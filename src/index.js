import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createRouterFromEnv } from './ai/index.js';
import { loadKnowledge, normalizeKnowledge } from './knowledge.js';
import { createStore } from './store.js';
import { createModerator } from './moderator.js';
import { createNotifier } from './notify.js';
import { createLogger } from './logger.js';

export { loadConfig, loadDotenv, discordProblems, PROJECT_ROOT } from './config.js';
export { createModerator } from './moderator.js';
export { decide } from './policy.js';
export { ruleScore } from './toxicity.js';
export { createSpamDetector } from './spam.js';

/**
 * Build the app without connecting to Discord.
 * options: env, noAi, simulate (provider names), aiProviders (tests), kb (object), store (null file = memory),
 *          logger, now, fetchImpl
 */
export function createApp(options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadConfig(env);
  if (options.mode) config.mode = options.mode;
  const logger = options.logger || createLogger(env.LOG_LEVEL || 'info');
  const kb = options.kb ? normalizeKnowledge(options.kb) : loadKnowledge(config.qa.knowledgeFile);

  const router = options.noAi
    ? null
    : createRouterFromEnv(env, {
        providers: options.aiProviders,
        simulate: options.simulate || [],
        fetchImpl: options.fetchImpl,
        onEvent: (e) => {
          if (e.type === 'failure') logger.warn(`[ai] ${e.target} ${e.kind} -> next model`);
        },
      });

  const store = options.store || createStore(options.memory ? null : path.join(config.dataDir, 'moderator.json'), { now: options.now });
  const notifier = createNotifier({ webhookUrl: config.alerts.webhookUrl, fetchImpl: options.fetchImpl, logger });
  const actions = { alert: notifier || undefined };
  const moderator = createModerator({ config, kb, router, store, actions, logger, now: options.now });
  const health = { startedAt: new Date().toISOString(), discord: { ready: false } };

  return {
    config,
    kb,
    router,
    store,
    notifier,
    moderator,
    logger,
    health,
    actions,
    /** Plug in a platform adapter (Discord, demo console, tests). */
    attachActions(a) {
      Object.assign(actions, a);
    },
    healthReport() {
      return {
        ok: true,
        mode: config.mode,
        ...health,
        ai: router ? router.status().map(({ id, state, avgMs, lastErrorKind }) => ({ id, state, avgMs, lastErrorKind })) : 'disabled',
        today: store.statsFor(1),
      };
    },
  };
}

/** Tiny health endpoint for Docker / Railway / Render uptime checks (GET /health). */
export function startHealthServer(app, port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const body = app.healthReport();
      res.writeHead(body.discord?.ready ? 200 : 503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body, null, 2));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
