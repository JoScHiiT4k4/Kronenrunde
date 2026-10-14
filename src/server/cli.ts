// Hilfsbefehle für den Betrieb:
//   npm run db:migrate                 Datenbank auf den neuesten Stand bringen
//   npm run login-link -- name@mail.de Anmelde-Link erzeugen, ohne E-Mail zu verschicken
//   npm run db:seed                    Beispieldaten (Worlds 2026) einspielen – nur zum Ausprobieren
//   npm run mail-test -- name@mail.de  Test-E-Mail verschicken (prüft die E-Mail-Einstellungen)
//   npm run daten -- worlds-2026       Turnier aus db/daten/worlds-2026.json einspielen (mehrfach ausführbar)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashToken, LOGIN_TOKEN_MINUTES, newToken, normalizeEmail } from './auth.ts';
import { loadConfig } from './config.ts';
import { describeSummary, importTournament, type TournamentData } from './daten.ts';
import { createDb, migrate } from './db/index.ts';
import { html } from './html.ts';
import { createMailer } from './mail.ts';

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
  } else if (command === 'daten') {
    const dir = join(root, 'db', 'daten');
    const available = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    if (!arg || !available.includes(arg)) {
      if (arg) {
        console.error(`Keine Daten "${arg}" gefunden.`);
        process.exitCode = 1;
      }
      console.log(`Vorhandene Daten: ${available.join(', ') || 'keine'}\nEinspielen z. B. mit:  tippspiel daten ${available[0] ?? 'name'}`);
    } else {
      await migrate(db, join(root, 'db', 'migrations'));
      const data = JSON.parse(readFileSync(join(dir, `${arg}.json`), 'utf8')) as TournamentData;
      console.log(describeSummary(await importTournament(db, data)));
    }
  } else if (command === 'login-link') {
    const email = normalizeEmail(arg ?? '');
    if (!email) throw new Error('Bitte E-Mail-Adresse angeben:  npm run login-link -- name@example.de');
    const token = newToken();
    await db.run(
      `insert into login_tokens (token_hash, email, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
      [hashToken(token), email, LOGIN_TOKEN_MINUTES],
    );
    console.log(`Anmelde-Link für ${email} (gilt ${LOGIN_TOKEN_MINUTES} Minuten, nur einmal):\n${config.appUrl}/anmelden/bestaetigen?token=${token}`);
  } else if (command === 'mail-test') {
    const email = normalizeEmail(arg ?? '');
    if (!email) throw new Error('Bitte E-Mail-Adresse angeben:  npm run mail-test -- name@example.de');
    console.log(`Verschicke Test-E-Mail an ${email} (MAIL_MODE=${config.mail.mode}) …`);
    await createMailer(config).send({
      to: email,
      subject: `Test-E-Mail von ${config.appName}`,
      text: `Hallo!\n\nDer E-Mail-Versand von ${config.appName} funktioniert.\n\n${config.appUrl}`,
      html: html`<p>Hallo!</p><p>Der E-Mail-Versand von ${config.appName} funktioniert.</p>`.value,
    });
    console.log(config.mail.mode === 'console' ? 'Fertig (nur angezeigt, MAIL_MODE=console).' : 'Verschickt. Schau in dein Postfach (notfalls auch im Spam-Ordner).');
  } else {
    console.log('Befehle: migrate | seed | daten <name> | login-link <email> | mail-test <email>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`Fehler: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
