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
 *  name. Empty when the path has no last segment (`https://host/download/`),
 *  which is a caller's cue to name the document some other way. Decoding is
 *  best-effort: a stray `%` in the wild must not throw. */
export function fileNameFromUrl(url: string): string {
  const tail = basename(url.split(/[?#]/)[0])
  try {
    return decodeURIComponent(tail)
  } catch {
    return tail
  }
}

/** The name a response declares in `Content-Disposition`, if any. Handles the
 *  RFC 5987 `filename*=UTF-8''…` form (preferred — it can carry non-ASCII) and
 *  the plain quoted or bare `filename=`. Any path is stripped: the value comes
 *  from a server and only ever gets shown or suggested in a save dialog. */
export function fileNameFromDisposition(disposition: string | null | undefined): string | null {
  if (!disposition) return null
  const encoded = /filename\*\s*=\s*[^';]*'[^']*'([^;]+)/i.exec(disposition)
  if (encoded) {
    try {
      const name = basename(decodeURIComponent(encoded[1].trim()))
      if (name) return name
    } catch {
      // Malformed escape — fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition)
  return basename((plain?.[1] ?? plain?.[2] ?? '').trim()) || null
}

/** A document name worth showing for a PDF we opened from a URL. Now that the
 *  content-type rule intercepts PDFs the URL says nothing about, the last path
 *  segment is often useless on its own (`/pdf/2401.12345`, `Delivery.cfm`), so
 *  prefer the name the response declares and make sure what we end up with reads
 *  as a PDF — it becomes the tab title, the recents row and the suggested name in
 *  the save dialog. */
export function pdfDisplayName(url: string, disposition?: string | null): string {
  const base = fileNameFromDisposition(disposition) || fileNameFromUrl(url) || hostOf(url)
  if (!base) return 'PDF'
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`
}

function basename(name: string): string {
  return name.split(/[/\\]/).pop() ?? name
}

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)
  return m ? m[1] : ''
}
