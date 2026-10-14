// HTML-Bausteine. Alle eingesetzten Werte werden automatisch maskiert,
// damit Eingaben von Nutzern (Namen, Antworten) nie als HTML ausgeführt werden.

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

/** html`<p>${name}</p>` – Werte werden maskiert, verschachteltes html`` bleibt unverändert. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

/** Nur für fest im Code stehendes, vertrauenswürdiges HTML. */
export function raw(value: string): Html {
  return new Html(value);
}

export const nothing = new Html('');

/** Attribut nur ausgeben, wenn die Bedingung stimmt: ${attr(selected, 'selected')} */
export function attr(condition: unknown, name: string): Html {
  return condition ? raw(` ${name}`) : nothing;
}
