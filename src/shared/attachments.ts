// Files embedded in a PDF — what may be done with one, decided in one place.
//
// A PDF can carry other files: in the catalog's /EmbeddedFiles name tree (the
// «Vedlegg» list in Acrobat) or behind a FileAttachment annotation (the
// paperclip on a page). Court filings send their exhibits this way, portfolios
// are nothing else, and an invoice can carry its own XML. Showing them is the
// easy half. Opening one is the classic way a PDF delivers malware, so the
// rules live here, dependency-free, where the renderer (which decides what to
// offer) and main (which does the opening, and re-checks rather than trusting
// the renderer) both import them — and where `npm run test:attachments` pins
// them down.
//
// Acrobat's model is a BLOCK list (executables, scripts, archives …) plus a
// "may contain programs or viruses — open anyway?" prompt for whatever is not
// on it. We do the stricter half only: an ALLOW list of plain document, data
// and media types, opened without a prompt, and everything else saved and
// never launched. A PDF attachment opens here, as a tab — Acrobat too opens
// those itself rather than handing them to the system.

/** Types the desktop app opens with the system's own program. Documents, data
 *  and media that carry no code of their own. Deliberately absent: anything
 *  executable or scripted (exe, msi, bat, cmd, ps1, js, vbs, hta, lnk, scr,
 *  jar …), archives (their contents would escape this check), web pages and
 *  SVG (script runs in whatever opens them), and the macro-enabled Office
 *  formats (docm, xlsm, xlsb, pptm, dotm, xltm, xlam …). The legacy binary
 *  Office formats stay in: exhibits arrive as .doc and .xls all the time, and
 *  Office's own macro policy applies to them — more so with the document's
 *  Mark of the Web attached (see `propagatedZoneIdentifier`). */
const OPENABLE = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'txt',
  'csv',
  'tsv',
  'md',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'webp',
  'heic',
  'mp3',
  'm4a',
  'wav',
  'mp4',
  'mov',
  'eml',
  'msg'
])

/** Media types for a download. A browser derives the saved file's extension
 *  from the type it is handed, and a wrong one is how a saved .xlsx arrives as
 *  `bilag.xlsx.txt` — octet-stream is the type it leaves alone. */
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4'
}

/** Windows' reserved device names: `CON.xlsx` cannot be created, and a write to
 *  it goes to the console instead. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Longest name we hand to a file system. Leaves room for the temp folder in
 *  front of it inside Windows' 260-character path limit. */
const MAX_NAME = 150

/** The attachment's name, made safe to show and to write to disk.
 *
 *  The name comes from the PDF, so it is whatever the author wanted it to be.
 *  Dropped: control characters, and the invisible format characters — above
 *  all the bidirectional overrides, which can make `rapport‮xcod.exe`
 *  DISPLAY as `rapportexe.docx`. Kept to the last path segment (a name is not
 *  a place to write to), Windows' forbidden characters replaced, trailing dots
 *  and spaces trimmed (Windows strips them itself, so the file on disk would
 *  not be the one we checked), a device name defused, and the length capped
 *  with the extension preserved. `fallback` stands in for a name with nothing
 *  left — the caller's language, which this module cannot know. */
export function cleanAttachmentName(raw: string, fallback = 'attachment'): string {
  let name = String(raw ?? '')
    // C0/C1 controls, then format characters: soft hyphen, zero-widths and the
    // LRM/RLM marks, the embedding/override/isolate controls, ALM, BOM.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[­؜​-‏‪-‮⁠-⁩﻿]/g, '')
  name = name.split(/[\\/]/).pop() ?? ''
  name = name.replace(/[<>:"|?*]/g, '_').trim().replace(/[. ]+$/, '')
  if (!name || /^\.+$/.test(name)) name = fallback
  if (RESERVED.test(name)) name = `_${name}`
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : ''
    name = name.slice(0, MAX_NAME - ext.length).trimEnd() + ext
  }
  return name
}

/** Lower-case extension without the dot, '' for none. Read from the CLEANED
 *  name — the one that will exist on disk, and the one Windows dispatches on. */
export function attachmentExtension(name: string): string {
  const clean = cleanAttachmentName(name)
  const dot = clean.lastIndexOf('.')
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

/** True when the attachment may be opened (rather than only saved). */
export function canOpenAttachment(name: string): boolean {
  return OPENABLE.has(attachmentExtension(name))
}

export function isPdfAttachment(name: string): boolean {
  return attachmentExtension(name) === 'pdf'
}

/** The name to try when `name` is already taken in a folder: «bilag (2).xlsx».
 *  n = 1 is the name itself. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
}

/** The media type to download the attachment under. */
export function attachmentMime(name: string): string {
  return MIME[attachmentExtension(name)] ?? 'application/octet-stream'
}

/** The Mark of the Web an attachment should carry, given the document's own.
 *
 *  Windows records where a downloaded file came from in a `Zone.Identifier`
 *  stream, and Office opens an internet-zone file in Protected View, with its
 *  macros blocked. A copy we write to the temp folder is a fresh file with no
 *  such stream — so without this, opening an attachment would quietly launder
 *  a file from an e-mail into one Office trusts. The attachment inherits the
 *  zone of the document it came in, the way Explorer marks what it unpacks
 *  from a downloaded zip. A document with no mark (made on this machine) gives
 *  its attachments none either; nothing is invented.
 *
 *  `source` is the document's stream as text, or null when it has none.
 *  Returns the stream to write, or null to write nothing. */
export function propagatedZoneIdentifier(source: string | null, sourcePath: string): string | null {
  if (!source) return null
  const m = /^\s*ZoneId\s*=\s*([0-4])\s*$/im.exec(source)
  if (!m) return null
  // ReferrerUrl names the container the file came out of, as Explorer writes
  // it for a zip. A path with a line break would forge further keys.
  const referrer = /[\r\n]/.test(sourcePath) ? '' : `ReferrerUrl=${sourcePath}\r\n`
  return `[ZoneTransfer]\r\nZoneId=${m[1]}\r\n${referrer}`
}
