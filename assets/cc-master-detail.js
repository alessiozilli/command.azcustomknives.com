/* ═══════════════════════════════════════════════════════════════
   cc-master-detail.js — shared 3-pane component.
   ═══════════════════════════════════════════════════════════════
   Plan 1ce80fe8 follow-up · bus #1606–#1609 (Alessio + cowork
   converged 2026-05-24). One component, instantiated at each
   depth level (project | plan | task). Identical translation by
   construction; no per-tab build drift.

   API:
     window.CCMasterDetail.mount(hostEl, {
       level:        'project' | 'plan' | 'task',
       getLeft:      async () => [{ id, title, sub?, status? }, ...]
       getMiddle:    async (leftId) => [{ id, title, sub?, status? }, ...]
       getDetail:    async (middleId) => { id, title, body, ...rest }
       getThread:    async (entityId) => [{ id, from_user, body, sent_at }, ...]
       sendMessage:  async (entityId, body) => { id, ... }
       saveDescription: async (entityId, newBody) => void
       leftLabel:    'Projects' | 'Plans' | 'Tasks'
       middleLabel:  'Plans' | 'Tasks' | 'Sub-tasks'
       emptyMiddle?: { label, ctaText, onCta }  // when middle is empty (e.g., "+ Add sub-task")
     });

   The host element gets:
     <div class="md3">
       <div class="md3-col md3-col--left">    [items]   </div>
       <div class="md3-col md3-col--middle">  [items]   </div>
       <div class="md3-col md3-col--right">   [detail]  </div>
     </div>

   Author: forge-code · Opus 4.7 · beast · 2026-05-24
*/

