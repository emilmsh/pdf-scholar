// A lock between PROCESSES on this machine: a file created with O_EXCL. Two
// processes of the app hold the ChatGPT sign-in — the app itself and the
// windowless native host the browser starts for the extension — and its
// refresh token rotates on use, so only one of them may renew it at a time
// (src/main/chatgpt-renew.ts).
//
// The lock file names its holder's pid. One left behind by a process that
// died is taken over at once when that pid is gone, and after `staleMs` in
// any case — a renewal is one HTTPS round trip with its own timeout, so a lock
// that old belongs to nobody. No dependency: proper-lockfile and friends do
// this and more, and this is the whole of what we need.
import { open, readFile, rm, stat } from 'node:fs/promises'

export interface FileLockOptions {
  /** A lock older than this is taken over whatever its pid says */
  staleMs?: number
  /** How long to wait between attempts */
  pollMs?: number
}

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const [info, text] = await Promise.all([stat(lockPath), readFile(lockPath, 'utf8')])
    if (Date.now() - info.mtimeMs > staleMs) return true
    const pid = Number.parseInt(text, 10)
    // An empty file is a holder between create and write — give it time
    return text.trim() !== '' && !alive(pid)
  } catch {
    // Gone between our attempt and the look: try again at once
    return false
  }
}

/** Run `fn` holding the lock at `lockPath`; the lock goes when it settles,
 *  thrown or not. Waits as long as it takes — a holder that never lets go is
 *  stale after `staleMs`, so the wait is bounded by that. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  { staleMs = 60_000, pollMs = 100 }: FileLockOptions = {}
): Promise<T> {
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(String(process.pid))
      } finally {
        await handle.close()
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (await isStale(lockPath, staleMs)) {
        await rm(lockPath, { force: true })
        continue
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockPath, { force: true })
  }
}
