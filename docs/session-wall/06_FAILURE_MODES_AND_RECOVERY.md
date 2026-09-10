# Session Wall 失敗模式與復原

狀態：**FROZEN FOR v0.1.0**

## 1. 核心不變量

任何失敗情況下：

- 不得把訊息送到錯誤 session。
- 不得因 UI unmount停止後端 Agent。
- 不得讓單 pane error摧毀整個 Wall。
- 不得默默丟失未送出 draft。
- 不得將 stale response套用到新 focus或新 slot。
- 不得擴大檔案權限範圍。

## 2. Session 不存在

情境：session被刪除、搬移、catalog暫時未列出。

行為：

- Pane顯示 stale state。
- 保留 slot config。
- 提供 Refresh／Replace／Remove。
- 不自動選擇「看起來相似」的 session。
- 若同 ID重新出現，恢復載入。

## 3. Session load 失敗

情境：HTTP error、malformed JSON、session reader錯誤。

行為：

- Error boundary只替換該 pane body。
- Header仍可顯示 catalog metadata。
- 提供 Retry。
- 其他 pane保持可互動。

## 4. SSE 斷線

- 沿用既有 AgentEventConnection reconnect。
- Pane顯示 reconnecting／stale indicator，不應假裝 idle。
- running reconcile確認 canonical state。
- 重新連線後避免重複插入已持久化訊息。

## 5. Server restart

- 所有 SSE終止。
- 前端 retry/reconcile。
- server恢復後重新讀 session file與 running state。
- 未送出 draft保留。
- 已送出但 response遺失的 prompt依既有 ambiguity contract處理，不自動重送。

## 6. Mode switch during streaming

- 切換模式不呼叫 abort。
- normal ChatWindow unmount或 wall pane unmount僅關閉 client connection。
- 新 UI mount後先抓 state，再決定是否接 SSE。
- optimistic bubble不得在兩個 UI instance中被重複永久保存。

## 7. Focus race

情境：A pane stats request很慢，使用者已聚焦 B。

行為：

- AppShell callback攜帶 sessionId/generation。
- 不符目前 focus的結果丟棄。
- Toolbar不能短暫顯示 A data並讓 B action使用。

## 8. Slot replacement race

- Replace前 increment pane runtime revision。
- 關閉舊 EventSource。
- 舊 fetch callback檢查 revision/sessionId。
- 新 session mount前清空舊 transcript顯示，避免錯認。
- Draft依 session key分離，不移轉舊 draft到新 session。

## 9. Prompt rejection／ambiguity

- Definitive rejection：移除 optimistic user message並還原到該 pane draft。
- Transport ambiguity：不立即還原成可再次送出的 draft；先以 state/reconcile確認。
- Error notice顯示於來源 pane。
- 不得因另一 pane成功而清掉來源 pane錯誤。

## 10. Blocking extension UI

- 來源 pane標記 attention。
- 若提升為全域 overlay，必須顯示 project/session。
- 回覆只能送回來源 session/request ID。
- 多個 blocking request需排隊或清楚列出，不得後來者覆蓋前者而無法回覆。

## 11. Hung tool／abort delay

Session Wall不自行偽造 idle：

- Stop已送出但server仍running時，pane保持 stopping/running狀態。
- 可顯示「等待工具停止」。
- 不允許使用者因 UI顯示 idle而送出衝突 prompt。
- 核心 abort語意問題留給 Pi/Pi Web既有 runtime，不在 Wall 以破壞性 workaround處理。

## 12. localStorage 不可用／quota

- 使用 in-memory default store。
- UI顯示一次非阻斷 warning。
- 不反覆 toast。
- 不影響 session本身。

## 13. Storage corruption

- parse失敗：保留原 raw value，不立刻覆寫。
- 以 default store啟動。
- 提供 Reset Wall Settings。
- 開發 log記錄 validation reason，不將 raw message content輸出。

## 14. Catalog cache stale

- Picker／pane有手動 Refresh。
- transient catalog miss不自動移除 slots。
- running IDs中存在、catalog暫缺的 session顯示「執行中但 metadata暫不可用」。

## 15. File open failure

- 顯示來源 pane錯誤。
- 不嘗試用 focused pane以外的 cwd重解相對路徑。
- 不打開任意 filesystem path。

## 16. Upstream incompatibility

若 upstream變更 ChatWindow/useAgentSession contract：

- CI typecheck/test應先失敗。
- 不以 `any` 或禁用測試硬繞過。
- 產品 branch維持上一個已驗證版本。
- 依 `09_UPSTREAM_SYNC.md` 進行 rebase與 smoke test後才升級。

## 17. Recovery UI 文案原則

錯誤應回答三件事：

1. 哪個 session／pane出錯。
2. Agent是否可能仍在後端執行。
3. 使用者可採取什麼安全動作。

不得只顯示 `Something went wrong`。
