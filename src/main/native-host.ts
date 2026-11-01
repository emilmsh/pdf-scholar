// The app as a native-messaging HOST: started (through the relay,
// native-host-relay.ts) when the browser extension asks for the ChatGPT plan,
// never by the reader (shared/native-host.ts has the why, the message shapes
// and the framing; docs/PLATFORMS.md §25).
//
// It is the app's own executable in Electron mode because only Electron can
// unseal the sign-in (safeStorage) — a Node script like the MCP server's
// could not. index.ts hands over before the single-instance lock, so a
// running app is neither asked nor disturbed: this process opens no window,
// takes no lock, starts no updater, and leaves when the port closes (stdin
// ends).
//
// What it does, and all it does: says which account is signed in, and runs
// one chat request at a time against the ChatGPT plan with the same
// `runProviderChat` the desktop's assistant uses, streaming the deltas back.
// No token leaves it. The browser starts a fresh host per port (one per
// request), so there is no state between requests to keep.
//
// stdout IS the channel: one stray console.log would corrupt a frame, so the
// console goes to stderr (which the browser drops) before anything else runs.
import { app } from 'electron'
import { createReadStream, writeSync } from 'node:fs'
import type { AiChatResult, AiCitation, AiDeltaKind, FileError } from '../shared/types'
import { runProviderChat } from '../shared/ai-chat'
import { AI_ERRORS } from '../shared/engine-errors'
import { DEFAULT_AI_MODELS } from '../shared/defaults'
import {
  FrameReader,
  HOST_READY,
  NATIVE_HOST_PROTOCOL,
  encodeFrame,
  resultMessages,
  type HostMessage,
  type HostRequest
} from '../shared/native-host'
import { refreshChatgpt } from './chatgpt-auth'
import { freshChatgptTokens } from './chatgpt-renew'
import { chatgptIo, chatgptLockPath, loadChatgpt } from './chatgpt-store'

const THINKING = new Set(['off', 'low', 'medium', 'high'])

function send(message: HostMessage): void {
  const frame = encodeFrame(message)
  let off = 0
  // writeSync on a pipe may take less than it was given
  while (off < frame.length) off += writeSync(1, frame, off, frame.length - off)
}

/** The sign-in as the extension should name its failure: it cannot sign in
 *  here, so every «sign in again» points at the desktop app */
async function access(): Promise<{ access: string; accountId: string } | FileError> {
  const r = await freshChatgptTokens(chatgptIo, refreshChatgpt, chatgptLockPath())
  if (r.ok) return r.tokens
  if (r.reason === 'unreachable') return AI_ERRORS.endpointUnreachable('auth.openai.com', r.detail)
  return AI_ERRORS.chatgptDesktopSignedOut
}

async function handle(msg: HostRequest, signal: AbortSignal): Promise<void> {
  if (msg.protocol !== NATIVE_HOST_PROTOCOL) {
    send({ type: 'error', error: AI_ERRORS.chatgptHostOutdated })
    return
  }
  if (msg.type === 'status') {
    const t = loadChatgpt()
    if (!t) send({ type: 'error', error: AI_ERRORS.chatgptDesktopSignedOut })
    else send({ type: 'status', account: t.email || t.accountId })
    return
  }
  if (typeof msg.model !== 'string' || !THINKING.has(msg.thinking) || !msg.request) {
    send({ type: 'error', error: AI_ERRORS.chatgptHostFailed('malformed request') })
    return
  }
  const tokens = await access()
  if (!('access' in tokens)) {
    send({ type: 'error', error: tokens })
    return
  }
  const emit = (text: string, kind?: AiDeltaKind, citation?: AiCitation): void =>
    send({ type: 'delta', text, ...(kind ? { kind } : {}), ...(citation ? { citation } : {}) })
  let result: AiChatResult = await runProviderChat({
    provider: 'chatgpt',
    key: tokens.access,
    chatgptAccountId: tokens.accountId,
    models: { ...DEFAULT_AI_MODELS, chatgpt: msg.model || DEFAULT_AI_MODELS.chatgpt },
    azure: { endpoint: '', deployment: '', apiVersion: '' },
    compat: { baseUrl: '' },
    thinking: msg.thinking,
    req: msg.request,
    emit,
    signal
  })
  // The backend refused a token we just renewed: the sign-in is gone, and it
  // is the desktop app that can get it back
  if ('code' in result && (result.code === 'ai-chatgpt-session-expired' || result.code === 'ai-chatgpt-signed-out'))
    result = AI_ERRORS.chatgptDesktopSignedOut
  for (const m of resultMessages(result)) send(m)
}

export function runNativeHost(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n')
  }
  console.log = console.info = console.warn = console.debug = toStderr
  // The relay passes on only what follows this
  writeSync(1, HOST_READY)
  app.disableHardwareAcceleration()
  app.dock?.hide()

  const controller = new AbortController()
  const reader = new FrameReader()
  let busy: Promise<void> = Promise.resolve()
  // Leave only once the work in hand has settled. The chat stops at once on
  // the abort; a RENEWAL is never aborted (refreshChatgpt takes no signal) —
  // the refresh token rotates the moment OpenAI answers, and a host killed
  // between that answer and the write would leave a spent token stored,
  // which reads as signed out. refreshChatgpt's own timeout bounds the wait.
  let leaving = false
  const quit = (): void => {
    if (leaving) return
    leaving = true
    controller.abort()
    void busy.finally(() => app.exit(0))
  }

  // fd 0 read as a file: Chrome hands the host a pipe for stdin, and reading
  // the descriptor directly works the same in a GUI-subsystem executable on
  // Windows, where process.stdin's own detection is less sure-footed
  const input = createReadStream('', { fd: 0, autoClose: false })
  input.on('data', (chunk) => {
    let messages: unknown[]
    try {
      messages = reader.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
    } catch {
      quit()
      return
    }
    for (const m of messages) {
      // In order, one at a time; safeStorage wants the app ready
      busy = busy
        .then(() => app.whenReady())
        .then(() => handle(m as HostRequest, controller.signal))
        .catch((err: unknown) => {
          try {
            send({ type: 'error', error: AI_ERRORS.chatgptHostFailed(err instanceof Error ? err.message : String(err)) })
          } catch {
            /* the port is gone */
          }
        })
    }
  })
  // The port closed (the request finished, was aborted, or the tab went):
  // stop whatever is running and leave
  input.on('end', quit)
  input.on('error', quit)
}
