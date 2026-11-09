import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/policy.js';
import { loadConfig } from '../src/config.js';
import { loadKnowledge, matchFaq, createQA, parseAnswer, fill } from '../src/knowledge.js';
import { createLLMRouter } from '../src/ai/index.js';
import { fakeProvider } from './helpers.js';

const th = loadConfig({}).thresholds;
const kb = loadKnowledge(loadConfig({}).qa.knowledgeFile);
const qaCfg = loadConfig({}).qa;
const none = { score: 0, signals: [], details: [], category: null, related: [] };
const run = (o) => decide({ spam: none, tox: { toxicity: 0, categories: [] }, member: {}, thresholds: th, ...o });

test('clean message -> nothing', () => {
  assert.equal(run({}).action, 'none');
});

test('toxicity ladder: flag -> delete -> timeout', () => {
  assert.equal(run({ tox: { toxicity: 50, categories: ['harassment'] } }).action, 'flag');
  const del = run({ tox: { toxicity: 75, categories: ['harassment'] } });
  assert.equal(del.action, 'delete');
  assert.ok(del.warn && del.strike);
  const to = run({ tox: { toxicity: 95, categories: ['threat'] } });
  assert.equal(to.action, 'timeout');
  assert.equal(to.timeoutMinutes, th.timeoutMinutes);
  assert.equal(to.priority, 'urgent');
});

test('banter is not punished unless the AI wants a human', () => {
  assert.equal(run({ tox: { toxicity: 75, categories: ['harassment'], is_banter: true } }).action, 'none');
  assert.equal(run({ tox: { toxicity: 75, categories: ['threat'], is_banter: true, needs_human: true } }).action, 'delete');
});

test('self-harm -> urgent flag + support DM, no punishment', () => {
  const d = run({ tox: { toxicity: 0, categories: ['self_harm'], needs_human: true } });
  assert.equal(d.action, 'flag');
  assert.equal(d.priority, 'urgent');
  assert.ok(d.supportDm);
  assert.ok(!d.strike && !d.deleteMessage);
});

test('scam -> delete everything, long timeout, suggest ban for new accounts', () => {
  const d = run({ spam: { score: 90, signals: ['scam_link'], details: ['x'], category: 'scam', related: [] }, member: { isNewAccount: true } });
  assert.equal(d.action, 'timeout');
  assert.equal(d.timeoutMinutes, th.scamTimeoutMinutes);
  assert.ok(d.deleteRelated && d.suggestBan);
});

test('spam flood -> delete + short timeout; light spam -> flag only', () => {
  const d = run({ spam: { score: 80, signals: ['flood', 'duplicate'], details: [], category: 'spam', related: [] } });
  assert.equal(d.timeoutMinutes, th.floodTimeoutMinutes);
  assert.ok(d.deleteRelated);
  assert.equal(run({ spam: { score: 40, signals: ['invite_link'], details: [], category: 'spam' } }).action, 'flag');
});

test('strikes escalate repeat offenders', () => {
  const third = run({ tox: { toxicity: 75, categories: ['harassment'] }, member: { strikes: 2 } });
  assert.equal(third.action, 'timeout');
  assert.equal(third.strikesAfter, 3);
  const fifth = run({ tox: { toxicity: 75, categories: ['harassment'] }, member: { strikes: 4 } });
  assert.equal(fifth.timeoutMinutes, th.longTimeoutMinutes);
  assert.ok(fifth.suggestBan);
});

test('staff are never auto-punished', () => {
  const d = run({ tox: { toxicity: 95, categories: ['harassment'] }, member: { exempt: true } });
  assert.ok(!d.deleteMessage && !d.timeoutMinutes && !d.strike);
  assert.equal(d.action, 'flag');
  assert.equal(run({ tox: { toxicity: 50, categories: ['harassment'] }, member: { exempt: true } }).action, 'none');
});

test('observe mode reports what it would have done', () => {
  const d = run({ tox: { toxicity: 95, categories: ['harassment'] }, mode: 'observe' });
  assert.equal(d.action, 'flag');
  assert.deepEqual(d.wouldHave, { deleteMessage: true, timeoutMinutes: th.timeoutMinutes, warn: true });
  assert.ok(!d.strike);
});

test('FAQ matching: clear questions match, unrelated ones do not', () => {
  assert.equal(matchFaq(kb, 'how do I get roles?').faq.id, 'get-roles');
  assert.ok(matchFaq(kb, 'how do I get roles?').score >= 0.6);
  assert.equal(matchFaq(kb, 'what time does the build contest start this month?').faq.id, 'events');
  assert.ok(matchFaq(kb, 'is there a mobile version').score < 0.35);
});

const qaRouter = (fn) => {
  const p = fakeProvider(fn);
  return { p, r: createLLMRouter({ chain: [{ provider: 'fake', model: 'a' }], providers: { fake: p } }) };
};

test('Q&A: instant FAQ answer without AI call', async () => {
  const { p, r } = qaRouter(() => ({ answerable: true, answer: 'x', confidence: 1 }));
  const out = await createQA({ kb, router: r, cfg: qaCfg }).answer('how do I report a bug?');
  assert.equal(out.source, 'faq');
  assert.equal(out.faqId, 'report-bug');
  assert.equal(p.calls.length, 0);
});

test('Q&A: AI answers from the knowledge, gaps are reported, no answer is invented', async () => {
  const { p, r } = qaRouter((prompt) =>
    /mobile/.test(prompt) ? { answerable: false, answer: '', confidence: 0.1 } : { answerable: true, answer: 'Build Night is Friday 19:00 UTC in #announcements.', sources: ['events'], confidence: 0.9 }
  );
  const qa = createQA({ kb, router: r, cfg: qaCfg });
  const a = await qa.answer('yo when do the weekly hangouts happen');
  assert.equal(a.source, 'ai');
  assert.ok(a.answered);
  assert.match(p.calls[0].system, /Answer ONLY from the KNOWLEDGE/);
  assert.match(p.calls[0].system, /\[events\]/);
  const silent = await qa.answer('is there a mobile version');
  assert.ok(!silent.answered && silent.gap && silent.text === '');
  const explicit = await qa.answer('is there a mobile version for tablets', { explicit: true });
  assert.match(explicit.text, /passed your question to the moderators/);
});

test('Q&A: AI down -> close FAQ match still answers', async () => {
  const { r } = qaRouter(() => new Error('down'));
  const out = await createQA({ kb, router: r, cfg: qaCfg }).answer('crossplay with xbox?');
  assert.ok(out.answered);
  assert.equal(out.faqId, 'crossplay');
});

test('parseAnswer and fill', () => {
  assert.throws(() => parseAnswer('{"answer":"x"}'));
  assert.throws(() => parseAnswer('{"answerable":true,"answer":""}'));
  assert.equal(parseAnswer('```json\n{"answerable":true,"answer":"hi","confidence":3}\n```').confidence, 1);
  assert.equal(fill('Hi {name} in {server} {x}', { name: 'Sam', server: 'PF' }), 'Hi Sam in PF {x}');
});
