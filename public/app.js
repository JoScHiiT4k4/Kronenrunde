// Kleine Helfer für die Oberfläche. Alles funktioniert auch ohne JavaScript.
'use strict';

document.addEventListener('submit', (e) => {
  // Rückfrage vor endgültigen Aktionen (Formular oder auslösender Knopf mit data-confirm)
  const form = e.target;
  const button = e.submitter;
  const text = (button && button.dataset.confirm) || form.dataset.confirm;
  if (text && !window.confirm(text)) {
    e.preventDefault();
    return;
  }
  if (form.classList.contains('tip-form')) form.dataset.submitting = '1';
});

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-copy]');
  if (!button) return;
  const input = document.getElementById(button.dataset.copy);
  if (!input) return;
  const done = () => {
    const label = button.textContent;
    button.textContent = 'Kopiert';
    setTimeout(() => (button.textContent = label), 1800);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(input.value).then(done, () => {
      input.select();
    });
  } else {
    input.select();
    document.execCommand('copy');
    done();
  }
});

// ---------------------------------------------------------------------------
// Ergebnis teilen: die vom Server gelieferte SVG-Karte wird hier im Browser selbst (Canvas)
// zu einem PNG gerastert – zum Teilen über das Teilen-Menü des Geräts (z. B. Instagram) oder
// zum Herunterladen. Ohne Canvas-Unterstützung bleibt der normale Link (SVG-Download) bestehen.
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-share-card]');
  if (!link || !document.createElement('canvas').getContext) return;
  e.preventDefault();
  const label = link.textContent;
  link.textContent = 'Wird vorbereitet …';
  shareCardAsPng(link).catch(() => {
    window.location.href = link.href; // etwas schiefgelaufen: als SVG herunterladen
  }).finally(() => {
    link.textContent = label;
  });
});

async function shareCardAsPng(link) {
  const res = await fetch(link.href);
  if (!res.ok) throw new Error('Karte konnte nicht geladen werden');
  const svgText = await res.text();
  const svgUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Karte lässt sich nicht als Bild laden'));
      img.src = svgUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1080;
    canvas.height = img.naturalHeight || 1080;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG konnte nicht erzeugt werden');
    const filename = `${link.dataset.filename || 'ergebnis'}.png`;
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: document.title });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // Nutzer hat das Teilen-Menü abgebrochen
        // sonst: als Download anbieten (unten)
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

