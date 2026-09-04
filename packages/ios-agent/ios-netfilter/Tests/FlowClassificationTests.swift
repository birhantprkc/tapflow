import XCTest

/// `passesRegardlessOfRule` decides whether a flow belonging to a simulator the tester took offline is
/// let through anyway. Three conditions, and each is load-bearing for a different reason — too narrow
/// and the 25-second name-resolution hang comes back, too wide and a device reported offline is
/// reaching the network.
///
/// Every `XCTAssertFalse` here was verified by the mutation that makes it true — see
/// `run-tests.sh --mutate`. A test asserting that something is *not* allowed passes when nothing is
/// allowed, which is its definition, so a green run is not evidence on its own.
final class FlowClassificationTests: XCTestCase {

    private func allows(port: Int?, udp: Bool = true, outbound: Bool = true) -> Bool {
        passesRegardlessOfRule(remotePort: port, isUDP: udp, isOutbound: outbound)
    }

    func testAllowsOutboundUDPNameResolution() {
        XCTAssertTrue(allows(port: 53))
        XCTAssertEqual(dnsPort, 53)
    }

    /// **TCP/53 is not allowed, and that is the point rather than an omission.** The hole exists
    /// because a dropped UDP flow tells its sender nothing; a dropped TCP flow fails in 6ms, measured.
    /// So opening TCP/53 would buy none of the fix and would let a simulator reported offline hold a
    /// bidirectional connection to anything listening there — the shape a DNS tunnel takes.
    func testDoesNotAllowTCPOnTheSamePort() {
        XCTAssertFalse(allows(port: 53, udp: false))
    }

    /// **Inbound is not allowed, because `remotePort` means the other end.** On an inbound flow that
    /// is the sender's port, so a peer sending from source port 53 would otherwise reach a device the
    /// tester was told is offline.
    func testDoesNotAllowInbound() {
        XCTAssertFalse(allows(port: 53, outbound: false))
        XCTAssertFalse(allows(port: 53, udp: false, outbound: false))
    }

    /// **The hole this must not open.** The port is `nil` when the endpoint cannot be read, and
    /// treating "we do not know" as "let it through" would make every dropped flow depend on a
    /// property this code does not control — one OS release from turning the feature off silently.
    func testAnUnreadablePortIsNotAllowed() {
        XCTAssertFalse(allows(port: nil))
    }

    func testDoesNotAllowOrdinaryTraffic() {
        XCTAssertFalse(allows(port: 443))   // HTTPS, and QUIC over UDP
        XCTAssertFalse(allows(port: 80))
        XCTAssertFalse(allows(port: 0))
    }

    /// **Two ports that look like they belong and do not.** 853 is DNS-over-TLS and 5353 is mDNS;
    /// neither is covered, and the reason is written on the function. Pinned so that adding either
    /// becomes an edit to this test — which is the moment to ask what measured it.
    func testDoesNotAllowTheOtherResolutionPorts() {
        XCTAssertFalse(allows(port: 853))
        XCTAssertFalse(allows(port: 5353))
    }

    /// **The channel choice, which is what the diagnostic log claims to make visible.** The first
    /// channel wins when it answers; `0` and a value the other side cannot parse both fall through to
    /// the second, and neither reads as "the first channel is empty".
    func testChoosesTheChannelThatActuallyAnswered() {
        var r = portFromChannels(hostEndpointPort: "53", flowEndpointPort: 5353)
        XCTAssertEqual(r.port, 53); XCTAssertEqual(r.how, "remoteEndpoint")

        r = portFromChannels(hostEndpointPort: "0", flowEndpointPort: 53)
        XCTAssertEqual(r.port, 53, "port 0 on the first channel must fall through, not win")
        XCTAssertEqual(r.how, "remoteFlowEndpoint")

        r = portFromChannels(hostEndpointPort: nil, flowEndpointPort: 53)
        XCTAssertEqual(r.port, 53); XCTAssertEqual(r.how, "remoteFlowEndpoint")

        r = portFromChannels(hostEndpointPort: "not-a-number", flowEndpointPort: 53)
        XCTAssertEqual(r.port, 53); XCTAssertEqual(r.how, "remoteFlowEndpoint")

        r = portFromChannels(hostEndpointPort: nil, flowEndpointPort: nil)
        XCTAssertNil(r.port); XCTAssertEqual(r.how, "unreadable")

        r = portFromChannels(hostEndpointPort: nil, flowEndpointPort: 0)
        XCTAssertNil(r.port, "0 is not a port on either channel")
        XCTAssertEqual(r.how, "unreadable")
    }

    /// **`0` is what one endpoint channel reports for an unconnected flow and the other omits.**
    /// Without normalising, the same condition read as two different channels in the log — and that
    /// log is the thing meant to make an emptied channel visible rather than silent.
    func testNormalisesPortsThatAreNotPorts() {
        XCTAssertNil(normalisedPort(0))
        XCTAssertNil(normalisedPort(-1))
        XCTAssertNil(normalisedPort(65_536))
        XCTAssertNil(normalisedPort(nil))
        XCTAssertEqual(normalisedPort(53), 53)
        XCTAssertEqual(normalisedPort(65_535), 65_535)
    }
}
