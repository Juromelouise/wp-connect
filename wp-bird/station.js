/* =============================================================================
   WP/Connect x DigiCon 2026 - shared station client.

   Both arcade stations (WPCONNECT/flip-match, WPCONNECT/wp-bird) talk to
   CCE Play through this one file. It is COPIED, not shared: each station is
   its own deployment, so the two copies must stay byte-identical - diff them
   before shipping.

   The flow is the INVERSE of the LOCK & LOADOUT kiosk (codm blast):

     attract screen -> WPStation.begin()       POST /v2/wpconnect/arcade/sessions
                       shows claimUrl as a QR
     player scans it on their phone from /playlab/wpconnect
     station polls  -> phase "claimed"         GET  .../sessions/:token
                       -> the game shows player.username, START unlocks
     game starts    -> WPStation.started()     (cancels the claimed-idle timer)
     game over      -> WPStation.finish(stats) POST .../sessions/:token/result
                       which writes the leaderboard row AND ticks the quest
     staff skip/idle-> WPStation.abandon()     POST .../sessions/:token/void

   Self-healing, because nobody is watching the TV:
     - an unscanned QR rotates after ?idle (default 300 s)
     - a scanned-but-never-started claim is released after ?claimIdle (120 s)
     - a failed mint retries with backoff (5 s -> 30 s) until it works
     - a failed result post retries 3x; a 409 means the server already has it
     - a 401 (rotated key) reopens the staff overlay instead of playing dark

   Mirrors CCE-Play-Server src/modules/v2/wpconnect/wpconnect.constants.ts and
   CCE-Play app/playlab/wpconnect/_lib/arcade-quest.ts - keep the three in sync
   by hand, there is no shared package.

   Integration is four lines in a game:
     <script src="station.js"></script>
     WPStation.configure({ game: 'flip-match', gameLabel: 'FLIP MATCH' });
     WPStation.on(function (s) { ...render s.phase... });
     WPStation.started();   // when the round actually begins

   URL switches: ?api=<base>  ?station=<label>  ?idle=<s>  ?claimIdle=<s>  ?debug
   The station key is typed once by staff on the boot overlay and kept in
   localStorage - never in the URL, never in this repo.
   ============================================================================= */
