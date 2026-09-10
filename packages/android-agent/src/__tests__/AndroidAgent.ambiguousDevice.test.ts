// A session-less entry point refuses when it cannot tell which device is meant (#617).
//
// **The fix existed on the other platform and was never applied here.** `IOSAgent.soleOf` has thrown
// on ambiguity since #607, with the reason written beside it: *"Refusing beats guessing: this
// interface has no way to say which device is meant, and picking one silently is the whole defect
// being fixed here."* `AndroidAgent` hand-rolled `deviceStates.values().next().value` in eleven
// places instead — the entry the relay happened to register first.
//
// For a read that answers about the wrong device. For `setNetworkOffline` it takes a device off the
// network while somebody else is testing on it, which is what #617 was filed about.
//
// **Two live devices is the state under test, and it is ordinary**: one Mac, one agent, two emulators
// launched. The relay opens a session per device, so `deviceStates` holds two entries and both have a
// serial.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AndroidAgent } from '../AndroidAgent'
import { AdbWrapper } from '../AdbWrapper'
import type { AdbRunner } from '../adb'

/** The internals these tests seed — the relay would, over a socket this test does not open. */
interface Internals {
  deviceStates: Map<string, { sessionId: string; deviceId: string; touchHelper: unknown }>
  ownedDevices: Set<string>
}
const internals = (agent: AndroidAgent) => agent as unknown as Internals

function adbWith(devices: Array<{ deviceId: string; serial: string | null }>): AdbWrapper {
  const runner: AdbRunner = {
    exec: vi.fn().mockResolvedValue(''),
    execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    listAvds: vi.fn().mockResolvedValue([]),
  }
  const adb = new AdbWrapper(runner)
  vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
  for (const d of devices) if (d.serial) adb.setSerial(d.deviceId, d.serial)
  return adb
}

/**
 * An agent holding `n` registered devices, the first `live` of them attached to adb, and `owned` of
 * those launched by tapflow itself.
 *
 * The two are genuinely different: `AdbWrapper.listDevices` syncs the serial map from `adb devices`
 * on every call, so a developer's own emulator has a serial too. `owned` defaults to none, which is
 * the state the refusal tests want.
 */
function agentWith(n: number, live: number, owned = 0) {
  const devices = Array.from({ length: n }, (_, i) => ({
    deviceId: `avd:Device_${i}`,
    serial: i < live ? `emulator-55${i}${i}` : null,
  }))
  const adb = adbWith(devices)
  const agent = new AndroidAgent({}, adb)
  const states = internals(agent).deviceStates
  devices.forEach((d, i) => {
    states.set(`session-${i}`, { sessionId: `session-${i}`, deviceId: d.deviceId, touchHelper: null })
    if (i < owned) internals(agent).ownedDevices.add(d.deviceId)
  })
  return { agent, adb, devices }
}

