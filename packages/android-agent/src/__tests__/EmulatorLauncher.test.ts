import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `launch` spawns and `findEmulatorPid` pgreps; both go through child_process, and both are
// **production code no test reached before** — the seam between `buildEmulatorArgs` and the process
// that receives its argv had nothing covering it, so dropping `opts` from the call inside `launch`
// left the whole suite green while killing `-wipe-data` (#447) and `-no-audio` (#341) together.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
  execFile: vi.fn(),
  // `probeEmulator` reads `status` and `error` off the result rather than catching a throw, which
  // is also what makes both of its outcomes reachable from a test — this runner reports an error
  // thrown inside `mockImplementation` as a failure even when production code swallows it.
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', error: undefined })),
}))

import { spawn, spawnSync } from 'child_process'
import { buildEmulatorArgs, EmulatorLauncher, findEmulatorPid, probeEmulator, stopEmulatorProcess } from '../EmulatorLauncher'

describe('buildEmulatorArgs', () => {
  it('includes -no-audio by default (audio off — video path unchanged)', () => {
    const args = buildEmulatorArgs('Pixel', 8554)
    expect(args).toContain('-no-audio')
    expect(args).toEqual(['-avd', 'Pixel', '-no-audio', '-no-snapshot', '-no-window', '-gpu', 'host', '-grpc', '8554'])
  })

  it('drops -no-audio when audio is enabled, leaving all other args intact', () => {
    const args = buildEmulatorArgs('Pixel', 8554, { audio: true })
    expect(args).not.toContain('-no-audio')
    expect(args).toEqual(['-avd', 'Pixel', '-no-snapshot', '-no-window', '-gpu', 'host', '-grpc', '8554'])
  })

  it('omits -grpc when no port given', () => {
    const args = buildEmulatorArgs('Pixel')
    expect(args).not.toContain('-grpc')
    expect(args).toContain('-no-audio')
  })

  it('explicit audio:false keeps -no-audio (parity with default)', () => {
    expect(buildEmulatorArgs('Pixel', 8554, { audio: false })).toContain('-no-audio')
  })

  // #447: the counterpart to iOS's `simctl erase`. `-no-snapshot` above is a **cold boot** — it skips
  // the snapshot and keeps `userdata`, so nothing here wiped anything before this flag.
  describe('wipeData', () => {
    it('adds -wipe-data, leaving every other arg where it was', () => {
      const args = buildEmulatorArgs('Pixel', 8554, { wipeData: true })
      expect(args).toEqual(
        ['-avd', 'Pixel', '-no-audio', '-no-snapshot', '-no-window', '-gpu', 'host', '-wipe-data', '-grpc', '8554'],
      )
    })

    it('is absent by default, so an ordinary boot keeps userdata', () => {
      expect(buildEmulatorArgs('Pixel', 8554)).not.toContain('-wipe-data')
      expect(buildEmulatorArgs('Pixel', 8554, { wipeData: false })).not.toContain('-wipe-data')
    })

    // The two options are independent knobs and a session can arm both — asserted because the
    // obvious implementation (one `if/else` over `opts`) passes each of the tests above alone.
    it('composes with audio rather than replacing it', () => {
      const args = buildEmulatorArgs('Pixel', 8554, { wipeData: true, audio: true })
      expect(args).toContain('-wipe-data')
      expect(args).not.toContain('-no-audio')
    })
  })
})

describe('EmulatorLauncher.launch', () => {
  beforeEach(() => vi.mocked(spawn).mockClear())

  /** The argv the emulator process is actually given. */
  function argvOf(): string[] {
    return vi.mocked(spawn).mock.calls[0]?.[1] as string[]
  }

  it('hands buildEmulatorArgs output to the spawned process, options included', () => {
    new EmulatorLauncher().launch('Pixel', 8554, { wipeData: true })
    expect(argvOf()).toEqual(buildEmulatorArgs('Pixel', 8554, { wipeData: true }))
    expect(argvOf()).toContain('-wipe-data')
  })

  // Named separately from the case above because they fail to different mutations: dropping `opts`
  // from the `buildEmulatorArgs` call inside `launch` kills both flags at once, and each of these
  // is the only assertion in the package that would say so for its own flag.
  it('still gates audio through the same call', () => {
    new EmulatorLauncher().launch('Pixel', 8554)
    expect(argvOf()).toContain('-no-audio')
    vi.mocked(spawn).mockClear()
    new EmulatorLauncher().launch('Pixel', 8554, { audio: true })
    expect(argvOf()).not.toContain('-no-audio')
  })
})

