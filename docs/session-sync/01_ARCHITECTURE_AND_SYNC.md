# 01 — 共用架構與同步契約

狀態：**DRAFT_FOR_BRAIN_REVIEW — 尚未核准實作**

本文件的元件、欄位與 endpoint 名稱均為提案；它定義必須成立的語意，不聲稱 repo 已有這些功能。程式基準與限制見 [00](./00_BASELINE_AND_SCOPE.md)。

## 1. 架構與所有權

```text
Application session-services root（不隨 normal／wall 切換）
├── SessionStore：normalized entries、已讀頁面、catalog、同步狀態
├── SessionSyncManager：一頁一條 session SSE、訂閱、補差異、去重
├── SessionReadCache：可選持久化的 IndexedDB 副本
├── NormalWorkspace → 既有 ChatWindow
└── SessionWallWorkspace → 多個既有 ChatWindow／pane adapters

HTTP read／sync API                 HTTP command API
          │                              │
Session Read Service              Pi Host／既有 wrapper
├── 分支／entry 索引                       │
├── 近期頁面與概要                        └─ SDK events
├── source generation／revision                 │
└── 有界事件分發器 ← collector ←───────────────┘
                          └─ JSONL watcher + reconciliation
```

**不建立 normal 舊引擎、Wall 新引擎兩個永久分支。** 除 rollout 的明確兼容路徑外，兩種模式讀同一份 session data。feature flag 不得綁在 `workspaceMode === 'wall'`。

SessionStore 的資料按 server identity、實際有效 auth scope、sessionId 隔離；同一 session 的不同 branch/view 另外建 key。若現有產品沒有帳號模型，由 Brain 定義可信的部署／權限 namespace，不先虛構 multi-tenant 系統。

message data、catalog、running 狀態及 event reduction 共用；focus、input ref、pane error boundary、scroll anchor、展開狀態按 view／pane 隔離。draft 沿用既有 session key 與 transient→real ID rekey 契約，不另造互相覆蓋的第二份 draft store。

同一 session 多個 consumer 訂閱以 reference count／需求合併處理。模式切換的短暫 unmount 不應清空資料或重開 transport。Normal 與 Wall 切換保留各自 navigation 意圖；不靠永久掛載所有隱藏 ChatWindow 達成快取。

React consumer 使用細粒度 selector；A 的 delta 只更新 A 的生成區域，不重算 catalog、其他 pane 或整份歷史。元件 `key` 的隔離可以保留；cache 不依附該 key 的生命週期。

## 2. Server 讀取服務

### 2.1 原始資料與權威邊界

Pi session JSONL 仍是已持久化歷史的來源。SDK runtime 是目前執行狀態、未落盤生成內容及部分 leaf 狀態的来源。新增索引是**可刪除、可重建的讀取投影**，不反向編輯 Pi session 以達成加速。

不要從檔案沒有新行推斷 agent 已 idle；也不要從新增 message 自行猜測所有外部 CLI 的即時執行狀態。無法觀察時標示 unknown／last-observed，避免偽造確定性。

### 2.2 更新來源

對本 server 管理的 agent，collector 接 SDK／wrapper 事件，不迴圈向自己的 HTTP API 抓取。已完成 message 尚未確認落盤時，可以作為 runtime snapshot 呈現，但不能提前推進「已持久化歷史」游標。

外部 Pi CLI／其他程序以檔案通知為 hint，從上次確認的 byte offset 增量讀取，並以啟動掃描、定期校正與前景查詢時的必要校正補漏。外部 CLI 尚未寫入 JSONL 的逐 token 資料，沒有額外事件接入就不可宣稱能同步。[R1]

不得為歷史觀看啟動休眠 AgentSession。沒有客戶端時 collector／索引仍由 server 生命週期維持；無人觀看的每個 token 不需要永久寫進 SQLite。

### 2.3 索引與一致性

建議採 SQLite + 有界記憶體快取，單一 index writer；driver 及部署 topology 待 Brain 決策。最低需表達：source identity／generation、session header、entryId／parentId、entry 定位、導航摘要、已驗證頁面、概要統計與變更版本。

