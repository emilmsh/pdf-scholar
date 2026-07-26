// Report class selectors in app.css that nothing in the source references.
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
