// The name a first run puts in «Navn på merknader» (settings.annotAuthor) —
// Simen's wish, 2026-11-23: the reader's own name filled in, editable as before.
//
// Filled in ONCE (AppState.annotAuthorSeeded): a reader who clears the field
// wants unsigned marks, and the next launch must not sign them again. A name
// already typed is never replaced.
//
// Where the name comes from is main's business (src/main/system-user-name.ts):
// on Windows the name Office signs Word comments with, then the login name;
// macOS's full name; Linux's GECOS field. Every one of them is outside input,
// so it passes `cleanAuthorName` first.
// The extension has no way to ask the system who is reading (PLATFORMS.md).

/** Longer than any real name; a runaway registry value is cut here */
export const AUTHOR_NAME_MAX = 64

/** A candidate name as it may be stored: control characters gone, whitespace
 *  runs one space, trimmed, capped. '' when nothing usable is left. */
export function cleanAuthorName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
  const name = flat.replace(/\s+/g, ' ').trim()
  return Array.from(name).slice(0, AUTHOR_NAME_MAX).join('').trim()
}

/** The first usable name among the candidates, in order ('' if none) */
export function pickAuthorName(candidates: readonly unknown[]): string {
  for (const c of candidates) {
    const name = cleanAuthorName(c)
    if (name) return name
  }
  return ''
}

/** What the seed does to a stored author: fills an empty one once, and
 *  never touches one that is set or a store that was seeded before. */
export function seedAuthor(current: string, seeded: boolean, systemName: string): string {
  if (seeded || current.trim()) return current
  return cleanAuthorName(systemName)
}

/** One string value out of a `reg export` file ('' if absent): the line
 *  `"Name"="value"`, with the file's escapes (backslash, quote) undone */
export function parseRegString(regText: string, valueName: string): string {
  for (const line of regText.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    if (m && m[1].replace(/\\(.)/g, '$1').toLowerCase() === valueName.toLowerCase())
      return m[2].replace(/\\(.)/g, '$1')
  }
  return ''
}
