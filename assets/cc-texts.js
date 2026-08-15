/* CC TEXTS — the message ledger, in the house layout.
   ═══════════════════════════════════════════════════════════════════════════
   Alessio, 2026-08-14: "the Texts tab gets rebuilt in house style, navigation
   left, information middle, communication right." The flat card list this
   replaces was not a surface, it was a pile.

   NAVIGATION  (left)   who is waiting, who failed, who has been told
   INFORMATION (middle) the text itself, the job behind it, the money spelled
                        out, and the whole back-and-forth with that number
   COMMUNICATION(right) the Project Bus — the shared composer, one thread

   THE TWO LAWS THIS SURFACE OBEYS
   1. Nothing sends without his press. Send is the ONLY thing that flips a row
      from draft to approved, and the sender (client-sms POST /run) drains
      approved only. A draft can sit here forever and reach nobody.
   2. The money is CALCULATED, never a placeholder. line_items carry Square's
      catalogue prices, which are PRE-tax; Alberta is GST 5%, no PST. The DB
      function az_pickup_draft_text writes the number into the draft; this
      surface only shows him the arithmetic so he never has to do it.

   The counter for this work is the QUEUE job window (assets/cc-scheduling.js),
   where Send sits directly under mark started / mark done / mark pickup. This
   tab is the ledger behind that counter — same rows, same rules, wider view.

   Fully self-contained: injects its own DOM + CSS into one host element.
   Host contract: window.supa (signed-in Supabase client) + one <div>.
   Mount: CCTexts.mount(el). One module, copied byte-identical per face.

   Author: forge-code · Opus 5 · tortuga · 2026-08-14 */
