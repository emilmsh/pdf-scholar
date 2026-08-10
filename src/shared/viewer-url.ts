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
  const params = new URLSearchParams(href.slice(q + 1).split('#')[0])
  // An assistant tab's URL also carries file=, but it is not a VIEWER target —
  // the two parsers stay mutually exclusive (see parseAssistantTarget below).
  if (params.get(ASSISTANT_VIEW_PARAM) === ASSISTANT_VIEW) return null
  return params.get(FILE_PARAM) || null
}

/** A viewer URL for a document we already hold a path/URL for. */
export function buildViewerUrl(base: string, path: string): string {
  return path ? `${base}?${FILE_PARAM}=${encodeURIComponent(path)}` : base
}

// ---------- The detached assistant window/tab ----------
//
// The assistant can leave the panel and live in its own surface: a second
// BrowserWindow on the desktop, a second viewer.html tab in the extension, a
// second browser tab in dev:web. Which document that surface belongs to rides
// in its URL, in two forms mirroring the viewer's own pair:
//
//  • `#assistant=<enc>` — surfaces we open ourselves where a hash is the
//    natural channel (Electron's loadFile({ hash }), dev:web's `#open=` twin).
//  • `?view=assistant&file=<enc>` — the extension tab, where the hash is
//    already spoken for by picked-file names and the viewer URL is query-built.
//
// A `?rawfile=` URL is always the redirect rule's product and NEVER assistant
// mode — everything after that marker is the document URL verbatim, so it is
// checked (and rejected) before any query parsing.

export const ASSISTANT_HASH_KEY = 'assistant'
export const ASSISTANT_VIEW_PARAM = 'view'
export const ASSISTANT_VIEW = 'assistant'

/** Hash payload (without the '#') for a desktop/dev-web assistant window. */
export function buildAssistantHash(path: string): string {
  return `${ASSISTANT_HASH_KEY}=${encodeURIComponent(path)}`
}

/** Extension-tab URL that hosts the ASSISTANT for a document. */
export function buildAssistantUrl(base: string, path: string): string {
  return `${base}?${ASSISTANT_VIEW_PARAM}=${ASSISTANT_VIEW}&${FILE_PARAM}=${encodeURIComponent(path)}`
}

/** The document whose assistant this page should host, or null when the URL
 *  is a plain viewer target. Accepts both producer forms above. */
export function parseAssistantTarget(href: string): string | null {
  if (href.includes(`?${RAW_FILE_PARAM}=`)) return null
  const marker = `#${ASSISTANT_HASH_KEY}=`
  const hashAt = href.indexOf(marker)
  if (hashAt >= 0) {
    const raw = href.slice(hashAt + marker.length)
    try {
      return decodeURIComponent(raw) || null
    } catch {
      return raw || null // malformed escape: better an odd name than no window
    }
  }
  const q = href.indexOf('?')
  if (q < 0) return null
  const params = new URLSearchParams(href.slice(q + 1).split('#')[0])
  if (params.get(ASSISTANT_VIEW_PARAM) !== ASSISTANT_VIEW) return null
  return params.get(FILE_PARAM) || null
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
