// The icon Explorer shows next to .pdf files when PDF Scholar is their reader
// (issue #26). The installer registers a document icon of its own
// (build/pdf.ico, from scripts/pdf-document.svg) — not the app logo, which on
// every file in a folder read as branding rather than a file type. This module
// is the pure half of letting the reader change it: which registry value each
// choice means, and the names of the ways it can fail. The registry itself is
// touched in src/main/file-icon.ts; the renderer only ever sees the choice.
//
// Windows-only by nature (docs/PLATFORMS.md, divergence 27): macOS document
// icons live inside the app bundle, and the browser has no files.

/** The three document variants share one drawing (scripts/pdf-document.svg)
 *  and differ in colour: 'document' = red fold + red lines (the shipped
 *  default — red is the file type's colour, the way Acrobat, Edge and the
 *  desktop icon themes all use it; Emil, 2026-10-05), 'document-lines' = grey
 *  fold + red lines, 'document-quiet' = all grey. Then 'app' = the executable's
 *  icon, the app logo; 'custom' = an .ico of the reader's own. Offering the
 *  variants is the same spirit as offering custom: the file icon is the
 *  reader's call, not ours. */
export type FileIconChoice = 'document' | 'document-lines' | 'document-quiet' | 'app' | 'custom'

export const FILE_ICON_VARIANTS = ['document', 'document-lines', 'document-quiet'] as const
export const FILE_ICON_CHOICES: readonly FileIconChoice[] = [...FILE_ICON_VARIANTS, 'app', 'custom']

/** The ProgId electron-builder's NSIS script registers for .pdf — it is the
 *  `name` of the fileAssociations entry in config/electron-builder.yml, and
 *  test:file-icon asserts the two agree, because a rename there would leave
 *  this writing a key nothing reads. */
export const PDF_PROGID = 'PDF-dokument'

/** The DefaultIcon value under HKCU\Software\Classes\<ProgId> for a choice.
 *  `resourcesPath` is Electron's process.resourcesPath (the installer copies
 *  pdf.ico there — NsisTarget: `$INSTDIR\resources\<icon>`); `execPath` the
 *  running exe (`,0` = its first icon resource, the app logo). A custom choice
 *  with no file yields null — nothing to write. */
export function fileIconRegistryValue(
  choice: FileIconChoice,
  paths: { resourcesPath: string; execPath: string; customPath: string }
): string | null {
  switch (choice) {
    case 'document':
      return `${paths.resourcesPath}\\pdf.ico`
    // The other variants travel through extraResources to resources\file-icons\
    case 'document-lines':
    case 'document-quiet':
      return `${paths.resourcesPath}\\file-icons\\${choice}.ico`
    case 'app':
      return `${paths.execPath},0`
    case 'custom':
      return paths.customPath.trim() ? paths.customPath : null
    default:
      return `${paths.resourcesPath}\\pdf.ico`
  }
}

/** What the picker accepts: a ready .ico, or a square .png that main turns
 *  into one (few people have an .ico lying around; everyone has a PNG).
 *  Explorer reads icon resources from .exe/.dll too, but a picker that
 *  accepts programs is a picker that launches nothing and still looks like it
 *  might. Judged on the name's extension alone. */
export function iconSourceKind(name: string): 'ico' | 'png' | null {
  const n = name.trim()
  if (/\.ico$/i.test(n)) return 'ico'
  if (/\.png$/i.test(n)) return 'png'
  return null
}

export function isIcoName(name: string): boolean {
  return iconSourceKind(name) === 'ico'
}

/** The sizes a PNG is rendered into when it becomes an .ico — what Explorer
 *  draws in list, tile and large-icon views. A source smaller than the top
 *  size gets only the entries it can fill without upscaling. */
export const ICO_SIZES: readonly number[] = [16, 32, 48, 256]

/** Below this a PNG cannot even fill the 48 px tile view, and upscaling an
 *  icon is how blur gets onto every file in a folder. The tooltip recommends
 *  256 px. */
export const MIN_ICON_SOURCE_PX = 48

/** Pack PNG images into an ICO container: ICONDIR (6 bytes) + one
 *  ICONDIRENTRY (16 bytes) per image, then the PNG payloads back to back.
 *  Width/height bytes are 0 for 256 (the format's way of saying 256); larger
 *  entries are not legal ICO and are dropped. Pure bytes, so main can pack the
 *  reader's PNG and the test can check the header. (scripts/render-file-icon.cjs
 *  carries the same logic in CommonJS for the build-time icons.) */
export function packIco(entries: ReadonlyArray<{ size: number; png: Uint8Array }>): Uint8Array {
  const kept = entries.filter((e) => e.size <= 256)
  const dirLen = 16 * kept.length
  const total = 6 + dirLen + kept.reduce((n, e) => n + e.png.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true) // reserved
  view.setUint16(2, 1, true) // type: icon
  view.setUint16(4, kept.length, true)
  let offset = 6 + dirLen
  kept.forEach((e, i) => {
    const o = 6 + i * 16
    out[o] = e.size === 256 ? 0 : e.size
    out[o + 1] = e.size === 256 ? 0 : e.size
    out[o + 2] = 0 // palette
    out[o + 3] = 0 // reserved
    view.setUint16(o + 4, 1, true) // planes
    view.setUint16(o + 6, 32, true) // bpp
    view.setUint32(o + 8, e.png.length, true)
    view.setUint32(o + 12, offset, true)
    out.set(e.png, offset)
    offset += e.png.length
  })
  return out
}

export type FileIconErrorCode =
  /** Not a Windows install we registered: macOS/Linux, the portable zip (it
   *  registers nothing), the Store build (MSIX associations are virtualized),
   *  or a dev run */
  | 'file-icon-unavailable'
  /** The chosen file is neither an .ico nor a readable .png */
  | 'file-icon-bad-file'
  /** A PNG that is not square — an icon is, and stretching one is not ours to do */
  | 'file-icon-not-square'
  /** A PNG under MIN_ICON_SOURCE_PX */
  | 'file-icon-too-small'
  /** reg.exe refused the write — the detail travels as prose */
  | 'file-icon-registry'

const FILE_ICON_ERROR_CODES: ReadonlySet<string> = new Set<FileIconErrorCode>([
  'file-icon-unavailable',
  'file-icon-bad-file',
  'file-icon-not-square',
  'file-icon-too-small',
  'file-icon-registry'
])

export function isFileIconErrorCode(code: string): code is FileIconErrorCode {
  return FILE_ICON_ERROR_CODES.has(code)
}

export type FileIconResult =
  | { ok: true; fileIcon: FileIconChoice; fileIconPath: string }
  /** The reader closed the file picker — not an error, nothing changed */
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; code: FileIconErrorCode; error: string }
