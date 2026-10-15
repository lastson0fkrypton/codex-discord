import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";
import { handleMessage } from "./message.js";
import { sessionManager } from "../../codex/session-manager.js";
vi.mock("../../db/database.js", () => ({ getProject: () => ({ project_path: "/project" }) }));
vi.mock("../../security/guard.js", () => ({ isAllowedUser: () => true, checkRateLimit: () => true }));
vi.mock("../../utils/i18n.js", () => ({ L: (en: string) => en }));
vi.mock("../../codex/session-manager.js", () => ({ sessionManager: {
  hasPendingCustomInput: vi.fn(), resolveCustomInput: vi.fn(), isActive: vi.fn(), steerMessage: vi.fn(), sendMessage: vi.fn(),
  setPendingQueue: vi.fn(), hasQueue: vi.fn(), isQueueFull: vi.fn(),
} }));
function message() {
  return { author: { id: "user", bot: false }, guild: {}, channelId: "c", channel: { id: "c" },
    content: "Please check this", attachments: new Map(), react: vi.fn().mockResolvedValue(undefined), reply: vi.fn(),
  } as unknown as Message;
}
describe("Discord replies", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("routes a plain typed answer to the pending question before steering", async () => {
    vi.mocked(sessionManager.hasPendingCustomInput).mockReturnValue(true);
    vi.mocked(sessionManager.resolveCustomInput).mockReturnValue(true);
    await handleMessage(message());
    expect(sessionManager.resolveCustomInput).toHaveBeenCalledWith("c", "Please check this");
    expect(sessionManager.steerMessage).not.toHaveBeenCalled();
    expect(sessionManager.sendMessage).not.toHaveBeenCalled();
  });
  it("delivers live feedback once even if a reaction is forbidden", async () => {
    vi.mocked(sessionManager.isActive).mockReturnValue(true);
    vi.mocked(sessionManager.steerMessage).mockResolvedValue(true);
    const incoming = message();
    vi.mocked(incoming.react).mockRejectedValue(new Error("Missing reaction permission"));
    await handleMessage(incoming);
    expect(sessionManager.steerMessage).toHaveBeenCalledWith("c", "Please check this", []);
    expect(sessionManager.sendMessage).not.toHaveBeenCalled();
    expect(sessionManager.setPendingQueue).not.toHaveBeenCalled();
  });
  it("continues normally when no turn is running", async () => {
    const incoming = message();
    await handleMessage(incoming);
    expect(sessionManager.sendMessage).toHaveBeenCalledWith(incoming.channel, incoming.content, []);
  });
});
