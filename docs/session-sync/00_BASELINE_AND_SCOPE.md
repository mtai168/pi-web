# 00 — 可讀基準、證據與範圍修正

狀態：**DRAFT_REVISED_FOR_BRAIN_REVIEW — 實作未核准**

## 1. 三個不同的版本身份

| 身份 | 固定 SHA／用途 |
|---|---|
| 舊提案文件 | `642ca316b39702ac8d8becb726388f9d127ad4d0`；本次文件修訂的 parent，不是新版程式證據。 |
| 原始部署來源 | `01f28079646952bcedbe88bd5b16913854c18382`；仍保留在 Owner 環境，不要求公開歷史。 |
| 可獨立讀取的 review snapshot | `b1291393e0d1376d8fd0db3231cd1166a8c1e9ee`；本次以下程式碼連結全部固定到這個 SHA。 |

[快照說明](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/REVIEW_SNAPSHOT.md)及[逐檔 manifest](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/REVIEW_SNAPSHOT_MANIFEST.tsv)記錄：579 UNCHANGED、1 SANITIZED、5 EXCLUDED，另有生成的說明／manifest；`next.config.ts` 的私密 host 已替換，workflow 與真實截圖未納入。這些「與 source 相同」的對照依據是部署端 manifest；提案方未取得私有 source tree 重新做逐 byte 比較。

提案方直接確認 review commit 無 parent，並核對下表的實際程式碼。未連入部署主機、未核對現在的服務 PID、未重啟或跑真實 agent，也沒有執行 application tests。快照未包含的部署配置／歷史不列為獨立驗證通過。

[package.json](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/package.json)宣告 Pi Web `0.9.0`、Pi SDK `0.85.1`、Next `16.3.1`、React `^19.2.4`；不要把 manifest 的版本宣告當成部署 node_modules 已被重新驗證。開工前 Brain 再核對當時實際 HEAD 與 lockfile。

## 2. 本次直接核對的程式碼

E 編號供其他文件引用；表列範圍是實際閱讀的相關區段，不宣稱逐行審查全部 579 個檔案。

