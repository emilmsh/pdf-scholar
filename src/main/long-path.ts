// Windows keeps an 8.3 alias for every long file name ("EFFECT~1.pdf"), and a
// handful of launchers hand a program the alias instead of the name — typically
// when the full path is long enough that the shell cannot fit it in a command
// line. A path held under its alias is harmless to READ, but it is poison to
// WRITE: replacing the file by renaming a temp file onto "EFFECT~1.pdf" does not
// keep the old entry's long name, it deletes that entry and creates one named
// literally EFFECT~1.pdf (issue #24 — the user's long-named paper came back from
// Save with a name of eight characters).
//
// So an alias never becomes a document's identity: every path that enters the
// app is expanded here first, and the one place that replaces a file on disk
// expands it again as a last line of defence.
import { realpathSync } from 'node:fs'
import { win32 } from 'node:path'

/** Every short alias carries a tilde and a digit ("PROGRA~1", "EFFECT~1.PDF") —
 *  a path without one cannot be an alias, which is the whole fast path */
const ALIAS = /~\d/

type Realpath = (path: string) => string

/** `path` with any 8.3 alias components replaced by the real names. Everything
 *  else is left exactly as given — casing, drive letters and links included —
 *  because the path doubles as the key for drafts, reading positions and tabs,
 *  and a mapped drive silently turning into a UNC path would orphan all three.
 *
 *  Never throws and never guesses: a path that cannot be resolved (it does not
 *  exist yet, the drive is gone) comes back unchanged. Windows only; on every
 *  other platform a `~1` is just part of a name. */
export function toLongPath(
  path: string,
  realpath: Realpath = realpathSync.native,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32' || !ALIAS.test(path)) return path
  let real: string
  try {
    real = realpath(path)
  } catch {
    return path
  }
  // The resolver also follows links and maps drives to their UNC form, so its
  // answer is only taken piece by piece: from the tail, each alias component is
  // swapped for the real name at the same position.
  const given = win32.normalize(path).split('\\')
  const resolved = real.split('\\')
  const merged = [...given]
  const depth = Math.min(given.length, resolved.length)
  for (let i = 1; i <= depth; i++) {
    const was = given[given.length - i]
    const now = resolved[resolved.length - i]
    if (ALIAS.test(was) && was.toLowerCase() !== now.toLowerCase()) merged[given.length - i] = now
  }
  const candidate = merged.join('\\')
  // A link in the middle shifts the positions, and then a swap may have landed
  // on the wrong component. The merged path must lead to the same file as the
  // resolver's answer; if it does not, the resolver's answer is the truth.
  try {
    if (realpath(candidate).toLowerCase() === real.toLowerCase()) return candidate
  } catch {
    // fall through to the resolver's own answer
  }
  return real
}
