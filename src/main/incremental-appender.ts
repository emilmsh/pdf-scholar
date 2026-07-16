// Incremental-update PDF appender: writes annotations into HUGE files without
// ever loading them into memory (and without WASM). Where the EmbedPDF engine
// round-trips the whole file through a wasm32 heap (2 GB cap — a 413 MB file
// needs ~2.4 GB and hard-aborts), this module reads only the byte ranges it
// needs (xref, page tree path, /Annots) and APPENDS an incremental update:
// new annotation object + appearance stream + updated /Annots + a new xref
// section chaining to the previous one (PDF 32000-1 §7.5.6). The original
// bytes are never rewritten — and writes target a draft copy anyway
// (src/main/drafts.ts), so a failed append can simply be truncated away.
//
// Scope is deliberately minimal but STRICT: any construct outside the strict
// grammar makes us return a clear Norwegian error instead of writing a
// doubtful append. Correctness over cleverness.
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import type {
  AnnotateRequest,
  AnnotateResult,
  DeleteAnnotationRequest,
  ModifyAnnotationRequest,
  PageRect
} from '../shared/types'

// ---------------------------------------------------------------------------
// User-facing errors (Norwegian bokmål) — everything else logs + maps to these
// ---------------------------------------------------------------------------
export const APPEND_UNSUPPORTED_MSG =
  'Dokumentet har en PDF-struktur som ikke støttes for direkte annotering ennå — endringen ble ikke lagret.'
const ENCRYPTED_MSG = 'PDF-en er passordbeskyttet'
const NOT_FOUND_MSG = 'Fant ikke annotasjonen i filen'
const OBJSTM_EDIT_MSG = 'Annotasjonen kan ikke endres i så store dokumenter ennå'

/** Error whose message is safe to show the user (Norwegian). */
class AppendError extends Error {
  constructor(msg: string, readonly detail?: string) {
    super(msg)
  }
}
/** Internal: parse window too small — retried with a bigger window. */
class NeedMore extends Error {}

// ---------------------------------------------------------------------------
// PDF value model. Strings keep their RAW bytes (escapes intact) so foreign
// objects round-trip byte-identically through parse -> serialize.
// ---------------------------------------------------------------------------
type PdfDict = Map<string, PdfValue>
type PdfValue =
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'name'; v: string } // decoded, without the leading '/'
  | { t: 'str'; raw: Buffer } // bytes between ( ), escape sequences NOT resolved
  | { t: 'hex'; raw: string } // hex chars between < >
  | { t: 'ref'; num: number; gen: number }
  | { t: 'arr'; items: PdfValue[] }
  | { t: 'dict'; map: PdfDict }

const N = (v: number): PdfValue => ({ t: 'num', v })
const NAME = (v: string): PdfValue => ({ t: 'name', v })
const REF = (num: number, gen = 0): PdfValue => ({ t: 'ref', num, gen })
const ARR = (items: PdfValue[]): PdfValue => ({ t: 'arr', items })
const DICT = (entries: [string, PdfValue][]): PdfValue => ({ t: 'dict', map: new Map(entries) })

const isWs = (b: number): boolean =>
  b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00
const isDelim = (b: number): boolean =>
  b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b || b === 0x5d ||
  b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25
const isDigit = (b: number): boolean => b >= 0x30 && b <= 0x39

// ---------------------------------------------------------------------------
// Lexer over a byte window. Running past the window throws NeedMore; the
// window loop in readWindow() grows the window and retries the whole parse.
// ---------------------------------------------------------------------------
class Lex {
  pos = 0
  constructor(
    readonly buf: Buffer,
    /** true when the window reaches the physical end of the file */
    readonly atEof: boolean
  ) {}

  /** Byte at pos, or -1 at true EOF. Throws NeedMore at a window edge. */
  peek(off = 0): number {
    const i = this.pos + off
    if (i >= this.buf.length) {
      if (this.atEof) return -1
      throw new NeedMore()
    }
    return this.buf[i]
  }

  take(): number {
    const b = this.peek()
    if (b === -1) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'unexpected end of file')
    this.pos++
    return b
  }

  skipWs(): void {
    for (;;) {
      const b = this.peek()
      if (b === -1) return
      if (isWs(b)) {
        this.pos++
      } else if (b === 0x25) {
        // % comment to end of line
        this.pos++
        for (;;) {
          const c = this.peek()
          if (c === -1) return
          this.pos++
          if (c === 0x0a || c === 0x0d) break
        }
      } else {
        return
      }
    }
  }

  /** Consume `kw` if it is next (delimited); false otherwise. */
  tryKeyword(kw: string): boolean {
    const save = this.pos
    this.skipWs()
    for (let i = 0; i < kw.length; i++) {
      if (this.peek(i) !== kw.charCodeAt(i)) {
        this.pos = save
        return false
      }
    }
    const after = this.peek(kw.length)
    if (after !== -1 && !isWs(after) && !isDelim(after)) {
      this.pos = save
      return false
    }
    this.pos += kw.length
    return true
  }

  expectKeyword(kw: string): void {
    if (!this.tryKeyword(kw)) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `expected '${kw}' at ${this.pos}`)
    }
  }

  /** Non-negative integer. */
  int(): number {
    this.skipWs()
    let b = this.peek()
    if (!isDigit(b)) throw new AppendError(APPEND_UNSUPPORTED_MSG, `expected integer at ${this.pos}`)
    let v = 0
    while (isDigit(b)) {
      v = v * 10 + (b - 0x30)
      this.pos++
      b = this.peek()
    }
    return v
  }

  number(): number {
    this.skipWs()
    const start = this.pos
    let b = this.peek()
    if (b === 0x2b || b === 0x2d) {
      this.pos++
      b = this.peek()
    }
    while (isDigit(b) || b === 0x2e) {
      this.pos++
      b = this.peek()
    }
    if (this.pos === start) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `expected number at ${start}`)
    }
    const v = Number(this.buf.toString('latin1', start, this.pos))
    if (!Number.isFinite(v)) throw new AppendError(APPEND_UNSUPPORTED_MSG, `bad number at ${start}`)
    return v
  }
}

/** Decode a /Name token body (after the slash), resolving #xx escapes. */
function parseName(lex: Lex): string {
  let out = ''
  for (;;) {
    const b = lex.peek()
    if (b === -1 || isWs(b) || isDelim(b)) return out
    lex.pos++
    if (b === 0x23) {
      const h1 = lex.take()
      const h2 = lex.take()
      out += String.fromCharCode(parseInt(String.fromCharCode(h1, h2), 16))
    } else {
      out += String.fromCharCode(b)
    }
  }
}

function parseValue(lex: Lex, depth = 0): PdfValue {
  if (depth > 48) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'object nesting too deep')
  lex.skipWs()
  const b = lex.peek()
  switch (b) {
    case 0x2f: {
      lex.pos++
      return { t: 'name', v: parseName(lex) }
    }
    case 0x28: {
      // Literal string: capture raw bytes between the outer parens, keeping
      // escape sequences untouched (round-trips byte-identically).
      lex.pos++
      const start = lex.pos
      let nest = 1
      for (;;) {
        const c = lex.take()
        if (c === 0x5c) {
          lex.take() // escaped char (incl. escaped paren)
        } else if (c === 0x28) {
          nest++
        } else if (c === 0x29 && --nest === 0) {
          return { t: 'str', raw: Buffer.from(lex.buf.subarray(start, lex.pos - 1)) }
        }
      }
    }
    case 0x3c: {
      if (lex.peek(1) === 0x3c) {
        lex.pos += 2
        const map: PdfDict = new Map()
        for (;;) {
          lex.skipWs()
          if (lex.peek() === 0x3e && lex.peek(1) === 0x3e) {
            lex.pos += 2
            return { t: 'dict', map }
          }
          if (lex.take() !== 0x2f) {
            throw new AppendError(APPEND_UNSUPPORTED_MSG, `expected name key at ${lex.pos}`)
          }
          const key = parseName(lex)
          map.set(key, parseValue(lex, depth + 1))
        }
      }
      lex.pos++
      let hex = ''
      for (;;) {
        const c = lex.take()
        if (c === 0x3e) return { t: 'hex', raw: hex }
        if (!isWs(c)) hex += String.fromCharCode(c)
      }
    }
    case 0x5b: {
      lex.pos++
      const items: PdfValue[] = []
      for (;;) {
        lex.skipWs()
        if (lex.peek() === 0x5d) {
          lex.pos++
          return { t: 'arr', items }
        }
        items.push(parseValue(lex, depth + 1))
      }
    }
    default: {
      if (lex.tryKeyword('true')) return { t: 'bool', v: true }
      if (lex.tryKeyword('false')) return { t: 'bool', v: false }
      if (lex.tryKeyword('null')) return { t: 'null' }
      // number — possibly the start of an indirect reference "n g R"
      const v = lex.number()
      if (Number.isInteger(v) && v >= 0) {
        const save = lex.pos
        try {
          lex.skipWs()
          if (isDigit(lex.peek())) {
            const gen = lex.int()
            if (lex.tryKeyword('R')) return { t: 'ref', num: v, gen }
          }
        } catch (err) {
          if (err instanceof NeedMore) throw err // must grow window to decide
          // a malformed lookahead is just "not a ref"
        }
        lex.pos = save
      }
      return { t: 'num', v }
    }
  }
}

