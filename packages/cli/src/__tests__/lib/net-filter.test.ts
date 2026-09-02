import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process')
vi.mock('node:fs')
vi.mock('node:net')
vi.mock('@clack/prompts', () => ({ confirm: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false) }))
// Off, so the audio step neither prompts nor fires a real macOS permission request from a test run.
vi.mock('@tapflowio/ios-agent', () => ({ isAudioSupported: vi.fn(() => false), requestAudioPermission: vi.fn() }))

import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { confirm } from '@clack/prompts'
import { join } from 'node:path'
import { installNetFilter, readNetFilterState, extensionBundle, NET_FILTER_APP } from '../../lib/net-filter.js'
import { runDoctorChecks } from '../../lib/doctor.js'
import { runSetupIos } from '../../lib/setup.js'

const mockExecFileSync = vi.mocked(execFileSync)
const mockSpawnSync = vi.mocked(spawnSync)
const mockExistsSync = vi.mocked(existsSync)
const mockChmodSync = vi.mocked(chmodSync)
const mockReaddirSync = vi.mocked(readdirSync)
const mockStatSync = vi.mocked(statSync)
const mockReadFileSync = vi.mocked(readFileSync)
const mockAccessSync = vi.mocked(accessSync)
const mockConfirm = vi.mocked(confirm)

/** `setup` gates every install on an interactive terminal; under vitest `isTTY` is neither. */
const filterPrompts = () =>
  mockConfirm.mock.calls.filter((c) => /network filter/i.test(String((c[0] as { message?: string })?.message ?? '')))

function setTTY(v: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true })
}

/** A bundle shaped like the real one: an executable under `Contents/MacOS`, and one more inside the
 *  nested system extension. */
function bundleOnDisk() {
  const tree: Record<string, string[]> = {
    [NET_FILTER_APP]: ['Contents'],
    [`${NET_FILTER_APP}/Contents`]: ['MacOS', 'Library', 'Info.plist'],
    [`${NET_FILTER_APP}/Contents/MacOS`]: ['TapflowNetFilter'],
    [`${NET_FILTER_APP}/Contents/Library`]: ['SystemExtensions'],
    [`${NET_FILTER_APP}/Contents/Library/SystemExtensions`]: ['dev.tapflow.netfilter.ext.systemextension'],
    [`${NET_FILTER_APP}/Contents/Library/SystemExtensions/dev.tapflow.netfilter.ext.systemextension`]: ['Contents'],
    [`${NET_FILTER_APP}/Contents/Library/SystemExtensions/dev.tapflow.netfilter.ext.systemextension/Contents`]: ['MacOS'],
    [`${NET_FILTER_APP}/Contents/Library/SystemExtensions/dev.tapflow.netfilter.ext.systemextension/Contents/MacOS`]: ['dev.tapflow.netfilter.ext'],
  }
  mockReaddirSync.mockImplementation((d) => (tree[String(d)] ?? []) as never)
  mockStatSync.mockImplementation((p) => ({ isDirectory: () => String(p) in tree }) as never)
}
const mockCreateServer = vi.mocked(createServer)

/** `runDoctorChecks` also probes port 4000; that is not this file's subject. */
function portIsFree() {
  mockCreateServer.mockReturnValue({
    once(ev: string, cb: () => void) { if (ev === 'listening') setImmediate(cb); return this },
    listen() { return this },
    close(cb?: () => void) { cb?.(); return this },
  } as never)
}

const netFilterChecks = async () => {
  portIsFree()
  const r = await runDoctorChecks('ios')
  return (r.ios ?? []).filter((c) => c.label.startsWith('Network filter'))
}

// **All three sit above `FIRST_SHIPPED_HOST_VERSION` (1787677954) on purpose.** Every released build
// is above that line, so a fixture below it would put every test on the path taken by a hand build
// and leave the disable-before-replace step — the reason this module changed — unexercised. The one
// test that wants the other side names its own version.
const SHIPPED = '1787800000'
const OLDER = '1787700000'
const NEWER = '1787999999'
/** Where the provider publishes its heartbeat. Its freshness is how `installNetFilter` tells a filter
 *  that is running from one that was switched off and never turned back on. */
const FILTER_STATE_FILE = '/Library/Application Support/tapflow/tapflow-netfilter-state.json'
/** Where it writes instead when the first directory cannot be written. */
const FILTER_STATE_FALLBACK = '/tmp/tapflow-netfilter-state.json'
/** Deliberately shorter. Same-length numeric strings compare identically as strings and as numbers,
 *  so a fixture set that is all the same width cannot tell `Number(a) > Number(b)` from `a > b`. */
const SHORT_BUT_NEWER = '9999999999'

/**
 * **Both the install routine and the doctor's iOS section are gated on `process.platform`, and CI runs
 * on Linux.** Without this every assertion in this file passes on the author's Mac and fourteen of
 * them fail the moment they run anywhere else — which is the only place they were going to run.
 */
function onMac() {
  const real = process.platform
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }) })
  afterEach(() => { Object.defineProperty(process, 'platform', { value: real, configurable: true }) })
}

/** What `systemextensionsctl list` prints. The `[activated enabled]` marker is the whole signal — a
 *  replaced extension sits in the same list as `terminated waiting to uninstall on reboot`. */
const listing = (version: string | null, state = '[activated enabled]') =>
  version === null
    ? '1 extension(s)\n--- com.apple.system_extension.network_extension\n'
    : `1 extension(s)\n--- com.apple.system_extension.network_extension\n`
      + `enabled\tactive\tteamID\tbundleID (version)\tname\t[state]\n`
      + `*\t*\t6FBS3QP893\tdev.tapflow.netfilter.ext (1.0/${version})\tdev.tapflow.netfilter.ext\t${state}\n`

/**
 * A Mac in a named state. `shipped` is the version the package carries; pass `null` for "the package
 * has no app at all".
 */
