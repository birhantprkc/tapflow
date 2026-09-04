import Foundation
import Network
import SystemConfiguration
import UIKit

// tapflow's network probe (#690 / the network-parity program).
//
// **It exists because the measurements needed one and the previous probe was never committed.** An
// earlier `TFNetProbe` was built during #607 and survives only as an unsigned binary on one Mac; every
// number in the parity investigation came from it, and none of them could be reproduced by anyone
// else. This is that tool, written down.
//
// **What it is for is telling the offline mechanisms apart.** "The app knows it is offline" is not one
// fact but four, and they fail independently:
//
//   1. `NWPathMonitor`        — layer 2 hooks it. A modern app draws its banner from this.
//   2. `SCNetworkReachability`— layer 2 does NOT hook it yet. Alamofire and Reachability.swift read it.
//   3. `URLSession`           — reads the kernel's real path, so no in-process hook reaches it.
//   4. `getaddrinfo`          — layer 2 hooks it, and refuses names while offline.
//
// Each line below names which of the four it is about, so a run says *which* mechanism moved rather
// than that "the app noticed".
//
// **The reachability half is split into a getter and a listener on purpose, and that split is the
// whole point of the file.** A consumer like Alamofire does not poll: it registers a callback, caches
// what the callback last told it, and recomputes only when the callback fires. So hooking the getter
// alone moves `getter=` and leaves `listener=` where it was — the two disagreeing is exactly the
// symptom of a missing callback re-fire, and them agreeing is the proof that it landed.
//
// Output goes to stdout, which is what `simctl launch --console` reads.

private let queue = DispatchQueue(label: "dev.tapflow.netprobe")
/// **The listeners write from `queue` and the main run loop; `tick()` reads from the timer.** Without
/// this the three reads in one line could come from either side of an update, and a report that
/// straddles a transition is indistinguishable from the disagreement this probe exists to detect.
private let stateLock = NSLock()
private func locked<T>(_ body: () -> T) -> T {
    stateLock.lock(); defer { stateLock.unlock() }
    return body()
}

private func say(_ line: String) {
    let t = DateFormatter()
    t.dateFormat = "HH:mm:ss.SSS"
    print("\(t.string(from: Date())) \(line)")
    // stdout through `--console` is line-buffered against a pipe rather than a tty, so a run that is
    // terminated rather than allowed to exit loses whatever is still in the buffer.
    fflush(stdout)
}

// MARK: - 2. SCNetworkReachability — the getter and the listener, kept apart

private var reachRef: SCNetworkReachability?
/// A **second** target, scheduled on the main run loop rather than a dispatch queue. The two ways of
/// scheduling are hooked separately, so a probe that exercised only one would report a covered API as
/// covered while the other silently did nothing.
private var reachRunLoopRef: SCNetworkReachability?
private var runLoopBelievesReachable: Bool?
private var runLoopFireCount = 0
/// **What a callback-driven consumer believes**, updated only from the callback. Never from the
/// getter — writing it there would paper over the exact gap this probe exists to show.
private var listenerBelievesReachable: Bool?
private var listenerFireCount = 0

/// **Alamofire's reduction, copied rather than approximated.** The probe's whole claim is "this is what
/// that library would compute", so a shortcut here would make the claim false even where the result
/// happens to match. The dial-up-era flags below never appear in a simulator; they are here because
/// the consumer reads them, not because we have seen one.
private func flagsAreReachable(_ f: SCNetworkReachabilityFlags) -> Bool {
    let isReachable = f.contains(.reachable)
    let needsConnection = f.contains(.connectionRequired)
    let canConnectAutomatically = f.contains(.connectionOnDemand) || f.contains(.connectionOnTraffic)
    let canConnectWithoutUserInteraction = canConnectAutomatically && !f.contains(.interventionRequired)
    return isReachable && (!needsConnection || canConnectWithoutUserInteraction)
}

/// A C function pointer, so it captures nothing and reads the globals above.
private func reachabilityChanged(_ target: SCNetworkReachability,
                                 _ flags: SCNetworkReachabilityFlags,
                                 _ info: UnsafeMutableRawPointer?) {
    locked {
        listenerFireCount += 1
        listenerBelievesReachable = flagsAreReachable(flags)
    }
    say("sc listener FIRED #\(listenerFireCount) flags=0x\(String(flags.rawValue, radix: 16)) " +
        "reachable=\(flagsAreReachable(flags))")
}

