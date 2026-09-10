import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// Deliberately NOT at the repo root. A config file there is inherited by every package that has
// none of its own — all of them do — and they then run with this `include` and find no tests.
// Invoked explicitly: `pnpm test:scripts`.
//
// `root` is resolved from this file, not from the cwd: vitest resolves a relative `root` against
// the working directory, so '..' pointed one level above the repo.
export default defineConfig({
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  test: {
    include: ['scripts/__tests__/**/*.test.mjs'],
  },
})
