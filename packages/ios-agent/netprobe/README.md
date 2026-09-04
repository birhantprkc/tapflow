# netprobe — 오프라인 메커니즘을 서로 구분해서 찍는 앱

`#607`의 네트워크 on/off가 앱에 실제로 전달되는지 재기 위한 도구다. **"앱이 오프라인을 안다"는 하나의
사실이 아니라 넷이고, 넷이 따로 고장 난다.**

| 무엇 | 2층이 훅하나 | 누가 읽나 |
|---|---|---|
| `NWPathMonitor` | 한다 | 현대적인 앱의 오프라인 배너 |
| `SCNetworkReachability` | 한다 (디스패치 큐·run loop **양쪽**) | Alamofire `NetworkReachabilityManager`, 구형 `Reachability.swift` |
| `URLSession` | 못 한다 (커널의 진짜 경로를 읽는다) | 요청 결과로 분기하는 코드 |
| `getaddrinfo` | 한다 | 직접 이름을 푸는 코드 |

각 줄이 넷 중 어느 것인지 이름을 달고 나오므로, 한 번 돌리면 "앱이 알아챘다"가 아니라 **무엇이
움직였는지**를 말한다.

## reachability는 getter와 listener를 따로 찍는다 — 이게 이 파일의 핵심

Alamofire 같은 소비자는 폴링하지 않는다. 콜백을 등록하고, 콜백이 말해준 것을 캐시하고, 콜백이 발화할
때만 다시 계산한다. 그래서 **getter만 훅하면 `getter=`는 움직이고 `listener=`는 그대로다.** 둘이
어긋나는 것이 콜백 재발화가 없다는 증상이고, 둘이 맞는 것이 그것이 들어갔다는 증거다.

```
sc getter=NOT-reachable listener=reachable fires=1   <-- DISAGREE: the callback has not re-fired
```

**이 줄이 지금 나온다면 둘 중 하나다** — dylib이 무장되지 않았거나(`TAPFLOW_TARGET_BUNDLE` 미설정),
reachability 훅 세트가 설치에 실패했거나(`log`에 `reachability hooks NOT installed`). 훅이 붙어
있으면 이 줄은 안 나온다.

프로브는 **리스너를 둘** 띄운다. 하나는 디스패치 큐로, 하나는 run loop로 스케줄한다. 두 경로가
따로 훅되므로, 하나만 시험하면 덮인 API를 덮였다고 보고하면서 다른 하나가 조용히 아무것도 안 하는
상태를 놓친다.

## 쓰는 법

```bash
./build.sh <booted-udid>
xcrun simctl launch --console <udid> dev.tapflow.netprobe
```

2층 무장과 오프라인 전환은 `build.sh` 헤더에 있다. **오프라인은 condition 파일만 만들어서** 하는 것을
권한다 — 1층 룰을 건드리지 않으므로 실행 중인 에이전트의 상태와 어긋나지 않는다.

## 왜 커밋되어 있나

앞선 프로브(`TFNetProbe`)는 `#607` 작업 중에 만들어졌고 **커밋되지 않았다.** 네트워크 패리티 조사의
숫자가 전부 거기서 나왔는데, 남은 것은 맥 한 대의 서명 없는 바이너리 하나였고 아무도 그 측정을 재현할
수 없었다. 빌드 산출물은 여전히 커밋하지 않는다 — 소스와 레시피만 있으면 된다.
