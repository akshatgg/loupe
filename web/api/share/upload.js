'use strict';
// POST /api/share/upload -- Vercel Blob client-upload handshake (see _lib/share.js).
const { shareApi } = require('../_lib/runtime');

module.exports = (req, res) => shareApi().upload(req, res);
