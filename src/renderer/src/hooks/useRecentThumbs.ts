// The library's grid view (issue #28): the stored first-page pictures of the
// recents as image URLs, plus the one-time drawing of the ones never taken.
//
// A picture is normally taken by the viewer while the document is open (see
// recent-thumbs.ts). An entry opened before the reader chose the grid has none,
// and a grid of placeholders is a poor first sight — so the grid draws those
// itself, ONCE each: one file at a time, after the library has painted, from
// bytes read without readFile's side effects (readRecentForThumb), into a
// throwaway pdf.js document. A file that cannot be drawn (gone, too large, a
// URL in the extension) is not asked again this session.
import { useEffect, useRef, useState } from 'react'
import type { RecentFile, RecentThumb, RecentThumbView } from '../../../shared/types'
import { bridge } from '../bridge'
import { isPasswordException, openDocument } from '../pdf-doc'
import { takeRecentThumb, whenIdle } from '../recent-thumbs'

export interface RecentThumbEntry {
  /** Object URL of the picture; absent = draw a placeholder */
  url?: string
  pages: number
  locked?: boolean
  /** Page of the saved reading position */
  page?: number
}

/** Paths the drawing gave up on, for the rest of the session */
const undrawable = new Set<string>()

/** Draw the picture for a recents entry from its file, or null when it cannot
 *  be read here or does not open. A locked file comes back as a lock — the
 *  grid has no password to offer it, and would keep no picture if it had. */
async function drawFromFile(path: string): Promise<RecentThumb | null> {
  const bytes = await bridge.readRecentForThumb(path)
  if (!bytes) return null
  const resources = openDocument(bytes)
  try {
    return await takeRecentThumb(await resources.task.promise, false)
  } catch (err) {
    return isPasswordException(err) ? { pages: 0, locked: true, taken: Date.now() } : null
  } finally {
    void resources.task.destroy()
    resources.port.terminate()
  }
}

export function useRecentThumbs(
  recents: RecentFile[],
  enabled: boolean
): Record<string, RecentThumbEntry> {
  const [entries, setEntries] = useState<Record<string, RecentThumbEntry>>({})
  /** Object URLs by path, with the `taken` stamp they were made from — a
   *  refresh that brings the same picture back keeps its URL, so the image
   *  does not blink on every return to the library. */
  const urls = useRef(new Map<string, { taken: number; url: string }>())

  useEffect(() => {
    const held = urls.current
    return () => {
      for (const { url } of held.values()) URL.revokeObjectURL(url)
      held.clear()
    }
  }, [])

  useEffect(() => {
    if (!enabled || recents.length === 0) return
    let cancelled = false
    let cancelIdle: (() => void) | undefined

    const entryOf = (path: string, thumb: RecentThumbView): RecentThumbEntry => {
      const entry: RecentThumbEntry = { pages: thumb.pages }
      if (thumb.locked) entry.locked = true
      if (thumb.page !== undefined) entry.page = thumb.page
      if (thumb.image) {
        const cached = urls.current.get(path)
        if (cached?.taken === thumb.taken) {
          entry.url = cached.url
        } else {
          if (cached) URL.revokeObjectURL(cached.url)
          entry.url = URL.createObjectURL(new Blob([thumb.image as BlobPart], { type: 'image/jpeg' }))
          urls.current.set(path, { taken: thumb.taken, url: entry.url })
        }
      }
      return entry
    }

    void (async () => {
      const stored = await bridge.getRecentThumbs()
      if (cancelled) return
      const next: Record<string, RecentThumbEntry> = {}
      for (const { path } of recents) {
        const thumb = stored[path]
        if (thumb) next[path] = entryOf(path, thumb)
      }
      for (const [path, { url }] of urls.current) {
        if (next[path]?.url === url) continue
        URL.revokeObjectURL(url)
        urls.current.delete(path)
      }
      setEntries(next)

      const missing = recents.map((r) => r.path).filter((p) => !stored[p] && !undrawable.has(p))
      if (missing.length === 0) return
      await new Promise<void>((resolve) => {
        cancelIdle = whenIdle(resolve)
      })
      for (const path of missing) {
        if (cancelled) return
        const thumb = await drawFromFile(path)
        if (!thumb) {
          undrawable.add(path)
          continue
        }
        // Kept even if the library closed meanwhile: the work is done
        bridge.setRecentThumb(path, thumb)
        if (cancelled) return
        const page = (await bridge.getPosition(path))?.page
        if (cancelled) return
        const view: RecentThumbView = page === undefined ? thumb : { ...thumb, page }
        setEntries((prev) => ({ ...prev, [path]: entryOf(path, view) }))
      }
    })()

    return () => {
      cancelled = true
      cancelIdle?.()
    }
  }, [recents, enabled])

  return enabled ? entries : {}
}
