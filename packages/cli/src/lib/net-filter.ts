import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * The iOS network filter — the one layer of the offline toggle that lives on the Mac rather than in
 * the simulator, and the only one a user has to install.
 *
 * **Three versions, not two, and the third is the one that matters.** The app the package ships, the
 * app in `/Applications`, and the extension macOS has *activated*. A design review found this the
 * hard way: on the ordinary upgrade path `--install` answers exit 5 (needs a reboot), which leaves
 * the first two matching while the kernel goes on running the old provider — so a check that compares
 * the files reports everything healthy while the dashboard says the Mac is not set up. The agent
 * confirms enforcement over XPC, and an older extension has no listener to answer it.
 *
 * So this module reads the activated version, and everything that installs goes through one routine
 * (`installNetFilter`) rather than being written twice.
 */

/** Where macOS expects the container app. Anywhere else and activation answers `code=3`. */
export const NET_FILTER_APP = '/Applications/TapflowNetFilter.app'
const EXT_BUNDLE_ID = 'dev.tapflow.netfilter.ext'

/** How long a read-only probe of this Mac may take before it is treated as unanswerable. Generous
 *  against a loaded machine, short against `doctor`'s promise to answer. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * **Two versions, not one, and the names say which is which** (#724).
 *
 * `build.sh` used to stamp one number into the host app and the system extension alike, so a rebuild
 * that changed nothing but the host still bumped the extension and macOS replaced a provider for no
 * reason — three of the six filter rebuilds so far. They are now allowed to differ, and the moment
 * they do, comparing one against the other stops being harmless.
 *
 * It was not harmless before either, only invisible: `isNetFilterCurrent` compared the *host* app's
 * version against the *extension* macOS is running, and they only ever agreed because one number was
 * written into both. Fields called `shipped` and `installed` gave nothing away about which kind of
 * version they held, which is why the names carry it now.
 */
export interface NetFilterState {
  /** Host app version this CLI's `@tapflowio/ios-agent` carries, or null when the package has no app. */
  shippedHost: string | null
  /** Host app version in `/Applications`, or null when nothing is installed there. */
  installedHost: string | null
  /** System extension version the package carries. */
  shippedExt: string | null
  /** System extension version macOS reports as `[activated enabled]`, or null when none is. */
  activatedExt: string | null
}

/** Read `CFBundleVersion` from an app bundle. `null` for absent or unreadable — a bundle that cannot
 *  be read is not a version, and guessing one here would be the claim this whole feature avoids. */
