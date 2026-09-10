# 02 — 分階段交付、分工與驗收

狀態：**DRAFT_FOR_BRAIN_REVIEW — 尚未核准實作**

以下 SS-* 是提案工作代號，不是已建立 GitHub issues，也不是現行 milestone 的新增承諾。需先通過 [Brain 審查 gate](./03_BRAIN_REVIEW.md)。

## 1. 交付順序與 gate

| 階段 | 交付 | 依賴與出口 |
|---|---|---|
| G0／SS-00：部署基準與契約 | 對齊實際 SST HEAD、模式切換、所有事件／命令、frozen 衝突；定案 protocol、隱私與 topology | 只審查，不派 production writer。Owner 核准確切文件與範圍後才離開 G0。 |
| P1／SS-01：共用前端 read store | normal 先接共用 store、記憶體快取、request／view generation、coalesced loads；保留現有 UI 與暫時 transport adapter | cold-start normal 從未進 Wall 也受益；A→B→A 不等待網路；旧回應不能回退；功能回歸通過。 |
| P2／SS-02：索引與有界查詢 | 单 writer source index、cached summary、tail／around-anchor、tree DTO／body 預算、外部變更校正 | 可與 P1 的獨立模組並行，需已定介面。warm query 不全檔解析；rewrite／branch／delete fixtures 通過。 |
| P3／SS-03：共用 live／diff | event hub、per-page SSE、snapshot checkpoint、replay／resync、runtime snapshot；明確命令 ready 分離 | 依 P1／P2 与命令能力決策。切換前先通過協定契約測試，再切換唯一事件 reducer owner。 |
| P4／SS-04：持久化與恢復 | IndexedDB、coverage／checkpoint 交易、quota／auth partition、前背景策略 | 依 P1 與定案版本契約。可先用 fake server 平行開發，但不能以自創另一套 schema 整合。 |
| P5／SS-05：Wall 整合與渲染 | 所有 pane 接同一服務，catalog／通知去重，真正列表 virtualization、重內容按需 | normal→Wall→normal 不重建資料引擎，4-pane live 不干擾輸入；8／12-pane 保留原有 hot／warm／cold 行為。 |
| P6／SS-06：回歸與 rollout | 隔離環境 production benchmark、斷線／失效／長跑、旗標回退及操作文件 | 不改 Pi 歷史格式；完成所有 correctness gate 才可擴大啟用。 |

P1 可以先改善記憶體回切，不必等 SQLite 或多路 SSE 完成。P5 名稱不代表 Wall 直到最後才可用；現有 Wall 繼續工作，這一階段完成新核心的全面接入與最終效能驗收。

## 2. 建議模組與單一 writer 分工

路徑為建議，Brain 必須先對照部署現況；存在同名模組時擴充，不重複造輪子。

| Hand 邊界 | 建議檔案所有權 | 禁止跨寫 |
|---|---|---|
| Contract writer | `lib/session-sync/types.*`、wire fixtures、schema tests | 不順便改 AppShell、runtime 或兩份 protocol。介面冻结後再派下游。 |
| Read/index writer | `lib/session-read/**`、index tests、read API 專屬檔案 | 不碰前端；需要 rpc-manager event 接點以介面需求交 integration owner。 |
| Client/cache writer | `lib/session-sync/client/**`、cache／reducer tests、IndexedDB adapter | 不與另一 Hand 同改 useAgentSession。 |
| Hub writer | `lib/session-sync/server/**`、SSE endpoint、replay／backpressure tests | 不私自改命令語意。 |
| Core integration writer | `AppShell.tsx`、`ChatWindow.tsx`、`useAgentSession.ts`、Sidebar、rpc-manager 的必要 adapters | 這些 hot files 同一時段只給一位 writer；所有其他 Hand 只提供 patch 建議／contract。 |
| Independent reviewer／test writer | 測試 fixtures、E2E 專屬檔案、review report | 不與被審核 writer 共寫同一 production file。 |

