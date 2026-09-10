# P1：Normal／Wall 共用記憶體歷史快取與分段量測

狀態：**DRAFT_REVISED_FOR_BRAIN_REVIEW — 文件修訂已授權，程式實作未核准**  
文件版本：0.2（不是產品版本）  
日期：2026-09-10  
文件分支：`docs/session-sync-review`；審查 PR：#20

> 本版取代 0.1 提案的預定大架構與 P2–P6 排程。現在只有 **P1a memory-only 歷史讀取快取／GET coalescing** 與 **P1b 分段 profiling** 是候選實作範圍。其餘能力不是下一階段的自動開工指令。

## 目標與邊界

SST 內的 Normal 與 Session Wall 共用有容量上限的歷史讀取結果。即使本次開頁後從未进入 Wall，Normal 也應受益；切換顯示模式不能讓共用 cache 跟著消失。

**共享讀取資料，不共享整個執行狀態。** 保留既有 `useAgentSession`、per-session SSE、observer、command／sole-authority、runtime reducer，以及各 view 的 draft、scroll、queue、optimistic messages、extension UI 與 toolbar ownership。不建立新的全域 runtime store 或 Sync Manager。

| 場景 | P1 的承諾 |
|---|---|
| 同頁 A→B→A，對應歷史仍在快取 | 先顯示可用 transcript，再背景校正；不以空白 loading 遮住內容。 |
| SST Normal→Wall→Normal | 同一應用根層的 cache 可重用；每個 view 仍保留原本隔離與 guards。 |
| 手機 Normal 背景後回來，頁面仍存活 | 可沿用記憶體資料並校正；不新增 mobile Wall。 |
| 首次未快取的讀取、未保留的深歷史頁面 | 沿用現有讀取／分頁，量測剩餘成本；不承諾已消除冷讀成本。 |
| 整頁 reload、頁面遭丟棄、關閉後重開 | 不承諾保留歷史；本期不新增持久化與 diff-only resume。 |
| 另一套獨立 official Pi Web 前端 | 不會自動取得 SST 的 client cache。 |

## 可讀基準

- Source identity：`01f28079646952bcedbe88bd5b16913854c18382`，只記錄來源，不公開原歷史。
- 實際核對的 sanitized snapshot：`b1291393e0d1376d8fd0db3231cd1166a8c1e9ee`，ref 為 `review/sst-01f2807-sanitized`。
- 本版已直接讀取快照中的相關程式碼，見 [證據表](./00_BASELINE_AND_SCOPE.md)。這不是已在部署主機跑過效能測試的聲明。
- Snapshot 是沒有 parent 的審查材料，**不得合併、部署或拿來開實作分支**。文件仍沿原 docs branch 前進，不帶入 snapshot 的程式碼。

## 閱讀順序

1. [00 — 基準、程式碼證據與範圍修正](./00_BASELINE_AND_SCOPE.md)
2. [01 — P1a 共用快取契約](./01_ARCHITECTURE_AND_SYNC.md)
3. [02 — P1b 量測、交付與驗收](./02_DELIVERY_AND_TESTS.md)
4. [03 — Brain 複核、決策與開工 gate](./03_BRAIN_REVIEW.md)

## 本期不做

SQLite、content index、sidecar、multiplex SSE、HTTP/2 部署調整、replay protocol、IndexedDB、always-on collector，以及新的 around-anchor API、全面虛擬列表改造、原生 App，全部是 **DEFERRED_OPTIONS**。只有量測證據或新的產品需求觸發，再另開 ADR／Owner decision；不自動排入 milestone。

## 授權與文件分層

本次只修改本目錄五份提案、SST README 的待審入口與 PR 說明。既有 delivered/frozen 規格、trackers、程式、套件、部署與服務皆不變。文件作者沒有派 Hand、建立實作 issues、執行 application tests 或發送真實 prompt／Stop。

Brain 下一輪只需複核這份 **0.2 docs commit** 的接入邊界、驗收、具體 cache 配額與回退。完成複核、記錄 Owner 對確切文件 commit／實作來源 SHA／範圍的核准後，才建立 post-v0.1 任務。保留原有 generic→custom 分層；不要把本文件分支的舊程式樹反向合併進目前部署。