function machine(opts: {
  shipped?: string | null; installed?: string | null; activated?: string | null; activatedState?: string
  /** The **extension** version the package carries. Defaults to the host version, which is what every
   *  build produced before the two were allowed to differ — so a test only names it when that is the
   *  thing under test. */
  shippedExt?: string | null
  /** Is a provider pulsing? Defaults to yes — a Mac whose versions all match is normally enforcing,
   *  and the interesting case is the one that is not. */
  filterRunning?: boolean
  /** Simulators `simctl` reports as `Booted`. */
  booted?: string[]
  /** Something holding :4000. */
  relayUp?: boolean
}) {
  const {
    shipped = SHIPPED, installed = SHIPPED, activated = SHIPPED, activatedState,
    shippedExt = shipped,
    filterRunning = true, booted = [], relayUp = false,
  } = opts
  mockReadFileSync.mockImplementation((p) => {
    if (String(p) === FILTER_STATE_FILE) {
      return JSON.stringify({ at: Math.floor(Date.now() / 1000), pulseSeconds: 5, rule: [] }) as never
    }
    // `hostLogTail` reads a log that need not exist.
    return '' as never
  })
  mockExistsSync.mockImplementation((p) => {
    const s = String(p)
    if (s === FILTER_STATE_FILE) return filterRunning
    if (s.startsWith(NET_FILTER_APP)) return installed !== null
    if (s.includes('TapflowNetFilter.app')) return shipped !== null
    // Xcode present, so the doctor's **normal** path runs. Without it every doctor assertion below
    // exercised the no-Xcode early return instead, and the splice on the main path was never reached.
    if (s === '/Applications/Xcode.app') return true
    return false
  })
  mockExecFileSync.mockImplementation((cmd, args) => {
    if (String(cmd).endsWith('/systemextensionsctl')) return listing(activated, activatedState) as never
    if (String(cmd) === '/usr/bin/xcrun') {
      return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': booted.map((name) => ({ name, state: 'Booted' })) } }) as never
    }
    if (String(cmd) === '/usr/sbin/lsof') {
      // `lsof` exits non-zero when nothing holds the port, and `execFileSync` turns that into a throw.
      if (!relayUp) throw new Error('lsof: no process')
      return '4321\n' as never
    }
    if (String(cmd).endsWith('/defaults')) {
      const path = String((args as string[])[1] ?? '')
      // Three plists now, and which one is being asked for is in the path: the app in
      // `/Applications`, the app in the package, and the system extension nested inside that.
      const v = path.startsWith(NET_FILTER_APP) ? installed
        : path.includes('SystemExtensions') ? shippedExt
          : shipped
      if (v === null) throw new Error('no such plist')
      return `${v}\n` as never
    }
    return '' as never
  })
}

/** The host binary answering `--install`. */
const hostExits = (code: number) => {
  mockSpawnSync.mockImplementation((cmd, args) => {
    if (String(cmd) === '/usr/bin/ditto') return { status: 0, stdout: '', stderr: '' } as never
    // The disable succeeds unless a test says otherwise. `code` is what `--install` answers, and
    // letting it answer for `--off` too would turn every exit-code case into a disable failure.
    if ((args as string[] | undefined)?.includes('--off')) return { status: 0, stdout: '', stderr: '' } as never
    return { status: code, stdout: '', stderr: '' } as never
  })
}

const dittoCalls = () =>
  mockSpawnSync.mock.calls.filter((c) => String(c[0]) === '/usr/bin/ditto')
const hostCalls = (flag: string) =>
  mockSpawnSync.mock.calls.filter((c) => (c[1] as string[] | undefined)?.includes(flag))
/** Index into the spawn log, so ordering can be asserted rather than assumed. */
const spawnOrder = () =>
  mockSpawnSync.mock.calls.map((c) => (String(c[0]) === '/usr/bin/ditto' ? 'ditto' : String((c[1] as string[] | undefined)?.[0])))

