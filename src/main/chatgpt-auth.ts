// Sign-in with a ChatGPT plan: the OAuth flow Codex CLI uses, so the assistant
// can run on a Plus/Pro subscription's allowance instead of a billed API key.
//
// What this is, plainly: OpenAI publishes no sign-in program for third-party
// apps. Every tool that offers «Sign in with ChatGPT» (opencode, Cline,
// OpenClaw …) uses Codex CLI's public OAuth client and its chatgpt.com backend,
// and OpenAI has said in public that it welcomes that. That is a policy, not a
// contract — Anthropic and Google closed the same door in 2026 — so this
// provider sits BESIDE the API-key one, never in place of it.
//
// Desktop only. The client's redirect is registered to http://localhost:1455,
// and only a process that can listen on a local port can receive it — the
// extension cannot (docs/PLATFORMS.md lists the divergence).
//
// Flow (mirrors opencode's packages/opencode/src/plugin/openai/codex.ts, read
// 2026-09-27): PKCE authorize in the system browser → callback on :1455 →
// code exchange → { access, refresh, id_token }. The access token lives about
// an hour; `refresh` renews it. Tokens never reach the renderer — ai.ts seals
// the bundle with safeStorage exactly like an API key.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'
import type { FileError } from '../shared/types'
import { CHATGPT_ORIGINATOR } from '../shared/ai-chat'
import { CHATGPT_LOGIN_ERRORS } from '../shared/engine-errors'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const PORT = 1455
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** What ai.ts seals and stores under keys.chatgpt */
export interface ChatgptTokens {
  access: string
  refresh: string
  /** Epoch ms when `access` stops working */
  expires: number
  accountId: string
  /** For the settings row («Logget inn som …»); '' when the token has none */
  email: string
}

interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
}

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split('.')[1]
  if (!part) return undefined
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

type AuthClaims = {
  chatgpt_account_id?: string
  email?: string
  organizations?: { id: string }[]
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string }
  'https://api.openai.com/profile'?: { email?: string }
}

/** Account id and email from the id_token, falling back to the access token
 *  (a refresh answer may come without an id_token). */
function identity(tokens: TokenResponse): { accountId: string; email: string } {
  for (const t of [tokens.id_token, tokens.access_token]) {
    const c = jwtClaims(t) as AuthClaims | undefined
    if (!c) continue
    const accountId =
      c.chatgpt_account_id ??
      c['https://api.openai.com/auth']?.chatgpt_account_id ??
      c.organizations?.[0]?.id ??
      ''
    const email = c.email ?? c['https://api.openai.com/profile']?.email ?? ''
    if (accountId) return { accountId, email }
  }
  return { accountId: '', email: '' }
}

function toBundle(tokens: TokenResponse, previous?: ChatgptTokens): ChatgptTokens {
  const who = identity(tokens)
  return {
    access: tokens.access_token,
    // A refresh answer may omit a new refresh token — keep the old one then
    refresh: tokens.refresh_token ?? previous?.refresh ?? '',
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: who.accountId || previous?.accountId || '',
    email: who.email || previous?.email || ''
  }
}

async function tokenRequest(params: Record<string, string>): Promise<Response> {
  return fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString()
  })
}

/** Renew the access token. `expired` = the refresh token itself was refused
 *  (revoked, signed out elsewhere) and only a new sign-in helps; any other
 *  failure (offline) leaves the stored bundle alone. */
export async function refreshChatgpt(
  current: ChatgptTokens
): Promise<{ ok: true; tokens: ChatgptTokens } | { ok: false; expired: boolean; detail: string }> {
  let res: Response
  try {
    res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refresh })
  } catch (err) {
    return { ok: false, expired: false, detail: err instanceof Error ? err.message : String(err) }
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return { ok: false, expired: res.status === 400 || res.status === 401, detail: `HTTP ${res.status}: ${detail.slice(0, 200)}` }
  }
  return { ok: true, tokens: toBundle((await res.json()) as TokenResponse, current) }
}

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`

/** The pending sign-in, so a second click restarts instead of colliding */
let pending: { cancel(): void } | null = null

/** Run the whole browser sign-in. Resolves once the browser has come back
 *  (or failed, or five minutes passed). */
export async function loginChatgpt(): Promise<{ ok: true; tokens: ChatgptTokens } | FileError> {
  pending?.cancel()
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(32))

  return new Promise((resolve) => {
    const servers: Server[] = []
    let settled = false
    const finish = (result: { ok: true; tokens: ChatgptTokens } | FileError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const s of servers) s.close()
      pending = null
      resolve(result)
    }
    const timer = setTimeout(() => finish(CHATGPT_LOGIN_ERRORS.cancelled), LOGIN_TIMEOUT_MS)
    pending = { cancel: () => finish(CHATGPT_LOGIN_ERRORS.cancelled) }

    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404).end()
        return
      }
      const html = (status: number, title: string, body: string): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(page(title, body))
      }
      const error = url.searchParams.get('error')
      if (error) {
        html(200, 'Innloggingen ble avbrutt', 'Du kan lukke denne fanen og prøve igjen fra PDF Scholar.')
        finish(error === 'access_denied' ? CHATGPT_LOGIN_ERRORS.cancelled : CHATGPT_LOGIN_ERRORS.failed(url.searchParams.get('error_description') ?? error))
        return
      }
      const code = url.searchParams.get('code')
      // A callback that does not carry OUR state is not our sign-in — anyone
      // on this machine can hit a localhost port
      if (!code || url.searchParams.get('state') !== state) {
        html(400, 'Ugyldig innlogging', 'Svaret fra OpenAI hørte ikke til denne innloggingen.')
        return
      }
      html(200, 'Logget inn', 'Du kan lukke denne fanen og gå tilbake til PDF Scholar.')
      tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
          const tokens = toBundle((await r.json()) as TokenResponse)
          finish(tokens.refresh ? { ok: true, tokens } : CHATGPT_LOGIN_ERRORS.failed('no refresh token'))
        })
        .catch((err) => finish(CHATGPT_LOGIN_ERRORS.failed(err instanceof Error ? err.message : String(err))))
    }

    // Loopback only, on both address families: «localhost» in the redirect may
    // resolve to either, and nothing off this machine should reach the port.
    // 'none' = this address family is not there at all (no IPv6), which is fine
    // as long as the other one listens
    const listen = (host: string): Promise<'ok' | 'busy' | 'none'> =>
      new Promise((done) => {
        const s = createServer(handler)
        s.once('error', (err: NodeJS.ErrnoException) => done(err.code === 'EADDRINUSE' ? 'busy' : 'none'))
        s.listen(PORT, host, () => {
          if (settled) s.close()
          else servers.push(s)
          done('ok')
        })
      })

    void Promise.all([listen('127.0.0.1'), listen('::1')]).then(([v4, v6]) => {
      if (settled) return
      if (v4 === 'busy' || v6 === 'busy' || (v4 !== 'ok' && v6 !== 'ok')) {
        finish(v4 === 'busy' || v6 === 'busy' ? CHATGPT_LOGIN_ERRORS.portBusy : CHATGPT_LOGIN_ERRORS.failed('could not listen on localhost:1455'))
        return
      }
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'openid profile email offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator: CHATGPT_ORIGINATOR
      })
      void shell.openExternal(`${ISSUER}/oauth/authorize?${params.toString()}`)
    })
  })
}
