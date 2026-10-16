// Auslastung des Servers (Raspberry Pi) für den Administrator-Bereich: Speicherplatz, Arbeitsspeicher, Prozessor, Temperatur.
// Gelesen wird aus /proc und /sys (Linux); fehlt etwas, bleibt der Wert leer.

import { readdirSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

export interface Usage {
  total: number;
  used: number;
}

export interface SystemInfo {
  disk: Usage | null;
  memory: Usage | null;
  swap: Usage | null;
  /** Last der letzten 1 / 5 / 15 Minuten */
  load: [number, number, number] | null;
  cores: number;
  /** Grad Celsius */
  temperature: number | null;
  uptimeSeconds: number | null;
  backupBytes: number | null;
  backupCount: number;
  /** Zeitpunkt der neuesten Sicherung */
  backupNewest: Date | null;
  /** Letzte Kopie auf die MyCloud; null, solange keine eingerichtet ist */
  nas: NasStatus | null;
}

export interface NasStatus {
  ok: boolean;
  at: Date;
  message: string;
}

export type Level = 'ok' | 'warm' | 'hot';

/** Schwellwerte: ab "warm" gelb, ab "hot" rot. Gewählt für einen Raspberry Pi mit SD-Karte. */
export const LIMITS = {
  /** Speicherplatz in %: bei voller Karte stehen Datenbank und Sicherungen still */
  disk: { warm: 70, hot: 85 },
  /** Arbeitsspeicher in % (verfügbarer Speicher zählt als frei) */
  memory: { warm: 75, hot: 90 },
  /** Auslagerung in %: der Pi lagert auf die SD-Karte aus, das bremst und verschleißt sie */
  swap: { warm: 30, hot: 60 },
  /** Prozessor-Last in % aller Kerne (1 Minute) */
  cpu: { warm: 70, hot: 100 },
  /** Grad Celsius: ab 80 °C drosselt der Pi sich selbst */
  temperature: { warm: 65, hot: 75 },
  /** Sicherung älter als (Stunden): nächtlich gesichert, ein Tag Verspätung ist noch ok */
  backupAgeHours: { warm: 30, hot: 50 },
} as const;

export function levelOf(value: number, limit: { warm: number; hot: number }): Level {
  return value >= limit.hot ? 'hot' : value >= limit.warm ? 'warm' : 'ok';
}

/** Rot, wenn es keine Sicherung gibt oder die neueste zu alt ist. */
export function backupLevel(count: number, newest: Date | null, now: Date): Level {
  if (count === 0 || !newest) return 'hot';
  return levelOf((now.getTime() - newest.getTime()) / 3_600_000, LIMITS.backupAgeHours);
}

export interface BackupFile {
  name: string;
  bytes: number;
  at: Date;
  /** Automatisch vor einem Update angelegt */
  beforeUpdate: boolean;
}

/** Vorhandene Sicherungen auf dem Pi, die neueste zuerst. */
export function readBackups(dir = '/var/backups/lol-tippspiel'): BackupFile[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith('tippspiel-') && f.endsWith('.dump'))
      .map((f) => {
        const st = statSync(join(dir, f));
        return { name: f, bytes: st.size, at: new Date(st.mtimeMs), beforeUpdate: f.includes('-vor-') };
      })
      .sort((a, b) => b.at.getTime() - a.at.getTime());
  } catch {
    return [];
  }
}

/** Statusdatei des Servers (`ok|fehler`, Zeitpunkt, Meldung – durch Tabulator getrennt), siehe deploy/tippspiel. */
export function parseNasStatus(text: string | null): NasStatus | null {
  if (!text) return null;
  const [state, time, ...rest] = text.trim().split('\t');
  const at = new Date(time ?? '');
  if ((state !== 'ok' && state !== 'fehler') || Number.isNaN(at.getTime())) return null;
  return { ok: state === 'ok', at, message: rest.join(' ') };
}

/** Rot, wenn die letzte Kopie auf die MyCloud fehlschlug oder zu lange her ist; sonst wie bei den Sicherungen. */
export function nasLevel(s: NasStatus, now: Date): Level {
  if (!s.ok) return 'hot';
  return levelOf((now.getTime() - s.at.getTime()) / 3_600_000, LIMITS.backupAgeHours);
}

/** Rot, wenn der freie Platz nicht mehr für drei Kopien der Datenbank reicht (Sicherungen, Wartung), gelb unter sechs. */
export function databaseLevel(dbBytes: number, freeBytes: number | null): Level {
  if (freeBytes === null || dbBytes <= 0) return 'ok';
  return freeBytes < dbBytes * 3 ? 'hot' : freeBytes < dbBytes * 6 ? 'warm' : 'ok';
}

/** /proc/meminfo → Arbeitsspeicher und Auslagerung in Byte ("verfügbar" statt "frei": Cache zählt nicht als belegt). */
export function parseMeminfo(text: string): { memory: Usage | null; swap: Usage | null } {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable') ?? kb('MemFree');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  return {
    memory: total !== null && available !== null ? { total, used: Math.max(0, total - available) } : null,
    swap: swapTotal && swapFree !== null ? { total: swapTotal, used: Math.max(0, swapTotal - swapFree) } : null,
  };
}

export function parseLoadavg(text: string): [number, number, number] | null {
  const p = text.trim().split(/\s+/).slice(0, 3).map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
}

/** Prozent (0–100) belegt */
export function percent(u: Usage | null): number {
  return u && u.total > 0 ? Math.min(100, Math.max(0, Math.round((u.used / u.total) * 100))) : 0;
}

/** 1,4 GB · 230 MB */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${units[i]}`;
}

/** 3 Tage 4 Std. · 5 Std. 12 Min. */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} ${d === 1 ? 'Tag' : 'Tage'} ${h} Std.`;
  return h > 0 ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function backupSize(dir: string): { bytes: number | null; count: number; newest: Date | null } {
  try {
    const stats = readdirSync(dir).filter((f) => f.endsWith('.dump')).map((f) => statSync(join(dir, f)));
    const newest = stats.reduce((max, st) => Math.max(max, st.mtimeMs), 0);
    return { bytes: stats.reduce((sum, st) => sum + st.size, 0), count: stats.length, newest: newest ? new Date(newest) : null };
  } catch {
    return { bytes: null, count: 0, newest: null };
  }
}

export function readSystemInfo(backupDir = '/var/backups/lol-tippspiel'): SystemInfo {
  let disk: Usage | null = null;
  try {
    const s = statfsSync('/');
    disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize };
  } catch {
    // ohne Angabe
  }
  const mem = read('/proc/meminfo');
  const parsed = mem ? parseMeminfo(mem) : { memory: null, swap: null };
  const loadText = read('/proc/loadavg');
  const temp = read('/sys/class/thermal/thermal_zone0/temp');
  const up = read('/proc/uptime');
  const b = backupSize(backupDir);
  return {
    disk,
    memory: parsed.memory,
    swap: parsed.swap,
    load: loadText ? parseLoadavg(loadText) : null,
    cores: Math.max(1, cpus().length),
    temperature: temp && Number.isFinite(Number(temp)) ? Number(temp) / 1000 : null,
    uptimeSeconds: up ? Number(up.split(' ')[0]) : null,
    backupBytes: b.bytes,
    backupCount: b.count,
    backupNewest: b.newest,
    nas: parseNasStatus(read(join(backupDir, '.nas-status'))),
  };
}
