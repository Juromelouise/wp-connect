/* =========================================================================
   Flip Match — shared storage module (window.FlipStore)
   -------------------------------------------------------------------------
   Loaded by BOTH index.html (the game) and admin.html (the staff page) so
   they agree on the IndexedDB schema, slot ids, validation and placeholder
   art. Plain script, no build step.

   Persistence is browser-only: everything lives in IndexedDB on the device
   that saved it. Both pages must be served from the SAME ORIGIN (same host
   and port) or they will not see the same database. Use Export / Import in
   the admin to move a card set to another device.
   ========================================================================= */
(function (global) {
  'use strict';

  var DB_NAME = 'flip-match';
  var DB_VERSION = 1;        // structural (object stores)
  var SCHEMA_VERSION = 1;    // shape of the settings record / export file
  var STORE_SETTINGS = 'settings';
  var STORE_IMAGES = 'images';
  var CONFIG_KEY = 'config';
  var UPDATED_KEY = 'flip-match:updatedAt';
  var EXPORT_FORMAT = 'flip-match-config';

  var LIMITS = {
    MIN_IMAGES: 1,                       // brand images (face slots); the board repeats them
    MAX_IMAGES: 12,
    MAX_SIDE: 768,                       // longest side after downscale (px)
    MAX_UPLOAD_BYTES: 15 * 1024 * 1024,  // reject bigger source files
    MAX_IMPORT_IMAGE_BYTES: 6 * 1024 * 1024,
    TITLE_MAX: 40,
    TAGLINE_MAX: 80,
    PREVIEW_MIN: 1,                      // seconds the fronts stay visible at round start
    PREVIEW_MAX: 10
  };

  var DEFAULTS = {
    images: 4,                           // brand images in play
    board: '4x4',                        // columns x rows, see BOARDS
    title: 'FLIP MATCH',
    tagline: 'WP/CONNECT × DIGICON 2026',
    previewSec: 3,
    faceColor: '#0b0b0b'                 // background behind each face image (deck black panel)
  };

  // Deck artwork shipped with the game (WP Gaming DigiCon 2026 deck). Relative
  // to the folder both pages are served from.
  var ART = {
    logo: 'assets/plug-play-title.png',   // PLUG & PLAY title art (start screen hero)
    mark: 'assets/wpg-logo.png',          // WP/G mark (top bar, "presented by")
    back: 'assets/card-back.png'          // branded card back
  };

  // Board sizes: every columns x rows grid from 2x2 to 8x8 that is portrait
  // (rows >= cols) and holds an even number of cards. Brand images repeat
  // round-robin across the pairs, and any two cards with the same image match.
  var BOARDS = [];
  for (var bc = 2; bc <= 8; bc++) {
    for (var br = bc; br <= 8; br++) {
      if ((bc * br) % 2 === 0) BOARDS.push({ id: bc + 'x' + br, cols: bc, rows: br, cards: bc * br, pairs: (bc * br) / 2 });
    }
  }
  var BOARD_BY_ID = {};
  BOARDS.forEach(function (b) { BOARD_BY_ID[b.id] = b; });

  function boardOf(id) {
    return BOARD_BY_ID[id] || BOARD_BY_ID[DEFAULTS.board];
  }

  // Pre-board configs stored "pairs" and laid the board out with this column
  // table; keep the same look when such a record is loaded.
  var LEGACY_COLS = { 2: 2, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 4, 9: 3, 10: 4, 11: 4, 12: 4 };
  function legacyBoard(pairs) {
    var cols = LEGACY_COLS[pairs] || 4;
    var best = null;
    BOARDS.forEach(function (b) {
      if (b.cols === cols && b.cards >= pairs * 2 && (!best || b.cards < best.cards)) best = b;
    });
    return best ? best.id : DEFAULTS.board;
  }

  // 12 distinct hues for placeholder faces (index = pair number).
  var PALETTE = [
    '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9',
    '#3b82f6', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e', '#84cc16'
  ];

  /* ---------- slot ids ---------- */
  var slot = {
    face: function (i) { return 'face-' + i; },
    BACK: 'back',
    LOGO: 'logo',
    MARK: 'mark',
    faceIndex: function (id) {
      var m = /^face-(\d{1,2})$/.exec(String(id || ''));
      if (!m) return -1;
      var i = Number(m[1]);
      return i >= 0 && i < LIMITS.MAX_IMAGES ? i : -1;
    },
    isValid: function (id) {
      return id === slot.BACK || id === slot.LOGO || id === slot.MARK || slot.faceIndex(id) >= 0;
    }
  };

  /* ---------- settings ---------- */
  function clampInt(value, min, max, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    n = Math.round(n);
    return Math.min(max, Math.max(min, n));
  }

  function cleanText(value, max, fallback) {
    if (typeof value !== 'string') return fallback;
    var t = value.replace(/\s+/g, ' ').trim();
    if (!t) return fallback;
    return t.length > max ? t.slice(0, max) : t;
  }

  // only #rrggbb is accepted (what <input type="color"> produces); stored lowercase
  function cleanHex(value, fallback) {
    if (typeof value !== 'string') return fallback;
    var t = value.trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(t) ? t : fallback;
  }

  function normalizeSettings(raw) {
    var src = raw && typeof raw === 'object' ? raw : {};
    var legacyPairs = Number.isFinite(Number(src.pairs)) ? clampInt(src.pairs, 2, 12, 0) : 0;
    var images = clampInt(src.images !== undefined ? src.images : (legacyPairs || undefined),
      LIMITS.MIN_IMAGES, LIMITS.MAX_IMAGES, DEFAULTS.images);
    var board = typeof src.board === 'string' && BOARD_BY_ID[src.board] ? src.board
      : (legacyPairs ? legacyBoard(legacyPairs) : DEFAULTS.board);
    var out = {
      version: SCHEMA_VERSION,
      images: images,
      board: board,
      title: cleanText(src.title, LIMITS.TITLE_MAX, DEFAULTS.title),
      tagline: cleanText(src.tagline, LIMITS.TAGLINE_MAX, DEFAULTS.tagline),
      previewSec: clampInt(src.previewSec, LIMITS.PREVIEW_MIN, LIMITS.PREVIEW_MAX, DEFAULTS.previewSec),
      faceColor: cleanHex(src.faceColor, DEFAULTS.faceColor)
    };
    if (Number.isFinite(src.updatedAt)) out.updatedAt = src.updatedAt;
    return out;
  }

  // Hook for future schema bumps; a no-op today.
  function migrate(record) {
    return record;
  }

  function defaultConfig() {
    return { settings: normalizeSettings({}), images: new Map(), isDefault: true };
  }

  /* ---------- IndexedDB ---------- */
  function isAvailable() {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
    catch (e) { return false; }
  }

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!isAvailable()) {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_IMAGES)) {
          db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        db.onclose = function () { dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('Could not open IndexedDB.')); };
      req.onblocked = function () { reject(new Error('IndexedDB is blocked by another open tab.')); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB request failed.')); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed.')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted.')); };
    });
  }

  function toImageRecord(id, value, now) {
    var blob = value instanceof Blob ? value : (value && value.blob);
    if (!(blob instanceof Blob)) return null;
    return {
      id: id,
      blob: blob,
      type: blob.type || 'application/octet-stream',
      width: value && Number.isFinite(value.width) ? value.width : 0,
      height: value && Number.isFinite(value.height) ? value.height : 0,
      updatedAt: now
    };
  }

  function loadConfig() {
    return open().then(function (db) {
      var tx = db.transaction([STORE_SETTINGS, STORE_IMAGES], 'readonly');
      var settingsReq = tx.objectStore(STORE_SETTINGS).get(CONFIG_KEY);
      var imagesReq = tx.objectStore(STORE_IMAGES).getAll();
      return Promise.all([reqToPromise(settingsReq), reqToPromise(imagesReq), txDone(tx)]);
    }).then(function (results) {
      var record = results[0];
      var imageRecords = results[1] || [];
      var images = new Map();
      imageRecords.forEach(function (rec) {
        if (rec && slot.isValid(rec.id) && rec.blob instanceof Blob) images.set(rec.id, rec);
      });
      var settings = normalizeSettings(record ? migrate(record) : {});
      return { settings: settings, images: images, isDefault: !record };
    });
  }

  // imageOps: Map<slotId, {blob,width,height} | Blob | null>  (null = delete)
  function saveConfig(payload) {
    var settings = normalizeSettings(payload && payload.settings);
    var imageOps = payload && payload.imageOps instanceof Map ? payload.imageOps : new Map();
    var now = Date.now();
    settings.updatedAt = now;
    return open().then(function (db) {
      var tx = db.transaction([STORE_SETTINGS, STORE_IMAGES], 'readwrite');
      var settingsStore = tx.objectStore(STORE_SETTINGS);
      var imageStore = tx.objectStore(STORE_IMAGES);
      var record = Object.assign({ key: CONFIG_KEY }, settings);
      settingsStore.put(record);
      imageOps.forEach(function (value, id) {
        if (!slot.isValid(id)) return;
        if (value === null || value === undefined) {
          imageStore.delete(id);
          return;
        }
        var rec = toImageRecord(id, value, now);
        if (rec) imageStore.put(rec);
      });
      return txDone(tx);
    }).then(function () {
      requestPersistence();
      return settings;
    });
  }

  // images: Map<slotId, {blob,width,height} | Blob>
  function replaceAll(payload) {
    var settings = normalizeSettings(payload && payload.settings);
    var images = payload && payload.images instanceof Map ? payload.images : new Map();
    var now = Date.now();
    settings.updatedAt = now;
    return open().then(function (db) {
      var tx = db.transaction([STORE_SETTINGS, STORE_IMAGES], 'readwrite');
      var settingsStore = tx.objectStore(STORE_SETTINGS);
      var imageStore = tx.objectStore(STORE_IMAGES);
      settingsStore.clear();
      imageStore.clear();
      settingsStore.put(Object.assign({ key: CONFIG_KEY }, settings));
      images.forEach(function (value, id) {
        if (!slot.isValid(id)) return;
        var rec = toImageRecord(id, value, now);
        if (rec) imageStore.put(rec);
      });
      return txDone(tx);
    }).then(function () {
      requestPersistence();
      return settings;
    });
  }

  function clearAll() {
    return open().then(function (db) {
      var tx = db.transaction([STORE_SETTINGS, STORE_IMAGES], 'readwrite');
      tx.objectStore(STORE_SETTINGS).clear();
      tx.objectStore(STORE_IMAGES).clear();
      return txDone(tx);
    });
  }

  function requestPersistence() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        navigator.storage.persist().catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- image processing ---------- */
  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({
          source: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
          release: function () { URL.revokeObjectURL(url); }
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Unsupported image format. Use PNG, JPG, or WebP.'));
      };
      img.src = url;
    });
  }

  function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).then(function (bmp) {
        return {
          source: bmp,
          width: bmp.width,
          height: bmp.height,
          release: function () { if (typeof bmp.close === 'function') bmp.close(); }
        };
      }).catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      try { canvas.toBlob(function (blob) { resolve(blob || null); }, type, quality); }
      catch (e) { resolve(null); }
    });
  }

  function processImageFile(file, options) {
    var opts = options || {};
    var maxSide = opts.maxSide || LIMITS.MAX_SIDE;
    if (!file) return Promise.reject(new Error('No file selected.'));
    if (!(file.type && file.type.indexOf('image/') === 0)) {
      return Promise.reject(new Error('That file is not an image. Use PNG, JPG, or WebP.'));
    }
    if (file.size > LIMITS.MAX_UPLOAD_BYTES) {
      return Promise.reject(new Error('Image is too large (max 15 MB).'));
    }
    return decodeImage(file).then(function (decoded) {
      var result;
      try {
        if (!decoded.width || !decoded.height) throw new Error('Could not read the image size.');
        var scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
        var w = Math.max(1, Math.round(decoded.width * scale));
        var h = Math.max(1, Math.round(decoded.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(decoded.source, 0, 0, w, h);
        result = canvasToBlob(canvas, 'image/webp', 0.85).then(function (blob) {
          // Browsers without WebP encoding silently return PNG (or null).
          if (blob && blob.type === 'image/webp') return blob;
          return canvasToBlob(canvas, 'image/png');
        }).then(function (blob) {
          if (!blob) throw new Error('Could not encode the image.');
          return { blob: blob, width: w, height: h, type: blob.type };
        });
      } catch (e) {
        result = Promise.reject(e);
      }
      return result.finally(function () { decoded.release(); });
    });
  }

  function measureBlob(blob) {
    return decodeImage(blob).then(function (d) {
      var dims = { width: d.width, height: d.height };
      d.release();
      return dims;
    }).catch(function () { return { width: 0, height: 0 }; });
  }

  /* ---------- data URL codecs ---------- */
  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read image.')); };
      reader.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataUrl) {
    if (typeof fetch === 'function') {
      return fetch(dataUrl).then(function (r) { return r.blob(); }).catch(function () {
        return dataURLToBlobSync(dataUrl);
      });
    }
    return Promise.resolve().then(function () { return dataURLToBlobSync(dataUrl); });
  }

  function dataURLToBlobSync(dataUrl) {
    var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('Invalid data URL.');
    var type = m[1] || 'application/octet-stream';
    var raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: type });
  }

  /* ---------- export / import ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function exportFilename(date) {
    var d = date || new Date();
    return 'flip-match-config-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' +
      pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + '.json';
  }

  function exportConfig() {
    return loadConfig().then(function (cfg) {
      var ids = Array.from(cfg.images.keys());
      return Promise.all(ids.map(function (id) {
        return blobToDataURL(cfg.images.get(id).blob);
      })).then(function (urls) {
        var images = {};
        ids.forEach(function (id, i) { images[id] = urls[i]; });
        var now = new Date();
        var doc = {
          format: EXPORT_FORMAT,
          version: SCHEMA_VERSION,
          exportedAt: now.toISOString(),
          settings: {
            images: cfg.settings.images,
            board: cfg.settings.board,
            title: cfg.settings.title,
            tagline: cfg.settings.tagline,
            previewSec: cfg.settings.previewSec,
            faceColor: cfg.settings.faceColor
          },
          images: images
        };
        return { json: JSON.stringify(doc), filename: exportFilename(now), imageCount: ids.length };
      });
    });
  }

  var DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;

  function parseImport(jsonText) {
    return Promise.resolve().then(function () {
      var doc;
      try { doc = JSON.parse(jsonText); }
      catch (e) { throw new Error('That file is not valid JSON.'); }
      if (!doc || typeof doc !== 'object') throw new Error('That file is not a Flip Match config.');
      if (doc.format !== EXPORT_FORMAT) throw new Error('That file is not a Flip Match config.');
      if (!Number.isInteger(doc.version) || doc.version < 1 || doc.version > SCHEMA_VERSION) {
        throw new Error('This config was made by a newer version of Flip Match.');
      }
      var settings = normalizeSettings(doc.settings);
      var rawImages = doc.images && typeof doc.images === 'object' ? doc.images : {};
      var ids = Object.keys(rawImages).filter(function (id) {
        return slot.isValid(id) && typeof rawImages[id] === 'string' && DATA_URL_RE.test(rawImages[id]);
      });
      return Promise.all(ids.map(function (id) {
        return dataURLToBlob(rawImages[id]).then(function (blob) {
          if (!blob || !blob.size) throw new Error('Image "' + id + '" is empty.');
          if (blob.size > LIMITS.MAX_IMPORT_IMAGE_BYTES) throw new Error('Image "' + id + '" is too large.');
          return measureBlob(blob).then(function (dims) {
            return { id: id, value: { blob: blob, width: dims.width, height: dims.height } };
          });
        });
      })).then(function (entries) {
        var images = new Map();
        entries.forEach(function (e) { images.set(e.id, e.value); });
        return { settings: settings, images: images };
      });
    });
  }

  /* ---------- placeholders (SVG data URIs) ---------- */
  function svgDataUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function shade(hex, amount) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var f = function (c) {
      var v = amount < 0 ? c * (1 + amount) : c + (255 - c) * amount;
      return Math.max(0, Math.min(255, Math.round(v)));
    };
    return '#' + ((1 << 24) + (f(r) << 16) + (f(g) << 8) + f(b)).toString(16).slice(1);
  }

  var FONT = "Montserrat, 'Arial Black', 'Segoe UI', Arial, sans-serif";
  var DECK_RED = '#e30613';

  // Deck-style placeholder face: TRANSPARENT (it sits on the admin-chosen face
  // colour), showing the numbered red badge with a white ring used throughout
  // the WP Gaming deck plus a small white dot grid.
  function placeholderFace(i, total) {
    var idx = Math.max(0, i | 0);
    var label = String(idx + 1);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">' +
      '<g fill="#ffffff" fill-opacity="0.8">' +
      '<circle cx="66" cy="66" r="4"/><circle cx="86" cy="66" r="4"/><circle cx="106" cy="66" r="4"/>' +
      '<circle cx="66" cy="86" r="4"/><circle cx="86" cy="86" r="4"/><circle cx="106" cy="86" r="4"/>' +
      '<circle cx="66" cy="106" r="4"/><circle cx="86" cy="106" r="4"/><circle cx="106" cy="106" r="4"/>' +
      '</g>' +
      '<circle cx="256" cy="256" r="176" fill="none" stroke="#ffffff" stroke-width="6" stroke-opacity="0.9"/>' +
      '<circle cx="256" cy="256" r="152" fill="' + DECK_RED + '"/>' +
      '<text x="250" y="262" text-anchor="middle" dominant-baseline="central" font-family="' + FONT + '" font-size="190" font-weight="900" font-style="italic" fill="#ffffff">' + label + '</text>' +
      '</svg>';
    return svgDataUri(svg);
  }

  function placeholderBack() { return ART.back; }
  function placeholderLogo() { return ART.logo; }
  function placeholderMark() { return ART.mark; }

  var placeholders = { face: placeholderFace, back: placeholderBack, logo: placeholderLogo, mark: placeholderMark };

  /* ---------- assets for the game ---------- */
  function resolveAssets(config) {
    var cfg = config || defaultConfig();
    var urls = [];
    function use(rec, fallback) {
      if (rec && rec.blob instanceof Blob) {
        var u = URL.createObjectURL(rec.blob);
        urls.push(u);
        return u;
      }
      return fallback;
    }
    var count = cfg.settings.images;
    var faces = [];
    for (var i = 0; i < count; i++) {
      faces.push(use(cfg.images.get(slot.face(i)), placeholders.face(i, count)));
    }
    return {
      faces: faces,
      back: use(cfg.images.get(slot.BACK), placeholders.back()),
      logo: use(cfg.images.get(slot.LOGO), placeholders.logo()),
      mark: use(cfg.images.get(slot.MARK), placeholders.mark()),
      hasCustomLogo: cfg.images.has(slot.LOGO),
      revoke: function () {
        urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
        urls.length = 0;
      }
    };
  }

  // Cheap change-detection key so the game only re-renders on real changes.
  function signature(config) {
    if (!config) return '';
    var imgs = [];
    config.images.forEach(function (rec, id) {
      imgs.push(id + ':' + (rec.updatedAt || 0) + ':' + (rec.blob ? rec.blob.size : 0));
    });
    imgs.sort();
    return JSON.stringify([config.settings, imgs]);
  }

  /* ---------- cross-tab "config updated" ping ---------- */
  function notifyUpdated() {
    try { localStorage.setItem(UPDATED_KEY, String(Date.now())); }
    catch (e) { /* ignore */ }
  }

  function onUpdated(callback) {
    var handler = function (event) {
      if (event.key === UPDATED_KEY || event.key === null) callback();
    };
    window.addEventListener('storage', handler);
    return function () { window.removeEventListener('storage', handler); };
  }

  global.FlipStore = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    LIMITS: LIMITS,
    DEFAULTS: DEFAULTS,
    ART: ART,
    BOARDS: BOARDS,
    boardOf: boardOf,
    PALETTE: PALETTE,
    slot: slot,
    isAvailable: isAvailable,
    open: open,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    replaceAll: replaceAll,
    clearAll: clearAll,
    normalizeSettings: normalizeSettings,
    defaultConfig: defaultConfig,
    processImageFile: processImageFile,
    measureBlob: measureBlob,
    blobToDataURL: blobToDataURL,
    dataURLToBlob: dataURLToBlob,
    exportConfig: exportConfig,
    parseImport: parseImport,
    placeholders: placeholders,
    resolveAssets: resolveAssets,
    signature: signature,
    notifyUpdated: notifyUpdated,
    onUpdated: onUpdated
  };
})(window);
