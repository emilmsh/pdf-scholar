// The detached assistant's citation relay OUTSIDE Electron: a BroadcastChannel
// between same-origin pages (dev:web tabs, extension viewer/assistant tabs).
// On desktop the same contract runs through main instead (assistant:jump in
// src/main/index.ts), which can also raise the target window — a browser tab
// cannot raise another tab from here, so the extension layer adds tab
// self-activation ON the receiving side (extension-api.ts).
//
// Protocol: the assistant posts {type:'jump'} with a nonce; whichever page has
// the document open shows the citation and answers {type:'jump-ack'} with the
// same nonce. No ack within the timeout means "nobody is showing this
// document" — the sender's cue to offer opening it. BroadcastChannel never
// delivers a message back to its poster, so a page can never ack itself.
import type { AiCitationTarget } from '../../shared/types'

const CHANNEL_NAME = 'pdfx-assistant'
const ACK_TIMEOUT_MS = 400

interface JumpMsg {
  type: 'jump'
  path: string
  target: AiCitationTarget
  nonce: number
}
interface AckMsg {
  type: 'jump-ack'
  nonce: number
}

type JumpListener = (path: string, target: AiCitationTarget) => boolean

const listeners = new Set<JumpListener>()
let channel: BroadcastChannel | null = null

/** Nonces must not collide across TABS (each tab counts on its own), so the
 *  sequence starts at a random offset per page. */
let nonceCounter = Math.floor(Math.random() * 2 ** 30)

function ensureChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data as JumpMsg | AckMsg | null
      if (!msg || msg.type !== 'jump') return
      let handled = false
      for (const listener of listeners) {
        if (listener(msg.path, msg.target)) handled = true
      }
      if (handled) {
        channel?.postMessage({ type: 'jump-ack', nonce: msg.nonce } satisfies AckMsg)
      }
    })
  }
  return channel
}

/** Receiving side: viewer pages subscribe; the callback returns true when this
 *  page showed the citation (that answer becomes the ack). */
export function subscribeAssistantJumps(cb: JumpListener): () => void {
  ensureChannel()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Sending side: true when some page acked within the timeout. */
export function requestAssistantJump(path: string, target: AiCitationTarget): Promise<boolean> {
  const ch = ensureChannel()
  if (!ch) return Promise.resolve(false)
  const nonce = ++nonceCounter
  return new Promise((resolve) => {
    const settle = (handled: boolean): void => {
      window.clearTimeout(timer)
      ch.removeEventListener('message', onMessage)
      resolve(handled)
    }
    const onMessage = (e: MessageEvent): void => {
      const msg = e.data as AckMsg | null
      if (msg?.type === 'jump-ack' && msg.nonce === nonce) settle(true)
    }
    const timer = window.setTimeout(() => settle(false), ACK_TIMEOUT_MS)
    ch.addEventListener('message', onMessage)
    ch.postMessage({ type: 'jump', path, target, nonce } satisfies JumpMsg)
  })
}
