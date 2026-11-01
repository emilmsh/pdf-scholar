// The extension borrowing the desktop app's ChatGPT sign-in through native
// messaging (src/shared/native-host.ts, src/main/native-host.ts,
// src/main/chatgpt-renew.ts, src/main/file-lock.ts; docs/PLATFORMS.md §25).
//
// Four things that would fail quietly:
//  - the stdio framing: Chrome hands the host bytes cut anywhere, and refuses
//    any message from it over 1 MB — a long answer must still arrive whole;
//  - who may start the host and where the browser looks for it: a wrong
//    origin or registry key reads in the extension as «app not installed»;
//  - the relay: Electron writes a line break on stdout before any code runs,
//    which the browser would read as a 4-byte length — the relay drops it,
//    and the launchers start it in Node mode (src/main/native-host-relay.ts);
//  - the LOCK: the refresh token rotates on use, so two processes renewing
//    from one stored bundle leave the loser with a spent token, which reads
//    as signed out and wipes a good sign-in. Two real processes contend here
//    — first WITHOUT the lock, which proves the fixture can lose a sign-in at
//    all, then with it: one renewal, both get the same token.
// Run: node scripts/test-native-host.mjs
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const src = (p) => fileURLToPath(new URL(`../src/${p}`, import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'native-host-'))
async function load(entry, name) {
  const outfile = join(dir, name)
  await build({ entryPoints: [src(entry)], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return outfile
}
const shared = await import(pathToFileURL(await load('shared/native-host.ts', 'native-host.mjs')).href)
const renewFile = await load('main/chatgpt-renew.ts', 'chatgpt-renew.mjs')
const lockFile = await load('main/file-lock.ts', 'file-lock.mjs')
const { withFileLock } = await import(pathToFileURL(lockFile).href)

let failures = 0
function ok(cond, msg) {
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`)
const throws = (fn, msg) => {
  try {
    fn()
    ok(false, msg)
  } catch {
    /* expected */
  }
}

// ---------- 1. Framing ----------
console.log('1. stdio framing')
{
  const { encodeFrame, FrameReader } = shared
  const msgs = [{ type: 'status', protocol: 1 }, { type: 'delta', text: 'æøå — 中文 😀' }, { a: [1, 2, 3], s: '\u0000\n"' }]
  const frames = msgs.map(encodeFrame)
  // Length prefix: little-endian, then UTF-8 JSON
  const body = new TextEncoder().encode(JSON.stringify(msgs[1]))
  eq([...frames[1].subarray(0, 4)], [body.length & 255, (body.length >> 8) & 255, 0, 0], 'the length is 4 bytes little-endian')
  eq(frames[1].length, 4 + body.length, 'frame = prefix + UTF-8 bytes (not UTF-16 units)')
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0))
  let o = 0
  for (const f of frames) all.set(f, (o += f.length) - f.length)
  // All at once
  eq(new FrameReader().push(all), msgs, 'three frames in one chunk come out as three messages')
  // Cut at EVERY position, the length prefix included
  let cutsOk = true
  for (let i = 0; i <= all.length; i++) {
    const r = new FrameReader()
    const got = [...r.push(all.subarray(0, i)), ...r.push(all.subarray(i))]
    if (JSON.stringify(got) !== JSON.stringify(msgs) || r.pending !== 0) cutsOk = false
  }
  ok(cutsOk, 'the stream cut at any byte reassembles the same messages')
  // One byte at a time
  const r = new FrameReader()
  const got = []
  for (const b of all) got.push(...r.push(Uint8Array.of(b)))
  eq(got, msgs, 'byte by byte')
  // A half frame is pending, not a message
  const half = new FrameReader()
  eq(half.push(frames[0].subarray(0, 6)), [], 'half a frame gives nothing yet')
  ok(half.pending === 6, 'and is reported pending')
  // Over the limit: refused from the PREFIX, before buffering the body
  const big = new FrameReader(100)
  const prefix = new Uint8Array(4)
  new DataView(prefix.buffer).setUint32(0, 101, true)
  throws(() => big.push(prefix), 'a frame over the limit is refused from its prefix alone')
  throws(() => new FrameReader().push(Uint8Array.of(2, 0, 0, 0, 0x7b, 0x7b)), 'a frame that is not JSON throws')
}

// ---------- 2. Results under Chrome's 1 MB ceiling ----------
console.log('2. results in pieces')
{
  const { resultMessages, encodeFrame, FrameReader, MAX_HOST_MESSAGE } = shared
  const nasty = '\u0001'.repeat(300_000) + '😀'.repeat(200_000) + 'x'.repeat(500_000) // every escape at its widest
  const result = { ok: true, parts: [{ text: nasty }], usage: { input: 1, output: 2 }, model: 'gpt' }
  const messages = resultMessages(result)
  ok(messages.length > 2, 'a 2 MB answer travels in several pieces')
  ok(messages.at(-1).type === 'result', 'closed by a result message')
  ok(messages.every((m) => encodeFrame(m).length <= MAX_HOST_MESSAGE), 'every framed piece is within 1 MB, worst-case escapes included')
  // Reassembled on the other side of a real frame round-trip
  const r = new FrameReader(4 * MAX_HOST_MESSAGE)
  const back = messages.flatMap((m) => r.push(encodeFrame(m)))
  const json = back.filter((m) => m.type === 'result-part').map((m) => m.data).join('')
  eq(JSON.parse(json), result, 'the pieces join to the same result, surrogate pairs cut between pieces included')
  eq(resultMessages({ code: 'ai-aborted', error: 'Avbrutt' }).length, 2, 'a failure is one piece and the close')
}

// ---------- 3. Who may start the host, and where the browser looks ----------
console.log('3. manifest and registration')
{
  const { hostManifest, allowedOrigins, manifestTargets, sanitizeExtraIds, STORE_EXTENSION_IDS, NATIVE_HOST_NAME } = shared
  ok(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(NATIVE_HOST_NAME), 'the host name is one Chrome accepts (lowercase, dots, underscores)')
  eq(STORE_EXTENSION_IDS, { edge: 'jdmemepojgjhflpeckiiciibnhmbdjcc', chrome: 'jhhlaaiegmdmjeeiopmdmoiidnbbhbmd' }, 'the store IDs (MESSAGING.md, STORE.md)')
  const exe = 'C:\\Users\\a b\\AppData\\Local\\Programs\\PDF Scholar\\PDF Scholar.exe'
  eq(
    hostManifest(exe, ['nccjibhokkebnffbghjjfkgcphkpomlk']),
    {
      name: 'no.emil.pdfscholar',
      description: 'PDF Scholar: ChatGPT sign-in for the browser extension',
      path: exe,
      type: 'stdio',
      allowed_origins: [
        'chrome-extension://jdmemepojgjhflpeckiiciibnhmbdjcc/',
        'chrome-extension://jhhlaaiegmdmjeeiopmdmoiidnbbhbmd/',
        'chrome-extension://nccjibhokkebnffbghjjfkgcphkpomlk/'
      ]
    },
    'the manifest: our name, this executable, stdio, the two store builds and the unpacked one'
  )
  ok(JSON.parse(JSON.stringify(hostManifest(exe))).path === exe, 'a path with spaces and backslashes survives JSON')
  eq(allowedOrigins(['jdmemepojgjhflpeckiiciibnhmbdjcc', 'not-an-id', 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP']).length, 2, 'a store ID twice and a malformed one add nothing')
  // Untrusted input: the extra-origins file
  eq(sanitizeExtraIds(['nccjibhokkebnffbghjjfkgcphkpomlk', 'nccjibhokkebnffbghjjfkgcphkpomlk']), ['nccjibhokkebnffbghjjfkgcphkpomlk'], 'an ID twice counts once')
  eq(sanitizeExtraIds({ ids: ['nccjibhokkebnffbghjjfkgcphkpomlk'] }), ['nccjibhokkebnffbghjjfkgcphkpomlk'], 'the { ids } form')
  for (const junk of [null, 'x', 7, {}, [{}], ['*'], ['chrome-extension://nccjibhokkebnffbghjjfkgcphkpomlk/'], ['qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq']])
    eq(sanitizeExtraIds(junk), [], `junk reads as none: ${JSON.stringify(junk)}`)
  eq(sanitizeExtraIds(Array.from({ length: 20 }, (_, i) => String.fromCharCode(97 + (i % 16)).repeat(32))).length, 8, 'at most 8 are taken')
  // Where each browser looks
  eq(
    manifestTargets('win32', 'C:\\Users\\a').registryKeys,
    [
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\no.emil.pdfscholar',
      'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\no.emil.pdfscholar'
    ],
    'Windows: one HKCU key per browser, named after the host'
  )
  eq(manifestTargets('win32', 'C:\\Users\\a').dirs, [], 'Windows: no fixed folders')
  eq(
    manifestTargets('darwin', '/Users/a').dirs,
    [
      '/Users/a/Library/Application Support/Google/Chrome/NativeMessagingHosts',
      '/Users/a/Library/Application Support/Microsoft Edge/NativeMessagingHosts',
      '/Users/a/Library/Application Support/Chromium/NativeMessagingHosts'
    ],
    'macOS: the per-user folders'
  )
  eq(
    manifestTargets('linux', '/home/a').dirs,
    ['/home/a/.config/google-chrome/NativeMessagingHosts', '/home/a/.config/microsoft-edge/NativeMessagingHosts', '/home/a/.config/chromium/NativeMessagingHosts'],
    'Linux: under ~/.config'
  )
  eq(manifestTargets('linux', '/home/a', '/x').dirs[0], '/x/google-chrome/NativeMessagingHosts', 'Linux: XDG_CONFIG_HOME when set')
  // The build-time NSIS cleanup names the same keys
  const nsh = readFileSync(fileURLToPath(new URL('../build/installer.nsh', import.meta.url)), 'utf8')
  for (const key of manifestTargets('win32', '').registryKeys)
    ok(nsh.includes(`DeleteRegKey HKCU "${key.replace(/^HKCU\\/, '')}"`), `the uninstaller removes ${key}`)
  // The extension asks for the permission, and only optionally
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../src/extension/manifest.json', import.meta.url)), 'utf8'))
  ok(manifest.optional_permissions?.includes('nativeMessaging'), 'nativeMessaging is an optional permission')
  ok(!manifest.permissions.includes('nativeMessaging'), '… and not an install-time one (no new warning for existing users)')
}

// ---------- 4. The relay, its launchers, and host mode ----------
console.log('4. relay and launchers')
{
  const { isNativeHostChild, NATIVE_HOST_SWITCH, ReadyStripper, HOST_READY, windowsLauncher, posixLauncher, nativePortFailure, encodeFrame, FrameReader } = shared
  ok(isNativeHostChild(['app.exe', NATIVE_HOST_SWITCH]), 'the relay\'s switch makes the host')
  ok(isNativeHostChild(['electron.exe', 'C:\\app', NATIVE_HOST_SWITCH]), '… also after an unpackaged run\'s app folder')
  ok(!isNativeHostChild(['app.exe']), 'a plain start is not the host')
  ok(!isNativeHostChild(['app.exe', 'chrome-extension://jdmemepojgjhflpeckiiciibnhmbdjcc/', '--parent-window=0']), 'the browser\'s own arguments are not the switch (they reach the relay)')
  ok(!isNativeHostChild([NATIVE_HOST_SWITCH]), 'argv[0] (the executable) is never read')

  // Electron writes «\r\n» on stdout before any code runs (measured on
  // Windows, Electron 43): the relay passes on only what follows the marker
  const frames = [encodeFrame({ type: 'status', account: 'a@b' }), encodeFrame({ type: 'result' })]
  const stream = new Uint8Array([...new TextEncoder().encode('\r\n' + HOST_READY), ...frames[0], ...frames[1]])
  let cutsOk = true
  for (let i = 0; i <= stream.length; i++) {
    const s = new ReadyStripper()
    const r = new FrameReader()
    const out = [...r.push(s.push(stream.subarray(0, i))), ...r.push(s.push(stream.subarray(i)))]
    if (JSON.stringify(out) !== JSON.stringify([{ type: 'status', account: 'a@b' }, { type: 'result' }])) cutsOk = false
  }
  ok(cutsOk, 'Electron\'s stray line break is dropped, whatever the cut — the marker split between reads included')
  const clean = new ReadyStripper()
  eq([...clean.push(new TextEncoder().encode(HOST_READY))], [], 'the marker alone passes nothing on')
  eq([...clean.push(Uint8Array.of(1, 2, 3))], [1, 2, 3], 'after it, bytes pass untouched')
  throws(() => new ReadyStripper(100).push(new Uint8Array(200)), 'junk past the limit without a marker is refused')

  // The launchers: the manifest cannot carry arguments or environment
  const cmd = windowsLauncher('PDF Scholar.exe')
  eq(
    cmd.split('\r\n'),
    ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', '"%~dp0..\\..\\PDF Scholar.exe" "%~dp0pdf-scholar-host.cjs" %*', ''],
    'Windows: echo off FIRST (an echoed line would be read as a frame), Node mode, paths relative to the .cmd'
  )
  ok(/^[\x20-\x7e\r\n]*$/.test(cmd), 'the .cmd is plain ASCII — cmd reads it in the OEM code page, so no absolute path with «ø» may be in it')
  const productName = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).productName
  ok(existsSync(fileURLToPath(new URL('../scripts/build-native-host.mjs', import.meta.url))) && readFileSync(fileURLToPath(new URL('../scripts/build-native-host.mjs', import.meta.url)), 'utf8').includes('windowsLauncher(`${productName}.exe`)'), `the build names the executable after productName («${productName}.exe»)`)
  const builder = readFileSync(fileURLToPath(new URL('../config/electron-builder.yml', import.meta.url)), 'utf8')
  ok(/- from: out\/native-host\s+to: native-host/.test(builder), 'electron-builder ships out/native-host as resources/native-host, where the .cmd\'s ..\\..\\ reaches the executable')
  eq(
    posixLauncher("/home/o'brien/PDF Scholar.AppImage", '/home/o\'brien/.config/PDF Scholar/native-host/pdf-scholar-host.cjs'),
    "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/home/o'\\''brien/PDF Scholar.AppImage' '/home/o'\\''brien/.config/PDF Scholar/native-host/pdf-scholar-host.cjs' \"$@\"\n",
    'macOS/Linux: exec in Node mode, every path single-quoted (a quote in a name too)'
  )

  // What the browser says when a port dies
  eq(nativePortFailure('Specified native messaging host not found.'), 'host-missing', 'not registered = missing')
  eq(nativePortFailure('Access to the specified native messaging host is forbidden.'), 'host-missing', 'not admitted = missing (an old manifest)')
  eq(nativePortFailure('Native host has exited.'), 'host-failed', 'exited = failed')
  eq(nativePortFailure(undefined), 'host-failed', 'no message = failed')
}

// ---------- 5. The lock ----------
console.log('5. the file lock')
{
  const lockDir = mkdtempSync(join(tmpdir(), 'native-host-lock-'))
  const lock = join(lockDir, 'x.lock')
  // Mutual exclusion within one process
  let inside = 0
  let maxInside = 0
  await Promise.all(
    Array.from({ length: 5 }, () =>
      withFileLock(lock, async () => {
        maxInside = Math.max(maxInside, ++inside)
        await new Promise((r) => setTimeout(r, 30))
        inside--
      }, { pollMs: 5 })
    )
  )
  ok(maxInside === 1, 'five contenders, never two inside at once')
  ok(!existsSync(lock), 'the lock is gone afterwards')
  // Released on a throw
  await withFileLock(lock, async () => {
    throw new Error('boom')
  }).catch(() => {})
  ok(!existsSync(lock), 'a throw inside still releases the lock')
  // A dead holder's lock is taken over at once
  writeFileSync(lock, '999999')
  const t0 = Date.now()
  await withFileLock(lock, async () => {}, { pollMs: 5 })
  ok(Date.now() - t0 < 1000, 'a lock naming a dead pid is taken over at once')
  // An old lock is taken over whatever its pid says
  writeFileSync(lock, String(process.pid))
  const old = (Date.now() - 120_000) / 1000
  utimesSync(lock, old, old)
  await withFileLock(lock, async () => {}, { pollMs: 5, staleMs: 60_000 })
  ok(!existsSync(lock), 'a lock older than staleMs is taken over')
  // A live, fresh lock is waited for
  writeFileSync(lock, String(process.pid))
  let entered = false
  const waiting = withFileLock(lock, async () => {
    entered = true
  }, { pollMs: 5 })
  await new Promise((r) => setTimeout(r, 100))
  ok(!entered, 'a live holder is waited for')
  const { rmSync } = await import('node:fs')
  rmSync(lock)
  await waiting
  ok(entered, '… and the lock taken once it lets go')
}

// ---------- 6. Two processes renewing one sign-in ----------
console.log('6. two processes, one renewal')
{
  // Each contender is a real process with the real chatgpt-renew + file-lock.
  // The fake token endpoint behaves like OpenAI's: a refresh spends the token
  // it was given and returns a new one; a spent token is refused (expired).
  // The «server» state is a file both processes share, updated atomically
  // under a lock of its own so the fixture itself cannot race.
  const contender = join(dir, 'contender.mjs')
  writeFileSync(
    contender,
    `
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshChatgptTokens } from ${JSON.stringify(pathToFileURL(renewFile).href)}
import { withFileLock } from ${JSON.stringify(pathToFileURL(lockFile).href)}
const [folder, mode, name] = process.argv.slice(2)
const store = join(folder, 'bundle.json')
const server = join(folder, 'server.json')
const io = {
  read: () => { try { return JSON.parse(readFileSync(store, 'utf8')) } catch { return null } },
  write: (t) => { const tmp = store + '.' + process.pid; writeFileSync(tmp, JSON.stringify(t)); renameSync(tmp, store) }
}
const refresh = async (cur) => {
  appendFileSync(join(folder, 'calls.log'), name + '\\n')
  // The network round trip: long enough that both contenders are in it
  await new Promise((r) => setTimeout(r, 400))
  return withFileLock(join(folder, 'server.lock'), async () => {
    const s = JSON.parse(readFileSync(server, 'utf8'))
    if (cur.refresh !== s.valid) return { ok: false, expired: true, detail: 'invalid_grant' }
    s.n++
    s.valid = 'r' + s.n
    writeFileSync(server, JSON.stringify(s))
    return { ok: true, tokens: { ...cur, access: 'a' + s.n, refresh: s.valid, expires: Date.now() + 3600_000 } }
  }, { pollMs: 5 })
}
// Both start together: wait for the go file
while (true) { try { readFileSync(join(folder, 'go')); break } catch { await new Promise((r) => setTimeout(r, 5)) } }
let result
if (mode === 'nolock') {
  // What one process alone did before: renew from what it read, no lock
  const cur = io.read()
  const r = await refresh(cur)
  if (r.ok) { io.write(r.tokens); result = { ok: true, tokens: r.tokens } }
  else { io.write(null); result = { ok: false, reason: 'expired' } }
} else {
  result = await freshChatgptTokens(io, refresh, join(folder, 'chatgpt-signin.lock'))
}
process.stdout.write(JSON.stringify(result))
`
  )
  const run = (folder, mode, name) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [contender, folder, mode, name], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${name} exited ${code}`))))
    })
  const scenario = async (mode) => {
    const folder = mkdtempSync(join(tmpdir(), `native-host-${mode}-`))
    mkdirSync(folder, { recursive: true })
    // An expired access token, a valid refresh token r0
    writeFileSync(join(folder, 'bundle.json'), JSON.stringify({ access: 'a0', refresh: 'r0', expires: Date.now() - 1000, accountId: 'acc', email: 'e@x' }))
    writeFileSync(join(folder, 'server.json'), JSON.stringify({ n: 0, valid: 'r0' }))
    writeFileSync(join(folder, 'calls.log'), '')
    const both = Promise.all([run(folder, mode, 'app'), run(folder, mode, 'host')])
    await new Promise((r) => setTimeout(r, 300)) // both processes up and waiting
    writeFileSync(join(folder, 'go'), '')
    const results = await both
    const calls = readFileSync(join(folder, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean)
    let stored = null
    try {
      stored = JSON.parse(readFileSync(join(folder, 'bundle.json'), 'utf8'))
    } catch {
      /* removed */
    }
    return { results, calls, stored }
  }

  // Without the lock the fixture must be able to lose the sign-in, or the
  // locked run below proves nothing
  const bare = await scenario('nolock')
  ok(bare.calls.length === 2, 'without the lock: both processes renew')
  ok(bare.results.some((r) => !r.ok && r.reason === 'expired'), 'without the lock: the loser holds a spent token and reads as signed out')

  const locked = await scenario('lock')
  eq(locked.calls.length, 1, 'with the lock: exactly one renewal for two contenders')
  ok(locked.results.every((r) => r.ok), 'with the lock: both get a usable token')
  ok(locked.results[0].ok && locked.results[1].ok && locked.results[0].tokens.access === locked.results[1].tokens.access, '… the SAME token — the second read what the first stored')
  eq(locked.stored?.refresh, 'r1', 'the stored refresh token is the rotated one, still valid at the server')
}

