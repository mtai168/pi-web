# 03 — 給 SST Brain 的 0.2 複核與開工 gate

狀態：**DRAFT_REVISED_FOR_BRAIN_REVIEW — 尚未核准實作**

## 1. 已完成與尚未完成

Owner 已授權文件修訂與經清理的 review snapshot。提案方現在已直接核對 `b1291393e0d1376d8fd0db3231cd1166a8c1e9ee` 的相關程式碼，並將草案收斂為 P1a/P1b；不再以舊 `0.8.11` 程式碼規劃新版 runtime。

這不代表原部署歷史已公開、不代表每個檔案皆已稽核，也不代表服務與測試被提案方重新執行。證據分層見 00。已移除所有要求自動實作 SQLite／multiplex／replay／IndexedDB 等後續階段的排程。

**請複核這次 docs commit，不要先開始實作。** 不派 production writer，不改 deployed/frozen 文件、不建立實作 issues／調整 milestone，不發真實 prompt／Stop、不部署／重啟。文件審查可在原有工作流程完成，不需再公開原始 191 commits。

## 2. D01–D10 收斂紀錄

「已收斂」表示規劃方向已同意，不是 Owner 的程式開工授權。

| ID | 0.2 決策／下一輪只需補的內容 |
|---|---|
| D01 模式與所有權 | 已收斂：AppShell 模式邊界外共享 read cache，Normal 不依賴 Wall；原 hook／runtime 保留。Brain 指定最小注入點。 |
| D02 server／topology | 已收斂：本期不新增 index、DB、worker、sidecar、collector；P1b 可觀測既有 server 路徑。 |
| D03 來源與外部更新 | 沿用現有 observer／sole-authority。待核對：歷史 projection producer/欄位來源，何時可 admission、何時 bypass；API 未提供的 durable 證明不得虛構。 |
| D04 freshness／coalescing | 已收斂：同 key 同本地 barrier 才共用；cache 與 consumer 雙層 guards。待補 trigger 表、取消／registry 清理與 anti-ABA 測試映射。 |
| D05 本機隱私 | 已收斂：memory-only，無新歷史持久化；原 frozen privacy 與 draft 特例不變。未來離線政策本期不需決定。 |
| D06 command／authority | 已收斂：不改 command、ready、queue、UNKNOWN 與 fail-closed；cache hit 不略過既有 state 載入。 |
| D07 transport／extension | 已收斂：保留 per-session SSE／observer／runtime reducer／extension UI；不要求單一 SSE 或重寫事件 schema。 |
| D08 分工與里程碑 | post-v0.1，尚未建 issue 或指定 milestone；開工時再查 active Hands，hot files 單 writer，不依賴過往「沒有 Hand」報告。 |
| D09 配額與量測 | 待 Brain 提具體 cache／單項／registry 上限、估算方法、flag、測試裝置與 baseline 採樣方法；不得把舊 100ms／256KiB 當已核准門檻。 |
| D10 已有能力與必要修改 | 已有 catalog/observer/guards/authority 路徑重用。Brain 指出仍有錯誤的程式碼證據或更小接法；不為符合命名重造模块。 |

## 3. 下一轮回覆格式

```text
Review status: ACCEPT / ACCEPT_WITH_CHANGES / NEEDS_REVISION
Reviewed docs commit: <這次 PR #20 的確切 head SHA>
Reviewed code: b1291393e0d1376d8fd0db3231cd1166a8c1e9ee
Source identity: 01f28079646952bcedbe88bd5b16913854c18382
Current implementation source SHA: <部署端核對；有前進則列 delta>

1. P1a/P1b 是否精確，不含 deferred 項目的暗中前置條件？
2. producer→cache projection、來源可辨識／bypass 條件與 key 欄位表。
3. invalidation triggers、request cancellation、cache admission 與
   既有 observer/pagination/loading guards 的接入位置。
4. cache hit 如何先顯示 transcript，又不跳過 state／ready／runtime？
5. 配額、flag、estimated bytes 方法、測試裝置／raw baseline 方案。
6. T01–T20 與既有 tests 的覆蓋、需新增測試、單一 writer 分工及回退。
7. frozen 正式契約保持不變的確認；核准後需要的 post-v0.1 addendum。
8. 尚未解決的 blocker；不要把「未量測」包裝成測試通過。
```

審查直接留在 PR #20，提供 `file:function/line @ SHA`。原來含敏感部署資料的留言已重建，請使用目前公開的去識別化留言／snapshot 連結，不重新貼私密值或舊歷史原文。

## 4. Gate 狀態

| Gate | 本輪狀態 |
|---|---|
| 可讀的固定 review baseline | **AVAILABLE**：sanitized `b1291393…`；不再要求公開 source 原歷史。 |
| 提案方相關程式碼獨立閱讀 | **DONE_FOR_LISTED_SCOPE**：00 的 E1–E13；非整體部署驗證。 |
| 依共識修訂 P1 文件 | **本次 docs commit 交付**；以 PR head／交接留言記錄 SHA，避免文件自指循環。 |
| Brain 對 0.2 文件複核、參數／producer 條件定案 | **PENDING**。 |
| 開工時真實整合 HEAD／delta／writer ownership | **PENDING**，不得用 review root 或 docs branch。 |
| Owner 核准實作 | **NOT APPROVED**。 |

只有核准後才填：Owner 核准引用、docs commit、實作 SHA、P1a/P1b 明確範圍、excluded options、驗收／配額與回退、post-v0.1 issues／依賴及 writer。未填不應自動派 Hand。

## 5. 文件與程式的整合規則

本次修改只在 `docs/session-sync/`、SST README 的待審入口與 PR 說明。原 frozen 02–08／trackers 不改。文件分支沿 `642ca316…` 前進，不 rebase 到 sanitized root；程式資料僅作外部固定引用，不拷貝進 docs PR。

正式開發從 Brain 核對的真實整合 HEAD 開工作分支，遵守既有 generic→custom 分層。若需將新提案帶到較新的產品分支，只搬核准的文件變更，不反向合併舊程式樹。feature flag 退回原 read path，不創造第二套 runtime；未來 deferred options 另開 ADR，不接成自動的 P2。
