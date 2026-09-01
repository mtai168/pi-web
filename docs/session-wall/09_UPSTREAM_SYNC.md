# Session Wall Upstream 同步策略

狀態：**FROZEN**

## 1. Branch model

```text
agegr/pi-web:main
        ↓
mtai168/pi-web:main
        ↓
feature/session-wall
        ↓
custom downstream product branch
```

- `main`：乾淨 upstream mirror，避免直接開發。
- `feature/session-wall`：通用、可 upstream 的功能。
- custom branch：品牌與 workflow-specific功能。

## 2. Remote 設定

```bash
git remote add upstream https://github.com/agegr/pi-web.git
git fetch upstream
```

確認：

```bash
git remote -v
git branch -vv
```

## 3. 更新 main

```bash
git switch main
git fetch upstream
git reset --hard upstream/main
git push --force-with-lease origin main
```

只有在確認 `main` 不含 fork-only commit時使用 reset。若有意外 commit，先備份 branch。

## 4. Rebase feature

```bash
git switch feature/session-wall
git rebase main
```

啟用 rerere：

```bash
git config rerere.enabled true
```

通過測試後：

```bash
git push --force-with-lease origin feature/session-wall
```

## 5. 更新 custom layer

```bash
git switch custom/sausage-session-terminal
git rebase feature/session-wall
git push --force-with-lease origin custom/sausage-session-terminal
```

custom branch不得反向 merge進 feature branch。

## 6. 衝突熱點

高機率衝突：

- `components/AppShell.tsx`
- `components/ChatWindow.tsx`
- `hooks/useAgentSession.ts`
- `hooks/useKeyboardShortcuts.ts`
- `lib/i18n/messages/*.ts`

降低衝突原則：

- Session Wall大多數邏輯放新檔案。
- AppShell只留下 mode入口與 composition。
- ChatWindow使用小型、向後相容 props。
- 不重新排版整個 upstream檔案。
- 不在同一 commit混入無關清理。

## 7. Upgrade gate

每次 upstream更新必須依序：

1. Review upstream release notes／diff。
2. Rebase feature。
3. Resolve conflicts without weakening tests。
4. `npm install`／`npm ci`依 upstream指引。
5. `npm test`。
6. `tsc --noEmit`。
7. `npm run lint`。
8. Dev smoke test normal mode。
9. Dev smoke test 2×2／2×6。
10. Release build。
11. 以測試 port啟動。
12. 才替換日常使用版本。

## 8. Rollback

保留上一個已驗證 tag，例如：

```text
sst-v0.1.0-upstream-0.8.11
```

部署失敗時：

- 停止新版本 Pi Web。
- checkout上一個 verified tag／artifact。
- 使用相同 `PI_CODING_AGENT_DIR` 啟動。
- 不同 Pi Web server不得同時對同一 active session提供互動。

## 9. 禁止更新方式

- 不 patch `.next` minified chunks。
- 不在全域 npm package安裝後注入不穩定字串替換。
- 不以 `git push --force` 取代 `--force-with-lease`。
- 不在測試失敗時直接升級日常環境。
- 不為了過 rebase而刪除 upstream regression tests。

## 10. Upstream PR 準備

若功能實際使用穩定：

- PR只從 `feature/session-wall` 出發。
- 移除 downstream branding與 Brain parser。
- 補英文文件／i18n。
- 說明 feature預設不影響 normal mode。
- 提供 2×2/2×4/2×6 screenshots與 performance evidence。
- 引用上游相關 multi-project/session management issues。
- 接受 maintainer要求拆分為多個小 PR。
