// When the extension viewer may OFFER to fetch a document over plaintext http —
// src/shared/insecure-retry.ts.
//
// This is the one place in the app that proposes dropping encryption, so both
// halves of the rule are load-bearing and neither shows up in normal use. Too
// eager and we offer a downgrade to someone whose site answered 403 and is
// working fine — an attacker who can reset a TLS handshake gets a lever. Too
// literal about rewriting and we hand back a mangled URL: only the LEADING
// scheme is a scheme, and an `https:` inside a query string is a value.
// Run: node scripts/test-insecure-retry.mjs
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/shared/insecure-retry.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'insecure-retry-'))
const out = join(dir, 'insecure-retry.mjs')
await build({ entryPoints: [SRC], outfile: out, format: 'esm', bundle: false, logLevel: 'silent' })
const { insecureRetryUrl, offersInsecureRetry } = await import(pathToFileURL(out).href)

let failures = 0
function eq(got, want, msg) {
  if (got !== want) {
    failures++
    console.error(`  ✗ ${msg}\n      got  ${got}\n      want ${want}`)
  }
}

// --- Only a connection that never happened earns the offer --------------------
// A server that ANSWERED is talking to us fine; 403, a login page or a bot check
// is a decision, not a transport problem, and plaintext does not change it.
console.log('which failures earn the offer')
{
  const url = 'https://aguirregabiria.net/wpapers/paper.pdf'
  eq(offersInsecureRetry(url, 'transport'), true, 'https + no answer at all → offered')
  eq(offersInsecureRetry(url, 'response'), false, 'https + the server answered → never offered')
  eq(offersInsecureRetry('http://example.org/p.pdf', 'transport'), false, 'http has nothing to drop')
  eq(offersInsecureRetry('file:///C:/tmp/p.pdf', 'transport'), false, 'file:// has nothing to drop')
  // A permission toggle the user can fix, and a picked file with no URL at all —
  // neither is a network failure, and neither must produce a plaintext URL.
  eq(offersInsecureRetry('fsa:paper.pdf', 'transport'), false, 'a picked file has no URL')
}

// --- The rewrite touches the scheme and nothing else --------------------------
console.log('what the offered URL looks like')
{
  const cases = [
    ['https://example.org/paper.pdf', 'http://example.org/paper.pdf'],
    // Port, path, query and fragment all have to survive byte for byte: a
    // truncated signed link fails in a way that looks like the site's fault.
    ['https://example.org:8443/wpapers/A_B.pdf', 'http://example.org:8443/wpapers/A_B.pdf'],
    [
      'https://example.org/get.pdf?utm_source=chatgpt.com&sig=aBc%2Fd#page=12',
      'http://example.org/get.pdf?utm_source=chatgpt.com&sig=aBc%2Fd#page=12'
    ],
    // A resolver forwarding another link: the second `https:` is a value.
    [
      'https://doi.example/go?to=https://other.example/paper.pdf',
      'http://doi.example/go?to=https://other.example/paper.pdf'
    ],
    ['HTTPS://Example.ORG/Paper.PDF', 'http://Example.ORG/Paper.PDF']
  ]
  for (const [from, want] of cases) eq(insecureRetryUrl(from), want, `${from}`)

  for (const url of ['http://example.org/p.pdf', 'file:///C:/tmp/p.pdf', 'fsa:p.pdf', '']) {
    eq(insecureRetryUrl(url), null, `no plaintext twin for ${url || '(empty)'}`)
  }
  // "https" as a hostname or path segment is not the scheme either.
  eq(insecureRetryUrl('http://https.example.org/https/p.pdf'), null, 'https only counts as a scheme')
}

if (failures) {
  console.error(`\n${failures} failing assertion(s)`)
  process.exit(1)
}
console.log('\nall good')
