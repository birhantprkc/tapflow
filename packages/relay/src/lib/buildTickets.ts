import crypto from 'crypto'

/**
 * Single-use, short-lived credentials that let an agent download one build over HTTP.
 *
 * **Why a ticket rather than a scope on the agent's PAT.** The relay used to hand the agent its own
 * filesystem path and let it open the file, which works only when the two share a disk. Opening
 * `/uploads/` to the `agent` scope would have given every agent token the whole upload directory,
 * and a `builds/:id` route reachable with that scope gives it the whole builds table one row at a
 * time — the id is chosen by whoever calls. A ticket is minted where session ownership has *already*
 * been checked, so the permission is the one build that request is about.
 *
 * It also removes an authentication problem rather than adding one: `tapflow start` runs an agent on
 * loopback with **no token at all** (the relay accepts loopback agents unauthenticated), so any
 * design that required a PAT would have broken every all-in-one install.
 *
 * **What is actually enforced**, stated exactly because the previous draft claimed more: 32 bytes of
 * entropy, one use, one build, and `TICKET_TTL_MS`. There is no binding to a particular agent — the
 * relay does not record the agent socket's address, so it cannot check one at HTTP time, and a field
 * that looks like a check but is not is worse than its absence.
 */
export interface BuildTicket {
  buildId: number
  filePath: string
  /** From `statSync` at mint time. The agent compares against this, not `Content-Length`. */
  bytes: number
  expiresAt: number
}

/**
 * Longer than every caller's deadline, so a ticket never expires under a request that is still
 * being awaited: `flow-runner` allows 120s (`RelayClient.ts`), `mcp-server` 120s after this change.
 * A download that outlives this was already going to fail its caller first.
 */
export const TICKET_TTL_MS = 180_000

/** Exported for the sweep test, which asserts the store fills before asserting it empties. */
export class BuildTicketStore {
  private readonly tickets = new Map<string, BuildTicket>()

  /** Test-only view. Asserting a sweep emptied the map means nothing without asserting it filled. */
  get size(): number { return this.tickets.size }

  mint(buildId: number, filePath: string, bytes: number, now = Date.now()): string {
    this.sweep(now)
    const ticket = crypto.randomBytes(32).toString('hex')
    this.tickets.set(ticket, { buildId, filePath, bytes, expiresAt: now + TICKET_TTL_MS })
    return ticket
  }

  /**
   * Resolves and **consumes** a ticket. Distinguishes "never existed / already used" from "expired"
   * so the agent can say which — a download that fails has three causes a user acts on differently,
   * and collapsing them is the defect this whole change exists to stop repeating.
   */
  redeem(ticket: string, now = Date.now()): BuildTicket | 'unknown' | 'expired' {
    const found = this.tickets.get(ticket)
    if (!found) return 'unknown'
    this.tickets.delete(ticket)
    return found.expiresAt <= now ? 'expired' : found
  }

  /**
   * Drops what nobody redeemed. Without it the map grows for the life of the process: a session
   * owner who presses install repeatedly mints a ticket each time and only the used ones are
   * removed.
   */
  sweep(now = Date.now()): void {
    for (const [ticket, rec] of this.tickets) {
      if (rec.expiresAt <= now) this.tickets.delete(ticket)
    }
  }
}
