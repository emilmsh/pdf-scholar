// The extension borrowing the desktop app's ChatGPT sign-in, through
// Chrome/Edge native messaging (docs/PLATFORMS.md §25).
//
// The sign-in itself cannot happen in an extension: the Codex client's
// redirect is registered to http://localhost:1455, and only a process that
// can listen on a port receives it. What the extension CAN do is ask the
// installed desktop app, which the browser starts on demand as a «native
// host» — the app's own executable, windowless (src/main/native-host.ts).
//
// In TWO steps, because Electron writes a stray line break to stdout before
// any of our code runs (measured 2026-11-01 on Windows with Electron 43: every
// start in Electron mode printed «\r\n» first, Node mode nothing) — and the
// browser reads the first four bytes on that pipe as a length. So what the
// browser starts is a small RELAY: a launcher script runs the app's executable
// in Node mode (ELECTRON_RUN_AS_NODE, like the MCP server) on
// native-host-relay.ts, which owns the browser's pipes, starts the app again
// in Electron mode with NATIVE_HOST_SWITCH, and passes the child's output on
// only from the HOST_READY marker the child writes first.
//
// The host PROXIES the request rather than handing out a token: it unseals
// the bundle (safeStorage — only Electron can), renews it under a lock the app
// shares, and runs the same `runProviderChat` the desktop's assistant does,
// streaming deltas back. So neither the refresh token nor the access token
// ever reaches the extension, and the request leaves exactly as the desktop's
// does — a fetch from an extension page would carry a chrome-extension://
// Origin the Codex backend has never been tried with.
//
// This file is the part every side shares and the test reads: the host's
// name and who may start it, the launchers, the message shapes, the stdio
// framing (Chrome frames each JSON message with a 4-byte length in native
// byte order), and where the manifest goes per OS. Platform-neutral on
// purpose — no Node, no chrome.* — so the renderer can import the types.
import type { AiChatRequest, AiCitation, AiChatResult, AiDeltaKind, FileError, ThinkingLevel } from './types'

/** The name the extension connects to and the manifest registers. Lowercase,
 *  dots and underscores only — Chrome refuses anything else. */
export const NATIVE_HOST_NAME = 'no.emil.pdfscholar'

/** Bumped when a message shape changes incompatibly; the host refuses a
 *  request for another version by name instead of misreading it. */
export const NATIVE_HOST_PROTOCOL = 1

/** What the relay starts the app with: the switch into host mode. A reader
 *  launching the app with it gets a process waiting on stdin, nothing more. */
export const NATIVE_HOST_SWITCH = '--pdfx-native-host'

/** The host's first bytes on stdout; the relay passes on only what follows */
export const HOST_READY = 'PDFX-NATIVE-HOST-READY\n'

/** The relay's file name, and the launcher's beside it */
export const RELAY_SCRIPT = 'pdf-scholar-host.cjs'
export const WINDOWS_LAUNCHER = 'pdf-scholar-host.cmd'
export const POSIX_LAUNCHER = 'pdf-scholar-host'

/** The published extensions (docs/MESSAGING.md, docs/STORE.md) */
export const STORE_EXTENSION_IDS = {
  edge: 'jdmemepojgjhflpeckiiciibnhmbdjcc',
  chrome: 'jhhlaaiegmdmjeeiopmdmoiidnbbhbmd'
} as const

/** The file in userData naming further extension IDs the host admits — the
 *  unpacked build `npm run ext:local` keeps in the main checkout writes its
 *  own there (its ID is derived from its folder, so no constant can name it) */
export const EXTRA_ORIGINS_FILE = 'native-host-origins.json'

const ID_RE = /^[a-p]{32}$/

export const isExtensionId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s)

export const extensionOrigin = (id: string): string => `chrome-extension://${id}/`

/** The IDs in an extra-origins file — untrusted input: anything but a list of
 *  well-formed IDs reads as none, and at most 8 are taken */
