/* CC SCHEDULING — one source of truth, one module, three windows.
   Blueprint: Command Center/Working/SCHEDULING_SYSTEM_BLUEPRINT_2026-08-08.md (approved).
   Evolution of cc-services-queue.js (which stays untouched until the command +
   Reanna faces adopt this module and their inline copies are deleted).

   THE MODEL (DB, shipped steps 1–2):
     az_service_bookings is THE table. work_type says what a row IS:
       job         = bench work with a due-by (preferred_date). No calendar slot.
       appointment = a slot that belongs to ONE customer (scheduled_at + duration).
       event       = a dated session that OWNS A ROSTER (az_event_attendees).
     REQUEST is a STATE, not a type: any open row with no committed date.
     az_time_claims is the calendar spine — maintained BY THE DATABASE
     (trg_az_sync_time_claim); a firm double-booking is refused by Postgres.
     status is DERIVED from timestamps by trigger. This module writes TIMESTAMPS
     (started_at, done_at, picked_up_at…), never status — except the two
     pass-through states the trigger honours: 'archived' and 'cancelled'.

   THE SURFACE — subtabs that match the model, not chips that patch it:
     BOARD    everything open that needs a hand TODAY, one tap to move it
     SCHEDULE the clock: claims, open-hours, Google context, day by day
     BENCH    dated jobs, rush first, transport-aware
     REQUESTS everything uncommitted, chased by next_action_date
     CLASSES  events + appointments with rosters, who paid, capacity
     PICKUPS  done-not-collected — the call list
     HISTORY  picked up · cancelled · archived (unarchive lives here)

   Fully self-contained: injects its own DOM + CSS into one host element.
   Host contract: window.supa (signed-in Supabase client) + one <div>.
   Mount: CCScheduling.mount(el, {defaultTab:'board'}). Legacy hooks
   window.renderQueue / window.renderServices are kept as aliases so every
   existing lane-enter call keeps working on every face. */
