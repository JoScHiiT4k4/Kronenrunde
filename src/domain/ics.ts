// Kalender-Export (.ics, RFC 5545): Spielplan einer Tipprunde zum Abonnieren/Importieren in Google/Apple Kalender & Co.

export interface IcsMatch {
  id: string;
  teamA: string;
  teamB: string;
  bestOf: 1 | 3 | 5;
  scheduledAt: Date;
  /** Phase/Stage, z. B. "Viertelfinale" – leer bei einfachen Turnieren */
  stage: string | null;
  tournament: string;
}

const PAD2 = (n: number) => String(n).padStart(2, '0');

/** "20261015T193000Z" – UTC, Basisformat nach RFC 5545 */
function stamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${PAD2(d.getUTCMonth() + 1)}${PAD2(d.getUTCDate())}` +
    `T${PAD2(d.getUTCHours())}${PAD2(d.getUTCMinutes())}${PAD2(d.getUTCSeconds())}Z`
  );
}

/** Offizielle LoL-Esports-Streams, stehen in den Notizen jedes Termins. */
export const STREAM_LINKS = { youtube: 'https://www.youtube.com/@lolesports', twitch: 'https://www.twitch.tv/riotgames' };

/** Ungefähre Dauer je nach Spielmodus (für das Ende des Termins; die tatsächliche Dauer variiert). */
function durationMinutes(bestOf: 1 | 3 | 5): number {
  return bestOf === 1 ? 45 : bestOf === 3 ? 90 : 150;
}

/** TEXT-Werte nach RFC 5545 maskieren: Backslash, Semikolon, Komma, Zeilenumbrüche. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\n|\r/g, '\\n');
}

/** Zeilen länger als 75 Oktette falten (vorgeschrieben von RFC 5545, als Folge-Zeile mit einem Leerzeichen vorn). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Nicht mitten in einem Mehrbyte-Zeichen schneiden (Folgebytes haben die oberen beiden Bits 10)
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // Folgezeilen beginnen mit einem Leerzeichen, das zählt mit
  }
  return parts.join('\r\n ');
}

function line(name: string, value: string): string {
  return fold(`${name}:${value}`);
}

/** Baut eine komplette .ics-Datei mit je einem Termin pro Spiel (ohne Teams/Termin werden ausgelassen). */
export function buildIcs(o: { calendarName: string; matches: IcsMatch[]; matchUrl: (id: string) => string; now: Date }): string {
  const now = stamp(o.now);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kronenrunde//Spielplan//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    line('X-WR-CALNAME', escapeText(o.calendarName)),
  ];
  for (const m of o.matches) {
    const end = new Date(m.scheduledAt.getTime() + durationMinutes(m.bestOf) * 60_000);
    const summary = `${m.teamA} vs ${m.teamB} (Bo${m.bestOf})`;
    const desc = [
      [m.tournament, m.stage].filter(Boolean).join(' · '),
      '',
      `YouTube: ${STREAM_LINKS.youtube}`,
      `Twitch: ${STREAM_LINKS.twitch}`,
    ].join('\n');
    lines.push(
      'BEGIN:VEVENT',
      line('UID', `${m.id}@kronenrunde`),
      line('DTSTAMP', now),
      line('DTSTART', stamp(m.scheduledAt)),
      line('DTEND', stamp(end)),
      line('SUMMARY', escapeText(summary)),
      line('DESCRIPTION', escapeText(desc)),
      line('URL', o.matchUrl(m.id)),
      // Erinnerung 1 Stunde vor Spielbeginn
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      line('DESCRIPTION', escapeText(summary)),
      'TRIGGER:-PT1H',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
