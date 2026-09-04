import XCTest

/// `passesRegardlessOfRule` decides whether a flow belonging to a simulator the tester took offline is
/// let through anyway. It is one comparison, and it is tested because of what sits on either side of
/// it: too narrow and the 25-second name-resolution hang this exists to remove comes back, too wide
/// and a device reported offline is reaching the network.
///
/// Every `XCTAssertFalse` here was verified by the mutation that makes it true — see
/// `run-tests.sh --mutate`. A test asserting that something is *not* allowed passes when nothing is
/// allowed, which is its definition, so a green run is not evidence on its own.
final class FlowClassificationTests: XCTestCase {

    func testAllowsPlainDNS() {
        XCTAssertTrue(passesRegardlessOfRule(remotePort: 53))
        XCTAssertEqual(dnsPort, 53)
    }

    /// **The hole this must not open.** `remotePort` answers `nil` when the endpoint cannot be read,
    /// and treating "we do not know" as "let it through" would make every dropped flow depend on a
    /// property this code does not control — one OS release from turning the feature off silently.
    func testAnUnreadablePortIsNotAllowed() {
        XCTAssertFalse(passesRegardlessOfRule(remotePort: nil))
    }

    func testDoesNotAllowOrdinaryTraffic() {
        XCTAssertFalse(passesRegardlessOfRule(remotePort: 443))   // HTTPS, and QUIC over UDP
        XCTAssertFalse(passesRegardlessOfRule(remotePort: 80))
        XCTAssertFalse(passesRegardlessOfRule(remotePort: 0))
    }

    /// **Two ports that look like they belong and do not.** 853 is DNS-over-TLS and 5353 is mDNS;
    /// neither is covered, and the reason is written on the function rather than here. Pinned so that
    /// adding either becomes an edit to this test — which is the moment to ask what measured it.
    func testDoesNotAllowTheOtherResolutionPorts() {
        XCTAssertFalse(passesRegardlessOfRule(remotePort: 853))
        XCTAssertFalse(passesRegardlessOfRule(remotePort: 5353))
    }
}
