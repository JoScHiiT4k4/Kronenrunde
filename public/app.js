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
  const loggedIn = document.body.dataset.angemeldet === '1';
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
    if (sheet || standalone || !loggedIn || (!force && quiet())) return;
    sheet = el('div', 'install-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-labelledby', 'install-title');
    const head = el('div', 'install-head');
    const icon = el('img');
    icon.src = '/static/icon-192.png';
    icon.alt = '';
    icon.width = 48;
    icon.height = 48;
    const title = el('h2', null, 'Aufs Handy legen');
    title.id = 'install-title';
    head.append(icon, title);
    sheet.append(head);
    const actions = el('div', 'install-actions');
    const later = el('button', 'btn btn-quiet', kind === 'ios' ? 'Verstanden' : 'Später');
    later.type = 'button';
    later.addEventListener('click', () => {
      remember();
      close();
    });
    if (kind === 'android') {
      sheet.append(el('p', null, 'Dann startest du das Tippspiel wie eine App direkt vom Startbildschirm.'));
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
    show('android');
  });
  window.addEventListener('appinstalled', () => {
    remember();
    close();
  });
  if (isIOS) setTimeout(() => show('ios'), 1500);

  // Knopf auf der Kontoseite
  const section = document.querySelector('[data-install-section]');
  if (section && !standalone) {
    section.hidden = false;
    section.querySelector('[data-install]').addEventListener('click', () => show(deferred ? 'android' : isIOS ? 'ios' : 'other', true));
  }
})();

// Countdown im Kopf: läuft sekundengenau; bei Null Seite neu laden (dann erscheinen die Livestream-Links)
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
      setTimeout(() => location.reload(), 1500);
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
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

// Dropdowns (Handy-Menüs, Spielleiter/Administrator): Tipp daneben schließt sie wieder
document.addEventListener('click', (e) => {
  document.querySelectorAll('details[data-m-menu][open], details.role-switch[open]').forEach((d) => {
    if (!d.contains(e.target)) d.removeAttribute('open');
  });
});
