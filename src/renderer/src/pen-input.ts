// Pen proximity, app-wide. Windows pens report hover from ~5–10 mm above the
// glass, so pen pointer events arrive BEFORE the tip (or a palm) touches —
// which is what makes both of these work:
//
//  - touch-action switching: `touch-action` cannot tell a pen from a finger
//    (both are direct-manipulation pointers on Windows), so the draw layer
//    allows finger panning by default and flips to `none` via html.pen-near
//    while a pen is in range — the pen draws, the finger scrolls.
//  - palm rejection: a touch that lands while the pen is in range is a palm,
//    never an intent, whatever the finger-draw preference says. The OS
//    suppresses most of these; this catches the rest.
//
// The listener lives in PdfViewer (one per window); this module is the shared
// clock so per-page event handlers can ask without threading a prop through.

let lastPenAt = -Infinity

/** How long the pen stays "near" after its last event. Long enough to bridge
 *  hover dropouts mid-writing, short enough that putting the pen down and
 *  swiping with a finger doesn't feel dead. */
export const PEN_NEAR_MS = 700

export function notePenEvent(): void {
  lastPenAt = performance.now()
}

export function penNear(): boolean {
  return performance.now() - lastPenAt < PEN_NEAR_MS
}
