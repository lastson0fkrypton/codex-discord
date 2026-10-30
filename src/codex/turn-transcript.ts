import { escapeMarkdown, type MessageCreateOptions, type MessageEditOptions } from "discord.js";
import { L } from "../utils/i18n.js";
import { splitMessage } from "./output-formatter.js";
import { OutboundMedia, type MediaResult } from "./outbound-media.js";

type Status = "running" | "completed" | "failed" | "declined" | "interrupted";
interface TranscriptMessage {
  edit(payload: MessageEditOptions): Promise<unknown>;
  delete(): Promise<unknown>;
}
interface TranscriptChannel {
  send(payload: MessageCreateOptions): Promise<TranscriptMessage>;
}
interface Activity {
  categories: string[];
  status: Status;
}
interface Segment {
  kind: "text" | "activities" | "compaction" | "plan" | "thinking" | "media";
  text: string;
  activities: Map<string, Activity>;
  status: Status;
  messages: TranscriptMessage[];
  rendered: string[];
  command?: string;
  output?: string;
  media?: Promise<MediaResult>;
  attachment?: { attachment: Buffer; name: string };
}

function displayName(value: unknown): string {
  if (typeof value !== "string") return "";
  return escapeMarkdown(value.replace(/\s+/g, " ").trim()).slice(0, 100);
}

function categoriesForItem(item: Record<string, unknown>): string[] {
  switch (item.type) {
    case "commandExecution": {
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      return actions.length ? [...new Set(actions.map((action) =>
        action?.type === "read" ? "read" : action?.type === "listFiles" ? "list"
          : action?.type === "search" ? "search" : "command",
      ))] : ["command"];
    }
    case "fileChange": return ["edit"];
    case "webSearch": return ["web"];
    case "mcpToolCall": return [`tool:${displayName(item.server)} / ${displayName(item.tool)}`];
    case "dynamicToolCall": return [`tool:${displayName(item.tool)}`];
    case "collabAgentToolCall":
    case "collabToolCall":
    case "subAgentActivity": return ["agent"];
    case "imageView": return ["imageView"];
    case "imageGeneration": return ["imageGeneration"];
    case "enteredReviewMode":
    case "exitedReviewMode": return ["review"];
    default: return [];
  }
}

function activityPhrase(category: string, running: boolean): string {
  switch (category) {
    case "read": return running ? L("reading files", "파일 읽는 중") : L("read files", "파일 읽음");
    case "list": return running ? L("exploring files", "파일 탐색 중") : L("explored files", "파일 탐색함");
    case "search": return running ? L("searching files", "파일 검색 중") : L("searched files", "파일 검색함");
    case "command": return running ? L("running a command", "명령어 실행 중") : L("ran a command", "명령어 실행함");
    case "edit": return running ? L("editing files", "파일 편집 중") : L("edited files", "파일 편집함");
    case "web": return running ? L("searching the web", "웹 검색 중") : L("searched the web", "웹 검색함");
    case "agent": return running ? L("working with subagents", "하위 에이전트 작업 중") : L("worked with subagents", "하위 에이전트와 작업함");
    case "imageView": return running ? L("viewing an image", "이미지 확인 중") : L("viewed an image", "이미지 확인함");
    case "imageGeneration": return running ? L("generating an image", "이미지 생성 중") : L("generated an image", "이미지 생성함");
    case "review": return running ? L("reviewing code", "코드 검토 중") : L("reviewed code", "코드 검토함");
    default: return `${running ? L("using", "사용 중") : L("used", "사용함")} ${category.slice(5)}`;
  }
}

/** Renders the turn in event order: assistant messages interleaved with compact activity summaries. */
export class TurnTranscript {
  private segments: Segment[] = [];
  private itemSegments = new Map<string, Segment>();
  private currentActivities: Segment | null = null;
  private plan: Segment | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  private deliveredImages = new Set<string>();
  private media: OutboundMedia;
  private pendingDiff = "";

  constructor(private channel: TranscriptChannel, private verbose = false, projectPath = process.cwd()) {
    this.media = new OutboundMedia(projectPath);
  }

  flushNow(): Promise<void> {
    return this.flush();
  }

