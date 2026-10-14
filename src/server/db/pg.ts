// Schlanker PostgreSQL-Anschluss ohne Zusatzpakete (Protokoll Version 3).
//
// Unterstützt: Verbindung mit oder ohne TLS, Anmeldung per SCRAM-SHA-256
// (Standard bei Supabase und PostgreSQL 14+), MD5 und Klartext, Abfragen mit
// Parametern, Transaktionen und einen kleinen Verbindungs-Pool.
//
// Austauschbar: Die App benutzt nur die Schnittstelle `Db` aus ./index.ts.
// Soll später das verbreitete Paket `pg` verwendet werden, muss nur diese
// Datei ersetzt werden.

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full';

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: SslMode;
  /** Eigenes Stammzertifikat (PEM) für verify-full, z. B. von Supabase. */
  sslCa?: string;
  connectTimeoutMs?: number;
  applicationName?: string;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
  command: string;
}

/** Fehlermeldung der Datenbank mit allen Feldern (Code, Tabelle, Regel …). */
export class PgError extends Error {
  code: string;
  severity?: string;
  detail?: string;
  hint?: string;
  table?: string;
  column?: string;
  constraint?: string;
  where?: string;

  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'Datenbankfehler');
    this.name = 'PgError';
    this.code = fields.C ?? '';
    this.severity = fields.V ?? fields.S;
    this.detail = fields.D;
    this.hint = fields.H;
    this.table = fields.t;
    this.column = fields.c;
    this.constraint = fields.n;
    this.where = fields.W;
  }
}

/** postgres://user:passwort@host:5432/datenbank?sslmode=require */
export function parseDatabaseUrl(url: string): PgConfig {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL muss mit postgres:// beginnen');
  }
  const mode = (u.searchParams.get('sslmode') ?? '').toLowerCase();
  const host = decodeURIComponent(u.hostname).replace(/^\[|\]$/g, '') || 'localhost';
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  let ssl: SslMode;
  if (mode === '') ssl = local ? 'disable' : 'prefer';
  else if (mode === 'disable' || mode === 'allow') ssl = 'disable';
  else if (mode === 'prefer') ssl = 'prefer';
  else if (mode === 'require' || mode === 'verify-ca' || mode === 'no-verify') ssl = 'require';
  else if (mode === 'verify-full') ssl = 'verify-full';
  else throw new Error(`Unbekannter sslmode: ${mode}`);
  return {
    host,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username || 'postgres'),
    ssl,
  };
}

// ---------------------------------------------------------------------
// Nachrichten bauen
// ---------------------------------------------------------------------

function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

function cstr(s: string): Buffer {
  if (s.includes('\0')) throw new Error('Text darf kein Nullzeichen enthalten');
  return Buffer.from(s + '\0', 'utf8');
}

function message(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type, 'ascii'), int32(body.length + 4), body]);
}

/** Wert für einen Parameter in Textform. */
export function serializeParam(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Ungültiges Datum als Parameter');
    return Buffer.from(value.toISOString(), 'utf8');
  }
  if (Buffer.isBuffer(value)) return Buffer.from('\\x' + value.toString('hex'), 'utf8');
  if (Array.isArray(value)) return Buffer.from(arrayLiteral(value), 'utf8');
  switch (typeof value) {
    case 'boolean':
      return Buffer.from(value ? 't' : 'f', 'utf8');
    case 'number':
    case 'bigint':
      return Buffer.from(String(value), 'utf8');
    case 'string':
      if (value.includes('\0')) throw new Error('Text darf kein Nullzeichen enthalten');
      return Buffer.from(value, 'utf8');
    case 'object':
      return Buffer.from(JSON.stringify(value), 'utf8');
    default:
      throw new Error(`Parameter-Typ nicht unterstützt: ${typeof value}`);
  }
}

function arrayLiteral(values: unknown[]): string {
  const items = values.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return arrayLiteral(v);
    const s = v instanceof Date ? v.toISOString() : String(v);
    if (s.includes('\0')) throw new Error('Text darf kein Nullzeichen enthalten');
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  });
  return '{' + items.join(',') + '}';
}

// ---------------------------------------------------------------------
// Ergebnisse lesen (Textformat → JavaScript)
// ---------------------------------------------------------------------

