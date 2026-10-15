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

function backupSize(dir: string): { bytes: number | null; count: number } {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.dump'));
    return { bytes: files.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0), count: files.length };
  } catch {
    return { bytes: null, count: 0 };
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
  };
}
