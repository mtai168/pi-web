# Sausage Session Terminal 日常操作與維護流程

狀態：**DRAFT FOR v0.1.0 OPERATIONS**

## 1. 日常使用流程

1. 以 `custom/sausage-session-terminal` build啟動 Pi Web。
2. 在正常 Pi Web建立或選擇各專案 Brain session。
3. 按模式按鈕進入 Sausage Session Terminal。
4. 以 `管理 Sessions` 將每個專案主要 Brain加入 slots。
5. 依同時工作量選擇 2×2、2×4或2×6。
6. 直接在各 pane自己的輸入框與 Brain互動。
7. 需要完整歷史、file viewer或進階 session panel時，展開該 pane至 normal mode。
8. 返回 Wall後繼續監看其他 sessions。

## 2. 建議 slot 排列

保持空間記憶：

```text
左上：最主要產品 Brain
右上：第二主要產品 Brain
左下：review/remediation
右下：research/support
```

2×4／2×6延續相同 project grouping，避免每次替換造成視覺記憶混亂。

## 3. Brain 輸出契約

Brain AGENTS／APPEND_SYSTEM應要求每次事件結尾輸出 canonical block：

```text
BRAIN_STATUS: <STATE>
milestone: <text>
active_hands: <integer>
blocker: <text|none>
new_dispatches: <integer>
```

Sausage Session Terminal仍支援既有 legacy separators，但 canonical格式是後續維護基準。

## 4. 狀態使用方式

- `DISPATCHED`：確認 Brain已派新 Hand；可切去其他 pane。
- `WAITING_FOR_HANDS`：通常不需介入，觀察 active hands與更新時間。
- `BLOCKED_OWNER`：優先閱讀 blocker並在該 pane直接回覆。
- `MILESTONE_COMPLETE`：檢查成果、決定下一 milestone或關閉／替換 slot。

Runtime顯示 Running但 structured status仍是上一狀態時，表示 Brain正在產生新回覆；待 settled後才更新 stable status。

## 5. 更新部署

正式使用版本需標記 verified tag：

```text
sst-v<product>-piweb-<upstream>
```

例如：

```text
sst-v0.1.0-piweb-0.8.11
```

升級流程依 [`09_UPSTREAM_SYNC.md`](../session-wall/09_UPSTREAM_SYNC.md)。

## 6. 雙 server 注意

不得讓官方 npm Pi Web與 fork build同時對相同 `PI_CODING_AGENT_DIR` 中的 active session送指令。測試新 build時：

- 優先使用不同 port。
- 最好使用隔離測試 agent dir或只做唯讀 smoke test。
- 正式切換前停止舊 server。

## 7. 備份

Wall設定主要在 browser localStorage，不等於 session備份。需要：

- 持續備份 `~/.pi/agent`。
- 升級前記錄目前 verified tag與 upstream SHA。
- 未來若加入 Wall export，仍不得把它當成 session JSONL備份。

## 8. 問題回報模板

回報 Session Wall問題時附：

- Product tag。
- Upstream Pi Web版本／commit。
- Browser與OS scaling/zoom。
- Layout（2×2／2×4／2×6）。
- Pane數與同時 running數。
- 問題是否只在 custom Brain status層發生。
- Console/server log與安全可分享的重現步驟。

不得貼 API keys、credentials或敏感 prompt內容。
