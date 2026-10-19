// Welche Version läuft gerade, und wann hat der Pi zuletzt nach Updates geschaut?
// Die Version (Haupt.Neben.Fix) beginnt beim Stand aus package.json und zählt von selbst hoch: jeder Commit seitdem mit
// der Zeile "Version: Feature" erhöht die Nebenversion (Fix wieder 0), jeder mit "Version: Fix" die dritte Zahl.
// So muss kein Pull Request package.json anfassen (keine Merge-Konflikte). Dazu Kurzform der Commit-Nummer und Datum.
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

export type Change = 'feature' | 'fix';

/** "0.27.0" + [fix, feature, fix] → "0.28.1"; ohne Git-Verlauf bleibt die Version aus package.json. */
export function composeVersion(base: string, changes: Change[] | null): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base);
  if (!m || !changes) return base;
  let minor = Number(m[2]);
  let patch = Number(m[3]);
  for (const c of changes) {
    if (c === 'feature') {
      minor++;
      patch = 0;
    } else {
      patch++;
    }
  }
  return `${m[1]}.${minor}.${patch}`;
}

/** Werte der Zeilen "Version: …" (älteste zuerst) → Art der Änderung; Unbekanntes zählt nicht. */
export function parseChanges(trailers: string): Change[] {
  return trailers
    .split(/[\n\x1e]/)
    .map((v) => v.trim().toLowerCase())
    .flatMap((v): Change[] => (v === 'feature' ? ['feature'] : v === 'fix' ? ['fix'] : []));
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function withChanges(base: string): string {
  try {
    // Ab dem Commit, der die Version in package.json zuletzt gesetzt hat (er selbst zählt mit)
    const since = git(['log', '-1', '--format=%H', '-G', '"version": "', '--', 'package.json']);
    if (!since) return base;
    const trailers = git(['log', '--reverse', '--format=%(trailers:key=Version,valueonly)%x1e', 'HEAD', '--not', `${since}^@`]);
    return composeVersion(base, parseChanges(trailers));
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
    return { version: withChanges(version), commit: commit || null, committedAt: ts ? new Date(Number(ts) * 1000) : null };
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