  recordItem(item: Record<string, unknown>, completed: boolean): void {
    if (this.closed || typeof item.id !== "string") return;
    if (["imageView", "imageGeneration", "image_generation_call"].includes(String(item.type))) {
      if (completed) this.recordMedia(item);
      return;
    }
    if (item.type === "agentMessage") {
      const segment = this.textSegment(item.id);
      if (typeof item.text === "string" && (completed || item.text.length > 0)) segment.text = item.text;
      this.schedule();
      return;
    }
    if (item.type === "reasoning") {
      if (completed && Array.isArray(item.summary)) {
        item.summary.forEach((summary, index) => {
          if (typeof summary === "string" && summary.trim()) this.reasoningSegment(item.id as string, index).text = summary;
        });
        this.schedule();
      }
      return;
    }
    if (item.type === "contextCompaction") {
      let segment = this.itemSegments.get(item.id);
      if (!segment) {
        segment = this.addSegment("compaction");
        this.itemSegments.set(item.id, segment);
      }
      segment.status = completed ? "completed" : "running";
      this.schedule();
      return;
    }
    const categories = categoriesForItem(item);
    if (!categories.length) return;
    let segment = this.itemSegments.get(item.id);
    if (!segment) {
      segment = (!this.verbose && this.currentActivities) || this.addSegment("activities");
      this.currentActivities = segment;
      this.itemSegments.set(item.id, segment);
    }
    const status = !completed ? "running" : item.status === "declined" ? "declined"
      : item.status === "failed" || item.success === false || item.error != null ||
        (typeof item.exitCode === "number" && item.exitCode !== 0) ? "failed" : "completed";
    segment.activities.set(item.id, { categories, status });
    if (this.verbose && item.type === "commandExecution") {
      segment.command = typeof item.command === "string" ? item.command : segment.command;
      if (typeof item.aggregatedOutput === "string") segment.output = item.aggregatedOutput.slice(-16000);
    }
    if (this.verbose && item.type === "fileChange" && Array.isArray(item.changes)) {
      segment.text = item.changes.map((change) => displayName(change?.path)).filter(Boolean).join(", ");
    }
    if (this.verbose && item.type === "webSearch") segment.text = displayName(item.query);
    if (completed) {
      const result = item.result as { content?: unknown[] } | undefined;
      if (Array.isArray(result?.content)) result.content.forEach((content, index) => {
        const image = content as { type?: string; data?: string };
        if (image?.type === "image" && typeof image.data === "string") this.recordMedia({ type: "toolImage", id: `${item.id}:${index}`, result: image.data });
      });
    }
    this.schedule();
  }

  private recordMedia(item: Record<string, unknown>): void {
    const key = `media:${item.id}`;
    if (this.itemSegments.has(key)) return;
    const segment = this.addSegment("media");
    segment.media = this.media.forItem(item);
    this.itemSegments.set(key, segment);
    this.schedule();
  }

  recordDiff(diff: string): void {
    if (this.closed) return;
    this.pendingDiff = diff;
  }

  private addDiff(): void {
    const segment = this.addSegment("text");
    segment.text = "Changes from this turn";
    const bytes = Buffer.from(this.pendingDiff);
    segment.attachment = bytes.length <= 8 * 1024 * 1024 ? { attachment: bytes, name: "codex-changes.diff" } : undefined;
    if (!segment.attachment) segment.text += " (diff exceeds upload limit)";
  }

  appendText(itemId: string, delta: string): void {
    if (this.closed) return;
    this.textSegment(itemId).text += delta;
    this.schedule();
  }

  appendReasoning(itemId: string, index: number, delta: string): void {
    if (this.closed) return;
    this.reasoningSegment(itemId, index).text += delta;
    this.schedule();
  }

  appendCommandOutput(itemId: string, delta: string): void {
    if (this.closed || !this.verbose) return;
    const segment = this.itemSegments.get(itemId);
    if (!segment) return;
    segment.output = ((segment.output ?? "") + delta).slice(-16000);
    this.schedule();
  }

  private reasoningSegment(itemId: string, index: number): Segment {
    const key = `reasoning:${itemId}:${index}`;
    let segment = this.itemSegments.get(key);
    if (!segment) {
      segment = this.addSegment("thinking");
      this.itemSegments.set(key, segment);
    }
    return segment;
  }

  updatePlan(value: unknown): void {
    if (this.closed || !Array.isArray(value) || !value.length) return;
    // Keep consecutive plan updates together, but place a later update after intervening prose.
    if (!this.plan || this.segments.at(-1) !== this.plan) this.plan = this.addSegment("plan");
    this.plan.text = `**${L("Plan", "계획")}**\n` + value.map((step) =>
      `${step?.status === "completed" ? "✅" : step?.status === "inProgress" ? "⏳" : "▫️"} ${displayName(step?.step)}`,
    ).join("\n");
    this.schedule();
  }

