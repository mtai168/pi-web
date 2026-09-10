# Session Wall Roadmap

## v0.1.0 — Interactive Session Wall

目標：能夠日常使用的多 Session 互動模式。

- Normal／Wall模式切換。
- 隱藏左右 panel、保留 top/bottom bars。
- 2×2、2×4、2×6固定兩欄。
- 跨 project session picker。
- 每格 transcript＋獨立 ChatInput。
- 每格 Send／Stop／draft／status。
- Focused pane與全域 toolbar routing。
- Hot/warm/cold lifecycle。
- Stale／network／storage recovery。
- Light/dark/i18n/regression tests。
- 2×6 performance與60分鐘 soak。

## v0.1.1 — Stabilization

- 實際重度使用回報修正。
- 更精確的 scroll restore。
- Blocking extension UI UX改進。
- Completion notification去重與未讀提示。
- Picker搜尋／排序改善。
- Upstream更新衝突減量。

## v0.2.0 — Mission Control Enhancements

通用層可考慮：

- 多組 named Walls。
- Pane drag reorder。
- 快速 filter：running／attention／recent。
- Pane header compact metrics。
- Wall command palette／keyboard navigation。
- Optional batch/multiplex events endpoint。
- Layout preset export/import。

Downstream workflow-specific功能留在 custom branch。

## v0.3.0 — Upstream Readiness

- 長期使用數據與效能證據。
- 完整英文文件。
- 將 thin-fork shortcuts整理為 upstream-quality abstractions。
- 拆分可審查 PR：store、focus registry、ChatWindow composition、Wall UI、virtualization。
- 移除或隔離所有產品品牌與私有 workflow假設。

## 非近期 Roadmap

- 非 Pi CLI整合。
- 多使用者／sandbox isolation。
- 任意 IDE式自由 split。
- 跨主機即時同步。
- 每 pane file explorer。
