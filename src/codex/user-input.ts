import { randomUUID } from "node:crypto";
import { escapeMarkdown, type TextChannel } from "discord.js";
import { createAskUserQuestionEmbed } from "./output-formatter.js";

export interface QuestionPayload {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }> | null;
}

export const AUTOMATIC_ANSWER = "No reply was received within five minutes. The user authorizes you to choose the most likely answer from the question and context, prefer the recommended option when appropriate, state your choice, and continue.";

/** Explicit choices on a finished turn can be answered without pretending to be a native RPC. */
export function conversationQuestions(item: Record<string, unknown>): QuestionPayload[] {
  if (Array.isArray(item.questions) && item.questions.length) return item.questions
    .filter((question) => typeof question?.title === "string").map((question, index) => ({
      id: String(index), header: "Your decision", question: question.title,
      options: Array.isArray(question.options) ? question.options.filter((value: unknown) => typeof value === "string")
        .map((label: string) => ({ label, description: "" })) : [],
    }));
  if (typeof item.text !== "string" || item.text.includes("```")) return [];
  const lines = item.text.trim().split("\n");
  let start = lines.length;
  while (start > 0 && /^\s*(?:[-*]|\d+[.)])\s+\S/.test(lines[start - 1])) start--;
  const options = lines.slice(start).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/\*\*/g, ""));
  const question = lines.slice(0, start).join("\n").trim().split(/\n\s*\n/).at(-1) ?? "";
  if (options.length < 2 || options.length > 25 || !question.includes("?")) return [];
  if (!/\b(should (?:it|i|we)|would you|do you|which|what|can you|your preference)\b/i.test(question)) return [];
  return [{ id: "decision", header: "Your decision", question, options: options.map((label) => ({ label, description: "" })) }];
}

interface Pending {
  channelId: string;
  scope: string;
  question: QuestionPayload;
  settle: (answer: string[] | null, automatic?: boolean) => void;
  setAutoDecision: (enabled: boolean) => void;
}

export class UserInput {
  private pending = new Map<string, Pending>();

  constructor(private autoDecisionEnabled: (channelId: string) => boolean = () => false) {}

  setAutoDecision(channelId: string, enabled: boolean): void {
    for (const pending of this.pending.values()) {
      if (pending.channelId === channelId) pending.setAutoDecision(enabled);
    }
  }

  ask(channel: TextChannel, scope: string, question: QuestionPayload, index: number, total: number): Promise<string[] | null> {
    const token = randomUUID();
    const { embed, components } = createAskUserQuestionEmbed({
      header: question.header, question: question.question, options: question.options ?? [], multiSelect: false,
    }, token, index, total);
    return new Promise((resolve) => {
      let message: Awaited<ReturnType<TextChannel["send"]>> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let autoDecision: boolean | undefined;
      let settledContent = "";
      let writes = Promise.resolve();
      const prompt = () => "Select an option or type a reply. " + (autoDecision
        ? "Auto-decision is ON: after five minutes, Codex will choose the most likely answer and continue."
        : "Auto-decision is OFF: waiting for your answer, with no automatic decision timeout.");
      const syncMessage = () => {
        // Read the latest state when each edit executes so an older policy update
        // cannot overwrite a settled answer or restore stale controls.
        writes = writes.then(async () => {
          await message?.edit({ content: settledContent || prompt(), ...(settledContent ? { components: [] } : {}), allowedMentions: { parse: [] } });
        }).catch(() => {});
      };
      const pending: Pending = {
        channelId: channel.id, scope, question,
        setAutoDecision: (enabled) => {
          if (autoDecision === enabled) return;
          autoDecision = enabled;
          clearTimeout(timeout);
          timeout = enabled ? setTimeout(() => pending.settle([AUTOMATIC_ANSWER], true), 5 * 60 * 1000) : undefined;
          if (message) syncMessage();
        },
        settle: (answer, automatic = false) => {
          if (!this.pending.delete(token)) return;
          clearTimeout(timeout);
          settledContent = automatic ? "⏳ No reply after five minutes. Codex will choose the most likely answer and continue."
            : answer ? `✅ Answer: ${escapeMarkdown(answer.join(", ")).slice(0, 1800)}` : "Question closed.";
          if (message) syncMessage();
          resolve(answer);
        },
      };
      this.pending.set(token, pending);
      pending.setAutoDecision(this.autoDecisionEnabled(channel.id));
      const initialContent = prompt();
      void channel.send({ content: initialContent,
        embeds: [embed], components, allowedMentions: { parse: [] },
      }).then((sent) => {
        message = sent;
        if (settledContent || initialContent !== prompt()) syncMessage();
      }).catch((error) => console.warn("Could not display Codex question:", error instanceof Error ? error.message : error));
    });
  }

  select(token: string, indices: string[], channelId: string): string[] | null {
    const pending = this.pending.get(token);
    if (!pending || pending.channelId !== channelId || !indices.length) return null;
    const answers = indices.map((index) => /^\d+$/.test(index) ? pending.question.options?.[Number(index)]?.label : undefined);
    if (answers.some((answer) => answer === undefined)) return null;
    pending.settle(answers as string[]);
    return answers as string[];
  }

  has(token: string, channelId: string): boolean { return this.pending.get(token)?.channelId === channelId; }
  hasChannel(channelId: string): boolean { return [...this.pending.values()].some((pending) => pending.channelId === channelId); }

  reply(channelId: string, text: string): boolean {
    const pending = [...this.pending.values()].find((question) => question.channelId === channelId);
    if (!pending || !text.trim()) return false;
    pending.settle([text.trim()]);
    return true;
  }

  cancel(scope: string): void {
    for (const pending of this.pending.values()) if (pending.scope === scope) pending.settle(null);
  }
  cancelChannel(channelId: string): void {
    for (const pending of this.pending.values()) if (pending.channelId === channelId) pending.settle(null);
  }
}
