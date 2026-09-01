# Sausage Session Terminal

狀態：**規格完成，等待 issue 拆分與實作**

Sausage Session Terminal 是此 Pi Web fork 的產品名稱。它建立在通用的 Session Wall 功能上，用於同時監看與操作多個 Pi Agent Brain session，並加入 Brain／Hand 工作流狀態呈現。

## Repository 關係

- Upstream：`agegr/pi-web`
- Fork：`mtai168/pi-web`
- 產品名稱：**Sausage Session Terminal**
- 通用功能名稱：**Session Wall**

## Branch contract

### `main`

盡量追蹤 upstream Pi Web `main`。不得直接提交產品功能。

### `feature/session-wall`

通用、可 upstream 的多 Session 功能：

- 互動式多 Session grid。
- 固定兩欄，支援 2×2、2×4、2×6。
- 每格獨立 transcript、ChatInput、draft、Send、Stop。
- 跨 project session picker。
- focus／keyboard／toolbar routing。
- persistence、virtualization、failure recovery與回歸測試。

此分支不得加入 Sausage 品牌或 Brain／Hand 特定格式。

### `custom/sausage-session-terminal`

日常使用的產品層，建立於 `feature/session-wall` 之上。可以包含：

- Sausage Session Terminal 名稱與模式標示。
- Brain／Hand workflow狀態解析。
- `DISPATCHED`
- `WAITING_FOR_HANDS`
- `BLOCKED_OWNER`
- `MILESTONE_COMPLETE`
- `milestone`、`active_hands`、`blocker`、`new_dispatches`
- 其他不適合 upstream 的個人工作流功能。

## 規格文件

### 通用 Session Wall

- [`docs/session-wall/README.md`](./docs/session-wall/README.md)
- [`docs/session-wall/00_PRODUCT_SPEC.md`](./docs/session-wall/00_PRODUCT_SPEC.md)
- [`docs/session-wall/01_UX_UI_SPEC.md`](./docs/session-wall/01_UX_UI_SPEC.md)
- [`docs/session-wall/02_ARCHITECTURE.md`](./docs/session-wall/02_ARCHITECTURE.md)
- [`docs/session-wall/03_STATE_AND_PERSISTENCE.md`](./docs/session-wall/03_STATE_AND_PERSISTENCE.md)
- [`docs/session-wall/04_MULTI_SESSION_RUNTIME.md`](./docs/session-wall/04_MULTI_SESSION_RUNTIME.md)
- [`docs/session-wall/05_PERFORMANCE_AND_VIRTUALIZATION.md`](./docs/session-wall/05_PERFORMANCE_AND_VIRTUALIZATION.md)
- [`docs/session-wall/06_FAILURE_MODES_AND_RECOVERY.md`](./docs/session-wall/06_FAILURE_MODES_AND_RECOVERY.md)
- [`docs/session-wall/07_ACCEPTANCE_TESTS.md`](./docs/session-wall/07_ACCEPTANCE_TESTS.md)
- [`docs/session-wall/08_IMPLEMENTATION_PLAN.md`](./docs/session-wall/08_IMPLEMENTATION_PLAN.md)
- [`docs/session-wall/09_UPSTREAM_SYNC.md`](./docs/session-wall/09_UPSTREAM_SYNC.md)
- [`docs/session-wall/ROADMAP.md`](./docs/session-wall/ROADMAP.md)

### Sausage Session Terminal 自訂層

- [`docs/sausage-session-terminal/README.md`](./docs/sausage-session-terminal/README.md)
- [`docs/sausage-session-terminal/PRODUCT_IDENTITY.md`](./docs/sausage-session-terminal/PRODUCT_IDENTITY.md)
- [`docs/sausage-session-terminal/BRAIN_STATUS_SPEC.md`](./docs/sausage-session-terminal/BRAIN_STATUS_SPEC.md)
- [`docs/sausage-session-terminal/CUSTOM_ACCEPTANCE_TESTS.md`](./docs/sausage-session-terminal/CUSTOM_ACCEPTANCE_TESTS.md)
- [`docs/sausage-session-terminal/OPERATIONAL_WORKFLOW.md`](./docs/sausage-session-terminal/OPERATIONAL_WORKFLOW.md)

## Frozen UI 方向

- 以 Pi Web 風格的懸浮控制進入／離開特殊模式。
- Wall 模式隱藏左側 project/session/file sidebar。
- Wall 模式隱藏右側 file panel。
- 保留原本 top toolbar 與 bottom global status bar。
- 固定兩欄。
- 2×2填滿主要 viewport；2×4與2×6維持可讀 pane高度，由使用者向下捲動。
- 每格有自己的 ChatInput、draft、Send、Stop與 session-local status。
- 全域 toolbar跟隨 focused pane。
- UI直接重用 Pi Web components、spacing、typography、icons、theme variables、hover、border與responsive patterns。
- 禁止另造 dashboard/card/badge/font/color/modal設計語言。

## Update flow

```text
upstream/main
    -> main
    -> feature/session-wall
    -> custom/sausage-session-terminal
```

Release前：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
npm run build
```

一般開發期間依 Pi Web 指引，不反覆執行 production build。
