#!/usr/bin/env node
import { createApp } from '../server/app.js';
import { hashPassword, parseDuration } from '../server/util.js';
import { seed } from './seed.js';

const [cmd = 'serve', ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const HELP = `Pulse — self-hosted uptime monitoring

Usage: pulse <command>

  serve                     Start the server (default). Env: PORT, HOST, PULSE_DATA, PULSE_BASE_URL
  create-user               --email a@b.c --name "Ada" --password ******** (also resets password if user exists)
  seed                      Insert demo monitors + 30 days of synthetic history
  sweep                     Run the retention sweep once and exit
  help
`;

async function main() {
  if (cmd === 'help' || cmd === '--help') return console.log(HELP);

  if (cmd === 'serve') {
    const app = createApp();
    await app.start();
    const shutdown = async (sig) => { console.log(`\n${sig} — shutting down`); await app.stop(); process.exit(0); };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return;
  }

  const app = createApp({ schedulerEnabled: false, logLevel: 'warn' });
  const { models } = app;
  try {
    if (cmd === 'create-user') {
      const email = flag('email'), name = flag('name') ?? 'Admin', password = flag('password');
      if (!email || !password || password.length < 8) throw new Error('Need --email and --password (min 8 chars)');
      const ex = models.users.byEmail(email);
      if (ex) { models.users.setPassword(ex.id, hashPassword(password)); console.log(`Password reset for ${email}`); }
      else { models.users.create({ email, name, passHash: hashPassword(password) }); console.log(`Created ${email}`); }
    } else if (cmd === 'seed') {
      console.log(seed(models, { days: Number(flag('days')) || 30 }));
    } else if (cmd === 'sweep') {
      const { createRetention } = await import('../server/retention.js');
      console.log(createRetention({ models, config: app.config, log: console }).sweep());
    } else {
      console.log(HELP); process.exitCode = 1;
    }
  } catch (e) {
    console.error(`error: ${e.message}`); process.exitCode = 1;
  } finally {
    app.db.close();
  }
}
main();
export { parseDuration };
