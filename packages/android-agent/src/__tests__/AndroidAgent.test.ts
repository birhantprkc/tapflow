import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../AndroidTouchHelper', () => ({
  AndroidTouchHelper: vi.fn(function () { return ({
    start: vi.fn(),
    stop: vi.fn(),
    touchStart: vi.fn(),
    touchMove: vi.fn(),
    touchEnd: vi.fn(async () => 'delivered'),
    pinchStart: vi.fn(() => 'unsupported'),
    pinchMove: vi.fn(() => 'unsupported'),
    pinchEnd: vi.fn(() => 'unsupported'),
    pressButton: vi.fn(async () => 'delivered'),
  }) }),
}))

// Shared state for per-test stream control (captured by inner factory closure)
let scrcpyCloseOnCreate = false
let scrcpyStartError: Error | null = null
let scrcpyStreamController: ReadableStreamDefaultController<ScrcpyFrame> | null = null

vi.mock('../scrcpy/ScrcpySession', () => ({
  ScrcpySession: vi.fn(function () { return ({
    start: vi.fn().mockImplementation(() => {
      const err = scrcpyStartError
      scrcpyStartError = null
      return err
        ? Promise.reject(err)
        : Promise.resolve({ deviceName: 'TestDevice', width: 1080, height: 2400 })
    }),
    stop: vi.fn(),
    video: {
      start: vi.fn(() => new ReadableStream<ScrcpyFrame>({
        start(c) {
          scrcpyStreamController = c
          if (scrcpyCloseOnCreate) c.close()
        },
      })),
    },
    control: {
      isReady: vi.fn(() => true),
      touchDown: vi.fn(),
      touchMove: vi.fn(),
      touchUp: vi.fn(),
      pinchStart: vi.fn(),
      pinchMove: vi.fn(),
      pinchEnd: vi.fn(),
      resetVideo: vi.fn(),
    },
  }) }),
}))

vi.mock('../EmulatorLauncher', () => ({
  EmulatorLauncher: vi.fn(function () { return ({
    launch: vi.fn(),
    findSerial: vi.fn().mockResolvedValue('emulator-5554'),
    waitForBoot: vi.fn().mockResolvedValue(undefined),
    waitForExit: vi.fn().mockResolvedValue(undefined),
  }) }),
  findEmulatorPid: vi.fn(() => null),
  // The boot path probes rather than asking for a pid, because it has to tell "not running" from
  // "could not look" (#447 review). Default: nothing running, and we could see that.
  probeEmulator: vi.fn(() => ({ state: 'gone' as const })),
  stopEmulatorProcess: vi.fn(() => true),
}))
// Shared macOS host-mute helper (#341). Off by default in tests (isAudioSupported → false → no-op);
// the host-mute test overrides these to assert the mute tap launches.
vi.mock('@tapflowio/audiotap-helper', () => ({
  isAudioSupported: vi.fn(() => false),
  ensureHelperApp: vi.fn(() => '/fake/audiotap-helper.app'),
  launchMuteOnlyTap: vi.fn(),
}))

// gRPC backend mocks (emulator host-encode path). Inert for the scrcpy-pinned tests; exercised by
// the 'gRPC backend' describe, which unpins TAPFLOW_ANDROID_BACKEND.
let grpcStartError: Error | null = null
let grpcFramesController: ReadableStreamDefaultController<ScrcpyFrame> | null = null

// Guest clipboard the mocked emulator reports back (clipboard bridge tests drive these).
let grpcClipboardText = ''
let grpcClipboardError: Error | null = null
// How long the emulator takes to actually apply a setClipboard (the proto says it is scheduled
// on the main looper, so "resolved" != "applied").
let grpcClipboardApplyDelayMs = 0

vi.mock('../emulator/EmulatorGrpcClient', () => ({
  EmulatorGrpcClient: vi.fn(function () { return ({
    isReady: vi.fn(() => true),
    close: vi.fn(),
    touchDown: vi.fn(), touchMove: vi.fn(), touchUp: vi.fn(),
    pinchStart: vi.fn(), pinchMove: vi.fn(), pinchEnd: vi.fn(),
    streamAudio: vi.fn(() => ({ frames: () => new ReadableStream({ start() {} }), cancel: vi.fn() })), // AudioStream shape: { frames, cancel }
    getClipboard: vi.fn(() => grpcClipboardError
      ? Promise.reject(grpcClipboardError)
      : Promise.resolve(grpcClipboardText)),
    setClipboard: vi.fn(async (text: string) => {
      if (grpcClipboardError) throw grpcClipboardError
      // The proto documents this as scheduling, not applying — model that so the read path
      // cannot get away with assuming the sentinel is visible the moment this resolves.
      const apply = () => { grpcClipboardText = text }
      if (grpcClipboardApplyDelayMs > 0) setTimeout(apply, grpcClipboardApplyDelayMs)
      else apply()
    }),
  }) }),
}))

vi.mock('../emulator/EmulatorVideo', () => ({
  EmulatorVideo: vi.fn(function () { return ({
    start: vi.fn().mockImplementation(() => {
      const err = grpcStartError
      grpcStartError = null
      return err
        ? Promise.reject(err)
        : Promise.resolve({ width: 1080, height: 2400, cornerRadius: 0 })
    }),
    frames: vi.fn(() => new ReadableStream<ScrcpyFrame>({ start(c) { grpcFramesController = c } })),
    requestIdr: vi.fn(),
    stop: vi.fn(),
  }) }),
}))

