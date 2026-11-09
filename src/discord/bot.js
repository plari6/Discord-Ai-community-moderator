import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { registerCommands } from './commands.js';
import { formatMinutes } from '../moderator.js';
import { truncate } from '../text.js';

const COLORS = { urgent: 0xe02424, high: 0xf97316, normal: 0xeab308, low: 0x64748b };
const EVERYONE_RE = /@(everyone|here)\b/;

/** discord.js Message -> the plain object the engine understands. */
export function normalizeMessage(message, botId) {
  const m = message.member;
  const perms = m?.permissions;
  const refId = message.reference?.messageId;
  const ref = refId ? message.channel?.messages?.cache?.get(refId) : null;
  const msg = {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    channelName: message.channel?.name || null,
    content: message.content || '',
    createdAt: message.editedTimestamp || message.createdTimestamp,
    mentionsBot: Boolean(botId && (message.mentions.users.has(botId) || ref?.author?.id === botId)),
    replyToContent: ref?.content || null,
    mentions: {
      users: message.mentions.users.filter((u) => u.id !== botId).size,
      roles: message.mentions.roles.size,
      everyone: message.mentions.everyone || EVERYONE_RE.test(message.content || ''),
    },
    author: {
      id: message.author.id,
      username: m?.displayName || message.author.username,
      bot: message.author.bot || Boolean(message.webhookId),
      accountCreatedAt: message.author.createdTimestamp,
      joinedAt: m?.joinedTimestamp || null,
      roleIds: m ? [...m.roles.cache.keys()] : [],
      isMod: Boolean(perms?.has(PermissionFlagsBits.ManageMessages) || perms?.has(PermissionFlagsBits.Administrator)),
      canMentionEveryone: Boolean(perms?.has(PermissionFlagsBits.MentionEveryone)),
    },
  };
  Object.defineProperty(msg, 'raw', { value: message, enumerable: false });
  return msg;
}

export function caseEmbed(c, { guildId } = {}) {
  const link = c.messageId && c.channelId ? `https://discord.com/channels/${c.guildId || guildId}/${c.channelId}/${c.messageId}` : null;
  const title =
    {
      scam: '🎣 Scam / phishing',
      spam: '📢 Spam',
      toxicity: '☣️ Toxic message',
      self_harm: '🆘 Member may be at risk',
      raid: '🚨 Possible raid',
      new_account: '🆕 Very new account joined',
      question: '❓ Unanswered question',
    }[c.kind] || 'Moderation case';
  const e = new EmbedBuilder()
    .setColor(COLORS[c.priority] || COLORS.low)
    .setTitle(`${title}${c.id ? ` · case #${c.id}` : ''}`)
    .setTimestamp(c.at ? new Date(c.at) : new Date());
  const desc = [];
  if (c.userId) desc.push(`**Member:** <@${c.userId}> (${c.username || c.userId})`);
  if (c.channelId) desc.push(`**Channel:** <#${c.channelId}>${link ? ` · [jump](${link})` : ''}`);
  if (c.content) desc.push(`**Message:**\n>>> ${truncate(c.content, 900)}`);
  e.setDescription(desc.join('\n'));
  if (c.reasons?.length) e.addFields({ name: 'Why', value: truncate(c.reasons.join('\n'), 1000) });
  const scores = [];
  if (c.toxicity !== undefined) scores.push(`toxicity **${c.toxicity}**`);
  if (c.spamScore) scores.push(`spam **${c.spamScore}**`);
  if (c.source) scores.push(`by ${c.source}${c.model ? ` (${c.model})` : ''}`);
  if (scores.length) e.addFields({ name: 'Scores', value: scores.join(' · '), inline: true });
  const did = [];
  if (c.action === 'timeout') did.push(`timed out ${formatMinutes(c.timeoutMinutes)}`);
  if (c.action === 'delete' || c.action === 'timeout') did.push('message deleted');
  if (c.wouldHave) did.push(`observe mode - would have: ${c.wouldHave.deleteMessage ? 'delete' : ''}${c.wouldHave.timeoutMinutes ? `, timeout ${formatMinutes(c.wouldHave.timeoutMinutes)}` : ''}`);
  if (did.length) e.addFields({ name: 'Bot action', value: did.join(', '), inline: true });
  if (c.suggestBan) e.addFields({ name: 'Suggestion', value: 'New or repeat account - consider a ban.', inline: true });
  e.setFooter({ text: `priority: ${c.priority || 'low'}` });
  return e;
}

export function caseButtons(c) {
  if (!c.id || !c.userId) return [];
  const deleted = c.action === 'delete' || c.action === 'timeout';
  const row = new ActionRowBuilder();
  if (!deleted && c.messageId) row.addComponents(new ButtonBuilder().setCustomId(`mod:delete:${c.id}`).setLabel('Delete message').setStyle(ButtonStyle.Secondary));
  if (c.action !== 'timeout') row.addComponents(new ButtonBuilder().setCustomId(`mod:timeout:${c.id}`).setLabel('Timeout').setStyle(ButtonStyle.Secondary));
  row.addComponents(
    new ButtonBuilder().setCustomId(`mod:ban:${c.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mod:dismiss:${c.id}`).setLabel('False positive').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`mod:resolve:${c.id}`).setLabel('Resolved').setStyle(ButtonStyle.Primary)
  );
  return [row];
}

