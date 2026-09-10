import os from 'os'
import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import type {
  AndroidButton, BootAbandonReason, ClipboardErrorPayload, Device, DeviceAgent,
  NetworkControlCapability, NetworkStatePayload, UIElement,
} from '@tapflowio/agent-core'
import type {
  AgentControlOutbound, ClipboardReplyBody, OpenUrlReplyBody,
  AppInstallReplyBody, AppLaunchReplyBody, AppClearStateReplyBody,
} from '@tapflowio/protocol'
import { createLogger, PlatformError, ValidationError, bootAbandonMessage, BOOT_NO_SESSION_STATE } from '@tapflowio/agent-core'
import { outcomeMessage, wireReason, type InputOutcome } from './inputOutcome.js'
import {
  MAX_CLIPBOARD_BYTES, clipboardByteLength,
  CLIPBOARD_SENTINEL_PREFIX as SENTINEL_PREFIX, isClipboardSentinel as isSentinel,
  CLIPBOARD_COPY_DEADLINE_MS, CLIPBOARD_WRITE_DEADLINE_MS, CLIPBOARD_RESTORE_DEADLINE_MS, CLIPBOARD_POLL_MS,
  createKeyedSerialQueue,
  type AgentCapability,
} from '@tapflowio/agent-core'
import {
  createResourceSampler,
  registerStreamWs,
  disableNagle,
  createKeyframeAwareSender,
  pickMaxSize,
  createRateLimitedDropWarn,
  createThroughputSampler,
  createSleepBlocker,
  type SleepBlocker,
  getMachineId,
  isLocalhostWss,
  DEFAULT_BACKPRESSURE_BYTES,
  writeEnvelopeHeader,
  rewriteLowLatencySpsInFrame,
  CODEC_H264,
  CODEC_AUDIO,
  sendAudioYieldingToVideo,
} from '@tapflowio/agent-core/utils'
import { execFileSync } from 'child_process'
import { AdbWrapper } from './AdbWrapper.js'
import { EmulatorLauncher, findEmulatorPid, probeEmulator, stopEmulatorProcess } from './EmulatorLauncher.js'
import { ensureHelperApp, launchMuteOnlyTap, isAudioSupported } from '@tapflowio/audiotap-helper'
import { AndroidTouchHelper } from './AndroidTouchHelper.js'
import { parseUiAutomatorDump } from './uiTree.js'
import { ScrcpySession } from './scrcpy/ScrcpySession.js'
import type { ScrcpyFrame } from './scrcpy/ScrcpyVideo.js'
import { EmulatorGrpcClient, type AudioStream } from './emulator/EmulatorGrpcClient.js'
import { discoverGrpcPort, isTcpPortFree } from './emulator/discovery.js'
import { EmulatorVideo } from './emulator/EmulatorVideo.js'

const logger = createLogger('android-agent')

// Typed so a typo cannot ship silently — the viewer gates the whole clipboard bridge on this, and
// since #447 the Full reset toggle too. `full-reset` is honoured in `handleDeviceBoot`, which stops
// an already-running emulator and relaunches it with `-wipe-data`.
// `network-control` claims what the other two claim: this agent has the code. Whether airplane mode
// actually works on a given image is per device, and `network:state.available` carries that — the
// split the protocol documents. Added last, after the handler and the boot-time reset, because the
// string on its own is what puts a control on screen.
const AGENT_CAPABILITIES: AgentCapability[] = ['clipboard', 'full-reset', 'network-control']

// Parse H.264 SPS NAL unit to extract frame dimensions.
// scrcpy sends a new SPS (inside an IDR keyframe) whenever the capture size changes —
// e.g. portrait→landscape for landscape-aware apps. This lets the agent track the
// actual video dimensions and keep ScrcpyControl.screenSize in sync without guessing.
export function parseSpsFromNal(nal: Buffer): { width: number; height: number } | null {
  // Locate NAL header byte after Annex B start code
  let offset = 0
  if (nal.length >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) offset = 4
  else if (nal.length >= 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1) offset = 3
  else return null
  if (offset >= nal.length || (nal[offset]! & 0x1f) !== 7) return null  // not SPS

  // Collect RBSP bytes (remove emulation-prevention 0x03 bytes)
  const bytes: number[] = []
  for (let i = offset + 1; i < nal.length; i++) {
    const b = nal[i]!
    const len = bytes.length
    if (len >= 2 && b === 3 && bytes[len - 1] === 0 && bytes[len - 2] === 0) continue
    bytes.push(b)
  }

  let bit = 0
  const readU = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) {
      if ((bit >> 3) >= bytes.length) throw new Error('truncated')
      v = (v << 1) | ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1)
      bit++
    }
    return v
  }
  const readUE = (): number => {
    let lz = 0
    while (readU(1) === 0) { if (++lz > 31) throw new Error('overflow') }
    return lz === 0 ? 0 : (1 << lz) - 1 + readU(lz)
  }
  const readSE = (): number => { const v = readUE(); return v % 2 === 0 ? -(v >> 1) : (v + 1) >> 1 }

  try {
    const profile = readU(8)
    readU(8); readU(8)           // constraint_flags, level_idc
    readUE()                     // seq_parameter_set_id

    let subWC = 2, subHC = 2    // 4:2:0 defaults
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const cfmt = readUE()
      subWC = cfmt === 0 ? 1 : cfmt === 2 ? 2 : cfmt === 3 ? 1 : 2
      subHC = cfmt === 0 ? 1 : cfmt === 1 ? 2 : 1
      if (cfmt === 3) readU(1)   // separate_colour_plane_flag
      readUE(); readUE()         // bit_depth_luma/chroma_minus8
      readU(1)                   // qpprime_y_zero_transform_bypass_flag
      if (readU(1)) return null  // seq_scaling_matrix_present_flag — skip
    }

    readUE()                     // log2_max_frame_num_minus4
    const pocType = readUE()
    if (pocType === 0) readUE()
    else if (pocType === 1) {
      readU(1); readSE(); readSE()
      const n = readUE(); for (let i = 0; i < n; i++) readSE()
    }
    readUE(); readU(1)           // max_num_ref_frames, gaps_in_frame_num_value_allowed_flag
    const codedW = (readUE() + 1) * 16
    const mapH = readUE()
    const frameMbsOnly = readU(1)
    const codedH = (mapH + 1) * 16 * (frameMbsOnly ? 1 : 2)
    if (!frameMbsOnly) readU(1) // mb_adaptive_frame_field_flag
    readU(1)                    // direct_8x8_inference_flag
    let w = codedW, h = codedH
    if (readU(1)) {             // frame_cropping_flag
      const cl = readUE(), cr = readUE(), ct = readUE(), cb = readUE()
      w = codedW - (cl + cr) * subWC
      h = codedH - (ct + cb) * subHC * (frameMbsOnly ? 1 : 2)
    }
    return { width: w, height: h }
  } catch { return null }
}

const ANDROID_BUTTONS: AndroidButton[] = [
  { name: 'home',        accessibilityTitle: 'Home',        keyCode: 3 },
  { name: 'back',        accessibilityTitle: 'Back',        keyCode: 4 },
  { name: 'recent_apps', accessibilityTitle: 'Recent Apps', keyCode: 187 },
  { name: 'volume_up',   accessibilityTitle: 'Volume Up',   keyCode: 24 },
  { name: 'volume_down', accessibilityTitle: 'Volume Down', keyCode: 25 },
  { name: 'power',       accessibilityTitle: 'Power',       keyCode: 26 },
]

interface DeviceState {
  sessionId: string
  /** Why each abandoned boot was abandoned, keyed by **the seq it lost**. A single slot would tell the
   *  wrong story the moment two boots overlap: boot A, boot B, then a shutdown leaves one slot saying
   *  `shut-down`, which is what B lost to — A lost to B.
   *
   *  **Written only while a boot is running to read it**, which is what keeps it from growing. Every
   *  lifecycle event retires a seq, but the usual one retires a boot that has already answered — an entry
   *  nothing would ever read or delete, one per boot and one per shutdown, for as long as the agent stays
   *  connected. `bootsInFlight` is that guard, and each boot clears its own key on the way out. */
  bootAbandon: Map<number, BootAbandonReason>
  /** Seqs held by a `handleDeviceBoot` that has not returned yet. */
  bootsInFlight: Set<number>
  deviceId: string
  touchHelper: AndroidTouchHelper | null
  // Device-booted flag for truthful input acks — set on device:ready, cleared on shutdown; false after a reconnect until the ack path re-verifies once via adb.
  booted: boolean
  /** The last airplane-mode value actually read off this device, and **only** the fallback for a read
   *  that fails — never the answer. `readNetworkState` still asks the device every time, because a
   *  remembered value cannot see one changed outside tapflow.
   *
   *  It exists because `NetworkNotSteerable.offline` is declared "still the device's real state", and
   *  the re-join report (#614) is the first producer with nothing to pass: the boot path hands over
   *  what it just read and `network:set` hands over what it measured, but a viewer coming back has no
   *  such moment behind it.
   *
   *  **`undefined` until something is observed, rather than `false`.** The two are not the same claim:
   *  `false` says "on the network" and the absent value says "not known", and a boolean spells the
   *  second as the first. Reachable — a boot whose own read failed writes nothing here, and a tester
   *  who then flips airplane mode in the emulator's own UI leaves a device that is offline, unreadable
   *  and never observed. Answering `offline: false` for it is the one direction that hides the
   *  problem this feature exists to show, so `reportNetworkState` stays silent there instead. */
  lastNetworkOffline?: boolean
  streamWs: WebSocket | null
  scrcpySession: ScrcpySession | null
  emulatorVideo: EmulatorVideo | null
  emulatorAudio: AudioStream | null   // gRPC audio stream (on by default; null when TAPFLOW_AUDIO=off)
  audioMuteQemuPid: number | null     // qemu pid silenced by the macOS mute-only tap (#341); null if not muting
  grpcPort: number | null             // gRPC port this device's emulator was launched with; null if we didn't launch it
  grpcClient: EmulatorGrpcClient | null
  cornerRadius: number   // baked rounded-corner radius as a fraction of width (0 = square)
  secureContext: boolean // viewer context → downscale tier (native / 1280 / 1000)
  external: boolean
  displayWidth: number
  displayHeight: number
  videoWidth: number   // actual scrcpy video frame dimensions — used for touch coordinates
  videoHeight: number
  landscape: boolean   // rotation intent toggle — only to request device rotation on input:rotate
  lastTouchPx: { x: number; y: number }
  bootSeq: number
  restarting: boolean
}

// Low-latency pointer injection, satisfied structurally by both ScrcpyControl (scrcpy backend)
// and EmulatorGrpcClient (gRPC backend) — identical method shapes, so the input handlers stay
// backend-agnostic. Methods may be sync (scrcpy) or async (gRPC); callers fire-and-forget.
interface PointerControl {
  /** Whether a write now reaches the device. Each backend answers from what it actually has — a
   *  socket's local writability for scrcpy, a closed flag for gRPC — because the two have nothing
   *  in common: `socket.write()` never throws, and a gRPC call rejects. See the implementations. */
  isReady(): boolean
  touchDown(pointerId: number, x: number, y: number): void | Promise<void>
  touchMove(pointerId: number, x: number, y: number): void | Promise<void>
  touchUp(pointerId: number, x?: number, y?: number): void | Promise<void>
  pinchStart(x1: number, y1: number, x2: number, y2: number): void | Promise<void>
  pinchMove(x1: number, y1: number, x2: number, y2: number): void | Promise<void>
  pinchEnd(): void | Promise<void>
}

// Video backend per device: emulators (serial `emulator-*`) default to the gRPC host-encode path
// (bypasses the guest SW H.264 encoder); real devices use scrcpy (their SoC has a HW encoder).
// `TAPFLOW_ANDROID_BACKEND=scrcpy|grpc` overrides either way.
export function pickAndroidBackend(serial: string, env: NodeJS.ProcessEnv = process.env): 'grpc' | 'scrcpy' {
  if (env.TAPFLOW_ANDROID_BACKEND === 'scrcpy') return 'scrcpy'
  if (env.TAPFLOW_ANDROID_BACKEND === 'grpc') return 'grpc'
  return serial.startsWith('emulator-') ? 'grpc' : 'scrcpy'
}

export interface AndroidAgentOptions {
  fps?: number
  /** AVD name or emulator serial to expose. Omit to expose all detected devices. */
  deviceFilter?: string
  reconnectDelays?: number[]
  /** Injectable for tests; defaults to a real macOS power assertion (no-op under vitest). */
  sleepBlocker?: SleepBlocker
  /** Credential for remote relays — sent as `Authorization: Bearer` on every relay WS (#271). */
  token?: string
  /** Handshake(연결~agent:registered) 타임아웃 ms. 기본 10초, 테스트용 주입 가능. */
  handshakeTimeoutMs?: number
}

