// Desktop store for the library's grid pictures (issue #28; the rules are in
// src/shared/recent-thumbs.ts).
//
// One pair of files per recents entry in its own folder beside the state file:
// `<sha1 of path>.jpg` (the picture) and `<sha1>.json` (path, page count,
// locked, taken). NOT in pdfx-state.json: that file is rewritten whole on every
// reading-position save, and twenty pictures would ride along each time. Per
// entry rather than one index, so two windows storing two pictures can never
// lose one to the other's read-modify-write. Two writes of the SAME entry (two
// windows opening one file) queue behind each other: on Windows a rename onto
// a file another rename is replacing fails with EPERM.
//
// The JSON is written last and is what makes an entry exist: a crash between
// the two writes leaves a picture nobody reads, which the next store replaces
// or the next prune removes. Node-only (no Electron import) so
// scripts/test-recent-thumbs.mjs runs it against a temp folder.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RecentThumb } from '../shared/types'
import { sanitizeRecentThumb } from '../shared/recent-thumbs'

export interface RecentThumbStore {
  /** The stored entries for these paths (absent = none, or unreadable) */
  get(paths: string[]): Promise<Record<string, RecentThumb>>
  set(path: string, thumb: RecentThumb): Promise<void>
  /** Delete every file that does not belong to one of these paths */
  prune(keep: string[]): Promise<void>
  /** Delete one entry's files, after any write of it still in flight — a
   *  pending set would otherwise put back the picture just removed */
  forget(path: string): Promise<void>
}

interface Meta {
  path: string
  pages: number
  locked?: boolean
  taken: number
  image: boolean
}

/** `<key>.jpg`, `<key>.json`, or one of their temp files mid-write */
const ENTRY_FILE = /^([0-9a-f]{40})\.(jpg|json)(\.\d+\.\d+\.tmp)?$/

const keyOf = (path: string): string => createHash('sha1').update(path).digest('hex')

let tmpSeq = 0

/** Write-then-rename, so a reader never sees half a file. The temp name is
 *  unique per write: two windows may store the same entry at once. */
async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

export function createRecentThumbStore(dir: string): RecentThumbStore {
  const jpg = (key: string): string => join(dir, `${key}.jpg`)
  const json = (key: string): string => join(dir, `${key}.json`)
  /** The write in flight per entry, which the next write of it waits for */
  const writing = new Map<string, Promise<void>>()

  async function write(path: string, key: string, thumb: RecentThumb): Promise<void> {
    await mkdir(dir, { recursive: true })
    if (thumb.image) {
      await writeAtomic(jpg(key), thumb.image)
    } else {
      // A file that was readable before and is locked now must not keep the
      // cover it had: that picture is exactly what `locked` withholds.
      await unlink(jpg(key)).catch(() => {})
    }
    const meta: Meta = {
      path,
      pages: thumb.pages,
      ...(thumb.locked ? { locked: true } : {}),
      taken: thumb.taken,
      image: thumb.image !== undefined
    }
    await writeAtomic(json(key), JSON.stringify(meta))
  }

  async function getOne(path: string): Promise<RecentThumb | null> {
    const key = keyOf(path)
    let meta: Meta
    try {
      meta = JSON.parse(await readFile(json(key), 'utf-8')) as Meta
    } catch {
      return null
    }
    // The file name is a hash; the path inside is the identity
    if (meta.path !== path) return null
    let image: Uint8Array | undefined
    if (meta.image && !meta.locked) {
      try {
        image = new Uint8Array(await readFile(jpg(key)))
      } catch {
        return null
      }
    }
    return sanitizeRecentThumb({ image, pages: meta.pages, locked: meta.locked, taken: meta.taken })
  }

  return {
    async get(paths) {
      const out: Record<string, RecentThumb> = {}
      await Promise.all(
        paths.map(async (path) => {
          const thumb = await getOne(path)
          if (thumb) out[path] = thumb
        })
      )
      return out
    },

    set(path, thumb) {
      const clean = sanitizeRecentThumb(thumb)
      if (!clean) return Promise.resolve()
      const key = keyOf(path)
      const before = writing.get(key) ?? Promise.resolve()
      const mine = before.catch(() => {}).then(() => write(path, key, clean))
      writing.set(key, mine)
      void mine
        .catch(() => {})
        .then(() => {
          if (writing.get(key) === mine) writing.delete(key)
        })
      return mine
    },

    async forget(path) {
      const key = keyOf(path)
      await (writing.get(key) ?? Promise.resolve()).catch(() => {})
      await Promise.all([unlink(jpg(key)).catch(() => {}), unlink(json(key)).catch(() => {})])
    },

    async prune(keep) {
      const keys = new Set(keep.map(keyOf))
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        return // no folder yet: nothing stored, nothing to prune
      }
      await Promise.all(
        files.map(async (file) => {
          // A kept entry's temp file may be another window's write in flight,
          // so it stays; it goes with the entry when that leaves the recents.
          const m = ENTRY_FILE.exec(file)
          if (m && keys.has(m[1])) return
          await unlink(join(dir, file)).catch(() => {})
        })
      )
    }
  }
}
