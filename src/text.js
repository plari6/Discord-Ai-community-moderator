/** Text helpers shared by the spam, toxicity and Q&A modules. */

const ZERO_WIDTH = /[​-‏⁠-⁤﻿­]/g;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l' };

/** Discord markup -> plain words: mentions, custom emoji, spoilers, code ticks. */
export function stripDiscordMarkup(text) {
  return String(text || '')
    .replace(/<a?:(\w+):\d+>/g, ' :$1: ')
    .replace(/<@[!&]?\d+>/g, ' @user ')
    .replace(/<#\d+>/g, ' #channel ')
    .replace(/\|\|/g, ' ')
    .replace(/[`*_~>]/g, ' ');
}

/** Lowercase, remove accents and zero-width tricks. */
export function basicNormalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(ZERO_WIDTH, '')
    .toLowerCase();
}

/**
 * Undo common filter-evasion tricks so keyword rules still match:
 * "f.u.c.k" / "f u c k" -> "fuck", "1d10t" -> "idiot", "stuuupid" -> "stupid", "k y s" -> "kys".
 */
export function deobfuscate(text) {
  let t = basicNormalize(stripDiscordMarkup(text));
  // join single characters separated by dots, dashes, underscores or spaces (3+ in a row)
  t = t.replace(/\b(?:[a-z0-9@$!][\s.\-_*]){2,}[a-z0-9@$!]\b/g, (m) => m.replace(/[\s.\-_*]/g, ''));
  t = t.replace(/[0134578@$!|]/g, (ch, i, s) => {
    // only translate digits/symbols that sit inside a word
    const prev = s[i - 1] || ' ';
    const next = s[i + 1] || ' ';
    return /[a-z]/.test(prev) || /[a-z]/.test(next) ? LEET[ch] || ch : ch;
  });
  t = t.replace(/([a-z])\1{2,}/g, '$1$1'); // stuuupid -> stuupid
  return t.replace(/\s+/g, ' ').trim();
}

/** Same as deobfuscate but collapses doubled letters too ("stuupid" -> "stupid"). */
export function squash(text) {
  return deobfuscate(text).replace(/([a-z])\1+/g, '$1');
}

export const URL_RE = /\bhttps?:\/\/[^\s<>()]+|\b(?:discord(?:app)?\.(?:gg|com\/invite)|dsc\.gg)\/[\w-]+/gi;

export function extractUrls(text) {
  return String(text || '').match(URL_RE) || [];
}

export function hostOf(url) {
  try {
    const u = new URL(/^https?:/i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Fingerprint for duplicate detection: words only, no case, no links' query strings. */
export function fingerprint(text) {
  return basicNormalize(stripDiscordMarkup(text))
    .replace(/https?:\/\/([^\s/?#]+)[^\s]*/g, 'link:$1')
    .replace(/[^\p{L}\p{N}:]+/gu, ' ')
    .trim();
}

const STOP = new Set(
  'a an the and or but if of to in on at by for with from is are was were be been am do does did can could should would will i me my we our you your it its this that these those there here what how where when why who which whom please hi hello hey thanks thank any some just get got im i\'m ok'.split(
    ' '
  )
);

/** Tokens for FAQ matching (light stemming). */
export function tokens(text) {
  return basicNormalize(stripDiscordMarkup(text))
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/u, (m) => (w.length - m.length >= 3 ? '' : m)));
}

export function looksLikeQuestion(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t.length < 6) return false;
  if (/\?\s*$/.test(t)) return true;
  return /^(how|what|where|when|why|who|which|can|could|is|are|do|does|did|should|will|anyone know|any idea|help|is there|where's|how's|what's)\b/.test(t);
}

export function truncate(text, n = 300) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function capsRatio(text) {
  const letters = String(text || '').replace(/[^a-zA-Z]/g, '');
  if (letters.length < 12) return 0;
  return letters.replace(/[^A-Z]/g, '').length / letters.length;
}

export function emojiCount(text) {
  const s = String(text || '');
  return (s.match(/\p{Extended_Pictographic}/gu) || []).length + (s.match(/<a?:\w+:\d+>/g) || []).length;
}

export function zalgoRatio(text) {
  const s = String(text || '').normalize('NFD');
  if (!s.length) return 0;
  return (s.match(/[̀-ͯ҉]/g) || []).length / s.length;
}
