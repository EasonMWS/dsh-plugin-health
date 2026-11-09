# 怎么开发

两条线，两个目录，互不影响。

| | 目录 | 分支 | 版本 | 谁在用 |
| --- | --- | --- | --- | --- |
| **主线** | `dsh-plugin-health\` | `main` | 3.0.7 | 装插件的人（`npm i -g`） |
| **实验** | `dsh-plugin-health-4.0\` | `4.0-beta` | 4.0.0-beta.2 | 手动下安装包的人 |

两个目录是 **git worktree**，同一个仓库的两次签出。切目录不用切分支，改一边不会碰到另一边。

---

## 改动放哪

```
用户报告 3.x 的问题？
  └─ 在 main 改 → 发 3.0.8 → cherry-pick 到 4.0-beta

只有 4.0 才有的东西（桌面软件、插件开关、市场兼容）？
  └─ 只在 4.0-beta 改

两边都有的 bug？
  └─ 先在 main 修，再 cherry-pick 过去
```

**顺序不能反。** 先在 4.0 修，3.x 的用户就一直在坏。

cherry-pick：

```sh
# 在 main 上拿到提交号
git log --oneline -1

# 去 4.0 目录
cd ..\dsh-plugin-health-4.0
git cherry-pick <提交号>
```

---

## 发 3.x（主线）

在 `dsh-plugin-health\`：

```sh
npm test                              # 必须有 0 失败
# 改 package.json 版本 → 3.0.8
# 改 README 两处版本号
# 改 CHANGELOG.md 顶部加一节
git add -A && git commit -m "..."

git push origin main                  # 先推！发布 workflow 用的是推上去的树
# 等 ci.yml 变绿

gh workflow run publish-npm.yml --ref main
# 版本号里没有 "-" → dist-tag 自动是 latest
```

发布后**核对 tarball，不是只看 dist-tags**：

```sh
npm pack dsh-plugin-health@3.0.8
tar -xzf dsh-plugin-health-3.0.8.tgz -C .
# 检查 package/ 里的文件对不对
```

最后打标签和发 Release：

```sh
git tag -a v3.0.8 -m "3.0.8"
git push origin v3.0.8
gh release create v3.0.8 --repo EasonMWS/dsh-plugin-health --title "3.0.8 — ..." --notes-file ...

# 移动 v3 标签，让它指向这个版本。README、示例和 Action 引用的是 v3，所以每次 3.x 发版都必须
# 移动它，否则拿着 v3 的人会一直用旧版本。
git tag -f v3 v3.0.8
git push -f origin v3
```

**`v3` 标签必须跟着每次 3.x 发版移动。** 它是一根会动的指针，不是一次性的发布标签。

---

## 发 4.0 beta

在 `dsh-plugin-health-4.0\`：

```sh
npm test                              # 507 个 / 503 通过
# 改版本 → 4.0.0-beta.3，同步 README 和 CHANGELOG

git push origin 4.0-beta
# 等 ci.yml 在 4.0-beta 上变绿

# 发 npm（版本号有 "-" → dist-tag 自动是 beta，永远碰不到 latest）
gh workflow run publish-npm.yml --ref 4.0-beta

# 构建安装包（CI 里做，不在这台机器上）
gh workflow run publish-desktop.yml --ref 4.0-beta
```

安装包构建完在 run 页面下载，或者打标签让它自动挂到 Release：

```sh
git tag -a v4.0.0-beta.3 -m "4.0.0-beta.3"
git push origin v4.0.0-beta.3          # 触发 publish-desktop，自动构建并挂到 release
gh release create v4.0.0-beta.3 --prerelease ...
```

**构建安装包前**如果在本地打，要先装桌面依赖：

```sh
cd desktop
npm ci
npx electron-builder --win --publish never
```

要设两个镜像，否则会因为下载 504 失败：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

---

## 不能做的事

| 禁止 | 为什么 |
| --- | --- |
| **4.0-beta 合并进 main** | 4.0 正式发布前，main 就是 3.0.7。合并等于让所有用户突然换版本 |
| **在 4.0 上改 3.x 的 bug** | 3.x 用户要等到 4.0 才修，可能就是永远 |
| **`git push` 之前跑发布** | 发布 workflow 用的是远程的树。先发布后推送 = 发布上一版的东西 |
| **只看 `dist-tags` 就宣布发好了** | 3.0.4 就是这么发错的：npm 收下了 tarball，但内容是旧的 |
| **在 main 上跑 `publish-desktop`** | main 上没有这个 workflow，也没有 `desktop/` |

---

## 4.0 正式发布时

```sh
cd dsh-plugin-health
git merge --no-ff 4.0-beta            # 保留 4.0 的全部提交历史
# 版本号改成 4.0.0（去掉 -beta.2）
# 检查 engines.dsh 还对不对
git push origin main
gh workflow run publish-npm.yml --ref main     # 这次 dist-tag 是 latest
```

发布后 main 就是 4.x 线。**如果还要维护 3.x**，从标签拉一条维护分支：

```sh
git branch 3.x v3.0.7
git push origin 3.x
```

3.x 的修复就往那条分支打，不再进 main。

---

## 每次提交前

```sh
npm test
```

两个线都要过。当前基线：

- main：**375 个测试 / 374 通过 / 0 失败**
- 4.0-beta：**507 个测试 / 503 通过 / 0 失败**

4.0 的 `test/architecture.test.js` 会拦下越界依赖（插件不许依赖管理器、管理器只能用 3 个声明过的模块）。改架构时它先红，别绕过去。

---

## 目录速查

主线和 4.0 是两个 git worktree，分别在各自的目录里：

```sh
# 主线（3.x）
cd <主线目录>

# 4.0 实验
cd <4.0 目录>

# 从任何一处列出两个工作树及其路径
git worktree list
```

具体的绝对路径由 `git worktree list` 给出，不写进文档——写死的路径在别人的机器上一定是错的。