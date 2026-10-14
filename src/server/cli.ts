// Hilfsbefehle für den Betrieb:
//   npm run db:migrate                 Datenbank auf den neuesten Stand bringen
//   npm run login-link -- name@mail.de Anmelde-Link erzeugen, ohne E-Mail zu verschicken
//   npm run db:seed                    Beispieldaten (Worlds 2026) einspielen – nur zum Ausprobieren

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashToken, LOGIN_TOKEN_MINUTES, newToken, normalizeEmail } from './auth.ts';
import { loadConfig } from './config.ts';
import { createDb, migrate } from './db/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const [command, arg] = process.argv.slice(2);
const config = loadConfig();
const db = createDb(config.databaseUrl, { max: 1 });

try {
  if (command === 'migrate') {
    const applied = await migrate(db, join(root, 'db', 'migrations'), (m) => console.log(m));
    console.log(applied.length ? `Fertig: ${applied.join(', ')}` : 'Datenbank ist schon auf dem neuesten Stand.');
  } else if (command === 'seed') {
    await migrate(db, join(root, 'db', 'migrations'));
    for (const f of readdirSync(join(root, 'db', 'seed')).filter((x) => x.endsWith('.sql')).sort()) {
      console.log(`Beispieldaten ${f} …`);
      await db.exec(readFileSync(join(root, 'db', 'seed', f), 'utf8'));
    }
    console.log('Fertig.');
  } else if (command === 'login-link') {
    const email = normalizeEmail(arg ?? '');
    if (!email) throw new Error('Bitte E-Mail-Adresse angeben:  npm run login-link -- name@example.de');
    const token = newToken();
    await db.run(
      `insert into login_tokens (token_hash, email, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
      [hashToken(token), email, LOGIN_TOKEN_MINUTES],
    );
    console.log(`Anmelde-Link für ${email} (gilt ${LOGIN_TOKEN_MINUTES} Minuten, nur einmal):\n${config.appUrl}/anmelden/bestaetigen?token=${token}`);
  } else {
    console.log('Befehle: migrate | seed | login-link <email>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`Fehler: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
