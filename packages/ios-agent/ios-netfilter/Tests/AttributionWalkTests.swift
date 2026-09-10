import XCTest

/// The parent walk — the last part of the filter's Swift that had no test (#690).
///
/// **This is the function that decides whose traffic a flow is.** Get it wrong in one direction and a
/// simulator the tester took offline keeps talking while the log calls it the Mac's own; get it wrong
/// in the other and the user's browser is cut. The kernel reads it climbs through cannot be stood up,
/// so they arrive as a `ProcessReader` and these tests supply the tree.
///
/// Every `.unresolved` assertion here was verified by the mutation that turns it into something else
/// — see `run-tests.sh --mutate`. A case asserting that a flow is *not* attributed passes when nothing
/// is attributed, which is its definition.
///
/// That includes the bound. Removing it makes the cycle case loop rather than fail, which is why the
/// runner enables XCTest's own execution-time allowance: a hang becomes a reported timeout, the run
/// continues, and the mutation is killed by an assertion with a name on it.
final class AttributionWalkTests: XCTestCase {

    private let udid = "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3"
    private let simArgs = "/…/launchd_sim /Users/u/Library/Developer/CoreSimulator/Devices/" +
                          "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3/data/var/run/launchd_bootstrap.plist "

    /// A tree as `(pid: (ppid, path, args))`, plus counters for what the walk actually read.
    private struct Tree {
        /// Folded into the identity's start time, so the same pid can be two different boots — which
        /// is the whole reason `ProcIdentity` carries one.
        var boot: Int64 = 1
        var parents: [pid_t: pid_t] = [:]
        var paths: [pid_t: String] = [:]
        var args: [pid_t: String] = [:]
        var missingParent: Set<pid_t> = []
        var pathReads = 0
        var argReads = 0
    }

    private func reader(_ tree: Tree) -> (ProcessReader, () -> Tree) {
        var t = tree
        let r = ProcessReader(
            parent: { pid in
                if t.missingParent.contains(pid) { return nil }
                guard let ppid = t.parents[pid] else { return nil }
                // The start time is what makes a pid an identity; derived from the pid so two
                // different pids are two different devices without the test spelling it out.
                return (ppid, ProcIdentity(pid: pid, startSec: Int64(pid) * 1000 + t.boot, startUsec: 0))
            },
            executablePath: { pid in t.pathReads += 1; return t.paths[pid] },
            arguments: { pid in t.argReads += 1; return t.args[pid] })
        return (r, { t })
    }

    // MARK: - where the climb stops, and what the stop means

    /// The Mac's own traffic. Allowed outright downstream, which also ends filtering for that flow.
    func testATopLevelProcessThatIsNotLaunchdSimIsTheMacsOwn() {
        var tree = Tree()
        tree.parents = [900: 1]
        tree.paths = [900: "/Applications/Safari.app/Contents/MacOS/Safari"]
        let (r, _) = reader(tree)
        XCTAssertEqual(attributeWalk(900, reading: r, cache: UDIDCache()), .host)
    }

    /// **`ppid <= 1`, not `ppid == 1`.** A process reparented to the kernel reports 0, and treating
    /// that as "keep climbing" would walk to the limit and report the flow unresolved.
    func testAParentOfZeroIsAlsoTheTop() {
        var tree = Tree()
        tree.parents = [900: 0]
        tree.paths = [900: "/usr/libexec/somethingd"]
        let (r, _) = reader(tree)
        XCTAssertEqual(attributeWalk(900, reading: r, cache: UDIDCache()), .host)
    }

    func testItClimbsToTheTopRatherThanJudgingTheFlowsOwnProcess() {
        var tree = Tree()
        tree.parents = [10: 20, 20: 30, 30: 1]
        tree.paths = [30: "/…/launchd_sim"]
        tree.args = [30: simArgs]
        let (r, counts) = reader(tree)
        XCTAssertEqual(attributeWalk(10, reading: r, cache: UDIDCache()), .simulator(udid))
        // **The executable is read once, at the top.** `proc_pidpath` is a kernel call and the climb
        // has no use for it below the stop; reading at every level would put one per ancestor on the
        // flow path. The closures in `ProcessReader` are what make that visible — nothing else here
        // could tell a read that happened from one that did not.
        XCTAssertEqual(counts().pathReads, 1, "the path was read at more levels than the one that stops")
    }

    /// **The identity the walk hands the cache, which is a different question from what the cache
    /// does with it.** macOS reuses pids and `launchd_sim`'s is reused readily — one per simulator
    /// boot. Keyed on the number alone, the walk answers for a simulator that no longer exists, and
    /// the consequence is not a stale label: it is a device nobody asked to cut, with every log line
    /// agreeing that the udid was right.
    ///
    /// `UDIDCache` has its own mutation for the dictionary's key type. This is the other half — what
    /// the caller passes in — and nothing held it before.
    func testTheSamePIDFromANewBootIsNotACacheHit() {
        var first = Tree()
        first.parents = [900: 1]
        first.paths = [900: "/…/launchd_sim"]
        first.args = [900: simArgs]
        let cache = UDIDCache()
        let (r1, c1) = reader(first)
        XCTAssertEqual(attributeWalk(900, reading: r1, cache: cache), .simulator(udid))
        XCTAssertEqual(c1().argReads, 1)

        // Same pid, a later boot. The arguments have to be read again, because this is not the
        // process the first answer was about.
        var second = first
        second.boot = 2
        let (r2, c2) = reader(second)
        XCTAssertEqual(attributeWalk(900, reading: r2, cache: cache), .simulator(udid))
        XCTAssertEqual(c2().argReads, 1, "the new boot was answered from the old boot's entry")
    }