import { WebSocket, WebSocketServer } from 'ws'
import { RelayServer, initDb, closeDb } from '@tapflowio/relay'
import { hasEnvelope, readEnvelopeFlags, CODEC_H264, CODEC_JPEG } from '@tapflowio/agent-core/utils'
import { AndroidAgent, pickAndroidBackend, parseSpsFromNal } from '../AndroidAgent'
import { AdbWrapper } from '../AdbWrapper'
import { ScrcpySession } from '../scrcpy/ScrcpySession'
import { EmulatorVideo } from '../emulator/EmulatorVideo'
import { EmulatorGrpcClient } from '../emulator/EmulatorGrpcClient'
import { findEmulatorPid, probeEmulator, stopEmulatorProcess } from '../EmulatorLauncher'
import { isAudioSupported, launchMuteOnlyTap } from '@tapflowio/audiotap-helper'
import type { ScrcpyControl } from '../scrcpy/ScrcpyControl'
import type { ScrcpyFrame } from '../scrcpy/ScrcpyVideo'
import type { AdbRunner } from '../adb'
import { barrier, waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'
import type { NetworkError, NetworkState, SessionJoined } from '@tapflowio/protocol'

// Test-only view of a per-device state entry (the real DeviceState is not exported).
interface TestState {
  restarting: boolean
  scrcpySession: { control: ScrcpyControl } | null
  emulatorVideo: unknown | null
  grpcClient: unknown | null
  streamWs: WebSocket | null
  touchHelper: {
    pressButton: ReturnType<typeof vi.fn>
    touchEnd: ReturnType<typeof vi.fn>
    pinchEnd: ReturnType<typeof vi.fn>
  } | null
  videoWidth: number
  videoHeight: number
  landscape: boolean
  booted: boolean
  bootSeq: number
}

// Test-only view of AndroidAgent internals (device state + reconnect fields are private).
interface AndroidAgentInternals {
  ws: WebSocket | null
  adb: AdbWrapper
  deviceStates: Map<string, TestState>
  _stopping: boolean
  _reconnectTimer: ReturnType<typeof setTimeout> | null
  _reconnectAttempt: number
  _scheduleReconnect(): void
  restartVideoStream(state: TestState): Promise<void>
  cleanupDeviceState(state: TestState): void
  handleRelayMessage(msg: unknown): void
}
const internals = (agent: AndroidAgent): AndroidAgentInternals =>
  agent as unknown as AndroidAgentInternals

function mockAdb(booted = false): AdbWrapper {
  const runner: AdbRunner = {
    exec: vi.fn().mockResolvedValue(''),
    execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    listAvds: vi.fn().mockResolvedValue(['Pixel_8_API_34']),
  }
  const adb = new AdbWrapper(runner)
  // Every boot reports network state (#607), so without this the real `AdbWrapper.airplaneMode`
  // parses `''`, throws, and each of the ~27 boot tests silently runs the degraded
  // `unsupported-device` path — a default device that is a device tapflow cannot steer. The
  // network tests spy over this; everyone else just gets a device that is on the network.
  vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
  if (booted) adb.setSerial('avd:Pixel_8_API_34', 'emulator-5554')
  vi.spyOn(adb, 'listDevices').mockResolvedValue([{
    id: 'avd:Pixel_8_API_34',
    name: 'Pixel_8_API_34',
    platform: 'android',
    status: booted ? 'booted' : 'shutdown',
    osVersion: booted ? 'Android 14' : undefined,
  }])
  return adb
}


describe('AndroidAgent', () => {
  let relay: RelayServer
  let port: number
  let tmpDir: string
  const prevBackend = process.env.TAPFLOW_ANDROID_BACKEND

  beforeAll(() => {
    // These tests exercise the scrcpy backend; pin it so the emulator serial doesn't auto-select
    // the gRPC path (which would spawn a real encoder / hit 127.0.0.1:8554 and be environment-flaky).
    process.env.TAPFLOW_ANDROID_BACKEND = 'scrcpy'
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-android-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    if (prevBackend === undefined) delete process.env.TAPFLOW_ANDROID_BACKEND
    else process.env.TAPFLOW_ANDROID_BACKEND = prevBackend
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    relay = new RelayServer({ port: 0 })
    await relay.start()
    port = (relay.address() as { port: number }).port
  })

  afterEach(async () => {
    await relay.stop()
  })

  describe('connect', () => {
    it('sends agent:register with platform:android', async () => {
      const adb = mockAdb()
      const agent = new AndroidAgent({}, adb)
      const relayWs = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(relayWs)

      const registerPromise = waitForType(relayWs, 'agent:register')
        .catch(() => null) // relay processes it internally — listen via agents:list instead

      await agent.connect(`ws://localhost:${port}`)
      relayWs.send(JSON.stringify({ type: 'agents:list' }))
      const listed = await waitForType(relayWs, 'agents:listed')
      const sessions = listed['sessions'] as Array<{ agentName: string; devices: unknown[] }>
      expect(sessions).toHaveLength(1)
      expect(sessions[0].devices).toHaveLength(1)

      agent.disconnect()
      relayWs.close()
      void registerPromise
    })

    it('registers one session per device', async () => {
      const adb = mockAdb()
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)
      expect(agent.sessionId).toBeTruthy()
      agent.disconnect()
    })

    it('holds a power assertion while connected (acquire on connect, release on disconnect)', async () => {
      const adb = mockAdb()
      const sleepBlocker = { acquire: vi.fn(), release: vi.fn() }
      const agent = new AndroidAgent({ sleepBlocker }, adb)
      await agent.connect(`ws://localhost:${port}`)
      expect(sleepBlocker.acquire).toHaveBeenCalled()
      expect(sleepBlocker.release).not.toHaveBeenCalled()
      agent.disconnect()
      expect(sleepBlocker.release).toHaveBeenCalled()
    })
  })

  describe('device:boot flow', () => {
    it('sends device:booting then device:ready', async () => {
      const adb = mockAdb(false)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-1',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))

      await waitForType(browser, 'device:booting')
      const ready = await waitForType(browser, 'device:ready')
      expect(ready['payload']).toMatchObject({ deviceId: 'avd:Pixel_8_API_34' })

      agent.disconnect()
      browser.close()
    })

  })

  // ── #607: network on/off, via airplane mode ────────────────────────────────────────────────
  describe('network control', () => {
    let agent: AndroidAgent
    let adb: AdbWrapper
    let browser: WebSocket

    /**
     * A device whose airplane mode reads as `initial` and follows what it is told.
     *
     * The doubles mirror the real wrapper's contract: `setAirplaneMode` **returns** what it
     * observed rather than throwing when it cannot confirm. An earlier version had the write
     * resolve while the read rejected — a combination the real wrapper cannot produce, since it
     * calls the read itself, so the test was pinning an unreachable path.
     */
    function withAirplane(initial = false, setBehaviour?: (on: boolean) => void) {
      adb = mockAdb(true)
      let state = initial
      vi.spyOn(adb, 'airplaneMode').mockImplementation(async () => state)
      vi.spyOn(adb, 'setAirplaneMode').mockImplementation(async (_s: string, on: boolean) => {
        setBehaviour?.(on)
        state = on
        return { confirmed: true, offline: on }
      })
      return adb
    }

    async function session(a: AdbWrapper) {
      agent = new AndroidAgent({}, a)
      await agent.connect(`ws://localhost:${port}`)
      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
    }

    const set = (offline: boolean, requestId = 'rq-net') =>
      browser.send(JSON.stringify({
        type: 'network:set', sessionId: agent.sessionId, requestId, payload: { offline },
      }))

    /** Boot, and wait past the unsolicited report the boot itself produces. */
    async function booted() {
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      await waitForType(browser, 'network:state')
    }

    afterEach(() => { agent?.disconnect(); browser?.close() })

    it('takes the device offline and answers with the state', async () => {
      await session(withAirplane(false))
      set(true)
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(adb.setAirplaneMode).toHaveBeenCalledWith('emulator-5554', true)
      expect(state.requestId).toBe('rq-net')
      expect(state.payload).toEqual({ offline: true, available: true })
    })

    it('puts it back', async () => {
      await session(withAirplane(true))
      set(false)
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(adb.setAirplaneMode).toHaveBeenCalledWith('emulator-5554', false)
      expect(state.payload).toEqual({ offline: false, available: true })
    })

    // Cleanup runs at **boot**, not at session end. Airplane mode lives in the AVD's userdata, so
    // it outlives `emu kill` — and a session that ended in a crash, a closed terminal or `dev:down`
    // never reaches a teardown path at all. Clearing on the way up is the only version that
    // survives however the last session died. Same conclusion the iOS half reached for its
    // condition file, for the same reason.
    it('clears a device left offline by whoever had it last', async () => {
      const a = withAirplane(true)
      await session(a)
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      // Barrier first, then read the recording — the reset runs after `device:ready` goes out.
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(a.setAirplaneMode).toHaveBeenCalledWith('emulator-5554', false)
      expect(state.payload).toEqual({ offline: false, available: true })
    })

    // The boot path's own version of the blocker above. The reset reads the device, fails to
    // clear it, and then reports — and if that second read fails too, the fact it already learned
    // must survive into the report. Dropping it renders "online" over a device the agent just
    // established is offline.
    it('carries what the reset learned into the report when the re-read fails', async () => {
      const a = mockAdb(true)
      let reads = 0
      vi.spyOn(a, 'airplaneMode').mockImplementation(async () => {
        if (++reads > 1) throw new Error('cannot read')
        return true                                  // left offline by whoever had it last
      })
      vi.spyOn(a, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
      await session(a)

      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    // The boot reset **writes to the device**, so it has to answer to `bootSeq` like every other
    // await in that path. The window is a real one: the read below is an adb round trip, and a
    // tester whose device just went ready can arm the toggle inside it — after which a superseded
    // boot waking up would put them back online with nobody having asked.
    it('abandons the boot-time reset when a newer boot supersedes it', async () => {
      const a = mockAdb(true)
      // One resolver per call, kept in order — a single slot would be overwritten by the second
      // boot's own read, and releasing that would wake the *current* reset rather than the
      // superseded one, which is a different test that would pass for the wrong reason.
      const parked: Array<() => void> = []
      vi.spyOn(a, 'airplaneMode').mockImplementation(
        () => new Promise((r) => { parked.push(() => r(true)) }),
      )
      const setSpy = vi.spyOn(a, 'setAirplaneMode').mockResolvedValue({ confirmed: true, offline: false })
      await session(a)

      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-1', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      await vi.waitFor(() => expect(parked.length).toBe(1))

      // A second boot bumps the seq while the first reset is parked on its read.
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-2', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')

      await vi.waitFor(() => expect(parked.length).toBe(2))
      setSpy.mockClear()
      parked[0]!()                   // the superseded reset wakes up holding "device is offline"
      await new Promise((r) => setTimeout(r, 50))

      expect(setSpy).not.toHaveBeenCalled()
    })

    // The control. Without it, an implementation that flips airplane mode on every boot passes the
    // two above — and takes a tester's device off the network with nobody having asked. It also
    // pins that the clear above is conditional: a device already online is left alone.
    it('touches airplane mode for nothing else', async () => {
      const a = withAirplane(false)
      await session(a)
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      // `device:ready` is the trigger's echo, not a barrier — the reset is dispatched with `void`
      // on the line after it. Its own last act is this report, so waiting for it is what puts the
      // absence assertion after the work rather than beside it.
      await waitForType(browser, 'network:state')

      expect(a.setAirplaneMode).not.toHaveBeenCalled()
    })

    // A device that cannot do this is **answering**, not failing: `network:state` with a reason the
    // viewer can render, never `network:error`. The two are told apart by the test below.
    //
    // The reason is `state-unconfirmed` and not `unsupported-device`, even though the error here is
    // literally an image without the command: a write that threw is also what a rebooting device and
    // a dropped adb connection produce, and nothing in the failure tells them apart (#618). Calling
    // it permanent would tell a tester to give up on a device that is coming back in twenty seconds.
    it('reports a write that threw as unconfirmed rather than as a dead image', async () => {
      const a = withAirplane(false, () => { throw new Error('cmd: not found') })
      await session(a)
      set(true)
      const state = await waitForType<NetworkState>(browser, 'network:state')

      // `toEqual`, not `toMatchObject`: `offline` is the field that carries the truth here, and
      // leaving it unasserted is what let a mutation report the requested value instead of the
      // device's. `reason` too — each value makes a different sentence on screen.
      expect(state.payload).toEqual({ offline: false, available: false, reason: 'state-unconfirmed' })
      expect(state.requestId).toBe('rq-net')
    })

    // …and a device with no session state is a failure, in the shape the request's waiter reads.
    it('answers network:error when there is no booted device', async () => {
      adb = mockAdb(false)
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: true, offline: true })
      await session(adb)
      set(true)
      const err = await waitForType<NetworkError>(browser, 'network:error')

      expect(err.requestId).toBe('rq-net')
      expect(err.message.length).toBeGreaterThan(0)
      expect(adb.setAirplaneMode).not.toHaveBeenCalled()
    })

    // The first of the three unsolicited producers the protocol names. Without it a viewer that
    // opens a session has no idea whether the device it is looking at is on the network.
    it('reports the state unsolicited once the device is ready', async () => {
      const a = withAirplane(false)
      await session(a)
      browser.send(JSON.stringify({
        type: 'device:boot', requestId: 'rq-b', sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')

      const state = await waitForType<NetworkState>(browser, 'network:state')
      expect(state.requestId).toBeUndefined()
      expect(state.payload).toEqual({ offline: false, available: true })
    })

    // It reads the device, not a flag the agent kept. An agent that remembers what it last set
    // cannot see a device someone else changed, or one left offline across an agent restart.
    it('reads the device rather than its own memory', async () => {
      const a = withAirplane(true)
      await session(a)
      set(true)
      await waitForType(browser, 'network:state')

      expect(a.airplaneMode).toHaveBeenCalledWith('emulator-5554')
    })

    // **The blocker this review found.** The wrapper writes first and confirms second, so a
    // confirmation that fails leaves a device that has probably already changed. Reporting the
    // pre-write value there renders "online" over an offline device — a tester signs off offline
    // behaviour they never saw, and the bug goes to the app under test. `offline` here is what the
    // wrapper observed, never what the caller had before.
    it('reports the device as offline when the write landed but could not be confirmed', async () => {
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: false, offline: true })
      await session(adb)

      set(true)
      const state = await waitForType<NetworkState>(browser, 'network:state')
      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    // The mirror, and **the pair is the discriminator** (#618). Both results are `confirmed: false`
    // and the shapes are identical, so what separates them is where `offline` sits: the test above
    // returns the value that was *requested*, which is what `setAirplaneMode` reports when the
    // read-back itself failed — nothing was observed, so `state-unconfirmed`. This one returns a
    // value that disagrees with the request, which means the read-back *succeeded* and the device had
    // not moved. Only that is an image which does not really support the command.
    //
    // Changing either `offline` here breaks the classification, not just the assertion.
    it('reports the device as online when the command was accepted and did nothing', async () => {
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: false, offline: false })
      await session(adb)

      set(true)
      const state = await waitForType<NetworkState>(browser, 'network:state')
      expect(state.payload).toEqual({ offline: false, available: false, reason: 'unsupported-device' })
    })

    // A write that never reached the device leaves the before-state true, and that is the one case
    // where reporting it is right. The reason is `state-unconfirmed` for the same reason as above:
    // a throw from the write says nothing about whether the device could ever do this.
    it('keeps the pre-request state when the write itself failed', async () => {
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockResolvedValue(true)     // device was already offline
      vi.spyOn(adb, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
      await session(adb)

      set(false)
      const state = await waitForType<NetworkState>(browser, 'network:state')
      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    // ── #614: the relay asks on a viewer's re-join ──────────────────────────────────────────
    //
    // Injected rather than sent from `browser`, because this frame travels relay → agent and the
    // browser socket is not that direction.
    const requestState = (sessionId = agent.sessionId) =>
      internals(agent).handleRelayMessage({ type: 'network:request-state', sessionId })

    it('reports what the device says when the relay asks on a re-join', async () => {
      const a = withAirplane(false)
      await session(a)
      await booted()
      // Taken offline *after* booting: the boot path clears a condition the last session left, so a
      // device cannot still be offline the moment it is ready. Asserting the value a fresh boot
      // happens to produce would pass on a report that read nothing at all.
      set(true)
      await waitForType(browser, 'network:state')

      requestState()
      const state = await waitForType<NetworkState>(browser, 'network:state')

      // No correlator: a report, not an answer. `toBe(undefined)` rather than a falsy check —
      // `requestId: ''` would render a reply nobody can match and pass a looser assertion.
      expect(state.requestId).toBe(undefined)
      expect(state.sessionId).toBe(agent.sessionId)
      expect(state.payload).toEqual({ offline: true, available: true })
    })

    it('reads the device again rather than replaying what it reported before', async () => {
      // The whole point of asking the agent instead of caching in the relay. If this replayed a
      // remembered value, the relay could have kept it and #614 would have had a cheaper answer.
      const a = withAirplane(false)
      await session(a)
      await booted()

      vi.mocked(a.airplaneMode).mockResolvedValue(true)   // changed outside tapflow
      requestState()
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ offline: true, available: true })
    })

    it('says nothing at all when the session holds no booted device', async () => {
      // Not `network:error`: nobody asked, so there is no requester to address one to. The relay
      // gates on `readySent`, so this is the window where its view and the agent's disagree.
      //
      // Mutation: answering `network:error` here fails, provided the mutant gives it a usable
      // correlator. One written with `requestId: ''` survives — but the relay's door refuses that
      // frame before the browser ever sees it, so what survives is a mutation the wire already
      // prevents, not a gap in this assertion.
      adb = mockAdb(false)
      await session(adb)

      requestState()
      // Barrier: a correlated round trip the agent *does* answer. Its reply cannot arrive before a
      // reply the dispatcher made for the earlier frame, so reading after it is reading after both.
      browser.send(JSON.stringify({
        type: 'network:set', sessionId: agent.sessionId, requestId: 'rq-barrier', payload: { offline: true },
      }))
      const err = await waitForType<NetworkError>(browser, 'network:error')

      expect(err.requestId).toBe('rq-barrier')
      expect(adb.airplaneMode).not.toHaveBeenCalled()
    })

    it('falls back to the last value it saw, not to online, when the re-read fails', async () => {
      // `NetworkNotSteerable.offline` is declared "still the device's real state". The re-join report
      // is the first producer with no freshly measured value to pass — the boot path and `network:set`
      // both hand over something they just read — so without a remembered one it would answer
      // `offline: false` for a device that is offline and momentarily unreadable.
      //
      // Mutation: defaulting `lastKnownOffline` to `false` reads `offline: false` here.
      const a = withAirplane(false)
      await session(a)
      await booted()

      set(true)
      await waitForType(browser, 'network:state')       // now known-offline, confirmed
      vi.mocked(a.airplaneMode).mockRejectedValue(new Error('device offline'))

      requestState()
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    it('does not let an unconfirmed write overwrite what it confirmed earlier', async () => {
      // Standing one guess on another: an unconfirmed write already reports a value it could not
      // verify, and letting that become the fallback would outlive the read it stood in for.
      //
      // The earlier confirmed value is what makes this readable — without it both behaviours end in
      // the silence below, and the test could not tell them apart.
      //
      // Mutation: dropping `result.confirmed` from the store reads `offline: false` here.
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: true, offline: true })
      await session(adb)

      set(true)
      await waitForType(browser, 'network:state')      // confirmed offline — this is what it knows
      // The fake device follows its own write. `confirmed: true` *means* the read-back agreed, so a
      // read that goes on answering `false` afterwards is a device that cannot exist — and the write
      // path now remembers a successful pre-write read as well, which that contradiction would send
      // backwards for a reason having nothing to do with what this test holds.
      vi.mocked(adb.airplaneMode).mockResolvedValue(true)

      vi.mocked(adb.setAirplaneMode).mockResolvedValue({ confirmed: false, offline: false })
      set(false, 'rq-unconfirmed')
      await waitForType(browser, 'network:state')
      vi.mocked(adb.airplaneMode).mockRejectedValue(new Error('gone'))

      requestState()
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.payload).toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
    })

    it('says nothing when it has never seen the device and cannot read it now', async () => {
      // `false` is not "unknown", it is "on the network" — and `NetworkNotSteerable.offline` is declared
      // to be the device's real state. A boot whose own read failed records nothing, so a tester who
      // then flips airplane mode in the emulator's own UI leaves a device that is offline, unreadable
      // and never observed. Reporting it would claim the one direction that hides the problem.
      //
      // Mutation: falling back to `false` instead of staying silent answers here, and the barrier's
      // reply is then the second `network:state` rather than the first.
      adb = mockAdb(true)
      vi.spyOn(adb, 'airplaneMode').mockRejectedValue(new Error('device offline'))
      vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: true, offline: true })
      await session(adb)

      requestState()
      // Barrier: a correlated request the agent does answer, sent after. Its reply cannot arrive before
      // one the dispatcher made for the earlier frame, so the first `network:state` to land tells us
      // whether the report was sent.
      set(true, 'rq-barrier')
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.requestId).toBe('rq-barrier')
    })

    // Injected past the relay, which is the only way to reach these: its schema requires
    // `payload.offline` and refuses the frame itself, so a browser cannot produce one. That door
    // is not the agent's, though — inbound is unvalidated here (#444), and the dispatch swallows a
    // synchronous throw, so a cast through a missing payload would answer *nothing* and leave the
    // requester on its own timeout. Same reason `input:button` destructures defensively.
    for (const [label, payload] of [
      ['no payload', undefined],
      ['a payload with no offline', {}],
      ['a non-boolean offline', { offline: 'true' }],
    ] as const) {
      it(`answers network:error for a network:set with ${label}`, async () => {
        await session(withAirplane(false))
        const errored = waitForType<NetworkError>(browser, 'network:error')
        internals(agent).handleRelayMessage({
          type: 'network:set', sessionId: agent.sessionId, requestId: 'rq-bad', payload,
        })

        const err = await errored
        expect(err.requestId).toBe('rq-bad')
        // Not just *an* error: the no-device case at the top of `handleNetworkSet` sends the same
        // label, and the two are a different fix for the tester. The message is the only thing
        // that separates them, so collapsing the guard into that path has to fail here.
        expect(err.message).toContain('offline')
        expect(adb.setAirplaneMode).not.toHaveBeenCalled()
      })
    }

    // A reply carrying `requestId: ''` correlates to nothing, so sending one would change the
    // device and leave the requester waiting anyway — for a mutation that is the worse half of the
    // trade. `correlatorOf` drops it instead, which is what every other correlated case does.
    //
    // Mutation: replacing `correlatorOf` with the old `msg as unknown as { requestId: string }`
    // cast makes this fail — a `network:state` arrives before the valid request's, with `''` on it.
    it('drops a network:set whose correlator is empty, rather than answering uncorrelatably', async () => {
      const a = withAirplane(false)
      await session(a)
      internals(agent).handleRelayMessage({
        type: 'network:set', sessionId: agent.sessionId, requestId: '', payload: { offline: true },
      })
      // The barrier: a well-formed request sent *after* it. Its reply cannot arrive before one the
      // dispatcher made for the empty frame, so reading here is reading after both were handled.
      set(false, 'rq-after')
      const state = await waitForType<NetworkState>(browser, 'network:state')

      expect(state.requestId).toBe('rq-after')
      expect(a.setAirplaneMode).toHaveBeenCalledTimes(1)
      expect(a.setAirplaneMode).toHaveBeenCalledWith('emulator-5554', false)
    })

    // ── the capability path answers the same question, so it must give the same answer ────────
    //
    // `setNetworkOffline` and `networkState` are the in-process capability, not what `mcp-server`
    // or `flow-runner` call — those address a session over the wire (#617). They had
    // **no test at all**, which is how the doc on `setNetworkOffline` came to record that the two
    // paths "must not disagree… and this one drifted first". A narrowed `unsupported-device` makes a
    // repeat worse than the drift it describes: a caller reading it as permanent would be told a
    // rebooting device can never do this.
    describe('capability path', () => {
      it('classifies an accepted write that did nothing the same as the WS path', async () => {
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
        vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: false, offline: false })
        await session(adb)
        await booted()

        expect(await agent.setNetworkOffline(true))
          .toEqual({ offline: false, available: false, reason: 'unsupported-device' })
      })

      it('classifies a write it could not read back as unconfirmed, not as a dead image', async () => {
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockResolvedValue(false)
        vi.spyOn(adb, 'setAirplaneMode').mockResolvedValue({ confirmed: false, offline: true })
        await session(adb)
        await booted()

        expect(await agent.setNetworkOffline(true))
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('reports a write that threw as unconfirmed, keeping the state it read before', async () => {
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockResolvedValue(true)
        vi.spyOn(adb, 'setAirplaneMode').mockRejectedValue(new Error('exit 255'))
        await session(adb)
        await booted()

        expect(await agent.setNetworkOffline(false))
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('keeps a confirmed offline device offline when both the read and the write fail', async () => {
        // **Two failures in a row, which is the one case that used to drop the memory.** The pre-write
        // read falls back to what was last confirmed and the write then throws, so the answer is
        // whatever the agent last knew — not `false`, which draws an online control over a device
        // whose app can reach nothing and sends the next bug report to the app under test.
        const a = withAirplane(false)
        await session(a)
        await booted()
        expect(await agent.setNetworkOffline(true)).toEqual({ offline: true, available: true })

        vi.mocked(a.airplaneMode).mockRejectedValue(new Error('device offline'))
        vi.mocked(a.setAirplaneMode).mockRejectedValue(new Error('exit 255'))

        expect(await agent.setNetworkOffline(false))
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
        expect(await agent.networkState())
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('refuses to answer for a device it has never observed and cannot read', async () => {
        // **`false` is not "unknown", it is "on the network".** With nothing ever confirmed and the
        // read failing, there is no position to report — and answering `offline: false` claims the one
        // direction that hides the problem. The WS report path stays silent in this state; a function
        // has to answer, so it answers with the failure.
        adb = mockAdb(true)
        vi.spyOn(adb, 'airplaneMode').mockRejectedValue(new Error('device offline'))
        await session(adb)

        await expect(agent.networkState()).rejects.toThrow(/never been observed/)
      })

      it('still answers with the last confirmed value when a read fails', async () => {
        // The other half, and the reason the throw above is narrow: once something *has* been
        // confirmed, an unreadable device is still that value. Reporting it as online is what sends a
        // tester to file against an app that cannot reach anything.
        const a = withAirplane(false)
        await session(a)
        await booted()
        await agent.setNetworkOffline(true)

        vi.mocked(a.airplaneMode).mockRejectedValue(new Error('device offline'))

        expect(await agent.networkState())
          .toEqual({ offline: true, available: false, reason: 'state-unconfirmed' })
      })

      it('answers a confirmed write as steerable', async () => {
        const a = withAirplane(false)
        await session(a)
        await booted()

        expect(await agent.setNetworkOffline(true)).toEqual({ offline: true, available: true })
        expect(await agent.networkState()).toEqual({ offline: true, available: true })
      })
    })
  })

  describe('device:boot flow — full reset', () => {
    // ── #447: Full reset — `-wipe-data`, the counterpart to iOS's `simctl erase` ──────────────

    describe('resetMode: full-erase', () => {
      /** The launcher this agent built, so the flags it was launched with can be read. */
      function launcherOf(agent: AndroidAgent) {
        return (agent as unknown as {
          launcher: {
            launch: ReturnType<typeof vi.fn>
            waitForExit: ReturnType<typeof vi.fn>
          }
        }).launcher
      }

      /** What the emulator will actually be told, not how the caller spelled it. `wipeData` absent
       *  and `wipeData: false` produce the same command line (`buildEmulatorArgs` reads it as
       *  falsy), so asserting the key's presence would fail a refactor that is behaviourally
       *  identical — and pass none that is not. */
      function wipedOnFirstLaunch(agent: AndroidAgent): boolean {
        const opts = launcherOf(agent).launch.mock.calls[0]?.[2] as { wipeData?: boolean } | undefined
        return opts?.wipeData ?? false
      }

      async function boot(agent: AndroidAgent, resetMode?: 'app-only' | 'full-erase') {
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        browser.send(JSON.stringify({
          type: 'device:boot',
          requestId: 'rq-wipe',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34', ...(resetMode ? { resetMode } : {}) },
        }))
        return browser
      }

      // The suite's default is "no emulator process". Each test states which world it is in, because
      // the stop branch is gated on the process rather than on adb's view of it.
      //
      // Both are module-level `vi.fn()`s shared by every test in the file, so the call history has
      // to be cleared as well as the return value — a `not.toHaveBeenCalled()` reading a previous
      // test's call is a failure that points at the wrong test.
      beforeEach(() => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'gone' })
        vi.mocked(stopEmulatorProcess).mockClear()
      })
      afterEach(() => vi.mocked(probeEmulator).mockReturnValue({ state: 'gone' }))

      it('launches with wipeData when the toggle was armed', async () => {
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(wipedOnFirstLaunch(agent)).toBe(true)

        agent.disconnect(); browser.close()
      })

      // The control. Without it the assertion above passes on an implementation that wipes every
      // boot, which is the worse of the two failures — it erases devices nobody asked it to.
      it('does not wipe an ordinary boot', async () => {
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent)
        await waitForType(browser, 'device:ready')

        expect(wipedOnFirstLaunch(agent)).toBe(false)

        agent.disconnect(); browser.close()
      })

      it('passes app-only through as no wipe', async () => {
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'app-only')
        await waitForType(browser, 'device:ready')

        expect(wipedOnFirstLaunch(agent)).toBe(false)

        agent.disconnect(); browser.close()
      })

      it('stops an already-running emulator first, then relaunches it wiped', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(true)
        const shutdown = vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(shutdown).toHaveBeenCalledWith('emulator-5554')
        expect(wipedOnFirstLaunch(agent)).toBe(true)

        agent.disconnect(); browser.close()
      })

      // The mirror of the test above, and the one that keeps the `fullErase &&` in the condition
      // honest: an ordinary boot must not touch a running emulator, or every tester loses the
      // device they were using to a cold boot nobody asked for.
      it('leaves a running emulator alone on an ordinary boot', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(true)
        const shutdown = vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent)
        await waitForType(browser, 'device:ready')

        expect(shutdown).not.toHaveBeenCalled()
        // Paired with the launch, so this cannot pass by the boot having failed before reaching it.
        expect(launcherOf(agent).launch).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // Relaunching before the old qemu process is gone races the AVD's lock file. Nothing in
      // `emu kill` waits — it returns as soon as the console accepts it.
      it('waits for the old process to exit before relaunching, naming the AVD not the device id', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(true)
        vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)

        const l = launcherOf(agent)
        const order: string[] = []
        l.waitForExit.mockImplementation(async () => { order.push('waited') })
        l.launch.mockImplementation(() => { order.push('launched') })

        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(order).toEqual(['waited', 'launched'])
        // `avd:Pixel_8_API_34` is three lines away in the same block and would make `pgrep` match
        // nothing, so the wait would return at once and buy nothing at all.
        expect(l.waitForExit).toHaveBeenCalledWith('Pixel_8_API_34')

        agent.disconnect(); browser.close()
      })

      // A live process adb cannot see — still coming up, or its adb server restarted. There is no
      // console to ask, and skipping the stop would put a second emulator on the same AVD.
      it('stops a live emulator that adb cannot see, without a serial', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(false)          // no serial: adb reports nothing booted
        const shutdown = vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(shutdown).not.toHaveBeenCalled()          // no console to send it to
        expect(vi.mocked(stopEmulatorProcess)).toHaveBeenCalledWith('Pixel_8_API_34')
        expect(launcherOf(agent).waitForExit).toHaveBeenCalledWith('Pixel_8_API_34')

        agent.disconnect(); browser.close()
      })

      it('does not try to stop an emulator that is not running', async () => {
        const adb = mockAdb(false)
        const shutdown = vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        await waitForType(browser, 'device:ready')

        expect(shutdown).not.toHaveBeenCalled()
        expect(vi.mocked(stopEmulatorProcess)).not.toHaveBeenCalled()
        expect(launcherOf(agent).waitForExit).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // `pgrep` answers "no match" and "I am not installed" through the same thrown error, so a
      // probe that cannot look must not read as "nothing is running" — that lands on the same
      // silent false success as launching after a failed stop, by a different door.
      it('fails the boot when it cannot tell whether an emulator is running', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'unknown' })
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent, 'full-erase')
        const err = await waitForType(browser, 'device:boot-error')

        expect(err['requestId']).toBe('rq-wipe')
        expect(launcherOf(agent).launch).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // The same probe failure must not touch an ordinary boot — it never asks, and a host without
      // `pgrep` has to keep booting devices normally.
      it('does not consult the probe on an ordinary boot', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'unknown' })
        const agent = new AndroidAgent({}, mockAdb(false))
        await agent.connect(`ws://localhost:${port}`)
        const browser = await boot(agent)
        await waitForType(browser, 'device:ready')

        expect(launcherOf(agent).launch).toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })

      // The blocker this review found: proceeding to launch after a failed stop reports a Full
      // reset that never happened, because `findSerial` scans `adb devices` for any emulator
      // answering to this AVD and returns the survivor, and `waitForBoot` passes instantly on a
      // device that is already up. The boot has to fail where the tester can see it.
      it('fails the boot rather than launching when the old emulator will not exit', async () => {
        vi.mocked(probeEmulator).mockReturnValue({ state: 'running', pid: 4321 })
        const adb = mockAdb(true)
        vi.spyOn(adb, 'shutdown').mockResolvedValue(undefined)
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        launcherOf(agent).waitForExit.mockRejectedValue(new Error('still running after 30s'))

        const browser = await boot(agent, 'full-erase')
        const err = await waitForType(browser, 'device:boot-error')

        expect(err['requestId']).toBe('rq-wipe')
        expect(launcherOf(agent).launch).not.toHaveBeenCalled()

        agent.disconnect(); browser.close()
      })
    })

    // ── #526: a boot the agent stops running is answered, not abandoned ───────────────────────

    /** The launcher this agent built, whose `waitForBoot` is where a boot can be parked. */
    function launcherOf(agent: AndroidAgent) {
      return (agent as unknown as { launcher: { waitForBoot: ReturnType<typeof vi.fn> } }).launcher
    }

    /** A `waitForBoot` whose first `hold` calls park until released, and which answers at once after. */
    function holdingBoot(agent: AndroidAgent, hold: number) {
      const releases: (() => void)[] = []
      let calls = 0
      launcherOf(agent).waitForBoot.mockImplementation(() => {
        calls++
        if (calls <= hold) return new Promise<void>((resolve) => releases.push(resolve))
        return Promise.resolve()
      })
      return { releases, calls: () => calls }
    }

    async function joinedAgent(adb: AdbWrapper) {
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      return { agent, browser }
    }

    const boot = (sessionId: string | null, requestId: string) =>
      JSON.stringify({ type: 'device:boot', requestId, sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } })

    it('answers a boot that a newer boot superseded', async () => {
      const { agent, browser } = await joinedAgent(mockAdb(false))
      const wait = holdingBoot(agent, 1)

      browser.send(boot(agent.sessionId, 'rq-a'))
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })

      const superseded = waitForType(browser, 'device:boot-error')
      browser.send(boot(agent.sessionId, 'rq-b'))
      const ready = await waitForType(browser, 'device:ready')
      expect(ready['requestId'], 'the surviving boot is the newer one').toBe('rq-b')

      wait.releases[0]!()
      const e = await superseded
      expect(e['requestId']).toBe('rq-a')
      expect(String(e['message'])).toContain('superseded')

      agent.disconnect()
      browser.close()
    })

    it('tells each abandoned boot what actually superseded it', async () => {
      // Two overlapping boots and one later event — the smallest sequence that tells a per-seq reason
      // apart from a single slot on the state, which would tell A it lost to the shutdown that took B.
      const { agent, browser } = await joinedAgent(mockAdb(false))
      const wait = holdingBoot(agent, 2)

      const seen: Record<string, string> = {}
      const both = new Promise<void>((resolve) => {
        browser.on('message', (raw) => {
          const m = JSON.parse(String(raw)) as Record<string, string>
          if (m['type'] === 'device:boot-error') {
            seen[m['requestId']!] = m['message']!
            if (Object.keys(seen).length === 2) resolve()
          }
        })
      })

      browser.send(boot(agent.sessionId, 'rq-a'))
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })
      browser.send(boot(agent.sessionId, 'rq-b'))
      await vi.waitFor(() => expect(wait.calls()).toBe(2), { timeout: 2000 })
      browser.send(JSON.stringify({ type: 'device:shutdown', requestId: 'rq-s', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))
      await waitForType(browser, 'device:shutdown-done')

      for (const release of wait.releases) release()
      await both

      expect(seen['rq-a'], 'A lost to B, not to the shutdown').toContain('superseded')
      expect(seen['rq-b'], 'B is the one the shutdown abandoned').toContain('shut down')

      agent.disconnect()
      browser.close()
    })

    it('answers a boot for a session it holds no device state for', async () => {
      const { agent, browser } = await joinedAgent(mockAdb(false))
      const sessionId = agent.sessionId
      // Held first: `agent.sessionId` reads the first entry of the very map being emptied.
      ;(agent as unknown as { deviceStates: Map<string, unknown> }).deviceStates.clear()

      const errored = waitForType(browser, 'device:boot-error')
      browser.send(boot(sessionId, 'rq-nostate'))
      const e = await errored
      expect(e['requestId']).toBe('rq-nostate')
      expect(String(e['message'])).toContain('re-join')

      agent.disconnect()
      browser.close()
    })

    it('says nothing for an abandoned boot that carried no correlator', async () => {
      // A reply nobody waits for is not an answer, and worse than nothing here: this viewer reports every
      // *uncorrelated* `device:boot-error` — deliberately, because `restartVideoStream` reports a dead
      // stream that way (#426). Driven through the handler because the relay requires a correlator on
      // `device:boot`; the parameter is optional and an older relay does not enforce it.
      const { agent, browser } = await joinedAgent(mockAdb(false))
      const wait = holdingBoot(agent, 1)
      const handler = agent as unknown as { handleDeviceBoot(s: string, d: string): Promise<void> }
      void handler.handleDeviceBoot(agent.sessionId!, 'avd:Pixel_8_API_34')
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })

      browser.send(boot(agent.sessionId, 'rq-live'))
      await waitForType(browser, 'device:ready')
      wait.releases[0]!()
      expect(await waitForTypeOrNull(browser, 'device:boot-error', 150)).toBeNull()

      agent.disconnect()
      browser.close()
    })

    it('sends no device info to a socket that is closing', async () => {
      // The mid-boot twin of the `sendMsg` guard below: this one gated on the socket being *present*, so a
      // boot that lost it mid-wait pushed its payload into a buffer nobody flushes while `device:ready` was
      // dropped by the other guard — the caller getting neither the data nor an answer.
      const agent = new AndroidAgent({}, mockAdb(false))
      const reach = agent as unknown as {
        ws: unknown
        sendDeviceInfo(state: { sessionId: string }, device: { id: string; name: string }): void
      }
      const sent: string[] = []
      const socket: { readyState: number; send: (d: string) => void } = {
        readyState: WebSocket.CLOSING,
        send: (d) => sent.push(d),
      }
      reach.ws = socket
      const device = { id: 'avd:Pixel_8_API_34', name: 'Pixel_8_API_34' }

      reach.sendDeviceInfo({ sessionId: 's1' }, device)
      expect(sent, 'a closing socket takes it and says nothing').toEqual([])

      socket.readyState = WebSocket.OPEN
      reach.sendDeviceInfo({ sessionId: 's1' }, device)
      expect(sent, 'and an open one still gets it').toHaveLength(1)
    })

    it('drops a reply to a socket that is closing, rather than buffering it in silence', async () => {
      // `ws.send` on anything but OPEN buffers and neither throws nor emits, so an answer sent there is
      // indistinguishable from a delivered one. Held on both agents: iOS has the same test, and a guard
      // present on one platform only is the asymmetry this slice's invariant table exists to catch.
      const agent = new AndroidAgent({}, mockAdb(false))
      const reach = agent as unknown as {
        ws: unknown
        sendMsg(msg: { type: string; sessionId: string; requestId: string; message: string }): void
      }
      const sent: string[] = []
      const socket: { readyState: number; send: (d: string) => void } = {
        readyState: WebSocket.CLOSING,
        send: (d) => sent.push(d),
      }
      reach.ws = socket
      const reply = { type: 'device:boot-error' as const, sessionId: 's1', requestId: 'rq-x', message: 'superseded' }

      reach.sendMsg(reply)
      expect(sent, 'a closing socket takes it and says nothing').toEqual([])

      socket.readyState = WebSocket.OPEN
      reach.sendMsg(reply)
      expect(sent, 'and an open one still gets it').toHaveLength(1)
    })

    it('abandons a boot when the relay goes away mid-boot, instead of finishing it', async () => {
      // **The asymmetry this slice closes.** iOS has invalidated in-flight boots on reconnect since its
      // helper-leak fix; this agent did not, so a boot that outlived the socket ran to completion against
      // a state `_scheduleReconnect` had already dropped — standing up a video stream and announcing
      // `device:ready` for a session that no longer exists. Both agents clear `deviceStates` there, but the
      // running boot holds its own reference to one, so clearing the map does not reach it.
      const adb = mockAdb(false)
      // A one-second handshake and a 25s budget, both copied from the iOS twin of this test rather than
      // guessed: stopping a relay, starting another on the same port and waiting out the agent's own
      // reconnect is the heaviest sequence in this file, and the default 10s handshake is longer than the
      // whole default 5s test budget — one attempt landing in it stops every later one, since
      // `_scheduleReconnect` runs only from `connect()`'s `.catch`. It passed locally and timed out on CI.
      const agent = new AndroidAgent({ reconnectDelays: [20], handshakeTimeoutMs: 1_000 }, adb)
      await agent.connect(`ws://localhost:${port}`)
      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      const sessionId = agent.sessionId
      browser.send(JSON.stringify({ type: 'session:start', sessionId }))
      await waitForType(browser, 'session:joined')

      const wait = holdingBoot(agent, 1)
      browser.send(boot(sessionId, 'rq-lost'))
      await waitForType(browser, 'device:booting')
      await vi.waitFor(() => expect(wait.calls()).toBe(1), { timeout: 2000 })

      // Drop the relay and bring another up on the same port, so the agent's own reconnect runs and the
      // socket is live again — an `agent.disconnect()` version of this passes with the fix removed,
      // because `ws` then stays null and the send guard covers for it.
      //
      // Rebinding `relay` is local in effect even though the binding is the suite's: `beforeEach` mints a
      // fresh server for every test and `afterEach` stops whichever one this leaves behind, so no
      // neighbour ever sees the replacement. Same shape as the iOS twin of this test.
      browser.close()
      await relay.stop()
      relay = new RelayServer({ port })
      await relay.start()
      const rejoined = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(rejoined)
      let joined = null
      for (let i = 0; i < 60 && joined === null; i++) {
        rejoined.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        joined = await waitForTypeOrNull(rejoined, 'session:joined', 250)
      }
      expect(joined, 'the agent never re-registered').not.toBeNull()

      // **Observed at the first thing the resumed boot would do, not at the last.** Two later signals look
      // like the obvious assertions and see nothing either way: `device:ready` names the dropped session,
      // which this relay has never heard of and discards at the door, and the video session is never built
      // because `openStreamWs` registers that same id and gets nowhere. Both stay silent with the fix
      // removed, so both would have passed a broken agent. The step immediately after the wait is `adb`,
      // which answers regardless of what the relay knows — so that is where the difference is visible.
      const adbCallsBefore = (adb.listDevices as ReturnType<typeof vi.fn>).mock.calls.length
      const serialBefore = adb.getSerial('avd:Pixel_8_API_34')
      wait.releases[0]!()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setTimeout(r, 50))
      expect(
        (adb.listDevices as ReturnType<typeof vi.fn>).mock.calls.length,
        'the abandoned boot carried on against a state the reconnect had dropped',
      ).toBe(adbCallsBefore)
      expect(adb.getSerial('avd:Pixel_8_API_34'), 'and bound a serial onto it').toBe(serialBefore)
      expect(await waitForTypeOrNull(rejoined, 'device:ready', 100)).toBeNull()

      agent.disconnect()
      rejoined.close()
    }, 25_000)

    // ── L5b′: the lifecycle pair correlates, and the correlator is optional ────────────────────
    //
    // Optional means the compiler enforces nothing — `<Pair>ReplyBody` cannot be built for a field an
    // object is allowed to omit — and `correlatedRequestsGated` derives only required declarations, so
    // it does not see this pair either. These tests are the entire enforcement of the echo here.
    describe('lifecycle replies echo the boot/shutdown correlator', () => {
      async function joined(adb: AdbWrapper) {
        const agent = new AndroidAgent({}, adb)
        await agent.connect(`ws://localhost:${port}`)
        const browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        await waitForType(browser, 'session:joined')
        return { agent, browser }
      }

      it('device:ready carries the requestId of the boot it answers', async () => {
        const { agent, browser } = await joined(mockAdb(false))

        const ready = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-1',
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        expect((await ready)['requestId']).toBe('boot-1')

        agent.disconnect(); browser.close()
      })

      it('device:boot-error carries the requestId of the boot it answers', async () => {
        // The failure exit is what a caller actually waits on: an uncorrelatable diagnosis is
        // discarded by a correlating consumer, so the boot fails by deadline instead of by error.
        const adb = mockAdb(false)
        const { agent, browser } = await joined(adb)
        // Mocked **after** the join: `connect()` enumerates devices through this same call, so failing
        // it earlier takes the registration down and never reaches a boot at all.
        ;(adb.listDevices as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('adb exploded'))

        const err = waitForType(browser, 'device:boot-error')
        browser.send(JSON.stringify({
          type: 'device:boot', sessionId: agent.sessionId, requestId: 'boot-2',
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        const msg = await err
        expect(msg['requestId']).toBe('boot-2')
        expect(msg['message']).toContain('adb exploded')

        agent.disconnect(); browser.close()
      })

      it('device:shutdown-done carries the requestId of the shutdown it answers', async () => {
        const { agent, browser } = await joined(mockAdb(true))

        const done = waitForType(browser, 'device:shutdown-done')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId, requestId: 'down-1',
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        expect((await done)['requestId']).toBe('down-1')

        agent.disconnect(); browser.close()
      })

      it('answers a correlator-less request without inventing one', async () => {
        // The relay originates `device:shutdown` from its idle timer with no id, so this is a live
        // wire shape. A minted id would be worse than none: the consumer's fallback accepts an absent
        // correlator and rejects a mismatched one, so inventing one turns a reply that lands today
        // into one that is silently dropped.
        const { agent, browser } = await joined(mockAdb(true))

        const done = waitForType(browser, 'device:shutdown-done')
        browser.send(JSON.stringify({
          type: 'device:shutdown', sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        expect((await done)['requestId']).toBeUndefined()

        agent.disconnect(); browser.close()
      })
    })

    it('sends session:chrome with buttons (no framePng)', async () => {
      const adb = mockAdb(false)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)

      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      const chromePromise = waitForType(browser, 'session:chrome')
      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-2',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:booting')

      const chrome = await chromePromise
      const payload = chrome['payload'] as Record<string, unknown>
      expect('framePng' in payload).toBe(false)
      expect(Array.isArray(payload['buttons'])).toBe(true)
      expect(payload['streamType']).toBe('h264')

      agent.disconnect()
      browser.close()
    })

    it('second boot request cancels first via bootSeq', async () => {
      const adb = mockAdb(false)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      // Send two boot requests rapidly
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-3', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))
      browser.send(JSON.stringify({ type: 'device:boot', requestId: 'rq-fix-4', sessionId: agent.sessionId, payload: { deviceId: 'avd:Pixel_8_API_34' } }))

      // Should still get exactly one device:ready eventually
      const ready = await waitForType(browser, 'device:ready')
      expect(ready['type']).toBe('device:ready')

      agent.disconnect()
      browser.close()
    })
  })

  describe('app:install', () => {
    it('sends app:install-error for .app.zip (iOS build)', async () => {
      const adb = mockAdb(true)
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-5',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')

      // relay resolves build from DB — simulate agent receiving the install message directly
      const agentWs = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(agentWs)
      // We can't easily test relay→agent path without a DB entry; test the response routing
      // by checking that .app.zip guard works at agent level via the relay message handler
      agent['handleRelayMessage']({
        type: 'app:install',
        sessionId: agent.sessionId!,
        requestId: 'rq-appzip',
        payload: { filePath: '/tmp/App.app.zip' },
      })
      const err = await waitForType(browser, 'app:install-error')
      expect((err['message'] as string).toLowerCase()).toContain('ios')

      agent.disconnect()
      browser.close()
      agentWs.close()
    })
  })

  describe('busy session', () => {
    it('rejects second browser joining the same session', async () => {
      const adb = mockAdb()
      const agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      const b1 = new WebSocket(`ws://localhost:${port}`)
      const b2 = new WebSocket(`ws://localhost:${port}`)
      await Promise.all([waitForOpen(b1), waitForOpen(b2)])

      b1.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(b1, 'session:joined')

      b2.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      const err = await waitForType(b2, 'error')
      expect(err['message']).toMatch(/busy/i)

      agent.disconnect()
      b1.close()
      b2.close()
    })
  })

  describe('DeviceAgent interface', () => {
    it('listDevices delegates to AdbWrapper', async () => {
      const adb = mockAdb()
      const agent = new AndroidAgent({}, adb)
      const devices = await agent.listDevices()
      expect(devices[0].platform).toBe('android')
    })
  })

  describe('auto-restart', () => {
    let agent: AndroidAgent
    let browser: WebSocket

    function getState(): TestState {
      return internals(agent).deviceStates.values().next().value!
    }

    beforeEach(async () => {
      // Reset the module-level mock state to a clean slate *before* booting, so any async work
      // that settled late from a previous test (a leaked pump/restart) can't carry stale values in.
      scrcpyCloseOnCreate = false
      scrcpyStartError = null
      scrcpyStreamController = null

      agent = new AndroidAgent({}, mockAdb(true))
      await agent.connect(`ws://localhost:${port}`)

      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
    })

    afterEach(async () => {
      vi.useRealTimers()
      // disconnect() clears deviceStates, so any in-flight auto-restart hits its
      // `deviceStates.has(...)` guard and returns without spawning a new scrcpy session — this is
      // what neutralizes the pump→restart chain instead of letting it bleed into the next test.
      agent.disconnect()
      browser.close()
      // End the active video stream so its pump loop resolves now, then let pending microtasks +
      // timer callbacks drain on the real clock before the next test starts from a clean slate.
      try { scrcpyStreamController?.close() } catch { /* already closed by the test or the mock */ }
      await new Promise((r) => setImmediate(r))
      scrcpyCloseOnCreate = false
      scrcpyStartError = null
      scrcpyStreamController = null
    })

    describe('pump exit guard', () => {
      it('calls restartVideoStream when stream ends unexpectedly', async () => {
        scrcpyCloseOnCreate = true
        const restartSpy = vi.spyOn(internals(agent), 'restartVideoStream').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'device:boot',
          requestId: 'rq-fix-6',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        await vi.waitFor(() => expect(restartSpy).toHaveBeenCalledOnce(), { timeout: 500 })
      })

      it('skips restartVideoStream when restarting flag is already set', async () => {
        const restartSpy = vi.spyOn(internals(agent), 'restartVideoStream').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'device:boot',
          requestId: 'rq-fix-7',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        getState().restarting = true
        scrcpyStreamController?.close()

        // Stream close is async — poll until the pump loop has had time to exit.
        // vi.waitFor retries until the assertion passes or the timeout is exceeded.
        await vi.waitFor(() => expect(restartSpy).not.toHaveBeenCalled(), { timeout: 200 })
      })

      it('skips restartVideoStream when session was intentionally stopped', async () => {
        const restartSpy = vi.spyOn(internals(agent), 'restartVideoStream').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'device:boot',
          requestId: 'rq-fix-8',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        const state = getState()
        internals(agent).cleanupDeviceState(state) // sets scrcpySession = null
        scrcpyStreamController?.close()

        await vi.waitFor(() => expect(restartSpy).not.toHaveBeenCalled(), { timeout: 200 })
      })
    })

    describe('envelope marking (B-2)', () => {
      it('marks codec=H.264 + per-AU keyframe so the relay stays keyframe-aware', async () => {
        browser.send(JSON.stringify({
          type: 'device:boot',
          requestId: 'rq-fix-9',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        const flags: Array<{ codec: number; keyframe: boolean }> = []
        browser.on('message', (d: Buffer) => {
          if (Buffer.isBuffer(d) && hasEnvelope(d)) flags.push(readEnvelopeFlags(d))
        })

        // The stream controller is assigned during startVideoStream; wait for it before enqueueing
        // so this test never reads it mid-(re)start when it is transiently null.
        await vi.waitFor(() => expect(scrcpyStreamController).not.toBeNull(), { timeout: 1000 })
        const controller = scrcpyStreamController!

        // A keyframe access unit (SPS+PPS merged) followed by a P-frame access unit.
        controller.enqueue({ payload: Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0x65, 0x88]), keyframe: true })
        controller.enqueue({ payload: Buffer.from([0x41, 0x9a, 0x00, 0x20]), keyframe: false })

        await vi.waitFor(() => expect(flags).toHaveLength(2), { timeout: 1000 })
        expect(flags[0]).toEqual({ codec: CODEC_H264, keyframe: true })
        expect(flags[1]).toEqual({ codec: CODEC_H264, keyframe: false })
        // Regression guard: the pre-fix bug marked H.264 frames as JPEG → relay saw every frame as a keyframe, degrading drop-to-keyframe into tearing drop-to-latest.
        expect(flags[0].codec).not.toBe(CODEC_JPEG)
      })
    })

    describe('stream:request-idr (B-3)', () => {
      it('resets the scrcpy video encoder to force an on-demand IDR', async () => {
        browser.send(JSON.stringify({
          type: 'device:boot',
          requestId: 'rq-fix-10',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')

        // Wait for the scrcpy session to settle before reading it — guards against reading during a
        // transient null window if a (re)start is still in flight.
        await vi.waitFor(() => expect(getState().scrcpySession).not.toBeNull(), { timeout: 1000 })
        const control = getState().scrcpySession!.control
        expect(control.resetVideo).not.toHaveBeenCalled()

        // Relay sends this agent-ward during drop-to-keyframe recovery.
        internals(agent).handleRelayMessage({ type: 'stream:request-idr', sessionId: agent.sessionId })

        expect(control.resetVideo).toHaveBeenCalledOnce()
      })

      it('ignores stream:request-idr when no scrcpy session is active', () => {
        // No device booted → no session; handler must not throw.
        expect(() =>
          internals(agent).handleRelayMessage({ type: 'stream:request-idr', sessionId: agent.sessionId }),
        ).not.toThrow()
      })
    })

    describe('restartVideoStream', () => {
      beforeEach(async () => {
        browser.send(JSON.stringify({
          type: 'device:boot',
          requestId: 'rq-fix-11',
          sessionId: agent.sessionId,
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await waitForType(browser, 'device:ready')
        // restartVideoStream bails early if the stream WS isn't OPEN. Its registration is a real
        // relay round-trip that can lag device:ready under load, so wait for OPEN to make the
        // precondition deterministic before any restart test reads it.
        await vi.waitFor(() => expect(getState().streamWs?.readyState).toBe(WebSocket.OPEN), { timeout: 1000 })
        vi.clearAllMocks() // reset call counts; implementations remain
      })

      it('resets restarting flag when serial is not found', async () => {
        vi.spyOn(internals(agent).adb, 'getSerial').mockReturnValue(undefined)

        const state = getState()
        state.restarting = true
        await internals(agent).restartVideoStream(state)

        expect(state.restarting).toBe(false)
      })

      it('resets restarting flag when streamWs is not open', async () => {
        const state = getState()
        state.streamWs = null
        state.restarting = true

        await internals(agent).restartVideoStream(state)

        expect(state.restarting).toBe(false)
      })

      // **This is why the correlator on `device:boot-error` is optional at all.** The message below
      // answers no request: a stream died mid-session and failed to come back, and there is no
      // `device:boot` anywhere behind it to take an id from. Everything downstream follows from that —
      // the declaration cannot be required, `correlatedRequestsGated` cannot cover the pair, and
      // `DeviceViewer` must not gate this branch on a correlator, since it is the only surface that
      // reports a dead stream. A boot carrying an id happens first here on purpose: that is the state
      // in which an implementation reaching for "the session's current requestId" would look correct.
      it('sends the unsolicited boot-error with no correlator, even after a correlated boot', async () => {
        vi.useFakeTimers()

        const reReady = waitForType(browser, 'device:ready')
        browser.send(JSON.stringify({
          type: 'device:boot',
          sessionId: agent.sessionId,
          requestId: 'boot-with-id',
          payload: { deviceId: 'avd:Pixel_8_API_34' },
        }))
        await vi.runAllTimersAsync()
        expect((await reReady)['requestId']).toBe('boot-with-id')

        scrcpyStartError = new Error('encoder stall')
        const state = getState()
        state.restarting = true

        const bootErrPromise = waitForType(browser, 'device:boot-error')
        const restartPromise = internals(agent).restartVideoStream(state)
        await vi.runAllTimersAsync()
        await restartPromise

        const err = await bootErrPromise
        expect(err['message']).toBe('scrcpy failed to restart')
        expect(err['requestId']).toBeUndefined()
      })

      it('sends device:boot-error and resets flag when startVideoStream throws', async () => {
        vi.useFakeTimers()
        scrcpyStartError = new Error('encoder stall')

        const state = getState()
        state.restarting = true

        const bootErrPromise = waitForType(browser, 'device:boot-error')
        const restartPromise = internals(agent).restartVideoStream(state)
        await vi.runAllTimersAsync()
        await restartPromise

        const err = await bootErrPromise
        expect(err['message']).toBe('scrcpy failed to restart')
        expect(state.restarting).toBe(false)
      })

      it('creates new ScrcpySession and resets flag on successful restart', async () => {
        vi.useFakeTimers()

        const state = getState()
        state.restarting = true

        const restartPromise = internals(agent).restartVideoStream(state)
        await vi.runAllTimersAsync()
        await restartPromise

        expect(vi.mocked(ScrcpySession)).toHaveBeenCalledOnce() // cleared before test; one new session
        expect(state.scrcpySession).not.toBeNull()
        expect(state.restarting).toBe(false)
      })
    })
  })

  describe('reconnect', () => {
    it('disconnect() sets _stopping and cancels pending reconnect timer', async () => {
      const agent = new AndroidAgent({}, mockAdb())
      await agent.connect(`ws://localhost:${port}`)

      internals(agent)._reconnectTimer = setTimeout(() => {}, 10000)

      agent.disconnect()

      expect(internals(agent)._stopping).toBe(true)
      expect(internals(agent)._reconnectTimer).toBeNull()
    })

    it('_scheduleReconnect() is no-op when _stopping is true', async () => {
      const agent = new AndroidAgent({}, mockAdb())
      await agent.connect(`ws://localhost:${port}`)

      internals(agent)._stopping = true
      internals(agent)._scheduleReconnect()

      expect(internals(agent)._reconnectTimer).toBeNull()
      expect(internals(agent)._reconnectAttempt).toBe(0)

      agent.disconnect()
    })

    it('reconnects automatically when connection drops and relay is available', async () => {
      const agent = new AndroidAgent({ reconnectDelays: [0] }, mockAdb())
      await agent.connect(`ws://localhost:${port}`)

      const oldWs = internals(agent).ws!
      oldWs.terminate()

      await vi.waitFor(() => {
        const ws = internals(agent).ws
        expect(ws).not.toBeNull()
        expect(ws).not.toBe(oldWs)       // 새 연결 객체여야 함
        expect(ws!.readyState).toBe(WebSocket.OPEN)
      }, { timeout: 2000 })

      agent.disconnect()
    })
  })

  // Input + misc relay-message handlers. Boot once over the scrcpy backend (pinned in beforeAll),
  // then inject relay messages directly via handleRelayMessage and assert on the backend control /
  // adb spies — the synchronous fire path means pointer calls land before the handler returns.
  describe('relay message handlers', () => {
    let agent: AndroidAgent
    let adb: AdbWrapper
    let browser: WebSocket

    function getState(): TestState {
      return internals(agent).deviceStates.values().next().value!
    }

    function inject(msg: Record<string, unknown>): void {
      internals(agent).handleRelayMessage({ sessionId: agent.sessionId, ...msg })
    }

    beforeEach(async () => {
      scrcpyCloseOnCreate = false
      scrcpyStartError = null
      scrcpyStreamController = null

      adb = mockAdb(true)
      agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)

      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')

      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-12',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
      // scrcpy mock reports a 1080×2400 display; touch coords map against these.
      await vi.waitFor(() => expect(getState().scrcpySession).not.toBeNull(), { timeout: 1000 })
      expect(getState().videoWidth).toBe(1080)
      expect(getState().videoHeight).toBe(2400)
    })

    afterEach(async () => {
      vi.useRealTimers()
      agent.disconnect()
      browser.close()
      try { scrcpyStreamController?.close() } catch { /* already closed */ }
      await new Promise((r) => setImmediate(r))
      scrcpyStreamController = null
    })

    describe('input — touch', () => {
      it('maps normalized touch:start to device px via scrcpy control', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:touch:start', payload: { x: 0.25, y: 0.75 } })
        // 0.25*1080 = 270, 0.75*2400 = 1800
        expect(control.touchDown).toHaveBeenCalledWith(0, 270, 1800)
      })

      it('maps touch:move to device px', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:touch:move', payload: { x: 0.5, y: 0.5 } })
        expect(control.touchMove).toHaveBeenCalledWith(0, 540, 1200)
      })

      it('touch:end lifts at the last touched px', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:touch:start', payload: { x: 0.1, y: 0.2 } })
        inject({ type: 'input:touch:end', requestId: 'rq-lift' })
        // last px from start: 0.1*1080 = 108, 0.2*2400 = 480
        expect(control.touchUp).toHaveBeenCalledWith(0, 108, 480)
      })

      // followups H-F: touch:end acks input:done when dispatched to a booted device (pointer channel present + adb reports booted).
      it('acks input:done on touch:end for a booted session', async () => {
        const done = waitForType(browser, 'input:done')
        browser.send(JSON.stringify({ type: 'input:touch:start', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
        browser.send(JSON.stringify({ type: 'input:touch:end', requestId: 'rq-in1', sessionId: agent.sessionId, payload: { x: 0.5, y: 0.5 } }))
        const ack = await done
        expect(ack.sessionId).toBe(agent.sessionId)
        // L5c. The terminal frame's id, not any id: replacing the echo with a literal left all 263 tests
        // passing in the mutation round. `requestId` rides beside `seq` as a caller-captured argument for
        // the same reason — a gesture is dozens of frames and two can overlap, so a correlator read from
        // shared state would answer one input with another's id, which is #499 rebuilt inside the agent.
        expect(ack.requestId).toBe('rq-in1')
      })
    })

    describe('input — pinch', () => {
      it('maps pinch:start two-finger coords to device px', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:pinch:start', payload: { f0: { x: 0.2, y: 0.3 }, f1: { x: 0.8, y: 0.9 } } })
        // f0: (216, 720), f1: (864, 2160)
        expect(control.pinchStart).toHaveBeenCalledWith(216, 720, 864, 2160)
      })

      it('maps pinch:move and pinch:end', () => {
        const control = getState().scrcpySession!.control
        inject({ type: 'input:pinch:move', payload: { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } } })
        expect(control.pinchMove).toHaveBeenCalledWith(540, 1200, 540, 1200)
        inject({ type: 'input:pinch:end', requestId: 'rq-pinch' })
        expect(control.pinchEnd).toHaveBeenCalledOnce()
      })
    })

    describe('input — rotate', () => {
      it('toggles landscape and asks the device to rotate to canonical landscape (3)', () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        expect(getState().landscape).toBe(false)

        inject({ type: 'input:rotate' })
        expect(rotateSpy).toHaveBeenCalledWith('emulator-5554', 3)
        expect(getState().landscape).toBe(true)
      })

      it('rotates back to portrait (0) on the second toggle', () => {
        const rotateSpy = vi.spyOn(adb, 'setRotation')
        inject({ type: 'input:rotate' })
        inject({ type: 'input:rotate' })
        expect(rotateSpy).toHaveBeenNthCalledWith(2, 'emulator-5554', 0)
        expect(getState().landscape).toBe(false)
      })
    })

    describe('input — type', () => {
      it('routes input:type to adb.inputText and acks only after it completes', async () => {
        // gate inputText so we can prove the ack is not sent until it resolves
        let resolveInput!: () => void
        const spy = vi.spyOn(adb, 'inputText').mockReturnValue(new Promise<void>((r) => { resolveInput = r }))
        const ack = waitForType(browser, 'input:type-done')
        inject({ type: 'input:type', requestId: 'rq-in2', payload: { text: 'hello' } })
        await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('emulator-5554', 'hello'), { timeout: 500 })
        // ack must NOT have fired while inputText is still pending
        let acked = false
        void ack.then(() => { acked = true })
        await new Promise((r) => setTimeout(r, 50))
        expect(acked).toBe(false)
        resolveInput()
        expect((await ack).sessionId).toBe(agent.sessionId)
      })

      // Empty text is a successful no-op on both platforms, and the flow schema and MCP `type_text`
      // both accept `""`. Answering an error for it would trade this change's real fix — "dispatched
      // nothing while claiming otherwise" — for a false failure.
      it('acks input:type-done for empty text without touching adb', async () => {
        const inputText = vi.spyOn(adb, 'inputText')
        const ack = waitForType(browser, 'input:type-done')
        inject({ type: 'input:type', requestId: 'rq-in3', payload: { text: '' } })
        // The correlator on the success half. All three `input:type-*` producers here took a literal in the
        // mutation round without a single test noticing — and the two client tests that echo it echo it
        // *correctly*, so a predicate that stopped checking would have matched either way.
        expect((await ack).requestId).toBe('rq-in3')
        expect(inputText).not.toHaveBeenCalled()
      })

      it('acks input:type-error when the text is rejected', async () => {
        vi.spyOn(adb, 'inputText').mockRejectedValue(new Error('ASCII only'))
        const ack = waitForType(browser, 'input:type-error')
        inject({ type: 'input:type', requestId: 'rq-in4', payload: { text: '안녕' } })
        const err = await ack
        expect(err.message).toBe('ASCII only')
        expect(err.requestId).toBe('rq-in4')
      })
    })

    describe('input — button', () => {
      it('forwards a named button press to the touch helper', () => {
        const helper = getState().touchHelper!
        inject({ type: 'input:button', requestId: 'rq-in5', payload: { name: 'home' } })
        expect(helper.pressButton).toHaveBeenCalledWith('home')
      })
    })

    describe('input — keyboard', () => {
      it('sends a keyevent for a special key (Enter → 66)', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        inject({ type: 'input:key', requestId: 'rq-in6', payload: { code: 'Enter', modifiers: 0 } })
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', '66')
      })

      it('types a lowercase character for a letter key with no shift', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in7', payload: { code: 'KeyA', modifiers: 0 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', 'a')
      })

      it('types an uppercase character when shift modifier is set', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in8', payload: { code: 'KeyA', modifiers: 0x02 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', 'A')
      })

      it('maps a shifted digit to its symbol (Digit1 + shift → !)', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in9', payload: { code: 'Digit1', modifiers: 0x02 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', '!')
      })

      // followups M1: a Cmd/Ctrl chord used to be typed as the raw letter (Cmd+C → 'c'), so
      // copy/paste both silently failed. They must map to the dedicated keycodes instead.
      it('maps Cmd+C (meta) to KEYCODE_COPY, not a typed "c"', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in10', payload: { code: 'KeyC', modifiers: 0x08 } })
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_COPY')
        expect(inputSpy).not.toHaveBeenCalled()
      })

      it('maps Cmd+V to KEYCODE_PASTE and Ctrl+X to KEYCODE_CUT', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in11', payload: { code: 'KeyV', modifiers: 0x08 } })
        inject({ type: 'input:key', requestId: 'rq-in12', payload: { code: 'KeyX', modifiers: 0x01 } })
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_PASTE')
        expect(keyEvSpy).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_CUT')
        expect(inputSpy).not.toHaveBeenCalled()
      })

      it('does not type the raw letter for a non-clipboard chord (Cmd+A)', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in13', payload: { code: 'KeyA', modifiers: 0x08 } })
        expect(inputSpy).not.toHaveBeenCalled()
        expect(keyEvSpy).not.toHaveBeenCalled()
      })

      it('still types a plain letter with no chord modifier (regression)', () => {
        const inputSpy = vi.spyOn(adb, 'sendInput')
        inject({ type: 'input:key', requestId: 'rq-in14', payload: { code: 'KeyC', modifiers: 0 } })
        expect(inputSpy).toHaveBeenCalledWith('emulator-5554', 'text', 'c')
      })

      it('keyboard:toggle is a client-side no-op (no adb side effect, no throw)', () => {
        const keyEvSpy = vi.spyOn(adb, 'sendKeyEvent')
        const inputSpy = vi.spyOn(adb, 'sendInput')
        expect(() => inject({ type: 'input:keyboard:toggle' })).not.toThrow()
        expect(keyEvSpy).not.toHaveBeenCalled()
        expect(inputSpy).not.toHaveBeenCalled()
      })
    })

    describe('input — no session', () => {
      it('ignores an opening frame for an unknown session without throwing', () => {
        // Opening frames have no ack obligation, so silence is the right answer here.
        expect(() =>
          internals(agent).handleRelayMessage({ type: 'input:touch:start', sessionId: 'nope', payload: { x: 0.5, y: 0.5 } }),
        ).not.toThrow()
      })

      // A *terminal* frame is different: the caller is waiting. The reachable shape is a session
      // the relay still routes for while the agent holds no state for it — an agent that restarted
      // with a dashboard tab still attached (#426). The relay answers on an agent's behalf only
      // when the agent is *offline*, so here nothing would answer at all and the caller waits out
      // its own timeout, which its fallback then reports as success.
      // Asserted on what the agent sends, not on what arrives at the browser: the relay answers
      // `agent offline` for these types on its own when the agent socket is down, so routing a
      // reply through it would test the relay's fallback rather than the agent's.
      for (const [type, payload] of [
        ['input:touch:end', { x: 0.5, y: 0.5 }],
        ['input:pinch:end', { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } }],
        ['input:button', { name: 'back' }],
        ['input:key', { code: 'KeyA' }],
      ] as Array<[string, Record<string, unknown>]>) {
        it(`answers input:error for ${type} when the agent has lost the session's state`, () => {
          // Captured first: `agent.sessionId` is derived from `deviceStates`, so clearing the map
          // would also make the id null — and then the ack has nothing to address.
          const sessionId = agent.sessionId
          const sent = vi.spyOn(internals(agent).ws!, 'send')
          internals(agent).deviceStates.clear()

          internals(agent).handleRelayMessage({ type, sessionId, requestId: 'rq-gone', payload })

          const acks = sent.mock.calls
            .map(([raw]) => JSON.parse(raw as string) as { type: string; requestId?: string; message?: string })
            .filter((m) => m.type === 'input:error')
          expect(acks).toHaveLength(1)
          expect(acks[0].message).toContain('no active session')
          // `ackNoSession` has no `state` to hang a correlator on, so it must arrive as an argument.
          expect(acks[0].requestId).toBe('rq-gone')
        })
      }
    })

    // Every terminal ack used to be computed from a proxy — a channel reference, a helper object
    // that has no process, or a resolvable serial — rather than from what the dispatch reported.
    describe('input acks report the dispatch, not a proxy', () => {
      it('answers channel-down without writing when the channel is not ready', async () => {
        const control = getState().scrcpySession!.control
        vi.mocked(control.isReady).mockReturnValue(false)

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
        inject({ type: 'input:touch:end', requestId: 'rq-in15', payload: { x: 0.5, y: 0.5 } })

        const e = await errored
        expect(e['message']).toBe('input channel not ready')
        // The error half of `ackInput`. See the iOS twin: an unmatched `input:error` is resolved
        // optimistically by `awaitInputAck`, so a stated device failure reaches the caller as success.
        expect(e['requestId']).toBe('rq-in15')
        expect(control.touchUp).not.toHaveBeenCalled()
      })

      // Deliberately driven through the *helper*, not the scrcpy control: this describe is pinned to
      // the scrcpy backend, whose writes are synchronous and void, so a rejecting pointer channel
      // there would only be testing the mock's contract. The gRPC backend is the one that can
      // genuinely reject, and `EmulatorGrpcClient.test.ts` covers that end of it.
      it('answers failed when a dispatch rejects on a live path', async () => {
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null
        state.touchHelper!.touchEnd.mockResolvedValue('failed')

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
        inject({ type: 'input:touch:end', requestId: 'rq-in16', payload: { x: 0.5, y: 0.5 } })

        expect((await errored)['message']).toBe('the device rejected the input')
      })

      it('answers failed when the button dispatch rejects', async () => {
        // Buttons go through the adb helper on both backends — the path that actually runs a
        // command in production.
        const helper = getState().touchHelper!
        helper.pressButton.mockResolvedValue('failed')

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:button', requestId: 'rq-in17', payload: { name: 'back' } })

        expect((await errored)['message']).toBe('the device rejected the input')
      })

      it('answers unsupported for a button name the helper has no mapping for', async () => {
        const helper = getState().touchHelper!
        helper.pressButton.mockResolvedValue('unsupported')

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:button', requestId: 'rq-in18', payload: { name: 'not_a_button' } })

        expect((await errored)['message']).toContain('not supported')
      })

      it('answers unsupported for a pinch that fell back to the adb path', async () => {
        // No pointer channel → the adb helper, which implements no pinch at all and used to accept
        // the frames and answer success.
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:pinch:end', requestId: 'rq-in19', payload: { f0: { x: 0.5, y: 0.5 }, f1: { x: 0.5, y: 0.5 } } })

        expect((await errored)['message']).toContain('not supported')
      })

      it('answers channel-down for a tap with neither a channel nor a helper', async () => {
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null
        state.touchHelper = null

        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:touch:end', requestId: 'rq-in20', payload: { x: 0.5, y: 0.5 } })

        expect((await errored)['message']).toBe('input channel not ready')
      })

      // The ws dispatch swallows synchronous throws, so destructuring out in the handler body left
      // the caller with no ack at all. The *reason* matters as much as the answer: a payload problem
      // is not a dead channel, and saying so would be the lie this vocabulary exists to prevent.
      for (const type of ['input:button', 'input:key']) {
        it(`answers malformed — not channel-down — for a ${type} with no payload`, async () => {
          const errored = waitForType(browser, 'input:error')
          internals(agent).handleRelayMessage({ type, sessionId: agent.sessionId, requestId: 'rq-malformed' })
          expect((await errored)['message']).toContain('missing what it needs')
        })
      }

      it('does not cache the boot verify across a reboot that started under the dispatch', async () => {
        // The ack is now sent after an awaited dispatch, so a `device:boot` can land in between.
        // Caching `booted` from a verify that raced it would let every later input on the session
        // skip the check while the device is still coming up.
        const state = getState()
        state.scrcpySession = null
        state.grpcClient = null
        state.booted = false
        let release: (v: string) => void = () => {}
        state.touchHelper!.touchEnd.mockReturnValue(new Promise((r) => { release = r }))

        const done = waitForType(browser, 'input:done')
        inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
        inject({ type: 'input:touch:end', requestId: 'rq-in21', payload: { x: 0.5, y: 0.5 } })
        state.bootSeq += 1 // a reboot begins while the dispatch is still in flight
        release('delivered')
        await done

        expect(state.booted).toBe(false)
      })

      // The mutation this missed: `state.booted` was cached from the verify without checking the
      // outcome, so the *second* input on an unbooted session skipped the verify and answered done.
      it('does not cache the boot verify when the device is not booted', async () => {
        const listDevices = vi.spyOn(adb, 'listDevices').mockResolvedValue([
          { id: 'avd:Pixel_8_API_34', name: 'Pixel 8', platform: 'android', status: 'shutdown', osVersion: '14' },
        ])
        getState().booted = false

        for (const attempt of [1, 2]) {
          const errored = waitForType(browser, 'input:error')
          inject({ type: 'input:touch:start', payload: { x: 0.5, y: 0.5 } })
          inject({ type: 'input:touch:end', requestId: 'rq-in22', payload: { x: 0.5, y: 0.5 } })
          expect((await errored)['message'], `attempt ${attempt}`).toBe('device not booted')
        }
        // Re-verified rather than trusting a cache that the first attempt must not have written.
        expect(listDevices.mock.calls.length).toBeGreaterThanOrEqual(2)
      })
    })

    // `handleKeyInput` resolves without sending anything in two branches. Judging by "did it throw"
    // reproduced the very lie this change removes.
    describe('input — key outcomes', () => {
      it('answers unsupported for a chord it deliberately does not send', async () => {
        const sendKeyEvent = vi.spyOn(adb, 'sendKeyEvent')
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in23', payload: { code: 'KeyA', modifiers: 0x08 } }) // Cmd+A
        expect((await errored)['message']).toContain('not supported')
        expect(sendKeyEvent).not.toHaveBeenCalled()
      })

      it('answers unsupported for a code that is only a prototype member', async () => {
        const sendKeyEvent = vi.spyOn(adb, 'sendKeyEvent')
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in24', payload: { code: 'constructor', modifiers: 0 } })
        expect((await errored)['message']).toContain('not supported')
        expect(sendKeyEvent).not.toHaveBeenCalled()
      })

      it('answers unsupported for a code with no character mapping', async () => {
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in25', payload: { code: 'CapsLock', modifiers: 0 } })
        expect((await errored)['message']).toContain('not supported')
      })

      it('answers failed when the key dispatch rejects', async () => {
        vi.spyOn(adb, 'sendInput').mockRejectedValue(new Error('offline'))
        const errored = waitForType(browser, 'input:error')
        inject({ type: 'input:key', requestId: 'rq-in26', payload: { code: 'KeyA', modifiers: 0 } })
        expect((await errored)['message']).toBe('the device rejected the input')
      })

      it('still answers input:done for a key it does send', async () => {
        const done = waitForType(browser, 'input:done')
        inject({ type: 'input:key', requestId: 'rq-in27', payload: { code: 'Enter', modifiers: 0 } })
        await done
      })
    })

    describe('misc — device:shutdown', () => {
      it('tears down the device and acks with device:shutdown-done', async () => {
        const shutdownSpy = vi.spyOn(adb, 'shutdown')
        const done = waitForType(browser, 'device:shutdown-done')
        inject({ type: 'device:shutdown', payload: { deviceId: 'avd:Pixel_8_API_34' } })
        const msg = await done
        expect(msg['payload']).toMatchObject({ deviceId: 'avd:Pixel_8_API_34' })
        expect(shutdownSpy).toHaveBeenCalledWith('emulator-5554')
        expect(adb.getSerial('avd:Pixel_8_API_34')).toBeUndefined() // serial cleared
      })
    })

    // The reply direction for all three app commands. See the iOS suite for why: review made all six
    // `respond` helpers emit a fabricated correlator and both agent suites held their baselines exactly.
    describe('app command correlation', () => {
      const PAIRS = [
        { req: 'app:install', payload: { filePath: '/tmp/app.apk' }, call: 'installApp' as const },
        { req: 'app:launch', payload: { bundleId: 'com.example.app' }, call: 'launchApp' as const },
        { req: 'app:clear-state', payload: { bundleId: 'com.example.app' }, call: 'clearAppData' as const },
      ]

      for (const { req, payload, call } of PAIRS) {
        it(`${req} echoes the requestId on both outcomes`, async () => {
          // Mocked explicitly rather than left to fall through: `adb` here is a real object with spies
          // added per test, so an unmocked call reaches the real binary and the test times out instead of
          // failing. (`app:install` also calls `clearAppData` on its way, which is how that surfaced.)
          vi.spyOn(adb, call).mockResolvedValue(undefined)
          vi.spyOn(adb, 'clearAppData').mockResolvedValue(undefined)
          const done = waitForType(browser, `${req}-done`)
          inject({ type: req, requestId: 'echo-1', payload })
          expect((await done)['requestId']).toBe('echo-1')

          vi.spyOn(adb, call).mockRejectedValueOnce(new Error('nope'))
          const err = waitForType(browser, `${req}-error`)
          inject({ type: req, requestId: 'echo-2', payload })
          const msg = await err
          expect(msg['requestId']).toBe('echo-2')
          expect(msg['message']).toBe('nope')
        })

        it(`${req} answers two concurrent requests with their own ids`, async () => {
          // TC5 — the only test that sees a correlator hoisted out of per-request scope.
          let release: (() => void) | undefined
          vi.spyOn(adb, call)
            .mockImplementationOnce(() => new Promise<void>((r) => { release = () => r() }))
            .mockImplementationOnce(() => Promise.resolve())

          inject({ type: req, requestId: 'con-A', payload })
          await vi.waitFor(() => expect(release).toBeDefined())

          // Sequential: `waitForType` does not correlate, so two concurrent waits would pass under the
          // mutation this exists to catch.
          inject({ type: req, requestId: 'con-B', payload })
          expect((await waitForType(browser, `${req}-done`))['requestId']).toBe('con-B')

          release!()
          expect((await waitForType(browser, `${req}-done`))['requestId']).toBe('con-A')
        })
      }
    })

    describe('misc — app:launch', () => {
      it('launches the package and acks with app:launch-done', async () => {
        const launchSpy = vi.spyOn(adb, 'launchApp')
        const done = waitForType(browser, 'app:launch-done')
        inject({ type: 'app:launch', requestId: 'rqi-1', payload: { bundleId: 'com.example.app' } })
        await done
        expect(launchSpy).toHaveBeenCalledWith('emulator-5554', 'com.example.app')
      })
    })

    describe('misc — open-url', () => {
      it('opens the URL on the device and echoes the requestId on open-url:done', async () => {
        const urlSpy = vi.spyOn(adb, 'openUrl')
        const done = waitForType(browser, 'open-url:done')
        inject({ type: 'open-url', requestId: 'req-1', payload: { url: 'https://example.com' } })
        expect((await done)['requestId']).toBe('req-1')
        expect(urlSpy).toHaveBeenCalledWith('emulator-5554', 'https://example.com')
      })

      it('reports open-url:error with the failure message, and echoes the requestId', async () => {
        vi.spyOn(adb, 'openUrl').mockRejectedValue(new Error('activity not found'))
        const err = waitForType(browser, 'open-url:error')
        inject({ type: 'open-url', requestId: 'req-2', payload: { url: 'https://example.com' } })
        const msg = await err
        expect(msg['message']).toBe('activity not found')
        expect(msg['requestId']).toBe('req-2')
      })

      it('drops a request with no requestId rather than answering uncorrelatably', async () => {
        // The correlator is required on the wire and there is no fallback, so a reply to this could not
        // be matched by anyone — and inventing an id would make it look like an answer to a request
        // nobody made. Every in-repo sender supplies one; validating third-party frames at the relay's
        // door is #444. Until then the honest outcome is nothing, which is what this pins.
        const urlSpy = vi.spyOn(adb, 'openUrl')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        inject({ type: 'open-url', payload: { url: 'https://example.com' } })
        await barrier(browser)
        expect(await waitForTypeOrNull(browser, 'open-url:done', 0)).toBeNull()
        expect(urlSpy).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('open-url without a requestId'))
      })
    })

    describe('misc — screenshot:request', () => {
      // The relay routes screenshot:done back to a pending HTTP request by requestId (not to the
      // session browser), so assert the agent's own outgoing reply on its relay socket.
      it('captures a screenshot and replies with base64 data + requestId', async () => {
        vi.spyOn(adb, 'screenshot').mockResolvedValue(Buffer.from('PNGDATA'))
        const sendSpy = vi.spyOn(internals(agent).ws!, 'send')

        inject({ type: 'screenshot:request', requestId: 'req-1', format: 'png' })

        const sent = await vi.waitFor(() => {
          const msg = sendSpy.mock.calls
            .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
            .find((m) => m['type'] === 'screenshot:done')
          expect(msg).toBeDefined()
          return msg!
        }, { timeout: 1000 })

        expect(sent['requestId']).toBe('req-1')
        expect(sent['format']).toBe('png')
        expect(sent['data']).toBe(Buffer.from('PNGDATA').toString('base64'))
      })

      it('answers png for a jpeg request, because that is what it produced (#508)', async () => {
        // `screencap -p` produces PNG and takes no format argument, so the request is a preference
        // this platform cannot honour (see `ScreenshotRequest` in protocol). Echoing it sent PNG
        // bytes out under `format: 'jpeg'`, which the relay wrote into the HTTP Content-Type — and
        // `mcp-server` then picked a JPEG parser for the dimensions it feeds to `tap` as divisors.
        vi.spyOn(adb, 'screenshot').mockResolvedValue(Buffer.from('PNGDATA'))
        const sendSpy = vi.spyOn(internals(agent).ws!, 'send')

        inject({ type: 'screenshot:request', requestId: 'req-2', format: 'jpeg' })

        const sent = await vi.waitFor(() => {
          const msg = sendSpy.mock.calls
            .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
            .find((m) => m['type'] === 'screenshot:done')
          expect(msg).toBeDefined()
          return msg!
        }, { timeout: 1000 })

        expect(sent['format']).toBe('png')
        expect(sent['requestId']).toBe('req-2')
      })
    })
  })

  // gRPC host-encode backend (emulator default). Unpin the backend to 'grpc' so an emulator serial
  // takes the gRPC path; the rest of the suite stays pinned to scrcpy via beforeAll.
  describe('gRPC backend', () => {
    let agent: AndroidAgent
    let adb: AdbWrapper
    let browser: WebSocket
    let pinned: string | undefined

    function getState(): TestState {
      return internals(agent).deviceStates.values().next().value!
    }

    async function bootDevice(): Promise<void> {
      browser = new WebSocket(`ws://localhost:${port}`)
      await waitForOpen(browser)
      browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
      await waitForType(browser, 'session:joined')
      browser.send(JSON.stringify({
        type: 'device:boot',
        requestId: 'rq-fix-13',
        sessionId: agent.sessionId,
        payload: { deviceId: 'avd:Pixel_8_API_34' },
      }))
      await waitForType(browser, 'device:ready')
    }

    beforeEach(async () => {
      pinned = process.env.TAPFLOW_ANDROID_BACKEND // live value (scrcpy, from the suite beforeAll)
      process.env.TAPFLOW_ANDROID_BACKEND = 'grpc'
      grpcStartError = null
      grpcFramesController = null
      scrcpyStreamController = null

      adb = mockAdb(true)
      vi.spyOn(adb, 'getScreenSize').mockResolvedValue({ width: 1080, height: 2400 })
      agent = new AndroidAgent({}, adb)
      await agent.connect(`ws://localhost:${port}`)
    })

    afterEach(async () => {
      agent.disconnect()
      browser?.close()
      try { grpcFramesController?.close() } catch { /* already closed */ }
      try { scrcpyStreamController?.close() } catch { /* already closed */ }
      await new Promise((r) => setImmediate(r))
      grpcStartError = null
      grpcFramesController = null
      scrcpyStreamController = null
      if (pinned === undefined) delete process.env.TAPFLOW_ANDROID_BACKEND
      else process.env.TAPFLOW_ANDROID_BACKEND = pinned
    })

    it('routes an emulator serial through the gRPC video path (no scrcpy session)', async () => {
      await bootDevice()
      await vi.waitFor(() => expect(getState().emulatorVideo).not.toBeNull(), { timeout: 1000 })

      expect(vi.mocked(EmulatorVideo)).toHaveBeenCalled()
      expect(vi.mocked(EmulatorGrpcClient)).toHaveBeenCalled()
      expect(getState().grpcClient).not.toBeNull()
      expect(getState().scrcpySession).toBeNull() // gRPC path never opens scrcpy
      // native screen size from adb drives the touch-mapping dimensions
      expect(getState().videoWidth).toBe(1080)
      expect(getState().videoHeight).toBe(2400)
    })

    // Clipboard bridge — the emulator gRPC controller exposes get/setClipboard, so the
    // Android side needs no adb (`cmd clipboard` is not implemented on the AVD images).
    describe('clipboard bridge', () => {
      beforeEach(() => { grpcClipboardText = ''; grpcClipboardError = null; grpcClipboardApplyDelayMs = 0 })
      afterEach(() => { grpcClipboardError = null; grpcClipboardApplyDelayMs = 0 })

      // Same gate as iOS: the viewer only enables the bridge when this arrives.
      it('advertises the clipboard capability all the way to the viewer', async () => {
        browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        const joined = await waitForType<SessionJoined>(browser, 'session:joined')
        expect(joined.capabilities).toContain('clipboard')
      })

      // #447: the toggle is gated on this, not on the platform string — so the capability and the
      // `-wipe-data` launch flag have to arrive together. Advertising it without the flag puts a
      // control on screen that erases nothing and then disarms, which reads as "done".
      it('advertises the full-reset capability all the way to the viewer', async () => {
        browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        const joined = await waitForType<SessionJoined>(browser, 'session:joined')
        expect(joined.capabilities).toContain('full-reset')
      })

      // #607. Added last on purpose: the string says "this agent has the code", so advertising it
      // before the handler exists puts a control on screen that does nothing — the failure #447
      // exists to document, two tests above in this same file.
      it('advertises the network-control capability all the way to the viewer', async () => {
        browser = new WebSocket(`ws://localhost:${port}`)
        await waitForOpen(browser)
        browser.send(JSON.stringify({ type: 'session:start', sessionId: agent.sessionId }))
        const joined = await waitForType<SessionJoined>(browser, 'session:joined')
        expect(joined.capabilities).toContain('network-control')
      })

      it('clipboard:read returns the guest clipboard as clipboard:data', async () => {
        grpcClipboardText = '한글 テスト 🎉\nline2'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a1' }))
        const data = await waitForType(browser, 'clipboard:data')
        expect(data.requestId).toBe('a1')
        expect((data.payload as { text: string }).text).toBe('한글 テスト 🎉\nline2')
      })

      // The agent owns the chord: the browser cannot know when the keyevent lands, and
      // reading before it does returns the PREVIOUS clipboard.
      it('press:copy sends KEYCODE_COPY before it reads', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const order: string[] = []
        // the guest "copies" when the keyevent lands
        vi.spyOn(adb, 'sendKeyEvent').mockImplementation(async (_s, k) => {
          order.push(String(k)); grpcClipboardText = 'copied'
        })
        const client = getState().grpcClient as unknown as { getClipboard: ReturnType<typeof vi.fn> }
        const realGet = client.getClipboard.getMockImplementation()! as () => Promise<string>
        client.getClipboard.mockImplementation(async () => { order.push('read'); return realGet() })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a2', payload: { press: 'copy' },
        }))
        const data = await waitForType(browser, 'clipboard:data')
        expect((data.payload as { text: string }).text).toBe('copied')
        expect(order.indexOf('KEYCODE_COPY')).toBeLessThan(order.lastIndexOf('read'))
      })

      // The core guarantee: no answer until the guest clipboard actually changed.
      it('keeps watching until the clipboard actually changes', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        let reads = 0
        const client = getState().grpcClient as unknown as { getClipboard: ReturnType<typeof vi.fn> }
        const realGet = client.getClipboard.getMockImplementation()! as () => Promise<string>
        client.getClipboard.mockImplementation(async () => (++reads <= 3 ? realGet() : 'what the app copied'))
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a2b', payload: { press: 'copy' },
        }))
        const data = await waitForType(browser, 'clipboard:data')
        expect((data.payload as { text: string }).text).toBe('what the app copied')
        expect(reads).toBeGreaterThan(2)   // a fixed delay would have answered on the first read
      })

      // B1: setClipboard only *schedules* the change. If the chord is pressed before the
      // sentinel is visible, the first poll reads the pre-sentinel value and returns it as the
      // copy result — the exact stale value the sentinel exists to prevent.
      it('waits for the sentinel to be applied before pressing the chord', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        grpcClipboardApplyDelayMs = 60          // the guest lags behind the resolved call
        vi.spyOn(adb, 'sendKeyEvent').mockImplementation(async () => {
          setTimeout(() => { grpcClipboardText = 'WHAT THE APP COPIED' }, 60)
        })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'b1', payload: { press: 'copy' },
        }))
        const data = await waitForType(browser, 'clipboard:data')
        expect((data.payload as { text: string }).text).toBe('WHAT THE APP COPIED')
      }, 10_000)

      // M2: without the per-device queue, two reads trade sentinels — one returns the other's
      // marker and a sentinel is left on the device.
      // Mirror of the iOS test of the same name. Reverting Android to reply-after-restore
      // previously broke nothing here, so the platform's half of the ordering was unguarded.
      it('answers before it restores, and still restores before releasing the device', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)   // the guest never copies
        const client = getState().grpcClient as unknown as { setClipboard: ReturnType<typeof vi.fn> }
        const realSet = client.setClipboard.getMockImplementation() as ((t: string) => Promise<void>) | undefined
        let restoreDone = false
        // Make the restore slow enough that "reply first" cannot be a scheduling artefact.
        client.setClipboard.mockImplementation(async (text: string) => {
          if (text === 'ORIGINAL') {
            await new Promise((r) => setTimeout(r, 400))
            restoreDone = true
          }
          return realSet?.(text)
        })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'ord', payload: { press: 'copy' },
        }))
        await waitForType(browser, 'clipboard:error')
        expect(restoreDone).toBe(false)   // answered while the restore was still in flight
        await vi.waitFor(() => expect(restoreDone).toBe(true), { timeout: 3000 })
      }, 15_000)

      it('reports a parked sentinel when the copy failed after the marker went down', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'sp1', payload: { press: 'copy' },
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(true)
      }, 10_000)

      // The flag describes the DEVICE, not the operation that answers: the chord the viewer would
      // press in response travels as `input:key`, outside the queue that keeps operations apart.
      it('reports a sentinel parked by a different in-flight operation', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'hold', payload: { press: 'copy' },
        }))
        await vi.waitFor(() => expect(grpcClipboardText.startsWith('\u200Btapflow-clipboard-')).toBe(true), { timeout: 2000 })

        // Rejected up front, before the queue — so it answers while the read above still holds.
        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'big',
          payload: { text: 'x'.repeat(1024 * 1024 + 1) },   // MAX_CLIPBOARD_BYTES + 1
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.requestId).toBe('big')
        expect((err.payload as { sentinelParked: boolean }).sentinelParked).toBe(true)

        // Let the read finish before leaving: it still holds the device queue, and the next test
        // would otherwise wait out its deadline and restore.
        await vi.waitFor(() => expect(grpcClipboardText).toBe('ORIGINAL'), { timeout: 5000 })
      }, 20_000)

      // Only reachable if the per-device queue fails, but the queue is the sole thing standing
      // between these and a corrupted clipboard, so the discrimination itself is pinned.
      it('never hands a foreign sentinel back as copied text', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockImplementation(async () => {
          grpcClipboardText = '\u200Btapflow-clipboard-someone-else'   // another operation's marker
        })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'f1', payload: { press: 'copy' },
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.message).toMatch(/did not copy/i)   // not clipboard:data carrying the marker
      }, 10_000)

      it('does not restore a foreign sentinel as if it were the user text', async () => {
        grpcClipboardText = '\u200Btapflow-clipboard-someone-else'   // already parked on arrival
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)   // the guest never copies

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'f2', payload: { press: 'copy' },
        }))
        await waitForType(browser, 'clipboard:error')
        // Restoring it would leave it for the NEXT read to mistake for the original.
        await vi.waitFor(() => expect(grpcClipboardText).toBe(''), { timeout: 2000 })
      }, 10_000)

      it('serialises overlapping reads so they cannot trade sentinels', async () => {
        grpcClipboardText = 'ORIGINAL'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)   // the guest never copies

        const seen: string[] = []
        browser.on('message', (d) => {
          const m = JSON.parse(d.toString()) as { type: string; requestId?: string; payload?: unknown }
          if (m.type === 'clipboard:data') seen.push(`${m.requestId}:${(m.payload as { text: string }).text}`)
          if (m.type === 'clipboard:error') seen.push(`${m.requestId}:ERR`)
        })
        // The guest applies a scheduled setClipboard late, so releasing the queue before the
        // restore lands lets the next read see the sentinel as "the original" — and then wipe it.
        grpcClipboardApplyDelayMs = 120

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'P1', payload: { press: 'copy' } }))
        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'P2', payload: { press: 'copy' } }))
        await vi.waitFor(() => expect(seen.length).toBe(2), { timeout: 9000 })

        // Neither may report a sentinel as the copied text, and the original must survive.
        expect(seen).toEqual(['P1:ERR', 'P2:ERR'])
        await vi.waitFor(() => expect(grpcClipboardText).toBe('ORIGINAL'), { timeout: 2000 })
      }, 15_000)

      it('fails and restores the original when the device never copies', async () => {
        grpcClipboardText = 'untouched original'
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)   // the guest ignores it

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a2c', payload: { press: 'copy' },
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.message).toMatch(/did not copy/i)
        expect(grpcClipboardText).toBe('untouched original')   // no sentinel left behind
      }, 10_000)

      it('press:cut sends KEYCODE_CUT instead', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const keys = vi.spyOn(adb, 'sendKeyEvent').mockImplementation(async () => { grpcClipboardText = 'cut text' })

        browser.send(JSON.stringify({
          type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a3', payload: { press: 'cut' },
        }))
        await waitForType(browser, 'clipboard:data')
        expect(keys).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_CUT')
      })

      it('clipboard:write sets the guest clipboard and acks only after it landed', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const client = getState().grpcClient as unknown as { setClipboard: ReturnType<typeof vi.fn> }
        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        client.setClipboard.mockReturnValue(gate)

        let acked = false
        void waitForType(browser, 'clipboard:write-done').then(() => { acked = true })
        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'a4', payload: { text: 'pasted' },
        }))
        await vi.waitFor(() => expect(client.setClipboard).toHaveBeenCalledWith('pasted'))
        await new Promise((r) => setTimeout(r, 50))
        expect(acked).toBe(false)
        release()
        await vi.waitFor(() => expect(acked).toBe(true))
      })

      it('pasteAfter sends KEYCODE_PASTE after the write', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const keys = vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        const done = waitForType(browser, 'clipboard:write-done')
        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'a5', payload: { text: 'x', pasteAfter: true },
        }))
        await done
        expect(keys).toHaveBeenCalledWith('emulator-5554', 'KEYCODE_PASTE')
        expect(grpcClipboardText).toBe('x')
      })

      it('does not press paste when pasteAfter is not asked for', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const keys = vi.spyOn(adb, 'sendKeyEvent').mockResolvedValue(undefined)

        const done = waitForType(browser, 'clipboard:write-done')
        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'a6', payload: { text: 'x' },
        }))
        await done
        expect(keys).not.toHaveBeenCalled()
      })

      it('rejects an oversized clipboard instead of forwarding it', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        const client = getState().grpcClient as unknown as { setClipboard: ReturnType<typeof vi.fn> }
        client.setClipboard.mockClear()

        browser.send(JSON.stringify({
          type: 'clipboard:write', sessionId: agent.sessionId, requestId: 'a7',
          payload: { text: 'x'.repeat(1024 * 1024 + 1) },
        }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.message).toMatch(/too large/i)
        expect(client.setClipboard).not.toHaveBeenCalled()
      })

      // The press-less read forwarded whatever the guest held straight to the relay. iOS is
      // bounded by getPasteboard's maxBuffer; Android had nothing, so a multi-MB guest
      // clipboard could land on the socket the video stream shares.
      it('caps a press-less read too, not just the sentinel path', async () => {
        grpcClipboardText = 'x'.repeat(1024 * 1024 + 1)
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'cap' }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.message).toMatch(/too large/i)
      })

      it('an empty clipboard is data, not an error', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a8' }))
        const data = await waitForType(browser, 'clipboard:data')
        expect((data.payload as { text: string }).text).toBe('')
      })

      it('surfaces a gRPC failure as clipboard:error', async () => {
        await bootDevice()
        await vi.waitFor(() => expect(getState().grpcClient).not.toBeNull(), { timeout: 1000 })
        grpcClipboardError = new Error('UNAVAILABLE: no connection')

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a9' }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.requestId).toBe('a9')
        expect(err.message).toContain('UNAVAILABLE')
        // A transient gRPC fault is NOT "unsupported": the backend has a clipboard channel, it
        // just failed this time. This request carries no `press`, so nothing was ever parked and
        // the viewer is free to fall back to the chord.
        const payload = err.payload as { unsupported: boolean; sentinelParked: boolean }
        expect(payload.unsupported).toBe(false)
        expect(payload.sentinelParked).toBe(false)
      })

      // R8: the scrcpy backend (real devices, and the gRPC fallback) has no clipboard
      // channel. It must say so — and say something DIFFERENT from "not booted", since
      // the two need different fixes.
      it('reports the backend limitation on scrcpy, distinctly from a missing device', async () => {
        grpcStartError = new Error('emulator -grpc not available')
        await bootDevice()
        await vi.waitFor(() => expect(getState().scrcpySession).not.toBeNull(), { timeout: 1000 })
        expect(getState().grpcClient).toBeNull()

        browser.send(JSON.stringify({ type: 'clipboard:read', sessionId: agent.sessionId, requestId: 'a10' }))
        const err = await waitForType(browser, 'clipboard:error')
        expect(err.requestId).toBe('a10')
        expect(err.message).toMatch(/gRPC backend/i)
        expect(err.message).not.toMatch(/no booted device/i)
        // Flagged so the viewer can safely press the plain chord: a backend without a
        // clipboard channel can never leave a sentinel on the device.
        expect((err.payload as { unsupported: boolean }).unsupported).toBe(true)
      })
    })

    it('falls back to scrcpy when the gRPC video stream fails to start', async () => {
      grpcStartError = new Error('emulator -grpc not available')

      await bootDevice()
      await vi.waitFor(() => expect(getState().scrcpySession).not.toBeNull(), { timeout: 1000 })

      // gRPC was attempted then torn down, scrcpy took over so streaming still works.
      expect(vi.mocked(EmulatorVideo)).toHaveBeenCalled()
      expect(vi.mocked(ScrcpySession)).toHaveBeenCalled()
      expect(getState().emulatorVideo).toBeNull()
      expect(getState().grpcClient).toBeNull()
    })

    // #341: with audio on, mute the emulator's host output on the agent Mac via a mute-only tap.
    it('host-mute: launches a mute-only tap on the emulator pid (audio on, macOS 14.2+)', async () => {
      vi.mocked(isAudioSupported).mockReturnValue(true)
      vi.mocked(findEmulatorPid).mockReturnValue(9999)
      vi.mocked(launchMuteOnlyTap).mockClear()
      await bootDevice()
      await vi.waitFor(() => expect(vi.mocked(launchMuteOnlyTap)).toHaveBeenCalledTimes(1))
      const [appPath, pids] = vi.mocked(launchMuteOnlyTap).mock.calls[0]
      expect(appPath).toBe('/fake/audiotap-helper.app')
      expect(pids).toEqual([9999])
      vi.mocked(isAudioSupported).mockReturnValue(false) // restore for the other tests
      vi.mocked(findEmulatorPid).mockReturnValue(null)
    })

    it('host-mute: skipped below macOS 14.2 (falls back to the Mac volume)', async () => {
      vi.mocked(isAudioSupported).mockReturnValue(false)
      vi.mocked(launchMuteOnlyTap).mockClear()
      await bootDevice()
      await new Promise((r) => setTimeout(r, 30))
      expect(vi.mocked(launchMuteOnlyTap)).not.toHaveBeenCalled()
    })
  })
})

