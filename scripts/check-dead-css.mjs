// Report two kinds of app.css rot: class selectors nothing references, and
// selectors declared more than once at top level.
// Run: npm run check:css
//
// A 5000-line stylesheet accumulates rules whose markup was removed years of
// commits ago, and nothing fails when that happens — so this sweep exists to be
// re-run instead of re-derived. It is a REPORT, not a gate: read each hit before
// deleting anything.
//
// False positives it already handles: classes built at runtime from a template
// literal (`theme-${theme.id}`) are matched by prefix, and classes that come
// from a library rather than our markup (pdf.js's text-layer classes, KaTeX)
// are allow-listed below. Anything else it prints is a genuine candidate.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const cssFile = join(root, 'src/renderer/src/styles/app.css')
const selfPath = join(root, 'scripts/check-dead-css.mjs')

/** Classes we do not author: emitted by pdf.js/KaTeX, or a font-file extension
 *  that the selector grammar cannot tell apart from a class token. */
const NOT_OURS = new Set(['markedContent', 'woff2', 'katex', 'katex-display'])

const SEARCH_DIRS = ['src', 'scripts', 'config', 'docs']
const SEARCH_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.html', '.json', '.md', '.yml'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    // Skip this file: naming a class in its own comments would mark it live.
    else if (SEARCH_EXTS.has(extname(name)) && full !== cssFile && full !== selfPath) out.push(full)
  }
  return out
}

const css = readFileSync(cssFile, 'utf8')
const cssLines = css.split(/\r?\n/)

// Every class token in a selector, with the line it is declared on. Strip
// comments and declaration bodies first so `content: '.foo'` and prose in
// comments cannot masquerade as selectors.
const classLines = new Map()
for (const [i, raw] of cssLines.entries()) {
  const line = raw.replace(/\/\*.*?\*\//g, '')
  if (!line.includes('.') || /^\s*(\/\*|\*|\/\/)/.test(line)) continue
  const selectorPart = line.split('{')[0]
  if (line.includes('{') === false && !/,\s*$/.test(selectorPart)) continue // a declaration, not a selector
  for (const m of selectorPart.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    if (!classLines.has(m[1])) classLines.set(m[1], i + 1)
  }
}

const haystack = walk(join(root, SEARCH_DIRS[0]))
for (const d of SEARCH_DIRS.slice(1)) haystack.push(...walk(join(root, d)))
const sources = haystack.map((f) => readFileSync(f, 'utf8')).join('\n')

/** Prefixes that a template literal builds class names from, e.g.
 *  `theme-${theme.id}` makes every `theme-*` selector reachable. Only literals
 *  on a line that mentions a class attribute count — the codebase builds plenty
 *  of ids and cache keys the same way, and treating those as class prefixes
 *  would silently excuse whole families of dead rules. */
const dynamicPrefixes = [
  ...new Set(
    sources
      .split(/\r?\n/)
      .filter((l) => /\bclass(Name|List)?\b/.test(l))
      // The prefix can sit anywhere in the literal, not just after the
      // backtick: `theme-option theme-${theme.id}` builds two class names.
      .flatMap((l) => [...l.matchAll(/([A-Za-z][\w-]*-)\$\{/g)].map((m) => m[1]))
  )
]

const dead = []
/** Unreferenced, but a dynamic prefix COULD reach them. `annot-${type}` cannot
 *  produce `.annot-popover-contents`, so these still need a human look — they
 *  are listed separately rather than silently excused. */
const maybe = []
for (const [cls, line] of classLines) {
  if (NOT_OURS.has(cls)) continue
  if (sources.includes(cls)) continue
  const prefix = dynamicPrefixes.find((p) => cls.startsWith(p))
  if (prefix) maybe.push({ cls, line, prefix })
  else dead.push({ cls, line })
}

const byLine = (a, b) => a.line - b.line
dead.sort(byLine)
maybe.sort(byLine)

if (dead.length === 0 && maybe.length === 0) {
  console.log(`No unreferenced class selectors in app.css (${classLines.size} checked).`)
} else {
  console.log(`${classLines.size} class selectors checked in app.css.\n`)
  if (dead.length > 0) {
    console.log(`${dead.length} with no reference anywhere:`)
    for (const { cls, line } of dead) console.log(`  app.css:${line}  .${cls}`)
  }
  if (maybe.length > 0) {
    console.log(`\n${maybe.length} unreferenced but possibly built at runtime — check by hand:`)
    for (const { cls, line, prefix } of maybe) console.log(`  app.css:${line}  .${cls}  (\`${prefix}\${…}\`)`)
  }
  console.log(
    `\nDynamic class prefixes found: ${dynamicPrefixes.join(', ') || '(none)'}` +
      `\nRead each rule before deleting — a class may be planned markup rather than dead markup.`
  )
}

// ---------- Selectors declared twice at top level ----------
//
// The file grew append-only, so a selector's real computed style is often split
// between a base block near its feature and an add-on thousands of lines later.
// Sometimes the later block shadows the earlier one outright (a silent bug);
// more often it is only unreadable. Either way, one selector should have one
// home. Only column-0 openings count — an indented one is inside @media, where
// re-declaring is the whole point.
const declaredAt = new Map()
for (const [i, raw] of cssLines.entries()) {
  const m = /^([.#:\w][^{]*?)\s*\{\s*$/.exec(raw)
  if (!m) continue
  const sel = m[1].trim()
  if (sel.startsWith('@') || sel.startsWith('from') || sel.startsWith('to')) continue
  // Skip the last line of a multi-selector list (`.a,\n.b {`): sharing
  // declarations across a list and then overriding one of them in its own block
  // is a deliberate pattern, not a duplicate.
  if (i > 0 && /,\s*$/.test(cssLines[i - 1])) continue
  if (!declaredAt.has(sel)) declaredAt.set(sel, [])
  declaredAt.get(sel).push(i + 1)
}

const repeated = [...declaredAt].filter(([, ls]) => ls.length > 1)
if (repeated.length > 0) {
  console.log(`\n${repeated.length} selector(s) declared more than once at top level:`)
  for (const [sel, ls] of repeated.sort((a, b) => a[1][0] - b[1][0])) {
    console.log(`  ${sel}  —  lines ${ls.join(', ')}`)
  }
  console.log(
    '\nMerge them, or (when the split is deliberate, e.g. a block grouped with\n' +
      'the pdf.js variables it belongs to) say so in a comment at both sites.'
  )
}
