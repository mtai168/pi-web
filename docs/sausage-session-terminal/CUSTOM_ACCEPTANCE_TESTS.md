# Sausage Session Terminal 自訂層驗收測試

狀態：**FROZEN FOR v0.1.0**

本文件補充通用 [`Session Wall 驗收`](../session-wall/07_ACCEPTANCE_TESTS.md)。兩者都必須通過。

## 1. Parser unit tests

### Canonical

輸入：

```text
BRAIN_STATUS: WAITING_FOR_HANDS
milestone: I45
active_hands: 3
blocker: none
new_dispatches: 0
```

期望：完整正確 snapshot，confidence=`explicit`。

### Legacy separator

覆蓋：

```text
milestone I45 remediation
active_hands == 0
blocker == owner physical recheck
new_dispatches = 0
BRAIN_STATUS: BLOCKED_OWNER
```

### Marker before fields

Canonical marker在第一行，欄位在後方仍可擷取。

### Multiple blocks

同一訊息有舊 `WAITING_FOR_HANDS` 與最後 `MILESTONE_COMPLETE`，只取最後 block與鄰近欄位。

### False positive

正文說明四種狀態、貼規格範例，但尾端無 terminal marker，不得誤判。

### Missing fields

只有 `BRAIN_STATUS` 時仍回傳 status，其他欄位null並有 diagnostic。

### Invalid numbers

- `active_hands: -1`
- `active_hands: 1.5`
- `new_dispatches: many`

不得猜測，值為null。

### Blocker normalization

`none`、`-`、`無` → null；中文長 blocker原文保留。

### Bounds

- 超過120行只分析尾端。
- 超過16KiB只分析尾端。
- 超長 blocker受長度上限保護。

### Runtime fallback

無 structured status時：running／idle／error呈現正確，不偽造四種 Brain status。

## 2. Integration tests

- A pane最新狀態不會出現在B pane。
- A/B同時完成時各自解析。
- Streaming過程保留上一 stable status並顯示 running。
- Prompt settled後更新至新 status。
- Cold pane捲回後以 canonical tail更新，不使用永久 stale snapshot。
- Slot替換後舊 parser result立即清除。
- Session失效時不保留看似有效的舊 Brain status作為當前真相；可標示last known但需明確 stale。

## 3. UI tests

每一狀態：

- `DISPATCHED`
- `WAITING_FOR_HANDS`
- `BLOCKED_OWNER`
- `MILESTONE_COMPLETE`

都需驗證：

- Header文字完整。
- 非只靠顏色。
- 長 milestone ellipsis＋tooltip。
- 長 blocker最多合理行數，不擠掉 ChatInput。
- Light/dark theme可讀。
- 2×2、2×4、2×6不破版。
- 狀態 presentation使用 Pi Web style，不是新 dashboard badge。

## 4. Workflow acceptance

建立至少四個實際 Brain sessions：

1. 剛派出 Hands。
2. 正在等待 Hands。
3. 等待 owner確認。
4. milestone完成。

確認一個 viewport內可不開 transcript details就辨識四種狀態，並能在正確 pane直接輸入回覆。

## 5. Branch separation

- `feature/session-wall` 不得 import `brain-status-*`。
- 通用 types不得列出四種自訂狀態。
- 移除 custom layer後 Session Wall仍完整運作。
- 未來 upstream PR diff不包含 Sausage品牌、Brain parser或個人 workflow字串。

## 6. Product identity

- Normal mode仍顯示 Pi Web。
- Wall mode顯示 `Sausage Session Terminal`。
- 不更換 favicon或主題色。
- 模式按鈕使用 Pi Web design token，不是固定綠色。
- zh-TW／en文案不溢出。

## 7. Release evidence

產品 release issue需額外附：

- Parser fixture test結果。
- 四種 Brain status實際截圖。
- 至少一次從 `BLOCKED_OWNER` pane直接回覆並更新狀態的操作紀錄。
- Branch diff檢查，證明 generic/custom分離。
