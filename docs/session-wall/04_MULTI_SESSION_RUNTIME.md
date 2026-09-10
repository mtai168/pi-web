# Session Wall 多 Session Runtime

狀態：**FROZEN FOR v0.1.0**

## 1. Runtime 目標

- 多個 pane 可同時互動。
- 每個 pane 的 send／stop／stream／draft 互不混淆。
- 模式切換與 UI virtualization 不停止後端 Agent。
- 全域 toolbar 與 keyboard action 永遠有單一明確目標。
- 背景 session 完成時可通知，但不重複鳴響。

## 2. Session identity

每個 runtime instance 綁定不可變的 `session.id`。Pane 替換 session 時必須以新的 React key 重新建立該 pane runtime，避免舊 SSE、慢 fetch 或 draft callback 污染新 session。

建議 key：

```text
${paneId}:${sessionId}:${runtimeRevision}
```

## 3. 初始載入

Hot pane mount：

1. 從 session catalog 取得 metadata。
2. `GET /api/sessions/[id]` 載入最近 context，使用既有 defer flags。
3. `GET /api/sessions/[id]/state` 或等價 agent state endpoint。
4. 若 running，維持 SSE 並 reconcile。
5. 模型目錄、slash commands、system/tools 採現有 lazy/on-demand 規則，不因 Wall 一次全部預載。

## 4. Send

每個 pane 使用自己的 `useAgentSession` 與 ChatInput：

- Send handler closure 綁定該 pane session。
- 送出前該 pane成為 focus。
- optimistic user message 只加入該 pane。
- transport ambiguity、recovery、prompt settlement 沿用既有邏輯。
- 其他 pane 可同時送出，不受 focused pane 限制。

不允許共用一個可變 `selectedSession` 來決定 Send 目標。

## 5. Stop／Abort

- Pane ChatInput 的 Stop 直接呼叫該 pane `handleAbort`。
- 全域 Escape 呼叫 focused pane 的 abort action。
- Stop 不應因 focus 在另一 pane 而改變目標。
- 一個 pane abort failure 只顯示該 pane notice。

## 6. SSE

現有 Pi Web 的 SSE 為 per-session connection。v0.1 政策：

- Hot 且 running pane：維持 SSE。
- Focused pane：即使暫時離開 viewport，至少保持 warm／SSE，直到 focus 改變或 run settled。
- Idle pane：沿用既有 grace window 後關閉 SSE。
- Cold pane：不為 idle session維持 SSE；以全域 running snapshot 知道是否需升級 lifecycle。

若 12 個 session 真的同時 running，允許 12 條 SSE；但必須通過壓力測試。若瀏覽器／server 負擔不可接受，再引入 multiplex endpoint，不可先行過度設計。

## 7. Running state

全域只保留一份 `/api/agent/running` polling／streaming source，供：

- pane running indicator。
- cold pane 升級判斷。
- background completion transition。
- Wall summary。

不得每個 pane各自 polling `/api/agent/running`。

## 8. Reconciliation

每個 hot runtime 保留其 session-local reconcile：

- periodic agent state。
- visibilitychange／online。
- monotonic run ID 防止舊 response 復活 stale stream。

Wall 另外用 pane generation 防止：

- slot 替換後舊 fetch 寫入。
- focus 改變後舊 stats 覆蓋 top toolbar。
- unmount 後 async callback set state。

## 9. Focused toolbar bridge

SessionWallController 維護：

```ts
interface FocusedPaneBridge {
  paneId: string;
  sessionId: string;
  generation: number;
  branchState: ...;
  systemPrompt: ...;
  tools: ...;
  stats: ...;
  contextUsage: ...;
  actions: ...;
}
```

只有 focused pane更新 bridge。AppShell 以 bridge 渲染既有 toolbar/panels。

Focus 切換流程：

1. increment generation。
2. 清空或標示 toolbar data loading。
3. 要求新 pane同步目前 data。
4. 忽略 generation 不符的 callback。

## 10. Extension UI

### 10.1 Non-blocking status/widgets

留在 pane-local ChatInput 附近。

### 10.2 Blocking request

- 有 blocking extension UI 的 pane自動標記 attention。
- 不應在每格同時顯示全屏 modal。
- 若 Pi Web 現有 ExtensionDialog 為 pane-local，可在 pane 內顯示；若尺寸不適合，提升至 AppShell overlay，但 overlay 標題必須清楚指出來源 project/session。
- 開啟 overlay 時來源 pane成為 focus。

## 11. Notifications／sound

- Pane notices 預設留在 pane 內，避免四組 toast 疊在頁面右上。
- 完成音效由 AppShell／全域 audio owner 去重。
- 同一 logical prompt completion 不得因 pane SSE、running poll 與 background transition 播放多次。
- 可在 Wall summary 顯示剛完成 session 數量。

## 12. File open

Pane 內點檔案：

- 來源 session／cwd 必須一併傳給 AppShell。
- Wall 模式可暫時開啟右側 file panel，或先切回 normal mode；v0.1 建議採「切回 focused session normal mode並打開檔案」以減少 layout 複雜度。
- 行為必須明確且不把 A session 的相對路徑套到 B session cwd。

## 13. Branch／fork

- Pane transcript 的 message-level fork 行為沿用 Pi Web。
- 若產生新 session，不自動替換原 slot，除非操作明確要求。
- 新 session 可透過 toast/action 加入空 slot或替換目前 slot。
- 全域 BranchNavigator 只顯示 focused pane branches。

## 14. Mode switch during run

- 進入 Wall：現有 normal ChatWindow 可被重用或重新掛載，但不能 abort run。
- 離開 Wall：focused pane切回 normal ChatWindow；其他 pane UI可 unmount，但後端 run繼續。
- unmount 時 SSE client關閉不等於 AgentSession shutdown。
- 返回後透過 state＋session file reconciliation取得最新內容。

## 15. 多 tab 情境

v0.1 不阻止同一 session 在不同 browser tab開啟，但 Session Wall 自身禁止同一 session在同一 Wall重複。現有 Pi Web 對同 session多 client的語意保持不變，不在本功能另行解決。
