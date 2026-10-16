import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => Promise<void>>(),
  login: vi.fn().mockResolvedValue(undefined),
  execute: vi.fn().mockResolvedValue(undefined),
  autocomplete: vi.fn().mockResolvedValue(undefined),
  button: vi.fn().mockResolvedValue(undefined),
  select: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("discord.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("discord.js")>(),
  Client: class {
    on(event: string, callback: (...args: any[]) => Promise<void>) {
      mocks.listeners.set(event, callback);
    }
    login = mocks.login;
  },
}));
vi.mock("../utils/config.js", () => ({ getConfig: () => ({
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "guild",
  DISCORD_CHANNEL_ID: "1559093425817522218",
  ALLOWED_USER_IDS: ["admin"],
  BASE_PROJECT_DIR: "/projects",
}) }));
vi.mock("./handlers/interaction.js", () => ({
  handleButtonInteraction: mocks.button,
  handleSelectMenuInteraction: mocks.select,
}));

let startBot: typeof import("./client.js").startBot;

beforeAll(async () => {
  for (const name of ["register", "unregister", "status", "stop", "auto-approve", "sessions", "clear-sessions", "last", "queue", "usage"]) {
    vi.doMock(`./commands/${name}.js`, () => ({
      data: { name },
      execute: mocks.execute,
      autocomplete: mocks.autocomplete,
    }));
  }
  ({ startBot } = await import("./client.js"));
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  await startBot();
});

function interaction(kind: string, channelId = "other-channel") {
  return {
    channelId,
    guildId: "guild",
    user: { id: "admin" },
    memberPermissions: { has: () => true },
    commandName: "register",
    isAutocomplete: () => kind === "autocomplete",
    isChatInputCommand: () => kind === "command",
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isRepliable: () => kind !== "autocomplete",
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

describe("configured Discord channel", () => {
  it.each(["command", "button", "select"])("rejects %s outside the channel even for an administrator", async (kind) => {
    const incoming = interaction(kind);
    await mocks.listeners.get("interactionCreate")!(incoming);
    expect(incoming.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: ["Ephemeral"] }));
    expect(incoming.deferReply).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.button).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("returns no autocomplete suggestions outside the channel", async () => {
    const incoming = interaction("autocomplete");
    await mocks.listeners.get("interactionCreate")!(incoming);
    expect(incoming.respond).toHaveBeenCalledWith([]);
    expect(mocks.autocomplete).not.toHaveBeenCalled();
  });

  it.each(["command", "button", "select", "autocomplete"])("routes %s normally in the configured channel", async (kind) => {
    const incoming = interaction(kind, "1559093425817522218");
    await mocks.listeners.get("interactionCreate")!(incoming);
    const handler = { command: mocks.execute, button: mocks.button, select: mocks.select, autocomplete: mocks.autocomplete }[kind]!;
    expect(handler).toHaveBeenCalledWith(incoming);
    expect(incoming.reply).not.toHaveBeenCalled();
  });
});
