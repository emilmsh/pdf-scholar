// A usable ChatGPT access token, renewed when it is (nearly) out of date —
// shared by the app's assistant (src/main/ai.ts) and the native host the
// browser extension borrows the sign-in through (src/main/native-host.ts).
//
// The refresh token ROTATES: renewing spends it and hands back a new one. Two
// processes renewing from the same stored bundle would leave the loser
// holding a spent token, and a refused refresh reads as «signed out» — the
// loser would wipe a perfectly good sign-in. So a renewal happens under a
// lock in userData that both processes take (file-lock.ts), and the bundle is
// read AGAIN once the lock is held: the other process may have renewed it
// while this one waited, and then there is nothing left to do.
//
// No Electron here (the sealed store is passed in), so the test can run two
// of these in two Node processes against one folder.
import { withFileLock } from './file-lock'

/** What the store keeps (sealed) — see chatgpt-auth.ts for where it comes from */
export interface ChatgptTokens {
  access: string
  refresh: string
  /** Epoch ms when `access` stops working */
  expires: number
  accountId: string
  /** For the settings row («Logget inn som …»); '' when the token has none */
  email: string
}

export type RefreshResult = { ok: true; tokens: ChatgptTokens } | { ok: false; expired: boolean; detail: string }

export interface ChatgptStoreIo {
  read(): ChatgptTokens | null
  write(tokens: ChatgptTokens | null): void
}

export type FreshResult =
  | { ok: true; tokens: ChatgptTokens }
  /** No bundle stored (never signed in, signed out, or not readable here) */
  | { ok: false; reason: 'signed-out' }
  /** The refresh token was refused; the bundle has been dropped */
  | { ok: false; reason: 'expired' }
  /** Renewal failed some other way (offline); the bundle is untouched */
  | { ok: false; reason: 'unreachable'; detail: string }

/** Renew this long before the access token runs out, so a request that
 *  takes a while is not refused half-way */
export const RENEW_MARGIN_MS = 60_000

const usable = (t: ChatgptTokens, now: number): boolean => t.access !== '' && t.expires > now + RENEW_MARGIN_MS

export async function freshChatgptTokens(
  io: ChatgptStoreIo,
  refresh: (current: ChatgptTokens) => Promise<RefreshResult>,
  lockPath: string,
  now: () => number = Date.now
): Promise<FreshResult> {
  const current = io.read()
  if (!current) return { ok: false, reason: 'signed-out' }
  if (usable(current, now())) return { ok: true, tokens: current }
  return withFileLock(lockPath, async (): Promise<FreshResult> => {
    // The other process may have renewed it while we waited
    const latest = io.read()
    if (!latest) return { ok: false, reason: 'signed-out' }
    if (usable(latest, now())) return { ok: true, tokens: latest }
    const r = await refresh(latest)
    if (r.ok) {
      io.write(r.tokens)
      return { ok: true, tokens: r.tokens }
    }
    if (r.expired) {
      io.write(null)
      return { ok: false, reason: 'expired' }
    }
    return { ok: false, reason: 'unreachable', detail: r.detail }
  })
}

/** Store a bundle (sign-in, sign-out) under the same lock, so a sign-in can
 *  never be overwritten by a renewal of the bundle it replaced */
export function storeChatgptLocked(io: ChatgptStoreIo, tokens: ChatgptTokens | null, lockPath: string): Promise<void> {
  return withFileLock(lockPath, async () => io.write(tokens))
}
