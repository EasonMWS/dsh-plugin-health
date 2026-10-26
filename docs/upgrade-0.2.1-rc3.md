# DSH 0.2.1-rc.3 升级体检报告

> 生成时间：2026-10-24 · **复测更新：2026-10-26** · 对比宿主：`0.2.1-rc.2`（latest）→ `0.2.1-rc.3`（next，2026-10-23 07:54 UTC 发布）· 采样：线上索引按下载量 Top 120

## 结论

| 结果 | 数量 |
| --- | --- |
| 两个宿主都兼容 | 113 |
| **rc.2 兼容、rc.3 失效（这次升级会打崩）** | **5 → 1**（4 个已修复发版） |
| rc.2 坏、rc.3 反而修好 | 0 |
| 两个宿主都坏 | 2 |

**rc.3 让兼容插件数从 118 掉到 113**——这是 DSH 迭代中很典型的一次小版本破坏。

## 会被 rc.3 打崩的插件（2026-10-26 复测：5 → 1）

| 插件 | 报告版本 | 卡在哪 | 现状 |
| --- | --- | --- | --- |
| `@nanmicoder/dsh-agent-teams` | 0.1.26 | 21 个 peer 精确枚举到 `0.2.1-rc.2` | ✅ **0.1.27 已修复** |
| `@anionex/dsh-vision-toolkit` | 0.1.47 | 19 个 peer 卡在 `... \|\| 0.2.1-rc.2` | ✅ **0.1.48 已修复** |
| `dsh-plugin-subscriptions` | 0.9.10 | 5 个 peer 枚举到 `0.2.1-rc.2` | ✅ **0.9.11 已修复** |
| `@goodandready/dsh-clinebot` | 0.6.15 | `engines.dsh` 精确等于 `0.2.1-rc.2` | ✅ **0.6.16 已修复** |
| `dsh-workbuddy-connect` | 0.7.9 | 6 个 peer 精确等于 `0.2.1-rc.2` | ⚠️ 仍为 0.7.9（仓库不可访问，无法提 issue） |

**5 个里已有 4 个修复发版，只剩 1 个**——而剩下的这个恰恰是唯一一个连 issue 都提不了的（仓库不可访问）。

共同点：**都是把版本写成了精确枚举，没有留范围**。`0.2.1-rc.3` 不在枚举里，加载时就会被判不兼容。

### 复测命令与结果

```sh
npx -y dsh-plugin-health@latest matrix \
  --plugins '@nanmicoder/dsh-agent-teams,@anionex/dsh-vision-toolkit,dsh-workbuddy-connect,dsh-plugin-subscriptions,@goodandready/dsh-clinebot' \
  --versions 0.2.1-rc.2,0.2.1-rc.3
```

```
dsh 0.2.1-rc.2: 5/5 compatible, 0 incompatible, 0 errors
dsh 0.2.1-rc.3: 4/5 compatible, 1 incompatible, 0 errors
  ✗ dsh-workbuddy-connect@0.7.9: 0.2.1-rc.3 (@deepseek-ai/dsh-llm, @deepseek-ai/dsh-settings, ...)
```

### 四个上游修复的时间线

| 插件 | 修复版本 | 维护者回复要点 |
| --- | --- | --- |
| `dsh-plugin-subscriptions` | 0.9.11 | PR #168，633/633 测试通过，版本门禁覆盖 rc.2/rc.3 |
| `@anionex/dsh-vision-toolkit` | 0.1.48 | 仅加精确 rc.3、保留旧版本、不放行未测试的未来预发布；九项 CI 全绿含 rc.3 Profile lane |
| `@nanmicoder/dsh-agent-teams` | 0.1.27 | 第三方独立复现后提交 PR #292，全矩阵 11/11 运行时场景通过 |
| `@goodandready/dsh-clinebot` | 0.6.16 | 改用 `>=0.2.1-rc.2 <0.2.2-0` **范围**（唯一采纳范围方案的）；202 测试通过，并引用了本工具的矩阵结果作为验证 |

> **关于修复方式的说明**：三家（subscriptions / vision-toolkit / agent-teams）选择「枚举加上 `0.2.1-rc.3`」，
> `clinebot` 选择范围。其中 `dsh-agent-teams` 的贡献者指出：该仓库的 `scripts/compatibility.mjs`
> 要求每个 host peer 范围必须**枚举** `compatibility.json` 声明的目标版本，写范围会挂 CI 检查。
> **两种做法都成立，取决于仓库自身的检查**——此处仅陈述结果，不作评判。

## 两个版本都失效（老问题）

| 插件 | 版本 | 原因 |
| --- | --- | --- |
| `dsh-find-plugin` | 0.4.0 | `@deepseek-ai/dsh-tools` peer 只覆盖 `^0.1.x` |
| `@feng0531/dsh-vcs` | 0.4.10 | `@deepseek-ai/dsh` 精确锁 `0.1.7-rc.2 || 0.2.0-rc.2` |

## 自查命令

```sh
# 查你装的插件在 rc.3 上还能不能用
npx -y dsh-plugin-health@latest matrix \
  --plugins your-plugins.txt \
  --versions 0.2.1-rc.2,0.2.1-rc.3
```

或者装成 DSH 插件，直接在 **设置 → 插件健康** 里看，冲突时侧栏还会出现提示。

## 给插件作者的建议

精确枚举能保证"我只测过这些版本"，但代价是每个新 nightly 都要跟一次。更稳的写法是用范围：

```jsonc
// 不推荐：每个新版本都要手动加
"@deepseek-ai/dsh-llm": "0.2.1-alpha.5 || 0.2.1-rc.1 || 0.2.1-rc.2"

// 推荐：覆盖整个 0.2.1 线
"@deepseek-ai/dsh-llm": ">=0.2.1-rc.2 <0.2.2-0"
```

DSH 判定时 `includePrerelease: true`，所以 `>=0.2.1-rc.2 <0.2.2-0` 会正确接受 `0.2.1-rc.3`。

### 一个重要的例外：仓库自带版本枚举检查时，必须枚举

上面这条建议**不总是适用**。`dsh-agent-teams` 的贡献者在复现报告中指出：该仓库的
`scripts/compatibility.mjs` 要求每个 host peer 范围必须**逐条枚举** `compatibility.json`
里声明的目标版本，写范围会直接判失败——这个检查在 `pnpm verify` 和 CI 里都会跑。

对这类复用自家发布检查的仓库，**枚举并显式加上新版本才是可行解**，范围反而过不了门禁。

因此正确的建议是：

1. **先看仓库有没有版本枚举检查**（`scripts/compatibility.mjs` 之类）。有 → 枚举，跟着加新版本。
2. **没有这类检查** → 优先用范围，一次写好可以撑过整条 minor 线。
3. 无论哪种，**都要为新宿主版本补一条 CI 实跑通道**（a required Profile lane），
   因为静态声明永远无法证明运行时真的能起来。

三家维护者的实际选择都是「枚举 + 补 CI lane」，这是合理的技术判断——声明范围只应覆盖真正验证过的版本。

## 边界

本检查只看**声明的兼容范围**，不跑插件代码。它抓不住"范围写得很宽但调用了已删除 API"这类运行时破坏，但"精确锁版本"是最常见、也最容易提前发现的一类。

> 运行时破坏的例子已经出现过：`dsh-agent-teams` 的贡献者在 PR #292 描述中提到，
> 兼容的 manifest 仍可能让 bundle 等待一个宿主已不再提供的服务，
> `runProfile` 会在 pending-entry 警告后返回。静态矩阵抓不住这类问题——需要真实 boot 验收。
