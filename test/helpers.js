import { createApp } from '../src/index.js';
import { silentLogger } from '../src/logger.js';

/** Env with no real keys: AI comes only from injected fake providers. */
export const baseEnv = (extra = {}) => ({ DISCORD_MOD_SKIP_DOTENV: '1', AI_HEDGE_MS: '0', AI_CHAIN: 'fake:one,fake:two', ...extra });

/** Fake AI provider: `fn(prompt, req)` returns an object (sent as JSON), a string, or an Error. */
export function fakeProvider(fn) {
  const calls = [];
  return {
    configured: true,
    calls,
    async complete(req) {
      calls.push(req);
      const prompt = req.messages.map((m) => m.content).join('\n');
      const out = typeof fn === 'function' ? fn(prompt, req) : fn;
      if (out instanceof Error) throw out;
      return { text: typeof out === 'string' ? out : JSON.stringify(out) };
    },
  };
}

export const tox = (over = {}) => ({
  toxicity: 5,
  categories: [],
  severity: 'none',
  directed_at: 'none',
  is_banter: false,
  needs_human: false,
  language: 'en',
  reason: 'normal chat',
  ...over,
});

export const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

let n = 0;
export function makeMsg(content, over = {}) {
  const { author = {}, ...rest } = over;
  return {
    id: String(++n),
    guildId: 'g1',
    channelId: 'c-general',
    channelName: 'general',
    content,
    createdAt: rest.createdAt ?? T0,
    mentionsBot: false,
    mentions: { users: 0, roles: 0, everyone: false },
    ...rest,
    author: {
      id: 'u1',
      username: 'member',
      bot: false,
      accountCreatedAt: T0 - 400 * 86_400_000,
      joinedAt: T0 - 100 * 86_400_000,
      roleIds: [],
      isMod: false,
      ...author,
    },
  };
}

/** App with a fake AI, an in-memory store and a recording actions adapter. */
export function testApp({ ai, env = {}, noAi = false, clock = { t: T0 }, kb, mode } = {}) {
  const provider = fakeProvider(ai ?? (() => tox()));
  const app = createApp({
    env: baseEnv(env),
    aiProviders: { fake: provider },
    noAi,
    memory: true,
    logger: silentLogger,
    now: () => clock.t,
    kb,
    mode,
  });
  const log = [];
  const rec = (name) => async (...args) => log.push([name, ...args]);
  app.attachActions({
    deleteMessage: rec('delete'),
    timeout: rec('timeout'),
    ban: rec('ban'),
    reply: async (msg, text) => log.push(['reply', msg.id, text]),
    dm: rec('dm'),
    send: rec('send'),
    modLog: async (c) => log.push(['modLog', c]),
    alert: async (c) => log.push(['alert', c]),
  });
  return { app, log, provider, clock, did: (name) => log.filter((l) => l[0] === name) };
}
