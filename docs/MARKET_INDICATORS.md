# Market indicators

The worker stores provider observations independently from company stock candles. `MarketInstrumentEntity` holds the fixed catalog; `MarketObservationEntity` holds only actual provider observations. Startup never creates sample prices.

## 화면 구성

메인은 KST 오전 6시부터 오후 6시 전까지 국내, 오후 6시부터 다음 날 오전 6시 전까지 미국을 기본으로 표시합니다. 국내·미국 탭의 직접 선택과 URL·뒤로가기를 유지하며, 다음 오전/오후 6시 경계에서는 자동 전환합니다. 백그라운드에서 돌아온 화면도 경계를 다시 확인합니다. 원자재·가상자산 요약은 별도로 표시합니다. 홈 요약과 시장 목록에서 금 🟡, 은 ⚪, WTI 🛢️, 비트코인 🪙, 이더리움 💎을 이름과 함께 표시하며 접근성 이름은 기존 명칭을 유지합니다.

시장 메뉴의 전체 탭은 모든 화면 크기에서 **국내 → 미국 → 원자재·가상자산** 순서로 위아래 배치합니다. 공통 footer의 데이터 출처·신선도 링크는 `/sources`로 연결하며, 승인된 회원과 관리자가 이 페이지에서 커넥터 상태와 로고 출처를 함께 확인합니다. 상태 조회는 저장된 정보만 읽고 공급자를 새로 점검하지 않습니다.

시장 카드와 상세 차트는 원화 `₩`, 달러 `$`를 수치 바로 앞에 붙입니다. 원자재는 가격 뒤에 `/oz` 또는 `/배럴` 계열 물리 단위를 유지하고, 가상자산 참고 환산가도 `≈ $금액`으로 표시합니다. 원천 데이터의 `KRW`·`USD` 코드와 환산 계산은 그대로 사용합니다.

Native 카드·홈 요약·상세 화면의 표시 시각은 실제 수집 시각인 `observedAt`을 KST로 변환한 값입니다. 화면에는 시각만 표시하며 `자료 기준` 문구와 `최근 관측` 배지는 표시하지 않습니다. 공급자 시각·원본 기준일은 tooltip과 접근성 설명에서 수집 시각과 구분해 보존합니다. `observedAt`이 없으면 `수집 시각 확인 전`으로 표시하고, 지연·미설정·이용 불가 상태는 유지합니다.

Native 카드의 시각 메타데이터는 좌측 하단에 9px로 배치합니다. 홈 원자재·가상자산 금액은 줄바꿈하지 않으며, 좁은 화면에서는 원자재 물리 단위를 별도 줄에 맞춰 제목·가격·등락률의 상단 정렬을 유지합니다. 상세 가격은 320px 화면에서도 들어가도록 반응형 글꼴 크기를 사용합니다. Compact 카드 padding 10px와 위젯 host 높이 90px 적용 후, 데스크톱 미국 지수 카드 높이는 브라우저 실측에서 154px에서 134px로 줄었습니다.

