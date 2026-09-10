/* =========================================================================
   WP Flappy Challenge - TRIAL station stub (window.WPStation)
   -------------------------------------------------------------------------
   Loaded INSTEAD of station.js when the game is opened as trial.html (which
   is index.html?trial=1). Same API surface the game calls, but:

     - no network: nothing is minted, polled, claimed, posted or voided
     - no station key, no setup overlay, no QR
     - one phase, 'trial': START is unlocked, the HUD says FREE PLAY, and a
       finished run is simply dropped - it never reaches the leaderboard

   Use it to try skins and branding, or to let people play for fun
   without a CCE Play account. The real station is index.html + station.js.
   ========================================================================= */
(function (global) {
  'use strict';

  var CFG = { game: '', gameLabel: 'WP FLAPPY', station: 'TRIAL' };
  var listeners = [];
  var state = { phase: 'idle' };

  function snapshot() {
    return {
      phase: state.phase,
      token: '',
      claimUrl: '',
      player: null,
      station: CFG.station,
      gameLabel: CFG.gameLabel,
      error: '',
      trial: true
    };
  }

  function emit() {
    var s = snapshot();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](s); } catch (e) { console.warn('[wp-station:trial] listener threw:', e); }
    }
  }

  function setPhase(phase) {
    state.phase = phase;
    emit();
  }

  var api = {
    configure: function (cfg) {
      cfg = cfg || {};
      if (cfg.game) CFG.game = String(cfg.game);
      if (cfg.gameLabel) CFG.gameLabel = String(cfg.gameLabel);
    },
    on: function (fn) {
      if (typeof fn === 'function') { listeners.push(fn); fn(snapshot()); }
      return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
    },
    state: snapshot,
    /** Attract screen: no code to mint - straight to free play. */
    begin: function () { setPhase('trial'); return Promise.resolve(null); },
    /** The round began - nothing to reserve. */
    started: function () {},
    /** Run over - dropped on purpose. Nothing is saved in trial. */
    finish: function () { return Promise.resolve(null); },
    /** Staff skip - nothing to retire. */
    abandon: function () { setPhase('trial'); },
    bump: function () {},
    /** No QR in trial. */
    qrCanvas: function () { return null; }
  };

  global.WPStation = api;
})(window);
