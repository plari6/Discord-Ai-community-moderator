import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { createApp } from './index.js';
import { formatMinutes } from './moderator.js';
import { actionBadge, c } from './format.js';
import { truncate } from './text.js';

export const DEMO_SCENARIO = path.join(PROJECT_ROOT, 'examples', 'demo-scenario.json');

/**
 * Run a scripted day on a fake server through the real engine (spam rules, AI toxicity, policy,
 * Q&A). Discord calls are printed instead of sent. Returns the results for tests.
 */
export async function runDemo({ file = DEMO_SCENARIO, appOptions = {}, print = console.log, mode } = {}) {
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  const start = Date.UTC(2026, 10, 9, 18, 0, 0);
  let clock = start;
  const channelIds = {};
  const chId = (name) => (channelIds[name] ||= String(100000 + Object.keys(channelIds).length + 1));
  const chName = (id) => Object.entries(channelIds).find(([, v]) => v === id)?.[0];
  const help = chId('help');
  chId('general');
  const modLog = chId('mod-log');
  const welcome = chId('welcome');

  const app = createApp({ memory: true, now: () => clock, mode, ...appOptions });
  Object.assign(app.config.discord, { helpChannelIds: [help], modLogChannelId: modLog, welcomeChannelId: welcome });
  app.config.welcome.dm = true;

  const out = [];
  const say = (s) => out.push(s);
  app.attachActions({
    deleteMessage: async (ch, id) => say(c.magenta(`   🗑  deleted message ${id} in #${chName(ch) || ch}`)),
    timeout: async (_g, user, min) => say(c.red(`   ⏳ timed out ${userName(user)} for ${formatMinutes(min)}`)),
    ban: async (_g, user) => say(c.red(`   🔨 banned ${userName(user)}`)),
    reply: async (_m, text) => say(c.cyan(`   🤖 bot replies: ${truncate(text.replace(/\n/g, ' '), 220)}`)),
    dm: async (user, text) => say(c.blue(`   ✉  DM to ${userName(user)}: ${truncate(text.replace(/\n/g, ' '), 160)}`)),
    send: async (ch, text) => say(c.cyan(`   💬 #${chName(ch) || ch}: ${truncate(text.replace(/<@(\d+)>/g, (_, id) => `@${userName(id)}`), 200)}`)),
    modLog: async (k) =>
      say(c.yellow(`   🛡  mod-log [${k.priority}] ${k.kind}${k.id ? ` case #${k.id}` : ''}: ${truncate((k.reasons || []).join('; '), 200)}${k.suggestBan ? ' · suggest ban' : ''}`)),
    alert: async (k) => say(c.red(`   🚨 urgent alert sent to staff (case #${k.id})`)),
  });

  const userIds = {};
  const uid = (name) => (userIds[name] ||= String(900000 + Object.keys(userIds).length + 1));
  const userName = (id) => Object.entries(userIds).find(([, v]) => v === id)?.[0] || id;

  const author = (name) => {
    const u = scenario.users[name] || {};
    return {
      id: uid(name),
      username: name,
      bot: false,
      accountCreatedAt: start - (u.accountDays ?? 365) * 86_400_000,
      joinedAt: start - (u.memberDays !== undefined ? u.memberDays * 86_400_000 : (u.memberMinutes ?? 60 * 24 * 30) * 60_000),
      roleIds: [],
      isMod: Boolean(u.isMod),
      canMentionEveryone: Boolean(u.isMod),
    };
  };

  print(c.bold(`\nDemo server "${app.kb.server.name}" · mode: ${app.config.mode} · AI: ${app.router ? `${app.router.enabledCount} model(s) configured` : 'off (keyword rules only)'}\n`));
  const results = [];
  let n = 0;
  for (const ev of scenario.events) {
    clock = start + ev.t * 1000;
    out.length = 0;
    if (ev.join) {
      const a = author(ev.join);
      const r = await app.moderator.handleJoin({ id: a.id, username: ev.join, guildId: '1', guildName: app.kb.server.name, accountCreatedAt: a.accountCreatedAt, joinedAt: clock });
      print(`${c.gray(`+${ev.t}s`)} ${c.green('[JOIN]')} ${c.bold(ev.join)} ${c.gray(`- ${ev.note || ''}`)}`);
      out.forEach((l) => print(l));
      results.push({ event: ev, join: r });
      continue;
    }
    const msg = {
      id: String(500000 + ++n),
      guildId: '1',
      channelId: chId(ev.channel || 'general'),
      channelName: ev.channel || 'general',
      content: ev.content,
      createdAt: clock,
      mentionsBot: Boolean(ev.mention),
      mentions: { users: 0, roles: 0, everyone: /@(everyone|here)/.test(ev.content) },
      author: author(ev.user),
    };
    const r = await app.moderator.handleMessage(msg);
    const d = r.decision;
    const score = `tox ${String(r.tox.toxicity).padStart(3)} · spam ${String(r.spam.score).padStart(3)} · ${r.tox.source}${r.tox.is_banter ? ' (banter)' : ''}`;
    print(`${c.gray(`+${ev.t}s`)} ${actionBadge(d.action)} ${c.bold(ev.user)} in #${msg.channelName}: "${truncate(ev.content, 90)}"`);
    print(c.gray(`   ${ev.note ? `${ev.note} · ` : ''}${score}${r.qa?.trigger ? ` · question (${r.qa.trigger}${r.qa.source ? `, ${r.qa.source}` : ''}${r.qa.skipped ? `, ${r.qa.skipped}` : ''})` : ''}`));
    out.forEach((l) => print(l));
    results.push({ event: ev, result: r });
  }

  const stats = app.store.statsFor(1);
  print(c.bold('\nSummary'));
  print(
    `  messages scanned: ${stats.messages || 0} · flagged: ${stats.action_flag || 0} · deleted: ${stats.action_delete || 0} · timeouts: ${stats.action_timeout || 0}` +
      ` · questions answered: ${(stats.qa_faq || 0) + (stats.qa_ai || 0) + (stats.qa_fallback || 0)} (${stats.qa_faq || 0} instant FAQ, ${stats.qa_ai || 0} AI)`
  );
  const gaps = app.store.gaps(5);
  if (gaps.length) print(`  knowledge gaps to add to the FAQ: ${gaps.map((g) => `"${truncate(g.question, 60)}"`).join(', ')}`);
  const t = app.moderator.stats().toxicity;
  print(`  toxicity checks: ${t.ai} by AI, ${t.rules} by rules, ${t.cached} cached${t.aiFailed ? `, ${t.aiFailed} AI failures (rules took over)` : ''}`);
  return { app, results, stats };
}