// Ungespeicherte Tipps: Knopf markieren und vor dem Verlassen der Seite warnen
const tipForm = document.querySelector('.tip-form');
if (tipForm) {
  const bar = tipForm.querySelector('.save-bar');
  tipForm.addEventListener('change', () => {
    tipForm.dataset.dirty = '1';
    if (bar) bar.classList.add('dirty');
  });
  window.addEventListener('beforeunload', (e) => {
    if (tipForm.dataset.dirty && !tipForm.dataset.submitting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ---------------------------------------------------------------------------
// App auf dem Handy: Service Worker (Hinweisseite ohne Internet; nötig, damit Android das Installieren anbietet)
// und ein Hinweis, das Tippspiel auf den Startbildschirm zu legen.
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(() => {
  const KEY = 'tippspiel-startbildschirm';
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const loggedIn = document.body.dataset.angemeldet === '1';
  const INSTALLED = 'kronenrunde-installiert';
  let deferred = null;
  let sheet = null;

  // Einmal beantwortet (Hinzufügen, Später, Verstanden): pro Gerät nie wieder fragen, solange der Browser-Speicher nicht geleert wird.
  // Über die Kontoseite lässt sich der Hinweis jederzeit selbst öffnen.
  const quiet = () => {
    try {
      return Number(localStorage.getItem(KEY)) > 0;
    } catch {
      return false;
    }
  };
  const remember = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* privates Fenster: dann eben beim nächsten Mal wieder */
    }
  };
  // Ob die App auf diesem Gerät schon installiert ist: gemerkt beim Installieren oder beim Start als App,
  // dazu (Chrome/Edge) getInstalledRelatedApps. Bietet der Browser das Installieren wieder an, ist sie es nicht mehr.
  const setInstalled = (on) => {
    try {
      if (on) localStorage.setItem(INSTALLED, '1');
      else localStorage.removeItem(INSTALLED);
    } catch {
      /* privates Fenster */
    }
  };
  const knownInstalled = async () => {
    if (standalone) return true;
    try {
      if (localStorage.getItem(INSTALLED) === '1') return true;
    } catch {
      /* privates Fenster */
    }
    try {
      return !!(navigator.getInstalledRelatedApps && (await navigator.getInstalledRelatedApps()).length);
    } catch {
      return false;
    }
  };
  if (standalone) setInstalled(true);
  const close = () => {
    if (sheet) sheet.remove();
    sheet = null;
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };

  function show(kind, force) {
    if (sheet || (standalone && kind !== 'installed') || (!force && (!loggedIn || quiet()))) return;
    sheet = el('div', 'install-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-labelledby', 'install-title');
    const head = el('div', 'install-head');
    const icon = el('img');
    const svgIcon = document.querySelector('link[rel="icon"]');
    icon.src = svgIcon ? svgIcon.href : '/static/icon.svg';
    icon.alt = '';
    icon.width = 48;
    icon.height = 48;
    const title = el('h2', null, kind === 'installed' ? 'App bereits installiert' : 'Als App speichern');
    title.id = 'install-title';
    head.append(icon, title);
    sheet.append(head);
    const actions = el('div', 'install-actions');
    const later = el('button', 'btn btn-quiet', kind === 'installed' ? 'Schließen' : kind === 'ios' ? 'Verstanden' : 'Später');
    later.type = 'button';
    later.addEventListener('click', () => {
      remember();
      close();
    });
    if (kind === 'installed') {
      sheet.append(
        el(
          'p',
          null,
          standalone
            ? 'Du nutzt die Kronenrunde gerade schon als App.'
            : 'Die Kronenrunde ist auf diesem Gerät schon als App installiert. Du startest sie über das Symbol auf dem Startbildschirm bzw. Desktop.',
        ),
      );
      const help = el('div');
      help.hidden = true;
      const steps = el('ol', 'install-steps');
      help.append(steps);
      if (isIOS) {
        steps.append(
          el('li', null, 'Halte das Kronenrunde-Symbol auf dem Home-Bildschirm gedrückt.'),
          el('li', null, 'Tippe auf „App entfernen“ bzw. „Lesezeichen löschen“ und bestätige.'),
        );
      } else if (isAndroid) {
        steps.append(
          el('li', null, 'Halte das Kronenrunde-Symbol auf dem Startbildschirm gedrückt.'),
          el('li', null, 'Tippe auf „Deinstallieren“ (oder „App-Info“ → „Deinstallieren“) und bestätige.'),
        );
      } else {
        steps.append(
          el('li', null, 'Öffne die Kronenrunde-App.'),
          el('li', null, 'Klicke oben rechts im App-Fenster auf ⋮ bzw. ⋯.'),
          el('li', null, 'Wähle „Kronenrunde deinstallieren“ und bestätige.'),
        );
        help.append(el('p', 'muted', 'Unter Windows geht es auch über das Startmenü: Rechtsklick auf Kronenrunde → „Deinstallieren“.'));
      }
      const how = el('button', 'btn', 'So deinstallierst du sie');
      how.type = 'button';
      how.addEventListener('click', () => {
        help.hidden = false;
        how.remove();
      });
      sheet.append(help);
      actions.append(later, how);
    } else if (kind === 'android') {
      sheet.append(el('p', null, 'Dann startest du das Tippspiel wie eine App direkt vom Startbildschirm oder Desktop.'));
      const add = el('button', 'btn btn-primary', 'Hinzufügen');
      add.type = 'button';
      add.addEventListener('click', async () => {
        if (!deferred) return close();
        deferred.prompt();
        const choice = await deferred.userChoice.catch(() => null);
        deferred = null;
        if (choice && choice.outcome !== 'accepted') remember();
        close();
      });
      actions.append(later, add);
    } else if (kind === 'other') {
      sheet.append(
        el('p', null, 'Öffne das Menü deines Browsers (⋮ oder ⋯) und wähle „App installieren“ bzw. „Zum Startbildschirm hinzufügen“. In Chrome und Edge steht das Symbol dafür auch rechts in der Adressleiste.'),
      );
      actions.append(later);
    } else {
      // iPhone/iPad: Apple lässt Webseiten das nicht selbst erledigen – also kurz zeigen, wie es geht
      const steps = el('ol', 'install-steps');
      steps.append(
        el('li', null, 'Tippe in Safari auf „Teilen“ (Quadrat mit Pfeil nach oben – je nach iOS unten in der Leiste oder unter „•••“).'),
        el('li', null, 'Wähle „Zum Home-Bildschirm“ und tippe auf „Hinzufügen“.'),
      );
      sheet.append(el('p', null, 'So startest du das Tippspiel wie eine App direkt vom Home-Bildschirm:'), steps);
      actions.append(later);
    }
    sheet.append(actions);
    document.body.append(sheet);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    setInstalled(false); // Browser bietet das Installieren an: Die App ist (nicht mehr) installiert
    show('android');
  });
  window.addEventListener('appinstalled', () => {
    setInstalled(true);
    remember();
    close();
  });
  if (isIOS) setTimeout(() => show('ios'), 1500);

  // Knopf unter „Mein Konto → App & Kalender“ und Link „Desktop-App“ in der Fußzeile
  const open = async () => {
    if (deferred) return show('android', true);
    if (await knownInstalled()) return show('installed', true);
    show(isIOS ? 'ios' : 'other', true);
  };
  for (const button of document.querySelectorAll('[data-install]')) {
    button.hidden = false;
    button.addEventListener('click', (e) => {
      e.preventDefault();
      open();
    });
  }
  knownInstalled().then((yes) => {
    if (!yes) return;
    const button = document.querySelector('button[data-install]');
    if (button) button.textContent = 'App bereits installiert';
    const done = document.querySelector('[data-install-done]');
    if (done && standalone) done.hidden = false;
  });
})();

// Countdown im Kopf: läuft sekundengenau; bei Null Seite neu laden (dann steht dort "Live" bzw. der nächste Countdown)
(() => {
  const el = document.querySelector('[data-countdown]');
  if (!el) return;
  const target = new Date(el.dataset.countdown).getTime();
  const two = (n) => String(n).padStart(2, '0');
  const tick = () => {
    const s = Math.max(0, Math.floor((target - Date.now()) / 1000));
    const d = Math.floor(s / 86400);
    const rest = `${two(Math.floor((s % 86400) / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
    el.textContent = d > 0 ? `${d} Tg ${rest}` : rest;
    if (s === 0) {
      clearInterval(timer);
      // Danach zeigt der Kopf "Live" bzw. den nächsten Countdown; geht die Uhr hier vor, nach ein paar Sekunden noch einmal
      let again = false;
      try {
        again = Date.now() - Number(sessionStorage.getItem('countdown-reload')) < 10000;
        sessionStorage.setItem('countdown-reload', String(Date.now()));
      } catch { /* ohne Speicher: einfach neu laden */ }
      setTimeout(() => location.reload(), again ? 5000 : 1500);
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
})();

// Rangliste rechts ein- und ausklappen (Standard: ausgeklappt; die Wahl merkt sich der Browser)
(() => {
  const box = document.querySelector('.rank-box');
  const btn = box && box.querySelector('[data-rank-toggle]');
  if (!btn) return;
  btn.hidden = false;
  const set = (collapsed) => {
    box.classList.toggle('collapsed', collapsed);
    const label = collapsed ? 'Rangliste ausklappen' : 'Rangliste einklappen';
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', label);
    btn.title = label;
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem('rank-collapsed') === '1'; } catch { /* ohne Speicher: ausgeklappt */ }
  set(collapsed);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    collapsed = !collapsed;
    set(collapsed);
    try { localStorage.setItem('rank-collapsed', collapsed ? '1' : '0'); } catch { /* egal */ }
  });
})();

// Profilbild: im Browser auf 128x128 zuschneiden und verkleinern (JPEG), dann als Text mitschicken
(() => {
  const form = document.querySelector('[data-avatar-form]');
  if (!form) return;
  const file = form.querySelector('[data-avatar-file]');
  const hidden = form.querySelector('input[name="avatar"]');
  const submit = form.querySelector('[data-avatar-submit]');
  file.addEventListener('change', () => {
    submit.disabled = true;
    hidden.value = '';
    const f = file.files && file.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 128;
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) return;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        hidden.value = canvas.toDataURL('image/jpeg', 0.85);
        submit.disabled = false;
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  });
})();

// Sonderfragen: Rückfrage, wenn beim Speichern Fragen abgewählt (also gelöscht) werden
document.addEventListener('submit', (e) => {
  const form = e.target;
  const text = form.dataset && form.dataset.confirmUncheck;
  if (!text || (e.submitter && e.submitter.dataset.confirm)) return;
  const removed = [...form.querySelectorAll('input[data-was-checked]')].some((i) => !i.checked && !i.disabled);
  if (removed && !window.confirm(text)) e.preventDefault();
});

// Live-Suche / Filter: Listen mit data-item-Zeilen, Leiste bleibt ohne JavaScript verborgen
document.querySelectorAll('.filter-bar[data-filter]').forEach((bar) => {
  const list = document.getElementById(bar.dataset.filter);
  if (!list) return;
  const q = bar.querySelector('.filter-q');
  const region = bar.querySelector('.filter-region');
  const empty = list.parentElement.querySelector('.st-empty, .filter-empty');
  const apply = () => {
    const text = q.value.trim().toLowerCase();
    const reg = region ? region.value : '';
    let shown = 0;
    list.querySelectorAll('[data-item]').forEach((row) => {
      const ok = (!text || (row.dataset.text || '').includes(text)) && (!reg || row.dataset.region === reg);
      row.hidden = !ok;
      if (ok) shown++;
    });
    list.querySelectorAll('[data-group]').forEach((g) => {
      const has = !!g.querySelector('[data-item]:not([hidden])');
      g.hidden = !has;
      if (has && text && g.tagName === 'DETAILS') g.open = true;
    });
    if (empty) empty.hidden = shown > 0;
  };
  q.addEventListener('input', apply);
  if (region) region.addEventListener('change', apply);
  bar.hidden = false;
});

// Suche im Kopf: beim Aufklappen das Eingabefeld fokussieren, beim Tippen Live-Treffer anzeigen (/suche.json).
// Ohne JavaScript bleibt nur das Formular übrig, das zur vollständigen Such-Seite führt.
document.querySelectorAll('details.top-search[data-search]').forEach((details) => {
  const input = details.querySelector('[data-search-input]');
  const results = details.querySelector('[data-search-results]');
  const panel = details.querySelector('.top-search-panel');
  const btn = details.querySelector('.top-search-btn');
  const slug = details.dataset.slug;
  // Das Panel hängt per CSS fix am Viewport (nicht an der Lupe), damit es am linken Rand nie herausragt.
  // Am Handy soll es als Overlay über die volle Breite erscheinen, am PC dicht unter der Lupe als schmale
  // Box – deshalb hier statt in CSS berechnet, wo die Lupe gerade tatsächlich sitzt.
  const place = () => {
    const r = btn.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    if (window.innerWidth <= 640) {
      panel.style.left = '16px';
      panel.style.right = '16px';
      panel.style.width = 'auto';
    } else {
      const width = Math.min(352, window.innerWidth - 32);
      const left = Math.min(Math.round(r.left), window.innerWidth - 16 - width);
      panel.style.left = `${Math.max(16, left)}px`;
      panel.style.right = 'auto';
      panel.style.width = `${width}px`;
    }
  };
  window.addEventListener('resize', () => {
    if (details.open) place();
  });
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const group = (title, items) => {
    if (!items || !items.length) return '';
    const rows = items.map((i) => `<li><a class="search-hit" href="${esc(i.href)}"><span>${esc(i.title)}</span>${i.sub ? `<span class="muted">${esc(i.sub)}</span>` : ''}</a></li>`).join('');
    return `<div><p class="ts-group-title">${title}</p><ul class="st-list search-hits">${rows}</ul></div>`;
  };
  const clear = () => {
    results.hidden = true;
    results.innerHTML = '';
  };
  details.addEventListener('toggle', () => {
    if (details.open) {
      place();
      input.focus();
    } else clear();
  });
  let timer = null;
  let controller = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      clear();
      return;
    }
    timer = setTimeout(async () => {
      if (controller) controller.abort();
      controller = new AbortController();
      try {
        const r = await fetch(`/r/${slug}/suche.json?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!r.ok) return;
        const data = await r.json();
        const found = [group('Teams', data.teams), group('Spieler', data.players), group('Teilnehmer', data.members), group('Champions', data.champions)].join('');
        results.innerHTML = found || '<p class="ts-empty">Keine Treffer.</p>';
        results.hidden = false;
      } catch {
        /* Abgebrochen (neue Eingabe) oder Netzwerkfehler – dann bleiben die vorigen Treffer einfach stehen */
      }
    }, 200);
  });
});

