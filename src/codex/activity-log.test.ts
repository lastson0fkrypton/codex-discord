import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityLog } from "./activity-log.js";

vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));

function setup() {
  const messages: Array<{ edit: ReturnType<typeof vi.fn> }> = [];
  const channel = {
    id: "channel-1",
    send: vi.fn().mockImplementation(async () => {
      const message = { edit: vi.fn().mockResolvedValue(undefined) };
      messages.push(message);
      return message;
    }),
  };
  return { log: new ActivityLog(channel, Date.now()), channel, messages };
}

describe("ActivityLog", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("batches activity events, tracks results, and keeps the plan after completion", async () => {
    const { log, channel, messages } = setup();
    await log.start();
    log.recordItem({ id: "cmd-1", type: "commandExecution", command: "npm test" }, false);
    log.recordItem({ id: "cmd-1", type: "commandExecution", command: "npm test", exitCode: 1, durationMs: 2000 }, true);
    log.recordItem({ id: "file-1", type: "fileChange", changes: [{ path: "src/index.ts" }] }, false);
    log.updatePlan([{ step: "Fix failing tests", status: "inProgress" }]);
    expect(messages[0].edit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    const payload = messages[0].edit.mock.calls.at(-1)![0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("1. ❌ Run: npm test (2.0s, exit 1)");
    expect(embed.description).toContain("2. ⏳ Edit files: src/index.ts");
    expect(embed.fields[0].value).toContain("⏳ Fix failing tests");
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(messages[0].edit).toHaveBeenCalledTimes(1);

    log.recordItem({ id: "file-1", type: "fileChange", changes: [{ path: "src/index.ts" }], status: "completed" }, true);
    await log.finish("completed");
    const final = messages[0].edit.mock.calls.at(-1)![0];
    expect(final.components).toEqual([]);
    expect(final.embeds[0].toJSON().footer.text).toContain("Completed • 2 activities");
    expect(final.embeds[0].toJSON().description).toContain("✅ Edit files");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains all activities across pages and keeps worst-case text within embed limits", async () => {
    const { log, channel, messages } = setup();
    await log.start();
    for (let index = 0; index < 25; index++) {
      log.recordItem({
        id: `search-${index}`, type: "webSearch",
        action: { type: "findInPage", url: "*".repeat(500), pattern: "_".repeat(500) },
      }, true);
    }
    log.updatePlan(Array.from({ length: 20 }, () => ({ step: "*".repeat(500), status: "pending" })));
    await log.finish("completed");
    expect(channel.send).toHaveBeenCalledTimes(3);
    const pages = messages.map((message, index) => message.edit.mock.calls.at(-1)?.[0] || channel.send.mock.calls[index][0]);
    const descriptions = pages.map((payload) => payload.embeds[0].toJSON().description);
    expect(descriptions[0]).toContain("1. ✅");
    expect(descriptions[0]).toContain("10. ✅");
    expect(descriptions[1]).toContain("11. ✅");
    expect(descriptions[2]).toContain("25. ✅");
    for (const payload of pages) {
      const embed = payload.embeds[0].toJSON();
      expect(embed.description.length).toBeLessThanOrEqual(4096);
      expect(payload.components).toEqual([]);
      for (const field of embed.fields ?? []) expect(field.value.length).toBeLessThanOrEqual(1024);
    }
  });

  it("shows tools and searches, ignores chat and raw reasoning text, and marks declined tools", async () => {
    const { log, messages } = setup();
    await log.start();
    log.recordItem({ id: "user", type: "userMessage", text: "prompt" }, false);
    log.recordItem({ id: "reply", type: "agentMessage", text: "answer" }, false);
    log.recordItem({ id: "reason", type: "reasoning", content: ["private text"] }, true);
    log.recordItem({ id: "web", type: "webSearch", action: { type: "search", query: "Codex activity events" } }, true);
    log.recordItem({ id: "mcp", type: "mcpToolCall", server: "sites", tool: "publish", status: "declined" }, true);
    log.recordItem({ id: "agent", type: "collabAgentToolCall", tool: "spawnAgent" }, false);
    await log.finish("interrupted");
    const embed = messages[0].edit.mock.calls.at(-1)![0].embeds[0].toJSON();
    expect(embed.description).toContain("Thinking");
    expect(embed.description).not.toContain("private text");
    expect(embed.description).not.toContain("prompt");
    expect(embed.description).not.toContain("answer");
    expect(embed.description).toContain("Search web: Codex activity events");
    expect(embed.description).toContain("🚫 Tool: sites / publish");
    expect(embed.description).toContain("⏹️ Subagent: spawnAgent");
    expect(embed.footer.text).toContain("Stopped • 4 activities");
  });

  it("serializes updates and removes controls when stopping during an edit", async () => {
    const { log, messages } = setup();
    await log.start();
    let release!: () => void;
    messages[0].edit.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    log.recordItem({ id: "cmd", type: "commandExecution", command: "sleep 60" }, false);
    await vi.advanceTimersByTimeAsync(1500);
    const finished = log.finish("interrupted");
    expect(messages[0].edit).toHaveBeenCalledTimes(1);
    release();
    await finished;
    expect(messages[0].edit).toHaveBeenCalledTimes(2);
    expect(messages[0].edit.mock.calls.at(-1)![0].components).toEqual([]);
    expect(messages[0].edit.mock.calls.at(-1)![0].embeds[0].toJSON().description).toContain("⏹️ Run: sleep 60");
    log.refresh();
    expect(vi.getTimerCount()).toBe(0);
  });
});