/** Liest ein Postgres-Array in Textform, z. B. {a,"b c",NULL}. Nur eindimensional. */
export function parseArray(text: string): (string | null)[] {
  if (text === '{}') return [];
  if (text[0] !== '{' || text[text.length - 1] !== '}') throw new Error(`Kein Array: ${text}`);
  const out: (string | null)[] = [];
  let i = 1;
  while (i < text.length - 1) {
    if (text[i] === '"') {
      let s = '';
      i++;
      while (text[i] !== '"') {
        if (text[i] === '\\') i++;
        s += text[i++];
      }
      i++; // schließendes "
      out.push(s);
    } else {
      let j = i;
      while (text[j] !== ',' && j < text.length - 1) j++;
      const raw = text.slice(i, j);
      out.push(raw === 'NULL' ? null : raw);
      i = j;
    }
    if (text[i] === ',') i++;
  }
  return out;
}

/** Zeitstempel im ISO-Format der Datenbank, z. B. "2026-10-15 18:00:00+00" oder "…12.345678+05:30". */
export function parseTimestamp(text: string, withZone: boolean): Date {
  if (text === 'infinity') return new Date(8.64e15);
  if (text === '-infinity') return new Date(-8.64e15);
  const m = /^(\d{4,})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?([+-]\d\d(?::?\d\d)?(?::\d\d)?)?$/.exec(text);
  if (!m) throw new Error(`Zeitstempel nicht lesbar (DateStyle muss ISO sein): ${text}`);
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (withZone && zone) {
    const sign = zone[0] === '-' ? -1 : 1;
    const parts = zone.slice(1).split(':');
    const hh = Number(parts[0].slice(0, 2));
    const mm = Number(parts.length > 1 ? parts[1] : zone.slice(3, 5) || 0);
    const ss = Number(parts[2] ?? 0);
    t -= sign * ((hh * 60 + mm) * 60 + ss) * 1000;
  }
  return new Date(t);
}

type Parser = (text: string) => unknown;

const toNumber: Parser = (t) => Number(t);
const PARSERS: Record<number, Parser> = {
  16: (t) => t === 't', // bool
  20: toNumber, // int8 (Zählungen; bei Werten > 2^53 ungenau)
  21: toNumber, // int2
  23: toNumber, // int4
  26: toNumber, // oid
  700: toNumber, // float4
  701: toNumber, // float8
  114: (t) => JSON.parse(t), // json
  3802: (t) => JSON.parse(t), // jsonb
  1114: (t) => parseTimestamp(t, false), // timestamp (als UTC gelesen)
  1184: (t) => parseTimestamp(t, true), // timestamptz
  1000: (t) => parseArray(t).map((v) => (v === null ? null : v === 't')), // bool[]
  1005: (t) => parseArray(t).map((v) => (v === null ? null : Number(v))), // int2[]
  1007: (t) => parseArray(t).map((v) => (v === null ? null : Number(v))), // int4[]
  1016: (t) => parseArray(t).map((v) => (v === null ? null : Number(v))), // int8[]
  1009: parseArray, // text[]
  1015: parseArray, // varchar[]
  1014: parseArray, // bpchar[]
  2951: parseArray, // uuid[]
  1185: (t) => parseArray(t).map((v) => (v === null ? null : parseTimestamp(v, true))), // timestamptz[]
  // date (1082), numeric (1700), uuid, text, citext … bleiben Text.
};

interface Field {
  name: string;
  typeOid: number;
}

// ---------------------------------------------------------------------
// Eine Verbindung
// ---------------------------------------------------------------------

interface Pending {
  onMessage(type: string, body: Buffer): void;
  fail(err: Error): void;
}

export class Connection {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  closed = false;
  /** Status nach der letzten Abfrage: I = keine Transaktion, T = in Transaktion, E = Transaktion fehlgeschlagen. */
  txStatus = 'I';
  lastUsed = Date.now();

  private readonly config: PgConfig;

  private constructor(config: PgConfig) {
    this.config = config;
  }

  static async connect(config: PgConfig): Promise<Connection> {
    const c = new Connection(config);
    await c.open();
    return c;
  }

