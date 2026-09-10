# Session Wall 效能與虛擬化

狀態：**FROZEN FOR v0.1.0**

## 1. 風險

2×6 代表 12 個 pane。若每個 pane 永遠掛載完整 ChatWindow，可能同時產生：

- 12 份大量 Markdown／code／tool rendering。
- 12 組 ResizeObserver／IntersectionObserver。
- 12 組 model catalog／slash command 請求。
- 多條 SSE 與 reconcile timer。
- 大量歷史訊息與圖片記憶體。
- streaming 期間多格高頻 re-render。

因此 virtualization 是 v0.1 的必要品質條件，不是日後優化選項。

## 2. Lifecycle tiers

### Hot

條件：

- pane 在 viewport 中；或
- pane 為 focused；或
- pane 有 blocking attention。

能力：

- 完整 transcript。
- 完整 ChatInput。
- running 時 SSE。
- local scroll/follow state。

### Warm

條件：

- viewport 前後一列 overscan；或
- 剛離開 hot，保留短暫 grace。

能力：

- 可保持 mount但降低非必要更新。
- 不主動載入 model catalog／slash commands。
- running 時可維持 SSE。

### Cold

條件：

- 遠離 viewport且非 focused／attention。

能力：

- 只顯示 metadata、running state、cached tail snapshot、draft indicator。
- 不掛載完整 ChatWindow。
- 不維持 idle SSE。
- 捲回時重新取得 canonical tail/state。

## 3. 可見範圍

在 2 欄、每 viewport 兩列的前提下：

- Hot：通常 4 panes。
- Warm overscan：前後各 1 列，最多再 4 panes。
- Cold：其餘 panes。

focused pane即使不在可見範圍，也不得 cold；必要時保持 warm。

## 4. 歷史載入

- 初次只抓最近 tail page，不完整掃描該 session歷史。
- 使用 Pi Web 既有 lazy-load upward history。
- Cold snapshot 只保存最近可顯示摘要，不保存整份 message tree。
- defer thinking/media。
- 大型 bash/tool output 保持延遲 fetch。

## 5. ChatInput 成本

- Hot pane掛載完整 ChatInput。
- Warm/Cold pane draft 由既有 draft store持久化，不靠 DOM 保存。
- Model list只在 input control首次展開或 pane變 hot且需要時載入。
- Slash commands只在使用者觸發時載入。
- System/tool definitions只在 focused pane開啟全域 panel時載入。

## 6. Streaming

- 沿用 upstream delta-based streaming與 memoization。
- 不在 Wall 上層複製每個 token內容到 global state。
- Wall summary只追蹤粗粒度狀態，不訂閱完整 message delta。
- Pane header running indicator不可因每個 token重 render。
- 若高頻 delta造成 layout thrash，可在 wall-pane display layer以 animation-frame batch更新，但不能延遲 command lifecycle事件。

## 7. Connection／timer budget

- `/api/agent/running`：整頁一份。
- 每個 hot running pane：最多一條 SSE。
- Idle pane：grace 後無 SSE。
- Reconcile timer僅在該 pane client認為 running時啟動。
- Cold idle pane無 timer。

## 8. 效能預算

以下為 v0.1 驗收目標，不是硬性 SLA：

- 2×2 進入 Wall，在本機 warm cache 下 1 秒內看到 pane shell，之後漸進載入 transcript。
- 2×6 初始不得等待所有 12 份完整 ChatWindow 才可互動。
- Idle Wall 不應持續佔滿單一 CPU core。
- 2×6 連續開啟 60 分鐘，heap 不得呈單調無界成長。
- 從第 1 列捲到第 6 列時，輸入與 scrolling 不出現長時間 main-thread freeze。
- 同時 4 個 session streaming 時仍可在另一 pane輸入。

具體數據應由 browser performance profile記錄並附在驗收 issue。

## 9. Instrumentation

開發期間加入 dev-only diagnostics：

- hot/warm/cold pane count。
- active SSE count。
- mounted ChatWindow count。
- per-pane load latency。
- session tail fetch count。
- model list request count。
- dropped stale callback count。

不得將 verbose diagnostics預設帶入 production UI。

## 10. Virtualization 正確性

Virtualization 絕不能：

- Abort Agent。
- 清除 draft。
- 將 running 誤判為 idle。
- 重送 prompt。
- 重複播放完成音。
- 丟失 blocking attention。
- 讓舊 session response寫入已替換 slot。

## 11. 降級策略

若 virtualization 尚未完成，不得宣稱 2×6 ready。可先以 feature flag：

```text
2×2 enabled
2×4/2×6 experimental or disabled
```

但 v0.1.0 正式完成定義要求三種 layout皆通過基本效能驗收。
