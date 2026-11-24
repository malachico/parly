import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/db.js';
import { retryBilling } from './rest/companies.js';
import { makeShutdown } from './shutdown.js';

const config = loadConfig();
if (!config.credentialsKey) console.warn(config.requireCredentialsKey ? 'CREDENTIALS_KEY is not set: endpoint agents that need a credential cannot be registered' : 'CREDENTIALS_KEY is not set: endpoint-agent credentials are stored unsealed');
const { app, hub } = createApp({ db: createDb(), config });

const server = app.listen(config.port, () => {
  console.log(`Parly hub listening on :${config.port} (public URL ${config.publicUrl})`);
});

// Agents woken by a Claude Code Routine: retry fires that failed and sessions that never came. Each instance
// sweeps; claimFire keeps two from firing for the same messages.
// ponytail: runs only while an instance has CPU (Cloud Run throttles idle ones); a scheduler job if that ever bites
const sweep = setInterval(() => {
  void hub.wakeService.wakeSweep().catch((err) => console.error('wake sweep failed', err));
  // Scheduled messages too; POST /tick (a scheduler job) covers the minutes no instance is awake.
  void hub.scheduleService.runSchedules().catch((err) => console.error('scheduled messages failed', err));
  // Seat recounts and Pro cancel undos that Paddle refused (retryBilling logs its own errors).
  void retryBilling(hub);
}, config.wakeSweepMs);
sweep.unref();

const shutdown = makeShutdown(server, hub, (code) => process.exit(code));

// Cloud Run sends SIGTERM before stopping an instance: finish the wakes under way first.
// Turns under way are stopped and their push leases freed now, not after the ~10s grace (SIGKILL skips finally blocks).
process.on('SIGTERM', () => shutdown(0));

// An uncaught exception leaves the process in an undefined state: log it, free leases through the same path, and
// exit non-zero so Cloud Run restarts the instance rather than leaving it half-broken.
process.on('uncaughtException', (err) => {
  console.error('uncaught exception, shutting down', err);
  shutdown(1);
});

// A stray rejection shouldn't take the instance (and every in-flight turn) down; registering this handler also
// stops Node's default crash-on-unhandled-rejection. Log loudly so it still gets noticed.
process.on('unhandledRejection', (reason) => console.error('unhandled promise rejection', reason));