interface IndirectObject {
  num: number
  gen: number
  value: PdfValue
  /** absolute file offset of the first stream data byte (when a stream) */
  streamDataOffset?: number
}

/** Parse "num gen obj <value> (stream|endobj)" at the window start. */
function parseIndirect(lex: Lex, windowBase: number): IndirectObject {
  lex.skipWs()
  const num = lex.int()
  const gen = lex.int()
  lex.expectKeyword('obj')
  const value = parseValue(lex)
  if (lex.tryKeyword('stream')) {
    // spec: 'stream' is followed by CRLF or LF (never a lone CR)
    let b = lex.take()
    if (b === 0x0d) b = lex.take()
    if (b !== 0x0a) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'malformed stream header')
    return { num, gen, value, streamDataOffset: windowBase + lex.pos }
  }
  lex.expectKeyword('endobj')
  return { num, gen, value }
}

// ---------------------------------------------------------------------------
// Serializer — must reproduce foreign objects (page dicts, /Annots arrays)
// faithfully; strings/hex round-trip raw.
// ---------------------------------------------------------------------------
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n)
  const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

function encodeNameToken(name: string): string {
  let out = '/'
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (c <= 0x20 || c >= 0x7f || c === 0x23 || isDelim(c)) {
      out += '#' + c.toString(16).padStart(2, '0')
    } else {
      out += name[i]
    }
  }
  return out
}

function serializeValue(v: PdfValue, out: Buffer[]): void {
  switch (v.t) {
    case 'num':
      out.push(Buffer.from(fmtNum(v.v)))
      return
    case 'bool':
      out.push(Buffer.from(v.v ? 'true' : 'false'))
      return
    case 'null':
      out.push(Buffer.from('null'))
      return
    case 'name':
      out.push(Buffer.from(encodeNameToken(v.v)))
      return
    case 'str':
      out.push(Buffer.from('('), v.raw, Buffer.from(')'))
      return
    case 'hex':
      out.push(Buffer.from(`<${v.raw}>`))
      return
    case 'ref':
      out.push(Buffer.from(`${v.num} ${v.gen} R`))
      return
    case 'arr': {
      out.push(Buffer.from('['))
      v.items.forEach((item, i) => {
        if (i > 0) out.push(Buffer.from(' '))
        serializeValue(item, out)
      })
      out.push(Buffer.from(']'))
      return
    }
    case 'dict': {
      out.push(Buffer.from('<<'))
      for (const [k, val] of v.map) {
        out.push(Buffer.from(`${encodeNameToken(k)} `))
        serializeValue(val, out)
        out.push(Buffer.from('\n'))
      }
      out.push(Buffer.from('>>'))
      return
    }
  }
}

function serialize(v: PdfValue): Buffer {
  const out: Buffer[] = []
  serializeValue(v, out)
  return Buffer.concat(out)
}

/** Full "num gen obj ... endobj\n" body for a plain (non-stream) object. */
function objectBuffer(num: number, gen: number, value: PdfValue): Buffer {
  return Buffer.concat([Buffer.from(`${num} ${gen} obj\n`), serialize(value), Buffer.from('\nendobj\n')])
}

/** Full stream object body; sets /Length on the dict. */
function streamObjectBuffer(num: number, gen: number, dict: PdfDict, data: Buffer): Buffer {
  dict.set('Length', N(data.length))
  return Buffer.concat([
    Buffer.from(`${num} ${gen} obj\n`),
    serialize({ t: 'dict', map: dict }),
    Buffer.from('\nstream\n'),
    data,
    Buffer.from('\nendstream\nendobj\n')
  ])
}

// ---------------------------------------------------------------------------
// Stream decoding: FlateDecode + PNG predictors 10–15 (the only filters we
// accept — enough for xref streams and object streams from every mainstream
// writer; anything else is refused, not guessed at).
// ---------------------------------------------------------------------------
function pngUnpredict(data: Buffer, columns: number): Buffer {
  // colors=1, bpc=8 for xref/objstm predictor use → bytes-per-pixel is 1
  const rowLen = columns
  const rows = Math.floor(data.length / (rowLen + 1))
  const out = Buffer.alloc(rows * rowLen)
  for (let r = 0; r < rows; r++) {
    const tag = data[r * (rowLen + 1)]
    const src = r * (rowLen + 1) + 1
    const dst = r * rowLen
    const prev = dst - rowLen
    for (let i = 0; i < rowLen; i++) {
      const raw = data[src + i]
      const left = i > 0 ? out[dst + i - 1] : 0
      const up = r > 0 ? out[prev + i] : 0
      let val: number
      switch (tag) {
        case 0: val = raw; break
        case 1: val = raw + left; break
        case 2: val = raw + up; break
        case 3: val = raw + Math.floor((left + up) / 2); break
        case 4: {
          const ul = r > 0 && i > 0 ? out[prev + i - 1] : 0
          const p = left + up - ul
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - ul)
          val = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)
          break
        }
        default:
          throw new AppendError(APPEND_UNSUPPORTED_MSG, `unknown PNG predictor tag ${tag}`)
      }
      out[dst + i] = val & 0xff
    }
  }
  return out
}

function dictGetName(dict: PdfDict, key: string): string | null {
  const v = dict.get(key)
  return v?.t === 'name' ? v.v : null
}

/** Apply /Filter + /DecodeParms to raw stream bytes. */
function decodeStreamData(dict: PdfDict, raw: Buffer): Buffer {
  const filter = dict.get('Filter')
  let filters: string[] = []
  if (filter?.t === 'name') filters = [filter.v]
  else if (filter?.t === 'arr') filters = filter.items.map((f) => (f.t === 'name' ? f.v : ''))
  else if (filter) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'unsupported /Filter shape')
  if (filters.length === 0) return raw
  if (filters.length > 1 || filters[0] !== 'FlateDecode') {
    throw new AppendError(APPEND_UNSUPPORTED_MSG, `unsupported filter ${filters.join(',')}`)
  }
  let data: Buffer
  try {
    data = inflateSync(raw)
  } catch {
    throw new AppendError(APPEND_UNSUPPORTED_MSG, 'flate data corrupt')
  }
  const parms = dict.get('DecodeParms') ?? dict.get('DP')
  const parmsDict = parms?.t === 'dict' ? parms.map : parms?.t === 'arr' && parms.items[0]?.t === 'dict' ? parms.items[0].map : null
  if (parmsDict) {
    const pred = parmsDict.get('Predictor')
    const predV = pred?.t === 'num' ? pred.v : 1
    if (predV >= 10 && predV <= 15) {
      const colors = parmsDict.get('Colors')
      const bpc = parmsDict.get('BitsPerComponent')
      if ((colors && (colors.t !== 'num' || colors.v !== 1)) || (bpc && (bpc.t !== 'num' || bpc.v !== 8))) {
        throw new AppendError(APPEND_UNSUPPORTED_MSG, 'unsupported predictor color layout')
      }
      const cols = parmsDict.get('Columns')
      data = pngUnpredict(data, cols?.t === 'num' ? cols.v : 1)
    } else if (predV !== 1) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `unsupported predictor ${predV}`)
    }
  }
  return data
}

// ---------------------------------------------------------------------------
// Xref (classic tables AND xref streams, incl. object streams) + file access
// ---------------------------------------------------------------------------
type XrefEntry =
  | { type: 0 } // free — recorded so an older in-use entry can't resurrect it
  | { type: 1; offset: number; gen: number }
  | { type: 2; container: number; index: number }

const WINDOW_START = 8 * 1024
const WINDOW_MAX = 32 * 1024 * 1024

class PdfFile {
  readonly xref = new Map<number, XrefEntry>()
  trailer: PdfDict = new Map()
  /** kind of the NEWEST xref section — appended sections must match it
   *  (mixing table/stream sections in one chain is invalid, §7.5.8) */
  latestKind: 'classic' | 'stream' = 'classic'
  /** offset of the newest xref section = /Prev of the section we append */
  startxref = 0
  private nextNum = 0
  private readonly objStmCache = new Map<number, { first: number; data: Buffer; offsets: Map<number, number> }>()

  private constructor(
    readonly fh: FileHandle,
    readonly size: number
  ) {}

  static async load(path: string): Promise<PdfFile> {
    const fh = await open(path, 'r+')
    try {
      const size = (await fh.stat()).size
      const pdf = new PdfFile(fh, size)
      await pdf.loadXrefChain()
      return pdf
    } catch (err) {
      await fh.close().catch(() => {})
      throw err
    }
  }

  async close(): Promise<void> {
    await this.fh.close().catch(() => {})
  }

  allocObjNum(): number {
    return this.nextNum++
  }

  get newSize(): number {
    return this.nextNum
  }

  private async read(offset: number, length: number): Promise<Buffer> {
    const len = Math.min(length, this.size - offset)
    if (len <= 0) throw new AppendError(APPEND_UNSUPPORTED_MSG, `read past EOF at ${offset}`)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await this.fh.read(buf, 0, len, offset)
    return bytesRead === len ? buf : buf.subarray(0, bytesRead)
  }