export function bundleVersion(appPath: string): string | null {
  // `appPath` is a bundle root — the app, or the system extension nested inside it. Both keep their
  // plist at `Contents/Info.plist`, which is what lets one reader serve the two versions this module
  // now has to tell apart.
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  try {
    const out = execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleVersion'], {
      // A read that hangs hangs `tapflow doctor ios` with it, and the command's whole job is to answer
      // quickly about a machine that may be in a bad state. The throw lands in the `catch` below, so a
      // hang reports the same "cannot tell" as a failure — which is what it is.
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * The app this CLI would install, found through the agent package rather than a relative path.
 *
 * `createRequire` resolution rather than `join(import.meta.dirname, '../..')`: the CLI is installed
 * as a dependency, run from a pnpm store with its own layout, and executed from a bin shim — the only
 * thing that holds across those is asking node where the package is.
 *
 * It resolves the **manifest**, which is why `@tapflowio/ios-agent` exports `./package.json`. Without
 * that entry the map's `.` is the only path out of the package and node answers
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`; resolving the main entry and walking up a directory would work
 * today and encode where the entry happens to sit.
 */
export function shippedAppPath(): string | null {
  return shippedArtifact('TapflowNetFilter.app')
}

/**
 * The injected library — the offline toggle's **second** layer, and the one nothing reported on.
 *
 * It is not a second copy of the filter's problem. The filter is installed onto the Mac and can be
 * absent, stale or unapproved; this one only ever lives inside the package, so it is either there or
 * the install is damaged. What made it worth a check is the failure it produces when it is not:
 * `DYLD_INSERT_LIBRARIES` naming a path that does not exist is **ignored silently** by dyld, the app
 * launches with no hooks, and no verdict is ever written — so the control asks the tester to launch
 * an app through tapflow, forever, while the app they launched is running in front of them.
 */
export function shippedHookPath(): string | null {
  return shippedArtifact('libtapflow-nethook.dylib')
}

function shippedArtifact(name: string): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('@tapflowio/ios-agent/package.json')
    const p = join(dirname(pkg), 'bin', name)
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

/**
 * What macOS has *activated*, from `systemextensionsctl list`.
 *
 * The line looks like `*   *   TEAMID   dev.tapflow.netfilter.ext (1.0/1787585990)   name  [activated enabled]`.
 * Only a line that is both activated **and** enabled counts; a replaced extension sits in that list
 * as `terminated waiting to uninstall on reboot` and is exactly the state this exists to catch.
 */
export function activatedVersion(): string | null {
  // `execFileSync`, not `spawnSync`, and the distinction is this codebase's: reads go through the exec
  // family and `spawnSync` is what changes the machine. A setup run on a fully configured Mac asserts
  // that nothing was spawned, and asking macOS what it has activated must not break that.
  let out: string
  try {
    out = execFileSync('/usr/bin/systemextensionsctl', ['list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    })
  } catch {
    return null
  }
  // Absent output is "cannot tell", which is what `null` means here — inventing a version would be
  // the claim this whole module exists to avoid.
  if (!out) return null
  for (const line of out.split('\n')) {
    if (!line.includes(EXT_BUNDLE_ID)) continue
    if (!line.includes('[activated enabled]')) continue
    const m = line.match(/\(([^)]*)\)/)
    if (!m) continue
    // `1.0/1787585990` — short version before the slash, build version after. The build version is
    // what `build.sh` makes unique per build, so it is the one that identifies a binary.
    //
    // **No slash means we cannot tell which half we are looking at**, and answering with the short
    // version puts an uncomparable `1.0` into a comparison against an epoch. That produced advice with
    // no exit: doctor says the versions differ, migrate installs, macOS skips the replace because the
    // bundle version did not change, and doctor says the same thing again.
    const parts = m[1].split('/')
    if (parts.length < 2) return null
    return parts[1].trim() || null
  }
  return null
}

/**
 * Is `candidate` a later build than `than`?
 *
 * **Anything that does not parse answers yes**, so an unreadable version refuses the install rather
 * than performing it. `Number('a') > Number('b')` is a NaN comparison and therefore `false`, which
 * would have made the downgrade guard fail *open* the day these stop being epoch seconds — the one
 * direction a guard must never fail in.
 */
export function isNewer(candidate: string, than: string): boolean {
  const a = Number(candidate)
  const b = Number(than)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  return a > b
}

/**
 * Nothing to install: the app on disk and the extension macOS is running are both this build.
 *
 * Exported because `setup ios` asks before each install and must not ask about one that would do
 * nothing — and a second copy of this comparison in the caller is how the prompt and the installer
 * would come to disagree about whether there was anything to consent to.
 */
export function isNetFilterCurrent(s: NetFilterState): boolean {
  return s.shippedHost !== null && s.installedHost === s.shippedHost
    && s.shippedExt !== null && s.activatedExt === s.shippedExt
}

/**
 * Where the extension's own plist sits inside the app bundle.
 *
 * **`installedExt` is deliberately not read**, and that is a decision rather than an omission: the
 * two plists come out of one build and the host version is unique per build, so `installedHost`
 * matching already says the bundle is this build's — extension included. Reading a third plist would
 * buy a derivable value at the price of another 10-second probe and another way to answer `null`,
 * where "could not read it" and "it is not there" are the same answer.
 */
/**
 * The system extension's own bundle, nested inside an app bundle.
 *
 * **A bundle root, not a plist path** — `bundleVersion` appends `Contents/Info.plist` itself, and
 * handing it a path that already ends in `Contents` produced `Contents/Contents/Info.plist`, an
 * unreadable path that answered `null` for every install. Null there means "this package carries no
 * filter", so `setup ios` and `migrate net-filter` both refused with *reinstall tapflow*, which
 * cannot fix it. The mistake survived a full green suite because the fixtures matched paths by
 * substring and said yes to both.
 */
export function extensionBundle(appPath: string): string {
  return join(appPath, 'Contents', 'Library', 'SystemExtensions', 'dev.tapflow.netfilter.ext.systemextension')
}

export function readNetFilterState(): NetFilterState {
  const shipped = shippedAppPath()
  return {
    shippedHost: shipped ? bundleVersion(shipped) : null,
    installedHost: bundleVersion(NET_FILTER_APP),
    shippedExt: shipped ? bundleVersion(extensionBundle(shipped)) : null,
    activatedExt: activatedVersion(),
  }
}

/**
 * Where the provider publishes what it is enforcing, most likely first.
 *
 * Read rather than asked. Asking means running the host binary, and a stale one turns a flag it does
 * not know into a rule write — measured on 2026-09-02, `--confirm` against an older build erased the
 * rule and answered 0. A file read cannot change the Mac.
 */
const FILTER_STATE_FILES = [
  '/Library/Application Support/tapflow/tapflow-netfilter-state.json',
  '/tmp/tapflow-netfilter-state.json',
]

/**
 * Is a provider actually enforcing right now?
 *
 * **Not the question `activatedVersion()` answers, and conflating them is what this exists to stop.**
 * `systemextensionsctl` reports the *system extension*; `NEFilterManager.isEnabled` is a separate
 * preference, and a filter switched off leaves the extension listed `[activated enabled]` exactly as
 * before. So a Mac whose filter was disabled and never turned back on reads as fully current, and
 * `installNetFilter` returned `already-current` without running the step that would restore it —
 * network control dead, `doctor ios` all green, and nothing anywhere saying why.
 *
 * That state is not hypothetical: the disable-before-replace sequence below creates it whenever it is
 * interrupted after `--off` and before `--install`.
 *
 * Stale counts as stopped, on the agent's own rule — three missed pulses, with `pulseSeconds` taken
 * from the file rather than assumed, because the provider slows its pulse while nothing is offline.
 */
export function isFilterEnforcing(now = Date.now(), since = 0): boolean {
  for (const path of FILTER_STATE_FILES) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown; pulseSeconds?: unknown }
      if (typeof raw.at !== 'number') continue
      const pulse = typeof raw.pulseSeconds === 'number' ? raw.pulseSeconds : 5
      // **A stale file is a reason to keep looking, not an answer.** The second path is where the
      // provider writes when it cannot write the first, so a Mac that failed over leaves an old file
      // at the first one and a live heartbeat at the second. Returning here read that Mac as stopped
      // and made every run pay the disable/enable cycle this module exists to make rare.
      // **`since` is how a caller asks "did somebody start *after* this moment".** Freshness alone
      // cannot tell a live provider from one that died inside the window — the file is written every
      // pulse and removed asynchronously two hops after `--off` returns, so a provider killed by an
      // activation leaves a file that is up to fifteen seconds young. A caller waiting for a filter to
      // come *back* would read that as success on its first look, which is the false report the wait
      // exists to prevent. `doctor` passes nothing, because it only asks whether anything is running
      // now.
      if (raw.at <= since) continue
      if (Math.floor(now / 1000) - raw.at <= 3 * Math.max(pulse, 1)) return true
      continue
    } catch {
      // Unreadable is not "enforcing". Keep looking; the second path is the fallback the provider
      // uses when it cannot write the first.
      continue
    }
  }
  return false
}

/**
 * What would be interrupted by a replace, in words a person can act on. Empty means nothing would.
 *
 * **All three, because the filter is host-wide.** It is `filterSockets`, so every new flow on the Mac
 * goes through the provider — an Android emulator's traffic included, even though nothing here can
 * take one offline. And a relay serving on :4000 means somebody may be testing through a browser from
 * another machine, which no device list can show.
 *
 * Best-effort by construction: a probe that cannot run reports nothing rather than blocking the
 * install. A missed device costs the interruption this refusal exists to avoid; a probe that throws
 * and stops the upgrade costs an upgrade nobody can perform.
 */
export function busyDevices(): string[] {
  const busy: string[] = []
  for (const name of bootedSimulators()) busy.push(`simulator ${name}`)
  for (const serial of attachedEmulators()) busy.push(`emulator ${serial}`)
  if (relayIsServing()) busy.push('a relay serving on :4000')
  return busy
}

function bootedSimulators(): string[] {
  try {
    const raw = execFileSync('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    const data = JSON.parse(raw) as { devices: Record<string, Array<{ name: string; state: string }>> }
    return Object.values(data.devices).flat().filter((d) => d.state === 'Booted').map((d) => d.name)
  } catch {
    return []
  }
}

function attachedEmulators(): string[] {
  try {
    // From `PATH`, unlike the absolute paths above: `adb` ships with the Android SDK and has no fixed
    // location. Absent is the common case on an iOS-only Mac and lands in the `catch`.
    const raw = execFileSync('adb', ['devices'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    return raw.split('\n').slice(1)
      .map((l) => l.trim()).filter((l) => l.endsWith('device'))
      .map((l) => l.split(/\s+/)[0]).filter(Boolean)
  } catch {
    return []
  }
}

function relayIsServing(): boolean {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:4000', '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    return out.trim().length > 0
  } catch {
    // `lsof` exits non-zero when nothing holds the port, which is the common case and not an error.
    return false
  }
}

export interface InstallOptions {
  /** Replace even though devices are in use. The refusal exists because a replace interrupts every
   *  new connection on the Mac; this is the caller saying they know and want it anyway. */
  ignoreRunningDevices?: boolean
  /**
   * How long to wait for a filter to report itself running, in milliseconds.
   *
   * A parameter rather than a constant because a test that means "it never came back" would otherwise
   * spend the real deadline proving it — 60 seconds across two cases, measured. Passing `0` asks once
   * and answers, which is the same code path a slow provider takes on its last poll.
   */
  confirmDeadlineMs?: number
}

export type InstallOutcome =
  | { status: 'installed' }
  | { status: 'installed-unconfirmed' }
  | { status: 'already-current' }
  | { status: 'needs-approval'; filterLeftDisabled: boolean }
  | { status: 'needs-reboot' }
  | { status: 'not-macos' }
  | { status: 'no-artifact' }
  | { status: 'refused-downgrade'; installed: string; shipped: string }
  | { status: 'refused-host-unknown'; activated: string }
  | { status: 'refused-devices-busy'; busy: string[] }
  | { status: 'failed'; code: number; detail: string; filterLeftDisabled: boolean }

/** What the host binary's exit codes mean. The table lives in `ios-netfilter/README.md`; these are the
 *  three that are not failures. */
const EXIT_APPROVAL_TIMEOUT = 4
const EXIT_NEEDS_REBOOT = 5

/** How long `--off` gets. It is one `NEFilterManager` save and was measured at 31ms; this is a bound
 *  on a wedged run, not a budget. */
const OFF_TIMEOUT_MS = 15_000

/** How long the copy gets. `ditto` moves a few megabytes off local disk, so this bounds a wedged run
 *  rather than a slow one — and after the disable above, a copy that never returns is what leaves the
 *  filter off with nothing said. */
const COPY_TIMEOUT_MS = 60_000

/**
 * How long the filter gets to come back up before the run says it could not tell.
 *
 * The provider writes its state file once from `startFilter`, so this is the time between the
 * preference save being accepted and settings actually being applied. Measured on this Mac: about
 * four seconds for a provider that was already resident, and `SimulatorNetwork.ts` records 5.8s for
 * one launched fresh, with one run in five taking 21.3. Thirty is that worst case with room.
 *
 * **The successful path does not wait**, so this is only ever spent on a run that has something to
 * report. Waiting is what makes the report possible.
 */
export const CONFIRM_DEADLINE_MS = 30_000

/** How often to look. The file is written once and then pulsed, so this only decides how quickly a
 *  success is noticed. */
const CONFIRM_POLL_MS = 500

/** How long `--install` gets. Generous because it can be waiting on a macOS approval dialog — the
 *  host has its own approval and stall deadlines (exit 4 and 6) and this is only the backstop for a
 *  run that reaches neither. Without it the CLI waits forever on a completion handler that never
 *  fires, which is how an interrupted sequence leaves the filter off. */
const INSTALL_TIMEOUT_MS = 180_000

/**
 * Put the shipped app in `/Applications` and activate it. **The one routine both `setup ios` and
 * `migrate net-filter` call** — they exist for different people (first run vs an upgrade that
 * introduced the feature) and must not drift into two answers for one question.
 *
 * No `sudo`: `/Applications` is writable by an admin user, and `ditto` preserves the signature, which
 * a plain copy does not. Measured.
 */
export function installNetFilter(opts: InstallOptions = {}): InstallOutcome {
  if (process.platform !== 'darwin') return { status: 'not-macos' }
  const shipped = shippedAppPath()
  if (!shipped) return { status: 'no-artifact' }

  const state = readNetFilterState()
  const { shippedHost, installedHost, shippedExt, activatedExt } = state
  // **An unreadable version refuses too.** Under `if (shippedVersion)` the whole guard below was
  // skipped whenever the shipped app would not say what it was, so the one artifact no comparison can
  // judge was the one that installed unconditionally — over a newer filter that was working.
  if (!shippedHost || !shippedExt) return { status: 'no-artifact' }
  // **Current *and* running.** The version check alone answers a different question than the one the
  // caller is asking, and the gap between them is a state this function creates: interrupt the
  // sequence below between `--off` and `--install` and the Mac has the right app, the right activated
  // extension, and no filter. Returning `already-current` there makes the condition permanent, because
  // the only thing that would turn it back on is the run that just declined to do anything.
  if (isNetFilterCurrent(state) && isFilterEnforcing()) {
    return { status: 'already-current' }
  }
  // **A downgrade is refused rather than performed.** `/Applications` holds one copy for the whole
  // Mac while the version each checkout judges it by comes from its own `node_modules`, so an older
  // checkout running this would replace the app a newer agent depends on and break it.
  //
  // **Each kind against its own kind.** This used to fall back to the activated *extension* version
  // when the app was gone, which worked only because one number was written into both. Once they are
  // allowed to differ, that comparison is between two things that were never the same measurement.
  if (installedHost && isNewer(installedHost, shippedHost)) {
    return { status: 'refused-downgrade', installed: installedHost, shipped: shippedHost }
  }
  if (activatedExt && isNewer(activatedExt, shippedExt)) {
    return { status: 'refused-downgrade', installed: activatedExt, shipped: shippedExt }
  }

  // **What is protected is what the Mac is running, not the file on disk**, and with the app gone
  // there is no longer anything that says what that is.
  //
  // macOS keeps an extension activated and enforcing when its container app is deleted, and the
  // agent's whole layer-1 path is the binary in `/Applications`. The extension's version used to
  // stand in for the host's; now it only gives a lower bound, because a host-only build moves one and
  // not the other. So this Mac may be running a *newer* host than this checkout carries and nothing
  // here can tell.
  //
  // Refusing costs a repair that would usually have been fine. Guessing costs a working install,
  // silently, for whoever set it up — and `doctor` already answers this state with the same two
  // remedies rather than offering to reinstall.
  if (installedHost === null && activatedExt !== null) {
    return { status: 'refused-host-unknown', activated: activatedExt }
  }

  // **Refused rather than forced, and it belongs here rather than in either command.** Both `setup
  // ios` and `migrate net-filter` reach this function, so a gate on one of them protects half the
  // callers — and the destructive part is here, not there.
  //
  // Refusing rather than shutting the devices down is the other half of the decision. `/Applications`
  // holds one filter for the whole Mac, which is already this module's reason for the downgrade
  // guard: the people affected by a replace are not necessarily the person running the command.
  const busy = opts.ignoreRunningDevices ? [] : busyDevices()
  if (busy.length > 0) return { status: 'refused-devices-busy', busy }

  const copy = spawnSync('/usr/bin/ditto', [shipped, NET_FILTER_APP], {
    encoding: 'utf8', timeout: COPY_TIMEOUT_MS,
  })
  if (!copy || copy.status !== 0) {
    return {
      status: 'failed',
      code: copy?.status ?? -1,
      detail: (copy?.stderr || 'ditto failed').trim(),
      filterLeftDisabled: false,
    }
  }

  restoreExecutableBits(NET_FILTER_APP)

  // **Take the filter out of the flow path before activating, and do it with the binary just copied
  // in.**
  //
  // A content filter is `filterSockets`, so every new flow on the Mac waits for a verdict from the
  // provider. Activating a replacement kills that provider while the configuration stays enabled, and
  // new connections then wait for a verdict nobody will give: measured 2026-09-02, the Mac's own
  // traffic timed out and only a restart brought it back. Disabling first means that state never
  // exists. What is left is the window while the filter comes back up, measured the same day across
  // ~300 probes: about four seconds of raised latency (10-30ms to 200-400ms) and **no failures**,
  // because the kernel passes traffic a provider has not applied settings for yet.
  //
  // **After the copy, not before it, and that ordering is the whole of two separate defects.**
  // `ditto` writes `/Applications`; the running provider executes out of `/Library/SystemExtensions`,
  // which is why macOS goes on filtering for an app someone deleted (`doctor` has a check for exactly
  // that state). So the copy cannot disturb anything, and only the activation can.
  //
  // Disabling first instead meant asking whatever binary happened to be installed. That is wrong in
  // both directions. A build older than the flag does not refuse it — every unrecognised argument fell
  // through to `.configure`, which writes `isEnabled = true` — so the request to switch the filter off
  // switched it on and answered 0. And when the app had been deleted there was no binary to ask at
  // all, while the extension it belonged to was still activated and enforcing, so the replace went
  // ahead with the filter up. Asking the binary this package shipped removes both: it is the one that
  // understands the flag, and it is there because the line above put it there.
  //
  // `--install` turns it back on by itself: with no `--add`/`--remove` it takes `clearAll`, and
  // `configureFilter` ends with `isEnabled = true`. So there is no re-enable step to forget.
  const off = spawnSync(join(NET_FILTER_APP, 'Contents', 'MacOS', 'TapflowNetFilter'), ['--off'], {
    encoding: 'utf8', timeout: OFF_TIMEOUT_MS,
  })
  // **Stop rather than continue.** A disable that did not take leaves the filter enabled, which is
  // exactly the state the activation must not meet. The copy has landed but nothing is activated yet,
  // so stopping costs an upgrade and continuing costs the Mac's network.
  if (!off || off.status !== 0) {
    return {
      status: 'failed',
      code: off?.status ?? -1,
      detail: hostLogTail() || (off?.stderr || '').trim()
        || 'could not switch the filter off before replacing it',
      filterLeftDisabled: false,
    }
  }

  const run = spawnSync(join(NET_FILTER_APP, 'Contents', 'MacOS', 'TapflowNetFilter'), ['--install'], {
    encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS,
  })
  if (!run) {
    return { status: 'failed', code: -1, detail: 'the filter host did not run', filterLeftDisabled: true }
  }
  switch (run.status) {
    // **Exit 0 is "nothing refused", which is smaller than "it works"** — `Host/main.swift` says so
    // itself. The framework hands the configuration to the provider afterwards with nothing coming
    // back, and this run has just switched the filter off on the strength of that report. So the last
    // thing it does is look.
    // **From a baseline, not from freshness.** The heartbeat this is waiting for has to have been
    // written after the activation returned; the previous provider's last one can still be inside the
    // freshness window, and reading it would report success over a Mac where nothing came back.
    //
    // The second is exclusive, so a provider that came up inside the same second waits one more —
    // cheaper than the ambiguity, since the file only carries whole seconds.
    case 0: return waitForEnforcing(opts.confirmDeadlineMs ?? CONFIRM_DEADLINE_MS, Math.floor(Date.now() / 1000))
      ? { status: 'installed' }
      : { status: 'installed-unconfirmed' }
    // **Approval and reboot differ in whether the filter came back**, which is why only one of them
    // carries the flag. The approval path dies before `configureFilter` runs, so the filter is still
    // off; the reboot path runs it — deliberately, since this binary is the only way a device is put
    // back online — so the filter is on and the *old* provider is enforcing until the restart.
    case EXIT_APPROVAL_TIMEOUT: return { status: 'needs-approval', filterLeftDisabled: true }
    case EXIT_NEEDS_REBOOT: return { status: 'needs-reboot' }
    default:
      return {
        status: 'failed',
        code: run.status ?? -1,
        detail: hostLogTail() || (run.stderr || '').trim() || `exit ${run.status}`,
        filterLeftDisabled: true,
      }
  }
}

/**
 * Wait for a provider to start enforcing, or give up.
 *
 * **Reading the heartbeat rather than asking over `--confirm`**, and the reason is agreement rather
 * than cost. `doctor ios` answers "is it running" from `isFilterEnforcing`, and two commands
 * answering one question from two sources eventually answer it differently — the same shape as
 * comparing a host version against an extension one. It is also a file read, so it cannot change the
 * Mac, which is not nothing on a path whose neighbours run a binary that once erased a rule when
 * handed a flag it did not know.
 *
 * `Atomics.wait` on a throwaway buffer, not a busy loop: this module is synchronous all the way up to
 * two commands that are synchronous themselves, and making it async to sleep would mean making
 * `installNetFilter`, `setUpNetFilter` and `cmdMigrateNetFilter` async for a pause.
 */
function waitForEnforcing(deadlineMs: number, since: number): boolean {
  const until = Date.now() + deadlineMs
  for (;;) {
    if (isFilterEnforcing(Date.now(), since)) return true
    if (Date.now() >= until) return false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CONFIRM_POLL_MS)
  }
}

