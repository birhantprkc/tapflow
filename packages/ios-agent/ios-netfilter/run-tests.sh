#!/usr/bin/env bash
# The netfilter's Swift tests (#690). Needs Xcode and xcodegen.
#
# **CI runs `--mutate`, not the plain mode.** `.github/workflows/ci.yml` has a `test-swift` job on
# `macos-15` that calls this script with the flag, and it is part of the `ci` rollup — so a Mac
# contributor is no longer the only thing standing between a decorative test and a merge. Running the
# expensive mode there is deliberate: a green suite is not evidence on its own, and the whole reason
# this file exists is that the cheap mode cannot tell the difference.
#
# **That makes every mutation added below a cost paid on every push**, so the engine matters more
# than the count. It is `swiftc` plus `xcrun xctest`, not `xcodebuild`: measured on these same files,
# a build-and-run cycle is 1.9s against ~13.5s for one `xcodebuild test` launch on CI's runner. At
# eighty-three cycles that is the difference between eighteen minutes and three.
#
# **An earlier version of this header said CI could not run these at all**, which was true when it
# was written and stopped being true without anything here noticing.
#
#   ./run-tests.sh            run them
#   ./run-tests.sh --mutate   run them, then re-run under mutations that must make them FAIL
#
# The second mode is the point. `contributing/test-and-guard-coverage.md` rule 2: a test asserting
# absence passes when nothing happens, so a green run is not evidence it holds anything. The mutations
# below break the parse in the ways the tests claim to catch; any that still passes is decoration.
set -euo pipefail
cd "$(dirname "$0")"

# The bundle is assembled by hand rather than by `xcodegen` + `xcodebuild`. `tests.yml` stays —
# generating a real project is how you open these tests in Xcode and step through one — but nothing
# in this script reads it, and `scripts/__tests__/netfilterTestSources.test.mjs` holds the two source
# lists together so the affordance cannot drift away from what is actually tested.
BUNDLE=build/FilterLogicTests.xctest
BIN="$BUNDLE/Contents/MacOS/FilterLogicTests"
LOG=$(mktemp -t netfilter-tests)
BUILD_LOG=$(mktemp -t netfilter-build)
HUNG_MARKER=$(mktemp -t netfilter-hung)

