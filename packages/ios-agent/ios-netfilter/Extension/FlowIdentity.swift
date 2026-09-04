import Foundation

// The pure half of flow handling, kept in its own file **so it can be tested** (#690).
//
// Everything else on the attribution path reads the live kernel — `sysctl(KERN_PROC)` for the parent
// walk, `KERN_PROCARGS2` for the arguments, `proc_pidpath` for the executable — and none of that can
// be stood up in a unit test. What is left once those are peeled away is this: a string arrived, and a
// device identifier has to come out of it. That part is decidable from its inputs alone, so it is the
// part a test can hold.
//
// It is `internal` rather than `private` for the same reason: the test bundle compiles this file
// directly (`tests.yml`), and a `private` function would not be visible to it.

/// The simulator a `launchd_sim` argument string belongs to, or `nil`.
///
/// The argument string looks like this, with the NULs between arguments already replaced by spaces
/// (`procArgs`):
///
/// ```text
/// launchd_sim /Users/<u>/Library/Developer/CoreSimulator/Devices/<UDID>/data/var/run/launchd_bootstrap.plist
/// ```
///
/// **The UDID appears in exactly one observable place — these arguments.** It is not in the executable
/// path (every simulator on a runtime shares one `launchd_sim` binary in the simruntime) and not in the
/// working directory (measured: `/`). `Provider.swift` has the rest of that reasoning.
///
/// The 36-character length check is what separates a real identifier from a `/Devices/` that happens to
/// appear elsewhere in the arguments. **It is a length check and not a UUID check**, which is a floor
/// rather than a fence: 36 characters of anything but `/` passes. That is deliberate for now — a
/// stricter parse would have to be sure it agrees with CoreSimulator about what a device identifier may
/// look like, and being wrong there drops attribution for a real device, which fails *open* and lets a
/// simulator the tester took offline keep talking. A test pins the current behaviour so that tightening
/// it later is a visible decision rather than a silent one.
func extractUDID(from text: String) -> String? {
    guard let marker = text.range(of: "/Devices/") else { return nil }
    let udid = text[marker.upperBound...].prefix { $0 != "/" }
    return udid.count == 36 ? String(udid) : nil
}


// MARK: - what passes whatever the rule says

/// The port name resolution uses. Plain DNS only — see `passesRegardlessOfRule`.
let dnsPort = 53

/**
 * A port from an endpoint, or `nil` when there is not one.
 *
 * **`0` is not a port and must not read as one.** The two endpoint properties disagree about it: one
 * of them reports an unconnected flow as port `0` while the other reports nothing at all, so without
 * this the log records a different channel for the same condition — and that log is what is supposed
 * to make "the OS emptied a channel" visible rather than silent. Normalising here is what keeps the
 * two answers comparable.
 */
func normalisedPort(_ raw: Int?) -> Int? {
    guard let raw, raw > 0, raw <= 65535 else { return nil }
    return raw
}

/**
 * Which of the two endpoint channels yielded a port, and what it was.
 *
 * **The choosing is here and the reading is not**, which is the whole reason this function exists.
 * `NEFilterSocketFlow` cannot be built in a unit test, so the downcast and the two property reads stay
 * in `Provider.swift` where nothing can cover them — but everything decided *from* those values is
 * decidable from the values alone, and that is the part with a test.
 *
 * **Order is load-bearing and so is the normalisation on both branches.** `remoteEndpoint` is
 * deprecated and `remoteFlowEndpoint` replaces it, so the deprecated one is asked first while it still
 * answers; and one of them reports an unconnected flow as `0` while the other omits it, so without
 * normalising both the same condition reads as two different channels — which defeats the one thing
 * the channel name in the log is for.
 */
func portFromChannels(hostEndpointPort: String?, flowEndpointPort: UInt16?) -> (port: Int?, how: String) {
    if let s = hostEndpointPort, let p = normalisedPort(Int(s)) { return (p, "remoteEndpoint") }
    if let f = flowEndpointPort, let p = normalisedPort(Int(f)) { return (p, "remoteFlowEndpoint") }
    return (nil, "unreadable")
}

/**
 * Whether a flow must be allowed even when its simulator is in the offline set.
 *
 * **Outbound UDP to port 53, and nothing else. Each of the three conditions is the reason, not a
 * belt-and-braces check.**
 *
 * A dropped UDP flow gives its sender nothing — no error, no reset — so a resolver whose query is
 * dropped waits out its own timeout. Measured on an offline simulator: a name already in the cache
 * failed its connection in 6ms, while a name that had to be resolved took **25 seconds** in `curl`
 * and left Safari on a white screen past 35. A tester reads that as the toggle not working. Allowing
 * resolution turns every case into the first one: the name resolves, and the connection that follows
 * is dropped at 6ms.
 *
 * **TCP is excluded because it never had the problem.** A dropped TCP flow fails in 6ms, measured —
 * so opening TCP/53 would buy nothing and would leave a simulator reported offline holding a
 * bidirectional connection to anything listening on 53, which is the shape a DNS tunnel takes.
 *
 * **Inbound is excluded because `remotePort` means the other end.** For an inbound flow that is the
 * *sender's* port, so a peer sending from source port 53 would otherwise reach a device the tester
 * was told is offline.
 *
 * **It is not the fidelity loss it looks like, but it is more than nothing** — see the note in
 * `AGENTS.md`. The app under test keeps failing name resolution only where it uses POSIX
 * `getaddrinfo`; `URLSession` resolves through Network.framework, which layer 2 does not reach, so
 * that path now resolves and fails at connect instead.
 *
 * **Encrypted DNS is not covered.** DNS-over-TLS has a port of its own (853) and could be added;
 * DNS-over-HTTPS shares 443 and could not. Neither is here because nothing has measured whether a
 * simulator whose host is configured for either actually uses it.
 */
func passesRegardlessOfRule(remotePort: Int?, isUDP: Bool, isOutbound: Bool) -> Bool {
    isOutbound && isUDP && remotePort == dnsPort
}
