# 02 — P1b 量測、交付、驗收與回退

狀態：**DRAFT_REVISED_FOR_BRAIN_REVIEW — 實作未核准**

本版沒有自動續做的 P2–P6。以下工作包不是已建立 issue／milestone；只有 Owner 核准後才可派實作 Hand。

## 1. 交付順序

| 工作包 | 內容 | 出口 |
|---|---|---|
| R0：本輪文件複核 | Brain 對照 review SHA 核對 projection／producer、cache key／barrier、現有 hot files 與測試；提交配額、flag 與量測環境建議 | Owner 核准 docs commit、真實實作 SHA、P1 範圍及驗收；目前尚未通過。 |
| P1b-baseline | 在核准的隔離環境取得現有 cold/warm、server/client 基準；profiling hook 只記成本，不更改讀取或命令語意 | 有 raw samples、模式／來源／資料量與環境記錄；不要只報平均。 |
| P1a-core | 有界 memory projection cache、in-flight coalescer、失效／取消與單元測試 | identity、stale admission、共享取消、容量與錯誤測試通過。 |
| P1a-integration | 單一 integration writer 將 AppShell、ChatWindow／useAgentSession 的 detail/context 讀取接入；保留 runtime 與 per-session SSE | Normal 從未開 Wall、Normal↔Wall、四格與 mobile Normal 驗收。 |
| P1b-comparison | 同樣條件比較 flag off/on，分開 cached paint、revalidated paint、HTTP 數量與記憶體成本 | 正確性通過、回退可用，Owner／Brain 檢視效益及剩餘瓶頸。 |

baseline 與獨立 cache 單元模組可在介面確認後平行；不要求先有龐大 benchmark 平台，也不以「只做 profiling」取代已同意的 cache 改善。

## 2. P1b 的量測邊界

### Server：沿現有 detail/context 路徑拆段

依 00 的 E6/E7，記錄 request id（非私密路徑）、read mode、cache cold/warm、總 entries／回傳 entries、歷史種類與下列 spans：

| 階段 | 測法與限制 |
|---|---|
| resolve/open/read/parse | 先分 resolveSessionPath 與 SessionManager.open。SDK 內無可靠細分時標成 `open_read_parse` aggregate，不能把整段假稱純 JSON parse；也不要求為 P1 修改 SDK。 |
| entries/context | entry 取得與 buildSessionContext 分開；記錄 tail/before、結果數量與耗時，不新增索引。 |
| tree/project | getTree 與 projectTreeForResponse 可分段；即使快取只保存 transcript，仍量 API 回傳 tree 的成本。 |
| stats/timing | computeSessionStats、computeSessionTotalActiveMs 分段。 |
| metadata/project info | stat、parent resolution、attachSessionProjectInfo 等獨立記錄，避免把這些等待全部算進 parse。 |
| serialize/response build | 測實際序列化或 response construction 的可觀察邊界；不為計時額外 JSON.stringify 一次完整歷史，不以準備 DTO 的時間冒充 network send。 |

nested spans 不重複加總；proxy request 與本機 read 分別標示，不從兩台未同步時鐘相減造出精確 latency。若無法取得某段，標 N/A／aggregate 與原因。

### Client 與 wire

分開記錄：使用者切換事件、cache lookup、histories 可用、實際 cached transcript 首次可見、revalidation request start/body end/parse、guarded commit、revalidated transcript 可見。既有 JS／app shell 啟動時間另外報告，不能藏在「cache 很快」之外。

瀏覽器 Resource Timing／DevTools 可提供 TTFB、body transfer、encoded／decoded／transfer size、nextHopProtocol 等資料；TTFB 不是純 server 計算時間，responseEnd-responseStart 也不是純網路 RTT。`Response.json()` 可包含 body 等待與 parse，不要直接命名為 parse-only。缺少量測權限／欄位時保留 unknown，不放寬 CORS／授權來追數字。[R1]

Server-Timing 可作為數字 spans 的候選載體，但不是要求新增 protocol。不得把 session 正文、內部 host/path、工具參數或 credentials 寫進 headers/logs。[R2]

