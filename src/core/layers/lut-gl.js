// A clip's frame graded through its LUT (look.js color.lut), on the GPU:
// WebGL2 samples the 3D table for every pixel, blended with the original by
// `mix`, into a canvas the frame layer then draws in the frame's place (so
// the camera's crop and the clip's placing still apply). Without WebGL2
// (never in Chromium; a test runner) it grades on the CPU with lut.js.
//
// The same pass does the clip's finer colour tools first (grade.js: warmth,
// tint, shadows, highlights, the curve -- gradePixel is what the shader
// mirrors) and sharpens last; with those and no LUT, the LUT's part is
// skipped.
//
//   gradeFrame(frame, lut, mix, color) -> a canvas the frame's size, or null
//     lut: a parsed .cube or null; color: the clip's colour or null.

import { sampleLut } from '../lut.js';
import { needsGrade, whiteBalance, curvePoints, curveTable, isIdentityCurve, gradePixel, LUMA, TONE_REACH, SHARPEN_REACH } from '../grade.js';

const VERTEX = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2((p.x + 1.0) / 2.0, 1.0 - (p.y + 1.0) / 2.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D img;
uniform sampler3D lut;
uniform float amount;
uniform float size;
uniform vec3 dmin;
uniform vec3 dmax;
// grade.js: white balance, shadows / highlights, the curve, sharpening.
uniform vec3 gains;
uniform float shadows;
uniform float highlights;
uniform sampler2D curve;
uniform float useCurve;
uniform float sharpen;
uniform vec2 texel;
in vec2 uv;
out vec4 color;
float curved(float v) {
  return texture(curve, vec2(v * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).r;
}
void main() {
  vec4 c = texture(img, uv);
  vec3 g = c.rgb * gains;
  float l = clamp(dot(g, vec3(${LUMA.join(', ')})), 0.0, 1.0);
  g += ${TONE_REACH.toFixed(4)} * (shadows * (1.0 - l) * (1.0 - l) + highlights * l * l);
  g = clamp(g, 0.0, 1.0);
  if (useCurve > 0.5) g = vec3(curved(g.r), curved(g.g), curved(g.b));
  if (amount > 0.0) {
    vec3 x = clamp((g - dmin) / (dmax - dmin), 0.0, 1.0);
    vec3 graded = texture(lut, x * (size - 1.0) / size + 0.5 / size).rgb;
    g = mix(g, graded, amount);
  }
  if (sharpen > 0.0) {
    // Unsharp: what this pixel has that the four beside it don't, added back.
    vec3 around = (texture(img, uv + vec2(texel.x, 0.0)).rgb + texture(img, uv - vec2(texel.x, 0.0)).rgb +
      texture(img, uv + vec2(0.0, texel.y)).rgb + texture(img, uv - vec2(0.0, texel.y)).rgb) / 4.0;
    g = clamp(g + sharpen * ${SHARPEN_REACH.toFixed(4)} * (c.rgb - around), 0.0, 1.0);
  }
  color = vec4(g, 1.0);
}`;

// With no LUT loaded: a table that changes nothing, mixed in at 0.
const NO_LUT = { size: 2, min: [0, 0, 0], max: [1, 1, 1], data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]) };

let gpu; // { canvas, gl, program, uniforms, luts: WeakMap } | null once it failed

function setUp() {
  if (gpu !== undefined) return gpu;
  gpu = null;
  if (typeof globalThis.OffscreenCanvas !== 'function') return gpu;
  const canvas = new globalThis.OffscreenCanvas(2, 2);
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) return gpu;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uniforms = Object.fromEntries(['img', 'lut', 'amount', 'size', 'dmin', 'dmax',
    'gains', 'shadows', 'highlights', 'curve', 'useCurve', 'sharpen', 'texel'].map((n) => [n, gl.getUniformLocation(program, n)]));
  gl.uniform1i(uniforms.img, 0);
  gl.uniform1i(uniforms.lut, 1);
  gl.uniform1i(uniforms.curve, 2);
  // The curve as a row of 256 heights, filled in when a clip has one.
  const curve = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, curve);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 256, 1, 0, gl.RED, gl.FLOAT, curveTable(null));
  const image = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, image);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gpu = { canvas, gl, uniforms, luts: new WeakMap(), curve, curveOf: null };
  return gpu;
}

// The table as a 3D texture, once per LUT.
function lutTexture({ gl, luts }, lut) {
  let tex = luts.get(lut);
  if (tex) return tex;
  tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
  gl.activeTexture(gl.TEXTURE0);
  luts.set(lut, tex);
  return tex;
}

function pixelSize(frame) {
  const w = frame?.displayWidth ?? frame?.videoWidth ?? frame?.naturalWidth ?? frame?.width;
  const h = frame?.displayHeight ?? frame?.videoHeight ?? frame?.naturalHeight ?? frame?.height;
  return w > 0 && h > 0 ? { w, h } : null;
}

// The clip's curve in its texture (only when it is another than last time).
function useCurve(g, color) {
  const { gl, uniforms } = g;
  if (isIdentityCurve(color?.curve)) {
    gl.uniform1f(uniforms.useCurve, 0);
    return;
  }
  const points = curvePoints(color.curve);
  if (g.curveOf !== points) {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, g.curve);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.FLOAT, curveTable(points));
    g.curveOf = points;
  }
  gl.uniform1f(uniforms.useCurve, 1);
}

export function gradeFrame(frame, lut, mix = 1, color = null) {
  const px = pixelSize(frame);
  const grade = needsGrade(color) ? color : null;
  if (!px || (!lut && !grade)) return null;
  let g = null;
  try {
    g = setUp();
  } catch (err) {
    console.warn('Loupe: LUTs fall back to the CPU:', err.message);
    gpu = null;
  }
  if (!g) return gradeOnCpu(frame, lut, mix, px, grade);
  const { gl, canvas, uniforms } = g;
  if (canvas.width !== px.w || canvas.height !== px.h) {
    canvas.width = px.w;
    canvas.height = px.h;
  }
  gl.viewport(0, 0, px.w, px.h);
  const table = lut ?? NO_LUT;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTexture(g, table));
  useCurve(g, grade);
  gl.activeTexture(gl.TEXTURE0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.uniform1f(uniforms.amount, lut ? Math.max(0, Math.min(1, mix)) : 0);
  gl.uniform1f(uniforms.size, table.size);
  gl.uniform3fv(uniforms.dmin, table.min);
  gl.uniform3fv(uniforms.dmax, table.max);
  gl.uniform3fv(uniforms.gains, whiteBalance(grade?.temperature ?? 0, grade?.tint ?? 0));
  gl.uniform1f(uniforms.shadows, grade?.shadows ?? 0);
  gl.uniform1f(uniforms.highlights, grade?.highlights ?? 0);
  gl.uniform1f(uniforms.sharpen, grade?.sharpen ?? 0);
  gl.uniform2f(uniforms.texel, 1 / px.w, 1 / px.h);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}

let cpuCanvas = null;
function gradeOnCpu(frame, lut, mix, { w, h }, grade) {
  if (typeof globalThis.OffscreenCanvas !== 'function') return null;
  if (!cpuCanvas || cpuCanvas.width !== w || cpuCanvas.height !== h) cpuCanvas = new globalThis.OffscreenCanvas(w, h);
  const ctx = cpuCanvas.getContext('2d');
  ctx.drawImage(frame, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let px = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
    if (grade) px = gradePixel(px, grade);
    const [r, g, b] = lut ? sampleLut(lut, px[0], px[1], px[2]) : px;
    const m = lut ? mix : 1;
    d[i] = Math.round((px[0] * (1 - m) + r * m) * 255);
    d[i + 1] = Math.round((px[1] * (1 - m) + g * m) * 255);
    d[i + 2] = Math.round((px[2] * (1 - m) + b * m) * 255);
  }
  ctx.putImageData(img, 0, 0);
  return cpuCanvas;
}
