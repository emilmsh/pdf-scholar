// How the extension viewer page learns which document to open.
//
// The document URL rides in the viewer page's own URL, and the two producers
// cannot agree on an encoding:
//
//  • `?rawfile=` — the background redirect rule. declarativeNetRequest folds the
//    matched URL in with `regexSubstitution`, which has no way to percent-encode
//    it, so the URL lands VERBATIM. Reading that back with URLSearchParams is
//    silently wrong: an `&` in the document URL (`report.pdf?utm_source=x&sig=y`
//    — every signed CDN link, and every link ChatGPT hands out) starts a new
//    param and the rest is lost, `+` decodes to a space, and a trailing `#page=2`
//    becomes the viewer page's own fragment. The rule puts this param LAST, so
//    the fix is to not parse at all: everything after `?rawfile=` is the document
//    URL, byte for byte.
//  • `?file=` — links we build ourselves (a new tab, the address-bar rewrite),
//    where encodeURIComponent is available. These also carry `fsa:` pseudo-paths
//    and Windows `file:` paths, which only survive round-tripping when encoded.
//
// Producer and consumer live in different build targets (service worker vs
// renderer), so both the param names and the parsing belong here, together.

export const RAW_FILE_PARAM = 'rawfile'
export const FILE_PARAM = 'file'

/** The document a viewer-page URL points at, or null for a bare viewer (the
 *  welcome screen). Accepts both param forms; see the note above. */
export function parseViewerTarget(href: string): string | null {
  const marker = `?${RAW_FILE_PARAM}=`
  const raw = href.indexOf(marker)
  if (raw >= 0) {
    // Chrome carries the original navigation's fragment across the redirect, so a
    // citation link (`report.pdf#page=12`) arrives with it attached. Nothing
    // consumes anchors yet, and keeping it would fork the document's identity:
    // recents and the saved reading position are keyed by this string, so the
    // same file linked with and without an anchor would become two documents.
    // Whoever teaches the viewer to honour `#page=` should return it separately.
    const url = href.slice(raw + marker.length)
    return url.split('#')[0] || null
  }

  const q = href.indexOf('?')
  if (q < 0) return null
  // Our own links are properly encoded, so ordinary query parsing is correct —
  // and the value never contains a fragment.
  return new URLSearchParams(href.slice(q + 1).split('#')[0]).get(FILE_PARAM) || null
}

/** A viewer URL for a document we already hold a path/URL for. */
export function buildViewerUrl(base: string, path: string): string {
  return path ? `${base}?${FILE_PARAM}=${encodeURIComponent(path)}` : base
}

/** Display name for a document URL: its last path segment, with the query and
 *  fragment cut off first — `paper.pdf?utm_source=chatgpt.com` is not a file
 *  name. Decoding is best-effort: a stray `%` in the wild must not throw. */
export function fileNameFromUrl(url: string): string {
  const bare = url.split(/[?#]/)[0]
  const tail = bare.split(/[/\\]/).pop() || bare
  try {
    return decodeURIComponent(tail)
  } catch {
    return tail
  }
}