React commit／requestAnimationFrame 只能作觀測代理；以瀏覽器 trace 或 E2E 的實際內容可見性核對 cached/revalidated paint，說明量法限制。使用合成對話，避免再產生真實 session 截圖或持久化敏感 HAR。

同時記錄 exact-key hits/misses/bypasses、coalesced callers、stale admission drops、active GETs、估算 cache bytes、eviction、heap trend、event-loop lag、render 次數。診斷資料本身須有上限，量 off/on 的 instrumentation overhead。

### SSE 只觀察，不改造

記錄實際 browser→SST 與 SST→owner 的協定／連線數／排隊／重連。成功定義不是「恰好一條 SSE」，也不改 HTTP/2、proxy、subscription 或 existing grace timers。若發現 connection-slot 問題，記入獨立後續決策。

## 3. P1 必要驗收

| ID | 測試 | Pass 條件 |
|---|---|---|
| T01 | 新頁直接 Normal，從未進 Wall | cache owner 已存在，歷史 GET 能使用新 adapter。 |
| T02 | 同頁 A→B→A，A key/coverage 命中；刻意延後背景 HTTP | 實際 transcript 在 HTTP 完成前可見；不是 skeleton／空白 loading；稍後校正不回退。 |
| T03 | Normal→Wall→Normal 重複切換 | cache 不被模式卸載清空；原有 selection、scroll、draft、toolbar ownership 不串格。SSE 維持既有策略，不新增重連 storm。 |
| T04 | 四格與兩個 view 指向同一 session | 歷史可共享；typing、queue、optimistic、extension UI、focus 各自正確；一個 view 的 lazy hydration 不 mutate 另一個。 |
| T05 | 同 key 同 barrier 的 GET 並行 | 一個進行中 fetch 供相容 consumers；detail/context、leaf/before/tail/defer/來源不同不誤合併。 |
| T06 | observer／connected／refresh 令 barrier 前進 | 新 revalidation 不加入旧 Promise；舊 200 不寫成 fresh cache，舊 404／error/finally 不破壞新狀態。 |
| T07 | 單一 consumer unmount／abort，另一個仍等待 | shared GET 繼續；退出者不套用。settled/failed/aborted registry 回收；最後 consumer 政策有界。 |
| T08 | eviction／clear 後同 key 新請求，舊請求晚到 | 沒有 generation ABA；舊結果不能重新污染 cache。 |
| T09 | active leaf 移動、explicit leaf、舊 before anchor | key/coverage 正確；保留既有 pagination 與 observer guards／entry ID 去重；未知 resolved leaf 不造假。 |
| T10 | cache hit 同時有更新的 observer snapshot／optimistic view | cache hydrate 不倒退已知新視圖；revalidation 仍走原 guards。 |
| T11 | cache hit + includeState／command readiness | `/api/sessions/[id]/state` 等原流程不被略過；不從歷史推斷 running／authority／agent ready。 |
| T12 | 巨型 tool/media entry、很多 pages、頻繁失效 | pages/entries 與 estimated bytes 雙上限；單項 bypass；pending registry／tokens／diagnostics 不洩漏，eviction 不丟 draft。 |
| T13 | cache miss／網路錯誤／接受的 404 或拒絕存取 | 沿用載入與錯誤語意；可保留的 stale 內容與必須失效的資料明確區分；不提升 command 權限。 |
| T14 | 手機 Normal A→B→A、背景回前景、輸入／捲動 | 指定 Android browser 的針對性 consumer regression 通過；頁面被丟棄時安全走 cold path。不新增 mobile Wall。 |
| T15 | reload／關閉頁面／storage 檢查 | 沒有新增 transcript 持久化；memory 消失後正確讀取。既有 draft 保存不因 cache 功能改變。 |
| T16 | read retry、模式切換、cache 恢復 | 不重送 prompt／Stop／fork；commands 不進 coalescer；UNKNOWN／sole-authority fail-closed 回歸通過。 |
| T17 | cache source 分類與 response projection | 只保存允許的歷史部分；transient/live-unknown 可 bypass，不把 SessionData／runtime event 全包入 cache；不偽造 durable revision。 |
| T18 | refresh／observer 重複提示、四格大量更新 | 無自我失效循環／無界 retry；只按實際需要校正，不為每 token 發新 GET。 |
| T19 | instrumentation off/on、flag rollback | 不改 response／authority／command 語意；關掉 cache 回原 read path，pending consumers 可完成或安全取消，不重新 dispatch 命令。 |
| T20 | 真正 cold/uncached 長歷史 | 如實報告仍有 parse/tree/stats/wire 成本；不得用 warm cache 的結果假称 cold API 已最佳化。 |