建立依賴 DAG，不用「多開 Hand」換取同檔衝突。測試與協定、index 與 client 可平行；核心整合依已凍結契約串行完成。Brain 回報實際 branch／commit／owner，不假裝這份表已經派工。

## 3. 必要正確性測試

| ID | 情境 | Pass 條件 |
|---|---|---|
| C01 | 新頁面只用 normal，從未進 Wall | 新共用服務照常存在；不依賴 Wall mount 才初始化。 |
| C02 | A→B→A，A 在 memory cache | 顯示實際 A 內容不需等待 HTTP；草稿、branch、閱讀位置不串到 B。 |
| C03 | Wall→normal→Wall（重複 100 次） | 共用 store 存活、cache 不清空；穩態只有一條 session SSE／頁；watcher、listener、timer、通知沒有累積。 |
| C04 | 深歷史閱讀錨點約距 tail 1,000 entries | 缺快取時以 around-anchor 直接定位；不可從 tail 每 50 筆串行找回。anchor 失效回明確狀態。 |
| C05 | 故意讓舊 HTTP 在新快照／SSE 後抵達 | appliedRev 不倒退；同 session 不同 leaf、舊 auth namespace 回應也不能污染。 |
| C06 | HTTP snapshot 與 live 接上之間完成訊息 | 正式訊息最終恰好呈現一次；不靠下一次人工 Refresh 才補回。 |
| C07 | metadata-only session 已知 rev 高於本機內容 | 只更新 knownRev；切入後仍補缺內容，不提前推進 appliedRev。 |
| C08 | snapshot、diff、SSE 重複／亂序，或訂閱 ACK 晚到 | entry／revision 去重；更舊 generation 不覆蓋目前需求。 |
| C09 | IndexedDB 寫入前後 crash／quota／schema blocked | 不出現游標超前資料；可以降級，重新啟動可補齊。 |
| C10 | cursor 過期、hub 重啟、queue overflow | 明確 resync，再接 live；不無限 replay，不靜默漏正式資料。 |
| C11 | 瀏覽 12 個休眠 session／訂閱冷 session | 沒有因觀看而呼叫 AgentSession 啟動；read service 不內接 12 條舊 SSE。 |
| C12 | 全域 SSE 已連上，目標 session 尚未啟動 | Send 仍正確初始化／拒絕／回報 UNKNOWN；失敗不重送。 |
| C13 | Send 接受後回應遺失，再重連／切模式 | 沒有第二次 prompt／Stop／fork；未具備命令去重時禁止自動 retry。 |
| C14 | queued follow-up／steering、retry、compaction、extension run | 不於第一個 agent_end 過早結束；保留原 queue／draft recovery。 |
| C15 | blocking extension UI、同 session 多 view、replay | request 路由與回覆不交叉／重複；通知音不因 replay 再播。 |
| C16 | SDK event 與 watcher 同時報告一則完成訊息 | durable entry 與累積統計只入帳一次。 |
| C17 | 外部 CLI append，半行 JSON／跨 UTF-8 chunk | 只提交完整 entry；完成後可見；不宣稱看見尚未落盤 token。 |
| C18 | 同大小 rewrite、replace、truncate、delete／recreate | source generation 正確失效與重建；舊 offset／cache 不讀錯檔。 |
| C19 | fork、新 leaf、非 tail branch、compact、header rewrite | 內容符合 SDK fixture；fork ID rekey、wrapper 銷毀與 cold view 不混淆。 |
| C20 | tree 保留節點塞巨大 thinking／tool／base64 image | 導航不帶完整 entry；首屏 wire bytes 受預算限制。 |
| C21 | 四 session 同時生成，大量歷史＋一個巨大 tool body | A 更新不使 B/C/D 重算歷史；可輸入；一個大事件不餓死其他 session。 |
| C22 | 手機背景／鎖屏／被丟棄後恢復 | 先 cache、再校正；不要求背景永遠在线；不重播全部 token。 |
| C23 | 登出、auth scope 改變、session 撤權、跨 tab | stream 停止或重新授權；cache 分区／清除生效；不跨權限洩漏。離線顯示政策按核准決策測。 |
| C24 | 索引重建／DB 不可用／feature rollback | Pi JSONL 不受損；唯讀服務可有界降級；不可默默啟動 agent 來代替讀取。 |

