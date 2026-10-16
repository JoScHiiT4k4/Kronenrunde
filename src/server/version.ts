// Welche Version läuft gerade, und wann hat der Pi zuletzt nach Updates geschaut?
// Die Version kommt aus package.json und dem Git-Stand des Programmordners (Kurzform der Commit-Nummer + Datum).
// Den Zeitpunkt der letzten Prüfung schreibt "tippspiel update --auto" (alle 15 Minuten) in die Datei .update-check,
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
    return { version, commit: commit || null, committedAt: ts ? new Date(Number(ts) * 1000) : null };
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
