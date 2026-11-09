#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import { loadDotenv, discordProblems } from '../src/config.js';
import { createApp, startHealthServer } from '../src/index.js';
import { formatCheck, c } from '../src/format.js';
import { createLogger } from '../src/logger.js';
import { truncate } from '../src/text.js';

loadDotenv();

const program = new Command();
program
  .name('discord-mod')
  .description('AI community moderator for Discord: filters spam and scams, answers new-member questions, flags toxic behaviour.')
  .version('1.0.0')
  .option('--no-ai', 'keyword rules only (no LLM calls)')
  .option('--simulate-outage <providers>', 'pretend these AI providers are down, e.g. "gemini" or "gemini,groq" (demo the fallback)')
  .option('--observe', 'shadow mode: report to the mod-log only, never delete or time out')
  .option('-v, --verbose', 'debug logging');

function build(cmd, extra = {}) {
  const o = cmd.optsWithGlobals();
  const logger = createLogger(o.verbose ? 'debug' : o.json ? 'error' : process.env.LOG_LEVEL || 'info');
  const app = createApp({
    noAi: o.ai === false,
    simulate: o.simulateOutage ? String(o.simulateOutage).split(',') : [],
    mode: o.observe ? 'observe' : undefined,
    logger,
    ...extra,
  });
  return { o, app, logger };
}

