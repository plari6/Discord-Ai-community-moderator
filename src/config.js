import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load `.env` from the current folder first, then from the project folder.
 * Values already in the environment win. DISCORD_MOD_SKIP_DOTENV=1 disables both (tests).
 */
export function loadDotenv(env = process.env) {
  if (env.DISCORD_MOD_SKIP_DOTENV === '1') return [];
  const loaded = [];
  for (const file of [path.resolve(process.cwd(), '.env'), path.join(PROJECT_ROOT, '.env')]) {
    if (!loaded.includes(file) && fs.existsSync(file)) {
      dotenv.config({ path: file, processEnv: env, quiet: true });
      loaded.push(file);
    }
  }
  return loaded;
}

const num = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const ids = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{5,25}$/.test(s));
const words = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const oneOf = (v, allowed, d) => (allowed.includes(String(v || '').trim().toLowerCase()) ? String(v).trim().toLowerCase() : d);

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(PROJECT_ROOT, 'data'));
  return {
    discord: {
      token: (env.DISCORD_TOKEN || '').trim(),
      clientId: (env.DISCORD_CLIENT_ID || '').trim(),
      guildIds: ids(env.DISCORD_GUILD_IDS || env.DISCORD_GUILD_ID),
      modLogChannelId: ids(env.MOD_LOG_CHANNEL_ID)[0] || null,
      welcomeChannelId: ids(env.WELCOME_CHANNEL_ID)[0] || null,
      helpChannelIds: ids(env.HELP_CHANNEL_IDS),
      ignoredChannelIds: ids(env.IGNORED_CHANNEL_IDS),
      exemptRoleIds: ids(env.EXEMPT_ROLE_IDS),
      modRoleIds: ids(env.MOD_ROLE_IDS),
      registerCommandsOnStart: bool(env.REGISTER_COMMANDS_ON_START, true),
      get configured() {
        return Boolean(this.token);
      },
    },
    // enforce = delete / timeout automatically; observe = only report to the mod-log (shadow mode for onboarding).
    mode: oneOf(env.MOD_MODE, ['enforce', 'observe'], 'enforce'),
    spam: {
      floodCount: num(env.FLOOD_COUNT, 5), // messages ...
      floodWindowMs: num(env.FLOOD_WINDOW_SECONDS, 7) * 1000, // ... within this many seconds
      duplicateCount: num(env.DUPLICATE_COUNT, 3),
      duplicateWindowMs: num(env.DUPLICATE_WINDOW_SECONDS, 60) * 1000,
      maxMentions: num(env.MAX_MENTIONS, 5),
      allowInvites: bool(env.ALLOW_INVITES, false),
      allowedDomains: words(env.ALLOWED_DOMAINS),
      blockedDomains: words(env.BLOCKED_DOMAINS),
      newAccountDays: num(env.NEW_ACCOUNT_DAYS, 7),
    },
    toxicity: {
      // all = every message goes to the AI (within the per-minute budget); suspicious = only messages the
      // rules pre-filter flags (cheapest); off = keyword rules only.
      aiScan: oneOf(env.AI_SCAN, ['all', 'suspicious', 'off'], 'all'),
      aiMaxPerMinute: num(env.AI_MAX_PER_MINUTE, 30),
      prefilterScore: num(env.AI_PREFILTER_SCORE, 10),
      minLength: num(env.AI_MIN_LENGTH, 4),
      contextMessages: num(env.CONTEXT_MESSAGES, 4),
      blockedWords: words(env.BLOCKED_WORDS),
    },
    thresholds: {
      spamFlag: num(env.SPAM_FLAG_SCORE, 35),
      spamDelete: num(env.SPAM_DELETE_SCORE, 60),
      toxFlag: num(env.TOX_FLAG_SCORE, 45),
      toxDelete: num(env.TOX_DELETE_SCORE, 70),
      toxTimeout: num(env.TOX_TIMEOUT_SCORE, 88),
      timeoutMinutes: num(env.TIMEOUT_MINUTES, 60),
      floodTimeoutMinutes: num(env.FLOOD_TIMEOUT_MINUTES, 10),
      scamTimeoutMinutes: num(env.SCAM_TIMEOUT_MINUTES, 1440),
      strikeWindowHours: num(env.STRIKE_WINDOW_HOURS, 24),
      strikesForTimeout: num(env.STRIKES_FOR_TIMEOUT, 3),
      strikesForLongTimeout: num(env.STRIKES_FOR_LONG_TIMEOUT, 5),
      longTimeoutMinutes: num(env.LONG_TIMEOUT_MINUTES, 1440),
    },
    qa: {
      knowledgeFile: path.resolve(env.KNOWLEDGE_FILE || path.join(PROJECT_ROOT, 'knowledge', 'community.json')),
      // Auto-answer questions in HELP_CHANNEL_IDS, and questions anywhere from members who joined recently.
      autoAnswer: bool(env.AUTO_ANSWER, true),
      newMemberDays: num(env.NEW_MEMBER_DAYS, 7),
      answerNewMembersAnywhere: bool(env.ANSWER_NEW_MEMBERS_ANYWHERE, true),
      instantScore: num(env.FAQ_INSTANT_SCORE, 0.6),
      userCooldownMs: num(env.QA_COOLDOWN_SECONDS, 20) * 1000,
    },
    welcome: {
      enabled: bool(env.WELCOME_ENABLED, true),
      dm: bool(env.WELCOME_DM, false),
      minAccountAgeDays: num(env.MIN_ACCOUNT_AGE_DAYS, 3),
      raidJoinCount: num(env.RAID_JOIN_COUNT, 8),
      raidWindowMs: num(env.RAID_WINDOW_SECONDS, 60) * 1000,
    },
    alerts: {
      webhookUrl: (env.ALERT_WEBHOOK_URL || '').trim(), // Slack / Discord / any JSON webhook for urgent cases
    },
    dataDir,
    port: num(env.PORT, 0),
  };
}

export function discordProblems(config) {
  const p = [];
  if (!config.discord.token) p.push('DISCORD_TOKEN is missing (Discord Developer Portal > your app > Bot > Reset Token)');
  if (!config.discord.clientId) p.push('DISCORD_CLIENT_ID is missing (Developer Portal > General Information > Application ID); needed for slash commands');
  if (!config.discord.modLogChannelId) p.push('MOD_LOG_CHANNEL_ID is not set: flagged messages will only be logged locally');
  return p;
}