(function () {
  'use strict';

  var QS = new URLSearchParams(location.search);
  var DEBUG = QS.has('debug');

  /* Mirrors the server's wpconnect.constants.ts. */
  var DEFAULT_API = 'https://cceplay-backend.onrender.com/api';
  var KEY_HEADER = 'x-kiosk-key';
  var POLL_MS = 2000;
  var RESULT_ATTEMPTS = 3;
  var RESULT_RETRY_MS = 3000;
  var CLOSED_RETRY_MS = 60000;   // outside the opening window: ask again each minute
  var LS_KEY = 'wpstation.key';
  var LS_STATION = 'wpstation.station';

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var CFG = {
    game: '',
    gameLabel: '',
    api: (QS.get('api') || DEFAULT_API).replace(/\/+$/, ''),
    key: lsGet(LS_KEY),
    // No made-up default: an empty label makes every screen say "this
    // station" instead of a bogus "Station A" on both machines.
    station: QS.get('station') || lsGet(LS_STATION) || '',
    idleMs: Math.max(30, (+QS.get('idle') || 300)) * 1000,
    claimIdleMs: Math.max(30, (+QS.get('claimIdle') || 120)) * 1000
  };

  /* ---------------------------------------------------------------------------
     State machine. One session at a time.

       setup      no station key yet - the boot overlay is up
       idle       nothing minted
       minting    first mint in flight (retries stay in 'error' until they win)
       pending    QR on screen, nobody has scanned it
       claimed    a player is bound; state.player is their nickname + avatar
       submitting result post in flight (retrying inside)
       done       result accepted
       error      last call failed; state.error says why. A mint failure keeps
                  retrying on its own; the game may still let people play.
     ------------------------------------------------------------------------- */
  var state = {
    phase: 'idle',
    token: '',
    claimUrl: '',
    player: null,
    station: CFG.station,
    gameLabel: '',
    error: ''
  };
  var listeners = [];
  var pollTimer = 0;
  var idleTimer = 0;
  var claimTimer = 0;
  var retryTimer = 0;
  /* Bumped by every begin()/abandon(); a late reply from an older generation
     must never touch the current session. */
  var beginGen = 0;

  function snapshot() {
    return {
      phase: state.phase, token: state.token, claimUrl: state.claimUrl,
      player: state.player, station: state.station,
      gameLabel: state.gameLabel || CFG.gameLabel, error: state.error
    };
  }
  function emit() {
    var s = snapshot();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](s); } catch (e) { console.warn('[wp-station] listener threw:', e); }
    }
  }
  function setPhase(phase, extra) {
    state.phase = phase;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) state[k] = extra[k];
    if (DEBUG) console.log('[wp-station]', phase, state.token || '', state.error || '');
    emit();
  }

  /* A server message is worth showing; a raw fetch/abort error is not. */
  function friendly(e, fallback) {
    return (e && e.status) ? (e.message || ('HTTP ' + e.status)) : fallback;
  }

  /* --------------------------------------------------------------------- HTTP */
  function req(path, opts, timeoutMs, withKey) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (withKey !== false && CFG.key) headers[KEY_HEADER] = CFG.key;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000) : 0;
    return fetch(CFG.api + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store'
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          var msg = body && body.message;
          if (Array.isArray(msg)) msg = msg[0];
          var err = new Error(msg || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return body && body.data;
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  /* ----------------------------------------------------------------- timers */
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } }
  function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0; } }
  function clearClaimIdle() { if (claimTimer) { clearTimeout(claimTimer); claimTimer = 0; } }
  function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; } }

  /* Unscanned QR: rotate it, so the attract screen never parks without a code. */
  function armIdle() {
    clearIdle();
    idleTimer = setTimeout(function () { api.abandon(); api.begin(); }, CFG.idleMs);
  }
  /* Scanned but never started: release the machine to the next player. The
     game calls started() when the round begins, which cancels this. */
  function armClaimIdle() {
    clearClaimIdle();
    claimTimer = setTimeout(function () { api.abandon(); api.begin(); }, CFG.claimIdleMs);
  }
  function scheduleMintRetry(gen, n, fixedMs) {
    clearRetry();
    var delay = fixedMs || Math.min(30000, 5000 * Math.pow(2, n));
    retryTimer = setTimeout(function () {
      var parked = state.phase === 'error' || state.phase === 'closed';
      if (beginGen === gen && parked && !state.token) api.begin(n + 1);
    }, delay);
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      var t = state.token;
      if (!t) { stopPolling(); return; }
      req('/v2/wpconnect/arcade/sessions/' + t, {}, 6000, false)
        .then(function (d) {
          // Token fence: begin() can re-mint while this reply is in flight,
          // and a stale "claimed" must not bind the OLD player to the NEW code.
          if (!d || state.token !== t) return;
          state.gameLabel = d.gameLabel || state.gameLabel;
          if (d.status === 'claimed' && state.phase === 'pending') {
            stopPolling();
            clearIdle();
            setPhase('claimed', { player: d.player, station: d.station || state.station });
            armClaimIdle();
          } else if (d.status === 'void' || d.status === 'expired') {
            // Retired from elsewhere (or aged out): put a fresh code up.
            stopPolling();
            clearIdle();
            api.begin();
          }
        })
        .catch(function () { /* transient - the next tick retries */ });
    }, POLL_MS);
  }

  function voidToken(t) {
    req('/v2/wpconnect/arcade/sessions/' + t + '/void', { method: 'POST', body: '{}' }, 6000)
      .catch(function () { /* best effort - it expires on its own anyway */ });
  }

  /* ---------------------------------------------------------------- public API */
  var api = {
    configure: function (opts) {
      opts = opts || {};
      if (opts.game) CFG.game = opts.game;
      if (opts.gameLabel) { CFG.gameLabel = opts.gameLabel; state.gameLabel = opts.gameLabel; }
      if (opts.api) CFG.api = String(opts.api).replace(/\/+$/, '');
      if (!CFG.key) { setPhase('setup'); mountSetup(); } else { emit(); }
      return api;
    },

    /** Staff have entered a key, so the station can mint. */
    ready: function () { return !!CFG.key; },

    config: function () {
      return { api: CFG.api, station: CFG.station, game: CFG.game, hasKey: !!CFG.key };
    },

    /** Reopen the boot overlay (bind this to a staff-only key if you like). */
    openSetup: function () { mountSetup(true); },

    on: function (cb) { if (typeof cb === 'function') { listeners.push(cb); cb(snapshot()); } return api; },

    state: snapshot,

    /**
     * Put a fresh QR on the attract screen. Any session still on screen is
     * voided first (unless its result is mid-flight), so a photo of the old
     * code can never be claimed later. `n` is the retry index - internal.
     */
    begin: function (n) {
      n = n || 0;
      if (!CFG.key) { setPhase('setup'); mountSetup(); return Promise.resolve(null); }
      var gen = ++beginGen;
      clearRetry(); clearClaimIdle();
      if (state.token && state.phase !== 'submitting') voidToken(state.token);
      stopPolling(); clearIdle();
      if (n === 0) {
        setPhase('minting', { token: '', claimUrl: '', player: null, error: '' });
      } else {
        // A retry keeps the visible 'error' state so START does not flicker
        // on and off while the backend is down.
        state.token = ''; state.claimUrl = ''; state.player = null;
      }
      return req('/v2/wpconnect/arcade/sessions', {
        method: 'POST',
        body: JSON.stringify({ game: CFG.game, station: CFG.station })
      }, 10000).then(function (d) {
        if (gen !== beginGen) { if (d && d.token) voidToken(d.token); return null; }
        if (!d || !d.token || !d.claimUrl) throw new Error('bad mint response');
        setPhase('pending', { token: d.token, claimUrl: d.claimUrl, error: '' });
        if (DEBUG) console.log('[wp-station] claimUrl:', d.claimUrl);
        startPolling();
        armIdle();
        return d;
      }).catch(function (e) {
        if (gen !== beginGen) return null;
        if (e && e.status === 401) {
          // The key was rotated under us: back to the staff overlay, never a
          // dark station that quietly plays unscored.
          CFG.key = ''; lsDel(LS_KEY);
          setPhase('setup', { error: '' });
          mountSetup(true);
          return null;
        }
        if (e && e.status === 423) {
          // Outside the admin-set opening window. Park with the server's copy
          // (it carries the opening time) and re-ask every minute, so the
          // screen opens itself on time with no staff action.
          setPhase('closed', { error: e.message || 'The arcade is closed right now.' });
          scheduleMintRetry(gen, n, CLOSED_RETRY_MS);
          return null;
        }
        setPhase('error', { error: friendly(e, "Can't reach CCE Play - retrying\u2026") });
        scheduleMintRetry(gen, n);
        return null;
      });
    },

    /**
     * Staff skip / idle timeout: retire the code (or the abandoned claim) and
     * go back to attract, so an abandoned QR in someone's camera roll is
     * worthless and a walked-off player stops holding the machine.
     */
    abandon: function () {
      var t = state.token, ph = state.phase;
      ++beginGen;
      clearRetry(); stopPolling(); clearIdle(); clearClaimIdle();
      setPhase('idle', { token: '', claimUrl: '', player: null, error: '' });
      if (t && ph !== 'submitting') voidToken(t);
    },

    /** The round actually began: the claimed-idle reservation no longer applies. */
    started: function () { clearClaimIdle(); },

    /**
     * The run is over. stats is whatever this game measures - Flip Match sends
     * { moves, timeMs, pairs, won }, WP Flappy Challenge { score, timeMs, won }. The server
     * rejects a run missing the stat its board ranks on. Retries transient
     * failures; a 409 means an earlier attempt landed and its reply was lost.
     */
    finish: function (stats) {
      var t = state.token;
      if (!t || state.phase !== 'claimed') return Promise.resolve(null);
      clearIdle(); clearClaimIdle();
      setPhase('submitting');
      var body = JSON.stringify({ stats: stats || {} });
      var attempt = 0;
      function settle(d) {
        // Token fence: the game may already have moved on and minted a new
        // code (WP Flappy Challenge returns to its menu ~8 s after game over).
        if (state.token === t) setPhase('done', { token: '', error: '' });
        return d;
      }
      function post() {
        return req('/v2/wpconnect/arcade/sessions/' + t + '/result',
          { method: 'POST', body: body }, 8000)
          .then(settle)
          .catch(function (e) {
            if (e && e.status === 409) return settle(null);
            var transient = !e || !e.status || e.status >= 500;
            if (transient && ++attempt < RESULT_ATTEMPTS) {
              return new Promise(function (r) { setTimeout(r, RESULT_RETRY_MS); }).then(post);
            }
            if (state.token === t) {
              setPhase('error', { error: friendly(e, "Couldn't save the run - CCE Play is unreachable.") });
            }
            return null;
          });
      }
      return post();
    },

    /** Push the unscanned-idle deadline back (call on attract-screen activity). */
    resetIdle: function () { if (state.phase === 'pending') armIdle(); },

    qrCanvas: function (text, targetPx) { return qrCanvas(text, targetPx); }
  };

  /* ------------------------------------------------------------ boot overlay */
  /* Staff type the shared key once per machine. Kept out of the URL and out of
     this repo; localStorage is the only place it lives. */
  function mountSetup(force) {
    if (!force && CFG.key) return;
    if (document.getElementById('wpStationSetup')) return;
    var wrap = document.createElement('div');
    wrap.id = 'wpStationSetup';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Station setup');
    wrap.innerHTML =
      '<style>' +
      '#wpStationSetup{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(10,3,6,.94);font-family:Montserrat,system-ui,Arial,sans-serif;padding:24px}' +
      '#wpStationSetup .box{width:min(440px,92vw);background:#15070b;border:1px solid rgba(255,255,255,.18);' +
      'border-radius:14px;padding:22px;color:#fff;box-shadow:0 20px 60px rgba(0,0,0,.6)}' +
      '#wpStationSetup h2{margin:0 0 4px;font-size:20px;font-weight:900;font-style:italic;text-transform:uppercase;letter-spacing:.5px}' +
      '#wpStationSetup p{margin:0 0 16px;font-size:13px;line-height:1.45;color:rgba(255,255,255,.7)}' +
      '#wpStationSetup label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;' +
      'letter-spacing:1.4px;color:rgba(255,255,255,.6);margin:12px 0 6px}' +
      '#wpStationSetup input{width:100%;box-sizing:border-box;padding:12px 14px;font-size:16px;border-radius:9px;' +
      'border:1px solid rgba(255,255,255,.25);background:#0c0407;color:#fff}' +
      '#wpStationSetup input:focus{outline:2px solid #e30613;outline-offset:1px}' +
      '#wpStationSetup button{margin-top:18px;width:100%;padding:13px;font-size:15px;font-weight:800;' +
      'text-transform:uppercase;letter-spacing:1px;border:0;border-radius:9px;background:#e30613;color:#fff;cursor:pointer}' +
      '#wpStationSetup button:hover{background:#ff2333}' +
      '#wpStationSetup .err{color:#ff9a9a;font-size:12px;margin-top:10px;min-height:16px}' +
      '</style>' +
      '<div class="box">' +
      '<h2>Station setup</h2>' +
      '<p>Staff only. Enter the CCE Play station key for this machine - it stays on this device.</p>' +
      '<label for="wpsKey">Station key</label>' +
      '<input id="wpsKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste the key">' +
      '<label for="wpsStation">Station label</label>' +
      '<input id="wpsStation" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. FLIP (optional)">' +
      '<button id="wpsSave" type="button">Start station</button>' +
      '<div class="err" id="wpsErr"></div>' +
      '</div>';
    document.body.appendChild(wrap);

    var keyIn = wrap.querySelector('#wpsKey');
    var stIn = wrap.querySelector('#wpsStation');
    var err = wrap.querySelector('#wpsErr');
    keyIn.value = CFG.key || '';
    stIn.value = CFG.station || '';
    setTimeout(function () { keyIn.focus(); }, 50);

    var saving = false;
    function save() {
      if (saving) return;   // Enter auto-repeat must not mint a probe per keystroke
      var k = (keyIn.value || '').trim();
      var s = (stIn.value || '').trim();
      if (!k) { err.textContent = 'Enter the station key.'; return; }
      saving = true;
      err.textContent = 'Checking...';
      CFG.key = k; CFG.station = s;
      // Prove the key before storing it, so a typo fails here rather than at
      // the first player's scan.
      req('/v2/wpconnect/arcade/sessions', {
        method: 'POST',
        body: JSON.stringify({ game: CFG.game, station: s })
      }, 12000).then(function (d) {
        saving = false;
        if (d && d.token) voidToken(d.token);
        lsSet(LS_KEY, k); lsSet(LS_STATION, s);
        state.station = s;
        wrap.remove();
        setPhase('idle', { error: '' });
        // The game already ran its attract-screen begin() while the overlay was
        // up (and it bailed for want of a key), so mint the first QR here.
        api.begin();
      }).catch(function (e) {
        saving = false;
        CFG.key = lsGet(LS_KEY);
        err.textContent = (e && e.status === 401) ? 'That key was rejected.'
          : friendly(e, 'Could not reach CCE Play - check the wifi and try again.');
      });
    }
    wrap.querySelector('#wpsSave').addEventListener('click', save);
    wrap.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.repeat) save(); });
  }

  window.WPStation = api;


  /* ===================== QR CODE — byte mode, EC level Q =====================
     Self-contained so the kiosk never needs a network round-trip or a third
     party library to put a code on the results screen. Versions 1-10, which
     covers anything from a short token to a ~150 character URL.
     Level Q (25% recovery) is deliberate: results screens get scanned at an
     angle, through glare, off a big panel. */
  const QR = (function(){
    /* ---- GF(256) tables, primitive polynomial 0x11D ---- */
    const EXP=new Array(512), LOG=new Array(256);
    (function(){
      let x=1;
      for(let i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100) x^=0x11D; }
      for(let i=255;i<512;i++) EXP[i]=EXP[i-255];
    })();
    const mul=(a,b)=> (a===0||b===0)? 0 : EXP[LOG[a]+LOG[b]];

    /* per version: [total codewords, EC codewords per block, [[blocks, data per block], ...]] */
    const SPEC=[ null,
      [26,  13, [[1,13]]],
      [44,  22, [[1,22]]],
      [70,  18, [[2,17]]],
      [100, 26, [[2,24]]],
      [134, 18, [[2,15],[2,16]]],
      [172, 24, [[4,19]]],
      [196, 18, [[2,14],[4,15]]],
      [242, 22, [[4,18],[2,19]]],
      [292, 20, [[4,16],[4,17]]],
      [346, 24, [[6,19],[2,20]]]
    ];
    const ALIGN=[null,[],[6,18],[6,22],[6,26],[6,30],[6,34],
                 [6,22,38],[6,24,42],[6,26,46],[6,28,50]];
    const EC_Q=3;   /* level Q format bits */

    function rsGen(n){
      let g=[1];
      for(let i=0;i<n;i++){
        const ng=new Array(g.length+1).fill(0);
        /* multiply by (x + a^i), coefficients descending so ng[0] stays the
           leading 1 that rsEncode() indexes past */
        for(let j=0;j<g.length;j++){
          ng[j]^=g[j];
          ng[j+1]^=mul(g[j],EXP[i]);
        }
        g=ng;
      }
      return g;
    }
    function rsEncode(data,n){
      const g=rsGen(n), rem=new Array(n).fill(0);
      for(const b of data){
        const factor=b^rem[0];
        rem.shift(); rem.push(0);
        for(let i=0;i<n;i++) rem[i]^=mul(g[i+1],factor);
      }
      return rem;
    }
    function formatBits(mask){
      const data=(EC_Q<<3)|mask;
      let rem=data;
      for(let i=0;i<10;i++) rem=(rem<<1)^((rem>>>9)*0x537);
      return (((data<<10)|rem)^0x5412)&0x7FFF;
    }
    function versionBits(v){
      let rem=v;
      for(let i=0;i<12;i++) rem=(rem<<1)^((rem>>>11)*0x1F25);
      return ((v<<12)|rem)&0x3FFFF;
    }
    function utf8(str){
      const out=[];
      for(const ch of str){
        let c=ch.codePointAt(0);
        if(c<0x80) out.push(c);
        else if(c<0x800){ out.push(0xC0|(c>>6), 0x80|(c&63)); }
        else if(c<0x10000){ out.push(0xE0|(c>>12), 0x80|((c>>6)&63), 0x80|(c&63)); }
        else { out.push(0xF0|(c>>18), 0x80|((c>>12)&63), 0x80|((c>>6)&63), 0x80|(c&63)); }
      }
      return out;
    }

    /* ---- data stream: mode + length + payload, padded to the version ---- */
    function buildCodewords(bytes,ver){
      const spec=SPEC[ver];
      let dataCw=0;
      for(const [n,d] of spec[2]) dataCw+=n*d;
      const bits=[];
      const push=(val,len)=>{ for(let i=len-1;i>=0;i--) bits.push((val>>i)&1); };
      push(4,4);                              /* byte mode */
      push(bytes.length, ver<10? 8:16);
      for(const b of bytes) push(b,8);
      const cap=dataCw*8;
      for(let i=0;i<4 && bits.length<cap;i++) bits.push(0);   /* terminator */
      while(bits.length%8) bits.push(0);
      const cw=[];
      for(let i=0;i<bits.length;i+=8){
        let v=0; for(let j=0;j<8;j++) v=(v<<1)|bits[i+j];
        cw.push(v);
      }
      const PAD=[0xEC,0x11];
      for(let i=0; cw.length<dataCw; i++) cw.push(PAD[i%2]);
      /* split into blocks, add EC, then interleave both halves */
      const blocks=[], ecs=[];
      let p=0;
      for(const [n,d] of spec[2]){
        for(let i=0;i<n;i++){
          const blk=cw.slice(p,p+d); p+=d;
          blocks.push(blk); ecs.push(rsEncode(blk,spec[1]));
        }
      }
      const out=[];
      const maxD=Math.max(...blocks.map(b=>b.length));
      for(let i=0;i<maxD;i++) for(const b of blocks) if(i<b.length) out.push(b[i]);
      for(let i=0;i<spec[1];i++) for(const e of ecs) out.push(e[i]);
      return out;
    }

    /* ---- module matrix ---- */
    function build(ver,codewords){
      const size=17+4*ver;
      const mat=[], res=[];
      for(let i=0;i<size;i++){ mat.push(new Array(size).fill(0)); res.push(new Array(size).fill(false)); }
      const set=(r,c,v)=>{ mat[r][c]=v; res[r][c]=true; };
      const finder=(r0,c0)=>{
        for(let r=-1;r<=7;r++) for(let c=-1;c<=7;c++){
          const rr=r0+r, cc=c0+c;
          if(rr<0||cc<0||rr>=size||cc>=size) continue;
          const inRing = (r>=0&&r<=6&&(c===0||c===6)) || (c>=0&&c<=6&&(r===0||r===6));
          const inCore = r>=2&&r<=4&&c>=2&&c<=4;
          set(rr,cc,(inRing||inCore)?1:0);
        }
      };
      finder(0,0); finder(0,size-7); finder(size-7,0);
      /* alignment patterns, skipped where they would collide with a finder */
      const ac=ALIGN[ver];
      for(const r of ac) for(const c of ac){
        if((r===6&&c===6)||(r===6&&c===size-7)||(r===size-7&&c===6)) continue;
        for(let dr=-2;dr<=2;dr++) for(let dc=-2;dc<=2;dc++){
          const ring=Math.max(Math.abs(dr),Math.abs(dc));
          set(r+dr,c+dc, (ring===1)?0:1);
        }
      }
      for(let i=8;i<size-8;i++){ set(6,i,(i%2===0)?1:0); set(i,6,(i%2===0)?1:0); }
      set(size-8,8,1);                                   /* dark module */
      for(let i=0;i<9;i++){                              /* reserve format areas */
        if(!res[8][i]) res[8][i]=true;
        if(!res[i][8]) res[i][8]=true;
      }
      for(let i=0;i<8;i++){ res[8][size-1-i]=true; res[size-1-i][8]=true; }
      if(ver>=7){
        for(let i=0;i<18;i++){
          const a=Math.floor(i/3), b=i%3;
          res[a][size-11+b]=true; res[size-11+b][a]=true;
        }
      }
      /* zigzag data placement, right to left, skipping the vertical timing column */
      const bits=[];
      for(const cw of codewords) for(let i=7;i>=0;i--) bits.push((cw>>i)&1);
      let dir=-1, row=size-1, col=size-1, k=0;
      while(col>0){
        if(col===6) col--;
        for(;;){
          for(let c=0;c<2;c++){
            const cc=col-c;
            if(!res[row][cc]) mat[row][cc]= k<bits.length? bits[k++] : 0;
          }
          row+=dir;
          if(row<0||row>=size){ row-=dir; dir=-dir; break; }
        }
        col-=2;
      }
      return {size, mat, res};
    }

    const MASK=[
      (r,c)=>(r+c)%2===0,
      (r,c)=>r%2===0,
      (r,c)=>c%3===0,
      (r,c)=>(r+c)%3===0,
      (r,c)=>((r>>1)+Math.floor(c/3))%2===0,
      (r,c)=>((r*c)%2+(r*c)%3)===0,
      (r,c)=>(((r*c)%2+(r*c)%3)%2)===0,
      (r,c)=>(((r+c)%2+(r*c)%3)%2)===0
    ];
    /* the four penalty rules from the spec — lowest total wins */
    function penalty(m,size){
      let p=0;
      const runScore=(run)=> run>=5? 3+(run-5) : 0;
      for(let i=0;i<size;i++){
        let rr=1, cr=1;
        for(let j=1;j<size;j++){
          if(m[i][j]===m[i][j-1]) rr++; else { p+=runScore(rr); rr=1; }
          if(m[j][i]===m[j-1][i]) cr++; else { p+=runScore(cr); cr=1; }
        }
        p+=runScore(rr)+runScore(cr);
      }
      for(let r=0;r<size-1;r++) for(let c=0;c<size-1;c++){
        const v=m[r][c];
        if(v===m[r][c+1] && v===m[r+1][c] && v===m[r+1][c+1]) p+=3;
      }
      const A=[1,0,1,1,1,0,1,0,0,0,0], B=[0,0,0,0,1,0,1,1,1,0,1];
      for(let i=0;i<size;i++){
        for(let j=0;j+11<=size;j++){
          let a=true,b=true;
          for(let k=0;k<11;k++){ if(m[i][j+k]!==A[k]) a=false; if(m[i][j+k]!==B[k]) b=false; }
          if(a||b) p+=40;
          a=true;b=true;
          for(let k=0;k<11;k++){ if(m[j+k][i]!==A[k]) a=false; if(m[j+k][i]!==B[k]) b=false; }
          if(a||b) p+=40;
        }
      }
      let dark=0;
      for(let r=0;r<size;r++) for(let c=0;c<size;c++) dark+=m[r][c];
      const pct=dark*100/(size*size);
      p+=Math.floor(Math.abs(pct-50)/5)*10;
      return p;
    }
    function applyMask(base,mask){
      const {size,mat,res}=base;
      const m=mat.map(r=>r.slice());
      for(let r=0;r<size;r++) for(let c=0;c<size;c++)
        if(!res[r][c] && MASK[mask](r,c)) m[r][c]^=1;
      const fmt=formatBits(mask);
      const bit=i=>(fmt>>(14-i))&1;
      for(let i=0;i<=5;i++) m[8][i]=bit(i);
      m[8][7]=bit(6); m[8][8]=bit(7); m[7][8]=bit(8);
      for(let i=9;i<=14;i++) m[14-i][8]=bit(i);
      for(let i=0;i<=6;i++) m[size-1-i][8]=bit(i);
      for(let i=7;i<=14;i++) m[8][size-15+i]=bit(i);
      m[size-8][8]=1;
      return m;
    }
    /* text -> {size, modules} where modules[r][c] is 1 for a dark module */
    function encode(text){
      const bytes=utf8(text);
      let ver=0;
      for(let v=1;v<=10;v++){
        let dataCw=0;
        for(const [n,d] of SPEC[v][2]) dataCw+=n*d;
        const need=4+(v<10?8:16)+bytes.length*8;
        if(need<=dataCw*8){ ver=v; break; }
      }
      if(!ver) throw new Error('QR payload too long for version 10 at level Q');
      const base=build(ver, buildCodewords(bytes,ver));
      if(ver>=7){
        const vb=versionBits(ver);
        for(let i=0;i<18;i++){
          const b=(vb>>i)&1, a=Math.floor(i/3), c=i%3;
          base.mat[a][base.size-11+c]=b;
          base.mat[base.size-11+c][a]=b;
        }
      }
      let best=null, bestP=Infinity;
      for(let k=0;k<8;k++){
        const m=applyMask(base,k);
        const p=penalty(m,base.size);
        if(p<bestP){ bestP=p; best=m; }
      }
      return { size:base.size, modules:best, version:ver };
    }
    return { encode };
  })();

  /* Renders a payload to an offscreen canvas: white card, black modules, and
     the 4-module quiet zone the spec requires (without it, phones fail to
     lock on against a dark background). One-slot cache: the payload changes
     every run, so a growing map would leak one canvas per game all day. */
  let qrCacheKey='', qrCacheCv=null;
  function qrCanvas(text, targetPx){
    const key=text+'@'+targetPx;
    if(key===qrCacheKey) return qrCacheCv;
    let code;
    try{ code=QR.encode(text); }
    catch(e){ console.warn('[wp-station] QR encode failed:', e.message); qrCacheKey=key; return qrCacheCv=null; }
    const quiet=4, total=code.size+quiet*2;
    const scale=Math.max(1, Math.floor(targetPx/total));
    const px=total*scale;
    const cv=document.createElement('canvas');
    cv.width=px; cv.height=px;
    const g=cv.getContext('2d');
    g.fillStyle='#FFFFFF'; g.fillRect(0,0,px,px);
    g.fillStyle='#000000';
    for(let r=0;r<code.size;r++) for(let c=0;c<code.size;c++)
      if(code.modules[r][c]) g.fillRect((c+quiet)*scale,(r+quiet)*scale,scale,scale);
    qrCacheKey=key; return qrCacheCv=cv;
  }

})();
