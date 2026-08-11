/* cc-bus-panel.js — global Bus side-panel.
   Mount via <script defer src="assets/cc-bus-panel.js"></script>.
   Reads agent_messages for current user. Quick-reply lets you fire @code/@cowork/@reanna texts.
   Read+reply only — full DISPATCH lives in index.html COMMS → Bus sub-tab.
   Depends on window.supa exposed by host page after auth.

   v3.22 features:
   - Collapsed by default; toggle button on left edge.
   - Unread badge on collapsed state (count of status='sent' addressed to me).
   - Hotkey Ctrl+/ (or Ctrl+`) toggles open.
   - Persistent draft per page (localStorage keyed by hostname+path).
   - Auto top offset — measures pinned chrome height instead of hardcoding.
   - Quick-reply: @code text · @cowork text · @reanna text · plain → bus.
   - Realtime refresh on agent_messages INSERT/UPDATE.
   - Every row deep-links to bus.html?id=X (you go straight to the ticket).
*/

(function () {
  'use strict';
  if (window.__ccBusPanelLoaded) return;
  window.__ccBusPanelLoaded = true;

  // Don't mount on bus.html itself — panel is redundant there.
  if (/\/bus\.html?$/i.test(location.pathname) || location.pathname.endsWith('/bus')) return;

  // ─── Styles ───────────────────────────────────────────────
  const css = `
.cc-buspanel { position:fixed; left:0; bottom:0; width:0; background:transparent; border-right:none; z-index:90; transition:width 0.18s ease, background 0.18s ease, border-color 0.18s ease; overflow:hidden; display:flex; flex-direction:column; pointer-events:none; }
.cc-buspanel.open { width:340px; background:var(--surface,#0d1117); border-right:1px solid var(--border,#30363d); box-shadow:4px 0 24px rgba(0,0,0,0.4); pointer-events:auto; }
.cc-buspanel__toggle { display:none; }
.cc-buspanel-inline { display:inline-flex; align-items:center; justify-content:center; width:30px; height:24px; background:var(--surface,#0d1117); border:1px solid var(--border,#30363d); border-radius:3px; color:var(--amber,#c8922a); font-family:var(--display,inherit); font-size:13px; font-weight:700; cursor:pointer; padding:0; margin:0 10px 0 0; flex-shrink:0; position:relative; align-self:center; }
.cc-buspanel-inline:hover { color:var(--text,#fff); border-color:var(--amber,#c8922a); }
.cc-buspanel-inline .cc-buspanel-inline__badge { position:absolute; top:-4px; right:-4px; min-width:13px; height:13px; padding:0 3px; border-radius:7px; background:#f85149; color:#fff; font-family:var(--mono,monospace); font-size:8px; font-weight:700; display:none; align-items:center; justify-content:center; line-height:1; }
.cc-buspanel-inline.has-unread .cc-buspanel-inline__badge { display:flex; }
.cc-buspanel__toggle:hover { color:var(--text,#fff); background:var(--raised,#161b22); }
.cc-buspanel__toggle .badge { position:absolute; top:6px; right:4px; min-width:14px; height:14px; padding:0 3px; border-radius:7px; background:#f85149; color:#fff; font-family:var(--mono,monospace); font-size:9px; font-weight:700; display:none; align-items:center; justify-content:center; }
.cc-buspanel__toggle.has-unread .badge { display:flex; }
.cc-buspanel__head { padding:12px 14px 8px 48px; border-bottom:1px solid var(--border,#30363d); font-family:var(--display,inherit); font-size:11px; font-weight:700; letter-spacing:0.16em; text-transform:uppercase; color:var(--amber,#c8922a); display:none; }
.cc-buspanel.open .cc-buspanel__head { display:flex; align-items:center; gap:8px; min-height:48px; }
.cc-buspanel__head .cc-buspanel__count { background:var(--amber-soft,rgba(200,146,42,.12)); color:var(--amber,#c8922a); border:1px solid var(--amber-glow,rgba(200,146,42,.3)); padding:2px 7px; border-radius:9px; font-size:9px; font-weight:700; letter-spacing:0.1em; }
.cc-buspanel__list { flex:1; overflow-y:auto; padding:6px 0; display:none; }
.cc-buspanel.open .cc-buspanel__list { display:block; }
.cc-buspanel__row { padding:8px 14px; border-bottom:1px solid var(--border,#30363d); cursor:pointer; transition:background 0.1s; text-decoration:none; color:inherit; display:block; }
.cc-buspanel__row:hover { background:var(--raised,#161b22); }
.cc-buspanel__row.unread { border-left:2px solid var(--amber,#c8922a); padding-left:12px; }
.cc-buspanel__row-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:3px; }
.cc-buspanel__from { font-family:var(--mono,monospace); font-size:10px; font-weight:700; color:var(--amber,#c8922a); letter-spacing:0.04em; }
.cc-buspanel__time { font-family:var(--mono,monospace); font-size:9px; color:var(--text-xs,#6e7681); }
.cc-buspanel__body { font-size:11px; line-height:1.4; color:var(--text-dim,#c9d1d9); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.cc-buspanel__empty { padding:24px 16px; text-align:center; font-size:11px; color:var(--text-xs,#6e7681); font-family:var(--mono,monospace); }
.cc-buspanel__compose { display:none; border-top:1px solid var(--border,#30363d); padding:8px 12px; background:var(--raised,#161b22); }
.cc-buspanel.open .cc-buspanel__compose { display:flex; flex-direction:column; gap:6px; }
.cc-buspanel__compose textarea { background:var(--surface,#0d1117); color:var(--text,#fff); border:1px solid var(--border,#30363d); border-radius:4px; padding:6px 8px; font-family:var(--mono,monospace); font-size:11px; resize:vertical; min-height:42px; max-height:140px; line-height:1.4; }
.cc-buspanel__compose textarea:focus { outline:none; border-color:var(--amber,#c8922a); }
.cc-buspanel__compose-row { display:flex; gap:6px; align-items:center; justify-content:space-between; }
.cc-buspanel__hint { font-family:var(--mono,monospace); font-size:9px; color:var(--text-xs,#6e7681); flex:1; }
.cc-buspanel__btn { background:var(--amber,#c8922a); color:#000; border:none; border-radius:3px; padding:4px 10px; font-family:var(--mono,monospace); font-size:10px; font-weight:700; cursor:pointer; letter-spacing:0.06em; text-transform:uppercase; }
.cc-buspanel__btn:hover { background:var(--text,#fff); }
.cc-buspanel__btn:disabled { opacity:0.5; cursor:wait; }
.cc-buspanel__btn.ghost { background:transparent; color:var(--amber,#c8922a); border:1px solid var(--amber-glow,rgba(200,146,42,.3)); }
.cc-buspanel__btn.ghost:hover { background:var(--amber,#c8922a); color:#000; }
.cc-buspanel__foot { padding:8px 14px; border-top:1px solid var(--border,#30363d); display:none; }
.cc-buspanel.open .cc-buspanel__foot { display:flex; gap:8px; align-items:center; justify-content:space-between; }
.cc-buspanel__foot a { font-family:var(--mono,monospace); font-size:10px; color:var(--amber,#c8922a); text-decoration:none; padding:4px 8px; border:1px solid var(--amber-glow,rgba(200,146,42,.3)); border-radius:3px; }
.cc-buspanel__foot a:hover { background:var(--amber,#c8922a); color:#000; }
@media (max-width:520px) { .cc-buspanel.open { width:88vw; } }
`;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ─── DOM ──────────────────────────────────────────────────
  const root = document.createElement('aside');
  root.className = 'cc-buspanel';
  root.setAttribute('aria-label', 'Bus side-panel');
  root.innerHTML = `
    <button class="cc-buspanel__toggle" type="button" title="Open Bus (Ctrl+/)" aria-label="Toggle Bus">⇄<span class="badge" data-badge>0</span></button>
    <div class="cc-buspanel__head">
      <span>Bus</span>
      <span class="cc-buspanel__count" data-count>0</span>
    </div>
    <div class="cc-buspanel__list" data-list>
      <div class="cc-buspanel__empty">Loading…</div>
    </div>
    <div class="cc-buspanel__compose">
      <textarea data-input placeholder="@code · @cowork · @reanna · or just type → fires bus" rows="2"></textarea>
      <div class="cc-buspanel__compose-row">
        <span class="cc-buspanel__hint">enter = newline · ⌘/ctrl+enter sends</span>
        <button class="cc-buspanel__btn ghost" type="button" data-mic title="Voice">🎤</button>
        <button class="cc-buspanel__btn" type="button" data-send title="Send to bus">FIRE</button>
      </div>
    </div>
    <div class="cc-buspanel__foot">
      <a href="bus.html" title="Open full bus list">Open full →</a>
      <span class="cc-buspanel__hint">read + quick-reply</span>
    </div>
  `;
  document.body.appendChild(root);

  // Inline toggle button (relocated from left edge into subnav/nav bar).
  const inlineBtn = document.createElement('button');
  inlineBtn.type = 'button';
  inlineBtn.className = 'cc-buspanel-inline';
  inlineBtn.innerHTML = '⇄<span class="cc-buspanel-inline__badge" data-inline-badge>0</span>';
  inlineBtn.title = 'Toggle Bus (Ctrl+/)';
  inlineBtn.setAttribute('aria-label', 'Toggle Bus');

  function placeInlineToggle() {
    if (inlineBtn.parentNode && inlineBtn.parentNode.isConnected) return;
    const subnav = document.getElementById('cc-subnav') || document.querySelector('.cc-subnav');
    const target = subnav || document.querySelector('.cc-nav');
    if (!target) return;
    target.insertBefore(inlineBtn, target.firstChild);
  }
  placeInlineToggle();
  // Watch for subnav re-renders (renderSubnav rewrites innerHTML on lane change).
  const subnavWatch = document.getElementById('cc-subnav') || document.querySelector('.cc-subnav');
  if (subnavWatch) {
    new MutationObserver(() => placeInlineToggle()).observe(subnavWatch, { childList: true });
  }

  const toggleBtn = inlineBtn; // primary trigger now
  const inlineBadge = inlineBtn.querySelector('[data-inline-badge]');
  const listEl = root.querySelector('[data-list]');
  const countEl = root.querySelector('[data-count]');
  const badgeEl = root.querySelector('[data-badge]');
  const inputEl = root.querySelector('[data-input]');
  const sendEl = root.querySelector('[data-send]');
  const micEl = root.querySelector('[data-mic]');

  // ─── Auto top offset (clear pinned chrome) ────────────────
  function recalcTop() {
    let top = 0;
    const header = document.querySelector('.cc-header');
    const nav = document.querySelector('.cc-nav');
    const subnav = document.querySelector('.cc-subnav');
    if (header) top += header.getBoundingClientRect().height;
    if (nav) top += nav.getBoundingClientRect().height;
    if (subnav && subnav.offsetParent !== null) top += subnav.getBoundingClientRect().height;
    root.style.top = (top || 100) + 'px';
  }
  recalcTop();
  window.addEventListener('resize', recalcTop);
  setTimeout(recalcTop, 600);
  setTimeout(recalcTop, 1500);

  // ─── Toggle + hotkey ──────────────────────────────────────
  function setOpen(open) {
    root.classList.toggle('open', !!open);
    toggleBtn.title = open ? 'Collapse Bus' : 'Open Bus (Ctrl+/)';
    if (open) setTimeout(() => inputEl.focus(), 200);
  }
  toggleBtn.addEventListener('click', () => setOpen(!root.classList.contains('open')));
  document.addEventListener('keydown', e => {
    // Ctrl+/ or Ctrl+` toggles
    if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.key === '`')) {
      e.preventDefault();
      setOpen(!root.classList.contains('open'));
    }
    // Escape closes if open
    if (e.key === 'Escape' && root.classList.contains('open') && document.activeElement !== inputEl) {
      setOpen(false);
    }
  });

  // ─── Persistent draft ─────────────────────────────────────
  const DRAFT_KEY = 'cc-buspanel-draft-' + (location.host + location.pathname).replace(/\W+/g, '-');
  try { inputEl.value = localStorage.getItem(DRAFT_KEY) || ''; } catch (e) {}
  let draftDebounce;
  inputEl.addEventListener('input', () => {
    if (draftDebounce) clearTimeout(draftDebounce);
    draftDebounce = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, inputEl.value); } catch (e) {}
    }, 200);
  });

  // ─── Helpers ──────────────────────────────────────────────
  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'now';
    if (diffMin < 60) return diffMin + 'm';
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + 'h';
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  async function waitForSupa() {
    let tries = 0;
    while (!window.supa && tries < 100) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    return window.supa;
  }
  function meFromUser() {
    try {
      const email = (window.currentUser && window.currentUser.email || '').toLowerCase();
      if (email.indexOf('reanna') >= 0) return 'reanna';
      return 'alessio';
    } catch (e) { return 'alessio'; }
  }

  // ─── Data load ────────────────────────────────────────────
  let _lastUnread = 0;
  async function loadRecent(supa) {
    const me = meFromUser();
    const { data, error } = await supa
      .from('agent_messages')
      .select('id, from_user, to_user, intended_for, body, status, sent_at, channel, priority')
      .or(`to_user.eq.${me},from_user.eq.${me}`)
      .order('sent_at', { ascending: false })
      .limit(20);
    if (error) {
      listEl.innerHTML = `<div class="cc-buspanel__empty">Error: ${escapeHtml(error.message).slice(0, 60)}</div>`;
      return;
    }
    if (!data || !data.length) {
      listEl.innerHTML = '<div class="cc-buspanel__empty">No bus traffic yet.</div>';
      countEl.textContent = '0';
      _setBadge(0);
      return;
    }
    countEl.textContent = String(data.length);
    let unread = 0;
    const keepScroll = listEl.scrollTop;   // the poll used to dump him back to the top mid-read
    listEl.innerHTML = data.map(m => {
      const isUnread = m.to_user === me && m.status === 'sent';
      if (isUnread) unread++;
      const preview = String(m.body || '').slice(0, 140);
      return `
        <a class="cc-buspanel__row${isUnread ? ' unread' : ''}" href="bus.html?id=${m.id}" title="Open #${m.id}">
          <div class="cc-buspanel__row-head">
            <span class="cc-buspanel__from">#${m.id} · ${escapeHtml(m.from_user || '?')} → ${escapeHtml(m.to_user || '?')}</span>
            <span class="cc-buspanel__time">${fmtTime(m.sent_at)}</span>
          </div>
          <div class="cc-buspanel__body">${escapeHtml(preview)}</div>
        </a>`;
    }).join('');
    try { listEl.scrollTop = keepScroll; } catch (e) {}
    _setBadge(unread);
  }
  function _setBadge(n) {
    _lastUnread = n;
    badgeEl.textContent = n > 99 ? '99+' : String(n);
    if (inlineBadge) inlineBadge.textContent = n > 99 ? '99+' : String(n);
    inlineBtn.classList.toggle('has-unread', n > 0);
  }

  // ─── Quick-reply (FIRE) ───────────────────────────────────
  async function fireBus() {
    const raw = inputEl.value.trim();
    if (!raw) return;
    const supa = window.supa;
    if (!supa) { inputEl.placeholder = 'Sign in first'; return; }
    const me = meFromUser();
    let toUser = 'forge-cowork';
    let intended = 'forge-cowork-sonnet';
    let body = raw;
    let priority = 'normal';
    if (/^@code\s/i.test(raw)) {
      toUser = 'forge-code'; intended = 'forge-code-opus-beast';
      body = raw.replace(/^@code\s+/i, '');
    } else if (/^@cowork\s/i.test(raw)) {
      toUser = 'forge-cowork'; intended = 'forge-cowork-sonnet';
      body = raw.replace(/^@cowork\s+/i, '');
    } else if (/^@reanna\s/i.test(raw)) {
      toUser = 'reanna'; intended = null;
      body = raw.replace(/^@reanna\s+/i, '');
    } else if (/^@design\s/i.test(raw)) {
      toUser = 'forge-design'; intended = null;
      body = raw.replace(/^@design\s+/i, '');
    } else if (/^@team\s/i.test(raw)) {
      toUser = 'forge-team'; intended = null;
      body = raw.replace(/^@team\s+/i, '');
    }
    if (/!urgent/i.test(body)) {
      priority = 'urgent';
      body = body.replace(/!urgent/i, '').trim();
    }
    sendEl.disabled = true;
    sendEl.textContent = '…';
    try {
      const ins = await supa.from('agent_messages').insert({
        from_user: me,
        from_instance_id: 'cc-buspanel@' + location.hostname,
        to_user: toUser,
        intended_for: intended,
        channel: 'general',
        body: body,
        priority: priority,
        status: 'sent',
        awaiting_reply_from: toUser,
        thread_id: 'cc-buspanel'
      }).select('id').single();
      if (ins.error) throw ins.error;
      inputEl.value = '';
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
      sendEl.textContent = '#' + ins.data.id + ' ✓';
      setTimeout(() => { sendEl.textContent = 'FIRE'; }, 1400);
      loadRecent(supa);
    } catch (err) {
      console.error('[cc-buspanel] fire failed', err);
      sendEl.textContent = 'FAIL';
      setTimeout(() => { sendEl.textContent = 'FIRE'; }, 1800);
    } finally {
      sendEl.disabled = false;
    }
  }
  sendEl.addEventListener('click', fireBus);
  inputEl.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.code === 'Enter')) {
      e.preventDefault();
      fireBus();
    }
  });

  // ─── Mic — Web Speech API (Chrome only, fail silently) ────
  let _rec = null;
  let _recOn = false;
  micEl.addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { micEl.title = 'No Web Speech API'; micEl.textContent = '⊘'; return; }
    if (_recOn) { try { _rec.stop(); } catch (e) {} return; }
    _rec = new SR();
    _rec.continuous = false;
    _rec.interimResults = true;
    _rec.lang = 'en-US';
    _rec.onstart = () => { _recOn = true; micEl.textContent = '⏺'; micEl.style.color = '#f85149'; };
    _rec.onresult = ev => {
      const text = Array.from(ev.results).map(r => r[0].transcript).join('');
      inputEl.value = text;
    };
    _rec.onerror = () => { _recOn = false; micEl.textContent = '🎤'; micEl.style.color = ''; };
    _rec.onend = () => { _recOn = false; micEl.textContent = '🎤'; micEl.style.color = ''; };
    try { _rec.start(); } catch (e) { _recOn = false; }
  });

  // ─── Boot ─────────────────────────────────────────────────
  (async function boot() {
    const supa = await waitForSupa();
    if (!supa) {
      listEl.innerHTML = '<div class="cc-buspanel__empty">No supabase client. Sign in first.</div>';
      return;
    }
    await loadRecent(supa);
    let debounce = null;
    const refresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => loadRecent(supa).catch(() => {}), 400);
    };
    try {
      supa.channel('cc-buspanel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_messages' }, refresh)
        .subscribe();
    } catch (e) { /* realtime optional */ }
    // Poll only when it can actually be seen: a collapsed panel on a background
    // tab was re-querying the bus every minute for nobody, and each tick reset
    // the list. Realtime already covers the open panel; this is the safety net.
    setInterval(() => {
      if (document.hidden) return;
      if (!root.classList.contains('open')) return;
      loadRecent(supa).catch(() => {});
    }, 60000);
    recalcTop();
  })();
})();
