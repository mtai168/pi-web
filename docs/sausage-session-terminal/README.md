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

## 待審查提案：共用 Session 讀取與同步核心

2026-09-10 新增 [共用 Session 核心提案](../session-sync/README.md)，適用於 **normal 與 Wall 兩種模式**，不是 SST 啟動後才生效的加速器。請負責 SST 的 Brain 先依 [審查任務與決策紀錄](../session-sync/03_BRAIN_REVIEW.md) 核對實際部署程式碼、回覆風險與替代方案，再交 Owner 討論。

此提案狀態為 **DRAFT_FOR_BRAIN_REVIEW，尚未核准實作**。它不取代本目錄或 Session Wall 的 frozen v0.1.0 規格，不自動變更 milestone，也不是立即派 Hand 改造 runtime 的授權。

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
