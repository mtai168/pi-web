# Session Wall 技術架構

狀態：**FROZEN FOR v0.1.0 IMPLEMENTATION**

## 1. 現有 Pi Web 基礎

Pi Web 已具備：

- `AppShell.tsx`：整體 layout、URL、selected session、toolbar、sidebar、file panel。
- `ChatWindow.tsx`：單 session transcript、ChatInput、notifications、extension UI。
- `useAgentSession.ts`：session load、SSE、send/abort、draft、branch、reconciliation。
- `/api/sessions/[id]` 與 `/context`：唯讀 session browsing。
- `/api/agent/[id]` 與 `/events`：AgentSession command 與 SSE。
- `/api/agent/running`：全域 running session snapshot。

Session Wall 應在上述邊界上組合，不重寫 Pi runtime。

## 2. 高階組成

```text
AppShell
├── SessionSidebar (normal mode visible; wall mode hidden)
├── TopToolbar
├── NormalWorkspace
│   └── ChatWindow
└── SessionWallWorkspace
    ├── SessionWallController
    ├── SessionWallGrid
    │   ├── SessionWallPane
    │   │   └── ChatWindow(mode="wall-pane")
    │   └── ...
    └── WallGlobalStatus
```

## 3. 建議檔案結構

```text
components/session-wall/
  SessionWall.tsx
  SessionWallGrid.tsx
  SessionWallPane.tsx
  SessionWallToolbar.tsx
  SessionWallPicker.tsx
  SessionWallEmptyPane.tsx
  SessionWallErrorBoundary.tsx

hooks/
  useSessionWall.ts
  useSessionWallFocus.ts
  useSessionWallVisibility.ts

lib/session-wall/
  types.ts
  store.ts
  reducer.ts
  layout.ts
  validation.ts
  runtime-policy.ts
```

既有核心修改應盡量侷限：

```text
components/AppShell.tsx
components/ChatWindow.tsx
hooks/useAgentSession.ts        僅在必要時加入 mode/lifecycle options
hooks/useKeyboardShortcuts.ts
lib/i18n/messages/*.ts
```

## 4. 狀態所有權

### 4.1 AppShell

擁有：

- `workspaceMode: "normal" | "wall"`
- sidebar／file panel 進入 Wall 前狀態快照。
- focused pane 對應的 session-derived toolbar state。
- normal mode selected session。

### 4.2 SessionWallController

擁有：

- Wall config。
- pane order。
- focused pane ID。
- layout preset。
- Wall outer scroll。
- pane visibility class（hot/warm/cold）。

### 4.3 SessionWallPane

擁有：

- 一個固定 `sessionId`。
- pane-local error boundary。
- pane-local ChatInput ref。
- pane visibility／mount state。
- pane-local scroll snapshot。
- focus event forwarding。

### 4.4 ChatWindow

仍擁有單一 session 的互動狀態；新增 mode options，而非讓 Wall 複製 useAgentSession 邏輯。

建議 API：

```ts
type ChatWindowDisplayMode = "normal" | "wall-pane";

interface ChatWindowProps {
  displayMode?: ChatWindowDisplayMode;
  keyboardActive?: boolean;
  toolbarReportingActive?: boolean;
  visibilityState?: "hot" | "warm" | "cold";
  onRequestFocus?: () => void;
}
```

`normal` 必須保持目前預設行為。

## 5. Wall 資料模型

```ts
type SessionWallLayout = "2x2" | "2x4" | "2x6";

interface SessionWallPaneConfig {
  paneId: string;       // Wall-local stable identity
  sessionId: string | null;
}

interface SessionWallConfigV1 {
  version: 1;
  wallId: string;
  name: string;
  layout: SessionWallLayout;
  panes: SessionWallPaneConfig[];
  focusedPaneId: string | null;
  outerScrollTop?: number;
  updatedAt: string;
}
```

