// An overlay's picture through its green screen (overlay-effects.js key), on
// the GPU: WebGL2 measures every pixel's chroma against the key colour's and
// makes the near ones see-through, into a canvas the overlay layer then
// draws in the picture's place. Built like lut-gl.js. Without WebGL2 (never
// in Chromium; a test runner) there is no keying: the caller draws the
// picture as it is.
//
//   keyFrame(frame, key) -> a canvas the picture's size, or null

import { hexToRgb, chroma, keyRange, CB, CR } from '../overlay-effects.js';

const VERTEX = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2((p.x + 1.0) / 2.0, 1.0 - (p.y + 1.0) / 2.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// keyAlpha (overlay-effects.js), per pixel. The canvas is premultiplied.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D img;
uniform vec2 key;
uniform float inner;
uniform float outer;
in vec2 uv;
out vec4 color;
void main() {
  vec4 c = texture(img, uv);
  vec2 cc = vec2(dot(c.rgb, vec3(${CB.join(', ')})), dot(c.rgb, vec3(${CR.join(', ')})));
  float a = smoothstep(inner, outer, distance(cc, key)) * c.a;
  color = vec4(c.rgb * a, a);
}`;

let gpu; // { canvas, gl, uniforms } | null once it failed

function setUp() {
  if (gpu !== undefined) return gpu;
  gpu = null;
  if (typeof globalThis.OffscreenCanvas !== 'function') return gpu;
  const canvas = new globalThis.OffscreenCanvas(2, 2);
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
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
  const uniforms = Object.fromEntries(['img', 'key', 'inner', 'outer'].map((n) => [n, gl.getUniformLocation(program, n)]));
  gl.uniform1i(uniforms.img, 0);
  const image = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, image);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.disable(gl.BLEND);
  gpu = { canvas, gl, uniforms };
  return gpu;
}

function pixelSize(frame) {
  const w = frame?.displayWidth ?? frame?.videoWidth ?? frame?.naturalWidth ?? frame?.width;
  const h = frame?.displayHeight ?? frame?.videoHeight ?? frame?.naturalHeight ?? frame?.height;
  return w > 0 && h > 0 ? { w, h } : null;
}

export function keyFrame(frame, key) {
  const px = pixelSize(frame);
  if (!px || !key?.on) return null;
  let g = null;
  try {
    g = setUp();
  } catch (err) {
    console.warn('Loupe: the green screen is off (no GPU):', err.message);
    gpu = null;
  }
  if (!g) return null;
  const { gl, canvas, uniforms } = g;
  if (canvas.width !== px.w || canvas.height !== px.h) {
    canvas.width = px.w;
    canvas.height = px.h;
  }
  try {
    gl.viewport(0, 0, px.w, px.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    const { inner, outer } = keyRange(key);
    gl.uniform2fv(uniforms.key, chroma(hexToRgb(key.color)));
    gl.uniform1f(uniforms.inner, inner);
    gl.uniform1f(uniforms.outer, outer);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } catch {
    // A picture the GPU can't take (not decoded yet): drawn as it is.
    return null;
  }
  return canvas;
}
