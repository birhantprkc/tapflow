# 문제 해결

## 에이전트 연결 문제

### 이미 에이전트가 실행 중이라고 나옴 {#agent-already-running}

`tapflow agent start`가 **AGENT ALREADY RUNNING**으로 멈추면, 그 맥에서 같은 플랫폼의 tapflow 에이전트가 이미 돌고 있다는 뜻입니다.

에이전트 하나가 그 맥의 시뮬레이터를 **전부** 관리합니다. 시뮬레이터를 여러 대 띄우고 팀원 여럿이 각자 하나씩 잡고 동시에 테스트하는 것은 에이전트 하나로 하는 일이고, 지금도 그대로 됩니다. 두 번째 에이전트를 띄우는 것은 그것과 다른 일입니다. 같은 기기 목록과 같은 네트워크 필터를 두고 첫 번째와 다투게 되고, 릴레이도 둘을 같은 에이전트로 봅니다.

돌고 있는 쪽을 멈추거나, 그쪽이 이미 제공하는 세션을 쓰세요.

### 에이전트가 릴레이에 연결되지 않음

1. 릴레이가 실행 중인지 확인합니다.
2. `--relay` 옵션의 URL이 `ws://`인지 확인합니다. 에이전트는 항상 내부 네트워크로 연결합니다.
3. `tapflow doctor`를 실행해 환경을 점검합니다.

## 빌드를 열면 `spawn unknown error`가 납니다 {#spawn-unknown-error}

먼저 Mac의 아키텍처를 확인하세요.

```bash
uname -m        # arm64면 Apple Silicon, x86_64면 Intel
```

`x86_64`가 나오면 **Intel Mac이고 에이전트가 지원하지 않는 환경**입니다. 네이티브 헬퍼 바이너리가
arm64 전용이라 macOS가 실행을 거부하고(`EBADARCH`), Node가 그것을 `Unknown system error -86`으로
올려보내면 대시보드에 `spawn unknown error`로 표시됩니다.

현재 에이전트 쪽 우회 방법은 없습니다. 에이전트를 Apple Silicon Mac에서 실행하세요. 릴레이와
대시보드에는 이 제약이 없으므로 시뮬레이터를 구동하는 머신만 바꾸면 됩니다.