describe('waitForExit', () => {
  beforeEach(() => vi.mocked(spawnSync).mockReset())
  afterEach(() => vi.useRealTimers())

  /** `findEmulatorPid` parses `pgrep` stdout; no match parses to NaN, which it reports as null.
   *  (`pgrep` also exits 1 on no match — that path is the function's own `catch`, covered by the
   *  `findEmulatorPid` describe below rather than by re-throwing through every wait test.) */
  const NONE = ''
  const pgrepReturns = (...results: string[]) => {
    let i = 0
    vi.mocked(spawnSync).mockImplementation(() => {
      const out = results[Math.min(i++, results.length - 1)]!
      return { status: out ? 0 : 1, stdout: out, error: undefined } as never
    })
  }

  it('returns as soon as no process holds the AVD', async () => {
    pgrepReturns(NONE)
    await expect(new EmulatorLauncher().waitForExit('Pixel', 1_000)).resolves.toBeUndefined()
  })

  // The direction matters more than the wait: inverted, this returns while the emulator is alive
  // and hands the relaunch the lock race it exists to prevent.
  it('keeps waiting while a process is still there, then returns when it goes', async () => {
    pgrepReturns('4321\n', '4321\n', NONE)
    await expect(new EmulatorLauncher().waitForExit('Pixel', 5_000)).resolves.toBeUndefined()
    expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  // A probe that cannot look is not a confirmed exit. Returning here would let the caller launch
  // against a lock that may still be held, and nothing downstream tells that from a real wipe.
  it('throws when the process lookup itself is unavailable', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: null, stdout: '', error: new Error('ENOENT') } as never)
    await expect(new EmulatorLauncher().waitForExit('Pixel', 5_000))
      .rejects.toThrow(/process lookup unavailable/)
  })

  // Throwing is the whole contract. Returning here would let the caller launch a second emulator
  // on a locked AVD, and nothing downstream can tell that apart from a successful wipe — `launch`
  // reads no exit code and `findSerial` would return the survivor's serial.
  it('throws when the emulator outlives the deadline, naming the AVD', async () => {
    pgrepReturns('4321\n')
    await expect(new EmulatorLauncher().waitForExit('Pixel', 300))
      .rejects.toThrow(/Pixel/)
  })
})

describe('stopEmulatorProcess', () => {
  beforeEach(() => vi.mocked(spawnSync).mockReset())

  it('signals the pid it found', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '4321\n', error: undefined } as never)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(stopEmulatorProcess('Pixel')).toBe(true)
    expect(kill).toHaveBeenCalledWith(4321, 'SIGTERM')
    kill.mockRestore()
  })

  it('reports false when nothing is running, without signalling', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', error: undefined } as never)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(stopEmulatorProcess('Pixel')).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })

  // A pid that died between the lookup and the signal is not a failure to stop it.
  it('reports false rather than throwing when the signal is refused', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '4321\n', error: undefined } as never)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH') })
    expect(stopEmulatorProcess('Pixel')).toBe(false)
    kill.mockRestore()
  })
})

describe('probeEmulator', () => {
  beforeEach(() => vi.mocked(spawnSync).mockReset())

  it('reads pgrep exit 1 as "gone", because that is pgrep saying it looked', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', error: undefined } as never)
    expect(probeEmulator('Pixel')).toEqual({ state: 'gone' })
  })

  it('reads a failure to run pgrep as "unknown", not as "gone"', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: null, stdout: '', error: new Error('ENOENT') } as never)
    expect(probeEmulator('Pixel')).toEqual({ state: 'unknown' })
  })

  // pgrep exits 2 on a syntax error and 3 on a fatal one. Neither means it looked and found
  // nothing, and reading them that way lets a wipe relaunch past a live emulator.
  it('reads any other non-zero status as "unknown", not as "gone"', () => {
    for (const status of [2, 3]) {
      vi.mocked(spawnSync).mockReturnValue({ status, stdout: '', error: undefined } as never)
      expect(probeEmulator('Pixel')).toEqual({ state: 'unknown' })
    }
  })

  // Exit 0 means pgrep matched something, so output it cannot parse is "cannot tell".
  it('reads a match it cannot parse as "unknown"', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: 'not-a-pid\n', error: undefined } as never)
    expect(probeEmulator('Pixel')).toEqual({ state: 'unknown' })
  })

  // `process.kill(0, …)` signals the caller's own process group, so a zero here is not a pid we
  // may act on — `Number.isFinite` alone would have let it through.
  it('refuses a non-positive pid rather than reporting it as running', () => {
    for (const stdout of ['0\n', '-1\n']) {
      vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout, error: undefined } as never)
      expect(probeEmulator('Pixel')).toEqual({ state: 'unknown' })
    }
  })

  // Verified against a real `pgrep -f`: the unbounded pattern matched a running `-avd Pixel_8`
  // when asked about `Pixel`, which for the audio tap muted the wrong emulator and here would
  // SIGTERM it.
  it('matches the whole -avd argument, so one AVD name cannot be a prefix of another', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', error: undefined } as never)
    probeEmulator('Pixel')
    const pattern = (vi.mocked(spawnSync).mock.calls[0]?.[1] as string[])[1]!
    expect(pattern).toContain('[[:space:]]-avd[[:space:]]Pixel([[:space:]]|$)')
  })

  it('reports the pid it found', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '4321\n', error: undefined } as never)
    expect(probeEmulator('Pixel')).toEqual({ state: 'running', pid: 4321 })
  })
})

describe('findEmulatorPid', () => {
  beforeEach(() => vi.mocked(spawnSync).mockReset())

  // Both non-running probe states collapse to `null` here on purpose — the audio tap's worst case
  // is that it does not mute. The `probeEmulator` describe above is where they are told apart, and
  // `waitForExit` is the caller for which the difference is a wiped device or a lie about one.
  it('answers null whether the emulator is gone or the lookup was unavailable', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', error: undefined } as never)
    expect(findEmulatorPid('Pixel')).toBeNull()
    vi.mocked(spawnSync).mockReturnValue({ status: null, stdout: '', error: new Error('ENOENT') } as never)
    expect(findEmulatorPid('Pixel')).toBeNull()
  })

  it('escapes regex metacharacters in the AVD name', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '1\n', error: undefined } as never)
    findEmulatorPid('Pixel.7')
    const pattern = (vi.mocked(spawnSync).mock.calls[0]?.[1] as string[])[1]
    expect(pattern).toContain('Pixel\\.7')
  })
})
