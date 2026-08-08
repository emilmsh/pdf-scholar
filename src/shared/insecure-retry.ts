// When a document that would not load over `https:` is worth OFFERING to fetch
// over plaintext `http:` instead — and what that URL is.
//
// Background. The extension viewer does not receive the browser's own request:
// the redirect rule cancels that navigation and our page re-fetches the URL. That
// costs us a resilience the browser has and `fetch` does not — Chrome and Edge
// silently upgrade an http navigation to https and fall back when https will not
// connect (HTTPS-Upgrades). A host with a working http site and no working TLS is
// a whole genre (academic homepages on Plesk/IIS with a certificate that expired
// or was never bound), and there the paper is sitting right there on port 80.
//
// This is deliberately an OFFER and never automatic, which is the whole reason it
// is a separate module rather than another rung of readFile's retry ladder. The
// browser only falls back when the BROWSER did the upgrade; for a link that was
// written `https://`, Chrome gives up and shows an error, and our redirect rule
// cannot tell the two apart by the time it sees the URL. Retrying anyway would
// put us below the browser on security (an attacker who can reset a TLS handshake
// could force us onto plaintext) and above it on behaviour, invisibly. So the
// viewer names the failure, shows the plaintext URL, and lets the reader decide.
//
// Pure so the rule can be tested without a browser: `npm run test:insecure-retry`.

/** Why an attempt did not yield the document. `transport` is the connection
 *  itself failing (DNS, TLS, a reset) — `fetch` rejects and there is no response
 *  to read; `response` is anything the server did answer, including a 200 that
 *  turned out to be a sign-in page. */
export type FetchFailure = 'transport' | 'response'

/** The plaintext twin of `url`, or null when retrying there is not worth
 *  offering. Only the leading scheme is rewritten — everything else (port, path,
 *  query, fragment) has to survive byte for byte, including an `https:` that
 *  appears INSIDE the URL, which is a value and not a scheme. */
export function insecureRetryUrl(url: string): string | null {
  return /^https:\/\//i.test(url) ? url.replace(/^https:/i, 'http:') : null
}

/** Whether a failed open should offer the plaintext retry at all.
 *
 *  Only a `transport` failure qualifies: a server that ANSWERED — 403, a login
 *  page, a bot check — is talking to us fine and will not be talked into it by
 *  dropping the encryption; offering there would be security theatre pointed the
 *  wrong way. And only for https, since anything else has no encryption to drop. */
export function offersInsecureRetry(url: string, failure: FetchFailure): boolean {
  return failure === 'transport' && insecureRetryUrl(url) !== null
}
