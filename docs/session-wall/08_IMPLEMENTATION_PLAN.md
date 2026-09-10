# Session Wall 實作計畫

狀態：**READY FOR ISSUE BREAKDOWN**

## 1. 開發原則

- 先建立可測試純函式與狀態邊界，再接 UI。
- normal mode預設行為不得改變。
- 通用功能只進 `feature/session-wall`。
- downstream branding／workflow parser不得混入本分支。
- 每個 issue需有明確 owner files與測試，降低 Brain／Hand平行開發衝突。

## 2. 實作 DAG

```text
A1 Store/types ─────┐
A2 Layout policy ───┼─> B1 Wall shell/mode switch
A3 Focus registry ──┘          │
                               ├─> C1 Grid + empty panes
Session catalog extraction ────┤
                               └─> C2 Picker

C1 + A3 ─> D1 ChatWindow wall-pane mode
D1 ──────> D2 Per-pane ChatInput/runtime
D2 + A3 ─> E1 Global toolbar routing
D2 ──────> E2 Extension UI/status isolation

C1 + D2 ─> F1 Visibility tiers/virtualization
F1 ──────> F2 Performance diagnostics/soak

All ─────> G1 Failure recovery
All ─────> G2 Regression/visual/i18n
G1+G2 ───> Release gate
```

## 3. Work packages

### A. Foundation

#### A1 — Types、store、validation

新增：

- `lib/session-wall/types.ts`
- `store.ts`
- `validation.ts`
- pure reducer tests

不碰 AppShell／ChatWindow，可獨立平行開發。

#### A2 — Layout policy

- 2×2／2×4／2×6 slot count。
- pane height calculation。
- viewport support判定。
- tests。

#### A3 — Focused session actions registry

- 重構單一 global abort handler。
- 保持 normal mode tests。
- 提供 sessionId/generation-safe registry。

### B. Shell

#### B1 — AppShell mode switch

- normal/wall mode state。
- Pi Web style切換 control。
- sidebar/file panel snapshot與restore。
- URL navigation precedence。
- placeholder Wall container。

此 issue主要擁有 `AppShell.tsx`，不應與其他 AppShell writer並行。

### C. Wall configuration UI

#### C1 — Grid／pane shell

- 兩欄 layout。
- outer scroll。
- 4/8/12 slots。
- focused outline。
- empty/stale/error pane shells。

#### C2 — Cross-project picker

- 共享 session catalog。
- search/group/running metadata。
- replace/remove。
- no duplicates。

### D. Interactive pane

#### D1 — ChatWindow display mode

- `normal`／`wall-pane` props。
- hide minimap。
- pane width composition。
- toolbar reporting guard。
- normal regression tests。

#### D2 — Per-pane ChatInput/runtime

- 每格完整 ChatInput。
- independent refs/drafts/send/stop。
- focus on interaction。
- pane-local notices/status。

### E. Global integration

#### E1 — Toolbar routing

- branch/system/tools/stats/context follow focused pane。
- generation guard。
- expand to normal session。

#### E2 — Extension UI／notification

- pane-local status/widget。
- blocking request來源與overlay。
- sound dedup。

### F. Performance

#### F1 — Hot/warm/cold lifecycle

- IntersectionObserver。
- overscan。
- cold snapshot。
- focused/attention pinning。
- draft/scroll preservation。

#### F2 — Diagnostics與soak

- dev-only counters。
- request/SSE/mount audits。
- 2×6 performance profile。
- 60分鐘 soak。

### G. Hardening

#### G1 — Failure recovery

依 `06_FAILURE_MODES_AND_RECOVERY.md` 補齊 stale、network、server restart、race、storage corruption。

#### G2 — UI/i18n/regression

- en/zh-CN/zh-TW。
- light/dark/auto。
- baseline viewport。
- normal mode regression。
- accessibility。

## 4. 建議 commit 邊界

- 每個 work package至少一個 focused commit。
- 純重構與功能變更分開。
- 不把格式化整個 AppShell與 Session Wall功能混在同一 commit。
- 任何修改 upstream core file的 commit都需對應 regression test。

## 5. Feature flags

開發中可使用：

```ts
const SESSION_WALL_ENABLED = true; // fork-only build flag or local setting
```

但正式 v0.1不可依賴隱藏 query param才能使用。Mobile可明確 disabled並顯示說明。

## 6. 開發驗證節奏

每個 work package：

```bash
npm test -- <focused tests if supported>
node_modules/.bin/tsc --noEmit
npm run lint
```

整合 checkpoint：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Release gate才執行：

```bash
npm run build
```

## 7. 開始 coding 前的 frozen questions

以下已定案，不再阻塞：

- 每格有獨立 ChatInput。
- 兩欄固定。
- 2×4以上外層捲動。
- Wall模式隱藏左右 panel。
- top toolbar與bottom status保留。
- UI完全沿用 Pi Web。

仍可在實作 spike確認但不得擅自改產品方向：

- file link在 Wall內是切 normal mode，還是暫時開 file panel。
- blocking extension UI採 pane-local或標示來源的全域 overlay。
- warm pane是否保持完整 mount的 grace時間。

上述三項應以簡單、安全、低 upstream衝突為優先。
