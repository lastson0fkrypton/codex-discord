import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/database.js", () => ({
  upsertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getProject: vi.fn(),
  getSession: vi.fn(),
  setAutoApprove: vi.fn(),
}));

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({ SHOW_COST: false }),
}));

vi.mock("../utils/i18n.js", () => ({
  L: (en: string, _kr: string) => en,
}));

vi.mock("./app-server-client.js", () => ({
  codexAppServer: {
    ensureStarted: vi.fn(),
    on: vi.fn(),
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    startTurn: vi.fn(),
    respond: vi.fn(),
    interruptTurn: vi.fn(),
  },
}));

import { SessionManager } from "./session-manager.js";
import { createStopButton, splitMessage } from "./output-formatter.js";
import { getProject, getSession } from "../db/database.js";
import { codexAppServer } from "./app-server-client.js";

function createFakeMessage() {
  return {
    edit: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SessionManager streaming output", () => {
  let now = 0;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates agent deltas instead of replacing earlier text", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const channel = {
      id: "channel-1",
      send: vi.fn(),
    } as any;

    (manager as any).sessions.set("channel-1", {
      channelId: "channel-1",
      channel,
      threadId: "thread-1",
      turnId: "turn-1",
      dbId: "db-1",
    });

    (manager as any).streamState.set("channel-1", {
      buffer: "",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-1"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: false,
      lastError: null,
    });

    now = 2_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "저는 " },
    });

    now = 4_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Codex입니다." },
    });

    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: "저는 Codex입니다." }),
    );
    expect(channel.send).not.toHaveBeenCalled();

    clearInterval((manager as any).streamState.get("channel-1").heartbeat);
  });

  it("keeps earlier chunks and sends only newly needed Discord messages", async () => {
    const manager = new SessionManager();
    const firstMessage = createFakeMessage();
    const sentMessages: Array<ReturnType<typeof createFakeMessage>> = [];
    const channel = {
      id: "channel-2",
      send: vi.fn().mockImplementation(async () => {
        const message = createFakeMessage();
        sentMessages.push(message);
        return message;
      }),
    } as any;

    (manager as any).sessions.set("channel-2", {
      channelId: "channel-2",
      channel,
      threadId: "thread-2",
      turnId: "turn-2",
      dbId: "db-2",
    });

    (manager as any).streamState.set("channel-2", {
      buffer: "",
      messages: [firstMessage],
      lastEditTime: 0,
      stopRow: createStopButton("channel-2"),
      startedAt: 0,
      lastActivity: "Thinking...",
      toolUseCount: 0,
      heartbeat: setInterval(() => {}, 60_000),
      hasTextOutput: false,
      lastError: null,
    });

    const firstDelta = "a".repeat(1890);
    const secondDelta = "\n" + "b".repeat(80);

    now = 2_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", delta: firstDelta },
    });

    now = 4_000;
    await (manager as any).handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-2", delta: secondDelta },
    });

    const chunks = splitMessage(firstDelta + secondDelta);
    expect(chunks).toHaveLength(2);
    expect(firstMessage.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: chunks[0] }),
    );
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(sentMessages[0].edit).not.toHaveBeenCalled();

    clearInterval((manager as any).streamState.get("channel-2").heartbeat);
  });
});

describe("SessionManager activity reporting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(getProject).mockReturnValue({
      channel_id: "channel-1", project_path: "/project", guild_id: "guild-1", auto_approve: 0, created_at: "",
    });
    vi.mocked(getSession).mockReturnValue(undefined);
    vi.mocked(codexAppServer.startThread).mockResolvedValue({ id: "thread-1" } as any);
    vi.mocked(codexAppServer.startTurn).mockResolvedValue({ id: "turn-1" });
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function setup() {
    const manager = new SessionManager();
    const messages: Array<ReturnType<typeof createFakeMessage>> = [];
    const channel = {
      id: "channel-1",
      send: vi.fn().mockImplementation(async () => {
        const message = createFakeMessage();
        messages.push(message);
        return message;
      }),
    } as any;
    await manager.sendMessage(channel, "Check the project");
    const notify = (method: string, params: Record<string, unknown>) =>
      (manager as any).handleNotification({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
    await notify("turn/started", { turn: { id: "turn-1" } });
    return { manager, channel, messages, notify };
  }

  it("keeps reporting activity after assistant text and preserves the log at completion", async () => {
    const { manager, channel, messages, notify } = await setup();
    await vi.advanceTimersByTimeAsync(2000);
    await notify("item/agentMessage/delta", { delta: "I’ll inspect the project." });
    expect(channel.send.mock.calls[1][0].content).toBe("I’ll inspect the project.");

    await notify("item/started", { item: { id: "cmd-1", type: "commandExecution", command: "rg --files" } });
    await notify("turn/plan/updated", { plan: [{ step: "Inspect files", status: "inProgress" }] });
    await vi.advanceTimersByTimeAsync(1500);
    const progress = messages[0].edit.mock.calls.at(-1)![0];
    expect(progress.embeds[0].toJSON().description).toContain("⏳ Run: rg --files");
    expect(progress.embeds[0].toJSON().fields[0].value).toContain("Inspect files");
    expect(messages[1].edit).not.toHaveBeenCalled();

    await notify("item/completed", { item: { id: "cmd-1", type: "commandExecution", command: "rg --files", exitCode: 0 } });
    await notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    const final = messages[0].edit.mock.calls.at(-1)![0];
    expect(final.embeds[0].toJSON().description).toContain("✅ Run: rg --files");
    expect(final.components).toEqual([]);
    expect(messages[1].edit.mock.calls.at(-1)![0].content).toBe("I’ll inspect the project.");
    expect(manager.isActive("channel-1")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["failed", "interrupted"])("finishes the activity log when a turn is %s", async (status) => {
    const { manager, channel, messages, notify } = await setup();
    await notify("item/started", { item: { id: "cmd-1", type: "commandExecution", command: "npm test" } });
    await notify("turn/completed", { turn: { id: "turn-1", status, error: { message: "Execution failed" } } });
    const final = messages[0].edit.mock.calls.at(-1)![0];
    expect(final.embeds[0].toJSON().footer.text).toContain(status === "failed" ? "Failed" : "Stopped");
    expect(final.components).toEqual([]);
    expect(channel.send.mock.calls.some(([payload]: any[]) => payload.embeds?.[0]?.toJSON().title.includes("Task Complete"))).toBe(false);
    expect(manager.isActive("channel-1")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finalizes the log when the user stops a turn and ignores events for another turn", async () => {
    const { manager, messages, notify } = await setup();
    await notify("item/started", { turnId: "old-turn", item: { id: "old-cmd", type: "commandExecution", command: "wrong command" } });
    await notify("item/started", { item: { id: "cmd-1", type: "commandExecution", command: "npm test" } });
    expect(await manager.stopSession("channel-1")).toBe(true);
    expect(codexAppServer.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
    const final = messages[0].edit.mock.calls.at(-1)![0];
    expect(final.embeds[0].toJSON().description).toContain("⏹️ Run: npm test");
    expect(final.embeds[0].toJSON().description).not.toContain("wrong command");
    expect(final.components).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
