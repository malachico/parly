import { createInterface } from 'node:readline/promises';
import { createDb } from '../db/db.js';
import { Registry } from '../registry/registry.js';

/**
 * Self-hosted: sets a person's password from the host, since there is no email to reset it by. Signs out their web
 * sessions. `docker compose exec hub node dist/cli/resetPassword.js you@example.com`, then type the new password.
 */
const email = process.argv[2];
if (!email) {
  console.error('Usage: node dist/cli/resetPassword.js <email>   (reads the new password from stdin)');
  process.exit(2);
}

/** Reads a line without echoing it on a TTY (password prompts). Piped stdin is read as a normal line. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    process.stderr.write(prompt);
    const line = await rl.question('');
    rl.close();
    return line;
  }
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return await new Promise((resolve) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const password = await readSecret('New password (10+ characters): ');
await new Registry(createDb()).resetPassword(email, password);
console.error(`Password set for ${email}; their old web sessions are signed out.`);
process.exit(0);
