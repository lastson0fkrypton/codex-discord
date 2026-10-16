import { randomUUID } from "node:crypto";
import type { TextChannel } from "discord.js";
import {
  upsertSession,
  updateSessionStatus,
  getProject,
  getSession,
  setAutoApprove,
  setAutoDecision as saveAutoDecision,
} from "../db/database.js";
import { getConfig } from "../utils/config.js";
import { L } from "../utils/i18n.js";
import { codexAppServer } from "./app-server-client.js";
import { TurnTranscript } from "./turn-transcript.js";
import { UserInput, conversationQuestions, type QuestionPayload } from "./user-input.js";
import {
  createToolApprovalEmbed,
} from "./output-formatter.js";

interface ActiveSession {
  channelId: string;
  channel: TextChannel;
  threadId: string;
  turnId: string | null;
  dbId: string;
}

type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

type StreamState = {
  transcript: TurnTranscript;
  lastError: string | null;
  lastAssistant?: Record<string, unknown>;
  nativeQuestion?: boolean;
};

type RequestId = string | number;
type Approval = { channelId: string; allowSession: boolean; resolve: (decision: ApprovalDecision) => void };

export class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private initialized = false;
  private userInput = new UserInput((channelId) => Boolean(getProject(channelId)?.auto_decision));
  private approvals = new Map<string, Approval>();
  private requests = new Map<RequestId, string>();
  private conversations = new Map<string, symbol>();
  private conversationRequests = new Map<RequestId, { channelId: string; token: symbol; scope: string }>();
  private static readonly MAX_QUEUE_SIZE = 5;
  private messageQueue = new Map<string, { channel: TextChannel; prompt: string }[]>();
  private pendingQueuePrompts = new Map<string, { channel: TextChannel; prompt: string }>();
  private streamState = new Map<string, StreamState>();

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await codexAppServer.ensureStarted();

    codexAppServer.on("notification", (msg) => {
      this.handleNotification(msg as { method: string; params?: Record<string, unknown> }).catch((error) => {
        console.error("Codex notification error:", error);
      });
    });

    codexAppServer.on("serverRequest", (msg) => {
      this.handleServerRequest(msg as { id: RequestId; method: string; params: Record<string, unknown> }).catch((error) => {
        console.error("Codex server request error:", error);
      });
    });

    codexAppServer.on("stderr", (line) => {
      const text = String(line);
      if (!text.includes(" WARN ")) {
        console.warn("[codex]", text);
      }
    });

    codexAppServer.on("exit", () => {
      for (const channelId of new Set([...this.sessions.keys(), ...this.conversations.keys()])) {
        this.cancelInputs(channelId);
        void this.streamState.get(channelId)?.transcript.finish("failed");
        updateSessionStatus(channelId, "offline");
      }
      this.sessions.clear();
      this.streamState.clear();
    });
    this.initialized = true;
  }

  async sendMessage(channel: TextChannel, prompt: string, imagePaths: string[] = []): Promise<void> {
    await this.ensureInitialized();

    const channelId = channel.id;
    const project = getProject(channelId);
    if (!project) return;

    const existingSession = this.sessions.get(channelId);
    const dbSession = !existingSession ? getSession(channelId) : undefined;
    const dbId = existingSession?.dbId ?? dbSession?.id ?? randomUUID();
    let threadId = existingSession?.threadId ?? dbSession?.session_id ?? null;

    try {
      if (!threadId) {
        const thread = await codexAppServer.startThread(project.project_path);
        threadId = thread.id;
      } else if (!existingSession) {
        await codexAppServer.resumeThread(threadId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to prepare Codex thread";
      const isResumeFailure = Boolean(threadId) && !existingSession;
      if (isResumeFailure) {
        console.error(`[codex] Failed to resume thread ${threadId} for channel ${channelId}:`, message);
        await channel.send(
          `❌ ${L("Failed to resume the selected Codex session", "선택한 Codex 세션을 재개하지 못했습니다")}: ${message}\n` +
          L(
            "Try `/sessions` again or choose `Create New Session`.",
            "`/sessions`를 다시 열거나 `새 세션 만들기`를 선택해 보세요."
          ),
        ).catch(() => {});
      } else {
        console.error(`[codex] Failed to start thread for channel ${channelId}:`, message);
        await channel.send(`❌ ${message}`).catch(() => {});
      }
      updateSessionStatus(channelId, "offline");
      this.finishSession(channelId);
      return;
    }

    upsertSession(dbId, channelId, threadId, "online");

    const transcript = new TurnTranscript(channel, getConfig().DISCORD_VERBOSE, project.project_path);
    this.streamState.set(channelId, { transcript, lastError: null });

    this.sessions.set(channelId, {
      channelId,
      channel,
      threadId,
      turnId: null,
      dbId,
    });

    try {
      const turn = await codexAppServer.startTurn(threadId, prompt, imagePaths);
      const active = this.sessions.get(channelId);
      if (active?.threadId === threadId && !active.turnId) active.turnId = turn.id;
    } catch (error) {
      await transcript.finish("failed");
      await channel.send(`❌ ${error instanceof Error ? error.message : "Failed to start Codex turn"}`);
      updateSessionStatus(channelId, "offline");
      this.finishSession(channelId);
    }
  }

  private async handleNotification(msg: { method: string; params?: Record<string, unknown> }): Promise<void> {
    const params = msg.params ?? {};
    if (msg.method === "serverRequest/resolved") {
      const id = params.requestId;
      if (typeof id === "number" || typeof id === "string") {
        this.requests.delete(id);
        this.userInput.cancel(`rpc:${id}`);
        this.approvals.get(String(id))?.resolve("cancel");
        const question = this.conversationRequests.get(id);
        if (question && this.conversations.get(question.channelId) === question.token) {
          this.conversations.delete(question.channelId);
          this.userInput.cancel(question.scope);
          if (!this.sessions.has(question.channelId)) {
            updateSessionStatus(question.channelId, "idle");
            this.finishSession(question.channelId);
          }
        }
      }
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const active = threadId ? this.findActiveByThread(threadId) : undefined;
    if (!active) return;
    const eventTurn = params.turn as { id?: string } | undefined;
    const eventTurnId = typeof params.turnId === "string" ? params.turnId : eventTurn?.id;
    if (eventTurnId && active.turnId && eventTurnId !== active.turnId) return;

    const channelId = active.channelId;
    const stream = this.streamState.get(channelId);

    switch (msg.method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) {
          active.turnId = turn.id;
          updateSessionStatus(channelId, "online");
        }
        return;
      }
      case "thread/status/changed": {
        const status = params.status as { type?: string; activeFlags?: string[] } | undefined;
        if (!status) return;
        if (status.type === "active") {
          const waiting =
            Array.isArray(status.activeFlags) &&
            status.activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
          updateSessionStatus(channelId, waiting ? "waiting" : "online");
        } else if (status.type === "idle") {
          updateSessionStatus(channelId, "idle");
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (item && typeof item.type === "string") stream?.transcript.recordItem(item, msg.method === "item/completed");
        if (stream && item?.type === "agentMessage" && msg.method === "item/completed") {
          stream.lastAssistant = item;
          if (Array.isArray(item.questions) && item.questions.length && !stream.nativeQuestion && !this.conversations.has(channelId)) {
            this.startConversation(active, conversationQuestions(item));
          }
        }
        return;
      }
      case "item/agentMessage/delta": {
        if (typeof params.delta === "string" && typeof params.itemId === "string") stream?.transcript.appendText(params.itemId, params.delta);
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        if (typeof params.itemId === "string" && typeof params.delta === "string") {
          stream?.transcript.appendReasoning(params.itemId, typeof params.summaryIndex === "number" ? params.summaryIndex : 0, params.delta);
        }
        return;
      }
      case "item/commandExecution/outputDelta": {
        if (typeof params.itemId === "string" && typeof params.delta === "string") stream?.transcript.appendCommandOutput(params.itemId, params.delta);
        return;
      }
      case "turn/plan/updated": {
        stream?.transcript.updatePlan(params.plan);
        return;
      }
      case "rawResponseItem/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type === "image_generation_call") stream?.transcript.recordItem(item, true);
        return;
      }
      case "turn/diff/updated": {
        if (typeof params.diff === "string") stream?.transcript.recordDiff(params.diff);
        return;
      }
      case "error": {
        if (!stream) return;
        const error = params.error as { message?: string; additionalDetails?: string | null } | undefined;
        if (!error?.message) return;
        stream.lastError = error.additionalDetails
          ? `${error.message}\n${error.additionalDetails}`
          : error.message;
        return;
      }
      case "turn/completed": {
        const turn = params.turn as { status?: string | { type?: string }; error?: { message?: string; additionalDetails?: string | null } | null } | undefined;
        const statusType =
          typeof turn?.status === "string"
            ? turn.status
            : typeof turn?.status === "object" && turn.status
              ? turn.status.type
              : undefined;

        if (statusType === "failed") {
          const message =
            turn?.error?.additionalDetails
              ? `${turn.error.message ?? "Turn failed"}\n${turn.error.additionalDetails}`
              : turn?.error?.message ?? stream?.lastError ?? "Turn failed";
          if (stream) {
            await stream.transcript.finish("failed");
          }
          await active.channel.send({ content: `❌ ${message}`.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => {});
          this.cancelInputs(channelId);
          updateSessionStatus(channelId, "offline");
          this.finishSession(channelId);
          return;
        }

        if (stream) {
          await stream.transcript.finish(statusType === "interrupted" ? "interrupted" : "completed");
        }

        const questions = statusType === "completed" && stream?.lastAssistant && !stream.nativeQuestion
          ? conversationQuestions(stream.lastAssistant) : [];
        if (questions.length && !this.conversations.has(channelId)) this.startConversation(active, questions);
        updateSessionStatus(channelId, this.conversations.has(channelId) ? "waiting" : "idle");
        this.finishSession(channelId);
      }
    }
  }

  private async handleServerRequest(msg: { id: RequestId; method: string; params: Record<string, unknown> }): Promise<void> {
    const threadId = typeof msg.params.threadId === "string" ? msg.params.threadId : msg.params.conversationId;
    const active = typeof threadId === "string" ? this.findActiveByThread(threadId) : undefined;
    if (!active) {
      await codexAppServer.respond(msg.id, this.approvalResponse(msg.method, msg.params, "cancel"));
      return;
    }
    this.requests.set(msg.id, active.channelId);
    const stream = this.streamState.get(active.channelId);
    await stream?.transcript.flushNow();
    if (!this.requests.has(msg.id)) return;
    if (msg.method === "item/tool/requestUserInput") {
      if (stream) stream.nativeQuestion = true;
      const questions = (msg.params.questions as QuestionPayload[]) ?? [];
      if (msg.params.isBlocking === false) {
        this.startConversation(active, questions, msg.id);
        return;
      }
      try {
        const answers: Record<string, { answers: string[] }> = {};
        for (let index = 0; index < questions.length && this.requests.has(msg.id); index++) {
          updateSessionStatus(active.channelId, "waiting");
          const answer = await this.userInput.ask(active.channel, `rpc:${msg.id}`, questions[index], index, questions.length);
          if (answer === null) return;
          answers[questions[index].id] = { answers: answer };
        }
        if (this.requests.has(msg.id)) await codexAppServer.respond(msg.id, { answers });
      } finally {
        this.requests.delete(msg.id);
        if (this.sessions.has(active.channelId)) updateSessionStatus(active.channelId, "online");
      }
      return;
    }
    try {
      const supported = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"];
      if (!supported.includes(msg.method)) {
        await active.channel.send({ content: `Codex requested an unsupported interactive form (${msg.method}); the request was cancelled.`, allowedMentions: { parse: [] } });
        await codexAppServer.respond(msg.id, this.approvalResponse(msg.method, msg.params, "cancel"));
        return;
      }
      const auto = getProject(active.channelId)?.auto_approve && msg.method !== "item/permissions/requestApproval";
      const decision = auto ? "acceptForSession" : await this.requestApproval(active.channel, active.channelId, msg.id, msg.method, msg.params);
      if (this.requests.has(msg.id)) await codexAppServer.respond(msg.id, this.approvalResponse(msg.method, msg.params, decision));
    } catch (error) {
      console.warn("Could not display Codex approval:", error instanceof Error ? error.message : error);
      if (this.requests.has(msg.id)) await codexAppServer.respond(msg.id, this.approvalResponse(msg.method, msg.params, "cancel"));
    } finally { this.requests.delete(msg.id); }
  }

  private approvalResponse(method: string, params: Record<string, unknown>, decision: ApprovalDecision): Record<string, unknown> {
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request") return { action: "cancel", content: null, _meta: null };
    if (method === "item/permissions/requestApproval") {
      const requested = (params.permissions ?? {}) as Record<string, unknown>;
      const granted = decision === "accept" || decision === "acceptForSession"
        ? Object.fromEntries(Object.entries(requested).filter(([key, value]) => ["network", "fileSystem"].includes(key) && value != null)) : {};
      return { permissions: granted, scope: "turn" };
    }
    return { decision };
  }

  private async requestApproval(
    channel: TextChannel,
    channelId: string,
    requestId: RequestId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<ApprovalDecision> {
    const toolName =
      method === "item/fileChange/requestApproval"
        ? "FileChange"
        : method === "item/commandExecution/requestApproval"
          ? "Bash"
          : "CodexAction";

    const input =
      method === "item/commandExecution/requestApproval"
        ? {
            command: typeof params.command === "string"
              ? params.command
              : Array.isArray(params.command)
                ? params.command.join(" ")
                : params.reason ?? "unknown",
            description: params.reason,
          }
        : params;

    const { embed, row } = createToolApprovalEmbed(toolName, input as Record<string, unknown>, String(requestId));
    const allowSession = method !== "item/permissions/requestApproval";
    if (!allowSession) row.setComponents(row.components.filter((_, index) => index !== 2));
    updateSessionStatus(channelId, "waiting");
    return new Promise((resolve, reject) => {
      let message: Awaited<ReturnType<TextChannel["send"]>> | undefined;
      const key = String(requestId);
      const timeout = setTimeout(() => this.approvals.get(key)?.resolve("cancel"), 5 * 60 * 1000);
      this.approvals.set(key, { channelId, allowSession, resolve: (decision) => {
        if (!this.approvals.delete(key)) return;
        clearTimeout(timeout);
        void message?.edit({ components: [] }).catch(() => {});
        if (this.requests.has(requestId)) updateSessionStatus(channelId, "online");
        resolve(decision);
      } });
      void channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).then((sent) => {
        message = sent;
        if (!this.approvals.has(key)) void sent.edit({ components: [] }).catch(() => {});
      }).catch((error) => { clearTimeout(timeout); this.approvals.delete(key); reject(error); });
    });
  }

  private startConversation(active: ActiveSession, questions: QuestionPayload[], requestId?: RequestId): void {
    if (!questions.length || this.conversations.has(active.channelId)) return;
    const token = Symbol("question");
    const scope = `conversation:${randomUUID()}`;
    this.conversations.set(active.channelId, token);
    if (requestId !== undefined) this.conversationRequests.set(requestId, { channelId: active.channelId, token, scope });
    const run = async () => {
      await this.streamState.get(active.channelId)?.transcript.flushNow();
      const answers: Record<string, { answers: string[] }> = {};
      const text: string[] = [];
      for (let index = 0; index < questions.length; index++) {
        if (this.conversations.get(active.channelId) !== token) return;
        const answer = await this.userInput.ask(active.channel, scope, questions[index], index, questions.length);
        if (answer === null || this.conversations.get(active.channelId) !== token) return;
        answers[questions[index].id] = { answers: answer };
        const choices = questions[index].options?.map((option) => `- ${option.label}`).join("\n");
        text.push(`${questions[index].question}${choices ? `\n${choices}` : ""}\nMy answer: ${answer.join(", ")}`);
      }
      this.conversations.delete(active.channelId);
      if (requestId !== undefined && this.requests.has(requestId)) {
        await codexAppServer.respond(requestId, { answers });
        this.requests.delete(requestId);
      } else if (!(await this.steerMessage(active.channelId, text.join("\n\n")))) {
        this.sessions.set(active.channelId, { ...active, turnId: null });
        await this.sendMessage(active.channel, text.join("\n\n"));
      }
    };
    void run().catch((error) => {
      console.error("Codex question delivery error:", error);
      void active.channel.send("Could not deliver your answer to Codex. Please send it again.").catch(() => {});
    }).finally(() => {
      if (requestId !== undefined && this.conversationRequests.get(requestId)?.token === token) this.conversationRequests.delete(requestId);
      if (this.conversations.get(active.channelId) === token) this.conversations.delete(active.channelId);
      this.userInput.cancel(scope);
    });
  }

  async steerMessage(channelId: string, prompt: string, imagePaths: string[] = []): Promise<boolean> {
    const active = this.sessions.get(channelId);
    if (!active?.turnId) return false;
    await codexAppServer.steerTurn(active.threadId, active.turnId, prompt, imagePaths);
    return true;
  }

  private cancelInputs(channelId: string, conversations = true): void {
    for (const [id, channel] of this.requests) if (channel === channelId) {
      this.requests.delete(id);
      this.userInput.cancel(`rpc:${id}`);
      this.approvals.get(String(id))?.resolve("cancel");
    }
    if (conversations) {
      this.conversations.delete(channelId);
      this.userInput.cancelChannel(channelId);
    }
  }

  private findActiveByThread(threadId: string): ActiveSession | undefined {
    return [...this.sessions.values()].find((entry) => entry.threadId === threadId);
  }

  async stopSession(channelId: string): Promise<boolean> {
    const session = this.sessions.get(channelId);
    if (!session || !session.turnId) {
      if (!this.conversations.has(channelId)) return false;
      this.cancelInputs(channelId);
      updateSessionStatus(channelId, "idle");
      return true;
    }
    this.cancelInputs(channelId);

    try {
      await codexAppServer.interruptTurn(session.threadId, session.turnId);
    } catch {
      // ignore
    }

    updateSessionStatus(channelId, "offline");
    await this.streamState.get(channelId)?.transcript.finish("interrupted");
    this.finishSession(channelId);
    return true;
  }

  private finishSession(channelId: string): void {
    this.cancelInputs(channelId, false);
    this.streamState.delete(channelId);

    this.sessions.delete(channelId);
    if (this.conversations.has(channelId)) return;

    const queue = this.messageQueue.get(channelId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.messageQueue.delete(channelId);
      const remaining = queue.length;
      const preview = next.prompt.length > 40 ? next.prompt.slice(0, 40) + "…" : next.prompt;
      const msg = remaining > 0
        ? L(`📨 Processing queued message... (remaining: ${remaining})\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다... (남은 큐: ${remaining}개)\n> ${preview}`)
        : L(`📨 Processing queued message...\n> ${preview}`, `📨 대기 중이던 메시지를 처리합니다...\n> ${preview}`);
      next.channel.send(msg).catch(() => {});
      this.sendMessage(next.channel, next.prompt).catch((err) => {
        console.error("Queue sendMessage error:", err);
      });
    }
  }

  isActive(channelId: string): boolean {
    return this.sessions.has(channelId) || this.conversations.has(channelId);
  }

  resolveApproval(requestId: string, decision: "approve" | "deny" | "approve-all", channelId: string): boolean {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.channelId !== channelId) return false;

    if (decision === "approve-all") {
      if (!pending.allowSession) return false;
      setAutoApprove(pending.channelId, true);
      pending.resolve("acceptForSession");
    } else if (decision === "approve") {
      pending.resolve("accept");
    } else {
      pending.resolve("cancel");
    }

    return true;
  }

  resolveQuestion(token: string, indices: string[], channelId: string): string[] | null {
    return this.userInput.select(token, indices, channelId);
  }

  setAutoDecision(channelId: string, enabled: boolean): void {
    saveAutoDecision(channelId, enabled);
    this.userInput.setAutoDecision(channelId, enabled);
  }

  enableCustomInput(token: string, channelId: string): boolean { return this.userInput.has(token, channelId); }
  resolveCustomInput(channelId: string, text: string): boolean { return this.userInput.reply(channelId, text); }
  hasPendingCustomInput(channelId: string): boolean { return this.userInput.hasChannel(channelId); }

  setPendingQueue(channelId: string, channel: TextChannel, prompt: string): void {
    this.pendingQueuePrompts.set(channelId, { channel, prompt });
  }

  confirmQueue(channelId: string): boolean {
    const pending = this.pendingQueuePrompts.get(channelId);
    if (!pending) return false;
    this.pendingQueuePrompts.delete(channelId);
    const queue = this.messageQueue.get(channelId) ?? [];
    queue.push(pending);
    this.messageQueue.set(channelId, queue);
    return true;
  }

  cancelQueue(channelId: string): void {
    this.pendingQueuePrompts.delete(channelId);
  }

  isQueueFull(channelId: string): boolean {
    const queue = this.messageQueue.get(channelId) ?? [];
    return queue.length >= SessionManager.MAX_QUEUE_SIZE;
  }

  hasQueue(channelId: string): boolean {
    return this.pendingQueuePrompts.has(channelId);
  }

  getQueueSize(channelId: string): number {
    return (this.messageQueue.get(channelId) ?? []).length;
  }

  getQueue(channelId: string): { channel: TextChannel; prompt: string }[] {
    return this.messageQueue.get(channelId) ?? [];
  }

  clearQueue(channelId: string): number {
    const queue = this.messageQueue.get(channelId) ?? [];
    const count = queue.length;
    this.messageQueue.delete(channelId);
    this.pendingQueuePrompts.delete(channelId);
    return count;
  }

  removeFromQueue(channelId: string, index: number): string | null {
    const queue = this.messageQueue.get(channelId) ?? [];
    if (index < 0 || index >= queue.length) return null;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.messageQueue.delete(channelId);
    return removed.prompt;
  }
}

export const sessionManager = new SessionManager();
