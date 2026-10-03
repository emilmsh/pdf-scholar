// Writing a document's embedded files to disk: the temp copy «Åpne» launches,
// and the files «Lagre» / «Lagre alle» put where the user chose. The rules for
// WHICH files may be opened live in src/shared/attachments.ts; this is only
// the file-system half, and it re-checks nothing the IPC handler did not.
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { cleanAttachmentName, numberedName, propagatedZoneIdentifier } from '../shared/attachments'

/** Where opened attachments are written. Left for the OS to clean, like every
 *  program's temp copies: the user may well have edited one in Excel and saved
 *  it there, and an app that deletes those behind their back loses work. */
const tempRoot = (): string => join(app.getPath('temp'), 'PDF Scholar', 'attachments')

/** Give `target` the Mark of the Web of the document it came in (see
 *  propagatedZoneIdentifier for why). Windows only — the mark is an NTFS
 *  alternate data stream; elsewhere, and on a volume without streams, there
 *  is nothing to write and the file is used as it is. */
async function markLikeDocument(target: string, docPath: string): Promise<void> {
  if (process.platform !== 'win32') return
  if (typeof docPath !== 'string' || !isAbsolute(docPath) || !existsSync(docPath)) return
  try {
    const source = await readFile(`${docPath}:Zone.Identifier`, 'utf8').catch(() => null)
    const stream = propagatedZoneIdentifier(source, docPath)
    if (stream) await writeFile(`${target}:Zone.Identifier`, stream)
  } catch {
    // FAT/exFAT or a network share without streams: no mark to carry
  }
}

/** The temp copy an attachment is opened from.
 *
 *  One folder per content hash, so opening the same exhibit twice reuses the
 *  copy (Excel already has it open; a second file would be a second window).
 *  A copy whose bytes no longer match was edited and saved by its program —
 *  that is the user's work now, so it is never overwritten; the next free
 *  folder is used instead. */
export async function stageAttachment(name: string, data: Uint8Array, docPath: string): Promise<string> {
  const clean = cleanAttachmentName(name)
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 16)
  for (let i = 1; i <= 20; i++) {
    const dir = join(tempRoot(), i === 1 ? hash : `${hash}-${i}`)
    const target = join(dir, clean)
    if (existsSync(target)) {
      const prev = await readFile(target).catch(() => null)
      if (prev && prev.length === data.length && Buffer.compare(prev, data) === 0) return target
      continue
    }
    await mkdir(dir, { recursive: true })
    await writeFile(target, data)
    await markLikeDocument(target, docPath)
    return target
  }
  throw new Error('Fant ingen ledig plass i temp-mappen for vedlegget')
}

/** Write a saved attachment to the exact path the user chose (the save dialog
 *  already asked about replacing an existing file). */
export async function writeSavedAttachment(target: string, data: Uint8Array, docPath: string): Promise<void> {
  await writeFile(target, data)
  await markLikeDocument(target, docPath)
}

/** «Lagre alle»: write each file into `folder` under its own clean name, never
 *  over a file that is already there — `wx` fails on an existing name, and the
 *  next number is tried. Returns how many were written. */
export async function writeAttachmentsInto(
  folder: string,
  files: { name: string; data: Uint8Array }[],
  docPath: string
): Promise<number> {
  let count = 0
  for (const file of files) {
    const clean = cleanAttachmentName(file.name)
    for (let n = 1; n <= 999; n++) {
      const target = join(folder, numberedName(clean, n))
      try {
        await writeFile(target, file.data, { flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw err
      }
      await markLikeDocument(target, docPath)
      count++
      break
    }
  }
  return count
}