  /** Run a parse against a growing byte window at `offset`. */
  private async withWindow<T>(offset: number, fn: (lex: Lex) => T): Promise<T> {
    for (let len = WINDOW_START; ; len *= 4) {
      const atEof = offset + len >= this.size
      const buf = await this.read(offset, len)
      try {
        return fn(new Lex(buf, atEof))
      } catch (err) {
        if (err instanceof NeedMore && !atEof && len < WINDOW_MAX) continue
        if (err instanceof NeedMore) {
          throw new AppendError(APPEND_UNSUPPORTED_MSG, `object too large to parse at ${offset}`)
        }
        throw err
      }
    }
  }

  // ---- xref chain ----------------------------------------------------------

  private async loadXrefChain(): Promise<void> {
    // Tail: "startxref\n<offset>\n%%EOF" lives in the last ~2 KB
    const tailLen = Math.min(2048, this.size)
    const tail = (await this.read(this.size - tailLen, tailLen)).toString('latin1')
    const m = /startxref\s+(\d+)/g
    let last: RegExpExecArray | null = null
    for (let hit = m.exec(tail); hit; hit = m.exec(tail)) last = hit
    if (!last) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'no startxref in file tail')
    this.startxref = Number(last[1])

    const queue: number[] = [this.startxref]
    const visited = new Set<number>()
    let first = true
    let declaredSize = 0
    while (queue.length > 0) {
      const offset = queue.shift()!
      if (visited.has(offset) || offset <= 0 || offset >= this.size) continue
      visited.add(offset)
      if (visited.size > 64) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'xref chain too long')
      const section = await this.withWindow(offset, (lex) =>
        lex.tryKeyword('xref') ? this.parseClassicSection(lex) : this.parseStreamSection(lex, offset)
      )
      if (first) {
        this.trailer = section.trailer
        this.latestKind = section.kind
        first = false
      }
      // Newest-first: an entry already recorded wins over older sections.
      for (const [num, entry] of section.entries) {
        if (!this.xref.has(num)) this.xref.set(num, entry)
      }
      const sz = section.trailer.get('Size')
      if (sz?.t === 'num') declaredSize = Math.max(declaredSize, sz.v)
      // Hybrid files: /XRefStm points at a stream section that must rank
      // between this classic section and its /Prev (queue order does that).
      const xrefStm = section.trailer.get('XRefStm')
      if (xrefStm?.t === 'num') queue.push(xrefStm.v)
      const prev = section.trailer.get('Prev')
      if (prev?.t === 'num') queue.push(prev.v)
    }
    if (this.trailer.get('Encrypt')) throw new AppendError(ENCRYPTED_MSG, 'encrypted document')
    if (!this.trailer.get('Root')) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'trailer has no /Root')
    let maxNum = 0
    for (const num of this.xref.keys()) maxNum = Math.max(maxNum, num)
    this.nextNum = Math.max(declaredSize, maxNum + 1)
  }

  /** Classic table: "xref" already consumed. Subsections + trailer dict. */
  private parseClassicSection(lex: Lex): { kind: 'classic'; entries: Map<number, XrefEntry>; trailer: PdfDict } {
    const entries = new Map<number, XrefEntry>()
    for (;;) {
      if (lex.tryKeyword('trailer')) {
        const trailer = parseValue(lex)
        if (trailer.t !== 'dict') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'trailer is not a dict')
        return { kind: 'classic', entries, trailer: trailer.map }
      }
      const start = lex.int()
      const count = lex.int()
      lex.skipWs()
      // Entries are EXACTLY 20 bytes: 10-digit offset, space, 5-digit gen,
      // space, n/f, 2-byte EOL (§7.5.4). Tolerate nothing looser.
      for (let i = 0; i < count; i++) {
        lex.peek(19) // ensure the record is inside the window
        const rec = lex.buf.toString('latin1', lex.pos, lex.pos + 20)
        const rm = /^(\d{10}) (\d{5}) ([nf])(?:\r\n| \r| \n)$/.exec(rec)
        if (!rm) throw new AppendError(APPEND_UNSUPPORTED_MSG, `malformed xref record '${rec}'`)
        lex.pos += 20
        const num = start + i
        if (!entries.has(num)) {
          entries.set(num, rm[3] === 'n' ? { type: 1, offset: Number(rm[1]), gen: Number(rm[2]) } : { type: 0 })
        }
      }
    }
  }

  /** Xref STREAM section at `offset` (§7.5.8): W field widths, Index runs. */
  private parseStreamSection(
    lex: Lex,
    offset: number
  ): { kind: 'stream'; entries: Map<number, XrefEntry>; trailer: PdfDict } {
    const obj = parseIndirect(lex, offset)
    if (obj.value.t !== 'dict' || obj.streamDataOffset === undefined) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `no xref table or stream at ${offset}`)
    }
    const dict = obj.value.map
    if (dictGetName(dict, 'Type') !== 'XRef') {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `object at ${offset} is not /Type /XRef`)
    }
    const lengthV = dict.get('Length')
    // xref streams may not reference their /Length indirectly through an
    // entry we don't have yet — require a direct number (all writers comply)
    if (lengthV?.t !== 'num') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'xref stream /Length not direct')
    const rel = obj.streamDataOffset - offset
    if (rel + lengthV.v > lex.buf.length) throw new NeedMore()
    const data = decodeStreamData(dict, Buffer.from(lex.buf.subarray(rel, rel + lengthV.v)))

    const wV = dict.get('W')
    if (wV?.t !== 'arr' || wV.items.length < 3 || wV.items.some((i) => i.t !== 'num')) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, 'bad /W in xref stream')
    }
    const w = wV.items.map((i) => (i as { t: 'num'; v: number }).v)
    const sizeV = dict.get('Size')
    if (sizeV?.t !== 'num') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'xref stream missing /Size')
    let index: number[] = [0, sizeV.v]
    const indexV = dict.get('Index')
    if (indexV) {
      if (indexV.t !== 'arr' || indexV.items.some((i) => i.t !== 'num') || indexV.items.length % 2 !== 0) {
        throw new AppendError(APPEND_UNSUPPORTED_MSG, 'bad /Index in xref stream')
      }
      index = indexV.items.map((i) => (i as { t: 'num'; v: number }).v)
    }
    const rowLen = w[0] + w[1] + w[2]
    if (rowLen <= 0 || rowLen > 32) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'bad xref row width')
    const entries = new Map<number, XrefEntry>()
    let pos = 0
    const field = (width: number): number => {
      let v = 0
      for (let i = 0; i < width; i++) v = v * 256 + data[pos++]
      return v
    }
    for (let run = 0; run < index.length; run += 2) {
      const start = index[run]
      const count = index[run + 1]
      for (let i = 0; i < count; i++) {
        if (pos + rowLen > data.length) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'xref stream truncated')
        // w[0]===0 → type field absent, defaults to 1 (§7.5.8.3)
        const type = w[0] === 0 ? 1 : field(w[0])
        const f2 = field(w[1])
        const f3 = field(w[2])
        const num = start + i
        if (entries.has(num)) continue
        if (type === 0) entries.set(num, { type: 0 })
        else if (type === 1) entries.set(num, { type: 1, offset: f2, gen: f3 })
        else if (type === 2) entries.set(num, { type: 2, container: f2, index: f3 })
        // unknown types "shall be interpreted as null" — skip
      }
    }
    return { kind: 'stream', entries, trailer: dict }
  }

  // ---- object access -------------------------------------------------------

  genOf(num: number): number {
    const e = this.xref.get(num)
    return e?.type === 1 ? e.gen : 0
  }

  /** Read object `num`, following the xref (offset or object-stream entry). */
  async getObject(num: number): Promise<IndirectObject> {
    const entry = this.xref.get(num)
    if (!entry || entry.type === 0) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `object ${num} missing from xref`)
    }
    if (entry.type === 1) {
      const obj = await this.withWindow(entry.offset, (lex) => parseIndirect(lex, entry.offset))
      // STRICT: a stale/wrong offset must never lead to a doubtful append
      if (obj.num !== num) {
        throw new AppendError(APPEND_UNSUPPORTED_MSG, `xref offset for ${num} points at object ${obj.num}`)
      }
      return obj
    }
    const container = await this.loadObjectStream(entry.container)
    const off = container.offsets.get(num)
    if (off === undefined) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `object ${num} not in object stream ${entry.container}`)
    }
    const lex = new Lex(container.data.subarray(container.first + off), true)
    return { num, gen: 0, value: parseValue(lex) }
  }

  /** Inflate + index an /ObjStm container (cached per operation). */
  private async loadObjectStream(num: number): Promise<{ first: number; data: Buffer; offsets: Map<number, number> }> {
    const cached = this.objStmCache.get(num)
    if (cached) return cached
    const entry = this.xref.get(num)
    if (entry?.type !== 1) throw new AppendError(APPEND_UNSUPPORTED_MSG, `object stream ${num} not a direct object`)
    const obj = await this.withWindow(entry.offset, (lex) => parseIndirect(lex, entry.offset))
    if (obj.num !== num || obj.value.t !== 'dict' || obj.streamDataOffset === undefined) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `object ${num} is not a stream`)
    }
    const dict = obj.value.map
    if (dictGetName(dict, 'Type') !== 'ObjStm') {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, `object ${num} is not /Type /ObjStm`)
    }
    const nV = dict.get('N')
    const firstV = dict.get('First')
    const raw = await this.readStreamData(dict, obj.streamDataOffset)
    if (nV?.t !== 'num' || firstV?.t !== 'num') {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, 'object stream missing /N or /First')
    }
    const data = decodeStreamData(dict, raw)
    const offsets = new Map<number, number>()
    const lex = new Lex(data.subarray(0, firstV.v), true)
    for (let i = 0; i < nV.v; i++) {
      const objNum = lex.int()
      const objOff = lex.int()
      offsets.set(objNum, objOff)
    }
    const result = { first: firstV.v, data, offsets }
    this.objStmCache.set(num, result)
    return result
  }

  /** Raw stream bytes; resolves an indirect /Length. */
  private async readStreamData(dict: PdfDict, dataOffset: number): Promise<Buffer> {
    let lengthV = dict.get('Length')
    if (lengthV?.t === 'ref') lengthV = (await this.getObject(lengthV.num)).value
    if (lengthV?.t !== 'num' || lengthV.v < 0 || lengthV.v > 256 * 1024 * 1024) {
      throw new AppendError(APPEND_UNSUPPORTED_MSG, 'bad stream /Length')
    }
    return this.read(dataOffset, lengthV.v)
  }

  /** Deref (chains of) references; returns non-ref values as-is. */
  async resolve(v: PdfValue | undefined): Promise<PdfValue | undefined> {
    let cur = v
    for (let depth = 0; cur?.t === 'ref'; depth++) {
      if (depth > 8) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'reference chain too deep')
      cur = (await this.getObject(cur.num)).value
    }
    return cur
  }

  async resolveNumber(v: PdfValue | undefined): Promise<number> {
    const r = await this.resolve(v)
    if (r?.t !== 'num') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'expected a number')
    return r.v
  }
}