- tail／anchor query 利用索引定位並沿選定 branch 讀取有界頁面；不得每頁重新 `SessionManager.open()` 或重建全 entries Map。
- entryId 在 session／generation namespace 內去重。SDK event 與 file observer 指向同一 entry，只能合併一次，統計不能加兩次。
- 正常追加只處理新增完整行。保留未完成 UTF-8／JSONL 行的 bytes；交易只推進到已確認完整內容的 offset。大行另設內容預算，不可造成無界記憶體分配。
- rename、inode replacement、truncate、same-size rewrite、header rewrite、migration、delete 都不能只靠「size 變大就是 append」處理。generation／fingerprint 檢查與重建策略須有測試；模糊時安全失效，不沿用舊 byte offset。[R1]
- full rebuild 可發生於首次建立、檔案重寫、索引損壞或 schema migration；不得每次讀取都 full rebuild。冷建索引期間狀態需明示，不能假裝 indexed fast path。
- branch 不是檔案最後 N 行。active leaf、view leaf、parent chain、fork（新檔案）、compaction 及 label／custom entry 的語意由對應 SDK 契約確認。部分 live leaf 變更未必有檔案追加；必須接 runtime 變更，或承認外部不可觀察限制。
- payload、metadata revision、offset 與 change record 在一致交易內提交，之後才通知 durable change。transaction 中斷可以重新處理，不得漏記或重複計數。
- 刪除及權限撤銷要有 tombstone／失效機制；游標過期時以完整授權 catalog 校正，避免離線裝置永久保留「仍存在」的假象。

索引回傳 materialization watermark／observedAt。檔案突變尚未被 watcher 發現時，不能承諾第一幀絕對最新；恢復同步會校正，必要讀取可先核对 source metadata。

### 2.4 程序與部署

初始建議維持同 repo、同主機、少數程序：SDK event collector 在現有 Pi Host 邊界，昂貴掃描／解析及 DB owner 移至受管理 worker 或 sidecar。不得把同步 SQLite 與全檔解析直接放回 Web request event loop。

Brain 必須確認實際 Next.js／launcher process topology、HMR、restart 與 IPC。`globalThis` 僅是單程序生命週期技巧，不是跨程序 singleton；不得多個 route worker 各自建 watcher、索引 writer 或不一致的 event hub。定案前不宣稱支援多 instance／serverless。

Pi Host 與 Web 完整拆程序是後續隔離選項，不是第一個快取修正的前置條件。不得為此次引入不必要的分散式平台。

## 3. 讀取 API 與資料預算

候選介面（名稱待定）：

| 需求 | 語意 |
|---|---|
| snapshot／batch snapshot | 可見 sessions 的最近頁、概要、view identity、coverage、版本與同步 checkpoint |
| context around anchor | 直接取得 anchor 前後有界內容；不存在或不在選定 branch 時回明確原因／可接受 fallback |
| diff | 客戶端提交已套用版本與所持 coverage；server 回 upsert、invalidate、tombstone，或要求新快照 |
| tree／body／media | 導航與重內容按需取得；不阻擋第一屏 |

正常首頁先顯示有界訊息頁＋快取概要。Tree DTO 用 allow-list 欄位，禁止以物件展開帶出完整 entry；thinking、工具內容、images 與 branch leaves 也不能繞過 lazy policy。

除了 entry count 還需 wire byte 與單項內容預算。超大 tool output 回 preview＋authorized content reference；媒體由原有權限邊界按需取得。不要拆成十個必須串行完成的小 API：小且已快取的摘要可以 batch。

ETag／revision 可用於未變更判斷，但不能為了產生 ETag 先重讀整份檔案。stats 若尚在重建可延後顯示；不能偽裝成最新精確值。

## 4. 本機快取

記憶體保存目前可見與近期切換內容，IndexedDB 保存允許的歷史頁面、閱讀錨點、view 版本與同步位置。[R2]

WallLayoutStore 仍只存 layout metadata；SessionReadCache 是獨立、可清除的內容副本。容量採 byte-based LRU，避免用「session 個數」假裝限制大小。可見頁面優先；巨大工具結果與圖片預設不全量下載。記憶體壓力仍可降級，不能無條件 pin 無界資料。

