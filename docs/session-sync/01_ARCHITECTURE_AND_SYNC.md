# 01 — P1a 共用歷史讀取快取契約

狀態：**DRAFT_REVISED_FOR_BRAIN_REVIEW — 實作未核准**

檔名保留以避免斷鏈；本版內容已縮為 memory read cache，不再定義新的全域同步協定。E 編號對應 [00 證據表](./00_BASELINE_AND_SCOPE.md)。本輪依 [Brain 對 ceb54c3 的 ACCEPT_WITH_CHANGES](https://github.com/mtai168/pi-web/pull/20#issuecomment-5623700887)補入 admission v1 與工程參數；仍是 0.2 範圍內的澄清，不是新的實作授權。

## 1. 所有權與非目標

```text
SST AppShell：模式邊界之外的 client-scoped read-cache owner
├── bounded SessionReadCache
├── compatible history GET in-flight registry
├── Normal → ChatWindow → 原 useAgentSession
└── Wall → SessionWallChatWindow → ChatWindow → 原 useAgentSession

useAgentSession：仍持有 view guards、scroll/draft、runtime reducer、
queue、optimistic messages、extension UI、command、per-session SSE

Server：沿用現有 detail/context、catalog、observer、authority、Pi runtime
```

只增加讀取副本與共享 GET，沒有新 server 程序、transport、catalog owner 或執行狀態真相。AppShell owner 的 identity 不受 workspaceMode、selectedSession、pane runtime key 改變；頁面結束即失去 cache。SSR 不得用 process-global Map 共用不同請求／使用者的內容。

Normal 從未進 Wall 也初始化同一 owner。Wall 顯示／隱藏或卸載仍遵循既有 runtime 策略；不為快取把所有 ChatWindow 永久掛載。P1 不要求切模式時 SSE 永不重連，只要求 cache 不被誤綁在模式生命週期。

每個 hook 保有自己的 transcript presentation 與 transient 狀態。A 的 cache 更新不應令 B/C/D 的歷史重算。共享 immutable projection；consumer 後續 lazy hydration／optimistic 操作需 copy-on-write，不能 mutate 共用物件或其他 view。

## 2. 只接兩種歷史 GET

納入候選：`GET /api/sessions/[id]` 與 `GET /api/sessions/[id]/context` 的歷史部分。沿用 query 與 response 語意，不新增 endpoint，不把同 session 的兩種 response shape 當成相同 request。

不進 cache／coalescer：`/state`、`/api/agent/*`、SSE、POST/PATCH/DELETE、get_tools／get_state 等以 command 發出的操作、provider auth、system info、檔案內容與媒體下載。GET 這個動詞本身不足以證明可安全共享，採 endpoint allow-list。

### 2.1 External-owner-only admission v1

首版只允許 **同一 AppShell 生命週期內、該 session 最近一次 guarded `/api/sessions/[id]/state` 成功確認 `readOnly === true && authority === "external_owner"`** 的歷史讀取 projection 進入 cache。Request 開始時捕捉的 barrier／source epoch，在 admission 時仍須有效；eligibility 不取代 consumer guards。

此限制利用既有 invariant：external-owner mode 的 [`startRpcSession()`](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/lib/rpc-manager.ts#L1984-L1998)在建立或重用本地 writable wrapper 前即 fail closed；[`/state`](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/app/api/sessions/%5Bid%5D/state/route.ts#L8-L34)的成功 payload 明確帶 external-owner 標記。這是本版來源範圍的依據，不新增 API、durable revision 或 fsync 保證；HTTP 200、`filePath`、`message_end` 本身仍不是落盤證明。

| Producer/path | 可 coalesce | 可寫入 cache | Projection 與條件 |
|---|---|---|---|
| detail GET | eligibility 已知後，才可走 shared adapter | 是，需通過 barrier／source／容量檢查 | `context.messages`、`context.entryIds`、`context.oldestEntryId`、`context.hasMore`，及 top-level 已解析的 `leafId`；使用既有 response shape。 |
| context GET，帶 explicit `leafId` 或 `before` | 同上 | 同上 | `messages`、`entryIds`、`oldestEntryId`、`hasMore`；只保存 requested selector/anchor 與 coverage，不虛構 resolved leaf。 |
| context GET，沒有 explicit `leafId` 且沒有 `before` | 不進 shared adapter，走原 GET | 否 | 無法取得 resolved leaf，v1 整份 bypass。 |
| eligibility 尚未確認、standalone／free／writable／lease-held／authority-unverifiable／state error | 走原 GET | 否；首次 detail 的 pending candidate 僅適用 §6 的 guarded state 後確認流程 | 不猜測來源，不等待 context 的 eligibility，不改 baseline 行為。 |
| observer `session_snapshot`、`message_end`、stream delta、optimistic state | 不適用 | 否 | 只進原 reducer 或通知 cache stale；不由 runtime event 填 cache。 |
| `/state`、`/api/agent/*`、commands、SSE | 不適用 | 否 | 全部保留原 owner 與流程。 |
| running／readOnly／authority／queue／tree／stats／info／toolNames／model／thinking／extension UI 等非歷史欄位 | 不適用 | 否 | 不保存完整 `SessionData` 或 hook state。 |

上表的歷史欄位加上必要 key／coverage／估算 metadata 是 v1 allow-list，不直接 `{...SessionData}` 或 `{...hookState}`。既有歷史中合法的 tool-result 訊息可依 byte 預算納入，仍保持 defer flags；不預抓 thinking、圖片或巨大工具 body。表中的 model/thinking 排除指獨立設定與 runtime 欄位，不另行改寫既有歷史訊息的 projection 語意。

Eligibility 是 **session-scoped、AppShell-memory-only 的 admission 控制狀態**，不是被快取的 `/state` response，也不是命令授權來源。`/state` 失敗或 authority/source class 改變時停止新的 admission／shared-adapter 使用，並失效舊 request 的資格。先前合法 admission 的 transcript，可在相同允許的 namespace 內標 stale 顯示、繼續既有 fail-closed 校正；source/身份 namespace 不同不可跨用。經 guarded 404/403/明確撤權，evict 該 session records 並 rotate token。

因此 P1 v1 專注 SST 的 external-owner consumer；不是另一套 official／standalone frontend 的快取，也不支援 writable/live producer。若未來要擴大來源，另需可驗證 source marker 或新契約，不在 P1 偷加。Observer snapshot 不作為 v1 cache producer。

## 3. Request identity 與 coverage

Exact key 的組成如下；leaf 與 before 分開保存，兩者同時存在時也不能遺失任一條件：

```text
appShellCacheInstance + authoritySourceEpoch + sessionId
+ endpointKind (detail | context)
+ requestedLeafSelector (active | explicit-leaf:<id>)
+ before (none | entry:<id>)
+ normalized tail + deferThinking + deferMedia + projectionVersion (= 1)
```

namespace 只使用 AppShell instance 與已知 source class/epoch，不保存 owner URL、私密位址或 token。相同 session ID 的獨立 owner／不同讀取來源不能混用；不新增多租戶系統。Context 的 active + before:none 不 admission，見 §2.1。

active leaf 是動態 selector，不是固定 leaf；有 explicit leaf 的 view 不能命中另一條分支。detail 回應有 leafId，context 回應未必有；保留 requested selector 與能證明的 coverage，未知 resolved leaf 保留 unknown。不能用接收時間或「最後一個顯示 entry」猜整個 branch 的 leaf。

沒有證明跨 endpoint 等價時不合併。初版只對精確相同 key 命中；不同 tail／before 即使有重疊也不要求進階範圍合併。只快取最後一頁不能宣稱完整歷史已保存。未命中的深歷史仍走現有 pagination，不新增 around-anchor API。

## 4. 本頁面內的 freshness barrier

使用 owner 管理、不可重用的 session-local token/object，不虛構跨程序 `contentRev`／total order。讀取開始 capture barrier；回應處理與 cache admission 前再次比較。consumer 的 observerSnapshotSeq／pagination generation／session identity／loading ownership guards 照常保留。

本輪採用的 invalidation trigger 表如下；接點沿用 [Brain 複核 §4](https://github.com/mtai168/pi-web/pull/20#issuecomment-5623700887)列出的 snapshot hook 區段，實作時核對真實基底的相同函式，不照搬已過時行號。

| Trigger | Cache 動作 | 讀取／命令邊界 |
|---|---|---|
| observer/external stream `connected` | 先 rotate barrier，每次 connection 一次 | 再沿原 `loadSession`，不另建 observer。 |
| `session_snapshot` | rotate、舊 cache 標 stale | snapshot 只進原 reducer，不填 cache、不另加 GET。 |
| 通過 session identity guard 的 `message_end` | rotate/stale | 原 view 照常 append/dedupe，不因每則 event 另發 GET。 |
| prompt/agent/compaction settlement 準備原有 reload | fresh load 前 rotate | load 函式本身不再 rotate。 |
| 明確 Refresh、navigate／leaf change | refresh 或 command/selection 前 rotate | 新 selector 使用新 barrier；不更動命令處理。 |
| successful/ambiguous history-affecting command 後原本會 reload | reload 前 rotate | 不新增 retry，不改 UNKNOWN 結果。 |
| session identity replacement／source epoch change | rotate old/new tokens，來源 eligibility 重新確認 | 舊 request 不可 admission；不跨來源復用。 |
| guarded 404/403/delete／明確撤權 | evict 該 session 全部 records，rotate token | 舊 404 仍由原 guards 拒收。 |
| catalog refresh only | 不自動失效全部 transcripts | 不製造四格 reload storm。 |
| ordinary cache lookup／load call | 不 rotate | 同 barrier 的相容 GET 才能 coalesce。 |

重複 event 可保守 rotate token，但 invalidation 本身不自行呼叫 load；只有既有 lifecycle 本來要校正時才發 GET。不得產生 reload→invalidate→reload 的自我循環、每 token GET 或無界 retry。

當 barrier 前進：舊 entry 變 stale；必要的 fresh GET 使用新 barrier，不能加入舊 Promise。舊 Promise 的晚到 200、404、錯誤及 finally 不能寫回新 cache、清掉新 entry 或移除更新的 registry 項目。

**token 相同只代表沒有觀察到較新的本地失效，不代表伺服器此刻絕對最新。** 未觀察到的外部寫入仍靠既有權威校正；catalog sessionListVersion、mtime、兩個 observer 各自的 seq 不能混成全域內容版本。與已知更新相矛盾或無法確認的結果保持 stale／不 admission，不能用到達順序證明更新。

Eviction／clear 不得重設 barrier 後讓舊請求重新取得 admission 資格（ABA）。目前 token map 不存在或不再指向原 token，即拒絕旧 request admission。token metadata 與 in-flight request 的生命週期要一起設計並保持有界；不是只限制訊息 Map。

## 5. Coalescing 與取消

Eligibility 已知後，只合併同 key、同 freshness barrier、相容讀取要求的進行中 GET。Registry identity 為 `(exactKey, barrierToken, requestToken)`；registry 擁有 request controller，consumer 只持 subscription/release token，不能把第一個 consumer 的 AbortSignal 作為所有人的 transport signal。

單一 consumer unmount／取消：停止它的後續套用並釋放訂閱；其他 consumer 還在等時不可取消 shared GET，也不刪其他人的 cache。**最後一位 consumer 釋放時立即 abort shared read。Read timeout 為 120 秒。** 不增加無人消費的預抓。

每個 consumer 仍自行通過既有 guards，不能以「共用 Promise 已 resolve」取代 view 驗證。settled／failed／aborted／timed-out request 必須以 identity 比較後移除；finally 只有仍指向同一 requestToken 才能刪除，舊 finally 不能誤刪同 key 的新 Promise。timeout、未消費結果與失效中的 promises 也需資源上限。

Shared GET registry 滿額時走原 direct GET，不建立新 scheduler／命令 queue；限額只約束新增的共享層，不宣稱限制 baseline 所有並行 GET 或 response 峰值記憶體。數值見 §7。

命令完全不經 coalescer。UNKNOWN command outcome、draft recovery、queue、ensureEventsConnected、authority failure 的既有語意不變；任何 read retry 或 cache 恢復都不得重新 Send／Stop。

## 6. 呈現與既有 loadSession 整合

cache miss 沿用現有 loading/error 路徑。cache hit 先 hydrate **歷史呈現部分**，再進行權威 GET 校正；背景以局部 freshness/revalidating 狀態顯示，不用 full loading／empty shell 蓋掉已讀內容。

首次 cache paint 與後續 revalidated paint 分別記錄。僅顯示面板邊框、skeleton、React state setter 完成或 cache-hit 計數，都不算 transcript 已畫出。

E3 的 `loadSession(..., includeState)` 在歷史讀取後還會查 `/api/sessions/[id]/state`。改成 cache hit 後，不能提前 return 而跳過這個流程；也不能把 cached transcript 視為 agent ready、目前 model/tools、可寫權限或正確 running 狀態。歷史 hydrate 與 fresh response 套用必須有不同入口／欄位邊界，不能強制 cast 不完整資料為完整 SessionData。

最小接入順序（不拆 runtime reducer）：

1. 若已有合法 admission 的 entry，且來源／consumer guards 允許，僅 hydrate `messages`、`entryIds`、`historyCursor`、`hasEarlierMessages` 與能確認的 `activeLeafId`。
2. 仍執行原 detail GET；eligibility 未知時不用 shared adapter，保留尚未 admission 的 bounded pending history candidate，不能當成共享 cache。既有 HTTP/JSON 前後 guards 照常套用。
3. `includeState` 為 true 時無條件繼續原 `/state` 流程。只有 guarded state 確認 external-owner eligibility，且原 source epoch／barrier／consumer identity 仍有效，pending candidate 才可 admission；失敗、取消或失效就丟棄。這處理首次 cold load，不需要新 API 或額外 state 輪詢。

同頁回切時 provider 已有該 session 的 guarded eligibility，後續合格 detail/context GET 可在 response 後依 barrier admission；branch/context 操作早於 eligibility 時，直接走原 path 並 bypass，不等待或猜測。原本 running、observer demand、queue、model/tools/system/ready 流程照常。

HTTP／JSON 解析前後的 guards、loadingToken 與 observer 更新優先關係仍保留。cache hydrate 在 consumer 已收到更高世代 observer snapshot／新分支／optimistic 更新後，不得再把畫面回退到舊歷史。稍後 revalidation 同樣遵守現有套用規則。

一般網路錯誤可保留 stale 歷史並提示重試；經 guard 接受的 session-not-found 或存取被拒，應清除／停止呈現受影響資料。舊 404 不能擦除新資料。authority 不確定不等同授權成功，cache 更不能打開原本被禁止的命令。

## 7. 容量、估算與隱私

### 7.1 本輪收斂的初始工程參數

下列數值來自 [Brain 複核 §6](https://github.com/mtai168/pi-web/pull/20#issuecomment-5623700887)，是待 Owner 隨 P1 整體核准的安全工程預設，不是已量測的 SLA。MiB = 1,048,576 bytes；KiB = 1,024 bytes。

| Resource | Desktop | Mobile Normal |
|---|---:|---:|
| Total estimated cache bytes | 24 MiB | 12 MiB |
| Cache records/pages | 32 | 16 |
| Total cached messages | 2,048 | 1,024 |
| Single projection | 2 MiB | 1 MiB |
| Single message | 512 KiB | 256 KiB |
| Active shared GETs | 8／AppShell、2／session | 4／AppShell、2／session |
| Read timeout | 120 秒 | 120 秒 |
| Inactive-entry eviction | 30 分鐘 | 10 分鐘 |
| Diagnostics | 200 metadata records 或 64 KiB，先到者為限 | 同左 |

Quota class 在 AppShell owner 建立時選定一次，resize 不重建 cache。LRU insertion 後須同時满足 bytes/records/messages 上限；任一單項或 projection 超限，**整份 projection bypass**，不建立缺訊息的「部分完整」cache。共享 registry 超限則依 §5 回原 GET，不阻擋命令。Baseline 後可由 Owner 整體調低配額；調高需 Owner/Brain 明確記錄，不由實作自行放寬。

### 7.2 Deterministic recursive estimator

```text
string  = 2 * string.length（UTF-16 code units）
number / boolean = 8
null = 4
array = 24 + child estimates
object = 32 + sum(2 * key.length + value estimate)
```

同一 object identity 在一次 projection 估算中只計一次；若遇循環參照則整份 bypass，不能把循環誤當一般共享引用略過。估算包含 messages、entryIds、cursor/leaf/coverage 與 key metadata。這是可重現配額，不等於 V8 heap、serialized JSON 或 wire bytes；不以額外完整 JSON.stringify 作估算。

Cache eviction 只影響 read replica，不刪 draft、scroll 或 runtime state；也不以 hidden pane pin 無界資料。in-flight registry、失效 tokens、pending candidates、diagnostic ring buffer 都需可回收；不得只限制資料 Map 而留下失效請求與 metadata 洩漏。

本期不寫 IndexedDB、Cache Storage、Service Worker 或新的 localStorage 訊息內容；不將 transcript 丟進持久化 log／telemetry。沿用既有 draft 特例，不擴大其範圍。來源／權限上下文變化時隔離或清除 cache；不宣稱可從記憶體完成不可恢復的安全抹除。Flags 與效能判定見 [02 §4](./02_DELIVERY_AND_TESTS.md#4-測試矩陣與效能判斷)。

## 8. 明確不提供的保證

不保證斷線期間每則 token 可重播、不提供跨 reload 歷史、不修正所有既有 runtime 競態、不使 cold detail API 自動變 O(page)，也不會讓另一套 official 前端自動取得快取。這些不是 P1 correctness gate；已知限制必須保留在交付說明，不可以「cache 已完成」代替整個效能目標。
