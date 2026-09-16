/* Share viewer: /v/<id> is rewritten to v.html (vercel.json), and this
   script asks /api/share/<id> what to play. */
(function () {
  'use strict';

  var ID_RE = /^[A-Za-z0-9_-]{16}$/;
  var RETRY_MS = 5000;
  var MAX_RETRIES = 36; // about three minutes of "still uploading"

  var player = document.querySelector('.share__player');
  var frame = document.querySelector('[data-frame]');
  var retries = 0;

  var id = decodeURIComponent(location.pathname.replace(/\/+$/, '').split('/').pop() || '');
  if (!ID_RE.test(id)) {
    notice('This link doesn’t work', 'Check that you copied the whole link.');
    return;
  }
  load();

  function load() {
    fetch('/api/share/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { status: res.status, body: body };
        });
      })
      .then(function (r) {
        if (r.status === 200 && r.body.ready) return show(r.body);
        if (r.status === 200) return waitForUpload();
        if (r.status === 404) return notice('This link doesn’t work', 'It may have been typed wrong, or the recording was removed.');
        if (r.status === 410) return notice('This link has expired', 'Shared recordings are available for 7 days. Ask the person who sent it to share it again.');
        if (r.status === 503) return notice('Sharing is taking a break', 'Please try again later.');
        notice('Something went wrong', 'Please reload the page to try again.');
      })
      .catch(function () {
        notice('Can’t load this recording', 'Check your internet connection, then reload the page.');
      });
  }

  function waitForUpload() {
    if (retries++ >= MAX_RETRIES) {
      notice('This recording isn’t ready', 'It may not have finished uploading. Ask the person who sent it to share it again.');
      return;
    }
    frame.querySelector('[data-loading]').textContent = 'Still uploading. This page will update by itself…';
    setTimeout(load, RETRY_MS);
  }

  function show(info) {
    var title = info.title || 'Screen recording';
    document.title = title + ' · Loupe';

    var media;
    if (info.contentType === 'image/gif') {
      media = document.createElement('img');
      media.alt = title;
    } else {
      media = document.createElement('video');
      media.controls = true;
      media.playsInline = true;
      media.preload = 'metadata';
      var source = document.createElement('source');
      source.src = info.url;
      source.type = info.contentType;
      media.appendChild(source);
    }
    if (info.width && info.height) {
      media.width = info.width;
      media.height = info.height;
      frame.setAttribute('data-sized', '');
    }
    if (media.tagName === 'IMG') media.src = info.url;
    frame.textContent = '';
    frame.appendChild(media);

    document.querySelector('[data-title]').textContent = title;
    document.querySelector('[data-expires]').textContent = expiresText(info.expiresInDays);
    var details = detailsText(info);
    document.querySelector('[data-details]').textContent = details;
    document.querySelector('.share__dot').hidden = !details;
    document.querySelector('[data-download]').href = info.downloadUrl || info.url;
    document.querySelector('[data-ready]').hidden = false;
    player.setAttribute('data-state', 'ready');
  }

  function notice(title, text) {
    document.title = title + ' · Loupe';
    document.querySelector('[data-notice-title]').textContent = title;
    document.querySelector('[data-notice-text]').textContent = text;
    document.querySelector('[data-notice]').hidden = false;
    player.setAttribute('data-state', 'notice');
  }

  function expiresText(days) {
    if (!(days > 1)) return 'Expires within a day';
    return 'Expires in ' + days + ' days';
  }

  function detailsText(info) {
    var parts = [];
    if (info.duration) parts.push(formatDuration(info.duration));
    if (info.size) parts.push(formatSize(info.size));
    if (info.createdAt) {
      try {
        parts.push('Shared ' + new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
          .format(new Date(info.createdAt)));
      } catch { /* an unusual locale is no reason to fail */ }
    }
    return parts.join(' · ');
  }

  function formatDuration(s) {
    s = Math.round(s);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }
})();
