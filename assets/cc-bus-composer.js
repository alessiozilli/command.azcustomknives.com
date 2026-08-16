/* ════════════════════════════════════════════════════════════════════════
   cc-bus-composer.js — the ONE shared bus message composer (bus #2081 follow-up,
   Alessio direct 2026-06-04).

   This is an exact, reusable copy of the SHOP › INTERNS "Project Bus" composer
   (the labelled box with: to: recipient select, a channel-type chip row
   — general / task / question / fyi / escalation — a textarea, and a Send button).
   Alessio wants that identical interface in every bus, so it lives here once and
   is mounted everywhere instead of being re-typed per surface (CC_DESIGN_SYSTEM
   §2.5 find-and-extend, never duplicate).

   The universal mic (assets/cc-mic.js) auto-attaches to the textarea, so the
   mic comes for free — same as the Interns box.

   Two ways to mount:
   1. Declarative (static HTML surfaces — QuadFang, Blue Building):
        <div data-bus-composer
             data-project-slug="blue-building-cowork"
             data-on-sent="renderBbBus"
             data-label="New bus message"></div>
      CCBusComposer.scan() runs on load and fills every such div.
   2. Programmatic (JS-built surfaces — Heat Treat, After-Hours):
        CCBusComposer.mount(hostEl, {
          projectSlug: 'azck-shop-office-cowork',
          getSlug() { return 'azck-shop-office-cowork'; },   // optional dynamic slug
          buildBody(text) { return '[' + slug + '] ' + text; }, // optional
          extraFields() { return { plan_id: id }; },            // optional FKs
          defaultTo: 'forge-cowork',
          onSent() { loadBus(); }
        });

   The composer NEVER renders the message thread — every surface keeps its own
   list/thread below the composer and refreshes it via opts.onSent.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var RECIPIENTS = ['forge-cowork', 'forge-code', 'forge-design', 'reanna', 'alessio'];
  var RECIPIENT_LABELS = { 'alessio': 'alessio (note to self)' };
  var CHANNELS = ['general', 'task', 'question', 'fyi', 'escalation'];

  // ── Scoped CSS — copied value-for-value from the Interns composer so the box
  //    is pixel-identical anywhere it mounts (the Interns rules are scoped under
  //    [data-subtab="interns"], which is why we re-declare them unscoped here). ──
  function injectCSS() {
    if (document.getElementById('ccbc-style')) return;
    var css = ''
      + '[data-bus-composer] { flex-shrink:0; }'  // host stays fixed-height at the top of the bus column
      + '.ccbc { flex-shrink:0; background:var(--bg); padding:var(--sp-10,10px); border:1px solid var(--border); border-radius:4px; margin-bottom:var(--sp-10,10px); display:flex; flex-direction:column; gap:var(--sp-6,6px); }'
      + '.ccbc__label { font-family:var(--mono); font-size:9px; color:var(--text-xs); letter-spacing:0.06em; text-transform:uppercase; }'
      + '.ccbc__row { display:flex; gap:var(--sp-6,6px); align-items:center; flex-wrap:wrap; }'
      + '.ccbc__to-label { font-family:var(--mono); font-size:10px; color:var(--text-xs); }'
      + '.ccbc__to { background:var(--bg); color:var(--text); border:1px solid var(--border); height:28px; font-size:11px; padding:0 6px; }'
      + '.ccbc__chan-row { display:flex; gap:4px; flex-wrap:wrap; }'
      + '.ccbc__chan { font-family:var(--mono); font-size:9px; padding:3px 8px; background:var(--raised); color:var(--text-dim); border:1px solid var(--border); border-radius:3px; text-transform:uppercase; letter-spacing:0.08em; cursor:pointer; user-select:none; }'
      + '.ccbc__chan:hover { color:var(--amber); border-color:var(--amber); }'
      + '.ccbc__chan.active { background:var(--amber); color:#000; border-color:var(--amber); }'
      + '.ccbc__text { width:100%; box-sizing:border-box; background:var(--bg); color:var(--text); border:1px solid var(--border); padding:6px 8px; font-family:var(--sans); font-size:12px; line-height:1.4; min-height:60px; max-height:400px; resize:vertical; }'
      + '.ccbc__text:focus { outline:none; border-color:var(--amber); }'
      + '.ccbc__send { align-self:flex-start; background:var(--amber); color:#000; border:0; padding:6px 14px; font-family:var(--mono); font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; cursor:pointer; height:28px; }'
      + '.ccbc__send:hover { background:var(--amber-hi,#ffb000); }'
      + '.ccbc__send:disabled { background:var(--muted); cursor:wait; }'
      // narrow columns: let the chip/recipient rows wrap (mirrors index.html line 141 rule)
      + '@media (max-width:1100px){ .ccbc__row, .ccbc__chan-row { flex-wrap:wrap; } }';
    var tag = document.createElement('style');
    tag.id = 'ccbc-style';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function buildMarkup(opts) {
    var recipients = opts.recipients || RECIPIENTS;
    var channels = opts.channels || CHANNELS;
    var defaultTo = opts.defaultTo || recipients[0];
    var label = opts.label || 'New bus message';
    var placeholder = opts.placeholder || 'Type a message to log on the project bus…';

    var optionsHtml = recipients.map(function (r) {
      var lbl = RECIPIENT_LABELS[r] || r;
      return '<option value="' + esc(r) + '"' + (r === defaultTo ? ' selected' : '') + '>' + esc(lbl) + '</option>';
    }).join('');

    var chipsHtml = channels.map(function (c, i) {
      var on = (i === 0);
      return '<button type="button" class="ccbc__chan' + (on ? ' active' : '') + '" data-chan="' + esc(c) + '"'
        + ' role="radio" aria-checked="' + (on ? 'true' : 'false') + '">' + esc(c) + '</button>';
    }).join('');

    return ''
      + '<div class="ccbc">'
      + '<label class="ccbc__label">' + esc(label) + '</label>'
      + '<div class="ccbc__row"><span class="ccbc__to-label">to:</span>'
      + '<select class="ccbc__to">' + optionsHtml + '</select></div>'
      + '<div class="ccbc__chan-row" role="radiogroup" aria-label="Channel type">' + chipsHtml + '</div>'
      + '<textarea class="ccbc__text" placeholder="' + esc(placeholder) + '"></textarea>'
      + '<button type="button" class="ccbc__send">Send to bus</button>'
      + '</div>';
  }

  function activeChan(rootEl) {
    var on = rootEl.querySelector('.ccbc__chan.active');
    return (on && on.dataset.chan) || 'general';
  }

  // ── Draft persistence (Alessio 2026-06-08): the host's innerHTML is rebuilt on
  //    every surface re-render (the 60s dashboard refresh, realtime, tab switch),
  //    which used to WIPE in-progress writing. Persist the draft per surface so a
  //    refresh never loses it; clear only on a successful send.
  function draftKey(opts) {
    var base = opts.draftKey || opts.projectSlug
      || (typeof opts.getSlug === 'function' ? opts.getSlug() : '') || opts.label || 'default';
    return 'ccbc-draft:' + base;
  }
  function loadDraft(opts) { try { return JSON.parse(localStorage.getItem(draftKey(opts)) || 'null'); } catch (e) { return null; } }
  function saveDraft(opts, d) {
    try {
      if (d && (d.text || '').trim().length) localStorage.setItem(draftKey(opts), JSON.stringify(d));
      else localStorage.removeItem(draftKey(opts));
    } catch (e) {}
  }
  function clearDraft(opts) { try { localStorage.removeItem(draftKey(opts)); } catch (e) {} }

  // Wire the chip radio behaviour + the Send button for one mounted composer.
  function wire(hostEl, opts) {
    var chanRow = hostEl.querySelector('.ccbc__chan-row');
    if (chanRow) {
      chanRow.addEventListener('click', function (e) {
        var btn = e.target.closest('.ccbc__chan');
        if (!btn) return;
        chanRow.querySelectorAll('.ccbc__chan').forEach(function (b) {
          var sel = (b === btn);
          b.classList.toggle('active', sel);
          b.setAttribute('aria-checked', sel ? 'true' : 'false');
        });
      });
    }

    var sendBtn = hostEl.querySelector('.ccbc__send');
    var ta = hostEl.querySelector('.ccbc__text');
    var toSel = hostEl.querySelector('.ccbc__to');
    if (!sendBtn || !ta || !toSel) return;

    // Save the draft on every change so a re-render/refresh can restore it.
    function persistDraft() { saveDraft(opts, { text: ta.value, to: toSel.value, chan: activeChan(hostEl) }); }
    ta.addEventListener('input', persistDraft);
    toSel.addEventListener('change', persistDraft);
    if (chanRow) chanRow.addEventListener('click', persistDraft);

    sendBtn.addEventListener('click', function () {
      var text = (ta.value || '').trim();
      if (!text) return;
      if (!window.supa) { alert('Database not ready yet — try again in a sec.'); return; }
      var to = toSel.value || opts.defaultTo || RECIPIENTS[0];
      var chan = activeChan(hostEl);
      var bodyText = (typeof opts.buildBody === 'function') ? opts.buildBody(text) : text;

      var old = sendBtn.textContent;
      function fail(e) {
        console.warn('[ccbc] send failed', e);
        sendBtn.style.background = '#f85149';
        sendBtn.textContent = '(failed)';
        setTimeout(function () { sendBtn.style.background = ''; sendBtn.textContent = old; sendBtn.disabled = false; }, 1800);
      }
      function done() {
        ta.value = '';
        clearDraft(opts);
        sendBtn.disabled = false;
        sendBtn.textContent = old;
        if (typeof opts.onSent === 'function') { try { opts.onSent(); } catch (e) { /* surface refresh is best-effort */ } }
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';

      // Delegated send (opts.onSend) — for surfaces that own their insert logic
      // (e.g. OPERATOR detail pane: per-row FKs + project_slug via cfg.sendMessage).
      // The composer still collects to: + channel + body and hands them over.
      if (typeof opts.onSend === 'function') {
        Promise.resolve(opts.onSend({ toUser: to, channel: chan, body: bodyText }))
          .then(function (res) { if (res && res.error) throw res.error; done(); })
          .catch(fail);
        return;
      }

      // Default path — the component does the agent_messages insert itself.
      var slug = (typeof opts.getSlug === 'function') ? opts.getSlug() : opts.projectSlug;
      if (!slug) { console.warn('[ccbc] no project_slug — abort send'); sendBtn.disabled = false; sendBtn.textContent = old; return; }
      var payload = {
        // WHO IS SENDING. Never hardcode a name here.
        // This file is the ONE source mirrored into every face (lane-split 5,
        // Alessio's pick 2026-08-15). command.azcustomknives.com is signed into
        // by BOTH humans — admin@ is Reanna's seat — so the sender must come
        // from the session, or her words get posted under his name
        // (feedback_never_presign_as_alessio). A face with no identity helper
        // falls through to 'alessio', which is exactly what it always did, so
        // this line is a no-op there and correct on command.
        from_user: (typeof window.CC_BUS_IDENTITY === 'function' ? window.CC_BUS_IDENTITY() : 'alessio'),
        to_user: to,
        channel: chan,
        priority: 'normal',
        body: bodyText,
        status: 'sent',
        awaiting_reply_from: to,
        project_slug: slug
      };
      if (typeof opts.extraFields === 'function') {
        var extra = opts.extraFields() || {};
        for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k]; }
      }
      window.supa.from('agent_messages').insert(payload).select('id').single()
        .then(function (res) { if (res && res.error) throw res.error; done(); })
        .catch(fail);
    });
  }

  // ── Public: mount the composer into a host element ──────────────────────
  function mount(hostEl, opts) {
    if (!hostEl) return;
    opts = opts || {};
    injectCSS();
    hostEl.style.flexShrink = '0'; // pin the composer at the top of its bus column (covers programmatic hosts too)
    hostEl.innerHTML = buildMarkup(opts);
    hostEl.setAttribute('data-ccbc-mounted', '1');
    wire(hostEl, opts);
    // Restore an in-progress draft so a refresh/re-render doesn't lose the writing.
    var _d = loadDraft(opts);
    if (_d) {
      var _ta = hostEl.querySelector('.ccbc__text'); if (_ta && _d.text) _ta.value = _d.text;
      var _to = hostEl.querySelector('.ccbc__to'); if (_to && _d.to) _to.value = _d.to;
      if (_d.chan) {
        var _chip = hostEl.querySelector('.ccbc__chan[data-chan="' + _d.chan + '"]');
        if (_chip) hostEl.querySelectorAll('.ccbc__chan').forEach(function (b) {
          var s = (b === _chip); b.classList.toggle('active', s); b.setAttribute('aria-checked', s ? 'true' : 'false');
        });
      }
    }
  }

  // ── Public: scan for declarative [data-bus-composer] mount points ───────
  function scan(root) {
    (root || document).querySelectorAll('[data-bus-composer]:not([data-ccbc-mounted])').forEach(function (el) {
      var onSentName = el.getAttribute('data-on-sent');
      mount(el, {
        projectSlug: el.getAttribute('data-project-slug'),
        defaultTo: el.getAttribute('data-default-to') || undefined,
        label: el.getAttribute('data-label') || undefined,
        placeholder: el.getAttribute('data-placeholder') || undefined,
        onSent: onSentName ? function () { if (typeof window[onSentName] === 'function') window[onSentName](); } : undefined
      });
    });
  }

  window.CCBusComposer = { mount: mount, scan: scan, RECIPIENTS: RECIPIENTS, CHANNELS: CHANNELS };

  // Fill declarative mount points on load (the static HTML surfaces — their
  // divs exist even inside hidden subpanes, so one scan mounts them all).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(document); });
  } else {
    scan(document);
  }
})();