  async finish(status: Exclude<Status, "running" | "declined">): Promise<void> {
    if (this.closed) return this.writes;
    if (this.pendingDiff) this.addDiff();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const segment of this.segments) {
      if (segment.status === "running") segment.status = status;
      for (const activity of segment.activities.values()) {
        if (activity.status === "running") activity.status = status;
      }
    }
    await this.flush();
  }

  private textSegment(itemId: string): Segment {
    let segment = this.itemSegments.get(itemId);
    if (!segment) {
      segment = this.addSegment("text");
      this.itemSegments.set(itemId, segment);
    }
    return segment;
  }

  private addSegment(kind: Segment["kind"]): Segment {
    this.currentActivities = null;
    const segment: Segment = { kind, text: "", activities: new Map(), status: "running", messages: [], rendered: [] };
    this.segments.push(segment);
    return segment;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 1500);
  }

  private flush(): Promise<void> {
    this.writes = this.writes.then(() => this.render()).then(() => { this.retries = 0; }).catch((error) => {
      console.warn("Failed to update Codex transcript:", error instanceof Error ? error.message : error);
      // Cached chunks are updated only after a successful send/edit. Retry failures
      // even if Codex emits no more events (including after turn completion).
      if (!this.timer && this.retries++ < 3) this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 2000);
    });
    return this.writes;
  }

  private retries = 0;

  private content(segment: Segment): string {
    if (segment.kind === "text" || segment.kind === "plan") return segment.text;
    if (segment.kind === "thinking") return segment.text.trim() ? `*Thinking*\n${segment.text}` : "";
    if (segment.kind === "compaction") return `*${segment.status === "running"
      ? L("Compacting context…", "컨텍스트 압축 중…") : segment.status === "completed"
        ? L("Context automatically compacted", "컨텍스트 자동 압축됨") : L("Context compaction stopped", "컨텍스트 압축 중지됨")}*`;
    const categories = new Set([...segment.activities.values()].flatMap((activity) => activity.categories));
    const phrases = [...categories].map((category) => {
      const activities = [...segment.activities.values()].filter((activity) => activity.categories.includes(category));
      const phrase = activityPhrase(category, activities.some((activity) => activity.status === "running"));
      const suffix = activities.some((activity) => activity.status === "failed") ? L("failed", "실패")
        : activities.some((activity) => activity.status === "declined") ? L("declined", "거부됨")
        : activities.some((activity) => activity.status === "interrupted") ? L("stopped", "중지됨") : "";
      return phrase + (suffix ? ` (${suffix})` : "");
    });
    const summary = phrases.join(", ");
    let content = summary ? `*${summary.charAt(0).toUpperCase()}${summary.slice(1)}*` : "";
    if (segment.command) content += `\n\`\`\`sh\n${segment.command.slice(0, 500).replace(/```/g, "` ` `")}\n\`\`\``;
    if (segment.text) content += `\n${segment.text}`;
    if (segment.output?.trim()) content += `\n\`\`\`text\n${segment.output.slice(-1100).replace(/```/g, "` ` `")}\n\`\`\``;
    return content;
  }

  private async render(): Promise<void> {
    for (const segment of this.segments) {
      const media = segment.media ? await segment.media : undefined;
      if (media?.hashes.length && !segment.messages.length && media.hashes.every((hash) => this.deliveredImages.has(hash))) continue;
      const content = media?.caption ?? this.content(segment);
      const chunks = splitMessage(content);
      for (let index = 0; index < chunks.length; index++) {
        if (segment.rendered[index] === chunks[index]) continue;
        const files = index === 0 ? media?.files ?? (segment.attachment ? [segment.attachment] : []) : [];
        const payload = { content: chunks[index], embeds: [], components: [], allowedMentions: { parse: [] } };
        if (segment.messages[index]) await segment.messages[index].edit(payload);
        else {
          segment.messages[index] = await this.channel.send({ ...payload, ...(files.length ? { files } : {}) });
          media?.hashes.forEach((hash) => this.deliveredImages.add(hash));
        }
        segment.rendered[index] = chunks[index];
      }
      // The authoritative completed text can be shorter than the streamed draft.
      while (segment.messages.length > chunks.length) {
        await segment.messages.at(-1)!.delete();
        segment.messages.pop();
        segment.rendered.pop();
      }
    }
  }
}
