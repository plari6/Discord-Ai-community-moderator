import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, makeMsg, tox, T0 } from './helpers.js';

const aiBy = (map) => (prompt, req) => {
  if (/helper bot/.test(req.system)) return map.qa ? map.qa(prompt) : { answerable: false, answer: '', confidence: 0 };
  const m = prompt.match(/<message>\n([\s\S]*?)\n<\/message>/)?.[1] || '';
  return map.tox ? map.tox(m) : tox();
};

test('harassment: deleted, warned by DM, strike, mod-log case', async () => {
  const { app, did } = testApp({ ai: aiBy({ tox: (m) => (/worthless/.test(m) ? tox({ toxicity: 78, categories: ['harassment'], reason: 'insults a member' }) : tox()) }) });
  const r = await app.moderator.handleMessage(makeMsg('you are worthless, leave'));
  assert.equal(r.decision.action, 'delete');
  assert.equal(did('delete').length, 1);
  assert.equal(did('dm').length, 1);
  assert.equal(did('modLog')[0][1].kind, 'toxicity');
  assert.equal(app.store.strikes('g1', 'u1', 86_400_000), 1);
  assert.deepEqual(r.case && app.store.getCase(r.case.id).done, ['deleted message', 'strike 1', 'warned by DM', 'reported to mod-log']);
});

test('third strike in 24h -> timeout; moderator "false positive" removes the strike', async () => {
  const clock = { t: T0 };
  const { app, did } = testApp({ clock, ai: () => tox({ toxicity: 75, categories: ['harassment'] }) });
  let r;
  for (let i = 0; i < 3; i++) {
    clock.t = T0 + i * 60_000;
    r = await app.moderator.handleMessage(makeMsg(`you are an idiot number ${i}`, { createdAt: clock.t }));
  }
  assert.equal(r.decision.action, 'timeout');
  assert.equal(did('timeout')[0][3], 60);
  const rev = await app.moderator.review(r.case.id, 'dismiss', { username: 'mod' });
  assert.equal(rev.case.status, 'false_positive');
  assert.equal(app.store.strikes('g1', 'u1', 86_400_000), 2);
});

test('scam from a fresh account: deleted, 24h timeout, ban suggested; ban button works', async () => {
  const { app, did } = testApp();
  const r = await app.moderator.handleMessage(
    makeMsg('free nitro here https://dlscord-gift.com/x', { author: { id: 'bad', accountCreatedAt: T0 - 3600_000, joinedAt: T0 - 60_000 } })
  );
  assert.equal(r.decision.kind, 'scam');
  assert.equal(did('timeout')[0][3], 1440);
  assert.ok(r.case.suggestBan);
  await app.moderator.review(r.case.id, 'ban', { username: 'mod' });
  assert.equal(did('ban')[0][2], 'bad');
});

test('self-harm: support DM + urgent alert, message stays', async () => {
  const { app, did } = testApp({ ai: () => tox({ toxicity: 5, categories: ['self_harm'], needs_human: true, directed_at: 'self' }) });
  const r = await app.moderator.handleMessage(makeMsg('i feel like i want to end my life'));
  assert.equal(did('delete').length, 0);
  assert.match(did('dm')[0][2], /findahelpline/);
  assert.equal(did('alert').length, 1);
  assert.equal(r.case.priority, 'urgent');
});

test('AI outage: rules still catch the abuse', async () => {
  const { app, did } = testApp({ ai: () => new Error('503') });
  const r = await app.moderator.handleMessage(makeMsg('shut up you stupid idiot'));
  assert.equal(r.tox.source, 'rules');
  assert.equal(did('delete').length, 1);
});

