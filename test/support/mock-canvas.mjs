// A 2D context that records every call and property write, for checking
// what compose.js draws without a real canvas.

export function mockContext() {
  const calls = [];
  const state = { fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, lineWidth: 1,
    shadowColor: 'rgba(0, 0, 0, 0)', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, lineJoin: 'miter' };
  const stack = [];
  let depth = 0;
  const record = (name) => (...args) => {
    calls.push({ name, args, state: { ...state }, depth });
    if (name === 'save') { stack.push({ ...state }); depth++; }
    if (name === 'restore') { Object.assign(state, stack.pop()); depth--; }
    if (name === 'createLinearGradient') {
      const stops = [];
      return { kind: 'linear', args, stops, addColorStop: (o, c) => stops.push([o, c]) };
    }
    return undefined;
  };
  const target = {
    calls,
    get depth() { return depth; },
    named: (name) => calls.filter((c) => c.name === name)
  };
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key];
      if (key in state) return state[key];
      return record(key);
    },
    set(_obj, key, value) {
      state[key] = value;
      calls.push({ name: `set:${String(key)}`, args: [value], depth });
      return true;
    }
  });
}
