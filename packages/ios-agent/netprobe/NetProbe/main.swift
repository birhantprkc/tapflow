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
/// **What a callback-driven consumer believes**, updated only from the callback. Never from the
/// getter — writing it there would paper over the exact gap this probe exists to show.
private var listenerBelievesReachable: Bool?
private var listenerFireCount = 0

private func flagsAreReachable(_ f: SCNetworkReachabilityFlags) -> Bool {
    // The same reduction Alamofire makes: reachable, and not merely reachable-if-a-connection-is-made.
    f.contains(.reachable) && !f.contains(.connectionRequired)
}

/// A C function pointer, so it captures nothing and reads the globals above.
private func reachabilityChanged(_ target: SCNetworkReachability,
                                 _ flags: SCNetworkReachabilityFlags,
                                 _ info: UnsafeMutableRawPointer?) {
    listenerFireCount += 1
    listenerBelievesReachable = flagsAreReachable(flags)
    say("sc listener FIRED #\(listenerFireCount) flags=0x\(String(flags.rawValue, radix: 16)) " +
        "reachable=\(flagsAreReachable(flags))")
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

private func reachabilityGetterSaysReachable() -> Bool? {
    guard let ref = reachRef else { return nil }
    var f = SCNetworkReachabilityFlags()
    guard SCNetworkReachabilityGetFlags(ref, &f) else { return nil }
    return flagsAreReachable(f)
}

// MARK: - 1. NWPathMonitor

private let monitor = NWPathMonitor()
private var lastPathStatus: NWPath.Status?

private func startPathMonitor() {
    monitor.pathUpdateHandler = { path in
        lastPathStatus = path.status
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
    let getter = reachabilityGetterSaysReachable().map { $0 ? "reachable" : "NOT-reachable" } ?? "unreadable"
    let listener = listenerBelievesReachable.map { $0 ? "reachable" : "NOT-reachable" } ?? "unset"
    let agree = getter == listener ? "" : "   <-- DISAGREE: the callback has not re-fired"
    say("sc getter=\(getter) listener=\(listener) fires=\(listenerFireCount)\(agree)")
    say("nwpath status=\(lastPathStatus.map(String.init(describing:)) ?? "unset")")
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
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in tick() }
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
