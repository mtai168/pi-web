# Session Wall 規格文件

狀態：**FROZEN FOR v0.1.0 PLANNING**  
適用分支：`feature/session-wall`  
文件語言：繁體中文；程式識別字與 upstream PR 標題使用英文。

Session Wall 是 Pi Web 的通用多 Session 互動模式。它允許使用者在同一個 Pi Web 頁面中，同時監看與操作來自不同專案的多個 Pi Agent session，並維持 Pi Web 原有的視覺、互動、權限與 session 語意。

## 文件索引

1. [產品規格](./00_PRODUCT_SPEC.md)
2. [UX／UI 規格](./01_UX_UI_SPEC.md)
3. [技術架構](./02_ARCHITECTURE.md)
4. [狀態與持久化](./03_STATE_AND_PERSISTENCE.md)
5. [多 Session Runtime](./04_MULTI_SESSION_RUNTIME.md)
6. [效能與虛擬化](./05_PERFORMANCE_AND_VIRTUALIZATION.md)
7. [失敗模式與復原](./06_FAILURE_MODES_AND_RECOVERY.md)
8. [驗收測試](./07_ACCEPTANCE_TESTS.md)
9. [實作計畫](./08_IMPLEMENTATION_PLAN.md)
10. [Upstream 同步策略](./09_UPSTREAM_SYNC.md)
11. [Roadmap](./ROADMAP.md)

## v0.1.0 已凍結決策

- Session Wall 是 Pi Web 的額外模式；原本單 Session 模式仍是預設且不得回歸。
- 由 Pi Web 風格的模式切換控制進入／離開。
- Wall 模式隱藏左側 project/session/file sidebar，並隱藏右側 file panel。
- 保留原本最上方 toolbar 與最下方全域 status bar。
- 中央固定兩欄，支援 `2×2`、`2×4`、`2×6`。
- `2×4` 與 `2×6` 不壓縮 pane；使用者以外層垂直捲動瀏覽後續列。
- 每個 pane 擁有自己的 transcript、ChatInput、draft、Send、Stop 與 session-local status。
- 點擊 pane 會使其成為 focused pane；全域 toolbar、Escape、session statistics 與 file-open source 跟隨 focused pane。
- UI 必須直接重用 Pi Web 元件與 design tokens，不另造 dashboard／card／badge 設計語言。
- 第一版不更改 Pi session JSONL 格式，不要求修改 Pi Agent runtime，也不以 iframe 包裝多個 Pi Web。
- 8～12 pane 必須有 lifecycle／virtualization 控制，不允許十二份完整歷史與模型目錄永遠同時保持 hot。

## 變更控制

若要修改上述凍結決策，必須同步更新：

- `00_PRODUCT_SPEC.md`
- `01_UX_UI_SPEC.md`
- `02_ARCHITECTURE.md`
- `07_ACCEPTANCE_TESTS.md`

任何只改程式、未同步規格的行為，視為規格偏移，不得合併到產品分支。