  private open(): Promise<void> {
    const { host, port, connectTimeoutMs = 10_000 } = this.config;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          this.closed = true;
          this.socket?.destroy();
          reject(err);
        } else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error(`Keine Verbindung zur Datenbank (${host}:${port}) – Zeitüberschreitung`)),
        connectTimeoutMs,
      );

      const raw = net.connect({ host, port });
      raw.setNoDelay(true);
      raw.once('error', (e) => finish(new Error(`Keine Verbindung zur Datenbank (${host}:${port}): ${e.message}`)));
      raw.once('connect', () => {
        if (this.config.ssl === 'disable') {
          this.attach(raw);
          this.startup().then(() => finish(), finish);
          return;
        }
        raw.write(Buffer.concat([int32(8), int32(80877103)])); // SSLRequest
        raw.once('data', (data: Buffer) => {
          const answer = String.fromCharCode(data[0]);
          if (answer === 'S') {
            const secure = tls.connect({
              socket: raw,
              servername: net.isIP(host) ? undefined : host,
              rejectUnauthorized: this.config.ssl === 'verify-full',
              ca: this.config.sslCa,
            });
            secure.once('error', (e) => finish(new Error(`TLS-Fehler bei der Datenbank: ${e.message}`)));
            secure.once('secureConnect', () => {
              this.attach(secure);
              this.startup().then(() => finish(), finish);
            });
          } else if (this.config.ssl === 'prefer') {
            this.attach(raw);
            this.startup().then(() => finish(), finish);
          } else {
            finish(new Error('Die Datenbank bietet keine verschlüsselte Verbindung (TLS) an'));
          }
        });
      });
    });
  }

  private attach(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (e) => this.terminate(new Error(`Datenbankverbindung unterbrochen: ${e.message}`)));
    socket.on('close', () => this.terminate(new Error('Datenbankverbindung geschlossen')));
  }

  private terminate(err: Error) {
    if (this.closed) return;
    this.closed = true;
    const p = this.pending;
    this.pending = null;
    p?.fail(err);
  }

  private receive(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 5) {
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) break;
      const type = String.fromCharCode(this.buffer[0]);
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      if (type === 'N' || type === 'S' || type === 'A') continue; // Hinweise, Parameter, Benachrichtigungen
      if (this.pending) this.pending.onMessage(type, body);
    }
  }

  private send(data: Buffer) {
    this.socket.write(data);
  }

  private startup(): Promise<void> {
    const { user, database, password } = this.config;
    const params = Buffer.concat([
      cstr('user'), cstr(user),
      cstr('database'), cstr(database),
      cstr('client_encoding'), cstr('UTF8'),
      cstr('application_name'), cstr(this.config.applicationName ?? 'lol-tippspiel'),
      Buffer.from([0]),
    ]);
    const packet = Buffer.concat([int32(params.length + 8), int32(196608), params]);

    return new Promise<void>((resolve, reject) => {
      let scram: ScramState | null = null;
      this.pending = {
        fail: reject,
        onMessage: (type, body) => {
          try {
            if (type === 'R') {
              const code = body.readInt32BE(0);
              if (code === 0) return; // angemeldet
              if (code === 3) {
                this.send(message('p', cstr(password)));
              } else if (code === 5) {
                const salt = body.subarray(4, 8);
                const inner = createHash('md5').update(password + user).digest('hex');
                const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
                this.send(message('p', cstr('md5' + outer)));
              } else if (code === 10) {
                const mechanisms = body.subarray(4).toString('utf8').split('\0');
                if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error('Anmeldeverfahren der Datenbank nicht unterstützt');
                scram = scramStart();
                const first = Buffer.from(scram.clientFirst, 'utf8');
                this.send(message('p', cstr('SCRAM-SHA-256'), int32(first.length), first));
              } else if (code === 11) {
                if (!scram) throw new Error('SCRAM: unerwartete Nachricht');
                const final = scramContinue(scram, body.subarray(4).toString('utf8'), password);
                this.send(message('p', Buffer.from(final, 'utf8')));
              } else if (code === 12) {
                if (!scram) throw new Error('SCRAM: unerwartete Nachricht');
                scramVerify(scram, body.subarray(4).toString('utf8'));
              } else {
                throw new Error(`Anmeldeverfahren ${code} der Datenbank nicht unterstützt`);
              }
            } else if (type === 'E') {
              throw new PgError(parseFields(body));
            } else if (type === 'Z') {
              this.txStatus = String.fromCharCode(body[0]);
              this.pending = null;
              resolve();
            }
            // 'K' (Schlüssel zum Abbrechen) wird nicht gebraucht.
          } catch (e) {
            this.pending = null;
            reject(e);
          }
        },
      };
      this.send(packet);
    });
  }

  /** Eine Abfrage mit Parametern ($1, $2 …). Mehrere gleichzeitige Aufrufe werden nacheinander ausgeführt. */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const run = () => this.extendedQuery<T>(sql, params);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Mehrere SQL-Befehle auf einmal, ohne Parameter (z. B. Migrationsdateien). */
  exec(sql: string): Promise<void> {
    const run = () => this.simpleQuery(sql);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private extendedQuery<T>(sql: string, params: unknown[]): Promise<QueryResult<T>> {
    if (this.closed) return Promise.reject(new Error('Datenbankverbindung geschlossen'));
    this.lastUsed = Date.now();
    const values = params.map(serializeParam);
    const bindParts: Buffer[] = [cstr(''), cstr(''), int16(0), int16(values.length)];
    for (const v of values) {
      if (v === null) bindParts.push(int32(-1));
      else bindParts.push(int32(v.length), v);
    }
    bindParts.push(int16(0));

    return new Promise<QueryResult<T>>((resolve, reject) => {
      let fields: Field[] = [];
      const rows: T[] = [];
      let command = '';
      let rowCount = 0;
      let error: Error | null = null;
      this.pending = {
        fail: reject,
        onMessage: (type, body) => {
          try {
            switch (type) {
              case 'T':
                fields = parseRowDescription(body);
                break;
              case 'D':
                rows.push(parseDataRow(body, fields) as T);
                break;
              case 'C': {
                command = body.subarray(0, body.length - 1).toString('utf8');
                const last = command.split(' ').pop();
                rowCount = last && /^\d+$/.test(last) ? Number(last) : 0;
                break;
              }
              case 'E':
                error = new PgError(parseFields(body));
                break;
              case 'Z':
                this.txStatus = String.fromCharCode(body[0]);
                this.pending = null;
                if (error) reject(error);
                else resolve({ rows, rowCount, command });
                break;
              // '1' ParseComplete, '2' BindComplete, 'n' NoData, 'I' EmptyQuery, 's' PortalSuspended
            }
          } catch (e) {
            error = e as Error;
          }
        },
      };
      this.send(
        Buffer.concat([
          message('P', cstr(''), cstr(sql), int16(0)),
          message('B', ...bindParts),
          message('D', Buffer.from('P', 'ascii'), cstr('')),
          message('E', cstr(''), int32(0)),
          message('S'),
        ]),
      );
    });
  }

  private simpleQuery(sql: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Datenbankverbindung geschlossen'));
    this.lastUsed = Date.now();
    return new Promise<void>((resolve, reject) => {
      let error: Error | null = null;
      this.pending = {
        fail: reject,
        onMessage: (type, body) => {
          if (type === 'E') error ??= new PgError(parseFields(body));
          else if (type === 'Z') {
            this.txStatus = String.fromCharCode(body[0]);
            this.pending = null;
            if (error) reject(error);
            else resolve();
          }
        },
      };
      this.send(message('Q', cstr(sql)));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end(message('X'));
    } catch {
      this.socket.destroy();
    }
  }
}

function parseFields(body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const key = String.fromCharCode(body[i]);
    const end = body.indexOf(0, i + 1);
    fields[key] = body.subarray(i + 1, end).toString('utf8');
    i = end + 1;
  }
  return fields;
}

