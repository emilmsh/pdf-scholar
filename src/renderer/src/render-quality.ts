// Adaptive render resolution.
//
// Pages render at the screen's full device-pixel density for maximum sharpness.
// But a heavy page (large format, high zoom, weak GPU) can make a single raster
// take long enough to stutter scrolling and zoom. So we watch how fast the
// machine actually rasterises and, when a render would blow the frame budget,
// trade retina crispness back toward native 1× density — never below it, so the
// fallback softens the anti-aliasing, never the legibility.
//
// The controller is self-calibrating: it learns throughput from real renders,
// starts optimistic (full sharpness), and recovers automatically once renders
// are cheap again (e.g. after zooming back out).

/** Target main-thread raster time for one page. Above this, sharpness is
 *  traded for responsiveness. A zoom/scroll commit re-renders a page or two,
 *  so ~a fifth of a second still feels immediate. */
const RENDER_BUDGET_MS = 220
/** Weight of the newest timing sample in the throughput EWMA. */
const THROUGHPUT_EWMA = 0.35
/** Ignore samples below this many device pixels: fixed per-render overhead
 *  dominates tiny renders and would skew throughput low. */
const MIN_SAMPLE_PX = 200_000
/** Optimistic seed (device px/ms ≈ 250 MP/s) so the first renders go out at
 *  full sharpness; real measurements correct it within a page or two. */
const SEED_PX_PER_MS = 250_000

/** Learned rasterisation throughput, device pixels per millisecond (EWMA). */
let throughput = SEED_PX_PER_MS

// Only timings from a render that had the main thread to itself are trustworthy:
// concurrent renders inflate each other's wall-clock. Track in-flight renders
// and drop any sample from a contended window.
let inFlight = 0
let contended = false

/**
 * Device-pixel scale to render a page at. Returns the display's full density
 * when the machine can raster the page within budget, otherwise the largest
 * density that fits the budget — but never below native (min(1, target)).
 *
 * @param cssPixels  viewport.width * viewport.height (zoom-scaled, dpr-free)
 * @param targetDpr  window.devicePixelRatio (the "max sharpness" ceiling)
 */
export function chooseRenderDpr(cssPixels: number, targetDpr: number): number {
  if (cssPixels <= 0) return targetDpr
  const budgetPixels = RENDER_BUDGET_MS * throughput // device px affordable in budget
  const budgetDpr = Math.sqrt(budgetPixels / cssPixels) // device px scale with dpr²
  const nativeFloor = Math.min(1, targetDpr)
  return Math.min(targetDpr, Math.max(budgetDpr, nativeFloor))
}

/** Mark the start of a page raster (for contention detection). */
export function beginRender(): void {
  inFlight += 1
  if (inFlight > 1) contended = true
}

/**
 * Mark the end of a page raster and, if the sample is clean, fold it into the
 * throughput estimate. Pass `pixels = 0` to only release the in-flight slot
 * (cancelled or failed render).
 */
export function endRender(pixels: number, ms: number): void {
  const clean = !contended
  inFlight = Math.max(0, inFlight - 1)
  if (inFlight === 0) contended = false
  if (clean && pixels >= MIN_SAMPLE_PX && ms > 0) {
    const sample = pixels / ms
    throughput = throughput * (1 - THROUGHPUT_EWMA) + sample * THROUGHPUT_EWMA
  }
}

/** Current learned throughput (device px/ms). Exposed for diagnostics. */
export function currentThroughput(): number {
  return throughput
}

// Dev-only handle so the mechanism can be inspected/driven from the console or
// automated preview (raster timing is unreliable in a hidden preview tab).
if (import.meta.env.DEV) {
  ;(window as unknown as { __renderQuality?: unknown }).__renderQuality = {
    chooseRenderDpr,
    recordSample: (pixels: number, ms: number) => {
      beginRender()
      endRender(pixels, ms)
    },
    get throughput() {
      return throughput
    },
    reset: () => {
      throughput = SEED_PX_PER_MS
      inFlight = 0
      contended = false
    }
  }
}
