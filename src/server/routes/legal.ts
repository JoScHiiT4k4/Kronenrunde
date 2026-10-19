// Rechtliche Pflichtseiten (Impressum, Datenschutz) als Vorlagen. Die Angaben pflegt der Administrator unter /admin/rechtliches.
// Hinweis: Das sind Textvorlagen und keine Rechtsberatung – vor der Veröffentlichung prüfen (lassen).

import type { Ctx } from '../app.ts';
import { cleanName } from './common.ts';
import { HttpError, htmlResponse, redirect, type Res, type Router } from '../http.ts';
import { type Html, html, nothing } from '../html.ts';
import { layout } from '../views/layout.ts';
import { loginRedirect } from './common.ts';

export const LEGAL_FIELDS = [
  { key: 'name', label: 'Vor- und Nachname', hint: 'Verantwortliche Person (bei Privatpersonen der volle Name)', max: 100 },
  { key: 'street', label: 'Straße und Hausnummer', hint: '', max: 100 },
  { key: 'city', label: 'PLZ und Ort', hint: '', max: 100 },
  { key: 'country', label: 'Land', hint: 'z. B. Deutschland', max: 60 },
  { key: 'email', label: 'Kontakt-E-Mail', hint: 'Muss erreichbar sein und im Impressum stehen', max: 254 },
  { key: 'phone', label: 'Telefon (optional)', hint: 'Nur wenn du es angeben willst', max: 40 },
  { key: 'hosting', label: 'Hosting', hint: 'z. B. „Eigener Server (Raspberry Pi) zu Hause in Deutschland“', max: 200 },
] as const;
export type LegalKey = (typeof LEGAL_FIELDS)[number]['key'];

export async function loadLegal(ctx: Ctx): Promise<Record<LegalKey, string>> {
  const rows = await ctx.deps.db.query<{ key: string; value: string }>(`select key, value from app_settings where key like 'legal\\_%'`);
  const out = Object.fromEntries(LEGAL_FIELDS.map((f) => [f.key, ''])) as Record<LegalKey, string>;
  for (const r of rows) {
    const k = r.key.slice(6) as LegalKey;
    if (k in out) out[k] = r.value;
  }
  return out;
}

/** Fehlende Angaben sichtbar als Platzhalter, damit nichts Falsches veröffentlicht wird. */
const val = (v: string, what: string): Html => (v ? html`${v}` : html`<mark class="placeholder">[${what} fehlt noch]</mark>`);

function page(ctx: Ctx, title: string, body: Html): Res {
  return htmlResponse(layout(ctx, { title, body }));
}

async function impressum(ctx: Ctx): Promise<Res> {
  const l = await loadLegal(ctx);
  const body = html`<section class="panel narrow legal">
  <h1>Impressum</h1>
  <h2>Angaben gemäß § 5 DDG</h2>
  <p>${val(l.name, 'Name')}<br>${val(l.street, 'Straße')}<br>${val(l.city, 'PLZ und Ort')}<br>${val(l.country, 'Land')}</p>
  <h2>Kontakt</h2>
  <p>E-Mail: ${val(l.email, 'E-Mail')}${l.phone ? html`<br>Telefon: ${l.phone}` : nothing}</p>
  <h2>Verantwortlich für den Inhalt</h2>
  <p>${val(l.name, 'Name')} (Anschrift wie oben)</p>
  <h2>Hinweis</h2>
  <p>${ctx.deps.config.appName} ist ein nicht-kommerzielles Fan-Projekt und wird von Riot Games weder unterstützt noch gesponsert. League of Legends ist eine Marke von Riot Games, Inc.</p>
</section>`;
  return page(ctx, 'Impressum', body);
}

