// Colour lookup tables, as colourists hand them out: Adobe/Resolve .cube
// files ("LUT_3D_SIZE n", then n³ lines of "r g b", red changing fastest).
//
//   parseCube(text) -> { title, size, data: Float32Array(n³·3), min, max }
//   sampleLut(lut, r, g, b) -> [r, g, b]  (0..1, trilinear)
//
// The export and the preview grade a clip's frames on the GPU with the same
// table (layers/lut-gl.js); sampleLut is the reference and the fallback.

const MAX_SIZE = 128;

export function parseCube(text) {
  let size = 0;
  let title = '';
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^TITLE\b/i.test(line)) { title = line.replace(/^TITLE\s*/i, '').replace(/^"|"$/g, ''); continue; }
    if (/^LUT_1D_SIZE\b/i.test(line)) throw new Error('That LUT is a 1D table; Loupe reads 3D .cube LUTs.');
    if (/^LUT_3D_SIZE\b/i.test(line)) {
      size = Number(line.split(/\s+/)[1]);
      if (!Number.isInteger(size) || size < 2 || size > MAX_SIZE) throw new Error(`That LUT's size (${line.split(/\s+/)[1]}) isn't one Loupe can use (2 to ${MAX_SIZE}).`);
      continue;
    }
    if (/^DOMAIN_MIN\b/i.test(line)) { min = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (/^DOMAIN_MAX\b/i.test(line)) { max = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]+\b/i.test(line) && !/^[-\d.]/.test(line)) continue; // other keywords
    const nums = line.split(/\s+/).map(Number);
    if (nums.length >= 3 && nums.slice(0, 3).every(Number.isFinite)) values.push(nums[0], nums[1], nums[2]);
  }
  if (!size) throw new Error('That file isn’t a 3D .cube LUT.');
  const count = size ** 3;
  if (values.length / 3 !== count) throw new Error(`That LUT should have ${count} colours but has ${values.length / 3}.`);
  return { title, size, data: Float32Array.from(values), min, max };
}

export function sampleLut(lut, r, g, b) {
  const { size, data, min, max } = lut;
  const n = size - 1;
  const at = (v, k) => Math.min(n, Math.max(0, ((v - min[k]) / (max[k] - min[k])) * n));
  const x = at(r, 0);
  const y = at(g, 1);
  const z = at(b, 2);
  const x0 = Math.floor(x); const y0 = Math.floor(y); const z0 = Math.floor(z);
  const x1 = Math.min(n, x0 + 1); const y1 = Math.min(n, y0 + 1); const z1 = Math.min(n, z0 + 1);
  const fx = x - x0; const fy = y - y0; const fz = z - z0;
  const idx = (i, j, k) => 3 * (i + size * (j + size * k));
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = (i, j, k) => data[idx(i, j, k) + c];
    const c00 = v(x0, y0, z0) * (1 - fx) + v(x1, y0, z0) * fx;
    const c10 = v(x0, y1, z0) * (1 - fx) + v(x1, y1, z0) * fx;
    const c01 = v(x0, y0, z1) * (1 - fx) + v(x1, y0, z1) * fx;
    const c11 = v(x0, y1, z1) * (1 - fx) + v(x1, y1, z1) * fx;
    out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  return out;
}
