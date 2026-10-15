// Welche Version läuft gerade, und wann hat der Pi zuletzt nach Updates geschaut?
// Die Version kommt aus package.json und dem Git-Stand des Programmordners (Kurzform der Commit-Nummer + Datum).
// Den Zeitpunkt der letzten Prüfung schreibt "tippspiel update --auto" (alle 15 Minuten) in die Datei .update-check.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface BuildInfo {
  version: string;
  commit: string | null;
  committedAt: Date | null;
  /** Wann der Programmordner zuletzt auf eine neue Version gesetzt wurde (Update), sonst Startzeit der App */
  updatedAt: Date;
}

const started = new Date();

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
    let updatedAt = started;
    try {
      // Das Protokoll von HEAD: der letzte Eintrag ist das letzte Update (git reset auf die neue Version)
      const t = execFileSync('git', ['-C', root, 'log', '-g', '-1', '--format=%ct', 'HEAD'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (/^\d+$/.test(t)) updatedAt = new Date(Number(t) * 1000);
    } catch {
      // ohne Protokoll gilt die Startzeit
    }
    return { version, commit: commit || null, committedAt: ts ? new Date(Number(ts) * 1000) : null, updatedAt };
  } catch {
    return { version, commit: null, committedAt: null, updatedAt: started };
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