# The same three entries as `tests.yml`'s `sources:`. Both halves of the binary pair, because both
# have a pure part and neither can be linked: a system extension is not loadable by a test bundle,
# and `Host/main.swift` is top-level code whose statements would become a second `main`.
SOURCES=(Extension/FlowIdentity.swift Host/RuleArguments.swift Tests/*.swift)

# No `-target`. The bundle is never shipped and only has to run on the machine testing, so pinning a
# deployment target here would be pinning CI's runner architecture in a file nobody would think to
# change when that moves. Nothing under test carries an `@available` branch.
PLATFORM_DIR=$(xcrun --show-sdk-platform-path --sdk macosx)
XCTEST_FW="$PLATFORM_DIR/Developer/Library/Frameworks"
XCTEST_LIB="$PLATFORM_DIR/Developer/usr/lib"

# How long a single run may take before it is treated as hung. The whole suite executes in 0.02s and
# the process is up for about 0.7s, so this is three orders of magnitude of headroom — it is not a
# performance budget, it is the only thing that can end a mutation whose failure mode is a loop.
DEADLINE=20

# **Four outcomes, and the exit code is the discriminator rather than a string in a log.** That is
# the substantive gain from dropping `xcodebuild`: `xcodebuild test` performs the build and the tests
# as one action and reports one status, so telling a compile error from a failing assertion meant
# counting `Test Case` occurrences — a textual check that this file had already got wrong twice.
# Compiling and running are two commands here, so each has its own status.
#
#   0  every test passed
#   1  a test failed — the mutation was killed
#   2  it did not compile, so nothing judged it
#   3  it had to be killed at the deadline
run () {
  # **Emptied first, and that is not tidiness.** An early `return` leaves `$LOG` untouched, so a
  # failed build would otherwise hand `mutate` the *previous* mutation's log.
  : > "$LOG"
  : > "$BUILD_LOG"
  rm -rf "$BUNDLE"
  mkdir -p "$BUNDLE/Contents/MacOS"
  cat > "$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.tapflow.FilterLogicTests</string>
  <key>CFBundleName</key><string>FilterLogicTests</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleExecutable</key><string>FilterLogicTests</string>
</dict></plist>
PLIST
  swiftc -o "$BIN" -module-name FilterLogicTests \
    -F "$XCTEST_FW" -I "$XCTEST_LIB" -L "$XCTEST_LIB" \
    -Xlinker -bundle \
    -Xlinker -rpath -Xlinker "$XCTEST_FW" -Xlinker -rpath -Xlinker "$XCTEST_LIB" \
    "${SOURCES[@]}" > "$BUILD_LOG" 2>&1 || return 2

  # **A watchdog rather than a poll**, because polling costs its interval on every one of the
  # eighty-two runs that finish in under a second, and the deadline only ever fires for one or two of
  # them. `timeout` is not on macOS.
  #
  # **The marker is what says the deadline fired, not the exit code.** SIGKILL surfaces as 137 and it
  # was tempting to read that as the answer, but that is inferring a cause from a number the same way
  # this file used to infer a build failure from a log line. A run really can die by signal on its
  # own — `cache: no lock` segfaults, measured — so the watchdog records that *it* acted, before it
  # acts, which makes the marker present by the time `wait` returns.
  rm -f "$HUNG_MARKER"
  xcrun xctest "$BUNDLE" > "$LOG" 2>&1 &
  local pid=$! rc=0
  ( sleep "$DEADLINE"; : > "$HUNG_MARKER"; kill -9 "$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid" || rc=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  [[ -f "$HUNG_MARKER" ]] && return 3
  return $rc
}

if [[ "${1:-}" != "--mutate" ]]; then
  rc=0; run || rc=$?
  case $rc in
    0) grep -E "Executed .* tests" "$LOG" | tail -1; exit 0 ;;
    2) echo "the tests did not compile:"; grep -E "error:" "$BUILD_LOG" | head -20; exit 1 ;;
    3) echo "the run was killed after ${DEADLINE}s — something is looping"; tail -3 "$LOG"; exit 1 ;;
    *) grep -E "error:|failed" "$LOG" | head -20; exit 1 ;;
  esac
fi

# **`--mutate` works on a COPY, and the checkout is never written to.**
#
# It used to mutate `Extension/FlowIdentity.swift` and `Host/RuleArguments.swift` in place and restore
# them after each of the seventy runs. That leaves a window open for the length of the whole mode —
# about thirteen minutes — and anything else touching the tree during it sees a deliberately broken
# source. Measured, three times in one day: `build.sh` started while this was running, and a mutated
# extension was compiled, signed, notarized and recorded in `shipped.json`. Nothing about the run
# said it was happening; `git status` was clean between mutations and dirty inside them.
#
# Being careful was tried and did not work. Copying does: there is no window, so a build racing this
# is no longer a thing that can go wrong, and `git status` stays clean throughout.
#
# `mktemp -d` rather than a fixed name, because `rsync --delete` into a path something else can
# pre-create is a path it can point somewhere worth deleting. Build products land in `build/` inside
# the copy and go with it, so nothing accumulates anywhere.
WORK=$(mktemp -d -t tapflow-netfilter-mutate) || exit 1
# **The second `trap … EXIT` below REPLACES this one**, which is why `cleanup` removes `$WORK` as well.
# Getting that wrong left a 3.7 GB copy behind on the first run of this mode — bash keeps one EXIT
# handler, not a list, and nothing says so at the point of the second `trap`.
trap 'rm -rf "$WORK"' EXIT
/usr/bin/rsync -a --exclude build --exclude '*.xcodeproj' ./ "$WORK/"
echo "=== mutating a copy at $WORK — this checkout is not written to ==="
cd "$WORK"

echo "=== baseline (must PASS) ==="
run && echo "  PASS" || { echo "  FAIL — fix the tests before mutating"; grep -E "error:" "$LOG" | head; exit 1; }

# **Two files carry pure code now**, so a mutation names the one it aims at. The extension's half and
# the host binary's half are tested by one bundle (`tests.yml`) but they are different targets in the
# shipping project, and — see the note in `tests.yml` — they carry different version stamps.
EXT_SRC=Extension/FlowIdentity.swift
HOST_SRC=Host/RuleArguments.swift

# **Still `mktemp`, and still restored between mutations** — each one has to start from the pristine
# source or the second would compound the first. What changed is the stake: these paths are inside the
# copy above, so a bad restore corrupts a directory that is deleted on exit rather than a source file
# that gets built into a signed system extension.
EXT_ORIG=$(mktemp -t FlowIdentity.orig) || exit 1
HOST_ORIG=$(mktemp -t RuleArguments.orig) || exit 1
cp "$EXT_SRC" "$EXT_ORIG"
cp "$HOST_SRC" "$HOST_ORIG"
restore () { cp "$EXT_ORIG" "$EXT_SRC"; cp "$HOST_ORIG" "$HOST_SRC"; }
cleanup () { restore; rm -f "$EXT_ORIG" "$HOST_ORIG" "$HUNG_MARKER"; rm -rf "${WORK:-}"; }
trap cleanup EXIT

# The backup a given source is compared against, so `DID NOT APPLY` stays honest per file.
orig_for () { [[ "$1" == "$EXT_SRC" ]] && echo "$EXT_ORIG" || echo "$HOST_ORIG"; }

# **Three ways a mutation can fail to prove anything, and they used to print the same word.**
#
#   DID NOT APPLY — the `sed` matched nothing, so the source was never mutated. Says the mutation has
#                   drifted from the code, not that a test is weak.
#   SURVIVED      — it compiled, it ran, and every test still passed. The finding this mode exists for.
#   BUILD BROKE   — it did not compile, so no test ever judged it. Reporting this as `killed` is how a
#                   suite that tests nothing reads as green, which is the whole failure this file
#                   guards against.
#
# And one that is a kill rather than a failure to prove anything:
#
#   killed (hung) — the run reached the deadline. A mutation that removes a *bound* does not make an
#                   assertion fail, it makes a case spin, so this is what catching one looks like. It
#                   is printed apart from a plain kill because a hang that is not about a bound is a
#                   different problem wearing the same clothes, and folding the two together would
#                   hide it.
mutate () {   # $1 = label, $2 = sed program, $3 = file (default: the extension's)
  restore
  local src="${3:-$EXT_SRC}" orig
  orig=$(orig_for "$src")
  /usr/bin/sed -i '' "$2" "$src"
  if cmp -s "$orig" "$src"; then
    echo "  DID NOT APPLY: $1   <-- the sed matched nothing; the source moved under it"
    return 1
  fi
  local rc=0
  run >/dev/null 2>&1 || rc=$?
  case $rc in
    0) echo "  SURVIVED: $1   <-- it compiled and every test still passed; one of them is decoration"
       return 1 ;;
    2) echo "  BUILD BROKE: $1   <-- it did not compile, so nothing judged it"
       return 1 ;;
    3) echo "  killed (hung): $1   <-- killed at ${DEADLINE}s" ;;
    *) echo "  killed:   $1" ;;
  esac
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
mutate "channels: reversed"      's/if let s = hostEndpointPort/if let f = flowEndpointPort, let p = normalisedPort(Int(f)) { return (p, "remoteFlowEndpoint") }; if let s = hostEndpointPort/' || fails=1
mutate "channels: first unguarded" 's/if let s = hostEndpointPort, let p = normalisedPort(Int(s))/if let s = hostEndpointPort, let p = Int(s)/' || fails=1

# --- the audit token, the identity cache and what the heartbeat publishes ---
#
# `size >= 20` rather than deleting the guard: with no guard at all a 31-byte blob reads a plausible
# word and an empty one traps, so the mutation would be judged on a crash rather than on the
# assertion it is aimed at. Loosening it keeps every fixture in the function and lets the test speak.
mutate "token: pid from word 4"  's/UInt32.self)\[5\]/UInt32.self)[4]/'                        || fails=1
mutate "token: asid from word 7" 's/UInt32.self)\[6\]/UInt32.self)[7]/'                        || fails=1
mutate "token: size guard loose" 's/data.count == MemoryLayout<audit_token_t>.size/data.count >= 20/' || fails=1
# The pid-reuse bug, planted exactly as it would arrive: a cache keyed on the number the kernel hands
# back rather than on the boot it belongs to.
mutate "cache: keyed on pid only" 's/\[ProcIdentity: String\]/[pid_t: String]/; s/return byRoot\[root\]/return byRoot[root.pid]/; s/byRoot\[root\] = udid/byRoot[root.pid] = udid/' || fails=1
mutate "prune: keeps everything" 's/counts.filter { rule.contains($0.key) }/counts/'           || fails=1
mutate "prune: empty rule keeps" 's/counts.filter { rule.contains($0.key) }/rule.isEmpty ? counts : counts.filter { rule.contains($0.key) }/' || fails=1
mutate "pulse: rates swapped"    's/enforcing ? 1 : 5/enforcing ? 5 : 1/'                      || fails=1
mutate "pulse: always fast"      's/enforcing ? 1 : 5/1/'                                      || fails=1
# **The one mutation here that kills by crashing rather than by asserting.** A bare Swift `Dictionary`
# mutated from two threads corrupts its storage, so the test process takes SIGSEGV — which `run` reads
# as a non-zero exit with `Test Case` present, exactly as a failed assertion does. That is the honest
# outcome: the lock's absence is not observable any other way.
# **This one is killed reliably and not always the same way**, because removing a lock is undefined
# behaviour rather than a wrong answer. Measured 28 runs of 28 killed, in three shapes: the assertion
# failing, `SIGSEGV`, and — once, under the load of a full mutation run — the watchdog. All three are
# kills; only the third costs the deadline. Do not "stabilise" it by weakening the concurrent test.
mutate "cache: no lock"          's/lock.lock(); defer { lock.unlock() }//'                     || fails=1

# --- the host binary's arguments and rule arithmetic ---
#
# **These name the third argument**, because the file they aim at is not the extension's.
mutate "merge: drops the existing set" 's/var out = Set(existing)/var out = Set<String>()/' "$HOST_SRC" || fails=1
mutate "merge: remove wipes"           's/out.subtract(remove)/out.removeAll()/'            "$HOST_SRC" || fails=1
# Swaps the two lines rather than deleting one, so it is the ORDER under test and not the presence of
# a subtract — `remove` winning over `add` for the same udid is the property, and only a flip moves it.
mutate "merge: union after subtract"   '/out.formUnion(add)/{s/.*/    out.subtract(remove)/;n;s/.*/    out.formUnion(add)/;}' "$HOST_SRC" || fails=1
# **This one could survive by luck, and the fixture is what stops it.** Swift seeds its hasher per
# process, so `Array(out)` is an arbitrary permutation each run. Measured over 300 fresh processes:
# a six-element set matched `sorted()` **once**, a twelve-element set **zero** times — so
# `testOutputIsSorted` uses twelve. Raised from six after CodeRabbit pointed out that a flaky
# `SURVIVED` sends someone after a hole that is not there.
mutate "merge: unsorted output"        's/return out.sorted()/return Array(out)/'            "$HOST_SRC" || fails=1
mutate "args: absent flag throws"      's/else { return \[\] }/else { throw ArgError.missingValue(flag) }/' "$HOST_SRC" || fails=1
mutate "args: value may be a flag"     's/, !args\[i + 1\].hasPrefix("--")//'                "$HOST_SRC" || fails=1
mutate "args: no bounds check"         's/i + 1 < args.count/i + 1 <= args.count/'           "$HOST_SRC" || fails=1
# **This one replaced a mutation that survived, and the survivor was right.** Deleting a
# `.filter { !$0.isEmpty }` changed nothing, because `split(separator:)` already omits empty
# subsequences — the filter was dead code and the test passed either way. Flipping the flag that
# actually decides is the mutation that was meant.
mutate "args: keeps empty entries"     's/split(separator: ",")/split(separator: ",", omittingEmptySubsequences: false)/' "$HOST_SRC" || fails=1
mutate "reject: bare word allowed"     's/^            throw ArgError.unknown(arg)$/            _ = arg/' "$HOST_SRC" || fails=1
mutate "reject: any flag is known"     's/if !knownFlags.contains(arg)/if false/'            "$HOST_SRC" || fails=1
mutate "reject: the value is judged"   's/if arg == "--add" || arg == "--remove" { i += 1 }//' "$HOST_SRC" || fails=1
mutate "reject: mode flags unknown"    's/"--confirm", "--off", //'                        "$HOST_SRC" || fails=1
mutate "args: last flag wins"          's/args.firstIndex(of: flag)/args.lastIndex(of: flag)/' "$HOST_SRC" || fails=1
mutate "mode: --off unwired"           's/if args.contains("--off") { return .disable }//' "$HOST_SRC" || fails=1
mutate "mode: install beats off"       '/if args.contains("--confirm")/{n;s/.*/    if args.contains("--install") { return .install }/;n;s/.*/    if args.contains("--off") { return .disable }/;}' "$HOST_SRC" || fails=1
mutate "clear: inverted"               's/!args.contains("--add") \&\& !args.contains("--remove")/args.contains("--add") || args.contains("--remove")/' "$HOST_SRC" || fails=1
mutate "clear: never clears"           's/!args.contains("--add") \&\& !args.contains("--remove")/false/' "$HOST_SRC" || fails=1

