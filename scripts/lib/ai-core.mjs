// Loading src/shared/ai-chat.ts from a plain Node script, plus the fetch
// instrumentation the AI test scripts share.
//
// Three scripts now import the provider core (test-ai-chat, test-live,
// test-stream-replay) and each one used to carry its own copy of the esbuild
// incantation. The bundle has two non-obvious requirements, which is exactly
// why it belongs in one place: `packages: 'external'` (the Anthropic SDK must
// stay a real import) and an output path INSIDE the repo, so that external
// import still resolves from node_modules at load time.
import { build } from 'esbuild'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
/** Where recorded provider streams live (test-stream-replay.mjs replays them) */
export const STREAM_DIR = join(ROOT, 'scripts', 'fixtures', 'streams')

let cached = null

/** The shared AI core, bundled and imported. Cached per process. */
export async function loadAiCore() {
  if (cached) return cached
  const outfile = join(ROOT, 'scripts', '.ai-core-bundle.mjs')
  await build({
    stdin: {
      contents: [
        `export * from './src/shared/ai-chat'`,
        `export * from './src/shared/ai-provider-profile'`,
        `export * from './src/shared/ai-model-catalog'`
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent'
  })
  cached = await import(pathToFileURL(outfile).href)
  return cached
}

/** The curated model ids for a provider, parsed out of ai-models.ts.
 *
 *  Regex rather than import, for the same reason check-models.mjs does it:
 *  importing the TS module drags in the renderer's i18n. A rewrite that breaks
 *  the parse shows up as an empty list, which every caller reports loudly. */
export function curatedIds(provider) {
  const src = readFileSync(join(ROOT, 'src/renderer/src/components/ai-models.ts'), 'utf8')
  const block = src.match(new RegExp(`${provider}:\\s*\\[([\\s\\S]*?)\\]`))
  if (!block) return []
  return [...block[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1])
}

/**
 * Wrap global fetch so a test can see what really crossed the wire.
 *
 * Two jobs, both of which need the RAW bytes rather than the parsed result:
 *
 *  - counting requests, which is how the degrade-on-400 net is caught firing
 *    (one question that costs two POSTs means a parameter we sent was refused);
 *  - recording the response stream verbatim, so it can be replayed keylessly
 *    forever after. The body is teed, not buffered: the caller still consumes a
 *    normal stream, chunk boundaries and all, and those boundaries are half of
 *    what makes a real recording worth having.
 */
export function instrumentFetch() {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    // `chunks` holds the writes as they arrived. Storing only the concatenated
    // body would throw away the single most valuable thing about a recording:
    // WHERE the provider cut it. A frame split down the middle of a JSON object
    // is a real shape that a re-serve at frame boundaries stops testing.
    const call = { url, status: 0, body: '', chunks: [], startedAt: Date.now() }
    calls.push(call)
    const res = await real(input, init)
    call.status = res.status
    if (!res.body) {
      call.body = await res.clone().text()
      call.chunks = [call.body]
      return res
    }
    // Tee: one branch to the caller, one to the recording
    const [toCaller, toRecord] = res.body.tee()
    void (async () => {
      const reader = toRecord.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const piece = decoder.decode(value, { stream: true })
        call.chunks.push(piece)
        call.body += piece
      }
    })()
    return new Response(toCaller, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers
    })
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = real
    }
  }
}

/** Write a recorded stream to the replay library. */
export function saveRecording(name, fixture) {
  mkdirSync(STREAM_DIR, { recursive: true })
  const file = join(STREAM_DIR, `${name}.json`)
  writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n')
  return file
}

/** Every recording in the library, newest name order. */
export function loadRecordings() {
  let names = []
  try {
    names = readdirSync(STREAM_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return names.sort().map((f) => ({
    name: f.replace(/\.json$/, ''),
    ...JSON.parse(readFileSync(join(STREAM_DIR, f), 'utf8'))
  }))
}
