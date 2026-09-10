import fs from 'fs'
import path from 'path'

// gitignore된 <dataDir>/.env 에서 자격 증명(JWT_SECRET·SMTP·DNS/ACME 토큰 등)을 로드한다.
// config.load()가 secret을 읽기 전에 호출되어 .env가 모든 비밀의 기본 경로가 된다(#287에서 시작).
// process.loadEnvFile 은 기존 process.env 값을 안 덮으므로 ambient(셸) 가 항상 우선.
export function loadDataDirEnv(dataDir: string, warn: (m: string) => void = (m) => console.warn(m)): string | null {
  const envPath = path.join(dataDir, '.env')
  if (!fs.existsSync(envPath)) return null
  try {
    // **Everything else that writes a secret into dataDir sets 0600 and this file trusted its
    // caller.** `config.ts` writes `jwt-secret` with `{ mode: 0o600 }` and chmods it; `tapflow init`
    // does the same for this file. The relay-only image has no CLI, so a container operator writes
    // it by hand under their own umask — 0644 — and the admin bootstrap now tells them to put a
    // plaintext password in it. Warn rather than refuse: an unreadable-by-others file is the goal,
    // but a relay that will not start because of a permission bit helps nobody.
    const mode = fs.statSync(envPath).mode & 0o777
    if (mode & 0o077) {
      warn(`${envPath} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 ${envPath}`)
    }
    process.loadEnvFile(envPath)
    return envPath
  } catch {
    // 손상된 파일은 무시 — 자격 증명이 없으면 cert 발급 시점에 명확히 실패한다.
    return null
  }
}