describe('pickAndroidBackend', () => {
  it('honors TAPFLOW_ANDROID_BACKEND=scrcpy even for an emulator serial', () => {
    expect(pickAndroidBackend('emulator-5554', { TAPFLOW_ANDROID_BACKEND: 'scrcpy' })).toBe('scrcpy')
  })

  it('honors TAPFLOW_ANDROID_BACKEND=grpc even for a real-device serial', () => {
    expect(pickAndroidBackend('39021FDH2003ZZ', { TAPFLOW_ANDROID_BACKEND: 'grpc' })).toBe('grpc')
  })

  it('defaults an emulator-* serial to grpc when unset', () => {
    expect(pickAndroidBackend('emulator-5556', {})).toBe('grpc')
  })

  it('defaults a real-device serial to scrcpy when unset', () => {
    expect(pickAndroidBackend('39021FDH2003ZZ', {})).toBe('scrcpy')
  })
})

describe('parseSpsFromNal', () => {
  // Independent Exp-Golomb SPS writer — a separate implementation of the H.264 SPS bit layout, so
  // the dimensions we assert come from the values WE encode, not from re-running the parser.
  class SpsBuilder {
    private bits: number[] = []
    u(n: number, val: number): this {
      for (let i = n - 1; i >= 0; i--) this.bits.push((val >> i) & 1)
      return this
    }
    ue(val: number): this {
      const code = val + 1
      const nb = Math.floor(Math.log2(code))
      for (let i = 0; i < nb; i++) this.bits.push(0)
      for (let i = nb; i >= 0; i--) this.bits.push((code >> i) & 1)
      return this
    }
    annexB(): Buffer {
      const padded = [...this.bits]
      while (padded.length % 8 !== 0) padded.push(0)
      const body: number[] = []
      for (let i = 0; i < padded.length; i += 8) {
        let b = 0
        for (let j = 0; j < 8; j++) b = (b << 1) | padded[i + j]!
        body.push(b)
      }
      // 4-byte Annex B start code + NAL header byte (0x67 = ref_idc 3, type 7 = SPS)
      return Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67]), Buffer.from(body)])
    }
  }

  // Common SPS prefix up to (and including) gaps_in_frame_num_value_allowed_flag for a baseline
  // (profile_idc 66) stream — baseline skips the high-profile chroma_format block.
  function baselineHead(b: SpsBuilder): SpsBuilder {
    return b
      .u(8, 66)    // profile_idc = 66 (baseline → no chroma block)
      .u(8, 0xc0)  // constraint flags (consumed, value irrelevant)
      .u(8, 31)    // level_idc
      .ue(0)       // seq_parameter_set_id
      .ue(0)       // log2_max_frame_num_minus4
      .ue(0)       // pic_order_cnt_type = 0
      .ue(0)       // log2_max_pic_order_cnt_lsb_minus4 (poc_type 0)
      .ue(1)       // max_num_ref_frames
      .u(1, 0)     // gaps_in_frame_num_value_allowed_flag
  }

  it('parses width/height from a 1280×720 baseline SPS (no cropping)', () => {
    const sps = baselineHead(new SpsBuilder())
      .ue(79)   // pic_width_in_mbs_minus1 → (79+1)*16 = 1280
      .ue(44)   // pic_height_in_map_units_minus1 → (44+1)*16 = 720
      .u(1, 1)  // frame_mbs_only_flag = 1
      .u(1, 1)  // direct_8x8_inference_flag
      .u(1, 0)  // frame_cropping_flag = 0
      .annexB()

    expect(parseSpsFromNal(sps)).toEqual({ width: 1280, height: 720 })
  })

  it('applies frame cropping (1920×1080 from a 1088-tall coded frame)', () => {
    const sps = baselineHead(new SpsBuilder())
      .ue(119)  // width → (119+1)*16 = 1920
      .ue(67)   // map units → (67+1)*16 = 1088 coded height
      .u(1, 1)  // frame_mbs_only_flag = 1
      .u(1, 1)  // direct_8x8_inference_flag
      .u(1, 1)  // frame_cropping_flag = 1
      .ue(0).ue(0).ue(0) // crop left/right/top = 0
      .ue(4)    // crop_bottom = 4 → 1088 - 4*2(subHeightC) = 1080
      .annexB()

    expect(parseSpsFromNal(sps)).toEqual({ width: 1920, height: 1080 })
  })

  it('returns null for a NAL with no Annex B start code', () => {
    expect(parseSpsFromNal(Buffer.from([0x67, 0x42, 0xc0, 0x1f]))).toBeNull()
  })

  it('returns null for a non-SPS NAL unit (type ≠ 7)', () => {
    // start code + 0x41 (nal_unit_type = 1, a P-slice) → not an SPS
    expect(parseSpsFromNal(Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x00]))).toBeNull()
  })

  it('returns null for a truncated SPS instead of throwing', () => {
    // start code + SPS header but no dimension fields → bit reader runs out → caught → null
    expect(parseSpsFromNal(Buffer.from([0, 0, 0, 1, 0x67]))).toBeNull()
  })
})

