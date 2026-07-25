// Minimal ZIP writer (deflate, no dependencies).
//
// Exists because the two Windows-native options both produce zips the extension
// stores mis-handle: PowerShell 5.1's Compress-Archive and .NET Framework's
// ZipFile.CreateFromDirectory write entry names with BACKSLASH separators, so an
// uploader looking for "manifest.json" or "icons/icon-16.png" either fails or
// flattens the tree. The ZIP spec requires forward slashes. CI zips on Linux
// (release.yml uses `zip`), so this is the local-build path.
//
// Deliberately tiny: one compression method (deflate), no zip64, no encryption,
// no directory entries. That covers a built extension (a few hundred small
// files) and nothing else.
import { deflateRawSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS packed date/time (the only timestamp a basic zip entry carries). */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/**
 * Write `entries` to `outFile` as a zip.
 * @param {string} outFile
 * @param {{name: string, data: Buffer, mtime?: Date}[]} entries — `name` is the
 *   path inside the zip; backslashes are normalised to forward slashes.
 */
export function writeZip(outFile, entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const compressed = deflateRawSync(entry.data, { level: 9 })
    const { time, date } = dosStamp(entry.mtime ?? new Date(1980, 0, 1))
    const crc = crc32(entry.data)

    // Bit 11 = names are UTF-8. Version 20 = the deflate-era baseline.
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // made by
    central.writeUInt16LE(20, 6) // needed to extract
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    // External attrs: regular file, rw-r--r-- in the high word. `>>> 0` because
    // JS bitwise math is signed 32-bit and this shift overflows into negative.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + compressed.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  writeFileSync(outFile, Buffer.concat([...locals, centralBuf, end]))
}
