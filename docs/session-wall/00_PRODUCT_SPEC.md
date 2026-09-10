# Session Wall 產品規格

狀態：**FROZEN FOR v0.1.0**  
功能名稱：**Session Wall**  
產品層名稱由 downstream fork 自行定義。

## 1. 問題

Pi Web 目前一次只呈現一個 session。當使用者同時讓多個專案中的 Brain／Agent session 工作時，必須反覆：

1. 切換專案或 workspace。
2. 在該專案下找到 session。
3. 開啟 session 查看進度。
4. 再切換到下一個專案。

這使「監督多個並行 Agent」變成高頻、低價值的導航工作，也增加漏看完成、失敗或需要人類介入訊息的風險。

## 2. 產品目標

Session Wall 的目標是讓使用者在一個 Pi Web 頁面中：

- 同時看到 4、8 或 12 個指定 session。
- 直接在每一格輸入與操作，不必先切換全域 session。
- 保留每個 session 的獨立 transcript、草稿、串流與 Stop 行為。
- 一眼識別各 session 的 running／idle／attention 狀態。
- 以 focused pane 將既有全域工具列安全地路由到正確 session。
- 保持 Pi Web 原有介面風格與單 Session 工作流。
- 在 upstream 更新後，仍能以小型、可測試的 patch set 維護。

## 3. 目標使用者

主要使用者是同時執行多個長時間 coding-agent 工作的 Pi Web 重度使用者，例如：

- 多專案並行開發。
- 一個 Brain session 派發多個 Hand／subagent。
- 同時進行 implementation、review、research 與 remediation。
- 需要在同一個畫面快速回覆不同 session。

## 4. 核心使用情境

### 4.1 建立 Wall

使用者進入 Wall 模式，選擇 `2×2`、`2×4` 或 `2×6`，並從不同 project 選入 session。選擇結果在重新整理與重啟後保留。

### 4.2 同時監看

每個 pane 顯示 session 名稱、project、branch、running 狀態、近期對話與即時輸出。使用者不需要切換 sidebar 即可掌握進度。

### 4.3 直接互動

每個 pane 都有自己的 ChatInput。使用者在左上 pane 輸入的訊息永遠送到左上 pane 對應的 session，不依賴全域 focus 才能決定目標。

### 4.4 全域操作

點擊任一 pane 後，它成為 focused pane。原本 Pi Web 上方的完整紀錄、標題、分支、System、Tools、statistics、context usage 等操作，均以 focused pane 為目標。

### 4.5 展開與返回

使用者可將某一 pane 展開回原本單 Session 模式。返回 Wall 時，Wall 配置、pane 順序、focused pane、草稿與合理範圍內的捲動狀態應保留。

## 5. v0.1.0 必要功能

### 5.1 模式切換

- 正常模式與 Wall 模式可雙向切換。
- 進入 Wall 時隱藏左右面板，但不得刪除其狀態。
- 離開 Wall 時恢復進入前的 sidebar／file panel 開關狀態。

### 5.2 Layout

- 固定兩欄。
- `2×2`：4 panes，共 2 列。
- `2×4`：8 panes，共 4 列。
- `2×6`：12 panes，共 6 列。
- 所有 layout 使用相同可讀 pane 高度；超過 viewport 時由 Wall 外層垂直捲動。
- 不提供將 8 或 12 panes 強制壓進一個 viewport 的模式。

### 5.3 Pane

每個 pane 至少包含：

- Project／workspace 顯示名稱。
- Session 名稱或 fallback 標題。
- Branch／worktree secondary information。
- Running／idle／error／attention 狀態。
- Transcript 區域。
- 自己的 ChatInput。
- 自己的 Send／Stop。
- 自己的 draft。
- 自己的 extension status／widget 區域。
- 聚焦、展開、更換、移除操作。

### 5.4 Session 選擇

- 可跨 project 搜尋與選擇既有 session。
- 同一 session 不得重複加入同一個 Wall。
- 已刪除或不可讀 session 顯示失效 slot，不得導致整個 Wall 崩潰。
- 空 slot 可直接開啟 picker。

### 5.5 Focus

- 任一時間最多一個 focused pane。
- 點擊 pane 內容、ChatInput 或 header 操作，會更新 focus。
- focus 不決定 pane 內 Send 的目標；Send 永遠屬於該 pane。
- focus 決定全域 toolbar、Escape 與 session-global panels 的目標。

### 5.6 Persistence

- 保存 Wall layout、pane session IDs、順序與 focused pane。
- 版本化 storage schema。
- 不修改 Pi session 檔案以保存 Wall metadata。
- localStorage 不可用時仍可運作，但設定不持久化。

## 6. 非目標

v0.1.0 不包含：

- 多使用者或權限隔離。
- 同一 session 的多人協作。
- 非 Pi Agent CLI 整合。
- 任意自由排版、拖拉 resize 或巢狀 split。
- 修改 Pi session JSONL schema。
- 將多個 Pi Web iframe 拼成牆。
- 跨瀏覽器／跨主機同步 Wall 設定。
- 將 file explorer 複製到每個 pane。
- 重新設計 Pi Web 的 ChatInput、MessageView 或主題。
- downstream 專用 Brain status 解析；該功能屬於 custom layer。

## 7. 產品限制

- 必須在 Pi Web 現有安全邊界內執行。
- 不因「只監看」而啟動不必要的 AgentSession；讀取歷史應走既有 browsing API。
- 不允許一個 pane 的錯誤摧毀其他 pane。
- 不允許切換 Wall 模式停止後端正在執行的 Agent。
- 不允許草稿在 pane virtualization 或模式切換時遺失。

## 8. 成功條件

v0.1.0 視為成功，需同時滿足：

- 使用者可穩定操作 2×2。
- 2×4、2×6 可長時間捲動與監看，不出現持續性效能劣化。
- 每格輸入永遠送往正確 session。
- 全域工具列永遠作用於 focused pane。
- 單 Session 模式無功能回歸。
- Wall UI 在視覺上可被合理認為是 Pi Web 原生功能。
- 全部自動測試、TypeScript、lint 與指定手動驗收通過。

## 9. 名詞

- **Wall**：一組已保存的多 Session layout。
- **Pane**：Wall 中對應一個 session 的互動區塊。
- **Focused pane**：目前接收全域工具列與快捷鍵的 pane。
- **Hot pane**：完整掛載 transcript、ChatInput 與必要 runtime 的 pane。
- **Warm pane**：接近 viewport，保留較輕量預載狀態的 pane。
- **Cold pane**：遠離 viewport，只保留 metadata／snapshot 的 pane。
