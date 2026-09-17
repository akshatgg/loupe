'use strict';
// The one place the real @vercel/blob SDK is loaded. Required lazily so a
// cold start only pays for it when an endpoint actually touches the store.
const { createShareApi } = require('./share');

let api = null;

function shareApi() {
  if (!api) {
    const { put, list, del } = require('@vercel/blob');
    const { handleUpload } = require('@vercel/blob/client');
    api = createShareApi({ blob: { put, list, del, handleUpload } });
  }
  return api;
}

module.exports = { shareApi };
