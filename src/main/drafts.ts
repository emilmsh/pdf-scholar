// Draft (shadow-file) model: annotation writes never touch the original PDF.
// The first mutation copies the original into userData/drafts/<hash>.pdf and
// all engine operations target that copy. "Save" copies the draft back over
// the original (atomically); closing without saving discards the draft. A
// draft left behind by a crashed session is picked up silently on next open,
// so unsaved work survives.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

function draftDir(): string {
  return join(app.getPath('userData'), 'drafts')
}

export function draftPathFor(originalPath: string): string {
  const hash = createHash('sha1').update(originalPath.toLowerCase()).digest('hex').slice(0, 20)
  return join(draftDir(), `${hash}.pdf`)
}

/** Sidecar recording the original file's mtime at the moment editing began —
 *  the baseline `wasModifiedExternally` compares against. */
function baselinePathFor(originalPath: string): string {
  return `${draftPathFor(originalPath)}.baseline.json`
}

export function hasDraft(originalPath: string): boolean {
  return existsSync(draftPathFor(originalPath))
}

/** The path engine writes should target; creates the draft copy on first use */
export function ensureDraft(originalPath: string): string {
  const draft = draftPathFor(originalPath)
  if (!existsSync(draft)) {
    mkdirSync(draftDir(), { recursive: true })
    copyFileSync(originalPath, draft)
    try {
      writeFileSync(
        baselinePathFor(originalPath),
        JSON.stringify({ mtimeMs: statSync(originalPath).mtimeMs })
      )
    } catch {
      // Best-effort — a missing baseline just means the external-change
      // check below stays silent (no false positive, no crash).
    }
  }
  return draft
}

/** The path to read current document bytes from (draft when one exists) */
export function readPathFor(originalPath: string): string {
  const draft = draftPathFor(originalPath)
  return existsSync(draft) ? draft : originalPath
}

/** True when the original file's mtime has moved past the baseline recorded
 *  when the draft was created — i.e. something outside the app touched it
 *  after this session started annotating. False (never a false alarm) when
 *  there is no draft, no baseline, or the original is gone. */
export function wasModifiedExternally(originalPath: string): boolean {
  if (!hasDraft(originalPath) || !existsSync(originalPath)) return false
  try {
    const { mtimeMs } = JSON.parse(readFileSync(baselinePathFor(originalPath), 'utf8')) as {
      mtimeMs: number
    }
    // A small buffer absorbs filesystem timestamp jitter/rounding, not real edits
    return statSync(originalPath).mtimeMs > mtimeMs + 1000
  } catch {
    return false
  }
}

/** Copy the draft over the original (atomic replace), then drop the draft */
export function saveDraft(originalPath: string): void {
  const draft = draftPathFor(originalPath)
  if (!existsSync(draft)) return
  const tmp = `${originalPath}.pdfx-tmp`
  copyFileSync(draft, tmp)
  renameSync(tmp, originalPath)
  rmSync(draft, { force: true })
  rmSync(baselinePathFor(originalPath), { force: true })
}

export function discardDraft(originalPath: string): void {
  rmSync(draftPathFor(originalPath), { force: true })
  rmSync(baselinePathFor(originalPath), { force: true })
}
