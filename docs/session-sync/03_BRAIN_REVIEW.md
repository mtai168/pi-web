# 03 — 給 SST Brain 的 0.2 複核與開工 gate

狀態：**DRAFT_REVISED_FOR_BRAIN_REVIEW — 尚未核准實作**

## 1. 已完成與尚未完成

Owner 已授權文件修訂與經清理的 review snapshot。提案方現在已直接核對 `b1291393e0d1376d8fd0db3231cd1166a8c1e9ee` 的相關程式碼，並將草案收斂為 P1a/P1b；不再以舊 `0.8.11` 程式碼規劃新版 runtime。

這不代表原部署歷史已公開、不代表每個檔案皆已稽核，也不代表服務與測試被提案方重新執行。證據分層見 00。已移除所有要求自動實作 SQLite／multiplex／replay／IndexedDB 等後續階段的排程。

[Brain 對 ceb54c3 的複核](https://github.com/mtai168/pi-web/pull/20#issuecomment-5623700887)為 **ACCEPT_WITH_CHANGES**：架構無 blocker，只需落實 external-owner-only admission v1、T04 dual-consumer harness，以及留言已收斂的配額／flags／量測参数。本次在 01/02 寫回這些澄清，03 同步決策與 gate，仍屬文件版本 0.2。README、00、SST README、frozen 正式契約与全部程式不因這輪修改。

**下一輪只核對 `ceb54c3 → 新 docs SHA` 的 exact diff，不重新開整體架構審查。** 不派 production writer、不改 deployed/frozen 文件、不建立實作 issues／調整 milestone、不發真實 prompt／Stop、不部署／重啟。文件審查可在原有工作流程完成，不需再公開原始 191 commits。

## 2. D01–D10 收斂紀錄

「已收斂」表示規劃方向已同意，不是 Owner 的程式開工授權。

| ID | 0.2 決策／本輪落實 |
|---|---|
| D01 模式與所有權 | 已收斂：AppShell 模式邊界外的 stable client provider，共享 read cache；原 hook／runtime 保留。Normal 不依賴 Wall 啟動。 |
| D02 server／topology | 已收斂：本期不新增 index、DB、worker、sidecar、collector；P1b 可觀測既有 server 路徑。 |
| D03 來源與外部更新 | 已收斂並寫入 01 §2.1：最近 guarded state 確認 `readOnly === true` 且 `authority === "external_owner"`；detail／有 leaf 或 before 的 context 才可 admission；其他來源全部 bypass，不新增 revision/API。 |
| D04 freshness／coalescing | 已收斂並寫入 01 §3–6：exact key＋不可重用 barrier；trigger 表；requestToken identity 清理；最後 consumer 離開立即 abort，120 秒 timeout；首次 state 後才 admission pending candidate。 |
| D05 本機隱私 | 已收斂：memory-only，無新歷史持久化；原 frozen privacy 與 draft 特例不變。未來離線政策本期不需決定。 |
| D06 command／authority | 已收斂：不改 command、ready、queue、UNKNOWN 與 fail-closed；cache hit 不略過既有 state 載入。 |
| D07 transport／extension | 已收斂：保留 per-session SSE／observer／runtime reducer／extension UI；不要求單一 SSE 或重寫事件 schema。 |
| D08 分工與里程碑 | post-v0.1，尚未建 issue 或指定 milestone；開工時再查 active Hands，hot files 單 writer，不依賴過往「沒有 Hand」報告。 |
| D09 配額與量測 | 已寫入 01 §7 與 02 §4：Desktop/Mobile 雙配額、deterministic estimator、兩個 default-off flags、3 warm-up＋20 samples、cold/miss p95 回歸界線及資源回歸。數值非已量測 SLA；仍待 Owner 隨 exact docs SHA 核准。 |
| D10 已有能力與必要修改 | 已有 catalog/observer/guards/authority 路徑重用。T04 只在 cache adapter/hook harness 建立雙 consumer，保留 Wall duplicate-session 禁止規則，不新增 UI 能力。 |

## 3. Exact-diff 回覆格式

```text
Review status: ACCEPT / ACCEPT_WITH_CHANGES / NEEDS_REVISION
Compared docs: ceb54c375db137b0241d43147f71822a803c9ccb -> <新 docs SHA>
Reviewed code: b1291393e0d1376d8fd0db3231cd1166a8c1e9ee
Source identity: 01f28079646952bcedbe88bd5b16913854c18382
Current implementation source SHA: <開工前部署端再核對；有前進則列 delta>

1. Admission v1 的條件、producer/bypass 表、首次 guarded state 後
   admission 與既有 authority/runtime/state 路徑，是否與留言一致？
2. T04 是否明確為 harness，Wall duplicate-session 規則不變？
3. 配額、estimator、flags、samples、p95 公式與回退是否準確？
4. Diff 是否只落在提案 01/02/03、沒有 deferred／frozen／程式變更？
5. 如仍有問題，只列此 diff 的具體差異；沒有就回覆 ACCEPT，
   附 exact docs SHA，交 Owner 決定是否核准實作。
```

審查直接留在 PR #20；必要時提供 `file:function/line @ SHA`。原來含敏感部署資料的留言已重建，請使用目前公開的去識別化留言／snapshot 連結，不重新貼私密值或舊歷史原文。

## 4. Gate 狀態

| Gate | 本輪狀態 |
|---|---|
| 可讀的固定 review baseline | **AVAILABLE**：sanitized `b1291393…`；不再要求公開 source 原歷史。 |
| 提案方相關程式碼獨立閱讀 | **DONE_FOR_LISTED_SCOPE**：00 的 E1–E13；本輪另核對 external-owner 的 state／startRpcSession 接點，非整體部署驗證。 |
| Brain 對 ceb54c3 架構與範圍複核 | **ACCEPT_WITH_CHANGES**：見上述固定留言；不把它說成新 docs SHA 已通過。 |
| Admission、T04、配額／flags／量測寫回文件 | **本次 docs commit 交付**；以 PR head／交接留言記錄 SHA。 |
| Brain 對本次 exact diff 複核 | **PENDING**。 |
| 開工時真實整合 HEAD／delta／writer ownership | **PENDING**，不得用 review root 或 docs branch。 |
| Owner 核准實作 | **NOT APPROVED**。 |

只有核准後才填：Owner 核准引用、docs commit、實作 SHA、P1a/P1b 明確範圍、excluded options、驗收／配額與回退、post-v0.1 issues／依賴及 writer。未填不應自動派 Hand。

## 5. 文件與程式的整合規則

本輪只改 `docs/session-sync/01_ARCHITECTURE_AND_SYNC.md`、`02_DELIVERY_AND_TESTS.md`、`03_BRAIN_REVIEW.md` 及 PR 說明／交接留言。既有提案入口不改，原 frozen 02–08／trackers 不改。文件分支以 `ceb54c375db137b0241d43147f71822a803c9ccb` 為 parent 前進，不 rebase 到 sanitized root；程式資料僅作外部固定引用，不拷貝進 docs PR。

正式開發從 Brain 核對的真實整合 HEAD 開工作分支，遵守既有 generic→custom 分層。若需將新提案帶到較新的產品分支，只搬核准的文件變更，不反向合併舊程式樹。feature flag 退回原 read path，不創造第二套 runtime；未來 deferred options 另開 ADR，不接成自動的 P2。
