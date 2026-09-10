import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The two primitives every committed-artifact guard in this repo needs.
 *
 * Extracted rather than copied because the two callers must agree: `netfilter-artifact.mjs` hashes a
 * signed `.app` its contributors cannot rebuild, `nethook-artifact.mjs` hashes a dylib they can, and
 * a second implementation of "walk in a stable order, hash path and bytes" is a way for one of them
 * to start hashing a different thing than it says it does.
 *
 * What is *not* shared is what each artifact is allowed to claim. The netfilter record can say
 * `CFBundleVersion`; the dylib has no such thing. Their failure messages differ for the same reason,
 * and that difference is the useful part of each guard rather than duplication to be factored out.
 */

/** Every file under `dir`, recursively, in a stable order. A missing directory yields nothing — the
 *  callers decide whether that is an error, because for them it is. */
export function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile()) out.push(p)
  }
  return out
}

/**
 * Path + bytes, in a stable order. Path is hashed too: moving a file changes the build.
 *
 * `normalize(relativePath, bytes)` is optional and exists for one shape: a file the build **writes
 * into on every run**. Hashing such a file raw asks "did this input change" by reading back what the
 * build itself last wrote, which is always true and makes any decision resting on it silently inert.
 * The caller decides what to blank, because only the caller knows which bytes are its own output.
 */
export function hashFiles(root, files, normalize) {
  const h = createHash('sha256')
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/')
    h.update(rel)
    h.update('\0')
    const bytes = fs.readFileSync(f)
    h.update(normalize ? normalize(rel, bytes) : bytes)
    h.update('\0')
  }
  return h.digest('hex')
}
