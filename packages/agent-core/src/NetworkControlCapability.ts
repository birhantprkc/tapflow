import type { NetworkStatePayload, NetworkUnavailableReason } from '@tapflowio/protocol'
import type { DeviceAgent } from './DeviceAgent.js'

// Optional network-control capability (take the device under test off the network and back), kept
// OUT of the core DeviceAgent interface (ISP): the mechanism is platform-asymmetric and opt-in, so
// only agents that can do it implement it. Consumers must feature-detect with hasNetworkControl().
//
// **The only capability interface left, and that is the shape working out rather than a gap.**
// `AudioStreamCapability` sat beside this one and was deleted: no implementer, no consumer, and no
// `AgentCapability` string, because audio is not feature-detected at all — the dashboard plays
// whatever frames arrive. An interface declared for a detection nobody performs, of a feature built
// through a different mechanism, tells a third-party implementer to do something neither first-party
// agent does.

// The state shape and its reason set are **wire** types, so `@tapflowio/protocol` owns them and this
// re-exports rather than re-declares — the rule `types.ts` states for `ClipboardErrorPayload` and the
// five beside it. A second copy here would drift the moment a reason is added: nothing would fail,
// and an agent typed against this package simply could not return the new value.
//
// `NetworkState` is deliberately **not** the name used here. Protocol exports that as the *message*;
// taking it for the payload would put two different types under one name across two packages an
// agent imports in the same file.
export type { NetworkStatePayload, NetworkUnavailableReason }

/**
 * **In-process only, and that is the whole scope (#617, #620).**
 *
 * Nothing outside an agent's own process holds a `DeviceAgent`. `mcp-server` and `flow-runner` each
 * hold a WebSocket client to the relay and address a device by session id over the wire —
 * `client.<verb>(sessionId, …)` — so the network tool they would expose goes through `network:set`,
 * which already names its session and already answers with a correlated `network:state`.
 *
 * That is why these two take no session id and send nothing on the wire. It was read the other way
 * for a while: two issues were filed asking for a session parameter and a wire report, on the premise
 * that MCP calls these. It does not, and a second session-addressed API that no out-of-process caller
 * can reach would have closed the issues without preventing anything.
 *
 * **What an embedded caller owes instead.** These resolve the device themselves, and **both agents now
 * refuse rather than choose** when more than one is live — Android took the first it had registered
 * until #617, which is the sentence this paragraph used to carry. An in-process caller holding more
 * than one session should use the wire path, or the agent's own session-addressed handlers, rather
 * than these: not because the pick is arbitrary any more, but because it is now an error.
 */
export interface NetworkControlCapability {
  /** Take the device off the network, or put it back. Returns the state that resulted, which may
   *  report `available: false` — asking for something the device cannot do is an answer, not an
   *  error. */
  setNetworkOffline(offline: boolean): Promise<NetworkStatePayload>
  /** The current state, for the unsolicited report a session gets on `device:ready` and after a
   *  boot re-arms whatever the platform needs armed. */
  networkState(): Promise<NetworkStatePayload>
}

export function hasNetworkControl(
  agent: DeviceAgent,
): agent is DeviceAgent & NetworkControlCapability {
  const a = agent as Partial<NetworkControlCapability>
  return typeof a.setNetworkOffline === 'function' && typeof a.networkState === 'function'
}