// ---------- 7. The renewal's own rules ----------
console.log('7. renewal rules')
{
  const { freshChatgptTokens, storeChatgptLocked } = await import(pathToFileURL(renewFile).href)
  const folder = mkdtempSync(join(tmpdir(), 'native-host-rules-'))
  const lock = join(folder, 'l.lock')
  let stored = null
  let calls = 0
  const io = { read: () => stored, write: (t) => (stored = t) }
  const now = 1_000_000
  const refreshWith = (r) => async () => (calls++, r)
  eq(await freshChatgptTokens(io, refreshWith(null), lock, () => now), { ok: false, reason: 'signed-out' }, 'nothing stored = signed out, no renewal')
  stored = { access: 'a', refresh: 'r', expires: now + 120_000, accountId: 'x', email: '' }
  ok((await freshChatgptTokens(io, refreshWith(null), lock, () => now)).ok && calls === 0, 'a token with two minutes left is used as it is')
  stored = { ...stored, expires: now + 30_000 }
  const renewed = { ...stored, access: 'b', refresh: 'r2', expires: now + 3_600_000 }
  const r1 = await freshChatgptTokens(io, refreshWith({ ok: true, tokens: renewed }), lock, () => now)
  ok(r1.ok && r1.tokens.access === 'b' && stored.refresh === 'r2' && calls === 1, 'thirty seconds left: renewed first, and the rotated token stored')
  stored = { ...stored, expires: now - 1 }
  eq(await freshChatgptTokens(io, refreshWith({ ok: false, expired: false, detail: 'offline' }), lock, () => now), { ok: false, reason: 'unreachable', detail: 'offline' }, 'offline: named, and…')
  ok(stored !== null, '… the bundle is left alone')
  eq(await freshChatgptTokens(io, refreshWith({ ok: false, expired: true, detail: '401' }), lock, () => now), { ok: false, reason: 'expired' }, 'a refused refresh token: expired, and…')
  ok(stored === null, '… the bundle is dropped')
  await storeChatgptLocked(io, renewed, lock)
  ok(stored === renewed && !existsSync(lock), 'a sign-in is stored under the lock and the lock released')
}

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nnative host: all checks passed')
