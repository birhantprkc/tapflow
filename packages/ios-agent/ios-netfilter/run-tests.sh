#!/usr/bin/env bash
# The netfilter's Swift tests (#690). Needs Xcode and xcodegen; there is no CI for this.
#
# **CI cannot run these.** `.github/workflows/ci.yml` builds on `ubuntu-latest` and the repo has no
# macOS runner, so this is a check a Mac contributor runs by hand. That is not a shortcoming of this
# script: the filter's Swift is only testable where Xcode is.
#
#   ./run-tests.sh            run them
#   ./run-tests.sh --mutate   run them, then re-run under mutations that must make them FAIL
#
# The second mode is the point. `contributing/test-and-guard-coverage.md` rule 2: a test asserting
# absence passes when nothing happens, so a green run is not evidence it holds anything. The mutations
# below break the parse in the ways the tests claim to catch; any that still passes is decoration.
set -euo pipefail
cd "$(dirname "$0")"

PROJ=TapflowNetFilterTests.xcodeproj
LOG=$(mktemp -t netfilter-tests)

# **Returns xcodebuild's own status.** An earlier version piped into `grep` and reported *its* exit
# code, so a compile error read as a passing run — which in `--mutate` below would have called every
# mutation "killed" while nothing was being tested at all.
run () {
  xcodegen generate --spec tests.yml >/dev/null || return 1
  xcodebuild test -project "$PROJ" -scheme FilterLogicTests -destination 'platform=macOS,arch=arm64' \
    CODE_SIGNING_ALLOWED=NO > "$LOG" 2>&1
}

if [[ "${1:-}" != "--mutate" ]]; then
  if run; then grep -E "Executed .* tests|TEST SUCCEEDED" "$LOG" | tail -2; exit 0
  else grep -E "error:|Test Case.*failed|TEST FAILED" "$LOG" | head -20; exit 1; fi
fi

echo "=== baseline (must PASS) ==="
run && echo "  PASS" || { echo "  FAIL — fix the tests before mutating"; grep -E "error:" "$LOG" | head; exit 1; }

SRC=Extension/FlowIdentity.swift
cp "$SRC" /tmp/FlowIdentity.orig.swift
restore () { cp /tmp/FlowIdentity.orig.swift "$SRC"; }
trap restore EXIT

mutate () {   # $1 = label, $2 = sed program
  restore
  /usr/bin/sed -i '' "$2" "$SRC"
  if run >/dev/null 2>&1; then echo "  SURVIVED: $1   <-- a test is decoration"; return 1
  else echo "  killed:   $1"; fi
}

echo "=== mutations (each must make a test FAIL) ==="
fails=0
mutate "always nil"              's/return udid.count == 36 ? String(udid) : nil/return nil/' || fails=1
mutate "no length check"         's/udid.count == 36 ? String(udid) : nil/String(udid)/'      || fails=1
mutate "length 35"               's/udid.count == 36/udid.count == 35/'                        || fails=1
mutate "scan past separators"    's/prefix { \$0 != "\/" }/prefix { _ in true }/'              || fails=1
mutate "last marker not first"   's/text.range(of: "\/Devices\/")/text.range(of: "\/Devices\/", options: .backwards)/' || fails=1
mutate "dns: always allow"       's/remotePort == dnsPort/true/'                               || fails=1
mutate "dns: never allow"        's/remotePort == dnsPort/false/'                              || fails=1
mutate "dns: nil allowed too"    's/remotePort == dnsPort/remotePort == dnsPort || remotePort == nil/' || fails=1
mutate "dns: port 853 too"       's/let dnsPort = 53/let dnsPort = 853/'                       || fails=1
mutate "dns: ignore protocol"    's/isOutbound \&\& isUDP \&\& remotePort == dnsPort/isOutbound \&\& remotePort == dnsPort/' || fails=1
mutate "dns: ignore direction"   's/isOutbound \&\& isUDP \&\& remotePort == dnsPort/isUDP \&\& remotePort == dnsPort/'     || fails=1
mutate "port: 0 is a port"       's/raw > 0, raw <= 65535/raw >= 0, raw <= 65535/'                 || fails=1
mutate "port: no upper bound"    's/raw > 0, raw <= 65535/raw > 0/'                                || fails=1
restore
[[ $fails -eq 0 ]] && echo "=== all mutations killed ===" || { echo "=== a mutation survived ==="; exit 1; }
