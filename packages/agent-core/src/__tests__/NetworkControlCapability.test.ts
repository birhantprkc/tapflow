import { describe, it, expect } from 'vitest'
import { hasNetworkControl } from '../NetworkControlCapability'
import type { NetworkControlCapability, NetworkStatePayload } from '../NetworkControlCapability'
import type { DeviceAgent } from '../DeviceAgent'
import type { Device, UIElement } from '../types'

// An agent that implements DeviceAgent and nothing optional — the shape every platform can meet.
class PlainAgent implements DeviceAgent {
  listDevices(): Promise<Device[]> { return Promise.resolve([]) }
  boot(_deviceId: string): Promise<void> { return Promise.resolve() }
  shutdown(_deviceId: string): Promise<void> { return Promise.resolve() }
  installApp(_path: string): Promise<void> { return Promise.resolve() }
  launchApp(_bundleId: string): Promise<void> { return Promise.resolve() }
  screenshot(): Promise<Buffer> { return Promise.resolve(Buffer.alloc(0)) }
  stream(): ReadableStream<Buffer> { return new ReadableStream() }
  touchStart(_x: number, _y: number): void {}
  touchMove(_x: number, _y: number): Promise<void> { return Promise.resolve() }
  touchEnd(): Promise<void> { return Promise.resolve() }
  openUrl(_url: string): Promise<void> { return Promise.resolve() }
  queryUITree(): Promise<UIElement[]> { return Promise.resolve([]) }
}

class NetworkAgent extends PlainAgent implements NetworkControlCapability {
  private offline = false
  setNetworkOffline(offline: boolean): Promise<NetworkStatePayload> {
    this.offline = offline
    return Promise.resolve({ offline, available: true })
  }
  networkState(): Promise<NetworkStatePayload> {
    return Promise.resolve({ offline: this.offline, available: true })
  }
}

/** Implements the feature but cannot run it on this device — the case the capability string cannot
 *  express, because it is announced once per agent and this is per device.
 *
 *  **It still reports the device's real state.** This one was never taken offline, so `offline` is
 *  false because that is true, not because the request failed — see `UnsteerableOfflineAgent`
 *  below for the half that distinction exists for. */
class UnavailableNetworkAgent extends PlainAgent implements NetworkControlCapability {
  setNetworkOffline(_offline: boolean): Promise<NetworkStatePayload> {
    return Promise.resolve({ offline: false, available: false, reason: 'hooks-not-installed' })
  }
  networkState(): Promise<NetworkStatePayload> {
    return Promise.resolve({ offline: false, available: false, reason: 'hooks-not-installed' })
  }
}

/** Taken offline, then the injection was lost — the app relaunched, or a re-arm did not happen. The
 *  device is **still off the network** and tapflow can no longer put it back. */
class UnsteerableOfflineAgent extends PlainAgent implements NetworkControlCapability {
  setNetworkOffline(_offline: boolean): Promise<NetworkStatePayload> {
    return Promise.resolve({ offline: true, available: false, reason: 'not-armed' })
  }
  networkState(): Promise<NetworkStatePayload> {
    return Promise.resolve({ offline: true, available: false, reason: 'not-armed' })
  }
}

describe('NetworkControlCapability', () => {
  it('hasNetworkControl is false for an agent without it', () => {
    expect(hasNetworkControl(new PlainAgent())).toBe(false)
  })

  it('hasNetworkControl is true for an agent that implements both methods', () => {
    expect(hasNetworkControl(new NetworkAgent())).toBe(true)
  })

  // Both members, not either — a half-implemented agent would satisfy a one-sided check and then
  // throw at the call site the viewer already enabled a control for.
  it('is false when only one of the two methods is present', () => {
    const halves = [
      Object.assign(new PlainAgent(), { setNetworkOffline: () => Promise.resolve({ offline: true, available: true }) }),
      Object.assign(new PlainAgent(), { networkState: () => Promise.resolve({ offline: true, available: true }) }),
    ]
    for (const half of halves) expect(hasNetworkControl(half as DeviceAgent)).toBe(false)
  })

  // **`typeof … === 'function'`, not merely present.** With both keys there but not callable, a
  // presence check passes and the viewer enables a control whose first use throws. The two halves
  // above cannot catch that — each is missing a key, so the *other* operand answers false whichever
  // way the check is written.
  it('is false for an object carrying both names as non-callable values', () => {
    const impostor = Object.assign(new PlainAgent(), { setNetworkOffline: true, networkState: 'yes' })
    expect(hasNetworkControl(impostor as unknown as DeviceAgent)).toBe(false)
  })

  // Pins the **fixture**, not production: `NetworkAgent` is defined in this file and no code from
  // `NetworkControlCapability.ts` is on this path. It earns its place by keeping the double honest
  // — a fixture that drifts from the interface is how a suite proves something about nothing.
  it('the double round-trips the offline flag, as the interface requires', async () => {
    const agent = new NetworkAgent()
    expect((await agent.networkState()).offline).toBe(false)
    expect((await agent.setNetworkOffline(true)).offline).toBe(true)
    expect((await agent.networkState()).offline).toBe(true)
    expect((await agent.setNetworkOffline(false)).offline).toBe(false)
  })

  // The distinction the whole two-layer design rests on: an agent can implement this and still be
  // unable to do it here. `hasNetworkControl` answers the first question and must not be read as
  // answering the second — that is what `available` is for.
  it('an agent that cannot run it on this device still has the capability', async () => {
    // Only the first assertion below reaches production; the rest pin the double. Both matter, and
    // the comment is here so a reader does not take the block for coverage it is not.
    const agent = new UnavailableNetworkAgent()
    expect(hasNetworkControl(agent)).toBe(true)

    const state = await agent.setNetworkOffline(true)
    // Narrowing on `available` is how a consumer reaches `reason` at all — the payload is a union,
    // so an unavailable state without one cannot be constructed and an available state with one
    // cannot either. This is the consumer shape the viewer will use.
    expect(state.available).toBe(false)
    if (state.available) throw new Error('expected an unavailable state')
    expect(state.reason).toBe('hooks-not-installed')
    // `false` because the device really is on the network — not as a stand-in for "the request did
    // not land". The test below is the one that pins which of those two `offline` means.
    expect(state.offline).toBe(false)
  })

  // **`offline` describes the device, never the request.** A device taken offline and then left
  // unsteerable is still offline, and reporting `false` there would render "online" over a device
  // whose app can reach nothing — after which every bug filed goes to the app under test. There is
  // no third value on the wire for "unknown", so a producer that uses `offline` as a placeholder
  // has no way to say what is true.
  it('reports a device that is offline and no longer steerable as offline', async () => {
    const state = await new UnsteerableOfflineAgent().networkState()
    expect(state).toEqual({ offline: true, available: false, reason: 'not-armed' })
  })
})
