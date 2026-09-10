# Session Wall 狀態與持久化

狀態：**FROZEN FOR v0.1.0**

## 1. 原則

- Wall 設定是 Pi Web UI metadata，不是 Pi session metadata。
- 不修改 `.jsonl` session header 或 entries。
- 使用版本化 localStorage schema。
- 所有讀寫皆 best-effort；storage 失敗不得阻止 Session Wall 使用。
- Session catalog、running state 與 session file 仍是 session 真相來源。

## 2. Storage key

通用 feature 使用：

```text
pi-web:session-walls:v1
```

模式偏好可使用：

```text
pi-web:workspace-mode:v1
```

不得使用 downstream 品牌名稱作為 generic branch 的必要 key。

## 3. Schema

```ts
interface SessionWallsStoreV1 {
  version: 1;
  activeWallId: string;
  walls: SessionWallConfigV1[];
}

interface SessionWallConfigV1 {
  version: 1;
  wallId: string;
  name: string;
  layout: "2x2" | "2x4" | "2x6";
  panes: Array<{
    paneId: string;
    sessionId: string | null;
  }>;
  focusedPaneId: string | null;
  outerScrollTop: number;
  updatedAt: string;
}
```

v0.1 UI 可以只公開一個 Wall，但資料模型應支援多組，避免日後破壞性 migration。

## 4. Validation

讀取 storage 後必須：

- 驗證 root 為 object。
- 驗證 `version === 1`。
- 驗證 layout 為允許值。
- 按 layout 補足或裁切 slot 數量：4／8／12。
- `paneId` 必須為非空字串且唯一；否則重新產生。
- `sessionId` 僅接受非空字串或 null。
- 移除同一 Wall 中重複 sessionId；較前 slot 保留，後者設 null。
- focusedPaneId 必須存在且對應有效 session；否則選第一個有效 pane。
- outerScrollTop 必須為有限非負數。

Malformed storage 不得 throw 到 React tree；回退至乾淨 default store。

## 5. Persist timing

- layout、slot 替換、移除、focus：立即或 microtask debounce 保存。
- outerScrollTop：150–300ms debounce。
- 不在每個 streaming delta 寫 localStorage。
- `updatedAt` 在可持久化 config 變更時更新。

## 6. Draft

每格獨立 draft 應沿用 Pi Web 現有 draft store：

```text
sessionId -> draft
```

規則：

- focus 改變不得 rekey draft。
- pane cold/unmount 前，ChatInput 的 draft persistence 必須已完成。
- 同一 session 不允許在同一 Wall 重複出現，避免兩份 UI 同時競爭同一 draft。
- session 由 transient ID 升級為 real ID 時，沿用既有 rekey 邏輯；v0.1 picker 僅選既有 session，因此不要求在 Wall 內建立 fresh unsaved session。

## 7. Scroll state

### 7.1 Wall outer scroll

- 保存 active Wall 的 `outerScrollTop`。
- Wall 首次 mount 後、尺寸穩定時恢復。
- layout 改變時 clamp 至可用範圍。

### 7.2 Pane transcript scroll

v0.1 為 best-effort：

- hot → warm 可保留 DOM。
- hot/warm → cold 時可在記憶體保存 `scrollTop`、`scrollHeight` 與是否 attached-to-tail。
- page reload 後不要求恢復每個 transcript 精確位置；預設回到 tail，除非現有 ChatWindow 已有可靠 persistence。

## 8. Mode restoration

預設啟動仍為 normal mode，避免 fork 更新或 storage corruption 讓使用者進入無法操作的 Wall。

可選地保存「上次使用 Wall」，但 v0.1 不自動恢復 Wall，除非：

- storage 驗證成功。
- 至少一個有效 session。
- 沒有明確的 `?session=` 或 `?cwd=` initial navigation。

若 URL 指定 session/cwd，URL 意圖優先。

## 9. Sidebar／file panel snapshot

進入 Wall 時保存於 memory：

```ts
interface PreWallLayoutSnapshot {
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
}
```

離開 Wall 時恢復。此 snapshot 不必跨 page reload 持久化；若 reload 發生在 Wall，離開後可使用 Pi Web 原本的 panel preference。

## 10. Stale session

若 storage 中 sessionId 不在 catalog：

- slot 保留 sessionId，以顯示 stale state。
- 不自動刪除，避免短暫 catalog/cache failure 導致永久設定遺失。
- 使用者可 Refresh、Replace 或 Remove。
- 若 session 之後重新出現，slot 自動恢復。

## 11. Schema migration

```ts
function loadSessionWalls(raw: unknown): SessionWallsStoreV1 {
  // parse -> migrate -> validate -> normalize
}
```

未來每次 schema 增版：

- 保留純函式 migration。
- 為每一舊版本提供 fixture test。
- 遇到未知較新版本時，不覆寫原資料；進入 read-safe default 並顯示 warning。

## 12. 隱私

Wall storage 只能保存：

- IDs
- layout
- display name
- focus
- scroll metadata

不得保存：

- message text
- prompts
- tool output
- file content
- credentials
- API key source
