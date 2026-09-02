# ios-netfilter — iOS 오프라인 1층 (content filter System Extension)

`#607` 네트워크 on/off의 **1층**이다. macOS `NEFilterDataProvider`로 사용자가 오프라인으로 전환한
시뮬레이터의 flow를 drop하고, 나머지는 손대지 않고 통과시킨다. **시뮬 단위** 격리를 flow의 프로세스
계보로 해낸다 — RocketSim은 bundle id로만 필터해 같은 앱 두 시뮬을 구분하지 못한다.

**왜 content filter인가** — 처음 만든 건 `NETransparentProxyProvider`였고, 시뮬레이터 flow를 하나도
못 봤다(실측: handler에 217건이 도달했고 전부 호스트 프로세스). `NEFilterDataProvider`는 본다.

**왜 호스트만으로는 안 되는가** — `handleNewFlow`의 `.drop()`은 **새 flow에만** 걸린다. `URLSession`의
keep-alive 연결은 새 flow를 안 만들어서 계속 통신한다. `filterDataVerdict`로 데이터 계층을 붙잡아
보려 했으나 양쪽 설정 다 못 쓴다 — peek 8192는 데이터 콜백 0건, peek 1은 40초에 815,869건(1바이트씩)
이면서 앱의 재사용 연결에서는 outbound 콜백이 한 번도 안 왔다. Apple DTS도 명시적이다: 허용한 연결은
되돌릴 수 없다. 그래서 기존 연결 절단은 호스트가 아니라 주입된 dylib이 앱 프로세스 안에서 한다.

**왜 fishhook이 아니라 inline patch인가** — fishhook은 Mach-O의 indirect symbol pointer를 다시 쓰는데,
dyld shared cache **밖의** 이미지에만 닿는다. 실제 `.app`에서 측정: 시스템 프레임워크는 서로를 캐시
안에서 direct branch로 부르므로 socket 계층도 path 계층도 안 잡혔다. 잡힌 것처럼 보인 건 우리 dylib
자신의 import였고, 그게 첫 self-check가 false positive였던 이유다. 근거는 `src/inline-hook.h`에 있다.

> **transparent proxy가 아니다.** `NETransparentProxyProvider`로 먼저 만들었고, 실측 결과 시뮬레이터
> 앱의 flow를 **하나도 보지 못했다** — `handleNewFlow`에 잡힌 217건이 전부 호스트 macOS 프로세스였다.
> 같은 조건에서 content filter(socket flow 계층)는 시뮬 flow를 그대로 본다.

## 두 층을 반드시 함께 쓴다

| 층 | 무엇을 | 어디서 | 상태 |
|---|---|---|---|
| **1층** (여기) | 트래픽 차단 (새 연결) | 호스트 sysext | 실증 완료 |
| **2층** | 앱의 `NWPathMonitor`를 `unsatisfied`로, **그리고 기존 연결 절단** | 앱-내부 dylib (`../bin/libtapflow-nethook.dylib`) | 실증 완료 |

1층 단독(= RocketSim)은 `NWPathMonitor`를 못 바꾼다 — 트래픽은 죽는데 앱은 `satisfied`를 계속 믿는다.
2층 단독은 트래픽을 못 막는다 — `nw_path_get_status`를 속여도 URLSession은 커널의 진짜 경로를 보고
요청을 보낸다. **둘 다 실측이고, 그래서 결합이 이 설계의 핵심이다.**

**기존 연결은 1층이 끊을 수 없다.** Apple이 명시한다 — *"Once you've allowed a connection to proceed,
there's no way to go back on that decision. That's true for both content filter and transparent
proxy."* ([forums/710166](https://developer.apple.com/forums/thread/710166)). 그래서 2층이 offline
전환 시 앱 프로세스 안에서 자기 소켓을 `shutdown`한다.

## 구조

```text
ios-netfilter/
  project.yml                    # xcodegen (xctest-runner와 같은 모델)
  TapflowNetFilter.xcodeproj/    # committed (runtime에 xcodegen 안 돌린다)
  Host/                          # 컨테이너 앱: sysext 설치·활성화·룰 기록. ios-agent가 실행
  Extension/                     # NEFilterDataProvider (Provider.swift). 판별과 drop
  build.sh                       # Developer ID 서명 + notarize + staple
  build/                         # gitignored
```

- **컨테이너 앱이 필요한 이유**: `OSSystemExtensionRequest`는 앱 번들 안에서만 호출된다. ios-agent는
  node라 앱이 아니므로, agent가 이 작은 `Host.app`을 실행해 설치·중개한다.
