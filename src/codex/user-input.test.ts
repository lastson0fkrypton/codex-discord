import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextChannel } from "discord.js";
import { AUTOMATIC_ANSWER, conversationQuestions, UserInput } from "./user-input.js";
vi.mock("../utils/i18n.js", () => ({ L: (en: string) => en }));
function setup() {
  const edit = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({ edit });
  const channel = { id: "c", send } as unknown as TextChannel;
  const input = new UserInput();
  const label = "Keep this ".repeat(40);
  const promise = input.ask(channel, "scope", { id: "q", header: "x".repeat(300), question: "q".repeat(4000), options: [
    { label, description: "d".repeat(1000) }, { label: "Disable", description: "" },
  ] }, 0, 1);
  const payload = send.mock.calls[0][0];
  const token = payload.components[0].toJSON().components[0].custom_id.split(":")[1];
  return { input, promise, label, token, payload, edit };
}
describe("question cards", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it("validates bounded cards but preserves original full answer values", async () => {
    const { input, promise, label, token, payload } = setup();
    expect(() => payload.embeds[0].toJSON()).not.toThrow();
    for (const row of payload.components) expect(() => row.toJSON()).not.toThrow();
    expect(input.select(token, ["0"], "wrong")).toBeNull();
    expect(input.select(token, ["999"], "c")).toBeNull();
    expect(input.select(token, ["0"], "c")).toEqual([label]);
    expect(await promise).toEqual([label]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("accepts typed replies without pressing Custom input first", async () => {
    const { input, promise, edit } = setup();
    await Promise.resolve();
    expect(input.reply("c", "Something else")).toBe(true);
    expect(await promise).toEqual(["Something else"]);
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });
  it("cleans up a card that arrives after the answer", async () => {
    const { input, promise, edit } = setup();
    input.reply("c", "yes");
    await promise;
    await Promise.resolve();
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });
  it("returns an explicit instruction on timeout and cancels without defaulting", async () => {
    const timed = setup();
    await vi.advanceTimersByTimeAsync(300000);
    expect(await timed.promise).toEqual([AUTOMATIC_ANSWER]);
    const cancelled = setup();
    cancelled.input.cancel("scope");
    expect(await cancelled.promise).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("detects the user's example choices and ignores ordinary work lists", () => {
    expect(conversationQuestions({ text: "For Steam, should it remain available? I’ll preserve it unless you prefer otherwise.\n- Keep it; label runs assisted (Recommended)\n- Disable it in release builds" })[0].options).toHaveLength(2);
    expect(conversationQuestions({ text: "I will do these tasks:\n- Read files\n- Run tests" })).toEqual([]);
    expect(conversationQuestions({ text: "```\nWhich?\n- One\n- Two\n```" })).toEqual([]);
  });
});
