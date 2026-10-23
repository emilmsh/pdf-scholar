// The OCR engine's own thread: Tesseract (tesseract.js-core, Apache-2.0,
// compiled to wasm) reading one rendered page at a time. Recognition takes a
// second or more per page and would freeze the window on the main thread.
//
// Everything it needs arrives in the first message — the wasm binary and the
// language models, fetched by ocr.ts — so this file never reaches for a URL:
// the packaged app runs from file://, where a worker's fetch is not to be
// relied on, and the extension may load nothing from outside itself.
import TesseractCore from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.js'
import type { TessModule, TessBaseApi } from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.js'
import { OEM_LSTM_ONLY, PSM_AUTO } from './ocr-text'
import { pixelsToPgm } from './ocr-image'
import type { PixelFormat } from './ocr-image'

export type OcrRequest =
  | { type: 'init'; wasm: ArrayBuffer; langs: { code: string; data: ArrayBuffer }[] }
  | {
      type: 'recognize'
      id: number
      /** A page drawn for reading ('rgba'), or an image's pixels as pdf.js
       *  decoded them — enlarged `upscale` times here, off the main thread */
      format: PixelFormat
      data: ArrayBuffer
      width: number
      height: number
      upscale: number
      dpi: number
    }

export type OcrReply =
  | { type: 'ready' }
  | { type: 'failed'; message: string }
  | { type: 'result'; id: number; tsv: string }
  | { type: 'error'; id: number; message: string }

let core: TessModule | null = null
let api: TessBaseApi | null = null

const reply = (msg: OcrReply): void => postMessage(msg)

async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(data)
  // A server that sent the .gz with Content-Encoding has already unpacked it
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function init(msg: Extract<OcrRequest, { type: 'init' }>): Promise<void> {
  core = await TesseractCore({ wasmBinary: new Uint8Array(msg.wasm) })
  for (const lang of msg.langs) core.FS.writeFile(`/${lang.code}.traineddata`, await gunzip(lang.data))
  api = new core.TessBaseAPI()
  if (api.Init('/', msg.langs.map((l) => l.code).join('+'), OEM_LSTM_ONLY) !== 0) {
    throw new Error('Tesseract could not load its language models')
  }
  api.SetVariable('tessedit_pageseg_mode', PSM_AUTO)
}

function recognize(msg: Extract<OcrRequest, { type: 'recognize' }>): string {
  if (!core || !api) throw new Error('OCR engine not initialised')
  // SetImageFile reads this fixed path (tesseract.js-core's binding)
  core.FS.writeFile('/input', pixelsToPgm(msg.format, new Uint8Array(msg.data), msg.width, msg.height, msg.upscale))
  try {
    if (api.SetImageFile(1, 0) === 1) throw new Error('Tesseract could not read the page image')
    api.SetSourceResolution(Math.round(msg.dpi * msg.upscale))
    api.Recognize(null)
    return api.GetTSVText(0)
  } finally {
    api.Clear()
    core.FS.unlink('/input')
  }
}

addEventListener('message', (e: MessageEvent<OcrRequest>) => {
  const msg = e.data
  if (msg.type === 'init') {
    init(msg).then(
      () => reply({ type: 'ready' }),
      (err: unknown) => reply({ type: 'failed', message: String(err) })
    )
    return
  }
  try {
    reply({ type: 'result', id: msg.id, tsv: recognize(msg) })
  } catch (err) {
    reply({ type: 'error', id: msg.id, message: String(err) })
  }
})
