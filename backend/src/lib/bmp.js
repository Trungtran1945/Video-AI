import fs from 'node:fs'
import path from 'node:path'

// Minimal 24-bit BMP writer (uncompressed, bottom-up). No image dependency.
// Row stride is padded to 4 bytes as required by the BMP spec.

const HEADER_SIZE = 54

export function bmpBuffer({ pixelAt, width, height }) {
  const w = Math.max(1, Math.round(Number(width)))
  const h = Math.max(1, Math.round(Number(height)))
  const rowBytes = w * 3
  const stride = (rowBytes + 3) & ~3
  const dataSize = stride * h
  const buffer = Buffer.alloc(HEADER_SIZE + dataSize)

  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(HEADER_SIZE + dataSize, 2)
  buffer.writeUInt16LE(0, 6)
  buffer.writeUInt16LE(0, 8)
  buffer.writeUInt32LE(HEADER_SIZE, 10)

  buffer.writeUInt32LE(40, 14) // DIB header size
  buffer.writeInt32LE(w, 18)
  buffer.writeInt32LE(h, 22) // positive height = bottom-up
  buffer.writeUInt16LE(1, 26) // planes
  buffer.writeUInt16LE(24, 28) // bits per pixel
  buffer.writeUInt32LE(0, 30) // BI_RGB
  buffer.writeUInt32LE(dataSize, 34)
  buffer.writeInt32LE(2835, 38) // ~72 DPI
  buffer.writeInt32LE(2835, 42)
  buffer.writeUInt32LE(0, 46)
  buffer.writeUInt32LE(0, 50)

  for (let y = 0; y < h; y++) {
    const rowStart = HEADER_SIZE + (h - 1 - y) * stride
    for (let x = 0; x < w; x++) {
      const { r, g, b } = pixelAt(x, y, w, h)
      const offset = rowStart + x * 3
      buffer[offset] = b
      buffer[offset + 1] = g
      buffer[offset + 2] = r
    }
  }
  return buffer
}

export function writeBmp(filePath, options) {
  const buffer = bmpBuffer(options)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, buffer)
  return { path: filePath, byteSize: buffer.length, width: options.width, height: options.height }
}

export function isBmpFile(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= HEADER_SIZE) return false
    const fd = fs.openSync(filePath, 'r')
    try {
      const head = Buffer.alloc(2)
      fs.readSync(fd, head, 0, 2, 0)
      return head.toString('ascii') === 'BM'
    } finally {
      fs.closeSync(fd)
    }
  } catch (_) {
    return false
  }
}

export default { bmpBuffer, writeBmp, isBmpFile, HEADER_SIZE }
