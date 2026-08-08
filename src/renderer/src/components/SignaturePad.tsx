// Draw a signature once, keep it, stamp it wherever it is needed.
//
// Deliberately its own canvas rather than the page draw-layer: a signature is
// drawn at a comfortable size and then placed small, so it must not be captured
// at the page's zoom. What comes out is a PNG trimmed to the ink, so the stamp's
// box is the signature's own shape and not whatever rectangle happened to be on
// screen.
//
// Pointer input follows the same rule as the page: pressure varies the width
// when the device reports it (a pen), and a finger or mouse gets a constant
// stroke. `touch-action: none` is safe here because — unlike the page — there is
// nothing to scroll underneath.
//
// A signature can also arrive as a PICTURE — most people already have one, on
// paper or in a file, and drawing it again with a mouse is a worse copy of a
// thing they own (Emil, 2026-08-08). An upload or a paste lands on this same
// canvas rather than beside it: the pad then shows exactly what will be saved,
// the Clear button still means clear, and there is still only ONE save path,
// the one that trims to the ink.
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import type { SavedSignature } from '../signatures'

/** Backing-store size. Generous so the PNG still looks crisp when a signature
 *  drawn across the full pad is placed at ~170 pt and then zoomed into. */
const PAD_W = 1000
const PAD_H = 360
const INK = '#101828'
const BASE_WIDTH = 3.4

/** Longest side an imported picture is decoded at. A phone photo is 4000 px
 *  wide and every pixel of it would be walked twice below for a signature that
 *  ends up ~1000 px across; this bounds that work without touching quality. */
const IMPORT_MAX_SIDE = 2400

/** Widest file we will even decode. Not a security boundary — the decode is the
 *  browser's — just a refusal to spend a second on something that is plainly
 *  not a signature. */
const IMPORT_MAX_BYTES = 25 * 1024 * 1024

/** Background keying for an OPAQUE picture (a photo or a scan): paper has to
 *  become transparent or the stamp lands as a white card on the page.
 *  Luminance below KEY_INK is ink and stays; above KEY_PAPER is paper and goes;
 *  in between fades, which is what keeps the edge of a stroke smooth. The gap
 *  is wide and set LOW on purpose — grey shadow across a photographed page sits
 *  around 200, and treating it as paper is far better than a grey haze around
 *  the signature. */
const KEY_INK = 110
const KEY_PAPER = 190

interface Props {
  onSave(sig: Omit<SavedSignature, 'id'>): void
  onCancel(): void
}

/** Turn an imported picture's paper transparent, in place, and report whether
 *  anything survived.
 *
 *  A picture that ALREADY carries transparency is left exactly as it is: it has
 *  been prepared by something, and keying it again by brightness would erase a
 *  signature written in a pale colour. Only a flat opaque rectangle — a photo,
 *  a scan, a screenshot — gets the treatment, and for those the alternative is
 *  stamping a white card over the page. */
function keyOutPaper(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      // Already has an alpha channel that means something — trust it, and only
      // answer whether it is empty.
      for (let j = 3; j < data.length; j += 4) if (data[j] > 8) return true
      return false
    }
  }
  let anyInk = false
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luma. Integer-cheap, and the difference from a perceptual
    // luminance is far below the width of the fade band.
    const l = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
    const a =
      l <= KEY_INK
        ? 255
        : l >= KEY_PAPER
          ? 0
          : Math.round((255 * (KEY_PAPER - l)) / (KEY_PAPER - KEY_INK))
    data[i + 3] = a
    if (a > 8) anyInk = true
  }
  return anyInk
}

