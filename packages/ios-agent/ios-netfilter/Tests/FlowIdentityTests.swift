import XCTest

// No import of the code under test: `tests.yml` compiles `Extension/FlowIdentity.swift` **into this
// bundle**, so it is the same module. A system extension cannot be linked by a test bundle, which is
// why the sources are compiled rather than imported.

/// The first tests the network filter's Swift has had (#690).
///
/// **What they can hold, and what they cannot.** Attribution reads the live kernel — the parent walk,
/// `KERN_PROCARGS2`, `proc_pidpath` — and none of that stands up in a unit test. `extractUDID` is the
/// part left once those are peeled away, and it is the part a test can decide from its inputs alone.
///
/// Every `XCTAssertNil` here was verified by the mutation that creates the absence, because a test
/// asserting absence passes when nothing happens — that is its definition, so it cannot tell a working
/// parse from a function that returns `nil` unconditionally. See
/// `contributing/test-and-guard-coverage.md` rule 2. `run-tests.sh --mutate` re-runs those mutations.
final class FlowIdentityTests: XCTestCase {

    /// The shape `procArgs` actually produces: `launchd_sim`'s argv with the NULs between arguments
    /// already replaced by spaces.
    private let realArgs =
        "/Library/Developer/CoreSimulator/Volumes/iOS_23E254a/Library/Developer/CoreSimulator/Profiles/" +
        "Runtimes/iOS 26.4.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/launchd_sim " +
        "/Users/someone/Library/Developer/CoreSimulator/Devices/" +
        "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3/data/var/run/launchd_bootstrap.plist "

    func testReadsTheUDIDOutOfARealArgumentString() {
        XCTAssertEqual(extractUDID(from: realArgs), "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3")
    }

    /// A host process's arguments never contain the marker. This is the branch that keeps the filter
    /// from attributing the Mac's own traffic to a simulator.
    func testReturnsNilWhenTheMarkerIsAbsent() {
        XCTAssertNil(extractUDID(from: "/usr/libexec/somethingd --flag /Users/someone/Library"))
        XCTAssertNil(extractUDID(from: ""))
    }

    /// `/Devices/` can appear with something that is not an identifier after it. The length check is
    /// the only thing separating the two.
    func testReturnsNilWhenTheSegmentIsNotThirtySixCharacters() {
        XCTAssertNil(extractUDID(from: "/Devices/short/data"))
        XCTAssertNil(extractUDID(from: "/Devices//data"))
        XCTAssertNil(extractUDID(from: "/Devices/752C0B5F-B060-4A5A-9D22-1DE9DAD483B/data"))   // 35
        XCTAssertNil(extractUDID(from: "/Devices/752C0B5F-B060-4A5A-9D22-1DE9DAD483B33/data")) // 37
    }

    /// **A trailing separator is not required**, and this pins it rather than requiring it: the scan
    /// runs to the end of the string when no `/` follows.
    func testAcceptsAnIdentifierThatEndsTheString() {
        XCTAssertEqual(extractUDID(from: "/Devices/752C0B5F-B060-4A5A-9D22-1DE9DAD483B3"),
                       "752C0B5F-B060-4A5A-9D22-1DE9DAD483B3")
    }

    /// **The consequence of the line above, and the reason the real input always has one.** With the
    /// NULs turned into spaces, an identifier followed by another *argument* rather than by a path
    /// component runs into that argument and fails the length check. Nothing in production produces
    /// this — `launchd_sim`'s identifier is always followed by `/data` — but the parse's behaviour here
    /// is what a stricter version would change, so it is written down.
    func testRunsIntoTheNextArgumentWhenNoPathComponentFollows() {
        XCTAssertNil(extractUDID(from: "/Devices/752C0B5F-B060-4A5A-9D22-1DE9DAD483B3 --another-arg"))
    }

    /// The first marker wins. Recorded because it is a decision the code makes silently.
    func testTakesTheFirstMarker() {
        let two = "/Devices/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/x /Devices/BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB/y"
        XCTAssertEqual(extractUDID(from: two), "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")
    }

    /// **This is a floor, not a fence, and the test says so out loud.** Thirty-six characters of
    /// anything but `/` passes — it is a length check, not a UUID check. Pinned so that tightening it
    /// becomes a visible decision: this test has to be edited to make the parse stricter, which is
    /// exactly the moment to think about whether CoreSimulator agrees.
    func testDoesNotValidateTheIdentifierBeyondItsLength() {
        let notAUUID = String(repeating: "z", count: 36)
        XCTAssertEqual(extractUDID(from: "/Devices/\(notAUUID)/data"), notAUUID)
    }
}
