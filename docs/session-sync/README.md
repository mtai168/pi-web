# 共用 Session 讀取與同步核心：審查提案

狀態：**DRAFT_FOR_BRAIN_REVIEW — 尚未核准實作**  
提案版本：0.1（文件版本，不是產品版本）  
日期：2026-09-10  
審查分支：`docs/session-sync-review`  
適用範圍：原版 Pi Web normal mode 與 Session Wall 共用核心。

> 這是一份給負責 SST 的 Brain 審查、提出反例及討論的提案，不是開工指令。文件提交、Draft PR 建立或技術審查通過，都不代表 Owner 已核准實作。既有 v0.1.0 frozen 規格與 tracker 不因本提案自動改變。

## 目標

保留 Pi Web 的外觀、手機操作與 Wall 多面板互動，先改善現有 fork，不以 Windows／Android 原生重寫為前提。

**Normal 與 Wall 是兩個視圖，不是兩套資料引擎。** 網站剛開啟、完全沒有進入 Wall，normal mode 也必須享有相同的讀取快取、同步及恢復能力。切回原版模式，不得切回舊資料層。

目標行為：

- 近期看過的 session 先從記憶體恢復；重新開啟時可先使用允許保存的本機歷史，再補差異。快取不是「已確認最新」。
- Server 在沒有網頁開啟時也維護已知 session 的讀取索引與可觀察狀態；不是持續完整重讀所有檔案，也不為查看歷史啟動休眠 agent。
- 使用中的每個應用頁面，最終共用一條 session SSE，承載多個 session 更新。手機與電腦各自一條；不是整台 server 只允許一條連線。
- 前景可見面板即時更新；背景裝置可以休息，恢復時補資料，不重播所有 token，更不能重送指令。

## 閱讀順序

1. [基準、證據與範圍](./00_BASELINE_AND_SCOPE.md)：哪些已核對，哪些必須由部署端 Brain 複驗，以及與 frozen 規格的衝突。
2. [架構與同步契約](./01_ARCHITECTURE_AND_SYNC.md)：狀態所有權、讀取索引、SSE、增量同步、命令及安全邊界。
3. [交付階段與驗收](./02_DELIVERY_AND_TESTS.md)：依賴、單一 writer 分工、回歸測試、效能指標及回退。
4. [Brain 審查與決策紀錄](./03_BRAIN_REVIEW.md)：審查任務、待決議事項、回覆格式及核准 gate。

## 本次沒有做的事

沒有改 application code、Pi SDK、套件版本、session 檔案格式或部署設定。沒有建立實作 issues、指派 Hands、調整既有 milestone、宣稱通過效能測試，也沒有合併到產品分支。

本提案不要求先導入 Rust、GPUI、WebSocket、Redis、Kafka、Kubernetes，或重寫 Pi agent。原生客戶端可在未來共用這套協定，但不屬於此次範圍。

## 文件位置與分支用途

`docs/session-sync/` 是兩種視圖共用的技術提案，不放在產品專屬 parser 目錄，也不視為 Wall 才能啟用的功能。SST README 提供入口。

本次文件審查分支以遠端 `custom/sausage-session-terminal@647cd341dcd5a66158f6decd5263dfbb94615385` 為基底，只用於交接審查；它不代表實際部署 HEAD。核准後，通用實作應遵守既有 generic → custom 分層，由 Brain 先核對實際程式 ancestry，再選擇正確整合基準。不要把整個 custom branch 反向合併進 generic branch。

## 核准流程

`DRAFT_FOR_BRAIN_REVIEW → BRAIN_REVIEWED → OWNER_APPROVED_FOR_IMPLEMENTATION`

Brain 先回覆部署基準、程式碼證據、反例、替代方案與決策建議；與 Owner／本提案討論後修訂。必須記錄 Owner 的明確核准、核准文件 commit、實作基底 SHA、分階段範圍與驗收門檻，才可建立實作任務並派 Hand。

**目前只授權審查與規劃，不授權依這份草稿開始改造 runtime。**
