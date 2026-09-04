#!/usr/bin/env bash
# Build the probe and install it on a booted simulator.
#
#   ./build.sh <udid>
#
# Then run it and watch, which is the only way to read it — the probe writes to stdout:
#
#   xcrun simctl launch --console <udid> dev.tapflow.netprobe
#
# **Arming layer 2 is a separate step and it is deliberate.** The probe reports what it sees whether
# or not the dylib is loaded, and comparing an armed run against an unarmed one is how a hook is shown
# to be doing something. tapflow's agent arms a device it launches an app on; to do it by hand:
#
#   xcrun simctl spawn <udid> launchctl setenv DYLD_INSERT_LIBRARIES <abs path to libtapflow-nethook.dylib>
#   xcrun simctl spawn <udid> launchctl setenv TAPFLOW_TARGET_BUNDLE dev.tapflow.netprobe
#
# and to flip the device offline **at layer 2 only** (no filter rule, so a running agent's view of the
# world is not disturbed):
#
#   touch /tmp/tapflow-offline-<udid>      # offline
#   rm -f  /tmp/tapflow-offline-<udid>     # online
set -euo pipefail
cd "$(dirname "$0")"
UDID="${1:?usage: build.sh <booted simulator udid>}"

xcodegen generate >/dev/null
xcodebuild -project TapflowNetProbe.xcodeproj -scheme NetProbe -configuration Debug \
  -sdk iphonesimulator -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build >/dev/null

APP="build/Build/Products/Debug-iphonesimulator/NetProbe.app"
[[ -d "$APP" ]] || { echo "build produced no app at $APP" >&2; exit 1; }
xcrun simctl install "$UDID" "$APP"
echo "installed dev.tapflow.netprobe on $UDID"
