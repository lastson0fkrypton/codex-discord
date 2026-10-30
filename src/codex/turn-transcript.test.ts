import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnTranscript } from "./turn-transcript.js";
import { splitMessage } from "./output-formatter.js";

vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));

function setup() {
  const messages: Array<{ content: string; edit: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }> = [];
  const channel = {
    send: vi.fn().mockImplementation(async (payload) => {
      const message = {
        content: payload.content,
        edit: vi.fn().mockImplementation(async (next) => { message.content = next.content; }),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      messages.push(message);
      return message;
    }),
  };
  return { transcript: new TurnTranscript(channel, false), channel, messages };
}

describe("TurnTranscript", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("matches the screenshot's order: compaction, commentary, and grouped activity", async () => {
    const { transcript, channel, messages } = setup();
    transcript.recordItem({ id: "compact", type: "contextCompaction" }, true);
    transcript.recordItem({ id: "commentary", type: "agentMessage", text: "I’ll wrap up P1-30 and commit after the final checks.", phase: "commentary" }, true);
    transcript.recordItem({ id: "read", type: "commandExecution", command: "cat file", commandActions: [{ type: "read" }] }, true);
    transcript.recordItem({ id: "run", type: "commandExecution", command: "python3 validate.py", aggregatedOutput: "Raw command output", commandActions: [{ type: "unknown" }] }, true);
    await transcript.finish("completed");
    expect(messages.map((message) => message.content)).toEqual([
      "*Context automatically compacted*",
      "I’ll wrap up P1-30 and commit after the final checks.",
      "*Read files, ran a command*",
    ]);
    for (const [payload] of channel.send.mock.calls) {
      expect(payload.components).toEqual([]);
      expect(payload.embeds).toEqual([]);
      expect(payload.allowedMentions).toEqual({ parse: [] });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes trailing deltas and uses completed text before the turn finishes", async () => {
    const { transcript, messages } = setup();
    transcript.appendText("commentary", "I");
    await vi.advanceTimersByTimeAsync(1500);
    expect(messages[0].content).toBe("I");
    transcript.appendText("commentary", "’ll inspect ");
    transcript.appendText("commentary", "the project.");
    await vi.advanceTimersByTimeAsync(1500);
    expect(messages[0].content).toBe("I’ll inspect the project.");
    transcript.recordItem({ id: "commentary", type: "agentMessage", text: "I’ll inspect the project and run checks." }, true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(messages[0].content).toBe("I’ll inspect the project and run checks.");
    transcript.recordItem({ id: "final", type: "agentMessage", text: "Checks passed." }, true);
    await transcript.finish("completed");
    expect(messages.map((message) => message.content)).toEqual(["I’ll inspect the project and run checks.", "Checks passed."]);
  });

  it("separates summaries around prose, suppresses thinking, and avoids raw shell commands", async () => {
    const { transcript, messages } = setup();
    for (let index = 0; index < 30; index++) {
      transcript.recordItem({ id: `cmd-${index}`, type: "commandExecution", command: "raw shell command" }, true);
      transcript.recordItem({ id: `reason-${index}`, type: "reasoning", content: ["private text"] }, true);
    }
    transcript.recordItem({ id: "comment", type: "agentMessage", text: "I found the issue." }, true);
    transcript.recordItem({ id: "edit", type: "fileChange", changes: [{ path: "src/index.ts" }] }, true);
    transcript.recordItem({ id: "answer", type: "agentMessage", text: "Fixed." }, true);
    await transcript.finish("completed");
    expect(messages.map((message) => message.content)).toEqual(["*Ran a command*", "I found the issue.", "*Edited files*", "Fixed."]);
  });

  it("shows live summaries without runtime or exit-code clutter", async () => {
    const { transcript, messages } = setup();
    transcript.recordItem({ id: "cmd", type: "commandExecution", commandActions: [{ type: "read" }, { type: "unknown" }] }, false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(messages[0].content).toBe("*Reading files, running a command*");
    transcript.recordItem({ id: "cmd", type: "commandExecution", commandActions: [{ type: "read" }, { type: "unknown" }], exitCode: 0, durationMs: 1234 }, true);
    await transcript.finish("completed");
    expect(messages[0].content).toBe("*Read files, ran a command*");
  });

  it("splits long replies safely and removes surplus chunks if completed text is shorter", async () => {
    const { transcript, channel, messages } = setup();
    const draft = "```ts\n" + "const x = 1;\n".repeat(350) + "```";
    transcript.appendText("answer", draft);
    await vi.advanceTimersByTimeAsync(1500);
    expect(messages.map((message) => message.content)).toEqual(splitMessage(draft));
    expect(channel.send.mock.calls.every(([payload]) => payload.content.length <= 2000)).toBe(true);
    transcript.recordItem({ id: "answer", type: "agentMessage", text: "Done." }, true);
    await transcript.finish("completed");
    expect(messages[0].content).toBe("Done.");
    for (const message of messages.slice(1)) expect(message.delete).toHaveBeenCalledOnce();
  });

  it("never sends blank messages or controls and preserves a plain plan checklist", async () => {
    const { transcript, channel, messages } = setup();
    transcript.recordItem({ id: "empty", type: "agentMessage", text: "" }, false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(channel.send).not.toHaveBeenCalled();
    transcript.updatePlan([{ step: "Check files", status: "inProgress" }]);
    transcript.updatePlan([{ step: "Check files", status: "completed" }]);
    await transcript.finish("completed");
    expect(messages.map((message) => message.content)).toEqual(["**Plan**\n✅ Check files"]);
    expect(channel.send.mock.calls[0][0].components).toEqual([]);
  });

  it("serializes edits and stopping without losing the final state", async () => {
    const { transcript, messages } = setup();
    transcript.recordItem({ id: "cmd", type: "commandExecution" }, false);
    await vi.advanceTimersByTimeAsync(1500);
    let release!: () => void;
    messages[0].edit.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    transcript.recordItem({ id: "file", type: "fileChange" }, false);
    await vi.advanceTimersByTimeAsync(1500);
    const finished = transcript.finish("interrupted");
    expect(messages[0].edit).toHaveBeenCalledTimes(1);
    release();
    await finished;
    expect(messages[0].content).toBe("*Ran a command (stopped), edited files (stopped)*");
    expect(messages[0].edit.mock.calls.at(-1)![0].components).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed final edit even after Codex stops emitting events", async () => {
    const { transcript, messages } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    transcript.appendText("answer", "Draft");
    await vi.advanceTimersByTimeAsync(1500);
    messages[0].edit.mockRejectedValueOnce(new Error("temporary Discord failure"));
    transcript.recordItem({ id: "answer", type: "agentMessage", text: "Complete answer" }, true);
    await transcript.finish("completed");
    expect(messages[0].content).toBe("Draft");
    await vi.advanceTimersByTimeAsync(2000);
    expect(messages[0].content).toBe("Complete answer");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("attaches duplicate generated images once and includes only the latest diff", async () => {
    const { transcript, channel } = setup();
    const result = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    transcript.recordItem({ id: "raw-image", type: "image_generation_call", result }, true);
    transcript.recordItem({ id: "canonical-image", type: "imageGeneration", result }, true);
    transcript.recordDiff("old diff");
    transcript.recordDiff("latest diff");
    await transcript.finish("completed");
    const payloads = channel.send.mock.calls.map(([payload]) => payload);
    expect(payloads.filter((payload) => payload.content === "Generated image")).toHaveLength(1);
    expect(payloads[0].files).toHaveLength(1);
    expect(payloads[1].files[0].attachment.toString()).toBe("latest diff");
  });

  it("drops a cleared diff and uses authoritative thinking summaries", async () => {
    const { transcript, messages, channel } = setup();
    transcript.appendReasoning("r", 0, "Partial");
    transcript.recordItem({ id: "r", type: "reasoning", summary: ["Complete summary"], content: ["private reasoning"] }, true);
    transcript.recordDiff("old");
    transcript.recordDiff("");
    await transcript.finish("completed");
    expect(messages.map((message) => message.content)).toEqual(["*Thinking*\nComplete summary"]);
    expect(channel.send.mock.calls[0][0].files).toBeUndefined();
  });

  it("retains failures and declined tools in concise summaries", async () => {
    const { transcript, messages } = setup();
    transcript.recordItem({ id: "cmd", type: "commandExecution", exitCode: 1 }, true);
    transcript.recordItem({ id: "tool", type: "mcpToolCall", server: "sites", tool: "publish", status: "declined" }, true);
    await transcript.finish("failed");
    expect(messages[0].content).toBe("*Ran a command (failed), used sites / publish (declined)*");
  });
});
