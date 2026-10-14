// Datenbank-Schnittstelle der App. Alles andere im Server benutzt nur diese Funktionen.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Connection, parseDatabaseUrl, PgError, Pool, type PoolOptions } from './pg.ts';

export { PgError };

export interface Queryable {
  /** Alle Zeilen einer Abfrage. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Erste Zeile oder null. */
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Befehl ausführen, Anzahl betroffener Zeilen zurück. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** Mehrere Befehle ohne Parameter (z. B. eine Migrationsdatei). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Alles in fn läuft in einer Transaktion: entweder alles oder nichts. */
  tx<R>(fn: (q: Queryable) => Promise<R>): Promise<R>;
  end(): Promise<void>;
}

function wrap(conn: Connection): Queryable {
  return {
    query: async (sql, params) => (await conn.query(sql, params)).rows as never,
    one: async (sql, params) => ((await conn.query(sql, params)).rows[0] ?? null) as never,
    run: async (sql, params) => (await conn.query(sql, params)).rowCount,
    exec: (sql) => conn.exec(sql),
  };
}

export function createDb(databaseUrl: string, options: PoolOptions & { sslCa?: string } = {}): Db {
  const config = parseDatabaseUrl(databaseUrl);
  if (options.sslCa) config.sslCa = options.sslCa;
  const pool = new Pool(config, options);

  async function withConnection<R>(fn: (c: Connection) => Promise<R>): Promise<R> {
    const c = await pool.acquire();
    try {
      return await fn(c);
    } finally {
      pool.release(c);
    }
  }

  return {
    query: (sql, params) => withConnection((c) => wrap(c).query(sql, params)),
    one: (sql, params) => withConnection((c) => wrap(c).one(sql, params)),
    run: (sql, params) => withConnection((c) => wrap(c).run(sql, params)),
    exec: (sql) => withConnection((c) => c.exec(sql)),
    tx: (fn) =>
      withConnection(async (c) => {
        await c.query('begin');
        try {
          const result = await fn(wrap(c));
          await c.query('commit');
          return result;
        } catch (e) {
          if (!c.closed) await c.query('rollback').catch(() => c.close());
          throw e;
        }
      }),
    end: () => pool.end(),
  };
}

/**
 * Spielt alle noch fehlenden Dateien aus db/migrations der Reihe nach ein.
 * Jede Datei läuft in einer eigenen Transaktion; bereits eingespielte werden übersprungen.
 */
export async function migrate(db: Db, dir: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done: string[] = [];
  await db.tx(async (q) => {
    await q.query('select pg_advisory_xact_lock(727274001)'); // nur eine Instanz migriert gleichzeitig
    await q.exec(`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = new Set((await q.query<{ name: string }>('select name from schema_migrations')).map((r) => r.name));
    for (const f of files) {
      if (applied.has(f)) continue;
      log(`Migration ${f} …`);
      await q.exec(readFileSync(join(dir, f), 'utf8'));
      await q.run('insert into schema_migrations (name) values ($1)', [f]);
      done.push(f);
    }
  });
  return done;
}
