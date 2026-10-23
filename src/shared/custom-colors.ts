// The list of remembered colour-wheel picks — the custom swatches after the
// palette in the markup rows (issue #50).
//
// Pure list rules, so they can be tested without a DOM; `annotations.ts`
// wraps them around localStorage. What is stored is untrusted input: a hand
// in the profile, an older build, or a garbage value must all read as a list
// and never throw.

/** How many picks are kept — the row has room for a few, not a history */
export const CUSTOM_COLORS_MAX = 3

const HEX_RE = /^#[0-9a-f]{6}$/i

/** A valid `#rrggbb`, lower-cased, or null for anything else */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.startsWith('#') ? value : `#${value}`
  return HEX_RE.test(v) ? v.toLowerCase() : null
}

/** The stored JSON → a clean list: valid hexes only, lower-cased, deduped
 *  (first occurrence wins), capped. Anything unreadable is an empty list. */
export function parseCustomColors(raw: string | null | undefined): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const item of parsed) {
    const hex = normalizeHex(item)
    if (hex && !out.includes(hex)) out.push(hex)
    if (out.length === CUSTOM_COLORS_MAX) break
  }
  return out
}

/** A new pick goes first; a repeat moves to the front; the oldest falls off */
export function rememberColor(list: string[], value: string): string[] {
  const hex = normalizeHex(value)
  if (!hex) return list
  return [hex, ...list.filter((h) => h !== hex)].slice(0, CUSTOM_COLORS_MAX)
}

/** One pick forgotten (the × on its swatch); the others keep their order */
export function forgetColor(list: string[], value: string): string[] {
  const hex = normalizeHex(value)
  if (!hex) return list
  return list.filter((h) => h !== hex)
}
