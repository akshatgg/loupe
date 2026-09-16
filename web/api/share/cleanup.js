'use strict';
// GET /api/share/cleanup -- run daily by Vercel Cron (web/vercel.json).
const { shareApi } = require('../_lib/runtime');

module.exports = (req, res) => shareApi().cleanup(req, res);
