import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/database.js", () => ({
  upsertSession: vi.fn(), updateSessionStatus: vi.fn(), getProject: vi.fn(), getSession: vi.fn(), setAutoApprove: vi.fn(),
}));
vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));
vi.mock("./app-server-client.js", () => ({
  codexAppServer: {
    ensureStarted: vi.fn(), on: vi.fn(), startThread: vi.fn(), resumeThread: vi.fn(),
    startTurn: vi.fn(), respond: vi.fn(), interruptTurn: vi.fn(),
  },
}));

import { SessionManager } from "./session-manager.js";
import { getProject, getSession } from "../db/database.js";
import { codexAppServer } from "./app-server-client.js";

describe("SessionManager transcript", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
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
    const messages: Array<{ content: string; edit: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }> = [];
    const channel = {
      id: "channel-1",
      send: vi.fn().mockImplementation(async (payload) => {
        const message = {
          content: payload.content,
          edit: vi.fn().mockImplementation(async (next) => { message.content = next.content; }),
          delete: vi.fn().mockResolvedValue(undefined),
        };
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

  it("relays full commentary and final answers in order with compact activity and no buttons", async () => {
    const { manager, channel, messages, notify } = await setup();
    expect(channel.send).not.toHaveBeenCalled();
    await notify("item/completed", { item: { id: "compact", type: "contextCompaction" } });
    await notify("item/started", { item: { id: "commentary", type: "agentMessage", text: "" } });
    await notify("item/agentMessage/delta", { itemId: "commentary", delta: "I" });
    await vi.advanceTimersByTimeAsync(1500);
    await notify("item/completed", { item: { id: "commentary", type: "agentMessage", text: "I’ll wrap up after the final checks.", phase: "commentary" } });
    await notify("item/started", { item: { id: "cmd", type: "commandExecution", commandActions: [{ type: "read" }, { type: "unknown" }] } });
    await notify("item/completed", { item: { id: "cmd", type: "commandExecution", commandActions: [{ type: "read" }, { type: "unknown" }], exitCode: 0 } });
    await notify("item/completed", { item: { id: "final", type: "agentMessage", text: "Checks passed.", phase: "final_answer" } });
    await notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(messages.map((message) => message.content)).toEqual([
      "*Context automatically compacted*", "I’ll wrap up after the final checks.", "*Read files, ran a command*", "Checks passed.",
    ]);
    for (const [payload] of channel.send.mock.calls) {
      expect(payload.components).toEqual([]);
      expect(payload.embeds).toEqual([]);
    }
    expect(manager.isActive("channel-1")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates trailing text without waiting for turn completion and keeps later prose separate", async () => {
    const { messages, notify } = await setup();
    await notify("item/agentMessage/delta", { itemId: "message-1", delta: "First " });
    await notify("item/agentMessage/delta", { itemId: "message-1", delta: "progress update." });
    await vi.advanceTimersByTimeAsync(1500);
    expect(messages[0].content).toBe("First progress update.");
    await notify("item/started", { item: { id: "cmd", type: "commandExecution" } });
    await notify("item/agentMessage/delta", { itemId: "message-2", delta: "Second update." });
    await notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(messages.map((message) => message.content)).toEqual(["First progress update.", "*Ran a command*", "Second update."]);
  });

  it.each(["failed", "interrupted"])("preserves progress when a turn is %s", async (status) => {
    const { manager, messages, notify } = await setup();
    await notify("item/completed", { item: { id: "commentary", type: "agentMessage", text: "Checking the project." } });
    await notify("item/started", { item: { id: "cmd", type: "commandExecution" } });
    await notify("turn/completed", { turn: { id: "turn-1", status, error: { message: "Execution failed" } } });
    expect(messages[0].content).toBe("Checking the project.");
    expect(messages[1].content).toContain(status === "failed" ? "failed" : "stopped");
    if (status === "failed") expect(messages[2].content).toBe("❌ Execution failed");
    expect(manager.isActive("channel-1")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps /stop working and ignores notifications for another turn", async () => {
    const { manager, messages, notify } = await setup();
    await notify("item/completed", { turnId: "old-turn", item: { id: "old", type: "agentMessage", text: "Wrong turn" } });
    await notify("turn/completed", { turnId: undefined, turn: { id: "old-turn", status: "completed" } });
    expect(manager.isActive("channel-1")).toBe(true);
    await notify("item/started", { item: { id: "cmd", type: "commandExecution" } });
    expect(await manager.stopSession("channel-1")).toBe(true);
    expect(codexAppServer.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
    expect(messages.map((message) => message.content)).toEqual(["*Ran a command (stopped)*"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a start failure without leaving a transcript timer", async () => {
    vi.mocked(codexAppServer.startTurn).mockRejectedValueOnce(new Error("Cannot start turn"));
    const { manager, channel } = await setup();
    expect(channel.send).toHaveBeenCalledWith("❌ Cannot start turn");
    expect(manager.isActive("channel-1")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
