// Startet den Server:  npm start
// Einstellungen kommen aus Umgebungsvariablen oder der Datei .env (Vorlage: .env.example).

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyncSchedule } from './abgleich.ts';
import { startNotifySchedule } from './benachrichtigung.ts';
import { startChatCleanup } from './routes/chat.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb, migrate } from './db/index.ts';
import { createMailer } from './mail.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const config = loadConfig();
const db = createDb(config.databaseUrl, { max: Number(process.env.DATABASE_POOL_SIZE ?? 5) });

if (config.autoMigrate) {
  const applied = await migrate(db, join(root, 'db', 'migrations'), (m) => console.log(m));
  if (applied.length) console.log(`Datenbank aktualisiert: ${applied.join(', ')}`);
}

const mailer = createMailer(config);
const app = createApp({ db, config, mailer, publicDir: join(root, 'public') });
const server = createServer(app.listener);
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.listen(config.port, config.host, () => {
  console.log(`${config.appName} läuft auf ${config.appUrl} (Port ${config.port})`);
  if (config.mail.mode === 'console') console.log('Hinweis: MAIL_MODE=console – Links zum Passwort-Festlegen erscheinen hier im Protokoll statt per E-Mail.');
  if (!config.adminEmails.size) console.log('Hinweis: ADMIN_EMAILS ist leer – niemand kann Turniere und Ergebnisse pflegen.');
});

// Champions und Spielerkader regelmäßig von Riot holen
if (config.dataSync) startSyncSchedule(db, (m) => console.log(m));

// Erinnerungen an fehlende Tipps (E-Mail, Push)
startNotifySchedule(db, config, mailer, (m) => console.log(m));
startChatCleanup(db, (m) => console.log(m));

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  console.log('Server wird beendet …');
  server.close(() => db.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
