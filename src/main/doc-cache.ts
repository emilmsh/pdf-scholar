// DocCache: per-path cache of open PDF document handles with debounced
// flushing, shared by both annotation write-engines (mupdf + EmbedPDF).
//
// Why: the engines used to run a full open -> parse -> mutate -> serialize ->
// write -> close cycle for EVERY annotation. On a 150 MB file that is ~0.8 s
// (mupdf) / ~4 s (EmbedPDF) per annotation, and on ~400 MB files the repeated
// cycles exhaust/fragment the 2 GB wasm32 heap. With the cache, a burst of
// writes costs ONE open and ONE serialize: mutations hit the cached in-memory
// doc, the file on disk catches up via a debounced flush. Writes always target
// a DRAFT copy (src/main/drafts.ts), so a briefly-stale on-disk draft is fine —
// but every code path that READS the draft's bytes must call flushAndEvict()
// first (wired up in src/main/index.ts via the router's flushAnnotations).
//
// Concurrency: a per-path promise chain serializes ALL operations on one path
// (mutations, flushes, evictions), so a flush can never race a write.
export interface DocCacheOptions<D> {
  /** Open the document at `path` and return the engine-specific handle(s). */
  open(path: string): Promise<D>
  /** Serialize the (still open) document and atomically persist it to `path`. */
  flush(doc: D, path: string): Promise<void>
  /** Release the document handle(s). */
  close(doc: D): void | Promise<void>
  /** Detect wasm OOM/abort — fatal errors drop cached docs WITHOUT flushing
   *  (the heap they'd serialize into is gone). */
  isFatal?(err: unknown): boolean
  /** A fatal error kills the whole wasm instance → drop every cached doc,
   *  not just the one being operated on (EmbedPDF: emscripten abort). */
  dropAllOnFatal?: boolean
  /** Called once per fatal error, after dropping (e.g. reset the engine
   *  singleton so the next write re-initializes a fresh wasm instance). */
  onFatal?(): void
  /** Close + evict after every flush instead of keeping the doc open. mupdf
   *  needs this: repeated incremental saves from a kept-open doc corrupt the
   *  xref chain (proven in scripts/spike-mupdf-cached-save.mjs). Flushes are
   *  debounced, so a burst of writes still amortizes to one open + one save. */
  evictAfterFlush?: boolean
  /** Debounce between the last write and the flush to disk (default 1200 ms). */
  flushDelayMs?: number
  /** Evict (flush + close) after this much inactivity (default 30 s). */
  idleMs?: number
  /** LRU cap on simultaneously open docs — wasm heap is precious (default 2). */
  maxDocs?: number
}

interface Entry<D> {
  doc: D
  dirty: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  lastUsed: number
}

