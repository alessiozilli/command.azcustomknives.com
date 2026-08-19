// cc-bus.js — THE bus. One surface, one renderer.
// Renamed off "v2" on 2026-08-19 (bus #5735, his order): there was never a v1 in
// service - it was archived 2026-07-12 - so the version number named nothing.
// Reads from public.agent_messages, decorates rows that reference a forge_plans UUID
// with an inline approve/bounce/open action bar. Never touches cc-bus-panel.js or the
// existing Buses subtab. Pure additive — scoped to #bus-mount.
//
// Built per bus #1334 + amendment #1351 spec · forge-code Opus 4.7 on beast.
// Layout: 220px filter sidebar | main column (header bar + list + sticky composer).

(function () {
  'use strict';

  var MOUNT_ID = 'bus-mount';
  var REFRESH_MS = 30000;
  // 400 covers every bucket's real size today (the biggest is the machine room at
  // ~324). If a bucket ever outgrows it the list says so out loud at the bottom —
  // see the overflow line in paintAll. A cap he cannot see is a lie by omission.
  var ROW_LIMIT = 400;
  var SYSLOG_LIMIT = 60;    // the right-hand system log, lane 'log', archived or not
  var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  var BROWSER_SESSION_KEY = 'cc.browser.session_id';

  // ─── Browser session plumbing ──────────────────────────────────────────
  // Every bus posted from the CC composer carries the browser's session_id
  // as from_instance_id, so the bus can group/label by instance + intent.
  function genUuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    (window.crypto || { getRandomValues: function (a) { for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); } }).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function getOrCreateBrowserSessionId() {
    try {
      var existing = localStorage.getItem(BROWSER_SESSION_KEY);
      if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    } catch (e) {}
    var fresh = genUuid();
    try { localStorage.setItem(BROWSER_SESSION_KEY, fresh); } catch (e) {}
    return fresh;
  }
  var BROWSER_SESSION_ID = null;
  async function registerBrowserSession(client) {
    BROWSER_SESSION_ID = getOrCreateBrowserSessionId();
    if (!client) return;
    try {
      // UPSERT — keep last_seen fresh, only set started_at on first INSERT.
      var nowIso = new Date().toISOString();
      await client.from('forge_sessions').upsert({
        id: BROWSER_SESSION_ID,
        instance: 'alessio',
        device: 'browser',
        model: 'cc-ui',
        status: 'active',
        last_seen: nowIso,
        intent: 'CC bus composer · browser tab'
      }, { onConflict: 'id', ignoreDuplicates: false });
    } catch (e) {
      // RLS may block INSERT — non-fatal; from_instance_id still flows through.
    }
  }

  // ─── Instance color coding (single source of truth) ────────────────────
  var INSTANCE_COLORS = {
    'forge-code':    { color: 'var(--blue, #4493d4)',  bg: 'var(--blue-bg, rgba(68,147,212,0.12))'  },
    'forge-cowork':  { color: 'var(--amber, #c8922a)', bg: 'var(--amber-soft, rgba(200,146,42,0.08))' },
    'forge-design':  { color: '#b87de8',               bg: 'rgba(184,125,232,0.12)' },
    'forge-local':   { color: '#3ec1c9',               bg: 'rgba(62,193,201,0.12)' },
    'sentinel':      { color: '#e06c9f',               bg: 'rgba(224,108,159,0.12)' },
    'reanna':        { color: 'var(--green, #2ea043)', bg: 'var(--green-bg, rgba(46,160,67,0.12))' },
    'alessio':       { color: 'var(--red, #e5534b)',   bg: 'var(--red-bg, rgba(229,83,75,0.12))' }
  };
  /* ─── What is this a reply TO? (bus #3949) ────────────────────────────────
     The Reply button worked from day one — 15 of 20 of Reanna's rows carried a
     parent_id. The DATA was threaded; the SCREEN was not, so Alessio saw a wall
     of bare "Got it · Done" with no idea what any of them answered. A one-word
     reply is fine; it is only useless when you cannot see the question. */
  var PARENT_MAP = {};
  function parentGist(row) {
    if (!row) return '';
    if (row.short_summary) return String(row.short_summary);
    // No summary: take the first line of the body that reads like a sentence,
    // skipping the "from: · to: · project:" header line dispatches carry.
    var lines = String(row.body || '').split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l && l.indexOf('from:') !== 0 && l.indexOf('re: #') !== 0; });
    return (lines[0] || '').replace(/^[*#>\s]+/, '');
  }
  async function loadParents(client, rows) {
    var want = {};
    (rows || []).forEach(function (r) { if (r.parent_id) want[r.parent_id] = true; });
    var have = {};
    (rows || []).forEach(function (r) { if (want[r.id]) have[r.id] = r; });
    var missing = Object.keys(want).filter(function (id) { return !have[id]; }).map(Number);
    if (missing.length) {
      try {
        var res = await client.from('agent_messages')
          .select('id,from_user,short_summary,body').in('id', missing);
        (res.data || []).forEach(function (r) { have[r.id] = r; });
      } catch (e) { /* the line is a nicety — never break the panel over it */ }
    }
    var map = {};
    Object.keys(have).forEach(function (id) {
      map[id] = { from: have[id].from_user, gist: parentGist(have[id]) };
    });
    return map;
  }
  // ─── DRAFTS: in-flight replies that outlive every repaint ──────────────
  // Alessio, 2026-08-11: "if I open a reply up, I want to be able to keep that
  // window open through refreshes. The whole refresh needs to keep me on the
  // same page — it always kicks me back."
  // An open reply used to be pure DOM: the panel's .hidden class, the typed
  // text, the forward target and the armed Close flag all lived on the card and
  // died the moment anything rewrote the list — the 30s poll, a realtime insert,
  // pressing Done, changing a filter. Now every one of those is a record here,
  // written on every keystroke, mirrored to localStorage, and re-emitted by
  // renderCard. That is why a draft now survives a repaint AND a browser reload.
  var DRAFTS_KEY = 'cc.bus.v2.drafts';
  var DRAFTS = (function () {
    try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  })();
  function draftsSave() {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(DRAFTS)); } catch (e) {}
  }
  function draftGet(msgId) { return DRAFTS[String(msgId)] || null; }
  function draftSet(msgId, patch) {
    var k = String(msgId);
    DRAFTS[k] = Object.assign({ text: '', fwdTo: null, armed: false }, DRAFTS[k] || {}, patch || {});
    draftsSave();
    return DRAFTS[k];
  }
  function draftClear(msgId) { delete DRAFTS[String(msgId)]; draftsSave(); }
  function draftHasText(msgId) {
    var d = draftGet(msgId);
    return !!(d && String(d.text || '').trim());
  }

  // ─── Thread folding (Alessio ratified 2026-08-10) ──────────────────────
  // A reply never stands alone: the whole exchange stacks as a chat on its
  // ROOT card. root_id is trigger-stamped in the DB (bus_auto_thread) and a
  // reply inherits the root's project/task/plan. THREAD_MAP.replies[rootId]
  // holds every reply ASC; THREAD_MAP.roots holds root rows older than the
  // fetch window so a fresh reply can still summon its original card.
  var THREAD_MAP = { replies: {}, roots: {} };
  var ROW_COLS = 'id,from_user,to_user,from_instance,from_instance_id,channel,priority,body,status,parent_id,sent_at,created_at,archived_at,awaiting_reply_from,thread_id,saved_at,flag_color,lane,root_id,project_slug';
  async function loadThreads(client, rows) {
    var map = { replies: {}, roots: {} };
    var rootIds = {};
    rows.forEach(function (r) {
      // A root row is the one every reply hangs off. Seed the map with every row
      // we already hold so a root that IS in the window is never re-fetched, and
      // one that is not gets pulled in below.
      map.roots[String(r.id)] = r;
      if (r.root_id) rootIds[String(r.root_id)] = true;
      else rootIds[String(r.id)] = true;   // any non-reply row may be a thread root
    });
    var ids = Object.keys(rootIds).map(Number).filter(function (n) { return n > 0; });
    if (!ids.length) return map;
    try {
      var rep = await client.from('agent_messages')
        .select(ROW_COLS)
        .in('root_id', ids).order('sent_at', { ascending: true }).limit(400);
      (rep.data || []).forEach(function (r) {
        var k = String(r.root_id);
        (map.replies[k] = map.replies[k] || []).push(r);
      });
      // Fetch every root we do not already hold. Reachability must NOT depend on
      // the root surviving a filter or the fetch window — a thread whose opening
      // message is done/archived/off-window still has to render as one card.
      var missingRoots = Object.keys(map.replies).filter(function (k) { return !map.roots[k]; }).map(Number);
      if (missingRoots.length) {
        var rr = await client.from('agent_messages')
          .select(ROW_COLS)
          .in('id', missingRoots);
        (rr.data || []).forEach(function (r) { map.roots[String(r.id)] = r; });
      }
    } catch (e) { /* on failure threads render flat, nothing is lost */ }
    return map;
  }

  function replyContextHtml(msg) {
    if (!msg || !msg.parent_id) return '';
    var p = PARENT_MAP[msg.parent_id];
    var gist = p ? p.gist : '';
    if (gist.length > 110) gist = gist.slice(0, 110) + '…';
    return '<button type="button" class="cc-bus__replyctx" data-act="jump-parent" ' +
      'data-parent="' + escapeHtml(String(msg.parent_id)) + '" ' +
      'title="Jump to the message this answers">↳ replying to #' + escapeHtml(String(msg.parent_id)) +
      (p ? ' · <span style="color:' + instColor(p.from).color + '">' + escapeHtml(p.from) + '</span>' : '') +
      (gist ? ' — ' + escapeHtml(gist) : '') + '</button>';
  }

  /* An UNANSWERED ASK: a row addressed to a human, still 'sent', with no reply
     pointing at it anywhere in the loaded set (bus #3918 item 5). */
  function rowById(id) {
    var n = Number(id);
    for (var i = 0; i < ALL_ROWS.length; i++) if (Number(ALL_ROWS[i].id) === n) return ALL_ROWS[i];
    return null;
  }
  function isUnansweredAsk(id) {
    var r = rowById(id);
    if (!r) return false;
    var toHuman = ['alessio', 'reanna', 'team'].indexOf(String(r.to_user || '').toLowerCase()) !== -1;
    if (!toHuman || r.status !== 'sent') return false;
    var n = Number(id);
    for (var i = 0; i < ALL_ROWS.length; i++) if (Number(ALL_ROWS[i].parent_id) === n) return false;
    return true;
  }

  function instColor(name) {
    var k = String(name || '').toLowerCase();
    return INSTANCE_COLORS[k] || { color: 'var(--text-dim, #8a9aa8)', bg: 'transparent' };
  }
  var ALL_INSTANCES = ['forge-code', 'forge-cowork', 'forge-design', 'reanna', 'alessio'];

  // ─── Persistent filter state ───────────────────────────────────────────
  var STATE_KEYS = {
    // The v2 in these keys is history, not a version: renaming them would throw away
    // every reply he has half-typed and every pick he has made. The keys stay.
    bucket:   'cc.bus.v2.bucket',
    lane:     'cc.bus.v2.channel',
    sender:   'cc.bus.v2.filter.sender',
    channel:  'cc.bus.v2.filter.channel',
    status:   'cc.bus.v2.filter.status',
    priority: 'cc.bus.v2.filter.priority',
    search:   'cc.bus.v2.filter.search'
  };
  function lsGet(k, dflt) {
    try { var v = localStorage.getItem(k); return v == null ? dflt : v; } catch (e) { return dflt; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v == null ? '' : String(v)); } catch (e) {}
  }
  // ─── THE PER-FACE KNOB ────────────────────────────────────────────────
  // This file is the ONE source mirrored into every face (lane-split 5,
  // Alessio's pick 2026-08-15). The faces are NOT identical and must not be
  // flattened: Alessio's face wakes on BOTH (the split view), command wakes on
  // AZ so infrastructure chatter does not clog the business side — his call,
  // 2026-08-10. That difference now lives in the PAGE, not in a second copy of
  // this file. Each face sets window.CC_FACE_CONFIG before loading this script.
  // No config = 'both', which is what every face did before this existed.
  var FACE = window.CC_FACE_CONFIG || {};

  // ─── HIS FILTERS ─────────────────────────────────────────────────────
  // Bus #5735, 2026-08-19. The old first column filtered on the SYSTEM taxonomy —
  // agent_messages.lane: cross / ai / log / local / human / intern. Thirty days of
  // proof that it was machine-facing: lane='human' held 45 rows while 567 rows were
  // actually addressed to him. That is exactly why his board kept showing him buses
  // that were never his, and why he deleted the whole column on 2026-08-18.
  //
  // These six ask a different question: WHO IS IT FOR. Every one is derived from the
  // data, and — this is the part that stops it going stale — each is defined ONCE.
  // The same builder feeds the count on the button AND the query behind the list, so
  // the number cannot disagree with what clicking it produces. There is no second
  // definition to drift.
  //
  // The face decides whose board this is. Reanna's face is the same component with
  // her name in it; the command face is the business surface and answers to him.
  var ME = (FACE.face === 'reanna') ? 'reanna' : 'alessio';
  var MINE = [ME, 'team'];

  // Machine bookkeeping that is addressed to a human but is not FOR one.
  //
  // ONLY the AUTO: prefix, and that is deliberate. The first cut of this also threw
  // out anything containing "daily health" or "digest" anywhere in the body, which is
  // a word-match standing in for the thing itself. Checked against the data: not one
  // machine health or digest post is addressed to him — they go to 'team' — while TEN
  // real messages to him in a fortnight mention those words in a sentence ("I read
  // your 2 pm meeting from your daily digest"). That filter would have taken ten of
  // his own messages out of his inbox and dropped them in the machine room.
  //
  // AUTO: is anchored at the start and is a marker the machines actually write, so it
  // cannot catch a sentence about a subject.
  function notNoise(q) {
    return q.not('body', 'like', 'AUTO:%');
  }
  function sevenDaysAgo() {
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  var BUCKETS = [
    { id: 'needs',   label: 'Needs me',     hint: 'waiting on you',
      apply: function (q) {
        return q.is('archived_at', null).eq('status', 'sent')
                .like('body', 'HUMAN ACTION%').in('to_user', MINE);
      } },
    { id: 'tome',    label: 'To me',        hint: 'addressed to you',
      apply: function (q) { return notNoise(q.is('archived_at', null).eq('to_user', ME)); } },
    { id: 'team',    label: 'Team',         hint: 'addressed to the team',
      apply: function (q) { return notNoise(q.is('archived_at', null).eq('to_user', 'team')); } },
    { id: 'fromme',  label: 'From me',      hint: 'sent by you',
      apply: function (q) { return q.is('archived_at', null).eq('from_user', ME); } },
    { id: 'handled', label: 'Handled',      hint: 'dealt with, last 7 days',
      apply: function (q) {
        return q.in('to_user', MINE).in('status', ['read', 'archived'])
                .gte('created_at', sevenDaysAgo());
      } },
    // EVERYTHING ELSE LANDS HERE, ON PURPOSE. A message shape nobody has seen before
    // matches none of the five above and falls through to this one — visible, at the
    // bottom, never silently dropped off the board.
    { id: 'machine', label: 'Machine room', hint: 'seat to seat — not yours to answer',
      quiet: true,
      apply: function (q) {
        // Exactly the complement of To me / Team / From me — the same AUTO: marker,
        // nothing wider. If this list and notNoise ever disagree, a row lands in both
        // buckets or in neither, and neither of those is something he can see.
        return q.is('archived_at', null).neq('from_user', ME)
                .or('to_user.not.in.(' + MINE.join(',') + '),body.like.AUTO:*');
      } }
  ];
  function bucketById(id) {
    for (var i = 0; i < BUCKETS.length; i++) if (BUCKETS[i].id === id) return BUCKETS[i];
    return null;
  }

  // Sender, channel, status and priority stayed pinned to 'all' when their buttons
  // were deleted on 2026-08-18, and they stay pinned now — rowMatches still reads
  // them, so every one of those gates falls straight through. A pick left in his
  // browser from weeks ago can never filter a board that has no button to undo it.
  var STATE = {
    bucket:   lsGet(STATE_KEYS.bucket, 'tome'),
    lane:     'both',      // the lane switch is gone; nothing narrows the list but the bucket
    sender:   'all',
    channel:  'all',
    status:   'all',
    priority: 'all',
    search:   lsGet(STATE_KEYS.search, '')
  };
  // A stored bucket that no longer exists falls back to his inbox rather than to an
  // empty board he cannot explain.
  if (!bucketById(STATE.bucket)) STATE.bucket = 'tome';

  // The ?priority=urgent hash handler that used to live here is gone with the
  // header pill that was its only caller (2026-08-18). It pinned a priority filter
  // AND flipped the channel to machines, and it wrote both to localStorage — so one
  // click on a pill could leave his board filtered days later. With no filter
  // buttons on screen there would have been nothing to undo it with.

  // ─── Supabase client ───────────────────────────────────────────────────
  function sb() {
    if (window.supa) return window.supa;            // reuse the single shared (refreshing) client
    if (window._sb) return window._sb;
    if (window.supabase && window.supabase.createClient) {
      window._sb = window.supabase.createClient(
        'https://twrlvnfszohyrmivdhre.supabase.co',
        'sb_publishable_xnDjiN2NRly0mU4aRMpLjA_HVqqcjxI',
        { auth: { persistSession: true, autoRefreshToken: false, storageKey: 'sb-twrlvnfszohyrmivdhre-auth-token' } }
      );
      return window._sb;
    }
    return null;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' MDT';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' MDT';
  }

  // ─── Styles ────────────────────────────────────────────────────────────
  function injectStylesOnce() {
    if (document.getElementById('cc-bus-style')) return;
    var css = [
      // Root layout — sidebar (filter) | main (human feed) | syslog (system noise)
      // 2026-06-01 Alessio direct: pull system messages OUT of the human feed.
      // Right col is read-only audit trail; nothing is lost, but the chat stays readable.
      // Three columns: HIS filters, the conversation, the system log. The first
      // column is new (2026-08-19) and is not the old one — that one sliced by the
      // machine's own taxonomy and he deleted it. On a phone the filters ride on
      // top, as a row, because they are how he chooses what he is looking at.
      '#bus-mount { display:grid; grid-template-columns:190px 1fr 400px; gap:var(--sp-16,16px); align-items:stretch; height:100%; min-height:0; }',
      '@media (max-width: 1280px) { #bus-mount { grid-template-columns:180px 1fr 320px; } }',
      '@media (max-width: 1024px) { #bus-mount { grid-template-columns:180px 1fr; } #bus-mount .cc-bus__syslog { display:none; } }',
      '@media (max-width: 820px) { #bus-mount { grid-template-columns:1fr; } #bus-mount .cc-bus__filters { flex-direction:row; flex-wrap:wrap; max-height:none; } #bus-mount .cc-bus__fbtn { flex:1 1 auto; } }',

      // ─── First column: his filters ───
      '#bus-mount .cc-bus__filters { min-height:0; max-height:100%; overflow-y:auto; display:flex; flex-direction:column; gap:3px; padding:var(--sp-10,10px); background:var(--surface,#0f1316); border:1px solid var(--border,#252c33); border-radius:4px; }',
      '#bus-mount .cc-bus__fbtn { display:flex; align-items:baseline; gap:8px; width:100%; background:transparent; border:1px solid transparent; border-radius:3px; padding:7px 9px; cursor:pointer; text-align:left; color:var(--text-dim,#8a9aa8); font-family:var(--sans,sans-serif); font-size:13px; }',
      '#bus-mount .cc-bus__fbtn:hover { background:var(--raised,#161b20); color:var(--text,#dde4eb); }',
      '#bus-mount .cc-bus__fbtn.active { background:var(--amber-soft,rgba(200,146,42,0.08)); color:var(--amber,#c8922a); border-color:var(--amber-glow,rgba(200,146,42,0.15)); }',
      // Zero is not hidden and not styled away — it is shown, dimmed, still clickable.
      // A filter that vanishes when it empties is a filter he cannot trust is there.
      '#bus-mount .cc-bus__fbtn.empty { opacity:0.45; }',
      '#bus-mount .cc-bus__fbtn.quiet { margin-top:auto; }',
      '#bus-mount .cc-bus__fnum { margin-left:auto; font-family:var(--mono,monospace); font-size:13px; font-weight:700; }',
      '#bus-mount .cc-bus__fhint { display:block; font-size:10px; color:var(--text-xs,#566470); letter-spacing:0.02em; margin-top:2px; }',
      '#bus-mount .cc-bus__fsep { height:1px; background:var(--border,#252c33); margin:8px 2px 4px; }',
      '#bus-mount .cc-bus__more { padding:14px 6px; font-family:var(--mono,monospace); font-size:11px; color:var(--text-xs,#6e7681); border-top:1px dashed var(--border,#252c33); margin-top:10px; }',

      // The eight filter-sidebar style rules that lived here are deleted too
      // (2026-08-18). He asked whether the column was really gone or only hidden;
      // nothing styles an element that no longer exists.

      // ─── Main column ───
      '#bus-mount .cc-bus__main { display:flex; flex-direction:column; gap:var(--sp-10,10px); min-width:0; min-height:0; max-height:100%; overflow-y:auto; }',

      // ─── System log column (right side) — 2026-06-01 ─────────────────────
      // Pulls from_user="system" OR channel="fyi" messages out of the main feed
      // so the human chat stays readable. Read-only. Full audit trail kept.
      '#bus-mount .cc-bus__syslog { min-height:0; max-height:100%; overflow:hidden; display:flex; flex-direction:column; background:var(--surface,#0f1316); border:1px solid var(--border,#252c33); border-radius:4px; }',
      '#bus-mount .cc-bus__syslog-head { padding:var(--sp-10,10px) var(--sp-12,12px); border-bottom:1px solid var(--border,#252c33); display:flex; align-items:center; gap:var(--sp-8,8px); flex-shrink:0; background:var(--surface,#0f1316); }',
      '#bus-mount .cc-bus__syslog-title { font-family:var(--display,sans-serif); font-size:11px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:var(--text-dim,#8a9aa8); }',
      '#bus-mount .cc-bus__syslog-count { margin-left:auto; font-family:var(--mono,monospace); font-size:13px; font-weight:700; color:var(--amber,#c8922a); padding:2px 10px; border-radius:10px; background:var(--amber-soft,rgba(200,146,42,0.08)); }',
      '#bus-mount .cc-bus__syslog-list { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:4px; background:var(--bg,#090b0d); min-height:0; }',
      '#bus-mount .cc-bus__syslog-row { padding:5px 8px; background:var(--surface,#0f1316); border:1px solid var(--border,#252c33); border-left:2px solid var(--text-xs,#566470); border-radius:3px; font-family:var(--mono,monospace); font-size:10px; color:var(--text-dim,#8a9aa8); line-height:1.4; word-break:break-word; }',
      '#bus-mount .cc-bus__syslog-row__head { font-size:11px; font-weight:700; color:var(--amber,#c8922a); letter-spacing:0.04em; margin-bottom:3px; display:flex; justify-content:space-between; gap:8px; }',
      '#bus-mount .cc-bus__syslog-row__head .to { color:var(--text-dim,#8a9aa8); }',
      '#bus-mount .cc-bus__syslog-row__body { white-space:pre-wrap; word-break:break-word; }',
      '#bus-mount .cc-bus__syslog-empty { font-family:var(--mono,monospace); font-size:10px; color:var(--text-xs,#566470); text-align:center; padding:16px; border:1px dashed var(--border,#252c33); border-radius:3px; }',

      // ─── Top stack (header + composer pinned as one block) ───
      // Alessio direct 2026-05-17: header must not disappear, and no gap can
      // leak the scrolling cards. top uses a CSS custom property set at
      // runtime by updateStickyOffset() so we abut cc-subnav.bottom exactly
      // even if it wraps to two rows. Opaque var(--bg) blocks cards behind.
      '#bus-mount .cc-bus__topstack { position:sticky; top:0; z-index:5; background:var(--bg,#090b0d); display:flex; flex-direction:column; gap:var(--sp-10,10px); padding-top:var(--sp-8,8px); padding-bottom:var(--sp-4,4px); }',

      // ─── Header bar (title + count + search) ───
      '#bus-mount .cc-bus__header { display:flex; align-items:center; gap:var(--sp-10,10px); padding-bottom:var(--sp-8,8px); border-bottom:1px solid var(--border,#252c33); flex-wrap:wrap; }',
      '#bus-mount .cc-bus__header-title { font-family:var(--display,sans-serif); font-size:11px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__header-count { font-family:var(--mono,monospace); font-size:13px; font-weight:700; color:var(--amber,#c8922a); background:var(--amber-soft,rgba(200,146,42,0.08)); padding:2px 10px; border-radius:10px; }',
      '#bus-mount .cc-bus__header-search { margin-left:auto; width:240px; max-width:100%; background:var(--bg,#090b0d); color:var(--text,#dde4eb); border:1px solid var(--border,#252c33); border-radius:3px; padding:5px 10px; font-family:var(--mono,monospace); font-size:11px; }',
      '#bus-mount .cc-bus__header-search:focus { outline:none; border-color:var(--amber,#c8922a); }',

      // ─── Lane tabs (2026-07-19) — Human/AI/Log/All inside the header row ───

      // ─── Bus list ───
      '#bus-mount .cc-bus__list { display:flex; flex-direction:column; gap:var(--sp-10,10px); }',
      '#bus-mount .cc-bus-card { background:var(--surface,#0f1316); border:1px solid var(--border,#252c33); border-radius:4px; padding:var(--sp-12,12px) var(--sp-16,16px); position:relative; overflow:hidden; }',
      '#bus-mount .cc-bus-card:hover { border-color:var(--border-hi,#2e3740); }',
      '#bus-mount .cc-bus-card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:2px; background:var(--stripe, var(--text-xs,#566470)); }',
      '#bus-mount .cc-bus-card.is-archived::before { opacity:0.35; }',
      '#bus-mount .cc-bus-card.is-approved::before { background:var(--green,#2ea043) !important; }',

      // ─── Card meta ───
      '#bus-mount .cc-bus__meta { display:flex; align-items:center; gap:10px; margin-bottom:var(--sp-8,8px); flex-wrap:wrap; }',
      '#bus-mount .cc-bus__from { font-family:var(--mono,monospace); font-size:10px; font-weight:700; letter-spacing:0.04em; }',
      '#bus-mount .cc-bus__arrow { font-family:var(--mono,monospace); font-size:10px; color:var(--text-xs,#566470); }',
      '#bus-mount .cc-bus__to { font-family:var(--mono,monospace); font-size:10px; font-weight:500; }',
      // Bus #ID + time bumped 2026-06-01 (Alessio direct: "barely can see them")
      '#bus-mount .cc-bus__id { margin-left:auto; font-family:var(--mono,monospace); font-size:13px; font-weight:700; color:var(--amber,#c8922a); letter-spacing:0.02em; }',
      // "replying to" line (bus #3949) — the question, above the answer.
      '#bus-mount .cc-bus__replyctx { display:block; width:100%; text-align:left; margin:2px 0 6px; padding:5px 9px; background:var(--raised,rgba(255,255,255,0.04)); border:1px solid var(--border,#252c33); border-left:2px solid var(--amber,#c8922a); border-radius:3px; font-family:var(--mono,monospace); font-size:11px; line-height:1.45; color:var(--text-dim,#8a9aa8); cursor:pointer; }',
      '#bus-mount .cc-bus__replyctx:hover { border-color:var(--amber,#c8922a); color:var(--text,#fff); }',
      '#bus-mount .cc-bus__parentbox { margin:0 0 8px; padding:8px 10px; background:var(--surface,#0f1316); border:1px solid var(--border,#252c33); border-radius:4px; font-size:12px; line-height:1.5; color:var(--text-dim,#8a9aa8); white-space:pre-wrap; max-height:280px; overflow-y:auto; }',
      '#bus-mount .cc-bus__parentbox-h { font-family:var(--mono,monospace); font-size:10px; font-weight:700; margin-bottom:5px; }',
      '#bus-mount .cc-bus__card--flash { animation:ccBusFlash 1.4s ease-out; }',
      '@keyframes ccBusFlash { 0%,40% { background:var(--amber-soft,rgba(200,146,42,0.18)); } 100% { background:transparent; } }',
      '#bus-mount .cc-bus__time { font-family:var(--mono,monospace); font-size:11px; font-weight:600; color:var(--text-dim,#8a9aa8); }',
      '#bus-mount .cc-bus__channel { font-family:var(--mono,monospace); font-size:9px; color:var(--text-xs,#566470); text-transform:uppercase; letter-spacing:0.08em; }',
      '#bus-mount .cc-bus__intent { font-family:var(--mono,monospace); font-size:9px; font-style:italic; color:var(--text-xs,#566470); padding:2px 6px; border-radius:8px; background:var(--raised,#161b20); border:1px solid var(--border,#252c33); }',
      '#bus-mount .cc-bus__instance-short { font-family:var(--mono,monospace); font-size:9px; color:var(--text-xs,#566470); opacity:0.7; }',

      // ─── Card body ───
      '#bus-mount .cc-bus__body { font-family:var(--sans,sans-serif); font-size:13px; line-height:1.5; color:var(--text,#dde4eb); white-space:pre-wrap; word-wrap:break-word; margin-bottom:var(--sp-8,8px); }',
      '#bus-mount .cc-bus__body.collapsed { display:-webkit-box; -webkit-line-clamp:10; -webkit-box-orient:vertical; overflow:hidden; }',
      '#bus-mount .cc-bus__readrow { display:flex; align-items:center; gap:8px; margin-bottom:var(--sp-8,8px); }',
      '#bus-mount .cc-bus__read { background:transparent; color:var(--text-dim,#8a9aa8); border:1px solid var(--border,#252c33); border-radius:3px; padding:3px 10px; font-family:var(--mono,monospace); font-size:11px; cursor:pointer; flex-shrink:0; }',
      '#bus-mount .cc-bus__read:hover { color:var(--amber,#c8922a); border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__read.speaking { color:#000; background:var(--amber,#c8922a); border-color:var(--amber,#c8922a); font-weight:700; }',
      '#bus-mount .cc-bus__readall { background:transparent; color:var(--text-dim,#8a9aa8); border:1px solid var(--border,#252c33); border-radius:3px; padding:3px 10px; font-family:var(--mono,monospace); font-size:11px; cursor:pointer; }',
      '#bus-mount .cc-bus__readall:hover { color:var(--amber,#c8922a); border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__readall.speaking { color:#000; background:var(--amber,#c8922a); border-color:var(--amber,#c8922a); font-weight:700; }',
      '#bus-mount .cc-bus__body code { font-family:var(--mono,monospace); font-size:11px; color:var(--amber,#c8922a); background:var(--amber-soft,rgba(200,146,42,0.08)); padding:1px 5px; border-radius:3px; }',
      '#bus-mount .cc-bus__body strong { font-weight:600; color:var(--text,#dde4eb); }',
      '#bus-mount .cc-bus__showmore { font-family:var(--mono,monospace); font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; background:transparent; color:var(--amber,#c8922a); border:1px solid var(--amber-glow,rgba(200,146,42,0.15)); border-radius:3px; padding:4px 10px; cursor:pointer; margin-bottom:var(--sp-10,10px); }',
      '#bus-mount .cc-bus__showmore:hover { background:var(--amber,#c8922a); color:#000; border-color:var(--amber,#c8922a); }',

      // ─── Plan action bar ───
      '#bus-mount .cc-bus__plan-action { background:var(--raised,#161b20); border:1px solid var(--amber-glow,rgba(200,146,42,0.15)); border-left:2px solid var(--amber,#c8922a); border-radius:3px; padding:var(--sp-10,10px) var(--sp-12,12px); margin-top:var(--sp-10,10px); }',
      '#bus-mount .cc-bus__plan-label { font-family:var(--display,sans-serif); font-size:9px; font-weight:600; letter-spacing:0.18em; text-transform:uppercase; color:var(--amber,#c8922a); margin-bottom:var(--sp-8,8px); display:flex; align-items:center; gap:6px; }',
      '#bus-mount .cc-bus__plan-title { font-family:var(--sans,sans-serif); font-size:13px; font-weight:600; color:var(--text,#dde4eb); line-height:1.35; margin-bottom:var(--sp-4,4px); }',
      '#bus-mount .cc-bus__plan-meta { font-family:var(--mono,monospace); font-size:10px; color:var(--text-dim,#8a9aa8); margin-bottom:var(--sp-10,10px); }',
      '#bus-mount .cc-bus__plan-meta .sep { color:var(--text-xs,#566470); margin:0 4px; }',
      '#bus-mount .cc-bus__plan-buttons { display:flex; gap:6px; flex-wrap:wrap; }',
      '#bus-mount .cc-bus__btn { font-family:var(--mono,monospace); font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; border-radius:3px; padding:5px 12px; cursor:pointer; border:1px solid; display:inline-flex; align-items:center; gap:5px; }',
      '#bus-mount .cc-bus__btn--approve { background:var(--amber,#c8922a); color:#000; border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__btn--approve:hover { background:var(--text,#dde4eb); border-color:var(--text,#dde4eb); }',
      '#bus-mount .cc-bus__btn--ghost { background:transparent; color:var(--amber,#c8922a); border-color:var(--amber-glow,rgba(200,146,42,0.15)); }',
      '#bus-mount .cc-bus__btn--ghost:hover { background:var(--amber,#c8922a); color:#000; border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__btn--neutral { background:transparent; color:var(--text-dim,#8a9aa8); border-color:var(--border,#252c33); }',
      '#bus-mount .cc-bus__btn--neutral:hover { color:var(--text,#dde4eb); border-color:var(--border-hi,#2e3740); }',
      '#bus-mount .cc-bus__btn[disabled] { opacity:0.4; cursor:not-allowed; }',
      '#bus-mount .cc-bus__approved { background:var(--green-bg,rgba(46,160,67,0.12)); border:1px solid var(--green,#2ea043); border-left-width:2px; border-radius:3px; padding:var(--sp-10,10px) var(--sp-12,12px); margin-top:var(--sp-10,10px); display:flex; align-items:center; gap:8px; font-family:var(--mono,monospace); font-size:11px; color:var(--green,#2ea043); }',
      '#bus-mount .cc-bus__approved strong { color:var(--text,#dde4eb); font-weight:700; }',
      '#bus-mount .cc-bus__approved .sep { color:var(--text-xs,#566470); margin:0 4px; }',

      // ─── Inline reply (legacy narrow input — kept for "Bounce with edits" flow) ───
      '#bus-mount .cc-bus__reply { display:flex; gap:6px; margin-top:var(--sp-10,10px); }',
      '#bus-mount .cc-bus__reply input { flex:1; background:var(--bg,#090b0d); border:1px solid var(--border,#252c33); color:var(--text,#dde4eb); padding:6px 10px; border-radius:3px; font-family:var(--mono,monospace); font-size:11px; }',
      '#bus-mount .cc-bus__reply input:focus { outline:none; border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__reply.hidden { display:none; }',

      // ─── Per-card actions row (Reply / Archive / Delete) ───
      '#bus-mount .cc-bus__actions { display:flex; gap:6px; margin-top:var(--sp-10,10px); padding-top:var(--sp-8,8px); border-top:1px dashed var(--border,#252c33); }',
      '#bus-mount .cc-bus__act-btn { font-family:var(--mono,monospace); font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; background:transparent; color:var(--text-dim,#8a9aa8); border:1px solid var(--border,#252c33); border-radius:3px; padding:4px 10px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }',
      '#bus-mount .cc-bus__act-btn:hover { color:var(--text,#dde4eb); border-color:var(--border-hi,#2e3740); }',
      '#bus-mount .cc-bus__act-btn--reply:hover { color:var(--amber,#c8922a); border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__act-btn--close:hover { color:var(--amber,#c8922a); border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__act-btn--close.is-armed { color:var(--amber,#c8922a); border-color:var(--amber,#c8922a); background:rgba(200,146,42,0.08); }',
      '#bus-mount .cc-bus__close-hint { display:none; font-family:var(--mono,monospace); font-size:10px; color:var(--amber,#c8922a); font-weight:600; margin-right:auto; }',
      '#bus-mount .cc-bus-card[data-close-on-send="1"] .cc-bus__close-hint { display:inline-block; }',
      '#bus-mount .cc-bus__act-btn--delete:hover { color:var(--red,#e5534b); border-color:var(--red,#e5534b); background:var(--red-bg,rgba(229,83,75,0.12)); }',
      // Done is the finishing action — green, and it stays lit once a thread is closed.
      '#bus-mount .cc-bus__act-btn--done:hover { color:var(--green,#3fb950); border-color:var(--green,#3fb950); background:var(--green-bg,rgba(63,185,80,0.12)); }',
      '#bus-mount .cc-bus__act-btn--done[data-done="1"] { color:var(--green,#3fb950); border-color:var(--green,#3fb950); background:var(--green-bg,rgba(63,185,80,0.12)); }',
      '#bus-mount .cc-bus__act-btn[disabled] { opacity:0.4; cursor:not-allowed; }',

      // ─── Full-width reply panel (NEW — spans entire card, supports dictation) ───
      '#bus-mount .cc-bus__reply-wide { margin-top:var(--sp-10,10px); display:flex; flex-direction:column; gap:6px; }',
      '#bus-mount .cc-bus__reply-wide.hidden { display:none; }',
      '#bus-mount .cc-bus__reply-wide textarea { width:100%; min-height:80px; max-height:240px; resize:vertical; background:var(--bg,#090b0d); color:var(--text,#dde4eb); border:1px solid var(--amber-glow,rgba(200,146,42,0.15)); border-radius:3px; padding:10px 12px; padding-right:42px; font-family:var(--mono,monospace); font-size:12px; line-height:1.5; box-sizing:border-box; }',
      '#bus-mount .cc-bus__reply-wide textarea:focus { outline:none; border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__reply-wide-row { display:flex; align-items:center; gap:8px; }',
      '#bus-mount .cc-bus__reply-wide-hint { font-family:var(--mono,monospace); font-size:9px; color:var(--text-xs,#566470); }',
      '#bus-mount .cc-bus__reply-wide-send { margin-left:auto; }',
      '#bus-mount .cc-bus__reply-wide-cancel { background:transparent; color:var(--text-dim,#8a9aa8); border:1px solid var(--border,#252c33); border-radius:3px; padding:4px 10px; font-family:var(--mono,monospace); font-size:10px; letter-spacing:0.06em; text-transform:uppercase; cursor:pointer; }',

      // ─── Composer (rendered inside .cc-bus__topstack — wrapper handles the stickiness now) ───
      '#bus-mount .cc-bus__composer { background:var(--surface,#0f1316); border:1px solid var(--border,#252c33); border-radius:4px; padding:var(--sp-10,10px); display:flex; flex-direction:column; gap:var(--sp-8,8px); }',
      '#bus-mount .cc-bus__chips { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }',
      '#bus-mount .cc-bus__compose-search { flex:1 1 200px; min-width:140px; background:var(--bg,#090b0d); color:var(--text,#dde4eb); border:1px solid var(--border,#252c33); border-radius:3px; padding:3px 10px; font-family:var(--mono,monospace); font-size:11px; box-sizing:border-box; }',
      '#bus-mount .cc-bus__compose-search:focus { outline:none; border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__chip { font-family:var(--mono,monospace); font-size:10px; font-weight:700; letter-spacing:0.04em; padding:3px 9px; border-radius:12px; border:1px solid; background:transparent; cursor:pointer; }',
      '#bus-mount .cc-bus__compose-input { width:100%; min-height:56px; max-height:200px; resize:vertical; background:var(--bg,#090b0d); color:var(--text,#dde4eb); border:1px solid var(--border,#252c33); border-radius:3px; padding:8px 10px; font-family:var(--mono,monospace); font-size:12px; line-height:1.5; }',
      '#bus-mount .cc-bus__compose-input:focus { outline:none; border-color:var(--amber,#c8922a); }',
      '#bus-mount .cc-bus__compose-row { display:flex; align-items:center; gap:8px; }',
      '#bus-mount .cc-bus__compose-hint { font-family:var(--mono,monospace); font-size:9px; color:var(--text-xs,#566470); }',
      '#bus-mount .cc-bus__compose-send { margin-left:auto; }',

      // ─── Empty + error ───
      '#bus-mount .cc-bus__empty { font-family:var(--mono,monospace); font-size:11px; color:var(--text-xs,#566470); text-align:center; padding:24px; border:1px dashed var(--border,#252c33); border-radius:4px; }',
      '#bus-mount .cc-bus__err { font-family:var(--mono,monospace); font-size:11px; color:var(--red,#e5534b); padding:12px 16px; border:1px solid var(--red,#e5534b); border-radius:4px; background:var(--red-bg,rgba(229,83,75,0.12)); }',

      // ─── Dyslexia-friendly font toggle (default ON = Lexend) — Alessio 2026-05-17.
      //     !important needed because index.html has a universal Oswald rule on body * .
      '#bus-mount .cc-bus__font-toggle { background:transparent; color:var(--amber,#c8922a); border:1px solid var(--amber,#c8922a); border-radius:3px; padding:2px 8px; font-family:var(--display,sans-serif); font-size:9px; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; margin-left:auto; }',
      '#bus-mount .cc-bus__font-toggle:hover { background:var(--amber,#c8922a); color:#000; }',
      '#bus-mount .cc-bus__font-toggle.on { background:var(--amber,#c8922a); color:#000; }',
      '#bus-mount.font-lexend .cc-bus__body { font-family:\'Lexend\', system-ui, sans-serif !important; text-transform:none !important; letter-spacing:0.01em !important; line-height:1.6 !important; }'
    ].join('\n');

    var style = document.createElement('style');
    style.id = 'cc-bus-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ─── Plan-detection logic ──────────────────────────────────────────────
  function extractPlanUuids(body) {
    if (!body) return [];
    var matches = String(body).match(UUID_RE) || [];
    var seen = {};
    return matches.filter(function (u) {
      var k = u.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  async function loadPlans(client, uuids) {
    if (!uuids || !uuids.length) return {};
    try {
      var res = await client.from('forge_plans').select('id,title,status,domain,approved_at,approved_by').in('id', uuids);
      var map = {};
      (res.data || []).forEach(function (p) { map[String(p.id).toLowerCase()] = p; });
      return map;
    } catch (e) {
      return {};
    }
  }

  function pickDraftPlan(msg, planMap) {
    var uuids = extractPlanUuids(msg.body);
    for (var i = 0; i < uuids.length; i++) {
      var p = planMap[uuids[i].toLowerCase()];
      if (p) return p;
    }
    return null;
  }

  // ─── Filtering ─────────────────────────────────────────────────────────
  // laneOf is deleted (2026-08-19). agent_messages.lane is the machine's own
  // taxonomy — cross / ai / log / local / human / intern — and thirty days of it
  // said lane='human' held 45 rows while 567 were addressed to him. Nothing on
  // his board is decided by it any more.

  // ONE predicate for both the list and the sidebar counts (bus #4361-era fix,
  // 2026-08-09): the filters "didn't all work" because the counts and the list
  // used two different definitions — a badge promised rows the click would not
  // show. rowMatches(r, skip) skips exactly one group so each sidebar group can
  // count against every OTHER active filter; the numbers now always equal what
  // clicking produces.
  // ONE GATE LEFT: his search box. Everything else that used to filter here now
  // happens in the query, which is the whole point — a client-side gate on top of a
  // server-side bucket is how a count and a list start lying to each other.
  //
  // This function used to drop archived and done rows on its own. That alone would
  // have made HANDLED count 47 and show 0, because HANDLED asks the database for
  // read and archived rows on purpose. The gate had to go, not be worked around.
  function rowMatches(r, skip) {
    var s = STATE.search.toLowerCase().trim();
    if (skip !== 'search' && s) {
      if (String(r.body || '').toLowerCase().indexOf(s) === -1) return false;
    }
    return true;
  }

  function applyFilters(rows) {
    return rows.filter(function (r) { return rowMatches(r, null); });
  }

  // ─── Card render ───────────────────────────────────────────────────────
  // ─── READ ALOUD (Alessio 2026-07-27) ──────────────────────────────────────
  // "I often have a hard time selecting everything without needing to scroll or
  // show more. I just want a button where it reads the bus."
  // Speaks full message bodies via the browser's speech engine. Nothing to
  // select, nothing to expand. One speaker at a time; pressing Read again (or
  // Stop) cancels whatever is talking.
  var SPEECH = { id: null };
  function speechOk() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }
  // There are two engines now. The Read button must not refuse just because the
  // OS robot is absent — the human voice does not need the OS at all.
  function canSpeak() {
    return speechOk() || !!(window.CCVoice && window.CCVoice.supported());
  }
  // Volume is owned by the CC's own voice slider (#voice-vol, persisted in
  // localStorage as cc_voice_vol, 0..1, default 0.85). Read it fresh for every
  // chunk so dragging the slider mid-playback takes effect on the next
  // sentence instead of after the whole message. (Alessio 2026-07-27: the Read
  // button was playing at full blast while the slider sat at zero.)
  var VOICE_VOL_LS = 'cc_voice_vol';
  function voiceVolume() {
    var v = NaN;
    try { v = parseFloat(localStorage.getItem(VOICE_VOL_LS)); } catch (e) {}
    if (isNaN(v)) v = 0.85;
    return Math.max(0, Math.min(1, v));
  }
  function stopSpeech() {
    if (speechOk()) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    try { window.CCVoice && window.CCVoice.stop(); } catch (e) {}
    SPEECH.id = null;
    resetReadButtons();
  }
  function resetReadButtons() {
    var root = document.getElementById(MOUNT_ID);
    if (!root) return;
    root.querySelectorAll('[data-act="read-body"]').forEach(function (b) {
      b.textContent = '▶ Read';
      b.classList.remove('speaking');
    });
    var all = root.querySelector('[data-act="read-all"]');
    if (all) { all.textContent = '▶ Read bus'; all.classList.remove('speaking'); }
  }
  /* THE HUMAN VOICE FIRST (Alessio 2026-08-19: "make sure all the read buttons
     and each way a bus or a text can come through that can be spoken is
     connected to that new voice"). These Read buttons had their own engine and
     kept talking in the OS robot after the rest of the page had moved on.

     window.CCVoice is Kokoro running in the browser; it exists on his face and
     not on command.azcustomknives.com, which shares this exact file. So this is
     a preference, not a requirement: no CCVoice, engine switched off, model
     refused to load — every one of those falls through to the robot below and
     the button behaves identically. */
  function speak(text, tokenId, onDone) {
    if (!text) return;
    SPEECH.id = tokenId;
    var finish = function () {
      if (SPEECH.id !== tokenId) return;   // a newer Read took over; leave it alone
      SPEECH.id = null;
      resetReadButtons();
      if (onDone) onDone();
    };
    if (window.CCVoice && window.CCVoice.on() && window.CCVoice.supported()) {
      if (speechOk()) { try { window.speechSynthesis.cancel(); } catch (e) {} }
      window.CCVoice.speak(text, voiceVolume()).then(function (spoke) {
        if (spoke) finish();
        else robotSpeak(text, tokenId, onDone);
      }, function () { robotSpeak(text, tokenId, onDone); });
      return;
    }
    robotSpeak(text, tokenId, onDone);
  }

  // Long bodies are split into sentence-sized chunks: some browsers silently
  // stop long utterances, and chunking also makes Stop feel immediate.
  function robotSpeak(text, tokenId, onDone) {
    if (!speechOk() || !text) return;
    window.speechSynthesis.cancel();
    SPEECH.id = tokenId;
    var chunks = String(text)
      .replace(/\s+/g, ' ')
      .match(/[^.!?]+[.!?]*\s*/g) || [String(text)];
    var merged = [];
    chunks.forEach(function (c) {
      if (merged.length && (merged[merged.length - 1] + c).length < 200) merged[merged.length - 1] += c;
      else merged.push(c);
    });
    var i = 0;
    (function next() {
      if (SPEECH.id !== tokenId || i >= merged.length) {
        if (SPEECH.id === tokenId) { SPEECH.id = null; resetReadButtons(); if (onDone) onDone(); }
        return;
      }
      var u = new SpeechSynthesisUtterance(merged[i++]);
      u.rate = 1; u.pitch = 1; u.volume = voiceVolume();
      u.onend = next;
      u.onerror = next;
      window.speechSynthesis.speak(u);
    })();
  }
  // What a listener actually wants to hear: who sent it, then the message.
  function spokenTextFor(card) {
    if (!card) return '';
    var from = card.querySelector('.cc-bus__from');
    var to = card.querySelector('.cc-bus__to');
    var body = card.querySelector('.cc-bus__body');
    var lead = (from ? 'From ' + from.textContent.trim() : '')
             + (to ? ', to ' + to.textContent.trim() + '. ' : '. ');
    return lead + (body ? body.textContent.trim() : '');
  }

  function renderCard(msg, plan, replies) {
    replies = replies || [];
    // Who's in the mix: everyone who has written or been written to on this
    // thread — the original pair plus anyone added later (forward = they join).
    var mix = {};
    [msg].concat(replies).forEach(function (r) {
      if (r && r.from_user) mix[r.from_user] = 1;
      if (r && r.to_user) mix[r.to_user] = 1;
    });
    var mixHtml = replies.length
      ? '<span class="cc-bus__mix" title="everyone in this thread">👥 ' +
        Object.keys(mix).map(function (n) { return '<b style="color:' + instColor(n).color + '">' + escapeHtml(n) + '</b>'; }).join(' · ') + '</span>'
      : '';
    // Reply goes to the last OTHER voice in the thread, not blindly to the root sender.
    var lastOther = msg.from_user || '';
    replies.forEach(function (r) { if (r.from_user && r.from_user !== 'alessio') lastOther = r.from_user; });
    var hasPlanDraft = plan && plan.status === 'draft';
    var hasPlanApproved = plan && plan.status && plan.status !== 'draft';
    var body = String(msg.body || '');
    var bodyLines = body.split('\n').length;
    var needsTruncate = bodyLines > 10 || body.length > 600;
    var bodyClass = needsTruncate ? 'cc-bus__body collapsed' : 'cc-bus__body';
    var showMore = needsTruncate
      ? '<button class="cc-bus__showmore" data-act="toggle-body">▾ Show more</button>'
      : '';
    // Read aloud (Alessio 2026-07-27): selecting a long body by hand is painful,
    // especially while it is clamped to 10 lines. This speaks the WHOLE message,
    // collapsed or not, so nothing has to be expanded or selected first.
    var readBtn = '<button class="cc-bus__read" data-act="read-body" title="Read this message out loud">▶ Read</button>';
    var msgId = String(msg.id);

    var fromColor = instColor(msg.from_user).color;
    var toColor = instColor(msg.to_user).color;
    var cardClasses = ['cc-bus-card'];
    if (hasPlanApproved) cardClasses.push('is-approved');
    if (msg.archived_at) cardClasses.push('is-archived');

    // OPEN ASK (bus #2715 lane 2, 2026-07-12): watchers now stamp delivery and
    // leave human-lane rows status='sent' until someone acts — surface that state.
    var isOpenAsk = (msg.status === 'sent') && ['alessio','reanna','team'].indexOf(String(msg.to_user||'').toLowerCase()) !== -1;
    var openAskTag = isOpenAsk ? '<span class="cc-bus__tag" style="color:#d29922;border:1px solid #d29922;border-radius:3px;padding:0 6px;font-size:10px;letter-spacing:0.05em;">⚑ OPEN ASK</span>' : '';

    // Save + Flag (Alessio 2026-07-11): flagged rows take the flag color as their
    // stripe; saved-but-unflagged take amber. Both survive the 14-day auto-wipe.
    var keepColor = msg.flag_color ? (FLAG_COLORS[msg.flag_color] || null) : (msg.saved_at ? '#d29922' : null);
    var stripeStyle = hasPlanApproved
      ? ''  // green stripe applied via .is-approved class !important rule
      : ' style="--stripe:' + (keepColor || fromColor) + ';"';

    var bodyHtml = escapeHtml(body)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    var planBar = '';
    if (hasPlanDraft) {
      planBar = '' +
        '<div class="cc-bus__plan-action">' +
          '<div class="cc-bus__plan-label">⚡ Plan detected · awaiting your approval</div>' +
          '<div class="cc-bus__plan-title">' + escapeHtml(plan.title || '(untitled plan)') + '</div>' +
          '<div class="cc-bus__plan-meta">' +
            escapeHtml(plan.id) +
            (plan.domain ? '<span class="sep">·</span> domain: ' + escapeHtml(plan.domain) : '') +
          '</div>' +
          '<div class="cc-bus__plan-buttons">' +
            '<button class="cc-bus__btn cc-bus__btn--approve" data-act="approve" data-plan-id="' + escapeHtml(plan.id) + '" data-msg-id="' + escapeHtml(msgId) + '" data-from="' + escapeHtml(msg.from_user || '') + '">✓ Approve plan</button>' +
            '<button class="cc-bus__btn cc-bus__btn--ghost" data-act="bounce">↺ Bounce with edits</button>' +
            '<button class="cc-bus__btn cc-bus__btn--neutral" data-act="open-plan" data-plan-id="' + escapeHtml(plan.id) + '">↗ Open in plans board</button>' +
          '</div>' +
        '</div>';
    } else if (hasPlanApproved) {
      var approvedBy = plan.approved_by || 'alessio';
      var approvedAt = plan.approved_at ? fmtTime(plan.approved_at) : '—';
      planBar = '' +
        '<div class="cc-bus__approved">' +
          '<span style="font-size:14px;">✓</span>' +
          '<span><strong>Plan ' + escapeHtml(plan.status) + '</strong>' +
            '<span class="sep">·</span>' + escapeHtml(approvedBy) +
            '<span class="sep">·</span>' + escapeHtml(approvedAt) +
          '</span>' +
        '</div>';
    }

    // ─── Session-intent label (NEW) ───
    var sessionRow = msg.from_instance_id ? SESSION_MAP[String(msg.from_instance_id).toLowerCase()] : null;
    var intentText = sessionRow ? shortenIntent(sessionRow.intent) : '';
    var instanceShort = msg.from_instance_id ? String(msg.from_instance_id).slice(0, 8) : '';
    var intentHtml = intentText
      ? '<span class="cc-bus__intent" title="session ' + escapeHtml(instanceShort) + '">' + escapeHtml(intentText) + '</span>'
      : (instanceShort ? '<span class="cc-bus__instance-short" title="session ' + escapeHtml(instanceShort) + '">·' + escapeHtml(instanceShort) + '</span>' : '');

    // ─── Per-card actions — Reply / Done / Close / Save / Archive ───
    // 2026-08-04 rebuild (Alessio: "I need a done button... delete is basically useless
    // because it literally tells me it won't be deleted, it will be archived"):
    //   + Done      — new. status='done', toggles back. THE one that finishes a thread.
    //   - Delete    — removed. It wrote {archived_at, status:'archived'}: byte-for-byte
    //                 identical to Archive, and its own confirm() text admitted it.
    //   - 🚩 Flag   — removed. It only toggled .hidden on the colour-dot row, but that row
    //                 carries an inline display:flex and no .hidden rule covers it, so the
    //                 dots were always on screen and the button did nothing. Dots stay.
    var archiveLabel = msg.archived_at ? '↻ Unarchive' : '📥 Archive';
    var saveLabel = msg.saved_at ? '💾 Saved ✓' : '💾 Save';
    var isDone = msg.status === 'done';
    var doneLabel = isDone ? '↩ Not done' : '✓ Done';
    var flagDots = Object.keys(FLAG_COLORS).map(function (name) {
      return '<button class="cc-bus__flag-dot" data-act="set-flag" data-flag="' + name + '" title="' + name + '" style="width:15px;height:15px;border-radius:50%;border:2px solid ' + (msg.flag_color === name ? '#fff' : 'transparent') + ';background:' + FLAG_COLORS[name] + ';cursor:pointer;padding:0;"></button>';
    }).join('');
    // The chat: every reply stacks chronologically on the original bus card.
    var threadHtml = '';
    if (replies.length) {
      threadHtml = '<div class="cc-bus__thread">' + replies.map(function (r) {
        var mine = String(r.from_user || '') === 'alessio';
        return '<div class="cc-bus__bubble' + (mine ? ' mine' : '') + '">' +
          '<div class="cc-bus__bubble-head"><b style="color:' + instColor(r.from_user).color + '">' + escapeHtml(r.from_user || '?') + '</b>' +
          (r.to_user ? '<span style="opacity:.6">→</span><span style="color:' + instColor(r.to_user).color + '">' + escapeHtml(r.to_user) + '</span>' : '') +
          '<span class="cc-bus__bubble-when">#' + escapeHtml(String(r.id)) + ' · ' + escapeHtml(fmtTime(r.sent_at || r.created_at)) + '</span></div>' +
          '<div class="cc-bus__bubble-body">' + escapeHtml(String(r.body || '')) + '</div>' +
        '</div>';
      }).join('') + '</div>';
    }
    // ─── An open reply is DURABLE state, not a DOM accident ───────────────
    // Everything the user has in flight on this card — the panel being open, the
    // text typed, who they forwarded to, whether Close is armed — comes out of
    // DRAFTS and is baked into the HTML. That is what makes it survive the 30s
    // poll, every action repaint, and a full browser reload (his ask,
    // 2026-08-11: "if I open a reply up, I want to keep that window open").
    var draft = DRAFTS[msgId] || null;
    var fwdTargets = ['forge-code', 'forge-cowork', 'forge-design', 'reanna', 'team', 'forge'];
    var fwdOn = !!(draft && draft.fwdTo);
    var fwdSelect = '<select data-role="fwd-to"' + (fwdOn ? '' : ' class="hidden"') + '>' +
      fwdTargets.map(function (t) {
        return '<option value="' + t + '"' + (fwdOn && draft.fwdTo === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('') + '</select>';
    var armed = !!(draft && draft.armed);
    var panelOpen = !!draft;
    var actionsHtml =
      '<div class="cc-bus__actions">' +
        '<button class="cc-bus__act-btn cc-bus__act-btn--reply" data-act="open-reply-wide">↩ Reply</button>' +
        '<button class="cc-bus__act-btn" data-act="open-forward" title="Send this thread to someone else — they join the mix and their answer stacks here too.">⇄ Forward</button>' +
        '<button class="cc-bus__act-btn cc-bus__act-btn--done" data-act="toggle-done" data-done="' + (isDone ? '1' : '') + '" title="' + (isDone ? 'Put it back on the list' : 'Finished — takes it off the list. No comment needed. Find it again under the Done filter.') + '">' + doneLabel + '</button>' +
        '<button class="cc-bus__act-btn cc-bus__act-btn--close' + (armed ? ' is-armed' : '') + '" data-act="toggle-close-on-send" title="Reply and finish in one go: arms this thread to be marked done when you hit Send. Just want it done with no message? Use Done.">' + (armed ? '✓ Close' : '✦ Close') + '</button>' +
        '<button class="cc-bus__act-btn" data-act="save" data-saved="' + (msg.saved_at ? '1' : '') + '" title="Keep — exempts this from the nightly tidy-up. Nothing is ever deleted either way.">' + saveLabel + '</button>' +
        '<button class="cc-bus__act-btn" data-act="archive" title="Hide it without marking it finished. Reversible.">' + archiveLabel + '</button>' +
      '</div>' +
      '<div class="cc-bus__flagrow" data-role="flag-row" style="display:flex;gap:8px;align-items:center;padding:6px 2px;">' +
        flagDots +
        '<button data-act="set-flag" data-flag="" style="background:none;border:0;color:#7a7a7a;cursor:pointer;font-size:11px;">✕ clear</button>' +
      '</div>' +
      '<div class="cc-bus__reply-wide' + (panelOpen ? '' : ' hidden') + '" data-role="reply-wide">' +
        '<textarea data-role="reply-wide-input" data-parent-id="' + escapeHtml(msgId) + '" data-to="' + escapeHtml(lastOther) + '" placeholder="Type your reply… click the mic icon for dictation. Cmd/Ctrl+Enter to send.">' + escapeHtml(draft ? (draft.text || '') : '') + '</textarea>' +
        '<div class="cc-bus__reply-wide-row">' +
          fwdSelect +
          '<span class="cc-bus__reply-wide-hint">' + (fwdOn ? 'Forwarding this thread — pick who joins the mix:' : 'Replying to ' + escapeHtml(lastOther) + ' on bus #' + escapeHtml(msgId)) + '</span>' +
          '<span class="cc-bus__close-hint">✓ Will close this thread when sent</span>' +
          '<button class="cc-bus__reply-wide-cancel" data-act="cancel-reply-wide">Cancel</button>' +
          '<button class="cc-bus__btn cc-bus__btn--approve cc-bus__reply-wide-send" data-act="send-reply-wide">Send</button>' +
        '</div>' +
      '</div>';

    return '<article class="' + cardClasses.join(' ') + '" data-msg-id="' + escapeHtml(msgId) + '"' +
        (armed ? ' data-close-on-send="1"' : '') + (fwdOn ? ' data-fwd="1"' : '') + stripeStyle + '>' +
        '<div class="cc-bus__meta">' +
          '<span class="cc-bus__from" style="color:' + fromColor + ';">' + escapeHtml(msg.from_user || '?') + '</span>' +
          intentHtml +
          '<span class="cc-bus__arrow">→</span>' +
          '<span class="cc-bus__to" style="color:' + toColor + ';">' + escapeHtml(msg.to_user || '?') + '</span>' +
          (msg.channel ? '<span class="cc-bus__channel">' + escapeHtml(msg.channel) + '</span>' : '') +
          openAskTag +
          '<span class="cc-bus__id">#' + escapeHtml(msgId) + '</span>' +
          '<span class="cc-bus__time">' + escapeHtml(fmtTime(msg.sent_at || msg.created_at)) + '</span>' +
          mixHtml +
        '</div>' +
        replyContextHtml(msg) +
        '<div class="' + bodyClass + '">' + bodyHtml + '</div>' +
        '<div class="cc-bus__readrow">' + readBtn + showMore + '</div>' +
        threadHtml +
        planBar +
        '<div class="cc-bus__reply hidden" data-role="reply">' +
          '<input type="text" placeholder="Reply on this thread…" data-role="reply-input" data-parent-id="' + escapeHtml(msgId) + '" data-to="' + escapeHtml(lastOther) + '">' +
          '<button class="cc-bus__btn cc-bus__btn--approve" data-act="send-reply">Send</button>' +
        '</div>' +
        actionsHtml +
      '</article>';
  }

  // ─── Task-batch bundling (bus #2085, Alessio 2026-06-06) ───────────────
  // A multi-task dispatch tags every row with one shared thread_id that
  // starts with 'taskbatch-', and the operator's note rides on the lead row
  // only. Here we fold those rows into ONE card: note shown once, every task
  // listed inside, each still its own bus row (#id) so nothing is lost.
  // Non-batch traffic and lone-survivor batches fall back to the normal
  // per-message card — current behaviour is byte-for-byte unchanged.
  function batchThreadOf(r) {
    var t = r && r.thread_id;
    return (typeof t === 'string' && t.indexOf('taskbatch-') === 0) ? t : null;
  }
  function groupRenderUnits(rows) {
    var units = [], seen = {}, seenThread = {};
    rows.forEach(function (r) {
      // Thread folding first: any row belonging to a thread with replies emits
      // ONE thread card (at the position of its newest member) and the rest fold.
      var rootKey = String(r.root_id || r.id);
      var replies = THREAD_MAP.replies[rootKey] || [];
      if (replies.length) {
        if (seenThread[rootKey]) return;
        // Bookkeeping ONLY once the root is actually in hand. Marking it first
        // ate every sibling reply whenever the root could not be found — one
        // message showed and the rest of the exchange vanished off the screen.
        var rootRow = r.root_id ? THREAD_MAP.roots[rootKey] : r;
        if (rootRow) { seenThread[rootKey] = true; units.push({ type: 'thread', msg: rootRow, replies: replies }); return; }
        // root unreachable — fall through so the reply still shows as its own card
      }
      var tid = batchThreadOf(r);
      if (!tid) { units.push({ type: 'single', msg: r }); return; }
      if (seen[tid]) return;            // batch already folded at its first row
      seen[tid] = true;
      var members = rows.filter(function (x) { return batchThreadOf(x) === tid; });
      if (members.length < 2) units.push({ type: 'single', msg: members[0] || r });
      else units.push({ type: 'bundle', msgs: members });
    });
    return units;
  }
  function taskTitleOf(body) {
    var m = String(body || '').match(/—\s*task:\s*(.+?)\s*·\s*id\b/);
    return m ? m[1] : null;
  }
  function bundleNoteOf(body) {
    // Note = everything before the first per-task footer line.
    var s = String(body || '');
    var idx = s.indexOf('\n\n— task:');
    if (idx === -1) idx = s.indexOf('— task:');
    return idx > 0 ? s.slice(0, idx).trim() : '';
  }
  function renderBundleCard(msgs) {
    var lead = msgs[0];                 // rows are sent_at-desc; any member shares from/to
    var leadId = String(lead.id);
    var fromColor = instColor(lead.from_user).color;
    var toColor = instColor(lead.to_user).color;
    // Find the note on whichever member carries it (insert order ≠ sent_at order).
    var note = '';
    for (var i = 0; i < msgs.length; i++) {
      var nn = bundleNoteOf(msgs[i].body);
      if (nn) { note = nn; break; }
    }
    var noteHtml = note
      ? '<div class="cc-bus__body">' + escapeHtml(note)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>') + '</div>'
      : '';
    var taskRows = msgs.map(function (m) {
      var title = taskTitleOf(m.body) || '(task)';
      return '<li data-msg-id="' + escapeHtml(String(m.id)) + '"' +
        ' style="display:flex;align-items:baseline;gap:8px;padding:5px 8px;border:1px solid var(--border,#252c33);border-left:2px solid ' + fromColor + ';border-radius:3px;background:var(--bg,#0a0a0a);">' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(title) + '</span>' +
        '<span class="cc-bus__id">#' + escapeHtml(String(m.id)) + '</span>' +
      '</li>';
    }).join('');
    return '<article class="cc-bus-card cc-bus-card--bundle" data-msg-id="' + escapeHtml(leadId) + '" data-bundle="1" style="--stripe:' + fromColor + ';">' +
        '<div class="cc-bus__meta">' +
          '<span class="cc-bus__from" style="color:' + fromColor + ';">' + escapeHtml(lead.from_user || '?') + '</span>' +
          '<span class="cc-bus__arrow">→</span>' +
          '<span class="cc-bus__to" style="color:' + toColor + ';">' + escapeHtml(lead.to_user || '?') + '</span>' +
          '<span class="cc-bus__channel">' + msgs.length + ' tasks</span>' +
          '<span class="cc-bus__time">' + escapeHtml(fmtTime(lead.sent_at || lead.created_at)) + '</span>' +
        '</div>' +
        noteHtml +
        '<ul style="list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px;">' + taskRows + '</ul>' +
      '</article>';
  }

  // isSystemMsg is deleted (2026-08-19). Deciding in the browser which column a
  // row belonged to is what let the two columns steal rows from each other. Each
  // column now asks the database for its own rows and draws all of them.

  function renderSyslogRow(r) {
    var body = String(r.body || '').slice(0, 400);
    var idStr = escapeHtml(String(r.id));
    return '<div class="cc-bus__syslog-row" data-msg-id="' + idStr + '">' +
      '<div class="cc-bus__syslog-row__head">' +
        '<span>#' + idStr + ' · <span class="to">→ ' + escapeHtml(r.to_user || '—') + '</span></span>' +
        '<span>' + escapeHtml(fmtTime(r.sent_at || r.created_at)) + '</span>' +
      '</div>' +
      '<div class="cc-bus__syslog-row__body">' + escapeHtml(body) + '</div>' +
    '</div>';
  }

  // ─── Shell (sidebar + main column + syslog column) ─────────────────────
  // Header + composer wrapped in .cc-bus__topstack so they pin as one
  // sticky block flush with the subtab row — no gap for scrolling cards
  // to peek through, and the "Bus Traffic" header stays visible too.
  // Alessio direct 2026-05-17 (topstack) + 2026-06-01 (syslog right col).
  function renderShell() {
    return '' +
      '<aside class="cc-bus__filters" data-role="filters"></aside>' +
      '<div class="cc-bus__main">' +
        '<div class="cc-bus__topstack">' +
          '<div class="cc-bus__header" data-role="header"></div>' +
          '<div class="cc-bus__composer" data-role="composer"></div>' +
        '</div>' +
        '<div class="cc-bus__list" data-role="list"></div>' +
      '</div>' +
      '<aside class="cc-bus__syslog" data-role="syslog">' +
        '<header class="cc-bus__syslog-head">' +
          '<span class="cc-bus__syslog-title">System log</span>' +
          '<span class="cc-bus__syslog-count" data-role="syslog-count">…</span>' +
        '</header>' +
        '<div class="cc-bus__syslog-list" data-role="syslog-list"></div>' +
      '</aside>';
  }

  // The first column. Built from BUCKETS every paint — there is no list of filters
  // written into any HTML file, so a bucket added or removed in one place is the
  // whole change. Machine room sits under a rule at the bottom: present, honest,
  // out of the way.
  function renderFilters() {
    return BUCKETS.map(function (b) {
      var n = COUNTS[b.id];
      var active = (STATE.bucket === b.id) ? ' active' : '';
      var empty = (n === 0) ? ' empty' : '';
      var quiet = b.quiet ? ' quiet' : '';
      var num = (n == null) ? '—' : String(n);   // a dash means we could not ask
      return (b.quiet ? '<div class="cc-bus__fsep"></div>' : '') +
        '<button type="button" class="cc-bus__fbtn' + active + empty + quiet + '"' +
          ' data-filter-group="bucket" data-filter-value="' + b.id + '"' +
          ' title="' + escapeHtml(b.hint) + '">' +
          '<span>' + escapeHtml(b.label) +
            '<span class="cc-bus__fhint">' + escapeHtml(b.hint) + '</span>' +
          '</span>' +
          '<span class="cc-bus__fnum">' + num + '</span>' +
        '</button>';
    }).join('');
  }

  // renderSidebar lived here: 106 lines that drew Sender / Channel / Status /
  // Priority buttons with a facet-correct count on each. Deleted 2026-08-18 on his
  // word - the column they filled is gone, and dead code that draws a wrong number
  // is exactly what he asked us to stop keeping around.

  function renderHeader(filteredCount) {
    // THE CHANNEL SWITCH IS GONE (2026-08-19). Both / AZ / Forge / System sliced by
    // agent_messages.lane — the machine's taxonomy, the same one that put buses on
    // his board that were never his. Two filter systems on one screen would also
    // have broken the rule that matters here: a count on a button has to equal what
    // clicking it shows, and it cannot if a second switch is narrowing the list
    // behind it. The first column is the only thing that chooses now.
    //
    // The header says which bucket he is in, so the title is never a generic word
    // sitting above a filtered list.
    var b = bucketById(STATE.bucket);
    var title = 'Bus · ' + (b ? b.label : 'To me');
    var fontOn = (busFontPref() !== 'off');
    // Search input was moved into renderComposer() per Alessio direct 2026-05-17
    // — it now sits inline with the @chips above the type box.
    return '' +
      '<span class="cc-bus__header-title">' + escapeHtml(title) + '</span>' +
      '<span class="cc-bus__header-count" title="conversations on screen">' + filteredCount + ' threads</span>' +
      '<button type="button" class="cc-bus__font-toggle' + (fontOn ? ' on' : '') + '" data-act="toggle-font" title="Toggle dyslexic-friendly font (Lexend)">Aa</button>' +
      '<button type="button" class="cc-bus__readall" data-act="read-all" title="Read every message shown, out loud">▶ Read bus</button>';
  }

  function renderComposer() {
    var chips = ALL_INSTANCES.filter(function (i) { return i !== 'alessio'; }).map(function (i) {
      var c = instColor(i);
      return '<button class="cc-bus__chip" data-act="chip" data-target="' + i + '" style="color:' + c.color + '; border-color:' + c.color + ';">@' + i.replace('forge-', '') + '</button>';
    }).join('');
    return '' +
      '<div class="cc-bus__chips">' + chips +
        '<input class="cc-bus__compose-search" type="text" placeholder="Search bus bodies…" data-role="search" value="' + escapeHtml(STATE.search) + '">' +
      '</div>' +
      '<textarea class="cc-bus__compose-input" data-role="compose-input" placeholder="Type a message… start with @code / @cowork / @design / @reanna to dispatch, or plain text for a general bus."></textarea>' +
      '<div class="cc-bus__compose-row">' +
        '<span class="cc-bus__compose-hint">Cmd/Ctrl+Enter to send · plain text → alessio</span>' +
        '<button class="cc-bus__btn cc-bus__btn--approve cc-bus__compose-send" data-act="compose-send">Send</button>' +
      '</div>';
  }

  // ─── Mutations ─────────────────────────────────────────────────────────
  async function approvePlan(planId, msgId, fromUser) {
    var client = sb();
    if (!client) return;
    try {
      await client.from('forge_plans').update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: 'alessio'
      }).eq('id', planId);
      if (fromUser) {
        await client.from('agent_messages').insert({
          from_user: 'alessio',
          to_user: fromUser,
          from_instance_id: BROWSER_SESSION_ID,
          channel: 'reply',
          priority: 'normal',
          status: 'sent',
          body: '✓ Plan ' + planId + ' approved by alessio via the CC bus.',
          parent_id: Number(msgId) || null,
          parent_bus_id: Number(msgId) || null
        });
      }
      refresh();
    } catch (e) {
      alert('Approve failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  // Save + Flag (Alessio 2026-07-11) — saved/flagged rows survive the 14-day auto-wipe.
  var FLAG_COLORS = { red: '#f85149', amber: '#d29922', green: '#3fb950', blue: '#4c8fd6', purple: '#b083f0', gray: '#7a7a7a' };

  async function saveBusV2(msgId, currentlySaved) {
    var client = sb();
    if (!client) return;
    try {
      await client.from('agent_messages').update({ saved_at: currentlySaved ? null : new Date().toISOString() }).eq('id', Number(msgId));
      refresh();
    } catch (e) {
      alert('Save failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  async function setBusFlagV2(msgId, color) {
    var client = sb();
    if (!client) return;
    try {
      await client.from('agent_messages').update({ flag_color: color || null }).eq('id', Number(msgId));
      refresh();
    } catch (e) {
      alert('Flag failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  // Done = "this thread is finished". Separate from Archive on purpose: Archive hides
  // something you have NOT finished, Done finishes it. Writes status only — never
  // archived_at — so the two stay independent and neither can clobber the other.
  async function doneBus(msgId, currentlyDone) {
    var client = sb();
    if (!client) return;
    try {
      await client.from('agent_messages')
        .update({ status: currentlyDone ? 'read' : 'done' })
        .eq('id', Number(msgId));
      refresh();
    } catch (e) {
      alert('Could not mark that done: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  async function archiveBus(msgId, currentlyArchived) {
    var client = sb();
    if (!client) return;
    try {
      // Preserve doneness across an archive round-trip. The old code forced status to
      // 'archived' going in and 'read' coming out, so archiving a finished thread and
      // restoring it silently un-finished it.
      var rowAb = rowById(msgId);
      var wasDone = rowAb && rowAb.status === 'done';
      var patch = currentlyArchived
        ? { archived_at: null,  status: wasDone ? 'done' : 'read' }
        : { archived_at: new Date().toISOString(), status: wasDone ? 'done' : 'archived' };
      await client.from('agent_messages').update(patch).eq('id', Number(msgId));
      refresh();
    } catch (e) {
      alert('Archive failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  // UNUSED since 2026-08-04 — the Delete button was removed (it duplicated Archive).
  // Kept only so nothing that may still reference it breaks.
  async function deleteBus(msgId) {
    var client = sb();
    if (!client) return;
    if (!confirm('Delete bus #' + msgId + '?\nRow is soft-deleted (archived_at set, status=archived).\nNothing is permanently removed — you can recover it from the DB.')) return;
    try {
      // Soft delete per Forge rule "Archive — never delete": row stays, marked
      // archived. If a hard delete is ever needed, do it from Supabase studio.
      await client.from('agent_messages').update({
        archived_at: new Date().toISOString(),
        status: 'archived'
      }).eq('id', Number(msgId));
      refresh();
    } catch (e) {
      alert('Delete failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  async function sendReplyWide(parentMsgId, toUser, text, closeMsgId) {
    var client = sb();
    if (!client || !text || !text.trim()) return;
    try {
      await client.from('agent_messages').insert({
        from_user: 'alessio',
        to_user: toUser || 'alessio',
        from_instance_id: BROWSER_SESSION_ID,
        channel: 'reply',
        priority: 'normal',
        status: 'sent',
        body: text.trim(),
        parent_id: Number(parentMsgId) || null,
        parent_bus_id: Number(parentMsgId) || null
      });
      // Optional: also FINISH the parent thread (✦ Close button).
      // Changed 2026-08-04: this used to archive — i.e. merely hide — which meant a
      // thread you had actually answered and closed looked the same as one you had
      // shoved out of sight. It now marks it done, the same state the Done button
      // writes, so "replied and finished" is a single honest thing.
      // Best-effort — a failure here must not block the reply that already shipped.
      if (closeMsgId) {
        try {
          await client.from('agent_messages')
            .update({ status: 'done' })
            .eq('id', Number(closeMsgId));
        } catch (eArc) { /* swallow — reply already shipped */ }
      }
      refresh();
    } catch (e) {
      alert('Send failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  async function sendReply(parentMsgId, toUser, text) {
    var client = sb();
    if (!client || !text || !text.trim()) return;
    try {
      await client.from('agent_messages').insert({
        from_user: 'alessio',
        to_user: toUser,
        from_instance_id: BROWSER_SESSION_ID,
        channel: 'reply',
        priority: 'normal',
        status: 'sent',
        body: text.trim(),
        parent_id: Number(parentMsgId) || null,
        parent_bus_id: Number(parentMsgId) || null
      });
      refresh();
    } catch (e) {
      alert('Send failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  async function composeSend(text) {
    var client = sb();
    if (!client || !text || !text.trim()) return;
    // Parse @-routing
    var trimmed = text.trim();
    var routes = {
      '@code':   'forge-code',
      '@cowork': 'forge-cowork',
      '@design': 'forge-design',
      '@reanna': 'reanna'
    };
    var toUser = 'alessio';
    var channel = 'general';
    Object.keys(routes).forEach(function (tag) {
      if (trimmed.toLowerCase().indexOf(tag) === 0) {
        toUser = routes[tag];
        channel = 'task';   // 'dispatch' is not in the channel CHECK whitelist; 'task' is the closest fit
        trimmed = trimmed.slice(tag.length).trim();
      }
    });
    try {
      await client.from('agent_messages').insert({
        from_user: 'alessio',
        to_user: toUser,
        from_instance_id: BROWSER_SESSION_ID,
        channel: channel,
        priority: 'normal',
        status: 'sent',
        body: trimmed
      });
      refresh();
    } catch (e) {
      alert('Send failed: ' + (e && e.message ? e.message : 'unknown error'));
    }
  }

  function openPlan(planId) {
    try {
      var btn = document.querySelector('.cc-nav__tab[data-lane="operator"]');
      if (btn && typeof window.switchTab === 'function') window.switchTab(btn, 'operator');
      var sub = document.querySelector('.cc-subtab[data-subtab="plans"]');
      if (sub && typeof window.switchSubtabFromNav === 'function') window.switchSubtabFromNav(sub);
      window.dispatchEvent(new CustomEvent('cc-plan-focus', { detail: { id: planId } }));
    } catch (e) {}
  }

  // ─── Render orchestrator ───────────────────────────────────────────────
  var ALL_ROWS = [];   // both sets, for thread/parent/plan lookups only
  var MAIN_ROWS = [];  // exactly what the active bucket asked for — the list
  var SYS_ROWS = [];   // lane 'log' — the right-hand column, its own query
  var PLAN_MAP = {};
  var SESSION_MAP = {};  // from_instance_id (uuid string) → { instance, intent, model, device, status }

  async function loadSessions(client, instanceIds) {
    if (!instanceIds || !instanceIds.length) return {};
    // Phase B (bus #1693): forge_sessions.id is uuid. Filter out legacy slug
    // aliases (e.g. 'forge-code-sonnet-beast') so they don't poison the
    // in.() clause and 400 the whole probe.
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var uuids = instanceIds.filter(function (x) { return UUID_RE.test(String(x)); });
    if (!uuids.length) return {};
    try {
      var res = await client.from('forge_sessions')
        .select('id,instance,intent,model,device,status,last_seen')
        .in('id', uuids);
      var map = {};
      (res.data || []).forEach(function (s) { map[String(s.id).toLowerCase()] = s; });
      return map;
    } catch (e) {
      return {};
    }
  }

  function shortenIntent(intent) {
    if (!intent) return '';
    var s = String(intent).replace(/[\r\n]+/g, ' ').trim();
    // Strip leading "background Claude Code process (PID …)" boilerplate
    if (/^background\s+Claude\s+Code/i.test(s)) return '';
    if (s.length > 48) return s.slice(0, 45) + '…';
    return s;
  }

  // ─── isUserBusy guard — pauses the 30s poll while the user is typing or
  //     focused on any bus input/textarea. Triad pattern (memory:
  //     cowork_iframe_ux_triad — cache hydrates, sig skips, busy pauses).
  var lastTypingMs = 0;
  function noteTyping() { lastTypingMs = Date.now(); }
  function isUserBusy() {
    var mountEl = document.getElementById(MOUNT_ID);
    if (!mountEl) return false;
    // 1. Active focus inside any bus input/textarea/select
    var ae = document.activeElement;
    if (ae && mountEl.contains(ae) && /^(TEXTAREA|INPUT|SELECT)$/.test(ae.tagName)) return true;
    // 2. Typing event in the last 5s (covers IME composition + voice dictation)
    if (Date.now() - lastTypingMs < 5000) return true;
    return false;
  }

  function paintAll() {
    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (!mount.querySelector('[data-role="list"]') || !mount.querySelector('[data-role="syslog-list"]')) {
      mount.innerHTML = renderShell();
    }
    var filters = mount.querySelector('[data-role="filters"]');
    var header = mount.querySelector('[data-role="header"]');
    var list = mount.querySelector('[data-role="list"]');
    var composer = mount.querySelector('[data-role="composer"]');
    var syslogList = mount.querySelector('[data-role="syslog-list"]');
    var syslogCount = mount.querySelector('[data-role="syslog-count"]');

    // Each column draws its OWN query's rows. No skimming between them.
    var humanRows = MAIN_ROWS;
    var systemRows = SYS_ROWS;

    if (filters) filters.innerHTML = renderFilters();

    // GROUP FIRST, FILTER SECOND — a conversation is an atom.
    // Filtering rows and then grouping tore threads in half: search for a word
    // that appears in a reply and you got the reply with no question above it,
    // and the rest of the exchange vanished. Now the thread is assembled from
    // the unfiltered set and kept whole if the root OR ANY reply matches.
    // The list is built from the rows the bucket asked for, minus the ones the
    // system-log column is already showing on the right.
    var baseRows = humanRows;
    var filtered = groupRenderUnits(baseRows).filter(function (u) {
      var rows = [u.msg].concat(u.replies || []).concat(u.msgs || []);
      for (var i = 0; i < rows.length; i++) if (rows[i] && rowMatches(rows[i])) return true;
      return false;
    });
    if (header) header.innerHTML = renderHeader(filtered.length);

    // ─── System log column render (read-only, no filtering, capped at 100) ─
    if (syslogCount) syslogCount.textContent = systemRows.length;
    if (syslogList) {
      var savedSysScroll = syslogList.scrollTop;
      if (!systemRows.length) {
        syslogList.innerHTML = '<div class="cc-bus__syslog-empty">No system messages.</div>';
      } else {
        syslogList.innerHTML = systemRows.slice(0, 100).map(renderSyslogRow).join('');
      }
      try { syslogList.scrollTop = savedSysScroll; } catch (e) {}
    }

    if (list) {
      // Snapshot scroll position + open reply panels + expanded bodies so the
      // 30s poll doesn't yank the user back / re-collapse what they opened.
      // Covers reply-wide (textarea) + legacy narrow reply (input) + show-more
      // body expansion + the list's scroll position. Also tracks which field
      // had focus so we can restore caret + focus (no "pull away").
      // Read/write the scroll on the element that ACTUALLY scrolls. .cc-bus__list has no
      // overflow (see the CSS at the top of this file) so its scrollTop is permanently 0 —
      // this save/restore pair was a no-op and the feed lost its place on every refresh.
      // The real scroller is .cc-bus__main; under 1100px the operator lane is.
      var scroller = list.closest('.cc-bus__main') || list.parentElement || list;
      var savedScrollTop = scroller.scrollTop;
      // ANCHOR ON A CARD, NOT A PIXEL. Restoring a raw offset kept the scrollbar
      // still while the content moved under it: one new message at the top and
      // the card he was reading slid out from under him. Remember WHICH card sat
      // at the top of the viewport and how far into it we were, then put that
      // same card back in that same spot after the rewrite.
      var anchorId = null, anchorDelta = 0;
      var sTop = scroller.getBoundingClientRect().top;
      var cardsNow = list.querySelectorAll('.cc-bus-card');
      for (var ci = 0; ci < cardsNow.length; ci++) {
        var cr = cardsNow[ci].getBoundingClientRect();
        if (cr.bottom > sTop + 4) { anchorId = cardsNow[ci].getAttribute('data-msg-id'); anchorDelta = cr.top - sTop; break; }
      }
      var replySnap = {};
      var expandedSnap = {};
      var activeEl = document.activeElement;
      list.querySelectorAll('.cc-bus-card').forEach(function (card) {
        var msgId = card.getAttribute('data-msg-id');
        var entry = null;
        var wide = card.querySelector('[data-role="reply-wide"]');
        if (wide && !wide.classList.contains('hidden')) {
          var ta = wide.querySelector('[data-role="reply-wide-input"]');
          entry = entry || {};
          entry.wide = {
            text: ta ? ta.value : '',
            sel: ta ? [ta.selectionStart, ta.selectionEnd] : [0, 0],
            focused: ta === activeEl
          };
        }
        var narrow = card.querySelector('[data-role="reply"]');
        if (narrow && !narrow.classList.contains('hidden')) {
          var ni = narrow.querySelector('[data-role="reply-input"]');
          entry = entry || {};
          entry.narrow = {
            text: ni ? ni.value : '',
            sel: ni ? [ni.selectionStart, ni.selectionEnd] : [0, 0],
            focused: ni === activeEl
          };
        }
        if (entry) replySnap[msgId] = entry;
        // Show-more expansion: cards with the toggle button that are NOT
        // collapsed have been opened by the user — preserve that on rerender.
        var body = card.querySelector('.cc-bus__body');
        var toggleBtn = card.querySelector('[data-act="toggle-body"]');
        if (body && toggleBtn && !body.classList.contains('collapsed')) {
          expandedSnap[msgId] = true;
        }
      });

      function unitHtml(u) {
        if (u.type === 'bundle') return renderBundleCard(u.msgs);
        var plan = pickDraftPlan(u.msg, PLAN_MAP);
        return renderCard(u.msg, plan, u.replies);
      }
      // THE AZ | FORGE SPLIT WENT WITH THE CHANNEL SWITCH (2026-08-19). It sorted
      // threads by project slug into two columns and QUIETLY SET ASIDE every
      // machine-to-machine thread into a counter at the bottom — a list that was
      // not the list its own header claimed. The bucket he picked is now the only
      // thing that decides what is here, and everything in it is shown.
      // NO SILENT CAP. If the bucket holds more than one fetch can carry, the last
      // line on the list says how many are not on screen. Without it the board looks
      // complete while quietly ending early, and that is how a number goes stale
      // without anyone noticing.
      var held = MAIN_ROWS.length;
      var total = COUNTS[STATE.bucket];
      var overflow = (total != null && total > held)
        ? '<div class="cc-bus__more">Showing the newest ' + held + ' of ' + total +
          '. Search to reach the rest.</div>'
        : '';
      if (!filtered.length) {
        list.innerHTML = '<div class="cc-bus__empty">Nothing here.</div>' + overflow;
      } else {
        list.innerHTML = filtered.map(unitHtml).join('') + overflow;
      }

      // Restore expanded bodies (must run BEFORE scrollTop restore so the
      // expanded heights are in the layout when we set scrollTop).
      Object.keys(expandedSnap).forEach(function (msgId) {
        var ecard = list.querySelector('[data-msg-id="' + msgId + '"]');
        if (!ecard) return;
        var ebody = ecard.querySelector('.cc-bus__body');
        var ebtn = ecard.querySelector('[data-act="toggle-body"]');
        if (ebody && ebtn) {
          ebody.classList.remove('collapsed');
          ebtn.textContent = '▴ Show less';
        }
      });

      // Restore reply panels (wide + narrow) + focus + caret after re-render.
      Object.keys(replySnap).forEach(function (msgId) {
        var s = replySnap[msgId];
        var card = list.querySelector('[data-msg-id="' + msgId + '"]');
        if (!card) return;
        if (s.wide) {
          var panel = card.querySelector('[data-role="reply-wide"]');
          var ta = panel && panel.querySelector('[data-role="reply-wide-input"]');
          if (panel && ta) {
            panel.classList.remove('hidden');
            ta.value = s.wide.text;
            try { ta.setSelectionRange(s.wide.sel[0], s.wide.sel[1]); } catch (e) {}
            if (s.wide.focused) { try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); } }
          }
        }
        if (s.narrow) {
          var nbox = card.querySelector('[data-role="reply"]');
          var ni = nbox && nbox.querySelector('[data-role="reply-input"]');
          if (nbox && ni) {
            nbox.classList.remove('hidden');
            ni.value = s.narrow.text;
            try { ni.setSelectionRange(s.narrow.sel[0], s.narrow.sel[1]); } catch (e) {}
            if (s.narrow.focused) { try { ni.focus({ preventScroll: true }); } catch (e) { ni.focus(); } }
          }
        }
      });

      // If a message is being read aloud, its button must still say Stop. The
      // voice kept talking through a repaint while the button reverted to
      // "▶ Read", so the only way to stop it was to start something else.
      if (SPEECH.id && String(SPEECH.id).indexOf('msg-') === 0) {
        var spCard = list.querySelector('[data-msg-id="' + String(SPEECH.id).slice(4) + '"]');
        var spBtn = spCard && spCard.querySelector('[data-act="read-body"]');
        if (spBtn) { spBtn.textContent = '◼ Stop'; spBtn.classList.add('speaking'); }
      }

      // Restore scroll last (after expanded bodies are open so the measured
      // geometry matches what he saw). Anchor card first, raw offset only as a
      // fallback when that card is genuinely gone from the list.
      try {
        var placed = false;
        if (anchorId) {
          var aCard = list.querySelector('[data-msg-id="' + anchorId + '"]');
          if (aCard) {
            var nowTop = aCard.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            scroller.scrollTop = scroller.scrollTop + (nowTop - anchorDelta);
            placed = true;
          }
        }
        if (!placed) scroller.scrollTop = savedScrollTop;
      } catch (e) {}
    }

    if (composer && !composer.querySelector('[data-role="compose-input"]')) {
      composer.innerHTML = renderComposer();
    }
  }

  // Styles for the thread chat + the half-and-half split (kept out of the main
  // CSS string on purpose — additive, zero merge risk with the big block).
  var THREAD_CSS_DONE = false;
  function injectThreadStylesOnce() {
    if (THREAD_CSS_DONE) return;
    THREAD_CSS_DONE = true;
    var st = document.createElement('style');
    st.textContent =
      '.cc-bus__thread{margin:8px 0 4px;border-left:2px solid var(--border,#252c33);padding-left:10px;display:flex;flex-direction:column;gap:6px}' +
      '.cc-bus__bubble{background:var(--raised,#161b20);border:1px solid var(--border,#252c33);border-radius:8px;padding:6px 10px;max-width:92%}' +
      '.cc-bus__bubble.mine{align-self:flex-end;background:var(--amber-soft,rgba(200,146,42,.08));border-color:var(--amber-glow,rgba(200,146,42,.3))}' +
      '.cc-bus__bubble-head{font-family:var(--mono,monospace);font-size:10px;display:flex;gap:6px;align-items:center;margin-bottom:3px}' +
      '.cc-bus__bubble-when{margin-left:auto;color:var(--text-xs,#6e7681);font-size:9px}' +
      '.cc-bus__bubble-body{font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word}' +
      '.cc-bus__mix{font-family:var(--mono,monospace);font-size:10px;color:var(--text-xs,#6e7681)}' +
      'select[data-role="fwd-to"]{background:var(--surface,#0f1316);color:var(--text,#dde4eb);border:1px solid var(--border,#252c33);border-radius:4px;padding:4px 6px;font-size:11px}' +
      'select[data-role="fwd-to"].hidden{display:none}' +
      // A real split: two columns that scroll on their own. Before this the
      // grid just sat inside the page scroller, so dragging either side moved
      // both — reading down the Forge column dragged the AZ column out of view.
      // Scrollbars follow the house recipe (the page-wide rule + the tokens), so
      // they read as part of the dark board instead of two pale system bars —
      // and scrollbar-color carries the same thing to Firefox, which ignores the
      // -webkit- rules entirely. Token-driven, so light theme comes free.
      // On a phone the two columns stack, so they go back to flowing with the
      // page — two tiny scroll boxes on one narrow screen would be worse.
      '.cc-bus__channel-btn{font-size:11px !important;padding:6px 14px !important;border-radius:5px !important;letter-spacing:0.1em !important}';
    document.head.appendChild(st);
  }

  // The split is only a real split if each side owns its own scrollbar, and a
  // column can only scroll if it has a height. Measure the room left under the
  // header and give the grid exactly that — recomputed on resize and on every
  // paint, so it never guesses at chrome that moves.
  // sizeSplitColumns and its resize listener are deleted with the split view

  // A blip on the wire must not cost him his work. One failed poll used to
  // replace the ENTIRE panel — composer draft, open reply panels, everything —
  // with a red line. Now: if the bus is already on screen, the trouble shows as
  // a thin banner above it and nothing is torn down. Only a cold start (nothing
  // rendered yet) gets the full-panel message.
  function busTrouble(mount, msg) {
    var painted = mount.querySelector('[data-role="list"]');
    if (!painted) {
      mount.innerHTML = '<div class="cc-bus__err">' + escapeHtml(msg) + '</div>';
      return;
    }
    var bar = mount.querySelector('[data-role="trouble"]');
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('data-role', 'trouble');
      bar.style.cssText = 'font-family:var(--mono,monospace);font-size:10px;color:#f85149;background:rgba(248,81,73,.08);border:1px solid rgba(248,81,73,.3);border-radius:3px;padding:4px 8px;margin:4px 0;';
      mount.insertBefore(bar, mount.firstChild);
    }
    bar.textContent = '⚠ ' + msg + ' — your open replies are untouched; retrying.';
    clearTimeout(busTrouble._t);
    busTrouble._t = setTimeout(function () { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); }, 12000);
  }

  // ─── Live counts ───────────────────────────────────────────────────────
  // One HEAD count per bucket, every refresh, straight from the database — never
  // derived from the rows on screen. A count that is derived from a page of rows
  // is a count of that page, and that is exactly how a number goes stale while
  // still looking alive.
  //
  // A count that FAILS stores null, and null renders as a dash. It never renders
  // as 0: "nothing here" and "I could not ask" are different answers and he is
  // entitled to know which one he is looking at.
  var COUNTS = {};
  function loadCounts(client) {
    return Promise.all(BUCKETS.map(function (b) {
      return b.apply(client.from('agent_messages').select('id', { count: 'exact', head: true }))
        .then(function (r) { COUNTS[b.id] = (r && !r.error) ? (r.count || 0) : null; })
        .catch(function () { COUNTS[b.id] = null; });
    }));
  }

  async function refresh() {
    injectStylesOnce();
    injectThreadStylesOnce();
    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    var client = sb();
    if (!client) {
      busTrouble(mount, 'Supabase client not ready. Reload the page.');
      return;
    }
    try {
      // 2026-08-18, his report: "I hear buses coming in but I don't see them."
      // He was right, and it was arithmetic. This fetch took the newest ROW_LIMIT
      // rows of the WHOLE bus and only then dropped archived ones in the browser.
      // But fn_bus_autosilence archives system task/plan chatter AT INSERT, and on
      // a busy night that is most of the bus: measured live, 48 of the newest 60
      // rows were already archived, so 12 cards survived and the window reached
      // back barely ninety minutes. Every one of those inserts still rang his phone.
      //
      // TWO QUERIES NOW, because the two columns want opposite things. The middle
      // column wants rows that can render, so it asks for live rows only and spends
      // its whole window on them. The syslog column on the right is BUILT from the
      // autosilenced lane, so it asks for lane 'log' regardless of archived state —
      // filtering those out server-side would have gone and darkened his system log
      // to fix his card list.
      // THE ACTIVE BUCKET IS THE QUERY. Not a filter applied to a list we already
      // fetched — the same builder that puts the number on his button is what asks
      // the database for these rows. The column cannot disagree with the list,
      // because there is one definition of each and it lives in BUCKETS.
      var bucket = bucketById(STATE.bucket) || BUCKETS[1];
      var mainQ = bucket.apply(client.from('agent_messages').select(ROW_COLS))
        .order('sent_at', { ascending: false, nullsFirst: false }).limit(ROW_LIMIT);
      var sysQ = client.from('agent_messages').select(ROW_COLS)
        .eq('lane', 'log')
        .order('sent_at', { ascending: false, nullsFirst: false }).limit(SYSLOG_LIMIT);
      var pair = await Promise.all([mainQ, sysQ, loadCounts(client)]);
      var res = pair[0], sysRes = pair[1];
      if (res.error) {
        busTrouble(mount, 'Bus query error: ' + res.error.message);
        return;
      }
      // TWO SETS, KEPT APART ON PURPOSE. MAIN_ROWS is exactly what the bucket asked
      // for, and it is exactly what the list draws — nothing gets skimmed out of it
      // on the way to the screen. Route a bucket row into the system-log column and
      // the button would say 324 while the list showed 300, which is the one thing
      // this rebuild exists to stop.
      var byTime = function (a, b) {
        return String(b.sent_at || b.created_at || '').localeCompare(String(a.sent_at || a.created_at || ''));
      };
      MAIN_ROWS = (res.data || []).slice().sort(byTime);
      SYS_ROWS = ((sysRes && sysRes.data) || []).slice().sort(byTime);
      var seenIds = {};
      ALL_ROWS = [];
      MAIN_ROWS.concat(SYS_ROWS).forEach(function (r) {
        if (seenIds[r.id]) return;
        seenIds[r.id] = true;
        ALL_ROWS.push(r);
      });
      ALL_ROWS.sort(byTime);
      var allUuids = [];
      var instanceIds = {};
      ALL_ROWS.forEach(function (r) {
        extractPlanUuids(r.body).forEach(function (u) { allUuids.push(u); });
        if (r.from_instance_id) instanceIds[String(r.from_instance_id).toLowerCase()] = true;
      });
      var instanceIdList = Object.keys(instanceIds);
      var sessionRes = await Promise.all([
        loadPlans(client, allUuids),
        loadSessions(client, instanceIdList)
      ]);
      PLAN_MAP = sessionRes[0];
      SESSION_MAP = sessionRes[1];
      PARENT_MAP = await loadParents(client, ALL_ROWS);
      THREAD_MAP = await loadThreads(client, ALL_ROWS);
      paintAll();
    } catch (e) {
      busTrouble(mount, 'Render error: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // ─── Event delegation ──────────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var target = ev.target;
    if (!target || !target.closest) return;
    if (!target.closest('#' + MOUNT_ID)) return;

    // Jump to the message a reply answers (bus #3949)
    var jump = target.closest('[data-act="jump-parent"]');
    if (jump) {
      ev.stopPropagation();
      var pid = jump.getAttribute('data-parent');
      var card = document.querySelector('#' + MOUNT_ID + ' [data-msg-id="' + pid + '"]');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('cc-bus__card--flash');
        void card.offsetWidth;                       // restart the highlight
        card.classList.add('cc-bus__card--flash');
        return;
      }
      // Not on screen — filtered out, or older than the loaded page. GO GET IT and
      // open it in place. The first cut told him to press Ctrl+K and overwrote the
      // banner saying so; pointing at another control is not opening the message.
      var nxtP = jump.nextElementSibling;
      if (nxtP && nxtP.className === 'cc-bus__parentbox') { nxtP.remove(); return; }
      var boxP = document.createElement('div');
      boxP.className = 'cc-bus__parentbox';
      boxP.textContent = 'opening #' + pid + '…';
      jump.insertAdjacentElement('afterend', boxP);
      (async function () {
        try {
          var r = await window.supa.from('agent_messages')
            .select('id,from_user,to_user,body,created_at,sent_at').eq('id', pid).maybeSingle();
          if (r.error || !r.data) { boxP.textContent = 'Could not open #' + pid + '.'; return; }
          var d = r.data;
          boxP.innerHTML = '<div class="cc-bus__parentbox-h" style="color:' + instColor(d.from_user).color + '">' +
            escapeHtml(d.from_user) + ' → ' + escapeHtml(d.to_user) + ' · #' + escapeHtml(String(d.id)) +
            ' · ' + escapeHtml(fmtTime(d.sent_at || d.created_at)) +
            ' <span style="color:var(--text-xs,#6e7681);font-weight:400">— click the line above to close</span></div>' +
            escapeHtml(d.body || '');
        } catch (e) { boxP.textContent = 'Could not open #' + pid + '.'; }
      })();
      return;
    }

    // Filter button
    var fbtn = target.closest('[data-filter-group]');
    if (fbtn) {
      ev.stopPropagation();
      var group = fbtn.getAttribute('data-filter-group');
      var value = fbtn.getAttribute('data-filter-value');
      if (group && value != null) {
        STATE[group] = value;
        lsSet(STATE_KEYS[group], value);
        // The bucket decides WHICH rows the query asks the database for, so picking
        // one has to re-fetch, not just repaint what we already hold. That is also
        // what keeps the count and the list honest: they are the same query.
        if (group === 'bucket') refresh(); else paintAll();
      }
      return;
    }

    var btn = target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');

    if (act === 'read-body') {
      ev.stopPropagation();
      var rcard = btn.closest('.cc-bus-card');
      var rid = rcard && rcard.getAttribute('data-msg-id');
      if (!canSpeak()) { btn.textContent = 'no voice support'; return; }
      if (SPEECH.id === 'msg-' + rid) { stopSpeech(); return; }
      stopSpeech();
      btn.textContent = '◼ Stop';
      btn.classList.add('speaking');
      speak(spokenTextFor(rcard), 'msg-' + rid);
      return;
    }
    if (act === 'read-all') {
      ev.stopPropagation();
      if (!canSpeak()) { btn.textContent = 'no voice support'; return; }
      if (SPEECH.id === 'all') { stopSpeech(); return; }
      stopSpeech();
      var cards = [].slice.call(document.querySelectorAll('#bus-mount .cc-bus-card'));
      if (!cards.length) return;
      var all = cards.map(function (c, i) { return 'Message ' + (i + 1) + '. ' + spokenTextFor(c); }).join(' ... ');
      btn.textContent = '◼ Stop';
      btn.classList.add('speaking');
      speak(all, 'all');
      return;
    }
    if (act === 'toggle-body') {
      ev.stopPropagation();
      var card = btn.closest('.cc-bus-card');
      var body = card && card.querySelector('.cc-bus__body');
      if (body) {
        body.classList.toggle('collapsed');
        btn.textContent = body.classList.contains('collapsed') ? '▾ Show more' : '▴ Show less';
      }
      return;
    }
    if (act === 'approve') {
      ev.stopPropagation();
      var planId = btn.getAttribute('data-plan-id');
      var msgId = btn.getAttribute('data-msg-id');
      var fromUser = btn.getAttribute('data-from');
      if (!planId) return;
      if (confirm('Approve plan ' + planId.slice(0, 8) + '… ?\nThis updates forge_plans.status and posts a confirmation bus.')) {
        approvePlan(planId, msgId, fromUser);
      }
      return;
    }
    if (act === 'bounce') {
      ev.stopPropagation();
      var card2 = btn.closest('.cc-bus-card');
      var reply = card2 && card2.querySelector('[data-role="reply"]');
      if (reply) {
        reply.classList.remove('hidden');
        var input = reply.querySelector('[data-role="reply-input"]');
        // same guard as open-reply-wide — this opener had the identical bare focus()
        if (input) { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }
      }
      return;
    }
    if (act === 'open-plan') {
      ev.stopPropagation();
      var planId2 = btn.getAttribute('data-plan-id');
      if (planId2) openPlan(planId2);
      return;
    }
    if (act === 'send-reply') {
      ev.stopPropagation();
      var card3 = btn.closest('.cc-bus-card');
      var input2 = card3 && card3.querySelector('[data-role="reply-input"]');
      if (!input2) return;
      var parentId = input2.getAttribute('data-parent-id');
      var to = input2.getAttribute('data-to');
      var text = input2.value;
      sendReply(parentId, to, text);
      input2.value = '';
      return;
    }
    if (act === 'open-reply-wide') {
      ev.stopPropagation();
      var cardR = btn.closest('.cc-bus-card');
      var panelR = cardR && cardR.querySelector('[data-role="reply-wide"]');
      if (panelR) {
        draftSet(cardR.getAttribute('data-msg-id'), {});   // the panel being open is itself durable
        panelR.classList.remove('hidden');
        var taR = panelR.querySelector('[data-role="reply-wide-input"]');
        // preventScroll: un-hiding the panel adds ~80px of textarea BELOW the card's old
        // bottom edge, so a bare focus() makes the browser scroll .cc-bus__main (or the
        // operator lane under 1100px) to reveal it — the card lurches away under the cursor.
        // The ✦ Close button opens this same panel and already guards it (see below).
        if (taR) { try { taR.focus({ preventScroll: true }); } catch (e) { taR.focus(); } }
      }
      return;
    }
    if (act === 'open-forward') {
      ev.stopPropagation();
      var cardF = btn.closest('.cc-bus-card');
      var panelF = cardF && cardF.querySelector('[data-role="reply-wide"]');
      if (!panelF) return;
      panelF.classList.remove('hidden');
      cardF.setAttribute('data-fwd', '1');
      var selF = panelF.querySelector('[data-role="fwd-to"]');
      if (selF) selF.classList.remove('hidden');
      // Remember WHO, not just that the picker is showing. Forward used to be
      // DOM-only: one repaint and Send quietly went back to the thread partner.
      draftSet(cardF.getAttribute('data-msg-id'), { fwdTo: (selF && selF.value) || 'forge-code' });
      var hintF = panelF.querySelector('.cc-bus__reply-wide-hint');
      if (hintF) hintF.textContent = 'Forwarding this thread — pick who joins the mix:';
      var taF = panelF.querySelector('[data-role="reply-wide-input"]');
      if (taF) {
        taF.placeholder = 'Optional note — the whole thread rides along either way.';
        try { taF.focus({ preventScroll: true }); } catch (e) { taF.focus(); }
      }
      return;
    }
    if (act === 'toggle-close-on-send') {
      // Arm/disarm the close-on-send flag for this card. When armed, hitting
      // Send on the reply panel will also archive this thread (status=archived).
      // Visibility: archived rows hide from default V2 view but stay in DB —
      // cowork/forge-code can still query them. No data loss.
      ev.stopPropagation();
      var cardK = btn.closest('.cc-bus-card');
      if (!cardK) return;
      var armed = cardK.getAttribute('data-close-on-send') === '1';
      if (armed) {
        cardK.removeAttribute('data-close-on-send');
        btn.classList.remove('is-armed');
        btn.textContent = '✦ Close';
      } else {
        cardK.setAttribute('data-close-on-send', '1');
        btn.classList.add('is-armed');
        btn.textContent = '✓ Close';
      }
      draftSet(cardK.getAttribute('data-msg-id'), { armed: !armed });
      // Also open the reply panel so user can type immediately.
      var panelK = cardK.querySelector('[data-role="reply-wide"]');
      if (panelK) {
        panelK.classList.remove('hidden');
        var taK = panelK.querySelector('[data-role="reply-wide-input"]');
        if (taK) { try { taK.focus({ preventScroll: true }); } catch (e) { taK.focus(); } }
      }
      return;
    }
    if (act === 'cancel-reply-wide') {
      ev.stopPropagation();
      var cardC = btn.closest('.cc-bus-card');
      var panelC = cardC && cardC.querySelector('[data-role="reply-wide"]');
      if (panelC) {
        panelC.classList.add('hidden');
        var taC = panelC.querySelector('[data-role="reply-wide-input"]');
        if (taC) taC.value = '';
        var selC = panelC.querySelector('[data-role="fwd-to"]');
        if (selC) selC.classList.add('hidden');
      }
      if (cardC) {
        cardC.removeAttribute('data-fwd');
        cardC.removeAttribute('data-close-on-send');
        draftClear(cardC.getAttribute('data-msg-id'));   // Cancel is the ONE way a draft dies unsent
      }
      return;
    }
    if (act === 'send-reply-wide') {
      ev.stopPropagation();
      var cardS = btn.closest('.cc-bus-card');
      var taS = cardS && cardS.querySelector('[data-role="reply-wide-input"]');
      if (!taS) return;
      var pIdS = taS.getAttribute('data-parent-id');
      var toS = taS.getAttribute('data-to');
      // The DRAFT is the truth, not the DOM: a repaint between arming and
      // sending used to silently disarm Close and drop the forward target.
      var dS = draftGet(cardS.getAttribute('data-msg-id')) || {};
      var closeOnSend = dS.armed || cardS.getAttribute('data-close-on-send') === '1';
      // Forward mode: recipient comes from the picker, and an empty note still
      // sends — the thread itself is the message.
      var fwdSelS = cardS.querySelector('[data-role="fwd-to"]');
      var fwdTo = dS.fwdTo || (cardS.getAttribute('data-fwd') === '1' && fwdSelS ? fwdSelS.value : null);
      if (fwdTo) {
        toS = (fwdSelS && !fwdSelS.classList.contains('hidden')) ? fwdSelS.value : fwdTo;
        if (!taS.value.trim()) taS.value = 'fwd: see thread';
        cardS.removeAttribute('data-fwd');
      }
      sendReplyWide(pIdS, toS, taS.value, closeOnSend ? pIdS : null);
      draftClear(cardS.getAttribute('data-msg-id'));   // sent — the draft is spent
      taS.value = '';
      var panelS = cardS.querySelector('[data-role="reply-wide"]');
      if (panelS) panelS.classList.add('hidden');
      // Clear the close-on-send flag now that we've fired (and the next render
      // will rebuild the card with the default state).
      cardS.removeAttribute('data-close-on-send');
      return;
    }
    if (act === 'save') {
      ev.stopPropagation();
      var cardSv = btn.closest('.cc-bus-card');
      if (!cardSv) return;
      saveBusV2(cardSv.getAttribute('data-msg-id'), !!btn.getAttribute('data-saved'));
      return;
    }
    if (act === 'toggle-done') {
      ev.stopPropagation();
      var cardDn = btn.closest('.cc-bus-card');
      if (!cardDn) return;
      var mIdDn = cardDn.getAttribute('data-msg-id');
      // Done drops the card out of the list. If there is an unsent reply on it,
      // that text would go with it — ask first instead of eating the words.
      if (btn.getAttribute('data-done') !== '1' && draftHasText(mIdDn)) {
        if (!window.confirm('You have an unsent reply on #' + mIdDn + '.\n\nMarking it done takes the card off the list and discards what you typed.\n\nDiscard it and mark done?')) return;
      }
      draftClear(mIdDn);
      doneBus(mIdDn, btn.getAttribute('data-done') === '1');
      return;
    }
    if (act === 'set-flag') {
      ev.stopPropagation();
      var cardSf = btn.closest('.cc-bus-card');
      if (!cardSf) return;
      setBusFlagV2(cardSf.getAttribute('data-msg-id'), btn.getAttribute('data-flag') || null);
      return;
    }
    if (act === 'archive') {
      ev.stopPropagation();
      var cardA = btn.closest('.cc-bus-card');
      if (!cardA) return;
      var mIdA = cardA.getAttribute('data-msg-id');
      var isArchived = cardA.classList.contains('is-archived');
      // bus #3918 item 5: archive must not be a one-tap escape on a question
      // nobody answered. Unarchiving is always free — it destroys nothing.
      if (!isArchived && isUnansweredAsk(mIdA)) {
        var rowU = rowById(mIdA);
        var whoU = rowU ? (rowU.to_user || 'someone') : 'someone';
        if (!window.confirm(
          'Bus #' + mIdA + ' asked ' + whoU + ' to do something, and nobody has replied to it yet.\n\n' +
          'Archiving hides it. The ask does not go away.\n\nArchive it anyway?')) return;
      }
      if (!isArchived && draftHasText(mIdA)) {
        if (!window.confirm('You have an unsent reply on #' + mIdA + '.\n\nArchiving hides the card and discards what you typed.\n\nDiscard it and archive?')) return;
      }
      draftClear(mIdA);
      archiveBus(mIdA, isArchived);
      return;
    }
    // 'delete' handler removed 2026-08-04 — the button is gone. It wrote exactly what
    // Archive writes; keeping a second control for one behaviour only made the board lie.
    if (act === 'chip') {
      ev.stopPropagation();
      var t = btn.getAttribute('data-target');
      var mount = document.getElementById(MOUNT_ID);
      var input3 = mount && mount.querySelector('[data-role="compose-input"]');
      if (!input3 || !t) return;
      var tag = '@' + t.replace('forge-', '') + ' ';
      // Strip any existing leading @-tag
      var cur = input3.value.replace(/^@(code|cowork|design|reanna)\s*/i, '');
      input3.value = tag + cur;
      input3.focus();
      return;
    }
    if (act === 'compose-send') {
      ev.stopPropagation();
      var mount2 = document.getElementById(MOUNT_ID);
      var input4 = mount2 && mount2.querySelector('[data-role="compose-input"]');
      if (!input4) return;
      composeSend(input4.value);
      input4.value = '';
      return;
    }
    if (act === 'toggle-font') {
      ev.stopPropagation();
      var cur = busFontPref();
      var next = (cur === 'off') ? 'on' : 'off';
      try { window.localStorage.setItem(BUS_FONT_LS, next); } catch (e) {}
      if (next === 'on') ensureLexendCss();
      applyBusFont(next === 'on');
      return;
    }
  });

  // Search input (debounced)
  var searchDebounce = null;
  document.addEventListener('input', function (ev) {
    var target = ev.target;
    if (!target || !target.matches) return;
    if (target.matches('#' + MOUNT_ID + ' [data-role="search"]')) {
      clearTimeout(searchDebounce);
      var val = target.value;
      searchDebounce = setTimeout(function () {
        STATE.search = val;
        lsSet(STATE_KEYS.search, val);
        paintAll();
        // Restore focus + caret to search input after re-paint
        var mount = document.getElementById(MOUNT_ID);
        var s = mount && mount.querySelector('[data-role="search"]');
        if (s) { s.focus(); s.setSelectionRange(val.length, val.length); }
      }, 180);
    }
    // Every keystroke in a reply box lands in the durable draft, so the next
    // repaint (poll, realtime, Done, filter change) re-emits it instead of
    // eating it. Cheap: one localStorage write per debounce tick.
    if (target.matches('#' + MOUNT_ID + ' [data-role="reply-wide-input"]')) {
      var cardIn = target.closest('.cc-bus-card');
      if (cardIn) {
        clearTimeout(draftDebounce);
        var txt = target.value, mid = cardIn.getAttribute('data-msg-id');
        draftDebounce = setTimeout(function () { draftSet(mid, { text: txt }); }, 150);
      }
    }
  });
  var draftDebounce = null;

  // Who a forward goes to is durable too — picking a name is a decision, and a
  // repaint must never quietly hand it back to the thread partner.
  document.addEventListener('change', function (ev) {
    var target = ev.target;
    if (!target || !target.matches) return;
    if (!target.matches('#' + MOUNT_ID + ' [data-role="fwd-to"]')) return;
    var cardCh = target.closest('.cc-bus-card');
    if (cardCh) draftSet(cardCh.getAttribute('data-msg-id'), { fwdTo: target.value });
  });

  // Enter key in reply input sends; Cmd/Ctrl+Enter in composer sends
  document.addEventListener('keydown', function (ev) {
    var target = ev.target;
    if (!target || !target.matches) return;
    if (target.matches('#' + MOUNT_ID + ' [data-role="reply-input"]') && ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      var parentId = target.getAttribute('data-parent-id');
      var to = target.getAttribute('data-to');
      sendReply(parentId, to, target.value);
      target.value = '';
      return;
    }
    if (target.matches('#' + MOUNT_ID + ' [data-role="compose-input"]') && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      composeSend(target.value);
      target.value = '';
      return;
    }
    if (target.matches('#' + MOUNT_ID + ' [data-role="reply-wide-input"]') && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      var parentId = target.getAttribute('data-parent-id');
      var to = target.getAttribute('data-to');
      // Honour ✦ Close here too. This path used to call sendReplyWide with no 4th
      // argument, so arming Close and then sending with the keyboard silently dropped
      // it — while the textarea placeholder tells you to send with Cmd/Ctrl+Enter.
      // Following the on-screen instruction defeated the button.
      var cardKb = target.closest('.cc-bus-card');
      var dKb = cardKb ? (draftGet(cardKb.getAttribute('data-msg-id')) || {}) : {};
      var closeKb = dKb.armed || (cardKb && cardKb.getAttribute('data-close-on-send') === '1');
      // Keyboard send honours a chosen forward target as well — the mouse path
      // did and this one did not, so ⌘/Ctrl+Enter used to mail the wrong person.
      if (dKb.fwdTo) {
        to = dKb.fwdTo;
        if (!target.value.trim()) target.value = 'fwd: see thread';
      }
      sendReplyWide(parentId, to, target.value, closeKb ? parentId : null);
      if (cardKb) draftClear(cardKb.getAttribute('data-msg-id'));
      target.value = '';
      var card = target.closest('.cc-bus-card');
      var panel = card && card.querySelector('[data-role="reply-wide"]');
      if (panel) panel.classList.add('hidden');
      return;
    }
  });

  // ─── Sticky offset for the topstack — measured from cc-subnav at runtime.
  // The subnav can wrap to two rows when the active lane has many subtabs;
  // a hardcoded top:125px leaks the cards through. Measure cc-subnav.bottom
  // and set a CSS custom property the topstack reads. Alessio direct 2026-05-17.
  //
  // OVERLAP: we subtract 2px so the topstack pins 2 pixels INTO the bottom
  // of cc-subnav. Subnav has z-index:98 (topstack:5), so the overlap is
  // invisible — but it kills the sub-pixel seam Alessio saw flashing
  // through the border-stroke. Without the overshoot, sub-pixel rounding
  // on hi-DPI or browser zoom leaves a half-pixel sliver where cards leak.
  function updateStickyOffset() {
    // the command face names its subtab strip #subnav — same strip, third name
    var subnav = document.getElementById('cc-subnav') || document.querySelector('.cc-subnav') || document.getElementById('subnav');
    var mount = document.getElementById(MOUNT_ID);
    if (!subnav || !mount) return;
    var cs = window.getComputedStyle(subnav);
    var pinnedTop = parseFloat(cs.top);
    if (isNaN(pinnedTop)) pinnedTop = 91;
    var height = subnav.offsetHeight || 34;
    var OVERLAP_PX = 2;
    mount.style.setProperty('--bus-stick-top', (pinnedTop + height - OVERLAP_PX) + 'px');
  }

  // ─── Dyslexia-friendly font (Lexend) — default ON, persists, refresh-safe.
  // Alessio direct 2026-05-17. Same localStorage key as the (now-orphaned) v1.
  var BUS_FONT_LS = 'cc.operator.bus.chatFont';
  function busFontPref() {
    try { return window.localStorage.getItem(BUS_FONT_LS); } catch (e) { return null; }
  }
  function ensureLexendCss() {
    if (document.getElementById('bus-lexend-css')) return;
    var link = document.createElement('link');
    link.id = 'bus-lexend-css';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Lexend:wght@400;500&display=swap';
    document.head.appendChild(link);
  }
  function applyBusFont(on) {
    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    if (on) mount.classList.add('font-lexend');
    else    mount.classList.remove('font-lexend');
    var btn = mount.querySelector('[data-act="toggle-font"]');
    if (btn) {
      if (on) btn.classList.add('on');
      else    btn.classList.remove('on');
    }
  }

  function init() {
    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;
    // Set BROWSER_SESSION_ID synchronously so composer INSERTs always have it,
    // then register the row in forge_sessions in the background (best-effort).
    BROWSER_SESSION_ID = getOrCreateBrowserSessionId();
    var client = sb();
    if (client) registerBrowserSession(client);
    // Apply persisted Lexend preference (default ON) before the first paint.
    var fontOn = (busFontPref() !== 'off');
    if (fontOn) ensureLexendCss();
    applyBusFont(fontOn);
    // Measure cc-subnav so the sticky topstack abuts its bottom edge.
    // Re-measure on resize because subnav wraps to two rows at certain widths.
    updateStickyOffset();
    setTimeout(updateStickyOffset, 100);  // catch late-rendered subtabs
    setTimeout(updateStickyOffset, 500);
    window.addEventListener('resize', updateStickyOffset);
    refresh();
    // Wire isUserBusy typing tracker on the mount node (capture phase catches all).
    var mountForBusy = document.getElementById(MOUNT_ID);
    if (mountForBusy) mountForBusy.addEventListener('input', noteTyping, true);
    // 30s poll, but skip when tab hidden OR user is typing/focused on bus input.
    setInterval(function () {
      if (document.hidden) return;
      if (isUserBusy()) return; // try again on next tick — user finishing typing
      refresh();
    }, REFRESH_MS);

    // AND ON THE WAY BACK IN. The poll is paused while the tab is hidden, so a board
    // left open overnight used to show him yesterday's numbers for up to thirty
    // seconds after he looked at it — long enough to read them and believe them.
    // Coming back to the tab, or to the window, re-asks immediately.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !isUserBusy()) refresh();
    });
    window.addEventListener('focus', function () {
      if (!isUserBusy()) refresh();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