// Teamname in der Spielzeile: auf einer Zeile, nie abgeschnitten. Reicht die Spaltenbreite nicht (kein
// gepflegtes Kürzel, langer Name), wird die Schrift schrittweise verkleinert statt umzubrechen oder den
// Namen am Rand abzuschneiden. Ohne JavaScript bleibt die normale Schriftgröße (siehe app.css).
function fitTeamNames() {
  document.querySelectorAll('.teams .team-a, .teams .team-b').forEach((el) => {
    el.style.fontSize = '';
    const base = parseFloat(getComputedStyle(el).fontSize);
    let size = base;
    const min = Math.max(base * 0.4, 8);
    while (el.scrollWidth > el.clientWidth + 1 && size > min) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  });
}
fitTeamNames();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTeamNames);
let fitTeamNamesTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(fitTeamNamesTimer);
  fitTeamNamesTimer = setTimeout(fitTeamNames, 100);
});

// Push-Benachrichtigungen im Konto: dieses Gerät an- und abmelden
(function () {
  const box = document.querySelector('[data-push]');
  if (!box || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  const on = box.querySelector('[data-push-on]');
  const off = box.querySelector('[data-push-off]');
  const status = box.querySelector('[data-push-status]');
  const csrf = box.querySelector('[data-push-csrf]').value;
  const toBytes = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const post = (url, data) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...data }) });
  const show = (subscribed) => {
    on.hidden = subscribed;
    off.hidden = !subscribed;
    if (subscribed) status.textContent = 'Push ist auf diesem Gerät aktiv.';
  };
  const registration = () => navigator.serviceWorker.ready;
  registration().then(async (reg) => {
    box.hidden = false;
    show(!!(await reg.pushManager.getSubscription()));
  });
  on.addEventListener('click', async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        status.textContent = 'Der Browser blockiert Benachrichtigungen. Erlaube sie in den Seiteneinstellungen.';
        return;
      }
      const reg = await registration();
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(box.dataset.key) }));
      const j = sub.toJSON();
      const r = await post('/konto/push', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
      if (!r.ok) throw new Error('save');
      show(true);
      status.textContent = 'Push ist auf diesem Gerät aktiv. Mit „Speichern“ oben legst du Vorlaufzeit fest.';
      const cb = document.querySelector('input[name="push"]');
      if (cb) cb.checked = true;
    } catch {
      status.textContent = 'Das hat nicht geklappt. Auf dem iPhone muss die App zuerst zum Startbildschirm hinzugefügt werden.';
    }
  });
  off.addEventListener('click', async () => {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post('/konto/push/entfernen', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    show(false);
    status.textContent = 'Push ist auf diesem Gerät abgeschaltet.';
  });
})();

