// Layer 7: the webcam bubble (sources.<key>.webcam, style.webcam).
//
// Extension point: registered in compose.js in its final place in the draw
// order, drawing nothing yet. The feature that owns it replaces draw() and
// keeps the signature, so the preview and every export pick it up.

export const name = 'webcam';

// draw(ctx, state): see compose.js for what `state` holds.
export function draw() {}
