// What a tab shows when its name alone does not tell it apart from the others
// (Emil, 2026-10-28: a full strip read «Hortacs…», «Hortacs…», «Handb…»,
// «Handb…»). Two cases, the two VS Code handles:
//
//  - The SAME name on two paths (two «main.pdf», one paper saved twice): the
//    folder is what differs, so the tab carries the shortest run of trailing
//    folders that sets it apart, dimmed after the name.
//  - Names that only BEGIN alike («Hortacsu Syverson 2015», «Hortacsu Puller
//    2008»): an end ellipsis cuts exactly the part that differs. The name is
//    split where it parts from its neighbour, and the strip shrinks the head
//    before the tail — «Hort…Syverson 2015». Head + tail is always the whole
//    name, so a tab wide enough reads exactly as before.
//
// Pure, so test:tab-labels can hold the rules.

export interface TabLabelInput {
  name: string
  path: string
}

export interface TabLabel {
  /** The part of the name that may give way first */
  head: string
  /** The part that tells the name from a neighbour's ('' when nothing does) */
  tail: string
  /** Trailing folders that tell an identical name apart, or null */
  dir: string | null
}

/** Shared beginnings shorter than this survive an end ellipsis on their own —
 *  a tab at its narrowest still shows about a dozen characters. */
export const MIN_SHARED = 6
/** A split never leaves less than this of the head (it would read as noise) */
const MIN_HEAD = 3
/** The tail starts at the word the names part in, unless that word is long —
 *  then a few characters before the difference, so the difference shows. */
const MAX_WORD_BACKTRACK = 12
const WORD_BREAK = /[\s_\-.,;()[\]]/

/** The folders a path lies in, outermost first. A URL's query and fragment
 *  are not folders; neither is its scheme. */
export function folderSegments(path: string): string[] {
  const bare = path.replace(/[?#].*$/, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const parts = bare.split(/[\\/]+/).filter((p) => p !== '')
  return parts.slice(0, -1)
}

/** The folder a document lies in, for a second line under its name; '' when
 *  the path names none */
export function folderOf(path: string): string {
  const segments = folderSegments(path)
  return segments[segments.length - 1] ?? ''
}

function fold(s: string): string {
  return s.toLocaleLowerCase()
}

function sharedLength(a: string, b: string): number {
  const x = fold(a)
  const y = fold(b)
  const n = Math.min(x.length, y.length)
  let i = 0
  while (i < n && x[i] === y[i]) i++
  return i
}

/** Where to cut `name`, given that its first `shared` characters are also
 *  another tab's; null to leave it whole. */
function splitPoint(name: string, shared: number): number | null {
  if (shared < MIN_SHARED || shared >= name.length) return null
  let start = shared
  // Parting AT a break («Handbook of IO» / «Handbook of IO vol 2») cuts there;
  // parting mid-word goes back to that word's start
  if (!WORD_BREAK.test(name[shared])) {
    while (start > 0 && !WORD_BREAK.test(name[start - 1])) start--
  }
  if (shared - start > MAX_WORD_BACKTRACK) start = shared - 3
  return start >= MIN_HEAD ? start : null
}

/** The trailing folders, joined by the path's own separator, that set each of
 *  `paths` (all bearing one name) apart; the fewest that do it for all. */
function distinguishingDirs(paths: string[]): string[] {
  const segs = paths.map(folderSegments)
  const sep = paths.map((p) => (p.includes('\\') && !p.includes('/') ? '\\' : '/'))
  const deepest = Math.max(1, ...segs.map((s) => s.length))
  let labels: string[] = []
  for (let k = 1; k <= deepest; k++) {
    labels = segs.map((s, i) => s.slice(-k).join(sep[i]))
    if (new Set(labels.map(fold)).size === labels.length) return labels
  }
  return labels
}

export function tabLabels(tabs: readonly TabLabelInput[]): TabLabel[] {
  const out: TabLabel[] = tabs.map((tab) => ({ head: tab.name, tail: '', dir: null }))

  // The same name on different paths: folders. A tab duplicated on ONE path is
  // the same document, and no folder could tell it apart anyway.
  const byName = new Map<string, number[]>()
  tabs.forEach((tab, i) => {
    const key = fold(tab.name)
    byName.set(key, [...(byName.get(key) ?? []), i])
  })
  for (const indices of byName.values()) {
    const paths = [...new Set(indices.map((i) => tabs[i].path))]
    if (paths.length < 2) continue
    const dirs = distinguishingDirs(paths)
    for (const i of indices) {
      const dir = dirs[paths.indexOf(tabs[i].path)]
      out[i].dir = dir === '' ? null : dir
    }
  }

  // Names that begin alike: cut where they part from the closest neighbour.
  // Identical names were handled above — their difference is not in the name.
  tabs.forEach((tab, i) => {
    let shared = 0
    for (const other of tabs) {
      if (fold(other.name) === fold(tab.name)) continue
      shared = Math.max(shared, sharedLength(tab.name, other.name))
    }
    const at = splitPoint(tab.name, shared)
    if (at === null) return
    out[i].head = tab.name.slice(0, at)
    out[i].tail = tab.name.slice(at)
  })
  return out
}

/** The «Alle faner» search: every word of the query must occur in the name or
 *  the path, case-folded; an empty query keeps every tab. */
export function matchesTabQuery(tab: TabLabelInput, query: string): boolean {
  const words = fold(query).split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return true
  const hay = fold(`${tab.name} ${tab.path}`)
  return words.every((w) => hay.includes(w))
}
