import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextChannel } from "discord.js";
import { codexAppServer } from "./app-server-client.js";
import { SessionManager } from "./session-manager.js";
import { AUTOMATIC_ANSWER } from "./user-input.js";
import fixture from "./fixtures/conversation.json";
import { getSession, updateSessionStatus } from "../db/database.js";

vi.mock("../db/database.js", () => ({
  getProject: vi.fn(() => ({ project_path: process.cwd(), auto_approve: false })),
  getSession: vi.fn(), upsertSession: vi.fn(), updateSessionStatus: vi.fn(), setAutoApprove: vi.fn(),
}));
vi.mock("../utils/config.js", () => ({ getConfig: () => ({ DISCORD_VERBOSE: true }) }));
vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));

type Payload = { content?: string; components?: unknown[]; files?: unknown[] };
function sink() {
  const messages: Array<Payload & { edit: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }> = [];
  const channel = { id: "channel", send: vi.fn(async (payload: Payload | string) => {
    const message = { ...(typeof payload === "string" ? { content: payload } : payload),
      edit: vi.fn(async (next: Payload) => { Object.assign(message, next); }), delete: vi.fn() };
    messages.push(message);
    return message;
  }) };
  return { channel: channel as unknown as TextChannel, messages };
}

/** Feed JSON through the real app-server parser, event listener, controller and renderer. */
async function feed(method: string, params: Record<string, unknown>, id?: number | string) {
  const parser = codexAppServer as unknown as { handleStdoutLine(line: string): void };
  parser.handleStdoutLine(JSON.stringify({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params }, ...(id === undefined ? {} : { id }) }));
  await vi.advanceTimersByTimeAsync(0);
}
const question = { id: "release", header: "Release", question: "Keep the reward?", options: [
  { label: "Keep it; label runs assisted (Recommended)", description: "Preserve it" },
  { label: "Disable it in release builds", description: "Remove it" },
] };
function questionToken(messages: ReturnType<typeof sink>["messages"]): string {
  const message = [...messages].reverse().find((message) => message.components?.length);
  const row = message!.components![0] as { toJSON(): { components: Array<{ custom_id: string }> } };
  return row.toJSON().components[0].custom_id.split(":")[1];
}

