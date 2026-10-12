import { EmbedBuilder, escapeMarkdown, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import { L } from "../utils/i18n.js";
import { createStopButton } from "./output-formatter.js";

type ActivityStatus = "running" | "completed" | "failed" | "declined" | "interrupted";
type TaskStatus = "running" | "completed" | "failed" | "interrupted";
interface Activity {
  id: string;
  label: string;
  status: ActivityStatus;
  startedAt: number;
  detail: string;
}
interface LogMessage {
  edit(payload: MessageEditOptions): Promise<unknown>;
}
interface LogChannel {
  id: string;
  send(payload: MessageCreateOptions): Promise<LogMessage>;
}

const PAGE_SIZE = 10;
const UPDATE_INTERVAL_MS = 1500;
const ICONS: Record<ActivityStatus, string> = {
  running: "⏳", completed: "✅", failed: "❌", declined: "🚫", interrupted: "⏹️",
};

function text(value: unknown, limit = 180): string {
  if (typeof value !== "string") return "";
  const singleLine = value.replace(/\s+/g, " ").trim();
  const shortened = singleLine.length > limit ? singleLine.slice(0, limit - 1) + "…" : singleLine;
  const escaped = escapeMarkdown(shortened);
  return escaped.length > limit ? escaped.slice(0, limit - 1) + "…" : escaped;
}

function labelForItem(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "commandExecution":
      return `${L("Run", "실행")}: ${text(item.command) || L("command", "명령어")}`;
    case "fileChange": {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((change) => text(change?.path, 90)).filter(Boolean)
        : [];
      return `${L("Edit files", "파일 편집")}${paths.length ? `: ${paths.slice(0, 2).join(", ")}${paths.length > 2 ? ` (+${paths.length - 2})` : ""}` : ""}`;
    }
    case "webSearch": {
      const action = item.action as Record<string, unknown> | undefined;
      const query = text(item.query || action?.query || (Array.isArray(action?.queries) ? action.queries.join(", ") : ""));
      const url = text(action?.url);
      return action?.type === "openPage" ? `${L("Open web page", "웹 페이지 열기")}: ${url}`
        : action?.type === "findInPage" ? `${L("Find on page", "페이지에서 찾기")}: ${text(action.pattern)} ${url}`
        : `${L("Search web", "웹 검색")}${query ? `: ${query}` : ""}`;
    }
    case "mcpToolCall":
      return `${L("Tool", "도구")}: ${text(item.server, 60)} / ${text(item.tool, 100)}`;
    case "dynamicToolCall":
      return `${L("Tool", "도구")}: ${text(item.tool)}`;
    case "collabAgentToolCall":
      return `${L("Subagent", "하위 에이전트")}: ${text(item.tool)}`;
    case "subAgentActivity":
      return `${L("Subagent", "하위 에이전트")}: ${text(item.agentPath, 100)} ${text(item.kind, 60)}`;
    case "imageView":
      return `${L("Inspect image", "이미지 확인")}: ${text(item.path)}`;
    case "imageGeneration":
      return L("Generate image", "이미지 생성");
    case "contextCompaction":
      return L("Compact conversation context", "대화 컨텍스트 압축");
    case "enteredReviewMode":
    case "exitedReviewMode":
      return L("Code review", "코드 검토");
    case "reasoning":
      return L("Thinking", "생각 중");
    case "plan":
      return L("Prepare plan", "계획 작성");
    case "sleep":
      return L("Waiting", "대기 중");
    default:
      return null;
  }
}