// ---------------------------------------------------------------------------
// Page lookup: /Root -> /Pages -> walk /Kids to page N, tracking inheritable
// /MediaBox and /Rotate (§7.7.3.4)
// ---------------------------------------------------------------------------
interface PageInfo {
  pageNum: number
  pageGen: number
  pageDict: PdfDict
  mediaBox: [number, number, number, number]
  rotate: 0 | 90 | 180 | 270
}

async function findPage(pdf: PdfFile, pageIndex: number): Promise<PageInfo> {
  const rootRef = pdf.trailer.get('Root')
  const catalog = await pdf.resolve(rootRef)
  if (catalog?.t !== 'dict') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'catalog is not a dict')
  let nodeRef = catalog.map.get('Pages')
  if (nodeRef?.t !== 'ref') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'catalog has no /Pages ref')

  let mediaBox: [number, number, number, number] | null = null
  let rotate = 0
  let idx = pageIndex
  for (let depth = 0; depth < 64; depth++) {
    const nodeObj = await pdf.getObject(nodeRef.num)
    if (nodeObj.value.t !== 'dict') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'page tree node is not a dict')
    const dict = nodeObj.value.map
    const mb = await pdf.resolve(dict.get('MediaBox'))
    if (mb) {
      if (mb.t !== 'arr' || mb.items.length !== 4) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'bad /MediaBox')
      const nums: number[] = []
      for (const item of mb.items) nums.push(await pdf.resolveNumber(item))
      mediaBox = [
        Math.min(nums[0], nums[2]),
        Math.min(nums[1], nums[3]),
        Math.max(nums[0], nums[2]),
        Math.max(nums[1], nums[3])
      ]
    }
    const rot = dict.get('Rotate')
    if (rot) rotate = await pdf.resolveNumber(rot)

    const type = dictGetName(dict, 'Type')
    if (type === 'Page') {
      if (idx !== 0) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'page tree /Count inconsistent')
      if (!mediaBox) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'page has no /MediaBox')
      const r = ((rotate % 360) + 360) % 360
      if (r !== 0 && r !== 90 && r !== 180 && r !== 270) {
        throw new AppendError(APPEND_UNSUPPORTED_MSG, `unsupported /Rotate ${rotate}`)
      }
      return { pageNum: nodeRef.num, pageGen: pdf.genOf(nodeRef.num), pageDict: dict, mediaBox, rotate: r as PageInfo['rotate'] }
    }
    if (type !== 'Pages') throw new AppendError(APPEND_UNSUPPORTED_MSG, `unexpected page tree node /Type ${type}`)
    const kids = await pdf.resolve(dict.get('Kids'))
    if (kids?.t !== 'arr') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'pages node has no /Kids')
    let descended = false
    for (const kid of kids.items) {
      if (kid.t !== 'ref') throw new AppendError(APPEND_UNSUPPORTED_MSG, '/Kids entry is not a reference')
      const kidObj = await pdf.getObject(kid.num)
      if (kidObj.value.t !== 'dict') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'kid is not a dict')
      const kidType = dictGetName(kidObj.value.map, 'Type')
      if (kidType === 'Page') {
        if (idx === 0) {
          nodeRef = kid
          descended = true
          break
        }
        idx--
      } else if (kidType === 'Pages') {
        const count = await pdf.resolveNumber(kidObj.value.map.get('Count'))
        if (idx < count) {
          nodeRef = kid
          descended = true
          break
        }
        idx -= count
      } else {
        throw new AppendError(APPEND_UNSUPPORTED_MSG, `unexpected kid /Type ${kidType}`)
      }
    }
    if (!descended) throw new AppendError(APPEND_UNSUPPORTED_MSG, `page ${pageIndex} not found in page tree`)
  }
  throw new AppendError(APPEND_UNSUPPORTED_MSG, 'page tree too deep')
}

// ---------------------------------------------------------------------------
// Geometry: request coords are DISPLAY space (top-left origin, y-down, after
// /Rotate — same space pdf.js renders in); PDF objects use USER space (y-up,
// /MediaBox origin). The wasm engines did this flip internally; here we own
// it. The four /Rotate cases mirror pdf.js's PageViewport transform.
// ---------------------------------------------------------------------------
interface Geom {
  mx0: number
  my0: number
  W: number // user-space width  (mx1-mx0)
  H: number // user-space height (my1-my0)
  rot: 0 | 90 | 180 | 270
}

function geomOf(page: PageInfo): Geom {
  const [mx0, my0, mx1, my1] = page.mediaBox
  return { mx0, my0, W: mx1 - mx0, H: my1 - my0, rot: page.rotate }
}

function toUser(g: Geom, x: number, y: number): [number, number] {
  switch (g.rot) {
    case 0: return [g.mx0 + x, g.my0 + g.H - y]
    case 90: return [g.mx0 + y, g.my0 + x]
    case 180: return [g.mx0 + g.W - x, g.my0 + y]
    case 270: return [g.mx0 + g.W - y, g.my0 + g.H - x]
  }
}

function fromUser(g: Geom, ux: number, uy: number): [number, number] {
  switch (g.rot) {
    case 0: return [ux - g.mx0, g.H - (uy - g.my0)]
    case 90: return [uy - g.my0, ux - g.mx0]
    case 180: return [g.W - (ux - g.mx0), uy - g.my0]
    case 270: return [g.H - (uy - g.my0), g.W - (ux - g.mx0)]
  }
}

/** Display-space delta -> user-space delta (rotation only, no translation). */
function deltaToUser(g: Geom, dx: number, dy: number): [number, number] {
  switch (g.rot) {
    case 0: return [dx, -dy]
    case 90: return [dy, dx]
    case 180: return [-dx, dy]
    case 270: return [-dy, -dx]
  }
}

/** Display rect -> user-space [x0,y0,x1,y1] (axis-aligned for 90° rotations). */
function rectToUser(g: Geom, r: PageRect): [number, number, number, number] {
  const [ax, ay] = toUser(g, r.x, r.y)
  const [bx, by] = toUser(g, r.x + r.w, r.y + r.h)
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

function rectFromUser(g: Geom, u: [number, number, number, number]): PageRect {
  const [ax, ay] = fromUser(g, u[0], u[1])
  const [bx, by] = fromUser(g, u[2], u[3])
  const x = Math.min(ax, bx)
  const y = Math.min(ay, by)
  return { x, y, w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

const unionRects = (rects: [number, number, number, number][]): [number, number, number, number] => [
  Math.min(...rects.map((r) => r[0])),
  Math.min(...rects.map((r) => r[1])),
  Math.max(...rects.map((r) => r[2])),
  Math.max(...rects.map((r) => r[3]))
]

const pad = (r: [number, number, number, number], p: number): [number, number, number, number] => [
  r[0] - p, r[1] - p, r[2] + p, r[3] + p
]

// ---------------------------------------------------------------------------
// Text encoding
// ---------------------------------------------------------------------------
/** Text string for /Contents, /T etc.: ASCII → literal; else UTF-16BE hex. */
function textString(s: string): PdfValue {
  let ascii = true
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7e || s.charCodeAt(i) < 0x20) { ascii = false; break }
  }
  if (ascii) {
    return { t: 'str', raw: Buffer.from(s.replace(/([\\()])/g, '\\$1'), 'latin1') }
  }
  let hex = 'FEFF'
  for (let i = 0; i < s.length; i++) {
    hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  }
  return { t: 'hex', raw: hex }
}

/** Decode a parsed PDF string back to JS (UTF-16BE w/ BOM or Latin-1-ish). */
function decodePdfString(v: PdfValue): string {
  let bytes: Buffer
  if (v.t === 'hex') {
    const clean = v.raw.length % 2 === 1 ? v.raw + '0' : v.raw
    bytes = Buffer.from(clean, 'hex')
  } else if (v.t === 'str') {
    // resolve literal-string escapes
    const out: number[] = []
    const raw = v.raw
    for (let i = 0; i < raw.length; i++) {
      const b = raw[i]
      if (b !== 0x5c) { out.push(b); continue }
      const e = raw[++i]
      if (e === 0x6e) out.push(0x0a)
      else if (e === 0x72) out.push(0x0d)
      else if (e === 0x74) out.push(0x09)
      else if (e === 0x62) out.push(0x08)
      else if (e === 0x66) out.push(0x0c)
      else if (e >= 0x30 && e <= 0x37) {
        let oct = e - 0x30
        for (let k = 0; k < 2 && raw[i + 1] >= 0x30 && raw[i + 1] <= 0x37; k++) oct = oct * 8 + (raw[++i] - 0x30)
        out.push(oct & 0xff)
      } else if (e === 0x0a || e === 0x0d) {
        if (e === 0x0d && raw[i + 1] === 0x0a) i++ // line continuation
      } else out.push(e)
    }
    bytes = Buffer.from(out)
  } else return ''
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] * 256 + bytes[i + 1])
    return s
  }
  return bytes.toString('latin1')
}

