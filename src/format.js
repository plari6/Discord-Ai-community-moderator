const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { red: wrap(31), green: wrap(32), yellow: wrap(33), blue: wrap(34), magenta: wrap(35), cyan: wrap(36), gray: wrap(90), bold: wrap(1) };

const ACTION_COLOR = { none: c.green, flag: c.yellow, delete: c.magenta, timeout: c.red };

export function actionBadge(a) {
  return (ACTION_COLOR[a] || c.gray)(`[${String(a).toUpperCase()}]`);
}

export function formatCheck({ spam, tox, decision }) {
  const lines = [];
  lines.push(`${actionBadge(decision.action)} ${decision.kind ? c.bold(decision.kind) : 'clean'}${decision.priority ? ` · priority ${decision.priority}` : ''}`);
  lines.push(`  spam      ${bar(spam.score)} ${spam.score}/100 ${spam.signals.length ? c.gray(spam.signals.join(', ')) : ''}`);
  lines.push(`  toxicity  ${bar(tox.toxicity)} ${tox.toxicity}/100 ${tox.categories?.length ? c.gray(tox.categories.join(', ')) : ''}${tox.is_banter ? c.gray(' (banter)') : ''}`);
  lines.push(`  scored by ${tox.source}${tox.model ? ` (${tox.model})` : ''}${tox.aiError ? c.yellow(' - AI unavailable, rules used') : ''}`);
  if (tox.reason) lines.push(`  reason    ${tox.reason}`);
  if (decision.reasons.length) lines.push(`  decision  ${decision.reasons.join('; ')}`);
  const acts = [];
  if (decision.deleteMessage) acts.push('delete message');
  if (decision.timeoutMinutes) acts.push(`timeout ${decision.timeoutMinutes} min`);
  if (decision.warn) acts.push('warn user');
  if (decision.supportDm) acts.push('DM support resources');
  if (decision.flag) acts.push('report to mod-log');
  if (decision.wouldHave) acts.push(c.gray(`(observe mode - would have: ${JSON.stringify(decision.wouldHave)})`));
  if (acts.length) lines.push(`  actions   ${acts.join(', ')}`);
  return lines.join('\n');
}

export function bar(n, width = 20) {
  const f = Math.round((Math.max(0, Math.min(100, n)) / 100) * width);
  const col = n >= 70 ? c.red : n >= 40 ? c.yellow : c.green;
  return col('█'.repeat(f)) + c.gray('░'.repeat(width - f));
}