    // MARK: - the simulator case

    func testALaunchdSimAtTheTopNamesItsDevice() {
        var tree = Tree()
        tree.parents = [900: 1]
        tree.paths = [900: "/…/RuntimeRoot/usr/libexec/launchd_sim"]
        tree.args = [900: simArgs]
        let (r, _) = reader(tree)
        XCTAssertEqual(attributeWalk(900, reading: r, cache: UDIDCache()), .simulator(udid))
    }

    /// **An unreadable path falls through on purpose, and this pins that.** The udid in the arguments
    /// is the stronger check; refusing here would report a simulator's traffic as the Mac's, which is
    /// the one direction that lets a device the tester took offline keep talking.
    func testAnUnreadablePathStillReachesTheArguments() {
        var tree = Tree()
        tree.parents = [900: 1]
        tree.args = [900: simArgs]   // no path entry at all
        let (r, _) = reader(tree)
        XCTAssertEqual(attributeWalk(900, reading: r, cache: UDIDCache()), .simulator(udid))
    }

    /// **The cache is what keeps the per-flow cost at the climb.** `KERN_PROCARGS2` is the expensive
    /// read, and `launchd_sim` outlives every flow of its simulator — so a hit must skip it entirely
    /// rather than read and discard.
    func testASecondFlowFromTheSameBootDoesNotReadTheArgumentsAgain() {
        var tree = Tree()
        tree.parents = [900: 1]
        tree.paths = [900: "/…/launchd_sim"]
        tree.args = [900: simArgs]
        let (r, counts) = reader(tree)
        let cache = UDIDCache()

        XCTAssertEqual(attributeWalk(900, reading: r, cache: cache), .simulator(udid))
        XCTAssertEqual(counts().argReads, 1)
        XCTAssertEqual(attributeWalk(900, reading: r, cache: cache), .simulator(udid))
        XCTAssertEqual(counts().argReads, 1, "the second walk read the arguments again")
    }

    // MARK: - the three ways it gives up, which are not the same as `.host`

    /// **A failed read is not a host flow, and it used to be logged as one** (#642). It is still
    /// allowed downstream — failing closed on a transient `sysctl` error would cut the user's own
    /// browser — but it is counted apart, because a hole nobody can see is the one that stays open.
    func testAFailedParentReadIsUnresolvedRatherThanHost() {
        var tree = Tree()
        tree.parents = [900: 1]
        tree.missingParent = [900]
        let (r, _) = reader(tree)
        XCTAssertEqual(attributeWalk(900, reading: r, cache: UDIDCache()),
                       .unresolved("sysctl failed at pid 900"))
    }

    /// The failure names the pid it happened at, which is what makes a log line worth reading. Pinned
    /// because the walk climbs — the pid that failed is rarely the one the flow arrived on.
    func testTheFailureNamesTheProcessItStoppedAt() {
        var tree = Tree()
        tree.parents = [10: 20, 20: 30]
        tree.missingParent = [30]
        let (r, _) = reader(tree)
        XCTAssertEqual(attributeWalk(10, reading: r, cache: UDIDCache()),
                       .unresolved("sysctl failed at pid 30"))
    }

    func testALaunchdSimWithNoDeviceInItsArgumentsIsUnresolved() {
        var tree = Tree()
        tree.parents = [900: 1]
        tree.paths = [900: "/…/launchd_sim"]
        tree.args = [900: "/…/launchd_sim --something-else"]
        let (r, _) = reader(tree)
        XCTAssertEqual(attributeWalk(900, reading: r, cache: UDIDCache()),
                       .unresolved("no UDID in the arguments of pid 900"))
    }

    /// **A cycle the kernel should not produce and this code cannot rule out.** Without the bound it
    /// is an infinite loop on the flow path, which takes the whole provider with it — so the limit is
    /// about surviving a kernel that surprises us, not about how deep trees get.
    func testAChainThatNeverReachesTheTopGivesUpRatherThanLooping() {
        var tree = Tree()
        tree.parents = [10: 20, 20: 10]   // a cycle
        let (r, _) = reader(tree)
        XCTAssertEqual(attributeWalk(10, reading: r, cache: UDIDCache()),
                       .unresolved("parent chain did not terminate"))
    }

    /// **The boundary, from both sides.** A chain that reaches the top on the last allowed step
    /// resolves; one step deeper does not. Written down because moving the limit is otherwise
    /// invisible — the failure it prevents is a hang, and a hang has no assertion.
    func testTheLimitCountsSteps() {
        func chain(_ depth: Int) -> ProcessReader {
            var tree = Tree()
            for i in 1..<depth { tree.parents[pid_t(i)] = pid_t(i + 1) }
            tree.parents[pid_t(depth)] = 1
            tree.paths[pid_t(depth)] = "/…/launchd_sim"
            tree.args[pid_t(depth)] = simArgs
            return reader(tree).0
        }
        // **Literals, not `attributionWalkLimit`.** Deriving the depths from the constant makes the
        // test move with it: lowering the limit to 31 then built a 31-chain and a 32-chain, both
        // behaved the same against the new limit, and the mutation survived. Measured, and it is the
        // reason this case names the number twice instead of once.
        XCTAssertEqual(attributionWalkLimit, 32, "the limit moved — the depths below have to move too")
        XCTAssertEqual(attributeWalk(1, reading: chain(32), cache: UDIDCache()),
                       .simulator(udid), "a chain exactly at the limit still resolves")
        XCTAssertEqual(attributeWalk(1, reading: chain(33), cache: UDIDCache()),
                       .unresolved("parent chain did not terminate"))
    }
}
