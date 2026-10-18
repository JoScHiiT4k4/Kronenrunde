// Chat der Tipprunde: auf- und zuklappbar, ungelesene Nachrichten dieser Sitzung am Symbol
(function () {
  const root = document.querySelector('[data-chat]');
  if (!root) return;
  const slug = root.dataset.slug;
  const csrf = root.dataset.csrf;
  const toggle = root.querySelector('[data-chat-toggle]');
  const panel = root.querySelector('.chat-panel');
  const log = root.querySelector('[data-chat-log]');
  const badge = root.querySelector('[data-chat-badge]');
  const form = root.querySelector('[data-chat-form]');
  const input = form.querySelector('input[name="text"]');
  const key = 'chat-gesehen-' + slug;
  let me = '';
  let list = [];
  let open = false;
  const store = {
    get: () => { try { return sessionStorage.getItem(key); } catch { return null; } },
    set: (v) => { try { sessionStorage.setItem(key, String(v)); } catch { /* egal */ } },
  };
  const lastId = () => (list.length ? list[list.length - 1].id : 0);
  let seen = store.get() === null ? null : Number(store.get());

  const fmt = (iso) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + time;
  };
  const render = () => {
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.replaceChildren();
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'muted chat-empty';
      p.textContent = 'Noch keine Nachrichten.';
      log.append(p);
      return;
    }
    for (const m of list) {
      const own = m.u === me;
      const row = document.createElement('div');
      row.className = 'chat-msg' + (own ? ' chat-own' : '');
      const meta = document.createElement('span');
      meta.className = 'chat-meta';
      meta.textContent = (own ? 'Du' : m.n) + ' · ' + fmt(m.t);
      const text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = m.x;
      row.append(meta, text);
      if (own) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'chat-del';
        del.textContent = '×';
        del.title = 'Meine Nachricht löschen';
        del.setAttribute('aria-label', 'Meine Nachricht löschen');
        del.addEventListener('click', () => remove(m.id));
        text.append(del);
      }
      log.append(row);
    }
    if (stick || open) log.scrollTop = log.scrollHeight;
  };
  const unread = () => (seen === null ? 0 : list.filter((m) => m.id > seen && m.u !== me).length);
  const update = () => {
    if (open) {
      seen = lastId();
      store.set(seen);
    }
    const n = unread();
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = n === 0 || open;
    toggle.setAttribute('aria-label', open ? 'Chat schließen' : n ? 'Chat öffnen, ' + n + ' ungelesen' : 'Chat öffnen');
    root.classList.toggle('chat-unread', n > 0 && !open);
  };
  const merge = (messages) => {
    const known = new Set(list.map((m) => m.id));
    const add = messages.filter((m) => !known.has(m.id));
    if (!add.length) return false;
    list = list.concat(add).slice(-200);
    return true;
  };
  // Gelöschte Nachrichten verschwinden bei allen: die Liste wird bei jedem Abruf ersetzt
  const sig = (l) => l.map((m) => m.id + ':' + m.x).join('|');
  const remove = async (id) => {
    try {
      const r = await fetch('/r/' + encodeURIComponent(slug) + '/chat/' + id + '/loeschen', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ _csrf: csrf }),
      });
      if (r.ok || r.status === 404) {
        list = list.filter((m) => m.id !== id);
        render();
        update();
      }
    } catch { /* später noch einmal */ }
  };
  const load = async () => {
    try {
      const r = await fetch('/r/' + encodeURIComponent(slug) + '/chat/nachrichten', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      me = data.me;
      const first = !list.length && seen === null;
      const changed = sig(list) !== sig(data.messages);
      list = data.messages;
      if (first) {
        // Neue Sitzung: bisherige Nachrichten gelten als gelesen
        seen = lastId();
        store.set(seen);
      }
      if (changed || first) render();
      update();
    } catch { /* offline: später wieder */ }
  };
  const toBottom = () => { log.scrollTop = log.scrollHeight; };
  // Handy: Fenster an den sichtbaren Bereich anpassen (Tastatur auf/zu, Seite verschoben)
  const phone = window.matchMedia('(max-width: 700px)');
  const vv = window.visualViewport;
  const fit = () => {
    if (!open || !phone.matches || !vv) return;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    panel.style.setProperty('--chat-top', vv.offsetTop + 'px');
    panel.style.setProperty('--chat-h', vv.height + 'px');
    // Mit offener Tastatur braucht es unten keinen Abstand für den Home-Balken
    panel.style.setProperty('--chat-bottom', vv.height < window.innerHeight - 120 ? '0px' : 'env(safe-area-inset-bottom)');
    if (stick) toBottom();
  };
  if (vv) {
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
  }
  phone.addEventListener?.('change', fit);
  const setOpen = (value) => {
    open = value;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('chat-open', open);
    if (open) {
      render();
      fit();
      toBottom();
      input.focus({ preventScroll: true });
      // nach dem Aufbau (und der Tastatur) noch einmal ganz nach unten zur neuesten Nachricht
      requestAnimationFrame(toBottom);
      setTimeout(() => { fit(); toBottom(); }, 350);
    }
    update();
  };
  toggle.addEventListener('click', () => setOpen(!open));
  root.querySelector('[data-chat-close]').addEventListener('click', () => { setOpen(false); toggle.focus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      const r = await fetch('/r/' + encodeURIComponent(slug) + '/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ _csrf: csrf, text }),
      });
      if (r.ok) {
        merge([(await r.json()).message]);
        input.value = '';
        render();
        update();
      }
    } catch { /* bleibt im Feld stehen */ }
    input.disabled = false;
    input.focus();
  });
  // Lautsprecher: Chat-Benachrichtigungen laut/stumm (gleicht sich mit „Dein Konto → Benachrichtigungen“ ab)
  const mute = root.querySelector('[data-chat-mute]');
  let muted = root.dataset.muted !== '0';
  const showMute = () => {
    mute.setAttribute('aria-pressed', String(muted));
    mute.title = muted ? 'Stumm – Benachrichtigungen einschalten' : 'Laut – stummschalten';
    mute.setAttribute('aria-label', muted ? 'Chat ist stumm, Benachrichtigungen einschalten' : 'Chat-Benachrichtigungen an, stummschalten');
  };
  const toBytes = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    return Uint8Array.from(atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  };
  const post = (url, data) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...data }) });
  // Beim Laut-Schalten dieses Gerät gleich für Push anmelden (falls möglich)
  const ensurePush = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if ((await Notification.requestPermission()) !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await (await fetch('/konto/push-schluessel', { credentials: 'same-origin' })).json();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
    }
    const j = sub.toJSON();
    await post('/konto/push', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
  };
  mute.addEventListener('click', async () => {
    muted = !muted;
    showMute();
    try {
      const r = await post('/konto/chat-stumm', { stumm: muted ? '1' : '0' });
      if (!r.ok) throw new Error('save');
      if (!muted) await ensurePush().catch(() => {});
    } catch {
      muted = !muted;
      showMute();
    }
  });
  showMute();
  root.hidden = false;
  load();
  setInterval(() => { if (!document.hidden) load(); }, 12000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
