import Foundation

/**
 * The XPC contract between the container app (client) and the sysext provider (listener).
 *
 * **Read-only, and that is a security decision rather than a scope one.** A mach service is
 * reachable by name from any process on the Mac, and validating the peer against this team's
 * signature — `SecCodeCopyGuestWithAttributes` over the connection's audit token — is not
 * implemented yet. With only a reader vended, what an unvalidated peer can obtain is "which
 * simulators are offline"; with a writer, it would be the network of every simulator on the machine.
 *
 * So the enforcement channel stays exactly one thing: `NEFilterProviderConfiguration.vendorConfiguration`,
 * written by the container app and handed to the provider by the framework. Nothing here changes a
 * rule. A probe build of this file had a `setRule`, and it does not ship.
 *
 * **Why a mach service at all**, when the file the provider writes says much the same: the file is a
 * pulse and answers "was this true a moment ago". A caller that has just written a rule needs "is it
 * true now", and the save returning does not carry that — the framework hands `vendorConfiguration`
 * to the running provider afterwards with nothing coming back. Measured: this round trip is 0.26–0.74 ms.
 *
 * **A reply is not proof the provider is alive on its own**, either: a call made while the provider
 * is dead does not fail, it *blocks* — measured 3/3, to the caller's own deadline, with neither the
 * invalidation nor the interruption handler firing, because launchd holds the mach name. Whoever
 * calls this owns a timeout, and the timeout is the mechanism, not a backstop.
 */
@objc public protocol NetFilterControl {
    /// What the **running** provider is enforcing right now, as JSON:
    /// `{"enforcing":Bool,"rule":[udid],"pid":Int}`.
    ///
    /// `enforcing` exists because `rule: []` is two different states — no device is offline, and the
    /// filter is stopped. Measured on a `--off` provider: it stays alive and answers in 16ms with an
    /// empty rule, indistinguishable from a healthy idle one.
    func ping(withReply reply: @escaping (Data) -> Void)
}

public let netFilterMachServiceName = "6FBS3QP893.dev.tapflow.netfilter.ext"
