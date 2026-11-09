import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deobfuscate, looksLikeQuestion, extractUrls, hostOf, fingerprint } from '../src/text.js';
import { createSpamDetector, lookalikeOf } from '../src/spam.js';
import { loadConfig } from '../src/config.js';
import { makeMsg, T0 } from './helpers.js';

const cfg = () => loadConfig({}).spam;

test('deobfuscate undoes common filter evasion', () => {
  assert.match(deobfuscate('k y s'), /\bkys\b/);
  assert.match(deobfuscate('you 1d10t'), /idiot/);
  assert.match(deobfuscate('f.u.c.k you'), /fuck you/);
  assert.match(deobfuscate('stuuuuupid'), /stuupid/);
  assert.match(deobfuscate('h​ello'), /hello/);
});

test('looksLikeQuestion', () => {
  assert.ok(looksLikeQuestion('how do I get roles'));
  assert.ok(looksLikeQuestion('anyone know the event time?'));
  assert.ok(!looksLikeQuestion('gg everyone'));
  assert.ok(!looksLikeQuestion('ok?'));
});

test('urls, hosts and fingerprints', () => {
  assert.deepEqual(extractUrls('see https://www.example.com/x?y=1 and discord.gg/abc'), ['https://www.example.com/x?y=1', 'discord.gg/abc']);
  assert.equal(hostOf('https://www.Example.com/a'), 'example.com');
  assert.equal(fingerprint('Hello   WORLD!!'), fingerprint('hello world'));
});

test('lookalike domains are caught, real ones are not', () => {
  for (const bad of ['dlscord-gift.com', 'discord-nitro.gift', 'steamcommunlty.com', 'discord.nitro-free.xyz', 'free-discord.ru', 'discorcl.com'])
    assert.ok(lookalikeOf(bad), bad);
  for (const ok of ['discord.com', 'cdn.discordapp.com', 'youtube.com', 'finance.yahoo.com', 'stream.example.com', 'github.com', 'example.org'])
    assert.equal(lookalikeOf(ok), null, ok);
});

test('normal message scores 0', () => {
  const s = createSpamDetector(cfg());
  const r = s.check(makeMsg('gg everyone, great match https://youtube.com/watch?v=1'));
  assert.equal(r.score, 0);
  assert.equal(r.category, null);
});

test('phishing link from a new account is a scam', () => {
  const s = createSpamDetector(cfg());
  const r = s.check(makeMsg('Free Discord Nitro! claim: https://dlscord-gift.com/claim', { author: { accountCreatedAt: T0 - 3600_000 } }));
  assert.equal(r.category, 'scam');
  assert.ok(r.score >= 90);
  assert.ok(r.signals.includes('scam_link') && r.signals.includes('new_account_link'));
});

test('scam wording without a link is suspicious but not "scam"', () => {
  const s = createSpamDetector(cfg());
  const r = s.check(makeMsg('dm me to claim your free nitro'));
  assert.ok(r.signals.includes('scam_phrase'));
  assert.equal(r.category, 'spam');
});

test('flood: 5 messages in 7 seconds', () => {
  const s = createSpamDetector(cfg());
  let r;
  for (let i = 0; i < 5; i++) r = s.check(makeMsg(`msg number ${i}`, { createdAt: T0 + i * 1000 }));
  assert.ok(r.signals.includes('flood'));
  assert.equal(r.related.length, 4);
});

test('same message in several channels = cross-channel duplicate', () => {
  const s = createSpamDetector(cfg());
  let r;
  ['a', 'b', 'c'].forEach((ch, i) => (r = s.check(makeMsg('buy cheap followers now', { channelId: ch, createdAt: T0 + i * 10_000 }))));
  assert.ok(r.signals.includes('cross_channel_duplicate'));
  assert.deepEqual(r.related.map((x) => x.channelId).sort(), ['a', 'b']);
});

test('mass mentions, @everyone attempts, caps, invites', () => {
  const s = createSpamDetector(cfg());
  assert.ok(s.check(makeMsg('hi', { mentions: { users: 6, roles: 0, everyone: false } })).signals.includes('mass_mention'));
  assert.ok(s.check(makeMsg('@everyone look', { mentions: { users: 0, roles: 0, everyone: true } })).signals.includes('everyone_ping'));
  assert.ok(s.check(makeMsg('WHY IS NOBODY ANSWERING MY QUESTION')).signals.includes('caps'));
  assert.ok(s.check(makeMsg('join discord.gg/abc')).signals.includes('invite_link'));
  const allow = createSpamDetector({ ...cfg(), allowInvites: true });
  assert.ok(!allow.check(makeMsg('join discord.gg/abc')).signals.includes('invite_link'));
});

test('allowed and blocked domains from config', () => {
  const s = createSpamDetector({ ...cfg(), blockedDomains: ['badsite.net'], allowedDomains: ['discord-tools.com'] });
  assert.ok(s.check(makeMsg('https://x.badsite.net/a')).signals.includes('blocked_domain'));
  assert.ok(!s.check(makeMsg('https://discord-tools.com/a')).signals.includes('scam_link'));
});
