// Who is reading, as the system knows them — the name a first run puts in
// «Navn på merknader» (rules in src/shared/annot-author.ts). Asked once per
// profile, never again after the seed has run.
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { parseRegString, pickAuthorName } from '../shared/annot-author'

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: 4000, windowsHide: true }, (err, stdout) =>
      resolve(err ? '' : stdout)
    )
  })

// The name Office signs Word comments with — what a reader's colleagues
// already see on their comments. Read with `reg export`, which writes the key
// as UTF-16: reg QUERY prints in the OEM code page, where «ø» comes out as
// 0x9B, and PowerShell takes 1.3 s to start where this takes 90 ms (both
// measured 2026-11-23) — this runs in front of the first window.
async function officeUserName(): Promise<string> {
  const file = join(tmpdir(), `pdfx-userinfo-${process.pid}-${Date.now()}.reg`)
  try {
    await run('reg.exe', ['export', 'HKCU\\Software\\Microsoft\\Office\\Common\\UserInfo', file, '/y'])
    return parseRegString(await readFile(file, 'utf16le'), 'UserName')
  } catch {
    return ''
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}

async function fullNames(): Promise<string[]> {
  if (process.platform === 'win32') return [await officeUserName()]
  if (process.platform === 'darwin') return [await run('id', ['-F'])]
  // Linux: the GECOS field's first part is the full name
  try {
    const uid = String(userInfo().uid)
    const line = (await readFile('/etc/passwd', 'utf8')).split('\n').find((l) => l.split(':')[2] === uid)
    return [line?.split(':')[4]?.split(',')[0] ?? '']
  } catch {
    return []
  }
}

/** The reader's name, best first: a full name, else the login name ('' if
 *  the system will not say) */
export async function systemUserName(): Promise<string> {
  let login = ''
  try {
    login = userInfo().username
  } catch {
    /* no user entry (a container) — the full names may still answer */
  }
  const names = await fullNames().catch(() => [])
  return pickAuthorName([...names, login])
}