另外保留現行 normal 與 Wall 的 Send／Stop、keyboard focus、toolbar、URL、draft、tool selection、file allow-list、project trust、branch navigator、export、extension 與自訂 parser 測試。新測試不能取代原測試。

## 4. 效能與資源驗收

先做「工作量與正確性」斷言，再做硬體相關數值。下列數字是候選工程預算，未量測，也不是保證：

| 指標 | 候選目標／量法 |
|---|---|
| memory cached switch | 指定桌面與 Android 裝置，輸入事件至實際訊息首屏 p95 < 100ms；阻斷網路仍成立。 |
| IndexedDB 恢復 | 分開記錄 app shell ready→cached content 與 navigation→content；不以 skeleton 冒充內容，也不隱藏 JS 初載時間。門檻由 G0 定案。 |
| warm indexed tail／anchor | 每個 query 的 full-file parse count = 0；工作量有界於頁面與索引定位，不隨全部歷史線性重建。 |
| 最近頁 payload | 以 count + bytes 雙預算；候選 JSON 256KiB，不含按需 body/media；過大合法降級且 UI 顯示可展開。G0 確認。 |
| input latency／render | 4-pane live、長工具輸出時分開量 p50/p95 input-to-paint、long tasks、pane render count；由 G0 定義装置與門檻。 |
| stream ownership | 穩態每頁恰有一條 session 更新 SSE；切模式不重建。網路重連過渡若有重疊須有明確短上限與 generation guard。 |
| resources | 登錄每 client queue bytes、cache bytes、DB size、watcher/listener count；模式切換 100 次及長跑無單調洩漏，達 quota 必須可降級。 |
| sync freshness | 分開記錄已管理 runtime event latency、外部 file observed latency、reconnect catch-up；不把三者混成「即時」。 |

fixtures 至少包括 50／1,000／10,000／50,000 entries、分支、深鏈、同筆巨大內容、4／8／12 sessions，以及 0／100／300ms 模擬 RTT。測 1 個和 2 個客戶端、agent 閒置與多 Hand 工作，避免只有理想本機空載數字。

server 記錄 API 分段耗時、source scan bytes、解析 entries、index hit、serialized bytes、event-loop lag 與 queue overflow；client 記錄 cache hit、stale response drops、diff bytes、recovery reason。log 使用 ID／統計，不收正文。

沿用現有 `npm test`（目前為 Node test runner）、`tsc --noEmit`、`npm run lint`，不為此強制遷移到 Vitest。production benchmark／release build 放在獨立 checkout／worktree，不在運行中的 dev checkout 做 `next build`，遵守 AGENTS.md。本次純文件提交不宣稱執行過上述 app tests。

## 5. Rollout／回退

先讀取層，再共用快取，再 transport 切換；每批保持可獨立回退。read／client／sync 開關為應用級能力，非 Wall-only 開關。

shadow read 只能比對資料與效能，不得 dispatch 命令。新舊事件路徑切換必須單一 reducer owner：不可同時兩邊各自追加訊息或播放通知。正式切新 transport 前先驗證冷啟動 Send 與 extension UI。

索引使用可重建 schema；遷移失敗不改 Pi 原始檔。保留舊 API 的相容 adapter，期限由 Brain 定案，避免永久養兩套資料真相。命令狀態不明時，回退也不能重播。

文件審查 PR 不合併任何實作。核准後 generic 內容依既有 upstream→main→feature→custom 路徑整合；如部署 HEAD 已前進，先重算差異，不把舊文件基底拿來覆蓋新程式。
