/* cc-col-resize.js — reusable column resizer for the Command Center.
 *
 * Makes any multi-column GRID surface resizable. The drag-bars are ABSOLUTELY
 * POSITIONED OVERLAYS on top of the column boundaries — they are NOT inserted as
 * grid columns — so the surface's own layout is never disturbed on load. (An
 * earlier version inserted bars as columns and squished the grid until you
 * dragged.) The grid's grid-template-columns is only touched when you actually
 * resize, or to restore your saved sizes.
 *
 * Bars show ONLY while the ✎ edit switch is on (body.cc-edit-on). Dragging uses
 * POINTER events, so it works with mouse AND touch (iPad / iPhone). Widths
 * persist per browser and restore on load. Bars hide, and saved widths stop being
 * applied, once the grid stacks — at each surface's OWN stack width (default 700:
 * iPads keep columns + resize, 2026-06-09; the 4-col Shop grids wrap at 1100).
 *
 * Rollout: add an entry to SURFACES (sel + key, plus `stack` when the surface's
 * CSS wraps above 700px). An observer auto-applies to matching grids as they
 * render (handles the CC's JS-rendered / re-mounted surfaces). A grid qualifies
 * only if ALL its direct element children are columns.
 *
 * Tasks (.cc-tms-3col) is intentionally NOT listed — it has its own inline
 * resizer in cc-task-multidispatch.js.
 */
