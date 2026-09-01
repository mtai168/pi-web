# Session Wall UX／UI 規格

狀態：**FROZEN FOR v0.1.0**

## 1. 設計原則

Session Wall 必須看起來像 Pi Web 原本就存在的 split-session mode，而不是外加 dashboard。

硬性原則：

- 直接使用 Pi Web 現有 CSS variables、字體、字級、icon 語言、hover、selected、border 與 animation 節奏。
- 優先重用既有 `ChatInput`、`MessageView`、`MarkdownBody`、tool/process 元件與 extension status 元件。
- 不新增另一套卡片、badge、漸層、品牌色、陰影或 modal 規範。
- Pane 間以細分隔線形成類 terminal／IDE split，而不是浮動圓角卡片。
- 正常模式外觀與行為不得因 Session Wall 而改變。

## 2. 入口

### 2.1 模式按鈕

- 在正常 Pi Web 畫面右上方提供 Session Wall 模式切換控制。
- 位置可懸浮於主內容右上，但視覺必須沿用 Pi Web toolbar icon button。
- 使用既有 `var(--accent)` 表示 active，不使用固定綠色。
- Tooltip／aria-label：`開啟 Session Wall`／`離開 Session Wall`。
- 按鈕不得遮擋 ChatInput、top panel dropdown 或 file panel control。

### 2.2 進入行為

進入 Wall 時：

- 保存 sidebar 是否開啟。
- 保存右側 file panel 是否開啟。
- 關閉或隱藏 sidebar。
- 關閉或隱藏 file panel。
- 保留 top toolbar。
- 保留最底部全域 status bar。
- 將目前單 Session 加入 focus 候選；若它已存在於 Wall，優先聚焦。

離開 Wall 時：

- 切回 focused pane 對應的單 Session。
- 恢復進入前的 sidebar／file panel 開關狀態。
- 保留 Wall layout、pane 順序與草稿。

## 3. 頁面構成

```text
┌──────────────────── Pi Web top toolbar ────────────────────┐
├────────────────────────┬────────────────────────────────────┤
│ Pane A                 │ Pane B                             │
├────────────────────────┼────────────────────────────────────┤
│ Pane C                 │ Pane D                             │
├────────────────────────┴────────────────────────────────────┤
│ Pi Web global status / Wall summary                         │
└─────────────────────────────────────────────────────────────┘
```

- Top toolbar 為既有 AppShell toolbar。
- 中央為 Wall outer scroller。
- Grid 固定兩欄。
- 最底部保留 Pi Web status bar；Wall 模式可加總覽文字，但不得取代 pane-local status。

## 4. Layout 規格

### 4.1 固定兩欄

```css
grid-template-columns: repeat(2, minmax(0, 1fr));
```

- Pane 間 gap 視覺上等同 `1px var(--border)`。
- 不以 card margin 產生大片空白。
- 每欄最小可用寬度不足時，Wall 模式顯示明確的 viewport warning；v0.1.0 不降為單欄。

### 4.2 Pane 高度

- `2×2`：中央 viewport 內顯示兩列。
- `2×4`／`2×6`：沿用與 `2×2` 相同的 pane 高度。
- Pane 建議高度由中央可用高度除以 2，並設合理 min/max；基準環境約 360–440 CSS px。
- 外層 Wall 可垂直捲動，pane 本身 transcript 亦可獨立捲動。

### 4.3 基準環境

至少驗證：

- 約 `1418×945 CSS px` 的桌面 viewport。
- Windows 顯示縮放 200%、瀏覽器縮放 110%。
- Chromium 系瀏覽器。
- Pi Web light、dark、auto theme。

## 5. Pane 結構

### 5.1 Header

建議高度 38–44px，包含：

- Primary：session name／first message fallback。
- Secondary：project name、branch/worktree、相對更新時間。
- Running indicator。
- Focus indicator。
- 展開、替換、移除、跳到最新等 icon button。

Header 不得使用大型彩色 badge。狀態以 Pi Web 現有文字色、accent、warning/error semantic color 及細 icon 表達。

### 5.2 Transcript