export class DocCache<D> {
  private readonly entries = new Map<string, Entry<D>>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly opts: DocCacheOptions<D>) {}

  /** Per-path mutex: every operation on one path queues behind the previous. */
  private enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve()
    const run = prev.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(path, tail)
    void tail.then(() => {
      // Garbage-collect settled chains for paths with no cached doc
      if (this.chains.get(path) === tail && !this.entries.has(path)) this.chains.delete(path)
    })
    return run
  }

  /** Run a mutation against the cached (or freshly opened) doc. `dirtied`
   *  decides from the result whether the doc now differs from disk — ops that
   *  return an {error} without touching the doc must not schedule a flush. */
  mutate<T>(path: string, fn: (doc: D) => Promise<T> | T, dirtied: (result: T) => boolean): Promise<T> {
    return this.enqueue(path, async () => {
      try {
        let entry = this.entries.get(path)
        if (!entry) {
          const doc = await this.opts.open(path)
          entry = { doc, dirty: false, flushTimer: null, idleTimer: null, lastUsed: Date.now() }
          this.entries.set(path, entry)
          this.enforceCap(path)
        }
        entry.lastUsed = Date.now()
        const result = await fn(entry.doc)
        if (dirtied(result)) {
          entry.dirty = true
          this.scheduleFlush(path, entry)
        }
        this.scheduleIdle(path, entry)
        return result
      } catch (err) {
        if (this.opts.isFatal?.(err)) this.handleFatal(path)
        throw err
      }
    })
  }

  /** Flush now if dirty, then close and evict. No-op when the path is not
   *  cached. Call before ANY read or copy of the file's on-disk bytes. */
  flushAndEvict(path: string): Promise<void> {
    return this.enqueue(path, async () => {
      const entry = this.entries.get(path)
      if (!entry) return
      this.clearTimers(entry)
      if (entry.dirty) {
        try {
          await this.opts.flush(entry.doc, path)
          entry.dirty = false
        } catch (err) {
          if (this.opts.isFatal?.(err)) {
            this.handleFatal(path)
          } else {
            // Keep the doc (and its dirty flag) so idle eviction or the next
            // explicit flush can retry — transient I/O errors shouldn't cost
            // the user their pending annotations.
            this.scheduleIdle(path, entry)
          }
          throw err
        }
      }
      this.entries.delete(path)
      await this.safeClose(entry.doc)
    })
  }

  /** Evict WITHOUT flushing — the draft is being discarded, and a late
   *  debounced flush must not resurrect the file we're about to delete. */
  drop(path: string): Promise<void> {
    return this.enqueue(path, async () => {
      const entry = this.entries.get(path)
      if (!entry) return
      this.clearTimers(entry)
      this.entries.delete(path)
      await this.safeClose(entry.doc)
    })
  }

  /** Flush + evict every cached doc (app quit). Never rejects — quitting must
   *  not hang on a broken doc; failures are logged instead. */
  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.entries.keys()].map((path) =>
        this.flushAndEvict(path).catch((err) => {
          console.error(`[doc-cache] flush-all failed for ${path}:`, err)
        })
      )
    )
  }

  private scheduleFlush(path: string, entry: Entry<D>): void {
    if (entry.flushTimer) clearTimeout(entry.flushTimer)
    const t = setTimeout(() => {
      entry.flushTimer = null
      void this.enqueue(path, async () => {
        const e = this.entries.get(path)
        if (!e || !e.dirty) return
        try {
          await this.opts.flush(e.doc, path)
          e.dirty = false
          if (this.opts.evictAfterFlush) {
            this.clearTimers(e)
            this.entries.delete(path)
            await this.safeClose(e.doc)
          }
        } catch (err) {
          // Background flush — nothing to report the error to. Keep the doc
          // dirty so the next write, idle eviction or explicit flush retries
          // (bounded: we do NOT re-arm the flush timer here, to avoid a hot
          // retry loop on a persistent I/O failure like a full disk).
          if (this.opts.isFatal?.(err)) this.handleFatal(path)
          console.error(`[doc-cache] background flush failed for ${path}:`, err)
        }
      })
    }, this.opts.flushDelayMs ?? 1200)
    t.unref?.() // never keep the process alive; quit flushes explicitly
    entry.flushTimer = t
  }

  private scheduleIdle(path: string, entry: Entry<D>): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    const t = setTimeout(() => {
      entry.idleTimer = null
      void this.flushAndEvict(path).catch((err) => {
        console.error(`[doc-cache] idle eviction failed for ${path}:`, err)
      })
    }, this.opts.idleMs ?? 30_000)
    t.unref?.()
    entry.idleTimer = t
  }

  /** LRU cap. Fire-and-forget: the eviction queues on the victim's own chain —
   *  awaiting it from inside another path's chain could deadlock two paths
   *  evicting each other. The cache may transiently exceed the cap while the
   *  eviction is in flight. */
  private enforceCap(justOpened: string): void {
    const max = this.opts.maxDocs ?? 2
    if (this.entries.size <= max) return
    let lruPath: string | null = null
    let lruTime = Infinity
    for (const [p, e] of this.entries) {
      if (p === justOpened) continue
      if (e.lastUsed < lruTime) {
        lruTime = e.lastUsed
        lruPath = p
      }
    }
    if (lruPath) {
      void this.flushAndEvict(lruPath).catch((err) => {
        console.error(`[doc-cache] LRU eviction failed for ${lruPath}:`, err)
      })
    }
  }

  /** The wasm heap is gone — drop cached docs without flushing. Closing is
   *  best-effort: the handles may already be dead. */
  private handleFatal(path: string): void {
    const paths = this.opts.dropAllOnFatal ? [...this.entries.keys()] : [path]
    for (const p of paths) {
      const e = this.entries.get(p)
      if (!e) continue
      this.clearTimers(e)
      this.entries.delete(p)
      void Promise.resolve()
        .then(() => this.opts.close(e.doc))
        .catch(() => {})
    }
    this.opts.onFatal?.()
  }

  private clearTimers(entry: Entry<D>): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  private async safeClose(doc: D): Promise<void> {
    try {
      await this.opts.close(doc)
    } catch {
      /* releasing a dead handle is fine */
    }
  }
}
