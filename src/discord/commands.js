import { PermissionFlagsBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

export function commandDefinitions() {
  const mod = PermissionFlagsBits.ManageMessages;
  return [
    new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask the server helper a question (rules, roles, channels, FAQ)')
      .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(500))
      .addBooleanOption((o) => o.setName('private').setDescription('Only you see the answer')),
    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Moderators: test how the bot would score a message (nothing is deleted)')
      .setDefaultMemberPermissions(mod)
      .addStringOption((o) => o.setName('text').setDescription('Message text').setRequired(true).setMaxLength(1800)),
    new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('Moderators: strikes and recent cases of a member')
      .setDefaultMemberPermissions(mod)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    new SlashCommandBuilder()
      .setName('clearstrikes')
      .setDescription('Moderators: reset the strikes of a member')
      .setDefaultMemberPermissions(mod)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    new SlashCommandBuilder()
      .setName('modstats')
      .setDescription('Moderators: what the bot did recently')
      .setDefaultMemberPermissions(mod)
      .addIntegerOption((o) => o.setName('days').setDescription('Days (default 7)').setMinValue(1).setMaxValue(90)),
  ].map((c) => c.toJSON());
}

/** Guild commands appear instantly; global commands can take up to an hour. */
export async function registerCommands({ token, clientId, guildIds = [] }) {
  if (!token || !clientId) throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register slash commands');
  const rest = new REST({ version: '10' }).setToken(token);
  const body = commandDefinitions();
  if (guildIds.length) {
    for (const g of guildIds) await rest.put(Routes.applicationGuildCommands(clientId, g), { body });
    return { scope: 'guild', guildIds, count: body.length };
  }
  await rest.put(Routes.applicationCommands(clientId), { body });
  return { scope: 'global', count: body.length };
}

/** Permissions the bot needs: view, send, embed, read history, manage messages, moderate (timeout), ban. */
export const BOT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.BanMembers;

export function inviteUrl(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${BOT_PERMISSIONS.toString()}&scope=bot%20applications.commands`;
}