初次啟動立即使用可讀快取，接著驗證授權與更新；是否允許授權尚未驗證時顯示既存離線內容，必須由隱私決策明確選定。不可同時保證完全離線、即時撤銷所有本機副本與無需確認授權。

所有 IndexedDB 操作 best-effort。quota、eviction、blocked upgrade、private mode 或 migration 失敗時退回記憶體／網路，不阻止正常使用。資料與對應的已套用 checkpoint 在同一交易中保存；不依賴 unload 才寫入，也不逐 token 寫 DB。[R2]

既有草稿的保存與清除語意不被 cache eviction 改變。登出／身份切換／權限失效時清除對應 namespace，跨 tab 傳播失效；不得把 model provider logout 與應用登入身分混為一談。

## 5. 同步版本：不能只有一個 lastEventId

| 概念 | 用途 |
|---|---|
| `sourceEpoch + contentRev` | 某 session 已持久化讀取投影的世代與版本；source rewrite／rebuild 的不相容狀態使舊快取失效。 |
| `viewKey + coverage + appliedRev` | 此 branch／視窗快取實際包含的資料及已套用版本。只有最近一頁不能宣稱整份歷史同步完成。 |
| `knownRev` | 從精簡通知知道 server 已更新到何處；不等於內容已下載或存入 DB。 |
| `hubEpoch + transportCursor` | SSE replay checkpoint；是傳輸位置，不是內容已落盤 acknowledgement。 |
| `runtimeEpoch + runId + streamSeq` | 目前生成中的暫態內容；重啟／run 更換時不能與舊 token 混接。 |
| `requestGeneration／subscriptionGeneration` | 排除慢回應、舊 view、旧訂閱 ACK 污染新畫面。 |

版本不可用時間戳猜順序。候選 revision 用 string／不透明 token，避免 JavaScript 大整數序號精度問題。跨 epoch 不比較大小，改做明確重同步。

normal／Wall 同 session 不同 leaf 的回應，不能因 sessionId 相同就直接替換。append 可依穩定 entry ID 合併；無法證明舊頁未受影響時標記失效，按需重取，不捏造可套用 diff。

## 6. 一頁一條 SSE 與無缺口恢復

只計算 session 更新通道；provider OAuth 等其他用途 SSE 不屬於「只能一條」限制。跨 tab 共用 transport 不列初版前置條件；每台裝置／每個頁面可各有自己的連線。[R3]

新 endpoint 是唯讀訂閱，不呼叫 `startRpcSession()`。Server 直接從事件 hub fan-out，不在內部開 N 條舊 session SSE。每個事件帶 sessionId 與適用的版本；同一串流交錯多個 session。

訂閱需求分為：可見內容（包括四個可見 pane，不只 focused）、catalog／running／attention 摘要，以及不需高頻內容的冷 session。變更需求透過帶身分驗證的控制請求與 subscription generation；mode switch 不重建 transport。clientId 只是訂閱識別，不是授權憑證。

### 6.1 Snapshot → live 的契約

候選流程：server 先註冊有界 pending subscription／確保變更紀錄已保留，再於一致切面產生 snapshot 與 checkpoint；client 套用快照後接續該 checkpoint 以後事件。安裝新訂閱亦遵守同一規則，不能只保證首次連線。

在 snapshot 與 SSE 連上之間完成的訊息，必須由 replay／diff 補到；不得只補當前 streamingMessage。重複資料以 entry ID／revision 去重。filtered stream 的全域 cursor 可以跳號，不能把其他 session 的被過濾事件誤判為缺口。

事件記錄保留有上限。epoch 改變、cursor 過期、pending buffer overflow 或無法證明連續性時，回 `resync_required`，重新取得可見 view 快照，再恢復增量。不以永久保留所有 token 換正確性。

### 6.2 Last-Event-ID 的陷阱

