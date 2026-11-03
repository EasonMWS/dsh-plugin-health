# dsh-plugin-health

[![CI](https://github.com/EasonMWS/dsh-plugin-health/actions/workflows/ci.yml/badge.svg)](https://github.com/EasonMWS/dsh-plugin-health/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-plugin-health.svg)](https://www.npmjs.com/package/dsh-plugin-health)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](https://github.com/EasonMWS/dsh-plugin-health/blob/main/README.md) · [中文](https://github.com/EasonMWS/dsh-plugin-health/blob/main/docs/README.zh.md)

**DSH 更新完，插件突然不加载了？这个工具告诉你哪个坏了、哪个能救、哪个救不了——然后帮你修。**

大部分被判「不兼容」的插件其实没坏，只是作者把版本号写死了，还没跟上新版 DSH。
这个工具会把每个插件装进一次性环境真跑一遍，确认能启动才动手：修、交给你自己的 AI、
或者关掉它让 DSH 继续能用。

> 状态：`2.1.2`。兼容判定完全对齐官方 DSH `0.2.1-rc.2` 的规则，索引由官方发布的
> `@deepseek-ai/dsh-plugin-market-index` 校验器验证。

```sh
npm install -g dsh-plugin-health
```

**不用碰命令行也能用**：装好后重启 DSH，点左下角 **设置 → 插件健康**，
界面上点按钮就行。下面的命令只是给习惯终端的人参考。

---

## 目录

| 你是… | 看这里 |
| --- | --- |
| DSH 用户，插件坏了 | [修复一个坏插件](#修复一个坏插件) |
| DSH 完全起不来 | [DSH 起不来的时候](#dsh-起不来的时候) |
| 插件作者 | [在 CI 里检查兼容性](#插件作者在每个-pr-上自动检查兼容性) |
| 要做插件市场 | [把插件索引当数据源](#把插件索引当数据源用) |
| 想确认这工具安不安全 | [安全](#安全) |

---

## 修复一个坏插件

插件被拒时，侧栏会直接冒一个提示，不用自己去找：

![侧栏提示：插件有 2 个问题，带查看按钮](https://raw.githubusercontent.com/EasonMWS/dsh-plugin-health/main/docs/images/sidebar-alert.zh.png)

打开 **设置 → 插件健康**。每个问题一行，每个插件一个按钮：

- **检查能不能救** —— 在一次性环境里装一遍、启动一遍（30~60 秒）。你的配置一点不动。
- **能启动** → *临时放行*。往宿主自己的 `compatibility.json` 写一条记录，一键可撤销。
- **起不来** → 不提供放行按钮。给两个选择：关掉这个插件，或者拿一份提示词交给你的 AI。

每一步都可撤销，不删任何文件。

![设置页里的不兼容插件和检查按钮](https://raw.githubusercontent.com/EasonMWS/dsh-plugin-health/main/docs/images/settings-finding.zh.png)

预演通过后才会写入放行，旁边就是撤销按钮：

![临时放行生效后，一键就能撤销](https://raw.githubusercontent.com/EasonMWS/dsh-plugin-health/main/docs/images/settings-exemption.zh.png)

**一次看全部插件。** 如果你更习惯终端：

```
$ dsh-plugin-health doctor --profile desktop
扫描 19 个插件…
✓ 14 个正常
⚠ 3 个声明的版本范围过时（可以救）
✗ 2 个真的不兼容
```

## 临时放行到底是什么意思

**门禁放行，不等于官方支持。** 我们只证明它在隔离环境里能启动；
插件的具体功能是否正常，仍然要你自己观察。

- 写的是 DSH 官方的 `allow-version` 豁免，不是改插件、不是改 npm 上的包
- 只对你当前这个 DSH 版本生效，升级后需要重新判断
- 「临时放行记录」里随时可以撤销，精确恢复到放行前的状态
- 作者发布正式支持版本后，这里会提示你可以撤销并升级

## 特色：四个层次，不是一层

静态检查只是第一层——而且**单独用它会经常判断错误，错到危险的程度**。完整路径是这样的：

| # | 层次 | 做什么 | 在哪跑 |
| --- | --- | --- | --- |
| **1** | **检测** | 扫每个已安装插件（bundles、`dependencies`、`cordis.patch.yml` 的 insert 含嵌套、`node_modules`），把声明和你实际运行的版本对比 | 你的机器 |
| **2** | **验证** | 在**一次性 DSH home** 里试：先放行门禁，再真装上、真启动，检查每个 entry 是否激活 | 隔离、用完即弃 |
| **3** | **修复** | 预演能启动，才往**你的** profile 写一条官方 `allow-version` 豁免——有记录，一键撤销 | 你的 profile |
| **4** | **兜底** | 预演起不来，就什么都不改，给两个真实选择：关掉它，或拿一份准备好的提示词交给你自己的 AI。上报前先查上游有没有人报过 | 你决定 |

**第 2 层是这个工具存在的理由。** 没有它，第 3 层就是在赌。

## 插件作者：在每个 PR 上自动检查兼容性

**你不用装任何东西。** DSH 每一两周发一个预发布版，写死的 `engines.dsh` 就会定时把你的插件搞挂。
这个 Action 会在 PR 里告诉你会不会挂——在用户发现之前。

加一个文件 `.github/workflows/dsh-compat.yml`：

```yaml
name: dsh compatibility
on: [pull_request]
permissions:
  contents: read
  pull-requests: write      # 评论 PR 需要这个权限
jobs:
  matrix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: EasonMWS/dsh-plugin-health@v1.2.0
        with:
          plugins: .
          versions: latest,next
```

它会在 PR 下评论一张兼容性表，并输出 `matrix.json`、`matrix.md` 和 SVG 徽章。

**挂了就让构建失败。** 加 `failOn: any`，不兼容时 job 直接红。更稳的做法是只盯你要支持的版本：

```yaml
        with:
          plugins: .
          versions: latest,next,alpha
          failOn: next          # 只在 next 通道上失败
```

**把结果贴进 README。** 运行会生成可直接提交的徽章：

```markdown
![dsh compatibility](dsh-health-matrix/dsh-compat.svg)
```

这是回答「这东西在当前 DSH 上还能用吗」最省事的方式——对你、对随便点进你仓库的人都一样。

完整参数见 [`action.yml`](action.yml) · 例子见 [`examples/dsh-compat.yml`](examples/dsh-compat.yml)。

## 为什么中间这层重要

大部分被拒的插件代码是好的——作者把版本号写死了，没跟上新宿主。`0.2.1-rc.4` 实测：

| 插件 | 声明状态 | 隔离环境里真跑 |
| --- | --- | --- |
| `@nanmicoder/dsh-agent-teams@0.1.27` | ❌ 被拒 | ✅ **完整启动，94 个 entry 全部激活** |
| `dsh-find-plugin@0.4.0` | ❌ 被拒 | ✅ **真的能跑** |
| `@feng0531/dsh-vcs@0.4.10` | ❌ 被拒 | ❌ **失败：在等宿主已不再提供的服务** |

前两个是**假警报**——只做静态检查的工具会把它们报成坏插件。**第三个正是预演必须存在的理由**：
放行它，恰好制造出门禁想避免的结果——一个能加载、但会出问题的插件，而且再没有任何警告留着。


**这意味着一件事：只做静态检查的工具，会把这些还能用的插件误判成坏插件。**

## 所以我们做的是“先验证，再动手”

```
扫描发现插件被拒
  ↓
在一次性临时环境里「假装放行 + 真的启动一次」   ← 不碰你的 profile
  ├─ 起来了 → 代码没问题，只是声明过时
  │    → 在你的 profile 里放行（可一键撤销）
  │    → 记录状态，盯上游有没有发新版
  └─ 起不来 → 真的不兼容，放行也没用
       → 什么都不改，明确告诉你
       → 需要的话，帮你准备好给 AI 的完整上下文
```

**顺序很重要**：先放行再验证，会让你带着一个「门禁不拦但会崩」的插件；我们是先在隔离环境里证明能用，才动你的配置。

## 在设置页里长这样

安装后在 **设置 → 插件健康** 里：

- 每个不兼容插件下方有「**检查能不能救**」按钮
- 点了会在临时环境试装试启动（30~60 秒），不修改任何东西
- 如果能用，出现「**临时放行**」按钮；不能用则明确告诉你救不了
- 放行过的插件会记录在案，等上游发版后提示你「可以恢复原样了」

全部操作都可撤销：放行只写一个官方支持的豁免项，撤销会精确恢复到放行前的状态。

## 在线查兼容性

装之前先看一眼：

**<https://easonmws.github.io/dsh-plugin-health/compat/>**

社区目录里的每个插件，对着当前几个宿主版本查一遍。顶上直接给数字，一眼看出生态现在的状况：

| | |
| --- | --- |
| **多少** | 一共查了多少、多少所有宿主都接受、多少被拒 |
| **分类** | 用目录自己的分类，可以筛 |
| **发布日期** | 当前版本的发布时间——能看出作者还在不在维护 |
| **筛选** | 按名字、按分类，或只看被拒的 |
| **语言** | 中英文切换，会记住 |

打勾表示插件的声明范围包含那个宿主版本，安装器不会拒绝它——**不代表插件能用，也不是安全审查**。
页面里写清了覆盖范围：只在 GitHub 或 tarball 上的插件没发 npm，查不了，也不计入。

同一份数据可以下载：[`matrix.json`](https://easonmws.github.io/dsh-plugin-health/compat/matrix.json)。
也可以给自己的插件集生成一份：

```sh
dsh-plugin-health matrix --plugins list.txt \
  --versions latest,next \
  --catalog https://awesome-dsh-plugin.com/plugins.json \
  --out site/compat
```

## 把插件索引当数据源用

如果你在做插件市场、目录站、启动器，这里有一份现成的 format-1 索引：

```
https://easonmws.github.io/dsh-plugin-health/index.json
```

**在 DSH 里直接就能用：** 把这个 URL 粘到 **插件 → 自定义插件市场 → 发现 → 添加索引源**。

- **format-1** —— DSH 官方市场索引格式，每次构建都用 `@deepseek-ai/dsh-plugin-market-index`
  （DSH 宿主读索引用的同一个校验器）验过
- **300 个插件**，每天 UTC 04:23 重建
- 每个插件含：名称、描述（中英）、作者、仓库、主页、分类、下载量、GitHub stars、
  健康分、最近版本历史
- 数据来源：[`awesome-dsh-plugin.com/plugins.json`](https://awesome-dsh-plugin.com/plugins.json)

自己生成一份：

```sh
dsh-plugin-health index \
  --catalog https://awesome-dsh-plugin.com/plugins.json \
  --host "$(npm view @deepseek-ai/dsh version)" \
  --index-url https://example.com/index.json \
  --limit 300 --out site
```

细节：描述是中英双语的（`en` 必需，`zh` 保留）；分类来自目录，另有标签
（`npm`、`compatible`、`incompatible`、`unchecked`、`capability risk`）和排序键
（`downloads`、`stars`、健康分）。健康分是确定性算出来的——热度（下载量取对数 55、
stars 取对数 25）再按兼容性和能力风险加减，0–100。**它不是安全评级。**
下载量和 stars 来自 npm 与 GitHub 的公开数据。

范围：只收录已发布到 npm 的目录项（2026 年 10 月快照里 5,704 个中的 2,607 个）；
只在 GitHub 或 tarball 上的会被跳过并在报告里计数。

## 安全

**还在用 1.0.3 或更早？请升级。** 1.1.0 修复了安全测试在 1.0.2 里发现的 7 个问题，
其中一个评为 high：写路由的控制密钥被无鉴权的 status 接口下发了。

见 [GHSA-vj8q-543v-9hw5](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/GHSA-vj8q-543v-9hw5) and [GHSA-52w2-cq6j-xhg7](https://github.com/EasonMWS/dsh-plugin-health/security/advisories/GHSA-52w2-cq6j-xhg7)
和 [SECURITY.md](SECURITY.md)。

**信任边界，直说：** 写路由对**任何本地进程**可达。真正的边界是 loopback 接口，不是那个密钥。

## 安全边界（请务必读一遍）


| 我们做什么 | 我们不做什么 |
| --- | --- |
| 在隔离的临时 home 里试装试启动 | ❌ 不自动调用你的 AI，不花你的 token |
| 使用 DSH 官方 `allow-version` 豁免机制 | ❌ 不修改插件源码，不改 npm 上的包 |
| 记录每一次改动，支持精确撤销 | ❌ 验证失败时绝不放行 |
| 帮你检查上游是否已有人报过 issue | ❌ 不替你提交 issue |
| 准备好完整的 AI 上下文包 | ❌ 不替你按下发送键 |

**临时放行 = 门禁放行，不等于官方支持。** 我们只保证它在隔离环境里能启动；
插件的具体功能是否完全正常，仍需你自己观察。等作者发布正式支持版本后，请撤销临时放行并升级。

## 1.0 承诺什么

大版本号是对稳定性的承诺，所以这里把**冻结的**和**还没冻结的**都说清楚，而不是让你升级时才发现。

**冻结**——1.x 内不会破坏：

| 面 | 保证 |
| --- | --- |
| CLI 命令与参数（`matrix`、`smoke`、`doctor`、`repair`、`rescue`、`handoff`、`report`、`boot`、`index`） | 现有参数含义不变。可以新增参数，但不会删除或改变含义 |
| `plugin_health` agent 工具的名字与输入 schema | 只增字段，不改已有字段 |
| 退出码（`0` 成功 / `1` 有问题或失败 / `2` 用法错误） | 不变 |
| 本工具写出的文件（`compatibility.json`、`plugin-health-rescue.json`、交接包） | 格式有文档且向前兼容：不认识的键会保留，不丢弃 |
| 状态路由结构（`/plugins/dsh-plugin-health/status`） | 只增字段，已有字段名与类型不变 |

**未冻结**——可能在 minor 版本变化，因为它们属于展示层或内部实现：

- UI 文案、布局、配色、设置面板的结构；
- 生成的 AI 提示词和 issue 草稿里的建议措辞；
- `src/` 下的内部模块划分（除 `./api` 和 `./client` 两个导出，`src/` 不是公开导入路径）；
- 已文档化之外的 finding id——新增检查会带来新 id。

**宿主升级时的版本策略。** `engines.dsh` 写的是**范围**（`>=0.1.0-rc.6 <0.3.0-0`）而不是枚举，
所以新的 DSH nightly 不会像打断那些写死版本的插件那样打断本插件。等 DSH 0.3.0 发布时，
本包需要发一版扩展这个范围——**这是唯一已知的过期点**，会提前写进 changelog。

## DSH 起不来的时候

插件坏了导致 DSH 根本启动不了时，设置页自然也打不开——那些功能都跑在 DSH 里面。
所以这三个命令**完全独立于 DSH**，只要能开终端就能用：

```sh
# 1. 先看为什么起不来（读宿主留下的日志和静态检查）
dsh-plugin-health boot diagnose --profile desktop

# 2. 实在查不出，就先把所有第三方插件停掉，让 DSH 能启动
dsh-plugin-health boot safe --profile desktop --apply

# 3. 找到元凶、修好之后，恢复原状
dsh-plugin-health boot restore --profile desktop --apply
```

`boot safe` 只往 profile 自己的补丁层追加 `disabled: true`：
**不删文件、不动插件、宿主自带条目一律不碰**。`boot restore` 只移除它自己加的条目，
你自己的配置原样保留。两者默认都是 dry-run，加 `--apply` 才真正写。

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
逐个提报后，作者们动了手——**5 个里已有 4 个发布修复**（2026-10-26 复测），受影响数 **5 → 1**：

> 已用发布的 0.1.47 manifest 和官方 rc.3 宿主兼容性评估器复核确认：**19 个 DSH peer 被拒**，
> 而 rc.2 仍然通过。已在 #179 合入 main 修复……九个 PR CI 全部通过，其中**新增了必需的 rc.3 Profile 检查**。
>
> — [Anionex/dsh-vision-toolkit#178](https://github.com/Anionex/dsh-vision-toolkit/issues/178#issuecomment-6388178989)
> （906★），因本次扫描而修复，已随 `0.1.48` 发布

| 插件 | 修复版本 | 状态 |
| --- | --- | --- |
| `@anionex/dsh-vision-toolkit` | `0.1.48` | ✅ 已发布，rc.2 + rc.3 双版本复测通过 |
| `dsh-plugin-subscriptions` | `0.9.11` | ✅ 已发布，rc.2 + rc.3 双版本复测通过 |
| `@nanmicoder/dsh-agent-teams` | `0.1.27` | ✅ 已发布，rc.2 + rc.3 双版本复测通过 |
| `@goodandready/dsh-clinebot` | `0.6.16` | ✅ 已发布，rc.2 + rc.3 双版本复测通过 |
| `dsh-workbuddy-connect` | — | ⚠️ 仍为 `0.7.9`（仓库不可访问，是唯一连 issue 都提不了的一个） |

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
- 顶部一行结论告诉你该不该担心：`可以放心用` 或 `有问题建议处理`；旁边三个按钮：
  `重新扫描` 随时重跑、`检查更新` 看插件本身有没有新版本、`浏览全部插件健康状况`
  直接打开[公开兼容性表](https://easonmws.github.io/dsh-plugin-health/compat/)；
- **打开 DSH 时会自己查一次新版本**，查到了才提示（附上完整的升级命令），没查到就什么都不说——
  不会每次开面板都弹一句"已是最新"；
- **一切正常时什么都不显示**：没有徽章、没有横幅、没有侧栏条目；
- **真的有问题时**，账号菜单上方会出现一个 `插件有 N 个问题` 的小入口，点一下直接跳到设置分区；
- host 半身只提供 loopback 只读快照，不会修改你的 profile。

> **准备升级 DSH？先跑一遍体检。**
>
> `0.2.1-rc.3`（2026-10-23）让 Top 120 里的兼容数从 118 掉到 **113**：
> **5 个在 rc.2 上正常的插件，到 rc.3 就加载不了**，原因都是把 `@deepseek-ai/*` 版本写成了精确枚举。
> 截至 2026-10-26，其中 **4 个已修复发版**（受影响数 5 → 1）。
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

## 2. Windows/WSL 诊断与修复

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