function parseRowDescription(body: Buffer): Field[] {
  const count = body.readInt16BE(0);
  const fields: Field[] = [];
  let i = 2;
  for (let n = 0; n < count; n++) {
    const end = body.indexOf(0, i);
    const name = body.subarray(i, end).toString('utf8');
    i = end + 1;
    const typeOid = body.readInt32BE(i + 6);
    i += 18;
    fields.push({ name, typeOid });
  }
  return fields;
}

function parseDataRow(body: Buffer, fields: Field[]): Record<string, unknown> {
  const count = body.readInt16BE(0);
  const row: Record<string, unknown> = {};
  let i = 2;
  for (let n = 0; n < count; n++) {
    const len = body.readInt32BE(i);
    i += 4;
    const field = fields[n];
    if (len === -1) {
      row[field.name] = null;
      continue;
    }
    const text = body.subarray(i, i + len).toString('utf8');
    i += len;
    const parse = PARSERS[field.typeOid];
    row[field.name] = parse ? parse(text) : text;
  }
  return row;
}

// ---------------------------------------------------------------------
// SCRAM-SHA-256 (RFC 5802 / 7677)
// ---------------------------------------------------------------------

interface ScramState {
  nonce: string;
  clientFirstBare: string;
  clientFirst: string;
  serverSignature?: Buffer;
}

