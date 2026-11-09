import { capsRatio, deobfuscate, emojiCount, extractUrls, fingerprint, hostOf, squash, zalgoRatio } from './text.js';

/**
 * Spam and scam detector. Pure rules (no AI, no network), so it runs on every message in
 * well under a millisecond. It keeps a short per-user history in memory to catch floods and
 * the same message pasted across channels (the classic compromised-account pattern).
 */

// Domains that imitate Discord / Steam / crypto brands. Real scams change daily, so the
// lookalike check below matters more than this list.
const KNOWN_SCAM_DOMAINS = [
  'discord-nitro.gift', 'discordnitro.gift', 'dlscord.gift', 'discord-gift.com', 'discordgift.site',
  'steamcommunlty.com', 'steamcommunity.ru', 'stearncommunity.com', 'steam-gift.ru', 'nitro-drop.com',
  'free-nitro.ru', 'dlscordapp.com', 'discorcl.com', 'discord-app.gift',
];
const BRANDS = ['discord', 'steam', 'steamcommunity', 'nitro', 'opensea', 'metamask', 'binance', 'coinbase'];
// Only long, distinctive brands get typo matching ("binance" is one letter from "finance").
const FUZZY_BRANDS = ['discord', 'steamcommunity', 'metamask', 'opensea', 'coinbase'];
const OFFICIAL = new Set([
  'discord.com', 'discord.gg', 'discordapp.com', 'discord.gift', 'discord.media', 'discordapp.net', 'discord.new',
  'steampowered.com', 'steamcommunity.com', 'opensea.io', 'metamask.io', 'binance.com', 'coinbase.com',
  'youtube.com', 'youtu.be', 'github.com', 'twitter.com', 'x.com', 'twitch.tv', 'reddit.com', 'google.com', 'tenor.com', 'giphy.com',
]);
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 'cutt.ly', 'is.gd', 'rb.gy', 't.ly', 'shorturl.at', 'goo.su', 'u.to', 'grabify.link', 'iplogger.org']);

const SCAM_PHRASES = [
  /free\s*(discord\s*)?nitro/,
  /nitro\s*(for\s*)?free/,
  /(steam|discord)\s*(gift|giveaway)\s*(card|code)?/,
  /(claim|grab|get)\s+(your|ur|a)\s+(free|gift|reward|airdrop|nitro)/,
  /\b(airdrop|giveaway)\b.*\b(claim|connect\s*wallet|limited)\b/,
  /connect\s+(your\s+)?wallet/,
  /(i'?m|im)\s+(leaving|quitting)\s+(cs|csgo|cs2|steam|the\s+game).*\b(skins?|inventory|items)\b/,
  /(accidentally|mistakenly)\s+reported\s+you/,
  /double\s+your\s+(btc|eth|crypto|money)/,
  /(dm|message)\s+me\s+(for|to\s+(get|earn|make))\s+.*(\$|money|profit|crypto)/,
  /earn\s+\$?\d+[k]?\s*(\/|per)\s*(day|week|hour)/,
  /(onlyfans|nudes?)\s+(leak|free)/,
];

const editDistance1or2 = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return false;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const d = dp[a.length][b.length];
  return d > 0 && d <= 2;
};

/** Is this hostname pretending to be a brand? ("dlscord-gift.com", "steamcommunlty.com", "discord.nitro-free.xyz") */
export function lookalikeOf(host) {
  if (!host || OFFICIAL.has(host)) return null;
  for (const off of OFFICIAL) if (host.endsWith(`.${off}`)) return null;
  if (KNOWN_SCAM_DOMAINS.includes(host)) return 'known scam domain';
  const labels = host.split('.');
  const parts = labels.flatMap((l) => l.split('-'));
  for (const brand of BRANDS) {
    if (parts.includes(brand)) return `uses "${brand}" in an unofficial domain`;
    if (FUZZY_BRANDS.includes(brand) && parts.some((p) => p.length >= 6 && editDistance1or2(p, brand))) return `imitates "${brand}"`;
  }
  return null;
}

export const SPAM_POINTS = {
  scam_link: 70,
  scam_phrase: 45,
  cross_channel_duplicate: 55,
  duplicate: 40,
  flood: 60,
  mass_mention: 50,
  everyone_ping: 35,
  invite_link: 35,
  blocked_domain: 60,
  shortener_link: 15,
  new_account_link: 20,
  link_flood: 15,
  caps: 12,
  emoji_spam: 12,
  char_spam: 12,
  zalgo: 20,
  wall_of_text: 10,
};