/** Unicode -> WinAnsi (cp1252) byte; unmappable chars become '?'. */
function winAnsiByte(code: number): number {
  if (code <= 0x7e) return code // ASCII (incl. controls we never emit)
  if (code >= 0xa0 && code <= 0xff) return code // Latin-1 block = cp1252 (æøåÆØÅ live here)
  const CP1252: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
    0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
    0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
  }
  return CP1252[code] ?? 0x3f
}

/** Escaped literal-string content-stream operand of WinAnsi-encoded text. */
function winAnsiLiteral(s: string): string {
  let out = '('
  for (let i = 0; i < s.length; i++) {
    const b = winAnsiByte(s.charCodeAt(i))
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b)
    else if (b < 0x20 || b > 0x7e) out += '\\' + b.toString(8).padStart(3, '0')
    else out += String.fromCharCode(b)
  }
  return out + ')'
}

// Helvetica advance widths (per mille) for naive FreeText wrapping — WinAnsi
// subset from the AFM. Only used to ESTIMATE line breaks; never written to
// the file (base-14 font, no embedding). Unlisted chars fall back to 556.
const HELV_DEFAULT_W = 556
const HELV_W: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333,
  ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, ':': 278, ';': 278,
  '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667,
  F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667,
  Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278,
  '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, a: 556, b: 556, c: 500, d: 556, e: 556,
  f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556,
  q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334,
  '|': 260, '}': 334, '~': 584, æ: 889, ø: 611, å: 556, Æ: 1000, Ø: 778, Å: 667
}
const helvWidth = (s: string, size: number): number => {
  let w = 0
  for (const ch of s) w += HELV_W[ch] ?? HELV_DEFAULT_W
  return (w / 1000) * size
}

