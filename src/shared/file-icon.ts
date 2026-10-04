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

/** 'document' = the installer's own icon (the shipped default); 'app' = the
 *  executable's icon, the app logo; 'custom' = an .ico of the reader's own. */
export type FileIconChoice = 'document' | 'app' | 'custom'

export const FILE_ICON_CHOICES: readonly FileIconChoice[] = ['document', 'app', 'custom']

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
    case 'app':
      return `${paths.execPath},0`
    case 'custom':
      return paths.customPath.trim() ? paths.customPath : null
    default:
      return `${paths.resourcesPath}\\pdf.ico`
  }
}

/** Only .ico files are offered: Explorer reads icon resources from .exe/.dll
 *  too, but a picker that accepts programs is a picker that launches nothing
 *  and still looks like it might. Judged on the name's extension alone. */
export function isIcoName(name: string): boolean {
  return /\.ico$/i.test(name.trim())
}

export type FileIconErrorCode =
  /** Not a Windows install we registered: macOS/Linux, the portable zip (it
   *  registers nothing), the Store build (MSIX associations are virtualized),
   *  or a dev run */
  | 'file-icon-unavailable'
  /** The chosen file is not an .ico */
  | 'file-icon-not-ico'
  /** reg.exe refused the write — the detail travels as prose */
  | 'file-icon-registry'

const FILE_ICON_ERROR_CODES: ReadonlySet<string> = new Set<FileIconErrorCode>([
  'file-icon-unavailable',
  'file-icon-not-ico',
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
