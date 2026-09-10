/**
 * Just enough Mach-O to answer one question: which symbols does this binary import?
 *
 * **Written because searching the file's bytes could not answer it.** The guard that needed this
 * first looked for the bytes `_rename` anywhere in the dylib and its header claimed that was
 * structural — that "no comment, string literal or renamed helper can produce it". A reviewer
 * disproved it in one compile: a dylib with zero `rename` imports, a `const char *note =
 * "atomic_rename"` and an ordinary `fopen(path, "w")` contains those bytes in `__cstring`. A local
 * helper called `tf_atomic_rename` does it too, since `_tf_atomic_rename` has `_rename` inside it.
 *
 * The undefined-symbol list is the thing the byte search was pretending to be: an entry there means
 * the linker recorded that this binary calls out to that name, which no literal can fake.
 *
 * Pure JS rather than `nm` on purpose — the CI that runs this is Linux and has no Mach-O tools.
 */

const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM_64 = 0xcffaedfe
const LC_SYMTAB = 0x2
const N_TYPE = 0x0e
const N_UNDF = 0x00

/**
 * Every name this binary leaves for the dynamic linker to resolve.
 *
 * @param {Buffer} buf a thin 64-bit Mach-O. Fat archives throw rather than guess which slice to read
 *   — this repo ships one arm64 slice, and silently picking the first one is how a guard starts
 *   reporting on a binary nobody asked about.
 */
export function undefinedSymbols(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = view.getUint32(0, true)
  if (magic !== MH_MAGIC_64 && magic !== MH_CIGAM_64) {
    throw new Error(`not a thin 64-bit Mach-O (magic 0x${magic.toString(16)})`)
  }
  const le = magic === MH_MAGIC_64
  const ncmds = view.getUint32(16, le)

  let off = 32
  for (let i = 0; i < ncmds; i++) {
    const cmd = view.getUint32(off, le)
    const cmdsize = view.getUint32(off + 4, le)
    if (cmdsize === 0) throw new Error('malformed load command')
    if (cmd === LC_SYMTAB) {
      const symoff = view.getUint32(off + 8, le)
      const nsyms = view.getUint32(off + 12, le)
      const stroff = view.getUint32(off + 16, le)
      const strsize = view.getUint32(off + 20, le)
      const names = []
      for (let s = 0; s < nsyms; s++) {
        const e = symoff + s * 16
        const strx = view.getUint32(e, le)
        const type = view.getUint8(e + 4)
        if ((type & N_TYPE) !== N_UNDF) continue
        if (strx === 0 || strx >= strsize) continue
        const start = stroff + strx
        let end = start
        while (end < stroff + strsize && buf[end] !== 0) end++
        names.push(buf.toString('utf8', start, end))
      }
      return names
    }
    off += cmdsize
  }
  throw new Error('no LC_SYMTAB in this Mach-O')
}