/** Naive word wrap at `maxW` points; hard-breaks overlong words by char. */
function wrapText(text: string, size: number, maxW: number): string[] {
  const lines: string[] = []
  for (const para of text.split(/\r\n|\r|\n/)) {
    let line = ''
    for (const word of para.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (helvWidth(candidate, size) <= maxW || line === '') {
        line = candidate
        // hard-break a single word wider than the box
        while (helvWidth(line, size) > maxW && line.length > 1) {
          let cut = line.length - 1
          while (cut > 1 && helvWidth(line.slice(0, cut), size) > maxW) cut--
          lines.push(line.slice(0, cut))
          line = line.slice(cut)
        }
      } else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Appearance streams — built by hand per type. Geometry comes in DISPLAY
// space and every emitted point goes through toUser(); the /BBox equals the
// user-space /Rect (no /Matrix), so form space === page space.
// ---------------------------------------------------------------------------
type Rgb = [number, number, number]
const fmtRgb = (c: Rgb): string => c.map(fmtNum).join(' ')

interface Appearance {
  /** user-space rect: both the annot /Rect and the form /BBox */
  rect: [number, number, number, number]
  content: string
  /** ExtGState needed (opacity < 1 or highlight blend) */
  gs: { blend: boolean; alpha: number } | null
  needsFont: boolean
}

/** Point operand in user space. */
const up = (g: Geom, x: number, y: number): string => {
  const [ux, uy] = toUser(g, x, y)
  return `${fmtNum(ux)} ${fmtNum(uy)}`
}
/** Axis-aligned `re` operand from a display rect. */
const ure = (g: Geom, r: PageRect): string => {
  const [x0, y0, x1, y1] = rectToUser(g, r)
  return `${fmtNum(x0)} ${fmtNum(y0)} ${fmtNum(x1 - x0)} ${fmtNum(y1 - y0)} re`
}

interface ShapeSpec {
  type: AnnotateRequest['type']
  quads: PageRect[]
  color: Rgb
  opacity: number
  strokes?: [number, number][][]
  width?: number
  contents?: string
  fontSize?: number
}

function buildAppearance(g: Geom, s: ShapeSpec): Appearance {
  const ops: string[] = []
  const alpha = s.opacity ?? 1
  let gs: Appearance['gs'] = alpha < 1 ? { blend: false, alpha } : null
  let rect: [number, number, number, number]
  let needsFont = false

  switch (s.type) {
    case 'highlight': {
      // Filled quads multiplied onto the page — same look as PDFium's
      // generated highlight APs and the app's CSS (multiply, pastel fill).
      gs = { blend: true, alpha }
      ops.push(`${fmtRgb(s.color)} rg`)
      for (const q of s.quads) ops.push(ure(g, q))
      ops.push('f')
      rect = unionRects(s.quads.map((q) => rectToUser(g, q)))
      break
    }
    case 'underline':
    case 'strikeout': {
      // Offsets mirror the renderer overlay (annotations.ts annotationCss):
      // underline sits max(1.5, 4.5% of line height) above the quad bottom,
      // strikeout crosses at 52% of the height.
      ops.push(`${fmtRgb(s.color)} RG`)
      for (const q of s.quads) {
        const lw = Math.min(2.5, Math.max(1.2, q.h * 0.11))
        const y = s.type === 'underline' ? q.y + q.h - Math.max(1.5, q.h * 0.045) : q.y + q.h * 0.52
        ops.push(`${fmtNum(lw)} w`, `${up(g, q.x, y)} m`, `${up(g, q.x + q.w, y)} l`, 'S')
      }
      rect = pad(unionRects(s.quads.map((q) => rectToUser(g, q))), 1)
      break
    }
    case 'squiggly': {
      ops.push(`${fmtRgb(s.color)} RG`, '1 w', '1 J 1 j')
      for (const q of s.quads) {
        const base = q.y + q.h - Math.max(2, q.h * 0.06)
        const amp = Math.max(1.2, q.h * 0.08)
        const half = 2 // display points per half-period (≈ renderer stripe pitch)
        ops.push(`${up(g, q.x, base)} m`)
        for (let x = q.x + half, i = 1; x < q.x + q.w + half; x += half, i++) {
          ops.push(`${up(g, Math.min(x, q.x + q.w), i % 2 ? base - amp : base)} l`)
        }
        ops.push('S')
      }
      rect = pad(unionRects(s.quads.map((q) => rectToUser(g, q))), 1)
      break
    }
    case 'ink': {
      const w = s.width ?? 2
      ops.push(`${fmtRgb(s.color)} RG`, `${fmtNum(w)} w`, '1 J 1 j')
      for (const stroke of s.strokes ?? []) {
        if (stroke.length === 0) continue
        ops.push(`${up(g, stroke[0][0], stroke[0][1])} m`)
        for (let i = 1; i < stroke.length; i++) ops.push(`${up(g, stroke[i][0], stroke[i][1])} l`)
        if (stroke.length === 1) ops.push(`${up(g, stroke[0][0] + 0.1, stroke[0][1])} l`) // dot
        ops.push('S')
      }
      const pts = (s.strokes ?? []).flat()
      rect = pad(unionRects(pts.map(([x, y]) => rectToUser(g, { x, y, w: 0, h: 0 }))), w)
      break
    }
    case 'square': {
      const q = s.quads[0]
      const w = s.width ?? 2
      const inset = w / 2
      ops.push(`${fmtRgb(s.color)} RG`, `${fmtNum(w)} w`,
        ure(g, { x: q.x + inset, y: q.y + inset, w: Math.max(0, q.w - w), h: Math.max(0, q.h - w) }), 'S')
      rect = rectToUser(g, q)
      break
    }
    case 'circle': {
      const q = s.quads[0]
      const w = s.width ?? 2
      const cx = q.x + q.w / 2
      const cy = q.y + q.h / 2
      const rx = Math.max(0.1, q.w / 2 - w / 2)
      const ry = Math.max(0.1, q.h / 2 - w / 2)
      const k = 0.5522847498
      ops.push(`${fmtRgb(s.color)} RG`, `${fmtNum(w)} w`)
      // 4-bezier ellipse; control points mapped through toUser stay valid
      // under 90°-multiple rotations (axis-aligned either way)
      ops.push(`${up(g, cx + rx, cy)} m`)
      ops.push(`${up(g, cx + rx, cy + k * ry)} ${up(g, cx + k * rx, cy + ry)} ${up(g, cx, cy + ry)} c`)
      ops.push(`${up(g, cx - k * rx, cy + ry)} ${up(g, cx - rx, cy + k * ry)} ${up(g, cx - rx, cy)} c`)
      ops.push(`${up(g, cx - rx, cy - k * ry)} ${up(g, cx - k * rx, cy - ry)} ${up(g, cx, cy - ry)} c`)
      ops.push(`${up(g, cx + k * rx, cy - ry)} ${up(g, cx + rx, cy - k * ry)} ${up(g, cx + rx, cy)} c`)
      ops.push('S')
      rect = rectToUser(g, q)
      break
    }
    case 'line':
    case 'arrow': {
      const [a, b] = s.strokes?.[0] ?? []
      if (!a || !b) throw new AppendError('Linjen mangler endepunkter')
      const w = s.width ?? 2
      ops.push(`${fmtRgb(s.color)} RG`, `${fmtNum(w)} w`, '1 J',
        `${up(g, a[0], a[1])} m`, `${up(g, b[0], b[1])} l`, 'S')
      let extra = w
      if (s.type === 'arrow') {
        // Filled triangular head sized like the app overlay:
        // max(11, width*4.5), half-angle 0.46 rad (annotations.ts arrowHeadPoints)
        const size = Math.max(11, w * 4.5)
        const spread = 0.46
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
        const p1: [number, number] = [b[0] - size * Math.cos(ang - spread), b[1] - size * Math.sin(ang - spread)]
        const p2: [number, number] = [b[0] - size * Math.cos(ang + spread), b[1] - size * Math.sin(ang + spread)]
        ops.push(`${fmtRgb(s.color)} rg`, `${up(g, b[0], b[1])} m`,
          `${up(g, p1[0], p1[1])} l`, `${up(g, p2[0], p2[1])} l`, 'h f')
        extra = Math.max(extra, size * 0.5)
      }
      rect = pad(
        unionRects([a, b].map(([x, y]) => rectToUser(g, { x, y, w: 0, h: 0 }))),
        extra + 1
      )
      break
    }
    case 'freetext': {
      const q = s.quads[0]
      const size = s.fontSize ?? 12
      const inset = 2
      const lines = wrapText(s.contents ?? '', size, Math.max(size, q.w - 2 * inset))
      const leading = size * 1.18
      // Text matrix carries the /Rotate so glyphs stay upright in display
      // space; the translation lands the first baseline at the box top-left.
      const [tx, ty] = toUser(g, q.x + inset, q.y + inset + size * 0.75)
      const TM: Record<Geom['rot'], string> = { 0: '1 0 0 1', 90: '0 1 -1 0', 180: '-1 0 0 -1', 270: '0 -1 1 0' }
      ops.push('BT', `/Helv ${fmtNum(size)} Tf`, `${fmtRgb(s.color)} rg`,
        `${TM[g.rot]} ${fmtNum(tx)} ${fmtNum(ty)} Tm`, `${fmtNum(leading)} TL`)
      lines.forEach((line, i) => {
        if (i > 0) ops.push('T*')
        if (line !== '') ops.push(`${winAnsiLiteral(line)} Tj`)
      })
      ops.push('ET')
      needsFont = true
      rect = rectToUser(g, q)
      break
    }
    default:
      throw new AppendError(`Ukjent annotasjonstype: ${s.type}`)
  }

  const content = (gs ? '/G0 gs\n' : '') + ops.join('\n')
  return { rect, content, gs, needsFont }
}

/** Form-XObject stream for an appearance. */
function appearanceObject(num: number, ap: Appearance): Buffer {
  const resources: [string, PdfValue][] = []
  if (ap.gs) {
    resources.push(['ExtGState', DICT([
      ['G0', DICT([
        ['Type', NAME('ExtGState')],
        ['CA', N(ap.gs.alpha)],
        ['ca', N(ap.gs.alpha)],
        ...(ap.gs.blend ? ([['BM', NAME('Multiply')]] as [string, PdfValue][]) : [])
      ])]
    ])])
  }
  if (ap.needsFont) {
    resources.push(['Font', DICT([
      ['Helv', DICT([
        ['Type', NAME('Font')],
        ['Subtype', NAME('Type1')],
        ['BaseFont', NAME('Helvetica')],
        ['Encoding', NAME('WinAnsiEncoding')]
      ])]
    ])])
  }
  const dict: PdfDict = new Map<string, PdfValue>([
    ['Type', NAME('XObject')],
    ['Subtype', NAME('Form')],
    ['FormType', N(1)],
    ['BBox', ARR(ap.rect.map(N))],
    ...(resources.length > 0 ? ([['Resources', DICT(resources)]] as [string, PdfValue][]) : []),
    ...(ap.gs?.blend ? ([['Group', DICT([['S', NAME('Transparency')]])]] as [string, PdfValue][]) : [])
  ])
  return streamObjectBuffer(num, 0, dict, Buffer.from(ap.content, 'latin1'))
}

// ---------------------------------------------------------------------------
// Annotation dictionaries
// ---------------------------------------------------------------------------
function pdfDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`
}

const SUBTYPE_NAME: Record<AnnotateRequest['type'], string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
  note: 'Text',
  ink: 'Ink',
  square: 'Square',
  circle: 'Circle',
  line: 'Line',
  arrow: 'Line',
  freetext: 'FreeText'
}
const TYPE_OF_SUBTYPE: Record<string, AnnotateRequest['type']> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Squiggly: 'squiggly',
  Text: 'note',
  Ink: 'ink',
  Square: 'square',
  Circle: 'circle',
  Line: 'line',
  FreeText: 'freetext'
}

const MARKUP_TYPES = new Set<AnnotateRequest['type']>(['highlight', 'underline', 'strikeout', 'squiggly'])

/** User-space quad points, one group of 8 per display quad. Order TL TR BL BR
 *  (the de-facto Adobe convention; pdf.js only min/maxes them). */
function quadPoints(g: Geom, quads: PageRect[]): PdfValue {
  const nums: number[] = []
  for (const q of quads) {
    const [x0, y0, x1, y1] = rectToUser(g, q)
    nums.push(x0, y1, x1, y1, x0, y0, x1, y0)
  }
  return ARR(nums.map(N))
}

const daString = (color: Rgb, size: number): PdfValue =>
  ({ t: 'str', raw: Buffer.from(`${fmtRgb(color)} rg /Helv ${fmtNum(size)} Tf`, 'latin1') })

/** Build the complete annotation dict for a create request. */
function buildAnnotDict(
  req: AnnotateRequest,
  g: Geom,
  page: PageInfo,
  rect: [number, number, number, number],
  apNum: number | null
): PdfDict {
  const now = pdfDate(new Date())
  const dict: PdfDict = new Map<string, PdfValue>([
    ['Type', NAME('Annot')],
    ['Subtype', NAME(SUBTYPE_NAME[req.type])],
    ['Rect', ARR(rect.map(N))],
    ['P', REF(page.pageNum, page.pageGen)],
    ['NM', textString(randomUUID())],
    ['T', textString(req.author ?? 'PDFX')],
    ['M', { t: 'str', raw: Buffer.from(now) }],
    ['CreationDate', { t: 'str', raw: Buffer.from(now) }],
    ['F', N(4)],
    ['CA', N(req.opacity ?? 1)]
  ])
  if (req.contents !== undefined) dict.set('Contents', textString(req.contents))
  if (req.type !== 'freetext') dict.set('C', ARR(req.color.map(N))) // freetext: color lives in /DA
  if (apNum !== null) dict.set('AP', DICT([['N', REF(apNum)]]))

  if (MARKUP_TYPES.has(req.type)) {
    dict.set('QuadPoints', quadPoints(g, req.quads))
  } else if (req.type === 'note') {
    dict.set('Name', NAME('Note')) // no /AP — viewers draw the standard icon
    if (req.contents === undefined) dict.set('Contents', textString(''))
  } else if (req.type === 'ink') {
    dict.set('InkList', ARR(
      (req.strokes ?? []).map((stroke) =>
        ARR(stroke.flatMap(([x, y]) => { const [ux, uy] = toUser(g, x, y); return [N(ux), N(uy)] }))
      )
    ))
    dict.set('BS', DICT([['W', N(req.width ?? 2)], ['S', NAME('S')]]))
  } else if (req.type === 'square' || req.type === 'circle') {
    dict.set('BS', DICT([['W', N(req.width ?? 2)], ['S', NAME('S')]]))
  } else if (req.type === 'line' || req.type === 'arrow') {
    const [a, b] = req.strokes![0]
    const [ax, ay] = toUser(g, a[0], a[1])
    const [bx, by] = toUser(g, b[0], b[1])
    dict.set('L', ARR([N(ax), N(ay), N(bx), N(by)]))
    dict.set('BS', DICT([['W', N(req.width ?? 2)], ['S', NAME('S')]]))
    if (req.type === 'arrow') {
      dict.set('LE', ARR([NAME('None'), NAME('ClosedArrow')]))
      dict.set('IC', ARR(req.color.map(N))) // arrowhead fill
    }
  } else if (req.type === 'freetext') {
    dict.set('DA', daString(req.color, req.fontSize ?? 12))
    dict.set('Q', N(0))
    if (req.contents === undefined) dict.set('Contents', textString(''))
  }
  return dict
}

// ---------------------------------------------------------------------------
// The incremental xref section writer
// ---------------------------------------------------------------------------
interface OutObj {
  num: number
  gen: number
  data: Buffer
}

/** Append `objs` + a matching xref section (+trailer) to the file. */
async function appendIncrement(pdf: PdfFile, objs: OutObj[]): Promise<void> {
  const base = pdf.size
  // The xref-stream section is itself an object and needs a number BEFORE
  // /Size is computed (its own entry is part of the section).
  const xrefStreamNum = pdf.latestKind === 'stream' ? pdf.allocObjNum() : -1

  const parts: Buffer[] = [Buffer.from('\n')] // the file may not end in an EOL
  let pos = base + 1
  const entries = new Map<number, { offset: number; gen: number }>()
  for (const o of objs) {
    entries.set(o.num, { offset: pos, gen: o.gen })
    parts.push(o.data)
    pos += o.data.length
  }
  const xrefOffset = pos

  // Trailer keys: /Size (new), /Prev (old startxref), /Root — plus /Info and
  // /ID carried over so metadata stays reachable from the newest trailer.
  const carried: [string, PdfValue][] = [['Size', N(pdf.newSize)], ['Root', pdf.trailer.get('Root')!]]
  const info = pdf.trailer.get('Info')
  if (info) carried.push(['Info', info])
  const id = pdf.trailer.get('ID')
  if (id) carried.push(['ID', id])
  carried.push(['Prev', N(pdf.startxref)])

  if (pdf.latestKind === 'classic') {
    // §7.5.4 classic table, contiguous runs, EXACT 20-byte records
    const nums = [...entries.keys()].sort((a, b) => a - b)
    let table = 'xref\n'
    for (let i = 0; i < nums.length; ) {
      let j = i
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
      table += `${nums[i]} ${j - i + 1}\n`
      for (let k = i; k <= j; k++) {
        const e = entries.get(nums[k])!
        table += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`
      }
      i = j + 1
    }
    table += 'trailer\n'
    parts.push(Buffer.from(table), serialize(DICT(carried)),
      Buffer.from(`\nstartxref\n${xrefOffset}\n%%EOF\n`))
  } else {
    // §7.5.8 xref STREAM (a classic table here would be an invalid mix).
    // Uncompressed, W = [1 4 2]: type byte, 4-byte offset, 2-byte gen.
    entries.set(xrefStreamNum, { offset: xrefOffset, gen: 0 })
    const nums = [...entries.keys()].sort((a, b) => a - b)
    const index: number[] = []
    for (let i = 0; i < nums.length; ) {
      let j = i
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
      index.push(nums[i], j - i + 1)
      i = j + 1
    }
    const rows = Buffer.alloc(nums.length * 7)
    nums.forEach((num, i) => {
      const e = entries.get(num)!
      if (e.offset > 0xffffffff) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'file exceeds 4 GB')
      rows[i * 7] = 1
      rows.writeUInt32BE(e.offset, i * 7 + 1)
      rows.writeUInt16BE(e.gen, i * 7 + 5)
    })
    const dict: PdfDict = new Map<string, PdfValue>([
      ['Type', NAME('XRef')],
      ...carried,
      ['W', ARR([N(1), N(4), N(2)])],
      ['Index', ARR(index.map(N))]
    ])
    parts.push(streamObjectBuffer(xrefStreamNum, 0, dict, rows),
      Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`))
  }

  const buf = Buffer.concat(parts)
  try {
    await pdf.fh.write(buf, 0, buf.length, base)
    await pdf.fh.datasync()
  } catch (err) {
    // A partial tail would corrupt the (draft) file — cut it back off.
    await pdf.fh.truncate(base).catch(() => {})
    throw err
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
/** Rewrite the object holding the page's annotation list with `items`.
 *  Returns the objects to append (array object OR the whole page dict). */
async function annotsHolderRewrite(
  pdf: PdfFile,
  page: PageInfo,
  mutate: (items: PdfValue[]) => PdfValue[] | null // null = "not found"
): Promise<OutObj[] | null> {
  const annotsVal = page.pageDict.get('Annots')
  if (annotsVal === undefined) {
    const items = mutate([])
    if (items === null) return null
    page.pageDict.set('Annots', ARR(items))
    return [{ num: page.pageNum, gen: page.pageGen, data: objectBuffer(page.pageNum, page.pageGen, { t: 'dict', map: page.pageDict }) }]
  }
  if (annotsVal.t === 'arr') {
    const items = mutate(annotsVal.items)
    if (items === null) return null
    page.pageDict.set('Annots', ARR(items))
    return [{ num: page.pageNum, gen: page.pageGen, data: objectBuffer(page.pageNum, page.pageGen, { t: 'dict', map: page.pageDict }) }]
  }
  if (annotsVal.t === 'ref') {
    const arrObj = await pdf.getObject(annotsVal.num)
    if (arrObj.value.t !== 'arr') throw new AppendError(APPEND_UNSUPPORTED_MSG, '/Annots ref is not an array')
    const items = mutate(arrObj.value.items)
    if (items === null) return null
    const gen = pdf.genOf(annotsVal.num) // 0 when it lived in an object stream
    return [{ num: annotsVal.num, gen, data: objectBuffer(annotsVal.num, gen, ARR(items)) }]
  }
  throw new AppendError(APPEND_UNSUPPORTED_MSG, 'unsupported /Annots shape')
}

async function opCreate(pdf: PdfFile, req: AnnotateRequest): Promise<AnnotateResult> {
  if (req.quads.length === 0 && req.type !== 'ink' && req.type !== 'line' && req.type !== 'arrow') {
    return { error: 'Annotasjonen har ingen posisjon' }
  }
  if (req.type === 'ink' && (!req.strokes || req.strokes.every((s) => s.length === 0))) {
    return { error: 'Streken er tom' }
  }
  if ((req.type === 'line' || req.type === 'arrow') && (req.strokes?.[0]?.length ?? 0) < 2) {
    return { error: 'Linjen mangler endepunkter' }
  }
  const page = await findPage(pdf, req.pageIndex)
  const g = geomOf(page)
  const annotNum = pdf.allocObjNum()
  const objs: OutObj[] = []

  let rect: [number, number, number, number]
  let apNum: number | null = null
  if (req.type === 'note') {
    const q = req.quads[0]
    rect = rectToUser(g, { x: q.x, y: q.y, w: Math.max(q.w, 20), h: Math.max(q.h, 20) })
  } else {
    const ap = buildAppearance(g, req)
    apNum = pdf.allocObjNum()
    objs.push({ num: apNum, gen: 0, data: appearanceObject(apNum, ap) })
    rect = ap.rect
  }
  const dict = buildAnnotDict(req, g, page, rect, apNum)
  objs.push({ num: annotNum, gen: 0, data: objectBuffer(annotNum, 0, { t: 'dict', map: dict }) })

  const holder = await annotsHolderRewrite(pdf, page, (items) => [...items, REF(annotNum)])
  objs.push(...holder!)
  await appendIncrement(pdf, objs)
  return { ok: true, id: annotNum }
}

async function opDelete(pdf: PdfFile, req: DeleteAnnotationRequest): Promise<AnnotateResult> {
  const page = await findPage(pdf, req.pageIndex)
  // Removing the ref from /Annots is the whole deletion — the orphaned
  // annotation object is legal garbage (incremental updates never reclaim).
  const holder = await annotsHolderRewrite(pdf, page, (items) => {
    const kept = items.filter((i) => !(i.t === 'ref' && i.num === req.id))
    return kept.length === items.length ? null : kept
  })
  if (holder === null) return { error: NOT_FOUND_MSG }
  await appendIncrement(pdf, holder)
  return { ok: true, id: req.id }
}

/** Resolve a PdfValue into a plain number[] (flat array of numbers). */
async function numArray(pdf: PdfFile, v: PdfValue | undefined): Promise<number[] | null> {
  const arr = await pdf.resolve(v)
  if (arr?.t !== 'arr') return null
  const out: number[] = []
  for (const item of arr.items) out.push(await pdf.resolveNumber(item))
  return out
}

/** Shift a flat [x y x y ...] number array by a user-space delta. */
const shiftPairs = (nums: number[], dux: number, duy: number): number[] =>
  nums.map((n, i) => (i % 2 === 0 ? n + dux : n + duy))

async function opUpdate(pdf: PdfFile, req: ModifyAnnotationRequest): Promise<AnnotateResult> {
  const entry = pdf.xref.get(req.id)
  if (!entry || entry.type === 0) return { error: NOT_FOUND_MSG }
  // A foreign annotation compressed into an object stream: rewriting it as a
  // plain object is possible in principle, but its sibling objects keep
  // pointing at the (now shadowed) container entry — refuse rather than risk
  // a doubtful append.
  if (entry.type === 2) return { error: OBJSTM_EDIT_MSG }
  let obj: IndirectObject
  try {
    obj = await pdf.getObject(req.id)
  } catch {
    return { error: NOT_FOUND_MSG }
  }
  if (obj.value.t !== 'dict' || obj.streamDataOffset !== undefined) return { error: NOT_FOUND_MSG }
  const dict = obj.value.map
  const subtype = dictGetName(dict, 'Subtype')
  const type = subtype ? TYPE_OF_SUBTYPE[subtype] : undefined
  if (!type) throw new AppendError(APPEND_UNSUPPORTED_MSG, `cannot edit /Subtype ${subtype}`)

  const page = await findPage(pdf, req.pageIndex)
  const g = geomOf(page)

  // ---- apply the patch to the dict (all geometry in USER space) ----
  if (req.color) {
    if (type === 'freetext') {
      // font color lives in /DA — keep the existing size
      const oldDa = dict.get('DA')
      const sizeM = oldDa && (oldDa.t === 'str' || oldDa.t === 'hex')
        ? /\/\S+\s+([\d.]+)\s+Tf/.exec(decodePdfString(oldDa))
        : null
      dict.set('DA', daString(req.color, sizeM ? Number(sizeM[1]) : 12))
    } else {
      dict.set('C', ARR(req.color.map(N)))
      if (dict.has('IC')) dict.set('IC', ARR(req.color.map(N)))
    }
  }
  if (req.opacity !== undefined) dict.set('CA', N(req.opacity))
  if (req.contents !== undefined) {
    dict.set('Contents', textString(req.contents))
    dict.delete('RC') // stale rich text would override /Contents in some viewers
  }
  if (req.rect && type !== 'line' && type !== 'arrow') {
    dict.set('Rect', ARR(rectToUser(g, req.rect).map(N)))
  }
  if (req.translate) {
    const [dux, duy] = deltaToUser(g, req.translate.dx, req.translate.dy)
    for (const key of ['Rect', 'QuadPoints', 'L', 'Vertices'] as const) {
      const nums = await numArray(pdf, dict.get(key))
      if (nums) dict.set(key, ARR(shiftPairs(nums, dux, duy).map(N)))
    }
    const inkList = await pdf.resolve(dict.get('InkList'))
    if (inkList?.t === 'arr') {
      const strokes: PdfValue[] = []
      for (const stroke of inkList.items) {
        const nums = await numArray(pdf, stroke)
        if (nums === null) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'bad /InkList')
        strokes.push(ARR(shiftPairs(nums, dux, duy).map(N)))
      }
      dict.set('InkList', ARR(strokes))
    }
  }
  dict.set('M', { t: 'str', raw: Buffer.from(pdfDate(new Date())) })

  const objs: OutObj[] = []
  // ---- regenerate the appearance stream from the PATCHED dict ----
  // (skip Text notes: they carry no AP of ours; a foreign note's AP keeps
  // rendering right after a move because /BBox-to-/Rect mapping follows /Rect)
  if (type !== 'note') {
    const spec = await shapeFromDict(pdf, g, type, dict)
    const ap = buildAppearance(g, spec)
    // Keep /Rect in lockstep with the regenerated appearance geometry
    dict.set('Rect', ARR(ap.rect.map(N)))
    const apNum = pdf.allocObjNum()
    dict.set('AP', DICT([['N', REF(apNum)]]))
    objs.push({ num: apNum, gen: 0, data: appearanceObject(apNum, ap) })
  }
  objs.push({ num: req.id, gen: entry.gen, data: objectBuffer(req.id, entry.gen, { t: 'dict', map: dict }) })
  await appendIncrement(pdf, objs)
  return { ok: true, id: req.id }
}

/** Reconstruct display-space appearance inputs from an annotation dict. */
async function shapeFromDict(
  pdf: PdfFile,
  g: Geom,
  type: AnnotateRequest['type'],
  dict: PdfDict
): Promise<ShapeSpec> {
  const caV = dict.get('CA')
  const opacity = caV?.t === 'num' ? caV.v : 1

  let color: Rgb = [0.89, 0.29, 0.29]
  if (type === 'freetext') {
    const da = dict.get('DA')
    const daStr = da && (da.t === 'str' || da.t === 'hex') ? decodePdfString(da) : ''
    const cm = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(daStr)
    const gm = /([\d.]+)\s+g(?![a-zA-Z])/.exec(daStr)
    if (cm) color = [Number(cm[1]), Number(cm[2]), Number(cm[3])]
    else if (gm) color = [Number(gm[1]), Number(gm[1]), Number(gm[1])]
    else color = [0, 0, 0]
  } else {
    const c = await numArray(pdf, dict.get('C'))
    if (c && c.length === 3) color = [c[0], c[1], c[2]]
    else if (c && c.length === 1) color = [c[0], c[0], c[0]]
  }

  const rectNums = await numArray(pdf, dict.get('Rect'))
  if (!rectNums || rectNums.length !== 4) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'annotation has no /Rect')
  const rectU: [number, number, number, number] = [
    Math.min(rectNums[0], rectNums[2]),
    Math.min(rectNums[1], rectNums[3]),
    Math.max(rectNums[0], rectNums[2]),
    Math.max(rectNums[1], rectNums[3])
  ]
  const rectD = rectFromUser(g, rectU)

  const bs = await pdf.resolve(dict.get('BS'))
  const bsW = bs?.t === 'dict' ? bs.map.get('W') : undefined
  const width = bsW?.t === 'num' ? bsW.v : 2

  if (MARKUP_TYPES.has(type)) {
    const qp = await numArray(pdf, dict.get('QuadPoints'))
    const quads: PageRect[] = []
    if (qp && qp.length >= 8) {
      for (let i = 0; i + 7 < qp.length; i += 8) {
        const xs = [qp[i], qp[i + 2], qp[i + 4], qp[i + 6]]
        const ys = [qp[i + 1], qp[i + 3], qp[i + 5], qp[i + 7]]
        quads.push(rectFromUser(g, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]))
      }
    } else {
      quads.push(rectD)
    }
    return { type, quads, color, opacity }
  }
  if (type === 'ink') {
    const inkList = await pdf.resolve(dict.get('InkList'))
    if (inkList?.t !== 'arr') throw new AppendError(APPEND_UNSUPPORTED_MSG, 'ink annotation has no /InkList')
    const strokes: [number, number][][] = []
    for (const strokeV of inkList.items) {
      const nums = await numArray(pdf, strokeV)
      if (nums === null) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'bad /InkList')
      const pts: [number, number][] = []
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push(fromUser(g, nums[i], nums[i + 1]))
      strokes.push(pts)
    }
    return { type, quads: [rectD], color, opacity, strokes, width }
  }
  if (type === 'line' || type === 'arrow') {
    const l = await numArray(pdf, dict.get('L'))
    if (!l || l.length !== 4) throw new AppendError(APPEND_UNSUPPORTED_MSG, 'line annotation has no /L')
    const le = await pdf.resolve(dict.get('LE'))
    const isArrow =
      le?.t === 'arr' && le.items.some((i) => i.t === 'name' && i.v !== 'None')
    return {
      type: isArrow ? 'arrow' : 'line',
      quads: [rectD],
      color,
      opacity,
      strokes: [[fromUser(g, l[0], l[1]), fromUser(g, l[2], l[3])]],
      width
    }
  }
  if (type === 'freetext') {
    const da = dict.get('DA')
    const daStr = da && (da.t === 'str' || da.t === 'hex') ? decodePdfString(da) : ''
    const sm = /\/\S+\s+([\d.]+)\s+Tf/.exec(daStr)
    const contentsV = dict.get('Contents')
    return {
      type,
      quads: [rectD],
      color,
      opacity,
      contents: contentsV && (contentsV.t === 'str' || contentsV.t === 'hex') ? decodePdfString(contentsV) : '',
      fontSize: sm ? Number(sm[1]) : 12
    }
  }
  // square / circle: geometry is the /Rect itself
  return { type, quads: [rectD], color, opacity, width }
}

// ---------------------------------------------------------------------------
// Public API — one open->parse->append->close cycle per call, serialized per
// path (concurrent appends to one file would race on the xref chain). Errors
// NEVER fall through to the WASM engine: an unsupported construct returns the
// friendly Norwegian message and the file is left untouched.
// ---------------------------------------------------------------------------
const chains = new Map<string, Promise<unknown>>()
function enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve()
  const run = prev.then(task, task)
  const tail = run.then(() => undefined, () => undefined)
  chains.set(path, tail)
  void tail.then(() => {
    if (chains.get(path) === tail) chains.delete(path)
  })
  return run
}

function withFile(path: string, op: (pdf: PdfFile) => Promise<AnnotateResult>): Promise<AnnotateResult> {
  return enqueue(path, async () => {
    let pdf: PdfFile | null = null
    try {
      pdf = await PdfFile.load(path)
      return await op(pdf)
    } catch (err) {
      if (err instanceof AppendError) {
        if (err.detail) console.error(`[appender] ${path}: ${err.detail}`)
        return { error: err.message }
      }
      console.error(`[appender] ${path}:`, err)
      return { error: APPEND_UNSUPPORTED_MSG }
    } finally {
      await pdf?.close()
    }
  })
}

/** Create an annotation via incremental append. Returns the PDF object number. */
export const appendAnnotation = (req: AnnotateRequest): Promise<AnnotateResult> =>
  withFile(req.path, (pdf) => opCreate(pdf, req))

/** Patch an existing annotation (color/opacity/contents/rect/translate). */
export const appendUpdateAnnotation = (req: ModifyAnnotationRequest): Promise<AnnotateResult> =>
  withFile(req.path, (pdf) => opUpdate(pdf, req))

/** Remove an annotation from its page's /Annots (orphaning the object). */
export const appendDeleteAnnotation = (req: DeleteAnnotationRequest): Promise<AnnotateResult> =>
  withFile(req.path, (pdf) => opDelete(pdf, req))