/// A C function pointer, like the one above, for the run-loop-scheduled target.
private func reachabilityChangedOnRunLoop(_ target: SCNetworkReachability,
                                          _ flags: SCNetworkReachabilityFlags,
                                          _ info: UnsafeMutableRawPointer?) {
    locked {
        runLoopFireCount += 1
        runLoopBelievesReachable = flagsAreReachable(flags)
    }
    say("sc runloop-listener FIRED #\(runLoopFireCount) flags=0x\(String(flags.rawValue, radix: 16)) " +
        "reachable=\(flagsAreReachable(flags))")
}

private func startReachabilityOnRunLoop() {
    guard let ref = SCNetworkReachabilityCreateWithName(nil, "example.org") else {
        say("sc runloop-listener could not be created"); return
    }
    reachRunLoopRef = ref
    var ctx = SCNetworkReachabilityContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
    let set = SCNetworkReachabilitySetCallback(ref, reachabilityChangedOnRunLoop, &ctx)
    let sched = SCNetworkReachabilityScheduleWithRunLoop(ref, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    say("sc runloop-listener registered setCallback=\(set) scheduleWithRunLoop=\(sched)")
    var f = SCNetworkReachabilityFlags()
    if SCNetworkReachabilityGetFlags(ref, &f) { runLoopBelievesReachable = flagsAreReachable(f) }
}

/// **The teardown half, and it is here because nothing else exercises it.**
///
/// `SCNetworkReachabilityUnscheduleFromRunLoop` is hooked, and everything the hook does — dropping the
/// recorded pair, releasing the run loop, clearing an entry that has nothing left — ran under no test
/// and no measurement until this existed. A probe that only ever registers reports the registration
/// path working and says nothing about the half that runs when a screen goes away.
///
/// After this, the run-loop listener must stop firing while the queue listener keeps going. That
/// difference is the assertion; there is no other way to see it from outside.
private func stopReachabilityOnRunLoop() {
    guard let ref = reachRunLoopRef else { return }
    let un = SCNetworkReachabilityUnscheduleFromRunLoop(ref, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    let cleared = SCNetworkReachabilitySetCallback(ref, nil, nil)
    guard un && cleared else {
        // **A partial teardown stays under observation.** Clearing the reference here would make the
        // next tick print "(torn down)" and stop comparing — so a teardown that half-failed would be
        // reported in exactly the same words as one that worked, which is the failure this probe is
        // supposed to expose rather than produce.
        say("sc runloop-listener TEARDOWN INCOMPLETE unschedule=\(un) setCallback(nil)=\(cleared) " +
            "— still watched; it may keep firing")
        return
    }
    reachRunLoopRef = nil
    say("sc runloop-listener TORN DOWN unschedule=\(un) setCallback(nil)=\(cleared) " +
        "— it must not fire again; the queue listener must keep firing")
}

private func startReachability() {
    guard let ref = SCNetworkReachabilityCreateWithName(nil, "example.com") else {
        say("sc listener could not be created"); return
    }
    reachRef = ref
    var ctx = SCNetworkReachabilityContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
    let set = SCNetworkReachabilitySetCallback(ref, reachabilityChanged, &ctx)
    let sched = SCNetworkReachabilitySetDispatchQueue(ref, queue)
    say("sc listener registered setCallback=\(set) setQueue=\(sched)")
    // The first reading is seeded from the getter, which is what every consumer does at start-up
    // (Alamofire's `startListening` calls `flags` immediately). After this, only the callback writes.
    var f = SCNetworkReachabilityFlags()
    if SCNetworkReachabilityGetFlags(ref, &f) { listenerBelievesReachable = flagsAreReachable(f) }
}

private func getterSaysReachable(_ ref: SCNetworkReachability?) -> Bool? {
    guard let ref else { return nil }
    var f = SCNetworkReachabilityFlags()
    guard SCNetworkReachabilityGetFlags(ref, &f) else { return nil }
    return flagsAreReachable(f)
}

// MARK: - 1. NWPathMonitor

private let monitor = NWPathMonitor()
private var lastPathStatus: NWPath.Status?

private func startPathMonitor() {
    monitor.pathUpdateHandler = { path in
        locked { lastPathStatus = path.status }
        say("nwpath handler FIRED status=\(path.status)")
    }
    monitor.start(queue: queue)
}

// MARK: - 4. getaddrinfo

private func resolves(_ host: String) -> String {
    var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
                         ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
    var res: UnsafeMutablePointer<addrinfo>?
    let rc = getaddrinfo(host, "443", &hints, &res)
    if let res { freeaddrinfo(res) }
    return rc == 0 ? "ok" : "ERR(\(rc))"
}

// MARK: - 3. URLSession

private let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 4
    c.timeoutIntervalForResource = 4
    // Every tick must be a NEW connection, or the probe measures a pooled one that the host filter
    // cannot revoke — which is a real behaviour, but a different one from the question here.
    c.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    return URLSession(configuration: c)
}()

private func fetch(_ label: String, _ url: String) {
    session.dataTask(with: URL(string: url)!) { _, response, error in
        if let error = error as NSError? {
            say("urlsession \(label)=ERR code=\(error.code) \(error.localizedDescription)")
        } else if let http = response as? HTTPURLResponse {
            say("urlsession \(label)=\(http.statusCode)")
        }
    }.resume()
}

// MARK: - the tick

private func tick() {
    // **Each listener is compared against its own target's getter.** The two watch different names so
    // that one scheduling path cannot mask the other, and a first version then compared the run-loop
    // listener against the *queue* target's getter — two names can legitimately differ, so an unarmed
    // run could print DISAGREE while both callbacks were working.
    let (listenerCached, listenerFires, rlCached, rlFires) =
        locked { (listenerBelievesReachable, listenerFireCount, runLoopBelievesReachable, runLoopFireCount) }
    let word = { (b: Bool?) in b.map { $0 ? "reachable" : "NOT-reachable" } ?? "unset" }

    let getter = getterSaysReachable(reachRef).map { $0 ? "reachable" : "NOT-reachable" } ?? "unreadable"
    let listener = word(listenerCached)
    let agree = getter == listener ? "" : "   <-- DISAGREE: the callback has not re-fired"
    say("sc getter=\(getter) listener=\(listener) fires=\(listenerFires)\(agree)")

    let torn = reachRunLoopRef == nil
    let rlGetter = getterSaysReachable(reachRunLoopRef).map { $0 ? "reachable" : "NOT-reachable" } ?? "unreadable"
    let rl = word(rlCached)
    let rlAgree = (torn || rlGetter == rl) ? "" : "   <-- DISAGREE: the run-loop callback has not re-fired"
    say("sc runloop-getter=\(torn ? "-" : rlGetter) runloop-listener=\(rl) fires=\(rlFires)\(rlAgree)\(torn ? " (torn down)" : "")")
    say("nwpath status=\(locked { lastPathStatus }.map(String.init(describing:)) ?? "unset")")
    say("getaddrinfo example.com=\(resolves("example.com")) localhost=\(resolves("localhost"))")
    fetch("fresh", "https://example.com/?tf=\(Int(Date().timeIntervalSince1970))")
    fetch("loopback", "http://127.0.0.1:8899/")
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        say("probe up bundle=\(Bundle.main.bundleIdentifier ?? "-") " +
            "udid=\(ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "-") " +
            "target=\(ProcessInfo.processInfo.environment["TAPFLOW_TARGET_BUNDLE"] ?? "-") " +
            "dyld=\(ProcessInfo.processInfo.environment["DYLD_INSERT_LIBRARIES"] ?? "-")")
        startPathMonitor()
        startReachability()
        startReachabilityOnRunLoop()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in tick() }
        // Late enough that a run has already seen the run-loop listener work, early enough that the
        // same run can then watch it stay quiet. `TAPFLOW_PROBE_TEARDOWN_AFTER` overrides it.
        let after = ProcessInfo.processInfo.environment["TAPFLOW_PROBE_TEARDOWN_AFTER"].flatMap(Double.init) ?? 20
        Timer.scheduledTimer(withTimeInterval: after, repeats: false) { _ in stopReachabilityOnRunLoop() }
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
