// The quiet pass that gives the AI tools the marks of documents the reader has
// not opened since notes were kept (shared/research-notes.ts). The viewer
// writes a document's record while it is open; a paper marked up before
// v0.79.0, or changed by another program since, has none until it is opened
// again — so its highlights were invisible to Claude Code while its
// conversations were not. Main names the recents that need reading (once per
// session, only while some tool may read, never one kept out); this reads
// each from its file into a throwaway pdf.js document, the way the library's
// grid draws a missing picture: one at a time, when the window is idle,
// without filing the document as just opened.
//
// A locked file is recorded as locked — which also keeps its conversations
// from the server, the same as a locked document the viewer opened.
import type { DocNotes } from '../../shared/research-notes'
import { computeExcerpts } from './annot-export'
import { bridge, isElectron } from './bridge'
import { buildDocNotes, metadataTitle } from './doc-notes'
import { collectAnnotations } from './doc-load'
import { detectDoi } from './doi-detect'
import { isPasswordException, openDocument } from './pdf-doc'
import { whenIdle } from './recent-thumbs'

/** Build one document's record from its file; null = not readable here */
async function recordFromFile(path: string, name: string): Promise<DocNotes | null> {
  const bytes = await bridge.readRecentForThumb(path)
  if (!bytes) return null
  const resources = openDocument(bytes)
  try {
    const pdf = await resources.task.promise
    const annots = await collectAnnotations(pdf)
    const [excerpts, doi, title] = await Promise.all([computeExcerpts(pdf, annots), detectDoi(pdf), metadataTitle(pdf)])
    return buildDocNotes({ path, name, annots, excerpts, pages: pdf.numPages, doi, title, locked: false })
  } catch (err) {
    if (!isPasswordException(err)) return null
    return buildDocNotes({ path, name, annots: new Map(), excerpts: new Map(), pages: 0, doi: null, title: undefined, locked: true })
  } finally {
    void resources.task.destroy()
    resources.port.terminate()
  }
}

let running: Promise<void> | null = null

/** Read what main hands out, then ask again — a switch turned on while a pass
 *  runs is picked up by the next. Safe to call any number of times. */
export function runNotesBackfill(): Promise<void> {
  if (!isElectron) return Promise.resolve()
  if (running) return running
  running = (async () => {
    for (;;) {
      const targets = await bridge.notesBackfillTargets()
      if (targets.length === 0) return
      for (const { path, name } of targets) {
        await new Promise<void>((resolve) => whenIdle(resolve))
        const record = await recordFromFile(path, name)
        if (record) await bridge.setDocNotes(record)
      }
    }
  })().finally(() => {
    running = null
  })
  return running
}
