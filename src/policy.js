/**
 * Turns the spam + toxicity scores into one decision. Pure function, no Discord calls,
 * so every rule here is unit tested.
 *
 * Ladder: none -> flag (mods review in the mod-log) -> delete + warn + strike -> timeout.
 * Repeat offenders escalate through strikes. Self-harm is never punished: it alerts the mods
 * and DMs the member support resources. In "observe" mode nothing is deleted or timed out;
 * the mod-log shows what WOULD have happened (shadow mode to tune thresholds on a new server).
 */

const PRIORITY = ['low', 'normal', 'high', 'urgent'];
const raise = (cur, next) => (PRIORITY.indexOf(next) > PRIORITY.indexOf(cur || 'low') ? next : cur || next);

export function decide({ spam = { score: 0, signals: [] }, tox = { toxicity: 0, categories: [] }, member = {}, thresholds: th, mode = 'enforce' }) {
  const d = {
    action: 'none',
    kind: null,
    deleteMessage: false,
    deleteRelated: false,
    timeoutMinutes: 0,
    warn: false,
    flag: false,
    priority: null,
    strike: false,
    supportDm: false,
    suggestBan: false,
    reasons: [],
    strikesAfter: member.strikes || 0,
  };
  const timeout = (m) => (d.timeoutMinutes = Math.max(d.timeoutMinutes, m));
  const flag = (p) => {
    d.flag = true;
    d.priority = raise(d.priority, p);
  };

  const cats = tox.categories || [];
  const selfHarm = cats.includes('self_harm');
  const t = tox.toxicity || 0;
  const s = spam.score || 0;
  const sig = new Set(spam.signals || []);

  // ---- self-harm: support, not punishment
  if (selfHarm) {
    d.kind = 'self_harm';
    d.supportDm = true;
    flag('urgent');
    d.reasons.push('possible self-harm risk - check in with this member');
  }

  // ---- spam / scams
  if (spam.category === 'scam' && s >= th.spamDelete) {
    d.kind = 'scam';
    d.deleteMessage = d.deleteRelated = true;
    d.strike = true;
    timeout(th.scamTimeoutMinutes);
    flag('high');
    d.suggestBan = Boolean(member.isNewAccount || member.isNewMember);
    d.reasons.push(`scam / phishing (${(spam.details || spam.signals).join('; ')})`);
  } else if (s >= th.spamDelete) {
    d.kind = d.kind || 'spam';
    d.deleteMessage = true;
    d.deleteRelated = sig.has('flood') || sig.has('duplicate') || sig.has('cross_channel_duplicate');
    d.warn = true;
    d.strike = true;
    if (d.deleteRelated || sig.has('mass_mention')) timeout(th.floodTimeoutMinutes);
    if (sig.has('cross_channel_duplicate')) d.suggestBan = Boolean(member.isNewAccount); // compromised / bot account
    flag(sig.has('cross_channel_duplicate') || sig.has('mass_mention') ? 'high' : 'normal');
    d.reasons.push(`spam (${(spam.details?.length ? spam.details : spam.signals).join('; ')})`);
  } else if (s >= th.spamFlag) {
    d.kind = d.kind || 'spam';
    flag('low');
    d.reasons.push(`possible spam (${spam.signals.join(', ')})`);
  }

  // ---- toxicity
  const label = [cats.filter((c) => c !== 'self_harm').join('/') || 'toxic', tox.reason].filter(Boolean).join(': ');
  if (t >= th.toxTimeout) {
    d.kind = d.kind && d.kind !== 'self_harm' ? d.kind : 'toxicity';
    d.deleteMessage = true;
    d.warn = true;
    d.strike = true;
    timeout(th.timeoutMinutes);
    flag(cats.includes('threat') || cats.includes('hate') ? 'urgent' : 'high');
    d.reasons.push(`severe (${t}/100) ${label}`);
  } else if (t >= th.toxDelete && !(tox.is_banter && !tox.needs_human)) {
    d.kind = d.kind && d.kind !== 'self_harm' ? d.kind : 'toxicity';
    d.deleteMessage = true;
    d.warn = true;
    d.strike = true;
    flag(cats.includes('threat') || cats.includes('hate') ? 'high' : 'normal');
    d.reasons.push(`toxic (${t}/100) ${label}`);
  } else if (t >= th.toxFlag && !(tox.is_banter && !tox.needs_human)) {
    d.kind = d.kind || 'toxicity';
    flag(cats.includes('threat') ? 'high' : 'normal');
    d.reasons.push(`needs review (${t}/100) ${label}`);
  } else if (tox.needs_human && !selfHarm && t >= 15) {
    d.kind = d.kind || 'toxicity';
    flag(cats.includes('threat') ? 'high' : 'low');
    d.reasons.push(`AI asked for a human look (${t}/100) ${label}`);
  }

  // ---- repeat offenders
  if (d.strike) {
    d.strikesAfter = (member.strikes || 0) + 1;
    if (d.strikesAfter >= th.strikesForLongTimeout) {
      timeout(th.longTimeoutMinutes);
      flag('urgent');
      d.suggestBan = true;
      d.reasons.push(`${d.strikesAfter} strikes in ${th.strikeWindowHours}h`);
    } else if (d.strikesAfter >= th.strikesForTimeout) {
      timeout(th.timeoutMinutes);
      flag('high');
      d.reasons.push(`${d.strikesAfter} strikes in ${th.strikeWindowHours}h`);
    }
  }

  // ---- moderators, admins and exempt roles are never auto-punished
  if (member.exempt) {
    const would = d.deleteMessage || d.timeoutMinutes;
    Object.assign(d, { deleteMessage: false, deleteRelated: false, timeoutMinutes: 0, warn: false, strike: false, suggestBan: false, strikesAfter: member.strikes || 0 });
    if (!would && !selfHarm) Object.assign(d, { flag: false, priority: null });
    if (would) d.reasons.push('author is exempt (staff) - not actioned');
  }

  // ---- observe (shadow) mode: report only
  if (mode === 'observe' && (d.deleteMessage || d.timeoutMinutes || d.warn)) {
    d.wouldHave = { deleteMessage: d.deleteMessage, timeoutMinutes: d.timeoutMinutes, warn: d.warn };
    Object.assign(d, { deleteMessage: false, deleteRelated: false, timeoutMinutes: 0, warn: false, strike: false, strikesAfter: member.strikes || 0 });
    flag(d.priority || 'normal');
  }

  d.action = d.timeoutMinutes ? 'timeout' : d.deleteMessage ? 'delete' : d.flag ? 'flag' : 'none';
  return d;
}

export function warningText(decision, { mention = 'there' } = {}) {
  if (decision.kind === 'scam') return `${mention}, your message was removed: it looked like a scam or phishing link. If your account was hacked, change your password and enable 2FA.`;
  if (decision.kind === 'spam') return `${mention}, please slow down - your message was removed by the anti-spam filter.`;
  return `${mention}, your message was removed because it breaks the server rules (be respectful). Repeated violations lead to a timeout.`;
}