# --- the flow verdict ---
mutate "dec: empty rule not idle"  's/if rule.isEmpty { return .allow(.idle) }//'                || fails=1
mutate "dec: host is dropped"      's/case .host: return .allow(.host)/case .host: return .drop(.host)/' || fails=1
mutate "dec: failed walk drops"    's/case .unresolved: return .allow(.unresolved)/case .unresolved: return .drop(.unresolved)/' || fails=1
mutate "dec: no token is a host"   's/guard let attribution else { return .allow(.unresolved) }/guard let attribution else { return .allow(.host) }/' || fails=1
mutate "dec: any simulator drops"  's/guard rule.contains(udid) else { return .allow(.simulator(dropped: false, udid: udid)) }//' || fails=1
mutate "dec: dns is dropped"       's/return .allow(.dns)/return .drop(.dns)/'                   || fails=1
# The laziness, which is a performance property and therefore the one nothing else would notice.
mutate "dec: endpoint read always" 's/if rule.isEmpty { return .allow(.idle) }/_ = shape(); if rule.isEmpty { return .allow(.idle) }/' || fails=1

# --- the counters ---
mutate "counts: dns is a sibling"  '/case .dns:/{n;s/simulator += 1//;}'                          || fails=1
mutate "counts: drop not per-device" 's/droppedByUDID\[udid, default: 0\] += 1//'                 || fails=1
mutate "counts: allowed is a drop" 's/if dropped {/if true {/'                                    || fails=1
mutate "counts: a skipped walk counts" 's/if let nanos = walkNanos {/let nanos = walkNanos ?? 0; if true {/' || fails=1
mutate "counts: average by zero"   's/walks > 0 ? Double(walkNanos)/walks >= 0 ? Double(walkNanos)/' || fails=1
# **Every accumulator, turned into an assignment.** A review found all five of these surviving: one
# sample cannot tell `+=` from `=`, and the tests recorded each outcome once. A per-device count
# pinned at 1 makes the agent's "enforcement observed" line say one flow forever.
mutate "counts: dropped assigned"  's/self.dropped += 1/self.dropped = 1/'                        || fails=1
mutate "counts: per-device assigned" 's/droppedByUDID\[udid, default: 0\] += 1/droppedByUDID[udid] = 1/' || fails=1
mutate "counts: host assigned"     's/case .host: host += 1/case .host: host = 1/'                 || fails=1
mutate "counts: walks assigned"    's/walks += 1/walks = 1/'                                       || fails=1
mutate "counts: nanos assigned"    's/self.walkNanos += nanos/self.walkNanos = nanos/'             || fails=1

