# 03 — 給 SST Brain 的審查任務與決策紀錄

狀態：**DRAFT_FOR_BRAIN_REVIEW — 尚未核准實作**

## 1. 這一輪請先審查，不要開始實作

Owner 已同意先把共用 session 讀取／同步方案寫入 repo，讓負責 SST 的 Brain 依目前實際程式碼審查並討論；尚未核准這份草稿的技術細節與實作順序。

請完整閱讀本目錄，先比較實際部署 checkout、進行中的 Hands、現有 frozen 文件與此提案。你可以指出提案錯誤、過度設計、已有實作或更簡單方案；不必為了接受提案而重做已完成的能力。

這一輪不要派會修改 production code 的 Hand，不改 schema／套件／SSE／runtime，不發 prompt／Stop 測試真實 agent，不搬動現有 milestone。可做 read-only audit，或在不影響部署的環境執行現有安全測試；報告必須說明實際做過哪些。

## 2. 先對齊基準

記錄：部署 repo／remote、branch、HEAD、dirty files、啟動方式、Pi SDK／lockfile 版本、Wall 模式切換的實際檔案與函数。此提案基底 `647cd341dcd5a66158f6decd5263dfbb94615385` 只代表遠端審查基準。

使用既有 checkout 時，先確認 `origin` 是 `mtai168/pi-web`，再按需取得文件分支；不需要切換正在運行的工作樹：

```bash
git remote -v
git status --short
git branch --show-current
git rev-parse HEAD
# 僅在確認 origin 指向本 fork 後執行：
git fetch origin docs/session-sync-review
git show FETCH_HEAD:docs/session-sync/README.md
```

其餘文件同樣可用 `git show FETCH_HEAD:docs/session-sync/<filename>` 閱讀，或直接看 Draft PR。不要 `reset --hard`、強制 checkout 或自動 stash 使用者修改。

## 3. 必須回答的決策

| ID | 問題 | 提案起點（未核准） |
|---|---|---|
| D01 | provider／store 放在哪裡，才能從未開 Wall 的 normal 也生效？按鈕有沒有整頁重載？ | root 在模式邊界外，兩種畫面只是 consumer；保留 normal URL／selection 行為。 |
| D02 | 現有部署中哪個程序擁有 collector／index writer／hub？ | 同 repo 的受管理 worker／sidecar；先單 owner，避免 Next 多程序／HMR 重複初始化。driver、IPC、啟動與重建由 Brain 提案。 |
| D03 | 外部 CLI 哪些資訊可觀察，哪些只能 unknown？ | 已落盤 history + runtime 可取得的狀態；不假設檔案能提供尚未落盤 token。 |
| D04 | snapshot／replay／subscription 更新如何保證無缺口？ | materialization revision、coverage、runtime seq、transport cursor 分離；有界保留，不能補時 resync。請提出時序與反例。 |
| D05 | 本機內容快取的預設與隱私？ | 與 WallLayoutStore 分離；可停用／清除／限制容量。共用裝置、授權未確認時的離線顯示、跨 tab 清除需 Owner 定案。 |
| D06 | 移除 per-session SSE ready 依賴後，命令成功／拒絕／UNKNOWN 如何判定？ | 保留 HTTP 命令；未具備可靠 dedup／receipt 前禁止自動重試；不把 transport ready 當 agent ready。 |
| D07 | 新舊 transport 切換如何保留 queue／extension UI／通知？ | 單一 reducer owner；明確 request／run routing、去重及 rollback。 |
| D08 | 正在執行的 SST Hands／milestone 如何避開衝突？ | hot files 單一 writer；不擅自把此提案塞進 v0.1.0。先提供安全插入點及依賴。 |
| D09 | 效能／容量／重連門檻與支持環境？ | 02 文件為候選目標。須定案 desktop／Android 型號、網路、Node／browser、DB／queue／cache 預算及 raw measurement。 |
| D10 | 哪些建議目前已做、哪些不值得做？ | 已有能力重用；不得只為吻合文件重寫。需要延後的項目列理由與仍可成立的驗收範圍。 |

## 4. 回覆格式

請先將審查結果回報 Owner；可另提 docs-only commit 或在 Draft PR 留言。不要先把文件狀態改成「已核准」。

```text
Review status: ACCEPT_WITH_CHANGES / NEEDS_REVISION / BLOCKED_BASELINE
Deployment baseline: repo, branch, HEAD, dirty state, runtime version
Audited code: file:function/line @ SHA

1. 整體判斷：是否能同時改善 normal／Wall？最小可行方案是什麼？
2. 已存在的能力：哪些無需重做，證據在哪裡？
3. 錯誤／風險／反例：逐项對應文件與程式碼。
4. D01–D10 決策建議：建議、替代方案、trade-off、是否需要 Owner 決策。
5. frozen 規格 amendments：逐檔列出，不直接默默覆盖。
6. 部署與現有 Hand 衝突：file ownership、依賴、建議插入點。
7. 驗收與回退：哪些測試已存在、還缺什麼？
8. 下一輪討論：仍未解決的 blocker 與最小需要資訊。
```

不得把「尚未量測」當作不判斷結構問題的理由，也不得把靜態推論包裝成已重現效能結果。對未知部署資料，保留 UNKNOWN 而非猜測。

## 5. Gate 紀錄（目前全部尚未完成）

| Gate | 狀態／紀錄 |
|---|---|
| G0-A 部署 HEAD 與完整切換路徑對齊 | PENDING |
| G0-B Brain 程式碼審查與反例回覆 | PENDING |
| G0-C D01–D10 決策及 frozen amendments 定案 | PENDING |
| G0-D 驗收、分工、回退、milestone 插入點確認 | PENDING |
| G0-E Owner 明確核准 | **NOT APPROVED** |

核准時才填：

- Owner 核准引用／時間：未提供。
- 核准文件 commit：未定。
- 實作基底 commit：未定。
- 已核准階段與明確排除範圍：未定。
- 目標 branch／milestone：未定。
- 實作 issue 清單／單一 writer ownership：尚未建立。

上述紀錄完成後，才將提案標為 `OWNER_APPROVED_FOR_IMPLEMENTATION`，同步修改受影響契約並建立實作 issues。之後 Brain 可依已核准 DAG 繼續派 Hand，無須重新猜測需求；遇到超出核准範圍的問題再回 Owner。
