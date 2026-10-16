// Welche Version läuft gerade, und wann hat der Pi zuletzt nach Updates geschaut?
// Die Version setzt sich zusammen aus Hauptversion.Nebenversion (package.json) und der Anzahl der Commits im Programmordner
// (zählt von selbst hoch, kein Hochzählen pro Pull Request nötig) – dazu Kurzform der Commit-Nummer und Datum.
// Den Zeitpunkt der letzten Prüfung schreibt "tippspiel update --auto" (täglich 08:00 und nach jedem Webhook) in die Datei .update-check,
// den der letzten Installation deploy/install.sh in die Datei .update-installed.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface BuildInfo {
  version: string;
  commit: string | null;
  committedAt: Date | null;
}

/** "0.26.0" + Commit-Anzahl 134 → "0.26.134"; ohne Git-Verlauf bleibt die Version aus package.json. */
export function composeVersion(base: string, commits: number | null): string {
  const m = /^(\d+)\.(\d+)\./.exec(base);
  return m && commits && commits > 0 ? `${m[1]}.${m[2]}.${commits}` : base;
}

function withCommitCount(base: string): string {
  try {
    const n = Number(execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return composeVersion(base, Number.isFinite(n) ? n : null);
  } catch {
    return base;
  }
}

function load(): BuildInfo {
  let version = '?';
  try {
    version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
  } catch {
    // ohne package.json bleibt "?"
  }
  try {
    const out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h %ct'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [commit, ts] = out.split(' ');
    return { version: withCommitCount(version), commit: commit || null, committedAt: ts ? new Date(Number(ts) * 1000) : null };
  } catch {
    return { version, commit: null, committedAt: null };
  }
}

let cached: BuildInfo | undefined;
/** Wird beim ersten Aufruf gelesen – ein Update startet die App ohnehin neu. */
export function buildInfo(): BuildInfo {
  return (cached ??= load());
}

/** Zeitpunkt der letzten Update-Prüfung des Pi (Änderungszeit der Datei .update-check) oder null. */
export function lastUpdateCheck(): Date | null {
  try {
    return statSync(join(root, '.update-check')).mtime;
  } catch {
    return null;
  }
}

/** Zeitpunkt, zu dem zuletzt eine Version installiert wurde (Änderungszeit der Datei .update-installed) oder null. */
export function lastUpdateInstalled(): Date | null {
  try {
    return statSync(join(root, '.update-installed')).mtime;
  } catch {
    return null;
  }
}
