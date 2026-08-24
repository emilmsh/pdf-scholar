// Saved signatures: drawn once, stamped as often as needed.
//
// Stored in localStorage next to the tool preferences (src/renderer/src/
// tool-prefs.ts) and for the same reasons — these are renderer-side user
// preferences, and the browser and extension targets have no main process to
// keep them in. Same defensive shape too: anything malformed is dropped rather
// than trusted, because this data outlives the code that wrote it.
//
// The image is a PNG data URL. A trimmed signature is a few KB, and the cap
// below keeps the whole list far under any localStorage budget.

/** A signature the user drew and kept. */
export interface SavedSignature {
  id: string
  /** PNG data URL — what the pad produced, already trimmed to the ink */
  dataUrl: string
  /** Pixel size of that PNG, so a placement can preserve the aspect ratio
   *  without waiting for an Image to decode. */
  width: number
  height: number
}

const LS_KEY = 'pdfx-signatures'

/** More than a handful stops being a picker and starts being a filing cabinet. */
export const MAX_SIGNATURES = 5

/** Refuse anything that is not plausibly one of ours. A data URL from a foreign
 *  origin (or a `javascript:` string someone hand-edited into localStorage) must
 *  never reach an <img src>. */
function validSignature(v: unknown): v is SavedSignature {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    typeof s.dataUrl === 'string' &&
    s.dataUrl.startsWith('data:image/png;base64,') &&
    typeof s.width === 'number' &&
    Number.isFinite(s.width) &&
    s.width > 0 &&
    typeof s.height === 'number' &&
    Number.isFinite(s.height) &&
    s.height > 0
  )
}

export function loadSignatures(): SavedSignature[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(validSignature).slice(0, MAX_SIGNATURES)
  } catch {
    return []
  }
}

export function saveSignatures(list: SavedSignature[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX_SIGNATURES)))
  } catch {
    // Quota or a locked-down storage mode — the signature stays usable for this
    // session, it just will not be there next time. Not worth interrupting for.
  }
}

/** Newest first, capped. Returns the new list; the caller owns the state. */
export function addSignature(list: SavedSignature[], sig: SavedSignature): SavedSignature[] {
  const next = [sig, ...list].slice(0, MAX_SIGNATURES)
  saveSignatures(next)
  return next
}

export function removeSignature(list: SavedSignature[], id: string): SavedSignature[] {
  const next = list.filter((s) => s.id !== id)
  saveSignatures(next)
  return next
}

/** The width, in PDF points, a freshly stamped signature gets. Sized so a
 *  normal signature spans about a third of an A4 text column — big enough to
 *  read, small enough that it rarely has to be shrunk before it is right. */
export const STAMP_DEFAULT_WIDTH_PT = 170

/** Box for a placement centred on (x, y), preserving the PNG's aspect ratio. */
export function stampRectAt(
  sig: Pick<SavedSignature, 'width' | 'height'>,
  x: number,
  y: number,
  widthPt = STAMP_DEFAULT_WIDTH_PT
): { x: number; y: number; w: number; h: number } {
  const h = (widthPt * sig.height) / sig.width
  return { x: x - widthPt / 2, y: y - h / 2, w: widthPt, h }
}

/** The PNG bytes behind a data URL, for the engine (which wants raw bytes). */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