/** A per-turn log, independent of assistant text, with serialized and batched Discord edits. */
export class ActivityLog {
  private entries: Activity[] = [];
  private messages: LogMessage[] = [];
  private rendered: string[] = [];
  private plan: string[] = [];
  private status: TaskStatus = "running";
  private waiting = "";
  private timer: NodeJS.Timeout | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private channel: LogChannel, private startedAt: number) {}

  async start(): Promise<void> {
    await this.flush();
  }

  recordItem(item: Record<string, unknown>, completed: boolean): void {
    if (this.status !== "running" || typeof item.id !== "string") return;
    const fullLabel = labelForItem(item);
    if (!fullLabel) return;
    const label = fullLabel.length > 240 ? fullLabel.slice(0, 239) + "…" : fullLabel;
    let entry = this.entries.find((candidate) => candidate.id === item.id);
    if (!entry) {
      entry = { id: item.id, label, status: "running", startedAt: Date.now(), detail: "" };
      this.entries.push(entry);
    }
    entry.label = label;
    if (completed) {
      entry.status = item.status === "declined" ? "declined"
        : item.status === "failed" || item.success === false || item.error != null ||
          (typeof item.exitCode === "number" && item.exitCode !== 0) ? "failed"
        : "completed";
      const duration = typeof item.durationMs === "number" ? item.durationMs : Date.now() - entry.startedAt;
      entry.detail = `${(duration / 1000).toFixed(1)}s`;
      if (typeof item.exitCode === "number") entry.detail += `, ${L("exit", "종료 코드")} ${item.exitCode}`;
    }
    this.refresh();
  }

  updatePlan(value: unknown): void {
    if (this.status !== "running" || !Array.isArray(value)) return;
    this.plan = value.slice(0, 8).map((step) => {
      const icon = step?.status === "completed" ? "✅" : step?.status === "inProgress" ? "⏳" : "▫️";
      return `${icon} ${text(step?.step, 120)}`;
    });
    if (value.length > 8) this.plan.push(`… (+${value.length - 8})`);
    this.refresh();
  }

  setWaiting(value: string): void {
    if (this.status !== "running") return;
    this.waiting = value;
    this.refresh();
  }

  refresh(): void {
    if (this.status !== "running" || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, UPDATE_INTERVAL_MS);
  }

  async finish(status: Exclude<TaskStatus, "running">): Promise<void> {
    if (this.status !== "running") return;
    this.status = status;
    this.waiting = "";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const entry of this.entries) {
      if (entry.status === "running") entry.status = status === "failed" ? "failed" : "interrupted";
    }
    await this.flush();
  }

  private flush(): Promise<void> {
    this.writes = this.writes.then(() => this.render()).catch((error) => {
      console.warn("Failed to update Codex activity log:", error instanceof Error ? error.message : error);
    });
    return this.writes;
  }

  private async render(): Promise<void> {
    const pageCount = Math.max(1, Math.ceil(this.entries.length / PAGE_SIZE));
    const payloads = Array.from({ length: pageCount }, (_, page) => {
      const isLast = page === pageCount - 1;
      const entries = this.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const lines = entries.map((entry, index) =>
        `${page * PAGE_SIZE + index + 1}. ${ICONS[entry.status]} ${entry.label}${entry.detail ? ` (${entry.detail})` : ""}`,
      );
      const statusLabel = this.status === "completed" ? L("Completed", "완료")
        : this.status === "failed" ? L("Failed", "실패")
        : this.status === "interrupted" ? L("Stopped", "중지됨")
        : this.waiting || L("Working", "작업 중");
      const embed = new EmbedBuilder()
        .setTitle(`${L("Codex Activity", "Codex 활동")} • ${L("Page", "페이지")} ${page + 1}`)
        .setDescription(lines.join("\n") || L("⏳ Waiting for Codex activity…", "⏳ Codex 활동 대기 중…"))
        .setColor(isLast && this.status === "failed" ? 0xff0000 : isLast && this.status === "completed" ? 0x00ff00 : 0x5865f2)
        .setFooter({ text: isLast
          ? `${statusLabel} • ${this.entries.length} ${L("activities", "개 활동")} • ${Math.round((Date.now() - this.startedAt) / 1000)}s`
          : L("Activity history", "활동 기록") });
      if (isLast && this.plan.length) embed.addFields({ name: L("Plan", "계획"), value: this.plan.join("\n") });
      return {
        content: "",
        embeds: [embed],
        components: isLast && this.status === "running" ? [createStopButton(this.channel.id)] : [],
        allowedMentions: { parse: [] },
      };
    });

    for (let page = 0; page < payloads.length; page++) {
      const payload = payloads[page];
      const serialized = JSON.stringify(payload);
      if (this.rendered[page] === serialized) continue;
      if (this.messages[page]) await this.messages[page].edit(payload);
      else this.messages[page] = await this.channel.send(payload);
      this.rendered[page] = serialized;
    }
  }
}
