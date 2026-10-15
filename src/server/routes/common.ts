// Hilfsfunktionen, die viele Seiten brauchen.

import type { Ctx } from '../app.ts';
import { redirect, type Res } from '../http.ts';

/** Nicht angemeldet → zur Anmeldung, danach zurück hierher. */
export function loginRedirect(ctx: Ctx): Res {
  const next = ctx.method === 'GET' ? ctx.path + (ctx.query.size ? `?${ctx.query}` : '') : '/';
  return redirect(`/anmelden?weiter=${encodeURIComponent(next)}`);
}

/** Bereinigt einen Anzeigenamen; null, wenn er nicht passt. */
export function cleanName(value: string | null, max = 40): string | null {
  const name = (value ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.length >= 1 && name.length <= max ? name : null;
}

export const FIRST_NAME_HELP = 'Bitte gib deinen Vornamen an – nur Buchstaben, ohne Leerzeichen und Zahlen (ein Bindestrich ist erlaubt, z. B. Anna-Lena).';

export const FIRST_NAME_PATTERN = '\\p{L}+(-\\p{L}+)*';

/** Vorname: nur Buchstaben, dazwischen einzelne Bindestriche; keine Leerzeichen, Zahlen oder Sonderzeichen. */
export function cleanFirstName(value: string | null): string | null {
  const name = (value ?? '').trim();
  return name.length >= 1 && name.length <= 40 && /^\p{L}+(?:-\p{L}+)*$/u.test(name) ? name : null;
}

export function intField(value: string | null, min: number, max: number): number | null {
  if (value === null || !/^-?\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string | null | undefined): value is string {
  return !!value && UUID_RE.test(value);
}

/** Wandelt einen Namen in einen Adress-Teil: "Die Rift-Runde 2026" → "die-rift-runde-2026" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}
