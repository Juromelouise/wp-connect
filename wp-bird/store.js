/* =========================================================================
   WP Flappy Challenge (formerly WP Bird) — shared storage module (window.BirdStore)
   -------------------------------------------------------------------------
   Loaded by BOTH index.html (the game) and admin.html (the staff page) so
   they agree on the IndexedDB schema, slot ids, validation and defaults.
   Plain script, no build step. Adapted from Flip Match's store.js - same
   idioms, different slots: instead of card faces the gallery holds BIRD
   SKINS (brand images), and the bird wears a random one each run.

   Persistence is browser-only: everything lives in IndexedDB on the device
   that saved it. Both pages must be served from the SAME ORIGIN (same host
   and port) or they will not see the same database. Use Export / Import in
   the admin to move a set to another device.
   ========================================================================= */
(function (global) {
  'use strict';

  var DB_NAME = 'wp-bird';
  var DB_VERSION = 1;        // structural (object stores)
  var SCHEMA_VERSION = 1;    // shape of the settings record / export file
  var STORE_SETTINGS = 'settings';
  var STORE_IMAGES = 'images';
  var CONFIG_KEY = 'config';
  var UPDATED_KEY = 'wp-bird:updatedAt';
  var EXPORT_FORMAT = 'wp-bird-config';

  var LIMITS = {
    MAX_SKINS: 12,                       // brand skins in the gallery
    MAX_SIDE: 512,                       // longest side after downscale (px) - a sprite, not a poster
    MAX_UPLOAD_BYTES: 15 * 1024 * 1024,  // reject bigger source files
    MAX_IMPORT_IMAGE_BYTES: 6 * 1024 * 1024,
    TITLE_MAX: 40,
    // Every skin is normalised to this square: transparent margins trimmed,
    // then the logo fitted inside with even padding. So a brand that ships
    // with baked-in whitespace, or a wide wordmark, renders the SAME size on
    // the bird as a tight square badge does.
    SKIN_SIDE: 512,
    SKIN_PADDING: 0.06,                  // fraction of SKIN_SIDE kept clear on each edge
    TRIM_SCAN_SIDE: 1024,                // alpha scan happens at most at this size
    TRIM_ALPHA: 8,                       // pixels this transparent or more count as empty
    MAX_KEYS: 12                         // keyboard keys that flap (arcade button boxes send key codes)
  };

  var DEFAULTS = {
    title: 'WP FLAPPY CHALLENGE',
    // Keys that flap (and start / restart a run). W was the hard-coded key.
    flapKeys: [{ code: 'KeyW', key: 'w', label: 'W' }],
    // Which brand the bird wears: 'random' (a new pick every run) or one
    // skin slot id such as 'skin-2' (always that brand).
    skinMode: 'random'
  };

  // Deck artwork shipped with the game (WP Gaming DigiCon 2026 deck). Relative
  // to the folder both pages are served from.
  var ART = {
    logo: 'assets/plug%20n%20play.png',   // PLUG & PLAY title art (menu hero, DigiCon 2026 deck)
    mark: 'assets/wpg-logo.png'           // WP/G mark ("presented by")
  };

  /* ---------- slot ids ---------- */
  var slot = {
    skin: function (i) { return 'skin-' + i; },
    LOGO: 'logo',
    MARK: 'mark',
    skinIndex: function (id) {
      var m = /^skin-(\d{1,2})$/.exec(String(id || ''));
      if (!m) return -1;
      var i = Number(m[1]);
      return i >= 0 && i < LIMITS.MAX_SKINS ? i : -1;
    },
    isValid: function (id) {
      return id === slot.LOGO || id === slot.MARK || slot.skinIndex(id) >= 0;
    }
  };

  /* ---------- settings ---------- */
  function cleanText(value, max, fallback) {
    if (typeof value !== 'string') return fallback;
    var t = value.replace(/\s+/g, ' ').trim();
    if (!t) return fallback;
    return t.length > max ? t.slice(0, max) : t;
  }

  /* ---------- flap keys ----------
     A key is stored as the KeyboardEvent's physical `code` (layout-proof, and
     what arcade button encoders send), plus its `key` for browsers that report
     no code, plus a label for the admin and the menu. "KeyN" is reserved: it is
     the staff skip on the start screen. */
  var RESERVED_CODES = { KeyN: true };
  var KEY_ID_RE = /^[A-Za-z0-9]{1,32}$/;

  function keyLabelFrom(code, key) {
    var k = typeof key === 'string' ? key : '';
    var c = typeof code === 'string' ? code : '';
    if (k === ' ' || c === 'Space') return 'Space';
    if (/^Key[A-Z]$/.test(c)) return c.slice(3);
    if (/^Digit[0-9]$/.test(c)) return c.slice(5);
    if (/^Numpad/.test(c)) return 'Num ' + c.slice(6);
    if (/^Arrow/.test(c)) return c.slice(5) + ' arrow';
    if (k.length === 1) return k.toUpperCase();
    return k || c || '?';
  }

  function normalizeKey(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var code = typeof raw.code === 'string' && KEY_ID_RE.test(raw.code) ? raw.code : '';
    var key = typeof raw.key === 'string' ? raw.key.slice(0, 16) : '';
    if (!code && !key) return null;
    if (RESERVED_CODES[code] || (!code && key.toLowerCase() === 'n')) return null;
    var label = cleanText(raw.label, 24, '') || keyLabelFrom(code, key);
    return { code: code, key: key, label: label };
  }

  function sameKey(a, b) {
    if (!a || !b) return false;
    if (a.code && b.code) return a.code === b.code;
    return !!a.key && !!b.key && a.key.toLowerCase() === b.key.toLowerCase();
  }

  function normalizeKeys(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      var k = normalizeKey(raw);
      if (!k) return;
      for (var i = 0; i < out.length; i++) if (sameKey(out[i], k)) return;
      if (out.length < LIMITS.MAX_KEYS) out.push(k);
    });
    if (out.length) return out;
    return DEFAULTS.flapKeys.map(function (k) { return { code: k.code, key: k.key, label: k.label }; });
  }

  function keyFromEvent(e) {
    if (!e) return null;
    var code = typeof e.code === 'string' ? e.code : '';
    var key = typeof e.key === 'string' ? e.key : '';
    return normalizeKey({ code: code, key: key, label: keyLabelFrom(code, key) });
  }

  function keyMatches(e, k) {
    if (!e || !k) return false;
    if (k.code && typeof e.code === 'string' && e.code) return e.code === k.code;
    var ek = typeof e.key === 'string' ? e.key : '';
    return !!k.key && ek.toLowerCase() === k.key.toLowerCase();
  }

  function keyMatchesAny(e, list) {
    for (var i = 0; i < (list || []).length; i++) if (keyMatches(e, list[i])) return true;
    return false;
  }

  // 'random' or a skin slot id; whether that slot actually holds an image is
  // the game's problem (it falls back to random), so an emptied slot never
  // breaks a saved config.
  function normalizeSkinMode(value) {
    if (typeof value !== 'string') return DEFAULTS.skinMode;
    if (value === 'random') return 'random';
    return slot.skinIndex(value) >= 0 ? value : DEFAULTS.skinMode;
  }

  function normalizeSettings(raw) {
    var src = raw && typeof raw === 'object' ? raw : {};
    var out = {
      version: SCHEMA_VERSION,
      title: cleanText(src.title, LIMITS.TITLE_MAX, DEFAULTS.title),
      flapKeys: normalizeKeys(src.flapKeys),
      skinMode: normalizeSkinMode(src.skinMode)
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

  // Skins keep transparency: WebP (lossless-ish) first, PNG when the browser
  // cannot encode WebP - never JPEG, a bird with a black box round it is worse
  // than no skin at all.
  /* Bounding box of the non-transparent pixels, scanned at a bounded size so
     a huge source does not cost a huge getImageData. Fully transparent (or
     unreadable) images keep their full frame. */
  function trimBox(source, w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.drawImage(source, 0, 0, w, h);
    var data;
    try { data = g.getImageData(0, 0, w, h).data; }
    catch (e) { return { x: 0, y: 0, w: w, h: h }; }
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > LIMITS.TRIM_ALPHA) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { x: 0, y: 0, w: w, h: h };
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /* Draw the trimmed logo centred in a SKIN_SIDE square with even padding.
     Aspect ratio is kept; the longer side of the trimmed logo fills the box. */
  function drawSquareSkin(decoded, canvas) {
    var side = LIMITS.SKIN_SIDE;
    var scan = Math.min(1, LIMITS.TRIM_SCAN_SIDE / Math.max(decoded.width, decoded.height));
    var sw = Math.max(1, Math.round(decoded.width * scan));
    var sh = Math.max(1, Math.round(decoded.height * scan));
    var box = trimBox(decoded.source, sw, sh);
    var sx = box.x / scan, sy = box.y / scan, sW = box.w / scan, sH = box.h / scan;
    var pad = side * LIMITS.SKIN_PADDING;
    var inner = side - pad * 2;
    var fit = Math.min(inner / sW, inner / sH);
    var dw = sW * fit, dh = sH * fit;
    canvas.width = side;
    canvas.height = side;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, sx, sy, sW, sH, (side - dw) / 2, (side - dh) / 2, dw, dh);
  }

  /* True when a stored skin predates the square normalisation. */
  function isSquareSkin(rec) {
    return !!rec && rec.width === LIMITS.SKIN_SIDE && rec.height === LIMITS.SKIN_SIDE;
  }

  // options.square: trim + fit into the SKIN_SIDE square (bird skins).
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
        var canvas = document.createElement('canvas');
        var w, h;
        if (opts.square) {
          drawSquareSkin(decoded, canvas);
          w = h = LIMITS.SKIN_SIDE;
        } else {
          var scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
          w = Math.max(1, Math.round(decoded.width * scale));
          h = Math.max(1, Math.round(decoded.height * scale));
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(decoded.source, 0, 0, w, h);
        }
        result = canvasToBlob(canvas, 'image/webp', 0.9).then(function (blob) {
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
    return 'wp-bird-config-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' +
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
            title: cfg.settings.title,
            flapKeys: cfg.settings.flapKeys,
            skinMode: cfg.settings.skinMode
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
      if (!doc || typeof doc !== 'object') throw new Error('That file is not a WP Flappy Challenge config.');
      if (doc.format !== EXPORT_FORMAT) throw new Error('That file is not a WP Flappy Challenge config.');
      if (!Number.isInteger(doc.version) || doc.version < 1 || doc.version > SCHEMA_VERSION) {
        throw new Error('This config was made by a newer version of WP Flappy Challenge.');
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

  /* ---------- placeholders ---------- */
  function svgDataUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // The admin's empty skin tile: the procedural bird the game draws when the
  // gallery is empty (amber body, white wing, red beak), so staff see what a
  // slot replaces.
  function placeholderSkin() {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">' +
      '<defs><radialGradient id="g" cx="0.35" cy="0.35" r="0.8">' +
      '<stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#ffb300"/><stop offset="1" stop-color="#c26a00"/>' +
      '</radialGradient></defs>' +
      '<circle cx="60" cy="64" r="40" fill="url(#g)" stroke="#ffffff" stroke-width="4"/>' +
      '<ellipse cx="54" cy="68" rx="22" ry="14" fill="#ffffff" fill-opacity="0.85" transform="rotate(-17 54 68)"/>' +
      '<polygon points="90,60 120,67 90,76" fill="#e30613"/>' +
      '<circle cx="74" cy="50" r="8" fill="#12060a"/>' +
      '</svg>';
    return svgDataUri(svg);
  }

  function placeholderLogo() { return ART.logo; }
  function placeholderMark() { return ART.mark; }

  var placeholders = { skin: placeholderSkin, logo: placeholderLogo, mark: placeholderMark };

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
    // Only slots that actually hold an image - gaps in the gallery are fine.
    // Each entry keeps its slot id so settings.skinMode can name one brand.
    var skins = [];
    for (var i = 0; i < LIMITS.MAX_SKINS; i++) {
      var rec = cfg.images.get(slot.skin(i));
      if (rec && rec.blob instanceof Blob) skins.push({ id: slot.skin(i), url: use(rec, '') });
    }
    return {
      skins: skins,
      logo: use(cfg.images.get(slot.LOGO), placeholders.logo()),
      mark: use(cfg.images.get(slot.MARK), placeholders.mark()),
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

  global.BirdStore = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    LIMITS: LIMITS,
    DEFAULTS: DEFAULTS,
    ART: ART,
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
    isSquareSkin: isSquareSkin,
    keys: {
      fromEvent: keyFromEvent,
      matches: keyMatches,
      matchesAny: keyMatchesAny,
      same: sameKey,
      label: keyLabelFrom,
      normalize: normalizeKeys,
      reserved: Object.keys(RESERVED_CODES)
    },
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
