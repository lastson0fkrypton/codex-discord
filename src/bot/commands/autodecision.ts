import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { getProject } from "../../db/database.js";
import { sessionManager } from "../../codex/session-manager.js";

export const data = new SlashCommandBuilder()
  .setName("autodecision")
  .setDescription("Enable or disable automatic answers after five minutes in this channel")
  .addStringOption((option) => option.setName("mode").setDescription("on or off").setRequired(true)
    .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!getProject(interaction.channelId)) {
    await interaction.editReply({ content: "This channel is not registered to any project." });
    return;
  }
  const enabled = interaction.options.getString("mode", true) === "on";
  sessionManager.setAutoDecision(interaction.channelId, enabled);
  await interaction.editReply({ content: enabled
    ? "Auto-decision: ON. Unanswered decisions will ask Codex to choose after five minutes. This also applies to pending questions. This setting is saved for this channel."
    : "Auto-decision: OFF. Decisions will wait for your answer. Automatic decision timers on pending questions have been cancelled. This setting is saved for this channel." });
}