- **Provider가 UDID를 스스로 알아낸다.** flow의 `sourceAppAuditToken` → pid →
  `sysctl(KERN_PROC)`로 부모를 타고 올라가 `launchd_sim`을 찾고 →
  `sysctl(KERN_PROCARGS2)`로 그 argv에서 `/Devices/<UDID>/`를 읽는다. UDID가 있는 곳은 argv뿐이다
  (실행 파일 경로도 cwd도 아니다). 호스트 flow는 조상이 `launchd_sim`이 아니라 자연히 걸러진다.
- **룰 주입은 `NEFilterProviderConfiguration.vendorConfiguration`**. 컨테이너 앱이 쓰고 프레임워크가
  provider에 전달한다 — **실행 중인 provider에 도달하며 재시작이 없다**(토글 3회 내내 pid 불변).
  전달까지 **55ms 이하**(실측). 다만 `saveToPreferences`의 성공은 저장이 받아들여졌다는 뜻뿐이고
  확인 응답이 없다. **"XPC mach service가 등록에 실패했다"고 적혀 있던 것은 틀렸다** — 리스너는
  1ms 안에 답한다(실측 0.26–0.74ms). **그래서 이제 확인은 XPC로 한다** — 아래 `--confirm`.
- **loopback은 예외 코드가 필요 없다**: content filter가 루프백 flow를 아예 받지 않는다(실측 —
  offline 지정된 시뮬의 `127.0.0.1` 요청 5회 전부 성공, 같은 구간 `handleNewFlow` 0건). Metro dev
  서버와 XCUITest tree runner가 이 경로다.

## 사용

```bash
B=/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter

$B --install                    # 확장 활성화 + 설정. 릴리스당 한 번, 사람이 한다
$B --add <udid>[,…] [--remove <udid>[,…]]   # 룰을 델타로 고친다. 에이전트가 토글마다 부르는 경로
                                            # 지명하지 않은 기기는 건드리지 않는다 — 그래서 두 번째
                                            # 에이전트가 첫 번째의 기기를 지우지 못한다
$B                              # 델타 플래그 없음 = 룰을 비운다 = 전부 온라인
                                # udid를 모를 때 사람이 쓰는 유일한 복구 수단
$B --off                        # 필터 비활성화 (확장은 그대로 둔다)
$B --confirm                    # 실행 중인 provider가 뭘 집행 중인지 묻는다 (읽기 전용)
```

**활성화는 설정과 분리돼 있다.** 예전에는 매 실행이 `OSSystemExtensionRequest`를 보냈고, 에이전트가
토글마다 이걸 부르므로 **설정 문자열 하나 바꾸려고 시스템 확장 설치·교체를 요청**하고 있었다. 불필요한
데다, 그 요청이 무응답으로 끝나는 실패(exit 6)에 매번 노출된다.

**exit 0은 "거부당하지 않았다"까지다.** 저장이 받아들여졌다는 뜻이고, 실행 중인 provider가 새 룰을
들고 있다는 뜻은 아니다 — 프레임워크가 `vendorConfiguration`을 provider에 넘기는 것은 그 뒤이고
돌아오는 확인은 없다(전체 실행 27ms, 측정). 실패는 각각 다른 코드로 나온다.

| exit | 뜻 |
|---|---|
| 0 | 저장까지 받아들여짐 |
| 1 | sysext 활성화 실패 |
| 2 | preferences 읽기 실패 |
| 3 | preferences 저장 실패 (시스템 설정에서 거절한 경우가 여기) |
| 4 | 승인 대기 120초 초과 — 시스템 설정에서 승인 후 다시 실행 |
| 5 | 재부팅해야 새 확장이 뜬다 |
| 6 | 45초 안에 시스템 확장 관리자가 아무 응답도 안 함 — 에러도 거절도 아니다 |
| 7 | `--confirm`이 provider에게서 답을 못 받았다 |
| 8 | 이 빌드가 모르는 인자. 룰은 건드리지 않는다 — 모르는 인자를 무시하고 진행하면 읽기 의도의 호출이 룰을 지운다 |

디바이스가 실제로 오프라인인지는 **1층은 `--confirm`, 2층은 dylib이 남긴 verdict**로 판단한다.

### `--confirm` — 실행 중인 provider에게 직접 묻는다

```bash
$B --confirm    # {"enforcing":true,"rule":["<udid>",…],"pid":1234}
```