# --- the state file ---
mutate "render: clock is read"     's/json = "{\\"at\\":\\(epochSeconds)"/json = "{\\"at\\":\\(Int(Date().timeIntervalSince1970))"/' || fails=1
mutate "render: pid dropped"       's/,\\"pid\\":\\(pid)//'                                       || fails=1
mutate "render: rule truncated"    's/withJSONObject: rule.sorted()/withJSONObject: rule.sorted().map { String($0.prefix(1)) }/' || fails=1
mutate "render: prune not applied" 's/counts.droppedByUDID = prunedDrops(/_ = prunedDrops(/'      || fails=1
# **The prune applied, and the pre-prune copy published anyway.** `inout` stops the CALLER forgetting;
# it does not stop this function serialising the wrong map, and asserting only the retained map left
# that invisible. This is the mutation that says the test looks at what the agent actually reads.
mutate "render: stale map published" 's/counts.droppedByUDID = prunedDrops(counts.droppedByUDID, rule: rule)/let stale = counts.droppedByUDID; counts.droppedByUDID = prunedDrops(counts.droppedByUDID, rule: rule)/; s/withJSONObject: counts.droppedByUDID))/withJSONObject: stale))/' || fails=1
mutate "render: always idle rate"  's/pulseSeconds(enforcing: !rule.isEmpty)/pulseSeconds(enforcing: false)/' || fails=1

