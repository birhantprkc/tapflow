import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}))
vi.mock('@tapflowio/ios-agent', () => ({
  isAudioSupported: vi.fn(() => true),
  requestAudioPermission: vi.fn(),
}))

import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { confirm, text } from '@clack/prompts'
import { runSetupAndroid, runSetupIos } from '../../lib/setup.js'

const mockExecSync = vi.mocked(execSync)
const mockExecFileSync = vi.mocked(execFileSync)
const NET_FILTER_VERSION = '1787675754'
/** What `systemextensionsctl list` prints for an extension macOS is actually running. */
const activatedListing = (version: string) =>
  `1 extension(s)\n--- com.apple.system_extension.network_extension\nenabled\tactive\tteamID\tbundleID (version)\tname\t[state]\n*\t*\t6FBS3QP893\tdev.tapflow.netfilter.ext (1.0/${version})\tdev.tapflow.netfilter.ext\t[activated enabled]\n`
const mockSpawnSync = vi.mocked(spawnSync)
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)
const mockReaddirSync = vi.mocked(readdirSync)
const mockAppendFileSync = vi.mocked(appendFileSync)
const mockConfirm = vi.mocked(confirm)
const mockText = vi.mocked(text)
const XCODE_APP = '/Applications/Xcode.app'
/** Where the filter's provider pulses. Its freshness is the only thing that separates an installed,
 *  approved, switched-ON filter from an installed, approved, switched-off one. */
const FILTER_STATE_FILE = '/Library/Application Support/tapflow/tapflow-netfilter-state.json'

