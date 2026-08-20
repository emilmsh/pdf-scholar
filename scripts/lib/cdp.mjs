// Minimal Chromium DevTools Protocol client, shared by the scripts that drive
// the REAL desktop app (shoot-screenshots.mjs, test-multiwindow.mjs).
//
// Electron ships Chromium's DevTools protocol and Node has had a global
// WebSocket since v22, so driving the built app needs no browser-automation
// dependency at all: spawn `electron out/main/index.js <pdf>
// --remote-debugging-port`, list the page targets over HTTP, talk CDP over the
// socket, and drive the UI with Runtime.evaluate.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let nextId = 1

/** Wrap an open socket in a `send(method, params) -> Promise<result>` function */
export function cdp(ws) {
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error.message))
    else entry.resolve(msg.result)
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

export function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')))
  })
}

/** Every attachable page target, in the order Chromium reports them */
export async function listPageTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    const targets = await res.json()
    return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  } catch {
    return [] // port not up yet
  }
}

/**
 * Wait until at least `count` page targets exist (one per app window) and
 * return them. The app needs a moment to open its debugging port and its
 * window, and a second window takes a moment more to appear.
 */
export async function waitForPageTargets(port, count = 1, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const targets = await listPageTargets(port)
    if (targets.length >= count) return targets
    if (Date.now() > deadline) {
      throw new Error(`only ${targets.length}/${count} CDP page targets after ${timeoutMs / 1000} s`)
    }
    await sleep(400)
  }
}

/** Electron's own binary, found the way Node resolves a module: from `root`
 *  upwards. A git worktree (which is how these sessions check the repo out) has
 *  an EMPTY node_modules and borrows the parent checkout's — so a path pinned to
 *  `root` spawns nothing and the failure reads as ENOENT on an exe that does
 *  exist one directory up. */
export function electronBinary(root) {
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron'
  let dir = resolve(root)
  for (;;) {
    const candidate = join(dir, 'node_modules', 'electron', 'dist', exe)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return join(root, 'node_modules', 'electron', 'dist', exe) // original, for the error message
    dir = parent
  }
}

/** Is something already listening on this localhost port? `netstat -an` is the
 *  one listing available on all three platforms without a dependency; the port
 *  shows up as `:port` (Windows, Linux) or `.port` (macOS), and Windows says
 *  LISTENING where the others say LISTEN. */
export function portInUse(port) {
  const r = spawnSync('netstat', ['-an'], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout) return false
  const re = new RegExp('[.:]' + port + '\\b.*LISTEN', 'i')
  return r.stdout.split(/\r?\n/).some((l) => re.test(l))
}

/**
 * Spawn the built app in a THROWAWAY profile, so a run never touches the real
 * recents / reading positions / theme, always starts from factory defaults, and
 * gets its own single-instance lock (it works while the real app is open).
 * Returns the child plus a `log()` of everything it printed and a `cleanup()`.
 *
 * `prepareProfile(dir)` runs after the profile directory exists and BEFORE the
 * app starts, for the rare case where factory defaults are not enough (see the
 * AI shots in shoot-screenshots.mjs). Anything it writes dies with the profile.
 *
 * Refuses to start when the debugging port is already taken, because the
 * failure it prevents is unrecognisable: two runs on one port drive EACH
 * OTHER's windows — commands land in the wrong app while screenshots come from
 * the right one — so the report is a scatter of "expected page 5, got page 1"
 * that looks like a broken app rather than two runs in one room. Cost us a
 * confusing afternoon on 2026-08-20.
 */
export function launchApp({ root, mainJs, args = [], port, prepareProfile, env }) {
  if (portInUse(port)) {
    throw new Error(
      `debugging port ${port} is already in use — another run of this script (or a ` +
        'leftover Electron from one) is still holding it.\n' +
        '  Let it finish, or close it: Get-Process electron | Stop-Process -Force'
    )
  }
  const profile = mkdtempSync(join(tmpdir(), 'pdfx-cdp-'))
  if (prepareProfile) prepareProfile(profile)
  const bin = electronBinary(root)
  const child = spawn(
    bin,
    [mainJs, ...args, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(env ?? {}) } }
  )
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  return {
    child,
    profile,
    log: () => out,
    async cleanup() {
      child.kill()
      await sleep(400)
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        /* a leftover temp profile is harmless */
      }
    }
  }
}

/**
 * Run an async body in a page and return its value. `prelude` is prepended, so
 * in-page helpers can be shared across calls without re-sending them by hand.
 */
export async function evaluate(send, body, prelude = '') {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${prelude}\n${body}\n })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'evaluate failed'
    )
  }
  return result.result?.value
}
