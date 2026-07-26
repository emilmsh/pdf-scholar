// At-rest protection for the browser extension's API keys.
//
// The extension has no access to an OS key store — there is no chrome.* API for
// DPAPI or Keychain — so it cannot match the desktop. What it CAN do is stop the
// key from sitting in chrome.storage.local as readable text: encrypt it with
// AES-GCM under a key that no script can read back.
//
// The trick is `extractable: false`. A CryptoKey generated that way can be
// structured-cloned into IndexedDB and used to encrypt and decrypt, but
// `crypto.subtle.exportKey` on it throws InvalidAccessError — so even code
// running in this extension's own page cannot print the AES key out.
//
// BE PRECISE ABOUT WHAT THIS BUYS (see KeyStorageMode in shared/types.ts):
//   - It defeats anything that merely READS the profile: a backup, a synced
//     copy, another program on disk, someone poking at the extension's storage.
//     They get ciphertext and a key handle they cannot export.
//   - It does NOT defeat code running inside this browser profile. Such code can
//     ask the browser to decrypt, exactly as this module does.
//   - Chrome makes no promise that the key MATERIAL is encrypted at rest inside
//     the IndexedDB files, so a determined attacker with raw file access could
//     still reassemble it. This is defence in depth, not a keychain, and the UI
//     says so rather than claiming parity with the desktop.
//
// If IndexedDB or WebCrypto is unavailable (a hardened profile, some private
// modes), we do NOT silently write plaintext: `seal` reports failure and the
// caller keeps the key in memory for the session instead.

const DB_NAME = 'pdfx-key-crypto'
const STORE = 'kek'
const ENTRY = 'aes-gcm'
/** Marks a value as sealed by this module, so a legacy plaintext key is
 *  distinguishable and can be migrated rather than mis-decrypted. */
const PREFIX = 'v1:'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** The one non-extractable AES key for this profile, created on first use.
 *  Cached, because every chat turn reads a key. */
let kekPromise: Promise<CryptoKey | null> | null = null

function getKek(): Promise<CryptoKey | null> {
  return (kekPromise ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined' || !crypto?.subtle) return null
      const db = await openDb()
      try {
        const existing = await idbGet(db, ENTRY)
        if (existing && (existing as CryptoKey).type === 'secret') return existing as CryptoKey
        const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
          'encrypt',
          'decrypt'
        ])
        await idbPut(db, ENTRY, fresh)
        return fresh
      } finally {
        db.close()
      }
    } catch {
      // No usable store — the caller falls back to session-only, never plaintext
      return null
    }
  })())
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromBase64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** True when the value was written by this module (rather than being a plaintext
 *  key stored by an older version). */
export const isSealed = (stored: string): boolean => stored.startsWith(PREFIX)

/** Encrypt a key for storage. Returns null when this profile has no usable
 *  crypto store, which the caller MUST treat as "do not persist". */
export async function seal(plain: string): Promise<string | null> {
  const kek = await getKek()
  if (!kek) return null
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, new TextEncoder().encode(plain))
  )
  const joined = new Uint8Array(iv.length + ct.length)
  joined.set(iv)
  joined.set(ct, iv.length)
  return PREFIX + toBase64(joined)
}

/** Decrypt a stored value. A value this module did not write is returned
 *  unchanged (a legacy plaintext key); an unopenable sealed value returns ''
 *  so the UI shows "no key" and the user re-enters it, rather than the settings
 *  claiming a key exists while every request fails. */
export async function unseal(stored: string): Promise<string> {
  if (!stored) return ''
  if (!isSealed(stored)) return stored
  const kek = await getKek()
  if (!kek) return ''
  try {
    const joined = fromBase64(stored.slice(PREFIX.length))
    // Copies, not subarrays: a subarray's buffer type widens to ArrayBufferLike,
    // which WebCrypto's BufferSource does not accept.
    const iv = new Uint8Array(joined.slice(0, 12))
    const ct = new Uint8Array(joined.slice(12))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct)
    return new TextDecoder().decode(pt)
  } catch {
    return ''
  }
}

/** Whether at-rest encryption is actually working in this profile — drives the
 *  storage mode the settings panel reports. */
export async function sealingAvailable(): Promise<boolean> {
  return (await getKek()) !== null
}