const SDK_DIR = join(homedir(), 'Library', 'Android', 'sdk')
const SDK_SDKMANAGER = join(SDK_DIR, 'cmdline-tools', 'latest', 'bin', 'sdkmanager')
const SDK_AVDMANAGER = join(SDK_DIR, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
const SDK_ADB = join(SDK_DIR, 'platform-tools', 'adb')
const SDK_EMULATOR = join(SDK_DIR, 'emulator', 'emulator')
const SDK_BUILD_TOOLS_DIR = join(SDK_DIR, 'build-tools')
const SDK_AAPT = join(SDK_BUILD_TOOLS_DIR, '35.0.0', 'aapt')
const SDK_SYSTEM_IMAGE = join(
  SDK_DIR,
  'system-images',
  'android-35',
  'google_apis',
  process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64',
)
const zshrc = join(homedir(), '.zshrc')

const okSpawn = { status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null }

// Generic, so the caller keeps its own element type. Written as `{ label: string }[]` this widened
// every result to just that field, and the 36 `Property 'ok' does not exist` errors #422 found here
// were all one helper narrowing away the thing under test.
function findStep<T extends { label: string }>(results: T[], keyword: string): T | undefined {
  return results.find((r) => r.label.toLowerCase().includes(keyword.toLowerCase()))
}

function setTTY(value: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
}

describe('runSetupAndroid', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('SHELL', '/bin/zsh')
    mockReadFileSync.mockReturnValue('')
    mockConfirm.mockResolvedValue(true as never)
    // 기본: 완전히 구성된 머신 (brew·JDK·자기완결 SDK·AVD 모두 존재)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === '/usr/libexec/java_home') return '/Library/Java/.../Home\n'
      if (c === 'which sdkmanager') return '/opt/homebrew/bin/sdkmanager\n'
      return ''
    })
    mockExistsSync.mockImplementation(
      (p) => p === SDK_SDKMANAGER || p === SDK_ADB || p === SDK_AVDMANAGER || p === SDK_EMULATOR || p === SDK_SYSTEM_IMAGE || p === SDK_BUILD_TOOLS_DIR || p === SDK_AAPT,
    )
    mockReaddirSync.mockReturnValue(['35.0.0'] as never)
    mockSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === SDK_EMULATOR && Array.isArray(args) && args.includes('-list-avds')) {
        return { ...okSpawn, stdout: 'tapflow-phone\n' } as never
      }
      return okSpawn as never
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    setTTY(undefined)
  })

  it('Homebrew 없음 + 비대화형이면 confirm 없이 warn', async () => {
    setTTY(false)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') throw new Error('not found')
      if (c === '/usr/libexec/java_home') return '/x\n'
      if (c === 'which sdkmanager') return '/opt/homebrew/bin/sdkmanager\n'
      return ''
    })

    const results = await runSetupAndroid()
    expect(findStep(results, 'homebrew')?.ok).toBe(false)
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('JDK 없음 + TTY + 수락 시 temurin 설치 시도', async () => {
    setTTY(true)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === '/usr/libexec/java_home') throw new Error('no java')
      if (c === 'which sdkmanager') return '/opt/homebrew/bin/sdkmanager\n'
      return ''
    })

    await runSetupAndroid()
    expect(mockSpawnSync).toHaveBeenCalledWith('brew', ['install', '--cask', 'temurin'], expect.anything())
  })

  it('JDK 없음 + 비대화형이면 warn (설치 안 함)', async () => {
    setTTY(false)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === '/usr/libexec/java_home') throw new Error('no java')
      if (c === 'which sdkmanager') return '/opt/homebrew/bin/sdkmanager\n'
      return ''
    })

    const results = await runSetupAndroid()
    expect(findStep(results, 'java')?.warn).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith('brew', ['install', '--cask', 'temurin'], expect.anything())
  })

  it('자기완결 SDK가 있으면 ok + ANDROID_HOME 등록 (설치 안 함)', async () => {
    const results = await runSetupAndroid()
    expect(findStep(results, 'android sdk')?.ok).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      'brew',
      ['install', '--cask', 'android-commandlinetools'],
      expect.anything(),
    )
    expect(mockAppendFileSync).toHaveBeenCalledWith(zshrc, expect.stringContaining('ANDROID_HOME'))
  })

  it('SDK 자기완결 아니면 sdkmanager로 자기완결 부트스트랩(cmdline-tools;latest 포함)', async () => {
    setTTY(true)
    let installed = false
    mockExistsSync.mockImplementation((p) => {
      if (p === SDK_SDKMANAGER || p === SDK_ADB || p === SDK_SYSTEM_IMAGE || p === SDK_BUILD_TOOLS_DIR || p === SDK_AAPT) return installed
      if (p === SDK_AVDMANAGER || p === SDK_EMULATOR) return true
      return false
    })
    mockSpawnSync.mockImplementation((cmd, args) => {
      const a = Array.isArray(args) ? args : []
      if (typeof cmd === 'string' && cmd.includes('sdkmanager') && a.includes('cmdline-tools;latest')) {
        installed = true
        return okSpawn as never
      }
      if (cmd === SDK_EMULATOR && a.includes('-list-avds')) {
        return { ...okSpawn, stdout: 'tapflow-phone\n' } as never
      }
      return okSpawn as never
    })

    const results = await runSetupAndroid()
    expect(mockSpawnSync).toHaveBeenCalledWith(
      '/opt/homebrew/bin/sdkmanager',
      expect.arrayContaining([`--sdk_root=${SDK_DIR}`, 'cmdline-tools;latest', 'platform-tools', 'emulator', 'build-tools;35.0.0']),
      expect.anything(),
    )
    expect(findStep(results, 'android sdk')?.ok).toBe(true)
  })

  it('SDK 자기완결 아님 + 비대화형이면 warn', async () => {
    setTTY(false)
    mockExistsSync.mockImplementation((p) => p === SDK_EMULATOR)

    const results = await runSetupAndroid()
    expect(findStep(results, 'android sdk')?.warn).toBe(true)
  })

  it('partial SDK without emulator/system image is repaired instead of reported as found', async () => {
    setTTY(true)
    mockReadFileSync.mockReturnValue(
      '# >>> tapflow android sdk >>>\nexport ANDROID_HOME="x"\n# <<< tapflow android sdk <<<\n',
    )
    let installed = false
    mockExistsSync.mockImplementation((p) => {
      if (p === SDK_SDKMANAGER || p === SDK_ADB || p === SDK_AVDMANAGER || p === zshrc) return true
      if (p === SDK_EMULATOR || p === SDK_SYSTEM_IMAGE || p === SDK_BUILD_TOOLS_DIR || p === SDK_AAPT) return installed
      return false
    })
    const expectedSystemImage =
      process.arch === 'arm64'
        ? 'system-images;android-35;google_apis;arm64-v8a'
        : 'system-images;android-35;google_apis;x86_64'

    mockSpawnSync.mockImplementation((cmd, args) => {
      const a = Array.isArray(args) ? args : []
      if (
        typeof cmd === 'string' &&
        cmd.includes('sdkmanager') &&
        a.includes('cmdline-tools;latest') &&
        a.includes(expectedSystemImage)
      ) {
        installed = true
        return okSpawn as never
      }
      if (cmd === SDK_EMULATOR && a.includes('-list-avds')) {
        return { ...okSpawn, stdout: 'tapflow-phone\n' } as never
      }
      return okSpawn as never
    })

    const results = await runSetupAndroid()

    expect(mockSpawnSync).toHaveBeenCalledWith(
      SDK_SDKMANAGER,
      expect.arrayContaining([
        `--sdk_root=${SDK_DIR}`,
        'cmdline-tools;latest',
        'platform-tools',
        'emulator',
        'build-tools;35.0.0',
        expectedSystemImage,
      ]),
      expect.anything(),
    )
    expect(findStep(results, 'android sdk')?.label).toBe('Android SDK installed')
    expect(findStep(results, 'android sdk')?.state).toBe('created')
  })

  it('build-tools(aapt)만 없는 SDK는 자기완결로 보지 않고 복구한다', async () => {
    setTTY(true)
    let installed = false
    mockExistsSync.mockImplementation((p) => {
      if (p === SDK_SDKMANAGER || p === SDK_ADB || p === SDK_AVDMANAGER || p === SDK_EMULATOR || p === SDK_SYSTEM_IMAGE) return true
      if (p === SDK_BUILD_TOOLS_DIR || p === SDK_AAPT) return installed
      return false
    })
    mockSpawnSync.mockImplementation((cmd, args) => {
      const a = Array.isArray(args) ? args : []
      if (typeof cmd === 'string' && cmd.includes('sdkmanager') && a.includes('build-tools;35.0.0')) {
        installed = true
        return okSpawn as never
      }
      if (cmd === SDK_EMULATOR && a.includes('-list-avds')) {
        return { ...okSpawn, stdout: 'tapflow-phone\n' } as never
      }
      return okSpawn as never
    })

    const results = await runSetupAndroid()
    expect(mockSpawnSync).toHaveBeenCalledWith(
      expect.stringContaining('sdkmanager'),
      expect.arrayContaining(['build-tools;35.0.0']),
      expect.anything(),
    )
    expect(findStep(results, 'android sdk')?.ok).toBe(true)
    expect(findStep(results, 'android sdk')?.state).toBe('created')
  })

  it('build-tools가 35.0.0이 아닌 34.0.0만 있어도 자기완결로 인정한다 (버전 고정 판정 아님 → 재설치 없음)', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (p === SDK_SDKMANAGER || p === SDK_ADB || p === SDK_AVDMANAGER || p === SDK_EMULATOR || p === SDK_SYSTEM_IMAGE || p === SDK_BUILD_TOOLS_DIR) return true
      if (p === join(SDK_DIR, 'build-tools', '34.0.0', 'aapt')) return true
      return false // no 35.0.0/aapt
    })
    mockReaddirSync.mockReturnValue(['34.0.0'] as never)

    const results = await runSetupAndroid()
    expect(findStep(results, 'android sdk')?.ok).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      expect.stringContaining('sdkmanager'),
      expect.arrayContaining(['build-tools;35.0.0']),
      expect.anything(),
    )
  })

  it('AVD가 있으면 ok (생성 안 함)', async () => {
    const results = await runSetupAndroid()
    expect(findStep(results, 'avd')?.ok).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      SDK_AVDMANAGER,
      expect.arrayContaining(['create']),
      expect.anything(),
    )
  })

  it('AVD 없음 + TTY + 수락 시 폼팩터별 AVD 4개 생성', async () => {
    setTTY(true)
    mockSpawnSync.mockImplementation((cmd, args) => {
      const a = Array.isArray(args) ? args : []
      if (cmd === SDK_EMULATOR && a.includes('-list-avds')) {
        return { ...okSpawn, stdout: '' } as never
      }
      if (cmd === SDK_AVDMANAGER && a.includes('device')) {
        return {
          ...okSpawn,
          stdout: 'id: 0 or "pixel_5"\nid: 1 or "pixel_7"\nid: 2 or "pixel_7_pro"\nid: 3 or "pixel_c"\n',
        } as never
      }
      return okSpawn as never
    })

    const results = await runSetupAndroid()
    const createCalls = mockSpawnSync.mock.calls.filter(
      (c) => c[0] === SDK_AVDMANAGER && Array.isArray(c[1]) && c[1].includes('create'),
    )
    expect(createCalls).toHaveLength(4)
    expect(findStep(results, 'avd')?.ok).toBe(true)
  })

  it('AVD 없음 + 비대화형이면 warn (생성 안 함)', async () => {
    setTTY(false)
    mockSpawnSync.mockImplementation((cmd, args) => {
      const a = Array.isArray(args) ? args : []
      if (cmd === SDK_EMULATOR && a.includes('-list-avds')) return { ...okSpawn, stdout: '' } as never
      return okSpawn as never
    })

    const results = await runSetupAndroid()
    expect(findStep(results, 'avd')?.warn).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      SDK_AVDMANAGER,
      expect.arrayContaining(['create']),
      expect.anything(),
    )
  })

  it('미지원 셸이면 ANDROID_HOME 자동 등록 안 함 (SDK는 ready)', async () => {
    vi.stubEnv('SHELL', '/usr/bin/fish')

    const results = await runSetupAndroid()
    expect(findStep(results, 'android sdk')?.ok).toBe(true)
    expect(mockAppendFileSync).not.toHaveBeenCalled()
  })

  it('멱등 — 완전 구성 + env 등록됨이면 전부 ok, 설치/생성/append 없음', async () => {
    mockReadFileSync.mockReturnValue(
      '# >>> tapflow android sdk >>>\nexport ANDROID_HOME="x"\n# <<< tapflow android sdk <<<\n',
    )
    mockExistsSync.mockImplementation(
      (p) =>
        p === SDK_SDKMANAGER ||
        p === SDK_ADB ||
        p === SDK_AVDMANAGER ||
        p === SDK_EMULATOR ||
        p === SDK_SYSTEM_IMAGE ||
        p === SDK_BUILD_TOOLS_DIR ||
        p === SDK_AAPT ||
        p === zshrc,
    )

    const results = await runSetupAndroid()
    expect(results.every((r) => r.ok)).toBe(true)
    expect(mockAppendFileSync).not.toHaveBeenCalled()
    expect(mockSpawnSync).not.toHaveBeenCalledWith('brew', expect.anything(), expect.anything())
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      SDK_AVDMANAGER,
      expect.arrayContaining(['create']),
      expect.anything(),
    )
  })

  it('shows a new-shell hint when the rc block exists but adb is not in the live PATH', async () => {
    mockReadFileSync.mockReturnValue(
      '# >>> tapflow android sdk >>>\nexport ANDROID_HOME="x"\n# <<< tapflow android sdk <<<\n',
    )
    mockExistsSync.mockImplementation(
      (p) =>
        p === SDK_SDKMANAGER ||
        p === SDK_ADB ||
        p === SDK_AVDMANAGER ||
        p === SDK_EMULATOR ||
        p === SDK_SYSTEM_IMAGE ||
        p === SDK_BUILD_TOOLS_DIR ||
        p === SDK_AAPT ||
        p === zshrc,
    )
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === '/usr/libexec/java_home') return '/Library/Java/.../Home\n'
      if (c === 'which sdkmanager') return '/opt/homebrew/bin/sdkmanager\n'
      if (c === 'which adb') throw new Error('not found')
      return ''
    })

    const results = await runSetupAndroid()
    const sdk = findStep(results, 'android sdk')
    expect(sdk?.ok).toBe(true)
    expect(sdk?.state).toBe('found')
    expect(sdk?.detail).toContain('open a new terminal')
    expect(mockAppendFileSync).not.toHaveBeenCalled()
  })

  // issue #326: state로 "이미 있었음(found)"과 "이번에 설치함(created)"을 구분한다.
  it("state: 완전 구성 머신은 모든 단계가 'found'", async () => {
    // 완전 구성 = env(rc 마커)까지 이미 등록된 상태. 그래야 registerAndroidEnv가
    // append 없이 added:false를 반환하고 SDK 단계가 'found'로 보고된다.
    mockReadFileSync.mockReturnValue(
      '# >>> tapflow android sdk >>>\nexport ANDROID_HOME="x"\n# <<< tapflow android sdk <<<\n',
    )
    mockExistsSync.mockImplementation(
      (p) =>
        p === SDK_SDKMANAGER ||
        p === SDK_ADB ||
        p === SDK_AVDMANAGER ||
        p === SDK_EMULATOR ||
        p === SDK_SYSTEM_IMAGE ||
        p === SDK_BUILD_TOOLS_DIR ||
        p === SDK_AAPT ||
        p === zshrc,
    )

    const results = await runSetupAndroid()
    expect(results.every((r) => r.ok)).toBe(true)
    expect(findStep(results, 'homebrew')?.state).toBe('found')
    expect(findStep(results, 'java')?.state).toBe('found')
    expect(findStep(results, 'android sdk')?.state).toBe('found')
    expect(findStep(results, 'avd')?.state).toBe('found')
  })

  // issue #326: SDK 바이너리는 있지만 이번 실행에 env(rc)를 새로 등록하면 'repaired'.
  it("state: SDK는 있고 env를 이번에 등록하면 'repaired'", async () => {
    // 기본 mock은 rc가 비어 있어(readFileSync→'') registerAndroidEnv가 append하고 added:true.
    const results = await runSetupAndroid()
    expect(findStep(results, 'android sdk')?.ok).toBe(true)
    expect(findStep(results, 'android sdk')?.state).toBe('repaired')
    expect(mockAppendFileSync).toHaveBeenCalledWith(zshrc, expect.stringContaining('ANDROID_HOME'))
  })

  it("state: 이번 실행에 SDK를 부트스트랩하면 'created'", async () => {
    setTTY(true)
    let installed = false
    mockExistsSync.mockImplementation((p) => {
      if (p === SDK_SDKMANAGER || p === SDK_ADB || p === SDK_SYSTEM_IMAGE || p === SDK_BUILD_TOOLS_DIR || p === SDK_AAPT) return installed
      if (p === SDK_AVDMANAGER || p === SDK_EMULATOR) return true
      return false
    })
    mockSpawnSync.mockImplementation((cmd, args) => {
      const a = Array.isArray(args) ? args : []
      if (typeof cmd === 'string' && cmd.includes('sdkmanager') && a.includes('cmdline-tools;latest')) {
        installed = true
        return okSpawn as never
      }
      if (cmd === SDK_EMULATOR && a.includes('-list-avds')) {
        return { ...okSpawn, stdout: 'tapflow-phone\n' } as never
      }
      return okSpawn as never
    })

    const results = await runSetupAndroid()
    expect(findStep(results, 'android sdk')?.state).toBe('created')
  })

  it("state: 이번 실행에 AVD를 생성하면 'created'", async () => {
    setTTY(true)
    mockSpawnSync.mockImplementation((cmd, args) => {
      const a = Array.isArray(args) ? args : []
      if (cmd === SDK_EMULATOR && a.includes('-list-avds')) {
        return { ...okSpawn, stdout: '' } as never
      }
      if (cmd === SDK_AVDMANAGER && a.includes('device')) {
        return {
          ...okSpawn,
          stdout: 'id: 0 or "pixel_5"\nid: 1 or "pixel_7"\nid: 2 or "pixel_7_pro"\nid: 3 or "pixel_c"\n',
        } as never
      }
      return okSpawn as never
    })

    const results = await runSetupAndroid()
    expect(findStep(results, 'avd')?.state).toBe('created')
  })
})