describe('AndroidAgent — a session-less entry point cannot choose between devices', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('refuses rather than picking one, and says how many it found', async () => {
    const { agent } = agentWith(2, 2)
    await expect(agent.screenshot()).rejects.toThrow(/2 booted devices/)
  })

  it('refuses the write #617 was filed about', async () => {
    // The one that matters most: this is not answering about the wrong device, it is taking somebody
    // else's device off the network while they are using it.
    const { agent } = agentWith(2, 2)
    await expect(agent.setNetworkOffline(true)).rejects.toThrow(/cannot choose between them/)
  })

  it('still works with one live device', async () => {
    // **The control.** Without it every assertion above passes on an entry point that always throws,
    // which would take the feature out rather than make it honest.
    const { agent, adb } = agentWith(2, 1)
    const shot = Buffer.from('png')
    vi.spyOn(adb, 'screenshot').mockResolvedValue(shot)
    await expect(agent.screenshot()).resolves.toBe(shot)
  })

  it('counts a registered-but-never-launched device as absent, not as a rival', async () => {
    // `deviceStates` holds one entry per *registered* device and a Mac reports every AVD it has. If
    // registration counted as liveness, a second AVD nobody booted would make every entry point
    // refuse — the feature removed by its own fix. What separates them is the
    // liveness `AdbWrapper` actually provides: `adb devices` reports it attached.
    const { agent, adb } = agentWith(4, 1)
    vi.spyOn(adb, 'screenshot').mockResolvedValue(Buffer.from('png'))
    await expect(agent.screenshot()).resolves.toBeInstanceOf(Buffer)
  })

  it('keeps saying "no booted device" when none is live', async () => {
    const { agent } = agentWith(2, 0)
    await expect(agent.screenshot()).rejects.toThrow(/no booted device/)
  })

  it('leaves the touch entry points no-opping rather than throwing when nothing is live', () => {
    // They have always been silent without a device, and the ambiguity fix must not smuggle in a
    // second behaviour change: `touchStart` returns `void`, so a throw is the only signal it could
    // give, and giving one here would break a caller that has always been allowed to tap early.
    const { agent } = agentWith(2, 0)
    expect(() => agent.touchStart(1, 1)).not.toThrow()
  })

  it('still refuses a touch it cannot aim', () => {
    const { agent } = agentWith(2, 2)
    expect(() => agent.touchStart(1, 1)).toThrow(/cannot choose between them/)
  })

  it('prefers the device tapflow launched over one that was already there', async () => {
    // **The common desk, and the reason the refusal is not enough on its own.** `adb devices` reports
    // a developer's own emulator exactly like tapflow's, and `AdbWrapper` syncs the serial map from
    // it on every `listDevices()` — so "has a serial" is two devices here and one obvious answer.
    // `IOSAgent.soleLiveDeviceState` narrows the same way, after a version that did not made every
    // caller refuse on a two-simulator desk.
    const { agent, adb, devices } = agentWith(2, 2, 1)
    const shot = Buffer.from('png')
    const spy = vi.spyOn(adb, 'screenshot').mockResolvedValue(shot)
    await expect(agent.screenshot()).resolves.toBe(shot)
    expect(spy.mock.calls[0]?.[0], 'it answered for the emulator tapflow did not launch')
      .toBe(adb.getSerial(devices[0]!.deviceId))
  })

  it('still refuses when tapflow launched both', async () => {
    // **The control for the narrowing.** Without it the test above passes on a resolver that simply
    // takes the first owned device, which is the silent pick this whole change removes.
    const { agent } = agentWith(2, 2, 2)
    await expect(agent.screenshot()).rejects.toThrow(/2 booted devices/)
  })

  it('refuses on every entry point, not only the ones with their own test', async () => {
    // Eleven members share the resolver and three had assertions. `stream()` is the one that most
    // needed one: it is the only member the change gave hand-written resolution to, and it had no
    // test anywhere in this package — so a version that picked a device by scanning for a video
    // source would have been green everywhere.
    const { agent } = agentWith(2, 2)
    const ambiguous = /cannot choose between them/
    await expect(agent.installApp('/tmp/x.apk')).rejects.toThrow(ambiguous)
    await expect(agent.launchApp('com.example')).rejects.toThrow(ambiguous)
    await expect(agent.queryUITree()).rejects.toThrow(ambiguous)
    await expect(agent.openUrl('https://example.com')).rejects.toThrow(ambiguous)
    await expect(agent.networkState()).rejects.toThrow(ambiguous)
    await expect(agent.touchMove(1, 1)).rejects.toThrow(ambiguous)
    await expect(agent.touchEnd()).rejects.toThrow(ambiguous)
    expect(() => agent.stream()).toThrow(ambiguous)
  })

  it('leaves `sessionId` answering, because a read is not the risk this fixes', () => {
    // Deliberate, and #617 says so itself: the worst case for a read is answering about the wrong
    // device. It also answers *before* a device is chosen, so refusing would turn "which session am I
    // on" into an error on a healthy two-emulator Mac. `IOSAgent.sessionId` is identical.
    const { agent } = agentWith(2, 2)
    expect(agent.sessionId).toBe('session-0')
  })
})