export function sanitizeExtraIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { ids?: unknown }).ids : null
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter(isExtensionId))].slice(0, 8)
}

/** Every origin the manifest admits: the two store builds, then the extras */
export function allowedOrigins(extraIds: readonly string[] = []): string[] {
  const ids = [STORE_EXTENSION_IDS.edge, STORE_EXTENSION_IDS.chrome, ...extraIds.filter(isExtensionId)]
  return [...new Set(ids)].map(extensionOrigin)
}

/** Whether this process is the host the relay started */
export const isNativeHostChild = (argv: readonly string[]): boolean => argv.slice(1).includes(NATIVE_HOST_SWITCH)

// ---------- Manifest ----------

export interface NativeHostManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

export function hostManifest(executable: string, extraIds: readonly string[] = []): NativeHostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: 'PDF Scholar: ChatGPT sign-in for the browser extension',
    path: executable,
    type: 'stdio',
    allowed_origins: allowedOrigins(extraIds)
  }
}

/** Where each browser looks for the manifest. Windows: a registry key per
 *  browser whose default value is the manifest's path (HKCU — no admin, and
 *  the per-user install is the only one we ship). macOS and Linux: a fixed
 *  folder per browser holding `<name>.json`. `home` is the user's home folder;
 *  `configHome` Linux's XDG_CONFIG_HOME when set. */
export function manifestTargets(
  platform: string,
  home: string,
  configHome?: string
): { registryKeys: string[]; dirs: string[] } {
  if (platform === 'win32') {
    return {
      registryKeys: [
        `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
        `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      ],
      dirs: []
    }
  }
  if (platform === 'darwin') {
    const base = `${home}/Library/Application Support`
    return {
      registryKeys: [],
      dirs: ['Google/Chrome', 'Microsoft Edge', 'Chromium'].map((b) => `${base}/${b}/NativeMessagingHosts`)
    }
  }
  const base = configHome || `${home}/.config`
  return {
    registryKeys: [],
    dirs: ['google-chrome', 'microsoft-edge', 'chromium'].map((b) => `${base}/${b}/NativeMessagingHosts`)
  }
}

// ---------- Launchers ----------
//
// The manifest's `path` cannot carry arguments or environment, so it names a
// launcher script that adds both.

/** Windows: a .cmd the browser runs through cmd.exe, shipped in
 *  resources\native-host beside the relay. Only relative paths: cmd reads a
 *  batch file in the console's OEM code page, so an absolute path holding
 *  the user's name («Strøm») would be misread — %~dp0 (this file's folder)
 *  is expanded by cmd itself, in Unicode. `@echo off` first: an echoed
 *  command line on stdout would be read as a frame. */
