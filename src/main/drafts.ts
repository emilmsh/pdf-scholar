// Draft (shadow-file) model: annotation writes never touch the original PDF.
// The first mutation copies the original into userData/drafts/<hash>.pdf and
// all engine operations target that copy. "Save" copies the draft back over
// the original (atomically); closing without saving discards the draft. A
// draft left behind by a crashed session is picked up silently on next open,
// so unsaved work survives.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function draftDir(): string {
  return join(app.getPath('userData'), 'drafts')
}

export function draftPathFor(originalPath: string): string {
  const hash = createHash('sha1').update(originalPath.toLowerCase()).digest('hex').slice(0, 20)
  return join(draftDir(), `${hash}.pdf`)
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
  }
  return draft
}

/** The path to read current document bytes from (draft when one exists) */
export function readPathFor(originalPath: string): string {
  const draft = draftPathFor(originalPath)
  return existsSync(draft) ? draft : originalPath
}

/** Copy the draft over the original (atomic replace), then drop the draft */
export function saveDraft(originalPath: string): void {
  const draft = draftPathFor(originalPath)
  if (!existsSync(draft)) return
  const tmp = `${originalPath}.pdfx-tmp`
  copyFileSync(draft, tmp)
  renameSync(tmp, originalPath)
  rmSync(draft, { force: true })
}

export function discardDraft(originalPath: string): void {
  rmSync(draftPathFor(originalPath), { force: true })
}