export function SignaturePad({ onSave, onCancel }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number; w: number } | null>(null)
  const [hasInk, setHasInk] = useState(false)
  const [importError, setImportError] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  /** Canvas coordinates for a pointer event, independent of the CSS size the
   *  pad happens to be laid out at. */
  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const c = canvasRef.current
    if (!c) return { x: 0, y: 0 }
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * PAD_W, y: ((e.clientY - r.top) / r.height) * PAD_H }
  }

  /** A pen reports 0–1; mouse and touch report 0.5 (or 0). Only trust it from a
   *  pen — otherwise every mouse signature would come out at half width. */
  const widthFor = (e: React.PointerEvent<HTMLCanvasElement>): number =>
    e.pointerType === 'pen' && e.pressure > 0
      ? BASE_WIDTH * (0.55 + e.pressure * 0.9)
      : BASE_WIDTH

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    // Capture keeps the stroke alive if the pointer leaves the pad mid-signature.
    // It is an enhancement, not a precondition — a pointer the browser no longer
    // tracks makes this throw, and losing the whole stroke over that would be
    // absurd. (It is also what a synthetic pointer does, so the test would
    // silently draw nothing.)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* draw without capture */
    }
    drawing.current = true
    const p = pointAt(e)
    last.current = { ...p, w: widthFor(e) }
    // A tap with no movement should still leave a dot
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) {
      ctx.fillStyle = INK
      ctx.beginPath()
      ctx.arc(p.x, p.y, widthFor(e) / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    setHasInk(true)
    setImportError(false)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext('2d')
    const from = last.current
    if (!ctx || !from) return
    const to = { ...pointAt(e), w: widthFor(e) }
    ctx.strokeStyle = INK
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // Width is per SEGMENT — that is what makes a pen stroke taper instead of
    // stepping between two uniform strokes.
    ctx.lineWidth = (from.w + to.w) / 2
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
    last.current = to
  }

  const endStroke = (): void => {
    drawing.current = false
    last.current = null
  }

  const clear = useCallback(() => {
    const c = canvasRef.current
    c?.getContext('2d')?.clearRect(0, 0, PAD_W, PAD_H)
    setHasInk(false)
    setImportError(false)
  }, [])

  /** Decode a picture, key its paper out, and lay it on the pad — fitted,
   *  centred, replacing whatever was there. The pad is only touched once the
   *  picture is known to be usable, so a bad file leaves a drawing in progress
   *  alone. `false` means nothing came of it. */
  const importImage = useCallback(async (file: Blob): Promise<boolean> => {
    if (!file.type.startsWith('image/') || file.size > IMPORT_MAX_BYTES) return false
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      const fitSrc = Math.min(
        1,
        IMPORT_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight, 1)
      )
      const sw = Math.max(1, Math.round(img.naturalWidth * fitSrc))
      const sh = Math.max(1, Math.round(img.naturalHeight * fitSrc))
      const src = document.createElement('canvas')
      src.width = sw
      src.height = sh
      const sctx = src.getContext('2d')
      if (!sctx) return false
      sctx.drawImage(img, 0, 0, sw, sh)
      const frame = sctx.getImageData(0, 0, sw, sh)
      if (!keyOutPaper(frame.data)) return false
      sctx.putImageData(frame, 0, 0)
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return false
      // Fit-CONTAIN: a signature stretched to the pad's shape is not the
      // signature. The empty band that leaves is trimmed straight back off by
      // save() below, so the aspect the user sees is the aspect they get.
      const fit = Math.min(PAD_W / sw, PAD_H / sh)
      const dw = sw * fit
      const dh = sh * fit
      ctx.clearRect(0, 0, PAD_W, PAD_H)
      ctx.drawImage(src, (PAD_W - dw) / 2, (PAD_H - dh) / 2, dw, dh)
      return true
    } catch {
      // Not something the browser could decode. A tainted canvas cannot happen
      // here — the bytes are the user's own file, same origin by construction.
      return false
    } finally {
      URL.revokeObjectURL(url)
    }
  }, [])

  const takeImage = useCallback(
    async (file: Blob): Promise<void> => {
      const ok = await importImage(file)
      if (ok) setHasInk(true)
      setImportError(!ok)
    },
    [importImage]
  )

  // Paste anywhere in the dialog. Most people's signature is already a picture
  // in a file or a message, and Ctrl+V is how it gets out of there.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/')
      )
      const blob = item?.getAsFile()
      if (!blob) return
      e.preventDefault()
      void takeImage(blob)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [takeImage])

  /** Crop to the drawn pixels, so the saved PNG is the signature and not the
   *  pad. Without this every stamp would carry the pad's empty margins and sit
   *  wrong wherever it was placed. */
  const save = useCallback(() => {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const { data } = ctx.getImageData(0, 0, PAD_W, PAD_H)
    let minX = PAD_W
    let minY = PAD_H
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < PAD_H; y++) {
      for (let x = 0; x < PAD_W; x++) {
        if (data[(y * PAD_W + x) * 4 + 3] === 0) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (maxX < 0) return // nothing drawn
    const pad = 8 // breathing room so the ink is not flush against the edge
    minX = Math.max(0, minX - pad)
    minY = Math.max(0, minY - pad)
    maxX = Math.min(PAD_W - 1, maxX + pad)
    maxY = Math.min(PAD_H - 1, maxY + pad)
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    out.getContext('2d')?.drawImage(c, minX, minY, w, h, 0, 0, w, h)
    onSave({ dataUrl: out.toDataURL('image/png'), width: w, height: h })
  }, [onSave])

  return (
    <div className="confirm-overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="signature-dialog" role="dialog" aria-modal="true" aria-label={t('sig.padTitle')}>
        <p className="confirm-message">{t('sig.padTitle')}</p>
        <p className="confirm-detail">{t('sig.padDetail')}</p>
        {importError && <p className="signature-import-error">{t('sig.uploadFailed')}</p>}
        <canvas
          ref={canvasRef}
          className="signature-canvas"
          width={PAD_W}
          height={PAD_H}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
        />
        <div className="signature-actions">
          <div className="signature-actions-left">
            <button className="btn-secondary" onClick={clear} disabled={!hasInk}>
              {t('sig.clear')}
            </button>
            <button
              className="btn-secondary"
              title={t('sig.uploadTip')}
              onClick={() => fileRef.current?.click()}
            >
              {t('sig.upload')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                // Cleared so picking the SAME file again still fires a change
                e.target.value = ''
                if (file) void takeImage(file)
              }}
            />
          </div>
          <div className="signature-actions-right">
            <button className="btn-secondary" onClick={onCancel}>
              {t('app.cancel')}
            </button>
            <button className="btn-primary" onClick={save} disabled={!hasInk}>
              {t('sig.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