- `paneId` 與 `sessionId` 分離，使 slot 可替換 session 而保留 layout identity。
- `sessionId` 是唯一 session key；不得以 session name 或 cwd 當 identity。
- project metadata 從 session catalog 衍生，不重複持久化為真相。

## 6. Session catalog

短期 thin-fork 實作可沿用 `SessionSidebar` 提供給 AppShell 的完整 session catalog 與 running IDs，即使 sidebar 在 Wall 模式視覺隱藏。

但資料依賴不可永久綁死在 sidebar render。建議逐步抽出：

```text
useSessionCatalog()
├── sessions
├── runningSessionIds
├── refresh
└── background completion transitions
```

`SessionSidebar` 與 `SessionWall` 共用同一 hook，避免雙重 `/api/sessions` 掃描與 running polling。

## 7. Focus 與 toolbar routing

現有 AppShell 只接收一個 ChatWindow 的：

- branch tree
- system prompt/tools
- stats/context
- system info loader

Wall 模式下不得讓多個 pane 同時寫入同一組 AppShell state。

規則：

- 只有 `toolbarReportingActive === true` 的 focused ChatWindow 可向 AppShell callback 回報。
- focus 改變時，舊 pane callbacks 應解除或被 generation token 忽略。
- 新 focused pane 主動同步目前 branch/system/stats/context。
- 使用 `focusedSessionId` 與 generation guard 防止慢速 response 覆蓋新 focus。

## 8. Keyboard routing

現有 module-level 單一 `globalAbortHandler` 必須改為焦點安全設計。

可接受方案：

```ts
interface GlobalSessionActions {
  sessionId: string;
  abort: () => void;
}

registerFocusedSessionActions(actions | null)
```

只有 focused pane 註冊全域 action。每個 pane 自己 ChatInput 內的 Stop 不受此限制。

不得建立「最後 mount 的 pane 贏得 Escape」語意。

## 9. API 與 event flow

### 9.1 Browse

```text
GET /api/sessions
GET /api/sessions/[id]?deferThinking=1&deferMedia=1
GET /api/sessions/[id]/context?... 
```

### 9.2 Interactive

```text
GET  /api/sessions/[id]/state
POST /api/agent/[id]
GET  /api/agent/[id]/events
```

Session Wall v0.1 優先重用既有 API。只有經實測證明 8～12 pane 導致不可接受負擔時，才新增 batch／multiplex endpoint。

## 10. Pane lifecycle

- Hot：完整 ChatWindow mount；可互動；需要時維持 SSE。
- Warm：接近 viewport；可保留 mount 或輕量預載。
- Cold：不 mount 完整 ChatWindow；顯示 metadata/snapshot；Agent 後端不受影響。

focused pane 即使離開 viewport，也不得直接 cold；應至少保持 warm，直到 focus 移轉。

## 11. Error isolation

每個 pane 必須包在獨立 error boundary：

```text
SessionWallErrorBoundary
└── SessionWallPane
    └── ChatWindow
```

一個 session 的 malformed message、extension UI 或 fetch error 不得 unmount 整個 Wall。

## 12. Security invariants

- Session Wall 不擴大 file access allow-list。
- `onOpenFile` 必須保留 source session／cwd，以既有 API 驗證。
- Picker 只能列出 Pi Web 已知 session catalog。
- Wall storage 不保存 API keys、credentials、prompt content 或檔案內容。
- 不使用 `dangerouslySetInnerHTML` 注入自訂 status。
- 不繞過 project trust。

## 13. 不採用方案

### iframe wall

拒絕，原因：多份 AppShell、重複 polling、focus／draft／notifications 無法統一，且 UI 不是可維護的內部組合。

### 編譯後 inject

拒絕，原因：npm 發布物為 `.next` build，chunk hash 與結構隨 upstream 更新改變。

### 重新寫一套 compact chat

拒絕，原因：會複製 streaming、draft、queue、extension、tool rendering 等高風險邏輯，並逐漸偏離 Pi Web。