async function datenschutz(ctx: Ctx): Promise<Res> {
  const l = await loadLegal(ctx);
  const app = ctx.deps.config.appName;
  const body = html`<section class="panel narrow legal">
  <h1>Datenschutzerklärung</h1>
  <h2>1. Verantwortlicher</h2>
  <p>${val(l.name, 'Name')}, ${val(l.street, 'Straße')}, ${val(l.city, 'PLZ und Ort')}, ${val(l.country, 'Land')}<br>E-Mail: ${val(l.email, 'E-Mail')}</p>

  <h2>2. Welche Daten wir verarbeiten und warum</h2>
  <p><strong>Konto:</strong> E-Mail-Adresse, Anzeigename und ein verschlüsselt gespeichertes Passwort (Hash). Das brauchen wir, damit du dich anmelden und in Tipprunden mitspielen kannst (Art. 6 Abs. 1 lit. b DSGVO).</p>
  <p><strong>Spieldaten:</strong> deine Tipps, Antworten auf Sonderfragen, Mitgliedschaften in Tipprunden und die daraus berechneten Punkte. Tipps der anderen Mitglieder einer Tipprunde sind für diese sichtbar, sobald das jeweilige Spiel begonnen hat; dein Anzeigename erscheint in der Rangliste deiner Tipprunden.</p>
  <p><strong>Profilbild (optional):</strong> ein selbst hochgeladenes Bild, das in der Rangliste angezeigt wird. Du kannst es jederzeit ändern oder löschen.</p>
  <p><strong>E-Mails:</strong> Wir verschicken E-Mails nur, wenn du sie auslöst (z. B. Passwort festlegen, E-Mail-Adresse bestätigen, Vorschlag für eine Sonderfrage).</p>
  <p><strong>Server-Protokolle:</strong> Beim Aufruf der Seite können technisch notwendige Daten (IP-Adresse, Zeitpunkt, aufgerufene Seite) kurzzeitig im Protokoll des Servers stehen. Sie dienen dem sicheren Betrieb (Art. 6 Abs. 1 lit. f DSGVO).</p>

  <h2>3. Cookies und lokaler Speicher</h2>
  <p>Wir setzen ein technisch notwendiges Sitzungs-Cookie, damit du angemeldet bleibst. Zusätzlich merkt sich dein Browser lokal, ob du den Hinweis „Zum Startbildschirm hinzufügen“ schon beantwortet hast und ob die App auf dem Gerät installiert ist. Es gibt kein Tracking und keine Werbe-Cookies.</p>

  <h2>4. Hosting</h2>
  <p>${val(l.hosting, 'Hosting-Angabe')}</p>

  <h2>5. Externe Links</h2>
  <p>Die Links zu Twitch und YouTube führen auf fremde Seiten. Beim Anklicken gelten dort die Datenschutzbestimmungen des jeweiligen Anbieters. Es werden keine Inhalte dieser Dienste in ${app} eingebunden.</p>

  <h2>6. Speicherdauer und Löschung</h2>
  <p>Deine Daten bleiben gespeichert, solange dein Konto besteht. Unter „Dein Konto“ kannst du es jederzeit mit allen Tipps und Antworten löschen.</p>

  <h2>7. Deine Rechte</h2>
  <p>Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch. Schreib uns dazu an die oben genannte E-Mail-Adresse. Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde beschweren.</p>

  <p class="muted">Stand: ${ctx.now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: ctx.deps.config.timeZone })}</p>
</section>`;
  return page(ctx, 'Datenschutz', body);
}