describe('runSetupIos', () => {
  const simctlBooted = JSON.stringify({
    devices: { 'iOS-18': [{ udid: 'AAA', name: 'iPhone 16 Pro', state: 'Booted' }] },
  })
  const simctlShutdown = JSON.stringify({
    devices: { 'iOS-18': [{ udid: 'BBB', name: 'iPhone 15', state: 'Shutdown' }] },
  })
  const simctlEmpty = JSON.stringify({ devices: {} })

  beforeEach(() => {
    vi.resetAllMocks()
    mockSpawnSync.mockReturnValue(okSpawn as never)
    mockConfirm.mockResolvedValue(true as never)
    mockText.mockResolvedValue('' as never)
    // 기본: 완전히 구성된 macOS (brew·Xcode·활성화·Booted 시뮬·넷필터 설치·활성·가동 중)
    //
    // 넷필터는 경로 모양으로 매칭한다 — 패키지 안 앱의 절대 경로는 node가 패키지를 어디서 찾느냐에
    // 달려 있어 테스트가 하드코딩할 값이 아니다.
    //
    // **가동 중까지가 "완전 구성"이다.** 버전 세 개가 맞아도 필터는 꺼져 있을 수 있고, 그 상태는
    // `systemextensionsctl`에 그대로 `[activated enabled]`로 남는다. heartbeat 파일이 그 차이를
    // 말하는 유일한 자리라서, 이 픽스처가 그것을 빠뜨리면 "완전 구성"이 아니다.
    mockExistsSync.mockImplementation((p) =>
      p === XCODE_APP || String(p).includes('TapflowNetFilter.app') || p === FILTER_STATE_FILE)
    mockReadFileSync.mockImplementation((p) => (p === FILTER_STATE_FILE
      ? JSON.stringify({ at: Math.floor(Date.now() / 1000), pulseSeconds: 5 }) as never
      : '' as never))
    // `defaults read …/Info.plist` 와 `systemextensionsctl list`. 둘 다 읽기이므로 exec 계열이고,
    // 그래서 아래 "부작용 없음"(spawnSync 미호출) 단언이 넷필터 때문에 깨지지 않는다.
    mockExecFileSync.mockImplementation((cmd) => {
      if (String(cmd).endsWith('/defaults')) return `${NET_FILTER_VERSION}\n` as never
      if (String(cmd).endsWith('/systemextensionsctl')) return activatedListing(NET_FILTER_VERSION) as never
      return '' as never
    })
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlBooted
      return ''
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    setTTY(undefined)
  })

  it('Xcode 설치돼 있으면 ok', async () => {
    const results = await runSetupIos()
    expect(findStep(results, 'xcode')?.ok).toBe(true)
  })

  it('Xcode 미설치 + 비대화형이면 warn + App Store 링크', async () => {
    setTTY(false)
    mockExistsSync.mockReturnValue(false)

    const results = await runSetupIos()
    const xcode = findStep(results, 'xcode')
    expect(xcode?.warn).toBe(true)
    expect(xcode?.detail).toContain('apps.apple.com')
    expect(mockText).not.toHaveBeenCalled()
  })

  it('Xcode 미설치 + TTY → App Store 열고 재확인 후 설치되면 ok', async () => {
    setTTY(true)
    // 처음엔 미설치, 두 번째 호출(재확인)부터 설치됨
    let calls = 0
    mockExistsSync.mockImplementation((p) => {
      if (p === XCODE_APP) return calls++ > 0
      return false
    })

    const results = await runSetupIos()
    expect(mockText).toHaveBeenCalled()
    expect(mockSpawnSync).toHaveBeenCalledWith('open', [expect.stringContaining('apps.apple.com')], expect.anything())
    expect(findStep(results, 'xcode')?.ok).toBe(true)
  })

  it('active dir이 CommandLineTools면 활성화 단계 warn + xcode-select 안내', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Library/Developer/CommandLineTools\n'
      if (c.includes('simctl list devices')) return simctlBooted
      return ''
    })

    const results = await runSetupIos()
    const act = results.find((r) => r.detail?.includes('xcode-select -s'))
    expect(act?.warn).toBe(true)
  })

  it('디바이스가 있으면 부팅하지 않고 ready', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlShutdown // 미부팅 디바이스 존재
      return ''
    })

    const results = await runSetupIos()
    expect(findStep(results, 'simulator')?.ok).toBe(true)
    expect(mockSpawnSync).not.toHaveBeenCalledWith('xcrun', expect.anything(), expect.anything())
  })

  it('사용 가능한 시뮬레이터가 없으면 비대화형에서 warn', async () => {
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlEmpty
      return ''
    })

    const results = await runSetupIos()
    expect(findStep(results, 'simulator')?.warn).toBe(true)
  })

  it('active dir이 CommandLineTools + TTY + 수락 시 sudo xcode-select 직접 실행', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Library/Developer/CommandLineTools\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlBooted
      return ''
    })

    const results = await runSetupIos()
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sudo',
      ['xcode-select', '-s', '/Applications/Xcode.app/Contents/Developer'],
      expect.anything(),
    )
    expect(findStep(results, 'xcode ready')?.ok).toBe(true)
  })

  it('시뮬 디바이스 없음 + TTY + 수락 시 xcodebuild -downloadPlatform 실행', async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true as never)
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlEmpty
      return ''
    })

    await runSetupIos()
    expect(mockSpawnSync).toHaveBeenCalledWith('xcodebuild', ['-downloadPlatform', 'iOS'], expect.anything())
  })

  it('멱등 — 완전 구성 머신은 전부 ok, 부작용 없음', async () => {
    const results = await runSetupIos()
    expect(results.filter((r) => !r.ok).map((r) => [r.label, r.detail])).toEqual([])
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('필터가 꺼져 있으면 버전이 다 맞아도 found로 넘기지 않는다', async () => {
    // 이 단계는 설치 루틴을 부르기 전에 자기 판정으로 빠져나간다. 그 판정이 버전만 보던 동안,
    // disable 다음 install 전에 끊긴 맥은 여기서 영구히 found였다 — 그 맥을 고칠 유일한 실행이
    // 아무것도 안 하기로 결정하는 자리였다.
    setTTY(false)
    mockExistsSync.mockImplementation((p) =>
      p === XCODE_APP || String(p).includes('TapflowNetFilter.app'))
    const results = await runSetupIos()
    const step = results.find((r) => r.label === 'Network filter')
    expect(step?.state, '꺼진 필터를 found로 보고했다').not.toBe('found')
  })

  // issue #326: iOS 단계도 found / created / repaired를 구분한다.
  it("state: 완전 구성 macOS는 'found' (xcode/simulator)", async () => {
    const results = await runSetupIos()
    expect(findStep(results, 'xcode installed')?.state).toBe('found')
    expect(findStep(results, 'simulator')?.state).toBe('found')
  })

  it("state: 시뮬 런타임을 이번에 설치하면 'created'", async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true as never)
    let hasDevice = false
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return hasDevice ? simctlBooted : simctlEmpty
      return ''
    })
    mockSpawnSync.mockImplementation((cmd, args) => {
      const a = Array.isArray(args) ? args : []
      if (cmd === 'xcodebuild' && a.includes('-downloadPlatform')) {
        hasDevice = true
        return okSpawn as never
      }
      return okSpawn as never
    })

    const results = await runSetupIos()
    expect(findStep(results, 'simulator')?.state).toBe('created')
  })

  it("state: 활성화를 sudo로 고치면 'repaired'", async () => {
    setTTY(true)
    mockConfirm.mockResolvedValue(true as never)
    // active dir이 CommandLineTools라 xcode-select -s로 고쳐야 하는 상태
    mockExecSync.mockImplementation((cmd) => {
      const c = cmd as string
      if (c === 'which brew') return '/opt/homebrew/bin/brew\n'
      if (c === 'xcode-select -p') return '/Library/Developer/CommandLineTools\n'
      if (c === 'xcodebuild -version') return 'Xcode 26.5\n'
      if (c.includes('simctl list devices')) return simctlBooted
      return ''
    })

    const results = await runSetupIos()
    const ready = findStep(results, 'xcode ready')
    expect(ready?.ok).toBe(true)
    expect(ready?.state).toBe('repaired')
  })
})
