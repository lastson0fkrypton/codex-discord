import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChatInputCommandInteraction } from "discord.js";

vi.mock("../../codex/storage.js", () => ({
  listStoredThreads: vi.fn(),
}));

vi.mock("../../db/database.js", () => ({
  getProject: vi.fn(),
  getSession: vi.fn(),
  upsertSession: vi.fn(),
}));

import { getProject, getSession } from "../../db/database.js";
import { listStoredThreads } from "../../codex/storage.js";
import {
  execute,
  findSessionDir,
  getLastAssistantMessage,
  getLastAssistantMessageFull,
  listSessions,
} from "./sessions.js";

describe("sessions helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("findSessionDir returns the parent directory of the first rollout file", () => {
    vi.mocked(listStoredThreads).mockReturnValue([
      {
        id: "thread-1",
        rollout_path: "/tmp/codex/2026/03/rollout-1.jsonl",
        created_at: 1,
        updated_at: 2,
        source: "vscode",
        model_provider: "openai",
        cwd: "/project",
        title: "Hello",
      },
    ]);

    expect(findSessionDir("/project")).toBe("/tmp/codex/2026/03");
  });

  it("findSessionDir returns null when no stored threads exist", () => {
    vi.mocked(listStoredThreads).mockReturnValue([]);
    expect(findSessionDir("/project")).toBeNull();
  });

  it("getLastAssistantMessageFull reads Codex agentMessage entries", async () => {
    const filePath = path.join(os.tmpdir(), `codex-session-${Date.now()}.jsonl`);
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "item_completed", item: { type: "agentMessage", text: "First" } }),
        JSON.stringify({ type: "item_completed", item: { type: "agentMessage", text: "Line 1\nLine 2" } }),
      ].join("\n"),
    );

    const result = await getLastAssistantMessageFull(filePath);
    expect(result).toBe("Line 1\nLine 2");
  });

  it("getLastAssistantMessage returns the last line of the last message", async () => {
    const filePath = path.join(os.tmpdir(), `codex-session-last-${Date.now()}.jsonl`);
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "item_completed", item: { type: "agentMessage", text: "Part A" } }),
        JSON.stringify({ type: "item_completed", item: { type: "agentMessage", text: "Part B\nTail" } }),
      ].join("\n"),
    );

    const result = await getLastAssistantMessage(filePath);
    expect(result).toBe("Tail");
  });

  it("listSessions maps stored threads into session summaries", async () => {
    vi.mocked(listStoredThreads).mockReturnValue([
      {
        id: "thread-1",
        rollout_path: "/tmp/rollout-1.jsonl",
        created_at: 1,
        updated_at: 1700000000,
        source: "vscode",
        model_provider: "openai",
        cwd: "/project",
        title: "Analyze repo",
      },
    ]);

    const result = await listSessions("/project");
    expect(result).toEqual([
      {
        sessionId: "thread-1",
        preview: "Analyze repo",
        timestamp: new Date(1700000000 * 1000).toISOString(),
        source: "vscode",
      },
    ]);
  });
});

describe("sessions command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getProject).mockReturnValue({
      channel_id: "channel-1",
      project_path: "/project",
      guild_id: "guild-1",
      auto_approve: 0,
      auto_decision: 0,
      created_at: "2026-09-26",
    });
  });

  it("lists sessions with long subagent metadata without exceeding Discord limits", async () => {
    const source = JSON.stringify({
      subagent: {
        thread_spawn: {
          parent_thread_id: "01a0db01-9a1e-7d20-aa32-3e12d6eb23a9",
          depth: 1,
          agent_path: "/root/avatar_animation",
          agent_nickname: "Popper",
          agent_role: null,
        },
      },
    });
    const updatedAt = 1790381369;
    vi.mocked(listStoredThreads).mockReturnValue([
      {
        id: "thread-1",
        rollout_path: "/tmp/rollout-1.jsonl",
        created_at: updatedAt,
        updated_at: updatedAt,
        source,
        model_provider: "openai",
        cwd: "/project",
        title: "A".repeat(200),
      },
    ]);
    const editReply = vi.fn().mockResolvedValue(undefined);

    await execute({ channelId: "channel-1", editReply } as unknown as ChatInputCommandInteraction);

    // Serialize the real Discord builders so their validation runs as it does on send.
    const row = editReply.mock.calls[0][0].components[0].toJSON();
    const option = row.components[0].options[1];
    expect(option.value).toBe("thread-1");
    expect(option.label).toBe("A".repeat(70) + "…");
    expect(option.description.length).toBeLessThanOrEqual(100);
    expect(option.description).toContain("… • ");
    expect(option.description.endsWith(new Date(updatedAt * 1000).toLocaleString())).toBe(true);
  });

  it("keeps the new-session option and active selection when listing many sessions", async () => {
    vi.mocked(listStoredThreads).mockReturnValue(Array.from({ length: 30 }, (_, index) => ({
      id: `thread-${index}`,
      rollout_path: `/tmp/rollout-${index}.jsonl`,
      created_at: 1,
      updated_at: 1700000000,
      source: "vscode",
      model_provider: "openai",
      cwd: "/project",
      title: index === 0 ? "" : `Session ${index}`,
    })));
    vi.mocked(getSession).mockReturnValue({
      id: "local-session",
      channel_id: "channel-1",
      session_id: "thread-1",
      status: "idle",
      last_activity: null,
      created_at: "2026-09-26",
    });
    const editReply = vi.fn().mockResolvedValue(undefined);

    await execute({ channelId: "channel-1", editReply } as unknown as ChatInputCommandInteraction);

    const options = editReply.mock.calls[0][0].components[0].toJSON().components[0].options;
    expect(options).toHaveLength(25);
    expect(options[0].value).toBe("__new_session__");
    expect(options[1].label).toBe("(empty session)");
    expect(options[2].default).toBe(true);
    expect(options[2].description).toBe(`vscode • ${new Date(1700000000 * 1000).toLocaleString()}`);
  });
});