export function windowsLauncher(exeName: string): string {
  return [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    `"%~dp0..\\..\\${exeName}" "%~dp0${RELAY_SCRIPT}" %*`,
    ''
  ].join('\r\n')
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** macOS and Linux: a shell script written into userData beside a copy of
 *  the relay (an AppImage's own folder moves on every launch). `exec`, so
 *  the process the browser holds IS the relay. */
export function posixLauncher(executable: string, relay: string): string {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(executable)} ${shQuote(relay)} "$@"\n`
}

/** Drops whatever the child wrote before HOST_READY (and the marker), then
 *  passes everything on. Junk past `max` bytes without a marker means this
 *  is not our host talking: it throws. */
export class ReadyStripper {
  private seen = ''
  private ready = false
  constructor(private readonly max = 64 * 1024) {}

  push(chunk: Uint8Array): Uint8Array {
    if (this.ready) return chunk
    // latin1: one char per byte, so an index into the string is one into bytes
    let text = ''
    for (const b of chunk) text += String.fromCharCode(b)
    const before = this.seen.length
    this.seen += text
    const at = this.seen.indexOf(HOST_READY)
    if (at < 0) {
      if (this.seen.length > this.max) throw new Error('the host never said it was ready')
      // Nothing to pass on yet
      return new Uint8Array(0)
    }
    this.ready = true
    const from = at + HOST_READY.length - before
    this.seen = ''
    return chunk.subarray(Math.max(0, from))
  }
}

// ---------- Messages ----------

/** Extension → host */
export type HostRequest =
  | { type: 'status'; protocol: number }
  | {
      type: 'chat'
      protocol: number
      /** The extension's own choices — its model menu and thinking setting,
       *  never the desktop's */
      model: string
      thinking: ThinkingLevel
      request: AiChatRequest
    }

/** Host → extension. A result is sent as `result-part` pieces and closed by
 *  `result` — Chrome refuses any single message from a host over 1 MB, and an
 *  answer with its citations can in principle pass that. */
export type HostMessage =
  | { type: 'status'; account: string }
  | { type: 'delta'; text: string; kind?: AiDeltaKind; citation?: AiCitation }
  | { type: 'result-part'; data: string }
  | { type: 'result' }
  | { type: 'error'; error: FileError }

/** Chrome's ceiling on one message FROM a host */
export const MAX_HOST_MESSAGE = 1024 * 1024
/** Our own ceiling on one message TO the host (Chrome allows 4 GB): a page
 *  rendered as an image is a few MB, ten of them a few tens */
export const MAX_REQUEST_MESSAGE = 256 * 1024 * 1024

/** A result as the messages that carry it, each under the 1 MB ceiling once
 *  framed: a piece of 128k UTF-16 units is at most 6 bytes a unit even if
 *  every one needed a \u escape (768 KB). A surrogate pair cut between two
 *  pieces travels as two escaped halves and joins again on the other side. */
export function resultMessages(result: AiChatResult, pieceChars = 128 * 1024): HostMessage[] {
  const json = JSON.stringify(result)
  const out: HostMessage[] = []
  for (let i = 0; i < json.length; i += pieceChars) out.push({ type: 'result-part', data: json.slice(i, i + pieceChars) })
  out.push({ type: 'result' })
  return out
}

// ---------- Framing ----------
//
// 4-byte length in NATIVE byte order, then that many bytes of UTF-8 JSON.
// Every platform we ship on (x64, arm64) is little-endian, so it is written
// and read as such.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeFrame(message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message))
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, true)
  out.set(body, 4)
  return out
}

/** Reassembles frames from a byte stream cut anywhere — a pipe hands over
 *  whatever it has, a length prefix split across two reads included. Throws
 *  on a frame over `max` (before buffering it) or on one that is not JSON;
 *  either way the stream cannot be trusted further and the host exits. */
export class FrameReader {
  private buf = new Uint8Array(0)
  constructor(private readonly max = MAX_REQUEST_MESSAGE) {}

  push(chunk: Uint8Array): unknown[] {
    const joined = new Uint8Array(this.buf.length + chunk.length)
    joined.set(this.buf)
    joined.set(chunk, this.buf.length)
    this.buf = joined
    const out: unknown[] = []
    for (;;) {
      if (this.buf.length < 4) break
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, true)
      if (len > this.max) throw new Error(`frame of ${len} bytes is over the ${this.max}-byte limit`)
      if (this.buf.length < 4 + len) break
      out.push(JSON.parse(decoder.decode(this.buf.subarray(4, 4 + len))))
      this.buf = this.buf.slice(4 + len)
    }
    return out
  }

  /** Bytes of an unfinished frame still waiting — a stream that ends with
   *  any was cut off */
  get pending(): number {
    return this.buf.length
  }
}

// ---------- Browser side ----------

/** What `chrome.runtime.lastError` says when a native port dies, as a code.
 *  Chromium's wording (native_message_process_host.cc) is stable since 2014;
 *  anything it does not match is a host that started and then failed. */
export function nativePortFailure(message: string | undefined): 'host-missing' | 'host-failed' {
  const m = (message ?? '').toLowerCase()
  if (m.includes('not found') || m.includes('forbidden')) return 'host-missing'
  return 'host-failed'
}
