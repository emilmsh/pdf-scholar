// A minimal RGBA PNG encoder for tests, so the stamp/signature path can be
// exercised with REAL image bytes without adding an image dependency to a repo
// that deliberately has none. Uncompressed-filter rows through node:zlib —
// correctness only, no attempt at small output.
import * as zlib from 'node:zlib'

function crc32(buf) {
  let c
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = c ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

/** paint(x, y) -> [r, g, b, a], each 0–255. Returns PNG bytes as a Buffer. */
export function encodePng(width, height, paint) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    raw[row] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y)
      const o = row + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** A signature-shaped mark: a dark wave on transparency. Deterministic, so a
 *  test can assert on the exact bytes it produced. */
export function signaturePng(width = 240, height = 90) {
  return encodePng(width, height, (x, y) => {
    const curve = height / 2 + Math.sin((x / width) * Math.PI * 2) * (height / 3.6)
    return Math.abs(y - curve) < 4 ? [20, 24, 40, 255] : [0, 0, 0, 0]
  })
}
