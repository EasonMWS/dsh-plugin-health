# DSH 0.2.1 升级体检报告

> 生成时间：2026-10-18 · 数据源：[dsh-plugin-health 线上 format-1 索引](https://easonmws.github.io/dsh-plugin-health/index.json)（250 个插件）· 采样：按下载量 Top 120 · 对比宿主：`0.2.0-rc.2`（latest）→ `0.2.1-rc.2`（next）

## 结论

| 结果 | 数量 |
| --- | --- |
| 两个宿主都兼容 | 105 |
| **旧的兼容、新的不兼容（升级后会失效）** | **3** |
| 旧的坏、新的反而修好 | 11 |
| 两个宿主都坏 | 1 |

> **更新（2026-10-19）**：`dsh-plugin-subscriptions` 已在 `main` 修复（[PR #155](https://github.com/V1ki/dsh-plugin-subscriptions/pull/155)，merge commit `1d24db8`），5 个 DSH peer 范围现在显式包含 `0.2.1-rc.2`；当时修复尚未发布到 npm。
>
> **更新（2026-10-20 复测）**：`dsh-plugin-subscriptions@0.9.10` 已发布，矩阵复测 `0.2.1-rc.2` ✅；`dsh-codex-connect` 的修复在 `alpha` 通道 `0.2.0-alpha.9`（`latest` 仍是 `0.2.0-alpha.1`，默认安装仍会命中旧声明）；`@feng0531/dsh-vcs@0.4.10` 仍未修复。
>
> **当前受影响数量**：按 npm `latest` 默认安装 = **2**（`dsh-codex-connect` latest、`@feng0531/dsh-vcs`）；如果允许使用 alpha 通道 = **1**（只剩 `@feng0531/dsh-vcs`）。扫描时的 3 个里，2 个已有修复版本。

### 扫描时（2026-10-18）会失效的 3 个插件

| 插件 | 版本 | `0.2.0-rc.2` | `0.2.1-rc.2` | 原因 |
| --- | --- | --- | --- | --- |
| `dsh-codex-connect` | 0.2.0-alpha.1 | ✅ | ❌ | 20 个 `@deepseek-ai/*` peer 精确锁到 `0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2`，不含 `0.2.1-rc.2` |
| `dsh-plugin-subscriptions` | 0.9.9 | ✅ | ❌ | `@deepseek-ai/dsh-llm` 等 peer 里精确写了 `0.2.0-rc.2` |
| `@feng0531/dsh-vcs` | 0.4.10 | ✅ | ❌ | `@deepseek-ai/dsh: 0.1.7-rc.2 || 0.2.0-rc.2`（精确枚举，没有范围） |

### 当前状态（2026-10-20 复测）

| 插件 | 最新可用版本 | `0.2.1-rc.2` | 说明 |
| --- | --- | --- | --- |
| `dsh-plugin-subscriptions` | 0.9.10 | ✅ | 已修复并发布；`0.9.9` 仍会命中旧声明 |
| `dsh-codex-connect` | 0.2.0-alpha.1（latest） / 0.2.0-alpha.9（alpha） | latest ❌ / alpha ✅ | 修复只在 alpha 通道，latest 尚未推进 |
| `@feng0531/dsh-vcs` | 0.4.10 | ❌ | 仍把 `@deepseek-ai/dsh` 精确锁在 `0.1.7-rc.2 || 0.2.0-rc.2` |

### 两个版本都失效

| 插件 | 版本 | 原因 |
| --- | --- | --- |
| `dsh-find-plugin` | 0.4.0 | `@deepseek-ai/dsh-tools` peer 只覆盖 `^0.1.x` 系列，没进入 0.2 线 |

## 为什么会这样

DSH 0.2.x 大约每两天发布一个预览版本，而它的插件兼容性由**插件自己声明的版本范围**决定：

1. 先看 `engines.dsh`；
2. 没有则逐个检查所有 `@deepseek-ai/dsh*` peer 依赖；
3. 判定使用 `semver.satisfies(..., { includePrerelease: true })`；
4. `workspace:^|~|*` 会映射到运行时版本。

所以插件只要把 peer 写成**精确版本枚举**（例如 `0.2.0-rc.2`），下一个宿主版本发布时就会命中“不兼容”，即使代码本身一行没改。这类问题在 DSH 升级后表现为“插件装了但用不了”。

> 边界：本工具检查的是**声明的兼容范围**，不是运行时 API 行为。范围写得很宽但实际调用了被删除 API 的插件仍可能坏；但“peer 上界过窄/精确锁定”是社区里最常见、也最难自查的一类。

## 升级前自检

```sh
# 把当前装了的插件名写进 plugins.txt（每行一个）
dsh-plugin-health matrix \
  --plugins plugins.txt \
  --versions 0.2.0-rc.2,0.2.1-rc.2 \
  --out dsh-health-out/upgrade

# 看报告
cat dsh-health-out/upgrade/matrix.md
```

输出会对每个插件逐宿主标记 ✅/❌，并在 Notes 里指出是 `engines.dsh` 还是哪个 `@deepseek-ai/*` peer 卡住了。

## 在 PR 里自动跑

把 [`examples/dsh-compat.yml`](../examples/dsh-compat.yml) 放进插件仓库的 `.github/workflows/dsh-compat.yml`，每个 PR 会自动收到一条兼容矩阵评论，并上传矩阵产物：

```yaml
name: dsh plugin compatibility
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  matrix:
    uses: EasonMWS/dsh-plugin-health/.github/workflows/matrix-review.yml@v0.1.6
```

---

## English summary

A scan of the top 120 DSH plugins (by npm downloads, from the published format-1 index) shows:

- 105 compatible with both `0.2.0-rc.2` and `0.2.1-rc.2`;
- **3 plugins that work on `0.2.0-rc.2` but would fail on `0.2.1-rc.2`** at scan time, because they pin exact `@deepseek-ai/*` peer versions (`dsh-codex-connect`, `dsh-plugin-subscriptions`, `@feng0531/dsh-vcs`);
- 11 that were broken before and are fixed by the upgrade;
- 1 broken on both.

**Update (2026-10-20):** `dsh-plugin-subscriptions@0.9.10` is fixed and published (matrix now passes on `0.2.1-rc.2`); `dsh-codex-connect` has the fix in the `alpha` channel (`0.2.0-alpha.9`), while `latest` still points at the old `0.2.0-alpha.1`; `@feng0531/dsh-vcs@0.4.10` is still unfixed. By default `latest` installs, 2 plugins remain affected; allowing the alpha channel, 1 remains.

DSH compatibility is decided from the plugin's declared ranges (`engines.dsh` first, otherwise every `@deepseek-ai/dsh*` peer, prereleases included). Pinning an exact host version therefore breaks on the next nightly even when the plugin code is unchanged.

Run the check before upgrading:

```sh
dsh-plugin-health matrix --plugins plugins.txt --versions 0.2.0-rc.2,0.2.1-rc.2
```

This checks declared compatibility, not runtime API usage. It catches the most common upgrade failure mode (narrow/pegged peer ranges), not every possible regression.
