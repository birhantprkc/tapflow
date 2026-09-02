import Foundation
import NetworkExtension
import os.log

/**
 * The box the listener answers from — **the running provider, held weakly, read on demand.**
 *
 * Weak and boxed rather than captured: the listener is vended once for the life of the process and a
 * filter can be stopped and started again inside it, so a listener holding a `Provider` would answer
 * for one that has been replaced. `startFilter` fills this after `apply` succeeds and `stopFilter`
 * empties it, which makes "is anything enforcing" a property of the box rather than a flag anyone has
 * to remember to clear.
 *
 * **The configuration is read at answer time, never cached.** A snapshot taken when the box was
 * filled would be up to one pulse old, and reporting a stale rule as the current one is the failure
 * this channel was added to remove.
 */
final class ProviderBox {
    static let shared = ProviderBox()

    private let lock = NSLock()
    private weak var provider: NEFilterDataProvider?

    func set(_ p: NEFilterDataProvider?) {
        lock.lock(); provider = p; lock.unlock()
    }

    /// `enforcing` is "the box is not empty". Nothing else can say it: a stopped provider is still a
    /// live process answering XPC, and its rule is empty for the same reason an idle one's is.
    func snapshot() -> (enforcing: Bool, rule: [String]) {
        lock.lock(); let p = provider; lock.unlock()
        guard let p else { return (false, []) }
        return (true, offlineUDIDs(p.filterConfiguration).sorted())
    }
}

/// Vends the mach service and answers `ping`. Started once from `main.swift`, so the service exists
/// for as long as the process does — independent of whether a filter is currently running, which is
/// exactly the question callers need answered.
final class IPCListener: NSObject, NSXPCListenerDelegate, NetFilterControl {
    static let shared = IPCListener()

    private let log = OSLog(subsystem: "dev.tapflow.netfilter", category: "xpc")
    private let listener = NSXPCListener(machServiceName: netFilterMachServiceName)

    override private init() {
        super.init()
        listener.delegate = self
    }

    func start() {
        listener.resume()
        // **`resume()` reports nothing, so this line used to be a claim rather than an observation** —
        // and on 2026-09-03 it was measured making a false one. XPC logged
        // `listener failed to activate: xpc_error=[1: Operation not permitted]` and
        // `invalidated after a failed init`, and one millisecond later this said "resumed". The only
        // trace of the truth was in Apple's subsystem; ours said the opposite.
        //
        // It fails for a reason that arrives with every release: a replaced system extension leaves
        // the retired one `[terminated waiting to uninstall on reboot]`, still owning this mach name,
        // so the new provider cannot claim it. `--confirm` then answers `no listener` while the filter
        // is enforcing normally. The listener is vended once per process and the provider survives
        // `--off`/`--install` on the same pid, so nothing retries: it is gone until this process is.
        probeListener()
    }

    /**
     * Ask the name whether *this* process is behind it.
     *
     * **Reaching the service is not the question, and answering only that would be the same mistake
     * one flavour milder.** The name may be held by the extension being retired, which is alive
     * enough to reply — so a probe that merely connected would log a green earned by the provider the
     * kernel is no longer consulting. The reply already carries `pid`; compare it.
     */
    private func probeListener() {
        let mine = ProcessInfo.processInfo.processIdentifier
        let conn = NSXPCConnection(machServiceName: netFilterMachServiceName, options: [])
        conn.remoteObjectInterface = NSXPCInterface(with: NetFilterControl.self)

        // Every outcome below is terminal and several can race — an error handler and the deadline,
        // for instance — so the first one to arrive is the one reported.
        let lock = NSLock()
        var reported = false
        let settle: (String, OSLogType) -> Void = { [log] message, type in
            lock.lock()
            let first = !reported
            reported = true
            lock.unlock()
            guard first else { return }
            os_log("%{public}@", log: log, type: type, message)
            conn.invalidate()
        }

        let name = netFilterMachServiceName
        conn.invalidationHandler = { settle("xpc listener UNREACHABLE on \(name) — no listener answered", .error) }
        conn.interruptionHandler = { settle("xpc listener probe interrupted on \(name)", .error) }
        conn.resume()

        let proxy = conn.remoteObjectProxyWithErrorHandler { err in
            settle("xpc listener UNREACHABLE on \(name): \(err.localizedDescription)", .error)
        } as? NetFilterControl
        guard let proxy else {
            settle("xpc listener UNREACHABLE on \(name) — no proxy", .error)
            return
        }
        proxy.ping { data in
            let answered = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])??["pid"] as? Int
            if answered == Int(mine) {
                settle("xpc listener reachable on \(name), answering from this provider (pid \(mine))", .default)
            } else {
                settle("xpc listener on \(name) answered from pid \(answered.map(String.init) ?? "?"), "
                       + "NOT this provider (pid \(mine)) — a retired extension still owns the name, "
                       + "so --confirm reports someone else's rule", .error)
            }
        }

        // The handlers above do not all fire. A name held by launchd for a process that is away
        // neither invalidates nor errors — it blocks, which is the same measurement `--confirm`'s
        // deadline exists for. Without this, that case logs nothing at all.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 5) {
            settle("xpc listener probe got no reply within 5s on \(name)", .error)
        }
    }

    // MARK: - NSXPCListenerDelegate

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection conn: NSXPCConnection) -> Bool {
        // **The peer is not authenticated, and the interface is read-only because of it** — see
        // `NetFilterControl`. Pinning the connection's audit token to this team's signature is its own
        // change; until it lands, the exposure this accepts is a read of which simulators are offline.
        os_log("xpc connection from pid %{public}d", log: log, type: .info, conn.processIdentifier)
        conn.exportedInterface = NSXPCInterface(with: NetFilterControl.self)
        conn.exportedObject = self
        conn.resume()
        return true
    }

    // MARK: - NetFilterControl

    func ping(withReply reply: @escaping (Data) -> Void) {
        let (enforcing, rule) = ProviderBox.shared.snapshot()
        let body: [String: Any] = [
            "enforcing": enforcing,
            "rule": rule,
            "pid": ProcessInfo.processInfo.processIdentifier,
        ]
        reply((try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8))
    }
}