미국 지수 요약은 기존 TradingView Single Ticker Web Component를 유지합니다. 내부 `bottom-link`는 closed shadow root 안에 있고, 확인한 배포본에는 이 링크의 글꼴 크기·정렬을 바꾸는 공개 part나 CSS token이 없습니다. 따라서 Orsem이 직접 렌더링하는 fallback 출처 링크만 9px·좌측 정렬을 적용했으며, 위젯 내부 출처 링크의 좌측 하단 배치까지 완료한 것은 아닙니다. [공식 스타일 지원 범위](https://www.tradingview.com/widget-docs/tutorials/web-components/styling-and-themes/), [확인한 위젯 배포 코드](https://widgets.tradingview-widget.com/w/en/chunks/QOcR3kBDb5.js)

2026-09-04 브라우저 비교에서는 `FRED:SP500`을 설정한 classic [Single Quote](https://s3.tradingview.com/external-embedding/embed-widget-single-quote.js)와 [Tickers](https://s3.tradingview.com/external-embedding/embed-widget-tickers.js)가 값을 `7.75K`로 축약한 반면, 현재 Web Component는 `7,747.71`로 표시했습니다. 이는 해당 시점의 실제 표시 관측이며 공급자의 고정된 형식 보장은 아닙니다. 정확한 수치를 읽을 수 있는 현재 컴포넌트를 유지합니다.

## Sources and meaning

| Instruments              | Request source                                                                           | Stored history                                                                                 | Configuration                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| KOSPI, KOSDAQ            | Toss `/api/v1/market-indicators/prices` and `/api/v1/market-indicators/{symbol}/candles` | Provider daily close, KST source date                                                          | Existing Toss OAuth credentials and shared Redis token |
| USD/KRW                  | Toss `/api/v1/exchange-rate`, base USD / quote KRW                                       | Last observed rate per KST date, beginning when collection starts                              | Existing Toss credentials                              |
| BTC, ETH                 | Bithumb `/v1/ticker` and `/v1/candles/days`, `KRW-BTC` / `KRW-ETH`                       | Provider daily candles, preserving `candle_date_time_kst`                                      | None                                                   |
| US Treasury 2Y, 10Y      | U.S. Treasury annual XML feed, `BC_2YEAR` / `BC_10YEAR`                                  | Published daily yield in percent                                                               | None                                                   |
| Gold, silver             | Gold API `/price/XAU` / `/price/XAG`                                                     | `/history` with explicit `groupBy=day` and `aggregation=avg`; daily average USD per troy ounce | Quotes need no key; history needs `GOLD_API_KEY`       |
| WTI                      | EIA `/v2/seriesid/PET.RWTC.D`                                                            | Cushing spot price, daily USD per barrel                                                       | `EIA_API_KEY`                                          |
| S&P500, Nasdaq Composite | TradingView `FRED:SP500` / `FRED:NDQCOM` official widgets                                | Original index daily close; no worker ingestion or extraction                                  | None                                                   |

USD/KRW is the provider's reference rate, not an executable FX quote. `basisPoint` is not used as a day-over-day change. Its `validFrom`/`validUntil` and original fields remain in provenance. The app converts Bithumb KRW quotes to USD separately using this rate and labels the result as a conversion.

Gold historical points are daily averages, not closing prices. Treasury and EIA expose date-only publications here, so `providerAt` remains null rather than inventing a release time. EIA missing values and Treasury null yields are skipped; negative WTI observations remain valid.

## Rollout findings: timestamps and index links

As checked on 2026-09-04, the [official Toss OpenAPI v1.2.14 contract](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json) limits every Market Indicators endpoint to `KOSPI`, `KOSDAQ`, and six `KR_BOND_*` tenors (2, 3, 5, 10, 20, and 30 years). S&P500 and Nasdaq Composite are outside this catalog; unsupported symbols return HTTP 400 `unsupported-symbol`. Symbols used by Toss's own website are not documented replacements for this public API catalog. This is a provider limitation in addition to Orsem's current domestic-index parser scope.

Toss allows the market-indicator quote `timestamp` to be missing or null. A valid price remains usable in that case, but both `providerAt` and `sourceDate` stay null. The UI identifies its observed time instead of presenting ingestion time as the provider's timestamp. No source date, previous-day reference date, or daily change is inferred from a null timestamp. Daily candles still use their explicit provider timestamps. See the [Toss OpenAPI contract](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json).

The Bithumb REST endpoint is documented at [현재가(Ticker) 조회](https://apidocs.bithumb.com/reference/%ED%98%84%EC%9E%AC%EA%B0%80-%EC%A1%B0%ED%9A%8C). During public-response rollout verification, some `trade_timestamp` values were nine hours apart from the explicit trade date/time fields. This is an observed response inconsistency, not a rule to subtract nine hours from every timestamp. The adapter therefore prefers `trade_date` + `trade_time` as UTC and checks that `trade_date_kst` + `trade_time_kst`, when supplied, represents the same instant in KST. Inconsistent explicit fields are rejected. If only the KST pair is present it is used; `trade_timestamp` is the fallback only when neither explicit pair exists. The original fields are retained unchanged, and `rawMetadataJson.normalizedTimeField` records which field supplied the normalized instant.

Bithumb defines `prev_closing_price` relative to KST midnight. Quotes preserve that reference value and the previous KST calendar date; UTC timestamp normalization does not change the KST comparison boundary. Daily candles preserve `candle_date_time_kst` and use the provider's exclusive KST `to` cursor. See the [Bithumb terminology guide](https://apidocs.bithumb.com/docs/%EA%B0%80%EC%83%81-%EC%9E%90%EC%82%B0-%ED%88%AC%EC%9E%90-%EC%9D%B4%ED%95%B4%ED%95%98%EA%B8%B0).

The direct `SP:SPX` and `NASDAQ:IXIC` widgets report that embedding is unavailable. The app instead uses [FRED:SP500](https://www.tradingview.com/symbols/FRED-SP500/) and [FRED:NDQCOM](https://www.tradingview.com/symbols/FRED-NDQCOM/), which carry the original S&P500 and Nasdaq Composite daily series. Both single-quote summaries and daily advanced charts were verified with actual public widget responses. The UI labels these as daily closing values; they are not intraday prices. For the advanced chart, use `interval: 'D'` and omit `range`, because a `1M` preset can force an unsupported intraday resolution. Native API quote fields remain null for these widget instruments. Preserve the widget attribution and provide a source link if the embed fails.

TradingView's [widget data FAQ](https://www.tradingview.com/widget-docs/faq/data/) states that it does not offer an API for exporting its market data. Free widgets display provider data within the widget; paid TradingView plans do not grant an external data API or change widget permissions. Do not extract values from the iframe or use unofficial endpoints.

## Credentials

Create a free Gold API account and key at [Gold API](https://gold-api.com/) for historical access. Current quote access works without it. Request the free EIA key at the [EIA registration page](https://www.eia.gov/opendata/register.php).

Load `GOLD_API_KEY` and `EIA_API_KEY` through the deployment's existing external environment file or secret manager. Keep it outside this repository and readable only by the service account; use [CREDENTIALS.md](./CREDENTIALS.md) for the project's storage convention. Never paste real keys into source, tests, API responses, or logs. The Gold key is sent only as the `/history` `x-api-key` header. The EIA key is sent only to the fixed EIA origin as its required `api_key` query parameter, and request URLs and raw request errors are not logged. Requests reject redirects.

Missing keys mark only the corresponding component unconfigured: absent Gold history credentials leave public metal quotes available; absent EIA credentials leave other instruments available. TradingView links do not use the user's broker credentials.

### 금·은 이력과 WTI 무료 키 설정

키를 설정하기 전에는 금·은 과거 차트와 WTI만 설정 대기 상태로 표시되며, 공개 금·은 현재가는 계속 사용할 수 있습니다.

1. **금·은 이력:** [Gold API 로그인](https://gold-api.com/login)에서 `create a new account`로 가입한 뒤 계정의 API 키를 확인합니다. [무료 요금제](https://gold-api.com/pricing)는 이력/OHLC 합산 시간당 10회 요청을 제공하며, 현재 수집기는 금·은 일평균을 각각 6시간마다 요청합니다. 짧은 시간에 워커를 반복 재시작하면 초기 이력 수집도 요청 수에 포함됩니다.
2. **WTI:** [EIA API 키 등록](https://www.eia.gov/opendata/register.php)에서 신청하고 이메일로 전달되는 키를 확인합니다.
3. 실제 키를 저장소 밖 `/home/laeti/.config/orsem/runtime.env`에 아래 이름으로 보관합니다. 아래 값은 형식 설명용 자리표시자입니다.

```dotenv
GOLD_API_KEY="YOUR_GOLD_API_HISTORY_KEY"
EIA_API_KEY="YOUR_EIA_KEY"
```

파일은 서비스 실행 계정만 읽도록 `0600`으로 관리하고 `VITE_*` 변수에 넣지 않습니다. 이 두 서비스는 전용 `CREDENTIALS_FILE` JSON 로더를 사용하지 않습니다. 외부 파일을 Node/PM2 환경에 주입한 뒤 API와 worker를 다시 로드하는 절차는 [외부 파일 연결 방법](./CREDENTIALS.md#현재-실행기에-외부-파일-연결하기)을 따릅니다. 저장소 `.env`에 같은 변수의 빈 값이나 오래된 값이 남아 외부 환경을 가리지 않도록 확인합니다. 적용 후 `market:gold`의 이력 상태와 `market:eia` 상태를 확인합니다. 이 문서는 키 발급이나 운영 재시작을 실행하지 않습니다.

## Scheduling, retention, and health

The market-data queue runs `refresh-market-indicator-quotes` once per minute and `refresh-market-indicator-history` at minute 10 every six hours, KST. An initial history refresh is enqueued on worker startup. Treasury and EIA current values come from the latest daily publication in the history job. History refresh fetches roughly 370 calendar days with bounded pagination; stored earlier observations are not deleted.

Jobs share one worker queue with concurrency one. Non-Toss requests have at least 1.2 seconds of provider pacing; Toss uses its existing shared request/token coordination. On failure, the provider cooldown respects `Retry-After` or increases from one minute to at most 15 minutes, with no immediate job retry. Gold history has a separate cooldown so its key quota cannot disable public quotes.

Valid observations are upserted by instrument, kind, and source period. Updates preserve `firstObservedAt`; older source dates or provider instants cannot replace newer observations. A failure retains the last stored value. Prior-day reference selection prefers corrected values from the latest response.

Connector IDs are `market:toss`, `market:bithumb`, `market:treasury`, `market:gold`, and `market:eia`. Health metadata records `quoteStatus` / `historyStatus`, checked times, unavailable instrument IDs, and sanitized HTTP status / retry time. API freshness uses these component fields so one missing component does not invalidate another healthy one.

## Official references

- [Toss current OpenAPI contract](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)
- [Bithumb asset terminology and KST previous close](https://apidocs.bithumb.com/docs/%EA%B0%80%EC%83%81-%EC%9E%90%EC%82%B0-%ED%88%AC%EC%9E%90-%EC%9D%B4%ED%95%B4%ED%95%98%EA%B8%B0)
- [Bithumb REST ticker](https://apidocs.bithumb.com/reference/%ED%98%84%EC%9E%AC%EA%B0%80-%EC%A1%B0%ED%9A%8C)
- [Bithumb daily candles](https://apidocs.bithumb.com/reference/%EC%9D%BCday-%EC%BA%94%EB%93%A4-%EC%A1%B0%ED%9A%8C)
- [Treasury XML feed instructions](https://home.treasury.gov/treasury-daily-interest-rate-xml-feed)
- [Gold API endpoint and quota documentation](https://gold-api.com/llms.txt)
- [EIA API documentation](https://www.eia.gov/opendata/documentation.php) and [reuse policy](https://www.eia.gov/about/copyrights_reuse.php)
- [TradingView widget data restrictions](https://www.tradingview.com/widget-docs/faq/data/)

The parser and persistence tests are in `apps/worker/test/market-indicators.spec.ts`. They use synthetic unit-test inputs only; running them makes no authenticated provider requests.
