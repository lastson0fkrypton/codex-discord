import { describe, it, expect, beforeEach, vi } from "vitest";

const migration = vi.hoisted(() => ({ legacy: false }));

// Mock better-sqlite3 to always use :memory:
vi.mock("better-sqlite3", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await vi.importActual("better-sqlite3") as any;
  const RealDatabase = actual.default;
  return {
    default: function MemoryDatabase(_path: string, options?: object) {
      const memory = new RealDatabase(":memory:", options);
      if (migration.legacy) memory.exec(`CREATE TABLE projects (
        channel_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, guild_id TEXT NOT NULL,
        auto_approve INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
      ); INSERT INTO projects (channel_id, project_path, guild_id, auto_approve)
        VALUES ('legacy', '/old/project', 'old-guild', 1);`);
      return memory;
    },
  };
});

import {
  initDatabase,
  registerProject,
  unregisterProject,
  getProject,
  getAllProjects,
  setAutoApprove,
  setAutoDecision,
  upsertSession,
  getSession,
  updateSessionStatus,
  getAllSessions,
} from "./database.js";

describe("database", () => {
  beforeEach(() => {
    initDatabase();
  });

  // ─── Project CRUD ───

  describe("project CRUD", () => {
    it("registerProject + getProject", () => {
      registerProject("ch1", "/path/to/project", "guild1");
      const project = getProject("ch1");
      expect(project).toBeDefined();
      expect(project!.project_path).toBe("/path/to/project");
      expect(project!.guild_id).toBe("guild1");
      expect(project!.auto_approve).toBe(0);
    });

    it("registerProject with same channelId replaces existing", () => {
      registerProject("ch1", "/old/path", "guild1");
      registerProject("ch1", "/new/path", "guild1");
      const project = getProject("ch1");
      expect(project!.project_path).toBe("/new/path");
    });

    it("getProject returns undefined for non-existent channel", () => {
      expect(getProject("nonexistent")).toBeUndefined();
    });

    it("getAllProjects filters by guild", () => {
      registerProject("ch1", "/p1", "guild1");
      registerProject("ch2", "/p2", "guild1");
      registerProject("ch3", "/p3", "guild2");
      expect(getAllProjects("guild1")).toHaveLength(2);
      expect(getAllProjects("guild2")).toHaveLength(1);
      expect(getAllProjects("guild3")).toHaveLength(0);
    });

    it("unregisterProject removes project and cascades to sessions", () => {
      registerProject("ch1", "/p1", "guild1");
      upsertSession("s1", "ch1", null, "online");
      unregisterProject("ch1");
      expect(getProject("ch1")).toBeUndefined();
      expect(getSession("ch1")).toBeUndefined();
    });

    it("setAutoApprove toggles auto_approve flag", () => {
      registerProject("ch1", "/p1", "guild1");
      expect(getProject("ch1")!.auto_approve).toBe(0);

      setAutoApprove("ch1", true);
      expect(getProject("ch1")!.auto_approve).toBe(1);

      setAutoApprove("ch1", false);
      expect(getProject("ch1")!.auto_approve).toBe(0);
    });
  });

  it("migrates existing projects to auto-decision off while preserving their settings", () => {
    migration.legacy = true;
    try { initDatabase(); } finally { migration.legacy = false; }
    expect(getProject("legacy")).toMatchObject({ project_path: "/old/project", auto_approve: 1, auto_decision: 0 });
    setAutoDecision("legacy", true);
    expect(getProject("legacy")!.auto_decision).toBe(1);
    registerProject("other", "/other", "old-guild");
    expect(getProject("other")!.auto_decision).toBe(0);
    setAutoDecision("legacy", false);
    expect(getProject("legacy")!.auto_decision).toBe(0);
  });

  // ─── Session CRUD ───

  describe("session CRUD", () => {
    beforeEach(() => {
      registerProject("ch1", "/p1", "guild1");
    });

    it("upsertSession + getSession", () => {
      upsertSession("s1", "ch1", "sdk-session-1", "online");
      const session = getSession("ch1");
      expect(session).toBeDefined();
      expect(session!.session_id).toBe("sdk-session-1");
      expect(session!.status).toBe("online");
    });

    it("upsertSession replaces existing session with same id", () => {
      upsertSession("s1", "ch1", null, "online");
      upsertSession("s1", "ch1", "sdk-1", "idle");
      const session = getSession("ch1");
      expect(session!.session_id).toBe("sdk-1");
      expect(session!.status).toBe("idle");
    });

    it("upsertSession with null sessionId", () => {
      upsertSession("s1", "ch1", null, "online");
      const session = getSession("ch1");
      expect(session!.session_id).toBeNull();
    });

    it("updateSessionStatus changes status", () => {
      upsertSession("s1", "ch1", null, "online");
      updateSessionStatus("ch1", "waiting");
      expect(getSession("ch1")!.status).toBe("waiting");
    });

    it("getAllSessions joins with projects", () => {
      registerProject("ch2", "/p2", "guild1");
      upsertSession("s1", "ch1", null, "online");
      upsertSession("s2", "ch2", null, "idle");
      const sessions = getAllSessions("guild1");
      expect(sessions).toHaveLength(2);
      expect(sessions[0].project_path).toBeDefined();
    });

    it("getAllSessions returns empty for guild with no sessions", () => {
      registerProject("ch2", "/p2", "guild2");
      expect(getAllSessions("guild2")).toHaveLength(0);
    });
  });
});
