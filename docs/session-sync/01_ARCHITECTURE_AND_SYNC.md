# 01 — P1a 共用歷史讀取快取契約

狀態：**DRAFT_REVISED_FOR_BRAIN_REVIEW — 實作未核准**

檔名保留以避免斷鏈；本版內容已縮為 memory read cache，不再定義新的全域同步協定。E 編號對應 [00 證據表](./00_BASELINE_AND_SCOPE.md)。以下名稱是候選名稱，實作前由 Brain 確認最小接入方式。

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

### 2.1 可保存的 projection

候選 allow-list 是 `context.messages`、平行的 `entryIds`、`oldestEntryId`、`hasMore`，以及能確認的 requested/resolved leaf、page coverage 和讀取參數。可供歷史標示的其他欄位須逐項列入，不直接 `{...SessionData}` 或 `{...hookState}`。

不保存 running、readOnly、authority permission、queue、optimistic user bubble、stream delta、extension requests/status/widgets、draft、scroll、工具啟用狀態或整份 tree。既有歷史中合法的 tool-result 訊息可依 byte 預算納入，仍保持 defer flags；不可預先載入全部 thinking、圖片或巨大工具 body。

**來源限制：** E6/E7 可讀磁碟 SessionManager，也可讀 live manager；API 沒有 durable contentRev。P1 不把非-delta 訊息、`message_end`、`filePath` 非空或 HTTP 200 當作已落盤證明。共享範圍以既有可辨識的歷史讀取投影為限，明確排除尚未落盤／transient 內容；無法辨識來源的情況可不 admission，照舊讀取。Brain 在開工 gate 提供 producer→projection 的欄位與來源對照；不能為達成 cache hit 而假稱 fsync，也不能暗加 server protocol。若既有介面無法支持所選 admission 條件，先縮小可快取路徑或回報，而非自行改 API。

Observer `session_snapshot` 保持現有 reducer 處理；P1 預設只將它作為 cache 失效提示，不把包含 running／tree 的 event 原封寫入 cache。日後要以已驗證的磁碟 observer projection 填 cache，需 Brain 在同一 P1 邊界內明確列出來源與 key 映射，不能推廣到所有 runtime events。

## 3. Request identity 與 coverage

一個 key 至少區分：

```text
effective read-source/authority namespace + sessionId
+ endpoint kind + requested view/leaf selector
+ before + normalized tail + defer/projection parameters
```

namespace 使用已知的有效讀取環境／權限上下文，不新增多租戶系統，也不把秘密位址或 token 放入遙測。相同 session ID 的獨立 owner／不同讀取來源不能混用。

active leaf 是動態 selector，不是固定 leaf；有 explicit leaf 的 view 不能命中另一條分支。detail 回應有 leafId，context 回應未必有；保留 requested selector 與能證明的 coverage，未知 resolved leaf 保留 unknown。不能用接收時間或「最後一個顯示 entry」猜整個 branch 的 leaf。

沒有證明跨 endpoint 等價時不合併。初版可只對精確相同 key 命中；不同 tail／before 即使有重疊也不要求進階範圍合併。只快取最後一頁不能宣稱完整歷史已保存。未命中的深歷史仍走現有 pagination，不新增 around-anchor API。

## 4. 本頁面內的 freshness barrier

使用 owner 管理的 session-local invalidation generation（或不可重用的 token），不虛構跨程序 `contentRev`／total order。讀取開始 capture barrier；回應處理與 cache admission 前再次比較。consumer 的 observerSnapshotSeq／pagination generation／session identity／loading ownership guards 照常保留。

失效提示接既有流程：明確 Refresh、observer connected／session_snapshot／已知 persisted update、分支或 session identity 改變、rewrite／delete 的已知結果、effective read-source 改變。事件只通知 cache，不重送命令、不另起 observer。

普通 cache lookup 或普通 load 呼叫不自動提升 barrier，否則每位 consumer 都製造不同 generation 而永遠無法 coalesce。實作需列 invalidation trigger 表與呼叫來源；重複提示可保守失效，但不得產生 reload→invalidate→reload 的自我循環或無界 retry。

當 barrier 前進：舊 entry 變 stale；必要的 fresh GET 使用新 barrier，不能加入舊 Promise。舊 Promise 的晚到 200、404、錯誤及 finally 不能寫回新 cache、清掉新 entry 或移除更新的 registry 項目。