/** Wire the engine to a discord.js client. Returns { client, actions, start, stop }. */
export function createDiscordBot({ app, logger }) {
  const { config } = app;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.Channel],
    allowedMentions: { parse: ['users'], repliedUser: true },
  });
  const allowedGuild = (id) => !config.discord.guildIds.length || config.discord.guildIds.includes(id);

  const channel = async (id) => client.channels.cache.get(id) || client.channels.fetch(id);
  const actions = {
    deleteMessage: async (channelId, messageId) => (await channel(channelId)).messages.delete(messageId),
    timeout: async (guildId, userId, minutes, reason) => {
      const member = await (await client.guilds.fetch(guildId)).members.fetch(userId);
      await member.timeout(Math.min(minutes, 28 * 1440) * 60_000, truncate(reason, 500));
    },
    ban: async (guildId, userId, reason) => (await client.guilds.fetch(guildId)).members.ban(userId, { reason: truncate(reason, 500), deleteMessageSeconds: 3600 }),
    reply: async (msg, text) => msg.raw.reply({ content: truncate(text, 1990), allowedMentions: { parse: [], repliedUser: true } }),
    dm: async (userId, text) => client.users.send(userId, truncate(text, 1990)),
    send: async (channelId, text) => (await channel(channelId)).send({ content: truncate(text, 1990), allowedMentions: { parse: ['users'] } }),
    modLog: async (c) => {
      if (!config.discord.modLogChannelId) return;
      const ping = c.priority === 'urgent' && config.discord.modRoleIds.length ? config.discord.modRoleIds.map((r) => `<@&${r}>`).join(' ') : undefined;
      const sent = await (await channel(config.discord.modLogChannelId)).send({
        content: ping,
        embeds: [caseEmbed(c)],
        components: caseButtons(c),
        allowedMentions: { roles: config.discord.modRoleIds },
      });
      if (c.id) app.store.updateCase(c.id, { modLogMessageId: sent.id });
    },
    alert: app.notifier || undefined,
  };
  app.attachActions(actions);
  const mod = app.moderator;

  client.once(Events.ClientReady, async (c) => {
    logger.info(`[discord] logged in as ${c.user.tag} on ${c.guilds.cache.size} server(s) · mode: ${config.mode}`);
    if (config.discord.registerCommandsOnStart && config.discord.clientId) {
      try {
        const guildIds = config.discord.guildIds.length ? config.discord.guildIds : [...c.guilds.cache.keys()];
        const r = await registerCommands({ token: config.discord.token, clientId: config.discord.clientId, guildIds });
        logger.info(`[discord] ${r.count} slash commands registered (${r.scope})`);
      } catch (err) {
        logger.warn(`[discord] slash command registration failed: ${err.message}`);
      }
    }
    app.health.discord = { ready: true, user: c.user.tag, guilds: c.guilds.cache.size };
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || message.author.bot || !allowedGuild(message.guildId)) return;
    try {
      await mod.handleMessage(normalizeMessage(message, client.user.id));
    } catch (err) {
      logger.error(`[discord] message ${message.id}: ${err.stack || err.message}`);
    }
  });

  // Edits are re-scanned: "edit after posting" is a common way to sneak in a scam link.
  client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
    try {
      if (newMsg.partial) newMsg = await newMsg.fetch();
      if (!newMsg.inGuild() || newMsg.author.bot || !allowedGuild(newMsg.guildId)) return;
      if (oldMsg.content === newMsg.content) return; // embeds loading, pins, etc.
      const msg = normalizeMessage(newMsg, client.user.id);
      msg.mentionsBot = false; // don't answer the same question twice
      await mod.handleMessage(msg);
    } catch (err) {
      logger.debug?.(`[discord] edit scan skipped: ${err.message}`);
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (!allowedGuild(member.guild.id) || member.user.bot) return;
    try {
      await mod.handleJoin({
        id: member.id,
        username: member.user.username,
        guildId: member.guild.id,
        guildName: member.guild.name,
        accountCreatedAt: member.user.createdTimestamp,
        joinedAt: member.joinedTimestamp || Date.now(),
      });
    } catch (err) {
      logger.error(`[discord] join ${member.id}: ${err.message}`);
    }
  });

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.isButton() && i.customId.startsWith('mod:')) return await onButton(i);
      if (i.isChatInputCommand()) return await onCommand(i);
    } catch (err) {
      logger.error(`[discord] interaction: ${err.message}`);
      const reply = { content: `Something went wrong: ${err.message}`, flags: MessageFlags.Ephemeral };
      if (i.isRepliable()) (i.deferred || i.replied ? i.followUp(reply) : i.reply(reply)).catch(() => {});
    }
  });

  async function onButton(i) {
    const [, action, caseId] = i.customId.split(':');
    const perms = i.memberPermissions;
    const needed = action === 'ban' ? PermissionFlagsBits.BanMembers : action === 'timeout' ? PermissionFlagsBits.ModerateMembers : PermissionFlagsBits.ManageMessages;
    if (!perms?.has(needed)) return i.reply({ content: 'You do not have permission for that action.', flags: MessageFlags.Ephemeral });
    const r = await mod.review(caseId, action, { id: i.user.id, username: i.user.username });
    if (!r.case) return i.reply({ content: r.error, flags: MessageFlags.Ephemeral });
    const embed = EmbedBuilder.from(i.message.embeds[0]).setFooter({
      text: `${r.case.status === 'false_positive' ? '✅ false positive' : '✔ resolved'} by ${i.user.username}: ${r.note}${r.errors.length ? ` (errors: ${r.errors.join('; ')})` : ''}`,
    });
    await i.update({ embeds: [embed], components: [] });
  }

  async function onCommand(i) {
    if (i.commandName === 'ask') {
      const ephemeral = i.options.getBoolean('private') ?? false;
      await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      const q = i.options.getString('question', true);
      const r = await mod.ask(q, { channelId: i.channelId });
      return i.editReply(truncate(`> ${q}\n${r.text}`, 1990));
    }
    if (i.commandName === 'check') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const text = i.options.getString('text', true);
      const r = await mod.checkOnly({
        id: `check-${i.id}`,
        guildId: i.guildId,
        channelId: `check-${i.id}`,
        content: text,
        createdAt: Date.now(),
        mentions: { users: 0, roles: 0, everyone: false },
        author: { id: `check-${i.user.id}`, username: i.user.username },
      });
      const d = r.decision;
      return i.editReply(
        [
          `**Decision:** ${d.action}${d.kind ? ` (${d.kind})` : ''}`,
          `**Toxicity:** ${r.tox.toxicity}/100 ${r.tox.categories.join(', ')}${r.tox.is_banter ? ' (banter)' : ''} - ${r.tox.reason || ''}`,
          `**Spam:** ${r.spam.score}/100 ${r.spam.signals.join(', ')}`,
          `**Scored by:** ${r.tox.source}${r.tox.model ? ` (${r.tox.model})` : ''}`,
          d.reasons.length ? `**Why:** ${d.reasons.join('; ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
    if (i.commandName === 'warnings') {
      const user = i.options.getUser('user', true);
      const n = app.store.strikes(i.guildId, user.id, config.thresholds.strikeWindowHours * 3_600_000);
      const cases = app.store.cases({ userId: user.id, limit: 5 });
      const lines = cases.map((c) => `#${c.id} <t:${Math.floor(c.at / 1000)}:R> ${c.action} ${c.kind || ''} - ${truncate(c.reasons?.[0] || '', 80)} (${c.status})`);
      return i.reply({ content: `**${user.username}**: ${n} strike(s) in the last ${config.thresholds.strikeWindowHours}h\n${lines.join('\n') || 'No cases.'}`, flags: MessageFlags.Ephemeral });
    }
    if (i.commandName === 'clearstrikes') {
      const user = i.options.getUser('user', true);
      app.store.clearStrikes(i.guildId, user.id);
      return i.reply({ content: `Strikes cleared for ${user.username}.`, flags: MessageFlags.Ephemeral });
    }
    if (i.commandName === 'modstats') {
      const days = i.options.getInteger('days') ?? 7;
      const s = app.store.statsFor(days);
      const lines = Object.entries(s)
        .sort()
        .map(([k, v]) => `${k}: **${v}**`);
      const gaps = app.store.gaps(5).map((g) => `• ${truncate(g.question, 90)} (${g.count}x)`);
      return i.reply({
        content: `**Last ${days} day(s)**\n${lines.join('\n') || 'No activity yet.'}${gaps.length ? `\n\n**Top unanswered questions** (add them to the FAQ):\n${gaps.join('\n')}` : ''}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  return {
    client,
    actions,
    start: () => client.login(config.discord.token),
    stop: () => client.destroy(),
  };
}