/** The host binary logs its own exit reason; a bare code says which preference failed but not what the
 *  framework said about it. Best-effort — the log is not load-bearing. */
function hostLogTail(): string {
  try {
    const lines = readFileSync('/tmp/tapflow-netfilter-host.log', 'utf8').trim().split('\n')
    return lines.slice(-1)[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * Put the executable bit back on everything under a `Contents/MacOS` inside the bundle.
 *
 * **Measured, not defensive.** A tarball does not have to carry file modes, and pnpm's does not: the
 * app arrives from the registry with its binaries at `rw-r--r--`, and `ditto` faithfully copies that
 * into `/Applications`, where `--install` then fails to execute. The package's `postinstall` chmods
 * `bin/` one level deep, which for a bundle sets the mode of the *directory* and never reaches
 * `Contents/MacOS/` — so the five flat helpers beside it are covered and this is not.
 *
 * Done here rather than only in `postinstall` because that script does not always run: `--ignore-scripts`
 * is a normal thing for a CI install to pass.
 *
 * Changing the mode does not disturb the signature: code signing seals contents, and `codesign
 * --verify --deep --strict` and `stapler validate` both still pass afterwards (measured).
 */
function restoreExecutableBits(appPath: string): void {
  const walk = (dir: string, inMacOS: boolean): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    // A listing that is not a listing — an unreadable directory, or a stubbed `fs` — is nothing to
    // walk. Trusting the shape here turns a missing directory into a TypeError three frames away.
    if (!Array.isArray(entries)) return
    for (const name of entries) {
      const p = join(dir, name)
      let isDir: boolean
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(p, inMacOS || name === 'MacOS')
      else if (inMacOS) {
        try {
          chmodSync(p, 0o755)
        } catch {
          // Best effort. A file we cannot chmod is one `--install` will report on with a real code.
        }
      }
    }
  }
  walk(appPath, false)
}
