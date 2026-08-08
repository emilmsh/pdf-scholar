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
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import type { SavedSignature } from '../signatures'

/** Backing-store size. Generous so the PNG still looks crisp when a signature
 *  drawn across the full pad is placed at ~170 pt and then zoomed into. */
const PAD_W = 1000
const PAD_H = 360
const INK = '#101828'
const BASE_WIDTH = 3.4

interface Props {
  onSave(sig: Omit<SavedSignature, 'id'>): void
  onCancel(): void
}

export function SignaturePad({ onSave, onCancel }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number; w: number } | null>(null)
  const [hasInk, setHasInk] = useState(false)

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
  }, [])

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
          <button className="btn-secondary" onClick={clear} disabled={!hasInk}>
            {t('sig.clear')}
          </button>
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
