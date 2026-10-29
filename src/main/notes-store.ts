// Desktop store for each document's notes (shared/research-notes.ts): one
// file per document under userData/notes, `<sha1 of path>.json`, beside the
// conversations and on the same pattern (src/main/chat-history.ts) —
// write-then-rename, two writes of one document queued (a rename onto a file
// mid-rename is EPERM on Windows), a record not worth keeping removes its
// file, a file that no longer parses reads as nothing and is left for the
// next write. Read by the MCP server in its own process, which is why this
// is Node-only (no Electron import): the server bundles it as it is.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocNotes } from '../shared/research-notes'
import { sanitizeDocNotes, worthKeeping } from '../shared/research-notes'

export interface NotesStore {
  get(path: string): Promise<DocNotes | null>
  /** Replace one document's record; one not worth keeping removes it */
  set(doc: DocNotes): Promise<void>
  remove(path: string): Promise<void>
  /** Every record, newest first */
  all(): Promise<DocNotes[]>
}

const ENTRY_FILE = /^[0-9a-f]{40}\.json$/

const keyOf = (path: string): string => createHash('sha1').update(path).digest('hex')

let tmpSeq = 0

export function createNotesStore(dir: string): NotesStore {
  const fileOf = (path: string): string => join(dir, `${keyOf(path)}.json`)
  const writing = new Map<string, Promise<void>>()
  /** Parsed records by file name, valid while mtime and size match — the MCP
   *  server lists the store on every search */
  const cache = new Map<string, { mtimeMs: number; size: number; doc: DocNotes | null }>()

  async function read(file: string): Promise<DocNotes | null> {
    try {
      return sanitizeDocNotes(JSON.parse(await readFile(file, 'utf-8')))
    } catch {
      return null
    }
  }

  const queue = (path: string, job: () => Promise<void>): Promise<void> => {
    const prev = writing.get(path) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(job)
    writing.set(path, next)
    void next.finally(() => {
      if (writing.get(path) === next) writing.delete(path)
    })
    return next
  }

  return {
    get: async (path) => {
      await writing.get(path)
      const doc = await read(fileOf(path))
      // Keyed by the path's hash: the path inside must agree
      return doc && doc.path === path ? doc : null
    },
    set: (input) => {
      const doc = sanitizeDocNotes(input)
      if (!doc) return Promise.resolve()
      return queue(doc.path, async () => {
        const file = fileOf(doc.path)
        if (!worthKeeping(doc)) {
          await unlink(file).catch(() => {})
          return
        }
        await mkdir(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
        await writeFile(tmp, JSON.stringify(doc))
        await rename(tmp, file)
      })
    },
    remove: (path) => queue(path, () => unlink(fileOf(path)).catch(() => {})),
    all: async () => {
      let names: string[]
      try {
        names = (await readdir(dir)).filter((n) => ENTRY_FILE.test(n))
      } catch {
        cache.clear()
        return []
      }
      const present = new Set(names)
      for (const n of cache.keys()) if (!present.has(n)) cache.delete(n)
      const docs = await Promise.all(
        names.map(async (name) => {
          const file = join(dir, name)
          let st
          try {
            st = await stat(file)
          } catch {
            return null
          }
          const have = cache.get(name)
          if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return have.doc
          const doc = await read(file)
          cache.set(name, { mtimeMs: st.mtimeMs, size: st.size, doc })
          return doc
        })
      )
      return docs.filter((d): d is DocNotes => d !== null).sort((a, b) => b.updatedAt - a.updatedAt)
    }
  }
}
