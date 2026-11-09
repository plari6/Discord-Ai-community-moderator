/**
 * Optional external alert for urgent cases (threats, self-harm, raids) so staff hear about them
 * even when nobody is watching the mod-log: Slack incoming webhook, Discord webhook, or any URL
 * that accepts JSON (Zapier, Make, n8n, PagerDuty bridge).
 */
export function alertText(c) {
  const who = c.username ? `${c.username} (${c.userId})` : c.userId || 'unknown';
  const where = c.channelName ? ` in #${c.channelName}` : '';
  return `🚨 [${(c.priority || 'urgent').toUpperCase()}] ${c.kind || 'case'} #${c.id ?? '-'} - ${who}${where}\n${(c.reasons || []).join('\n')}${c.content ? `\n> ${String(c.content).slice(0, 300)}` : ''}`;
}

export function createNotifier({ webhookUrl, fetchImpl = fetch, logger } = {}) {
  if (!webhookUrl) return null;
  return async function alert(c) {
    const text = alertText(c);
    // "text" for Slack, "content" for Discord webhooks, "case" for everything else
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text.slice(0, 1990), case: c }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`alert webhook ${res.status}`);
    logger?.debug?.('[alert] sent');
  };
}