describe('connect — error paths', () => {
  let server: WebSocketServer
  let url: string

  async function startServer(onConnection: (ws: WebSocket) => void): Promise<void> {
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => server.once('listening', r))
    url = `ws://localhost:${(server.address() as { port: number }).port}`
    server.on('connection', (ws) => onConnection(ws as unknown as WebSocket))
  }

  afterEach(async () => {
    // A rejected handshake leaves the agent's raw socket open, which would block server.close();
    // terminate any lingering clients first.
    for (const client of server.clients) client.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('rejects with a PlatformError when the handshake reply is not agent:registered', async () => {
    await startServer((ws) => {
      ws.on('message', () => ws.send(JSON.stringify({ type: 'agent:rejected' })))
    })
    const agent = new AndroidAgent({}, mockAdb())

    await expect(agent.connect(url)).rejects.toThrow(/Unexpected message during handshake/)
    agent.disconnect()
  })

  it('ignores a malformed (non-JSON) frame and keeps handling subsequent messages', async () => {
    let serverWs: WebSocket
    await startServer((ws) => {
      serverWs = ws
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'agent:register') {
          ws.send(JSON.stringify({ type: 'agent:registered', registeredSessions: [] }))
        }
      })
    })
    const agent = new AndroidAgent({}, mockAdb())
    await agent.connect(url) // resolves once agent:registered arrives

    // The agent's message loop must swallow a malformed frame without tearing down the connection.
    serverWs!.send('this is not json {{{')

    // Prove the connection still works: a valid request after the bad frame still gets a reply.
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      serverWs!.on('message', (d) => {
        const m = JSON.parse(d.toString())
        if (m.type === 'app:install-error') resolve(m)
      })
    })
    serverWs!.send(JSON.stringify({ type: 'app:install', requestId: 'rqi-2', sessionId: 'unknown', payload: { filePath: '/tmp/app.apk' } }))

    const m = await reply
    expect(m['message']).toBe('No booted device')
    agent.disconnect()
  })

  // #271 — 원격 릴레이 인증: token 옵션이 control/stream WS 업그레이드에 Bearer 헤더로 실린다.
  // (iOS와 동일 동작 — IOSAgent.test.ts의 relay auth token 테스트와 짝)
  describe('relay auth token (#271)', () => {
    async function withRawServer<T>(
      onConnection: (sock: WebSocket, authHeader: string | undefined) => void,
      run: (url: string) => Promise<T>,
    ): Promise<T> {
      const wss = new WebSocketServer({ port: 0 })
      // 느린 러너에서 address()가 null일 수 있으므로 listening 이후 포트를 읽는다
      await new Promise<void>((r) => wss.once('listening', r))
      const wssPort = (wss.address() as { port: number }).port
      wss.on('connection', (sock, req) => onConnection(sock as unknown as WebSocket, req.headers.authorization))
      try {
        return await run(`ws://127.0.0.1:${wssPort}`)
      } finally {
        await new Promise<void>((r) => wss.close(() => r()))
      }
    }

    it('token 옵션이 있으면 control WS에 Authorization: Bearer 헤더가 실린다', async () => {
      let seen: string | undefined
      await withRawServer(
        (sock, auth) => {
          seen = auth
          sock.on('message', () => sock.send(JSON.stringify({ type: 'agent:registered', registeredSessions: [] })))
        },
        async (url) => {
          const agent = new AndroidAgent({ token: 'tflw_pat_android' }, mockAdb())
          await agent.connect(url)
          agent.disconnect()
        },
      )
      expect(seen).toBe('Bearer tflw_pat_android')
    })

    it('token이 없으면 Authorization 헤더를 보내지 않는다', async () => {
      let seen: string | undefined = 'sentinel'
      await withRawServer(
        (sock, auth) => {
          seen = auth
          sock.on('message', () => sock.send(JSON.stringify({ type: 'agent:registered', registeredSessions: [] })))
        },
        async (url) => {
          const agent = new AndroidAgent({}, mockAdb())
          await agent.connect(url)
          agent.disconnect()
        },
      )
      expect(seen).toBeUndefined()
    })

    it('stream WS(openStreamWs)에도 같은 토큰 헤더가 실린다', async () => {
      let seen: string | undefined
      await withRawServer(
        (sock, auth) => {
          seen = auth
          sock.on('message', () => sock.send(JSON.stringify({ type: 'stream:registered' })))
        },
        async (url) => {
          const agent = new AndroidAgent({ token: 'tflw_pat_android' }, mockAdb())
          const internals = agent as unknown as {
            relayUrl: string | null
            openStreamWs(state: { sessionId: string; streamWs: WebSocket | null }): Promise<WebSocket>
          }
          internals.relayUrl = url
          const streamWs = await internals.openStreamWs({ sessionId: 's1', streamWs: null })
          streamWs.close()
        },
      )
      expect(seen).toBe('Bearer tflw_pat_android')
    })
  })

  // #271 — 핸드셰이크 견고성 (IOSAgent.test.ts와 짝)
  describe('handshake robustness (#271)', () => {
    // listening 이후 포트를 읽어 느린 러너의 null address()를 피한다 (CodeRabbit #272 ③)
    async function withServer(
      onConnection: (sock: WebSocket) => void,
      run: (url: string) => Promise<void>,
    ): Promise<void> {
      const wss = new WebSocketServer({ port: 0 })
      await new Promise<void>((r) => wss.once('listening', r))
      const wssPort = (wss.address() as { port: number }).port
      wss.on('connection', (sock) => onConnection(sock as unknown as WebSocket))
      try {
        await run(`ws://127.0.0.1:${wssPort}`)
      } finally {
        await new Promise<void>((r) => wss.close(() => r()))
      }
    }

    it('등록 전 1008 close → code/reason을 담아 reject한다 (무한 대기 없음)', async () => {
      await withServer(
        (sock) => sock.close(1008, 'Unauthorized: agents need a PAT'),
        async (url) => {
          const agent = new AndroidAgent({}, mockAdb())
          await expect(agent.connect(url)).rejects.toThrow(/code=1008.*Unauthorized: agents need a PAT/)
        },
      )
    })

    it('agent:registered 응답이 없으면 handshakeTimeoutMs 후 reject한다', async () => {
      await withServer(
        () => { /* 업그레이드만 수락, 무응답 */ },
        async (url) => {
          const agent = new AndroidAgent({ handshakeTimeoutMs: 150 }, mockAdb())
          await expect(agent.connect(url)).rejects.toThrow(/timed out after 150ms/)
        },
      )
    })

    // CodeRabbit #272 ② — malformed 첫 프레임이 핸들러에서 throw되어 connect()가 행되지 않는다
    it('등록 전 malformed(비-JSON) 프레임 → 행 없이 reject한다', async () => {
      await withServer(
        (sock) => sock.on('message', () => sock.send('not-json{{{')),
        async (url) => {
          const agent = new AndroidAgent({ handshakeTimeoutMs: 1000 }, mockAdb())
          await expect(agent.connect(url)).rejects.toThrow(/malformed|handshake/i)
        },
      )
    })
  })
})