- 填滿 header 與 ChatInput 之間的剩餘空間。
- 使用 `min-width: 0`、`overflow-x: hidden`、`overflow-y: auto`。
- 內容 max-width 不應固定為桌面單欄的 820px；wall pane 內應填滿 pane 並保留現有左右 padding。
- Tool/process details 預設規則沿用 Pi Web。
- Chat minimap 在 wall pane 關閉。
- 圖片與大型媒體採延遲載入。
- 使用者向上捲動後不得被 streaming 強制拉回；顯示 `跳到最新` 控制。

### 5.3 ChatInput

每個 pane 必須直接擁有自己的 ChatInput：

- Enter／Send 只送到該 pane session。
- Stop 只停止該 pane session。
- 草稿以該 session 的 draft key 保存。
- 模型、thinking、tools、compact、queue 與音效控制盡量重用既有行為。
- 依 pane 容器寬度調整控制密度，不能只依 browser viewport 判斷 mobile。
- 使用 container query 或 explicit density prop；不建立風格不同的「簡化輸入框」。

### 5.4 Pane-local status

- Extension status／widget 應留在該 pane 輸入區附近。
- 不得把某個 session 的 extension status 只放在全域最底部，避免目標混淆。

## 6. Focus 規格

- focused pane 使用極細 accent outline／inset border，不能產生 layout shift。
- 點擊 header、transcript、ChatInput 或 pane-local action 都會聚焦。
- 直接按某 pane 的 Send／Stop 不要求先聚焦，但操作後該 pane應成為 focus。
- 全域 top toolbar 與 Escape 僅作用於 focused pane。
- focus 變更不得清空其他 pane draft 或 scroll position。
- 沒有有效 pane 時，全域 session-specific 控制 disabled。

## 7. Wall Toolbar／管理

Wall 模式需提供低干擾管理入口：

- layout selector：`2×2`、`2×4`、`2×6`。
- `管理 Sessions`。
- 切換已保存 Wall（若 v0.1 僅支援一組，可先保留資料結構，不顯示多組 UI）。
- 顯示 running／attention 總數。

管理 UI 使用 Pi Web 現有 dropdown／panel／modal patterns，不引入獨立設計系統。

## 8. Picker

Session picker 必須：

- 可跨 project 搜尋。
- 依 project 分組。
- 顯示 session name、first message、branch、modified time、running state。
- 已在 Wall 的 session 顯示 selected 且不能重複加入。
- 支援替換指定 slot，而非只能追加。
- 無結果、讀取失敗與 stale session 有明確狀態。

## 9. 捲動

存在兩層捲動：

- Pane transcript scroller。
- Wall outer scroller。

規則：

- 游標在 transcript 上時，優先捲動 transcript。
- transcript 到邊界後允許自然 scroll chaining 到 Wall。
- 不使用強制 scroll snap；可使用非常弱的 proximity snap，但 v0.1 預設關閉。
- Wall 重新整理後可恢復 outer scroll；pane scroll 恢復屬 best-effort。

## 10. 鍵盤與可及性

- `Tab` 順序依 pane DOM 順序，pane 內 header → transcript controls → ChatInput。
- `Escape` 在一般頁面範圍停止 focused pane；在 input/textarea 中沿用 ChatInput 自己的 menu／abort 邏輯。
- 所有 icon button 必須有 tooltip 與 aria-label。
- focus outline 在 keyboard navigation 時清楚可見。
- status 不得只靠顏色區分。
- reduced motion 模式停用非必要 transition。

## 11. Empty／Error 狀態

空 slot：

```text
＋ 選擇 Session
```

失效 session：

```text
此 Session 已不存在或無法讀取
[更換] [移除]
```

單 pane 載入錯誤只影響該 pane，其他 pane 繼續運作。

## 12. 禁止事項

- 不得使用 iframe 嵌入多份 Pi Web。
- 不得讓每個 pane 出現自己的 sidebar／file panel。
- 不得使用大型圓角卡片、大陰影、彩色 dashboard metric cards。
- 不得複製 ChatInput markup 後另行維護。
- 不得因 wall mode 改變 normal ChatWindow 的預設 spacing 或 width。
