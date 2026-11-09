// Where the ChatGPT sign-in is kept: sealed with safeStorage (DPAPI /
// Keychain / the Linux keyring) in a file of its own in userData.
//
// It used to sit in the state file under keys.chatgpt, like an API key. It
// moved because a second process now reads AND renews it — the windowless
// native host the browser starts for the extension (native-host.ts). The
// state file is held in memory by the app and written whole on every save,
// so a bundle the host renewed there would be overwritten by the app's stale
// copy at its next save, spent refresh token and all. A file of its own is
// read fresh on every use by both, and written only under the lock they share
// (chatgpt-renew.ts).
//
// Where there is no key store (Linux without a keyring) the bundle is held in
// memory for this process only, as an API key is (ai.ts) — and the native
// host, a different process, then finds no sign-in.
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatgptStoreIo, ChatgptTokens } from './chatgpt-renew'
import { getState, mergeAiConfig, saveState } from './storage'

const bundleFile = (): string => join(app.getPath('userData'), 'chatgpt-signin.bin')
export const chatgptLockPath = (): string => join(app.getPath('userData'), 'chatgpt-signin.lock')

/** The bundle as JSON, for this process only, where nothing can be sealed */
let sessionBundle: string | null = null

function unseal(sealed: string): string {
  if (!sealed) return ''
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    // Sealed by another OS user, or the key store was reset: not ours to read
    return ''
  }
}

function readPlain(): string {
  if (sessionBundle !== null) return sessionBundle
  try {
    return unseal(readFileSync(bundleFile(), 'utf8').trim())
  } catch {
    // No file yet. A bundle stored by a version before the move is still in
    // the state file until the app next starts (migrateChatgptBundle) — the
    // host may run first after an update, and reads it there (never writes it)
    return unseal(getState().ai.keys.chatgpt ?? '')
  }
}

export function loadChatgpt(): ChatgptTokens | null {
  const raw = readPlain()
  if (!raw) return null
  try {
    const t = JSON.parse(raw) as ChatgptTokens
    return t.refresh ? t : null
  } catch {
    return null
  }
}

function writeSealed(sealed: string): void {
  const file = bundleFile()
  mkdirSync(dirname(file), { recursive: true })
  // Atomic: a crash mid-write must not leave half a bundle
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, sealed)
  renameSync(tmp, file)
}

/** Write (or with null, remove) the bundle. Call it holding the lock —
 *  through `freshChatgptTokens` or `storeChatgptLocked`. */
function writeChatgpt(tokens: ChatgptTokens | null): void {
  const plain = tokens ? JSON.stringify(tokens) : ''
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      sessionBundle = plain || null
      rmSync(bundleFile(), { force: true })
      return
    }
    sessionBundle = null
    if (!plain) rmSync(bundleFile(), { force: true })
    else writeSealed(safeStorage.encryptString(plain).toString('base64'))
  } catch (err) {
    console.error('[pdfx] could not store the ChatGPT sign-in:', err)
  }
}

export const chatgptIo: ChatgptStoreIo = { read: loadChatgpt, write: writeChatgpt }

/** App start: a bundle still in the state file moves to its own file (sealed
 *  as it was — nothing is decrypted), and the state file forgets it. A file
 *  already there wins: the host renewed it after the update. */
export function migrateChatgptBundle(): void {
  const state = getState()
  const legacy = state.ai.keys.chatgpt ?? ''
  if (!legacy) return
  try {
    if (!existsSync(bundleFile())) writeSealed(legacy)
  } catch (err) {
    console.error('[pdfx] could not move the ChatGPT sign-in out of the state file:', err)
    return
  }
  state.ai = mergeAiConfig(state.ai, { keys: { chatgpt: '' } })
  saveState()
}
