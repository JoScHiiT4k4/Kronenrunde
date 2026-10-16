// Datums- und Zeitanzeige in der Zeitzone der App (Standard: Europe/Berlin).

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = timeZone + JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('de-DE', { timeZone, ...options });
    cache.set(key, f);
  }
  return f;
}

function parts(d: Date, timeZone: string) {
  const p = fmt(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** "Do., 15.10., 20:00" */
export function formatDateTime(d: Date, timeZone: string): string {
  const day = fmt(timeZone, { weekday: 'short', day: '2-digit', month: '2-digit' }).format(d);
  const p = parts(d, timeZone);
  return `${day}, ${p.hour}:${p.minute}`;
}

/** "20:00" */
export function formatTime(d: Date, timeZone: string): string {
  const p = parts(d, timeZone);
  return `${p.hour}:${p.minute}`;
}

/** "Donnerstag, 15. Oktober" */
export function formatDayLong(d: Date, timeZone: string): string {
  return fmt(timeZone, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

/** "15.10.2026" */
export function formatDate(d: Date, timeZone: string): string {
  const p = parts(d, timeZone);
  return `${p.day}.${p.month}.${p.year}`;
}

/** Tag als Schlüssel zum Gruppieren: "2026-10-15" */
export function dayKey(d: Date, timeZone: string): string {
  const p = parts(d, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Wert für <input type="datetime-local">: "2026-10-15T20:00" */
export function toLocalInput(d: Date | null, timeZone: string): string {
  if (!d) return '';
  const p = parts(d, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Prüft die Eingabe aus <input type="datetime-local">. Umrechnung in UTC macht die Datenbank. */
export function isLocalInput(value: string): boolean {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(value);
}

/** "in 3 Std." / "in 2 Tagen" – grobe Restzeit bis zum Tippschluss. */
export function formatRemaining(until: Date, now: Date): string {
  const minutes = Math.floor((until.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return 'gleich';
  if (minutes < 60) return `in ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} Std.`;
  return `in ${Math.floor(hours / 24)} Tagen`;
}
