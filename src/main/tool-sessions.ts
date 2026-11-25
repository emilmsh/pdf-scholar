// Desktop store for what an AI tool pointed at and read (shared/tool-bridge.ts):
// one file per SESSION of the tool under userData/tool-sessions, `<id>.json`,
// on the pattern of the notes and the conversations (src/main/notes-store.ts)
// — write-then-rename, two writes of one session queued (a rename onto a file
// mid-rename is EPERM on Windows), a file that no longer parses reads as
// nothing and is left for the next write. Node-only (no Electron import), so
// scripts/test-tool-bridge.mjs drives it against a temp folder.
//
// Unlike the conversations this one evicts: a session's list is capped
// (MAX_SESSION_ENTRIES) and so is the number of sessions (MAX_SESSIONS, the
// least recently used first). It is a log of pointers into documents the
// reader still has — nothing in it exists nowhere else.
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSessionId } from '../shared/mcp'
import type { BridgeSessionInfo, ToolEntry, ToolSession } from '../shared/tool-bridge'
import { MAX_SESSIONS, sanitizeToolSession, withToolEntry } from '../shared/tool-bridge'

export interface ToolSessionStore {
  get(id: string): Promise<ToolSession | null>
  /** Add one entry to the session (made on its first) and answer the session */
  append(info: BridgeSessionInfo, entry: ToolEntry, topic?: string): Promise<ToolSession>
  /** Every session, the one last added to first */
  all(): Promise<ToolSession[]>
  remove(id: string): Promise<void>
}

/** A session's file: its id (isSessionId) and `.json` */
const isSessionFile = (name: string): boolean => name.endsWith('.json') && isSessionId(name.slice(0, -5))

let tmpSeq = 0

/** A rename onto the session's file, tried again for a moment while Windows
 *  refuses it. Writes of one session are queued, but the file the last one
 *  renamed into place can still be held for a moment after (Defender scans a
 *  new file; a reader of all() may have it open), and the rename onto it is
 *  then EPERM — measured 2026-11-25 as one run in three of test:tool-bridge
 *  failing on three appends at once. A tool citing several passages at once
 *  meets the same. */
async function renameOnto(from: string, to: string): Promise<void> {
  for (let tried = 0; ; tried++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (tried >= 20 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        await unlink(from).catch(() => {})
        throw err
      }
      await new Promise((r) => setTimeout(r, 25 * (tried + 1)))
    }
  }
}

export function createToolSessionStore(dir: string): ToolSessionStore {
  const fileOf = (id: string): string => join(dir, `${id}.json`)
  const writing = new Map<string, Promise<unknown>>()

  async function read(file: string): Promise<ToolSession | null> {
    try {
      return sanitizeToolSession(JSON.parse(await readFile(file, 'utf-8')))
    } catch {
      return null
    }
  }

  function queue<T>(id: string, job: () => Promise<T>): Promise<T> {
    const prev = writing.get(id) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(job)
    writing.set(id, next)
    void next
      .catch(() => {})
      .finally(() => {
        if (writing.get(id) === next) writing.delete(id)
      })
    return next
  }

  /** Past the cap, the sessions least recently written go */
  async function prune(): Promise<void> {
    let names: string[]
    try {
      names = (await readdir(dir)).filter(isSessionFile)
    } catch {
      return
    }
    if (names.length <= MAX_SESSIONS) return
    const aged = await Promise.all(
      names.map(async (name) => ({ name, mtimeMs: await stat(join(dir, name)).then((s) => s.mtimeMs, () => 0) }))
    )
    aged.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const { name } of aged.slice(0, names.length - MAX_SESSIONS)) await unlink(join(dir, name)).catch(() => {})
  }

  return {
    get: async (id) => {
      if (!isSessionId(id)) return null
      await writing.get(id)?.catch(() => {})
      const session = await read(fileOf(id))
      // Named by its id: the id inside must agree
      return session && session.id === id ? session : null
    },
    append: (info, entry, topic) =>
      queue(info.id, async () => {
        const file = fileOf(info.id)
        const have = await read(file)
        const next = withToolEntry(have && have.id === info.id ? have : null, info, entry, topic)
        await mkdir(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
        await writeFile(tmp, JSON.stringify(next))
        await renameOnto(tmp, file)
        if (!have) await prune()
        return next
      }),
    all: async () => {
      let names: string[]
      try {
        names = (await readdir(dir)).filter(isSessionFile)
      } catch {
        return []
      }
      const sessions = await Promise.all(names.map((name) => read(join(dir, name))))
      return sessions.filter((s): s is ToolSession => s !== null).sort((a, b) => b.updatedAt - a.updatedAt)
    },
    remove: (id) =>
      isSessionId(id)
        ? queue(id, () => unlink(fileOf(id)).catch(() => {}))
        : Promise.resolve()
  }
}
