/** Read-aloud is hidden until we have a voice worth shipping: Chromium on
 *  Windows only exposes the legacy SAPI5 voices to speechSynthesis (the
 *  Windows 11 "natural" voices are Narrator-only and never appear), so the
 *  desktop app reads with a robot voice — and falls back to a Norwegian voice
 *  on English papers when no English SAPI voice is installed. Edge's natural
 *  voices make the extension sound fine, but we hide it on ALL platforms for
 *  parity until a local neural TTS (e.g. Piper) replaces it.
 *
 *  Re-enable with `?readaloud=1` in the URL (dev:web) or
 *  `localStorage.setItem('pdfx-read-aloud', '1')` + reload (Electron/extension).
 */
export const READ_ALOUD = (() => {
  try {
    return (
      new URLSearchParams(window.location.search).get('readaloud') === '1' ||
      window.localStorage.getItem('pdfx-read-aloud') === '1'
    )
  } catch {
    return false
  }
})()