Intel 지원은 가능하고 [#464](https://github.com/jo-duchan/tapflow/issues/464)에서 다루고 있습니다.
유니버설 빌드가 필요하고 메인테이너가 갖고 있지 않은 하드웨어에서 검증해야 해서 예정에는 없습니다.
[시스템 요구사항](/ko/guide/requirements#에이전트)도 참고하세요.

`uname -m`이 `arm64`를 출력하면 다른 문제입니다. 헬퍼 파일이 없거나 실행 권한이 없을 때도 같은
메시지가 나오므로, 에이전트 패키지가 온전히 설치됐는지 확인하세요.

## iOS 시뮬레이터 서비스 버전 불일치 {#ios-simulator-service-version-mismatch}

Xcode를 업데이트한 후 다음과 같은 macOS 알림이 표시될 수 있습니다:

> "Loaded CoreSimulatorService is no longer valid for this process … Service version (X) does not match expected service version (Y)."

tapflow는 이 오류를 자동으로 감지해 서비스를 재시작합니다. 자동 복구에 실패하면 (재시도 후에도 알림이 계속 표시되면) 아래 명령어를 직접 실행하세요:

```sh
killall -9 com.apple.CoreSimulator.CoreSimulatorService
```

`launchd`가 즉시 서비스를 재시작합니다. 이후 `tapflow start`를 다시 실행하면 됩니다.

::: details 발생 원인
Xcode 업데이트 시 새 버전의 `CoreSimulator.framework`가 설치되지만, 이전 세션에서 기동한 `CoreSimulatorService` 데몬은 그대로 남아 있습니다. `xcrun simctl`이 버전 불일치를 감지하면 tapflow가 데몬을 강제 종료해 `launchd`가 새 버전으로 재시작하도록 유도합니다. 데몬이 멈춰 있어 첫 번째 시도에 종료되지 않으면 위의 수동 명령어가 필요합니다.
:::

## iOS 시뮬레이터가 부팅되지 않음 — "cannot be located on disk" {#simulator-data-missing}

Xcode나 macOS 업데이트가 오래된 런타임을 정리하면, 시뮬레이터가 목록에는 남아 있지만 디스크의 데이터 디렉토리는 사라진 상태가 될 수 있습니다. `simctl list`에는 여전히 사용 가능으로 표시되지만 부팅은 실패합니다:

> Unable to boot device because it cannot be located on disk. The device's data is no longer present …

tapflow는 이 상황을 자동으로 복구합니다. 대시보드에서 해당 디바이스를 열면 에이전트가 깨진 시뮬레이터를 erase해 데이터를 다시 생성한 뒤 부팅을 한 번 재시도합니다. 정상 시뮬레이터는 절대 erase하지 않습니다.

자동 복구로 해결되지 않으면 남아 있는 디바이스를 직접 정리하세요. 아래 명령은 런타임이 사라진 시뮬레이터를 삭제합니다:

```sh
xcrun simctl delete unavailable
```

특정 시뮬레이터만 계속 실패하면 UDID로 삭제한 뒤 Xcode가 새로 만들도록 둡니다:

```sh
xcrun simctl delete 822F00B0-D9CF-4B78-8EDD-6322974E4079
```

## iOS 17 이하 — 한글 입력 시 자모 분리

iOS 17 이하 시뮬레이터에서 한글을 입력하면 음절로 조합되지 않고 자모가 분리됩니다 (예: "안녕" → "ㅇㅏㄴㄴㅕㅇ").

이는 iOS 시뮬레이터의 IME 처리 버그로, tapflow가 아닌 iOS 시뮬레이터 자체의 문제입니다. 시스템 앱(메시지 등)에서도 동일하게 재현됩니다.

**iOS 18 이상 시뮬레이터 런타임으로 업그레이드하세요.**  
Xcode → Settings → Platforms에서 iOS 18+ 런타임을 설치합니다.

::: details 레퍼런스
- [React Native #41494](https://github.com/facebook/react-native/issues/41494)
- [Flutter #135825](https://github.com/flutter/flutter/issues/135825)
:::

## iOS 빌드 업로드 오류

### 업로드 시 `400` 오류

| 원인 | 해결 방법 |
|------|-----------|
| `.ipa` 파일 업로드 | `.ipa`는 실제 기기용입니다. `xcodebuild -sdk iphonesimulator`로 빌드 후 `.app` 폴더를 zip으로 압축하세요 |
| `.app`이 ZIP 루트에 없음 | 압축 해제 시 `MyApp.app`이 바로 나와야 합니다. 상위 폴더로 감싸면 파싱에 실패합니다 |
| 디바이스용 슬라이스만 포함 | 시뮬레이터용 빌드인지 확인합니다. `lipo -info MyApp.app/MyApp` 출력에 `x86_64` 또는 `arm64`(시뮬레이터)가 있어야 합니다 |

## Android 에뮬레이터 문제

### 스트림이 시작되지 않거나 인코더 크래시

대개 AVD가 테스트되지 않은 `google_apis_playstore` 이미지를 사용할 때 발생합니다. 테스트된 `google_apis/arm64-v8a` 이미지로 AVD를 다시 생성하세요.

```sh
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n Pixel_8 -k "system-images;android-34;google_apis;arm64-v8a"
```

### `INSTALL_FAILED_NO_MATCHING_ABIS` — Apple Silicon 에뮬레이터와 호환되지 않는 APK

```
INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113
```

Apple Silicon Mac(M1/M2/M3)의 Android 에뮬레이터는 네이티브 ARM64 환경에서 동작합니다. APK에 `arm64-v8a` ABI가 포함되어 있어야 합니다.

APK가 지원하는 ABI를 확인합니다:

```sh
aapt dump badging your-app.apk | grep native-code
```

| 결과 | 호환 여부 |
|------|-----------|
| `native-code: 'arm64-v8a'` | ✅ |
| `native-code: 'armeabi-v7a' 'arm64-v8a'` | ✅ |
| `native-code: 'armeabi-v7a' 'x86'` | ❌ |
| `native-code: 'x86' 'x86_64'` | ❌ |

`arm64-v8a`가 없다면 32비트 ARM 또는 Intel 에뮬레이터용으로 빌드된 APK입니다. 개발팀에 ABI split 설정에 `arm64-v8a`를 추가해 달라고 요청하세요.

::: details ABI 참고

| ABI | 아키텍처 | Apple Silicon 에뮬레이터 |
|-----|---------|------------------------|
| `arm64-v8a` | 64비트 ARM | ✅ 필수 |
| `armeabi-v7a` | 32비트 ARM | ❌ |
| `x86_64` | 64비트 Intel | ❌ |
| `x86` | 32비트 Intel | ❌ |

:::

### APK 업로드가 'Unversioned'로 표시되거나 다른 앱에 병합됨

APK의 앱 이름·버전·패키지 이름은 릴레이가 Android build-tools의 `aapt`로 읽습니다. build-tools가 없으면 이 정보를 읽지 못해 빌드가 버전·패키지 없이 저장됩니다.

- `app_id`를 지정한 업로드는 이 경우 `400`으로 거절됩니다. 정체를 알 수 없는 빌드가 지정한 앱에 섞여 들어가지 않도록 막는 것입니다.
- `tapflow doctor`의 Android 항목에서 `aapt (build-tools)`가 경고로 표시되면 이 상태입니다.

릴레이를 실행하는 머신에 build-tools를 설치하면 해결됩니다.

```sh
tapflow setup android
```

`tapflow setup`을 이미 돌린 적이 있다면 다시 실행해 build-tools를 채웁니다. 수동으로 설치할 때는 `sdkmanager --sdk_root="$ANDROID_HOME" "build-tools;35.0.0"`을 씁니다.

build-tools가 이미 있는데도 지정 업로드가 계속 `400`이면, APK 자체가 손상됐거나 올바른 패키지가 아닐 가능성이 큽니다. 다시 빌드하거나 재추출하세요. 정상 APK라면 `aapt dump badging your-app.apk`가 `package: name=...` 줄을 출력합니다.

### 색이 에뮬레이터와 다르게 보임 (채도가 낮음)

tapflow 화면의 색이 Android 에뮬레이터 창보다 채도가 약간 낮아 보일 수 있습니다. **이는 정상이며, 오히려 tapflow가 원본에 더 가까운 색을 보여줍니다.**

- **tapflow** — 에이전트가 보내는 H.264 스트림의 픽셀 값을 그대로 렌더링합니다. 즉 디자인 원본(Figma 등)에 가깝습니다.
- **에뮬레이터 창** — 화면에 그릴 때 디스플레이 색 처리를 한 번 더 거치면서 원본보다 채도를 높여 표시합니다.

따라서 디자인 색상 검수에는 **tapflow가 더 신뢰할 수 있는 레퍼런스**입니다.

::: details 실측 예시
컬러 피커로 평평한 단색 주황 스와치를 측정한 결과:

| 원본(Figma) | tapflow | 에뮬레이터 |
|-------------|---------|-----------|
| `#FF8000` (G=128) | `#FF7700` (G=119) | `#FF6C00` (G=108) |

tapflow(G=119)가 원본(G=128)에 더 가깝고, 에뮬레이터(G=108)는 원본에서 더 많이 벗어나 더 진한 주황으로 보정합니다.

검정(`#000000`)·흰색(`#FFFFFF`)·순수 R/G/B는 세 곳 모두 동일합니다 — 차이는 중간톤 채도에만 나타나며, 스트림이 손상된 것이 아닙니다.
:::

### 무인 상태에서 에뮬레이터가 느려짐

tapflow는 에이전트가 실행되는 동안 호스트 Mac의 idle sleep을 자동으로 차단합니다(`caffeinate -i`). 에이전트가 연결되면 어서션을 획득하고, 종료될 때 해제합니다.

그래도 무인 상태에서 에뮬레이터가 느리다면 아래 두 가지를 확인하세요.

| 확인 항목 | 이유 |
|-----------|------|
| **전원 어댑터 연결** | 배터리 모드에서는 macOS가 CPU 성능을 낮춥니다. `caffeinate`는 이 스케일링을 막지 못합니다. |
| **노트북 덮개가 열려 있는지** | 덮개를 닫으면 macOS가 클램셸 잠자기로 전환합니다. 클램셸 잠자기는 `caffeinate`로도 막을 수 없습니다. |

## iOS: 네트워크 확장이 설치되지 않았습니다 {#network-not-set-up}

iOS 시뮬레이터에서 네트워크 제어를 하려면 에이전트 맥에 tapflow 네트워크 확장이 설치돼 있어야 합니다. **확장은 tapflow와 함께 오므로 따로 내려받지 않습니다.** 아래 명령이 패키지에 들어 있는 확장을 설치합니다.

### 1. 설치

처음 설정하는 맥이라면 iOS 셋업이 확장까지 함께 처리합니다.

```sh
tapflow setup ios
```

이미 tapflow를 쓰던 맥이라면 셋업을 다시 돌리지 않으므로 별도 명령을 씁니다. 확장이 없던 시절에 설정한 맥이 여기 해당합니다.

```sh
tapflow migrate net-filter
```

### 2. 승인

설치를 요청하면 macOS 승인 창이 뜹니다.

**시스템 설정 → 일반 → 로그인 항목 및 확장 프로그램 → 네트워크 확장**에서 tapflow 항목을 켭니다. (관리자 암호가 필요합니다.)

승인은 맥 앞에서만 할 수 있습니다. 브라우저에서 누를 수 있는 대체 경로는 macOS가 제공하지 않습니다.

### 3. 재시작이 필요한 경우

이미 설치된 확장을 교체하면 맥을 재시작해야 완료됩니다. **재시작 전까지는 이전 버전이 계속 동작합니다.** 파일은 새 것인데 macOS가 실행 중인 것은 옛 것인 상태라, 대시보드는 여전히 준비되지 않았다고 말합니다.

### 무엇이 설치돼 있는지 확인

```sh
tapflow doctor ios
```

네 가지를 따로 말합니다. **설치돼 있는가**, **승인됐는가**, **켜져 있는가**, 그리고 **이 맥의 버전들이 이 tapflow가 싣고 온 것과 같은가**. 뒤의 두 항목이 따로 있는 이유는 앞의 것들이 다 맞는데도 동작하지 않는 상태가 있기 때문입니다 — 교체 직후 재시작 전이 하나입니다. 필터가 꺼져 있는 경우가 다른 하나입니다. 꺼져 있는 상태는 자기 버전이 없습니다. 확장은 활성으로 남으므로 버전은 전부 맞게 읽히는데 아무것도 필터링되지 않습니다.

**버전을 가진 것은 둘입니다.** `/Applications`의 앱과 그 안의 시스템 확장입니다. 둘은 따로 움직입니다. 앱만 바뀐 릴리즈가 돌아가는 필터를 교체할 이유는 없기 때문입니다. 검사는 뒤처진 쪽을 지목하고, 각각 할 일이 다릅니다.

| 무엇이 뒤처졌다고 하나 | 할 일 |
|---|---|
| `/Applications`의 앱 | `tapflow migrate net-filter`. 앱만 복사되고 macOS는 활성화를 건너뛰므로 아무것도 끊기지 않습니다. 에이전트가 그 바이너리를 실행하므로 낡은 앱은 문제가 됩니다 |
| 확장, 재시작 안내와 함께 | 맥을 재시작하세요. 교체본은 이미 설치돼 있고 그때 끝납니다 |
| 확장, 재시작 안내 없이 | `tapflow migrate net-filter` |
| 이 맥이 더 새 tapflow용이다 | 대신 이 체크아웃을 최신으로 올리세요. 그 방향은 migrate가 거부합니다. 새 필터를 덮어쓰면 그것에 기대는 에이전트가 망가지기 때문입니다 |

**앱은 지워졌는데 확장이 아직 돌고 있으면 tapflow는 재설치를 거부합니다.** 확장 버전은 어떤 필터가 도는지를 말할 뿐 그 앱이 무엇이었는지는 말하지 않습니다. 그래서 그 맥이 여기보다 새 tapflow로 설정됐는지 알 방법이 없습니다. 덮어쓰면 누군가 기대고 있을지 모를 동작 중인 필터를 교체하게 됩니다. 버전이 맞는 tapflow에서 재설치하거나, 확장을 정리하고 새로 시작하세요.

```sh
systemextensionsctl uninstall 6FBS3QP893 dev.tapflow.netfilter.ext
```

### 그래도 안 될 때

설치는 실패 종류마다 다른 코드로 끝납니다.

| 코드 | 뜻 |
|---|---|
| 1 | 활성화 실패 |
| 2 | 설정을 읽지 못함 |
| 3 | 설정을 저장하지 못함 |
| 4 | 120초 안에 승인되지 않음. 시스템 설정에서 승인하고 다시 실행하세요 |
| 5 | 맥을 재시작해야 완료됩니다 |
| 6 | 시스템 확장 관리자가 45초 안에 응답하지 않음 |
| 7 | 실행 중인 필터에게서 답을 받지 못함 |

확장이 무엇을 보고 무엇을 보지 않는지는 [네트워크 제어](/ko/guide/network-control#무엇을-신뢰하게-되는가)에 있습니다.

## iOS: 필터를 교체하는 중에 맥의 네트워크가 끊겼습니다 {#network-lost-on-replace}

이 필터는 시뮬레이터 것만이 아니라 **맥이 새로 맺는 모든 연결**을 판정합니다. 필터가 켜져 있는 상태에서 멈추면 macOS는 검사받지 않은 트래픽을 흘려보내는 대신 전부 막습니다. 필터로서는 안전한 선택이고 쓰는 입장에서는 갑작스러운 일입니다. 확장을 교체하는 동안 필터가 잠깐 멈춥니다. 그래서 교체할 때 이 일이 생깁니다.

증상은 느려짐이 아니라 즉시 실패입니다. 오래 기다리는 것이 아니라 **`No route to host`**가 바로 뜹니다. 이미 열려 있던 연결은 그대로 동작하므로 브라우저는 멈췄는데 다른 것은 멀쩡해 보이는 상태가 됩니다.

`tapflow migrate net-filter`는 확장을 건드리기 전에 필터를 먼저 끄므로 이런 일이 일어나지 않습니다. 그래도 일어난다면 필터가 꺼져 있다고 명령이 알려줍니다. 그 상태에서 네트워크는 정상이고 iOS 네트워크 제어만 빠져 있습니다.

**네트워크를 되살리는 데 재시작은 필요 없습니다.**

```sh
/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter --off
```

필터를 경로에서 빼면 트래픽이 돌아옵니다. 필터를 다시 켤 때까지 iOS 네트워크 제어는 쓸 수 없습니다. 마이그레이션을 다시 돌리면 켜집니다.

```sh
tapflow migrate net-filter
```

## iOS: 오프라인이던 기기가 스스로 온라인으로 돌아왔습니다 {#network-stopped}

오프라인으로 두고 확인하던 중에 기기가 다시 온라인이 됐다는 알림이 뜨면, **그때까지 확인한 오프라인 동작은 다시 확인해야 합니다.** 알림이 뜬 시점과 실제로 트래픽이 통과하기 시작한 시점 사이에 요청이 성공했을 수 있기 때문입니다.

에이전트 맥에서 트래픽을 막던 필터가 멈췄습니다. 확장이 시스템 설정에서 꺼졌거나, 죽은 필터 프로세스를 macOS가 다시 띄우는 중입니다. 다시 뜨는 데는 보통 6초 남짓 걸리며 그동안에는 아무것도 막히지 않습니다.

**확인**

```sh
systemextensionsctl list
```

`dev.tapflow.netfilter.ext`가 `[activated enabled]`가 아니면 [설치·승인 절차](#network-not-set-up)로 돌아가세요.

켜져 있는데도 같은 일이 반복된다면 필터 프로세스가 계속 죽고 있습니다.

```sh
log show --last 10m --predicate 'subsystem == "dev.tapflow.netfilter"' --info --debug --style compact
```

**대처**

기기를 다시 오프라인으로 두고 확인을 처음부터 다시 하세요. 필터가 돌아왔다면 버튼은 정상으로 그려집니다. 계속 같은 알림이 뜨면 그 맥에서는 오프라인 확인을 신뢰할 수 없으므로, 원인을 잡기 전까지는 다른 에이전트 맥을 쓰는 편이 낫습니다.

로그는 `/tmp/tapflow-netfilter-host.log`에 있습니다.

기능 자체는 [네트워크 제어](/ko/guide/network-control)를 참고하세요.

## `tapflow doctor` 실패

### iOS 항목이 모두 실패함

iOS 에이전트는 macOS에서만 실행됩니다 (Apple 정책). Linux나 Windows에서는 iOS 에이전트를 시작할 수 없습니다.

### `Xcode not found` — Xcode가 설치되어 있지 않은 경우

Mac App Store 또는 Apple Developer 사이트에서 Xcode를 설치한 뒤 아래 명령어를 실행합니다:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

### `Xcode not found` — Xcode는 설치되어 있지만 `xcode-select`가 설정되지 않은 경우

Mac App Store에서 Xcode를 설치한 후 흔히 발생합니다. Xcode는 있지만 개발자 도구 경로가 등록되지 않은 상태입니다:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

이후 `tapflow doctor`를 다시 실행해 체크가 통과되는지 확인합니다.

### 실행 중인 시뮬레이터가 없는 경우

부팅된 시뮬레이터가 없으면 `tapflow doctor`에서 경고를 표시합니다. 이 경고는 `tapflow start` 실행을 막지 않으며 참고용입니다.

시작 전에 시뮬레이터를 미리 부팅하려면:

```sh
tapflow devices        # 사용 가능한 시뮬레이터 목록 확인
tapflow boot "iPhone 16 Pro"
```

### `adb not found`

Android Studio는 설치되어 있지만 `adb`가 `$PATH`에 없는 경우입니다. 셸 프로필에 Android SDK `platform-tools` 경로를 추가합니다:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

`~/.zshrc`(또는 `~/.bashrc`)에 위 내용을 추가하면 영구적으로 적용됩니다. 추가 후 `source ~/.zshrc`를 실행합니다.

## 세션 관련

### 세션이 자동으로 종료됨

30분 동안 브라우저 입력이 없으면 세션이 자동 종료됩니다. 현재 이 값은 설정에서 변경할 수 없습니다. 대시보드에서 재연결하면 됩니다.

## 스트림 지연·끊김 {#stream-lag}

원인은 보통 셋 중 하나입니다: 에이전트와 릴레이 사이 네트워크, 에이전트 Mac의 자원, 디스플레이 절전.

### LAN 유선 권장

에이전트는 릴레이로 영상 프레임을 끊임없이 전송하므로, 둘 사이 연결이 기본 매끄러움을 좌우합니다. **릴레이와 에이전트 머신은 유선 이더넷을 권장**합니다. Wi-Fi도 동작하지만 지연과 지터가 늘고, 특히 릴레이 Mac에서는 아래의 주기적 끊김을 일으킬 수 있습니다.

### Wi-Fi에서 약 0.5초 주기로 끊기는 경우 (AWDL)

Wi-Fi에서 스트림이 일정한 리듬으로(대략 초당 두 번) 끊긴다면 **AWDL**(Apple Wireless Direct Link)이 원인일 가능성이 높습니다. AirDrop·AirPlay·Handoff·Sidecar를 담당하는 인터페이스로, 주기적으로 Wi-Fi 채널을 옮겨 다니며 그때마다 데이터 채널을 약 90ms씩 비웁니다. 이것이 톱니 모양 지연과 눈에 보이는 끊김으로 나타납니다.

확실한 해결책은 **유선 연결**입니다. 이더넷이면 데이터가 무선을 타지 않으므로 AWDL과 무관해집니다.

Wi-Fi를 써야 한다면 시스템 설정에서 AWDL을 잠재울 수 있습니다(되돌리기 쉽고 관리자 권한도 필요 없습니다):

- **AirDrop** → "받지 않음"
- **AirPlay 수신 모드** → 끄기 (시스템 설정 → 일반 → AirDrop 및 Handoff)
- **Handoff** → 끄기 (같은 패널)
- **Bluetooth** → 끄기

AWDL은 트리거(AirDrop 검색·AirPlay 수신·Handoff·Bluetooth 근접)가 있을 때만 채널을 옮깁니다. 위 항목을 끄면 잠잠해집니다.

원인 확인은 릴레이 Mac에서 라우터로 촘촘한 간격의 ping을 보내 톱니가 보이는지로 합니다. `ping -i 0.01 <router-ip>`를 돌려 보고, 유선으로 바꿨을 때 톱니가 사라지면 AWDL이 맞습니다.

::: tip 고급: awdl0 직접 끄기
`sudo ifconfig awdl0 down`은 세션 동안 AWDL을 끕니다. 일시적이고(재부팅하거나 다음에 AirDrop을 쓰면 복구됩니다) 관리자 권한이 필요하므로, 위 토글이나 유선을 먼저 쓰세요.
:::

### 호스트 CPU·RAM 부족

시뮬레이터와 H.264 인코더가 자원을 많이 씁니다. 에이전트 Mac이 빠듯하면(특히 메모리 압박 시) 캡처와 인코딩이 밀립니다.

- 대시보드 **Mac Resources** 탭에서 해당 Mac의 CPU·RAM 사용량을 확인합니다.
- 릴레이와 에이전트를 **다른 Mac으로 분리**해 자원 경쟁을 없앱니다(에이전트 확장에도 유리합니다).
- 한 Mac에서 동시에 실행하는 디바이스 수를 줄입니다.

### 디스플레이 절전

에이전트는 기본적으로 세션이 활성인 동안 호스트 디스플레이를 깨어 있게 유지합니다. 디스플레이가 꺼지면 GPU가 저전력으로 묶여 시뮬레이터가 느려지기 때문입니다. `TAPFLOW_ALLOW_DISPLAY_SLEEP=1`을 설정했다면 디스플레이가 꺼질 때 스트림이 느려질 수 있습니다. [에이전트 설정](/ko/guide/agent#호스트-디스플레이와-절전)을 참고하세요.

### LAN에서 화면이 흐리거나 해상도가 낮은 경우

평문 HTTP의 LAN 연결은 **Standard** 프로파일을 사용하며, WASM 디코더의 반응성을 유지하기 위해 스트림을 1280px(가장 긴 변)로 제한합니다. 시뮬레이터 원본 해상도로 스트리밍하려면 릴레이를 HTTPS로 제공하세요 — 그러면 **Smooth** 프로파일(하드웨어 디코딩, 원본 해상도)로 전환됩니다. [릴레이 배포](/ko/guide/self-hosting) 참고. HTTPS 없이 제한값만 높이려면 에이전트에서 `TAPFLOW_MAX_SIZE_LAN` 환경변수를 설정합니다 — [스트림 품질](/ko/guide/streaming) 참고.

## 인증 관련

### `tapflow init` 실패 (`ALREADY INITIALIZED`)

현재 디렉토리에 `tapflow.config.json`이 이미 존재합니다. `--force` 옵션을 사용해 덮어쓰거나, 기존 파일을 직접 편집하세요.

### `tapflow admin init` 실패 (`Already initialized`)

릴레이에 이미 관리자 계정이 존재합니다. 대시보드에 로그인한 뒤 **Settings → Team**에서 팀원을 초대하세요.

### 초대 링크가 만료됨

초대 링크는 **7일** 후 만료됩니다. Admin이 **Settings → Team**에서 새 초대를 발송해야 합니다. SMTP가 설정되지 않은 경우 API 응답의 `token` 값을 직접 복사해 링크를 공유할 수 있습니다.

### 비밀번호 재설정 링크가 만료됨

비밀번호 재설정 링크는 **2시간** 후 만료됩니다. Admin이 **Settings → Team → 회원 선택 → 비밀번호 재설정 발송**으로 새 링크를 요청할 수 있습니다.

## 로그 확인

릴레이의 동작 로그를 확인하려면:

```sh
tapflow logs
tapflow logs --lines 200
```
