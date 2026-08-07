// html.touch-ui — the switch behind every finger-sized-target CSS rule
// (see the Touch UI section of app.css).
//
// Why a runtime class and not @media (pointer: coarse): the media query looks
// at the PRIMARY pointer, and a Surface with its Type Cover attached has a
// fine one — the touch adaptations would never fire on the machine they were
// made for. Windows apps solve this by following the input actually in use;
// so does this: coarse primary pointer → on from the start (a true tablet),
// then every touch turns it on and every mouse or pen press turns it off.
// Pen counts as fine — it hits 15 px targets better than a mouse does.

export function initTouchUi(): void {
  const el = document.documentElement
  el.classList.toggle('touch-ui', window.matchMedia('(pointer: coarse)').matches)
  const follow = (e: PointerEvent): void => {
    el.classList.toggle('touch-ui', e.pointerType === 'touch')
  }
  window.addEventListener('pointerdown', follow, { capture: true, passive: true })
}
