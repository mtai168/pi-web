# 00 — 基準、證據與範圍

狀態：**DRAFT_FOR_BRAIN_REVIEW — 尚未核准實作**

## 1. 可重現的遠端基準

2026-09-10 經 GitHub 讀取：

| Ref | SHA |
|---|---|
| `main` | `28bab3c25f5f6770c9b0b745ebbfec1c27f7b948` |
| `feature/session-wall` | `2dee5ad337770166c4e8aa1c28bc7e9736d266d8` |
| `custom/sausage-session-terminal` | `647cd341dcd5a66158f6decd5263dfbb94615385` |

此次提案以最後一個 SHA 的文件及下列程式碼為引用基準。[package.json](https://github.com/mtai168/pi-web/blob/647cd341dcd5a66158f6decd5263dfbb94615385/package.json) 為 Pi Web `0.8.11`、`@earendil-works/pi-*` `0.84.3`，不是前次討論 upstream 的 `0.9.0／0.85.1`。不應跨版本套用行號或 SDK 行為。

**重要限制：Owner 描述的已運行 Wall／normal 切換實作，尚未在這份審查中對齊部署 commit。不能把遠端規格狀態當作部署進度，也不能宣稱那顆按鈕的生命週期已驗證。**

## 2. 本輪直接讀取的證據

下列都是靜態程式碼／文件觀察，不是正式環境 profiling 結果。

| ID | 證據 | 可確認內容與規劃含義 |
|---|---|---|
| B1 | [session GET](https://github.com/mtai168/pi-web/blob/647cd341dcd5a66158f6decd5263dfbb94615385/app/api/sessions/%5Bid%5D/route.ts) | GET 使用 live SessionManager，否則 `SessionManager.open()`；還取得 entries、tree、context、累積統計及 project 資訊。`tail` 預設 50 不代表整條請求只處理 50 筆。應建立可重用讀取投影。 |
| B2 | [session SSE route](https://github.com/mtai168/pi-web/blob/647cd341dcd5a66158f6decd5263dfbb94615385/app/api/agent/%5Bid%5D/events/route.ts) | 沒有 live wrapper 時會 `startRpcSession()`。共用唯讀 SSE 不得靠在 server 裡打開多條舊 SSE 來聚合。 |
| B3 | [command/state route](https://github.com/mtai168/pi-web/blob/647cd341dcd5a66158f6decd5263dfbb94615385/app/api/agent/%5Bid%5D/route.ts) | POST 可初始化 runtime 後送命令；GET 讀既有 runtime state。傳輸已連線與 agent 已準備好應分離；現有回應不應被假定為持久化命令去重帳本。 |
| B4 | [SSE 實作](https://github.com/mtai168/pi-web/blob/647cd341dcd5a66158f6decd5263dfbb94615385/lib/agent-event-stream.ts) | 已有 listener 安裝、初始化事件暫存、目前 streaming snapshot 與 heartbeat；frame 以 `data:` 編碼。不可把這些既有保護移除，但它不是本提案所需的持久歷史版本／補齊契約。 |
| B5 | [hook 入口與型別](https://github.com/mtai168/pi-web/blob/647cd341dcd5a66158f6decd5263dfbb94615385/hooks/useAgentSession.ts#L1-L180) | 引入 AgentEventConnection、stream reducer、draft recovery，承載 session、extension UI、toolbar callbacks 等多種責任。不能只搬 messages 而遺漏其他事件。此輪讀取此檔前 180 行；完整函式與部署修改列為 Brain 的必要複驗。 |
| B6 | [AGENTS.md](https://github.com/mtai168/pi-web/blob/647cd341dcd5a66158f6decd5263dfbb94615385/AGENTS.md) | 描述 in-process Pi、wrapper registry、fork 後銷毀 wrapper、全檔重寫、running reconciliation、工具切換與 file allow-list 等既有約束。這些是後續 adapter 必須保留的語意。 |
| B7 | [branch contract](https://github.com/mtai168/pi-web/blob/647cd341dcd5a66158f6decd5263dfbb94615385/CUSTOMIZATIONS.md) | `main` 追 upstream；generic 功能在 `feature/session-wall`，品牌與 Brain/Hand parser 在 custom。此次不改這個分層。 |

先前對「逐頁恢復閱讀錨點」「快照互相覆蓋」「tree 夾帶重內容」等分析，應在實際部署 SHA 上逐一複驗。它們構成測試與重構檢查項，不在本文件偽裝成已重新審核部署程式、已重現 bug 或已量測毫秒數。

## 3. Brain 必須補齊的部署端程式碼地圖

請記錄 `git remote -v`、branch、HEAD、dirty state、執行中的 checkout／啟動方式，以及 package 與 lockfile 的 SDK 版本。不要 reset、覆寫或丟棄正在開發的修改。

| 追蹤路徑 | 必須回答 |
|---|---|
| mode 按鈕 → AppShell／router → normal／Wall root | 切换是否整頁 navigation？哪個 provider、hook、EventSource 被卸載？normal 從未進 Wall 時走哪個路徑？ |
| ChatWindow → useAgentSession → loadSession／loadContext | cache lifetime、anchor 恢復、request generation、branch identity、回應合併與取消各由誰負責？ |
| Sidebar／catalog／running polling／notifications | 是否有多個資料擁有者？切模式或 SSE replay 是否重複通知？ |
| handleSend → ensureEventsConnected → command POST | 移除 per-session SSE 後，哪些 ready、prompt recovery、queued commands、extension UI 行為會受影響？ |
| rpc-manager → SDK subscribe → history persistence | 哪些事件尚未落盤？何時才可宣布 durable contentRev？如何避免 SDK 與檔案監看雙重計數？ |
| branch／fork／compact／reload／set_tools | leaf 變更是否只存在 runtime？wrapper 重建與 session ID rekey 如何清除舊訂閱？ |
| lazy media／thinking／tree／stats | 現有 API 是否已修正？哪些內容仍可能突破第一屏資料預算？ |

每個結論附 `file:function/line @ SHA`。缺少部署原始碼時，回報缺口及最小需求；不得從舊快照猜出「已驗證」。

## 4. 與 frozen v0.1.0 規格的差異

本提案沒有直接修改下面文件。核准後先更新契約，再派相關 writer。

| 現行文件 | 原契約／需核對处 | 本提案方向 |
|---|---|---|
| [02_ARCHITECTURE](../session-wall/02_ARCHITECTURE.md) §3–6 | 較薄的 core 改動、pane-local ChatWindow、catalog 可暫由 sidebar 提供 | Session store／catalog／sync 置於模式邊界外；互動、focus、pane error 邊界仍保留。 |
| 同上 §9 | 優先沿用既有 API，batch／multiplex 延後；範例含 `/api/sessions/[id]/state` | multiplex 列入核准後的共用核心階段；此次實際 state route 是 B3 的 `/api/agent/[id]`，Brain 核對部署差異，不照抄錯誤路徑。 |
| [03_STATE_AND_PERSISTENCE](../session-wall/03_STATE_AND_PERSISTENCE.md) §6–9、§12 | 既有 draft、URL 優先、best-effort scroll、Wall storage 不存訊息 | WallLayoutStore 仍只存 metadata；另提 SessionReadCache／IndexedDB 的隱私與容量政策。不得默默解除原禁令。 |
| [04_MULTI_SESSION_RUNTIME](../session-wall/04_MULTI_SESSION_RUNTIME.md) | 需複驗各 pane／running／SSE 所有權 | 改為每頁一個 sync owner，與 agent 執行生命週期分離；保留逐 session Send／Stop／queue／extension 行為。 |
| [05_PERFORMANCE_AND_VIRTUALIZATION](../session-wall/05_PERFORMANCE_AND_VIRTUALIZATION.md) | 現有 hot／warm／cold 與渲染策略 | 保留可見性設計，但資料及 transport 不因冷面板卸載而消失；不能只做到少 render、多重整份解析仍存在。 |
| [06_FAILURE_MODES_AND_RECOVERY](../session-wall/06_FAILURE_MODES_AND_RECOVERY.md)、[07_ACCEPTANCE_TESTS](../session-wall/07_ACCEPTANCE_TESTS.md) | 現有恢復／正常模式回歸 | 加入版本倒退、快照銜接、外部寫入、休眠瀏覽不啟動 agent、cache eviction、模式切換測試。 |
| [08_IMPLEMENTATION_PLAN](../session-wall/08_IMPLEMENTATION_PLAN.md)／trackers | 現有依賴與 file ownership | 新工作尚未排入任何 milestone；Brain 提出與正在執行 Hands 的衝突清單，由 Owner 決定插入點。 |

## 5. 範圍與非目標

優先修共用讀取／同步，維持現有 UI、normal selection、URL 意圖、draft key、keyboard／toolbar routing。不是把切回 normal 改成強制選擇剛才 focused Wall session。

不新增自動發送、離線命令重播或 AI 自行執行的工作流。不假設 Tailscale 就等於完整授權。不卡死在 SQLite driver、provider 元件名或 API 路徑；它們在審查後才定案。
