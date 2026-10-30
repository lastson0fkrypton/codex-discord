import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { data, execute } from "./autodecision.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../codex/session-manager.js";
vi.mock("../../db/database.js", () => ({ getProject: vi.fn() }));
vi.mock("../../codex/session-manager.js", () => ({ sessionManager: { setAutoDecision: vi.fn() } }));

describe("/autodecision", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it.each(["on", "off"])("applies %s to the current channel", async (mode) => {
    vi.mocked(getProject).mockReturnValue({ channel_id: "c" } as NonNullable<ReturnType<typeof getProject>>);
    const editReply = vi.fn();
    await execute({ channelId: "c", options: { getString: () => mode }, editReply } as unknown as ChatInputCommandInteraction);
    expect(sessionManager.setAutoDecision).toHaveBeenCalledWith("c", mode === "on");
    expect(editReply).toHaveBeenCalledWith({ content: expect.stringContaining(`Auto-decision: ${mode.toUpperCase()}`) });
  });
  it("rejects unregistered channels", async () => {
    const editReply = vi.fn();
    await execute({ channelId: "missing", editReply } as unknown as ChatInputCommandInteraction);
    expect(sessionManager.setAutoDecision).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: expect.stringContaining("not registered") });
  });
  it("registers the required on/off choices", () => {
    const command = data.toJSON();
    expect(command.name).toBe("autodecision");
    expect(command.options?.[0]).toMatchObject({ name: "mode", required: true, choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }] });
  });
});
