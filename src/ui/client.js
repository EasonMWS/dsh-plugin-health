/**
 * Browser half of dsh-plugin-health: one native settings section («插件健康») and a sidebar alert
 * that only appears when something is actually wrong.
 *
 * Loaded by the DSH module loader through `package.json` → `dsh.client` → `exports["./client"]`.
 * @module ui/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-health',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const STATUS_PATH = '/plugins/dsh-plugin-health/status'
    const REPAIR_PATH = '/plugins/dsh-plugin-health/repair'
    const SECTION_SLOT = 'settings.section'
    const SECTION_ID = 'plugin-health'
    const ALERT_SLOT = 'sidebar.footer.action'
    const ALERT_ID = 'plugin-health-alert'
    const NS = 'plugin-health'

    const COLORS = { error: '#d93025', warn: '#b26a00', info: '#1a73e8', ok: '#188038' }
    const SEVERITY_LABEL = { error: '会影响使用', warn: '建议处理', info: '提示' }

    /** Friendly copy for the reported finding ids; unknown ids fall back to the host title. */
    const COPY = {
      'plugin-incompatible': {
        title: '插件和当前 DSH 版本不兼容',
        what: '这个插件声明的版本范围不包含你当前的 DSH。DSH 会拒绝加载它。',
        fix: '升级插件到支持当前 DSH 的版本；如果没有新版，暂时不要用它。',
      },
      'bundle-missing': {
        title: '插件没有真正装上',
        what: '插件列表里有它，但磁盘上没有对应文件，通常是安装中断或手动删掉了。',
        fix: '重新安装这个插件，然后重启 DSH。',
      },
      'bundle-manifest-invalid': {
        title: '插件文件损坏',
        what: '这个插件的 package.json 读不出来，DSH 无法确认它是什么。',
        fix: '先隔离这个目录，再重新安装插件。',
      },
      'package-dir-broken': {
        title: '插件目录不完整',
        what: '目录里没有 package.json，一般是安装到一半失败留下的空壳。',
        fix: '删掉这个目录后重新安装。',
      },
      'dependency-missing': {
        title: '插件依赖缺失',
        what: '插件声明了某个依赖，但 node_modules 里没有。',
        fix: '在 profile 目录里重新安装依赖，或重装这个插件。',
      },
      'patch-invalid': {
        title: '插件挂载配置无法解析',
        what: 'cordis.patch.yml 不是合法的 YAML，DSH 可能因此启动不了。',
        fix: '从备份恢复这个文件，或删掉出问题的条目。',
      },
      'patch-not-array': {
        title: '插件挂载配置格式不对',
        what: 'cordis.patch.yml 应该是一个数组，现在不是。',
        fix: '把它改成数组格式，或从备份恢复。',
      },
      'patch-empty-entry': {
        title: '挂载配置里有空条目',
        what: '空条目会干扰加载器，通常是编辑时留下的。',
        fix: '删掉这些空条目即可，不会影响插件功能。',
      },
      'patch-invalid-entry': {
        title: '挂载配置里有无效条目',
        what: '有些条目不是对象，DSH 会忽略它们。',
        fix: '删掉无效条目，或恢复备份。',
      },
      'plugin-manifest-invalid': {
        title: '插件的 package.json 读不出来',
        what: '这个插件目录里的 manifest 损坏，无法判断兼容性。',
        fix: '重新安装这个插件。',
      },
      'profile-bundles-empty': {
        title: '这个 profile 没有启用任何插件',
        what: '刚创建的 profile 或还没安装插件时会出现，属于正常现象。',
        fix: '如果你本来装了插件，检查一下 profile 是不是选错了。',
      },
      'profile-manifest-missing': {
        title: 'profile 配置丢失',
        what: '这个 profile 的 package.json 不在了。',
        fix: '从备份恢复，或重新创建 profile。',
      },
      'profile-manifest-invalid': {
        title: 'profile 配置损坏',
        what: 'profile 的 package.json 不是合法 JSON。',
        fix: '从备份恢复这个文件。',
      },
      'profile-missing': {
        title: 'profile 不存在',
        what: '指定的 profile 目录找不到。',
        fix: '检查 profile 名字，或启动一次 DSH 让它自动创建。',
      },
      'home-missing': {
        title: '找不到 DSH 数据目录',
        what: 'DSH 还没有在这台机器上启动过，或者 DSH_HOME 指错了。',
        fix: '启动一次 DSH，或检查 DSH_HOME 环境变量。',
      },
      'profiles-missing': {
        title: '还没有任何 profile',
        what: '第一次启动 DSH 之前会是这个状态。',
        fix: '启动一次 DSH 即可。',
      },
      residue: {
        title: '有上次安装留下的临时文件',
        what: '这些是安装或更新插件时留下的临时文件，不参与运行，也不影响功能。',
        fix: '可以安全清理；清理前请先退出 DSH。',
      },
      'logs-large': {
        title: '插件日志有点大',
        what: '日志占用了几十 MB，通常是反复安装失败留下的。',
        fix: '在 DSH 停止时归档或删除旧日志。',
      },
      'proxy-env': {
        title: '代理设置可能不生效',
        what: '你设置了代理，但 DSH 的插件下载走 Node fetch，默认不读代理环境变量。',
        fix: '启动 DSH 前设置 NODE_USE_ENV_PROXY=1，或改用 npm 镜像。',
      },
      'registry-mirror': {
        title: '正在使用自定义 npm 源',
        what: '插件安装走这个源，有些插件版本可能还没同步过来。',
        fix: '装不上插件时，先确认这个源有对应版本。',
      },
      'wsl-detected': {
        title: '检测到 WSL 环境',
        what: '在 WSL 里跑 DSH 时，Windows 路径、换行符和挂载性能都可能出问题。',
        fix: '把 DSH_HOME 放在 Linux 文件系统里，不要放在 /mnt/c。',
      },
      'long-path': {
        title: 'DSH 路径有点长',
        what: 'Windows 对长路径支持有限，安装插件可能失败。',
        fix: '把 DSH_HOME 改到更短的路径，比如 C:\\dsh。',
      },
      'profile-drift': {
        title: '两个 profile 的插件不一样',
        what: '不同 profile 本来就是隔离的，这不一定是问题。',
        fix: '升级 DSH 时记得把另一个 profile 也检查一遍。',
      },
    }

    /** Poll the host snapshot; the route is cheap and cached server-side for a few seconds. */
    function useStatus(intervalMs = 30000) {
      const [state, setState] = React.useState({ loading: true, error: undefined, data: undefined })
      const reload = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_PATH, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setState({ loading: false, error: undefined, data })
        } catch (error) {
          setState({ loading: false, error: error instanceof Error ? error.message : String(error), data: undefined })
        }
      }, [])
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          if (!alive) return
          await reload()
        }
        load()
        const timer = setInterval(load, intervalMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [intervalMs, reload])
      return { ...state, reload }
    }

    /**
     * Two-step repair: a dry run first (always shown), then the real write behind an explicit
     * confirm. Never touches a finding that the host did not mark `autoFixable`.
     */
    function useRepair(reload) {
      const [phase, setPhase] = React.useState('idle')
      const [plan, setPlan] = React.useState(undefined)
      const [result, setResult] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)

      const call = async (dryRun, key) => {
        const response = await fetch(REPAIR_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-plugin-health-key': key },
          credentials: 'same-origin',
          body: JSON.stringify({ dryRun }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      }

      const start = async (key) => {
        setPhase('planning')
        setError(undefined)
        try {
          const next = await call(true, key)
          setPlan(next)
          setPhase(next.planned.length === 0 ? 'nothing' : 'planned')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('error')
        }
      }

      const confirm = async (key) => {
        setPhase('applying')
        setError(undefined)
        try {
          const next = await call(false, key)
          setResult(next)
          setPhase('done')
          await reload()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('error')
        }
      }

      const reset = () => {
        setPhase('idle')
        setPlan(undefined)
        setResult(undefined)
        setError(undefined)
      }

      return { phase, plan, result, error, start, confirm, reset }
    }

    function dot(severity, size = 8) {
      return h('span', {
        style: {
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: size / 2,
          background: COLORS[severity] ?? '#999',
          flex: '0 0 auto',
        },
      })
    }

    /** One finding: a plain-language headline, expandable details, and a concrete next step. */
    function Finding({ issue }) {
      const [open, setOpen] = React.useState(false)
      const copy = COPY[issue.id] ?? { title: issue.title, what: '', fix: issue.fix }
      return h('div', {
        style: {
          border: '1px solid rgba(128,128,128,.22)',
          borderRadius: 10,
          padding: '12px 14px',
          marginBottom: 10,
          background: 'transparent',
        },
      }, [
        h('div', {
          key: 'head',
          onClick: () => setOpen(!open),
          style: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexWrap: 'wrap' },
        }, [
          dot(issue.severity),
          h('span', { key: 't', style: { flex: '1 1 200px', minWidth: 0, fontWeight: 600, fontSize: 14, lineHeight: 1.5 } }, copy.title),
          h('span', { key: 'badge', style: { flex: '0 0 auto', fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' } }, SEVERITY_LABEL[issue.severity] ?? ''),
          h('span', { key: 'a', style: { flex: '0 0 auto', fontSize: 12, opacity: 0.5, whiteSpace: 'nowrap' } }, open ? '收起' : '详情'),
        ]),
        open ? h('div', { key: 'body', style: { marginTop: 10, paddingLeft: 18, fontSize: 13, lineHeight: 1.65 } }, [
          copy.what ? h('div', { key: 'what', style: { marginBottom: 8, opacity: 0.85 } }, copy.what) : null,
          issue.detail ? h('div', {
            key: 'detail',
            style: { marginBottom: 8, opacity: 0.6, fontSize: 12, wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace' },
          }, issue.detail) : null,
          copy.fix ? h('div', { key: 'fix', style: { color: COLORS.info } }, `怎么做：${copy.fix}`) : null,
        ]) : null,
      ])
    }

    function EmptyState() {
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '18px 16px',
          borderRadius: 10,
          background: 'rgba(52,168,83,.10)',
          color: COLORS.ok,
          fontSize: 14,
          fontWeight: 600,
        },
      }, [h('span', { key: 'i', style: { fontSize: 18 } }, '✓'), h('span', { key: 't' }, '一切正常，没有发现插件冲突')])
    }

    function HealthSection() {
      const { loading, error, data, reload } = useStatus()
      const repair = useRepair(reload)
      const issues = data?.issues ?? []
      const actionable = issues.filter((issue) => issue.severity !== 'info')
      const autoFixable = actionable.filter((issue) => issue.autoFixable === true)
      const summary = data?.summary ?? {}
      const repairKey = data?.repairKey

      return h('div', { style: { padding: '20px 4px', maxWidth: 760 } }, [
        h('div', { key: 'head', style: { marginBottom: 16 } }, [
          h('div', { key: 't', style: { fontSize: 17, fontWeight: 700 } }, '插件健康'),
          h('div', { key: 's', style: { fontSize: 13, opacity: 0.65, marginTop: 4 } },
            '检查已安装的插件能否在当前 DSH 版本上正常加载。只在你打开这里时检查，不会影响 DSH 运行。'),
        ]),
        loading ? h('div', { key: 'l', style: { fontSize: 13, opacity: 0.7 } }, '正在检查…') : null,
        error !== undefined ? h('div', { key: 'e', style: { fontSize: 13, color: COLORS.warn } }, [
          h('div', { key: 't', style: { fontWeight: 600, marginBottom: 4 } }, '检查失败'),
          h('div', { key: 'd' }, error),
          h('div', { key: 'h', style: { marginTop: 4, opacity: 0.7 } }, 'DSH 刚启动时可能还没准备好，页面会自动重试。'),
        ]) : null,
        !loading && error === undefined ? (actionable.length === 0 ? h(EmptyState, { key: 'ok' }) : h('div', { key: 'list' },
          actionable.map((issue, index) => h(Finding, { key: `${issue.id}-${index}`, issue })))) : null,
        !loading && error === undefined && issues.length > actionable.length
          ? h('div', { key: 'info', style: { marginTop: 6, fontSize: 12, opacity: 0.55 } },
            `${issues.length - actionable.length} 条提示不影响使用，已省略。`)
          : null,
        autoFixable.length > 0 && repair.phase === 'idle'
          ? h('div', { key: 'fixbar', style: { marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } }, [
            h('button', {
              key: 'b',
              onClick: () => repair.start(repairKey),
              style: {
                border: 0,
                borderRadius: 8,
                padding: '9px 16px',
                cursor: 'pointer',
                background: COLORS.ok,
                color: '#fff',
                font: 'inherit',
                fontSize: 13,
                fontWeight: 600,
              },
            }, `一键修复 ${autoFixable.length} 项`),
            h('span', { key: 'h', style: { fontSize: 12, opacity: 0.6 } },
              '安全：只隔离不删除，原文件可以在隔离区找回；会先给你看修复计划。'),
          ])
          : null,
        repair.phase === 'planning' ? h('div', { key: 'p', style: { marginTop: 14, fontSize: 13, opacity: 0.7 } }, '正在生成修复计划…') : null,
        repair.phase === 'planned' && repair.plan
          ? h('div', { key: 'plan', style: { marginTop: 14, padding: 14, borderRadius: 10, border: '1px solid rgba(128,128,128,.25)', fontSize: 13 } }, [
            h('div', { key: 't', style: { fontWeight: 600, marginBottom: 8 } }, '将要执行的操作'),
            ...repair.plan.planned.map((item, index) => h('div', { key: index, style: { padding: '4px 0', opacity: 0.85 } }, `· ${item.description || item.id}`)),
            repair.plan.manual > 0
              ? h('div', { key: 'm', style: { marginTop: 8, fontSize: 12, opacity: 0.6 } }, `另有 ${repair.plan.manual} 项需要你手动处理，不会动。`)
              : null,
            h('div', { key: 'actions', style: { marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' } }, [
              h('button', {
                key: 'go',
                onClick: () => repair.confirm(repairKey),
                style: { border: 0, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', background: COLORS.error, color: '#fff', font: 'inherit', fontSize: 13, fontWeight: 600 },
              }, '确认修复'),
              h('button', {
                key: 'cancel',
                onClick: repair.reset,
                style: { border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13 },
              }, '取消'),
            ]),
          ])
          : null,
        repair.phase === 'nothing' ? h('div', { key: 'n', style: { marginTop: 14, fontSize: 13, opacity: 0.75 } }, '这些问题需要你手动处理，工具不会自动改。') : null,
        repair.phase === 'applying' ? h('div', { key: 'a', style: { marginTop: 14, fontSize: 13, opacity: 0.7 } }, '正在应用…') : null,
        repair.phase === 'done' && repair.result
          ? h('div', { key: 'done', style: { marginTop: 14, padding: 14, borderRadius: 10, background: 'rgba(52,168,83,.10)', color: COLORS.ok, fontSize: 13 } }, [
            h('div', { key: 't', style: { fontWeight: 700, marginBottom: 6 } }, `已修复 ${repair.result.actions.length} 项`),
            ...repair.result.actions.map((action, index) => h('div', { key: index, style: { fontSize: 12, opacity: 0.85 } },
              action.kind === 'quarantine' ? `已隔离：${action.from}` : `已重写：${action.file}（备份在隔离区）`)),
            repair.result.quarantineDir
              ? h('div', { key: 'q', style: { marginTop: 8, fontSize: 12, opacity: 0.7 } }, `可从这里找回：${repair.result.quarantineDir}`)
              : null,
            h('div', { key: 'r', style: { marginTop: 10 } }, [
              h('button', {
                key: 'again',
                onClick: repair.reset,
                style: { border: 0, borderRadius: 8, padding: '7px 12px', cursor: 'pointer', background: 'rgba(52,168,83,.18)', color: COLORS.ok, font: 'inherit', fontSize: 13, fontWeight: 600 },
              }, '知道了'),
            ]),
          ])
          : null,
        data
          ? h('div', { key: 'meta', style: { marginTop: 20, fontSize: 12, opacity: 0.5, lineHeight: 1.7 } }, [
            h('div', { key: 'v' }, `DSH 版本：${data.runtimeVersion ?? '未知'}`),
            h('div', { key: 'p' }, `Profile：${data.profile ?? '未知'}（${data.home}）`),
            h('div', { key: 'c' }, `检查时间：${new Date(data.generatedAt).toLocaleString()} · 共 ${summary.error ?? 0} 个错误 / ${summary.warn ?? 0} 个警告`),
          ])
          : null,
      ])
    }

    /** Sidebar entry that exists only while there is something worth acting on. */
    function AlertEntry(props) {
      return h('button', {
        onClick: props.open,
        title: '查看插件健康检查结果',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          border: 0,
          borderRadius: 8,
          padding: '8px 10px',
          cursor: 'pointer',
          background: 'rgba(217,48,37,.10)',
          color: COLORS.error,
          font: 'inherit',
          fontSize: 13,
          fontWeight: 600,
          textAlign: 'left',
        },
      }, [
        h('span', { key: 'i' }, '!'),
        h('span', { key: 't', style: { flex: 1 } }, `插件有 ${props.count} 个问题`),
        h('span', { key: 'a', style: { fontSize: 12, opacity: 0.7 } }, '查看'),
      ])
    }

    const name = 'dsh-plugin-health-client'
    const inject = ['slots', 'locale']

    /**
     * Register the settings section, and register the sidebar alert only when the snapshot has
     * actionable findings. Nothing is shown in the normal case.
     * @param {object} ctx - client Cordis context.
     */
    function apply(ctx) {
      const t = (() => {
        try {
          ctx.effect(() => ctx.locale.register(NS, {
            zh: { nav: '插件健康' },
            en: { nav: 'Plugin health' },
          }), 'dsh-plugin-health: copy')
          return ctx.locale.bind(NS)
        } catch {
          return undefined
        }
      })()

      ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
        name: SECTION_SLOT,
        id: SECTION_ID,
        order: 45,
        label: () => (typeof t === 'function' ? t('nav') : '插件健康'),
        locale: NS,
      }, HealthSection))

      ctx.inject(['layout'], (layoutCtx) => {
        let disposeAlert
        const refreshAlert = () => {
          fetch(STATUS_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((data) => {
              const count = (data?.issues ?? []).filter((issue) => issue.severity !== 'info').length
              if (count === 0) {
                try { disposeAlert?.() } catch {}
                disposeAlert = undefined
                return
              }
              if (disposeAlert !== undefined) return
              layoutCtx.slots.inject(ALERT_SLOT, () => {
                const dispose = layoutCtx.slots.register({
                  name: ALERT_SLOT,
                  id: ALERT_ID,
                  order: 90,
                  inject: () => ({
                    count,
                    open: () => {
                      try { layoutCtx.get('layout')?.selectPanel?.('settings') } catch {}
                    },
                  }),
                }, AlertEntry)
                disposeAlert = dispose
                return () => {
                  try { dispose() } catch {}
                  disposeAlert = undefined
                }
              })
            })
            .catch(() => {})
        }
        refreshAlert()
        const timer = setInterval(refreshAlert, 60000)
        return () => clearInterval(timer)
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
