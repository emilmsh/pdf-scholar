/** True on macOS — in the Electron renderer and the plain-browser/extension
 *  targets alike (Electron reports MacIntel on Apple Silicon too). */
export const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform)

/** The platform's primary command modifier: Cmd on macOS, Ctrl elsewhere.
 *  Use for keyboard SHORTCUTS only — ctrl+wheel zoom must keep testing
 *  ctrlKey on every platform (trackpad pinch arrives as ctrl+wheel, also
 *  on macOS), and Ctrl+Tab cycling is the mac convention as well (Cmd+Tab
 *  is the OS app switcher). */
export function primaryMod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}