describe("Discord conversation protocol replay", () => {
  let manager: SessionManager;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getSession).mockReturnValue(undefined);
    codexAppServer.removeAllListeners();
    vi.spyOn(codexAppServer, "ensureStarted").mockResolvedValue(undefined);
    vi.spyOn(codexAppServer, "startThread").mockResolvedValue({ id: "thread-1" } as Awaited<ReturnType<typeof codexAppServer.startThread>>);
    vi.spyOn(codexAppServer, "resumeThread").mockResolvedValue({ id: "thread-1" } as Awaited<ReturnType<typeof codexAppServer.startThread>>);
    vi.spyOn(codexAppServer, "startTurn").mockResolvedValue({ id: "turn-1" });
    vi.spyOn(codexAppServer, "steerTurn").mockResolvedValue(undefined);
    vi.spyOn(codexAppServer, "interruptTurn").mockResolvedValue(undefined);
    vi.spyOn(codexAppServer, "respond").mockResolvedValue(undefined);
    manager = new SessionManager();
  });
  afterEach(() => { codexAppServer.removeAllListeners(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("delivers a complete verbose conversation with no Stop buttons", async () => {
    const { channel, messages } = sink();
    await manager.sendMessage(channel, "Check the project");
    for (const event of fixture.slice(0, -1)) await feed(event.method, event.params);
    await vi.advanceTimersByTimeAsync(1500);
    const text = messages.map((message) => message.content).join("\n");
    expect(text).toContain("I will check the project and run tests.");
    expect(text).toContain("Checking which validation covers the change.");
    expect(text).not.toContain("RAW_REASONING");
    expect(text).toContain("npm test");
    expect(text).toContain("All tests passed.");
    expect(text).toContain("src/index.ts");
    expect(manager.isActive("channel")).toBe(true);
    await feed("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(messages.some((message) => message.files?.length)).toBe(true);
    expect(messages.every((message) => !message.components?.length)).toBe(true);
    expect(manager.isActive("channel")).toBe(false);
    expect(updateSessionStatus).toHaveBeenCalledWith("channel", "idle");
  });

  it("flushes a rapid burst after a single initial character while work continues", async () => {
    const { channel, messages } = sink();
    await manager.sendMessage(channel, "continue");
    await feed("item/agentMessage/delta", { itemId: "a", delta: "I" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(messages[0].content).toBe("I");
    await feed("item/agentMessage/delta", { itemId: "a", delta: " will check files." });
    await feed("item/completed", { item: { id: "a", type: "agentMessage", text: "I will check files and run tests." } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(messages[0].content).toBe("I will check files and run tests.");
    expect(manager.isActive("channel")).toBe(true);
    await manager.stopSession("channel");
  });

  it("waits for a button or typed reply and returns the full native answer", async () => {
    const { channel, messages } = sink();
    await manager.sendMessage(channel, "plan");
    await feed("item/tool/requestUserInput", { questions: [question], isBlocking: true }, "request-1");
    const token = questionToken(messages);
    expect(manager.resolveQuestion(token, ["0"], "other-channel")).toBeNull();
    await vi.advanceTimersByTimeAsync(299999);
    expect(codexAppServer.respond).not.toHaveBeenCalled();
    expect(manager.resolveQuestion(token, ["0"], "channel")).toEqual([question.options[0].label]);
    await vi.advanceTimersByTimeAsync(0);
    expect(codexAppServer.respond).toHaveBeenCalledWith("request-1", { answers: { release: { answers: [question.options[0].label] } } });
    expect(manager.resolveQuestion(token, ["1"], "channel")).toBeNull();
    expect(messages.at(-1)?.components).toEqual([]);
    await manager.stopSession("channel");
  });

  it("uses the authorized five-minute fallback instead of an empty answer", async () => {
    const { channel, messages } = sink();
    await manager.sendMessage(channel, "plan");
    await feed("item/tool/requestUserInput", { questions: [question] }, 41);
    await vi.advanceTimersByTimeAsync(300000);
    expect(codexAppServer.respond).toHaveBeenCalledWith(41, { answers: { release: { answers: [AUTOMATIC_ANSWER] } } });
    expect(messages.at(-1)?.content).toContain("five minutes");
    expect(messages.at(-1)?.components).toEqual([]);
    await manager.stopSession("channel");
  });

  it("keeps optional questions answerable after the originating turn finishes", async () => {
    const { channel } = sink();
    await manager.sendMessage(channel, "plan");
    await feed("item/tool/requestUserInput", { questions: [question], isBlocking: false }, 42);
    await feed("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(manager.hasPendingCustomInput("channel")).toBe(true);
    expect(manager.resolveCustomInput("channel", "Keep it please")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(codexAppServer.startThread).toHaveBeenCalledTimes(1);
    expect(codexAppServer.startTurn).toHaveBeenLastCalledWith("thread-1", expect.stringContaining("My answer: Keep it please"), []);
    await manager.stopSession("channel");
  });

  it("turns a completed prose question into choices without interrupting ongoing work", async () => {
    const { channel, messages } = sink();
    await manager.sendMessage(channel, "plan");
    await feed("item/completed", { item: { id: "a", type: "agentMessage", text: "Should it remain available?\n- Keep it (Recommended)\n- Disable it" } });
    expect(manager.hasPendingCustomInput("channel")).toBe(false);
    await feed("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(questionToken(messages)).toBeTruthy();
    expect(manager.resolveCustomInput("channel", "Keep it")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(codexAppServer.interruptTurn).not.toHaveBeenCalled();
    expect(codexAppServer.startTurn).toHaveBeenLastCalledWith("thread-1", expect.stringContaining("My answer: Keep it"), []);
    await manager.stopSession("channel");
  });

  it("closes resolved and stopped questions without a later automatic reply", async () => {
    const { channel, messages } = sink();
    await manager.sendMessage(channel, "plan");
    await feed("item/tool/requestUserInput", { questions: [question] }, 41);
    await feed("serverRequest/resolved", { requestId: 41 });
    expect(manager.hasPendingCustomInput("channel")).toBe(false);
    expect(messages.at(-1)?.components).toEqual([]);
    await vi.advanceTimersByTimeAsync(300000);
    expect(codexAppServer.respond).not.toHaveBeenCalled();
    await feed("item/tool/requestUserInput", { questions: [question] }, 42);
    await manager.stopSession("channel");
    await vi.advanceTimersByTimeAsync(300000);
    expect(codexAppServer.respond).not.toHaveBeenCalled();
  });

  it("scopes permission grants to the requested permissions and turn", async () => {
    const { channel } = sink();
    await manager.sendMessage(channel, "plan");
    await feed("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: null } }, "perm");
    expect(manager.resolveApproval("perm", "approve-all", "channel")).toBe(false);
    expect(manager.resolveApproval("perm", "approve", "other")).toBe(false);
    expect(manager.resolveApproval("perm", "approve", "channel")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(codexAppServer.respond).toHaveBeenCalledWith("perm", { permissions: { network: { enabled: true } }, scope: "turn" });
    await manager.stopSession("channel");
  });

  it("resumes a selected existing session and does not silently replace failed resumes", async () => {
    const { channel, messages } = sink();
    vi.mocked(getSession).mockReturnValue({ id: "stored", session_id: "existing" } as NonNullable<ReturnType<typeof getSession>>);
    await manager.sendMessage(channel, "continue");
    expect(codexAppServer.resumeThread).toHaveBeenCalledWith("existing");
    expect(codexAppServer.startThread).not.toHaveBeenCalled();
    await manager.stopSession("channel");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(codexAppServer.resumeThread).mockRejectedValueOnce(new Error("missing thread"));
    await manager.sendMessage(channel, "continue");
    expect(messages.at(-1)?.content).toContain("Failed to resume");
    expect(codexAppServer.startThread).not.toHaveBeenCalled();
    expect(manager.isActive("channel")).toBe(false);
  });

  it("preserves progress and closes questions when a turn fails", async () => {
    const { channel, messages } = sink();
    await manager.sendMessage(channel, "plan");
    await feed("item/completed", { item: { id: "a", type: "agentMessage", text: "I checked the files." } });
    await feed("item/tool/requestUserInput", { questions: [question], isBlocking: false }, 50);
    await feed("turn/completed", { turn: { id: "turn-1", status: "failed", error: { message: "connection lost" } } });
    expect(messages.some((message) => message.content === "I checked the files.")).toBe(true);
    expect(messages.some((message) => message.content?.includes("connection lost"))).toBe(true);
    expect(manager.hasPendingCustomInput("channel")).toBe(false);
    expect(manager.isActive("channel")).toBe(false);
    await vi.advanceTimersByTimeAsync(300000);
    expect(codexAppServer.startTurn).toHaveBeenCalledTimes(1);
  });

  it("closes optional controls when the server resolves a request after turn completion", async () => {
    const { channel, messages } = sink();
    await manager.sendMessage(channel, "plan");
    await feed("item/tool/requestUserInput", { questions: [question], isBlocking: false }, 50);
    await feed("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await feed("serverRequest/resolved", { requestId: 50 });
    expect(manager.hasPendingCustomInput("channel")).toBe(false);
    expect(messages.at(-1)?.components).toEqual([]);
    expect(manager.isActive("channel")).toBe(false);
    await vi.advanceTimersByTimeAsync(300000);
    expect(codexAppServer.startTurn).toHaveBeenCalledTimes(1);
  });

  it("steers the same active turn with native images", async () => {
    const { channel } = sink();
    await manager.sendMessage(channel, "plan", ["/tmp/input.png"]);
    expect(codexAppServer.startTurn).toHaveBeenCalledWith("thread-1", "plan", ["/tmp/input.png"]);
    expect(await manager.steerMessage("channel", "check this", ["/tmp/second.png"])).toBe(true);
    expect(codexAppServer.steerTurn).toHaveBeenCalledWith("thread-1", "turn-1", "check this", ["/tmp/second.png"]);
    await manager.stopSession("channel");
  });
});