# --- when a write is due ---
mutate "due: force ignored"        's/force || now - lastWrite >= 1.0/now - lastWrite >= 1.0/'    || fails=1
mutate "due: no rate limit"        's/force || now - lastWrite >= 1.0/true/'                      || fails=1
mutate "due: threshold halved"     's/now - lastWrite >= 1.0/now - lastWrite >= 0.5/'             || fails=1
mutate "pulse: no leeway"          's/pulseSeconds(enforcing: enforcing) - 0.25/pulseSeconds(enforcing: enforcing)/' || fails=1
mutate "pulse: unpublished ignored" 's/unpublished || now - lastWrite/now - lastWrite/'           || fails=1

# --- where the file goes ---
mutate "paths: protected path gone" 's|"/Library/Application Support/tapflow",|"/tmp",|'          || fails=1


# --- the parent walk: whose traffic a flow is ---
mutate "walk: a failed read is a host flow" 's/return .unresolved("sysctl failed at pid \\(current)")/return .host/' || fails=1
mutate "walk: stops only at ppid 1"      's/if info.ppid <= 1 {/if info.ppid == 1 {/'          || fails=1
mutate "walk: any top is a simulator"    's/!path.hasSuffix("\/launchd_sim")/path.hasSuffix("\/launchd_sim")/' || fails=1
mutate "walk: an unreadable path is host" 's/if let path = read.executablePath(current), !path.hasSuffix/if read.executablePath(current) == nil { return .host }; if let path = read.executablePath(current), !path.hasSuffix/' || fails=1
mutate "walk: the cache is not consulted" 's/if let cached = cache.lookup(info.identity) { return .simulator(cached) }//' || fails=1
mutate "walk: nothing is cached"         's/cache.store(info.identity, udid)//'                || fails=1
# **The bound gets a mutation after all, and the claim that it could not was untested.** This one
# does not fail fast — it makes the cycle case spin until `run`'s watchdog kills it, so it reports as
# `killed (hung)` and costs the deadline. That is the price of holding a decision whose failure mode
# is a hang rather than a wrong answer, and it is the one run in this file that does not get faster
# by making the engine faster.
mutate "walk: no bound"                  's/for _ in 0..<attributionWalkLimit {/while true {/' || fails=1
mutate "walk: one step short"            's/let attributionWalkLimit = 32/let attributionWalkLimit = 31/' || fails=1
mutate "walk: judges the flow's own process" 's/current = info.ppid//'                         || fails=1
mutate "walk: cache keyed on pid only"   's/cache.lookup(info.identity)/cache.lookup(ProcIdentity(pid: current, startSec: 0, startUsec: 0))/' || fails=1
mutate "walk: caches under a fake identity" 's/cache.store(info.identity, udid)/cache.store(ProcIdentity(pid: current, startSec: 0, startUsec: 0), udid)/' || fails=1
mutate "walk: reads the path at every level" 's/guard let info = read.parent(current) else {/_ = read.executablePath(current); guard let info = read.parent(current) else {/' || fails=1

restore
[[ $fails -eq 0 ]] && echo "=== all mutations killed ===" || { echo "=== a mutation survived ==="; exit 1; }
