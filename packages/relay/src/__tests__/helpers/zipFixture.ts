import fs from 'fs'
import path from 'path'

export type ZipFixtureEntry = {
  name: string
  data?: Buffer | string
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function entryData(entry: ZipFixtureEntry): Buffer {
  if (entry.data === undefined) return Buffer.alloc(0)
  return Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
}

// Keep this writer in-process: the repo has no ZIP library, and fixtures must not
// depend on a system zip executable.
function makeZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  const utf8Flag = 0x800
  const dosDate = 33 // 1980-01-01
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entryData(entry)
    const checksum = crc32(data)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(utf8Flag, 6)
    localHeader.writeUInt16LE(0, 8) // stored, not compressed
    localHeader.writeUInt16LE(0, 10) // 00:00
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(utf8Flag, 8)
    centralHeader.writeUInt16LE(0, 10) // stored, not compressed
    centralHeader.writeUInt16LE(0, 12) // 00:00
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(entry.name.endsWith('/') ? 0x10 : 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, name)

    offset += localHeader.length + name.length + data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const endOfCentralDirectory = Buffer.alloc(22)
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0)
  endOfCentralDirectory.writeUInt16LE(0, 4)
  endOfCentralDirectory.writeUInt16LE(0, 6)
  endOfCentralDirectory.writeUInt16LE(entries.length, 8)
  endOfCentralDirectory.writeUInt16LE(entries.length, 10)
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12)
  endOfCentralDirectory.writeUInt32LE(offset, 16)
  endOfCentralDirectory.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory])
}

export function writeZipFixture(zipPath: string, entries: readonly ZipFixtureEntry[]): string {
  fs.writeFileSync(zipPath, makeZip(entries))
  return zipPath
}

export function makeAppZip(tmpDir: string, appName: string, plistXml: string): string {
  const zipPath = path.join(tmpDir, `${appName}.app.zip`)
  return writeZipFixture(zipPath, [
    // This explicit, apparently empty directory entry is load-bearing: production
    // findAppDirInZip relies on unzip -l output containing a line ending in .app/.
    { name: `${appName}.app/` },
    { name: `${appName}.app/Info.plist`, data: plistXml },
    { name: `${appName}.app/${appName}`, data: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) },
  ])
}
