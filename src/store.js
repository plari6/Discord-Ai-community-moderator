import fs from 'node:fs';
import path from 'node:path';

/**
 * Small JSON-file database: moderation cases, strikes, knowledge gaps and daily stats.
 * Writes are debounced and atomic (tmp file + rename). `file = null` keeps it in memory (demo, tests).
 */

const MAX_CASES = 5000;
const MAX_GAPS = 1000;
const empty = () => ({ nextCase: 1, cases: [], strikes: {}, gaps: [], stats: {} });

export function createStore(file, { now = () => Date.now() } = {}) {
  let db = empty();
  if (file && fs.existsSync(file)) {
    try {
      db = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    }
  }
  let timer = null;

  function flush() {
    if (!file) return;
    clearTimeout(timer);
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, file);
  }
  const save = () => {
    if (file && !timer) timer = setTimeout(flush, 500);
    timer?.unref?.();
  };
  const day = (t = now()) => new Date(t).toISOString().slice(0, 10);

  function count(key, n = 1) {
    const d = (db.stats[day()] ||= {});
    d[key] = (d[key] || 0) + n;
    save();
  }

  function addCase(c) {
    const rec = { id: db.nextCase++, at: now(), status: c.flag ? 'open' : 'closed', ...c };
    db.cases.push(rec);
    if (db.cases.length > MAX_CASES) db.cases.splice(0, db.cases.length - MAX_CASES);
    save();
    return rec;
  }

  function updateCase(id, patch) {
    const c = db.cases.find((x) => x.id === Number(id));
    if (c) Object.assign(c, patch, { updatedAt: now() });
    save();
    return c || null;
  }

  const sKey = (guildId, userId) => `${guildId || 'dm'}:${userId}`;

  function strikes(guildId, userId, windowMs) {
    const list = (db.strikes[sKey(guildId, userId)] || []).filter((s) => now() - s.at <= windowMs);
    return list.length;
  }
  function addStrike(guildId, userId, caseId) {
    (db.strikes[sKey(guildId, userId)] ||= []).push({ at: now(), caseId });
    db.strikes[sKey(guildId, userId)] = db.strikes[sKey(guildId, userId)].slice(-50);
    save();
  }
  function removeStrike(guildId, userId, caseId) {
    const k = sKey(guildId, userId);
    db.strikes[k] = (db.strikes[k] || []).filter((s) => s.caseId !== caseId);
    save();
  }
  function clearStrikes(guildId, userId) {
    delete db.strikes[sKey(guildId, userId)];
    save();
  }

  function addGap(g) {
    const q = String(g.question || '').trim().toLowerCase();
    const existing = db.gaps.find((x) => x.question.toLowerCase() === q);
    if (existing) {
      existing.count++;
      existing.lastAt = now();
    } else {
      db.gaps.push({ question: g.question, count: 1, firstAt: now(), lastAt: now(), channelId: g.channelId || null });
      if (db.gaps.length > MAX_GAPS) db.gaps.shift();
    }
    save();
  }

  function statsFor(days = 7) {
    const out = {};
    const cutoff = day(now() - (days - 1) * 86_400_000);
    for (const [d, v] of Object.entries(db.stats)) if (d >= cutoff) for (const [k, n] of Object.entries(v)) out[k] = (out[k] || 0) + n;
    return out;
  }

  return {
    addCase,
    updateCase,
    getCase: (id) => db.cases.find((x) => x.id === Number(id)) || null,
    cases: ({ limit = 20, status, userId } = {}) =>
      db.cases.filter((c) => (!status || c.status === status) && (!userId || c.userId === userId)).slice(-limit).reverse(),
    strikes,
    addStrike,
    removeStrike,
    clearStrikes,
    addGap,
    gaps: (limit = 50) => [...db.gaps].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, limit),
    count,
    statsFor,
    flush,
    get file() {
      return file;
    },
  };
}
