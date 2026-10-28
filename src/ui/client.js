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
    const RESCUE_PATH = '/plugins/dsh-plugin-health/rescue'
    const SECTION_SLOT = 'settings.section'
    const SECTION_ID = 'plugin-health'
    const ALERT_SLOT = 'sidebar.footer.action'
    const ALERT_ID = 'plugin-health-alert'
    const NS = 'plugin-health'

    const COLORS = { error: '#d93025', warn: '#b26a00', info: '#1a73e8', ok: '#188038' }

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

    const COPY_EN = {
      'plugin-incompatible': {
        title: 'Plugin is incompatible with this DSH version',
        what: 'The plugin does not declare support for your current DSH version. DSH will refuse to load it.',
        fix: 'Update to a plugin version that supports this DSH release. If none is available, leave it disabled for now.',
      },
      'bundle-missing': {
        title: 'Plugin installation is missing',
        what: 'The plugin is listed, but its files are missing. An interrupted installation or manual removal can cause this.',
        fix: 'Reinstall the plugin, then restart DSH.',
      },
      'bundle-manifest-invalid': {
        title: 'Plugin files are damaged',
        what: 'DSH cannot read this plugin’s package.json to identify it.',
        fix: 'Quarantine the directory, then reinstall the plugin.',
      },
      'package-dir-broken': {
        title: 'Plugin directory is incomplete',
        what: 'The directory has a missing or unreadable package.json, often after a failed installation.',
        fix: 'Quarantine this directory, then reinstall the package.',
      },
      'dependency-missing': {
        title: 'Plugin dependency is missing',
        what: 'A dependency declared by the plugin is missing from node_modules.',
        fix: 'Reinstall the profile’s dependencies, or reinstall the plugin.',
      },
      'patch-invalid': {
        title: 'Plugin configuration cannot be parsed',
        what: 'cordis.patch.yml is not valid YAML. This may prevent DSH from starting.',
        fix: 'Restore the file from a backup, or remove the invalid entries.',
      },
      'patch-not-array': {
        title: 'Plugin configuration has the wrong format',
        what: 'cordis.patch.yml must contain an array.',
        fix: 'Convert it to an array, or restore it from a backup.',
      },
      'patch-empty-entry': {
        title: 'Plugin configuration contains empty entries',
        what: 'Empty entries can interfere with loading. They are often left behind during editing.',
        fix: 'Remove the empty entries; this does not remove plugin functionality.',
      },
      'patch-invalid-entry': {
        title: 'Plugin configuration contains invalid entries',
        what: 'Some entries are not objects. DSH will ignore them.',
        fix: 'Remove the invalid entries, or restore a backup.',
      },
      'plugin-manifest-invalid': {
        title: 'Plugin package.json cannot be read',
        what: 'The plugin manifest is damaged, so compatibility cannot be determined.',
        fix: 'Reinstall the plugin.',
      },
      'profile-bundles-empty': {
        title: 'This profile has no enabled plugins',
        what: 'This is normal for a new profile or one with no plugins installed yet.',
        fix: 'If you expected installed plugins, check that you selected the right profile.',
      },
      'profile-manifest-missing': {
        title: 'Profile configuration is missing',
        what: 'This profile’s package.json is missing.',
        fix: 'Restore it from a backup, or recreate the profile.',
      },
      'profile-manifest-invalid': {
        title: 'Profile configuration is damaged',
        what: 'The profile’s package.json is not valid JSON.',
        fix: 'Restore the file from a backup.',
      },
      'profile-missing': {
        title: 'Profile does not exist',
        what: 'The specified profile directory could not be found.',
        fix: 'Check the profile name, or start DSH once to create it.',
      },
      'home-missing': {
        title: 'DSH data directory was not found',
        what: 'DSH may not have started on this machine yet, or DSH_HOME points to the wrong location.',
        fix: 'Start DSH once, or check the DSH_HOME environment variable.',
      },
      'profiles-missing': {
        title: 'No profiles exist yet',
        what: 'This is expected before DSH starts for the first time.',
        fix: 'Start DSH once.',
      },
      residue: {
        title: 'Temporary files remain from an earlier installation',
        what: 'These files were left by a plugin installation or update. They are not used at runtime.',
        fix: 'They can be cleaned up. Exit DSH before cleaning them up.',
      },
      'logs-large': {
        title: 'Plugin logs are getting large',
        what: 'The logs occupy tens of MB, often after repeated installation failures.',
        fix: 'Archive or delete old logs while DSH is stopped.',
      },
      'proxy-env': {
        title: 'Proxy settings may not take effect',
        what: 'A proxy is configured, but DSH downloads plugins through Node fetch, which does not read proxy environment variables by default.',
        fix: 'Set NODE_USE_ENV_PROXY=1 before starting DSH, or configure an npm mirror.',
      },
      'registry-mirror': {
        title: 'A custom npm registry is in use',
        what: 'Plugins are installed from this registry. Some versions may not have reached it yet.',
        fix: 'If installation fails, check that the registry has the required version.',
      },
      'wsl-detected': {
        title: 'WSL environment detected',
        what: 'Windows paths, line endings and mount performance can cause issues when running DSH in WSL.',
        fix: 'Keep DSH_HOME in the Linux filesystem rather than under /mnt/c.',
      },
      'long-path': {
        title: 'DSH path is long',
        what: 'Windows long-path limitations may cause plugin installation to fail.',
        fix: 'Move DSH_HOME to a shorter path, such as C:\\dsh.',
      },
      'profile-drift': {
        title: 'Two profiles have different plugins',
        what: 'Profiles are isolated by design. This is not necessarily a problem.',
        fix: 'Check the other profile too when upgrading DSH.',
      },
    }

    const dictionaries = {
      zh: {
        nav: '插件健康',
        description: '检查你电脑上已安装的每个插件能否在当前 DSH 版本上正常加载。只读检查，不会改动任何东西。',
        'severity.error': '会影响使用', 'severity.warn': '建议处理', 'severity.info': '提示',
        collapse: '收起', details: '详情', nextStep: '怎么做：{fix}',
        healthy: '一切正常，没有发现插件冲突', installedChecked: '已检查 {count} 个已安装插件',
        errors: '{count} 个错误', warnings: '{count} 个警告', ready: '可以放心用', attention: '有问题建议处理',
        checked: '共检查 {count} 个插件', checkedWithVersion: '共检查 {count} 个插件，DSH {version}',
        scanning: '正在扫描…', rescan: '重新扫描', checking: '正在检查…', checkFailed: '检查失败',
        checkRetry: 'DSH 刚启动时可能还没准备好，点「重新扫描」再试一次。',
        omitted: '{count} 条提示不影响使用，已省略。', repair: '一键修复 {count} 项',
        repairSafety: '安全：只隔离不删除，原文件可以在隔离区找回；会先给你看修复计划。',
        planning: '正在生成修复计划…', planned: '将要执行的操作', manual: '另有 {count} 项需要你手动处理，不会动。',
        confirm: '确认修复', cancel: '取消', nothing: '这些问题需要你手动处理，工具不会自动改。', applying: '正在应用…',
        repaired: '已修复 {count} 项', quarantined: '已隔离：{path}', rewritten: '已重写：{path}（备份在隔离区）',
        restoreFrom: '可从这里找回：{path}', acknowledge: '知道了', lastChecked: '上次检查：{time}', unknown: '未知',
        versionProfile: 'DSH {version} · Profile：{profile}', dateLocale: 'zh-CN',
        alertTitle: '查看插件健康检查结果', alertCount: '插件有 {count} 个问题', view: '查看',
        'plan.bundle-manifest-invalid': '把损坏的插件目录移到隔离区。',
        'plan.package-dir-broken': '把不完整或损坏的目录移到隔离区，然后重新安装插件。',
        'plan.patch-empty-entry': '移除顶层空 [] 条目，并备份原始文件。',
        'plan.residue': '把残留文件移到隔离区；可以从那里恢复。',
      },
      en: {
        nav: 'Plugin health',
        description: 'Check whether each installed plugin can load on your current DSH version. The scan is read-only and does not change any files.',
        'severity.error': 'Affects usage', 'severity.warn': 'Needs attention', 'severity.info': 'Information',
        collapse: 'Collapse', details: 'Details', nextStep: 'Next step: {fix}',
        healthy: 'No plugin conflicts found', installedChecked: 'Installed plugins checked: {count}',
        errors: 'Errors: {count}', warnings: 'Warnings: {count}', ready: 'Ready to use', attention: 'Issues need attention',
        checked: 'Plugins checked: {count}', checkedWithVersion: 'Plugins checked: {count}, DSH {version}',
        scanning: 'Scanning…', rescan: 'Rescan', checking: 'Checking…', checkFailed: 'Check failed',
        checkRetry: 'DSH may still be starting. Select Rescan to try again.',
        omitted: 'Informational findings omitted: {count}. They do not affect usage.', repair: 'Repair items ({count})',
        repairSafety: 'Files are quarantined, not deleted, and can be restored. You will review the plan before applying it.',
        planning: 'Preparing repair plan…', planned: 'Planned actions', manual: 'Items requiring manual action: {count}. They will not be changed.',
        confirm: 'Confirm repair', cancel: 'Cancel', nothing: 'These issues need manual action. The tool will not change them automatically.', applying: 'Applying…',
        repaired: 'Items repaired: {count}', quarantined: 'Quarantined: {path}', rewritten: 'Rewritten: {path} (backup in quarantine)',
        restoreFrom: 'Restore files from: {path}', acknowledge: 'Done', lastChecked: 'Last checked: {time}', unknown: 'Unknown',
        versionProfile: 'DSH {version} · Profile: {profile}', dateLocale: 'en',
        alertTitle: 'View plugin health results', alertCount: 'Plugin issues: {count}', view: 'View',
        'plan.bundle-manifest-invalid': 'Move the broken bundle directory to quarantine.',
        'plan.package-dir-broken': 'Move the incomplete or broken directory to quarantine, then reinstall the package.',
        'plan.patch-empty-entry': 'Remove top-level empty [] entries and back up the original file.',
        'plan.residue': 'Move the residue file to quarantine; it can be restored from there.',
      },
    }
    // The host locale registry uses flat keys and owns fallback and live language changes.
    for (const [language, findings] of Object.entries({ zh: COPY, en: COPY_EN })) {
      for (const [id, fields] of Object.entries(findings)) {
        for (const [field, text] of Object.entries(fields)) dictionaries[language][`finding.${id}.${field}`] = text
      }
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
     * Rescue flow: rehearse in a throwaway home first, then apply only if the rehearsal
     * proved the plugin boots. The two steps are separate on purpose — the user sees the
     * verdict before anything in their profile changes.
     */
    function useRescue(reload, key) {
      const [phase, setPhase] = React.useState('idle')
      const [verdict, setVerdict] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [applied, setApplied] = React.useState(undefined)
      const call = React.useCallback(async (action, body) => {
        const response = await fetch(`${RESCUE_PATH}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-plugin-health-key': key ?? '' },
          credentials: 'same-origin',
          body: JSON.stringify(body ?? {}),
        })
        if (!response.ok) {
          let detail = `HTTP ${response.status}`
          try { detail = (await response.json()).error ?? detail } catch { /* keep the status text */ }
          throw new Error(detail)
        }
        return response.json()
      }, [key])
      const rehearse = React.useCallback(async (plugin) => {
        setError(undefined); setApplied(undefined); setVerdict(undefined); setPhase('rehearsing')
        try {
          const result = await call('rehearse', plugin)
          setVerdict(result)
          setPhase('rehearsed')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('idle')
        }
      }, [call])
      const apply = React.useCallback(async (plugin) => {
        setPhase('applying')
        try {
          const result = await call('apply', plugin)
          setApplied(result)
          setPhase('done')
          if (typeof reload === 'function') await reload()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('rehearsed')
        }
      }, [call, reload])
      const reset = React.useCallback(() => {
        setPhase('idle'); setVerdict(undefined); setError(undefined); setApplied(undefined)
      }, [])
      return { phase, verdict, applied, error, rehearse, apply, reset }
    }

    /** Shared button styling so the rescue actions match the rest of the section. */
    function buttonStyle({ background, color, border } = {}) {
      return {
        border: border ?? (background === undefined ? '1px solid rgba(128,128,128,.35)' : 0),
        borderRadius: 8,
        padding: '8px 14px',
        cursor: 'pointer',
        background: background ?? 'transparent',
        color: color ?? 'inherit',
        font: 'inherit',
        fontSize: 13,
        fontWeight: background === undefined ? 400 : 600,
      }
    }

    /**
     * One incompatible plugin: explain, rehearse, then offer the exemption only when the
     * rehearsal says the plugin actually boots. A failed rehearsal offers the AI brief
     * and the upstream report instead, because exempting it would not have helped.
     */
    function RescueCard({ plugin, rescue }) {
      const busy = rescue.phase === 'rehearsing' || rescue.phase === 'applying'
      const showResult = rescue.verdict !== undefined
      const color = rescue.verdict === undefined
        ? COLORS.warn
        : rescue.verdict.verdict === 'runs' ? COLORS.ok : rescue.verdict.verdict === 'broken' ? COLORS.error : COLORS.warn
      return h('div', {
        style: { marginTop: 12, padding: 14, borderRadius: 10, border: '1px solid rgba(128,128,128,.25)' },
      }, [
        h('div', { key: 'h', style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } }, [
          h('span', { key: 'n', style: { fontWeight: 600, fontSize: 13 } }, plugin.name),
          h('span', { key: 'v', style: { fontSize: 12, opacity: 0.6 } }, plugin.version),
        ]),
        h('div', { key: 'w', style: { marginTop: 6, fontSize: 13, opacity: 0.8, lineHeight: 1.6 } },
          '这个插件声明的版本范围不包含你当前的 DSH，所以被拦住了。先做一次隔离检查：'
          + '在临时环境里把它装一遍、启动一遍，看代码本身到底能不能用。'),
        busy
          ? h('div', { key: 'b', style: { marginTop: 10, fontSize: 13, opacity: 0.7 } },
            rescue.phase === 'rehearsing'
              ? '正在隔离环境里试装并启动，大约需要 30~60 秒…'
              : '正在重新验证一次，然后写入配置（这样确保放行的正是刚刚验证过的状态）…')
          : null,
        rescue.error !== undefined
          ? h('div', { key: 'e', style: { marginTop: 10, fontSize: 13, color: COLORS.warn } }, `检查失败：${rescue.error}`)
          : null,
        showResult
          ? h('div', {
            key: 'r',
            style: { marginTop: 10, padding: 10, borderRadius: 8, fontSize: 13, lineHeight: 1.6, color, background: 'rgba(128,128,128,.08)' },
          }, [
            h('div', { key: 'm', style: { fontWeight: 600 } }, rescue.verdict.verdict === 'runs' ? '代码没问题，只是声明过时了' :
              rescue.verdict.verdict === 'broken' ? '这个插件真的跑不起来' : '检查结果不确定'),
            h('div', { key: 'd', style: { marginTop: 4, opacity: 0.9 } }, rescue.verdict.message),
            rescue.verdict.hostVersion ? h('div', { key: 'h', style: { marginTop: 4, fontSize: 12, opacity: 0.6 } }, `测试宿主：DSH ${rescue.verdict.hostVersion}`) : null,
          ])
          : null,
        rescue.applied !== undefined && rescue.applied.applied === true
          ? h('div', { key: 'a', style: { marginTop: 10, fontSize: 13, color: COLORS.ok, lineHeight: 1.6 } }, [
            h('div', { key: 't', style: { fontWeight: 600 } }, '已临时放行'),
            h('div', { key: 'd', style: { marginTop: 4, opacity: 0.9 } },
              '重启 DSH 后这个插件就能加载了。这是临时措施：等作者发布支持当前版本的正式版后，'
              + '在下面「临时放行记录」里点「撤销」即可恢复原状。'),
          ])
          : null,
        h('div', { key: 'act', style: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
          rescue.phase === 'idle'
            ? h('button', {
              key: 'go',
              onClick: () => rescue.rehearse({ plugin: plugin.name, version: plugin.version }),
              style: buttonStyle({ background: COLORS.info, color: '#fff' }),
            }, '检查能不能救')
            : null,
          rescue.phase === 'rehearsed' && rescue.verdict?.canApply === true
            ? h('button', {
              key: 'apply',
              onClick: () => rescue.apply({ plugin: plugin.name, version: plugin.version }),
              style: buttonStyle({ background: COLORS.ok, color: '#fff' }),
            }, '临时放行')
            : null,
          rescue.phase === 'rehearsed' && rescue.verdict?.canApply !== true
            ? h('button', {
              key: 'brief',
              onClick: () => rescue.rehearse({ plugin: plugin.name, version: plugin.version }),
              style: buttonStyle({}),
            }, '重新检查')
            : null,
          rescue.phase === 'done'
            ? h('button', { key: 'reset', onClick: rescue.reset, style: buttonStyle({}) }, '知道了')
            : null,
        ]),
      ])
    }

    /** Shown when rescue is available: the list of incompatible plugins with their actions. */
    function RescuePanel({ rescuable, rescue }) {
      if (!Array.isArray(rescuable) || rescuable.length === 0) return null
      return h('div', { key: 'rescue', style: { marginTop: 18 } }, [
        h('div', { key: 't', style: { fontSize: 14, fontWeight: 700, marginBottom: 4 } }, '可以尝试修复'),
        h('div', { key: 's', style: { fontSize: 12, opacity: 0.65, marginBottom: 4, lineHeight: 1.6 } },
          '大部分“不兼容”其实只是插件把版本号写死了，代码本身在新的 DSH 上照样能跑。'
          + '下面会先在临时环境里验证，确认能用才动你的配置。'),
        ...rescuable.map((plugin, index) => h(RescueCard, { key: `${plugin.name}-${index}`, plugin, rescue })),
      ])
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
    function Finding({ issue, t }) {
      const [open, setOpen] = React.useState(false)
      const copy = Object.hasOwn(COPY, issue.id)
        ? { title: t(`finding.${issue.id}.title`), what: t(`finding.${issue.id}.what`), fix: t(`finding.${issue.id}.fix`) }
        : { title: issue.title, what: '', fix: issue.fix }
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
          h('span', { key: 'badge', style: { flex: '0 0 auto', fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' } }, ['error', 'warn', 'info'].includes(issue.severity) ? t(`severity.${issue.severity}`) : ''),
          h('span', { key: 'a', style: { flex: '0 0 auto', fontSize: 12, opacity: 0.5, whiteSpace: 'nowrap' } }, open ? t('collapse') : t('details')),
        ]),
        open ? h('div', { key: 'body', style: { marginTop: 10, paddingLeft: 18, fontSize: 13, lineHeight: 1.65 } }, [
          copy.what ? h('div', { key: 'what', style: { marginBottom: 8, opacity: 0.85 } }, copy.what) : null,
          issue.detail ? h('div', {
            key: 'detail',
            style: { marginBottom: 8, opacity: 0.6, fontSize: 12, wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace' },
          }, issue.detail) : null,
          copy.fix ? h('div', { key: 'fix', style: { color: COLORS.info } }, t('nextStep', { fix: copy.fix })) : null,
        ]) : null,
      ])
    }

    function EmptyState({ scanned, t }) {
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
          flexWrap: 'wrap',
        },
      }, [
        h('span', { key: 'i', style: { fontSize: 18 } }, '✓'),
        h('span', { key: 't' }, t('healthy')),
        scanned !== undefined
          ? h('span', { key: 'n', style: { fontSize: 12, fontWeight: 400, opacity: 0.65 } }, t('installedChecked', { count: scanned }))
          : null,
      ])
    }

    /** One-line verdict a first-time user can act on without reading the list. */
    function Verdict({ errorCount, warnCount, scanned, runtimeVersion, t }) {
      const parts = []
      if (errorCount > 0) parts.push(h('span', { key: 'e', style: { color: COLORS.error } }, t('errors', { count: errorCount })))
      if (warnCount > 0) parts.push(h('span', { key: 'w', style: { color: COLORS.warn } }, t('warnings', { count: warnCount })))
      const clean = errorCount === 0 && warnCount === 0
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '10px 14px',
          borderRadius: 8,
          marginBottom: 14,
          fontSize: 13,
          background: clean ? 'rgba(52,168,83,.08)' : 'rgba(178,106,0,.08)',
        },
      }, [
        h('span', { key: 'd', style: { width: 8, height: 8, borderRadius: '50%', background: clean ? COLORS.ok : COLORS.warn, flex: '0 0 auto' } }),
        h('span', { key: 't', style: { fontWeight: 600 } }, clean ? t('ready') : t('attention')),
        h('span', { key: 's', style: { opacity: 0.7 } }, clean
          ? t(runtimeVersion ? 'checkedWithVersion' : 'checked', { count: scanned ?? '?', version: runtimeVersion })
          : parts),
      ])
    }

    function ScanButton({ onClick, busy, t }) {
      return h('button', {
        onClick,
        disabled: busy === true,
        style: {
          border: '1px solid rgba(128,128,128,.35)',
          borderRadius: 8,
          padding: '7px 14px',
          cursor: busy === true ? 'default' : 'pointer',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 13,
          opacity: busy === true ? 0.55 : 1,
        },
      }, busy === true ? t('scanning') : t('rescan'))
    }

    function HealthSection({ t }) {
      const { loading, error, data, reload } = useStatus()
      const repair = useRepair(reload)
      const rescue = useRescue(reload, data?.repairKey)
      const [scanning, setScanning] = React.useState(false)
      const issues = data?.issues ?? []
      const rescuable = data?.rescuable ?? []
      const actionable = issues.filter((issue) => issue.severity !== 'info')
      const autoFixable = actionable.filter((issue) => issue.autoFixable === true)
      const summary = data?.summary ?? {}
      const repairKey = data?.repairKey
      const scanned = data?.scanned?.plugins?.total

      const rescan = React.useCallback(async () => {
        setScanning(true)
        try {
          await reload()
        } finally {
          setScanning(false)
        }
      }, [reload])

      return h('div', { style: { padding: '20px 4px', maxWidth: 760 } }, [
        h('div', { key: 'head', style: { marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } }, [
          h('div', { key: 'l', style: { flex: '1 1 320px', minWidth: 0 } }, [
            h('div', { key: 't', style: { fontSize: 17, fontWeight: 700 } }, t('nav')),
            h('div', { key: 's', style: { fontSize: 13, opacity: 0.65, marginTop: 4 } },
              t('description')),
          ]),
          h('div', { key: 'r', style: { flex: '0 0 auto' } }, h(ScanButton, { onClick: rescan, busy: scanning || loading, t })),
        ]),
        loading ? h('div', { key: 'l', style: { fontSize: 13, opacity: 0.7 } }, t('checking')) : null,
        error !== undefined ? h('div', { key: 'e', style: { fontSize: 13, color: COLORS.warn } }, [
          h('div', { key: 't', style: { fontWeight: 600, marginBottom: 4 } }, t('checkFailed')),
          h('div', { key: 'd' }, error),
          h('div', { key: 'h', style: { marginTop: 4, opacity: 0.7 } }, t('checkRetry')),
        ]) : null,
        !loading && error === undefined
          ? h(Verdict, {
            key: 'v',
            t,
            errorCount: summary.error ?? 0,
            warnCount: summary.warn ?? 0,
            scanned,
            runtimeVersion: data?.runtimeVersion,
          })
          : null,
        !loading && error === undefined ? (actionable.length === 0 ? h(EmptyState, { key: 'ok', scanned, t }) : h('div', { key: 'list' },
          actionable.map((issue, index) => h(Finding, { key: `${issue.id}-${index}`, issue, t })))) : null,
        !loading && error === undefined && issues.length > actionable.length
          ? h('div', { key: 'info', style: { marginTop: 6, fontSize: 12, opacity: 0.55 } },
            t('omitted', { count: issues.length - actionable.length }))
          : null,
        !loading && error === undefined
          ? h(RescuePanel, { key: 'rescue', rescuable, rescue })
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
            }, t('repair', { count: autoFixable.length })),
            h('span', { key: 'h', style: { fontSize: 12, opacity: 0.6 } },
              t('repairSafety')),
          ])
          : null,
        repair.phase === 'planning' ? h('div', { key: 'p', style: { marginTop: 14, fontSize: 13, opacity: 0.7 } }, t('planning')) : null,
        repair.phase === 'planned' && repair.plan
          ? h('div', { key: 'plan', style: { marginTop: 14, padding: 14, borderRadius: 10, border: '1px solid rgba(128,128,128,.25)', fontSize: 13 } }, [
            h('div', { key: 't', style: { fontWeight: 600, marginBottom: 8 } }, t('planned')),
            ...repair.plan.planned.map((item, index) => h('div', { key: index, style: { padding: '4px 0', opacity: 0.85 } }, `· ${Object.hasOwn(dictionaries.en, `plan.${item.id}`) ? t(`plan.${item.id}`) : item.description || item.id}`)),
            repair.plan.manual > 0
              ? h('div', { key: 'm', style: { marginTop: 8, fontSize: 12, opacity: 0.6 } }, t('manual', { count: repair.plan.manual }))
              : null,
            h('div', { key: 'actions', style: { marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' } }, [
              h('button', {
                key: 'go',
                onClick: () => repair.confirm(repairKey),
                style: { border: 0, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', background: COLORS.error, color: '#fff', font: 'inherit', fontSize: 13, fontWeight: 600 },
              }, t('confirm')),
              h('button', {
                key: 'cancel',
                onClick: repair.reset,
                style: { border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13 },
              }, t('cancel')),
            ]),
          ])
          : null,
        repair.phase === 'nothing' ? h('div', { key: 'n', style: { marginTop: 14, fontSize: 13, opacity: 0.75 } }, t('nothing')) : null,
        repair.phase === 'applying' ? h('div', { key: 'a', style: { marginTop: 14, fontSize: 13, opacity: 0.7 } }, t('applying')) : null,
        repair.phase === 'done' && repair.result
          ? h('div', { key: 'done', style: { marginTop: 14, padding: 14, borderRadius: 10, background: 'rgba(52,168,83,.10)', color: COLORS.ok, fontSize: 13 } }, [
            h('div', { key: 't', style: { fontWeight: 700, marginBottom: 6 } }, t('repaired', { count: repair.result.actions.length })),
            ...repair.result.actions.map((action, index) => h('div', { key: index, style: { fontSize: 12, opacity: 0.85 } },
              action.kind === 'quarantine' ? t('quarantined', { path: action.from }) : t('rewritten', { path: action.file }))),
            repair.result.quarantineDir
              ? h('div', { key: 'q', style: { marginTop: 8, fontSize: 12, opacity: 0.7 } }, t('restoreFrom', { path: repair.result.quarantineDir }))
              : null,
            h('div', { key: 'r', style: { marginTop: 10 } }, [
              h('button', {
                key: 'again',
                onClick: repair.reset,
                style: { border: 0, borderRadius: 8, padding: '7px 12px', cursor: 'pointer', background: 'rgba(52,168,83,.18)', color: COLORS.ok, font: 'inherit', fontSize: 13, fontWeight: 600 },
              }, t('acknowledge')),
            ]),
          ])
          : null,
        data
          ? h('div', { key: 'meta', style: { marginTop: 20, fontSize: 12, opacity: 0.5, lineHeight: 1.7 } }, [
            h('div', { key: 'c' }, `${t('lastChecked', { time: new Date(data.generatedAt).toLocaleString(t('dateLocale')) })}${scanned !== undefined ? ` · ${t('checked', { count: scanned })}` : ''}`),
            h('div', { key: 'v' }, t('versionProfile', { version: data.runtimeVersion ?? t('unknown'), profile: data.profile ?? t('unknown') })),
            h('div', { key: 'h', style: { opacity: 0.8 } }, `${data.home}`),
          ])
          : null,
      ])
    }

    /** Sidebar entry that exists only while there is something worth acting on. */
    function AlertEntry(props) {
      const { t } = props
      return h('button', {
        onClick: props.open,
        title: t('alertTitle'),
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
        h('span', { key: 't', style: { flex: 1 } }, t('alertCount', { count: props.count })),
        h('span', { key: 'a', style: { fontSize: 12, opacity: 0.7 } }, t('view')),
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
          ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-plugin-health: copy')
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
                  locale: NS,
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