(function(){
  'use strict';
  if(window.CCScheduling) return;   // one copy, ever

  /* ══════════════ THE PRICE BOOK — ported VERBATIM from cc-services-queue.js
     (read from the LIVE Square catalog 2026-07-31 → 2026-08-06). Square is the
     pricing source (locked 08-06). If a price moves in Square, it moves here —
     re-read the catalog, do not guess. All provenance comments preserved in
     cc-services-queue.js; this block is the data, unchanged. ══════════════ */
  const SVQ_PRICES = {
    knives: { label:'Knives', variantLabel:null, variants:null,
      sizes: Array.from({length:18}, (_,i) => ({ key:String(i+1), label:(i+1)+'"', cad:20+(i+1) })),
      extraSizes: [{ key:'bread', label:'Bread knife', cad:50 }] },
    axes: { label:'Axes', variantLabel:'Finish',
      variants: [{ key:'standard', label:'Standard', cad:20 }, { key:'razor', label:'Razor sharp', cad:50 }],
      sizes: null },
    scissors: { label:'Scissors', variantLabel:'Kind',
      variants: [
        { key:'standard', label:'Standard',        base:40 },
        { key:'thinning', label:'Thinning',        base:60 },
        { key:'curved',   label:'Curved',          base:60 },
        { key:'curvthin', label:'Curved thinning', base:80 }
      ],
      sizes: Array.from({length:8}, (_,i) => ({ key:String(i+2), label:(i+2)+'"', inch:i+2 })) },
    shears: { label:'Grooming shears', variantLabel:'Kind',
      variants: [
        { key:'standard', label:'Standard', base:40 },
        { key:'curved',   label:'Curved',   base:60 },
        { key:'thinning', label:'Thinning', base:60 },
        { key:'curvthin', label:'Curved thinning', base:80 }
      ],
      sizes: Array.from({length:6}, (_,i) => ({ key:String(i+5), label:(i+5)+'"', inch:i+5 })) },
    folders: { label:'Folders', variantLabel:'Size',
      variants: [
        { key:'f2', label:'2"', cad:24 }, { key:'f3', label:'3"', cad:26 },
        { key:'f4', label:'4"', cad:28 }, { key:'f5', label:'5"', cad:30 }
      ],
      sizes: null },
    specialty: { label:'Specialty', variantLabel:'What is it',
      variants: [
        { key:'guthook',   label:'Gut hook',                cad:40 },
        { key:'gutting',   label:'Gutting blade',           cad:40 },
        { key:'auger',     label:'Ice auger blade',         cad:35 },
        { key:'augerlg',   label:'Ice auger blade (large)', cad:45 },
        { key:'mower',     label:'Lawnmower blade',         cad:35 },
        { key:'grinder',   label:'Meat grinder blade',      cad:40 },
        { key:'slicersm',  label:'Small round meat slicer', cad:30 },
        { key:'slicerlg',  label:'6–8" round meat slicer',  cad:50 },
        { key:'masontouch',label:'Masonry chisel touch-up', cad:10 },
        { key:'masonsm',   label:'Masonry chisel < 1"',     cad:20 },
        { key:'masonlg',   label:'Masonry chisel > 1"',     cad:30 },
        { key:'masonxl',   label:'Masonry chisel XL',       cad:50 },
        { key:'razor',     label:'Straight razor',          cad:75 },
        { key:'chipbasic', label:'Wood chipper — basic',    cad:30 },
        { key:'chipext',   label:'Wood chipper — extensive',cad:40 },
        { key:'scrap6',    label:'Scraper blade up to 6"',  cad:20 },
        { key:'scrap8',    label:'Scraper blade 6–8"',      cad:22.5 },
        { key:'scrap10',   label:'Scraper blade 8–10"',     cad:25 },
        { key:'scrap12',   label:'Scraper blade 10–12"',    cad:27.5 },
        { key:'scrap14',   label:'Scraper blade 12–14"',    cad:30 },
        { key:'scrap16',   label:'Scraper blade 14–16"',    cad:32.5 }
      ],
      sizes: null },
    chisels: { label:'Chisels & gouges', variantLabel:'Which',
      variants: [
        { key:'c15', label:'1.5" chisel', cad:15 }, { key:'c2',  label:'2" chisel',  cad:20 },
        { key:'c25', label:'2.5" chisel', cad:25 }, { key:'c3',  label:'3" chisel',  cad:30 },
        { key:'c35', label:'3.5" chisel', cad:35 }, { key:'c4',  label:'4" chisel',  cad:40 },
        { key:'c45', label:'4.5" chisel', cad:45 }, { key:'c5',  label:'5" chisel',  cad:50 },
        { key:'gs',  label:'Small gouge', cad:30 }, { key:'gm',  label:'Medium gouge', cad:35 },
        { key:'gl',  label:'Large gouge', cad:40 }
      ],
      sizes: null }
  };
  const SVQ_EXTRAS = [
    { key:'rush',      label:'Rush job',           cad:20, flag:true },
    { key:'chip',      label:'Chip fix',           cad:10 },
    { key:'tip',       label:'Tip fix',            cad:10 },
    { key:'serration', label:'Serration side',     cad:10 },
    { key:'ultra',     label:'Ultrasonic clean',   cad:10 },
    { key:'disasm',    label:'Disassembly',        cad:20 },
    { key:'disclean',  label:'Disassembly + clean',cad:30 },
    { key:'nano',      label:'Nano oil',           cad:5  },
    { key:'mirror',    label:'Mirror finish',      cad:20 },
    { key:'repair',    label:'Scissor repair',     cad:10 },
    { key:'clean15',   label:'Cleaning charge (15 min)', cad:15 },
    { key:'repair20',  label:'Scissor repair (heavy)',   cad:20 },
    { key:'spare',     label:'Spare part',               cad:5  },
    { key:'giftwrap',  label:'Gift wrapping',            cad:5  }
  ];
  const SVQ_ENGRAVING = [
    { key:'text',       label:'Text only',            first:50,  piece:15 },
    { key:'yourart',    label:'Your artwork',         first:50,  piece:15 },
    { key:'artfee',     label:'Artwork fee',          first:60,  piece:15 },
    { key:'predigital', label:'Pre-made digital art', first:75,  piece:15 },
    { key:'logofix',    label:'Logo redesign',        first:100, piece:15 },
    { key:'customart',  label:'Custom artwork',       first:115, piece:15 },
    { key:'manual',     label:'Hand engraved (manual)', first:40, piece:25 }
  ];
  const SVQ_ENG_PIECE  = 15;
  const SVQ_ENG_EXTRAS = [ { key:'engrush', label:'Rush order', cad:25, flag:true } ];
  /* What came in — ENGRAVING intake (Reanna, bus #4351 2026-08-08): the property
     on the counter, separate from what kind of engraving it gets. Optional on
     purpose — it labels the line, it never blocks the add. */
  const SVQ_ENG_CAME = [
    { key:'knife',  label:'Knife' },
    { key:'board',  label:'Cutting board' },
    { key:'sheath', label:'Sheath' },
    { key:'other',  label:'Other' }
  ];
  const SVQ_ALL_EXTRAS = SVQ_EXTRAS.concat(SVQ_ENG_EXTRAS);
  const SVQ_SHEATHS = {
    kydex:     { label:'Custom Kydex', variantLabel:'Option', variants: [
      { key:'kydex', label:'Kydex sheath', cad:120 }, { key:'ministeel', label:'Mini-steel leather holder', cad:60 } ], sizes:null },
    sleeve:    { label:'Leather sleeve', variantLabel:'Leather', variants: [
      { key:'nt', label:'Natural tanned', cad:120 }, { key:'nd', label:'Natural dyed', cad:150 }, { key:'prem', label:'Premium', cad:180 } ], sizes:null },
    smallloop: { label:'Small loop', variantLabel:'Leather', variants: [
      { key:'nt', label:'Natural tanned', cad:160 }, { key:'nd', label:'Natural dyed', cad:190 }, { key:'prem', label:'Premium', cad:220 } ], sizes:null },
    longloop:  { label:'Long loop', variantLabel:'Leather', variants: [
      { key:'nt', label:'Natural tanned', cad:170 }, { key:'nd', label:'Natural dyed', cad:200 }, { key:'prem', label:'Premium', cad:230 } ], sizes:null },
    ranger:    { label:'Ranger carry (kydex-backed)', variantLabel:'Leather', variants: [
      { key:'nt', label:'Natural tanned', cad:300 }, { key:'nd', label:'Natural dyed', cad:330 }, { key:'prem', label:'Premium', cad:370 } ], sizes:null }
  };
  const SVQ_MODLISTS = {
    steel_cul:  { label:'Steel', single:true, mods:[
      { key:'vg10', label:'VG10', cad:0 }, { key:'cruwear', label:'CPM CRU-WEAR', cad:180 }, { key:'magnacut', label:'CPM MagnaCut', cad:280 } ] },
    steel_out:  { label:'Steel', single:true, mods:[
      { key:'80crv2', label:'80CRV2', cad:0 }, { key:'vg10', label:'VG10', cad:120 },
      { key:'cruwear', label:'CPM CRU-WEAR', cad:180 }, { key:'magnacut', label:'CPM MagnaCut', cad:280 } ] },
    finish:     { label:'Finish', single:true, mods:[
      { key:'swlight', label:'Stonewash, light', cad:0 }, { key:'natural', label:'Natural', cad:20 },
      { key:'brushed', label:'Brushed', cad:100 }, { key:'swdark', label:'Stonewash, dark', cad:100 },
      { key:'handrub', label:'Hand-rubbed', cad:120 } ] },
    feature:    { label:'Features', single:false, mods:[
      { key:'polishtang', label:'Polished tang', cad:80 }, { key:'blackouttang', label:'Blackout tang', cad:80 },
      { key:'roundspine', label:'Rounded spine', cad:80 }, { key:'smallswedge', label:'Small swedge', cad:160 },
      { key:'swedge', label:'Swedge', cad:180 }, { key:'protrudetang', label:'Protruding tang', cad:200 },
      { key:'fuller', label:'Fuller', cad:220 } ] },
    bolster:    { label:'Bolster', single:true, mods:[
      { key:'none', label:'None', cad:0 }, { key:'g10', label:'G10', cad:120 }, { key:'stainless', label:'Stainless', cad:180 },
      { key:'brass', label:'Brass', cad:200 }, { key:'copper', label:'Copper', cad:220 } ] },
    handlemat:  { label:'Handle material', single:true, mods:[
      { key:'g10', label:'G10', cad:0 }, { key:'custom', label:'Custom request', cad:0 },
      { key:'specg10', label:'Specialty G10', cad:40 }, { key:'stabwood', label:'Stabilized wood', cad:80 },
      { key:'micarta', label:'Micarta', cad:100 } ] },
    handlefin:  { label:'Handle finish', single:false, mods:[
      { key:'roundover', label:'1/4" roundover', cad:0 }, { key:'dbltaper', label:'Double taper', cad:40 },
      { key:'scalloped', label:'Scalloped', cad:200 } ] },
    liner:      { label:'Liner', single:true, mods:[
      { key:'none', label:'None', cad:0 }, { key:'paper', label:'Paper', cad:40 },
      { key:'g10', label:'G10', cad:50 }, { key:'metal', label:'Metal', cad:80 } ] },
    pins_cul:   { label:'Pins', single:false, mods:[
      { key:'g10', label:'G10', cad:0 }, { key:'p2st', label:'2 pins stainless 1/8"', cad:5 },
      { key:'p2br', label:'2 pins brass 1/8"', cad:10 }, { key:'p2cu', label:'2 pins copper 1/8"', cad:15 },
      { key:'p2mo', label:'2 pins mosaic 1/8"', cad:20 }, { key:'p3st', label:'3 pins stainless 3/16"', cad:7.5 },
      { key:'p3br', label:'3 pins brass 3/16"', cad:15 }, { key:'p3cu', label:'3 pins copper 3/16"', cad:22.5 },
      { key:'p3mo', label:'3 pins mosaic 3/16"', cad:37.5 }, { key:'p1mo', label:'1 pin mosaic 1/4"', cad:15 },
      { key:'p1sig', label:'1 pin AZCK signature 1/4"', cad:25 } ] },
    pins_out:   { label:'Pins', single:true, mods:[
      { key:'g10', label:'G10', cad:0 }, { key:'st', label:'2 pins stainless 3/16"', cad:5 },
      { key:'br', label:'2 pins brass 3/16"', cad:10 }, { key:'cu', label:'2 pins copper 3/16"', cad:15 },
      { key:'mo', label:'2 pins mosaic 3/16"', cad:25 } ] },
    thong:      { label:'Thong tube', single:true, mods:[
      { key:'none', label:'None', cad:0 }, { key:'g10', label:'1/4" G10', cad:40 },
      { key:'stainless', label:'1/4" stainless', cad:45 }, { key:'brass', label:'1/4" brass', cad:50 },
      { key:'copper', label:'1/4" copper', cad:55 } ] },
    engrave:    { label:'Engraving', single:false, mods:[
      { key:'spine', label:'Spine (manual)', cad:45 }, { key:'blade', label:'Blade (laser)', cad:50 } ] },
    special:    { label:'Special request', single:false, mods:[
      { key:'s100', label:'+$100', cad:100 }, { key:'s200', label:'+$200', cad:200 },
      { key:'s300', label:'+$300', cad:300 }, { key:'s400', label:'+$400', cad:400 } ] }
  };
  const A_CUL = ['steel_cul','finish','feature','handlefin','handlemat','liner','pins_cul','special','engrave'];
  const A_OUT = ['steel_out','finish','feature','handlefin','handlemat','liner','thong','pins_out','special','engrave'];
  const SVQ_DROP_CUL = { feature:['fuller'], handlefin:['scalloped'] };
  const SVQ_DROP_OUT = { handlefin:['dbltaper'] };
  const SVQ_CUSTOM = {
    model: { label:'Model', variantLabel:'Which knife', variants: [
      { key:'bulldog',  label:'Bulldog',      cad:750,  addons:A_OUT, drop:SVQ_DROP_OUT },
      { key:'badger',   label:'Badger',       cad:730,  addons:A_OUT, drop:SVQ_DROP_OUT },
      { key:'falcon',   label:'Falcon',       cad:810,  addons:A_OUT, drop:SVQ_DROP_OUT },
      { key:'reaper',   label:'Reaper',       cad:830,  addons:A_OUT, drop:SVQ_DROP_OUT },
      { key:'defender', label:'Defender',     cad:950,  addons:A_OUT.filter(g => g !== 'thong'), drop:SVQ_DROP_OUT },
      { key:'rep35',    label:'3.5" REP (Raptor Expert)',      cad:660,  addons:A_CUL, drop:SVQ_DROP_CUL },
      { key:'res50',    label:'5.0" RES (Raptor Expert Slim)', cad:810,  addons:A_CUL, drop:SVQ_DROP_CUL },
      { key:'raptor65', label:'6.5" Raptor',  cad:1350, drop:SVQ_DROP_CUL, bolsterPinRule:true,
        addons:['steel_cul','finish','feature','bolster','handlemat','handlefin','liner','pins_cul','engrave','special'] } ], sizes:null },
    project: { label:'Project charges', variantLabel:'Which', variants: [
      { key:'dev', label:'Development charge (10 alterations)', cad:500 },
      { key:'prop', label:'Proprietary custom design', cad:2000 } ], sizes:null }
  };
  const SVQ_COURSES = {
    p1: { label:'1 person', variantLabel:'Option', variants: [
      { key:'hdbs', label:'½ day blacksmithing', cad:450 }, { key:'hdkm', label:'½ day knife making', cad:450 },
      { key:'hdproj', label:'½ day project class', cad:450 }, { key:'fdbs', label:'Full day blacksmithing', cad:700 },
      { key:'fdkm', label:'Full day knife making', cad:850 }, { key:'ka', label:'Knife assembly', cad:450 },
      { key:'d_hd', label:'50% deposit — ½ day', cad:225 }, { key:'d_ka', label:'50% deposit — assembly', cad:225 },
      { key:'d_fdbs', label:'50% deposit — full BS', cad:350 }, { key:'d_fdkm', label:'50% deposit — full KM', cad:425 } ], sizes:null },
    p2: { label:'2 people', variantLabel:'Option', variants: [
      { key:'fdbs', label:'Full day blacksmithing', cad:1200 }, { key:'fdkm', label:'Full day knife making', cad:1500 },
      { key:'s_hdbs', label:'1 spot — ½ day BS', cad:350 }, { key:'s_hdkm', label:'1 spot — ½ day KM', cad:350 },
      { key:'s_fdbs', label:'1 spot — full BS', cad:600 }, { key:'s_fdkm', label:'1 spot — full KM', cad:750 },
      { key:'d_hd', label:'50% deposit — ½ day', cad:350 }, { key:'d_fdbs', label:'50% deposit — full BS', cad:600 },
      { key:'d_fdkm', label:'50% deposit — full KM', cad:750 } ], sizes:null },
    p3: { label:'3 people', variantLabel:'Option', variants: [
      { key:'fdkm', label:'Full day knife making', cad:1950 },
      { key:'s_hdproj', label:'1 spot — ½ day project', cad:250 }, { key:'s_hdbs', label:'1 spot — ½ day BS', cad:250 },
      { key:'s_hdkm', label:'1 spot — ½ day KM', cad:250 }, { key:'s_fdbs', label:'1 spot — full BS', cad:500 },
      { key:'s_fdkm', label:'1 spot — full KM', cad:650 },
      { key:'d_hd', label:'50% deposit — ½ day', cad:375 }, { key:'d_fdbs', label:'50% deposit — full BS', cad:750 },
      { key:'d_fdkm', label:'50% deposit — full KM', cad:975 } ], sizes:null },
    teambuilding: { label:'Team building', variantLabel:'Option', variants: [
      { key:'sharp', label:'Sharpening workshop', cad:260 }, { key:'bs', label:'Blacksmithing', cad:350 },
      { key:'ka', label:'Knife assembly', cad:450 }, { key:'km', label:'Knife making class', cad:650 },
      { key:'d_sharp', label:'50% deposit — sharpening', cad:130 }, { key:'d_bs', label:'50% deposit — BS', cad:175 },
      { key:'d_ka', label:'50% deposit — assembly', cad:225 }, { key:'d_km', label:'50% deposit — KM', cad:325 } ], sizes:null },
    sharpclass: { label:'Sharpening classes', variantLabel:'Option', variants: [
      { key:'group', label:'Group (with kit)', cad:260 }, { key:'nokit', label:'Group (no kit)', cad:160 },
      { key:'private', label:'Private class', cad:340 }, { key:'gcup', label:'Upgrade from GC', cad:80 } ], sizes:null },
    afterhours: { label:'After-Hours program', variantLabel:'Option', variants: [
      { key:'program', label:'Knife making program', cad:799 }, { key:'makeup', label:'Make-up class', cad:150 } ], sizes:null },
    continuation: { label:'Continuation', variantLabel:'Option', variants: [
      { key:'session', label:'Session', cad:400 } ], sizes:null }
  };
  const SVQ_RESTO = {
    regrind: { label:'Regrind', variantLabel:'Which', variants: [
      { key:'reprofile', label:'Reprofile', cad:20 }, { key:'basic', label:'Regrind — basic', cad:250 },
      { key:'adv', label:'Regrind — advanced', cad:400 } ], sizes:null },
    labour: { label:'Shop labour', variantLabel:'Rate', variants: [
      { key:'min', label:'Shop minimum', cad:50 }, { key:'m45', label:'45 minutes', cad:75 },
      { key:'hour', label:'Per hour', cad:100 } ], sizes:null }
  };
  const SVQ_CATALOGS = { sharpening:SVQ_PRICES, sheath:SVQ_SHEATHS, custom_knife:SVQ_CUSTOM, class:SVQ_COURSES, restoration:SVQ_RESTO };
  const SVQ_KIND_LBL = { sharpening:'What came in', sheath:'Which sheath', custom_knife:'Which knife', class:'Which course', restoration:'What kind of work' };
  const SVQ_MANUAL_TOO = { custom_knife:true, restoration:true, sharpening:true };
  const SVQ_MANUAL_NOTE = {
    custom_knife: 'Special Request Custom Knife is variable-priced in Square — type that quote here. Upgrades are the add-on chips above; do not type those.',
    restoration:  'Odd restoration? Build it from the chips, or type the quote.',
    sharpening:   'Anything odd, or shipping & handling? Type it and the amount — this is Square’s open-amount ladder.',
    other:        'Say what it is and the price you quoted.'
  };
  const SVQ_TYPES = { sharpening:'Sharpening', engraving:'Engraving', sheath:'Sheath', custom_knife:'Custom knife', restoration:'Restoration', class:'Class', teambuilding:'Team building', other:'Other' };

  /* ── TRANSPORT (blueprint §5) — the CLOSED vocabulary for where the
     customer's property physically is. The free-text disease ("Shop until noon
     Aug 6, then Blue Building") ends here. ── */
  const LOCS = ['Shop', 'Blue Building', 'In transit', "Alessio's bench", 'with customer'];
  const SVQ_QTYS = [1,2,3,4,5,6,7,8,9,10];

  /* ══════════════ MODEL HELPERS ══════════════ */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const day = s => s ? String(s).slice(0,10) : '';
  const todayStr = () => { const d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate()+n); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit'}) : '';
  const fmtDay  = iso => iso ? new Date(iso).toLocaleDateString('en-CA',{weekday:'short',month:'short',day:'numeric'}) : '';
  const daysWaiting = iso => iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime())/86400000)) : null;

  /* OPEN MEANS "STILL OURS" (locked 08-06) — deny list on purpose: name what
     LEAVES; everything else stays visible, including statuses added later. */
  const CLOSED    = ['picked_up','cancelled','archived'];
  const isOpen    = r => CLOSED.indexOf(r.status) === -1;
  const isJob     = r => (r.work_type || 'job') === 'job';
  const isSession = r => r.work_type === 'appointment' || r.work_type === 'event';
  /* A commitment is work_type-shaped: a job commits to a DUE-BY, a session
     commits to a SLOT. "No date set is simply not a queue" (locked 08-07). */
  const committed = r => isJob(r) ? !!r.preferred_date : !!r.scheduled_at;
  const isRequest = r => isOpen(r) && !committed(r);
  const isPickup  = r => !!r.done_at && !r.picked_up_at && r.status !== 'archived' && r.status !== 'cancelled';
  /* Have they heard from us? A text that is sent or armed counts, and so does the
     old notified_at stamp for the years before the texting line existed. This is
     what separates HIS move (tell them) from THEIRS (come and get it). */
  const told      = r => !!r.notified_at || (S.sms || []).some(x =>
                      x.booking_id === r.id && (x.status === 'sent' || x.status === 'approved'));
  const onBench   = r => isJob(r) && isOpen(r) && !r.done_at;
  /* how long "at the counter" lasts before a job becomes basket work — see the
     long note on paintBoard's counter section for why this window exists */
  const COUNTER_DAYS = 2;
  const atCounter = r => isPickup(r) && !told(r) && daysWaiting(r.done_at) <= COUNTER_DAYS;
  const wtLabel   = r => r.work_type === 'appointment' ? 'Appointment' : r.work_type === 'event' ? 'Event' : 'Job';
  const typeLabel = r => SVQ_TYPES[r.category] || (r.category ? r.category : 'Job');

  /* ══════════════ STATE ══════════════ */
  const S = {
    tab: 'board', rows: null, claims: [], attendees: [], hours: [], gcal: [],
    sel: null, editing: null, busy: false, err: null, host: null, opts: {},
    // composer
    formOpen: false, kind:'knives', variant:null, size:null, qty:1, ekind:null, ecame:null,
    addons:{}, lines:[], extras:{}, loc:null, cWork:'job', customers:null, custFetch:null,
    // the pickup text — one row of az_sms_log per job, shown inside the job window
    sms: [], smsMsg: null, smsBad: false
  };

  const TABS = [
    { key:'board',    label:'Board' },
    { key:'schedule', label:'Schedule' },
    { key:'bench',    label:'Bench' },
    { key:'requests', label:'Requests' },
    { key:'classes',  label:'Classes & Events' },
    { key:'pickups',  label:'Pickups' },
    { key:'history',  label:'History' }
  ];

  /* ══════════════ DATA ══════════════ */
  const BK_COLS = 'id,created_at,category,service,blade_detail,preferred_date,preferred_time,quantity,'
    + 'customer_name,customer_phone,customer_email,notes,status,source,rush,intake_by,item_location,'
    + 'total_cad,line_items,dropped_off_at,scheduled_at,started_at,done_at,notified_at,picked_up_at,'
    + 'work_type,duration_minutes,next_action_date';

  async function load(){
    if(!window.supa){ S.err = 'signin'; paint(); return; }
    try{
      const [bk, cl, at, oh, gc, sm] = await Promise.all([
        window.supa.from('az_service_bookings').select(BK_COLS).order('created_at',{ascending:false}).limit(500),
        window.supa.from('az_time_claims').select('id,resource,span,kind,status,booking_id,note').limit(500),
        window.supa.from('az_event_attendees').select('id,booking_id,name,contact,paid,notes').limit(1000),
        window.supa.from('az_open_hours').select('service,weekday,times,active').eq('active', true),
        window.supa.from('calendar_events').select('summary,start_time,end_time,all_day,location')
          .gte('start_time', new Date(Date.now()-86400000).toISOString())
          .lte('start_time', new Date(Date.now()+15*86400000).toISOString())
          .order('start_time').limit(120),
        /* the pickup texts, so the job window can show a job's own text without
           a second round-trip every time he taps a different job */
        window.supa.from('az_sms_log')
          .select('id,booking_id,to_name,to_phone,body,status,created_at,sent_at,error')
          .eq('direction','outbound').not('booking_id','is',null)
          .order('created_at',{ascending:false}).limit(400)
      ]);
      if(bk.error) throw bk.error;
      S.rows = bk.data || [];
      S.claims = cl.error ? [] : (cl.data || []);
      S.attendees = at.error ? [] : (at.data || []);
      S.hours = oh.error ? [] : (oh.data || []);
      S.gcal = gc.error ? [] : (gc.data || []);
      S.sms = sm.error ? [] : (sm.data || []);
      S.err = null;
    }catch(e){
      console.warn('[scheduling] load failed', e);
      S.err = (e && e.message) || String(e);
    }
    paint();
  }

  /* ══════════════ WRITES — timestamps, never status (two pass-throughs) ══ */
  async function write(id, patch, okThen){
    if(!window.supa || S.busy) return;
    S.busy = true;
    let err = null;
    try { const r = await window.supa.from('az_service_bookings').update(patch).eq('id', id); err = r.error; }
    catch(e){ err = e; }
    S.busy = false;
    if(err){
      const m = (err && err.message) || String(err);
      alert(m.indexOf('TIME_TAKEN') !== -1
        ? 'That time is already firmly booked — pick another slot, or make the other one tentative first.'
        : 'Could not save that: ' + m);
      return;
    }
    if(okThen) okThen();
    load();
  }

  function act(id, what){
    const now = new Date().toISOString();
    if(what === 'started')   return write(id, { started_at: now });
    if(what === 'done')      return write(id, { done_at: now });
    if(what === 'picked_up') return write(id, { picked_up_at: now });
    if(what === 'notified')  return write(id, { notified_at: now });
    if(what === 'reopen')    return write(id, { done_at: null, picked_up_at: null, notified_at: null });
    if(what === 'archive')   return write(id, { status: 'archived' });
    if(what === 'unarchive') return write(id, { status: 'new' });
    if(what === 'cancel'){
      if(!confirm('Cancel this one? Its calendar hold is released.')) return;
      return write(id, { status: 'cancelled' });
    }
  }

  /* tstzrange comes over the wire as e.g. ["2026-09-03 15:00:00+00","…")
     — normalise the pg timestamp to strict ISO so Safari parses it too */
  function spanStart(span){
    const m = /^[\[(]"?([^",]+)/.exec(span || '');
    if(!m) return null;
    let s = m[1].trim().replace(' ', 'T');
    if(/[+-]\d\d$/.test(s)) s += ':00';
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /* ══════════════ MOUNT — self-contained DOM + CSS ══════════════
     THE LOOK IS THE CC LAYOUT STANDARD (Alessio ruling 2026-07-27, re-affirmed
     2026-08-08: "the function stays, the visual goes back"): three BOXED columns
     — nav | product | Project Bus — with column heads, own scroll, resize-ready.
     Values mirror the services-lane svq-* styles so the surface reads identical
     on every face; only the class prefix differs (scx-). ══════════════ */
  /* (old flat-grid CSS removed 2026-08-08 — the boxed 3-column standard below is the look) */

  const CSS = `
  .scx{font-size:13px;color:var(--text,#dde4eb);}
  .scx *{box-sizing:border-box;}
  .scx-topline{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;}
  .scx-tabs{display:flex;gap:6px;flex-wrap:wrap;}
  .scx-tab{cursor:pointer;padding:6px 12px;border:1px solid var(--border,#252c33);border-radius:4px;
    font-family:var(--mono,monospace);font-size:10px;letter-spacing:.08em;text-transform:uppercase;
    color:var(--text-dim,#8a9aa8);background:var(--raised,#161b20);user-select:none;}
  .scx-tab:hover{border-color:var(--amber,#c8922a);color:var(--amber,#c8922a);}
  .scx-tab.on{background:var(--amber,#c8922a);color:#000;border-color:var(--amber,#c8922a);font-weight:700;}
  .scx-tab b{margin-left:5px;font-weight:700;}
  .scx-3col{display:grid;grid-template-columns:1.25fr 2.3fr 1.45fr;gap:10px;height:calc(100vh - var(--scx-top,248px));min-height:420px;align-items:stretch;position:relative;}
  .scx ::-webkit-scrollbar{width:4px;height:4px;}
  .scx ::-webkit-scrollbar-track{background:transparent;}
  .scx ::-webkit-scrollbar-thumb{background:var(--border,#252c33);border-radius:2px;}
  .scx-col__body{scrollbar-width:thin;scrollbar-color:var(--border,#252c33) transparent;}
  .scx-col{background:var(--surface,#0f1316);border:1px solid var(--border,#252c33);border-radius:6px;padding:10px;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;}
  .scx-col__head{font-family:var(--display,sans-serif);font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--amber,#c8922a);padding-bottom:8px;border-bottom:1px solid var(--border,#252c33);margin-bottom:8px;flex-shrink:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .scx-col__body{flex:1 1 0%;min-height:0;overflow-y:auto;}
  .scx-count{font-family:var(--mono,monospace);font-size:9px;color:var(--text-xs,#566470);margin-left:auto;}
  .scx-reload{background:var(--raised,#161b20);border:1px solid var(--border,#252c33);border-radius:4px;color:var(--text-dim,#8a9aa8);cursor:pointer;font-size:11px;padding:4px 9px;}
  .scx-reload:hover{border-color:var(--amber,#c8922a);color:var(--amber,#c8922a);}
  .scx-new{width:100%;padding:13px 12px;background:var(--amber,#c8922a);color:#000;border:0;border-radius:5px;font-family:var(--display,sans-serif);font-size:14px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;flex-shrink:0;margin-bottom:10px;}
  .scx-new:hover{filter:brightness(1.08);}
  .scx-new.open{background:var(--raised,#161b20);color:var(--text-dim,#8a9aa8);border:1px solid var(--border,#252c33);}
  .scx-card{padding:9px 10px;border:1px solid transparent;border-left:3px solid transparent;border-radius:3px;cursor:pointer;margin-bottom:3px;}
  .scx-card:hover{background:var(--raised,#161b20);border-color:var(--border,#252c33);}
  .scx-card.on{background:var(--amber-soft,rgba(200,146,42,.12));border-color:var(--amber,#c8922a);}
  .scx-card.rush{border-left-color:#cc1f1f;}
  .scx-card.closed{opacity:.55;}
  .scx-card__t{font-size:13px;color:var(--text,#dde4eb);line-height:1.35;font-weight:400;}
  .scx-card.on .scx-card__t{color:var(--amber,#c8922a);}
  .scx-card__s{font-family:var(--mono,monospace);font-size:9.5px;color:var(--text-xs,#566470);margin-top:3px;}
  .scx-tag{font-family:var(--mono,monospace);font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;padding:1px 5px;border-radius:2px;border:1px solid var(--border,#252c33);color:var(--text-dim,#8a9aa8);display:inline-block;margin:3px 4px 0 0;}
  .scx-tag.red{background:rgba(204,31,31,.18);color:#ff7a7a;border-color:rgba(204,31,31,.5);}
  .scx-tag.amber{background:rgba(255,176,0,.15);color:var(--amber,#c8922a);border-color:rgba(255,176,0,.45);}
  .scx-tag.green{color:#4caf7d;border-color:rgba(46,160,67,.5);}
  .scx-sec{margin:11px 0 4px;font-family:var(--mono,monospace);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-xs,#566470);}
  .scx-sec:first-child{margin-top:0;}
  .scx-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}
  .scx-act{font-family:var(--display,sans-serif);font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:8px 14px;background:var(--raised,#161b20);border:1px solid var(--border,#252c33);border-radius:4px;color:var(--text-dim,#8a9aa8);cursor:pointer;}
  .scx-act:hover{border-color:var(--amber,#c8922a);color:var(--amber,#c8922a);}
  .scx-act.on{background:var(--amber,#c8922a);color:#000;border-color:var(--amber,#c8922a);}
  .scx-act.go{border-color:rgba(46,160,67,.6);color:#2ea043;}
  .scx-act.send{background:var(--azck-red,#990000);border-color:var(--azck-red,#990000);color:#fff;font-weight:700;}
  .scx-act.send:hover{filter:brightness(1.2);color:#fff;}
  .scx-act:disabled{opacity:.4;cursor:default;}
  /* the pickup text, right under the buttons that finish the job */
  .scx-sms{margin-top:12px;padding-top:10px;border-top:1px solid var(--border,#252c33);}
  .scx-sms__head{font-family:var(--mono,monospace);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--amber,#c8922a);margin-bottom:7px;}
  .scx-sms__money{font-size:12px;color:var(--text-dim,#8a9aa8);margin-bottom:7px;}
  .scx-sms__money b{color:var(--text,#dde4eb);font-size:13px;}
  .scx-sms__money.bad{color:#e05252;}
  .scx-sms__body{width:100%;background:var(--bg,#0d1114);color:var(--text,#dde4eb);border:1px solid var(--border,#252c33);
    border-radius:5px;padding:8px 10px;font-family:inherit;font-size:12.5px;line-height:1.55;resize:vertical;}
  .scx-sms__body:focus{outline:none;border-color:var(--amber,#c8922a);}
  .scx-sms__done{background:var(--bg,#0d1114);border:1px solid var(--border,#252c33);border-radius:5px;
    padding:8px 10px;font-size:12.5px;line-height:1.55;color:var(--text-dim,#8a9aa8);white-space:pre-wrap;}
  .scx-sms__to{font-family:var(--mono,monospace);font-size:9.5px;color:var(--text-dim,#8a9aa8);margin-top:5px;}
  .scx-sms__idle{font-size:12px;color:var(--text-dim,#8a9aa8);margin-top:6px;}
  .scx-sms__note{font-size:11.5px;color:var(--amber,#c8922a);margin-top:7px;}
  .scx-sms__note.bad{color:#e05252;}
  .scx-row{display:flex;gap:8px;margin:3px 0;}
  .scx-row__k{width:96px;flex:none;font-family:var(--mono,monospace);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-xs,#566470);padding-top:3px;}
  .scx-row__v{flex:1;min-width:0;overflow-wrap:anywhere;}
  .scx-empty{font-family:var(--mono,monospace);font-size:11px;color:var(--text-xs,#566470);padding:16px;text-align:center;}
  .scx-detail h3{font-family:var(--display,sans-serif);font-size:15px;color:var(--amber,#c8922a);margin:0 0 8px;}
  .scx-form{display:none;}
  .scx-form.on{display:block;}
  .scx-f{margin-bottom:9px;}
  .scx-f label{display:block;font-family:var(--mono,monospace);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-xs,#566470);margin-bottom:3px;}
  .scx-f input,.scx-f select,.scx-f textarea{width:100%;box-sizing:border-box;background:var(--raised,#161b20);border:1px solid var(--border,#252c33);border-radius:4px;color:var(--text,#dde4eb);font-family:var(--sans,inherit);font-size:14px;padding:9px 10px;}
  .scx-f input:focus,.scx-f select:focus,.scx-f textarea:focus{outline:0;border-color:var(--amber,#c8922a);}
  .scx-f textarea{min-height:64px;resize:vertical;}
  .scx-chips{display:flex;gap:5px;flex-wrap:wrap;margin:4px 0;}
  .scx-chip{font-family:var(--mono,monospace);font-size:11px;padding:7px 11px;background:var(--raised,#161b20);color:var(--text-dim,#8a9aa8);border:1px solid var(--border,#252c33);border-radius:4px;cursor:pointer;user-select:none;}
  .scx-chip:hover{border-color:var(--amber,#c8922a);color:var(--amber,#c8922a);}
  .scx-chip.on{background:var(--amber,#c8922a);color:#000;border-color:var(--amber,#c8922a);font-weight:700;}
  .scx-chip__p{opacity:.6;margin-left:4px;}
  .scx-chip.on .scx-chip__p{opacity:.8;}
  .scx-chip__n{display:inline-block;min-width:15px;margin-left:5px;padding:0 4px;background:var(--amber,#c8922a);color:#000;border-radius:8px;font-weight:700;}
  .scx-line{display:flex;align-items:center;gap:8px;padding:6px 9px;background:var(--raised,#161b20);border:1px solid var(--border,#252c33);border-radius:4px;margin-bottom:4px;font-size:12.5px;color:var(--text,#dde4eb);}
  .scx-line__x{margin-left:auto;background:none;border:0;color:var(--text-xs,#566470);cursor:pointer;font-size:14px;padding:0 2px;}
  .scx-line__x:hover{color:#ff7a7a;}
  .scx-hits{border:1px solid var(--border,#252c33);border-radius:4px;margin-top:4px;max-height:190px;overflow-y:auto;}
  .scx-hits[hidden]{display:none;}
  .scx-hit{padding:7px 10px;cursor:pointer;font-size:12.5px;color:var(--text,#dde4eb);border-bottom:1px solid var(--border,#252c33);}
  .scx-hit:last-child{border-bottom:0;}
  .scx-hit:hover{background:var(--amber-soft,rgba(200,146,42,.12));color:var(--amber,#c8922a);}
  .scx-hit small{display:block;font-family:var(--mono,monospace);font-size:9.5px;color:var(--text-xs,#566470);margin-top:2px;}
  .scx-day{border:1px solid var(--border,#252c33);border-radius:6px;padding:8px 10px;margin-bottom:6px;background:var(--raised,#161b20);}
  .scx-day__h{font-family:var(--mono,monospace);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--amber,#c8922a);margin-bottom:4px;}
  .scx-slot{display:flex;gap:8px;padding:2px 0;font-size:12px;}
  .scx-slot__t{width:104px;flex:none;font-family:var(--mono,monospace);font-size:10px;color:var(--text-xs,#566470);padding-top:2px;}
  .scx-slot.dim{opacity:.55;}
  .scx-msg{border:1px solid var(--border,#252c33);border-radius:4px;padding:6px 8px;margin-bottom:6px;font-size:12px;overflow-wrap:anywhere;background:var(--raised,#161b20);}
  .scx-msg__head{font-family:var(--mono,monospace);font-size:9px;color:var(--text-xs,#566470);margin-bottom:3px;}
  @media(max-width:700px){
    .scx-3col{grid-template-columns:1fr;height:auto;min-height:0;}
    .scx-col{overflow:visible;}
    .scx-col__body{overflow:visible;}
  }
  `;

  function mount(host, opts){
    if(!host) return;
    S.host = host; S.opts = opts || {};
    S.tab = (opts && opts.defaultTab) || 'board';
    if(!document.getElementById('scx-style')){
      const st = document.createElement('style'); st.id = 'scx-style'; st.textContent = CSS;
      document.head.appendChild(st);
    }
    host.classList.add('scx');
    host.innerHTML = '<div class="scx-topline">'
      + '<div class="scx-tabs" id="scx-tabs"></div>'
      + '<button type="button" class="scx-reload" id="scx-reload" title="Reload">↻</button>'
      + '</div>'
      + '<div id="scx-body"></div>';
    host.addEventListener('click', function(e){ try{ onClick(e); }catch(err){ console.warn('[scheduling] click', err); } });
    host.addEventListener('input', function(e){
      if(e.target && e.target.id === 'scx-name') searchCustomers(e.target.value);
    });
    host.addEventListener('focusin', function(e){
      if(e.target && e.target.id === 'scx-name') paintCustomers(e.target.value);
    });
    window.addEventListener('resize', fitCols);
    paint();
    load();
  }

  /* ══════════════ PAINT ══════════════ */
  function counts(){
    const rows = S.rows || [];
    return {
      /* the basket is NOT board work (2026-08-12) — but a finished job nobody has
         been told about IS his move, and it clears itself on Send (2026-08-14) */
      board: rows.filter(r => onBench(r) && committed(r)).length
           + rows.filter(atCounter).length
           + rows.filter(r => isRequest(r) && r.next_action_date && r.next_action_date <= todayStr()).length,
      schedule: null,
      bench: rows.filter(r => onBench(r) && !!r.preferred_date).length,
      requests: rows.filter(isRequest).length,
      classes: rows.filter(r => isSession(r) && isOpen(r)).length,
      pickups: rows.filter(isPickup).length,
      history: null
    };
  }

  function paint(){
    if(!S.host) return;
    const tabs = document.getElementById('scx-tabs');
    if(tabs){
      const c = counts();
      tabs.innerHTML = TABS.map(t =>
        '<span class="scx-tab'+(S.tab===t.key?' on':'')+'" data-scxtab="'+t.key+'">'+t.label
        + (c[t.key] != null ? ' <b>'+c[t.key]+'</b>' : '') + '</span>').join('');
    }
    const body = document.getElementById('scx-body');
    if(!body) return;
    if(S.err === 'signin'){ body.innerHTML = '<div class="scx-empty">Sign in to see the schedule.</div>'; return; }
    if(S.err){ body.innerHTML = '<div class="scx-empty">Could not load: '+esc(S.err)+' — tap ↻ to try again.</div>'; return; }
    if(!S.rows){ body.innerHTML = '<div class="scx-empty">Loading…</div>'; return; }

    /* the three boxes — nav | product | Project Bus — on EVERY subtab */
    const tabLabel = (TABS.find(t => t.key === S.tab) || TABS[0]).label;
    body.innerHTML = '<div class="scx-3col">'
      + '<div class="scx-col"><div class="scx-col__head">'+esc(tabLabel)
      + '<span class="scx-count"><span id="scx-count">—</span> shown</span></div>'
      + '<div class="scx-col__body" id="scx-left"></div></div>'
      + '<div class="scx-col"><div class="scx-col__head">Job</div>'
      + '<button type="button" class="scx-new'+(S.formOpen?' open':'')+'" id="scx-new">'
      + (S.formOpen ? '× Cancel' : '+ New job') + '</button>'
      + '<div class="scx-col__body">'
      + '<div class="scx-form'+(S.formOpen?' on':'')+'" id="scx-form"></div>'
      + '<div class="scx-detail" id="scx-detail"'+(S.formOpen?' style="display:none"':'')+'></div>'
      + '</div></div>'
      + '<div class="scx-col"><div class="scx-col__head">Project Bus <span class="scx-count" id="scx-bus-count">…</span></div>'
      + '<div id="scx-bus-composer"></div>'
      + '<div class="scx-col__body" id="scx-bus-list"></div></div>'
      + '</div>';

    const left = document.getElementById('scx-left');
    if(S.tab === 'board') paintBoard(left);
    else if(S.tab === 'schedule') paintSchedule(left);
    else paintListTab(left);
    if(S.formOpen) paintComposer();
    else paintDetail();
    mountBus();
    fitCols();
  }

  /* the bottom of the boxes lines up with the browser on EVERY face — measured,
     not guessed (the After-Hours standard Alessio pointed at, 2026-08-09) */
  function fitCols(){
    if(!S.host) return;
    const g = S.host.querySelector('.scx-3col');
    if(!g) return;
    const top = g.getBoundingClientRect().top;
    if(top > 0) S.host.style.setProperty('--scx-top', Math.round(top + 12) + 'px');
  }

  /* ── BOARD — the one-glance surface. Everything open that needs a hand,
     one tap to move it. Alessio, 2026-08-08: "What is all on my bench right
     now? What is all in the basket right now? … my job is just click done." ── */
  function paintBoard(left){
    const rows = S.rows || [], t = todayStr();
    const bench = rows.filter(r => onBench(r) && committed(r)).sort(benchSort);
    /* AT THE COUNTER — done, and they have NOT been told yet. Alessio, 2026-08-14:
       "they should still be on the board somewhere, not on the bench, they're at
       the counter … so I can send a text and go through the system with it."
       This does not undo the 2026-08-12 order that took the basket off his board.
       The basket was work waiting on a CUSTOMER — nothing he could do, so it only
       made him tense. This is the opposite: it is HIS move, one tap, and the row
       leaves the board the moment he presses Send. Newest first — the job he just
       finished is the one he is standing there holding.

       WHY A WINDOW. "Not told yet" alone put twelve rows here on the first run,
       including three finished over a MONTH ago that the system simply has no
       record of a call for. That is the stress pile again wearing a new name. The
       counter is a physical place: this week's finished work, sitting there before
       it is handed over. Anything older is the basket — it lives on Pickups, where
       chasing is the job, and the section head says how many are back there so
       nothing feels hidden. */
    const untold  = rows.filter(r => isPickup(r) && !told(r));
    const counter = untold.filter(atCounter)
      .sort((a,b) => (a.done_at||'') < (b.done_at||'') ? 1 : -1);
    const counterOld = untold.length - counter.length;
    const chase = rows.filter(r => isRequest(r))
      .sort((a,b) => (a.next_action_date||'9999') < (b.next_action_date||'9999') ? -1 : 1);
    const chaseDue = chase.filter(r => r.next_action_date && r.next_action_date <= t);
    const chaseRest = chase.filter(r => !(r.next_action_date && r.next_action_date <= t));
    const week = upcoming(7);

    const rowHtml = (r, taps) => {
      const late = r.status === 'at_risk';
      /* the tag states WHERE IT IS; the buttons are ACTIONS ("Mark …") — the two
         must never read alike (Alessio caught the buttons reading as states) */
      const state = isPickup(r) ? (told(r) ? 'done · not collected' : 'done · not told yet')
        : r.started_at ? 'started' : (r.status||'').replace('_',' ');
      return '<div class="scx-card'+(S.sel===r.id?' on':'')+'" data-scxid="'+r.id+'">'
        + '<div class="scx-card__t">'+esc(r.customer_name||'—')+' · '+esc(typeLabel(r))
        + ' <span class="scx-tag'+(isPickup(r)?' amber':'')+'">'+esc(state)+'</span>'
        + (r.rush ? ' <span class="scx-tag red">Rush</span>' : '')
        + (late ? ' <span class="scx-tag red">Late</span>' : '') + '</div>'
        + '<div class="scx-card__s">'+esc(r.blade_detail||r.service||'')
        + (isJob(r) ? (r.preferred_date ? ' · due '+esc(r.preferred_date) : '')
                    : (r.scheduled_at ? ' · '+esc(fmtDay(r.scheduled_at))+' '+esc(fmtTime(r.scheduled_at)) : ''))
        + (isPickup(r) && r.done_at ? ' · waiting '+daysWaiting(r.done_at)+'d'
            + (r.customer_phone ? '' : ' · <span style="color:#e05252">no phone on file</span>') : '')
        + '</div>'
        + '<div class="scx-acts">'+taps.map(tp =>
            '<button type="button" class="scx-act'+(tp.go?' go':'')+'" data-scxact="'+tp.a+'" data-scxrow="'+r.id+'">'+tp.l+'</button>'
          ).join('')+'</div>'
        + '</div>';
    };

    let h = '';
    h += '<div class="scx-sec">On the bench — '+bench.length+'</div>';
    h += bench.length ? bench.map(r => rowHtml(r, [
        !r.started_at ? { a:'started', l:'Mark started' } : null,
        { a:'done', l:'Mark done', go:true }
      ].filter(Boolean))).join('') : '<div class="scx-empty">Bench clear.</div>';

    /* THE BASKET IS NOT ON THE BOARD (Alessio, 2026-08-12, third time asked).
       Finished work waiting on a customer is not his queue. "If this is on my
       queue, it is just sitting there. Every day I look at it and get stressed
       by it. I am creating this so I cannot be stressed." Done-and-not-collected
       lives on the PICKUPS tab, where it is someone's job to chase it — and it
       is still one tap away. Nothing was deleted; it was moved off his glance.

       The one thing that DOES belong here: the job he just finished that nobody
       has been told about. That is his move, not the customer's, and it clears
       itself the second he sends the text. */
    const older = counterOld
      ? ' <span class="scx-tag">'+counterOld+' older under Pickups</span>' : '';
    h += '<div class="scx-sec">At the counter — '+counter.length+older+'</div>';
    h += counter.length ? counter.map(r => rowHtml(r, [
        { a:'picked_up', l:'Mark picked up' }
      ])).join('')
      : '<div class="scx-empty">Nothing finished in the last '+COUNTER_DAYS+' days is waiting on a word from you.</div>';

    h += '<div class="scx-sec">Next 7 days</div>';
    h += week.length ? week.map(d =>
        '<div class="scx-day"><div class="scx-day__h">'+esc(d.label)+'</div>'
        + d.items.map(i => '<div class="scx-slot'+(i.dim?' dim':'')+'"'
            + (i.id ? ' data-scxid="'+i.id+'" style="cursor:pointer"' : '') + '>'
            + '<span class="scx-slot__t">'+esc(i.t)+'</span><span>'+esc(i.what)+'</span></div>').join('')
        + '</div>').join('')
      : '<div class="scx-empty">Nothing on the clock this week.</div>';

    h += '<div class="scx-sec">Chase today — '+chaseDue.length+'</div>';
    h += chaseDue.length ? chaseDue.map(r => rowHtml(r, [{ a:'chase7', l:'Chased — again in a week' }])).join('')
       : '<div class="scx-empty">Nobody to chase today.'+(chaseRest.length? ' '+chaseRest.length+' request'+(chaseRest.length===1?'':'s')+' waiting under Requests.':'')+'</div>';

    if(left) left.innerHTML = h;
    const cnt = document.getElementById('scx-count');
    /* the basket stays excluded — but the counter is his work, so it counts */
    if(cnt) cnt.textContent = bench.length + counter.length + chaseDue.length;
    /* NOTHING auto-selects (Alessio, 2026-08-09): the centre shows only what HE
       tapped — otherwise it just offers + New job. */
  }

  function benchSort(a,b){
    if(!!a.rush !== !!b.rush) return a.rush ? -1 : 1;
    const ad = a.preferred_date || '9999-12-31', bd = b.preferred_date || '9999-12-31';
    if(ad !== bd) return ad < bd ? -1 : 1;
    return (a.created_at||'') < (b.created_at||'') ? -1 : 1;
  }

  /* the day-by-day feed shared by BOARD (7 days) and SCHEDULE (14 days) */
  function upcoming(nDays){
    const rows = S.rows || [], byId = {};
    rows.forEach(r => byId[r.id] = r);
    const days = [];
    for(let i = 0; i < nDays; i++){
      const d = new Date(); d.setDate(d.getDate()+i);
      const iso = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      const wd = d.getDay();
      const items = [];
      // firm clock: claims land first
      S.claims.forEach(c => {
        const start = spanStart(c.span);
        if(!start || start.toDateString() !== d.toDateString()) return;
        const b = c.booking_id ? byId[c.booking_id] : null;
        items.push({ t: fmtTime(start.toISOString()) + (c.status==='tentative' ? ' · pencil' : ''),
          what: (b ? (b.customer_name||'') + ' · ' + (b.service||b.category||'') : (c.note||c.kind)),
          id: b ? b.id : null, sort: start.getTime() });
      });
      // due-by: jobs promised for this day
      const due = rows.filter(r => onBench(r) && r.preferred_date === iso);
      if(due.length) items.push({ t:'due', what: due.length+' job'+(due.length===1?'':'s')+' promised: '
        + due.map(r => r.customer_name||'—').join(', '), sort: 23*3600000 });
      // website drop-off windows
      S.hours.forEach(hh => {
        if(hh.weekday === wd && hh.times && hh.times.length)
          items.push({ t:'website', what:'Drop-off slots open ('+esc(hh.service||'sharpening')+'): '+hh.times.join(' · '), dim:true, sort: 24*3600000 });
      });
      // Google context — display only, never part of the exclusion spine
      S.gcal.forEach(g => {
        const gs = new Date(g.start_time);
        if(gs.toDateString() !== d.toDateString()) return;
        items.push({ t: g.all_day ? 'all day' : fmtTime(g.start_time), what:'[cal] '+(g.summary||''), dim:true, sort: g.all_day ? -1 : gs.getTime() });
      });
      if(items.length){
        items.sort((a,b) => a.sort - b.sort);
        days.push({ label: (i===0?'Today · ':'') + d.toLocaleDateString('en-CA',{weekday:'long',month:'short',day:'numeric'}), items });
      }
    }
    return days;
  }

  function paintSchedule(left){
    const days = upcoming(14);
    if(left) left.innerHTML = days.length ? days.map(d =>
        '<div class="scx-day"><div class="scx-day__h">'+esc(d.label)+'</div>'
        + d.items.map(i => '<div class="scx-slot'+(i.dim?' dim':'')+'"'
            + (i.id ? ' data-scxid="'+i.id+'" style="cursor:pointer"' : '') + '>'
            + '<span class="scx-slot__t">'+esc(i.t)+'</span><span>'+esc(i.what)+'</span></div>').join('')
        + '</div>').join('')
      : '<div class="scx-empty">Nothing on the clock for the next two weeks.</div>';
    const cnt = document.getElementById('scx-count');
    if(cnt) cnt.textContent = days.length + ' day' + (days.length===1?'':'s');
  }

  /* ── the list tabs: BENCH · REQUESTS · CLASSES · PICKUPS · HISTORY ── */
  function tabRows(){
    const rows = S.rows || [];
    if(S.tab === 'bench')    return rows.filter(r => onBench(r) && !!r.preferred_date).sort(benchSort);
    if(S.tab === 'requests') return rows.filter(isRequest)
      .sort((a,b) => (a.next_action_date||'9999') < (b.next_action_date||'9999') ? -1 : 1);
    if(S.tab === 'classes')  return rows.filter(r => isSession(r) && isOpen(r))
      .sort((a,b) => (a.scheduled_at||'9999') < (b.scheduled_at||'9999') ? -1 : 1);
    /* PICKUPS — nobody-told-yet rides at the top, freshest first (2026-08-14: he
       marked a job done and could not find it, because oldest-first buried it at
       the bottom of fifteen). Below that, the chase list keeps its old order:
       longest wait first, because that is who needs chasing. */
    if(S.tab === 'pickups')  return rows.filter(isPickup).sort((a,b) => {
      const ta = told(a), tb = told(b);
      if(ta !== tb) return ta ? 1 : -1;
      if(!ta) return (a.done_at||'') < (b.done_at||'') ? 1 : -1;
      return (a.done_at||'') < (b.done_at||'') ? -1 : 1;
    });
    if(S.tab === 'history')  return rows.filter(r => !isOpen(r))
      .sort((a,b) => (a.created_at||'') < (b.created_at||'') ? 1 : -1);
    return [];
  }

  function paintListTab(left){
    const list = tabRows(), t = todayStr();
    /* keep the selection only if it survived the filter — NEVER auto-pick */
    if(S.sel && !list.some(r => r.id === S.sel)) S.sel = null;
    const cards = list.map(r => {
      const tags = '<span class="scx-tag">'+wtLabel(r)+'</span>'
        + (r.rush ? '<span class="scx-tag red">Rush</span>' : '')
        + (r.status === 'at_risk' ? '<span class="scx-tag red">Late</span>' : '')
        + (S.tab === 'requests' && r.next_action_date && r.next_action_date <= t
            ? '<span class="scx-tag amber">Chase now</span>' : '')
        + (S.tab === 'requests' && !r.next_action_date
            ? '<span class="scx-tag red">No chase date</span>' : '')
        + (S.tab === 'pickups' ? '<span class="scx-tag amber">waiting '+daysWaiting(r.done_at)+'d</span>' : '')
        + '<span class="scx-tag">'+esc((r.status||'').replace('_',' '))+'</span>';
      const sub = (r.blade_detail||r.service||'')
        + (isJob(r) ? (r.preferred_date ? ' · due '+r.preferred_date : ' · no date set')
                    : (r.scheduled_at ? ' · '+fmtDay(r.scheduled_at)+' '+fmtTime(r.scheduled_at) : ' · not booked yet'))
        + (S.tab === 'requests' ? (r.next_action_date ? ' · chase '+r.next_action_date : '') : '');
      return '<div class="scx-card'+(S.sel===r.id?' on':'')+(isOpen(r)?'':' closed')+'" data-scxid="'+r.id+'">'
        + '<div class="scx-card__t">'+esc(r.customer_name||'—')+' · '+esc(typeLabel(r))+'</div>'
        + '<div class="scx-card__s">'+esc(sub)+'</div>'
        + '<div>'+tags+'</div></div>';
    }).join('');
    if(left) left.innerHTML = cards || '<div class="scx-empty">'+emptyLine()+'</div>';
    const cnt = document.getElementById('scx-count');
    if(cnt) cnt.textContent = list.length;
  }

  /* ── Project Bus rail — the ONE shared composer + azck-operations-cowork
     thread (layout standard, Alessio ruling 2026-07-27). Moves house intact. ── */
  function mountBus(){
    (function m(n){
      const host = document.getElementById('scx-bus-composer');
      if(!host) return;
      if(host.dataset.ccbcMounted){ loadBus(); return; }
      if(!window.CCBusComposer){ if(n < 60) setTimeout(() => m(n+1), 100); else loadBus(); return; }
      window.CCBusComposer.mount(host, {
        projectSlug: 'azck-operations-cowork',
        label: 'New bus message',
        placeholder: 'Type a message about the schedule…',
        onSent: loadBus
      });
      loadBus();
    })(0);
  }
  async function loadBus(){
    const host = document.getElementById('scx-bus-list'); if(!host || !window.supa) return;
    const { data, error } = await window.supa.from('agent_messages')
      .select('id,from_user,to_user,body,created_at')
      .eq('project_slug','azck-operations-cowork').is('archived_at',null)
      .order('created_at',{ascending:false}).limit(30);
    const c = document.getElementById('scx-bus-count'); if(c) c.textContent = error ? '—' : (data||[]).length;
    if(error){ host.innerHTML = '<div class="scx-empty">Bus unavailable.</div>'; return; }
    host.innerHTML = (data||[]).length ? data.map(m =>
      '<div class="scx-msg"><div class="scx-msg__head">#'+m.id+' · '+esc(m.from_user)+' → '+esc(m.to_user)+' · '+esc(day(m.created_at))+'</div>'
      + esc((m.body||'').slice(0,400)) + '</div>').join('') : '<div class="scx-empty">No messages yet.</div>';
  }

  function emptyLine(){
    return S.tab === 'bench' ? 'Bench clear — nothing dated and open.'
      : S.tab === 'requests' ? 'No open requests. Everything has a date.'
      : S.tab === 'classes' ? 'No classes or events on the books.'
      : S.tab === 'pickups' ? 'Nothing waiting to be collected.'
      : 'History is empty.';
  }

  /* ── DETAIL — the product, plus the actions that move it ── */
  function paintDetail(){
    const det = document.getElementById('scx-detail'); if(!det) return;
    /* never eat half-typed words: whatever is in the text box outranks what the
       DB last handed us, so a repaint (or a reload) cannot swallow his edit */
    const typing = det.querySelector('[data-scxsmsid]');
    if(typing) smsPatchLocal(typing.dataset.scxsmsid, { body: typing.value });
    const r = (S.rows||[]).find(x => x.id === S.sel);
    if(S.editing === S.sel && r){ paintEdit(det, r); return; }
    delete det.dataset.scxEditing;
    if(!r){ det.innerHTML = '<div class="scx-empty">Pick one on the left, or tap + New job.</div>'; return; }
    const row = (k,v) => v ? '<div class="scx-row"><div class="scx-row__k">'+esc(k)+'</div><div class="scx-row__v">'+v+'</div></div>' : '';
    const lines = (r.line_items && r.line_items.length)
      ? '<div style="margin:8px 0">'+r.line_items.map(l =>
          '<div class="scx-line"><span>'+esc(l.label)+'</span><span>$'+Number(l.line_cad||0).toFixed(2)+'</span></div>').join('')+'</div>'
      : '';
    const roster = r.work_type === 'event' ? rosterHtml(r) : '';
    const transport = isJob(r) && isOpen(r) ? transportHtml(r) : '';
    const acts = r.status === 'archived'
      ? '<button type="button" class="scx-act" data-scxact="unarchive" data-scxrow="'+r.id+'">Unarchive</button>'
      : (isOpen(r)
          ? (isJob(r)
              ? '<button type="button" class="scx-act'+(r.started_at?' on':'')+'" data-scxact="started" data-scxrow="'+r.id+'">Mark started</button>'
              : '')
            + '<button type="button" class="scx-act'+(r.done_at?' on':'')+'" data-scxact="done" data-scxrow="'+r.id+'">'
            + (isSession(r) ? 'Mark delivered' : 'Mark done') + '</button>'
            + '<button type="button" class="scx-act" data-scxact="picked_up" data-scxrow="'+r.id+'">Mark picked up</button>'
            + (isSession(r) ? '<button type="button" class="scx-act" data-scxact="cancel" data-scxrow="'+r.id+'">Cancel</button>' : '')
          : '<button type="button" class="scx-act" data-scxact="reopen" data-scxrow="'+r.id+'">Reopen</button>')
        + '<button type="button" class="scx-act" data-scxedit="'+r.id+'">Edit</button>'
        + (r.status !== 'archived' ? '<button type="button" class="scx-act" data-scxact="archive" data-scxrow="'+r.id+'">Archive</button>' : '');
    det.innerHTML = '<h3>'+esc(r.customer_name||'—')+' · '+esc(typeLabel(r))+'</h3>'
      + row('Kind', wtLabel(r) + (isRequest(r) ? ' — REQUEST: no committed date yet' : ''))
      + row('What', esc(r.blade_detail||r.service||''))
      + row('How many', r.quantity ? esc('×'+r.quantity) : '')
      + lines
      + row('Phone', r.customer_phone ? '<a href="tel:'+esc(r.customer_phone)+'">'+esc(r.customer_phone)+'</a>' : '')
      + (!r.customer_phone && !r.customer_email
          ? '<div class="scx-row"><div class="scx-row__k">Phone</div><div class="scx-row__v" style="color:#e05252">none on file — tap Edit to add one, or you cannot tell them it is ready</div></div>' : '')
      + row('Email', r.customer_email ? '<a href="mailto:'+esc(r.customer_email)+'">'+esc(r.customer_email)+'</a>' : '')
      + (isJob(r)
          ? row('Due by', esc(r.preferred_date ? r.preferred_date + (r.preferred_time ? ' · '+r.preferred_time : '') : ''))
            + row('Drop-off slot', r.scheduled_at ? esc(fmtDay(r.scheduled_at)+' '+fmtTime(r.scheduled_at)) : '')
          : row('Booked for', r.scheduled_at
              ? esc(fmtDay(r.scheduled_at)+' '+fmtTime(r.scheduled_at))
                + (r.duration_minutes ? esc(' · '+(r.duration_minutes/60)+'h') : ' · <span style="color:#e8a13a">no length set — the day is only pencilled</span>')
              : '<span style="color:#e8a13a">not booked yet</span>')
            + (r.preferred_date && !r.scheduled_at ? row('They wished for', esc(r.preferred_date)) : ''))
      + row('Chase on', r.next_action_date ? esc(r.next_action_date) : '')
      + row('Rush', r.rush ? 'YES' : '')
      + row('Status', esc((r.status||'').replace('_',' ')))
      + row('Price', r.total_cad ? '$'+esc(String(r.total_cad)) : '')
      + row('Came in', esc(day(r.created_at)) + (r.intake_by ? ' · by '+esc(r.intake_by) : ''))
      + row('Started', esc(day(r.started_at))) + row('Done', esc(day(r.done_at)))
      + row('Told them', esc(day(r.notified_at))) + row('Picked up', esc(day(r.picked_up_at)))
      + row('Notes', r.notes ? esc(r.notes) : '')
      + transport
      + roster
      + '<div class="scx-acts">'+acts+'</div>'
      + smsHtml(r);
  }

  /* ══════════════ THE PICKUP TEXT — it lives HERE, in the job window ══════════════
     Alessio, 2026-08-14: the Send button belongs directly under mark started /
     mark done / mark pickup, so marking a job done and telling the customer are
     one motion in one place. The Texts tab is the ledger; this is the counter.

     THE MONEY IS CALCULATED, NEVER A PLACEHOLDER. line_items carry Square's
     catalogue prices, which are PRE-tax (proven: unit_cad matches az_price_list
     sell_price exactly, and the two texts he has already approved — Randy $109.20,
     Ralph $86.10 — are both subtotal x 1.05). Alberta is GST 5%, no PST.
     The same arithmetic lives in the DB function az_pickup_draft_text, which
     writes the draft; this mirror only SHOWS him the breakdown.

     NOTHING SENDS WITHOUT HIS PRESS. Send is the only thing that flips a row from
     draft to approved, and the sender (client-sms POST /run) drains approved only. */
  const SMS_SEND_URL = 'https://twrlvnfszohyrmivdhre.supabase.co/functions/v1/client-sms/run';
  const GST = 0.05;

  /* the job's own money: priced lines first, the stored total behind them */
  function moneyOf(r){
    let sub = null;
    if(r.line_items && r.line_items.length){
      sub = r.line_items.reduce((a,l) => a + (Number(l.line_cad) || 0), 0);
    }
    if(!(sub > 0) && r.total_cad != null) sub = Number(r.total_cad);
    if(!(sub > 0)) return null;
    return { sub: sub, gst: Math.round(sub * GST * 100) / 100, total: Math.round(sub * (1 + GST) * 100) / 100 };
  }
  function cad(n){ return '$' + Number(n).toFixed(2); }

  /* the live text row for a job — the newest one that still matters */
  function smsOf(id){
    const mine = (S.sms || []).filter(x => x.booking_id === id && x.status !== 'cancelled');
    return mine.length ? mine[0] : null;
  }

  function smsHtml(r){
    if(!isJob(r) && !isSession(r)) return '';
    if(r.status === 'archived') return '';
    const m   = moneyOf(r);
    const row = smsOf(r.id);
    const note = S.smsMsg
      ? '<div class="scx-sms__note'+(S.smsBad?' bad':'')+'">'+esc(S.smsMsg)+'</div>' : '';

    const head = '<div class="scx-sms__head">The text'
      + (row && row.status === 'sent' ? ' <span class="scx-tag">sent '+esc(day(row.sent_at || row.created_at))+'</span>'
        : row && row.status === 'approved' ? ' <span class="scx-tag amber">handed to the sender</span>'
        : row && row.status === 'failed'   ? ' <span class="scx-tag bad">last try failed</span>'
        : row ? ' <span class="scx-tag amber">waiting on you</span>' : '')
      + '</div>';

    /* the money, spelled out, so he never has to do the arithmetic himself */
    const priced = m
      ? '<div class="scx-sms__money">'+cad(m.sub)+' + '+cad(m.gst)+' GST = <b>'+cad(m.total)+'</b></div>'
      : '<div class="scx-sms__money bad">No price on this job — tap Edit and add the lines, then Write the text again.</div>';

    if(!r.customer_phone){
      return '<div class="scx-sms">'+head
        + '<div class="scx-sms__money bad">No phone on file. Tap Edit and add one, then the text can be written.</div>'
        + '</div>';
    }

    if(!row){
      const why = r.done_at ? '' : ' It is written for you the moment you mark this done.';
      return '<div class="scx-sms">'+head+priced
        + '<div class="scx-sms__idle">Nothing written yet.'+esc(why)+'</div>'
        + '<div class="scx-acts"><button type="button" class="scx-act" data-scxsms="write" data-scxrow="'+r.id+'">Write the text</button></div>'
        + note + '</div>';
    }

    if(row.status === 'sent'){
      return '<div class="scx-sms">'+head
        + '<div class="scx-sms__done">'+esc(row.body)+'</div>'
        + '<div class="scx-sms__idle">Gone to '+esc(row.to_phone||'')+'. Nothing more to do.</div>'
        + note + '</div>';
    }
    if(row.status === 'approved'){
      return '<div class="scx-sms">'+head
        + '<div class="scx-sms__done">'+esc(row.body)+'</div>'
        + '<div class="scx-sms__idle">On its way. Hit the reload arrow in a moment to see it land.</div>'
        + note + '</div>';
    }

    /* draft or failed — the one place the words can still be changed */
    return '<div class="scx-sms">'+head
      + (row.status === 'failed' ? '<div class="scx-sms__money bad">'+esc(row.error||'It did not go through.')+'</div>' : '')
      + priced
      + '<textarea class="scx-sms__body" id="scx-sms-body" data-scxsmsid="'+row.id+'" rows="5">'+esc(row.body||'')+'</textarea>'
      + '<div class="scx-sms__to">to '+esc(row.to_name||r.customer_name||'')+' · '+esc(row.to_phone||r.customer_phone||'')+'</div>'
      + '<div class="scx-acts">'
      +   '<button type="button" class="scx-act send" data-scxsms="send" data-scxsmsid="'+row.id+'" data-scxrow="'+r.id+'">Send</button>'
      +   '<button type="button" class="scx-act" data-scxsms="save" data-scxsmsid="'+row.id+'" data-scxrow="'+r.id+'">Save for later</button>'
      +   '<button type="button" class="scx-act" data-scxsms="rewrite" data-scxsmsid="'+row.id+'" data-scxrow="'+r.id+'">Write it again</button>'
      +   '<button type="button" class="scx-act" data-scxsms="drop" data-scxsmsid="'+row.id+'" data-scxrow="'+r.id+'">Don\'t send</button>'
      + '</div>'
      + note + '</div>';
  }

  function smsSay(t, bad){ S.smsMsg = t || null; S.smsBad = !!bad; paintDetail(); }

  /* what is in the box right now — his edits win over what the DB last saw */
  function smsTyped(){
    const t = document.getElementById('scx-sms-body');
    return t ? t.value.trim() : '';
  }
  function smsPatchLocal(id, patch){
    const i = (S.sms || []).findIndex(x => x.id === id);
    if(i >= 0) S.sms[i] = Object.assign({}, S.sms[i], patch);
  }

  async function smsAct(what, smsId, bookingId){
    if(!window.supa || S.busy) return;
    const r = (S.rows || []).find(x => x.id === bookingId);

    if(what === 'write' || what === 'rewrite'){
      S.busy = true;
      try{
        const t = await window.supa.rpc('az_pickup_draft_text', { p_booking: bookingId });
        if(t.error) throw new Error(t.error.message);
        const body = t.data;
        if(!body) throw new Error('That job did not give me enough to write with.');
        if(smsId){
          const up = await window.supa.from('az_sms_log').update({ body: body }).eq('id', smsId);
          if(up.error) throw new Error(up.error.message);
          smsPatchLocal(smsId, { body: body });
          S.busy = false; smsSay('Rewritten from the job. It still has not gone anywhere.');
          return;
        }
        const ins = await window.supa.from('az_sms_log').insert({
          direction:'outbound', to_phone:r.customer_phone, to_name:r.customer_name,
          body: body, status:'draft', booking_id: bookingId,
          ref: 'pickup-' + new Date().toISOString().slice(0,10), created_by: 'queue-window'
        });
        if(ins.error) throw new Error(ins.error.message);
        S.busy = false; S.smsMsg = 'Written. Read it, then press Send.'; S.smsBad = false;
        load(); return;
      }catch(e){ S.busy = false; smsSay('Could not write it: '+(e.message||e), true); return; }
    }

    const body = smsTyped();

    if(what === 'save'){
      if(!body){ smsSay('There is nothing written to save.', true); return; }
      S.busy = true;
      const up = await window.supa.from('az_sms_log').update({ body: body }).eq('id', smsId);
      S.busy = false;
      if(up.error){ smsSay('Could not save it: '+up.error.message, true); return; }
      smsPatchLocal(smsId, { body: body });
      smsSay('Saved. It still has not gone anywhere.');
      return;
    }

    if(what === 'drop'){
      if(!confirm('Throw this text away? The job stays done, the customer just does not hear from us.')) return;
      S.busy = true;
      const up = await window.supa.from('az_sms_log')
        .update({ status:'cancelled', error:'dropped by Alessio' }).eq('id', smsId);
      S.busy = false;
      if(up.error){ smsSay('Could not drop it: '+up.error.message, true); return; }
      S.smsMsg = 'Dropped.'; S.smsBad = false;
      load(); return;
    }

    if(what === 'send'){
      if(!body){ smsSay('There is nothing written to send.', true); return; }
      if(/\$_+/.test(body)){ smsSay('That still has a blank where the total goes. Write it again, or type the number.', true); return; }
      if(!confirm('This goes to their phone now:\n\n'+body+'\n\nSend it?')) return;
      S.busy = true;
      try{
        const sv = await window.supa.from('az_sms_log').update({ body: body }).eq('id', smsId);
        if(sv.error) throw new Error(sv.error.message);
        /* THE ONE LINE THAT ARMS IT. Everything before this is reversible. */
        const up = await window.supa.from('az_sms_log')
          .update({ status:'approved', approved_by:'alessio', approved_at:new Date().toISOString() }).eq('id', smsId);
        if(up.error) throw new Error(up.error.message);
        await fetch(SMS_SEND_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
        /* trust the ROW, not the call */
        await new Promise(z => setTimeout(z, 1500));
        const chk = await window.supa.from('az_sms_log').select('status,error').eq('id', smsId).maybeSingle();
        const st = chk.data ? chk.data.status : null;
        S.busy = false;
        S.smsMsg = st === 'sent'   ? 'Sent.'
                 : st === 'failed' ? 'It did not go through: '+(chk.data.error||'unknown')
                 : 'Handed to the sender, still going. Hit the reload arrow in a moment.';
        S.smsBad = st === 'failed';
        load(); return;
      }catch(e){ S.busy = false; smsSay('Could not send it: '+(e.message||e), true); return; }
    }
  }

  /* transport legs (blueprint §5): where the property is + one-tap moves */
  function transportHtml(r){
    const here = r.item_location || '';
    const chips = LOCS.map(l =>
      '<span class="scx-chip'+(here===l?' on':'')+'" data-scxloc="'+esc(l)+'" data-scxrow="'+r.id+'">'+esc(l)+'</span>').join('');
    const tap = here === 'Blue Building'
        ? '<button type="button" class="scx-act go" data-scxloc="In transit" data-scxrow="'+r.id+'">Send to shop →</button>'
      : here === 'In transit'
        ? '<button type="button" class="scx-act go" data-scxloc="Shop" data-scxrow="'+r.id+'">Arrived at shop</button>'
          + '<button type="button" class="scx-act go" data-scxloc="Blue Building" data-scxrow="'+r.id+'">Arrived at BB</button>'
      : (here === 'Shop' || here === "Alessio's bench") && r.done_at
        ? '<button type="button" class="scx-act go" data-scxloc="In transit" data-scxrow="'+r.id+'">← Back to BB</button>'
      : '';
    return '<div class="scx-row"><div class="scx-row__k">Where it is</div><div class="scx-row__v">'
      + '<div class="scx-chips">'+chips+'</div>'
      + (tap ? '<div class="scx-acts" style="margin-top:4px">'+tap+'</div>' : '')
      + '</div></div>';
  }

  /* the roster — an event owns people (az_event_attendees) */
  function rosterHtml(r){
    const heads = S.attendees.filter(a => a.booking_id === r.id);
    const cap = r.quantity || null;
    return '<div class="scx-row"><div class="scx-row__k">Roster</div><div class="scx-row__v">'
      + '<div class="scx-count">'+heads.length+(cap ? ' of '+cap : '')+' named'
      + (cap && heads.length < cap ? ' · '+(cap-heads.length)+' seat'+(cap-heads.length===1?'':'s')+' unnamed' : '')
      + (heads.length ? ' · '+heads.filter(a=>a.paid).length+' paid' : '')+'</div>'
      + heads.map(a =>
          '<div class="scx-line"><span>'+esc(a.name)+(a.contact ? ' <small style="color:var(--text-dim,#999)">'+esc(a.contact)+'</small>' : '')+'</span>'
          + '<span class="scx-chip'+(a.paid?' on':'')+'" data-scxpaid="'+a.id+'">'+(a.paid?'paid':'unpaid')+'</span>'
          + '<button type="button" class="scx-line__x" data-scxdelatt="'+a.id+'" title="Remove">×</button></div>').join('')
      + '<div class="scx-acts" style="margin-top:5px">'
      + '<input id="scx-att-name" placeholder="name" style="flex:1;min-width:90px;padding:5px 8px;border:1px solid var(--border,#333);border-radius:6px;background:transparent;color:inherit;">'
      + '<input id="scx-att-contact" placeholder="phone or email (optional)" style="flex:1;min-width:110px;padding:5px 8px;border:1px solid var(--border,#333);border-radius:6px;background:transparent;color:inherit;">'
      + '<button type="button" class="scx-act" data-scxaddatt="'+r.id+'">+ Add</button>'
      + '</div></div></div>';
  }

  /* ── EDIT — writes the base table; the phone-number path stays private ── */
  function paintEdit(det, r){
    if(det.dataset.scxEditing === r.id) return;   // never eat half-typed input
    const val = k => r[k] == null ? '' : String(r[k]);
    const schedDate = r.scheduled_at ? new Date(r.scheduled_at) : null;
    const dLocal = schedDate ? (schedDate.getFullYear()+'-'+String(schedDate.getMonth()+1).padStart(2,'0')+'-'+String(schedDate.getDate()).padStart(2,'0')) : '';
    const tLocal = schedDate ? (String(schedDate.getHours()).padStart(2,'0')+':'+String(schedDate.getMinutes()).padStart(2,'0')) : '';
    const f = (k, lbl, type, extra) => '<div class="scx-f"><label for="scx-ed-'+k+'">'+lbl+'</label>'
      + '<input id="scx-ed-'+k+'" type="'+(type||'text')+'" autocomplete="off" '+(extra||'')+' value="'+esc(val(k))+'"></div>';
    det.innerHTML = '<h3>Edit · '+esc(r.customer_name||'—')+'</h3>'
      + '<div class="scx-f"><label>This is a…</label><div class="scx-chips">'
      + ['job','appointment','event'].map(w =>
          '<span class="scx-chip'+((r.work_type||'job')===w?' on':'')+'" data-scxedwt="'+w+'">'+w+'</span>').join('')
      + '</div></div>'
      + f('customer_phone','Phone','tel','placeholder="so you can text them when it is ready"')
      + f('customer_email','Email','email')
      + f('customer_name','Customer','text')
      + f('quantity', r.work_type==='event' ? 'How many people' : 'How many','number','step="1"')
      + f('blade_detail','What it is','text')
      + f('preferred_date', isJob(r)?'Due by (the promise)':'Wished-for date','date')
      + '<div class="scx-f"><label>Booked slot (appointments + events — this claims the calendar)</label>'
      + '<div style="display:flex;gap:6px"><input id="scx-ed-sdate" type="date" value="'+esc(dLocal)+'" style="flex:1">'
      + '<input id="scx-ed-stime" type="time" value="'+esc(tLocal)+'" style="flex:1"></div></div>'
      + f('duration_minutes','Length in minutes (600 = full day) — firm needs this','number','step="15"')
      + f('next_action_date','Chase date (requests — when to follow up)','date')
      + f('total_cad','Price $','number','step="0.01"')
      + '<div class="scx-f"><label for="scx-ed-item_location">Where it is</label>'
      + '<select id="scx-ed-item_location"><option value=""></option>'
      + LOCS.map(l => '<option'+(val('item_location')===l?' selected':'')+'>'+esc(l)+'</option>').join('')
      + (val('item_location') && LOCS.indexOf(val('item_location')) === -1
          ? '<option selected>'+esc(val('item_location'))+'</option>' : '')
      + '</select></div>'
      + '<div class="scx-f"><label for="scx-ed-notes">Notes</label><textarea id="scx-ed-notes">'+esc(val('notes'))+'</textarea></div>'
      + '<div class="scx-acts">'
      + '<button type="button" class="scx-act on" id="scx-ed-save" data-scxrow="'+r.id+'">Save</button>'
      + '<button type="button" class="scx-act" id="scx-ed-cancel">Cancel</button>'
      + '</div>';
    det.dataset.scxEditing = r.id;
    det.dataset.scxWt = r.work_type || 'job';
  }

  async function saveEdit(id){
    const det = document.getElementById('scx-detail');
    const g = k => { const el = document.getElementById('scx-ed-'+k); return el ? String(el.value||'').trim() : ''; };
    const name = g('customer_name');
    if(!name){ alert('Customer name is needed.'); return; }
    const qty = g('quantity'), price = g('total_cad'), dur = g('duration_minutes');
    if(qty && !Number.isFinite(Number(qty)))     { alert('How many must be a number.'); return; }
    if(price && !Number.isFinite(Number(price))) { alert('Price must be a number.'); return; }
    if(dur && !Number.isFinite(Number(dur)))     { alert('Length must be minutes — a number.'); return; }
    const sd = g('sdate'), stm = g('stime');
    let scheduled_at = null;
    if(sd && stm) scheduled_at = new Date(sd+'T'+stm).toISOString();
    else if(sd && !stm){ alert('A booked slot needs a time too — or clear the date to leave it unbooked.'); return; }
    const patch = {
      work_type: (det && det.dataset.scxWt) || 'job',
      customer_name: name,
      customer_phone: g('customer_phone') || null,
      customer_email: g('customer_email') || null,
      blade_detail: g('blade_detail') || null,
      quantity: qty === '' ? null : Number(qty),
      preferred_date: g('preferred_date') || null,
      scheduled_at: scheduled_at,
      duration_minutes: dur === '' ? null : Number(dur),
      next_action_date: g('next_action_date') || null,
      total_cad: price === '' ? null : Number(price),
      item_location: g('item_location') || null,
      notes: g('notes') || null
    };
    S.editing = null;
    write(id, patch);
  }

  /* ══════════════ COMPOSER — + New job (writes the base table) ══════════ */
  function paintComposer(){
    const host = document.getElementById('scx-form'); if(!host) return;
    host.innerHTML =
      '<h3 style="font-family:var(--display,inherit);color:var(--amber,#e8a13a);margin:0 0 8px;">New job</h3>'
      + '<div class="scx-f" style="position:relative"><label for="scx-name">Customer</label>'
      + '<input id="scx-name" autocomplete="off" placeholder="start typing — past customers appear">'
      + '<div id="scx-cust-hits" class="scx-hits" hidden></div></div>'
      + '<div style="display:flex;gap:8px"><div class="scx-f" style="flex:1"><label for="scx-phone">Phone</label><input id="scx-phone" type="tel"></div>'
      + '<div class="scx-f" style="flex:1"><label for="scx-email">Email</label><input id="scx-email" type="email"></div></div>'
      + '<div class="scx-f"><label for="scx-type">Type of work</label><select id="scx-type">'
      + Object.keys(SVQ_TYPES).filter(k => k!=='teambuilding').map(k => '<option value="'+k+'">'+SVQ_TYPES[k]+'</option>').join('')
      + '</select></div>'
      + '<div class="scx-f"><label>This is a…</label><div class="scx-chips" id="scx-cwork">'
      + ['job','appointment','event'].map(w => '<span class="scx-chip'+(S.cWork===w?' on':'')+'" data-scxcw="'+w+'">'+w+'</span>').join('')
      + '</div></div>'
      + '<div class="scx-f" id="scx-kind-wrap"><label id="scx-kind-lbl">What came in</label><div class="scx-chips" id="scx-kind"></div></div>'
      + '<div class="scx-f" id="scx-variant-wrap" hidden><label id="scx-variant-lbl"></label><div class="scx-chips" id="scx-variant"></div></div>'
      + '<div class="scx-f" id="scx-addons-wrap" hidden><div id="scx-addons"></div></div>'
      + '<div class="scx-f" id="scx-size-wrap" hidden><label>Size</label><div class="scx-chips" id="scx-size"></div></div>'
      + '<div class="scx-f" id="scx-manual-wrap" hidden><label>Typed line</label>'
      + '<div style="display:flex;gap:6px"><input id="scx-man-label" placeholder="what it is" style="flex:2">'
      + '<input id="scx-man-price" type="number" step="0.01" placeholder="$" style="flex:1"></div>'
      + '<div class="scx-count" id="scx-man-note"></div></div>'
      + '<div class="scx-f"><label id="scx-qty-lbl">How many</label><div class="scx-chips" id="scx-qty"></div></div>'
      + '<div class="scx-f" id="scx-extras-wrap"><label>Extras — tap again for one more, shift-tap to clear</label><div class="scx-chips" id="scx-extras"></div></div>'
      + '<button type="button" class="scx-act" id="scx-add-line">+ Add to this job</button>'
      + '<div id="scx-lines" style="margin:8px 0"></div>'
      + '<div id="scx-total" style="margin:4px 0 10px;font-weight:700"></div>'
      + '<div class="scx-f" id="scx-due-wrap"><label for="scx-date">Wanted by (the due-by promise)</label><input id="scx-date" type="date"></div>'
      + '<div class="scx-f" id="scx-slot-wrap" hidden><label>Booked slot — date, time, length (this claims the calendar)</label>'
      + '<div style="display:flex;gap:6px"><input id="scx-sdate" type="date" style="flex:1"><input id="scx-stime" type="time" style="flex:1">'
      + '<input id="scx-sdur" type="number" step="15" placeholder="minutes" style="flex:1"></div>'
      + '<div class="scx-count">No date yet? Leave it empty — it lands in Requests with a chase date.</div></div>'
      + '<div class="scx-f"><label>Where it is</label><div class="scx-chips" id="scx-loc-chips"></div></div>'
      + '<div class="scx-f"><label for="scx-notes">Notes</label><textarea id="scx-notes"></textarea></div>'
      + '<div class="scx-acts">'
      + '<button type="button" class="scx-act on" id="scx-save">Add it</button>'
      + '<button type="button" class="scx-act" id="scx-form-cancel">Cancel</button>'
      + '</div>';
    paintBuilder();
    loadCustomers();
    setTimeout(() => { try{ document.getElementById('scx-name').focus(); }catch(e){} }, 30);
  }

  const scxType = () => (document.getElementById('scx-type')||{}).value || 'sharpening';
  const scxMode = () => SVQ_CATALOGS[scxType()] ? 'items' : (scxType() === 'engraving' ? 'engraving' : 'manual');
  const scxCat  = () => SVQ_CATALOGS[scxType()] || SVQ_PRICES;
  const activeExtras = () => {
    const t = scxType();
    return (t === 'sharpening' || t === 'restoration') ? SVQ_EXTRAS
         : t === 'engraving' ? SVQ_ENG_EXTRAS : [];
  };

  function mods(variant, gkey){
    const G = SVQ_MODLISTS[gkey]; if(!G) return [];
    let m = G.mods;
    const drop = (variant && variant.drop || {})[gkey];
    if(drop) m = m.filter(x => drop.indexOf(x.key) === -1);
    if(gkey === 'pins_cul' && variant && variant.bolsterPinRule){
      const b = (S.addons.bolster || [])[0];
      if(b && b !== 'none') m = m.filter(x => x.key === 'p1mo' || x.key === 'p1sig');
    }
    return m;
  }
  function pruneAddons(variant){
    if(!variant || !variant.addons) return;
    variant.addons.forEach(g => {
      const ok = mods(variant, g).map(m => m.key);
      if(S.addons[g]) S.addons[g] = S.addons[g].filter(k => ok.indexOf(k) !== -1);
    });
  }
  function unitPrice(kind, variantKey, size){
    const k = scxCat()[kind]; if(!k) return 0;
    if(kind === 'knives'){
      const s = (k.sizes.concat(k.extraSizes)).find(x => x.key === size);
      return s ? s.cad : 0;
    }
    const v = (k.variants||[]).find(x => x.key === variantKey);
    if(!v) return 0;
    if(v.cad != null) return v.cad;
    const inch = parseInt(String(size),10);
    return isNaN(inch) ? 0 : v.base + inch;
  }
  const chip = (id, lbl, on, price) => '<span class="scx-chip'+(on?' on':'')+'" data-scxc="'+id+'">'
    + esc(lbl) + (price!=null ? '<span class="scx-chip__p">$'+price+'</span>' : '') + '</span>';

  function paintBuilder(){
    const mode = scxMode();
    const el = id => document.getElementById(id);
    const kw = el('scx-kind-wrap'), kl = el('scx-kind-lbl'), vw = el('scx-variant-wrap');
    const sw = el('scx-size-wrap'), mw = el('scx-manual-wrap'), aw = el('scx-addons-wrap');
    const ql = el('scx-qty-lbl');
    if(!kw) return;
    if(aw) aw.hidden = true;
    if(mw) mw.hidden = !(mode === 'manual' || SVQ_MANUAL_TOO[scxType()]);
    kw.hidden = mode === 'manual';
    if(mw && !mw.hidden){
      const note = el('scx-man-note');
      if(note) note.textContent = SVQ_MANUAL_NOTE[scxType()] || SVQ_MANUAL_NOTE.other;
    }
    if(mode === 'items'){
      const cat = scxCat();
      if(!cat[S.kind]) S.kind = Object.keys(cat)[0];
      const k = cat[S.kind];
      kl.textContent = SVQ_KIND_LBL[scxType()] || 'What came in';
      ql.textContent = 'How many';
      el('scx-kind').innerHTML = Object.keys(cat).map(id => chip('kind:'+id, cat[id].label, S.kind===id)).join('');
      if(k.variants){
        vw.hidden = false;
        el('scx-variant-lbl').textContent = k.variantLabel;
        el('scx-variant').innerHTML = k.variants.map(v =>
          chip('var:'+v.key, v.label, S.variant===v.key, v.cad!=null?v.cad:null)).join('');
      } else vw.hidden = true;
      const sizes = k.sizes ? k.sizes.concat(k.extraSizes||[]) : null;
      if(sizes){
        sw.hidden = false;
        el('scx-size').innerHTML = sizes.map(s =>
          chip('size:'+s.key, s.label, S.size===s.key, unitPrice(S.kind, S.variant, s.key) || null)).join('');
      } else sw.hidden = true;
      const picked = k.variants ? k.variants.find(v => v.key === S.variant) : null;
      const groups = picked && picked.addons ? picked.addons : null;
      if(aw){
        aw.hidden = !groups;
        if(groups) el('scx-addons').innerHTML = groups.map(g => {
          const G = SVQ_MODLISTS[g]; if(!G) return '';
          const on = S.addons[g] || [];
          const mm = mods(picked, g);
          const hid = G.mods.length - mm.length;
          return '<div class="scx-sec">'+esc(G.label)+(G.single ? '' : ' · tap any')
            + (hid ? ' <span style="text-transform:none;letter-spacing:0">· '+hid+' hidden, will not fit this knife</span>' : '')+'</div>'
            + '<div class="scx-chips">'
            + mm.map(m => chip('ad:'+g+':'+m.key, m.label, on.indexOf(m.key) !== -1, m.cad || null)).join('')
            + '</div>';
        }).join('');
      }
    } else if(mode === 'engraving'){
      /* What came in first, then the engraving options (Square's Engraving
         variations, flattened to first-piece prices). Never the Size row —
         both rows are engraving-only (Reanna, bus #4351). */
      kl.textContent = 'What came in';
      el('scx-kind').innerHTML = SVQ_ENG_CAME.map(c => chip('ecame:'+c.key, c.label, S.ecame===c.key)).join('');
      vw.hidden = false;
      el('scx-variant-lbl').textContent = 'What kind of engraving — price shown is the first piece';
      const eg = SVQ_ENGRAVING.find(x => x.key === S.ekind);
      ql.textContent = eg ? ('How many pieces — each after the first is $' + (eg.piece || SVQ_ENG_PIECE)) : 'How many pieces';
      el('scx-variant').innerHTML = SVQ_ENGRAVING.map(g => chip('ekind:'+g.key, g.label, S.ekind===g.key, g.first)).join('');
      sw.hidden = true;
    } else {
      ql.textContent = 'How many';
      vw.hidden = true; sw.hidden = true;
    }
    el('scx-qty').innerHTML = SVQ_QTYS.map(n => chip('qty:'+n, String(n), S.qty===n)).join('');
    const ax = activeExtras();
    const xw = el('scx-extras-wrap');
    if(xw) xw.hidden = !ax.length;
    el('scx-extras').innerHTML = ax.map(x =>
      '<span class="scx-chip'+(S.extras[x.key]?' on':'')+'" data-scxc="ex:'+x.key+'">'+esc(x.label)
      + '<span class="scx-chip__p">$'+x.cad+'</span>'
      + (S.extras[x.key] ? '<span class="scx-chip__n">'+S.extras[x.key]+'</span>' : '')+'</span>').join('');
    el('scx-loc-chips').innerHTML = LOCS.map(l => chip('loc:'+l, l, S.loc===l)).join('');
    el('scx-lines').innerHTML = S.lines.map((l,i) =>
      '<div class="scx-line"><span>'+esc(l.label)+'</span>'
      + '<span>'+l.qty+' × $'+l.unit_cad+' = $'+l.line_cad.toFixed(2)+'</span>'
      + '<button type="button" class="scx-line__x" data-scxdel="'+i+'" title="Remove">×</button></div>').join('');
    el('scx-total').innerHTML = 'Total <b>$'+total().toFixed(2)+'</b>';
    // work-type driven slots
    const dueW = el('scx-due-wrap'), slotW = el('scx-slot-wrap');
    if(dueW) dueW.hidden = S.cWork !== 'job';
    if(slotW) slotW.hidden = S.cWork === 'job';
    const cw = el('scx-cwork');
    if(cw) cw.innerHTML = ['job','appointment','event'].map(w =>
      '<span class="scx-chip'+(S.cWork===w?' on':'')+'" data-scxcw="'+w+'">'+w+'</span>').join('');
  }

  function total(){
    let t = S.lines.reduce((a,l) => a + l.line_cad, 0);
    SVQ_ALL_EXTRAS.forEach(x => { if(S.extras[x.key]) t += x.cad * S.extras[x.key]; });
    return t;
  }

  function typeChanged(){
    S.variant = null; S.size = null; S.ekind = null; S.ecame = null; S.qty = 1; S.addons = {};
    const cat = SVQ_CATALOGS[scxType()];
    if(cat) S.kind = Object.keys(cat)[0];
    // classes are sessions by default; teambuilding course kind is an event
    if(scxType() === 'class') S.cWork = 'appointment';
    else if(S.cWork !== 'job' && scxType() !== 'class') S.cWork = 'job';
    paintBuilder();
  }

  function addLine(){
    const mode = scxMode();
    if(mode === 'engraving'){
      if(!S.ekind){ alert('Pick what kind of engraving first.'); return; }
      const g = SVQ_ENGRAVING.find(x => x.key === S.ekind);
      const cad = g.first + (S.qty - 1) * (g.piece || SVQ_ENG_PIECE);
      const came = SVQ_ENG_CAME.find(c => c.key === S.ecame);
      S.lines.push({ kind:'engraving', came: came ? came.key : null,
                     label: S.qty+' × '+g.label.toLowerCase()+' engraving'+(came ? ' — '+came.label.toLowerCase() : ''),
                     qty:S.qty, unit_cad:g.first, line_cad:cad });
      S.ekind = null; S.ecame = null; S.qty = 1; paintBuilder(); return;
    }
    const manLbl = document.getElementById('scx-man-label');
    if(mode === 'manual' || (SVQ_MANUAL_TOO[scxType()] && manLbl && manLbl.value.trim())){
      const prEl = document.getElementById('scx-man-price');
      const lbl = ((manLbl && manLbl.value) || '').trim();
      const pr  = Number((prEl && prEl.value) || '');
      if(!lbl){ alert('Say what it is first.'); return; }
      if(!Number.isFinite(pr) || pr < 0){ alert('Type the quoted price — a number.'); return; }
      S.lines.push({ kind:'manual', label: S.qty+' × '+lbl, qty:S.qty, unit_cad:pr, line_cad:pr*S.qty });
      if(manLbl) manLbl.value = ''; if(prEl) prEl.value = '';
      S.qty = 1; paintBuilder(); return;
    }
    const cat = scxCat();
    if(!cat[S.kind]) S.kind = Object.keys(cat)[0];
    const k = cat[S.kind];
    if(k.variants && !S.variant){ alert('Pick a '+k.variantLabel.toLowerCase()+' first.'); return; }
    if(k.sizes && !S.size){ alert('Pick a size first.'); return; }
    const picked = k.variants ? k.variants.find(v => v.key === S.variant) : null;
    if(picked && picked.addons){
      S.lines.push({ kind:S.kind, label:S.qty+' × '+picked.label, qty:S.qty,
                     unit_cad:picked.cad, line_cad:picked.cad*S.qty });
      picked.addons.forEach(g => {
        const G = SVQ_MODLISTS[g]; if(!G) return;
        const allowed = mods(picked, g);
        (S.addons[g] || []).forEach(mk => {
          const m = allowed.find(x => x.key === mk); if(!m) return;
          S.lines.push({ kind:'addon', label:S.qty+' × '+G.label+': '+m.label,
                         qty:S.qty, unit_cad:m.cad, line_cad:m.cad*S.qty });
        });
      });
      S.addons = {}; S.variant = null; S.qty = 1;
      paintBuilder(); return;
    }
    const unit = unitPrice(S.kind, S.variant, S.size);
    const vlbl = k.variants ? (k.variants.find(v=>v.key===S.variant)||{}).label+' ' : '';
    const sObj = (k.sizes||[]).concat(k.extraSizes||[]).find(x => x.key === S.size);
    const slbl = sObj ? sObj.label+' ' : '';
    const label = S.qty + ' × ' + vlbl + slbl + k.label.toLowerCase();
    S.lines.push({ kind:S.kind, label:label, qty:S.qty, unit_cad:unit, line_cad:unit*S.qty });
    S.size = null; S.qty = 1;
    paintBuilder();
  }

  async function saveNew(){
    const g = i => { const el = document.getElementById(i); return ((el && el.value) || '').trim(); };
    const name = g('scx-name');
    if(!name){ alert('Customer name is needed.'); return; }
    if(!S.lines.length){ alert(scxMode() === 'engraving'
      ? 'Add at least one line — pick what kind of engraving, how many pieces, then + Add to this job.'
      : 'Add at least one line — pick what came in, a size, how many, then + Add to this job.'); return; }
    const btn = document.getElementById('scx-save');
    if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
    const unlock = () => { if(btn){ btn.disabled = false; btn.textContent = 'Add it'; } };

    const lines = S.lines.slice();
    SVQ_ALL_EXTRAS.forEach(x => { if(S.extras[x.key]) lines.push(
      { kind:'extra', label:S.extras[x.key]+' × '+x.label, qty:S.extras[x.key], unit_cad:x.cad, line_cad:x.cad*S.extras[x.key] }); });

    const summary = S.lines.map(l=>l.label).join(' · ');
    const work = S.cWork || 'job';
    let scheduled_at = null, dur = null;
    if(work !== 'job'){
      const sd = g('scx-sdate'), stm = g('scx-stime'), sdr = g('scx-sdur');
      if(sd && stm) scheduled_at = new Date(sd+'T'+stm).toISOString();
      else if(sd && !stm){ unlock(); alert('A booked slot needs a time too — or clear the date to leave it a request.'); return; }
      if(sdr && Number.isFinite(Number(sdr))) dur = Number(sdr);
    }
    const dueDate = work === 'job' ? (g('scx-date') || null) : null;
    const committedNow = work === 'job' ? !!dueDate : !!scheduled_at;

    const rec = {
      category: scxType(),                          // honest category, no regex collapse
      service: summary || SVQ_TYPES[scxType()],
      blade_detail: summary,
      work_type: work,
      quantity: S.lines.reduce((a,l)=>a+l.qty,0),
      customer_name: name,
      customer_phone: g('scx-phone') || null,
      customer_email: g('scx-email') || null,
      preferred_date: dueDate,
      scheduled_at: scheduled_at,
      duration_minutes: dur,
      /* every uncommitted intake gets a chase date — the ServiceM8 lesson;
         a request with no chase date becomes furniture */
      next_action_date: committedNow ? null : plusDays(7),
      item_location: S.loc || (work === 'job' ? 'Shop' : null),
      /* 'with customer' means NOTHING was left with us — no drop-off stamp */
      notes: g('scx-notes') || null,
      rush: SVQ_ALL_EXTRAS.some(x => x.flag && S.extras[x.key]),
      line_items: lines,
      total_cad: total(),
      intake_by: 'counter',
      source: 'shop-intake',
      /* a counter JOB is physically here — that is what dropped_off_at means.
         A session, a request, or property still with the customer: nothing
         was dropped off. */
      dropped_off_at: (work === 'job' && S.loc !== 'with customer') ? new Date().toISOString() : null
    };
    try {
      const { error } = await window.supa.from('az_service_bookings').insert(rec);
      if(error){
        unlock();
        const m = error.message || String(error);
        alert(m.indexOf('TIME_TAKEN') !== -1
          ? 'That time is already firmly booked — pick another slot.'
          : 'Could not add it: ' + m);
        return;
      }
    } catch(e){ unlock(); alert('Could not add it: '+(e && e.message || e)); return; }
    unlock();
    Object.assign(S, { lines:[], extras:{}, size:null, qty:1, ekind:null, ecame:null, loc:null, formOpen:false, cWork:'job' });
    load();
  }

  /* customer picker — one fetch per session, debounced (the dictation freeze) */
  function loadCustomers(){
    if(S.customers) return Promise.resolve(S.customers);
    if(S.custFetch) return S.custFetch;
    S.custFetch = window.supa.from('az_customer_directory')
      .select('name,phone,email,jobs').limit(2000)
      .then(r => {
        S.custFetch = null;
        if(r.error){ console.warn('[scheduling] customer directory failed', r.error); return { err:r.error }; }
        S.customers = r.data || [];
        return S.customers;
      })
      .catch(e => { S.custFetch = null; return { err:e }; });
    return S.custFetch;
  }
  let custTimer = null;
  function searchCustomers(q){
    clearTimeout(custTimer);
    custTimer = setTimeout(() => paintCustomers(q), 220);
  }
  async function paintCustomers(q){
    const box = document.getElementById('scx-cust-hits'); if(!box) return;
    const term = (q||'').trim().toLowerCase();
    let all;
    try { all = await loadCustomers(); } catch(e){ all = { err:e }; }
    if(all && all.err){
      box.hidden = false;
      box.innerHTML = '<div class="scx-hit">Could not load past customers — just type the name, it still saves.</div>';
      return;
    }
    const list = Array.isArray(all) ? all : [];
    const hits = (term.length < 1 ? list.slice(0,10)
                                  : list.filter(c => (c.name||'').toLowerCase().includes(term)).slice(0,12));
    box.hidden = false;
    box.innerHTML = (hits.length
      ? (term.length < 1 ? '<div class="scx-hit" style="cursor:default;color:var(--text-dim,#999)">Recent customers — tap one, or keep typing</div>' : '')
        + hits.map((c,i) => '<div class="scx-hit" data-scxcust="'+i+'">'+esc(c.name)
          + '<small>'+esc(c.phone||'no phone')+' · '+esc(c.email||'no email')+' · '+c.jobs+' job'+(c.jobs===1?'':'s')+'</small></div>').join('')
      : '<div class="scx-hit">No match — that is fine, a new name is saved as you typed it.</div>');
    box._hits = hits;
  }

  /* ══════════════ ONE DELEGATED CLICK HANDLER ══════════════ */
  function onClick(e){
    if(!e.target || !e.target.closest) return;
    const T = sel => e.target.closest(sel);
    let el;
    if(el = T('[data-scxtab]')){ S.tab = el.dataset.scxtab; S.formOpen = false; S.editing = null; paint(); return; }
    if(T('#scx-reload')){ load(); return; }
    if(T('#scx-new')){ S.formOpen = !S.formOpen; S.editing = null; paint(); return; }
    if(T('#scx-form-cancel')){ S.formOpen = false; paint(); return; }
    if(el = T('[data-scxsms]')){ smsAct(el.dataset.scxsms, el.dataset.scxsmsid || null, el.dataset.scxrow); return; }
    if(el = T('[data-scxact]')){ S.smsMsg = null; act(el.dataset.scxrow, el.dataset.scxact); return; }
    if(el = T('[data-scxloc]')){ write(el.dataset.scxrow, { item_location: el.dataset.scxloc }); return; }
    if(el = T('[data-scxedit]')){ S.editing = el.dataset.scxedit; S.sel = el.dataset.scxedit; paintDetail(); return; }
    if(T('#scx-ed-save')){ saveEdit(T('#scx-ed-save').dataset.scxrow); return; }
    if(T('#scx-ed-cancel')){ S.editing = null; paintDetail(); return; }
    if(el = T('[data-scxedwt]')){
      const det = document.getElementById('scx-detail');
      if(det){ det.dataset.scxWt = el.dataset.scxedwt;
        det.querySelectorAll('[data-scxedwt]').forEach(x => x.classList.toggle('on', x.dataset.scxedwt === el.dataset.scxedwt)); }
      return;
    }
    if(el = T('[data-scxcw]')){ S.cWork = el.dataset.scxcw; paintBuilder(); return; }
    if(el = T('[data-scxpaid]')){
      const a = S.attendees.find(x => x.id === el.dataset.scxpaid);
      if(a && window.supa && !S.busy){
        S.busy = true;
        window.supa.from('az_event_attendees').update({ paid: !a.paid }).eq('id', a.id)
          .then(r => { S.busy = false; if(r.error) alert('Could not save that: '+r.error.message); load(); });
      }
      return;
    }
    if(el = T('[data-scxdelatt]')){
      if(window.supa && !S.busy && confirm('Take them off the roster?')){
        S.busy = true;
        window.supa.from('az_event_attendees').delete().eq('id', el.dataset.scxdelatt)
          .then(r => { S.busy = false; if(r.error) alert('Could not: '+r.error.message); load(); });
      }
      return;
    }
    if(el = T('[data-scxaddatt]')){
      const nm = (document.getElementById('scx-att-name')||{value:''}).value.trim();
      const ct = (document.getElementById('scx-att-contact')||{value:''}).value.trim();
      if(!nm){ alert('A name is needed.'); return; }
      if(window.supa && !S.busy){
        S.busy = true;
        window.supa.from('az_event_attendees').insert({ booking_id: el.dataset.scxaddatt, name: nm, contact: ct || null })
          .then(r => { S.busy = false; if(r.error) alert('Could not add them: '+r.error.message); load(); });
      }
      return;
    }
    if(el = T('[data-scxid]')){
      /* selecting stays IN PLACE — the product column is always beside you now */
      S.editing = null; S.formOpen = false; S.smsMsg = null; S.sel = el.dataset.scxid; paint(); return; }
    if(T('#scx-save')){ saveNew(); return; }
    if(T('#scx-add-line')){ addLine(); return; }
    if(el = T('[data-scxc]')){
      const v = el.dataset.scxc, k = v.slice(0, v.indexOf(':')), val = v.slice(v.indexOf(':')+1);
      if(k==='kind'){ S.kind = val; S.variant = null; S.size = null; S.addons = {}; }
      else if(k==='ekind'){ S.ekind = (S.ekind===val ? null : val); }
      else if(k==='ecame'){ S.ecame = (S.ecame===val ? null : val); }
      else if(k==='var'){ S.variant = (S.variant===val ? null : val); S.addons = {}; }
      else if(k==='ad'){
        const gi = val.indexOf(':'), gr = val.slice(0, gi), mk = val.slice(gi+1);
        const G = SVQ_MODLISTS[gr];
        if(G){
          const cur = (S.addons[gr] || []).slice();
          if(G.single){ S.addons[gr] = (cur[0] === mk) ? [] : [mk]; }
          else { const i = cur.indexOf(mk); if(i === -1) cur.push(mk); else cur.splice(i,1); S.addons[gr] = cur; }
          const cat0 = scxCat()[S.kind];
          pruneAddons(cat0 && cat0.variants ? cat0.variants.find(x => x.key === S.variant) : null);
        }
      }
      else if(k==='size'){ S.size = (S.size===val ? null : val); }
      else if(k==='qty'){ S.qty = Number(val); }
      else if(k==='loc'){ S.loc = (S.loc===val ? null : val); }
      else if(k==='ex'){
        S.extras[val] = (S.extras[val]||0) + 1;
        if(e.shiftKey || S.extras[val] > 9) delete S.extras[val];
      }
      paintBuilder(); return;
    }
    if(el = T('[data-scxdel]')){ S.lines.splice(Number(el.dataset.scxdel),1); paintBuilder(); return; }
    if(el = T('[data-scxcust]')){
      const box = document.getElementById('scx-cust-hits');
      const c = (box._hits||[])[Number(el.dataset.scxcust)];
      if(c){
        document.getElementById('scx-name').value  = c.name || '';
        document.getElementById('scx-phone').value = c.phone || '';
        document.getElementById('scx-email').value = c.email || '';
      }
      clearTimeout(custTimer);
      box.hidden = true; return;
    }
    if(!T('#scx-name') && !T('#scx-cust-hits')){
      const b = document.getElementById('scx-cust-hits'); if(b) b.hidden = true;
    }
  }

  /* chase7 — one tap on the Board: chased them today, ask me again in a week */
  const realAct = act;
  act = function(id, what){
    if(what === 'chase7') return write(id, { next_action_date: plusDays(7) });
    return realAct(id, what);
  };

  /* type dropdown re-derives the builder (delegated 'change') */
  document.addEventListener('change', function(e){
    if(e.target && e.target.id === 'scx-type') typeChanged();
  });

  /* ══════════════ PUBLIC API + LEGACY ALIASES ══════════════ */
  window.CCScheduling = {
    mount: mount,
    refresh: load,
    setTab: function(t){ S.tab = t; paint(); },
    openForm: function(){ S.formOpen = true; paint(); }
  };
  // every face's existing lane-enter hook keeps working:
  window.renderQueue = function(){ if(S.host) load(); };
  window.renderServices = window.renderServices || function(){};   // legacy no-op

  // auto-mount if the host div is already on the page
  function boot(){
    const host = document.getElementById('cc-scheduling-host');
    if(host && !S.host) mount(host, { defaultTab: host.dataset.defaultTab || 'board' });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // the login gates on both faces dispatch 'cc-boot' after sign-in — reload then
  document.addEventListener('cc-boot', function(){ if(S.host) load(); });
})();
