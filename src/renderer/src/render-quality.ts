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

/** The densities a page may be rastered at BELOW the display's own, when the
 *  budget forces it. Whole steps, not the continuous value the budget
 *  arithmetic yields (issue #53): a bitmap at 1.12× on a 1.25× screen is
 *  resampled at every pixel, and whether a page came out soft depended on
 *  what the throughput estimate happened to read at that moment — the
 *  «fuzzy, but not consistently» half of the report. A step is at least
 *  stable from one raster to the next; only the display's own density is
 *  pixel-exact, which is why the budget check prefers it outright. */
const DPR_STEPS = [1, 1.25, 1.5, 2, 3]

// Concurrent renders share the main thread, so one render's wall-clock among
// others says nothing about throughput. A BATCH does: from the first render
// starting with none in flight to the last one ending, the pixels of all of
// them over the time of all of them. A lone render is a batch of one (its own
// timing, as before). Dropping the contended samples instead — what this did
// until 2026-10 — dropped exactly the zoom commits and page jumps where several
// pages raster at once: the controller kept its optimistic seed and never
// eased a 2× screen off full density when it was struggling.
let inFlight = 0
let batchStart = 0
let batchPixels = 0
let batchCount = 0
/** A render in the batch was cancelled or failed: its time is in the batch,
 *  its pixels are not, so the batch would read slow — drop it. */
let batchTainted = false

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
  if (budgetDpr >= targetDpr) return targetDpr
  // Over budget at full density: the largest step that fits, never above the
  // display and never below native
  let best = Math.min(1, targetDpr)
  for (const step of DPR_STEPS) if (step < targetDpr && step <= budgetDpr && step > best) best = step
  return best
}

/** Mark the start of a page raster (opens a batch when none is in flight). */
export function beginRender(): void {
  if (inFlight === 0) {
    batchStart = performance.now()
    batchPixels = 0
    batchCount = 0
    batchTainted = false
  }
  inFlight += 1
  batchCount += 1
}

/**
 * Mark the end of a page raster; when it closes its batch and the batch is
 * clean, fold the batch into the throughput estimate. Pass `pixels = 0` for a
 * cancelled or failed render (releases the slot, taints the batch).
 */
export function endRender(pixels: number, ms: number): void {
  if (inFlight === 0) return
  inFlight -= 1
  if (pixels > 0) batchPixels += pixels
  else batchTainted = true
  if (inFlight > 0) return
  const elapsed = batchCount === 1 ? ms : performance.now() - batchStart
  if (!batchTainted && batchPixels >= MIN_SAMPLE_PX && elapsed > 0) {
    const sample = batchPixels / elapsed
    throughput = throughput * (1 - THROUGHPUT_EWMA) + sample * THROUGHPUT_EWMA
  }
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
      batchPixels = 0
      batchCount = 0
      batchTainted = false
    }
  }
}
