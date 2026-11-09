import { createSpamDetector } from './spam.js';
import { createToxicityClassifier } from './toxicity.js';
import { createQA, fill } from './knowledge.js';
import { decide, warningText } from './policy.js';
import { looksLikeQuestion, truncate } from './text.js';

/**
 * The moderation engine. It works on plain "normalized" message objects and talks to Discord
 * only through an `actions` adapter, so the same engine runs in the real bot, the CLI demo and
 * the tests.
 *
 * Normalized message:
 * { id, guildId, channelId, channelName, content, createdAt, mentionsBot, replyToContent,
 *   mentions: { users, roles, everyone },
 *   author: { id, username, bot, accountCreatedAt, joinedAt, roleIds, isMod, canMentionEveryone } }
 *
 * Actions adapter (every method optional, every failure is caught and recorded on the case):
 * deleteMessage(channelId, messageId, reason), timeout(guildId, userId, minutes, reason),
 * reply(msg, text), dm(userId, text), send(channelId, text), modLog(case), alert(case)
 */
export function createModerator({ config, kb, router, store, actions = {}, logger = console, now = () => Date.now() }) {
  const spam = createSpamDetector(config.spam);
  const toxicity = createToxicityClassifier({ router, cfg: config.toxicity, logger, now });
  const qa = createQA({ kb, router, cfg: config.qa, logger });
  const context = new Map(); // channelId -> last messages
  const qaCooldown = new Map(); // userId -> last answer time
  const joins = []; // recent join times (raid detection)
  let raidAlertAt = 0;

  const exemptRoles = new Set([...config.discord.exemptRoleIds, ...config.discord.modRoleIds]);
  const days = (ms) => ms / 86_400_000;

  async function act(name, fn, errors) {
    if (typeof fn !== 'function') return false;
    try {
      await fn();
      return true;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      logger.warn?.(`[mod] ${name} failed: ${err.message}`);
      return false;
    }
  }

  function memberInfo(msg) {
    const a = msg.author;
    const t = msg.createdAt || now();
    return {
      exempt: Boolean(a.isMod) || (a.roleIds || []).some((r) => exemptRoles.has(r)),
      isNewMember: a.joinedAt ? days(t - a.joinedAt) < config.qa.newMemberDays : false,
      isNewAccount: a.accountCreatedAt ? days(t - a.accountCreatedAt) < config.spam.newAccountDays : false,
      strikes: store.strikes(msg.guildId, a.id, config.thresholds.strikeWindowHours * 3_600_000),
    };
  }

  function remember(msg) {
    const list = context.get(msg.channelId) || [];
    list.push({ authorName: msg.author.username, content: truncate(msg.content, 300) });
    context.set(msg.channelId, list.slice(-Math.max(1, config.toxicity.contextMessages)));
    if (context.size > 2000) context.delete(context.keys().next().value);
  }

  /** Scan one message. Returns everything that was decided and done (used by logs, demo and tests). */
  async function handleMessage(msg) {
    if (!msg || msg.author?.bot || !String(msg.content || '').trim()) return { skipped: 'bot or empty' };
    if (config.discord.ignoredChannelIds.includes(msg.channelId)) return { skipped: 'ignored channel' };
    store.count('messages');

    const member = memberInfo(msg);
    const spamResult = spam.check(msg, msg.createdAt || now());
    const tox = await toxicity.classify(msg, { context: context.get(msg.channelId) || [], spamScore: spamResult.score, isNewMember: member.isNewMember });
    remember(msg);
    const decision = decide({ spam: spamResult, tox, member, thresholds: config.thresholds, mode: config.mode });
    const result = { message: msg, spam: spamResult, tox, member, decision, errors: [], done: [] };

    if (decision.action !== 'none' || decision.supportDm) {
      await execute(result);
    }

    // Answer questions (new members, help channels, @mentions) if the message survived.
    if (!decision.deleteMessage && !decision.supportDm) result.qa = await maybeAnswer(msg, member);
    return result;
  }

  async function execute(result) {
    const { message: msg, decision: d, spam: s, tox, errors, done } = result;
    const reason = truncate(d.reasons.join('; '), 400);
    const rec = store.addCase({
      guildId: msg.guildId,
      channelId: msg.channelId,
      channelName: msg.channelName,
      messageId: msg.id,
      userId: msg.author.id,
      username: msg.author.username,
      content: truncate(msg.content, 1000),
      kind: d.kind,
      action: d.action,
      priority: d.priority,
      flag: d.flag,
      reasons: d.reasons,
      spamScore: s.score,
      spamSignals: s.signals,
      toxicity: tox.toxicity,
      categories: tox.categories,
      source: tox.source,
      model: tox.model || null,
      timeoutMinutes: d.timeoutMinutes,
      suggestBan: d.suggestBan,
      wouldHave: d.wouldHave || null,
      mode: config.mode,
    });
    result.case = rec;
    store.count(`action_${d.action}`);
    if (d.kind) store.count(`kind_${d.kind}`);

    if (d.deleteMessage && (await act('delete', () => actions.deleteMessage?.(msg.channelId, msg.id, reason), errors))) done.push('deleted message');
    if (d.deleteRelated && s.related.length) {
      let n = 0;
      for (const r of s.related.slice(0, 20)) if (await act('delete related', () => actions.deleteMessage?.(r.channelId, r.messageId, reason), errors)) n++;
      if (n) done.push(`deleted ${n} related message(s)`);
    }
    if (d.timeoutMinutes && (await act('timeout', () => actions.timeout?.(msg.guildId, msg.author.id, d.timeoutMinutes, reason), errors)))
      done.push(`timed out ${formatMinutes(d.timeoutMinutes)}`);
    if (d.strike) {
      store.addStrike(msg.guildId, msg.author.id, rec.id);
      done.push(`strike ${d.strikesAfter}`);
    }
    if (d.warn) {
      const text = warningText(d, { mention: `<@${msg.author.id}>` });
      // the message is gone, so warn by DM; fall back to a channel reply if DMs are closed
      const ok = await act('warn dm', () => actions.dm?.(msg.author.id, `${text}\n> ${truncate(msg.content, 200)}`), errors);
      if (ok) done.push('warned by DM');
      else if (await act('warn reply', () => actions.send?.(msg.channelId, text), errors)) done.push('warned in channel');
    }
    if (d.supportDm && (await act('support dm', () => actions.dm?.(msg.author.id, `Hey ${msg.author.username}, I noticed your message. ${kb.selfHarmResources}`), errors)))
      done.push('sent support resources');
    if (d.flag && (await act('mod-log', () => actions.modLog?.(rec), errors))) done.push('reported to mod-log');
    if (d.priority === 'urgent' && (await act('alert', () => actions.alert?.(rec), errors))) done.push('alerted staff');
    store.updateCase(rec.id, { done, errors });
    logger.info?.(`[mod] case #${rec.id} ${d.action} ${msg.author.username} in #${msg.channelName || msg.channelId}: ${reason}`);
  }

  function qaTrigger(msg, member) {
    if (msg.mentionsBot) return 'mention';
    if (!config.qa.autoAnswer || !looksLikeQuestion(msg.content)) return null;
    if (config.discord.helpChannelIds.includes(msg.channelId)) return 'help-channel';
    if (member.isNewMember && config.qa.answerNewMembersAnywhere) return 'new-member';
    return null;
  }

  async function maybeAnswer(msg, member) {
    const trigger = qaTrigger(msg, member);
    if (!trigger) return null;
    const explicit = trigger === 'mention';
    const last = qaCooldown.get(msg.author.id) || 0;
    if (!explicit && now() - last < config.qa.userCooldownMs) return { trigger, skipped: 'cooldown' };
    const r = await qa.answer(msg.content, { explicit });
    if (r.gap) {
      store.addGap({ question: truncate(msg.content.replace(/<@[!&]?\d+>|^@[\w.]+/g, '').trim(), 300), channelId: msg.channelId });
      store.count('qa_gap');
    }
    if (r.text) {
      qaCooldown.set(msg.author.id, now());
      const errors = [];
      await act('answer', () => actions.reply?.(msg, r.text), errors);
      store.count(r.answered ? `qa_${r.source}` : 'qa_unanswered');
      if (!r.answered && explicit)
        await act('mod-log', () => actions.modLog?.({ id: null, kind: 'question', priority: 'low', userId: msg.author.id, username: msg.author.username, channelId: msg.channelId, messageId: msg.id, content: msg.content, reasons: ['question the bot could not answer - consider adding it to the FAQ'], action: 'flag', flag: true }), errors);
      return { trigger, ...r, errors };
    }
    return { trigger, ...r };
  }

  /** Slash command /ask: always answers (says so when it does not know). */
  async function ask(question, meta = {}) {
    const r = await qa.answer(question, { explicit: true });
    if (r.gap) store.addGap({ question: truncate(question, 300), channelId: meta.channelId });
    store.count(r.answered ? `qa_${r.source}` : 'qa_unanswered');
    return r;
  }

  /**
   * New member joined: raid detection, young-account flag, welcome message and DM.
   * member: { id, username, guildId, guildName, accountCreatedAt, joinedAt }
   */
  async function handleJoin(member) {
    const t = member.joinedAt || now();
    const errors = [];
    const done = [];
    store.count('joins');
    joins.push(t);
    while (joins.length && t - joins[0] > config.welcome.raidWindowMs) joins.shift();
    let raid = false;
    if (joins.length >= config.welcome.raidJoinCount && t - raidAlertAt > config.welcome.raidWindowMs) {
      raid = true;
      raidAlertAt = t;
      const rec = store.addCase({ guildId: member.guildId, kind: 'raid', action: 'flag', flag: true, priority: 'urgent', userId: member.id, username: member.username, content: '', reasons: [`${joins.length} members joined in ${Math.round(config.welcome.raidWindowMs / 1000)}s - possible raid. Consider enabling a higher verification level or pausing invites.`] });
      store.count('raids');
      await act('mod-log', () => actions.modLog?.(rec), errors);
      await act('alert', () => actions.alert?.(rec), errors);
      done.push('raid alert');
    }
    const ageDays = member.accountCreatedAt ? days(t - member.accountCreatedAt) : Infinity;
    if (ageDays < config.welcome.minAccountAgeDays && !raid) {
      const rec = store.addCase({ guildId: member.guildId, kind: 'new_account', action: 'flag', flag: true, priority: 'low', userId: member.id, username: member.username, content: '', reasons: [`account is ${ageDays < 1 ? 'less than a day' : `${Math.floor(ageDays)} day(s)`} old - watch for spam`] });
      await act('mod-log', () => actions.modLog?.(rec), errors);
      done.push('flagged young account');
    }
    if (config.welcome.enabled && !raid) {
      const vars = { user: `<@${member.id}>`, name: member.username, server: member.guildName || kb.server.name };
      if (config.discord.welcomeChannelId && kb.welcome.message && (await act('welcome', () => actions.send?.(config.discord.welcomeChannelId, fill(kb.welcome.message, vars)), errors)))
        done.push('welcome message');
      if (config.welcome.dm && kb.welcome.dm && (await act('welcome dm', () => actions.dm?.(member.id, fill(kb.welcome.dm, vars)), errors))) done.push('welcome DM');
    }
    return { raid, accountAgeDays: ageDays, done, errors };
  }

  /**
   * A moderator pressed a button on a mod-log report.
   * action: dismiss (false positive: removes the strike) | resolve | delete | timeout | ban
   */
  async function review(caseId, action, moderator = {}) {
    const c = store.getCase(caseId);
    if (!c) return { ok: false, error: `case #${caseId} not found` };
    const errors = [];
    const by = moderator.username || moderator.id || 'moderator';
    let note = '';
    if (action === 'dismiss') {
      store.removeStrike(c.guildId, c.userId, c.id);
      store.count('false_positive');
      note = 'marked as false positive (strike removed)';
    } else if (action === 'delete') {
      await act('delete', () => actions.deleteMessage?.(c.channelId, c.messageId, `case #${c.id} by ${by}`), errors);
      note = 'message deleted';
    } else if (action === 'timeout') {
      await act('timeout', () => actions.timeout?.(c.guildId, c.userId, config.thresholds.timeoutMinutes, `case #${c.id} by ${by}`), errors);
      note = `timed out ${formatMinutes(config.thresholds.timeoutMinutes)}`;
    } else if (action === 'ban') {
      await act('ban', () => actions.ban?.(c.guildId, c.userId, `case #${c.id} by ${by}: ${c.reasons?.[0] || ''}`), errors);
      note = 'banned';
    } else if (action === 'resolve') {
      note = 'resolved';
    } else return { ok: false, error: `unknown action ${action}` };
    const status = action === 'dismiss' ? 'false_positive' : 'resolved';
    const updated = store.updateCase(c.id, { status, reviewedBy: by, review: note, reviewErrors: errors });
    return { ok: errors.length === 0, case: updated, note, errors };
  }

  return {
    handleMessage,
    handleJoin,
    ask,
    review,
    checkOnly: async (msg) => {
      // dry analysis for /check and the CLI: nothing is deleted, logged or counted as a strike
      const member = memberInfo(msg);
      const s = spam.check(msg, msg.createdAt || now());
      const tox = await toxicity.classify(msg, { context: msg.context || [], spamScore: s.score, isNewMember: member.isNewMember });
      return { spam: s, tox, member, decision: decide({ spam: s, tox, member, thresholds: config.thresholds, mode: config.mode }) };
    },
    stats: () => ({ toxicity: { ...toxicity.stats } }),
    qa,
    spam,
  };
}

export function formatMinutes(m) {
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440}d`;
  if (m >= 60 && m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}
