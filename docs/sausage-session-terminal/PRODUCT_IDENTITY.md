# Sausage Session Terminal 產品識別

狀態：**FROZEN FOR v0.1.0**

## 1. 正式名稱

```text
Sausage Session Terminal
```

大小寫與單字順序固定。程式識別可使用：

- `sausage-session-terminal`
- `SausageSessionTerminal`
- `sst` 僅限內部短稱，不作主要 UI 名稱。

## 2. 定位

一句話：

> A Pi Web multi-session terminal for supervising concurrent Brain sessions.

繁中說明：

> 在同一個 Pi Web 畫面中，同時監看與操作多個 Brain session 的多 Session 終端。

## 3. 與 Pi Web 品牌的關係

Sausage Session Terminal 是 Pi Web fork 的功能模式，不在 v0.1 將整個應用重新品牌化。

### Normal mode

- 保留 Pi Web 名稱、favicon、welcome畫面與版本顯示。
- 不把 upstream UI全部改成 Sausage品牌。

### Wall mode

- 在 Wall toolbar或global status顯示 `Sausage Session Terminal`。
- 模式切換 tooltip可使用產品名稱。
- 可在 document title加入：`Sausage Session Terminal · Pi Web`。

## 4. 視覺識別

v0.1 不建立新的 design system。

必須沿用：

- Pi Web theme variables。
- Pi Web mono font與字級層級。
- Pi Web icon button大小、線寬、hover與active狀態。
- Pi Web panel border、背景與selected treatment。
- Pi Web light/dark/auto主題。

不得：

- 因「Sausage」加入新的臘腸狗圖示、插畫或品牌色到核心 Wall UI。
- 使用固定綠色懸浮球。
- 將 pane做成不同於 Pi Web的 dashboard cards。
- 增加大型品牌 hero或 logo。

圖形品牌可留待後續版本，且不得犧牲 upstream同步能力。

## 5. 模式控制

圖中曾以綠色圓點表示預期位置，但正式控制必須：

- 視覺為 Pi Web原生 icon button。
- active使用 `var(--accent)`。
- 圖示表達 split/grid/session wall。
- 不使用文字過長的浮動按鈕。
- Tooltip：`Open Sausage Session Terminal`／`Close Sausage Session Terminal`。

## 6. 用語

UI 建議：

| English | 繁體中文 |
|---|---|
| Sausage Session Terminal | Sausage Session Terminal |
| Session Wall | 多 Session 模式 |
| Wall | 總控牆 |
| Pane | 分割窗格 |
| Focused | 已聚焦 |
| Manage sessions | 管理 Sessions |
| Replace session | 更換 Session |
| Remove from wall | 從總控牆移除 |

產品名稱不翻譯；功能性 UI可繁中化。

## 7. Repository metadata

Repo維持 `mtai168/pi-web`，因為它是 upstream fork。產品名透過文件、release tag與 Wall mode顯示，不需更名 Repo。

建議 release tag：

```text
sst-v0.1.0-piweb-0.8.11
```
