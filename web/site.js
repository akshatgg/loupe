/* Loupe website. No dependencies, no tracking.
   Everything here is an enhancement: the page reads, and every download
   works, with JavaScript turned off. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  // Mac or Windows: chosen from the visitor's system before first paint (so
  // the other platform's panel never flashes), changeable with the tabs.
  var platform = detectPlatform();
  root.setAttribute('data-platform', platform);
  var platformListeners = [];

  function detectPlatform() {
    var nav = window.navigator || {};
    var hint = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '';
    return /win/i.test(hint) ? 'win' : 'mac';
  }

  var ready = function (fn) {
    // Always after this whole file has run, so every table below is defined.
    if (document.readyState !== 'loading') setTimeout(fn, 0);
    else document.addEventListener('DOMContentLoaded', fn);
  };

  ready(function () {
    initPlatform();
    initCopyButtons();
    initRelease();
    var demo = document.querySelector('[data-demo]');
    if (demo) initDemo(demo);
    var look = document.querySelector('[data-look]');
    if (look) initLook(look);
  });

  /* ------------------------------------------------------------ look */

  // The video shape buttons. Without JavaScript the illustration simply
  // stays wide and the buttons stay hidden.
  function initLook(look) {
    var group = look.querySelector('[data-aspects]');
    if (!group) return;
    var buttons = Array.prototype.slice.call(group.querySelectorAll('[data-aspect-value]'));
    group.hidden = false;
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var value = btn.getAttribute('data-aspect-value');
        look.setAttribute('data-aspect', value);
        buttons.forEach(function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
      });
    });
  }

  /* ------------------------------------------------------------ platform */

  // How each system names the zoom keys. The saved setting is the same on
  // both; only the labels change.
  var KEYS = {
    mac: {
      glyph: { option: '⌥', control: '⌃', command: '⌘', shift: '⇧' },
      // option-after follows the key itself: "⌥ Option" on a Mac, just "Alt" on Windows.
      name: { option: 'Option', 'option-after': '\u00a0Option', control: 'Control', command: 'Command' },
      cap: { option: 'option', control: 'control', command: 'command', shift: 'shift' }
    },
    win: {
      glyph: { option: 'Alt', control: 'Ctrl', command: '⊞', shift: 'Shift' },
      name: { option: 'Alt', 'option-after': '', control: 'Ctrl', command: 'the Windows key' },
      // A PC keycap is labelled with the word itself; only the logo key needs a name.
      cap: { option: '', control: '', command: 'windows', shift: '' }
    }
  };

  function keyGlyph(key) { return KEYS[platform].glyph[key]; }

  function initPlatform() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-platform-tab]'));
    var list = document.querySelector('[data-os-tabs]');
    if (list) list.hidden = false;

    function select(next, focus) {
      platform = next;
      root.setAttribute('data-platform', next);
      tabs.forEach(function (tab) {
        var on = tab.getAttribute('data-platform-tab') === next;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
        if (on && focus) tab.focus();
      });
      var k = KEYS[next];
      each('[data-keyglyph]', function (el) {
        var g = k.glyph[el.getAttribute('data-keyglyph')];
        if (g) { el.textContent = g; el.classList.toggle('is-word', g.length > 1); }
      });
      each('[data-key-name]', function (el) {
        var n = k.name[el.getAttribute('data-key-name')];
        if (typeof n === 'string') el.textContent = n;
      });
      each('[data-key-cap]', function (el) {
        var c = k.cap[el.getAttribute('data-key-cap')];
        if (typeof c === 'string') el.textContent = c;
      });
      // A shortcut badge and the reveal button read the way each system does.
      each('[data-mod]', function (el) { el.textContent = next === 'win' ? 'Ctrl' : '⌘'; });
      each('[data-reveal-label]', function (el) {
        el.textContent = next === 'win' ? 'Show in Explorer' : 'Show in Finder';
      });
      each('[data-os-cta]', function (el) {
        el.textContent = next === 'win' ? 'Download for Windows' : 'Download for Mac';
      });
      platformListeners.forEach(function (fn) { fn(next); });
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab.getAttribute('data-platform-tab'), false); });
      tab.addEventListener('keydown', function (e) {
        var step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        var to = tabs[(i + step + tabs.length) % tabs.length];
        select(to.getAttribute('data-platform-tab'), true);
      });
    });

    select(platform, false);
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  /* ---------------------------------------------------------------- copy */

  function initCopyButtons() {
    var status = document.getElementById('copy-status');
    var buttons = document.querySelectorAll('[data-copy]');

    Array.prototype.forEach.call(buttons, function (btn) {
      var code = document.getElementById(btn.getAttribute('data-copy'));
      var label = btn.querySelector('[data-copy-label]') || btn;
      if (!code) return;
      btn.hidden = false;
      btn.setAttribute('aria-label', btn.getAttribute('data-copy-name') || 'Copy command');
      var timer = 0;

      function show(state, text, announce) {
        btn.setAttribute('data-state', state);
        label.textContent = text;
        if (status) {
          status.textContent = '';
          // A fresh write so screen readers announce repeat copies too.
          setTimeout(function () { status.textContent = announce; }, 30);
        }
        clearTimeout(timer);
        timer = setTimeout(function () {
          btn.removeAttribute('data-state');
          label.textContent = 'Copy';
        }, 2400);
      }

      btn.addEventListener('click', function () {
        var text = code.textContent.trim();
        var done = function () { show('copied', 'Copied', 'Command copied to the clipboard'); };
        var fallback = function () {
          selectText(code);
          var ok = false;
          try { ok = document.execCommand('copy'); } catch { ok = false; }
          if (ok) done();
          else show('select', 'Press ⌘C', 'Command selected. Press Command C to copy it.');
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(done, fallback);
        } else {
          fallback();
        }
      });
    });
  }

  function selectText(node) {
    var sel = window.getSelection && window.getSelection();
    if (!sel) return;
    var range = document.createRange();
    range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ------------------------------------------------------------- release */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function initRelease() {
    var line = document.querySelector('[data-release]');
    var textEl = document.querySelector('[data-release-text]');
    var link = document.querySelector('[data-release-link]');
    if (!line || !textEl || !window.fetch) return;

    var ctrl = window.AbortController ? new AbortController() : null;
    if (ctrl) setTimeout(function () { ctrl.abort(); }, 8000);

    fetch('https://api.github.com/repos/akshatgg/loupe/releases/latest', ctrl ? { signal: ctrl.signal } : {})
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (rel) {
        if (!rel || typeof rel.tag_name !== 'string') return;
        var tag = rel.tag_name.trim().slice(0, 40);
        if (!tag) return;
        if (/^\d/.test(tag)) tag = 'v' + tag;
        var when = new Date(rel.published_at || rel.created_at);
        var text = tag;
        if (!isNaN(when.getTime())) {
          text += ' · released ' + when.getUTCDate() + ' ' + MONTHS[when.getUTCMonth()] + ' ' + when.getUTCFullYear();
        }
        textEl.textContent = text + '.';
        if (typeof rel.html_url === 'string' && rel.html_url.indexOf('https://github.com/akshatgg/loupe/') === 0) {
          link.href = rel.html_url;
        }
        line.hidden = false;
        // The newest release may predate Windows builds: then say so rather
        // than offer a link that would not download anything.
        var hasWindows = Array.isArray(rel.assets) && rel.assets.some(function (a) {
          return a && a.name === 'Loupe-Setup-x64.exe';
        });
        if (!hasWindows) {
          each('[data-win-download]', function (el) { el.hidden = true; });
          each('[data-win-pending]', function (el) { el.hidden = false; });
        }
      })
      .catch(function () { /* no release yet, offline, or rate-limited: say nothing */ });
  }

  /* ---------------------------------------------------------------- demo */

  function initDemo(demo) {
    var stage = demo.querySelector('[data-stage]');
    var outView = demo.querySelector('[data-output]');
    if (!stage) return;

    // The "in the video" panel is a copy of the screen's contents only. The
    // frame and the control bar sit outside the stage, so, as in Loupe, they
    // never make it into the video.
    if (outView) {
      var copy = stage.cloneNode(true);
      copy.removeAttribute('data-stage');
      outView.appendChild(copy);
    }

    var typedEls = demo.querySelectorAll('[data-typed]');
    var zoomEls = demo.querySelectorAll('[data-zoom-text]');
    var timeEl = demo.querySelector('[data-time]');
    var gestureEl = demo.querySelector('[data-gesture-text]');
    var pauseBtn = demo.querySelector('[data-pause]');
    var motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

    var EMAIL = 'maya@northwind.co';
    var LOOP = 15;
    var KEY_HELD = [[1.7, 3.3], [10.15, 11.45]];
    var IN_TICKS = [], OUT_TICKS = [];
    for (var i = 0; i < 7; i++) {
      IN_TICKS.push(1.95 + i * 0.17);   // seven notches up: 1.0× to 2.4×
      OUT_TICKS.push(10.35 + i * 0.13); // seven notches down: back to 1.0×
    }
    var TYPE_START = 3.75, TYPE_STEP = 0.105;
    var PRESS = 8.05, SENT = 8.2;
    var LINES = [
      [0, 'Point at what you want to show'],
      [1.7, function () { return 'Hold ' + keyGlyph('option') + ' and scroll up to zoom in'; }],
      [3.45, 'Typing? Small movements don’t shake the shot'],
      [6.3, 'Move somewhere new and the shot follows'],
      [10.15, 'Scroll back down to zoom out'],
      [11.9, 'The frame and the bar never reach the video']
    ];

    var geo = null;
    function measure() {
      var s = stage.getBoundingClientRect();
      if (!s.width || !s.height) return false;
      function at(sel, ax, ay) {
        var r = stage.querySelector(sel).getBoundingClientRect();
        return {
          x: (r.left - s.left + r.width * ax) / s.width * 100,
          y: (r.top - s.top + r.height * ay) / s.height * 100
        };
      }
      var e = stage.querySelector('[data-t="email"]').getBoundingClientRect();
      geo = {
        home: { x: 71, y: 77 },
        email: at('[data-t="email"]', 0.4, 0.58),
        send: at('[data-t="send"]', 0.46, 0.6),
        pill: at('[data-t="pill"]', 0.55, 0.62),
        field: {
          l: (e.left - s.left) / s.width * 100, r: (e.right - s.left) / s.width * 100,
          t: (e.top - s.top) / s.height * 100, b: (e.bottom - s.top) / s.height * 100
        }
      };
      return true;
    }

    function ease(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function cursorAt(t) {
      var g = geo;
      var pts = [
        [0, g.home], [0.35, g.home], [1.5, g.email], [6.3, g.email],
        [7.35, g.send], [8.75, g.send], [9.85, g.pill], [12.3, g.pill],
        [14.2, g.home], [LOOP, g.home]
      ];
      for (var k = 1; k < pts.length; k++) {
        if (t <= pts[k][0]) {
          var a = pts[k - 1], b = pts[k];
          var p = ease(clamp((t - a[0]) / (b[0] - a[0] || 1), 0, 1));
          var x = a[1].x + (b[1].x - a[1].x) * p;
          var y = a[1].y + (b[1].y - a[1].y) * p;
          // The small nudges a hand makes while typing.
          if (t > TYPE_START - 0.2 && t < 6.1) {
            x += Math.sin(t * 9.1) * 0.35 + Math.sin(t * 23.7) * 0.18;
            y += Math.cos(t * 7.3) * 0.3;
          }
          return { x: x, y: y };
        }
      }
      return g.home;
    }

    function zoomTargetAt(t) {
      var z = 1, k;
      for (k = 0; k < IN_TICKS.length; k++) if (t >= IN_TICKS[k]) z += 0.2;
      for (k = 0; k < OUT_TICKS.length; k++) if (t >= OUT_TICKS[k]) z -= 0.2;
      return clamp(Math.round(z * 10) / 10, 1, 4);
    }

    function within(t, list, width) {
      for (var k = 0; k < list.length; k++) if (t >= list[k] && t < list[k] + width) return true;
      return false;
    }

    var flags = {};
    function flag(name, on, value) {
      var v = on ? (value || '') : null;
      if (flags[name] === v) return;
      flags[name] = v;
      if (v === null) demo.removeAttribute('data-' + name);
      else demo.setAttribute('data-' + name, v);
    }
    var texts = new Map();
    function setText(el, s) {
      if (!el || texts.get(el) === s) return;
      texts.set(el, s);
      el.textContent = s;
    }
    function setTyped(s) {
      for (var k = 0; k < typedEls.length; k++) setText(typedEls[k], s);
    }
    function setZoomText(z) {
      var s = z.toFixed(1) + '×';
      for (var k = 0; k < zoomEls.length; k++) setText(zoomEls[k], s);
    }
    function setVars(v) {
      var st = demo.style;
      st.setProperty('--z', v.z.toFixed(4));
      st.setProperty('--fx', v.fx.toFixed(3));
      st.setProperty('--fy', v.fy.toFixed(3));
      st.setProperty('--cx', v.cx.toFixed(3));
      st.setProperty('--cy', v.cy.toFixed(3));
    }

    // Camera state, in % of the screen.
    var cam = { x: 50, y: 50, z: 1 };
    var t = 0, outSince = -1, wasZoomed = false;

    function reset() {
      cam.x = 50; cam.y = 50; cam.z = 1;
      outSince = -1; wasZoomed = false;
    }

    function step(dt) {
      t += dt;
      if (t >= LOOP) { t -= LOOP; reset(); }

      var c = cursorAt(t);
      var zT = zoomTargetAt(t);
      cam.z += (zT - cam.z) * (1 - Math.exp(-dt * 9));
      if (Math.abs(zT - cam.z) < 0.002) cam.z = zT;

      // Follow the cursor, but ignore movement inside a dead zone so small
      // motions don't shake the shot; outside it, glide rather than snap.
      var half = 50 / cam.z;
      var dead = half * 0.32;
      var dx = c.x - cam.x, dy = c.y - cam.y;
      var tx = Math.abs(dx) > dead ? c.x - (dx > 0 ? dead : -dead) : cam.x;
      var ty = Math.abs(dy) > dead ? c.y - (dy > 0 ? dead : -dead) : cam.y;
      var follow = 1 - Math.exp(-dt * 3.4);
      cam.x += (tx - cam.x) * follow;
      cam.y += (ty - cam.y) * follow;
      cam.x = clamp(cam.x, half, 100 - half);
      cam.y = clamp(cam.y, half, 100 - half);

      setVars({ z: cam.z, fx: cam.x - half, fy: cam.y - half, cx: c.x, cy: c.y });

      var zoomed = cam.z >= 1.02;
      if (zoomed) outSince = -1;
      else if (wasZoomed) outSince = t;
      wasZoomed = zoomed;
      setZoomText(zoomed ? cam.z : 1);
      flag('out', !zoomed);
      // Back at 1.0×, leave "1.0×" up for a moment, then fade it.
      flag('idle', !zoomed && (outSince < 0 || t - outSince > 0.9));

      var f = geo.field;
      flag('ibeam', c.x > f.l && c.x < f.r && c.y > f.t && c.y < f.b);
      flag('key', t >= KEY_HELD[0][0] && t < KEY_HELD[0][1] || t >= KEY_HELD[1][0] && t < KEY_HELD[1][1]);
      var up = within(t, IN_TICKS, 0.12), down = within(t, OUT_TICKS, 0.1);
      flag('scroll', up || down, up ? 'up' : 'down');

      var n = t < TYPE_START ? 0 : Math.min(EMAIL.length, Math.floor((t - TYPE_START) / TYPE_STEP) + 1);
      setTyped(t < SENT ? EMAIL.slice(0, n) : '');
      flag('focus', t >= 1.4 && t < SENT);
      flag('press', t >= PRESS && t < SENT);
      flag('click', t >= PRESS && t < PRESS + 0.7);
      flag('sent', t >= SENT && t < LOOP - 0.5);

      var s = Math.floor(t);
      setText(timeEl, Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60));
      var line = LINES[0][1];
      for (var k = 0; k < LINES.length; k++) if (t >= LINES[k][0]) line = LINES[k][1];
      setText(gestureEl, typeof line === 'function' ? line() : line);
    }

    // One still frame for reduced motion: zoomed in on the invite row.
    function still() {
      var z = 2.2, half = 50 / z;
      var cx = clamp((geo.field.l + geo.send.x) / 2 + 0.6, half, 100 - half);
      var cy = clamp(geo.send.y + 6, half, 100 - half);
      setVars({ z: z, fx: cx - half, fy: cy - half, cx: geo.send.x, cy: geo.send.y });
      setZoomText(z);
      ['out', 'idle', 'ibeam', 'key', 'scroll', 'press', 'click', 'sent', 'focus'].forEach(function (n) { flag(n, false); });
      setTyped(EMAIL);
      setText(timeEl, '0:08');
      setText(gestureEl, 'Hold ' + keyGlyph('option') + ' and scroll up to zoom in');
    }

    var raf = 0, running = false, last = 0, userPaused = false, onScreen = true;

    function frame(now) {
      var dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      step(dt);
      raf = requestAnimationFrame(frame);
    }
    function start() {
      if (running || userPaused || !onScreen || motion.matches || document.hidden || !geo) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    function applyMotionPref() {
      if (motion.matches) {
        stop();
        still();
        if (pauseBtn) pauseBtn.hidden = true;
      } else {
        if (pauseBtn) pauseBtn.hidden = false;
        start();
      }
    }

    if (pauseBtn) {
      pauseBtn.addEventListener('click', function () {
        userPaused = !userPaused;
        pauseBtn.textContent = userPaused ? 'Play animation' : 'Pause animation';
        if (userPaused) stop(); else start();
      });
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        if (onScreen) start(); else stop();
      }, { threshold: 0.05 }).observe(demo);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    if (motion.addEventListener) motion.addEventListener('change', applyMotionPref);

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (measure() && motion.matches) still();
      }, 150);
    });

    var boot = function () {
      if (!measure()) return;
      if (motion.matches) {
        applyMotionPref();
      } else {
        reset();
        t = 0;
        setTyped('');
        step(0);
        applyMotionPref();
      }
    };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(boot, boot);
    else boot();
  }
})();