**generation 相同只代表沒有觀察到較新的本地失效，不代表伺服器此刻絕對最新。** 未觀察到的外部寫入仍靠既有權威校正；catalog sessionListVersion、mtime、兩個 observer 各自的 seq 不能混成全域內容版本。與已知更新相矛盾或無法確認的結果保持 stale／不 admission，不能用到達順序證明更新。

Eviction／clear 不得重設 barrier 後讓舊請求重新取得 admission 資格（ABA）。owner token／generation metadata 與 in-flight request 的生命週期要一起設計並保持有界；不是只限制訊息 Map。

## 5. Coalescing 與取消

只合併同 key、同 freshness barrier、相容讀取要求的進行中 GET。registry 擁有 request controller，不能把第一個 consumer 的 AbortSignal 直接作為所有人的 transport signal。

單一 consumer unmount／取消：停止它的後續套用並釋放訂閱；其他 consumer 還在等時不可取消 shared GET。最後一位釋放時，採用明確且有界的政策（取消，或完成後依 admission 規則決定是否保存），不得繼續無上限預抓。

每個 consumer 仍自行通過既有 guards，不能以「共用 Promise 已 resolve」取代 view 驗證。settled／failed／aborted request 必須以 identity 比較後移除；舊 finally 不能誤刪同 key 的新 Promise。timeout、未消費結果與失效中的 promises 也需資源上限。

命令完全不經 coalescer。UNKNOWN command outcome、draft recovery、queue、ensureEventsConnected、authority failure 的既有語意不變；任何 read retry 或 cache 恢復都不得重新 Send／Stop。

## 6. 呈現與既有 loadSession 整合

cache miss 沿用現有 loading/error 路徑。cache hit 先 hydrate **歷史呈現部分**，再進行權威 GET 校正；背景以局部 freshness/revalidating 狀態顯示，不用 full loading／empty shell 蓋掉已讀內容。

首次 cache paint 與後續 revalidated paint 分別記錄。僅顯示面板邊框、skeleton、React state setter 完成或 cache-hit 計數，都不算 transcript 已畫出。

E3 的 `loadSession(..., includeState)` 在歷史讀取後還會查 `/api/sessions/[id]/state`。改成 cache hit 後，不能提前 return 而跳過這個流程；也不能把 cached transcript 視為 agent ready、目前 model/tools、可写權限或正確 running 狀態。歷史 hydrate 與 fresh response 套用必須有不同入口／欄位邊界，不能強制 cast 不完整資料為完整 SessionData。

HTTP／JSON 解析前後的 guards、loadingToken 與 observer 更新優先關係仍保留。cache hydrate 在 consumer 已收到更高世代 observer snapshot／新分支／optimistic 更新後，不得再把畫面回退到舊歷史。稍後 revalidation 同樣遵守現有套用規則。

一般網路錯誤可保留 stale 歷史並提示重試；經 guard 接受的 session-not-found 或存取被拒，應清除／停止呈現受影響資料。舊 404 不能擦除新資料。authority 不確定不等同授權成功，cache 更不能打開原本被禁止的命令。

## 7. 容量與隱私

必須同時限制 pages/entries 與 estimated bytes，並設定單項 admission 上限；超大合法訊息可 bypass cache。估算方式要可重現，說明是否包含字串、巢狀 block、metadata 與重複 page，不能將 JSON byte size 宣稱為精確 heap 使用量。

cache eviction 只影響 read replica，不刪 draft、scroll 或 runtime state；也不以 hidden pane pin 無界資料。in-flight registry、失效 tokens、diagnostic ring buffer 都需可回收。配額、單項上限、可選 age policy 與測試依據由 Brain 提出後寫入開工紀錄，不把原草案的 100ms／256KiB 當已核准硬門檻。

本期不寫 IndexedDB、Cache Storage、Service Worker 或新的 localStorage 訊息內容；不將 transcript 丟進持久化 log／telemetry。沿用既有 draft 特例，不擴大其範圍。來源／權限上下文變化時隔離或清除 cache；不宣稱可從記憶體完成不可恢復的安全抹除。

## 8. 明確不提供的保證

不保證斷線期間每則 token 可重播、不提供跨 reload 歷史、不修正所有既有 runtime 競態、不使 cold detail API 自動變 O(page)，也不會讓另一套 official 前端自動取得快取。這些不是 P1 correctness gate；已知限制必須保留在交付說明，不可以「cache 已完成」代替整個效能目標。