(function () {
  'use strict';

  const STYLE_ID = 'cc-master-detail-style';
  function injectStyleOnce() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.md3 { display:grid; grid-template-columns:minmax(220px,1fr) minmax(260px,1.2fr) minmax(320px,1.6fr); gap:12px; align-items:stretch; min-height:calc(100vh - 260px); }',
      '@media (max-width:960px) { .md3 { grid-template-columns:1fr; } }',
      '.md3-col { background:var(--surface); border:1px solid var(--border); border-radius:6px; padding:10px; min-width:0; max-height:calc(100vh - 260px); overflow-y:auto; display:flex; flex-direction:column; }',
      '.md3-col__head { font-family:var(--display-tabs,var(--display,sans-serif)); font-size:10px; letter-spacing:0.14em; text-transform:uppercase; color:var(--amber); padding-bottom:8px; border-bottom:1px solid var(--border); margin-bottom:8px; flex-shrink:0; display:flex; align-items:center; gap:8px; }',
      // Count bumped 2026-06-01 (Alessio direct: "barely can see them")
      '.md3-col__count { font-family:var(--mono,monospace); font-size:13px; font-weight:700; color:var(--amber); margin-left:auto; padding:1px 8px; border-radius:10px; background:var(--amber-soft,rgba(255,176,0,0.10)); }',
      '.md3-col__body { flex:1; min-height:0; }',
      '.md3-item { padding:8px 10px; border:1px solid transparent; border-radius:4px; cursor:pointer; font-size:13px; color:var(--text); line-height:1.4; margin-bottom:4px; }',
      '.md3-item:hover { background:var(--raised,rgba(255,255,255,0.03)); border-color:var(--border); }',
      '.md3-item.active { background:var(--amber-soft,rgba(255,176,0,0.10)); border-color:var(--amber); color:var(--amber); }',
      '.md3-item__sub { font-family:var(--mono,monospace); font-size:10px; color:var(--text-dim); margin-top:3px; }',
      '.md3-item__action { float:right; margin-left:8px; background:var(--amber); color:#000; border:1px solid var(--amber); border-radius:3px; padding:2px 8px; font-family:var(--mono,monospace); font-size:9px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; cursor:pointer; }',
      '.md3-item__action:hover { filter:brightness(1.15); }',
      '.md3-item__action[disabled] { opacity:0.5; cursor:default; }',
      '.md3-empty { font-family:var(--mono,monospace); font-size:11px; color:var(--text-xs); padding:16px; text-align:center; }',
      '.md3-cta { font-family:var(--mono,monospace); font-size:11px; color:var(--amber); border:1px dashed var(--amber); border-radius:4px; padding:10px; text-align:center; cursor:pointer; margin-top:8px; }',
      '.md3-cta:hover { background:var(--amber-soft,rgba(255,176,0,0.10)); }',
      '.md3-detail__title { font-size:15px; color:var(--text); line-height:1.35; margin-bottom:10px; flex-shrink:0; }',
      '.md3-detail__meta { font-family:var(--mono,monospace); font-size:10.5px; color:var(--text-dim); display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid var(--border); flex-shrink:0; }',
      '.md3-detail__body-wrap { margin-bottom:14px; flex-shrink:0; }',
      '.md3-detail__body { width:100%; box-sizing:border-box; min-height:160px; max-height:600px; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:4px; padding:8px 10px; font-family:var(--sans); font-size:13px; line-height:1.55; resize:vertical; }',
      '.md3-detail__body:focus { outline:none; border-color:var(--amber); }',
      '.md3-detail__save-btn { display:inline-block; margin-top:6px; font-family:var(--mono,monospace); font-size:10px; letter-spacing:0.06em; text-transform:uppercase; background:transparent; color:var(--amber); border:1px solid var(--amber); border-radius:3px; padding:4px 10px; cursor:pointer; }',
      '.md3-detail__save-btn:hover { background:var(--amber); color:#000; }',
      '.md3-detail__save-btn.saved { color:var(--good,#46c28b); border-color:var(--good,#46c28b); }',
      '.md3-thread { flex:1; min-height:0; overflow-y:auto; border:1px solid var(--border); border-radius:4px; padding:6px; background:var(--bg); margin-bottom:8px; }',
      '.md3-thread__msg { padding:6px 8px; border-bottom:1px dashed var(--border); font-size:12px; line-height:1.45; color:var(--text); white-space:pre-wrap; word-wrap:break-word; }',
      '.md3-thread__msg:last-child { border-bottom:0; }',
      '.md3-thread__meta { font-family:var(--mono,monospace); font-size:9.5px; color:var(--text-xs); margin-bottom:2px; letter-spacing:0.04em; }',
      '.md3-thread__empty { font-family:var(--mono,monospace); font-size:10.5px; color:var(--text-xs); padding:12px; text-align:center; }',
      '.md3-send-row { display:flex; gap:6px; align-items:stretch; flex-shrink:0; width:100%; }',
      '.md3-send-row textarea { flex:1 1 0%; width:100%; min-width:0; background:var(--bg); border:1px solid var(--border); color:var(--text); padding:6px 10px; border-radius:3px; font-family:var(--sans); font-size:12px; line-height:1.45; min-height:80px; max-height:400px; resize:vertical; box-sizing:border-box; }',
      '.md3-send-row textarea:focus { outline:none; border-color:var(--amber); }',
      '.md3-send-row button { font-family:var(--mono,monospace); font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; background:var(--amber); color:#000; border:1px solid var(--amber); border-radius:3px; padding:6px 14px; cursor:pointer; align-self:stretch; }',
      '.md3-send-row button:hover { background:var(--text); border-color:var(--text); }',
      '.md3-section-label { font-family:var(--display-tabs,var(--display,sans-serif)); font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:var(--text-xs); margin:0 0 6px; flex-shrink:0; }',
      /* Group head — left column grouping pattern lifted from SHOP > Heat Treat
         (Alessio direct 2026-06-01: make all three OPERATOR tabs feel equal). */
      // Group head + count bumped 2026-06-01 (Alessio direct: "barely can see them")
      '.md3-group-head { font-family:var(--display,sans-serif); font-size:11px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:var(--text-dim); padding:8px 4px 4px; border-bottom:1px dashed var(--border); margin-top:6px; }',
      '.md3-group-head:first-child { margin-top:0; padding-top:0; }',
      '.md3-group-head__count { font-family:var(--mono,monospace); font-size:13px; color:var(--amber); margin-left:6px; opacity:1; font-weight:700; letter-spacing:0.02em; }',
      '.md3-group-head { cursor:pointer; user-select:none; }',
      '.md3-group-head:hover { color:var(--amber); }',
      '.md3-group-head__caret { display:inline-block; width:11px; font-size:9px; color:var(--text-xs); }',
      '.md3-group-head.is-collapsed .md3-group-head__caret { color:var(--amber); }'
    ].join('\n');
    document.head.appendChild(s);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

  // Collapsible left-column groups (Alessio 2026-06-06). Persisted so a folded
  // group stays folded across the 30s refresh and tab switches.
  const _COLLAPSE_KEY = 'cc_md3_collapsed_groups';
  let _collapsedGroups = new Set();
  try { _collapsedGroups = new Set(JSON.parse(localStorage.getItem(_COLLAPSE_KEY) || '[]')); } catch (e) {}
  function _saveCollapsed() { try { localStorage.setItem(_COLLAPSE_KEY, JSON.stringify(Array.from(_collapsedGroups))); } catch (e) {} }
  function fmtAgo(ts) {
    if (!ts) return '';
    const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm';
    if (m < 1440) return Math.floor(m/60) + 'h';
    return Math.floor(m/1440) + 'd';
  }

  function mount(host, cfg) {
    if (!host) return;
    injectStyleOnce();
    // Plan 0c87c618 Phase C: when cfg.detailPane is set, the right column is
    // delegated to the shared ccDetailPane component. cfg.detailPane.source
    // tells the pane which table/FK shape to use. dpController is the live
    // controller; we dispose + remount when the selected middle item changes.
    const state = { left: [], middle: [], detail: null, thread: [], selectedLeftId: null, selectedMiddleId: null, dpController: null };

    host.innerHTML = '<div class="md3">'
      + '<div class="md3-col md3-col--left"><div class="md3-col__head"><span>' + esc(cfg.leftLabel) + '</span><span class="md3-col__count" data-count="left">…</span></div><div class="md3-col__body" data-body="left"><div class="md3-empty">Loading…</div></div></div>'
      + '<div class="md3-col md3-col--middle"><div class="md3-col__head"><span>' + esc(cfg.middleLabel) + '</span><span class="md3-col__count" data-count="middle">—</span></div><div class="md3-col__body" data-body="middle"><div class="md3-empty">Pick on the left.</div></div></div>'
      + '<div class="md3-col md3-col--right"><div class="md3-col__head"><span>Detail</span></div><div class="md3-col__body" data-body="right"><div class="md3-empty">Pick in the middle.</div></div></div>'
      + '</div>';

    const $left   = host.querySelector('[data-body="left"]');
    const $middle = host.querySelector('[data-body="middle"]');
    const $right  = host.querySelector('[data-body="right"]');
    const $leftCount   = host.querySelector('[data-count="left"]');
    const $middleCount = host.querySelector('[data-count="middle"]');

    function renderList($el, $count, items, onPick, emptyMsg, ctaCfg, groupBy, groupOrder, itemAction) {
      $count.textContent = items.length || '0';
      if (!items.length) {
        let html = '<div class="md3-empty">' + esc(emptyMsg || 'Nothing here.') + '</div>';
        if (ctaCfg) html += '<div class="md3-cta" data-cta="1">' + esc(ctaCfg.ctaText) + '</div>';
        $el.innerHTML = html;
        if (ctaCfg) {
          const cta = $el.querySelector('[data-cta="1"]');
          if (cta && typeof ctaCfg.onCta === 'function') cta.addEventListener('click', ctaCfg.onCta);
        }
        return;
      }
      // Optional per-item button (Alessio 2026-07-27: approve a plan from the
      // PROJECTS middle column instead of walking over to the PLANS subtab).
      // itemAction(it) -> {label} or null. Clicking it must not select the row.
      const buildItem = it => {
        const act = (typeof itemAction === 'function') ? itemAction(it) : null;
        return '<div class="md3-item" data-id="' + esc(it.id) + '">'
          + esc(it.title)
          + (act ? '<button type="button" class="md3-item__action" data-action-id="' + esc(it.id) + '">' + esc(act.label) + '</button>' : '')
          + (it.sub ? '<div class="md3-item__sub">' + esc(it.sub) + '</div>' : '')
          + '</div>';
      };
      if (typeof groupBy === 'function') {
        const groups = {}; const seen = [];
        items.forEach(it => {
          const key = groupBy(it) || 'Other';
          if (!groups[key]) { groups[key] = []; seen.push(key); }
          groups[key].push(it);
        });
        const order = (Array.isArray(groupOrder) && groupOrder.length)
          ? groupOrder.filter(k => groups[k]).concat(seen.filter(k => !groupOrder.includes(k)).sort())
          : seen.sort();
        $el.innerHTML = order.map(key => {
          const collapsed = _collapsedGroups.has(key);
          return '<div class="md3-group-head' + (collapsed ? ' is-collapsed' : '') + '" data-group-key="' + esc(key) + '">'
            + '<span class="md3-group-head__caret">' + (collapsed ? '▸' : '▾') + '</span>' + esc(key)
            + ' <span class="md3-group-head__count">(' + groups[key].length + ')</span></div>'
            + '<div class="md3-group-items"' + (collapsed ? ' hidden' : '') + '>' + groups[key].map(buildItem).join('') + '</div>';
        }).join('');
        $el.querySelectorAll('.md3-group-head').forEach(h => h.addEventListener('click', () => {
          const k = h.getAttribute('data-group-key');
          const nowCollapsed = !_collapsedGroups.has(k);
          if (nowCollapsed) _collapsedGroups.add(k); else _collapsedGroups.delete(k);
          _saveCollapsed();
          h.classList.toggle('is-collapsed', nowCollapsed);
          const caret = h.querySelector('.md3-group-head__caret');
          if (caret) caret.textContent = nowCollapsed ? '▸' : '▾';
          const itemsEl = h.nextElementSibling;
          if (itemsEl && itemsEl.classList.contains('md3-group-items')) itemsEl.hidden = nowCollapsed;
        }));
      } else {
        $el.innerHTML = items.map(buildItem).join('');
      }
      $el.querySelectorAll('.md3-item').forEach(el => {
        el.addEventListener('click', () => {
          $el.querySelectorAll('.md3-item').forEach(x => x.classList.remove('active'));
          el.classList.add('active');
          onPick(el.dataset.id);
        });
      });
      $el.querySelectorAll('.md3-item__action').forEach(btn => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();            // never select the row
          const id = btn.getAttribute('data-action-id');
          const it = items.find(x => String(x.id) === String(id));
          const act = (typeof itemAction === 'function') ? itemAction(it) : null;
          if (!act || typeof act.onClick !== 'function') return;
          btn.disabled = true;
          try { await act.onClick(it); } finally { btn.disabled = false; }
        });
      });
    }

    async function loadLeft() {
      try {
        const items = await cfg.getLeft();
        state.left = items || [];
        renderList($left, $leftCount, state.left, pickLeft, 'No items.', null, cfg.leftGroupBy, cfg.leftGroupOrder);
        if (state.left.length) {
          // Preserve current selection if still present after refresh.
          const keep = state.selectedLeftId && state.left.some(it => it.id === state.selectedLeftId);
          pickLeft(keep ? state.selectedLeftId : state.left[0].id);
        }
      } catch (e) {
        $left.innerHTML = '<div class="md3-empty" style="color:#f85149">Load error: ' + esc(e.message) + '</div>';
      }
    }

    async function pickLeft(leftId) {
      state.selectedLeftId = leftId;
      state.selectedMiddleId = null;
      // Plan 0c87c618 Phase C: dispose any live detail-pane controller before
      // wiping the right column — prevents leaked event listeners + fetch races.
      if (state.dpController) { try { state.dpController.dispose(); } catch (e) {} state.dpController = null; }
      $right.innerHTML = '<div class="md3-empty">Pick in the middle.</div>';
      // Mark active
      $left.querySelectorAll('.md3-item').forEach(el => el.classList.toggle('active', el.dataset.id === leftId));
      try {
        const items = await cfg.getMiddle(leftId);
        state.middle = items || [];
        renderList($middle, $middleCount, state.middle, pickMiddle, 'Nothing here.', cfg.emptyMiddle, null, null, cfg.middleItemAction);
        // Alessio direct 2026-05-31: on every left selection, auto-pick the first
        // middle item so the right column (detail + bus thread) opens immediately
        // without a second click. Opt out by setting cfg.autoPickFirstMiddle = false.
        if (state.middle.length && cfg.autoPickFirstMiddle !== false) {
          pickMiddle(state.middle[0].id);
        }
      } catch (e) {
        $middle.innerHTML = '<div class="md3-empty" style="color:#f85149">Load error: ' + esc(e.message) + '</div>';
      }
    }

    async function pickMiddle(middleId) {
      state.selectedMiddleId = middleId;
      $middle.querySelectorAll('.md3-item').forEach(el => el.classList.toggle('active', el.dataset.id === middleId));
      // Plan 0c87c618 Phase C: delegate the right column to ccDetailPane when
      // cfg.detailPane is set. middleId is the source id (plan uuid, task uuid,
      // project slug). Built-in getDetail/getThread/sendMessage path is bypassed.
      if (cfg.detailPane && window.ccDetailPane && window.supa) {
        if (state.dpController) { try { state.dpController.dispose(); } catch (e) {} state.dpController = null; }
        try {
          state.dpController = window.ccDetailPane.mount($right, {
            source: cfg.detailPane.source,
            id: middleId,
            supa: window.supa
          });
        } catch (e) {
          $right.innerHTML = '<div class="md3-empty" style="color:#f85149">Detail pane error: ' + esc(e.message) + '</div>';
        }
        return;
      }
      $right.innerHTML = '<div class="md3-empty">Loading…</div>';
      try {
        const detail = await cfg.getDetail(middleId);
        state.detail = detail;
        renderRight();
        if (cfg.getThread) loadThread(middleId);
      } catch (e) {
        $right.innerHTML = '<div class="md3-empty" style="color:#f85149">Load error: ' + esc(e.message) + '</div>';
      }
    }

    function renderRight() {
      const d = state.detail;
      if (!d) { $right.innerHTML = '<div class="md3-empty">Nothing selected.</div>'; return; }
      const meta = [];
      if (d.status)       meta.push(esc(d.status));
      if (d.priority)     meta.push('priority: ' + esc(d.priority));
      if (d.project_slug) meta.push(esc(d.project_slug));
      if (d.assigned_to)  meta.push('→ ' + esc(d.assigned_to));
      $right.innerHTML =
        '<div class="md3-detail__title">' + esc(d.title) + '</div>'
        + '<div class="md3-detail__meta">' + meta.join(' · ') + '</div>'
        + '<div class="md3-detail__body-wrap">'
          + '<div class="md3-section-label">Description</div>'
          + '<textarea class="md3-detail__body" data-body-input>' + esc(d.body || '') + '</textarea>'
          + '<button class="md3-detail__save-btn" data-save>Save description</button>'
        + '</div>'
        + (cfg.getThread ? ''
          + '<div class="md3-section-label">Bus thread</div>'
          + '<div class="md3-thread" data-thread><div class="md3-thread__empty">Loading…</div></div>'
          + '<div class="md3-send-row">'
            + '<textarea data-send-input placeholder="Send a message scoped to this..."></textarea>'
            + '<button data-send>Send</button>'
          + '</div>'
        : '');
      const saveBtn  = $right.querySelector('[data-save]');
      const bodyArea = $right.querySelector('[data-body-input]');
      if (saveBtn && cfg.saveDescription) {
        saveBtn.addEventListener('click', async () => {
          saveBtn.textContent = 'Saving…';
          try {
            await cfg.saveDescription(d.id, bodyArea.value);
            saveBtn.textContent = 'Saved';
            saveBtn.classList.add('saved');
            setTimeout(() => { saveBtn.textContent = 'Save description'; saveBtn.classList.remove('saved'); }, 1500);
          } catch (e) {
            saveBtn.textContent = 'Save failed';
            console.warn('[md3] save failed', e);
          }
        });
      }
      const sendBtn   = $right.querySelector('[data-send]');
      const sendInput = $right.querySelector('[data-send-input]');
      if (sendBtn && cfg.sendMessage && sendInput) {
        sendBtn.addEventListener('click', async () => {
          const body = (sendInput.value || '').trim();
          if (!body) return;
          sendBtn.textContent = '…';
          try {
            await cfg.sendMessage(d.id, body);
            sendInput.value = '';
            loadThread(d.id);
          } catch (e) {
            console.warn('[md3] send failed', e);
            sendBtn.textContent = 'Send failed';
            setTimeout(() => { sendBtn.textContent = 'Send'; }, 1500);
            return;
          }
          sendBtn.textContent = 'Send';
        });
      }
    }

    async function loadThread(entityId) {
      const $th = $right.querySelector('[data-thread]');
      if (!$th) return;
      try {
        const msgs = await cfg.getThread(entityId);
        if (!msgs || !msgs.length) { $th.innerHTML = '<div class="md3-thread__empty">No messages yet.</div>'; return; }
        $th.innerHTML = msgs.map(m =>
          '<div class="md3-thread__msg">'
          + '<div class="md3-thread__meta">' + esc(m.from_user) + ' · ' + esc(fmtAgo(m.sent_at || m.created_at)) + (m.priority === 'urgent' ? ' · URGENT' : '') + '</div>'
          + esc(m.body)
          + '</div>'
        ).join('');
        $th.scrollTop = $th.scrollHeight;
      } catch (e) {
        $th.innerHTML = '<div class="md3-thread__empty" style="color:#f85149">Load error: ' + esc(e.message) + '</div>';
      }
    }

    loadLeft();
    return { reload: loadLeft };
  }

  // ensureStyles: lets a read-only sibling view (e.g. KEY PARTNERS) reuse the
  // exact md3 look without duplicating CSS. Idempotent (injectStyleOnce guards).
  window.CCMasterDetail = { mount, ensureStyles: injectStyleOnce };
})();
