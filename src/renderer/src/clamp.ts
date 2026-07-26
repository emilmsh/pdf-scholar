/** Constrain `v` to [min, max]. Trivial, but it had four private copies across
 *  the renderer — zoom.ts:clampZoom already showed the shared-constant pattern,
 *  this is the same idea for the general case. */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