(function(){
  'use strict';
  if(window.CCTexts) return;   // one copy, ever

  var SEND_URL  = 'https://twrlvnfszohyrmivdhre.supabase.co/functions/v1/client-sms/run';
  var BUS_SLUG  = 'azck-operations-cowork';
  var GST       = 0.05;

  var S = {
    host: null, rows: null, bookings: [], sel: null, err: null,
    busy: false, msg: null, bad: false, later: null, when: null, force: false,
    folded: {}    // group key -> true when shut
  };

  /* ══════════════ small helpers ══════════════ */
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function cad(n){ return '$' + Number(n).toFixed(2); }
  function day(s){ return s ? String(s).slice(0,10) : ''; }
  function ago(ts){
    if(!ts) return '';
    var m = Math.floor((Date.now() - new Date(ts).getTime())/60000);
    if(m < 1)    return 'just now';
    if(m < 60)   return m + ' min ago';
    if(m < 1440) return Math.floor(m/60) + ' h ago';
    return Math.floor(m/1440) + ' d ago';
  }
  /* digits only, so "780-897-3944 (text)" and "+17808973944" are the same person */
  function digits(p){ return String(p||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,''); }

  /* ── THE TIMER (2026-08-14, "build it") ──
     status='approved' is still the only armed state and only his press sets it;
     send_after just tells the sender to hold. pg_cron asks the sender every
     minute whether anything is due — punctual to the minute, nothing awake. */
  function pad2(n){ return String(n).padStart(2,'0'); }
  function localStamp(d){
    return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate())
      +'T'+pad2(d.getHours())+':'+pad2(d.getMinutes());
  }
  function tomorrow9(){
    var d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0);
    return localStamp(d);
  }
  function whenWords(iso){
    if(!iso) return '';
    var d = new Date(iso); if(isNaN(d.getTime())) return '';
    var now = new Date(), t = new Date(); t.setDate(t.getDate()+1);
    function dayOf(x){ return x.getFullYear()+'-'+x.getMonth()+'-'+x.getDate(); }
    var clock = ((d.getHours()%12)||12)+':'+pad2(d.getMinutes())+' '+(d.getHours()<12?'AM':'PM');
    if(dayOf(d) === dayOf(now)) return 'today '+clock;
    if(dayOf(d) === dayOf(t))   return 'tomorrow '+clock;
    return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+', '+clock;
  }
  function isWaiting(r){ return !!r.send_after && new Date(r.send_after).getTime() > Date.now(); }
  function whenIsoOf(stamp){
    var d = new Date(stamp);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /* ── WORDS THAT GO STALE (Alessio, 2026-08-14) ──
     He wrote Brian "ready for pickup TOMORROW", then set the timer for tomorrow
     9 AM. Delivered, it would have read wrong. Weekday names are deliberately
     NOT in here: "open Wednesday and Friday" is recurring shop hours, true
     whenever it lands. Only words anchored to the writing day rot. */
  var DAY_WORDS = /\b(today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening))\b/gi;
  function stalePhrases(body){
    var hits = String(body || '').match(DAY_WORDS);
    if(!hits) return [];
    var seen = {}, out = [];
    hits.forEach(function(h){ var k = h.toLowerCase(); if(!seen[k]){ seen[k] = 1; out.push(k); } });
    return out;
  }
  function sameDay(a, b){
    var x = new Date(a), y = new Date(b);
    if(isNaN(x.getTime()) || isNaN(y.getTime())) return true;   // unknown: do not cry wolf
    return x.getFullYear()===y.getFullYear() && x.getMonth()===y.getMonth() && x.getDate()===y.getDate();
  }
  function staleWarn(body, whenIso, writtenIso){
    if(!whenIso) return '';
    var hits = stalePhrases(body);
    if(!hits.length) return '';
    if(sameDay(writtenIso || Date.now(), whenIso)) return '';
    var list = hits.map(function(h){ return '"'+h+'"'; }).join(' and ');
    return '<div class="txm-money bad">This says '+esc(list)+', but it does not land until '
      + esc(whenWords(whenIso)) + ' — by then those words mean the wrong day. '
      + 'Fix the wording, or send it today.</div>';
  }

  /* the job's own money: priced lines first, the stored total behind them.
     Mirrors az_pickup_draft_text exactly — if one changes, change both. */
  function moneyOf(b){
    if(!b) return null;
    var sub = null;
    if(b.line_items && b.line_items.length){
      sub = b.line_items.reduce(function(a,l){ return a + (Number(l.line_cad) || 0); }, 0);
    }
    if(!(sub > 0) && b.total_cad != null) sub = Number(b.total_cad);
    if(!(sub > 0)) return null;
    return { sub: sub, gst: Math.round(sub*GST*100)/100, total: Math.round(sub*(1+GST)*100)/100 };
  }
  function bookingOf(r){
    if(!r || !r.booking_id) return null;
    for(var i=0;i<S.bookings.length;i++) if(S.bookings[i].id === r.booking_id) return S.bookings[i];
    return null;
  }

  /* ══════════════ DATA ══════════════ */
  var SMS_COLS = 'id,created_at,direction,to_phone,to_name,body,ref,booking_id,status,'
               + 'approved_by,approved_at,sent_at,error,created_by,send_after';
  var BK_COLS  = 'id,customer_name,customer_phone,category,service,blade_detail,quantity,'
               + 'total_cad,line_items,item_location,status,done_at,picked_up_at,notes';

  function load(){
    if(!window.supa){ S.err = 'signin'; paint(); return Promise.resolve(); }
    return Promise.all([
      window.supa.from('az_sms_log').select(SMS_COLS).order('created_at',{ascending:false}).limit(300),
      window.supa.from('az_service_bookings').select(BK_COLS).order('created_at',{ascending:false}).limit(400)
    ]).then(function(res){
      var sm = res[0], bk = res[1];
      if(sm.error) throw sm.error;
      S.rows     = sm.data || [];
      S.bookings = bk.error ? [] : (bk.data || []);
      S.err = null;
    }).catch(function(e){
      console.warn('[texts] load failed', e);
      S.err = (e && e.message) || String(e);
    }).then(function(){ paint(); });
  }

  /* ══════════════ THE LOOK — the CC layout standard, same values as the queue
     module so the two surfaces read as one system (only the prefix differs) ══ */
  var CSS = ''
  + '.txm{font-size:13px;color:var(--text,#dde4eb);}'
  + '.txm *{box-sizing:border-box;}'
  + '.txm-topline{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}'
  + '.txm-hint{font-size:12px;color:var(--text-dim,#8a9aa8);}'
  + '.txm-reload{cursor:pointer;padding:6px 12px;border:1px solid var(--border,#252c33);border-radius:4px;'
  +   'font-family:var(--mono,monospace);font-size:10px;letter-spacing:.08em;text-transform:uppercase;'
  +   'color:var(--text-dim,#8a9aa8);background:var(--raised,#161b20);margin-left:auto;}'
  + '.txm-reload:hover{border-color:var(--amber,#c8922a);color:var(--amber,#c8922a);}'
  + '.txm-3col{display:grid;grid-template-columns:1.25fr 2.3fr 1.45fr;gap:10px;'
  +   'height:calc(100vh - var(--txm-top,248px));min-height:420px;align-items:stretch;position:relative;}'
  + '.txm ::-webkit-scrollbar{width:4px;height:4px;}'
  + '.txm ::-webkit-scrollbar-thumb{background:var(--border,#252c33);border-radius:2px;}'
  + '.txm-col{background:var(--surface,#11161a);border:1px solid var(--border,#252c33);border-radius:6px;'
  +   'padding:10px;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;}'
  + '.txm-col__head{font-family:var(--display-tabs,var(--display,sans-serif));font-size:10px;letter-spacing:.14em;'
  +   'text-transform:uppercase;color:var(--amber,#c8922a);padding-bottom:8px;border-bottom:1px solid var(--border,#252c33);'
  +   'margin-bottom:8px;flex-shrink:0;display:flex;align-items:center;gap:8px;}'
  + '.txm-count{font-family:var(--mono,monospace);font-size:11px;color:var(--text-dim,#8a9aa8);margin-left:auto;}'
  + '.txm-col__body{flex:1 1 0%;min-height:0;overflow-y:auto;}'
  /* left: grouped nav, the WHOLE head folds (never a caret-sized target) */
  + '.txm-group{font-family:var(--display,sans-serif);font-size:11px;font-weight:700;letter-spacing:.18em;'
  +   'text-transform:uppercase;color:var(--text-dim,#8a9aa8);padding:8px 4px 4px;border-bottom:1px dashed var(--border,#252c33);'
  +   'margin-top:8px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;}'
  + '.txm-group:first-child{margin-top:0;}'
  + '.txm-group:hover{color:var(--amber,#c8922a);}'
  + '.txm-group__c{display:inline-block;width:11px;font-size:9px;color:var(--text-xs,#6b7780);}'
  + '.txm-group.open .txm-group__c{color:var(--amber,#c8922a);}'
  + '.txm-group__n{font-family:var(--mono,monospace);font-size:12px;font-weight:700;color:var(--amber,#c8922a);margin-left:auto;}'
  + '.txm-item{padding:8px 10px;border:1px solid transparent;border-radius:4px;cursor:pointer;margin-bottom:4px;line-height:1.4;}'
  + '.txm-item:hover{background:var(--raised,#161b20);border-color:var(--border,#252c33);}'
  + '.txm-item.on{background:rgba(200,146,42,.10);border-color:var(--amber,#c8922a);}'
  + '.txm-item__n{font-size:13px;color:var(--text,#dde4eb);}'
  + '.txm-item.on .txm-item__n{color:var(--amber,#c8922a);}'
  + '.txm-item__s{font-family:var(--mono,monospace);font-size:10px;color:var(--text-dim,#8a9aa8);margin-top:3px;}'
  + '.txm-item__p{font-size:11.5px;color:var(--text-dim,#8a9aa8);margin-top:4px;overflow:hidden;'
  +   'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}'
  /* middle: the product */
  + '.txm-h{font-size:15px;color:var(--text,#dde4eb);margin:0 0 4px;}'
  + '.txm-sub{font-family:var(--mono,monospace);font-size:10.5px;color:var(--text-dim,#8a9aa8);margin-bottom:12px;'
  +   'padding-bottom:10px;border-bottom:1px solid var(--border,#252c33);}'
  + '.txm-row{display:flex;gap:10px;padding:5px 0;font-size:12.5px;line-height:1.5;}'
  + '.txm-row__k{flex:0 0 108px;font-family:var(--mono,monospace);font-size:9.5px;letter-spacing:.06em;'
  +   'text-transform:uppercase;color:var(--text-xs,#6b7780);padding-top:3px;}'
  + '.txm-row__v{flex:1 1 auto;min-width:0;color:var(--text,#dde4eb);}'
  + '.txm-money{font-size:13px;color:var(--text-dim,#8a9aa8);margin:10px 0 8px;}'
  + '.txm-money b{color:var(--text,#dde4eb);font-size:15px;}'
  + '.txm-money.bad{color:#e05252;font-size:12.5px;}'
  + '.txm-label{font-family:var(--mono,monospace);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;'
  +   'color:var(--amber,#c8922a);margin:14px 0 6px;}'
  + '.txm-body{width:100%;background:var(--bg,#0d1114);color:var(--text,#dde4eb);border:1px solid var(--border,#252c33);'
  +   'border-radius:5px;padding:9px 11px;font-family:inherit;font-size:13px;line-height:1.6;resize:vertical;}'
  + '.txm-body:focus{outline:none;border-color:var(--amber,#c8922a);}'
  + '.txm-frozen{background:var(--bg,#0d1114);border:1px solid var(--border,#252c33);border-radius:5px;'
  +   'padding:9px 11px;font-size:13px;line-height:1.6;color:var(--text-dim,#8a9aa8);white-space:pre-wrap;}'
  + '.txm-len{font-family:var(--mono,monospace);font-size:9.5px;color:var(--text-xs,#6b7780);margin-top:5px;}'
  + '.txm-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}'
  + '.txm-act{font-family:var(--display,sans-serif);font-size:10px;letter-spacing:.1em;text-transform:uppercase;'
  +   'padding:8px 14px;background:var(--raised,#161b20);border:1px solid var(--border,#252c33);border-radius:4px;'
  +   'color:var(--text-dim,#8a9aa8);cursor:pointer;}'
  + '.txm-act:hover{border-color:var(--amber,#c8922a);color:var(--amber,#c8922a);}'
  + '.txm-act.send{background:var(--azck-red,#990000);border-color:var(--azck-red,#990000);color:#fff;font-weight:700;}'
  + '.txm-act.send:hover{filter:brightness(1.2);color:#fff;}'
  + '.txm-act:disabled{opacity:.4;cursor:default;}'
  + '.txm-note{font-size:11.5px;color:var(--amber,#c8922a);margin-top:8px;}'
  + '.txm-note.bad{color:#e05252;}'
  + '.txm-timer{margin-top:10px;font-size:14px;color:var(--amber,#c8922a);}'
  + '.txm-when{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;}'
  + '.txm-when input{background:var(--bg,#0d1114);color:var(--text,#dde4eb);border:1px solid var(--border,#252c33);'
  +   'border-radius:4px;padding:8px 10px;font-family:inherit;font-size:12.5px;color-scheme:dark;}'
  + '.txm-when input:focus{outline:none;border-color:var(--amber,#c8922a);}'
  + '.txm-act.on{border-color:var(--amber,#c8922a);color:var(--amber,#c8922a);}'
  + '.txm-tag{font-family:var(--mono,monospace);font-size:9px;letter-spacing:.06em;text-transform:uppercase;'
  +   'padding:2px 7px;border:1px solid var(--border,#252c33);border-radius:10px;color:var(--text-dim,#8a9aa8);}'
  + '.txm-tag.amber{border-color:var(--amber,#c8922a);color:var(--amber,#c8922a);}'
  + '.txm-tag.bad{border-color:#e05252;color:#e05252;}'
  + '.txm-tag.good{border-color:#2ea043;color:#2ea043;}'
  /* the back-and-forth with that number */
  + '.txm-thread{margin-top:6px;}'
  + '.txm-bub{border:1px solid var(--border,#252c33);border-radius:6px;padding:8px 10px;margin-bottom:6px;'
  +   'font-size:12.5px;line-height:1.5;white-space:pre-wrap;}'
  + '.txm-bub.out{background:var(--raised,#161b20);}'
  + '.txm-bub.in{background:var(--bg,#0d1114);border-color:var(--amber,#c8922a);}'
  + '.txm-bub__h{font-family:var(--mono,monospace);font-size:9px;letter-spacing:.05em;text-transform:uppercase;'
  +   'color:var(--text-xs,#6b7780);margin-bottom:4px;}'
  /* the bus column */
  + '.txm-msg{border-bottom:1px solid var(--border,#252c33);padding:7px 0;font-size:12px;'
  +   'color:var(--text-dim,#8a9aa8);line-height:1.5;white-space:pre-wrap;}'
  + '.txm-msg__h{font-family:var(--mono,monospace);font-size:9px;color:var(--text-xs,#6b7780);letter-spacing:.05em;margin-bottom:3px;}'
  + '.txm-empty{font-family:var(--mono,monospace);font-size:11px;color:var(--text-xs,#6b7780);padding:16px;text-align:center;}'
  + '@media (max-width:700px){.txm-3col{grid-template-columns:1fr;height:auto;min-height:0;}'
  +   '.txm-col{max-height:none;}.txm-col__body{overflow:visible;}}';

  function injectCSS(){
    if(document.getElementById('cc-texts-style')) return;
    var s = document.createElement('style');
    s.id = 'cc-texts-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ══════════════ GROUPS — the left column's navigation ══════════════ */
  var GROUPS = [
    { key:'wait',    label:'Waiting on you', pick:function(r){ return r.direction==='outbound' && r.status==='draft'; } },
    { key:'failed',  label:'Did not go through', pick:function(r){ return r.direction==='outbound' && r.status==='failed'; } },
    { key:'timer',   label:'On a timer',     pick:function(r){ return r.direction==='outbound' && r.status==='approved' && isWaiting(r); } },
    { key:'flight',  label:'On its way',     pick:function(r){ return r.direction==='outbound' && r.status==='approved' && !isWaiting(r); } },
    { key:'replies', label:'They wrote back', pick:function(r){ return r.direction!=='outbound'; } },
    { key:'sent',    label:'Told them',      pick:function(r){ return r.direction==='outbound' && r.status==='sent'; } },
    { key:'dropped', label:'Dropped',        pick:function(r){ return r.direction==='outbound' && r.status==='cancelled'; } }
  ];
  /* everything shut except the one thing he acts on — a short column he can read */
  function foldedDefault(key){ return key !== 'wait' && key !== 'timer'; }
  function isFolded(key){ return S.folded[key] === undefined ? foldedDefault(key) : S.folded[key]; }

  function paint(){
    var host = S.host; if(!host) return;
    if(!host.classList.contains('txm')) host.classList.add('txm');

    if(S.err === 'signin'){ host.innerHTML = '<div class="txm-empty">Sign in to see the texts.</div>'; return; }
    if(S.err){ host.innerHTML = '<div class="txm-empty">Could not load: '+esc(S.err)+' — tap ↻ to try again.</div>'; return; }
    if(!S.rows){ host.innerHTML = '<div class="txm-empty">Loading…</div>'; return; }

    var waiting = S.rows.filter(GROUPS[0].pick).length;

    host.innerHTML = '<div class="txm-topline">'
      + '<span class="txm-hint">Marking a job done writes the text. Nothing leaves here until you press Send.</span>'
      + '<span class="txm-reload" id="txm-reload">↻ Reload</span>'
      + '</div>'
      + '<div class="txm-3col">'
      +   '<div class="txm-col"><div class="txm-col__head">Texts'
      +     '<span class="txm-count">'+waiting+' waiting</span></div>'
      +     '<div class="txm-col__body" id="txm-left"></div></div>'
      +   '<div class="txm-col"><div class="txm-col__head">The message</div>'
      +     '<div class="txm-col__body" id="txm-mid"></div></div>'
      +   '<div class="txm-col"><div class="txm-col__head">Project Bus '
      +     '<span class="txm-count" id="txm-bus-count">…</span></div>'
      +     '<div id="txm-bus-composer"></div>'
      +     '<div class="txm-col__body" id="txm-bus-list"></div></div>'
      + '</div>';

    paintLeft();
    paintMid();
    mountBus();
    fitCols();
  }

  function fitCols(){
    if(!S.host) return;
    var g = S.host.querySelector('.txm-3col'); if(!g) return;
    var top = g.getBoundingClientRect().top;
    if(top > 0) S.host.style.setProperty('--txm-top', Math.round(top + 12) + 'px');
  }

  function paintLeft(){
    var left = document.getElementById('txm-left'); if(!left) return;
    var html = '', any = false;

    GROUPS.forEach(function(g){
      var list = S.rows.filter(g.pick);
      if(g.key === 'sent' || g.key === 'dropped' || g.key === 'replies') list = list.slice(0, 30);
      if(!list.length) return;
      any = true;
      var shut = isFolded(g.key);
      html += '<div class="txm-group'+(shut?'':' open')+'" data-txmgroup="'+g.key+'">'
           +    '<span class="txm-group__c">'+(shut?'▶':'▼')+'</span>'+esc(g.label)
           +    '<span class="txm-group__n">'+list.length+'</span></div>';
      if(shut) return;
      html += list.map(function(r){
        var b = bookingOf(r);
        var m = r.direction === 'outbound' ? moneyOf(b) : null;
        return '<div class="txm-item'+(S.sel===r.id?' on':'')+'" data-txmid="'+esc(r.id)+'">'
          + '<div class="txm-item__n">'+esc(r.to_name || r.to_phone || 'Unknown')+'</div>'
          + '<div class="txm-item__s">'
          +   (isWaiting(r) ? '⏱ '+esc(whenWords(r.send_after)) : esc(ago(r.created_at)))
          +   (m ? ' · '+cad(m.total) : (r.direction==='outbound' && r.booking_id && !m ? ' · no price' : ''))
          +   (r.direction !== 'outbound' ? ' · inbound' : '')+'</div>'
          + '<div class="txm-item__p">'+esc(String(r.body||'').slice(0,120))+'</div>'
          + '</div>';
      }).join('');
    });

    left.innerHTML = any ? html
      : '<div class="txm-empty">Nothing here yet. Mark a job done and its text lands in this column.</div>';
  }

  /* ══════════════ MIDDLE — the information ══════════════ */
  function paintMid(){
    var mid = document.getElementById('txm-mid'); if(!mid) return;

    /* Never eat half-typed words — but never eat a REWRITE either. The box carries
       the text it was painted with (data-txmbase); only a difference means he has
       unsaved typing worth protecting. An untouched box lets fresh text through,
       which is exactly what "Write it again" needs. S.force is the override for
       when he HAS typed and presses Write it again anyway. */
    var typing = mid.querySelector('#txm-body');
    if(typing && !S.force && typing.value !== (typing.dataset.txmbase || ''))
      patchLocal(typing.dataset.txmid, { body: typing.value });
    S.force = false;

    var r = S.rows.find(function(x){ return x.id === S.sel; });
    if(!r){ mid.innerHTML = '<div class="txm-empty">Pick someone on the left.</div>'; return; }

    var b   = bookingOf(r);
    var m   = r.direction === 'outbound' ? moneyOf(b) : null;
    var out = r.direction === 'outbound';
    var editable = out && (r.status === 'draft' || r.status === 'failed');
    var note = S.msg ? '<div class="txm-note'+(S.bad?' bad':'')+'">'+esc(S.msg)+'</div>' : '';

    var tag = !out ? '<span class="txm-tag">they wrote in</span>'
      : r.status === 'draft'     ? '<span class="txm-tag amber">waiting on you</span>'
      : r.status === 'approved' && isWaiting(r) ? '<span class="txm-tag amber">⏱ '+esc(whenWords(r.send_after))+'</span>'
      : r.status === 'approved'  ? '<span class="txm-tag amber">on its way</span>'
      : r.status === 'sent'      ? '<span class="txm-tag good">sent '+esc(day(r.sent_at||r.created_at))+'</span>'
      : r.status === 'failed'    ? '<span class="txm-tag bad">did not go through</span>'
      : '<span class="txm-tag">dropped</span>';

    var row = function(k,v){
      return v ? '<div class="txm-row"><div class="txm-row__k">'+esc(k)+'</div><div class="txm-row__v">'+v+'</div></div>' : '';
    };

    var head = '<div class="txm-h">'+esc(r.to_name || r.to_phone || 'Unknown')+' '+tag+'</div>'
      + '<div class="txm-sub">'+esc(r.to_phone||'')+' · '+esc(ago(r.created_at))+'</div>';

    /* the job behind the text — what it is, where it is, what it costs */
    var job = '';
    if(b){
      job = row('The job', esc(b.blade_detail || b.service || b.category || ''))
          + row('Where it is', esc(b.item_location || ''))
          + row('Finished', esc(day(b.done_at)))
          + row('Notes', b.notes ? esc(b.notes) : '');
    } else if(out && r.ref){
      job = row('About', esc(r.ref));
    }

    var money = out
      ? (m ? '<div class="txm-money">'+cad(m.sub)+' + '+cad(m.gst)+' GST = <b>'+cad(m.total)+'</b>'
           + ' <span class="txm-tag">from the job\'s own lines</span></div>'
           : (b ? '<div class="txm-money bad">This job has no priced lines, so the text carries no total. '
                + 'Price it in the Queue, then press Write it again.</div>' : ''))
      : '';

    var bodyBlock = editable
      ? '<div class="txm-label">The words</div>'
        + '<textarea class="txm-body" id="txm-body" data-txmid="'+esc(r.id)+'" data-txmbase="'+esc(r.body||'')+'" rows="6">'+esc(r.body||'')+'</textarea>'
        + '<div class="txm-len">'+String(r.body||'').length+' characters</div>'
        + '<div class="txm-acts">'
        +   '<button type="button" class="txm-act send" data-txmact="send">Send</button>'
        +   '<button type="button" class="txm-act'+(S.later===r.id?' on':'')+'" data-txmact="later">Send later</button>'
        +   '<button type="button" class="txm-act" data-txmact="save">Save for later</button>'
        +   (b ? '<button type="button" class="txm-act" data-txmact="rewrite">Write it again</button>' : '')
        +   '<button type="button" class="txm-act" data-txmact="drop">Don\'t send</button>'
        + '</div>'
        + (S.later === r.id
            /* the chosen time lives in state, not the DOM — a repaint used to throw
               it away and snap back to tomorrow 9 AM under his thumb */
            ? '<div class="txm-when">'
              + '<input type="datetime-local" id="txm-whenbox" value="'+esc(S.when || tomorrow9())+'">'
              + '<button type="button" class="txm-act send" data-txmact="schedule">Set the timer</button>'
              + '</div>'
              + '<div id="txm-rot">'+staleWarn(r.body, whenIsoOf(S.when || tomorrow9()), Date.now())+'</div>'
            : '')
      : '<div class="txm-label">'+(out ? 'The words' : 'What they wrote')+'</div>'
        + '<div class="txm-frozen">'+esc(r.body||'')+'</div>'
        + (out && r.status === 'approved' && isWaiting(r)
            ? '<div class="txm-timer">⏱ Going out '+esc(whenWords(r.send_after))+'</div>'
              /* the words were true when he armed it — still true on arrival? */
              + staleWarn(r.body, r.send_after, r.approved_at || r.created_at)
              + '<div class="txm-acts"><button type="button" class="txm-act" data-txmact="unschedule">Call it back</button></div>'
            : '')
        + (r.status === 'cancelled'
            ? '<div class="txm-acts"><button type="button" class="txm-act" data-txmact="revive">Put it back in the queue</button></div>'
            : '');

    var err = (out && r.status === 'failed' && r.error)
      ? '<div class="txm-money bad">'+esc(r.error)+'</div>' : '';

    mid.innerHTML = head + job + money + err + bodyBlock + note + threadHtml(r);
  }

  /* everything ever said to and from that number, newest last */
  function threadHtml(r){
    var key = digits(r.to_phone);
    if(!key) return '';
    var mine = S.rows.filter(function(x){ return digits(x.to_phone) === key && x.id !== r.id; })
      .sort(function(a,b){ return (a.created_at||'') < (b.created_at||'') ? -1 : 1; });
    if(!mine.length) return '';
    return '<div class="txm-label">The rest of this conversation</div><div class="txm-thread">'
      + mine.map(function(x){
          var out = x.direction === 'outbound';
          return '<div class="txm-bub '+(out?'out':'in')+'">'
            + '<div class="txm-bub__h">'+(out ? 'us' : 'them')+' · '+esc(day(x.created_at))
            + (out ? ' · '+esc(x.status) : '')+'</div>'
            + esc(x.body||'') + '</div>';
        }).join('')
      + '</div>';
  }

  /* ══════════════ THE BUS — communication, right column ══════════════ */
  function mountBus(){
    var host = document.getElementById('txm-bus-composer');
    if(host && window.CCBusComposer && !host.dataset.txmMounted){
      host.dataset.txmMounted = '1';
      try{
        window.CCBusComposer.mount(host, {
          projectSlug: BUS_SLUG, defaultTo: 'forge-cowork', label: 'New bus message',
          onSent: function(){ loadBus(); }
        });
      }catch(e){ console.warn('[texts] composer', e); }
    } else if(host && !window.CCBusComposer){
      (function retry(n){
        if(window.CCBusComposer){ mountBus(); return; }
        if(n < 60) setTimeout(function(){ retry(n+1); }, 200);
      })(0);
    }
    loadBus();
  }

  function loadBus(){
    var host = document.getElementById('txm-bus-list');
    if(!host || !window.supa) return;
    window.supa.from('agent_messages').select('id,from_user,to_user,body,created_at')
      .eq('project_slug', BUS_SLUG).is('archived_at', null)
      .order('created_at',{ascending:false}).limit(30)
      .then(function(r){
        var c = document.getElementById('txm-bus-count');
        if(c) c.textContent = r.error ? '—' : (r.data||[]).length;
        if(r.error){ host.innerHTML = '<div class="txm-empty">Bus unavailable.</div>'; return; }
        host.innerHTML = (r.data||[]).length ? r.data.map(function(m){
          return '<div class="txm-msg"><div class="txm-msg__h">#'+m.id+' · '+esc(m.from_user)+' → '
            + esc(m.to_user)+' · '+esc(day(m.created_at))+'</div>'+esc(String(m.body||'').slice(0,400))+'</div>';
        }).join('') : '<div class="txm-empty">No messages yet.</div>';
      });
  }

  /* ══════════════ WRITES ══════════════ */
  function patchLocal(id, patch){
    var i = S.rows.findIndex(function(x){ return x.id === id; });
    if(i >= 0) S.rows[i] = Object.assign({}, S.rows[i], patch);
  }
  function say(t, bad){ S.msg = t || null; S.bad = !!bad; paintMid(); }
  function typed(){
    var t = document.getElementById('txm-body');
    return t ? t.value.trim() : '';
  }

  function act(what){
    if(!window.supa || S.busy) return;
    var r = S.rows.find(function(x){ return x.id === S.sel; });
    if(!r) return;

    if(what === 'rewrite'){
      S.busy = true;
      window.supa.rpc('az_pickup_draft_text', { p_booking: r.booking_id }).then(function(t){
        if(t.error) throw new Error(t.error.message);
        if(!t.data) throw new Error('That job did not give me enough to write with.');
        /* his own wording is worth more than mine — never swap it silently */
        var typedNow = typed();
        if(typedNow && typedNow !== t.data && !confirm(
            'Replace what is written with the standard wording from the job?\n\nIt becomes:\n\n'
            + t.data + '\n\nYour own words are lost.')){ S.busy = false; return; }
        return window.supa.from('az_sms_log').update({ body: t.data }).eq('id', r.id).then(function(up){
          if(up.error) throw new Error(up.error.message);
          patchLocal(r.id, { body: t.data });
          S.busy = false;
          S.force = true;                        // his words are gone on purpose; let the new ones paint
          say('Rewritten from the job. It still has not gone anywhere.');
        });
      }).catch(function(e){ S.busy = false; say('Could not write it: '+(e.message||e), true); });
      return;
    }

    /* open/close the little clock row — no write, just the panel */
    if(what === 'later'){
      var opening = S.later !== r.id;
      S.later = opening ? r.id : null;
      if(opening) S.when = tomorrow9();          // the prefill happens ONCE, on open
      S.msg = null; paintMid(); return;
    }

    /* CALL IT BACK — straight to draft, clock cleared. Only 'approved' is armed,
       so the text has not gone anywhere and cannot. */
    if(what === 'unschedule'){
      S.busy = true;
      window.supa.from('az_sms_log')
        .update({ status:'draft', send_after:null, approved_by:null, approved_at:null }).eq('id', r.id)
        .then(function(up){
          S.busy = false;
          if(up.error){ say('Could not call it back: '+up.error.message, true); return; }
          S.msg = 'Called back. It is a draft again and nothing was sent.'; S.bad = false;
          load();
        });
      return;
    }

    if(what === 'schedule'){
      var box = document.getElementById('txm-whenbox');
      var val = (box && box.value) || S.when || '';
      if(!val){ say('Pick a day and a time first.', true); return; }
      var when = new Date(val);
      if(isNaN(when.getTime())){ say('That time did not make sense to me.', true); return; }
      if(when.getTime() <= Date.now()){ say('That moment has already passed — pick a later one.', true); return; }
      var text = typed();
      if(!text){ say('There is nothing written to send.', true); return; }
      if(/\$_+/.test(text)){ say('That still has a blank where the total goes. Press Write it again, or type the number.', true); return; }
      /* the trap he fell into: words true today, delivered on another day */
      var rot = stalePhrases(text);
      if(rot.length && !sameDay(Date.now(), when)){
        if(!confirm('Careful — this says ' + rot.map(function(h){ return '"'+h+'"'; }).join(' and ')
          + ', but it does not land until ' + whenWords(when.toISOString())
          + '.\n\nBy then those words mean the wrong day.\n\nSet the timer anyway?')) return;
      }
      if(!confirm('This goes to their phone '+whenWords(when.toISOString())+', on its own:\n\n'+text+'\n\nSet the timer?')) return;
      S.busy = true;
      window.supa.from('az_sms_log').update({ body: text }).eq('id', r.id).then(function(sv){
        if(sv.error) throw new Error(sv.error.message);
        /* armed, but held: the sender skips it until send_after has passed */
        return window.supa.from('az_sms_log').update({
          status:'approved', approved_by:'alessio', approved_at:new Date().toISOString(),
          send_after: when.toISOString()
        }).eq('id', r.id);
      }).then(function(up){
        if(up.error) throw new Error(up.error.message);
        S.busy = false; S.later = null;
        S.msg = 'Timer set — it goes out '+whenWords(when.toISOString())+'. You can still call it back.';
        S.bad = false;
        load();
      }).catch(function(e){ S.busy = false; say('Could not set the timer: '+(e.message||e), true); });
      return;
    }

    if(what === 'revive'){
      S.busy = true;
      window.supa.from('az_sms_log').update({ status:'draft', error:null }).eq('id', r.id).then(function(up){
        S.busy = false;
        if(up.error){ say('Could not put it back: '+up.error.message, true); return; }
        S.msg = 'Back in the queue as a draft.'; S.bad = false;
        load();
      });
      return;
    }

    var body = typed();

    if(what === 'save'){
      if(!body){ say('There is nothing written to save.', true); return; }
      S.busy = true;
      window.supa.from('az_sms_log').update({ body: body }).eq('id', r.id).then(function(up){
        S.busy = false;
        if(up.error){ say('Could not save it: '+up.error.message, true); return; }
        patchLocal(r.id, { body: body });
        say('Saved. It still has not gone anywhere.');
      });
      return;
    }

    if(what === 'drop'){
      if(!confirm('Throw this text away? The job stays done, the customer just does not hear from us.')) return;
      S.busy = true;
      window.supa.from('az_sms_log').update({ status:'cancelled', error:'dropped by Alessio' }).eq('id', r.id)
        .then(function(up){
          S.busy = false;
          if(up.error){ say('Could not drop it: '+up.error.message, true); return; }
          S.msg = 'Dropped.'; S.bad = false;
          load();
        });
      return;
    }

    if(what === 'send'){
      if(!body){ say('There is nothing written to send.', true); return; }
      if(/\$_+/.test(body)){ say('That still has a blank where the total goes. Press Write it again, or type the number.', true); return; }
      if(!confirm('This goes to their phone now:\n\n'+body+'\n\nSend it?')) return;
      S.busy = true;
      window.supa.from('az_sms_log').update({ body: body }).eq('id', r.id).then(function(sv){
        if(sv.error) throw new Error(sv.error.message);
        /* THE ONE LINE THAT ARMS IT. Everything before this is reversible. */
        return window.supa.from('az_sms_log')
          .update({ status:'approved', approved_by:'alessio', approved_at:new Date().toISOString() })
          .eq('id', r.id);
      }).then(function(up){
        if(up.error) throw new Error(up.error.message);
        return fetch(SEND_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      }).then(function(){
        return new Promise(function(z){ setTimeout(z, 1500); });
      }).then(function(){
        /* trust the ROW, not the call */
        return window.supa.from('az_sms_log').select('status,error').eq('id', r.id).maybeSingle();
      }).then(function(chk){
        var st = chk && chk.data ? chk.data.status : null;
        S.busy = false;
        S.msg = st === 'sent'   ? 'Sent.'
              : st === 'failed' ? 'It did not go through: '+((chk.data && chk.data.error)||'unknown')
              : 'Handed to the sender, still going. Hit ↻ Reload in a moment.';
        S.bad = st === 'failed';
        load();
      }).catch(function(e){
        S.busy = false; say('Could not send it: '+(e.message||e), true);
      });
      return;
    }
  }

  /* ══════════════ ONE DELEGATED CLICK HANDLER ══════════════ */
  function onClick(e){
    if(!e.target || !e.target.closest) return;
    var el;
    if(el = e.target.closest('[data-txmgroup]')){
      var k = el.dataset.txmgroup;
      S.folded[k] = !isFolded(k);
      paintLeft(); return;
    }
    if(el = e.target.closest('[data-txmid]')){
      if(el.classList.contains('txm-item')){ S.sel = el.dataset.txmid; S.msg = null; S.later = null; S.when = null; paintLeft(); paintMid(); return; }
    }
    if(el = e.target.closest('[data-txmact]')){ act(el.dataset.txmact); return; }
    if(e.target.closest('#txm-reload')){ load(); return; }
  }

  /* ══════════════ MOUNT ══════════════ */
  window.CCTexts = {
    mount: function(host){
      if(!host) return;
      injectCSS();
      S.host = host;
      if(!host.dataset.txmWired){
        host.dataset.txmWired = '1';
        host.addEventListener('click', function(e){
          try{ onClick(e); }catch(err){ console.warn('[texts] click', err); }
        });
        /* Remember the time he picked, and re-check the wording against it live.
           Surgical on purpose: a full repaint here would tear the date picker out
           from under his thumb mid-scroll. Only the warning line is touched. */
        host.addEventListener('input', function(e){
          if(!e.target || e.target.id !== 'txm-whenbox') return;
          S.when = e.target.value;
          var warn = document.getElementById('txm-rot');
          var box  = document.getElementById('txm-body');
          if(warn) warn.innerHTML = staleWarn(box ? box.value : '', whenIsoOf(S.when), Date.now());
        });
        window.addEventListener('resize', fitCols);
      }
      if(!S.rows) host.innerHTML = '<div class="txm-empty">Loading…</div>';
      return load();
    },
    reload: load
  };

  /* the lane-enter hook every face already calls */
  window.renderSmsDrafts = function(){
    var h = document.getElementById('cc-texts-host');
    if(h) window.CCTexts.mount(h);
  };
})();
