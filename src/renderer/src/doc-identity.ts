// The renderer's side of a document's identity across a move (issue #46;
// the rule is src/shared/doc-identity.ts). Every open reads its reading
// position through here, so the fingerprint is reported — and a moved file's
// records carried over to its new path — BEFORE the position is looked up.
import type { FilePayload, ReadingPosition } from '../../shared/types'
import { docNameFromPath } from '../../shared/chat-history'
import { pdfFingerprint } from '../../shared/doc-identity'
import { bridge } from './bridge'

/** One report per payload: a re-render or a second read of the same bytes
 *  costs nothing */
const reported = new WeakMap<Uint8Array, Promise<string[]>>()

/** Report the document's fingerprint; resolves to the paths its records
 *  followed from ([] for an ordinary open). Never throws — an open must not
 *  fail over bookkeeping. */
export function reportIdentity(payload: FilePayload): Promise<string[]> {
  const have = reported.get(payload.data)
  if (have) return have
  const run = (async () => {
    try {
      const fp = pdfFingerprint(payload.data)
      return fp ? await bridge.docIdentity(payload.path, payload.name, fp) : []
    } catch {
      return []
    }
  })()
  reported.set(payload.data, run)
  return run
}

/** The reading position for a payload, after its identity has been reported */
export async function positionFor(payload: FilePayload): Promise<ReadingPosition | null> {
  await reportIdentity(payload)
  return bridge.getPosition(payload.path)
}

/** The name the notice gives the old location: its file name when the name
 *  changed, else its folder — what the reader would recognise */
export function movedFromLabel(from: string, payload: FilePayload): string {
  const oldName = docNameFromPath(from)
  if (oldName !== payload.name) return oldName
  const parts = from.replace(/[?#].*$/, '').split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? decodeSafe(parts[parts.length - 2]) : oldName
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