**exit 0이 못 하는 말을 하는 채널이다. 다른 하나는 provider가 쓰는 상태 파일이고, CLI의 설치 확인과 `tapflow doctor ios`는 그쪽을 읽는다.** 저장이 받아들여진 것과 실행 중인 provider가 그 룰을
들고 있는 것은 다르고, 그 사이에 확인이 돌아오지 않는다. 왕복은 0.26–0.74ms.

**`enforcing`이 따로 있는 이유**: `rule: []`은 "오프라인 기기가 없다"와 "필터가 정지했다" 둘 다다.
`--off` 된 provider는 살아서 16ms에 답하고 빈 룰을 돌려준다 — 정상 유휴 상태와 구분되지 않는다.

**부르는 쪽이 타임아웃을 쥐어야 한다.** provider가 죽어 있는 동안 이 호출은 실패하지 않고 **매달린다**
(실측 3/3, 호출자 데드라인까지). launchd가 mach 이름을 들고 있어서 연결은 성립하고 메시지가 큐에
남기 때문이다. `invalidation`도 `interruption`도 안 온다. 이 바이너리의 5초는 아무도 안 기다리는
프로세스를 위한 보험이고, 실제 판단은 에이전트의 1초가 한다.

**읽기 전용이다.** mach 서비스는 이름만 알면 아무 프로세스나 붙을 수 있고 피어 검증은 아직 없다.
집행 채널은 `vendorConfiguration` 하나뿐이며, 프로브에 있던 `setRule`은 출시본에 없다.

## provider가 남기는 상태 파일

`/Library/Application Support/tapflow/tapflow-netfilter-state.json` — root 소유, 644.
**에이전트가 읽는 코드는 아직 없다 — 그게 #639다.** 아래는 그 판독기가 기대야 할 규약이다.

```json
{"at":1787503422,"pulseSeconds":1,"rule":["<udid>"],
 "flows":{"simulator":116,"host":90,"unresolved":0,"dropped":24},
 "attribution":{"walks":206,"avgMicros":319.7}}
```

**갱신 주기는 두 가지다.** flow가 들어오면 최대 초당 한 번, 그리고 트래픽과 무관하게 `pulseSeconds`
마다. **조용한 Mac에서는 후자만 돈다** — 초당 갱신을 전제로 staleness 임계값을 잡으면 살아 있는
provider를 죽은 것으로 본다. 그래서 그 값이 파일 안에 있다.

**`pulseSeconds`는 고정이 아니다 — 룰이 비어 있지 않으면 1초, 비어 있으면 5초.** 읽는 쪽은 파일에
적힌 값을 쓰고, 상수를 따로 들고 있으면 안 된다.

**임계값은 최소 3박동.** 집행 중이면 3초다. 예전에 이 자리에 "15초(5초 박동 3번)"라고 적혀 있었고,
근거는 "`SIGKILL` 뒤 launchd가 약 7초에 되살리니 그보다 짧으면 정상 재시작마다 오탐"이었다.
**재측정 결과 그 문장은 숫자가 아니라 결론이 틀렸다**(2026-08-25): 재기동은 5.8초(4/5회, 1회는 21.3초)
이고, 더 중요한 건 **그 구간 내내 커널이 그 시뮬의 트래픽을 통과시킨다**는 것이다 — 회당 23~27건.
NE 프레임워크가 세션을 내리기 전에 5.1초짜리 "filter extension exit timer"를 기다리고, 그 동안
fail-open이다. 15초 임계값은 그 구멍을 **덮는 게 아니라 못 본다** — gap이 임계값보다 먼저 닫히므로
아무것도 보고되지 않고, 테스터는 요청이 성공하는 동안 오프라인 컨트롤을 계속 본다.

읽는 쪽이 판단하는 법:

| 파일 | 뜻 |
|---|---|
| 있고 신선함 | provider가 살아서 `rule`을 집행 중 |
| 있고 3박동 넘게 오래됨 | provider가 죽었다 (재시작 대기 중이거나) |
| 없음 | 필터가 정상 정지했다 (`stopFilter`가 지운다) |

- `rule` — **실행 중인 provider가 실제로 들고 있는 offline 집합.** 저장된 설정이 아니라 집행 중인
  것이라, exit code가 못 하는 말을 한다. 이게 없으면 필터가 죽어도 컨트롤은 "조종 가능"이라고 한다.
- `unresolved` — 귀속이 **실패한** flow. 호스트 flow와 다르다. 여전히 allow하지만(아래) 셀 수 있다.
- `avgMicros` — flow당 부모 walk 비용. 캐시를 붙일지 판단하려면 이 숫자가 먼저다.

