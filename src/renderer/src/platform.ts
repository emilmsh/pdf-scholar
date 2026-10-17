/** True on macOS — in the Electron renderer and the plain-browser/extension
 *  targets alike (Electron reports MacIntel on Apple Silicon too). */
export const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform)

/** The platform's primary command modifier: Cmd on macOS, Ctrl elsewhere.
 *  Use for keyboard SHORTCUTS only — wheel zoom goes through isZoomWheel
 *  below, and Ctrl+Tab cycling is the mac convention as well (Cmd+Tab is
 *  the OS app switcher). */
export function primaryMod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/** A wheel event that zooms the pages. Ctrl+wheel on every platform — a
 *  trackpad pinch arrives as ctrl+wheel, on macOS too, so ctrlKey can never be
 *  swapped out — plus Cmd+wheel on macOS, which is how a mouse zooms there
 *  (Preview, PDF Expert); Ctrl+wheel is often taken by the OS's own screen
 *  zoom before the app sees it. */
export function isZoomWheel(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || (isMac && e.metaKey)
}

// Text fields that stop keydown propagation (composer, popovers, the search
// field itself) must still let the app's own shortcuts bubble — that used to be
// an isFindHotkey() test for Ctrl+F alone. It now lives in keymap.ts as
// `bubblesWhileTyping`, which asks the CURRENT bindings, so a rebound find (or
// save, or zoom) gets through too.