test('new member question gets an instant FAQ answer; regulars outside #help are left alone', async () => {
  const { app, did, provider } = testApp();
  const r = await app.moderator.handleMessage(makeMsg('how do I get roles?', { author: { id: 'new', joinedAt: T0 - 120_000 } }));
  assert.equal(r.qa.trigger, 'new-member');
  assert.equal(r.qa.source, 'faq');
  assert.match(did('reply')[0][2], /#roles/);
  assert.ok(provider.calls.every((c) => !/helper bot/.test(c.system)));
  const r2 = await app.moderator.handleMessage(makeMsg('how do I get roles?'));
  assert.equal(r2.qa, null);
});

test('help channel + mention trigger answers; unanswerable mention goes to the mod-log as a gap', async () => {
  const { app, did } = testApp({ env: { HELP_CHANNEL_IDS: '111111' } });
  const r = await app.moderator.handleMessage(makeMsg('where do I report a crash?', { channelId: '111111' }));
  assert.equal(r.qa.trigger, 'help-channel');
  const m = await app.moderator.handleMessage(makeMsg('<@999> when is the next patch?', { mentionsBot: true }));
  assert.equal(m.qa.trigger, 'mention');
  assert.match(did('reply').at(-1)[2], /moderators/);
  assert.equal(did('modLog').at(-1)[1].kind, 'question');
  assert.equal(app.store.gaps()[0].question, 'when is the next patch?');
});

test('Q&A cooldown per user for auto answers', async () => {
  const { app } = testApp();
  const a = { id: 'new2', joinedAt: T0 - 60_000 };
  await app.moderator.handleMessage(makeMsg('how do I get roles?', { author: a }));
  const r = await app.moderator.handleMessage(makeMsg('how do I report a bug?', { author: a }));
  assert.equal(r.qa.skipped, 'cooldown');
});

test('observe mode never deletes', async () => {
  const { app, did } = testApp({ mode: 'observe', ai: () => tox({ toxicity: 95, categories: ['threat'] }) });
  const r = await app.moderator.handleMessage(makeMsg('something nasty'));
  assert.equal(did('delete').length + did('timeout').length + did('dm').length, 0);
  assert.equal(did('modLog').length, 1);
  assert.ok(r.case.wouldHave.deleteMessage);
});

test('bots, empty messages, ignored channels and staff', async () => {
  const { app, did } = testApp({ env: { IGNORED_CHANNEL_IDS: '222222' }, ai: () => tox({ toxicity: 80, categories: ['harassment'] }) });
  assert.ok((await app.moderator.handleMessage(makeMsg('you idiot', { author: { bot: true } }))).skipped);
  assert.ok((await app.moderator.handleMessage(makeMsg('   '))).skipped);
  assert.ok((await app.moderator.handleMessage(makeMsg('you idiot', { channelId: '222222' }))).skipped);
  await app.moderator.handleMessage(makeMsg('you idiot', { author: { isMod: true } }));
  assert.equal(did('delete').length, 0);
});

test('a failing Discord action never breaks the pipeline (DM closed -> channel warning)', async () => {
  const { app, did } = testApp({ ai: () => tox({ toxicity: 75, categories: ['harassment'] }) });
  app.attachActions({
    dm: async () => {
      throw new Error('Cannot send messages to this user');
    },
  });
  const r = await app.moderator.handleMessage(makeMsg('you are trash'));
  assert.ok(r.errors[0].startsWith('warn dm'));
  assert.equal(did('send').length, 1);
  assert.ok(r.done.includes('warned in channel'));
});

test('joins: welcome, young-account flag and raid alert', async () => {
  const clock = { t: T0 };
  const { app, did } = testApp({ clock, env: { WELCOME_CHANNEL_ID: '333333', RAID_JOIN_COUNT: '4' } });
  const j = await app.moderator.handleJoin({ id: 'n1', username: 'newbie', guildId: 'g1', accountCreatedAt: T0 - 3600_000, joinedAt: T0 });
  assert.ok(j.done.includes('welcome message') && j.done.includes('flagged young account'));
  assert.match(did('send')[0][2], /Welcome to/);
  let r;
  for (let i = 2; i <= 4; i++) r = await app.moderator.handleJoin({ id: `n${i}`, username: `u${i}`, guildId: 'g1', accountCreatedAt: T0 - 400 * 86_400_000, joinedAt: T0 + i * 1000 });
  assert.ok(r.raid);
  assert.equal(did('alert').at(-1)[1].kind, 'raid');
});

test('the flood case deletes the earlier messages too', async () => {
  const { app, did } = testApp({ noAi: true });
  for (let i = 0; i < 5; i++) await app.moderator.handleMessage(makeMsg(`spam ${i} buy now`, { createdAt: T0 + i * 500, author: { id: 'fl' } }));
  assert.ok(did('delete').length >= 5);
  assert.equal(did('timeout')[0][3], 10);
});
