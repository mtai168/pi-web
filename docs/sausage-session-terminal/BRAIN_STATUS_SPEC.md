# Brain 狀態格式與解析規格

狀態：**FROZEN FOR v0.1.0**  
適用分支：`custom/sausage-session-terminal`

## 1. 目的

Sausage Session Terminal 需要從每個 Brain session 的最新 Assistant 最終回覆中，擷取一致的 workflow 狀態，讓使用者不用逐格閱讀完整 transcript 即可掌握：

- Brain 是否剛派工。
- 是否正在等待 Hands。
- 是否需要 owner介入。
- milestone是否完成。
- 目前 active Hands數量。
- blocker與新派工數量。

Parser只做顯示，不修改 session，不自動推進狀態，也不取代 Pi Web runtime running state。

## 2. Canonical status block

Brain應在每個事件／回合結尾輸出：

```text
BRAIN_STATUS: WAITING_FOR_HANDS
milestone: I45 structured-output history remediation
active_hands: 3
blocker: none
new_dispatches: 0
```

允許狀態：

```text
DISPATCHED
WAITING_FOR_HANDS
BLOCKED_OWNER
MILESTONE_COMPLETE
```

欄位：

- `BRAIN_STATUS`：必要。
- `milestone`：建議必要，string。
- `active_hands`：建議必要，非負整數。
- `blocker`：建議必要，string或none。
- `new_dispatches`：建議必要，非負整數。

## 3. Legacy 格式相容

現有 Brain可能輸出：

```text
BLOCKED_OWNER
milestone I45 structured-output history bug remediation
active_hands == 0
blocker == owner physical recheck
new_dispatches == 0
BRAIN_STATUS: BLOCKED_OWNER
```

v0.1 parser需接受 key後的分隔：

- `:`
- `=`
- `==`
- 一個以上空白

Key比對不分大小寫，但輸出 normalize為小寫欄位名與大寫狀態。

## 4. 解析來源

只解析：

- 最新一則可顯示的 Assistant final answer text。
- 該訊息最後最多 120 logical lines。
- 該訊息尾端最多 16 KiB文字。

不得搜尋整份 session歷史，避免把舊狀態當成現在狀態。

Tool result、user message、system prompt與舊 Assistant訊息不得成為主要狀態來源。

## 5. 解析優先序

### Level 1 — Explicit marker

取尾端最後一次出現：

```text
BRAIN_STATUS: <STATE>
```

若 STATE有效，以它為真相，並在鄰近範圍擷取欄位。

### Level 2 — Structured terminal block

若無 explicit marker，僅在最後 20個非空行中存在：

- 單獨一行有效 STATE；且
- 至少兩個 companion fields

才接受為 structured status。

### Level 3 — Runtime fallback

若無可信 structured status：

- Pi Web runtime running → `RUNNING`。
- runtime idle → `IDLE`。
- load/error → `UNKNOWN`／error state。

不得僅因正文中提到 `BLOCKED_OWNER` 就判斷為狀態。

## 6. Field window

找到最後一個 explicit marker後：

- 往前最多 12個非空行。
- 往後最多 6個非空行。
- 同一 key取最接近 marker、最後出現的值。

若 marker在最後，能擷取前方 legacy欄位；若 canonical marker在最前，也能擷取後方欄位。

## 7. 值正規化

### active_hands／new_dispatches

- 接受十進位非負整數。
- 負數、NaN、小數、極大溢位視為 invalid。
- invalid保留 `null`並產生 parser diagnostic，不猜測。

### blocker

以下視為無 blocker：

```text
none
null
n/a
na
-
無
沒有
```

其他值 trim後保留原文，限制顯示長度但 parser result可保留合理上限，例如 2 KiB。

### milestone

- trim。
- 多餘空白可壓成單一空白，但不改變中英文內容。
- 空字串為 null。

## 8. Result type

```ts
type BrainStatus =
  | "DISPATCHED"
  | "WAITING_FOR_HANDS"
  | "BLOCKED_OWNER"
  | "MILESTONE_COMPLETE";

interface BrainStatusSnapshot {
  status: BrainStatus;
  milestone: string | null;
  activeHands: number | null;
  blocker: string | null;
  newDispatches: number | null;
  confidence: "explicit" | "structured";
  sourceMessageTimestamp: number | null;
  diagnostics: BrainStatusDiagnostic[];
}
```

Runtime fallback不偽裝為 `BrainStatusSnapshot`；UI以另一個 union表示。

## 9. 一致性 diagnostics

Parser不因欄位矛盾改寫 explicit state，但可產生非阻斷 diagnostic：

- `WAITING_FOR_HANDS` 且 `active_hands === 0`。
- `BLOCKED_OWNER` 但 blocker為null。
- `MILESTONE_COMPLETE` 但 active_hands > 0。
- `MILESTONE_COMPLETE` 但 new_dispatches > 0。
- `DISPATCHED` 但 new_dispatches === 0。

UI v0.1不必顯示全部 diagnostics；dev log與測試需可觀察。

## 10. 多狀態文字

若同一最新 Assistant訊息包含多個 status block：

- 永遠取尾端最後一個可信 block。
- 之前的 block視為歷程，不合併欄位。
- companion fields只在最後 marker鄰近 window擷取。

## 11. Code fence／引用

False-positive防護：

- explicit marker仍可在普通文字或簡單 code block中解析，因 Brain可能刻意用 code block輸出。
- 但若 marker後仍有超過 40個非空正文行，視為不是 terminal block，不採用。
- 引用舊規格而在最後另有新的 marker時，取最後 marker。
- 無 marker時，code example中的單獨 state不足以通過 Level 2，除非 companion fields也形成 terminal block；測試需覆蓋。

## 12. UI 呈現

Pane header：

```text
WAITING_FOR_HANDS · 3 hands
```

Pane footer：

```text
I45 structured-output history remediation
blocker: —
new dispatches: 0
```

`BLOCKED_OWNER` 應有明確 attention icon／semantic text color，但仍沿用 Pi Web現有 style。不得新增大型彩色 dashboard badge。

Status age顯示相對時間。v0.1不自動創造 `STALLED` 第五狀態；疑似停滯規則留待後續版本。

## 13. 更新時機

- Session tail初次載入後解析。
- Assistant final message完成後解析。
- Reconcile重新載入 canonical session後解析。
- Streaming尚未形成 final answer時，保留上一個 stable status並另外顯示 runtime running。

不得在每個 token重新完整 parse 16 KiB；可在 prompt settled或低頻 debounce後執行。

## 14. 安全

- Parser輸出以純文字渲染。
- blocker/milestone不可作為 HTML。
- 不把解析欄位當 command執行。
- 不因文字聲稱派工完成而變更 Agent runtime或GitHub狀態。