**해결 불가 flow는 allow한다.** `sysctl` 일시 오류에 fail-closed하면 사용자 브라우저를 끊는다 — 이
필터는 호스트 전역이고, 기능의 약속은 "토글한 시뮬만 영향받는다"이다. 구멍인 것은 맞고, 그래서
error 레벨로 로그하고 세는 것이다.

## 빌드

```bash
export DEVELOPMENT_TEAM=<10자리 Team ID>
./build.sh
```

**교체가 무응답으로 끝나면 delegate가 수거된 것이다.** `submitRequest`가 반환하고 delegate가 한 번도
안 불린다 — 에러도 거절도 승인 프롬프트도 없다. 호스트가 45초에 끊고 exit 6을 내는 게 유일하게 이걸
보이게 하는 장치다.

`OSSystemExtensionRequest`는 `delegate`를 **weak로 잡는다.** 설치된 확장을 교체할 때 `sysextd`가 앱에게
어느 쪽을 남길지 묻는데(로그의 `requestAppReplaceAction` → `notifying client of activation conflict`),
그 시점에 delegate가 수거돼 있으면 답할 게 없어서 프레임워크가 연결을 끊는다. **최초 설치에서는 안
나온다** — 물어볼 기존 항목이 없기 때문이고, 그래서 반복 빌드를 시작해야 만난다.

```bash
# 실패했을 때의 모습
log show --last 5m --debug --predicate 'process == "sysextd"' | grep -i conflict
```

틀린 추측 두 개를 적어 둔다. 시간을 썼기 때문이다: 누적 14개 / 대기 13개가 원인처럼 보였지만 재부팅으로
1개가 된 뒤에도 다음 교체가 똑같이 멈췄고, `lsregister -f`도 소용없었다. 시스템 상태 문제가 아니었으니
둘 다 도움이 될 수 없었다.

교체마다 이전 버전이 재부팅까지 대기 상태로 남는 건 사실이므로, 편집마다 빌드하지 말고 묶는 편이
낫다. #724 이후로는 `Host/`만 고친 빌드가 교체를 일으키지 않으므로 이 조언은 확장을 건드리는 편집에만
해당한다. 자가호스터는 릴리스당 한 번 설치하므로 이걸 만나지 않는다 — `ios-netfilter`를 건드리는 기여자가
만난다.

`build.sh` 헤더에 one-time 셋업(App ID + NE capability, notarytool 자격증명)이 있다.

**★설치할 때 두 가지를 반드시 지킨다** — 둘 다 어기면 증상이 같다(새 빌드인데 옛 코드가 조용히 돈다):

