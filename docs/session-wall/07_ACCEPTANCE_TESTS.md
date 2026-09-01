# Session Wall 驗收測試

狀態：**FROZEN FOR v0.1.0**

## 1. Release gate

v0.1.0 只有在以下全部通過後才可標記完成：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
npm run build
```

Production build只在 release驗收階段執行，不在一般 dev server迭代中反覆執行。

## 2. 自動測試分類

### 2.1 Store／validation

- 無 storage時建立 default 2×2。
- malformed JSON回退且不覆寫 raw。
- 不合法 layout回退。
- slot數量依 layout normalize。
- 重複 sessionId去重。
- stale sessionId保留。
- focusedPaneId失效時選第一個有效 pane。
- v1 round-trip不遺失欄位。

### 2.2 Reducer

- add/replace/remove slot。
- layout 4→8→12補空 slot。
- layout 12→4裁切有明確策略。
- focus切換。
- session刪除標記 stale而非刪 config。
- pane runtime revision在替換時增加。

### 2.3 Focus／keyboard

- 只有 focused pane註冊全域 abort。
- 點 A輸入框後 Escape操作 A。
- 點 B header後 toolbar callbacks只接受 B。
- input內 menu Escape仍由 ChatInput處理。
- unmount focused pane後 action清除或移轉。

### 2.4 ChatWindow wall mode

- normal mode snapshot／DOM contract不變。
- wall mode不渲染 minimap。
- wall mode保留 ChatInput。
- Send綁定正確 session。
- Stop綁定正確 session。
- pane-local status存在。
- toolbar reporting可關閉。

### 2.5 Async race

- A慢 stats response在聚焦 B後被丟棄。
- slot A→C替換後A SSE event不寫入C。
- cold→hot快速切換不重複 prompt。
- mode切換時舊 callback不 resurrect UI。

### 2.6 Virtualization

- viewport中 panes為hot。
- overscan panes為warm。
- 遠端 panes為cold。
- focused pane不會cold。
- cold pane恢復時載入最新 canonical tail。
- draft不因 unmount遺失。

## 3. 手動功能驗收

### 3.1 2×2

- 從四個不同 project選 session。
- 四格同時顯示正確 project/session。
- 在四個輸入框分別輸入不同草稿，切 focus後內容不互換。
- 連續向四格送出訊息，每則進入正確 session。
- 四格可同時 running。
- 每格 Stop只停止自身。

### 3.2 2×4／2×6

- Layout擴充後保留既有前四格順序。
- 新 slots可跨 project選擇。
- Pane高度不縮小。
- Wall外層可捲到所有列。
- Transcript與外層 scroll chaining可預期。
- 捲離再返回，pane取得最新內容。

### 3.3 Mode switch

- 正常模式 sidebar開、file panel關 → 進 Wall全部隱藏 → 離開後恢復。
- 正常模式 file panel開 → 進 Wall隱藏 → 離開後恢復。
- running期間來回切換不停止 Agent。
- 離開後顯示 focused session。
- `?session=`／`?cwd=` initial navigation不被 Wall preference覆蓋。

### 3.4 Toolbar

針對 focused pane驗證：

- 完整紀錄。
- 產生標題。
- 分支切換。
- System Prompt。
- Tools。
- Session stats/context。
- file open source。

切換 focus後不得殘留前一 pane資料或操作錯誤 session。

### 3.5 Extension

- 兩個 pane各有不同 status widget，顯示不混淆。
- 一個 pane出現 blocking request時來源清楚。
- 回覆 blocking UI進入正確 session。
- 多 pane完成音不重複。

## 4. 視覺驗收

基準 viewport：

- 3120×2080 physical。
- Windows scale 200%。
- Browser zoom 110%。
- 約 1418×945 CSS viewport。

需通過：

- Light theme。
- Dark theme。
- Auto theme切換。
- English、zh-CN、zh-TW。
- 100%、110%、125% browser zoom。

視覺硬條件：

- 無 dashboard card look。
- Pane border、hover、selected、button與 Pi Web一致。
- ChatInput不是仿製版。
- 文字、code、tool內容不水平溢出整頁。
- focused outline不造成 layout jump。
- floating mode control不蓋住 toolbar dropdown或 pane action。

## 5. 效能驗收

- 2×6 首次開啟時只讓可見＋overscan panes進入 hot/warm。
- Idle 10分鐘無持續單核滿載。
- 4 sessions同時長輸出時仍可在第5個 pane流暢輸入。
- 12 panes連續使用60分鐘，無明顯 memory leak。
- 快速捲動六列不觸發大量重複 model/slash requests。
- Dev diagnostics顯示 mounted ChatWindow數符合 policy。

## 6. 失敗驗收

- 刪除其中一個 session後只該 pane顯示 stale。
- 中斷 network後 drafts保留，恢復後 running狀態同步。
- 重啟 Pi Web server後 Wall可恢復。
- Corrupt localStorage後 normal mode仍可用。
- 一個 pane render error不影響其他 pane。
- 替換 slot時舊 stream不出現在新 session。

## 7. 回歸驗收

在 normal mode逐項確認：

- sidebar project/session navigation。
- new session。
- ChatInput、draft、image。
- send/stop/steer/follow-up。
- branch/fork。
- file explorer/viewer。
- model/thinking/tools。
- extension UI/status。
- notifications/sound。
- mobile layout至少不因新增程式崩潰；v0.1 Wall可在mobile明確disabled。

## 8. 完成證據

Release issue需附：

- 自動測試輸出。
- TypeScript與lint輸出。
- 2×2、2×4、2×6 screenshots。
- performance profile摘要。
- 60分鐘 soak結果。
- 已知限制清單。
