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
 * Whether a flow must be allowed even when its simulator is in the offline set.
 *
 * **Exactly one thing passes, and the reason is that blocking it produces a worse lie than letting it
 * through.** A dropped UDP flow gives its sender nothing — no error, no reset — so a resolver whose
 * query is dropped waits out its own timeout. Measured on an offline simulator: a name already in the
 * cache failed its connection in 6ms, while a name that had to be resolved took **25 seconds** in
 * `curl` and left Safari on a white screen past 35. A tester reads that as the toggle not working.
 *
 * Allowing resolution turns every case into the first one: the name resolves, and the connection that
 * follows is dropped at 6ms with the app none the wiser about which step failed.
 *
 * **It is not the fidelity loss it looks like.** A real device with no signal fails resolution too —
 * but layer 2 already refuses `getaddrinfo` inside the app under test, so the app tapflow exists to
 * test still sees name resolution fail. What changes is the traffic of processes layer 2 cannot reach
 * (WebKit, and every other app in the simulator), which today hang instead of failing.
 *
 * **Encrypted DNS is not covered and that is not an oversight.** DNS-over-TLS has a port of its own
 * (853) and could be added here; DNS-over-HTTPS shares 443 with everything else and could not. Neither
 * is here because nothing has measured whether a simulator whose host is configured for either
 * actually uses it — and widening the hole on a guess is what this comment exists to avoid.
 */
func passesRegardlessOfRule(remotePort: Int?) -> Bool {
    remotePort == dnsPort
}