function scramStart(): ScramState {
  const nonce = randomBytes(18).toString('base64');
  const clientFirstBare = `n=*,r=${nonce}`;
  return { nonce, clientFirstBare, clientFirst: `n,,${clientFirstBare}` };
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function scramContinue(state: ScramState, serverFirst: string, password: string): string {
  const attrs = new Map(serverFirst.split(',').map((p) => [p[0], p.slice(2)] as [string, string]));
  const serverNonce = attrs.get('r') ?? '';
  const salt = Buffer.from(attrs.get('s') ?? '', 'base64');
  const iterations = Number(attrs.get('i'));
  if (!serverNonce.startsWith(state.nonce) || serverNonce.length === state.nonce.length) {
    throw new Error('SCRAM: ungültige Antwort der Datenbank');
  }
  if (!salt.length || !Number.isInteger(iterations) || iterations < 1) throw new Error('SCRAM: ungültige Antwort der Datenbank');

  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = createHash('sha256').update(clientKey).digest();
  const withoutProof = `c=biws,r=${serverNonce}`;
  const authMessage = `${state.clientFirstBare},${serverFirst},${withoutProof}`;
  const clientSignature = hmac(storedKey, authMessage);
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i] ^ clientSignature[i];
  state.serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
  return `${withoutProof},p=${proof.toString('base64')}`;
}

function scramVerify(state: ScramState, serverFinal: string) {
  const v = serverFinal.split(',').find((p) => p.startsWith('v='));
  if (!v || !state.serverSignature) throw new Error('SCRAM: Datenbank hat sich nicht ausgewiesen');
  const received = Buffer.from(v.slice(2), 'base64');
  if (received.length !== state.serverSignature.length || !timingSafeEqual(received, state.serverSignature)) {
    throw new Error('SCRAM: Signatur der Datenbank stimmt nicht');
  }
}

// ---------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------

export interface PoolOptions {
  max?: number;
  idleTimeoutMs?: number;
}

export class Pool {
  private idle: Connection[] = [];
  private all = new Set<Connection>();
  private waiting: { resolve: (c: Connection) => void; reject: (e: Error) => void }[] = [];
  private opening = 0;
  private ended = false;
  private readonly max: number;
  private readonly idleTimeoutMs: number;
  private timer: NodeJS.Timeout;

  private readonly config: PgConfig;

  constructor(config: PgConfig, options: PoolOptions = {}) {
    this.config = config;
    this.max = options.max ?? 5;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.timer = setInterval(() => this.closeIdle(), 10_000);
    this.timer.unref();
  }

  async acquire(): Promise<Connection> {
    if (this.ended) throw new Error('Datenbank-Pool ist beendet');
    while (this.idle.length) {
      const c = this.idle.pop() as Connection;
      if (!c.closed) return c;
      this.all.delete(c);
    }
    if (this.all.size + this.opening < this.max) {
      this.opening++;
      try {
        const c = await Connection.connect(this.config);
        this.all.add(c);
        return c;
      } finally {
        this.opening--;
      }
    }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  release(c: Connection) {
    if (c.closed || this.ended || c.txStatus !== 'I') {
      // Eine Verbindung mitten in einer Transaktion wird nie weitergegeben.
      if (!c.closed) c.close();
      this.all.delete(c);
      const w = this.waiting.shift();
      if (w) this.acquire().then(w.resolve, w.reject);
      return;
    }
    const w = this.waiting.shift();
    if (w) w.resolve(c);
    else this.idle.push(c);
  }

  private closeIdle() {
    const now = Date.now();
    this.idle = this.idle.filter((c) => {
      if (now - c.lastUsed > this.idleTimeoutMs || c.closed) {
        c.close();
        this.all.delete(c);
        return false;
      }
      return true;
    });
  }

  async end() {
    this.ended = true;
    clearInterval(this.timer);
    for (const w of this.waiting) w.reject(new Error('Datenbank-Pool ist beendet'));
    this.waiting = [];
    for (const c of this.all) c.close();
    this.all.clear();
    this.idle = [];
  }
}
