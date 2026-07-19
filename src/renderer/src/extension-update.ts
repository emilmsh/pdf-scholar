// Update notice for SIDELOADED extension installs ("Load unpacked").
//
// Chromium only auto-updates extensions installed from a store — a sideloaded
// install has no update channel at all, so users would silently stay on an old
// version forever. This module tells them a newer release exists. It runs ONLY
// when chrome.management.getSelf() reports installType 'development'
// (getSelf needs no extra permission); store installs auto-update and never
// see the notice. The check is an anonymous HTTPS request to the GitHub
// releases API, throttled to once per day (see PRIVACY.md).

import { isExtensionContext } from './extension-api'
import { store } from './extension-store'

const K_UPDATE = 'pdfx-update-check'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const RELEASES_API = 'https://api.github.com/repos/emilmsh/pdf-scholar/releases/latest'
/** Where the toast's download button points (version-stable asset name). */
export const EXTENSION_DOWNLOAD_URL =
  'https://github.com/emilmsh/pdf-scholar/releases/latest/download/pdf-scholar-extension.zip'

interface UpdateCheckState {
  checkedAt?: number
  latest?: string
  /** Version the user dismissed — never nag about it again */
  skipped?: string
}

/** True when `a` is a strictly newer dotted version than `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (Number.isNaN(da) || Number.isNaN(db)) return false
    if (da !== db) return da > db
  }
  return false
}

/** Returns the newer available version to announce, or null (also on any
 *  error — the check must never disturb the viewer). */
export async function checkForExtensionUpdate(): Promise<string | null> {
  if (!isExtensionContext()) return null
  try {
    const self = await chrome?.management?.getSelf()
    if (self?.installType !== 'development') return null
    const current = chrome?.runtime.getManifest().version
    if (!current) return null

    const state = await store.get<UpdateCheckState>(K_UPDATE, {})
    let latest = state.latest
    if (!state.checkedAt || Date.now() - state.checkedAt > CHECK_INTERVAL_MS) {
      const res = await fetch(RELEASES_API)
      if (!res.ok) return null
      const release = (await res.json()) as { tag_name?: string }
      latest = release.tag_name?.replace(/^v/, '')
      await store.set(K_UPDATE, { ...state, checkedAt: Date.now(), latest })
    }

    if (latest && latest !== state.skipped && isNewer(latest, current)) return latest
    return null
  } catch {
    return null
  }
}

/** Remember a dismissed version so the toast doesn't reappear for it. */
export async function skipExtensionUpdate(version: string): Promise<void> {
  try {
    const state = await store.get<UpdateCheckState>(K_UPDATE, {})
    await store.set(K_UPDATE, { ...state, skipped: version })
  } catch {
    /* ignore */
  }
}
