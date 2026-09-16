// Layer 6: keystroke badges (sources.<key>.keys, style.keystrokes).
//
// Extension point: registered in compose.js in its final place in the draw
// order, drawing nothing yet. The feature that owns it replaces draw() and
// keeps the signature, so the preview and every export pick it up.

export const name = 'keystrokes';

// draw(ctx, state): see compose.js for what `state` holds.
export function draw() {}