// Dropdowns (Handy-Menüs, Spielleiter/Administrator, Suche): Tipp daneben schließt sie wieder
document.addEventListener('click', (e) => {
  document.querySelectorAll('details[data-m-menu][open], details.role-switch[open], details.top-search[open]').forEach((d) => {
    if (!d.contains(e.target)) d.removeAttribute('open');
  });
});

// Spoilerschutz: Klick auf den Ergebnis-Block zeigt das Ergebnis (noch einmal klicken verdeckt es wieder)
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('[data-spoiler]') : null;
  if (!btn) return;
  const shown = btn.classList.toggle('revealed');
  btn.setAttribute('aria-label', shown ? btn.dataset.label + ' – Ergebnis verdecken' : 'Ergebnis anzeigen');
});

// Filterformulare (Backup, Alle Tipps): Auswahlfelder wirken sofort; nach dem Von-Datum öffnet sich gleich der Bis-Kalender,
// mit dem Bis-Datum wird gefiltert
document.querySelectorAll('form[data-auto-filter]').forEach((form) => {
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    form.submit();
  };
  form.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', send));
  const von = form.elements.namedItem('von');
  const bis = form.elements.namedItem('bis');
  if (!(von instanceof HTMLInputElement) || !(bis instanceof HTMLInputElement)) return;
  von.addEventListener('change', () => {
    bis.min = von.value || bis.min;
    if (!von.value) return send();
    bis.focus();
    try { bis.showPicker(); } catch { /* ältere Browser: Bis von Hand wählen */ }
  });
  bis.addEventListener('change', () => {
    von.max = bis.value || von.max;
    send();
  });
  // Bis-Kalender ohne Auswahl geschlossen: der Filter gilt dann ab dem Von-Datum
  bis.addEventListener('blur', () => {
    if (von.value && von.value !== von.defaultValue) send();
  });
});


