// A clip's frame graded through its LUT (look.js color.lut), on the GPU:
// WebGL2 samples the 3D table for every pixel, blended with the original by
// `mix`, into a canvas the frame layer then draws in the frame's place (so
// the camera's crop and the clip's placing still apply). Without WebGL2
// (never in Chromium; a test runner) it grades on the CPU with lut.js.
//
//   gradeFrame(frame, lut, mix) -> a canvas the frame's size, or null

import { sampleLut } from '../lut.js';

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
in vec2 uv;
out vec4 color;
void main() {
  vec4 c = texture(img, uv);
  vec3 x = clamp((c.rgb - dmin) / (dmax - dmin), 0.0, 1.0);
  vec3 graded = texture(lut, x * (size - 1.0) / size + 0.5 / size).rgb;
  color = vec4(mix(c.rgb, graded, amount), 1.0);
}`;

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
  const uniforms = Object.fromEntries(['img', 'lut', 'amount', 'size', 'dmin', 'dmax'].map((n) => [n, gl.getUniformLocation(program, n)]));
  gl.uniform1i(uniforms.img, 0);
  gl.uniform1i(uniforms.lut, 1);
  const image = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, image);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gpu = { canvas, gl, uniforms, luts: new WeakMap() };
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

export function gradeFrame(frame, lut, mix = 1) {
  const px = pixelSize(frame);
  if (!px || !lut) return null;
  let g = null;
  try {
    g = setUp();
  } catch (err) {
    console.warn('Loupe: LUTs fall back to the CPU:', err.message);
    gpu = null;
  }
  if (!g) return gradeOnCpu(frame, lut, mix, px);
  const { gl, canvas, uniforms } = g;
  if (canvas.width !== px.w || canvas.height !== px.h) {
    canvas.width = px.w;
    canvas.height = px.h;
  }
  gl.viewport(0, 0, px.w, px.h);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTexture(g, lut));
  gl.activeTexture(gl.TEXTURE0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.uniform1f(uniforms.amount, Math.max(0, Math.min(1, mix)));
  gl.uniform1f(uniforms.size, lut.size);
  gl.uniform3fv(uniforms.dmin, lut.min);
  gl.uniform3fv(uniforms.dmax, lut.max);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}

let cpuCanvas = null;
function gradeOnCpu(frame, lut, mix, { w, h }) {
  if (typeof globalThis.OffscreenCanvas !== 'function') return null;
  if (!cpuCanvas || cpuCanvas.width !== w || cpuCanvas.height !== h) cpuCanvas = new globalThis.OffscreenCanvas(w, h);
  const ctx = cpuCanvas.getContext('2d');
  ctx.drawImage(frame, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = sampleLut(lut, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    d[i] = Math.round((d[i] / 255 * (1 - mix) + r * mix) * 255);
    d[i + 1] = Math.round((d[i + 1] / 255 * (1 - mix) + g * mix) * 255);
    d[i + 2] = Math.round((d[i + 2] / 255 * (1 - mix) + b * mix) * 255);
  }
  ctx.putImageData(img, 0, 0);
  return cpuCanvas;
}