// Everything inside the per-device clipboard section must be bounded, or one stuck call wedges
// every later copy/paste on that device. gRPC carries its own deadline; adb does not (and a
// blanket AdbRunner timeout would break legitimately slow calls like app install), so bound it
// here. The child process may outlive this — the point is to release the queue.
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    // The adb child is not killed — `input keyevent` is idempotent for our purposes and killing
    // it mid-write could leave the guest in a worse state. What matters is releasing the section
    // so one stuck call cannot wedge every later clipboard op on this device.
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError(`${what} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
const ADB_KEYEVENT_TIMEOUT_MS = 5_000

// `implements NetworkControlCapability` as well as `DeviceAgent`, and the clause is the whole
// point: without it the two methods are just methods, and a change to the interface reaches this
// class through nothing at all. `AgentRegistry.test.ts` once declared `implements DeviceAgent`
// while missing two members — the clause only works when something checks it, and here that is the
// compiler.
export class AndroidAgent implements DeviceAgent, NetworkControlCapability {
  private readonly adb: AdbWrapper
  private readonly launcher: EmulatorLauncher
  private ws: WebSocket | null = null

  /** Send on the control socket, if there is one. The `?.` is the point: 66 call sites relied on a send
   *  being a no-op between reconnects, and this preserves that exactly.
   *
   *  Typed with `AgentControlOutbound`, which is why this exists — an agent's literal used to reach `ws.send`
   *  with nothing checking it, and #489/#490 are what that cost. *
 *  **The guard is not defensive tidying.** `ws.send` on anything other than OPEN takes the `sendAfterClose`
 *  path, which adds the payload to a buffer nobody will flush and neither throws nor emits — so a reply
 *  sent to a closing socket is indistinguishable from a delivered one at the call site. `reportResources`
 *  has always checked; this did not, and the boot answers this file now owes a caller are exactly the
 *  messages whose purpose is to end someone's wait.
 *
 *  The body is held character for character by `scripts/__tests__/agentSendTyped.test.mjs`, so the comment
 *  lives out here: that check strips comments and matches the body exactly, having watched three earlier
 *  drafts get bypassed by a renamed socket. */
  private sendMsg(msg: AgentControlOutbound): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  /** Send on a socket the caller has already established. Takes the socket **as an argument** rather than
   *  reading `this.ws`, and that is deliberate: the call sites that use it sit behind an entry guard
   *  (`if (!this.ws) return`), and today deleting one of those guards is a compile error. Reading
   *  `this.ws` here — or asserting it with `!` — would make the guard optional to the compiler and turn
   *  its removal into a runtime `TypeError` instead. It also serves the `agent:register` send, which runs
   *  inside `onopen` on a local socket. */
  private sendOn(ws: WebSocket, msg: AgentControlOutbound): void {
    ws.send(JSON.stringify(msg))
  }
  private deviceStates = new Map<string, DeviceState>()
  // Holds a macOS power assertion while connected so the host doesn't idle-throttle the
  // emulator (its software H.264 encoder starves badly when the Mac idles). No-op off macOS.
  private readonly sleepBlocker: SleepBlocker
  private relayUrl: string | null = null
  private resourcesTimer: ReturnType<typeof setInterval> | null = null
  private readonly resources = createResourceSampler()
  private _stopping = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _reconnectAttempt = 0

  private readonly deviceFilter?: string
  private readonly reconnectDelays: number[]
  private readonly token?: string
  private readonly handshakeTimeoutMs: number

  constructor(options: AndroidAgentOptions = {}, adb?: AdbWrapper) {
    this.adb = adb ?? new AdbWrapper()
    this.launcher = new EmulatorLauncher()
    this.deviceFilter = options.deviceFilter
    this.token = options.token
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
    this.reconnectDelays = options.reconnectDelays ?? [1000, 2000, 4000, 8000, 16000, 30000]
    // No-op under vitest so the suite never spawns real `caffeinate` processes.
    this.sleepBlocker = options.sleepBlocker ?? (process.env.VITEST ? { acquire() {}, release() {} } : createSleepBlocker())
  }

  /**
   * **The one entry point that still takes the first registered session, and that is a decision.**
   *
   * Every other session-less member goes through `soleLiveOrNone` and refuses when the choice is
   * ambiguous (#617). This one does not, for the reason #617 gives itself: reading and writing are
   * not the same risk. The worst case here is answering about the wrong device; there it is taking
   * someone else's device off the network while they are using it.
   *
   * It also answers *before* any device is chosen — it is what an agent reports about itself — so a
   * refusal would turn "which session am I on" into an error on a healthy multi-device Mac.
   * `IOSAgent.sessionId` is identical, deliberately.
   */
  get sessionId(): string | null {
    const first = this.deviceStates.values().next().value
    return first?.sessionId ?? null
  }

  async connect(relayUrl: string): Promise<void> {
    this._stopping = false
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this.relayUrl = relayUrl
    const allDevices = await this.adb.listDevices()
    const devices = this.deviceFilter
      ? allDevices.filter((d) => d.name === this.deviceFilter || d.id === this.deviceFilter)
      : allDevices

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl, this.wsClientOptions())
      let registered = false

      // 등록 응답이 영영 오지 않는 행 방지 — 시간 내 미등록이면 끊고 reject (#271)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new PlatformError(`relay handshake timed out after ${this.handshakeTimeoutMs}ms (${relayUrl})`))
      }, this.handshakeTimeoutMs)

      ws.once('open', () => {
        disableNagle(ws)
        this.sendOn(ws, {
          type: 'agent:register',
          platform: 'android',
          // Lets a viewer tell a clipboard-capable agent from one that predates the
          // feature, instead of inferring it from silence. See agent-core AgentCapability.
          capabilities: AGENT_CAPABILITIES,
          agentId: getMachineId(),
          agentName: os.hostname(),
          devices: devices.map((d) => ({
            id: d.id,
            name: d.name,
            platform: d.platform,
            status: d.status,
            osVersion: d.osVersion,
          })),
        })
      })

      ws.once('message', (data) => {
        let msg: { type?: string; registeredSessions?: unknown }
        try {
          msg = JSON.parse(data.toString())
        } catch {
          // malformed 첫 프레임이 핸들러 밖으로 throw되면 connect()가 reject 없이 행된다 (#272)
          clearTimeout(timer)
          ws.terminate()
          reject(new PlatformError('relay sent a malformed handshake response'))
          return
        }
        if (msg.type === 'agent:registered') {
          registered = true
          clearTimeout(timer)
          this.ws = ws
          this.sleepBlocker.acquire() // idempotent across reconnects
          this.initDeviceStates(
            msg.registeredSessions as Array<{ deviceId: string; sessionId: string }>,
          )
          ws.on('message', (d) => {
            try {
              const m = JSON.parse(d.toString()) as { type?: unknown; sessionId?: unknown }
              // Every type `handleRelayMessage` dispatches is session-scoped, and the relay resolves the
              // session before forwarding — so a message without one did not come from that path. Rejecting
              // it here is what lets the dispatcher declare `sessionId: string` instead of threading an
              // optional through 30 sends and asserting it with `!` at each one.
              if (typeof m.type !== 'string' || typeof m.sessionId !== 'string') return
              this.handleRelayMessage(m as { type: string; sessionId: string; requestId?: string; payload?: unknown })
            } catch { /* ignore malformed */ }
          })
          this.reportResources()
          this.resourcesTimer = setInterval(() => this.reportResources(), 5000)
          ws.on('close', () => this._scheduleReconnect())
          resolve()
        } else {
          clearTimeout(timer)
          ws.close()
          reject(new PlatformError(`Unexpected message during handshake: ${msg.type}`))
        }
      })

      // 등록 전의 정상 close(예: 릴레이의 1008 인증 거절)는 'error' 없이 도착한다.
      // 사유를 살려 reject해야 무한 대기(스피너 행)가 아니라 진단 가능한 실패가 된다 (#271).
      ws.once('close', (code, reason) => {
        if (registered) return
        clearTimeout(timer)
        const reasonText = reason.toString()
        reject(new PlatformError(
          `relay closed the connection during handshake (code=${code}${reasonText ? `: ${reasonText}` : ''})`,
        ))
      })

      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer)
        ws.terminate()
        reject(new PlatformError(`relay rejected the WebSocket upgrade (HTTP ${res.statusCode})`))
      })

      ws.once('error', (e) => { clearTimeout(timer); reject(e) })
    })
  }

  private initDeviceStates(
    registeredSessions: Array<{ deviceId: string; sessionId: string }>,
  ): void {
    registeredSessions.forEach(({ deviceId, sessionId }) => {
      this.deviceStates.set(sessionId, {
        sessionId,
        deviceId,
        touchHelper: null,
        booted: false,
        streamWs: null,
        scrcpySession: null,
        emulatorVideo: null,
        emulatorAudio: null,
        audioMuteQemuPid: null,
        grpcPort: null,
        grpcClient: null,
        cornerRadius: 0,
        secureContext: false,
        external: false,
        displayWidth: 0,
        displayHeight: 0,
        videoWidth: 0,
        videoHeight: 0,
        landscape: false,
        lastTouchPx: { x: 0, y: 0 },
        bootSeq: 0,
        bootAbandon: new Map(),
        bootsInFlight: new Set(),
        restarting: false,
      })
    })
  }

  disconnect(): void {
    this._stopping = true
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    if (this.resourcesTimer) { clearInterval(this.resourcesTimer); this.resourcesTimer = null }
    for (const state of this.deviceStates.values()) {
      this.bumpBootSeq(state, 'relay-lost')
      this.cleanupDeviceState(state)
    }
    this.deviceStates.clear()
    this.sleepBlocker.release()
    this.ws?.close()
    this.ws = null
    this.relayUrl = null
  }

  private _scheduleReconnect(): void {
    if (this._stopping) return
    if (this.resourcesTimer) { clearInterval(this.resourcesTimer); this.resourcesTimer = null }
    for (const state of this.deviceStates.values()) {
      // **Invalidate any boot still in flight, which this agent did not do until now.** The map is dropped
      // just below, but a `handleDeviceBoot` awaiting the emulator holds its own reference and its seq
      // would still match — so it ran to completion against a state nobody owns, standing up a video
      // stream and sending `device:ready` for a session that no longer exists. iOS has invalidated here
      // since its helper-leak fix; the two agents disagreed about the same user action (losing the relay
      // mid-boot), which is the asymmetry the invariant table for #526 was written to surface.
      this.bumpBootSeq(state, 'relay-lost')
      this.cleanupDeviceState(state)
    }
    this.deviceStates.clear()
    this.ws = null

    const delays = this.reconnectDelays
    const delay = delays[Math.min(this._reconnectAttempt, delays.length - 1)]
    this._reconnectAttempt++
    logger.warn(`relay disconnected — reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`)

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (this._stopping || !this.relayUrl) return
      this.connect(this.relayUrl).then(() => {
        this._reconnectAttempt = 0
        logger.info('reconnected to relay')
      }).catch((e) => {
        // 실패 원인을 남겨야 인증 거절(1008)과 네트워크 장애를 구분할 수 있다 (#271)
        logger.warn(`reconnect failed: ${e instanceof Error ? e.message : String(e)}`)
        this._scheduleReconnect()
      })
    }, delay)
  }

  private reportResources(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const bootedCount = Array.from(this.deviceStates.values()).filter((s) => s.scrcpySession !== null || s.emulatorVideo !== null).length
    const slotsTotal = this.deviceStates.size
    const { memUsedMB, memTotalMB } = this.resources.getMemoryUsage()
    this.sendOn(this.ws, {
      type: 'agent:resources',
      resources: {
        cpuPercent: this.resources.getCpuPercent(),
        memUsedMB,
        memTotalMB,
        slotsAvailable: Math.max(0, slotsTotal - bootedCount),
        slotsTotal,
        reportedAt: Date.now(),
      },
    })
  }

  private cleanupDeviceState(state: DeviceState): void {
    const serial = this.adb.getSerial(state.deviceId)
    if (serial && state.scrcpySession) state.scrcpySession.stop(serial)
    state.scrcpySession = null
    state.emulatorVideo?.stop()
    state.emulatorVideo = null
    state.emulatorAudio?.cancel()
    state.emulatorAudio = null
    this.stopHostMute(state)
    state.grpcClient?.close()
    state.grpcClient = null
    state.cornerRadius = 0
    state.touchHelper?.stop()
    state.touchHelper = null
    state.booted = false
    state.streamWs?.close()
    state.streamWs = null
  }

  private sendDeviceInfo(state: DeviceState, device: Device): void {
    // `readyState`, not presence: this runs mid-boot, and a socket that closed since the entry guard
    // takes the payload into a buffer nobody flushes while `device:ready` is dropped by `sendMsg`'s own
    // check — leaving the caller with neither the data nor an answer.
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.sendOn(this.ws, {
      type: 'session:deviceInfo',
      sessionId: state.sessionId,
      payload: {
        deviceName: device.name,
        osVersion: device.osVersion ?? '',
      },
    })
  }

  private forceScrcpy(): boolean {
    return process.env.TAPFLOW_ANDROID_BACKEND === 'scrcpy'
  }

  private useGrpc(serial: string): boolean {
    return pickAndroidBackend(serial) === 'grpc'
  }

  // The active low-latency pointer backend (gRPC preferred), or null when only the ADB fallback
  // (AndroidTouchHelper) is available. Coordinates go in state.videoWidth/Height px.
  private pointerControl(state: DeviceState): PointerControl | null {
    if (state.grpcClient) return state.grpcClient
    if (state.scrcpySession) return state.scrcpySession.control
    return null
  }

  // Clipboard work parks a sentinel on the device while it waits, so two operations on the same
  // device must not interleave — each would read the other's marker instead of the real
  // clipboard. Keyed by device, not session: several sessions (and MCP) can address one device.
  private readonly clipboardQueue = createKeyedSerialQueue()
  // Device-scoped, not operation-scoped. Several sessions (and MCP) can address one emulator, so
  // an operation that fails before parking anything may still be answering while ANOTHER holds a
  // marker down. The viewer decides from this whether pressing the plain chord is safe, and that
  // chord travels as `input:key` — outside this queue — so the answer has to describe the device
  // rather than the caller. Mirrors the iOS agent.
  private readonly parkedSentinels = new Map<string, number>()

  private markSentinel(deviceId: string, delta: 1 | -1): void {
    const n = (this.parkedSentinels.get(deviceId) ?? 0) + delta
    if (n > 0) this.parkedSentinels.set(deviceId, n)
    else this.parkedSentinels.delete(deviceId)
  }

  private sentinelParked(deviceId: string): boolean {
    return (this.parkedSentinels.get(deviceId) ?? 0) > 0
  }

  // Fire-and-forget a pointer call: gRPC methods are async (swallow rejection), scrcpy sync (no-op).
  private fire(r: void | Promise<void>): void {
    if (r) r.catch(() => {})
  }

  // Port to launch the emulator with (`-grpc <port>`, unsecured localhost). A plain `-grpc` endpoint
  // is unsecured; without it the emulator opens its DEFAULT gRPC port with token auth, which our
  // unauthenticated client can't use. Launches are always AVDs (emulators), so default to gRPC
  // unless explicitly forced to scrcpy. undefined = don't open gRPC.
  // Ports reserved between pick() and the emulator actually binding them — avoids two concurrent
  // boots racing onto the same port before either emulator has claimed it.
  private pendingGrpcPorts = new Set<number>()

  // A FREE gRPC port for a new emulator. Each emulator must get its own port — a shared fixed 8554
  // makes a second emulator collide and every session ends up streaming the first emulator (#stream-bleed).
  private async pickFreeGrpcPort(): Promise<number> {
    const base = Number(process.env.TAPFLOW_ANDROID_GRPC_PORT) || 8554
    for (let p = base; p < base + 200; p += 2) { // emulators conventionally use even ports
      if (this.pendingGrpcPorts.has(p)) continue
      // Reserve before the async probe so two concurrent boots can't both claim the same port.
      this.pendingGrpcPorts.add(p)
      let free = false
      try {
        free = await isTcpPortFree(p)
        if (free) return p
      } finally {
        if (!free) this.pendingGrpcPorts.delete(p)
      }
    }
    throw new PlatformError('No free gRPC port available for the emulator')
  }

  // Audio output is ON by default; opt out with TAPFLOW_AUDIO=off. Gates both emulator launch
  // (`-no-audio` removal) and the gRPC streamAudio pump — both must read the same flag so the audio
  // backend matches the stream. Unlike iOS, the emulator also plays to the host (agent Mac) — it has
  // no host-output-only mute, so use the Mac's own volume; see contributing/simulator-audio.md (#341).
  private audioEnabled(): boolean {
    return process.env.TAPFLOW_AUDIO !== 'off'
  }

  private async startVideoStream(state: DeviceState, streamWs: WebSocket): Promise<void> {
    const serial = this.adb.getSerial(state.deviceId)
    if (!serial) return

    // Emulator: capture via gRPC streamScreenshot + Mac VideoToolbox (bypasses the guest SW H.264
    // encoder). On any failure (e.g. an externally-booted emulator without `-grpc`), fall back to
    // scrcpy so streaming still works.
    if (this.useGrpc(serial)) {
      try {
        await this.startGrpcVideoStream(state, streamWs, serial)
        return
      } catch (e) {
        logger.warn(`gRPC backend failed (${(e as Error).message}) — falling back to scrcpy`)
        state.emulatorVideo?.stop(); state.emulatorVideo = null
        state.grpcClient?.close(); state.grpcClient = null
        state.touchHelper?.stop(); state.touchHelper = null
      }
    }

    const touchHelper = new AndroidTouchHelper(this.adb, serial)
    touchHelper.start()
    state.touchHelper = touchHelper

    const session = new ScrcpySession()
    const info = await session.start(serial)
    state.scrcpySession = session
    state.landscape = false

    state.displayWidth = info.width
    state.displayHeight = info.height
    state.videoWidth = info.width
    state.videoHeight = info.height

    const reader = session.video.start().getReader()

    // Detect video size changes via H.264 SPS so ScrcpyControl.screenSize always matches what
    // scrcpy is encoding (landscape-aware vs portrait-locked). The SPS leads the keyframe AU.
    const onFrame = (value: ScrcpyFrame) => {
      const parsed = parseSpsFromNal(value.payload)
      if (parsed && (parsed.width !== state.videoWidth || parsed.height !== state.videoHeight)) {
        state.videoWidth = parsed.width
        state.videoHeight = parsed.height
        state.scrcpySession?.control.updateScreenSize(parsed.width, parsed.height)
        logger.info(`video size → ${parsed.width}×${parsed.height}`)
      }
    }

    void this.pumpVideo(state, streamWs, reader, onFrame, () => session.control.resetVideo()).then(() => {
      if (state.scrcpySession === session && !state.restarting) {
        state.restarting = true
        void this.restartVideoStream(state)
      }
    })
  }

  // Shared frame pump for both video backends: reads H.264 access units, wraps each in the TFFE
  // envelope (codec + per-AU keyframe flag, so the relay's keyframe-aware backpressure preserves the
  // reference chain), and sends with backpressure + optional throughput metrics. `onFrame` lets a
  // backend inspect each frame (scrcpy parses SPS for size). Resolves when the source stream ends.
  private async pumpVideo(
    state: DeviceState,
    streamWs: WebSocket,
    reader: ReadableStreamDefaultReader<ScrcpyFrame>,
    onFrame?: (frame: ScrcpyFrame) => void,
    requestIdr?: () => void,
  ): Promise<void> {
    const threshold = Number(process.env.TAPFLOW_WS_BACKPRESSURE_BYTES) || DEFAULT_BACKPRESSURE_BYTES
    const warnDrop = createRateLimitedDropWarn(logger, state.deviceId)
    // Keyframe-aware backpressure: when the agent→relay socket fills, drop whole GOPs to the next
    // keyframe (never forward an orphan P-frame whose reference was dropped — that decodes to a
    // sheared/ghosted frame until the next IDR). On a drop with no keyframe, ask the encoder for an
    // IDR (throttled) so the stream resyncs fast instead of waiting for the periodic one.
    const dropper = createKeyframeAwareSender()
    let lastIdrReq = 0
    const onWantKeyframe = requestIdr
      ? () => { const now = Date.now(); if (now - lastIdrReq >= 500) { lastIdrReq = now; requestIdr() } }
      : undefined
    // Opt-in throughput baseline (TAPFLOW_STREAM_METRICS=1): logs fps/KB·s/drop every 5s, so the
    // Android source rate can be compared against the relay→browser drop logs and the iOS agent.
    const metrics = process.env.TAPFLOW_STREAM_METRICS === '1' ? createThroughputSampler() : null
    const metricsTimer = metrics
      ? setInterval(() => {
          const s = metrics.sample()
          logger.info(
            `stream metrics [${state.deviceId}] ${s.fpsSent}fps ${s.kbPerSec}KB/s avg=${s.avgFrameKB}KB drop=${(s.dropRate * 100).toFixed(1)}% (${s.droppedFrames}/${s.producedFrames})`,
          )
        }, 5000)
      : undefined
    metricsTimer?.unref()
    const onDrop = metrics ? () => { metrics.recordDropped(); warnDrop() } : warnDrop

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        onFrame?.(value)
        // Declare reorder=0 on the keyframe SPS so the decoder (WASM/WebCodecs) emits frames
        // immediately instead of buffering the level's max DPB (~hundreds of ms of latency on every
        // frame). The gRPC/VideoToolbox SPS omits bitstream_restriction; scrcpy's is a no-op.
        const payload = value.keyframe ? (rewriteLowLatencySpsInFrame(value.payload) as Buffer) : value.payload
        const frame = writeEnvelopeHeader(payload, Date.now(), { codec: CODEC_H264, keyframe: value.keyframe })
        const sent = dropper.send(streamWs, frame, threshold, value.keyframe, onDrop, onWantKeyframe)
        if (sent) metrics?.recordSent(value.payload.length)
      }
    } catch {
      // stream cancelled or ws closed — expected on disconnect
    }
    if (metricsTimer) clearInterval(metricsTimer)
  }

  // gRPC emulator backend: capture via EmulatorVideo (gRPC streamScreenshot + Mac VT encode) through
  // the shared pump. Input is routed to the gRPC client in handleRelayMessage. No auto-restart —
  // the backend is torn down with the device state.
  private async startGrpcVideoStream(state: DeviceState, streamWs: WebSocket, serial: string): Promise<void> {
    // Connect to THIS emulator's port: the one we launched it with, else the port it advertises in
    // its discovery .ini (covers externally-booted emulators), else the legacy default.
    const port = state.grpcPort ?? discoverGrpcPort(serial) ?? 8554
    // Downscale box (longest side), server-side resize. Per-session tier from the viewer context
    // (secure→native / LAN-HTTP→1280 / external→1000); TAPFLOW_ANDROID_MAX_SIZE | TAPFLOW_MAX_SIZE
    // is a hard override.
    const maxSize = pickMaxSize({
      secureContext: state.secureContext,
      external: state.external,
      override: process.env.TAPFLOW_ANDROID_MAX_SIZE ?? process.env.TAPFLOW_MAX_SIZE,
    })
    // Default 30fps (iOS parity) — caps source 60fps to halve decode/transport for LAN-HTTP.
    const fps = Number(process.env.TAPFLOW_ANDROID_FPS) || 30

    const touchHelper = new AndroidTouchHelper(this.adb, serial)
    touchHelper.start()
    state.touchHelper = touchHelper

    const client = new EmulatorGrpcClient(`127.0.0.1:${port}`)
    const video = new EmulatorVideo(client, { fps, ...(maxSize ? { maxWidth: maxSize, maxHeight: maxSize } : {}) })
    // Assign before start() so the caller's fallback cleanup can tear these down on failure.
    state.grpcClient = client
    state.emulatorVideo = video
    const info = await video.start()
    // gRPC sendTouch coordinates are in the device's native display resolution — not the (possibly
    // downscaled) video size — so query it for correct normalized→px touch mapping. The aspect
    // ratio matches the downscaled video, so native dims also drive the dashboard chrome.
    const native = await this.adb.getScreenSize(serial).catch(() => ({ width: info.width, height: info.height }))
    state.landscape = false
    state.displayWidth = native.width
    state.displayHeight = native.height
    state.videoWidth = native.width
    state.videoHeight = native.height
    state.cornerRadius = info.cornerRadius

    const reader = video.frames().getReader()
    // If the gRPC video ends unexpectedly (emulator crash / disconnect), restart the stream so the
    // session recovers instead of going dead — mirrors the scrcpy pump's auto-restart.
    void this.pumpVideo(state, streamWs, reader, undefined, () => video.requestIdr()).then(() => {
      if (state.emulatorVideo === video && !state.restarting) {
        state.restarting = true
        void this.restartVideoStream(state)
      }
    })

    // Opt-in audio output, on the SAME gRPC client + stream socket as video. Best-effort: if it
    // ends or errors it does NOT trigger a video restart — video owns the session lifecycle.
    if (this.audioEnabled()) {
      const audio = client.streamAudio()
      state.emulatorAudio = audio
      void this.pumpAudio(state, streamWs, audio)
      this.startHostMute(state) // #341: silence the emulator's host (agent Mac) output — iOS parity
    }
  }

  // #341: the emulator also plays to the agent Mac's speakers (its `-audio` backend has no
  // host-output-only mute). On macOS 14.2+ we hold a mute-only Core Audio process tap on the
  // emulator's qemu pid so its host output is silenced while gRPC keeps capturing for the browser —
  // matching iOS's muteBehavior=.muted. Below 14.2 / non-macOS: no-op (fall back to the Mac's volume).
  private startHostMute(state: DeviceState): void {
    if (!isAudioSupported()) return
    if (state.audioMuteQemuPid != null) return // already muting this session (e.g. a stream restart)
    const avdName = state.deviceId.replace(/^avd:/, '')
    const qemuPid = findEmulatorPid(avdName)
    if (!qemuPid) { logger.debug(`host-mute: no qemu pid for ${avdName}`); return }
    try {
      launchMuteOnlyTap(ensureHelperApp(), [qemuPid])
      state.audioMuteQemuPid = qemuPid
      logger.info(`host-mute: silencing emulator host output on the agent Mac (qemu ${qemuPid})`)
    } catch (e) {
      logger.warn(`host-mute: failed to launch mute tap: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Stop muting on teardown so the emulator is audible again if the operator uses it directly. The
  // mute helper also self-exits when qemu dies, so this only matters when the emulator outlives us.
  private stopHostMute(state: DeviceState): void {
    if (state.audioMuteQemuPid == null) return
    try { execFileSync('pkill', ['-f', `audiotap-helper.*--mute-only ${state.audioMuteQemuPid}$`], { stdio: 'ignore' }) } catch { /* already gone */ }
    state.audioMuteQemuPid = null
  }

  // Forward raw-PCM audio frames to the relay on the shared stream socket. Uses the yielding sender,
  // never the keyframe-aware video sender: audio must never inflate the socket buffer enough to make
  // video's backpressure misfire. A dropped audio frame is a brief glitch; a stalled video isn't.
  private async pumpAudio(state: DeviceState, streamWs: WebSocket, audio: AudioStream): Promise<void> {
    const warnDrop = createRateLimitedDropWarn(logger, `${state.deviceId} audio`)
    try {
      for await (const f of audio.frames) {
        if (streamWs.readyState !== WebSocket.OPEN) break
        const frame = writeEnvelopeHeader(f.audio, Date.now(), { codec: CODEC_AUDIO })
        sendAudioYieldingToVideo(streamWs, frame, warnDrop)
      }
    } catch {
      // stream cancelled or ws closed — expected on teardown/restart
    }
  }

  private async restartVideoStream(state: DeviceState): Promise<void> {
    const serial = this.adb.getSerial(state.deviceId)
    if (!serial) { state.restarting = false; return }

    state.scrcpySession?.stop(serial)
    state.scrcpySession = null
    state.emulatorVideo?.stop()
    state.emulatorVideo = null
    state.emulatorAudio?.cancel()
    state.emulatorAudio = null
    state.grpcClient?.close()
    state.grpcClient = null
    state.touchHelper?.stop()
    state.touchHelper = null

    const { streamWs } = state
    if (!streamWs || streamWs.readyState !== WebSocket.OPEN) {
      state.restarting = false
      return
    }

    // kill any lingering scrcpy server process on the device before restarting
    await this.adb.pkill(serial, 'scrcpy-server').catch(() => {})
    await new Promise<void>((r) => setTimeout(r, 1500))

    if (!this.deviceStates.has(state.sessionId)) return

    try {
      await this.startVideoStream(state, streamWs)
    } catch (err) {
      logger.error(`scrcpy restart failed: ${err}`)
      // **No `requestId`, and that is the contract rather than an omission.** This is the unsolicited
      // producer of `device:boot-error`: a stream that died mid-session and failed to come back, with
      // no `device:boot` behind it. It is why the correlator on this message is optional, and why a
      // consumer that gates on the correlator drops the only report a dead stream gets.
      this.sendMsg({
        type: 'device:boot-error',
        sessionId: state.sessionId,
        message: 'scrcpy failed to restart',
      })
    } finally {
      state.restarting = false
    }
  }

  // 원격 릴레이는 PAT 인증을 요구한다 (#271) — control/stream WS 모두 같은 토큰을 쓴다.
  private wsClientOptions(): { headers?: Record<string, string>; rejectUnauthorized?: boolean } {
    const opts: { headers?: Record<string, string>; rejectUnauthorized?: boolean } = {}
    if (this.token) opts.headers = { authorization: `Bearer ${this.token}` }
    // All-in-one (tapflow start): the relay's domain cert won't match wss://localhost, but localhost
    // never leaves the machine so MITM is impossible — accept it. External relays keep verification.
    if (this.relayUrl && isLocalhostWss(this.relayUrl)) opts.rejectUnauthorized = false
    return opts
  }

  private async openStreamWs(state: DeviceState): Promise<WebSocket> {
    const streamWs = new WebSocket(this.relayUrl!, this.wsClientOptions())
    state.streamWs = streamWs
    await registerStreamWs(streamWs, state.sessionId)
    return streamWs
  }

  /** Retire the boot that holds the current seq, recording what retired it, and return the new seq.
   *
   *  **Three callers, and the third is why this is a method.** A new boot supersedes the one in flight, a
   *  shutdown abandons it, and losing the relay invalidates it — that last one lives in the reconnect path
   *  and is easy to miss when reading `handleDeviceBoot` alone. Spreading the reason across three
   *  `state.bootSeq++` lines makes forgetting one silent; here it is a parameter.
   *
   *  Deliberately **not** folded into `cleanupDeviceState` the way iOS's bump once was: this agent calls
   *  that cleanup from inside `handleDeviceBoot`, so a bump there would make every boot supersede itself. */
  private bumpBootSeq(state: DeviceState, reason: BootAbandonReason): number {
    if (state.bootsInFlight.has(state.bootSeq)) state.bootAbandon.set(state.bootSeq, reason)
    return ++state.bootSeq
  }

  /** Answer a boot this agent has stopped running. Called at every point that abandons one.
   *
   *  **Only when a correlator exists**, which is the same rule the input path settled on (#489): a reply
   *  nobody is waiting for is not an answer, and the dashboard reports every *uncorrelated*
   *  `device:boot-error` as a failure — deliberately, since this agent's own dead-stream report
   *  (`restartVideoStream`) has no id it could carry (#426). So sending one for a boot with no correlator
   *  would put an error toast on a tester's screen for a device that is booting normally. */
  private abandonBoot(state: DeviceState, seq: number, sessionId: string, requestId?: string): void {
    const reason = state.bootAbandon.get(seq) ?? 'superseded'
    state.bootAbandon.delete(seq)
    // **A state the agent has stopped holding cannot be answered, and trying is worse than silence.**
    // `relay-lost` retires a boot by dropping the whole map, so by the time the parked `await` resumes this
    // `state` is an object nobody is registered against — and whether the socket is back yet decides
    // between dropping the reply and sending it to a *new* relay naming a session id it has never heard
    // of. Neither is an answer, and which one happens is a race between a poll interval and a backoff.
    if (this.deviceStates.get(sessionId) !== state) {
      logger.warn(`boot for ${sessionId} abandoned (${reason}) after the session was dropped — nothing to answer`)
      return
    }
    if (!requestId) {
      logger.warn(`boot for ${sessionId} abandoned (${reason}) with no requestId — nothing to answer`)
      return
    }
    this.sendMsg({ type: 'device:boot-error', sessionId, requestId, message: bootAbandonMessage(reason) })
  }

  // `requestId` is a parameter, never a field on `state`: `bootSeq` exists because two boots overlap,
  // and a correlator hoisted onto shared state would answer the first request with the second's id.
  // Optional because the relay's idle timer boots nothing — but every *browser* boot carries one.
  private async handleDeviceBoot(sessionId: string, avdId: string, fullErase = false, tier?: { secureContext: boolean; external: boolean }, requestId?: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    // Split, because the two halves are not the same kind of nothing. No open control channel means the
    // answer itself has nowhere to go, so this is the one abandonment that stays silent — and the caller
    // learns from the relay instead, which declares the agent away and terminates the session. A missing
    // `state` is answerable and now answered (#489's reasoning, on the boot path).
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!state) {
      if (requestId) this.sendMsg({ type: 'device:boot-error', sessionId, requestId, message: BOOT_NO_SESSION_STATE })
      return
    }

    const seq = this.bumpBootSeq(state, 'superseded')
    state.bootsInFlight.add(seq)

    // **The teardown runs inside the try, and that is a fix rather than tidying.** It ran before it, and here it is the
    // heaviest thing in the handler — stopping a scrcpy session, closing a gRPC client, `pkill`ing the
    // host-mute tap. A throw there rejected this handler into the bare `.catch(logger.error)` at its dispatch site: no
    // `device:booting`, no ready, no error — and the seq was already bumped, so the boot this one
    // superseded was gone as well. The caller then waited out the very deadline this change exists to
    // end. `finally` is what stops `bootAbandon` outliving the boot that would have read it.
    try {
      this.cleanupDeviceState(state)
      if (tier) { state.secureContext = tier.secureContext; state.external = tier.external }
      this.sendOn(ws, { type: 'device:booting', sessionId })
      const avdName = avdId.replace(/^avd:/, '')
      const devices = await this.adb.listDevices()
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }

      const target = devices.find((d) => d.id === avdId)
      if (!target) throw new PlatformError(`Device not found: ${avdId}`)

      // `-wipe-data` is a **launch** argument, so an emulator that is already up cannot honour it
      // where it stands — the mirror of `simctl erase` refusing a booted device (#439). A device
      // survives agent restarts and sessions that ended without a clean shutdown, so "this
      // session's first boot, device already running" is reachable; iOS answers it by restarting
      // and so does this, or the toggle would refuse exactly the device a tester just armed it for.
      //
      // **Asked of the process, not of `target.status`.** That status is `Boolean(serial)` — it
      // says adb can *see* the emulator, which an emulator that is still coming up, or one whose
      // adb server restarted, is not. Skipping the stop there would put a second emulator on the
      // same AVD and race its lock file. iOS widened the same condition for the same reason and
      // says so at `IOSAgent.ts` (`!== 'shutdown'`, not `=== 'booted'`); this is that widening,
      // expressed against the only thing Android's two-valued status cannot tell us.
      // `probeEmulator`, not `findEmulatorPid`: the latter reports "could not look" as "not
      // running", and here that difference is a wiped device versus a lie about one. An
      // unconfirmable probe fails the boot before anything destructive happens.
      const emulator = fullErase ? probeEmulator(avdName) : { state: 'gone' as const }
      if (emulator.state === 'unknown') {
        throw new PlatformError(
          `Could not tell whether emulator "${avdName}" was already running (process lookup ` +
          'unavailable), so Full reset was not attempted.',
        )
      }
      if (emulator.state === 'running') {
        const serial = this.adb.getSerial(avdId)
        if (serial) {
          await this.adb.shutdown(serial).catch((e: unknown) => {
            // Best effort, as on the shutdown path: the emulator may already be going down. The
            // wait below is what decides whether we may launch, not this call's success.
            logger.warn('emu kill before wipe failed (already gone?):', (e as Error).message)
          })
          this.adb.clearSerial(avdId)
      this.ownedDevices.delete(avdId)
        } else {
          // Live process, no console to ask. Safe here and only here — the data a hard stop could
          // damage is about to be wiped.
          stopEmulatorProcess(avdName)
        }
        // Throws if it is still up at the deadline, which the outer catch turns into
        // `device:boot-error`. Launching anyway would report a Full reset that never happened.
        await this.launcher.waitForExit(avdName)
        // The stop and the wait are both awaits, so a newer boot may have overtaken us. Without
        // this the superseded boot goes on to wipe a device the tester has since re-picked with the
        // toggle off — the erase-with-no-click #439 exists to prevent, on the platform where it
        // would be silent.
        if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      }

      // `|| fullErase`: the branch above left the device down on purpose, and the reading in
      // `target` predates it.
      if (target.status !== 'booted' || fullErase) {
        // One unique gRPC port per emulator (undefined when forced to scrcpy → no `-grpc`).
        const grpcPort = this.forceScrcpy() ? undefined : await this.pickFreeGrpcPort()
        state.grpcPort = grpcPort ?? null
        // The port probe is an await, and the launch below is destructive now that it can carry
        // `-wipe-data`. A `device:shutdown` landing in that gap used to reach a harmless relaunch;
        // it would now bring the device back *erased* seconds after the tester asked for it to stop.
        if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
        try {
          this.launcher.launch(avdName, grpcPort, { audio: this.audioEnabled(), wipeData: fullErase })
          const serial = await this.launcher.findSerial(avdName)
          if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
          await this.launcher.waitForBoot(serial)
          if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
          this.adb.setSerial(avdId, serial)
          this.ownedDevices.add(avdId)
        } finally {
          // The emulator now holds the port (or boot failed) — drop the reservation either way.
          if (grpcPort !== undefined) this.pendingGrpcPorts.delete(grpcPort)
        }
      }

      const refreshed = await this.adb.listDevices()
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      const refreshedDevice = refreshed.find((d) => d.id === avdId) ?? target

      this.sendDeviceInfo(state, { ...refreshedDevice, status: 'booted' } as Device)

      const streamWs = await this.openStreamWs(state)
      if (seq !== state.bootSeq) {
        streamWs.close()
        this.abandonBoot(state, seq, sessionId, requestId)
        return
      }

      await this.startVideoStream(state, streamWs)
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      this.sendMsg({
        type: 'session:chrome',
        sessionId: state.sessionId,
        payload: {
          buttons: ANDROID_BUTTONS,
          streamType: 'h264',
          screenWidth: state.displayWidth,
          screenHeight: state.displayHeight,
          cornerRadius: state.cornerRadius,
        },
      })
      state.booted = true
      this.sendMsg({ type: 'device:ready', sessionId, requestId, payload: { deviceId: avdId } })
      // Clear a network condition the last session left behind, then report (#607).
      //
      // **At boot rather than at teardown**, because airplane mode lives in the AVD's userdata and
      // outlives `emu kill` — and a session that ended in a crash, a closed terminal or `dev:down`
      // never reaches a teardown path at all. Clearing on the way up survives however the last one
      // died; clearing on the way out only works when someone was there to run it.
      //
      // The report that follows is the first of the three unsolicited producers the protocol names.
      // Without it a viewer opening a session has no idea whether this device is on the network.
      void this.resetNetworkForSession(sessionId, state, seq)
    } catch (e) {
      if (seq !== state.bootSeq) { this.abandonBoot(state, seq, sessionId, requestId); return }
      const message = e instanceof Error ? e.message : String(e)
      logger.error('boot failed:', message)
      this.sendMsg({ type: 'device:boot-error', sessionId, requestId, message })
    } finally {
      state.bootsInFlight.delete(seq)
      // Its own key, in the one case nothing reads it: a newer boot arriving after this boot's last
      // checkpoint but before it returns.
      state.bootAbandon.delete(seq)
    }
  }

  // ── network on/off (#607) ──────────────────────────────────────────────────────────────────
  //
  // Airplane mode, so the **OS** goes offline rather than the app being lied to. That is what makes
  // the app's own `ConnectivityManager` callbacks fire and the status bar follow, with nothing
  // faked — measured on API 34: `dumpsys connectivity` reports "Active default network: none" and
  // a ping from the guest fails. iOS has to hook three layers to reach the same place.

  /** The serial for a session's device, or undefined when nothing is booted. */
  /**
   * The AVDs **this agent launched**, which is not the same as the ones `adb` can see.
   *
   * `AdbWrapper.serialMap` is synced from `adb devices` on every `listDevices()`, so it holds a
   * developer's own emulator as readily as tapflow's. Written here at the two places tapflow starts
   * one and cleared at the three where it stops one — the same shape and the same purpose as
   * `IOSAgent.ownedDevices`, which exists because that platform hit this first: its
   * `soleDeviceState` comment records a version that counted every booted simulator and "made all
   * the callers above refuse with '2 booted devices' on the common two-simulator desk".
   */
  private readonly ownedDevices = new Set<string>()

  private serialFor(sessionId: string): string | undefined {
    const state = this.deviceStates.get(sessionId)
    return state ? this.adb.getSerial(state.deviceId) : undefined
  }

  /**
   * Turn a `setAirplaneMode` result into what the viewer is told.
   *
   * **Both unconfirmed shapes are `{ confirmed: false, offline: boolean }` and only the value tells
   * them apart** — the discriminator that used to live nowhere (#618). `AdbWrapper` returns the
   * value it *read* when the read-back succeeded, and the value that was *requested* when the
   * read-back failed, so:
   *
   * - `offline !== requested` — the read-back succeeded and the device had not moved. The write was
   *   accepted and did nothing: `unsupported-device`. **Not "an image that does not support this"** —
   *   that image throws from the write and lands in the branch below, which `AdbWrapper` now records
   *   at the return it describes. What reaches this branch is unmeasured, so the member names the
   *   observation and a consumer keeps offering the retry.
   * - `offline === requested` — nothing was observed. `state-unconfirmed`, which a retry may fix.
   *
   * Shared by the WS path and the capability path on purpose: they answer the same question, and the
   * doc on `setNetworkOffline` records that they had already disagreed once.
   */
  private classifyWrite(result: { confirmed: boolean; offline: boolean }, requested: boolean): NetworkStatePayload {
    if (result.confirmed) return { offline: result.offline, available: true }
    return {
      offline: result.offline,
      available: false,
      reason: result.offline === requested ? 'state-unconfirmed' : 'unsupported-device',
    }
  }

  /**
   * Read the device's current network state.
   *
   * **Reads the device, never a flag this agent kept.** A remembered value cannot see a device left
   * offline by a previous session, one changed outside tapflow, or one that survived an agent
   * restart — and every one of those ends with the viewer showing the opposite of what is true.
   *
   * `lastKnownOffline` is the fallback for a read that fails, **not** `false`: a device that is
   * offline and can no longer be read is still offline, and reporting it as online renders the
   * control in the position that hides the problem.
   */
  private async readNetworkState(serial: string, lastKnownOffline = false): Promise<NetworkStatePayload> {
    try {
      return { offline: await this.adb.airplaneMode(serial), available: true }
    } catch (e) {
      logger.warn('airplane mode read failed:', (e as Error).message)
      return { offline: lastKnownOffline, available: false, reason: 'state-unconfirmed' }
    }
  }

  /**
   * Put a device back on the network if the last session left it off, then report where it is.
   *
   * **Guarded by `bootSeq` like every other await in the boot path**, and for the reason the wipe
   * block states two hundred lines up: this **writes to the device**, and a boot that has been
   * superseded must not. The window is a real one rather than a race — the read below is an adb
   * round trip, and a tester whose device just went ready can arm the network toggle inside it.
   * Without the check, this wakes up and puts them back online with nobody having asked.
   */
  private async resetNetworkForSession(sessionId: string, state: DeviceState, seq: number): Promise<void> {
    const serial = this.serialFor(sessionId)
    if (!serial) return
    let known = false
    try {
      // Conditional: an already-online device is left alone, so an ordinary boot issues no command
      // at all. Unconditional would work too and is worse — it makes every boot a write to a
      // setting nobody asked about, on a path where a failure is not the tester's problem to solve.
      known = await this.adb.airplaneMode(serial)
      if (seq !== state.bootSeq) return
      if (known) {
        const r = await this.adb.setAirplaneMode(serial, false)
        known = r.offline
      }
    } catch (e) {
      // An image that cannot do this has nothing to clear. The report below says so.
      logger.warn('could not clear airplane mode on boot:', (e as Error).message)
    }
    if (seq !== state.bootSeq) return
    await this.reportNetworkState(sessionId, known)
  }

  /**
   * Send the current state with no correlator — this is a report, not an answer.
   *
   * `lastKnownOffline` defaults to what this device was last *observed* doing rather than to `false`,
   * because the re-join report (#614) has no freshly measured value to pass: the boot path and
   * `network:set` both hand over something they just read, and a viewer coming back has nothing
   * behind it. `false` there would answer "online" for a device that is offline and momentarily
   * unreadable, which `NetworkNotSteerable.offline` forbids.
   *
   * Silent with no device, deliberately: nobody asked, so there is no requester to answer and
   * `network:error` would be addressed to no one.
   */
  private async reportNetworkState(sessionId: string, lastKnownOffline?: boolean): Promise<void> {
    const serial = this.serialFor(sessionId)
    if (!serial) return
    const state = this.deviceStates.get(sessionId)
    const known = lastKnownOffline ?? state?.lastNetworkOffline
    const payload = await this.readNetworkState(serial, known ?? false)
    // Nothing observed and nothing readable: every value of `offline` here would be a claim, and
    // `false` is the one that reads as "on the network". Silence is already this method's answer when
    // there is no device — nobody asked, so nothing is owed — and it is the honest one here too. The
    // boot path always passes a value, so the report the protocol names on `device:ready` still goes.
    if (!payload.available && known === undefined) return
    // Only an observed value enters the memory — a failed read has nothing to record, since what it
    // returns *is* the memory (or a value the caller just read off the device).
    //
    // **No test distinguishes this from storing unconditionally, and that is stated rather than
    // implied:** for every caller today the two are the same write. It guards a future caller that
    // passes a `lastKnownOffline` it did not measure, which would otherwise become the remembered
    // truth for every later read failure.
    if (state && payload.available) state.lastNetworkOffline = payload.offline
    this.sendMsg({ type: 'network:state', sessionId, payload })
  }

  private async handleNetworkSet(sessionId: string, offline: boolean, requestId: string): Promise<void> {
    const serial = this.serialFor(sessionId)
    if (!serial) {
      this.sendMsg({
        type: 'network:error', sessionId, requestId,
        message: 'No booted device — boot one before changing its network.',
      })
      return
    }

    // What the device says now. Only used when the **write** fails, where the device is unchanged
    // and this is still true — every other path reports what the wrapper observed after writing.
    //
    // **The last confirmed value is the fallback, not `false`.** Two failures in a row — this read and
    // then the write — used to answer `offline: false` for a device the agent had already confirmed
    // offline, which draws an online control over a device whose app can reach nothing. The report
    // path has always passed this; the two write paths did not, so the one moment a device is least
    // readable was the one where the memory was dropped.
    const beforeState = this.deviceStates.get(sessionId)
    const before = await this.readNetworkState(serial, beforeState?.lastNetworkOffline)
    // A read that succeeded is an observation, and it was being thrown away. Someone flipping airplane
    // mode in the emulator's own UI between the boot read and this toggle is seen here and nowhere
    // else, so without this a later unreadable device falls back past it to the older value.
    if (beforeState && before.available) beforeState.lastNetworkOffline = before.offline

    let result: { confirmed: boolean; offline: boolean }
    try {
      result = await this.adb.setAirplaneMode(serial, offline)
    } catch (e) {
      // The write itself failed: nothing reached the device. An image whose `cmd connectivity`
      // predates the subcommand lands here — **and so does a device mid-reboot and a dropped adb
      // connection**, which is why this is `state-unconfirmed` rather than a verdict about the
      // device. Nothing in the failure separates them, and calling it permanent tells a tester to
      // give up on a device that is twenty seconds from working. `unsupported-device` is reserved for
      // the one shape that does say so on its own — see `classifyWrite`.
      //
      // **An answer, not a failure.** The viewer needs to say this and stay usable; `network:error`
      // is for a request that could not be dispatched at all, which is the no-device case above and a
      // different fix for the tester.
      logger.warn('airplane mode write failed:', (e as Error).message)
      this.sendMsg({
        type: 'network:state', sessionId, requestId,
        payload: { offline: before.offline, available: false, reason: 'state-unconfirmed' },
      })
      return
    }

    // `result.offline` is what the wrapper saw where it could see anything, and the requested value
    // where the read-back failed — never the value this agent held before the write. The write
    // happens before the confirmation, so a state it could not confirm is still more likely to be the
    // requested one than the old one. Reporting the old value here is how an offline device gets
    // rendered as online, which is the failure this whole feature exists to avoid. **Which of those
    // two an unconfirmed result is, is the whole discriminator** — see `classifyWrite`.
    // Remember it for the same reason the boot path hands its read to the report: a later re-join
    // whose own read fails falls back to this, and the write path is the freshest truth there is.
    // Only a **confirmed** result counts — an unconfirmed one is already a guess, and standing one
    // guess on another is how a stale value outlives the thing it described.
    const state = this.deviceStates.get(sessionId)
    if (state && result.confirmed) state.lastNetworkOffline = result.offline

    this.sendMsg({
      type: 'network:state', sessionId, requestId,
      payload: this.classifyWrite(result, offline),
    })
  }

  /**
   * **Answers rather than throwing when the device cannot do it**, which is what
   * `NetworkControlCapability` declares — the return type can express `available: false`, and a
   * device that does not support this is not a caller error. The WS path answers the same way; the
   * two must not disagree about the same question, and this one drifted first.
   *
   * A device that is not booted still throws: there is no state to describe.
   */
  async setNetworkOffline(offline: boolean): Promise<NetworkStatePayload> {
    // **The write #617 was filed about.** This took the first-registered session, so on an agent
    // holding several it took *someone else's* device off the network while they were testing on it.
    const { state, serial } = this.soleLive()
    // Same fallback as the WS path, for the reason recorded there.
    const before = await this.readNetworkState(serial, state.lastNetworkOffline)
    if (before.available) state.lastNetworkOffline = before.offline
    try {
      const result = await this.adb.setAirplaneMode(serial, offline)
      // **And it remembers, which this path did not.** The WS path has always stored the confirmed
      // value, so a caller that toggled through MCP and then lost the device read `false` from a
      // memory nothing had written — the fallback above had nothing to fall back to. Only a confirmed
      // result counts, for the reason the WS path gives: an unconfirmed one is already a guess.
      if (result.confirmed) state.lastNetworkOffline = result.offline
      return this.classifyWrite(result, offline)
    } catch {
      return { offline: before.offline, available: false, reason: 'state-unconfirmed' }
    }
  }

  async networkState(): Promise<NetworkStatePayload> {
    const live = this.soleLive()
    const known = live.state.lastNetworkOffline
    const state = await this.readNetworkState(live.serial, known)
    // **`false` is not "unknown", it is "on the network".** A device nobody has ever observed, whose
    // read has now failed, has no position to report — and answering `offline: false` there claims the
    // one direction that hides the problem, which is what the WS report path stays silent about
    // rather than say. A function has to answer, so it answers with the failure.
    if (!state.available && known === undefined) {
      throw new PlatformError('Cannot read the network state, and this device has never been observed')
    }
    return state
  }

  private async handleDeviceShutdown(sessionId: string, avdId: string, requestId?: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state) return

    this.bumpBootSeq(state, 'shut-down')
    this.cleanupDeviceState(state)

    const serial = this.adb.getSerial(avdId)
    if (serial) {
      // best-effort — emulator may already be gone
      await this.adb.shutdown(serial).catch((e: unknown) => {
        logger.warn('emu kill failed (already gone?):', (e as Error).message)
      })
      this.adb.clearSerial(avdId)
      this.ownedDevices.delete(avdId)
    }
    this.sendMsg({
      type: 'device:shutdown-done',
      sessionId,
      requestId,
      payload: { deviceId: avdId },
    })
  }

  // Ack a terminal input. `input:done` = the input reached a live channel on a booted device (not a
  // landing guarantee — `adb shell input` and HID are both fire-and-forget once accepted).
  // Everything else is `input:error` with the reason, because collapsing the reasons would report a
  // dead channel for an input we simply do not implement. See inputOutcome.ts.
  // `seq` is the boot generation observed when the message arrived — captured by the caller, before
  // it awaited the dispatch. Reading it here would be too late: a reboot that started under that
  // await would already have been counted, and caching `booted` across it poisons every later input
  // on the session, since they all skip the verify.
  /** The correlator on an input an ack answers, or `null` if the frame cannot be attributed.
   *
   *  A local capture rather than a guard at the top of the dispatcher: a guard there would not narrow
   *  `msg.requestId` inside the case, so the shortest way to satisfy the reply's required field would be
   *  `msg.requestId!` — the assertion removed from `open-url` and then from clipboard. Inbound is
   *  unvalidated (#444) and `mcp-server`'s tool schemas are bare `z.string()`, so `''` is reachable. */
  private correlatorOf(msg: { type: string; requestId?: string }): string | null {
    if (typeof msg.requestId === 'string' && msg.requestId !== '') return msg.requestId
    logger.warn(`${msg.type} without a usable requestId — dropped, its ack could not be attributed`)
    return null
  }

  // `requestId` joins `seq` as a caller-captured parameter, for the same reason stated above it: state
  // moves under the awaited dispatch, and a correlator read from shared state would answer one input with
  // another's id — #499 rebuilt inside the agent.
  private async ackInput(state: DeviceState, outcome: InputOutcome, seq: number, requestId: string): Promise<void> {
    // Only worth verifying the device when we believe we dispatched: every other outcome already
    // knows why it failed, and asking adb would add a round trip to say the same thing.
    const resolved: InputOutcome = outcome !== 'delivered'
      ? outcome
      : (state.booted || (await this.isBooted(state.deviceId))) ? 'delivered' : 'not-booted'
    if (resolved === 'delivered' && seq === state.bootSeq) state.booted = true // cache the verify
    this.sendMsg(
      resolved === 'delivered'
        ? { type: 'input:done', sessionId: state.sessionId, requestId }
        : { type: 'input:error', sessionId: state.sessionId, requestId, message: outcomeMessage(resolved), reason: wireReason(resolved) })
  }

  // A terminal input naming a session this agent holds no state for. `deviceStates` is never
  // deleted, so this is an unregistered sessionId rather than an evicted one — and the relay only
  // answers on an agent's behalf when the agent is *offline*, so nothing else would answer at all
  // and the caller would wait out its own timeout.
  private ackNoSession(sessionId: string, requestId: string): void {
    // The `if (!sessionId) return` this used to open with is gone: the dispatcher now declares
    // `sessionId: string`, so there is no undefined to guard against and the guard would have been a
    // silent drop with nothing left that could reach it.
    this.sendMsg({
      type: 'input:error', sessionId, requestId, message: outcomeMessage('no-session'), reason: wireReason('no-session'),
    })
  }

  // Await a pointer-channel write and turn it into an outcome. scrcpy's methods are synchronous and
  // return void, so `await` is a no-op there and `isReady()` is the whole signal; gRPC rejects, with a
  // deadline on input RPCs.
  //
  // The deadline is **not** a licence to retry, and this comment used to say it was. It cancels our
  // call, not a request the emulator already applied — and since an unreachable emulator rejects on its
  // own in 4ms, the case the deadline actually fires in is a connected-but-unresponsive emulator, where
  // whether the input landed is unknowable and a retry can double it. AGENTS.md carries the full
  // reasoning under "What the deadline does and does not buy".
  private async dispatchTo(pc: PointerControl, write: () => void | Promise<void>): Promise<InputOutcome> {
    if (!pc.isReady()) return 'channel-down'
    try {
      await write()
      return 'delivered'
    } catch (e) {
      logger.error(`pointer dispatch failed: ${e instanceof Error ? e.message : String(e)}`)
      return 'failed'
    }
  }

  private async isBooted(deviceId: string): Promise<boolean> {
    try {
      const devices = await this.adb.listDevices()
      return devices.find((d) => d.id === deviceId)?.status === 'booted'
    } catch { return false }
  }

  private handleRelayMessage(msg: { type: string; sessionId: string; requestId?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'device:boot': {
        const { deviceId, resetMode, secureContext, external } = msg.payload as { deviceId: string; resetMode?: 'app-only' | 'full-erase'; secureContext?: boolean; external?: boolean }
        this.handleDeviceBoot(msg.sessionId, deviceId, resetMode === 'full-erase', { secureContext: !!secureContext, external: !!external }, msg.requestId)
          .catch((e) => logger.error('handleDeviceBoot failed:', e))
        break
      }
      case 'device:shutdown': {
        const { deviceId } = msg.payload as { deviceId: string }
        this.handleDeviceShutdown(msg.sessionId, deviceId, msg.requestId)
          .catch((e) => logger.error('handleDeviceShutdown failed:', e))
        break
      }
      case 'app:install': {
        const { filePath, bundleId } = msg.payload as { filePath: string; bundleId?: string }
        const sessionId = msg.sessionId
        const { requestId } = msg
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] app:install without a requestId — dropped, cannot correlate a reply')
          break
        }
        // `...body` first — see the iOS handler and `open-url`.
        const respond = (body: AppInstallReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          respond({ type: 'app:install-error', message: 'No booted device' })
          break
        }
        if (filePath.endsWith('.app.zip') || filePath.endsWith('.app')) {
          respond({
            type: 'app:install-error',
            message: '.app.zip is an iOS simulator build — upload a .apk file for Android.',
          })
          break
        }
        const doInstall = async () => {
          if (bundleId) await this.adb.clearAppData(serial, bundleId).catch(() => {})
          await this.adb.installApp(serial, filePath)
        }
        doInstall()
          .then(() => respond({ type: 'app:install-done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'app:install-error', message })
          })
        break
      }
      case 'app:launch': {
        const { bundleId } = msg.payload as { bundleId: string }
        const sessionId = msg.sessionId
        const { requestId } = msg
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] app:launch without a requestId — dropped, cannot correlate a reply')
          break
        }
        // `...body` first — see the iOS handler and `open-url`.
        const respond = (body: AppLaunchReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          respond({ type: 'app:launch-error', message: 'No booted device' })
          break
        }
        this.adb.launchApp(serial, bundleId)
          .then(() => respond({ type: 'app:launch-done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'app:launch-error', message })
          })
        break
      }
      case 'input:touch:start': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const { x, y } = msg.payload as { x: number; y: number }
        const pc = this.pointerControl(state)
        if (pc && state.videoWidth > 0) {
          const px = Math.round(x * state.videoWidth)
          const py = Math.round(y * state.videoHeight)
          state.lastTouchPx = { x: px, y: py }
          this.fire(pc.touchDown(0, px, py))
        } else {
          state.touchHelper?.touchStart(x, y)
        }
        break
      }
      case 'input:touch:move': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const { x, y } = msg.payload as { x: number; y: number }
        const pc = this.pointerControl(state)
        if (pc && state.videoWidth > 0) {
          const px = Math.round(x * state.videoWidth)
          const py = Math.round(y * state.videoHeight)
          state.lastTouchPx = { x: px, y: py }
          this.fire(pc.touchMove(0, px, py))
        } else {
          state.touchHelper?.touchMove(x, y)
        }
        break
      }
      case 'input:touch:end': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        const pc = this.pointerControl(state)
        const helper = state.touchHelper
        const seq = state.bootSeq
        // terminal of a tap/swipe → ack the gesture, on what the dispatch actually reported
        void (async () => this.ackInput(state,
          pc ? await this.dispatchTo(pc, () => pc.touchUp(0, state.lastTouchPx.x, state.lastTouchPx.y))
            : helper ? await helper.touchEnd()
            : 'channel-down',
          seq, requestId,
        ))().catch((e) => logger.error('input:touch:end ack failed:', e))
        break
      }
      case 'input:pinch:start': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        const pc = this.pointerControl(state)
        if (pc && state.videoWidth > 0) {
          const px1 = Math.round(f0.x * state.videoWidth), py1 = Math.round(f0.y * state.videoHeight)
          const px2 = Math.round(f1.x * state.videoWidth), py2 = Math.round(f1.y * state.videoHeight)
          this.fire(pc.pinchStart(px1, py1, px2, py2))
        } else {
          state.touchHelper?.pinchStart(f0.x, f0.y, f1.x, f1.y)
        }
        break
      }
      case 'input:pinch:move': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const { f0, f1 } = msg.payload as { f0: { x: number; y: number }; f1: { x: number; y: number } }
        const pc = this.pointerControl(state)
        if (pc && state.videoWidth > 0) {
          const px1 = Math.round(f0.x * state.videoWidth), py1 = Math.round(f0.y * state.videoHeight)
          const px2 = Math.round(f1.x * state.videoWidth), py2 = Math.round(f1.y * state.videoHeight)
          this.fire(pc.pinchMove(px1, py1, px2, py2))
        } else {
          state.touchHelper?.pinchMove(f0.x, f0.y, f1.x, f1.y)
        }
        break
      }
      case 'input:pinch:end': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        const pc = this.pointerControl(state)
        const helper = state.touchHelper
        const seq = state.bootSeq
        void (async () => this.ackInput(state,
          pc ? await this.dispatchTo(pc, () => pc.pinchEnd())
            : helper ? helper.pinchEnd()   // 'unsupported' — the adb path has no pinch at all
            : 'channel-down',
          seq, requestId,
        ))().catch((e) => logger.error('input:pinch:end ack failed:', e))
        break
      }
      case 'input:rotate': {
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) break
        const serial = this.adb.getSerial(state.deviceId)
        if (!serial) break
        // The viewer owns rotation intent locally (CSS); here we only ask the device to
        // rotate so rotation-capable apps re-layout. user_rotation=3 = canonical landscape
        // (home-left/punch-right). Portrait-locked apps ignore it — the viewer's CSS handles
        // their cosmetic rotation, so we don't track or sync device rotation back.
        const next = !state.landscape
        state.landscape = next
        this.adb.setRotation(serial, next ? 3 : 0).catch(() => { state.landscape = !next })
        break
      }
      case 'input:button': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        // Buttons go through the adb helper on BOTH backends — this is the path that actually runs
        // a command in production, so its outcome is the one that matters most here.
        // Destructuring inside the async body: doing it out here would throw synchronously on a
        // malformed payload, and the ws dispatch swallows that, leaving the caller with no ack.
        const seq = state.bootSeq
        void (async () => {
          const { name } = (msg.payload ?? {}) as { name?: string }
          const helper = state.touchHelper
          if (name === undefined) return this.ackInput(state, 'malformed', seq, requestId)
          if (!helper) return this.ackInput(state, 'channel-down', seq, requestId)
          return this.ackInput(state, await helper.pressButton(name), seq, requestId)
        })().catch((e) => logger.error('input:button ack failed:', e))
        break
      }
      case 'stream:request-idr': {
        // Relay drop-to-keyframe / join recovery: reset the encoder so it re-emits SPS/PPS + IDR,
        // resyncing fast instead of waiting for the periodic IDR. Throttled by the relay.
        const st = this.deviceStates.get(msg.sessionId)
        st?.scrcpySession?.control.resetVideo()
        st?.emulatorVideo?.requestIdr()
        break
      }
      case 'open-url': {
        const { url } = msg.payload as { url: string }
        const sessionId = msg.sessionId
        const { requestId } = msg
        // No fallback by design (see the note above `OpenUrl`), so an uncorrelatable request cannot be
        // answered correlatably either — and inventing an id would make this agent's reply look like a
        // response to a request nobody made. Every in-repo sender supplies one, and the `fixed` version
        // group means there is no in-repo skew window; validating third-party frames at the relay's door
        // is #444, which will take this over. Until then a drop with a log beats a reply that lies.
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] open-url without a requestId — dropped, cannot correlate a reply')
          break
        }
        // See the iOS handler for what this does and does not enforce. `...body` first is load-bearing:
        // with the ids last a body variable carrying a `requestId` overrides the real one, and excess
        // property checking does not fire on variables.
        const respond = (body: OpenUrlReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          respond({ type: 'open-url:error', message: 'No booted device' })
          break
        }
        this.adb.openUrl(serial, url)
          .then(() => respond({ type: 'open-url:done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'open-url:error', message })
          })
        break
      }
      case 'input:keyboard:toggle': {
        // client-side key forwarding toggle only — no ADB side effect needed
        break
      }
      case 'input:type': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        const { text } = (msg.payload ?? {}) as { text?: string }
        if (!serial) {
          this.sendMsg({ type: 'input:type-error', sessionId, requestId, message: 'No booted device' })
          break
        }
        // Empty text is a successful no-op, not a failure: the caller asked for nothing and nothing
        // was needed, so there is no claim to be false about. iOS answers the same way, and both the
        // flow schema and the MCP `type_text` tool accept `""`. (The lie this change removes is
        // "dispatched nothing while claiming otherwise" — not "dispatched nothing".)
        // Ack on completion so a following input step (e.g. pressKey Enter) is
        // only sent after the text has actually landed.
        Promise.resolve(text ? this.adb.inputText(serial, text) : undefined)
          .then(() => this.sendMsg({ type: 'input:type-done', sessionId, requestId }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            logger.error('input:type failed:', e)
            this.sendMsg({ type: 'input:type-error', sessionId, requestId, message })
          })
        break
      }
      case 'input:key': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        const state = this.deviceStates.get(msg.sessionId)
        if (!state) { this.ackNoSession(msg.sessionId, requestId); break }
        const seq = state.bootSeq
        void (async () => {
          const serial = this.adb.getSerial(state.deviceId)
          if (!serial) return this.ackInput(state, 'channel-down', seq, requestId)
          // `modifiers` is optional in the contract and iOS already defaults it; match that here so
          // both agents read the same message the same way.
          const { code, modifiers } = (msg.payload ?? {}) as { code?: string; modifiers?: number }
          if (code === undefined) return this.ackInput(state, 'malformed', seq, requestId)
          return this.ackInput(state, await this.handleKeyInput(serial, code, modifiers ?? 0), seq, requestId)
        })().catch((e) => logger.error('input:key ack failed:', e))
        break
      }
      case 'screenshot:request': {
        // `format` is deliberately destructured and unused — it is on the wire and this platform
        // cannot honour it, which is the whole of #508. Reading it here and answering with it is
        // exactly the bug.
        const raw = msg as unknown as { requestId: string; format?: 'png' | 'jpeg'; sessionId?: string }
        const { requestId } = raw
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.sendMsg({ type: 'screenshot:error', sessionId, requestId, message: 'No booted device' })
          break
        }
        this.adb.screenshot(serial)
          .then((buf) => this.sendMsg({
            type: 'screenshot:done',
            sessionId,
            requestId,
            // `'png'`, never the requested format. `screencap -p` produces PNG and takes no format
            // argument, and this field means what was produced — the request's is a preference (see
            // `ScreenshotRequest` in protocol). Echoing it sent PNG bytes out under `image/jpeg`
            // (#508), which the relay then wrote into the HTTP Content-Type.
            format: 'png',
            data: buf.toString('base64'),
          }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.sendMsg({ type: 'screenshot:error', sessionId, requestId, message })
          })
        break
      }
      case 'app:clear-state': {
        const { bundleId } = (msg.payload ?? {}) as { bundleId?: string }
        const sessionId = msg.sessionId
        const { requestId } = msg
        if (typeof requestId !== 'string' || requestId === '') {
          console.warn('[tapflow] app:clear-state without a requestId — dropped, cannot correlate a reply')
          break
        }
        const respond = (body: AppClearStateReplyBody) => this.sendMsg({ ...body, sessionId, requestId })
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial || !bundleId) {
          respond({ type: 'app:clear-state-error', message: !serial ? 'No booted device' : 'bundleId missing' })
          break
        }
        this.adb.clearAppData(serial, bundleId)
          .then(() => respond({ type: 'app:clear-state-done' }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            respond({ type: 'app:clear-state-error', message })
          })
        break
      }
      case 'network:set': {
        const requestId = this.correlatorOf(msg)
        if (requestId === null) break
        // `?? {}` and a re-check of a field the relay's schema already requires: this case owes a
        // reply, and the ws dispatch swallows a synchronous throw (see `input:button`), so a cast
        // that dereferences a missing payload answers nothing at all — the one failure the
        // requester cannot tell from a hung device. A malformed frame gets a `network:error`
        // because it could not be dispatched, which is the same reason the no-device case does.
        const { offline } = (msg.payload ?? {}) as { offline?: boolean }
        if (typeof offline !== 'boolean') {
          this.sendMsg({
            type: 'network:error', sessionId: msg.sessionId, requestId,
            message: 'network:set payload must carry a boolean `offline`.',
          })
          break
        }
        void this.handleNetworkSet(msg.sessionId, offline, requestId)
        break
      }
      // The relay asks on a viewer's re-join (#614). Uncorrelated both ways: the reply is a report,
      // and nothing here is waiting on it — a session with no booted device answers nothing at all,
      // because `network:error` would be addressed to a requester that does not exist.
      case 'network:request-state':
        void this.reportNetworkState(msg.sessionId)
        break
      // Clipboard bridge. Emulator-only: it rides the gRPC EmulatorController, since the
      // AVD images have no `adb shell cmd clipboard`. The chord is pressed HERE, not by the
      // viewer — the browser cannot know when the key lands, and reading too early returns
      // the PREVIOUS clipboard, a stale value the user would never notice.
      case 'clipboard:read':
      case 'clipboard:write': {
        // `requestId: string`, matching the screenshot and ui:tree casts a few cases below — clipboard was
        // the only one reading it as optional, for the same wire guarantee. `ClipboardRequest.requestId` is
        // required and the only requester goes through a typed `send()`, so nothing in-repo omits it.
        //
        // It is still an assertion about unvalidated JSON, as those other two are: a third-party client
        // could omit it, and then the reply would carry `undefined` and be uncorrelatable. That is inbound
        // validation (#444), not producer typing, and making it optional here instead would just move the
        // same hole into every reply this case sends.
        const { requestId } = msg as unknown as { requestId: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        // Every caller of `fail` gave up before parking anything itself, but another operation
        // on the same device may still hold a marker — and the chord the viewer would press in
        // response does not go through the queue. So report the device, not the caller.
        const fail = (message: string, unsupported = false) =>
          this.sendMsg({
            type: 'clipboard:error', sessionId, requestId, message,
            payload: {
              unsupported,
              sentinelParked: state ? this.sentinelParked(state.deviceId) : false,
            } satisfies ClipboardErrorPayload,
          })
        // Distinguish the three ways this can be unavailable — they need different fixes.
        if (!state || !serial) { fail('No booted device'); break }
        if (!state.grpcClient) {
          // `unsupported` means this backend has no clipboard channel at all, so it can never
          // park a sentinel — which makes it the one error where the viewer may safely press
          // the plain chord. Without that the shortcut would silently do nothing here, which
          // is worse than the behaviour that predates this feature.
          fail('Clipboard needs the emulator gRPC backend — this device pastes on-device only', true)
          break
        }
        const client = state.grpcClient
        const onError = (e: unknown) => fail(e instanceof Error ? e.message : String(e))

        if (msg.type === 'clipboard:read') {
          const { press } = (msg.payload ?? {}) as { press?: 'copy' | 'cut' }
          // Answering is separate from cleaning up: the restore is a `finally`, which runs after
          // the `catch` that replies, so the viewer hears back as soon as the outcome is known.
          // The queue is still held until the restore lands — that is what stops the next
          // operation seeing a sentinel. Mirrors the iOS read path.
          const respond = (body: ClipboardReplyBody) =>
            this.sendMsg({ sessionId, requestId, ...body })
          // The ceiling applies to whatever leaves the device, not just the sentinel path —
          // iOS gets this from getPasteboard's maxBuffer, so Android is the only side that
          // could put a multi-MB guest clipboard on the socket the video shares.
          const capped = (text: string): string => {
            if (clipboardByteLength(text) > MAX_CLIPBOARD_BYTES) {
              throw new PlatformError(`The device clipboard is too large to send (max ${Math.floor(MAX_CLIPBOARD_BYTES / 1024)} KB)`)
            }
            return text
          }
          const read = async (): Promise<void> => {
            if (!press) {
              respond({ type: 'clipboard:data', payload: { text: capped(await client.getClipboard()) } })
              return
            }
            // Overwrite with a value only we could have written, press the chord, then wait for
            // it to change. A fixed delay can only guess whether the app has copied yet, and
            // guessing wrong hands back the PREVIOUS clipboard with no error. The sentinel also
            // covers re-copying identical text, where a plain value-change watch never fires.
            // Read the original first. If we cannot, do NOT continue: parking a sentinel we are
            // unable to undo would destroy whatever the user had on the device clipboard.
            const raw = await client.getClipboard()
            const before = isSentinel(raw) ? '' : raw
            const sentinel = `${SENTINEL_PREFIX}${randomUUID()}`
            let copied: string | null = null
            // Counted before the call: setClipboard only schedules, so a rejection can still
            // leave the marker applied — everything from here to the restore counts as parked.
            this.markSentinel(state.deviceId, 1)
            try {
              // Inside the try: setClipboard only schedules the change, so a rejection can
              // still leave it applied — the restore below has to run either way.
              await client.setClipboard(sentinel)
              // ...and a resolved setClipboard means *scheduled*, not applied (see the proto).
              // Pressing before it lands would let the first poll read the pre-sentinel value
              // and return it as "what the app copied" — the exact staleness this guards.
              const applied = Date.now() + CLIPBOARD_WRITE_DEADLINE_MS
              while ((await client.getClipboard()) !== sentinel) {
                if (Date.now() >= applied) throw new PlatformError('The device clipboard did not respond')
                await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
              }
              await bounded(
                this.adb.sendKeyEvent(serial, press === 'cut' ? 'KEYCODE_CUT' : 'KEYCODE_COPY'),
                ADB_KEYEVENT_TIMEOUT_MS, 'copy keyevent')
              const deadline = Date.now() + CLIPBOARD_COPY_DEADLINE_MS
              do {
                const now = await client.getClipboard()
                // A sentinel is never a copy result: ours means "not yet", another one means a
                // concurrent operation slipped in and must not be handed to the user.
                if (!isSentinel(now)) {
                  copied = now
                  respond({ type: 'clipboard:data', payload: { text: capped(now) } })
                  return
                }
                await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
              } while (Date.now() < deadline)
              throw new PlatformError('The device did not copy anything — is something selected?')
            } catch (e) {
              // Reply here rather than letting this propagate: a rejection would surface only
              // after `finally` had restored, putting that window inside the round trip.
              respond({
                type: 'clipboard:error', message: e instanceof Error ? e.message : String(e),
                // setClipboard only schedules, so a rejection can still leave the marker applied.
                payload: {
                  unsupported: false, sentinelParked: this.sentinelParked(state.deviceId),
                } satisfies ClipboardErrorPayload,
              })
            } finally {
              // Restore only if nothing was copied; otherwise this would clobber the capture.
              // And wait for it to APPLY, not just schedule: releasing the queue early lets the
              // next operation read the sentinel as the original — which then becomes '' and
              // wipes the user's device clipboard.
              if (copied === null) {
                await client.setClipboard(before).catch(() => {})
                const restored = Date.now() + CLIPBOARD_RESTORE_DEADLINE_MS
                while ((await client.getClipboard().catch(() => before)) !== before) {
                  if (Date.now() >= restored) break   // best effort; the error is already going out
                  await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
                }
              }
              this.markSentinel(state.deviceId, -1)
            }
          }
          // `read` answers for itself; this only catches what the press-less branch can throw.
          this.clipboardQueue(state.deviceId, read).catch(onError)
        } else {
          const { text, pasteAfter } = (msg.payload ?? {}) as { text?: string; pasteAfter?: boolean }
          if (clipboardByteLength(text ?? '') > MAX_CLIPBOARD_BYTES) {
            fail(`Clipboard is too large (max ${Math.floor(MAX_CLIPBOARD_BYTES / 1024)} KB)`)
            break
          }
          const write = async (): Promise<void> => {
            const wanted = text ?? ''
            await client.setClipboard(wanted)
            if (!pasteAfter) return
            // setClipboard is explicitly asynchronous in the proto ("executed on the emulator's
            // main looper ... returns OK upon successful asynchronous scheduling"), so a resolved
            // promise means scheduled, not applied. Pasting now would paste the old clipboard.
            const deadline = Date.now() + CLIPBOARD_WRITE_DEADLINE_MS
            while ((await client.getClipboard().catch(() => null)) !== wanted) {
              if (Date.now() >= deadline) throw new PlatformError('The device clipboard did not accept the text')
              await new Promise((r) => setTimeout(r, CLIPBOARD_POLL_MS))
            }
            await bounded(this.adb.sendKeyEvent(serial, 'KEYCODE_PASTE'),
              ADB_KEYEVENT_TIMEOUT_MS, 'paste keyevent')
          }
          // Ack only once the write (and the paste, when asked for) actually landed.
          this.clipboardQueue(state.deviceId, write)
            .then(() => this.sendMsg({ type: 'clipboard:write-done', sessionId, requestId }))
            .catch(onError)
        }
        break
      }
      case 'ui:tree:request': {
        const raw = msg as unknown as { requestId: string; sessionId?: string }
        const { requestId } = raw
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.sendMsg({ type: 'ui:tree:error', sessionId, requestId, message: 'No booted device' })
          break
        }
        this.adb.dumpUiHierarchy(serial)
          .then((xml) => this.sendMsg({
            type: 'ui:tree:response',
            sessionId,
            requestId,
            elements: parseUiAutomatorDump(xml),
          }))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.sendMsg({ type: 'ui:tree:error', sessionId, requestId, message })
          })
        break
      }
    }
  }

  private async handleKeyInput(serial: string, code: string, modifiers: number): Promise<InputOutcome> {
    const SPECIAL: Record<string, string> = {
      Backspace: '67', Enter: '66', Tab: '61', Space: '62', Escape: '111',
      ArrowLeft: '21', ArrowRight: '22', ArrowUp: '19', ArrowDown: '20',
      Delete: '112', Home: '122', End: '123', PageUp: '92', PageDown: '93',
      F1: '131', F2: '132', F3: '133', F4: '134', F5: '135',
      F6: '136', F7: '137', F8: '138', F9: '139', F10: '140', F11: '141', F12: '142',
    }
    // Every exit below reports whether it dispatched, not merely whether it threw. Two of them
    // deliberately send nothing, and answering `delivered` for those would be the same lie this
    // vocabulary exists to remove.
    // `Object.hasOwn`, not truthiness: `code` comes off the wire, and `'constructor'` would
    // otherwise resolve up the prototype chain to a function and be dispatched as a keycode.
    if (Object.hasOwn(SPECIAL, code)) {
      return this.dispatchKey(() => this.adb.sendKeyEvent(serial, SPECIAL[code]))
    }
    // A Ctrl/Cmd chord is a command, not text. `input text` can't do chords, so map the
    // clipboard shortcuts to dedicated keycodes (a Mac viewer sends Cmd = meta 0x08; treat
    // meta and ctrl alike). Any other chord+letter (e.g. Cmd+A) must NOT type the raw letter.
    if (modifiers & (0x01 | 0x08)) {
      const CLIP: Record<string, string> = { KeyC: 'KEYCODE_COPY', KeyV: 'KEYCODE_PASTE', KeyX: 'KEYCODE_CUT' }
      // Anything else — Cmd+A, Ctrl+S — is intentionally not sent. The channel is fine; we do not
      // implement it.
      if (!Object.hasOwn(CLIP, code)) return 'unsupported'
      return this.dispatchKey(() => this.adb.sendKeyEvent(serial, CLIP[code]))
    }
    const shift = Boolean(modifiers & 0x02)
    let char: string | null = null
    if (code.startsWith('Key')) {
      const letter = code.slice(3)
      char = shift ? letter.toUpperCase() : letter.toLowerCase()
    } else if (code.startsWith('Digit')) {
      const digit = code.slice(5)
      const shiftDigits: Record<string, string> = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
      }
      char = shift ? (shiftDigits[digit] ?? digit) : digit
    } else {
      const PUNCT: Record<string, [string, string]> = {
        Minus: ['-', '_'], Equal: ['=', '+'],
        BracketLeft: ['[', '{'], BracketRight: [']', '}'],
        Backslash: ['\\', '|'], Semicolon: [';', ':'],
        Quote: ["'", '"'], Comma: [',', '<'],
        Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'],
      }
      if (Object.hasOwn(PUNCT, code)) char = shift ? PUNCT[code][1] : PUNCT[code][0]
    }
    // CapsLock, F13+, IntlBackslash, Numpad… — no character mapping, so nothing goes out.
    if (!char) return 'unsupported'
    const text = char
    return this.dispatchKey(() => this.adb.sendInput(serial, 'text', text))
  }

  private async dispatchKey(send: () => Promise<void>): Promise<InputOutcome> {
    try {
      await send()
      return 'delivered'
    } catch (e) {
      logger.error(`key dispatch failed: ${e instanceof Error ? e.message : String(e)}`)
      return 'failed'
    }
  }

  listDevices(): Promise<Device[]> { return this.adb.listDevices() }

  async boot(avdId: string): Promise<void> {
    const avdName = avdId.replace(/^avd:/, '')
    this.launcher.launch(avdName)
    const serial = await this.launcher.findSerial(avdName)
    await this.launcher.waitForBoot(serial)
    this.adb.setSerial(avdId, serial)
    this.ownedDevices.add(avdId)
  }

  async shutdown(avdId: string): Promise<void> {
    const serial = this.adb.getSerial(avdId)
    if (serial) {
      await this.adb.shutdown(serial)
      this.adb.clearSerial(avdId)
      this.ownedDevices.delete(avdId)
    }
  }

  /**
   * The one live device, or a refusal — **the resolver every session-less entry point shares.**
   *
   * `IOSAgent.soleOf` has done this since #607 and says why: *"Refusing beats guessing: this interface
   * has no way to say which device is meant, and picking one silently is the whole defect being fixed
   * here."* Same defect, same interface, and this class never got it — eleven entry points each took
   * `deviceStates.values().next().value`, the entry the relay happened to register first. For a read
   * that answers about the wrong device; for `setNetworkOffline` it takes a device off the network
   * while somebody else is testing on it (#617).
   *
   * **Liveness is `adb` reporting the emulator attached — not tapflow having launched it.**
   * `IOSAgent.soleDeviceState`'s comment says this map is "only populated on launch" and that is
   * **wrong**: `AdbWrapper.listDevices` syncs it from `adb devices` on every call, taking every
   * `emulator-*` in state `device` whoever started it, and dropping the ones that went away. The
   * claim was inherited from that comment and checked afterwards; it is recorded here so the next
   * reader does not inherit it again.
   *
   * So a developer with their own emulator open, plus one a tester booted, is two live devices — and
   * refusing there would be the feature removed by its own fix. `ownedDevices` is what separates
   * them, and it is why that set exists rather than the serial map being enough on its own. **iOS
   * narrows the same way for the same desk** (`soleLiveDeviceState`), after a version that did not.
   *
   * **What ownership does not cover**: an emulator tapflow launched and someone else killed keeps
   * its serial *and* its ownership until the next `listDevices()` syncs the map (`AdbWrapper` calls
   * that removal "stale serials"). A ghost can still make a live device ambiguous for that window.
   * Refusing is the safe direction there, and the window closes on the next device listing.
   *
   * **Absence is not an error here**, because the touch entry points have always no-opped without a
   * device and making them throw would change more than the ambiguity this fixes. `soleLive` is the
   * variant that demands one.
   *
   * **Ambiguity is an error even for input, and there this class diverges from iOS on purpose.**
   * `IOSAgent.liveDeviceState` returns `undefined` when it cannot choose, so a tap on a
   * two-simulator desk silently does nothing. Silence is the failure mode this repo keeps removing:
   * a tester taps, nothing moves, and no channel says why. `touchStart` returns `void` so a throw is
   * the only signal available to it, and `touchMove`/`touchEnd` reject.
   */
  private soleLiveOrNone(): { state: DeviceState; serial: string } | undefined {
    const live: Array<{ state: DeviceState; serial: string }> = []
    for (const state of this.deviceStates.values()) {
      const serial = this.adb.getSerial(state.deviceId)
      if (serial) live.push({ state, serial })
    }
    if (live.length === 0) return undefined
    // **Ownership narrows liveness, and only when it can** — `IOSAgent.soleLiveDeviceState`'s line
    // for the same desk. A developer's own emulator plus tapflow's is two live devices and one
    // obvious answer; when ownership says nothing (nothing launched through tapflow yet, or an agent
    // that reconnected before it booted anything) there is no narrowing to apply and refusing is the
    // honest reply.
    const mine = live.filter((l) => this.ownedDevices.has(l.state.deviceId))
    const pool = mine.length > 0 ? mine : live
    if (pool.length > 1) {
      throw new ValidationError(`${pool.length} booted devices — this entry point cannot choose between them`)
    }
    return pool[0]
  }

  /** `soleLiveOrNone`, for the callers that have nothing to do without a device. */
  private soleLive(): { state: DeviceState; serial: string } {
    const live = this.soleLiveOrNone()
    if (!live) throw new ValidationError('no booted device — call connect() first')
    return live
  }

  async installApp(apkPath: string): Promise<void> {
    await this.adb.installApp(this.soleLive().serial, apkPath)
  }

  async launchApp(packageName: string): Promise<void> {
    await this.adb.launchApp(this.soleLive().serial, packageName)
  }

  async screenshot(): Promise<Buffer> {
    return this.adb.screenshot(this.soleLive().serial)
  }

  async queryUITree(): Promise<UIElement[]> {
    return parseUiAutomatorDump(await this.adb.dumpUiHierarchy(this.soleLive().serial))
  }

  stream(): ReadableStream<Buffer> {
    // **Resolved by `soleLiveOrNone`, then checked for frames separately.** Liveness here is a video
    // source rather than a serial, and the two are not the same: a device can be launched and have no
    // stream yet. Routing the *choice* through the shared resolver fixes the ambiguity without
    // swallowing this method's own message.
    const state = this.soleLiveOrNone()?.state
    // Works on either video backend (scrcpy for real devices, gRPC host-encode for emulators).
    const frames = state?.scrcpySession?.video.start() ?? state?.emulatorVideo?.frames()
    if (!frames) throw new ValidationError('no active video stream — call connect() first')
    // DeviceAgent.stream() is the platform-neutral Buffer contract; unwrap ScrcpyFrame payloads.
    return frames.pipeThrough(new TransformStream<ScrcpyFrame, Buffer>({
      transform(frame, controller) { controller.enqueue(frame.payload) },
    }))
  }

  touchStart(x: number, y: number): void {
    this.soleLiveOrNone()?.state.touchHelper?.touchStart(x, y)
  }

  // `async`, so the refusal arrives as a rejection rather than escaping at the call site. It declared
  // `Promise<void>` and could not throw before this change; a caller that wrote `.catch()` on the
  // strength of that signature would have been broken by exactly the path this change added.
  async touchMove(x: number, y: number): Promise<void> {
    this.soleLiveOrNone()?.state.touchHelper?.touchMove(x, y)
  }

  // The platform-neutral DeviceAgent contract has no ack channel, so the outcome is dropped on
  // purpose — but it must be consumed rather than left floating: the helper now returns a promise,
  // and an adb failure escaping here would be an unhandled rejection.
  async touchEnd(): Promise<void> {
    await this.soleLiveOrNone()?.state.touchHelper?.touchEnd()
  }

  async openUrl(url: string): Promise<void> {
    await this.adb.openUrl(this.soleLive().serial, url)
  }
}