SSE 的 `id:` 可供 transport 恢復，但瀏覽器收到事件不代表 IndexedDB 已提交。[R3] 重連時不得只相信瀏覽器的 Last-Event-ID：要依已套用／已保存的 view 版本做 diff／快照校正。記憶體、DB、transport 三種 checkpoint 不得混用。

動態訂閱增減、page refresh、server restart、短暫雙連線與慢 HTTP 都需 generation／revision guards。不能由舊快照把較新事件覆蓋回去。

### 6.3 durable 與 transient 分流

已完成歷史走可重建的正式 entry／diff；逐 token 為暫態事件，可小批次合併。離線十分鐘後，取得期間完成內容＋目前 runtime snapshot，不重播十分鐘打字動畫。未完成 run 的 streamSeq 缺口可要求新的 runtime snapshot。

只收 metadata 的 session 推進 knownRev，不推進 content appliedRev。完成事件可觸發合併後的有界 diff，不再由 agent_end／prompt_done／settled 各發一次完整 reload。

每 client queue 與每 session burst 都要有 byte 上限與公平排程。大檔不能堵住其他 session；壓力過大時合併 transient delta 或明確要求重同步，不靜默丟棄正式變更、命令回覆或核准請求。

## 7. 命令、extension UI 與通知

HTTP 仍負責 Send／Stop／fork／navigate／compact／tools 等命令。新 SSE 已連上只表示資料通道可用，不代表某 session 的 runtime 已 ready。既有 handleSend／ensureEventsConnected 依賴必须在部署基準上檢查後替換。[B2–B5：00 文件]

Server 接受命令後，由受控 session 啟動流程執行；失敗要能区分明確拒絕與「是否已接受不明」。現有 command route 不等於可查詢的持久化 receipt／去重 ledger。若此次加入 commandId／receipt，需獨立契約與測試；若暫不加入，UNKNOWN 狀態禁止自動重試。**讀取重連、cache replay、模式切換均不得觸發命令重送。** 不承諾 exactly-once。

保留 queued steering／follow-up、draft recovery、fork 後 wrapper 失效、transient ID rekey、set_tools 重建、compaction／retry／extension-queued run 的邏輯。不能見第一次 agent_end 就宣布整個邏輯工作結束。

Extension status／widget／UI request 不可在簡化 wire schema 時遺失。Blocking request 以 requestId 去重，沿用或補齊明確的單一回覆權責；多 pane／重連不得自動回覆两次或派到錯的 session。completion／attention 通知集中去重，replay 不重播已通知完成音。跨裝置通知政策由 Brain 提案，不宣稱傳輸協定自動解決。

## 8. 前背景、省電與安全

前景可見 session 保持 live；不在畫面上的 session 收精簡狀態，必要時才補內容。頁面背景／freeze 可降級或斷線，恢復時先顯示快取並標記 freshness，再校正。瀏覽器可能凍結／丟棄頁面，不能把 permanent background SSE 或 Service Worker 常駐當保證。[R4]

不為每個 token wake device。關鍵完成／attention 通知沿用現有能力，另行明確 opt-in；不把新增 push 系統作為核心快取的前置條件。

snapshot、diff、subscriptions、SSE replay、media references 均需同等 session／project 授權；不能因為 event hub 全域可見而把所有 session 廣播给每個人。保留 file allow-list／project trust。索引資料庫要限制檔案權限，log 不記正文或 secrets。

不將 credentials、API keys、auth.json、完整 system configuration 放進內容 cache。歷史本身可能含敏感資訊；本機保存須有停用、容量、clear、身份分區與降級策略。索引或瀏覽器 cache 都不是新的授權來源。

## 9. 外部依據

以下只支援平台能力與限制；本文件的架構及數值仍是待審提案。

- R1：[Node.js fs.watch caveats](https://nodejs.org/api/fs.html#caveats)：檔案通知不能取代校正，須處理 inode／平台差異。
- R2：[MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)：結構化、非同步、交易式本機資料；持久化策略仍需處理失敗。
- R3：[MDN Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)：單向事件、event／id、重連與連線限制；不提供應用層 exactly-once。
- R4：[Chrome Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)：背景 freeze／discard 與生命週期限制。