const readInput = (words, o) => {
  let text = words.join(' ');
  if (o.file) text = fs.readFileSync(o.file, 'utf8');
  if (!text && !process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
  return text.trim();
};

program
  .command('start')
  .description('connect to Discord and moderate (needs DISCORD_TOKEN)')
  .action(async (_opts, cmd) => {
    const { app, logger } = build(cmd);
    const problems = discordProblems(app.config);
    if (!app.config.discord.token) {
      console.error(c.red('Discord is not configured:'));
      problems.forEach((p) => console.error(`  - ${p}`));
      console.error('Copy .env.example to .env and fill it in, or try `discord-mod demo` (no account needed).');
      process.exit(2);
    }
    problems.forEach((p) => logger.warn(`[config] ${p}`));
    if (!app.router?.enabledCount) logger.warn('[config] no AI key set: toxicity uses keyword rules and Q&A uses FAQ matching only');
    const { createDiscordBot } = await import('../src/discord/bot.js');
    const bot = createDiscordBot({ app, logger });
    if (app.config.port) {
      await startHealthServer(app, app.config.port);
      logger.info(`[health] http://localhost:${app.config.port}/health`);
    }
    const stop = async () => {
      logger.info('shutting down');
      app.store.flush();
      await bot.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('unhandledRejection', (e) => logger.error(`[unhandled] ${e?.stack || e}`));
    await bot.start();
  });

program
  .command('demo')
  .description('simulate a busy day on a fake server (no Discord account needed)')
  .option('-s, --scenario <file>', 'scenario JSON (default examples/demo-scenario.json)')
  .action(async (_opts, cmd) => {
    const o = cmd.optsWithGlobals();
    const { runDemo } = await import('../src/demo.js');
    const logger = createLogger(o.verbose ? 'debug' : 'error');
    await runDemo({
      file: o.scenario,
      mode: o.observe ? 'observe' : undefined,
      appOptions: { noAi: o.ai === false, simulate: o.simulateOutage ? String(o.simulateOutage).split(',') : [], logger },
    });
  });

program
  .command('check')
  .description('score one message for spam and toxicity (nothing is sent)')
  .argument('[text...]', 'message text (or --file / stdin)')
  .option('-f, --file <path>', 'read the text from a file')
  .option('--new-member', 'author joined minutes ago with a 1-day-old account')
  .option('--json', 'JSON output')
  .action(async (words, _opts, cmd) => {
    const { o, app } = build(cmd, { memory: true });
    const text = readInput(words, o);
    if (!text) {
      console.error('Nothing to check. Example: discord-mod check "shut up you idiot"');
      process.exit(2);
    }
    const t = Date.now();
    const r = await app.moderator.checkOnly({
      id: 'cli',
      guildId: 'cli',
      channelId: 'cli',
      content: text,
      createdAt: t,
      mentions: { users: (text.match(/<@!?\d+>/g) || []).length, roles: 0, everyone: /@(everyone|here)/.test(text) },
      author: {
        id: 'cli-user',
        username: 'member',
        accountCreatedAt: o.newMember ? t - 86_400_000 : t - 400 * 86_400_000,
        joinedAt: o.newMember ? t - 120_000 : t - 100 * 86_400_000,
      },
    });
    console.log(o.json ? JSON.stringify(r, null, 2) : formatCheck(r));
  });

program
  .command('ask')
  .description('ask the knowledge base a question like a new member would')
  .argument('[question...]')
  .option('--json', 'JSON output')
  .action(async (words, _opts, cmd) => {
    const { o, app } = build(cmd, { memory: true });
    const q = readInput(words, o);
    if (!q) {
      console.error('Example: discord-mod ask "how do I get roles?"');
      process.exit(2);
    }
    const r = await app.moderator.ask(q);
    if (o.json) return console.log(JSON.stringify(r, null, 2));
    console.log(`${r.answered ? c.green('[ANSWERED]') : c.yellow('[NO ANSWER]')} ${c.gray(`${r.source}${r.faqId ? ` · ${r.faqId}` : ''}${r.model ? ` · ${r.model}` : ''} · score ${r.score}`)}`);
    console.log(r.text);
  });

program
  .command('doctor')
  .description('check configuration, knowledge file and AI models')
  .option('--ping', 'send a tiny request to every AI model')
  .action(async (_opts, cmd) => {
    const { o, app } = build(cmd, { memory: true });
    const ok = (s) => console.log(`${c.green('✔')} ${s}`);
    const bad = (s) => console.log(`${c.yellow('!')} ${s}`);
    const cfg = app.config;
    console.log(c.bold('Discord'));
    cfg.discord.token ? ok('DISCORD_TOKEN set') : bad('DISCORD_TOKEN missing');
    cfg.discord.clientId ? ok(`DISCORD_CLIENT_ID ${cfg.discord.clientId}`) : bad('DISCORD_CLIENT_ID missing (slash commands, invite link)');
    cfg.discord.modLogChannelId ? ok(`mod-log channel ${cfg.discord.modLogChannelId}`) : bad('MOD_LOG_CHANNEL_ID missing (flags only go to the console)');
    ok(`help channels: ${cfg.discord.helpChannelIds.join(', ') || 'none (questions answered on @mention, /ask and from new members)'}`);
    ok(`mode: ${cfg.mode}${cfg.mode === 'observe' ? ' (nothing is deleted)' : ''} · AI scan: ${cfg.toxicity.aiScan} (max ${cfg.toxicity.aiMaxPerMinute}/min)`);
    if (cfg.discord.token) {
      try {
        const res = await fetch('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bot ${cfg.discord.token}` }, signal: AbortSignal.timeout(8000) });
        const j = await res.json();
        res.ok ? ok(`bot token valid: ${j.username} (${j.id})`) : bad(`Discord rejected the token: ${res.status} ${j.message || ''}`);
      } catch (err) {
        bad(`could not reach Discord: ${err.message}`);
      }
    }
    console.log(c.bold('\nKnowledge'));
    ok(`${app.kb.server.name}: ${app.kb.faqs.length} FAQs, ${app.kb.rules.length} rules, ${Object.keys(app.kb.channels).length} channels (${cfg.qa.knowledgeFile})`);
    console.log(c.bold('\nAI models'));
    if (!app.router) return bad('AI disabled (--no-ai)');
    if (!app.router.enabledCount) bad('no AI key set - add GEMINI_API_KEY (and GROQ/NVIDIA/OPENROUTER for redundancy)');
    for (const t of app.router.status()) {
      if (!t.enabled) {
        console.log(c.gray(`  - ${t.id} (${t.disabledReason || 'no key'})`));
        continue;
      }
      if (!o.ping) {
        console.log(`  ${c.cyan('•')} ${t.id}`);
        continue;
      }
      const s = Date.now();
      try {
        const r = await app.router.generate({ only: t.id, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 1024, timeoutMs: 20_000 });
        console.log(`  ${c.green('✔')} ${t.id} ${c.gray(`${Date.now() - s} ms: ${truncate(r.text.trim(), 30)}`)}`);
      } catch (err) {
        console.log(`  ${c.red('✖')} ${t.id} ${c.gray(truncate(err.attempts?.[0]?.message || err.message, 120))}`);
      }
    }
  });

program
  .command('register-commands')
  .description('register the slash commands (/ask /check /warnings /clearstrikes /modstats)')
  .action(async (_opts, cmd) => {
    const { app } = build(cmd, { memory: true });
    const { registerCommands } = await import('../src/discord/commands.js');
    const r = await registerCommands({ token: app.config.discord.token, clientId: app.config.discord.clientId, guildIds: app.config.discord.guildIds });
    console.log(`${r.count} commands registered (${r.scope}${r.guildIds ? `: ${r.guildIds.join(', ')}` : ', can take up to an hour to appear'})`);
  });

program
  .command('invite')
  .description('print the link that adds the bot to a server with the right permissions')
  .action(async (_opts, cmd) => {
    const { app } = build(cmd, { memory: true });
    if (!app.config.discord.clientId) {
      console.error('Set DISCORD_CLIENT_ID first (Developer Portal > General Information > Application ID).');
      process.exit(2);
    }
    const { inviteUrl } = await import('../src/discord/commands.js');
    console.log(inviteUrl(app.config.discord.clientId));
  });

program
  .command('cases')
  .description('recent moderation cases')
  .option('-n, --limit <n>', 'how many', '20')
  .option('--open', 'only cases nobody reviewed yet')
  .option('--json', 'JSON output')
  .action((_opts, cmd) => {
    const { o, app } = build(cmd);
    const list = app.store.cases({ limit: Number(o.limit) || 20, status: o.open ? 'open' : undefined });
    if (o.json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log('No cases yet.');
    for (const k of list)
      console.log(`#${String(k.id).padEnd(4)} ${new Date(k.at).toISOString().slice(0, 16)} ${String(k.action).padEnd(8)} ${String(k.kind || '').padEnd(11)} ${String(k.priority || '').padEnd(7)} ${String(k.status).padEnd(14)} ${k.username || ''}: ${truncate(k.content || k.reasons?.[0] || '', 60)}`);
  });

program
  .command('stats')
  .description('what the bot did in the last days')
  .option('-d, --days <n>', 'days', '7')
  .action((_opts, cmd) => {
    const { o, app } = build(cmd);
    const s = app.store.statsFor(Number(o.days) || 7);
    if (!Object.keys(s).length) return console.log('No activity recorded yet.');
    for (const [k, v] of Object.entries(s).sort()) console.log(`${k.padEnd(22)} ${v}`);
  });

program
  .command('gaps')
  .description('questions members asked that the knowledge base could not answer')
  .action((_opts, cmd) => {
    const { app } = build(cmd);
    const g = app.store.gaps(50);
    if (!g.length) return console.log('No knowledge gaps recorded.');
    for (const x of g) console.log(`${String(x.count).padStart(3)}x  ${x.question}`);
  });

program.parseAsync().catch((err) => {
  console.error(c.red(err.message));
  process.exit(1);
});