(function () {
  'use strict';

  // stack: the width at or below which the SURFACE'S OWN CSS stops showing its
  // full column set. Below it the resizer hides its bars and stops applying saved
  // widths, so it never fights the surface's responsive layout. Default 700 (the
  // 3-col surfaces — iPads keep columns + resize, 2026-06-09). The 4-col Shop
  // surfaces wrap to 2x2 at 1100, so they declare 1100 (2026-07-27).
  var SURFACES = [
    { sel: '.rnd-3col:not(.bmc3)', key: 'cc.rnd.cols'     }, // QuadFang R&D 3-col (bmc3 excluded: 2 cols + iframe)
    { sel: '.in-3col',             key: 'cc.interns.cols' }, // Interns (list | detail | bus)
    { sel: '.p3d-3col',            key: 'cc.p3d.cols'     }, // 3D Printing (nav | doc | bus) — layout standard 2026-07-27
    { sel: '.dash-3col',           key: 'cc.dash.cols'    }, // Dashboard (areas | overview | bus)
    { sel: '.ht4',                 key: 'cc.ht.cols',   stack: 1100 }, // Shop > Heat Treat (steel | procs | phases | detail+bus)
    { sel: '.ah4',                 key: 'cc.ah.cols',   stack: 1100 }, // Shop > After-Hours (days | steps | viewer | bus)
    { sel: '.knp-3col',            key: 'cc.knp.cols'   }, // Shop > Patterns (knives | pattern | bus) — 2026-08-06
    { sel: '.hw-3col',             key: 'cc.hw.cols'    }, // Hardware (builds | buy board + history | bus) — bus #4224, 2026-08-06
    { sel: '.scx-3col',            key: 'cc.scx.cols'   }, // Services > Queue scheduling module (nav | job | bus) — 2026-08-08
    { sel: '.svsc-3col',           key: 'cc.svsched.cols' }, // Services > Schedule (hours | blocks | bus) — 2026-08-09
    { sel: '.txm-3col',            key: 'cc.txm.cols'   } // Services > Texts (nav | message | bus) — 2026-08-14
  ];

  var DEFAULT_STACK = 700;

  if (!document.getElementById('ccr-style')) {
    var st = document.createElement('style');
    st.id = 'ccr-style';
    st.textContent =
      '.ccr-handle{position:absolute;top:0;height:100%;width:14px;box-sizing:border-box;cursor:col-resize;touch-action:none;pointer-events:none;background:transparent;z-index:6;}' +
      'body.cc-edit-on .ccr-handle{pointer-events:auto;background:linear-gradient(to right,transparent calc(50% - 1px),var(--amber-dim,var(--amber,#d29922)) calc(50% - 1px),var(--amber-dim,var(--amber,#d29922)) calc(50% + 1px),transparent calc(50% + 1px));}' +
      'body.cc-edit-on .ccr-handle:hover,body.cc-edit-on .ccr-handle.ccr-dragging{background:linear-gradient(to right,transparent calc(50% - 2px),var(--amber,#ffb000) calc(50% - 2px),var(--amber,#ffb000) calc(50% + 2px),transparent calc(50% + 2px));}';
    // Per-surface stack widths are enforced in JS (each grid has its own mq), so
    // no global media rule here — a 700px rule would leave the 1100px surfaces
    // showing bars over a wrapped 2x2 layout.
    (document.head || document.documentElement).appendChild(st);
  }

  function colsOf(grid) {
    return Array.prototype.filter.call(grid.children, function (c) {
      return c.nodeType === 1 && !c.classList.contains('ccr-handle');
    });
  }

  window.ccColResize = function (grid, opts) {
    opts = opts || {};
    if (!grid || grid.dataset.ccrDone === '1') return;
    var cols = colsOf(grid);
    if (cols.length < 2) return;
    grid.dataset.ccrDone = '1';

    var KEY = opts.key || ('cc.ccr.' + (grid.id || 'grid'));
    var MIN = opts.min || 140;
    var N = cols.length;
    var mq = window.matchMedia('(max-width: ' + (opts.stack || DEFAULT_STACK) + 'px)');

    if (getComputedStyle(grid).position === 'static') grid.style.position = 'relative';

    var frs = null;
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && s.length === N && s.every(function (x) { return isFinite(x) && x > 0.05; })) frs = s.map(Number);
    } catch (e) {}

    // Apply ONLY saved widths (N fr values → matches the grid's N tracks; no extra
    // tracks, no distortion). On mobile, leave the surface to stack via its own CSS.
    function applySaved() {
      if (mq.matches) { grid.style.removeProperty('grid-template-columns'); return; }
      if (!frs) return;
      var p = []; for (var k = 0; k < N; k++) p.push(frs[k] + 'fr');
      grid.style.gridTemplateColumns = p.join(' ');
    }
    applySaved();

    // create N-1 ABSOLUTE overlay handles (do NOT count as columns / grid items)
    var handles = [];
    for (var k = 0; k < N - 1; k++) {
      var h = document.createElement('div');
      h.className = 'ccr-handle';
      h.setAttribute('data-ccr-k', String(k));
      h.title = 'Drag to resize';
      grid.appendChild(h);
      handles.push(h);
    }

    function reposition() {
      var c = colsOf(grid);
      if (mq.matches || c.length !== N) { handles.forEach(function (h) { h.style.display = 'none'; }); return; }
      var gridLeft = grid.getBoundingClientRect().left;
      handles.forEach(function (h, i) {
        var a = c[i].getBoundingClientRect(), b = c[i + 1].getBoundingClientRect();
        if (a.width === 0 || b.width === 0) { h.style.display = 'none'; return; }
        h.style.display = '';
        var center = ((a.right - gridLeft) + (b.left - gridLeft)) / 2;
        h.style.left = (center - 7) + 'px';
      });
    }
    reposition();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(reposition);
      ro.observe(grid);
      colsOf(grid).forEach(function (c) { ro.observe(c); });
    }
    window.addEventListener('resize', reposition);
    if (mq.addEventListener) mq.addEventListener('change', function () { applySaved(); reposition(); });
    // catch late layout (data loads / tab becomes visible) for a few seconds
    var t = setInterval(reposition, 500);
    setTimeout(function () { clearInterval(t); }, 8000);

    handles.forEach(function (handle) {
      handle.addEventListener('pointerdown', function (ev) {
        if (mq.matches) return;
        var k = parseInt(handle.getAttribute('data-ccr-k'), 10); // boundary between col k and k+1
        var c = colsOf(grid); if (c.length !== N) return;
        var wA = c[k].getBoundingClientRect().width, wB = c[k + 1].getBoundingClientRect().width;
        var totalPx = c.reduce(function (s, x) { return s + x.getBoundingClientRect().width; }, 0);
        if (!(wA > 0 && wB > 0 && totalPx > 0)) return;
        var base = frs ? frs.slice() : c.map(function (x) { return x.getBoundingClientRect().width; });
        var startX = ev.clientX;
        try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
        handle.classList.add('ccr-dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        ev.preventDefault();

        function move(e) {
          var S = wA + wB, d = e.clientX - startX;
          var nA = Math.max(MIN, Math.min(S - MIN, wA + d)), nB = S - nA;
          var tf = base.reduce(function (s, x) { return s + x; }, 0), u = totalPx / tf;
          if (!isFinite(u) || u <= 0) return;
          var f = base.slice(); f[k] = nA / u; f[k + 1] = nB / u;
          if (!f.every(function (x) { return isFinite(x) && x > 0; })) return;
          frs = f;
          var p = []; for (var i = 0; i < N; i++) p.push(frs[i] + 'fr');
          grid.style.gridTemplateColumns = p.join(' ');
          reposition();
          e.preventDefault();
        }
        function up() {
          handle.classList.remove('ccr-dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          try { if (frs) localStorage.setItem(KEY, JSON.stringify(frs.map(function (n) { return +n.toFixed(4); }))); } catch (e) {}
          reposition();
        }
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    });
  };

  function sweep(root) {
    SURFACES.forEach(function (s) {
      var scope = (root && root.querySelectorAll) ? root : document;
      scope.querySelectorAll(s.sel).forEach(function (grid) { try { window.ccColResize(grid, { key: s.key, stack: s.stack }); } catch (e) {} });
      if (root && root.matches && root.matches(s.sel)) { try { window.ccColResize(root, { key: s.key, stack: s.stack }); } catch (e) {} }
    });
  }

  function start() {
    sweep(document);
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) { if (added[j].nodeType === 1) sweep(added[j]); }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