/** Häufige Fragen: feste Antworten zur Bedienung, für alle sichtbar (auch ohne Anmeldung). */
function faq(ctx: Ctx): Res {
  const app = ctx.deps.config.appName;
  const items: [string, Html][] = [
    ['Was ist ' + app + '?', html`Ein kostenloses Tippspiel für E-Sport-Turniere, zuerst League of Legends. Du tippst die Spiele eines Turniers und sammelst Punkte in einer Tipprunde mit deinen Leuten.`],
    ['Wie komme ich in eine Tipprunde?', html`Über den Einladungslink, den dir die Spielleitung schickt. Er gilt bis zum Start des ersten Spiels des Turniers. Du kannst in mehreren Tipprunden mitspielen und oben zwischen ihnen wechseln.`],
    ['Wie tippe ich?', html`Im Reiter „Tippen“ wählst du bei jedem Spiel den Sieger, bei Bo3 und Bo5 auch das Ergebnis (z. B. 2:1), und speicherst unten. Bis zum Tippschluss kannst du deinen Tipp beliebig oft ändern.`],
    ['Wann ist Tippschluss?', html`Das legt die Spielleitung fest. Meist schließt jedes Spiel einzeln zum Anstoß – oder schon früher, sobald das Spiel davor vorbei ist, weil Spiele oft früher beginnen als angesetzt. Über jedem Spieltag steht, was gilt.`],
    ['Wie werden Punkte vergeben?', html`Für den richtigen Sieger gibt es Punkte, für das exakte Ergebnis Extrapunkte; wie viele, stellt die Spielleitung ein. Bei Gleichstand in der Rangliste entscheidet die Zahl der exakten Ergebnisse.`],
    ['Was sind Sonderfragen?', html`Zusatzfragen zum ganzen Turnier, etwa „Wer wird Weltmeister?“. Sie lassen sich bis zum Start des ersten Spiels beantworten; die Schreibweise der Antwort ist egal.`],
    ['Ab wann sehe ich die Tipps der anderen?', html`Ab dem Tippschluss eines Spiels, im Reiter „Alle Tipps“. Vorher sieht niemand deinen Tipp, auch die Spielleitung nicht.`],
    ['Wo sehe ich die Spiele live?', html`Läuft ein Spiel, steht oben „Live“ und das „VS“ des Spiels leuchtet grün. Ein Klick darauf führt wahlweise zu Twitch oder YouTube. Die Links stehen auch unten in der Fußzeile.`],
    ['Kann ich ' + app + ' als App nutzen?', html`Ja. Unter „Mein Konto → App & Kalender“ steht, wie du die Seite auf den Startbildschirm oder den Desktop legst. Dort gibt es auch ein Kalender-Abo mit allen Spielen.`],
    ['Bekomme ich Erinnerungen?', html`Wenn du möchtest: Unter „Mein Konto → Benachrichtigungen“ stellst du Erinnerungen per E-Mail oder Push ein, falls dir vor dem Tippschluss noch Tipps fehlen.`],
    ['Wie schütze ich mein Konto?', html`Mit einem eigenen Passwort und freiwillig mit Zwei-Faktor (Authenticator-App) oder einem Passkey – beides unter „Mein Konto → Konto“.`],
    ['Ich sehe Ergebnisse nicht – warum?', html`Der Spoilerschutz verdeckt Ergebnisse, bis du darauf tippst. Du kannst ihn unter „Mein Konto → Einstellungen“ abschalten.`],
    ['Kann ich mein Konto löschen?', html`Jederzeit unter „Mein Konto → Konto“. Dabei werden alle deine Daten gelöscht, auch Tipps und Antworten.`],
    ['Gehört ' + app + ' zu Riot Games?', html`Nein. ${app} ist ein Fan-Projekt und wird von Riot Games weder unterstützt noch gesponsert.`],
  ];
  const body = html`<section class="panel narrow legal faq">
  <h1>Häufige Fragen</h1>
  ${items.map(([q, a]) => html`<details class="faq-item"><summary>${q}</summary><p>${a}</p></details>`)}
</section>`;
  return page(ctx, 'FAQ', body);
}

export function registerLegalRoutes(router: Router<Ctx>) {
  router.get('/impressum', impressum);
  router.get('/datenschutz', datenschutz);
  router.get('/faq', async (ctx) => faq(ctx));
  const guard = (ctx: Ctx): Res | null => {
    if (!ctx.user) return loginRedirect(ctx);
    if (!ctx.isAdmin) throw new HttpError(404, 'Diese Seite gibt es nicht.');
    return null;
  };
  router.get('/admin/rechtliches', async (ctx) => guard(ctx) ?? redirect('/admin?bereich=impressum'));
  router.post('/admin/rechtliches', async (ctx) => {
    const denied = guard(ctx);
    if (denied) return denied;
    await ctx.deps.db.tx(async (q) => {
      // Nur Felder speichern, die im Formular vorkommen (Impressum und Datenschutz haben getrennte Formulare)
      for (const f of LEGAL_FIELDS.filter((x) => ctx.form.has(x.key))) {
        const v = cleanName(ctx.form.get(f.key), f.max) ?? '';
        await q.run(
          `insert into app_settings (key, value) values ($1, $2)
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [`legal_${f.key}`, v],
        );
      }
    });
    const area = ctx.form.get('bereich') === 'datenschutz' ? 'datenschutz' : 'impressum';
    return redirect(`/admin?bereich=${area}&hinweis=gespeichert`);
  });
}
