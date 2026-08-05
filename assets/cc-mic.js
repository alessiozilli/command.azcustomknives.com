/* azck-faces · cc-mic.js v1
 * Universal mic: every text input / textarea on the page gets a 🎤 button.
 * Click → continuous + interim dictation into that field. Click again → stop.
 * Skip rules:
 *   - <input type="password|email|number|tel|search|url|hidden|...">  (text only)
 *   - elements with [data-no-mic] (or any ancestor)
 *   - elements with [data-mic-custom] (chat input owns its own UI)
 *   - readonly / disabled
 * Auto-discovers new inputs added later via MutationObserver.
 */
(function () {
  'use strict';

  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) return; // silently no-op on unsupported browsers

  var STYLE = '\
    .cc-mic-wrap { position:relative; display:inline-block; }\
    .cc-mic-wrap.block { display:block; }\
    .cc-mic-btn-uni { position:absolute; right:4px; top:50%; transform:translateY(-50%); z-index:5;\
      width:24px; height:24px; padding:0; border-radius:50%; border:1px solid rgba(120,120,120,0.4);\
      background:rgba(0,0,0,0.18); color:#fff; cursor:pointer; font-size:11px; line-height:1;\
      display:flex; align-items:center; justify-content:center; opacity:0.55; transition:opacity 0.15s, background 0.15s; }\
    .cc-mic-btn-uni:hover { opacity:1; background:rgba(200,146,42,0.7); }\
    .cc-mic-btn-uni.listening { background:#e5534b; color:#fff; opacity:1; border-color:#e5534b;\
      animation: cc-mic-uni-pulse 1.2s ease-in-out infinite; }\
    @keyframes cc-mic-uni-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(229,83,75,0.7); } 50% { box-shadow: 0 0 0 6px rgba(229,83,75,0); } }\
    .cc-mic-btn-uni:focus { outline:1px solid #c8922a; outline-offset:1px; }\
    .cc-mic-toast { position:fixed; bottom:14px; right:14px; z-index:9999;\
      background:rgba(0,0,0,0.85); color:#c8922a; font-family:"JetBrains Mono",monospace; font-size:11px;\
      padding:6px 10px; border-radius:4px; border:1px solid rgba(200,146,42,0.4); pointer-events:none; max-width:340px; }\
  ';
  var s = document.createElement('style');
  s.textContent = STYLE;
  document.head.appendChild(s);

  // Single shared recognizer state (only one mic active at a time anyway)
  var rec = null;
  var listening = false;
  var prefix = '';
  var sessionFinal = '';
  var restartTimer = null;
  var activeBtn = null;
  var activeInput = null;

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'cc-mic-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  function fireInput(el) {
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
  }

  function stop() {
    listening = false;
    try { rec && rec.stop(); } catch (e) {}
    if (activeBtn) activeBtn.classList.remove('listening');
    activeBtn = null;
    activeInput = null;
    sessionFinal = '';
    prefix = '';
  }

  function makeAndStart() {
    rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onstart = function () { if (activeBtn) activeBtn.classList.add('listening'); };
    rec.onend = function () {
      if (listening) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(function () {
          if (listening) {
            try { makeAndStart(); } catch (err) { stop(); }
          }
        }, 120);
      } else if (activeBtn) {
        activeBtn.classList.remove('listening');
      }
    };
    rec.onerror = function (e) {
      var err = e && e.error;
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
        toast('🎤 mic permission denied');
        stop();
      }
    };
    rec.onresult = function (e) {
      if (!activeInput) return;
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var t = e.results[i][0].transcript;
        if (e.results[i].isFinal) sessionFinal += t;
        else interim += t;
      }
      activeInput.value = prefix + sessionFinal + interim;
      fireInput(activeInput);
    };
    try { rec.start(); } catch (err) { console.warn('[cc-mic] start failed', err); stop(); }
  }

  function start(input, btn) {
    // If something else is recording, stop it first
    if (listening) stop();
    activeInput = input;
    activeBtn = btn;
    listening = true;
    prefix = input.value || '';
    if (prefix && !prefix.endsWith(' ') && !prefix.endsWith('\n')) prefix += ' ';
    sessionFinal = '';
    try { input.focus(); } catch (e) {}
    makeAndStart();
  }

  function eligible(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.closest('[data-no-mic]')) return false;
    if (el.matches('[data-mic-custom]')) return false; // owner handles its own mic
    // co-chat-input owns its own bigger mic + transcript line — skip
    if (el.id === 'co-chat-input') return false;
    // operator-lane chat (chat-input) had its own listener but no visible button — let universal handle it
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      var type = (el.type || 'text').toLowerCase();
      var allow = ['text', 'search', 'url', '', 'textarea'];
      return allow.indexOf(type) !== -1;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function attach(input) {
    if (!eligible(input)) return;
    if (input.dataset._micWired) return;
    input.dataset._micWired = '1';

    var parent = input.parentElement;
    if (!parent) return;

    // Wrap the input so the mic button is anchored to the input's box,
    // not the parent. Avoids clashes with flex/grid sibling layout.
    var wrap = document.createElement('span');
    wrap.className = 'cc-mic-wrap';
    // Match the input's display behavior — block textareas keep their full width.
    var disp = window.getComputedStyle(input).display;
    if (disp === 'block' || input.tagName === 'TEXTAREA') {
      wrap.classList.add('block');
      wrap.style.width = '100%';
    }
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cc-mic-btn-uni';
    btn.title = 'Dictate (click to start, click again to stop)';
    btn.setAttribute('aria-label', 'Dictate to this field');
    btn.textContent = '🎤';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      try { window.speechSynthesis && window.speechSynthesis.resume && window.speechSynthesis.resume(); } catch (err) {}
      if (listening && activeInput === input) {
        stop();
      } else {
        start(input, btn);
      }
    });
    wrap.appendChild(btn);

    // Pad the input so the cursor isn't hidden behind the button.
    if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
      try {
        var pr = parseInt(window.getComputedStyle(input).paddingRight, 10) || 0;
        if (pr < 32) input.style.paddingRight = '32px';
      } catch (e) {}
    }
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll('textarea, input, [contenteditable="true"]');
    nodes.forEach(attach);
  }

  function init() {
    scan(document);
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches && n.matches('textarea, input, [contenteditable="true"]')) attach(n);
          if (n.querySelectorAll) scan(n);
        });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