// Passkeys: im Konto erstellen und beim Anmelden benutzen (WebAuthn). Ohne Unterstützung bleibt alles verborgen.
(function () {
  const supported = 'PublicKeyCredential' in window && navigator.credentials && navigator.credentials.create;
  const toB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64url = (s) => {
    const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const post = async (url, form, extra) => {
    const body = new URLSearchParams({ _csrf: form.querySelector('input[name="_csrf"]')?.value || '', ...extra });
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Das hat nicht geklappt. Bitte lade die Seite neu.');
    return data;
  };
  const setup = (form, run) => {
    if (!form) return;
    const error = form.querySelector('[data-passkey-error]');
    const button = form.querySelector('[data-passkey-start]');
    form.hidden = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      button.disabled = true;
      try {
        await run();
        form.submit();
      } catch (err) {
        // Abbruch im Passkey-Dialog ist kein Fehler, den man erklären muss
        if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
          error.textContent = err.name === 'InvalidStateError' ? 'Auf diesem Gerät gibt es schon einen Passkey für dein Konto.' : err.message;
          error.hidden = false;
        }
        button.disabled = false;
      }
    });
  };
  const field = (form, name, value) => {
    form.querySelector(`input[name="${name}"]`).value = value;
  };
  if (!supported) return;
  document.querySelectorAll('[data-passkey-unsupported]').forEach((el) => (el.hidden = true));

  const reg = document.querySelector('[data-passkey-register]');
  setup(reg, async () => {
    const current = reg.querySelector('input[name="current"]');
    const o = await post('/konto/passkey/optionen', reg, current ? { current: current.value } : {});
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: fromB64url(o.challenge),
        rp: o.rp,
        user: { id: fromB64url(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.algs.map((alg) => ({ type: 'public-key', alg })),
        excludeCredentials: o.exclude.map((id) => ({ type: 'public-key', id: fromB64url(id) })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none',
        timeout: 120000,
      },
    });
    field(reg, 'clientDataJSON', toB64url(cred.response.clientDataJSON));
    field(reg, 'attestationObject', toB64url(cred.response.attestationObject));
  });

  const login = document.querySelector('[data-passkey-login]');
  setup(login, async () => {
    const o = await post('/anmelden/passkey/optionen', login, { weiter: login.querySelector('input[name="weiter"]').value });
    const cred = await navigator.credentials.get({
      publicKey: { challenge: fromB64url(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: 120000 },
    });
    field(login, 'id', toB64url(cred.rawId));
    field(login, 'clientDataJSON', toB64url(cred.response.clientDataJSON));
    field(login, 'authenticatorData', toB64url(cred.response.authenticatorData));
    field(login, 'signature', toB64url(cred.response.signature));
    field(login, 'userHandle', cred.response.userHandle ? toB64url(cred.response.userHandle) : '');
  });
})();
