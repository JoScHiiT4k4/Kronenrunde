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
