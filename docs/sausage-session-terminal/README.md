# Sausage Session Terminal

狀態：**PRODUCT SPEC FROZEN FOR v0.1.0**  
產品分支：`custom/sausage-session-terminal`

Sausage Session Terminal 是建立在 Pi Web Session Wall 上的自訂產品層。通用多 Session UI、runtime、persistence、virtualization 與 upstream 策略由 [`docs/session-wall/`](../session-wall/README.md) 定義；本目錄只定義產品名稱與 Brain／Hand 工作流擴充。

## 文件

- [產品識別](./PRODUCT_IDENTITY.md)
- [Brain 狀態格式與解析](./BRAIN_STATUS_SPEC.md)
- [自訂層驗收測試](./CUSTOM_ACCEPTANCE_TESTS.md)
- [日常操作與維護流程](./OPERATIONAL_WORKFLOW.md)
- [v0.1.0 自訂層 Tracker](./V0.1.0_TRACKER.md)

## 待審查提案：P1 共用記憶體歷史快取與量測

2026-09-10 的 [P1 提案 0.2](../session-sync/README.md)已依 sanitized review snapshot 修訂。候選範圍僅 **P1a：Normal／Wall 共用 bounded memory-only 歷史快取與 GET coalescing；P1b：server／client 分段 profiling**。保留既有 hook、runtime、observer、per-session SSE、command 與 authority，不是 Wall 才啟用的新資料引擎。

請 Brain 依 [0.2 複核任務](../session-sync/03_BRAIN_REVIEW.md)核對本次文件 commit。狀態為 **DRAFT_REVISED_FOR_BRAIN_REVIEW，尚未核准實作**。SQLite、content index、sidecar、multiplex、HTTP/2 調整、replay、IndexedDB、always-on collector 均為另行決策的未承諾選項。

本提案不取代本目錄或 Session Wall 的 frozen v0.1.0 規格，不自動變更 milestone，不授權派 Hand、修改 runtime、部署或合併 PR。

## 分層原則

```text
feature/session-wall
└── 通用 Multi-Session Wall

custom/sausage-session-terminal
├── Sausage Session Terminal product identity
└── Brain/Hand workflow status layer
```

自訂層不得複製或 fork 通用 Session Wall 元件。它只能透過明確 extension points 加入：

- Product label。
- Brain status parser。
- Pane status summary。
- Workflow-specific filters／attention rules（後續版本）。

## v0.1.0 自訂範圍

- 在 Wall 模式顯示產品名稱 `Sausage Session Terminal`。
- 解析最新 Brain 回覆尾端的結構化狀態。
- 在每個 pane header／footer顯示：
  - `BRAIN_STATUS`
  - `milestone`
  - `active_hands`
  - `blocker`
  - `new_dispatches`
- 解析失敗時安全回退至 Pi Web runtime running／idle狀態。
- 不修改 Brain session內容，不自動向 Brain送訊息。
- 不將自訂 parser放入 `feature/session-wall`。

## 完成定義

通用 Session Wall驗收全部通過，且本目錄的自訂 parser與視覺驗收全部通過，才可將產品分支標記為 Sausage Session Terminal v0.1.0。
