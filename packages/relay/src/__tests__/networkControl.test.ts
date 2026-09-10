import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { WebSocket } from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'
import { waitForOpen, waitForType, waitForTypeOrNull } from '@tapflowio/test-utils'

import type {
  AgentRegistered, BrowserInbound, BrowserToRelay, NetworkError, NetworkSet, NetworkState, RelayToAgent,
  SessionJoined,
} from '@tapflowio/protocol'

/** What an agent socket receives: what the relay originates, plus browser commands it forwards
 *  verbatim. Same note as `clipboard.test.ts` — the protocol has no single union for it (#557). */
type AgentSocketInbound = RelayToAgent | BrowserToRelay

describe('network control relay routing (#607)', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-network-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(async () => {
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => { await server.stop() })

  async function setup(capabilities: string[] = ['network-control']) {
    const agent = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(agent)
    agent.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'net-1', capabilities,
      devices: [{ id: 'dev-1', name: 'iPhone', platform: 'ios', status: 'booted' }],
    }))
    const reply = await waitForType<AgentRegistered>(agent, 'agent:registered')
    const sessionId = reply.registeredSessions[0]!.sessionId

    const browser = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(browser)
    browser.send(JSON.stringify({ type: 'session:start', sessionId }))
    await waitForType(browser, 'session:joined')
    return { agent, browser, sessionId }
  }

  const setMsg = (sessionId: string, requestId: string, offline: boolean): NetworkSet =>
    ({ type: 'network:set', sessionId, requestId, payload: { offline } })

  it('forwards network:set to the agent with its correlator intact', async () => {
    const { agent, browser, sessionId } = await setup()
    browser.send(JSON.stringify(setMsg(sessionId, 'rq-1', true)))

    const got = await waitForType<AgentSocketInbound & NetworkSet>(agent, 'network:set')
    expect(got.requestId).toBe('rq-1')
    expect(got.payload).toEqual({ offline: true })

    agent.close(); browser.close()
  })

  it('routes network:state back to the browser, echoing the requestId', async () => {
    const { agent, browser, sessionId } = await setup()
    browser.send(JSON.stringify(setMsg(sessionId, 'rq-2', true)))
    await waitForType(agent, 'network:set')

    agent.send(JSON.stringify({
      type: 'network:state', sessionId, requestId: 'rq-2',
      payload: { offline: true, available: true },
    }))
    const state = await waitForType<NetworkState>(browser, 'network:state')
    // `waitForType` matches on `type` alone, so without this the address is unasserted — and
    // `DeviceViewer` drops any frame whose `sessionId` is not its own, which turns a wrong address
    // into a control that sits armed forever with nothing on screen to say why.
    expect(state.sessionId).toBe(sessionId)
    expect(state.requestId).toBe('rq-2')
    expect(state.payload).toEqual({ offline: true, available: true })

    agent.close(); browser.close()
  })

  // The unsolicited half. `requestId` absent means "not the answer to a request", and the relay
  // must forward it rather than treating a missing correlator as a malformed frame.
  it('routes an unsolicited network:state, with no correlator at all', async () => {
    const { agent, browser, sessionId } = await setup()
    agent.send(JSON.stringify({
      type: 'network:state', sessionId,
      payload: { offline: false, available: false, reason: 'hooks-not-installed' },
    }))
    const state = await waitForType<NetworkState>(browser, 'network:state')
    expect(state.sessionId).toBe(sessionId)
    expect(state.requestId).toBeUndefined()
    // The payload is a union, so `reason` is only reachable after narrowing — which is the shape
    // every consumer will use, and the reason an unavailable frame cannot arrive without one.
    if (state.payload.available) throw new Error('expected an unavailable state')
    expect(state.payload.reason).toBe('hooks-not-installed')

    agent.close(); browser.close()
  })

  // Taking a device off the network is the most disruptive thing a non-holder could do to someone
  // else's session short of shutting it down — and unlike a shutdown it leaves the device looking
  // fine, so the tester has no reason to suspect anyone else.
  it('refuses a network:set from a client that does not hold the session', async () => {
    const { agent, browser, sessionId } = await setup()

    const intruder = new WebSocket(`ws://localhost:${port}?client=someone-else`)
    await waitForOpen(intruder)
    intruder.send(JSON.stringify(setMsg(sessionId, 'rq-3', true)))

    const err = await waitForType<NetworkError>(intruder, 'network:error')
    expect(err.sessionId).toBe(sessionId)
    expect(err.requestId).toBe('rq-3')
    // `message` carries the diagnosis `dispatchTarget` picked — stale session id, dead Mac, or in
    // use by someone else. An empty one ships a toast that says nothing.
    expect(err.message.length).toBeGreaterThan(0)
    // And the agent never saw it — refused at the door, not after delivery.
    expect(await waitForTypeOrNull(agent, 'network:set', 300)).toBeNull()

    agent.close(); browser.close(); intruder.close()
  })

  // The mirror of the test above, on the direction the gate in `RelayServer` actually buys. Without
  // it, moving these two labels into the ungated forward block two lines up leaves **every** relay
  // test green and the static routing guard green with them — that guard reads `case` labels and
  // cannot see which block they sit in. A second agent could then tell a stranger's viewer their
  // device is offline, or that it is fine when it is not.
  it('another agent cannot push network:state into someone else\'s session', async () => {
    const { agent, browser, sessionId } = await setup()

    const rogue = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(rogue)
    rogue.send(JSON.stringify({
      type: 'agent:register', platform: 'ios', agentName: 'net-2',
      devices: [{ id: 'rogue-1', name: 'Rogue', platform: 'ios', status: 'booted' }],
    }))
    await waitForType(rogue, 'agent:registered')

    const got: BrowserInbound[] = []
    browser.on('message', (d) => got.push(JSON.parse(d.toString()) as BrowserInbound))

    rogue.send(JSON.stringify({
      type: 'network:state', sessionId, payload: { offline: true, available: true },
    }))
    rogue.send(JSON.stringify({
      type: 'network:error', sessionId, requestId: 'spoof', message: 'ATTACKER',
    }))
    await new Promise((r) => setTimeout(r, 200))
    expect(got.filter((m) => m.type === 'network:state' || m.type === 'network:error')).toEqual([])

    // Paired with a positive, so this cannot pass by the forward being broken for everyone.
    agent.send(JSON.stringify({
      type: 'network:state', sessionId, payload: { offline: false, available: true },
    }))
    const mine = await waitForType<NetworkState>(browser, 'network:state')
    expect(mine.payload.offline).toBe(false)

    agent.close(); browser.close(); rogue.close()
  })

  // The refusal has to arrive in the shape this request's own waiter reads. An `input:error` here
  // would be a non-answer the caller waits out — the defect `refuseMalformed` exists to prevent.
  it('answers a malformed network:set with network:error, not silence', async () => {
    const { agent, browser, sessionId } = await setup()
    browser.send(JSON.stringify({
      type: 'network:set', sessionId, requestId: 'rq-4', payload: {},   // `offline` missing
    }))

    const err = await waitForType<NetworkError>(browser, 'network:error')
    expect(err.sessionId).toBe(sessionId)
    expect(err.requestId).toBe('rq-4')
    expect(err.message.length).toBeGreaterThan(0)
    expect(await waitForTypeOrNull(agent, 'network:set', 300)).toBeNull()

    agent.close(); browser.close()
  })

  // `network-control` says the agent has the code; it does not say the toggle will work. The relay
  // has no business judging that, and an agent that answers `available: false` is answering, not
  // failing — so this must route like any other reply.
  it('routes an available:false answer through unchanged', async () => {
    const { agent, browser, sessionId } = await setup()
    browser.send(JSON.stringify(setMsg(sessionId, 'rq-5', true)))
    await waitForType(agent, 'network:set')

    agent.send(JSON.stringify({
      type: 'network:state', sessionId, requestId: 'rq-5',
      payload: { offline: false, available: false, reason: 'not-armed' },
    }))
    const state = await waitForType<NetworkState>(browser, 'network:state')
    expect(state.payload).toEqual({ offline: false, available: false, reason: 'not-armed' })

    agent.close(); browser.close()
  })

  // The combination the wire has to be able to carry: still offline, no longer steerable. If a
  // producer used `offline` as a placeholder for "the request did not land" this frame could not be
  // expressed, and the viewer would show "online" over a device whose app reaches nothing.
  it('carries offline:true together with available:false', async () => {
    const { agent, browser, sessionId } = await setup()
    agent.send(JSON.stringify({
      type: 'network:state', sessionId,
      payload: { offline: true, available: false, reason: 'not-armed' },
    }))
    const state = await waitForType<NetworkState>(browser, 'network:state')
    expect(state.payload).toEqual({ offline: true, available: false, reason: 'not-armed' })

    agent.close(); browser.close()
  })

  // The capability rides the join so the viewer knows whether to render the control at all, the
  // same hop `clipboard` and `full-reset` use. What it does **not** tell the viewer is whether the
  // toggle will work — that is `network:state.available`, and the two answer different questions.
  it('echoes network-control on session:joined, alongside the others', async () => {
    const { agent, browser, sessionId } = await setup(['clipboard', 'network-control'])
    browser.close()

    const b2 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(b2)
    b2.send(JSON.stringify({ type: 'session:start', sessionId }))
    const joined = await waitForType<SessionJoined>(b2, 'session:joined')
    expect(joined.capabilities).toEqual(['clipboard', 'network-control'])

    agent.close(); b2.close()
  })

  // An agent that has no network code says so by omission, and the relay does not invent one.
  it('does not invent the capability for an agent that never claimed it', async () => {
    const { agent, browser, sessionId } = await setup(['clipboard'])
    browser.close()

    const b2 = new WebSocket(`ws://localhost:${port}`)
    await waitForOpen(b2)
    b2.send(JSON.stringify({ type: 'session:start', sessionId }))
    const joined = await waitForType<SessionJoined>(b2, 'session:joined')
    expect(joined.capabilities).not.toContain('network-control')
    // Paired with a positive so this cannot pass by the list being empty.
    expect(joined.capabilities).toContain('clipboard')

    agent.close(); b2.close()
  })
})
