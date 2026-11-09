import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/config.js';
import { normalizeMessage, caseEmbed, caseButtons } from '../src/discord/bot.js';
import { commandDefinitions, inviteUrl } from '../src/discord/commands.js';
import { runDemo } from '../src/demo.js';
import { createStore } from '../src/store.js';
import { createNotifier } from '../src/notify.js';
import { baseEnv, fakeProvider } from './helpers.js';
import { silentLogger } from '../src/logger.js';
import fs from 'node:fs';
import os from 'node:os';

const BIN = path.join(PROJECT_ROOT, 'bin', 'discord-mod.js');
const cli = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NO_COLOR: '1', DISCORD_MOD_SKIP_DOTENV: '1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'dmod-')) },
  });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('CLI check, ask, demo and start without a token', () => {
  const chk = cli('--no-ai', 'check', 'shut up you worthless idiot');
  assert.equal(chk.code, 0);
  assert.match(chk.out, /\[DELETE\] toxicity/);
  const js = JSON.parse(cli('--no-ai', 'check', '--json', '--new-member', 'free nitro https://dlscord-gift.com').out);
  assert.equal(js.decision.kind, 'scam');
  assert.match(cli('--no-ai', 'ask', 'how do I report a bug').out, /\[ANSWERED\][\s\S]*#bug-reports/);
  const demo = cli('--no-ai', 'demo');
  assert.equal(demo.code, 0);
  assert.match(demo.out, /Summary/);
  assert.match(demo.out, /scam case/);
  const start = cli('start');
  assert.equal(start.code, 2);
  assert.match(start.out, /DISCORD_TOKEN is missing/);
});

test('demo with AI + simulated Gemini outage falls back to the next provider', async () => {
  const gem = fakeProvider(() => ({ toxicity: 1 }));
  const backup = fakeProvider((p, req) => (/helper bot/.test(req.system) ? { answerable: false, answer: '', confidence: 0 } : { toxicity: 3, categories: [], is_banter: true }));
  const lines = [];
  const { results } = await runDemo({
    print: (l) => lines.push(l),
    appOptions: {
      env: baseEnv({ AI_CHAIN: 'gemini:x,groq:y' }),
      aiProviders: { gemini: gem, groq: backup },
      simulate: ['gemini'],
      logger: silentLogger,
    },
  });
  assert.equal(gem.calls.length, 0);
  assert.ok(backup.calls.length > 5);
  const kys = results.find((r) => r.event.content?.includes('k y s'));
  assert.equal(kys.result.decision.action, 'timeout'); // rules floor still applies when the AI says "fine"
  assert.ok(lines.some((l) => /groq:y/.test(l) || /by AI/.test(l)));
});

test('normalizeMessage maps a discord.js message', () => {
  const coll = (arr) => {
    const m = new Map(arr.map((x) => [x.id, x]));
    m.filter = (f) => coll(arr.filter(f));
    return m;
  };
  const fake = {
    id: 'm1',
    guildId: 'g',
    channelId: 'c',
    channel: { name: 'general', messages: { cache: new Map([['r1', { author: { id: 'BOT' }, content: 'earlier answer' }]]) } },
    content: 'hey <@BOT> @everyone',
    createdTimestamp: 5,
    reference: { messageId: 'r1' },
    mentions: { users: coll([{ id: 'BOT' }, { id: 'x' }]), roles: new Map(), everyone: false },
    author: { id: 'u', username: 'sam', bot: false, createdTimestamp: 1 },
    member: { displayName: 'Sam', joinedTimestamp: 2, roles: { cache: new Map([['r', {}]]) }, permissions: { has: () => false } },
  };
  const m = normalizeMessage(fake, 'BOT');
  assert.equal(m.mentionsBot, true);
  assert.equal(m.mentions.users, 1);
  assert.equal(m.mentions.everyone, true);
  assert.equal(m.replyToContent, 'earlier answer');
  assert.deepEqual(m.author.roleIds, ['r']);
  assert.equal(m.raw, fake);
  assert.ok(!Object.keys(m).includes('raw'));
});

test('mod-log embed, buttons, slash commands and invite link build', () => {
  const c = { id: 7, kind: 'scam', priority: 'high', userId: 'u', username: 'x', channelId: 'c', messageId: 'm', guildId: 'g', content: 'free nitro', reasons: ['scam'], toxicity: 0, spamScore: 90, source: 'rules', action: 'timeout', timeoutMinutes: 1440, suggestBan: true };
  const e = caseEmbed(c).toJSON();
  assert.match(e.title, /case #7/);
  assert.ok(e.fields.some((f) => /1d/.test(f.value)));
  const ids = caseButtons(c)[0].toJSON().components.map((b) => b.custom_id);
  assert.deepEqual(ids, ['mod:ban:7', 'mod:dismiss:7', 'mod:resolve:7']);
  assert.deepEqual(caseButtons({ kind: 'question' }), []);
  assert.deepEqual(commandDefinitions().map((x) => x.name), ['ask', 'check', 'warnings', 'clearstrikes', 'modstats']);
  assert.match(inviteUrl('123'), /client_id=123&permissions=\d+&scope=bot%20applications.commands/);
});

test('store persists to disk and survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dmod-')), 'db.json');
  const s = createStore(file);
  const c = s.addCase({ userId: 'u', flag: true });
  s.addStrike('g', 'u', c.id);
  s.addGap({ question: 'Mobile?' });
  s.addGap({ question: 'mobile?' });
  s.count('messages', 3);
  s.flush();
  const s2 = createStore(file);
  assert.equal(s2.getCase(c.id).status, 'open');
  assert.equal(s2.strikes('g', 'u', 1e9), 1);
  assert.equal(s2.gaps()[0].count, 2);
  assert.equal(s2.statsFor(1).messages, 3);
});

test('alert webhook posts Slack/Discord compatible JSON', async () => {
  const sent = [];
  const alert = createNotifier({ webhookUrl: 'https://hooks.example/x', fetchImpl: async (url, opts) => (sent.push(JSON.parse(opts.body)), { ok: true }) });
  await alert({ id: 3, kind: 'raid', priority: 'urgent', reasons: ['10 joins in 60s'] });
  assert.match(sent[0].text, /URGENT.*raid #3/);
  assert.equal(sent[0].text, sent[0].content);
  assert.equal(createNotifier({}), null);
});
