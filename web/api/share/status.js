'use strict';
// GET /api/share/status -> { enabled, maxBytes, expiresInDays, contentTypes }
// Needs no Blob SDK: it only reports whether the store is configured.
const { createShareApi } = require('../_lib/share');

const api = createShareApi({ blob: null });

module.exports = (req, res) => api.status(req, res);