這些是候選測試，不是本輪已通過的結果。保留現有 catalog、observer、stale loading/pagination、draft、fork／tool recreation、retry/compaction/queue、extension、authority、SSE、toolbar、file allow-list 與自訂 parser 測試。既有 SSE 可能進行的初始化不因 P1 被重新定義；只檢查 cache 本身沒有引入新副作用。

## 4. 測試矩陣與效能判斷

桌面 2×2 是主要使用情境；2×4／2×6 做既有 regression/resource coverage，不新增功能。Mobile 僅 Normal 的針對性操作。Brain 記錄指定 desktop／Android 裝置、browser／Node、讀取來源角色、啟動模式、資料量與合成內容類型。

至少比較小歷史、長歷史、同筆巨大工具內容；fresh open、cache hit、cache evicted、前背景恢復；agent 閒置與四個 mocked streams 活動時。延遲與亂序以可控制的 fake fetch／合成 server 測試，不能靠操作真實使用者 session 發 prompt／Stop。

採 p50/p95、樣本數、冷暖分開與 raw measurements；具體毫秒、配額與容許 regression 由 Brain 根據 baseline 提案後鎖定。原 0.1 的 100ms／256KiB 並非核准硬門檻。裝置無關的 gates 是可见內容不等 revalidation、正確 coalescing、沒有 stale poisoning 與資源有界；不能只以「感覺變快」收工。

## 5. 分工與回退

候選 file ownership：cache module/tests 一位 writer；AppShell／ChatWindow／useAgentSession 及必要 adapter 的 integration 一位 writer；profiling 在獨立 utility/harness 可平行，但同 route／hook 與 integration writer 串行協作；獨立 reviewer 不與 writer 同改 production hot file。路徑在派工前由 Brain 對照現況，這不是現在已派 Hand。

Feature flag 為應用級 read-cache 能力，不綁 Wall。回退只停用 admission／reuse／coalescing、回原 GET；不重置 authority、SSE 或 runtime，不刪 Pi 檔案，不重送命令。未完成的共享請求以原訂約定收尾，不能讓 rollback 的舊 callback 套入新 view。

沿用 package 的 Node test runner、typecheck、lint 與現行 E2E；不強迫換 Vitest。不在運行中的 dev checkout 做 `next build`，遵守 AGENTS.md；正式 build／benchmark 僅在經核准的隔離環境。開工後先跑相關單元與整合，再跑既有回歸。本輪只檢查文件與程式碼證據，沒有跑 application tests。

## 6. Deferred options 的觸發條件

| 獨立候選 | 才值得重新評估的原因 |
|---|---|
| content index／SQLite／sidecar | uncached detail/context 的 server 成本仍主導，現有讀取機制無法合理改善；先比較更小改動，不預選技術。 |
| multiplex／HTTP/2 調整 | 實際連線排隊／重連或 deployment 限制有證據；另審協定、authority 與取消語意。 |
| replay | 有新的無缺口恢復需求或既有恢復不足的可重現情境；另定事件與版本契約。 |
| IndexedDB | Owner 要求跨重開歷史；先決定授權分區、撤權、離線顯示與清除政策，非本期隱含授權。 |
| always-on collector／新 around-anchor／render 重構／原生客戶端 | 明確產品或 profiling 證據，另作範圍與成本決策。 |

沒有自動「P1 完成就派下一階段」。量測可得出暫不需要額外架構的結論。

## 平台依據

- R1：[MDN PerformanceResourceTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming)，用於瀏覽器側 timing／size／protocol 的能力與限制。
- R2：[MDN Server-Timing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Server-Timing)，用於選擇性呈現 server spans；不提供應用層一致性保證。
