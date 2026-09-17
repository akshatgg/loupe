'use strict';
// GET /api/share/<id> -> what the viewer page at /v/<id> needs to play a share.
const { shareApi } = require('../_lib/runtime');

module.exports = (req, res) => shareApi().meta(req, res);
