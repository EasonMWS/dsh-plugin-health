# dsh-plugin-health

[![CI](https://github.com/EasonMWS/dsh-plugin-health/actions/workflows/ci.yml/badge.svg)](https://github.com/EasonMWS/dsh-plugin-health/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-plugin-health.svg)](https://www.npmjs.com/package/dsh-plugin-health)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek Harness（dsh）的**插件管理器 / 插件体检 / 插件冲突检测**工具，带 **DSH 内的原生设置页**。
同时提供**官方 format-1 市场索引生成器**与 **Windows/WSL 安装诊断**能力。

> 状态：`0.4.3`。兼容判定完全对齐官方 DSH `0.2.1-rc.2` 的规则，索引由官方发布的
> `@deepseek-ai/dsh-plugin-market-index` 校验器验证。

**线上官方 format-1 索引：** <https://easonmws.github.io/dsh-plugin-health/index.json>
（300 个插件，每晚自动重建） · **npm：** `npm install -g dsh-plugin-health` ·
**仓库：** <https://github.com/EasonMWS/dsh-plugin-health>

已收录：[awesome-dsh-plugin](https://awesome-dsh-plugin.com/zh/p/EasonMWS/dsh-plugin-health/) 与
[DSH Plugin Store](https://www.dshplugin.store/plugin/EasonMWS/dsh-plugin-health)。

## 你在找“插件管理器 / 插件检查 / 插件冲突检测”吗？

如果你在搜下面任何一个，那你要的就是这个：

| 你在找… | 这个包能做到 |
| --- | --- |
| DSH 的**插件管理器** | 一页看全所有已安装插件及状态 |
| **插件检查 / 体检 / 扫描**工具 | 扫描全部已安装插件，不是抽样 |
| **插件诊断 / doctor** | 说清哪里坏了、该怎么处理 |
| **插件冲突**检测 | 指出哪些插件在当前 DSH 版本上加载不了 |
| 想**修复坏掉的插件** | 一键修复（只隔离不删除，随时可找回） |
| **DSH 更新后插件突然不能用了** | 对比插件声明与新宿主要求 |
| plugin manager / plugin doctor / plugin checker / plugin conflict | 英文界面同样支持 |

**不适合你**：如果你想“逛市场、发现并安装新插件”——那是插件市场的活，这个包管的是你已经装了什么。
（不过官方 format-1 索引正是由它生成的，市场可以消费。）

## 为什么需要它：DSH 管住了安装，但没管升级

DSH 会拒绝**新安装**一个声明范围不匹配当前版本的插件，这块做得很扎实：

```
$ dsh plugin --profile test add dsh-session-recall
dsh: installation rejected: Plugin dsh-session-recall@0.7.9 is incompatible with dsh 0.2.1-rc.3
dsh: nothing was installed.
```

但它**不会**在宿主升级后重新检查已经装好的插件。一个声明 `engines.dsh: 0.2.1-rc.2` 的插件
依旧留在 `bundles` 里、依旧在 `0.2.1-rc.3` 上加载，UI 里没有任何提示。这就是本工具要补的缺口：
读出每个已安装插件自己声明的范围，和你实际在跑的版本做对比。

## 它已经抓到过真实问题

在一次宿主小版本升级中扫描 Top 120 插件，发现 **5 个在 `0.2.1-rc.2` 上正常、到 `0.2.1-rc.3` 就被拒**。
逐个提报后，作者们动了手：

> 已用发布的 0.1.47 manifest 和官方 rc.3 宿主兼容性评估器复核确认：**19 个 DSH peer 被拒**，
> 而 rc.2 仍然通过。已在 #179 合入 main 修复……九个 PR CI 全部通过，其中**新增了必需的 rc.3 Profile 检查**。
>
> — [Anionex/dsh-vision-toolkit#178](https://github.com/Anionex/dsh-vision-toolkit/issues/178#issuecomment-6388178989)
> （906★），因本次扫描而修复

完整报告：[docs/upgrade-0.2.1-rc3.md](docs/upgrade-0.2.1-rc3.md)。

## 有 UI，但只在你需要时出现

把它作为 bundle 装进 profile，DSH 设置里会多出一个原生分区 **设置 → 插件健康**：

```sh
dsh plugin --profile web add dsh-plugin-health
```

- **它检查的是你机器上真实安装的每一个插件**，不是抽样，也不只看 bundle 列表：
  bundle、`package.json` 依赖、`cordis.patch.yml` 的 insert（含嵌套）、`node_modules` 里所有插件形态的包。
  页面顶部会直接告诉你这次检查了多少个。
- 每条问题都用大白话解释，并给出「怎么做」，第一次用的人不用读文档也能处理；
- 顶部一行结论告诉你该不该担心：`可以放心用` 或 `有问题建议处理`；旁边有 `重新扫描` 按钮随时重跑；
- **一切正常时什么都不显示**：没有徽章、没有横幅、没有侧栏条目；
- **真的有问题时**，账号菜单上方会出现一个 `插件有 N 个问题` 的小入口，点一下直接跳到设置分区；
- host 半身只提供 loopback 只读快照，不会修改你的 profile。

| 问题列表 + 结论行 + 一键修复 | 执行前先给你看修复计划 |
| --- | --- |
| ![设置页里的问题与修复按钮](docs/images/settings-finding.png) | ![执行前展示的修复计划](docs/images/settings-repair-plan.png) |

> **准备升级 DSH？先跑一遍体检。**
>
> `0.2.1-rc.3`（2026-10-23）让 Top 120 里的兼容数从 118 掉到 **113**：
> **5 个在 rc.2 上正常的插件，到 rc.3 就加载不了**，原因都是把 `@deepseek-ai/*` 版本写成了精确枚举。
> 更早的 rc.2 也曾打崩另外 3 个。最新报告：
> [docs/upgrade-0.2.1-rc3.md](docs/upgrade-0.2.1-rc3.md) ·
> [docs/upgrade-0.2.1.md](docs/upgrade-0.2.1.md)。
>
> ```sh
> dsh-plugin-health matrix --plugins plugins.txt --versions 0.2.1-rc.2,0.2.1-rc.3
> ```

## 为什么做

DSH 没有官方插件市场索引；发行节奏约 **2.1 天一个版本**且带破坏性变更；官方插件管理器没有
版本选择/升级动作；Windows/WSL 安装失败会留下残缺目录和残留锁文件。现有 doctor/市场工具
只验证“本机当前安装的那一个 DSH 版本”，也不处理 Windows 文件锁和跨 profile 问题。

这个工具补三个缺口：

1. **多宿主兼容矩阵**：插件能不能在 `0.1.7-rc.2` / `0.2.0-rc.2` / `0.2.1-alpha.4` /
   `0.2.1-rc.2` 上加载？使用官方语义精确判定（`engines.dsh` 优先，否则检查
   `@deepseek-ai/dsh*` peers；预发布参与 range；`workspace:` 映射到宿主版本）。
2. **官方 format-1 市场索引**：把社区目录变成内置 **Discover** 能直接吃的 JSON 索引，并用
   DSH Host 同款解析器验证。
3. **Windows/WSL 安装诊断**：默认只读；修复动作只隔离不删除，改 patch 保留用户注释。

## 安装

```sh
npm install -g dsh-plugin-health
# 或首发前本地运行：
git clone https://github.com/EasonMWS/dsh-plugin-health.git && cd dsh-plugin-health && npm ci
node bin/dsh-plugin-health.js --help
```

需要 Node.js 20+。

### 作为 DSH bundle 安装（可选）

这个包同时是一个可安装的 DSH bundle。装进 profile 后会提供一个只读的 `plugin_health` agent
工具，报告：声明但未安装的第三方 bundle、残缺的包目录、`cordis.patch.yml` 残留、代理/registry
配置、profile 差异，以及已装插件与当前 DSH 版本的不兼容。

```sh
dsh plugin --profile web add dsh-plugin-health
```

bundle 声明了 `engines.dsh`，不带 UI，自身不改变任何东西。

## 1. 兼容矩阵

```sh
dsh-plugin-health matrix \
  --plugins examples/plugins.txt \
  --versions latest,next,alpha,0.1.7-rc.2 \
  --out dsh-health-out/matrix \
  --fail-on any
```

- `--plugins`：文件（一行一个，支持 `#` 注释）、逗号列表，或重复参数；每项是 `name`、
  `name@version`，或本地插件目录。
- `--versions`：精确 SemVer，或 `@deepseek-ai/dsh` 的 npm dist-tag（`latest`/`next`/`alpha`）。
- 输出：`matrix.json`、`matrix.md`、静态 SVG 徽章（`badges/`）。
- `--fail-on any|none|<host>`：直接用作 CI 门禁。

判定规则与官方 `packages/boot/app-boot/src/plugin-compatibility.ts` 一致：

| 插件声明 | 检查 |
|---|---|
| `engines.dsh` | 只看这个 range，忽略 peers |
| 无 `engines.dsh`、有 peers | 所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer range |
| peer 为 `workspace:^` / `~` / `*` | 视为当前宿主版本 |
| 宿主为预发布 | 参与 range 比较（`includePrerelease: true`） |

矩阵是**静态判定**（manifest + 官方兼容规则）。声明兼容不代表插件已激活、工具能执行；
可以用下面独立、显式执行的 `smoke` 命令补充运行时验收。Git 插件仍可从本地目录做静态检查。

### 在全新 profile 中做运行时验收

先把目标宿主版本安装到独立目录，再验收用户实际安装的包，包括发布用的 tarball：

```sh
npm install --prefix /tmp/dsh-rc3 @deepseek-ai/dsh@0.2.1-rc.3
dsh-plugin-health smoke \
  --dsh-dir /tmp/dsh-rc3/node_modules/@deepseek-ai/dsh \
  --plugin ./my-plugin-1.0.0.tgz \
  --tool my_plugin_tool \
  --calls ./smoke-calls.json \
  --out dsh-health-out/runtime
```

`smoke-calls.json` 是工具调用数组。调用必须成功；提供 `expectedValue` 时还会精确比较完整的
结构化返回值：

```json
[{"name":"my_plugin_tool","arguments":{"input":"example"},"expectedValue":{"answer":42}}]
```

命令使用全新的 `DSH_HOME`，通过官方 `dsh plugin` CLI 安装，经宿主公开的
`@deepseek-ai/dsh/profile-boot` 启动，然后检查工具注册、执行调用、释放 profile。
至少提供一个 `--tool` 或 `--calls` 断言。只有 `--tool` 时仅检查注册，不代表功能或浏览器 UI
已经验收。每个宿主版本分别运行一次。

安装默认最多 120 秒，启动、调用与退出合计最多 30 秒，可用 `--install-timeout`、`--timeout`
调整（毫秒）。超时会停止整个子进程树，包括一直不结束初始化的插件。报告保留失败阶段
（`install`、`boot`、`assertions`、`shutdown`）与宿主错误，即使超时后的信号处理以 0 退出，
这次验收仍然失败。
POSIX 下，父进程以 0 退出却留下后台子进程时，同样判定失败并停止其进程组。Windows 超时
使用 `taskkill /T`；目前不能在父进程已经退出后检测其遗留子进程。

每次运行都保留独立目录中的 home、`smoke.json`、`runtime.json` 与有长度上限的输出日志，
不会修改现有 profile，也不自动清理。分享前请检查日志。目标宿主需要自己的 Node.js、pnpm
运行要求，并需导出 `profile-boot`（已在 `0.2.1-rc.2`、`0.2.1-rc.3` 验证）。

**此命令会以当前系统账号权限执行插件代码。** 临时 DSH home 只隔离正常 profile，不是安全
沙箱；只测试可信代码，不可信代码请放在容器或虚拟机中。运行时冒烟也不保证所有功能或 UI
都兼容。

### 实跑示例（2026-10-17，7 个插件 × 4 个宿主版本）

```
dsh 0.1.7-rc.2: 6/7 compatible, 1 incompatible
dsh 0.2.0-rc.2: 5/7 compatible, 2 incompatible
dsh 0.2.1-alpha.4: 5/7 compatible, 2 incompatible
dsh 0.2.1-rc.2: 5/7 compatible, 2 incompatible
✗ dsh-win32@0.17.14：四个宿主全不兼容（@deepseek-ai/dsh-subprocess-local 的 peer 上界过窄）
✗ dsh-find-plugin@0.4.0：从 0.2.0-rc.2 起不兼容（@deepseek-ai/dsh-tools peer）
```

第一条正好复现了 dsh-win32 issue #89（peer 上界过窄导致新宿主线被拒绝）的真实问题，而且
不需要安装任何东西。

### GitHub Action：每个 PR 自动贴兼容矩阵

仓库内置可复用 workflow。把 [`examples/dsh-compat.yml`](examples/dsh-compat.yml) 放进插件仓库的
`.github/workflows/dsh-compat.yml`，之后每个 PR 都会收到一条兼容矩阵评论 + job summary，并且
矩阵产物会自动上传为 artifact：

```yaml
name: dsh plugin compatibility
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  matrix:
    uses: EasonMWS/dsh-plugin-health/.github/workflows/matrix-review.yml@v0.1.5
    with:
      plugins: '.'
      versions: 'latest,next,alpha'
      comment: true
```

## 2. format-1 市场索引

```sh
dsh-plugin-health index \
  --catalog https://awesome-dsh-plugin.com/plugins.json \
  --host 0.2.1-rc.2 \
  --index-url https://easonmws.github.io/dsh-plugin-health/index.json \
  --matrix dsh-health-out/matrix/matrix.json \
  --limit 300 --out site
```

命令生成 `site/index.json`（`format: 1`）和 `site/build-report.md`，然后调用
`@deepseek-ai/dsh-plugin-market-index`（DSH Host 实际使用的解析器）做严格校验。把目录部署到
任意静态主机（GitHub Pages 即可，不能有重定向），再把 `index.json` 的 URL 填进
**插件 → 自定义插件市场 → 发现 → 添加索引源**。

索引特性：

- 市场与每个插件的标题/描述都带本地化（必须有 `en`，同时保留 `zh`）；
- 分类来自社区目录，另有标签（`npm`、`compatible`、`incompatible`、`unchecked`、
  `capability risk`）和排序键（下载量、Star、健康分）；
- 健康分是确定性公式：热度（log 下载 55 分 + log Star 25 分）加减兼容性与能力风险，0–100；
- 每个插件默认列 3 个版本（`--max-versions`）：dist-tag latest 优先，然后最高版本，带 npm
  发布时间与 `engines.dsh`。

当前范围：只收社区目录里有 npm 包的条目（2026-10 快照里 2,607 / 5,704）；GitHub/tarball-only
条目会跳过并在报告里计数，git 源（commit 固定）在路线图里。

## 3. Windows/WSL 诊断与修复

```sh
dsh-plugin-health doctor --home C:\Users\me\.dsh --profile desktop --runtime 0.2.1-rc.2
dsh-plugin-health repair --home C:\Users\me\.dsh --profile desktop --apply --yes
```

检查项：profile 声明但未安装的第三方 bundle（DSH 安装自带的 `@deepseek-ai/*` 视为已提供）、
不可读/残缺的包目录、缺失的 profile 依赖、损坏或空的 `cordis.patch.yml` 条目、
`.bak-*` / `.lock` / `.lock.takeover-*` 残留、过大的插件管理器日志、配了代理但没设
`NODE_USE_ENV_PROXY=1`、WSL 与 Windows 长路径、按 `--runtime` 检查已装插件是否兼容、以及
desktop/web 等 profile 之间的插件集差异。

修复必须显式 `--apply`，默认 dry-run，且**只隔离不删除**：

- 文件和目录移到 `<home>/.plugin-health/quarantine/<时间戳>/`，`repair-log.json` 记录每一步；
- `cordis.patch.yml` 只做文本级删除（顶层 `- []` 条目），先备份，保留用户注释与格式。

## 路线图

- 浏览器插件的运行时验收（当前 `smoke` 探测 agent 工具）；
- 支持 GitHub/tarball 目录条目的 commit-pinned git 源；
- 全目录矩阵 + 每晚构建并发布索引；
- DSH 内的插件面板（渲染矩阵与诊断结果）；
- 可复用的 GitHub Action 与公开兼容性看板。

## 开发

```sh
npm ci
npm test
```

另外可针对已安装的宿主执行真实 tarball 验收（需要 pnpm）：

```sh
npm run test:runtime -- /tmp/dsh-rc3/node_modules/@deepseek-ai/dsh
```

会打包并安装正常、等待缺失服务、初始化抛错、初始化挂起四类受控插件，保留 profile 与报告。

23 个单元测试覆盖官方兼容语义、format-1 构建（用官方解析器验证）以及基于 fixture home 的
诊断/修复流程，不依赖网络。

## 免责声明

DSH 插件以用户完整权限运行。健康分、兼容标签、目录收录都**不是**安全审计。第三方索引未签名，
只添加你信任的来源。

## License

MIT