| ID | 精確位置 @ review SHA | 可確認行為與 P1 含義 |
|---|---|---|
| E1 | [AppShell 1780–2030](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/components/AppShell.tsx#L1780-L2030)、[3280–3540](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/components/AppShell.tsx#L3280-L3540) | Wall 的 renderer 建立 keyed SessionWallChatWindow；Normal 的 ChatWindow 在 `workspaceMode === normal` 才掛載。共用 read cache 必須在模式條件外；不能推論隱藏 Wall 已全部卸載。 |
| E2 | [SessionWallChatWindow](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/components/session-wall/SessionWallChatWindow.tsx) | Wall adapter 最後使用同一 ChatWindow，另有 toolbar reporter ownership。沿用此 adapter，不另造一套聊天元件。 |
| E3 | [useAgentSession 300–629](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/hooks/useAgentSession.ts#L300-L629) | hook 保有 draft／runtime／queue／extension refs；loadSession 直接 GET detail，已有 observerSnapshotSeq、pagination generation、loading ownership 與 stale 404 guards。加入 cache 不得繞過這些 consumer guards。 |
| E4 | [useAgentSession 630–880](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/hooks/useAgentSession.ts#L630-L880) | loadContext 有 signal、anchor 存在性、page generation 與 entry ID 去重；ensure_session、get_tools、system info 等仍是命令路徑。只在 detail/context GET 接 coalescer。 |
| E5 | [useAgentSession 1120–1340](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/hooks/useAgentSession.ts#L1120-L1340) | 已有 active-run reconcile、visibility／online 恢復、connected 的 observer reload、session_snapshot 的 transcript 取代。應在既有事件接點通知 cache 失效，而不是另建 observer。 |
| E6 | [detail GET 1–112](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/app/api/sessions/%5Bid%5D/route.ts#L1-L112) | 使用 live SessionManager 或 SessionManager.open，再處理 entries、tree、context、全歷史 stats／timing、project info 與 JSON response。仍有 P1b 必須拆量的成本；不是只讀 tail 筆數。 |
| E7 | [context GET](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/app/api/sessions/%5Bid%5D/context/route.ts) | 接 leafId／before／tail／defer，回 context；沒有 durable contentRev，也不總是回傳 resolved leaf。cache 不得虛構缺少的 view／revision 證明。 |
| E8 | [sessions state route](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/app/api/sessions/%5Bid%5D/state/route.ts) | `/api/sessions/[id]/state` 在新版確實存在，處理 readOnly／authority。原 0.1 文件將這個路徑視為誤植的敘述撤回。cache hit 不能略過既有 state 流程。 |
| E9 | [SSE route](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/app/api/agent/%5Bid%5D/events/route.ts) | external-owner 模式直接代理 owner stream，失敗 fail closed；非 external 模式才走 local wrapper／authority-error observer。不能再概括成所有 SST SSE 都在本地啟動 agent。 |
| E10 | [command/state route](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/app/api/agent/%5Bid%5D/route.ts) | commands 在 external-owner 模式轉送，取消有 outcome-unknown 回應，無 local writable fallback。P1 不新增 retry、receipt ledger 或變更 authority。 |
| E11 | [useSessionCatalog 1–230](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/hooks/useSessionCatalog.ts#L1-L230)、[session-reader 1–220](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/lib/session-reader.ts#L1-L220) | 已有 catalog requester、running poller 介面、listSessionsIncremental 接點、TTL cache 與 generation-aware list promise coalescing。清單能力不重做，也不把 sessionListVersion 當內容版本。 |
| E12 | [session-observer 1–230](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/lib/session-observer.ts#L1-L230) | 已有唯讀 JSONL observer 的 deps／snapshot、poll/stability/force-read 參數及 torn/cyclic entry 驗證。不新增 scanner／collector；本輪沒有重新審查此檔全部排程分支。 |
| E13 | [observer tests 1–150](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/lib/session-observer.test.mjs#L1-L150)、[events route tests](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/app/api/agent/events-route.test.mjs) | 已有 snapshot／未知 running 與 SSE 啟動／buffering 測試。只做靜態閱讀，不宣稱本輪測試通過；P1 新測試應補充而非取代它們。 |

## 3. 由證據導出的修訂

可以確定的接入點是既有 detail/context GET 與 AppShell 模式邊界，不是整個 runtime 重寫。既有 stale guards 也不是共用 cache 的自動保證：consumer 拒收的舊回應，仍必須在 cache admission 層被拒絕。

Catalog 增量索引與 content 查詢索引是不同能力；E6/E7 顯示後者的成本仍應量測，但本次不新增 content index。快照 GET 的 live-manager 路徑也不能被當成磁碟已 fsync 的證明；正式 cache projection 的來源限制見 01。

已撤回的 0.1 承諾：新的 SessionStore 接管全域 runtime、單一 SSE 作為硬 gate、always-on collector、SQLite index、IndexedDB、replay，以及 cold tail query 不得 full-parse 等跨期驗收。本版不偷偷以「優化」恢復它們。

## 4. Frozen 文件與部署證據邊界

[現行 persistence 規格](https://github.com/mtai168/pi-web/blob/b1291393e0d1376d8fd0db3231cd1166a8c1e9ee/docs/session-wall/03_STATE_AND_PERSISTENCE.md#L150-L173)禁止 Wall storage 保存 message／prompt／tool output。本期只新增記憶體讀取副本，不改這個政策，也不影響既有 draft 的特定保存契約。

交付後的 `docs/session-wall/02` 至 `08`、SST frozen 文件及 trackers 不在本次修改清單。核准實作後若需要正式補充，另作 post-v0.1 addendum，列明相容性，不改寫已交付歷史。應涵蓋：共享 read cache 所有權、memory-only 隱私邊界、失效／取消、效能與回退，以及單一 hot-file writer。

[Brain 交接與修訂授權](https://github.com/mtai168/pi-web/pull/20#issuecomment-5623033775)是部署狀態與清理範圍的來源；本提案不重刊內網位址、私有路徑、私人分支名稱或舊敏感留言內容。開工時由 Brain 鎖定真實最新整合 SHA，記錄相對來源的 delta，不使用 review snapshot 或 docs branch 作實作基底。
