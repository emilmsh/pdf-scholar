// Telling Chrome and Edge where the native host is (shared/native-host.ts):
// a manifest naming the launcher that starts the relay and the extensions
// that may start it, and — on Windows — a registry key per browser pointing
// at that manifest. Windows' launcher ships in resources/native-host (paths
// relative to itself, see windowsLauncher); macOS and Linux get a copy of the
// relay and a launcher naming this executable in userData/native-host.
//
// Written at every start of the installed app, compared first so a quiet
// start writes nothing: an update can move the executable (a new AppImage, a
// portable zip unpacked elsewhere), and a reader who installs the app only to
// lend the extension its sign-in starts it once to sign in anyway. The NSIS
// uninstaller takes the keys back (build/installer.nsh).
//
// Not in an unpackaged dev run (the executable is node_modules' electron, and
// a browser starting it would open Electron's default app) and not in the
// Microsoft Store build: its registry writes are virtualized to the package
// and its executable cannot be started by another program, so the browser
// would never find it — the extension says «not found» (docs/PLATFORMS.md §25),
// as it does for the MCP server.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import {
  EXTRA_ORIGINS_FILE,
  NATIVE_HOST_NAME,
  POSIX_LAUNCHER,
  RELAY_SCRIPT,
  WINDOWS_LAUNCHER,
  hostManifest,
  manifestTargets,
  posixLauncher,
  sanitizeExtraIds
} from '../shared/native-host'

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  )

async function writeIfChanged(file: string, content: string | Buffer, mode?: number): Promise<void> {
  const have = await readFile(file).catch(() => null)
  if (have?.equals(typeof content === 'string' ? Buffer.from(content) : content)) return
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, content)
  if (mode !== undefined) await chmod(tmp, mode)
  await rename(tmp, file)
}

async function extraIds(): Promise<string[]> {
  try {
    return sanitizeExtraIds(JSON.parse(await readFile(join(app.getPath('userData'), EXTRA_ORIGINS_FILE), 'utf8')))
  } catch {
    return []
  }
}

/** The registry's default value under `key`, or null when the key is absent */
async function registryDefault(key: string): Promise<string | null> {
  try {
    const out = await run('reg.exe', ['query', key, '/ve'])
    const m = /REG_SZ\s+(.*)$/m.exec(out)
    return m ? m[1]!.trim() : ''
  } catch {
    return null
  }
}

export async function registerNativeHost(): Promise<void> {
  const shipped = join(process.resourcesPath, 'native-host')
  const dir = join(app.getPath('userData'), 'native-host')
  await mkdir(dir, { recursive: true })
  let launcher: string
  if (process.platform === 'win32') {
    launcher = join(shipped, WINDOWS_LAUNCHER)
    if (!existsSync(launcher)) throw new Error(`${launcher} is missing from this build`)
  } else {
    // The AppImage itself, not the binary in its mount (which moves)
    const exe = process.env.APPIMAGE || process.execPath
    const relay = join(dir, RELAY_SCRIPT)
    await writeIfChanged(relay, await readFile(join(shipped, RELAY_SCRIPT)))
    launcher = join(dir, POSIX_LAUNCHER)
    await writeIfChanged(launcher, posixLauncher(exe, relay), 0o755)
  }
  const content = JSON.stringify(hostManifest(launcher, await extraIds()), null, 2) + '\n'
  const targets = manifestTargets(process.platform, homedir(), process.env.XDG_CONFIG_HOME)
  if (process.platform === 'win32') {
    const manifest = join(dir, `${NATIVE_HOST_NAME}.json`)
    await writeIfChanged(manifest, content)
    for (const key of targets.registryKeys) {
      if ((await registryDefault(key)) === manifest) continue
      await run('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'])
    }
    return
  }
  for (const dir of targets.dirs) {
    // Only for a browser that is there: no folders for one never installed
    if (!existsSync(dirname(dir))) continue
    try {
      await mkdir(dir, { recursive: true })
      await writeIfChanged(join(dir, `${NATIVE_HOST_NAME}.json`), content)
    } catch {
      /* that browser's folder cannot be written — the others still can */
    }
  }
}

export function registerNativeHostAtStartup(): void {
  if (!app.isPackaged || process.windowsStore) return
  registerNativeHost().catch((err: unknown) => console.error('[pdfx] native host not registered:', err))
}