export function createSpamDetector(cfg) {
  const history = new Map(); // userId -> [{ at, fp, channelId, messageId }]
  const keepMs = Math.max(cfg.floodWindowMs, cfg.duplicateWindowMs);

  function remember(msg, now) {
    const list = (history.get(msg.author.id) || []).filter((h) => now - h.at <= keepMs);
    list.push({ at: now, fp: fingerprint(msg.content), channelId: msg.channelId, messageId: msg.id });
    history.set(msg.author.id, list.slice(-50));
    if (history.size > 5000) history.delete(history.keys().next().value); // bound memory
    return list;
  }

  /**
   * @param msg normalized message (see moderator.js)
   * @returns {{ score:number, signals:string[], details:string[], category:'scam'|'spam'|null, related:{messageId:string,channelId:string}[] }}
   */
  function check(msg, now = msg.createdAt || Date.now()) {
    const signals = new Set();
    const details = [];
    const related = [];
    const content = msg.content || '';
    const variants = [deobfuscate(content), squash(content)];

    // --- links ---
    const urls = extractUrls(content);
    const hosts = urls.map(hostOf).filter(Boolean);
    for (const url of urls) {
      if (/discord(?:app)?\.(?:gg|com\/invite)|dsc\.gg/i.test(url) && !cfg.allowInvites) {
        signals.add('invite_link');
        details.push(`server invite: ${url}`);
      }
    }
    for (const host of hosts) {
      if (cfg.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
      if (cfg.blockedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
        signals.add('blocked_domain');
        details.push(`blocked domain: ${host}`);
      }
      const fake = lookalikeOf(host);
      if (fake) {
        signals.add('scam_link');
        details.push(`${host}: ${fake}`);
      }
      if (SHORTENERS.has(host)) {
        signals.add('shortener_link');
        details.push(`link shortener / IP logger: ${host}`);
      }
    }
    if (urls.length >= 3) signals.add('link_flood');
    const accountAgeDays = msg.author.accountCreatedAt ? (now - msg.author.accountCreatedAt) / 86_400_000 : Infinity;
    const memberAgeDays = msg.author.joinedAt ? (now - msg.author.joinedAt) / 86_400_000 : Infinity;
    if (urls.length && (accountAgeDays < cfg.newAccountDays || memberAgeDays < 1 / 24)) {
      signals.add('new_account_link');
      details.push(accountAgeDays < cfg.newAccountDays ? `link from a ${Math.max(0, Math.floor(accountAgeDays))}-day-old account` : 'link posted within an hour of joining');
    }

    // --- scam wording ---
    const phrase = SCAM_PHRASES.find((re) => variants.some((v) => re.test(v)));
    if (phrase) {
      signals.add('scam_phrase');
      details.push('typical scam wording');
      if (urls.length) signals.add('scam_link');
    }

    // --- mentions ---
    const mentionTotal = (msg.mentions?.users || 0) + (msg.mentions?.roles || 0);
    if (mentionTotal >= cfg.maxMentions) {
      signals.add('mass_mention');
      details.push(`${mentionTotal} mentions in one message`);
    }
    if (msg.mentions?.everyone && !msg.author.canMentionEveryone) {
      signals.add('everyone_ping');
      details.push('tried to ping @everyone/@here');
    }

    // --- formatting abuse ---
    if (capsRatio(content) > 0.75 && content.length >= 15) signals.add('caps');
    if (emojiCount(content) >= 15) signals.add('emoji_spam');
    if (/(.)\1{14,}/su.test(content) || /(\b\S{2,12}\b)(?:\s+\1){7,}/iu.test(content)) signals.add('char_spam');
    if (zalgoRatio(content) > 0.3) signals.add('zalgo');
    if (content.split('\n').length > 30 || content.length > 1800) signals.add('wall_of_text');

    // --- behaviour over time ---
    const list = remember(msg, now);
    const fp = fingerprint(content);
    const recent = list.filter((h) => now - h.at <= cfg.floodWindowMs);
    if (recent.length >= cfg.floodCount) {
      signals.add('flood');
      details.push(`${recent.length} messages in ${Math.round(cfg.floodWindowMs / 1000)}s`);
      related.push(...recent);
    }
    if (fp.length >= 3) {
      const dups = list.filter((h) => h.fp === fp && now - h.at <= cfg.duplicateWindowMs);
      if (dups.length >= cfg.duplicateCount) {
        const channels = new Set(dups.map((h) => h.channelId));
        signals.add(channels.size > 1 ? 'cross_channel_duplicate' : 'duplicate');
        details.push(`same message ${dups.length}x${channels.size > 1 ? ` in ${channels.size} channels` : ''}`);
        related.push(...dups);
      }
    }

    const list2 = [...signals];
    let score = list2.reduce((s, k) => s + (SPAM_POINTS[k] || 0), 0);
    score = Math.min(100, score);
    const category = signals.has('scam_link') || (signals.has('scam_phrase') && urls.length) ? 'scam' : score > 0 ? 'spam' : null;
    return {
      score,
      signals: list2,
      details,
      category,
      related: [...new Map(related.map((h) => [h.messageId, { messageId: h.messageId, channelId: h.channelId }])).values()].filter((h) => h.messageId && h.messageId !== msg.id),
    };
  }

  return { check, reset: () => history.clear(), _history: history };
}