describe('net filter — reading what the Mac has', () => {
  onMac()
  beforeEach(() => { vi.resetAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('reads the activated version, not the app on disk', () => {
    // **The distinction this module exists for.** On the ordinary upgrade path the two disagree:
    // `--install` answers "needs a reboot" and leaves the new app in /Applications while the kernel
    // keeps running the old provider. Comparing files would call that healthy.
    machine({ installed: SHIPPED, activated: OLDER })
    expect(readNetFilterState()).toEqual({
      shippedHost: SHIPPED, installedHost: SHIPPED, shippedExt: SHIPPED, activatedExt: OLDER,
    })
  })

  it('does not count an extension that is listed but not activated', () => {
    // A replaced extension stays in the list as `terminated waiting to uninstall on reboot`, which is
    // exactly the state a check that only grepped for the bundle id would read as healthy.
    machine({ activated: OLDER, activatedState: '[terminated waiting to uninstall on reboot]' })
    expect(readNetFilterState().activatedExt).toBeNull()
  })

  it('says nothing rather than guessing when the command cannot run', () => {
    machine({})
    // `endsWith`, not `===`: the code calls `/usr/bin/systemextensionsctl`, so an equality check on the
    // bare name never matched. The test passed anyway — the mock's fallback returned a version string,
    // `activatedVersion` found no bundle id in it and returned null from the loop exit. Green, and the
    // `catch` this test is named after was never entered.
    mockExecFileSync.mockImplementation((cmd) => {
      if (String(cmd).endsWith('/systemextensionsctl')) throw new Error('not found')
      return `${SHIPPED}\n` as never
    })
    expect(readNetFilterState().activatedExt).toBeNull()
    expect(mockExecFileSync.mock.calls.some((c) => String(c[0]).endsWith('/systemextensionsctl'))).toBe(true)
  })

  it('gives each probe a deadline, so a wedged Mac cannot hang the doctor', () => {
    // **A shape check, and it says so.** That the process is actually killed is node's contract, not
    // ours; what this discriminates is the deletion — a probe going back to no deadline at all, which
    // is what both of these were.
    machine({})
    readNetFilterState()
    const probes = mockExecFileSync.mock.calls.filter((c) =>
      /systemextensionsctl|defaults/.test(String(c[0])))
    expect(probes.length).toBeGreaterThan(1)
    for (const [cmd, , opts] of probes) {
      expect((opts as { timeout?: number })?.timeout, `${String(cmd)} can hang forever`).toBeGreaterThan(0)
    }
  })
})

describe('net filter — installing', () => {
  onMac()
  beforeEach(() => { vi.resetAllMocks(); hostExits(0) })
  afterEach(() => { vi.restoreAllMocks() })

  it('puts the executable bit back on what the tarball flattened', () => {
    // **Measured, not hypothetical.** The app arrives from a pnpm-packed tarball at `rw-r--r--`, and
    // `ditto` copies that faithfully into /Applications, where `--install` cannot then run. The
    // package's `postinstall` chmods `bin/` one level deep, which for a bundle sets the mode of the
    // directory and never reaches `Contents/MacOS`.
    machine({ installed: null, activated: null })
    bundleOnDisk()
    installNetFilter()
    const chmodded = mockChmodSync.mock.calls.map((c) => String(c[0]))
    // **The mode, not only the path.** Asserting the call alone leaves `chmodSync(p, 0o400)` green —
    // which reintroduces exactly the unrunnable binary this function exists to prevent.
    for (const call of mockChmodSync.mock.calls) expect(call[1]).toBe(0o755)
    expect(chmodded).toContain(`${NET_FILTER_APP}/Contents/MacOS/TapflowNetFilter`)
    expect(chmodded, 'the nested system extension is an executable too').toContain(
      `${NET_FILTER_APP}/Contents/Library/SystemExtensions/dev.tapflow.netfilter.ext.systemextension/Contents/MacOS/dev.tapflow.netfilter.ext`,
    )
    expect(chmodded, 'files outside Contents/MacOS are not executables').not.toContain(`${NET_FILTER_APP}/Contents/Info.plist`)
  })

  it('copies and activates when nothing is installed', () => {
    machine({ installed: null, activated: null })
    expect(installNetFilter()).toEqual({ status: 'installed' })
    // The positive control the "does not touch /Applications" assertions below need: this is what the
    // same spy sees when the work does happen.
    expect(dittoCalls()).toHaveLength(1)
    expect(String(dittoCalls()[0][1]?.[1])).toBe(NET_FILTER_APP)
  })

  it('does nothing when the activated version is already the shipped one', () => {
    machine({})
    expect(installNetFilter()).toEqual({ status: 'already-current' })
    expect(dittoCalls(), 'it reinstalled something that was already current').toHaveLength(0)
  })

  it('installs when the files match but the activated version is behind', () => {
    // The reboot-pending Mac. Files agree, so a file comparison would skip the work; the kernel is
    // still running the old provider and the dashboard still says the Mac is not set up.
    machine({ installed: SHIPPED, activated: OLDER })
    expect(installNetFilter()).toEqual({ status: 'installed' })
    expect(dittoCalls()).toHaveLength(1)
  })

  it('compares versions as numbers, not as strings', () => {
    // `'9999999999' > '1787675754'` is true either way; a *shorter* newer version is what separates
    // them. Every other fixture here is the same width, so without this a string comparison passes.
    machine({ installed: SHORT_BUT_NEWER, activated: SHORT_BUT_NEWER })
    expect(installNetFilter()).toMatchObject({ status: 'refused-downgrade' })

    machine({ shipped: SHORT_BUT_NEWER, installed: OLDER, activated: OLDER })
    expect(installNetFilter(), 'a genuinely newer package was refused').toMatchObject({ status: 'installed' })
  })

  it('protects what the Mac is running even when the app is gone from /Applications', () => {
    // macOS keeps an activated extension when its container app is deleted. Reading the app alone
    // skipped the guard entirely there, and an older checkout would walk in and replace a filter that
    // was working.
    machine({ installed: null, activated: NEWER })
    expect(installNetFilter()).toMatchObject({ status: 'refused-downgrade', installed: NEWER })
    expect(dittoCalls()).toHaveLength(0)
  })

  it('refuses to replace a newer filter, and does not touch /Applications', () => {
    // `/Applications` holds one copy for the whole Mac while each checkout judges it by its own
    // node_modules — so an older checkout running this would break the newer agent.
    machine({ installed: NEWER, activated: NEWER })
    expect(installNetFilter()).toEqual({ status: 'refused-downgrade', installed: NEWER, shipped: SHIPPED })
    expect(dittoCalls()).toHaveLength(0)
  })

  it('reports a package with no filter app, and does not touch /Applications', () => {
    machine({ shipped: null, installed: null, activated: null })
    expect(installNetFilter()).toEqual({ status: 'no-artifact' })
    expect(dittoCalls()).toHaveLength(0)
  })

  // ── taking the filter out of the flow path before replacing it ──────────────────────────────
  //
  // A content filter is `filterSockets`: every new flow on the Mac waits for a verdict from the
  // provider. Replacing the extension kills that provider while the configuration stays enabled, and
  // measured on 2026-09-02 the Mac's own traffic then timed out until a restart. Disabling first
  // means that state never exists.

  it('switches the filter off after the copy and before the activation', () => {
    machine({ installed: OLDER, activated: OLDER })
    expect(installNetFilter()).toEqual({ status: 'installed' })
    // **Order, not presence.** Both spawns exist whichever way round they go, so counting them cannot
    // tell the working sequence from the broken one.
    //
    // The copy comes first on purpose: `ditto` writes `/Applications` while the running provider
    // executes out of `/Library/SystemExtensions`, so it disturbs nothing — and putting the disable
    // after it means the binary being asked is the one this package shipped rather than whatever was
    // already installed.
    expect(spawnOrder()).toEqual(['ditto', '--off', '--install'])
  })

  it('refuses when the app is gone and an extension is still enforcing', () => {
    // macOS keeps an extension activated when its container app is deleted, and the agent's whole
    // layer-1 path is that binary. The extension version used to stand in for the host's; now it only
    // gives a lower bound, because a host-only build moves one and not the other. So this Mac may be
    // running a newer host than this checkout carries and nothing here can tell.
    machine({ installed: null, activated: OLDER })
    expect(installNetFilter()).toEqual({ status: 'refused-host-unknown', activated: OLDER })
    expect(mockSpawnSync, 'it replaced an install it could not judge').not.toHaveBeenCalled()
  })

  it('still installs on a Mac with no filter at all', () => {
    // The other side of the refusal above, and the reason it is conditioned on an activated extension
    // rather than on the missing app: a clean Mac has neither, and must not be refused.
    machine({ installed: null, activated: null })
    expect(installNetFilter()).toEqual({ status: 'installed' })
  })

  it('stops before activating when the disable did not take', () => {
    machine({ installed: OLDER, activated: OLDER })
    mockSpawnSync.mockImplementation((cmd, args) => {
      if ((args as string[] | undefined)?.includes('--off')) return { status: 3, stdout: '', stderr: 'save failed' } as never
      return { status: 0, stdout: '', stderr: '' } as never
    })
    // The copy has landed but nothing is activated, so the Mac is still running what it was running.
    // Stopping costs an upgrade; continuing costs the Mac's network.
    expect(installNetFilter()).toMatchObject({ status: 'failed', filterLeftDisabled: false })
    expect(hostCalls('--install')).toHaveLength(0)
  })

  it('reports the filter left off when the activation fails after a disable', () => {
    machine({ installed: OLDER, activated: OLDER })
    hostExits(2)
    // The state matters more than the failure: a filter left off is a working Mac with no iOS
    // network control, and every version on it still reads as correct.
    expect(installNetFilter()).toMatchObject({ status: 'failed', code: 2, filterLeftDisabled: true })
  })

  it('does not claim the filter is off after the reboot path, which turns it back on', () => {
    // `willCompleteAfterReboot` still runs `configureFilter` — deliberately, since the host is the
    // only way a device is put back online — so the filter is on and the old provider enforces it
    // until the restart. Approval is the opposite: it dies before `configureFilter`.
    machine({ installed: OLDER, activated: OLDER })
    hostExits(5)
    expect(installNetFilter()).toEqual({ status: 'needs-reboot' })

    vi.resetAllMocks()
    machine({ installed: OLDER, activated: OLDER })
    hostExits(4)
    expect(installNetFilter()).toEqual({ status: 'needs-approval', filterLeftDisabled: true })
  })

  it('gives every process it starts a deadline', () => {
    // **The lock-in this routine can create is what makes this load-bearing.** It switches the filter
    // off first, so a spawn that never returns leaves the Mac with no filter, no message, and — until
    // the currency check learned to read the heartbeat — nothing that would repair it on a later run.
    // `--install` can legitimately sit on a macOS approval dialog; none of the three may sit forever.
    machine({ installed: OLDER, activated: OLDER })
    expect(installNetFilter()).toMatchObject({ status: 'installed' })
    expect(spawnOrder()).toEqual(['ditto', '--off', '--install'])
    for (const [cmd, args, opts] of mockSpawnSync.mock.calls) {
      const what = String((args as string[] | undefined)?.[0] ?? cmd)
      expect((opts as { timeout?: number } | undefined)?.timeout, `${what} can hang forever`)
        .toBeGreaterThan(0)
    }
  })

  // ── did the filter actually come back? (#725) ───────────────────────────────────────────────
  //
  // The host's exit 0 means the preference save was not refused, which is smaller than "it works" —
  // `Host/main.swift` says so itself. The framework hands the configuration to the provider
  // afterwards with nothing coming back, and by then this routine has switched the filter off on the
  // strength of that report.

  it('reports installed when a filter reports itself running', () => {
    machine({ installed: OLDER, activated: OLDER })
    expect(installNetFilter({ confirmDeadlineMs: 0 })).toEqual({ status: 'installed' })
  })

  it('reports it could not confirm when nothing starts enforcing', () => {
    // **Not a failure.** The app is in place and the extension is activated; what is unknown is
    // whether anything is filtering. Reporting `installed` here is the claim this check exists to
    // stop making, and it is the claim the banner turns into "available now".
    machine({ installed: OLDER, activated: OLDER, filterRunning: false })
    expect(installNetFilter({ confirmDeadlineMs: 0 })).toEqual({ status: 'installed-unconfirmed' })
  })

  it('waits rather than deciding on the first look', () => {
    // A provider launched fresh takes seconds to apply its settings — 5.8 measured, one run in five
    // 21.3 — so asking once and answering would report failure on almost every real replace.
    machine({ installed: OLDER, activated: OLDER })
    let looks = 0
    mockExistsSync.mockImplementation((p) => {
      const q = String(p)
      if (q === FILTER_STATE_FILE) return ++looks > 2
      if (q.startsWith(NET_FILTER_APP) || q.includes('TapflowNetFilter.app')) return true
      return q === '/Applications/Xcode.app'
    })
    expect(installNetFilter({ confirmDeadlineMs: 5_000 })).toEqual({ status: 'installed' })
    expect(looks, 'it answered on the first look').toBeGreaterThan(2)
  })

  it('does not wait on the paths where there is nothing to confirm', () => {
    // Approval dies before the filter is re-enabled, and the reboot path leaves the previous provider
    // enforcing until the restart. Neither banner claims the filter is working, and spending the
    // deadline before telling someone to reboot is a cost with no answer at the end of it.
    for (const [code, status] of [[4, 'needs-approval'], [5, 'needs-reboot']] as const) {
      vi.resetAllMocks()
      machine({ installed: OLDER, activated: OLDER, filterRunning: false })
      hostExits(code)
      const began = Date.now()
      expect(installNetFilter({ confirmDeadlineMs: 5_000 }), `exit ${code}`).toMatchObject({ status })
      expect(Date.now() - began, `exit ${code} spent the confirmation deadline`).toBeLessThan(2_000)
    }
  })

  // ── a filter that was switched off and never turned back on ─────────────────────────────────

  it('reinstalls when the versions all match but nothing is enforcing', () => {
    // The state the sequence above creates when it is interrupted between `--off` and `--install`:
    // right app, right activated extension, no filter. `systemextensionsctl` still says
    // `[activated enabled]` — that is the system extension, not `NEFilterManager.isEnabled` — so a
    // version-only check calls this Mac current and the condition becomes permanent.
    machine({ filterRunning: false })
    // `installed-unconfirmed` rather than `installed`: nothing was enforcing before the run and the
    // fixture keeps it that way, so the confirmation at the end correctly finds nothing. The zero
    // deadline asks once — a real run would spend thirty seconds proving the same thing.
    expect(installNetFilter({ confirmDeadlineMs: 0 })).toEqual({ status: 'installed-unconfirmed' })
    expect(dittoCalls(), 'it declined to restore a filter that was switched off').toHaveLength(1)
  })

  it('finds the heartbeat at the fallback path when the first one is stale', () => {
    // The provider writes to `/tmp` when it cannot write `/Library`, which leaves an old file at the
    // first path and a live one at the second. Answering from the first alone read that Mac as
    // stopped and made every run pay the disable/enable cycle.
    machine({})
    mockExistsSync.mockImplementation((p) => {
      const q = String(p)
      if (q === FILTER_STATE_FILE || q === FILTER_STATE_FALLBACK) return true
      if (q.startsWith(NET_FILTER_APP)) return true
      if (q.includes('TapflowNetFilter.app')) return true
      return q === '/Applications/Xcode.app'
    })
    mockReadFileSync.mockImplementation((p) => {
      const now = Math.floor(Date.now() / 1000)
      if (String(p) === FILTER_STATE_FILE) return JSON.stringify({ at: now - 3600, pulseSeconds: 5 }) as never
      if (String(p) === FILTER_STATE_FALLBACK) return JSON.stringify({ at: now, pulseSeconds: 5 }) as never
      return '' as never
    })
    expect(installNetFilter()).toEqual({ status: 'already-current' })
    expect(dittoCalls(), 'a live filter was replaced because the first state file was old').toHaveLength(0)
  })

  it('treats a heartbeat older than three pulses as stopped', () => {
    machine({})
    mockReadFileSync.mockImplementation((p) => (String(p) === FILTER_STATE_FILE
      ? JSON.stringify({ at: Math.floor(Date.now() / 1000) - 16, pulseSeconds: 5 }) as never
      : '' as never))
    // A provider that died leaves its last file behind; only the clock says so.
    expect(installNetFilter({ confirmDeadlineMs: 0 })).toMatchObject({ status: 'installed-unconfirmed' })
  })

  // ── the host and the extension are two versions now (#724) ──────────────────────────────────
  //
  // `build.sh` stamped one number into both, so comparing a host version against an extension one was
  // invisible rather than harmless. Once a host-only rebuild leaves them different, every comparison
  // that crosses has to be found.

  it('points at a plist that is actually in the committed bundle', async () => {
    // **Against the real filesystem, because the mocks cannot see this.** They match paths by
    // substring, so a path with `Contents/Contents` in it satisfies every one of them — and the first
    // version of this shipped exactly that, reading `null` on every real Mac. Null there means "this
    // package carries no filter", so both commands refused with *reinstall tapflow*, which could not
    // fix it, and 328 tests stayed green.
    const { existsSync: realExists } = await vi.importActual<typeof import('node:fs')>('node:fs')
    const app = join(process.cwd(), 'node_modules', '@tapflowio', 'ios-agent', 'bin', 'TapflowNetFilter.app')
    const root = realExists(app)
      ? app
      : join(process.cwd(), '..', 'ios-agent', 'bin', 'TapflowNetFilter.app')
    expect(realExists(root), `no shipped app to check against at ${root}`).toBe(true)
    // The exact thing `bundleVersion` will `defaults read`.
    expect(
      realExists(join(extensionBundle(root), 'Contents', 'Info.plist')),
      'the extension bundle path does not resolve to a plist in the shipped app',
    ).toBe(true)
  })

  it('is not current when only the app in /Applications is behind', () => {
    // The shape a host-only release produces, and the one the split exists to make ordinary. The
    // extension macOS runs is already ours; the binary the agent executes is not.
    machine({ installed: OLDER, activated: SHIPPED, shippedExt: SHIPPED })
    expect(installNetFilter()).toEqual({ status: 'installed' })
    expect(dittoCalls(), 'a stale host binary was left in place').toHaveLength(1)
  })

  it('is not current when only the extension is behind', () => {
    machine({ installed: SHIPPED, activated: OLDER, shippedExt: SHIPPED })
    expect(installNetFilter()).toEqual({ status: 'installed' })
  })

  it('is current only when both agree', () => {
    machine({ installed: SHIPPED, activated: SHIPPED, shippedExt: SHIPPED })
    expect(installNetFilter()).toEqual({ status: 'already-current' })
    expect(dittoCalls()).toHaveLength(0)
  })

  it('does not read a host version as if it were an extension version', () => {
    // **The crossing this whole change is about.** Host `NEWER`, extension `OLDER`: comparing the
    // host against `shippedExt` would call the Mac newer and refuse, and comparing the extension
    // against `shippedHost` would call it older and install over a newer host. Neither is a judgement
    // anyone made — they are two different measurements put on one scale.
    machine({ installed: NEWER, activated: OLDER, shippedExt: SHIPPED })
    expect(installNetFilter()).toEqual({ status: 'refused-downgrade', installed: NEWER, shipped: SHIPPED })

    vi.resetAllMocks(); hostExits(0)
    machine({ installed: OLDER, activated: NEWER, shippedExt: SHIPPED })
    expect(installNetFilter()).toEqual({ status: 'refused-downgrade', installed: NEWER, shipped: SHIPPED })
  })

  it('judges the Mac\'s extension against the extension this package carries', () => {
    // **The fixture that had to exist for any of this to be testable.** Every case above happens to
    // ship a host and an extension at the same version, which is what every build produced before the
    // split — and on that fixture a guard comparing the Mac's extension against our *host* version is
    // indistinguishable from a correct one.
    //
    // A host-only release is the first thing to carry two different numbers: host `NEWER`, extension
    // `SHIPPED`. A Mac running extension `NEWER` is then newer than us and must be refused, and only
    // the extension-against-extension comparison can say so.
    machine({ shipped: NEWER, shippedExt: SHIPPED, installed: NEWER, activated: NEWER })
    expect(installNetFilter()).toEqual({ status: 'refused-downgrade', installed: NEWER, shipped: SHIPPED })
    expect(dittoCalls(), 'it installed over an extension newer than its own').toHaveLength(0)
  })

  it('judges the app on disk against the app this package carries', () => {
    // The mirror. Package host `SHIPPED`, extension `OLDER`; the Mac's app is `NEWER`. Comparing the
    // installed host against our *extension* version would read the Mac as older and replace a newer
    // binary the agent on this Mac depends on.
    machine({ shipped: SHIPPED, shippedExt: OLDER, installed: NEWER, activated: OLDER })
    expect(installNetFilter()).toEqual({ status: 'refused-downgrade', installed: NEWER, shipped: SHIPPED })
    expect(dittoCalls()).toHaveLength(0)
  })

  // ── devices in use ──────────────────────────────────────────────────────────────────────────

  it('refuses while a simulator is booted, and touches nothing', () => {
    machine({ installed: OLDER, activated: OLDER, booted: ['iPhone 17'] })
    expect(installNetFilter()).toEqual({ status: 'refused-devices-busy', busy: ['simulator iPhone 17'] })
    // **Before the disable, not only before the copy.** A refusal that has already switched the
    // filter off has interrupted the thing it refused in order to avoid.
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('counts a relay on :4000 as in use, because no device list can show a browser', () => {
    machine({ installed: OLDER, activated: OLDER, relayUp: true })
    expect(installNetFilter()).toEqual({ status: 'refused-devices-busy', busy: ['a relay serving on :4000'] })
  })

  it('replaces anyway when the caller says to', () => {
    machine({ installed: OLDER, activated: OLDER, booted: ['iPhone 17'], relayUp: true })
    expect(installNetFilter({ ignoreRunningDevices: true })).toEqual({ status: 'installed' })
    expect(spawnOrder()).toEqual(['ditto', '--off', '--install'])
  })

  it('does not refuse for a device that is present but not booted', () => {
    machine({ installed: OLDER, activated: OLDER })
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (String(cmd) === '/usr/bin/xcrun') {
        return JSON.stringify({ devices: { r: [{ name: 'iPhone 17', state: 'Shutdown' }] } }) as never
      }
      if (String(cmd) === '/usr/sbin/lsof') throw new Error('lsof: no process')
      if (String(cmd).endsWith('/systemextensionsctl')) return listing(OLDER) as never
      if (String(cmd).endsWith('/defaults')) {
        return `${String((args as string[])[1] ?? '').startsWith(NET_FILTER_APP) ? OLDER : SHIPPED}\n` as never
      }
      return '' as never
    })
    expect(installNetFilter()).toMatchObject({ status: 'installed' })
  })

  it('separates approval and reboot from failure', () => {
    for (const [code, status] of [[4, 'needs-approval'], [5, 'needs-reboot']] as const) {
      vi.resetAllMocks()
      machine({ installed: null, activated: null })
      hostExits(code)
      expect(installNetFilter(), `exit ${code}`).toMatchObject({ status })
    }
  })

  it('reports every other exit code as a failure, carrying the code', () => {
    for (const code of [1, 2, 3, 6, 7]) {
      vi.resetAllMocks()
      machine({ installed: null, activated: null })
      hostExits(code)
      expect(installNetFilter(), `exit ${code}`).toMatchObject({ status: 'failed', code })
    }
  })
})

describe('doctor — what it says about the filter', () => {
  onMac()
  beforeEach(() => { vi.resetAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('warns rather than fails when nothing is installed, and names both commands', async () => {
    // `warn`, not `fail`: a session works without the filter. Only iOS network control does not.
    machine({ installed: null, activated: null })
    const [check, ...rest] = await netFilterChecks()
    expect(rest).toHaveLength(0)
    expect(check).toMatchObject({ ok: false, warn: true })
    expect(check.detail).toMatch(/setup ios/)
    expect(check.detail, 'an existing install never runs setup again').toMatch(/migrate net-filter/)
  })

  it('says it is installed but unapproved, and where to approve it', async () => {
    machine({ activated: null })
    const [check] = await netFilterChecks()
    expect(check).toMatchObject({ ok: false, warn: true })
    expect(check.detail).toMatch(/System Settings/)
  })

  it('asks for a restart when the files agree and the running one does not', async () => {
    // The state a file comparison calls healthy, and the reason the version check reads
    // `systemextensionsctl` instead.
    machine({ installed: SHIPPED, activated: OLDER })
    const [, version] = await netFilterChecks()
    expect(version).toMatchObject({ label: 'Network filter version', ok: false, warn: true })
    expect(version.detail).toMatch(/[Rr]estart/)
  })

  it('sends an out-of-date Mac to migrate', async () => {
    machine({ installed: OLDER, activated: OLDER })
    const [, version] = await netFilterChecks()
    expect(version.detail).toMatch(/migrate net-filter/)
  })

  it('tells a stale checkout to upgrade itself rather than reinstall the filter', async () => {
    // One Mac, several tapflows. Reinstalling here would downgrade the filter the newer agent needs.
    machine({ installed: NEWER, activated: NEWER })
    const [, version] = await netFilterChecks()
    expect(version.detail).toMatch(/newer tapflow/)
  })

  it('is quiet when the running filter is the one this tapflow carries', async () => {
    // The positive control. Without it every assertion above passes on a build that always warns.
    machine({})
    expect(await netFilterChecks()).toEqual([
      { label: 'Network filter', ok: true },
      { label: 'Network filter version', ok: true },
    ])
  })

  it('still says the filter is off when a version is behind as well', async () => {
    // The version branches all report the same `Network filter` check, so deciding "switched on"
    // inside the matching-version branch left every other branch claiming a healthy filter. A Mac
    // waiting for a restart *and* switched off was told only about the restart — and restarting does
    // not turn a filter back on, so the advice sends the user round a loop that cannot end.
    machine({ installed: SHIPPED, activated: OLDER, filterRunning: false })
    const [check, version] = await netFilterChecks()
    expect(check.ok, 'a version mismatch hid the switched-off filter').toBe(false)
    expect(check.detail).toMatch(/switched off/)
    // Both are true at once, and they want different actions. Neither replaces the other.
    expect(version.ok).toBe(false)
    expect(version.detail).toMatch(/Restart the Mac/)
  })

  it('names the app, not the extension, when the Mac is set up by a newer tapflow', async () => {
    // A host-only release moves one number and not the other, so this branch fires with the extension
    // versions equal. Reporting the extension pair printed the same number twice as the evidence they
    // differed, and never named the thing that was actually newer.
    machine({ installed: NEWER, activated: SHIPPED, shippedExt: SHIPPED })
    const [, version] = await netFilterChecks()
    expect(version.ok).toBe(false)
    expect(version.detail).toMatch(/newer tapflow/)
    expect(version.detail, 'it named the extension for a host mismatch').toContain('/Applications')
    expect(version.detail).toContain(NEWER)
    expect(version.detail, 'it printed the same version twice as proof of a difference')
      .not.toMatch(new RegExp(`extension ${SHIPPED} and this one carries ${SHIPPED}`))
  })

  it('names the app, not the extension, when only the host is behind', async () => {
    // The release shape the split makes common. macOS skips the activation because the extension did
    // not change, so nothing is interrupted — but the agent runs the binary in `/Applications`, and an
    // older one meets flags it does not understand. Reporting this as healthy is how #723 happened.
    machine({ installed: OLDER, activated: SHIPPED, shippedExt: SHIPPED })
    const [check, version] = await netFilterChecks()
    expect(check.ok, 'the filter itself is fine here').toBe(true)
    expect(version.ok, 'doctor called a stale host binary healthy').toBe(false)
    expect(version.detail).toMatch(/\/Applications/)
    expect(version.detail).toMatch(/tapflow migrate net-filter/)
    expect(version.detail, 'it blamed the extension for a host problem').not.toMatch(/Waiting for a restart/)
  })

  it('warns when every version matches and nothing is enforcing', async () => {
    // **Installed, approved and switched on are three things, and only two of them have a version.**
    // `systemextensionsctl` describes the system extension, so a filter switched off leaves this
    // whole section green over a control that does not work — and the replace sequence creates
    // exactly that state when it is interrupted between the disable and the install.
    machine({ filterRunning: false })
    const [check, version] = await netFilterChecks()
    expect(check.ok, 'doctor called a switched-off filter healthy').toBe(false)
    expect(check.warn).toBe(true)
    expect(check.detail).toMatch(/switched off/)
    expect(check.detail, 'it did not say how to fix it').toMatch(/tapflow migrate net-filter/)
    // The version half is still true and says so: this is not a version problem, and telling someone
    // to upgrade would send them somewhere that cannot help.
    expect(version).toEqual({ label: 'Network filter version', ok: true })
  })
})

describe('net filter — a version nobody can read', () => {
  onMac()
  beforeEach(() => { vi.resetAllMocks(); hostExits(0) })
  afterEach(() => { vi.restoreAllMocks() })

  it('refuses to install an app that will not say what it is', () => {
    // The guard used to sit under `if (shippedVersion)`, so the one artifact no comparison could judge
    // was the one that installed unconditionally — over a filter that was working.
    machine({ shipped: null, installed: NEWER, activated: NEWER })
    mockExistsSync.mockImplementation((p) => String(p).includes('TapflowNetFilter.app'))
    expect(installNetFilter()).toEqual({ status: 'no-artifact' })
    expect(dittoCalls().length, 'it copied an unreadable bundle over a newer one').toBe(0)
  })

  it('does not send the user to a migrate the installer would refuse', async () => {
    // doctor compared with its own `Number(a) > Number(b)`, which answers `false` for a pair neither
    // side can parse while `isNewer` answers `true` and refuses. The two disagreeing produced advice
    // with no exit: doctor says run migrate, migrate says it will not.
    machine({ shipped: 'xyz', installed: 'def', activated: 'abc' })
    const [, version] = await netFilterChecks()
    expect(version?.detail).toMatch(/Upgrade this checkout/)
    expect(version?.detail, 'it recommended the command that refuses').not.toMatch(/migrate net-filter/)
  })
})

describe('doctor — the injected library', () => {
  onMac()
  beforeEach(() => { vi.resetAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  const hookCheck = async () => {
    portIsFree()
    const r = await runDoctorChecks('ios')
    return (r.ios ?? []).find((c) => c.label === 'Network hook')
  }

  it('reports it, which nothing did before — the other half of the same feature had five checks', async () => {
    machine({})
    mockExistsSync.mockImplementation((p) => {
      const s = String(p)
      if (s.endsWith('libtapflow-nethook.dylib')) return true
      if (s === '/Applications/Xcode.app') return true
      return s.includes('TapflowNetFilter.app')
    })
    mockAccessSync.mockReturnValue(undefined as never)
    expect(await hookCheck()).toMatchObject({ label: 'Network hook', ok: true })
  })

  it('warns rather than fails when it is gone, and says what restores it', async () => {
    machine({})
    mockExistsSync.mockImplementation((p) => {
      const s = String(p)
      if (s.endsWith('libtapflow-nethook.dylib')) return false
      if (s === '/Applications/Xcode.app') return true
      return s.includes('TapflowNetFilter.app')
    })
    const check = await hookCheck()
    // Warn, not fail: a session works without it and only iOS network control does not — the same
    // grading the filter's own checks carry.
    expect(check).toMatchObject({ ok: false, warn: true })
    expect(check?.detail).toMatch(/Reinstalling tapflow/)
  })

  it('separates present-but-unreadable from absent, because they are different repairs', async () => {
    machine({})
    mockExistsSync.mockImplementation((p) => {
      const s = String(p)
      if (s.endsWith('libtapflow-nethook.dylib')) return true
      if (s === '/Applications/Xcode.app') return true
      return s.includes('TapflowNetFilter.app')
    })
    mockAccessSync.mockImplementation(() => { throw new Error('EACCES') })
    const check = await hookCheck()
    expect(check).toMatchObject({ ok: false, warn: true })
    expect(check?.detail, 'an unreadable file reported as a missing one').toMatch(/cannot be read/)
  })
})

describe('setup and migrate share one install', () => {
  beforeEach(() => { vi.resetAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('marks the step skipped on a host that cannot have it', async () => {
    // **Asserted as a present marker, not as an absence.** "It skips and says so" passes on a build
    // where the step was never written; a step that exists and reports itself skipped cannot.
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      machine({})
      mockExecSyncForIos()
      const step = (await runSetupIos()).find((r) => r.label === 'Network filter')
      expect(step, 'the step is missing entirely, so nothing reported the skip').toBeDefined()
      expect(step).toMatchObject({ ok: true, warn: true })
      expect(step?.detail).toMatch(/macOS only/)
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('asks before installing a system extension, and installs when told to', async () => {
    await onMacFor(async () => {
      machine({ installed: null, activated: null })
      mockExecSyncForIos()
      hostExits(0)
      setTTY(true)
      mockConfirm.mockResolvedValue(true as never)
      const step = (await runSetupIos()).find((r) => r.label === 'Network filter')
      expect(filterPrompts().length, 'it installed without asking').toBe(1)
      expect(step).toMatchObject({ ok: true, state: 'created' })
      expect(dittoCalls().length).toBe(1)
    })
  })

  it('declining leaves the Mac alone and names the command that installs it later', async () => {
    // **The step this file's siblings all had and this one did not.** Every other install in
    // `setup.ts` is gated on `isTTY` + `confirm()`; written synchronously, this one went straight to
    // activating a system extension that sees every flow the Mac attributes to a simulator.
    await onMacFor(async () => {
      machine({ installed: null, activated: null })
      mockExecSyncForIos()
      hostExits(0)
      setTTY(true)
      mockConfirm.mockResolvedValue(false as never)
      const step = (await runSetupIos()).find((r) => r.label === 'Network filter')
      expect(dittoCalls().length, 'it installed anyway').toBe(0)
      expect(step?.detail).toMatch(/migrate net-filter/)
    })
  })

  it('does not ask about an install that would do nothing', async () => {
    await onMacFor(async () => {
      machine({})
      mockExecSyncForIos()
      setTTY(true)
      mockConfirm.mockResolvedValue(true as never)
      const step = (await runSetupIos()).find((r) => r.label === 'Network filter')
      expect(filterPrompts().length, 'a no-op install still stopped to ask').toBe(0)
      expect(step).toMatchObject({ ok: true, state: 'found' })
    })
  })

  it('does not install one in a non-interactive run', async () => {
    await onMacFor(async () => {
      machine({ installed: null, activated: null })
      mockExecSyncForIos()
      hostExits(0)
      setTTY(false)
      const step = (await runSetupIos()).find((r) => r.label === 'Network filter')
      expect(dittoCalls().length).toBe(0)
      expect(step?.detail).toMatch(/non-interactive/)
    })
  })

  it('keeps the install in one place — neither command spawns anything itself', async () => {
    // The real `fs`: this reads the sources under test, and the mocked one returns nothing at all —
    // which would make every assertion below pass on an empty string.
    const { readFileSync: realRead } = await vi.importActual<typeof import('node:fs')>('node:fs')
    // The drift guard. The compiler already forces both surfaces to handle every `InstallOutcome`
    // member, because neither switch has a default; what it cannot see is one of them growing its own
    // copy of the copy-and-activate. `cmdMigrateDataDir` set the precedent: commands present, `lib/`
    // decides.
    const here = new URL('.', import.meta.url).pathname
    for (const file of ['setup.ts', 'migrate.ts']) {
      const src = realRead(join(here, '..', '..', 'commands', file), 'utf8')
      expect(src, `${file} runs its own process`).not.toMatch(/spawnSync|execFileSync|ditto/)
    }
    const lib = realRead(join(here, '..', '..', 'lib', 'net-filter.ts'), 'utf8')
    expect(lib, 'the shared routine no longer copies anything').toMatch(/ditto/)
  })
})

/** `onMac()` is a hook pair and cannot wrap one test inside a describe that must stay cross-platform. */
async function onMacFor(body: () => Promise<void>) {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  try { await body() } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true })
    setTTY(undefined)
  }
}

/** iOS setup also probes brew/Xcode/simctl; none of that is this file's subject. */
function mockExecSyncForIos() {
  vi.mocked(execSync).mockImplementation((cmd) => {
    const c = String(cmd)
    if (c === 'which brew') return '/opt/homebrew/bin/brew\n' as never
    if (c === 'xcode-select -p') return '/Applications/Xcode.app/Contents/Developer\n' as never
    if (c === 'xcodebuild -version') return 'Xcode 26.5\n' as never
    if (c.includes('simctl list devices')) return JSON.stringify({ devices: { 'iOS-18': [{ udid: 'A', name: 'iPhone', state: 'Booted' }] } }) as never
    return '' as never
  })
}