1. **`CFBundleVersion`을 올린다.** 버전이 같으면 activation이 `result 0`을 돌려주면서도 번들 교체를
   조용히 건너뛴다. xcodegen이 버전을 리터럴로 박아 build setting override가 안 먹으므로 generate 후
   `plutil`이 필수다.

   **호스트와 확장이 각각 다른 규칙을 따른다**(#724). 호스트 앱은 매 빌드 새 epoch을 받는다. 확장은
   자기 입력이 안 바뀌었으면 **버전을 유지한다** — 그래야 `Host/`만 고친 릴리스가 사용자 맥의
   provider를 교체하지 않는다. 교체는 맥의 모든 새 연결을 그 사이 멈추게 하므로 공짜가 아니다.

   확장 입력은 열거된 넷이다 — `Extension/`, `Shared/`, `project.yml`, `build.sh`. 여기에 프로비저닝
   프로파일과 툴체인(`DTXcodeBuild`/`DTSDKBuild`)이 더해진다(#728). "`Host/`가 아니면 전부"가 아니다:
   `README.md`·`shipped.json`·`TapflowNetFilter.xcodeproj/`는 입력이 아니다. `project.pbxproj`는
   xcodegen이 매번 새 식별자로 다시 쓰기 때문에 의도적으로 제외돼 있다.

   `Extension/`이나 `Shared/`를 고쳤다면 버전은 자동으로 오른다. `Host/`만 고쳤다면 안 오른다.
   **그것이 의도한 동작이다** — 확장 바이너리가 같으므로 교체할 것이 없다.

   **`ios-netfilter/` 최상위에 파일을 새로 놓는다면 그것만으로는 입력이 되지 않는다.** 확장 바이너리를
   바꾸는 파일이라면 `scripts/lib/netfilter-artifact.mjs`의 `EXT_SOURCE_FILES`에 이름을 추가해야 한다.

   서명 주체가 바뀌는 경우는 프로파일이 잡는다. 확장 프로파일 안에 `TeamIdentifier`와
   `DeveloperCertificates`가 들어 있어서, 팀을 옮기거나 Developer ID를 교체하면 프로파일이 재발급되고
   바이트가 달라진다. 호스트 쪽 서명이 바뀌는 것은 확장 번들을 건드리지 않는다 — 중첩 서명은 한
   방향이라 호스트가 확장을 봉인하지 그 반대가 아니고, 호스트 앱은 어차피 매 릴리스 교체된다.

   그래도 판정이 못 보는 것이 남을 수 있다. 레포에도 프로파일에도 툴체인에도 안 나타나는 변화라면
   강제한다.

   ```bash
   FORCE_EXT_BUMP=1 ./build.sh
   ```

   판정 자체는 `scripts/netfilter-stamp-version.mjs`가 하고, 답을 못 내면 새 버전을 만든다. 불필요한
   교체는 몇 초를 쓰지만, 바뀐 확장에 버전을 재사용하면 macOS가 교체를 조용히 건너뛰기 때문이다.
2. **컨테이너 앱을 먼저 죽인다.** 이미 실행 중인 앱에 `open`/exec을 하면 `main`을 다시 안 타므로
   `OSSystemExtensionRequest` 자체가 발생하지 않는다.
   ```bash
   pkill -f "TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter"
   ```

확인 세 가지: `systemextensionsctl list`의 활성 버전이 방금 빌드한 값인가, provider pid가 바뀌었나,
`/tmp/tapflow-netfilter-host.log` 마지막 줄 시각이 방금인가.

**단, 확장 버전을 재사용한 빌드에서는 앞의 둘이 안 바뀌는 것이 정상이다.** `Host/`만 고쳤다면 macOS가
activation을 건너뛰므로 활성 버전도 provider pid도 그대로다. 위 ★ 항목의 "새 빌드인데 옛 코드가 조용히
돈다"와 증상이 같지만 원인이 반대다 — 확장을 안 고쳤으니 돌아야 할 옛 코드가 곧 새 코드다. 확장을
고쳤는데도 둘이 안 바뀌었다면 그때가 진짜 문제다. `build.sh` 출력의 `(extension …)` 값이 직전 빌드와
같은지부터 본다.

앱은 `/Applications`에 있어야 activation `code=3`을 피한다. `ditto`로 복사한다(서명 보존).

**notarize가 `timestamps differ by N seconds - check your system clock`으로 실패하면 시계를 만지지
말 것.** 실측 시 시계 오차는 0.14초였고, Apple 타임스탬프 서버 응답이 615초 걸린 것이었다. 재시도로
통과한다.

## 배포 — ad-hoc 불가, 정식 서명 prebuilt

sysext는 다른 헬퍼(`bin/`의 ad-hoc prebuilt)와 달리 **ad-hoc으로 로드되지 않는다**(실측). 그래서:

- **소스는 committed** (xctest-runner처럼), 하지만 **사용자가 빌드하지 않는다** — 서명할 수 없기 때문.
- **프로젝트가 Developer ID로 서명 + notarize한 단일 바이너리**를 배포한다 (LuLu 모델). NE
  content-filter entitlement는 셀프서비스라 별도 Apple 승인 폼은 없다.

## 관측

```bash
log show --start "<시각>" --predicate 'subsystem == "dev.tapflow.netfilter"' --info --debug --style compact
```

**반드시 스크립트 파일에 넣어 실행한다** — zsh가 predicate의 중첩 따옴표를 깨뜨린다. `--info --debug`
없이는 `.default` 레벨도 안 보인다. `log stream`이 아니라 `log show`를 쓰면 **재부팅 전 기록까지**
나온다(unified log는 디스크에 남는다).

## Open Questions

- **배포 매체** — `bin/` committed prebuilt vs CI release asset.
- **에러 코드** — 1층이 주는 것은 `-1005`(연결이 끊김)이고 신호 없는 실기는 `-1009`(인터넷 없음)다.
  앱의 오프라인 분기가 후자로 쓰여 있으면 다른 가지를 탄다.
- **`NENetworkRule` init** — macOS 15에서 deprecated. 지금은 룰 없이 `defaultAction: .filterData`로
  전량을 `handleNewFlow`에 받으므로 쓰지 않는다. 룰 기반으로 좁힐 때 최신 API를 확인할 것.
