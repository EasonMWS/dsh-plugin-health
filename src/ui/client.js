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
    const UPDATE_PATH = '/plugins/dsh-plugin-health/update'
    // The published compatibility table. Hard-coded rather than derived: it is a public URL we own,
    // and a user clicking it should get the site, not something computed from their profile.
    const COMPAT_URL = 'https://easonmws.github.io/dsh-plugin-health/compat/'
    // The control key for this launch, learned from the status snapshot. Held in memory rather than
    // relied on through a cookie: when the host does not pass `Set-Cookie` through to the page, every
    // write fails with a 401 that the UI can only describe as a network problem.
    let controlKey
    const SECTION_SLOT = 'settings.section'
    const SECTION_ID = 'plugin-health'
    const ALERT_SLOT = 'sidebar.footer.action'
    const ALERT_ID = 'plugin-health-alert'
    const NS = 'plugin-health'
    const VIEW_KEY = 'dsh-plugin-health:view'
    const VIEWS = ['daily', 'advanced', 'developer']

    const COLORS = {
      error: 'var(--dph-error, #b42318)', warn: 'var(--dph-warn, #946000)',
      info: 'var(--dph-accent, #245fc5)', ok: 'var(--dph-ok, #18734a)',
    }
    // Local to this settings surface. Never style host buttons, headings or forms globally.
    const PANEL_CSS = `
      .dph-panel { --dph-accent: light-dark(#245fc5,#91b7ff); --dph-error: light-dark(#b42318,#ffaaa1);
        --dph-warn: light-dark(#946000,#eec46a); --dph-ok: light-dark(#18734a,#87d6aa);
        --dph-line: color-mix(in srgb,currentColor 17%,transparent);
        --dph-tint: color-mix(in srgb,currentColor 3%,transparent);
        max-width: 880px; padding: 24px 8px; line-height: 1.6; font-size: 13px; overflow-wrap: anywhere; }
      .dph-panel *, .dph-panel *::before, .dph-panel *::after { box-sizing: border-box; }
      .dph-panel [hidden] { display: none !important; }
      .dph-panel button, .dph-panel select, .dph-panel input { font: inherit; min-height: 36px; max-width: 100%; }
      .dph-panel button, .dph-panel a { transition: background-color 160ms, box-shadow 160ms, opacity 160ms; }
      .dph-panel button:not(:disabled):hover, .dph-panel a:hover { box-shadow: 0 0 0 2px var(--dph-line); }
      .dph-panel button:disabled { opacity: .55; cursor: wait; }
      .dph-panel :is(button,a,input,select):focus-visible { outline: 2px solid var(--dph-accent); outline-offset: 3px; }
      .dph-panel :is(input,select) { border: 1px solid var(--dph-line); border-radius: 9px; padding: 8px 10px;
        background: var(--dph-tint); color: inherit; }
      .dph-panel option { background: Canvas; color: CanvasText; }
      .dph-panel h2, .dph-panel h3, .dph-panel p { margin: 0; }
      .dph-panel h2 { font-size: 22px; letter-spacing: -.03em; line-height: 1.4; }
      .dph-panel h3 { font-size: 14px; font-weight: 650; }
      .dph-panel p + p { margin-top: 8px; }
      .dph-panel .dph-head { display: flex; align-items: center; justify-content: space-between;
        flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
      .dph-panel .dph-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .dph-panel .dph-mode { display: inline-flex; flex-wrap: wrap; gap: 2px; max-width: 100%;
        padding: 2px; border: 1px solid var(--dph-line); border-radius: 9px; background: var(--dph-tint); }
      .dph-panel .dph-mode button { padding: 5px 8px; border-radius: 6px; cursor: pointer;
        border: 1px solid transparent; background: transparent; color: inherit; }
      .dph-panel .dph-mode button[aria-pressed="true"] { border-color: var(--dph-accent);
        background: color-mix(in srgb,var(--dph-accent) 12%,transparent); font-weight: 700; }
      .dph-panel .dph-scan { position: relative; }
      .dph-panel .dph-scan-tip { position: absolute; z-index: 2; inset: 100% auto auto 0;
        width: min(270px, calc(100vw - 48px)); padding: 8px 10px; border: 1px solid var(--dph-line);
        border-radius: 8px; background: Canvas; color: CanvasText; visibility: hidden; }
      .dph-panel .dph-scan:hover .dph-scan-tip, .dph-panel .dph-scan:has(:focus-visible) .dph-scan-tip {
        visibility: visible; }
      .dph-panel .dph-muted { opacity: .74; font-size: 12px; }
      .dph-panel .dph-chip { border: 1px solid var(--dph-line); border-radius: 99px; padding: 2px 8px; font-size: 11px; }
      .dph-panel .dph-card { border: 1px solid var(--dph-line); border-radius: 14px; padding: 16px; margin: 16px 0; }
      .dph-panel .dph-card > p, .dph-panel .dph-card > form { margin-top: 10px; }
      .dph-panel .dph-disclosure { border: 1px solid var(--dph-line); border-radius: 12px; margin: 10px 0; overflow: hidden; }
      .dph-panel .dph-trigger { display: flex; align-items: center; gap: 10px; width: 100%; border: 0;
        background: transparent; color: inherit; text-align: start; padding: 13px 14px; cursor: pointer; }
      .dph-panel .dph-trigger:hover { background: var(--dph-tint); box-shadow: none !important; }
      .dph-panel .dph-trigger:focus-visible { outline-offset: -3px; }
      .dph-panel .dph-trigger-title { flex: 1; min-width: 0; font-weight: 600; }
      .dph-panel .dph-chevron { flex: 0 0 8px; width: 8px; height: 8px; border-right: 1.5px solid;
        border-bottom: 1.5px solid; transform: rotate(-45deg); transition: transform 200ms ease; }
      .dph-panel [aria-expanded="true"] .dph-chevron { transform: rotate(45deg); }
      .dph-panel .dph-collapse { display: grid; grid-template-rows: 0fr; opacity: 0; visibility: hidden;
        transition: grid-template-rows 220ms ease, opacity 180ms ease, visibility 220ms; }
      .dph-panel .dph-collapse[data-open="true"] { grid-template-rows: 1fr; opacity: 1; visibility: visible; }
      .dph-panel .dph-collapse-clip { min-height: 0; overflow: hidden; }
      .dph-panel .dph-detail-body { padding: 0 14px 14px; }
      .dph-panel .dph-detail-body > * + * { margin-top: 8px; }
      .dph-panel .dph-row { padding: 10px 0; border-bottom: 1px solid var(--dph-line); }
      .dph-panel .dph-row:last-child { border-bottom: 0; }
      .dph-panel .dph-row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
      .dph-panel .dph-row-head strong { flex: 1 1 180px; min-width: 0; font-weight: 550; }
      .dph-panel .dph-failed { border-left: 3px solid var(--dph-error); padding: 10px 12px; margin-top: 10px; background: var(--dph-tint); }
      .dph-panel .dph-metrics { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
      .dph-panel .dph-metric { flex: 1 1 90px; padding: 10px 12px; border: 1px solid var(--dph-line); border-radius: 10px; }
      .dph-panel .dph-metric[data-attention] { border-color: var(--dph-error);
        background: color-mix(in srgb,var(--dph-error) 8%,transparent); }
      .dph-panel .dph-metric-label { display: block; font-size: 12px; font-weight: 600; }
      .dph-panel .dph-search { display: grid; gap: 4px; margin: 4px 0 10px; font-size: 12px; }
      .dph-panel .dph-search input { padding: 7px 9px; font: inherit; font-size: 13px; border: 1px solid var(--dph-line);
        border-radius: 8px; background: transparent; color: inherit; }
      .dph-panel .dph-entry-group + .dph-entry-group { margin-top: 12px; }
      .dph-panel .dph-group-label { font-size: 11px; letter-spacing: .02em; text-transform: none; margin: 6px 0 2px; }
      .dph-panel .dph-metric strong { font-size: 22px; line-height: 1.3; display: block; font-variant-numeric: tabular-nums; }
      .dph-panel code { font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
      .dph-panel .dph-code { display: block; padding: 12px; border-radius: 8px; background: var(--dph-tint); margin: 8px 0; }
      .dph-panel .dph-enter { animation: dph-enter 180ms ease-out; }
      @keyframes dph-enter { from { opacity: .5; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      @media (max-width: 520px) {
        .dph-panel { padding: 16px 0; }
        .dph-panel .dph-card { padding: 12px; }
        .dph-panel .dph-trigger { flex-wrap: wrap; gap: 8px; }
        .dph-panel button, .dph-panel a { white-space: normal !important; }
      }
      @media (prefers-reduced-motion: reduce) {
        .dph-panel *, .dph-panel *::before, .dph-panel *::after { animation: none !important; transition: none !important; }
      }
    `
    let disclosureId = 0

    function safeReportUrl(value) {
      try {
        if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/u.test(value)) return undefined
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return undefined
        if (!/^\/[\w.-]+\/[\w.-]+\/issues\/(?:\d+|new)$/u.test(url.pathname)) return undefined
        return url.href
      } catch { return undefined }
    }

    /** Keep the body mounted for a reversible height transition and stable focus/state. */
    function Disclosure({ title, body, badge, severity, defaultOpen = false, revealKey, t }) {
      const [open, setOpen] = React.useState(defaultOpen)
      const [id] = React.useState(() => `dph-detail-${++disclosureId}`)
      React.useEffect(() => { if (revealKey) setOpen(true) }, [revealKey])
      return h('section', { className: 'dph-disclosure' }, [
        h('button', { key: 'toggle', type: 'button', className: 'dph-trigger',
          'aria-expanded': open, 'aria-controls': id, onClick: () => setOpen(value => !value) }, [
          severity ? dot(severity) : null,
          h('span', { key: 'title', className: 'dph-trigger-title' }, title),
          badge ? h('span', { key: 'badge', className: 'dph-muted' }, badge) : null,
          t ? h('span', { key: 'hint', className: 'dph-muted' }, t(open ? 'collapse' : 'details')) : null,
          h('span', { key: 'chevron', className: 'dph-chevron', 'aria-hidden': true }),
        ]),
        h('div', { key: 'body', id, className: 'dph-collapse', 'data-open': String(open),
          'aria-hidden': !open, inert: open ? undefined : '' },
        h('div', { className: 'dph-collapse-clip' }, h('div', { className: 'dph-detail-body' }, body))),
      ])
    }

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
      // 'proxy-env' was removed together with the finding it explained. See src/repair/inspect.js.
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
        technicalDetails: '查看详细信息', operationFailed: '这次操作没有完成，请查看详细信息后重试。',
        scanReadOnly: '扫描为只读。',
        securityScope: '检查安装和启动状态。Health 无法查杀病毒或阻止恶意程序扩散。',
        trialTitle: '试运行前，请确认插件来源可信',
        trialRisk: '这一步会下载、安装并运行插件代码。临时目录不限制它访问当前账号有权限访问的文件、网络或启动其他程序。Health 无法阻止它的恶意行为。来源不明或怀疑有恶意的插件，请取消。',
        trialConfirm: '我信任此插件，开始试运行', trialCancel: '取消试运行',
        reportsUnavailable: '这次没有完成反馈查询，请稍后重试。',
        'severity.error': '会影响使用', 'severity.warn': '建议处理', 'severity.info': '提示',
        collapse: '收起', details: '详情', nextStep: '怎么做：{fix}',
        installedChecked: '安装扫描：{count} 个包',
        reviewInline: '升级预检',
        reviewInlineRun: '检查',
        reviewInlineLabel: '目标 DSH 版本（只读）',
        healthyDoctor: '复制配置检查命令',
        healthyCopied: '命令已复制，粘贴到终端运行',
        errors: '{count} 个错误', warnings: '{count} 个警告', ready: '本次检查未发现问题', attention: '有问题建议处理',
        reviewTitle: '插件清单与升级预检', reviewTarget: '目标 DSH 版本',
        viewLabel: '显示模式',
        'view.daily': '日常检查', 'view.advanced': '进阶诊断', 'view.developer': '开发验证',
        liveActive: '运行中', liveFailed: '激活失败', liveWaiting: '其他状态',
        liveCadence: '页面打开时每 30 秒读取宿主状态，短暂变化可能无法捕获。',
        staleStatus: '刷新未成功，下面保留上次结果。请重新扫描后再操作。',
        infoFindings: '其他检查提示', exportHelp: '导出文件含插件名称和配置标识，分享前请检查内容。',
        previewStale: '配置已变化或刷新失败，请重新预检后使用结果。',
        reviewNetworkFail: '暂时无法获取预检结果，请稍后重试。',
        requestTimeout: '读取超时，请重试。',
        reviewInvalidTarget: '请输入完整版本号，例如 0.2.1-rc.5。',
        liveFailureHelp: '先检查插件更新和注册冲突，处理后重新扫描。',
        developerPreflight: '1. 检查版本声明', developerCombination: '2. 验证可信插件组合',
        developerTrust: '组合验证会安装并执行插件，使用当前系统账号的权限。请只指定可信插件。',
        liveSample: '状态更新时间：{time}', liveChanges: '最近观察到的变化', liveNoChanges: '本次启动期间暂未观察到变化。',
        liveOther: '其余加载条目',
        liveSearch: '搜索',
        liveSearchHint: '按名称或 id 筛选',
        liveNoMatch: '没有匹配的条目。',
        liveOfficial: 'DSH / Cordis 包条目',
        liveUserInstalled: '其他包条目',
        liveCount: '{count} 条',
        liveTransition: '{name}（{id}）：{before} → {after}',
        liveDuplicate: '工具 {tool} 已被注册，宿主拒绝了这次注册。',
        liveDeveloper: '开发验证', liveExport: '下载运行证据',
        liveDeveloperHelp: '用命令行生成预检 JSON，或为可信插件指定组合并验证启动。',
        'review.pending': '等待中', 'review.loading': '加载中', 'review.failed': '激活失败',
        'review.unloading': '卸载中', 'review.absent': '未出现',
        reviewRun: '预检', reviewFail: '预检失败。请输入完整版本号，例如 0.2.1-rc.5。',
        reviewResult: 'DSH {version} · 已判定声明：{judged} 个包 · 声明不匹配且未放行：{count} 个包',
        reviewNoTarget: '请输入目标版本，开始检查版本声明。',
        reviewSnapshot: '下载当前配置快照', reviewActivation: '启动状态（加载条目）',
        reviewNoActivation: '当前宿主未提供可读取的加载状态。',
        reviewLimits: '这里只检查版本声明和可识别的配置层。动态工具、共享文件及启动参数尚未验证。',
        reviewSources: '查看检测范围', reviewPackages: '当前环境的包清单',
        'review.compatible': '声明兼容', 'review.incompatible': '声明不匹配', 'review.exempted': '已有版本豁免',
        'review.undeclared': '没有兼容声明', 'review.unknown': '无法判断', 'review.not-checked': '未检查',
        'review.active': '运行中', 'review.disabled': '已禁用', 'review.not-active': '其他状态',
        reviewCore: '配置中有宿主包副本：{name}@{version}。实际加载来源待验证。',
        reviewDuplicate: '重复插入 {id}（{layer}）',
        reviewSharedWrite: '{packages} 声明写入同一路径 {path}。实际并发行为待验证。',
        reviewOverride: '{id} 的配置覆盖：{before} → {after}',
        reviewRemoved: '后层未保留字段：{keys}', reviewModuleChanged: '后层替换了模块名称。',
        'limit.launch-overlays-not-read': '未读取通过启动参数传入的覆盖层',
        'limit.tool-and-file-behavior-not-tested': '未试跑工具或监测文件读写',
        'limit.unsupported-patch-rows': '跳过了无法静态解释的配置项',
        'limit.unreadable-patch': '无法检查配置层 {detail}',
        'limit.unreadable-package': '有包的声明无法读取',
        'limit.in-box-bundles-not-read': '未读取宿主内置配置层',
        'limit.unsupported-package-name': '跳过了无法识别的包名',
        'limit.exemptions-unreadable': '无法读取版本豁免',
        'limit.unreadable-profile-file': '无法读取 {detail}',
        'limit.invalid-resource-declaration': '有文件访问声明不符合格式',
        scanning: '正在扫描…', rescan: '重新扫描', checking: '正在检查…', checkFailed: '检查失败',
        checkUpdate: '检查更新', checkingUpdate: '正在查询…',
        browseAll: '社区兼容表',
        updateNow: '立即更新',
        updating: '正在更新…',
        updateDone: '已更新到 {version}，重启 DSH 生效',
        updateRestart: '重启 DSH 后生效',
        updateInstallFailed: '更新失败：{error}',
        updateRetry: '重试',
        updateRestartNow: '重启 DSH',
        alertUpdate: '插件健康有新版本 {version}',
        alertUpdateTitle: '点一下打开设置页更新',
  alertOpenFailed: '没能打开设置页，请点侧栏的设置图标',
  alertRetry: '重试',
        updateAvailable: '有新版本 {version}（当前 {current}）',
        updateHowTo: '升级：{command}',
        updateUpToDate: '已是最新版本 {version}',
        updateFailed: '查不到最新版本：{error}',
        updateDenied: '插件界面没有拿到本次启动的密钥，刷新页面即可（重启 DSH 后端口会变）。',
        updateDisabled: '已通过环境变量关闭更新检查',
        checkRetry: 'DSH 刚启动时可能还没准备好，点「重新扫描」再试一次。',
        omitted: '{count} 条提示不影响使用，已省略。', repair: '清理 {count} 项损坏文件',
        repairSafety: '这些项是装坏的文件：只隔离不删除，原文件可以在隔离区找回，执行前会先给你看计划。',
        planning: '正在生成修复计划…', planned: '将要执行的操作', manual: '另有 {count} 项需要你手动处理，不会动。',
        repairFailed: '修复未完成', repairRetry: '重新生成计划',
        repairFailedHelp: '请先查看失败原因。重试会重新检查并生成计划，执行前仍需确认。',
        confirm: '确认修复', cancel: '取消', nothing: '这些问题需要你手动处理，工具不会自动改。', applying: '正在应用…',
        repaired: '已修复 {count} 项', quarantined: '已隔离：{path}', rewritten: '已重写：{path}（备份在隔离区）',
        restoreFrom: '可从这里找回：{path}', restorePreview: '终端恢复预览', acknowledge: '知道了', lastChecked: '上次检查：{time}', unknown: '未知',
        versionProfile: 'DSH {version} · Profile：{profile}', dateLocale: 'zh-CN',
        alertTitle: '查看插件健康检查结果', alertCount: '插件有 {count} 个问题', view: '查看',
        'plan.bundle-manifest-invalid': '把损坏的插件目录移到隔离区。',
        'plan.package-dir-broken': '把不完整或损坏的目录移到隔离区，然后重新安装插件。',
        'plan.patch-empty-entry': '移除顶层空 [] 条目，并备份原始文件。',
        'plan.residue': '把残留文件移到隔离区；可以从那里恢复。',
        rescueTitle: '修复兼容问题',
        rescueWhy: '先在临时 DSH 目录试启动插件。试跑会执行插件代码，使用当前系统账号的权限。启动结果仅覆盖这次试跑。',
        rescueCheck: '查看试运行说明',
        rescueChecking: '正在临时 DSH 目录里安装并启动，大约需要 30~60 秒…',
        rescueApplying: '正在重新验证一次，然后写入配置（确保放行的正是刚刚验证过的状态）…',
        rescueFailed: '检查失败：{error}',
        rescueVerdictOk: '已通过独立启动检查',
        rescueVerdictBroken: '本次未能启动',
        rescueVerdictUnknown: '检查结果不确定',
        rescueTestedOn: '测试宿主：DSH {version}',
        rescueApply: '临时放行',
        rescueApplied: '已临时放行',
        rescueAppliedWhat: '下次启动时，版本门禁会放行此插件。请在当前配置中确认它是否正常工作。你可以在「临时放行记录」撤销。',
        rescueRecheck: '重新检查',
        rescueVerdictRuns: '插件在本次临时配置中成功启动。当前插件组合和具体功能尚未验证。',
        rescueVerdictBrokenWhy: '本次试运行启动失败，未写入版本放行记录。试运行代码可能已经产生其他影响。',
        rescueVerdictInconclusive: '本次试运行没有得出结论，未写入版本放行记录。试运行代码可能已经产生其他影响。',
        rescuePluginWhy: '插件声明的支持范围不包含当前 DSH 版本。可信插件可在临时目录试启动，结果仅覆盖本次启动。',
        rescuePreparing: '正在准备交给 AI 的上下文…',
        rescueCheckingReportsNow: '正在查询上游是否已有报告…',
        rescueConfirmTitle: '放行前请确认',
        rescueConfirmWhat: '即将为 {name}@{version} 在 DSH {host} 上写入一条「精确版本豁免」。',
        rescueConfirmWill1: '只写入官方支持的一条豁免记录，不修改插件本身，不改 npm 上的包。',
        rescueConfirmWill2: 'DSH 下次启动会跳过这个插件的版本限制，本次临时目录试运行已成功启动。',
        rescueConfirmWill3: '可以在「临时放行记录」撤销这条许可；这不会撤销插件此前造成的影响。',
        rescueConfirmLimit: '但这只是放行门禁，不等于官方支持。插件的具体功能是否都正常，仍需你自己观察；作者发布正式支持版本后，请撤销并升级。',
        rescueConfirmYes: '确认放行',
        rescueFallbackWhy: '暂时无法自动解决，可以选择下一步：',
        rescueChoiceOffTitle: '关掉它，继续用 DSH',
        rescueChoiceOffWhat: '写入下次启动时禁用的设置，保留插件文件。不会立即终止正在运行的插件。',
        rescueChoiceOffAction: '关掉',
        rescueChoiceAiTitle: '让 AI 试着修',
        rescueChoiceAiWhat: '这一步只整理提示词，供你交给自己的 AI，不会自动调用模型或发送。',
        rescueChoiceAiAction: '生成提示词',
        rescueDisabledTitle: '已关掉',
        rescueDisabledWhat: '重启 DSH 后它不再加载。作者发布兼容版本后重装即可。',
        rescueAskAi: '让我的 AI 帮忙分析',
        rescueCheckReports: '看上游是否已有人报过',
        rescueAiReady: 'AI 上下文已准备好（尚未发送）',
        rescueAiReadyWhat: '已把你的插件版本、声明范围、隔离测试结果整理成一份提示词。这个工具不会调用任何模型、不花你的 token；把下面这份 prompt 粘给你自己的 AI 即可，发不发由你决定。',
        rescueCopyPrompt: '复制 prompt',
        rescueCopied: '已复制',
        rescueReportsFound: '这次找到了相关反馈，可以打开查看',
        rescueNoReports: '这次没有找到相关反馈',
        rescueNoReportsWhat: '已经准备好一份 issue 正文（只写我们能证明的事实：声明范围、宿主版本、隔离测试结论）。',
        rescueOpenIssue: '打开新建 issue 页面',
        rescueNoFile: '这个工具不会替你提交 issue —— 请自己确认内容后再发。',
        recordsTitle: '临时放行记录',
        recordsWhy: '以下版本暂时跳过了兼容性限制。更换本机插件版本后，请重新检查这些记录。',
        recordsOn: '在 DSH {host} 上',
        recordsStale: '本机已安装版本变为 {installed}，请重新检查这条临时许可。',
        recordsUndo: '撤销',
      },
      en: {
        nav: 'Plugin health',
        technicalDetails: 'View diagnostic details', operationFailed: 'This operation did not complete. Review the details before trying again.',
        scanReadOnly: 'Scanning is read-only.',
        securityScope: 'Checks installation and startup. Health cannot remove malware or stop it spreading.',
        trialTitle: 'Confirm you trust the plugin before running it',
        trialRisk: 'This downloads, installs and executes plugin code. The temporary directory does not restrict access to files, networks or other programs available to your account. Health cannot block malicious behavior. Cancel if the source is unknown or the plugin seems malicious.',
        trialConfirm: 'I trust this plugin; run the check', trialCancel: 'Cancel startup check',
        reportsUnavailable: 'This search did not complete. Please try again later.',
        'severity.error': 'Affects usage', 'severity.warn': 'Needs attention', 'severity.info': 'Information',
        collapse: 'Collapse', details: 'Details', nextStep: 'Next step: {fix}',
        installedChecked: 'Installation scan: {count} packages',
        reviewInline: 'Upgrade preview',
        reviewInlineRun: 'Check',
        reviewInlineLabel: 'Target DSH version (read-only)',
        healthyDoctor: 'Copy configuration check command',
        healthyCopied: 'Command copied — paste it into a terminal',
        errors: 'Errors: {count}', warnings: 'Warnings: {count}', ready: 'No issues found in this scan', attention: 'Issues need attention',
        reviewTitle: 'Plugin inventory and upgrade preview', reviewTarget: 'Target DSH version',
        viewLabel: 'View',
        'view.daily': 'Daily', 'view.advanced': 'Advanced', 'view.developer': 'Developer',
        liveActive: 'Running', liveFailed: 'Activation failed', liveWaiting: 'Other states',
        liveCadence: 'Reads host state every 30 seconds while this page is open. Brief changes may be missed.',
        staleStatus: 'Refresh failed. The last results remain below. Rescan before taking action.',
        infoFindings: 'Other scan findings', exportHelp: 'Exports contain plugin names and configuration identifiers. Review them before sharing.',
        previewStale: 'Configuration changed or refresh failed. Run the preview again before relying on it.',
        reviewNetworkFail: 'The preview is unavailable. Please try again shortly.',
        requestTimeout: 'The read timed out. Please try again.',
        reviewInvalidTarget: 'Enter an exact version such as 0.2.1-rc.5.',
        liveFailureHelp: 'Check for plugin updates and registration conflicts, then rescan.',
        developerPreflight: '1. Check version declarations', developerCombination: '2. Verify a trusted combination',
        developerTrust: 'Combination checks install and execute plugins with your OS account permissions. Only specify trusted plugins.',
        liveSample: 'Status updated at {time}', liveChanges: 'Recently observed changes', liveNoChanges: 'No changes observed in this host session yet.',
        liveOther: 'Other loader entries',
        liveSearch: 'Search',
        liveSearchHint: 'Filter by name or id',
        liveNoMatch: 'Nothing matches.',
        liveOfficial: 'DSH / Cordis package entries',
        liveUserInstalled: 'Other package entries',
        liveCount: '{count} entries',
        liveTransition: '{name} ({id}): {before} → {after}',
        liveDuplicate: 'The host rejected the registration because tool {tool} is already registered.',
        liveDeveloper: 'Developer verification', liveExport: 'Download runtime evidence',
        liveDeveloperHelp: 'Use the CLI for preflight JSON or to verify startup for a combination of trusted plugins.',
        'review.pending': 'Waiting', 'review.loading': 'Loading', 'review.failed': 'Activation failed',
        'review.unloading': 'Unloading', 'review.absent': 'Absent',
        reviewRun: 'Check target', reviewFail: 'The preview failed. Enter an exact version such as 0.2.1-rc.5.',
        reviewResult: 'DSH {version} · Packages with assessed declarations: {judged} · Package mismatches without exemptions: {count}',
        reviewNoTarget: 'Enter a target version to check compatibility declarations.',
        reviewSnapshot: 'Download current snapshot', reviewActivation: 'Startup status (loader entries)',
        reviewNoActivation: 'Live loader state is unavailable on this host.',
        reviewLimits: 'This checks version declarations and recognized configuration layers. Dynamic tools, shared files and launch arguments are unverified.',
        reviewSources: 'View scan coverage', reviewPackages: 'Packages in this setup',
        'review.compatible': 'Declared compatible', 'review.incompatible': 'Version mismatch', 'review.exempted': 'Version exemption',
        'review.undeclared': 'No compatibility declaration', 'review.unknown': 'Unknown', 'review.not-checked': 'Unchecked',
        'review.active': 'Running', 'review.disabled': 'Disabled', 'review.not-active': 'Other states',
        reviewCore: 'Host package copy in profile: {name}@{version}. Effective resolution is unverified.',
        reviewDuplicate: 'Repeated insert ID {id} ({layer})',
        reviewSharedWrite: '{packages} declare writes to {path}. Concurrent behavior is unverified.',
        reviewOverride: 'Configuration override for {id}: {before} → {after}',
        reviewRemoved: 'Fields omitted by the later layer: {keys}', reviewModuleChanged: 'The later layer changes the module name.',
        'limit.launch-overlays-not-read': 'Launch argument overlays were outside the scan',
        'limit.tool-and-file-behavior-not-tested': 'Tool calls and file access were untested',
        'limit.unsupported-patch-rows': 'Some patch rows could not be interpreted statically',
        'limit.unreadable-patch': 'Could not check configuration layer {detail}',
        'limit.unreadable-package': 'Some package manifests could not be read',
        'limit.in-box-bundles-not-read': 'In-box bundle layers were outside the scan',
        'limit.unsupported-package-name': 'Unrecognized package names were skipped',
        'limit.exemptions-unreadable': 'Could not read version exemptions',
        'limit.unreadable-profile-file': 'Could not read {detail}',
        'limit.invalid-resource-declaration': 'Some file access declarations were invalid',
        scanning: 'Scanning…', rescan: 'Rescan', checking: 'Checking…', checkFailed: 'Check failed',
        checkUpdate: 'Check for updates', checkingUpdate: 'Checking…',
        browseAll: 'Community compatibility',
        updateNow: 'Update now',
        updating: 'Updating…',
        updateDone: 'Updated to {version} — restart DSH to load it',
        updateRestart: 'Restart DSH to load it',
        updateInstallFailed: 'Update failed: {error}',
        updateRetry: 'Try again',
        updateRestartNow: 'Restart DSH',
        alertUpdate: 'Plugin health {version} available',
        alertUpdateTitle: 'Open Settings to update',
  alertOpenFailed: 'Could not open Settings, use the settings icon in the sidebar',
  alertRetry: 'Retry',
        updateAvailable: 'Version {version} is available (you have {current})',
        updateHowTo: 'Upgrade with: {command}',
        updateUpToDate: 'You are on the latest version, {version}',
        updateFailed: 'Could not reach the registry: {error}',
        updateDenied: 'The panel could not obtain this launch\'s key. Reload the page — a DSH restart changes the port.',
        updateDisabled: 'Update checks are off (environment variable)',
        checkRetry: 'DSH may still be starting. Select Rescan to try again.',
        omitted: 'Informational findings omitted: {count}. They do not affect usage.', repair: 'Clean up {count} broken file(s)',
        repairSafety: 'These are files left behind by a failed install: they are quarantined rather than deleted, can be restored, and you review the plan before anything happens.',
        planning: 'Preparing repair plan…', planned: 'Planned actions', manual: 'Items requiring manual action: {count}. They will not be changed.',
        repairFailed: 'Repair did not complete', repairRetry: 'Build a new plan',
        repairFailedHelp: 'Review the reason below. Retrying rechecks the files and builds a plan for confirmation.',
        confirm: 'Confirm repair', cancel: 'Cancel', nothing: 'These issues need manual action. The tool will not change them automatically.', applying: 'Applying…',
        repaired: 'Items repaired: {count}', quarantined: 'Quarantined: {path}', rewritten: 'Rewritten: {path} (backup in quarantine)',
        restoreFrom: 'Restore files from: {path}', restorePreview: 'Preview restore in a terminal', acknowledge: 'Done', lastChecked: 'Last checked: {time}', unknown: 'Unknown',
        versionProfile: 'DSH {version} · Profile: {profile}', dateLocale: 'en',
        alertTitle: 'View plugin health results', alertCount: 'Plugin issues: {count}', view: 'View',
        'plan.bundle-manifest-invalid': 'Move the broken bundle directory to quarantine.',
        'plan.package-dir-broken': 'Move the incomplete or broken directory to quarantine, then reinstall the package.',
        'plan.patch-empty-entry': 'Remove top-level empty [] entries and back up the original file.',
        'plan.residue': 'Move the residue file to quarantine; it can be restored from there.',
        rescueTitle: 'Fix compatibility',
        rescueWhy: 'Run a startup check in a temporary DSH directory first. This executes plugin code with your OS account permissions. The result covers this trial.',
        rescueCheck: 'Review startup check',
        rescueChecking: 'Installing and starting in a temporary DSH directory — about 30–60 seconds…',
        rescueApplying: 'Verifying once more, then writing the configuration so the exemption covers exactly what was just proven to boot…',
        rescueFailed: 'Check failed: {error}',
        rescueVerdictOk: 'Passed the standalone startup check',
        rescueVerdictBroken: 'Did not start in this trial',
        rescueVerdictUnknown: 'The check was inconclusive',
        rescueTestedOn: 'Tested on DSH {version}',
        rescueApply: 'Exempt temporarily',
        rescueApplied: 'Temporarily exempted',
        rescueAppliedWhat: 'The version gate will allow this plugin on the next start. Check that it works with your profile. You can undo the exemption in the rescue records.',
        rescueRecheck: 'Check again',
        rescueVerdictRuns: 'The plugin started in the temporary profile. Your plugin combination and individual features are unverified.',
        rescueVerdictBrokenWhy: 'Startup failed in this trial. No version exemption was written. The code that ran may have had other effects.',
        rescueVerdictInconclusive: 'This trial was inconclusive. No version exemption was written. The code that ran may have had other effects.',
        rescuePluginWhy: 'The plugin does not declare support for this DSH version. A trusted plugin can be tried in a temporary directory; the result covers that startup only.',
        rescuePreparing: 'Preparing the context to hand to your AI…',
        rescueCheckingReportsNow: 'Checking whether upstream already has a report…',
        rescueConfirmTitle: 'Confirm before exempting',
        rescueConfirmWhat: 'This will write one exact-version exemption for {name}@{version} on DSH {host}.',
        rescueConfirmWill1: 'Only one exemption entry is written — the plugin itself and anything on npm are untouched.',
        rescueConfirmWill2: 'The next DSH launch skips the plugin’s version check. It started successfully in this temporary-directory trial.',
        rescueConfirmWill3: 'Revoke the permission under Temporary exemptions. This does not undo earlier effects of the plugin.',
        rescueConfirmLimit: 'This only lets the gate through; it is not official support. Whether every feature works is still for you to observe, and you should revoke it once the author ships a supported release.',
        rescueConfirmYes: 'Exempt it',
        rescueFallbackWhy: 'Automatic recovery is unavailable for now. Choose a next step:',
        rescueChoiceOffTitle: 'Turn it off, keep using DSH',
        rescueChoiceOffWhat: 'Disables it for the next launch and keeps its files. This does not immediately stop running plugin code.',
        rescueChoiceOffAction: 'Turn off',
        rescueChoiceAiTitle: 'Let AI try to fix it',
        rescueChoiceAiWhat: 'Prepares a prompt for your own AI. This step does not call a model or send the prompt.',
        rescueChoiceAiAction: 'Generate prompt',
        rescueDisabledTitle: 'Turned off',
        rescueDisabledWhat: 'It will not load after a restart. Reinstall once the author ships a compatible version.',
        rescueAskAi: 'Ask my AI to analyse it',
        rescueCheckReports: 'See whether upstream already knows',
        rescueAiReady: 'AI context is ready (nothing sent)',
        rescueAiReadyWhat: 'Plugin versions, declared ranges and the temporary-directory trial result are prepared for your AI. This action does not call a model or send the prompt. Review it before sharing.',
        rescueCopyPrompt: 'Copy prompt',
        rescueCopied: 'Copied',
        rescueReportsFound: 'This search found related reports you can open',
        rescueNoReports: 'No matching reports found in this search',
        rescueNoReportsWhat: 'An issue draft contains the declared ranges, DSH version and temporary-directory trial result for you to review.',
        rescueOpenIssue: 'Open the new-issue page',
        rescueNoFile: 'This tool does not file the issue for you — review it, then post it yourself.',
        recordsTitle: 'Temporary exemptions',
        recordsWhy: 'These versions temporarily skip compatibility checks. Review the records after changing the installed plugin version.',
        recordsOn: 'on DSH {host}',
        recordsStale: 'Installed version changed to {installed}; review this temporary permission.',
        recordsUndo: 'Revoke',
      },
    }
    // Wording is selected independently of the checks and permissions. Every view sees the
    // same failures and execution warnings; simpler views explain the consequence first.
    const AUDIENCE_COPY = {
      zh: {
        daily: {
          reviewNoActivation: '暂时无法读取插件是否启动，请稍后重新检查。',
          liveDuplicate: '功能名称「{tool}」被重复使用，DSH 因此没有启动这个插件。',
          liveFailureHelp: '先看看这个插件有没有新版，处理后点「重新扫描」。',
          versionProfile: 'DSH {version} · 当前环境：{profile}',
          repairSafety: '处理前会列出要改动的内容。损坏文件会移到备份位置，方便找回。',
          restoreFrom: '备份保存在：{path}', quarantined: '已移到备份位置：{path}',
          'plan.bundle-manifest-invalid': '把损坏插件的文件夹移到备份位置。',
          'plan.package-dir-broken': '备份不完整的插件文件，之后可重新安装。',
          'plan.patch-empty-entry': '备份设置文件，再清理其中的空白记录。',
          'plan.residue': '把上次安装留下的文件移到备份位置。',
          recordsTitle: '允许尝试启动的插件', recordsWhy: '这些插件暂时跳过了版本限制。如果使用有问题，可以在这里取消。',
          recordsUndo: '取消允许',
          rescueTitle: '插件版本不合适',
          rescueWhy: '试运行会实际运行插件，能访问你这个账号有权限访问的文件和网络。请先阅读说明。',
          rescueTestedOn: '试运行时使用的 DSH：{version}',
          rescueVerdictRuns: '这个插件在本次检查中启动了。还没有检查全部功能，也没有判断它是否有恶意行为。',
          rescueVerdictBrokenWhy: '这次没有启动成功，未保存允许启动的记录。已运行的代码仍可能产生其他影响。',
          rescueVerdictInconclusive: '这次没有得出结论，未保存允许启动的记录。已运行的代码仍可能产生其他影响。',
          rescuePreparing: '正在整理问题说明…', rescueCheckingReportsNow: '正在查找类似反馈…',
          rescuePluginWhy: '这个插件标注支持的 DSH 版本与你正在用的不同。优先看看有没有新版；确认来源可信后，也可以尝试启动检查。',
          rescueApply: '允许下次尝试启动', rescueConfirmTitle: '确认允许这个版本启动',
          rescueConfirmWhat: '将允许 {name}@{version} 在 DSH {host} 下尝试启动。',
          rescueConfirmWill1: '会保存一条允许启动的记录，不会修复插件代码。',
          rescueConfirmWill2: '下次打开 DSH 时会跳过这个插件的版本限制。',
          rescueConfirmWill3: '可以在「允许尝试启动的插件」中取消。',
          rescueConfirmLimit: '这次试运行只证明它当时能启动，不能证明所有功能正常或没有恶意行为。',
          rescueConfirmYes: '确认允许启动', rescueApplied: '已允许下次尝试启动',
          rescueAppliedWhat: '下次打开 DSH 后，请检查这个插件的功能。遇到问题可在下面取消允许。',
          rescueChoiceAiAction: '整理问题说明', rescueAskAi: '整理问题，交给我的 AI',
          rescueChoiceAiWhat: '把问题整理成文字，你可以交给自己使用的 AI。不会自动发送。',
          rescueCopyPrompt: '复制问题说明', rescueAiReady: '问题说明已准备好，尚未发送',
          rescueAiReadyWhat: '已整理插件版本和本次检查结果。复制后可交给你自己的 AI；发送前请检查内容。',
          rescueCheckReports: '查看有没有类似反馈', rescueOpenIssue: '打开反馈页面',
          rescueNoReportsWhat: '已整理一份反馈草稿，你可以检查后发给插件作者。',
          rescueNoFile: '打开页面后，请检查内容并自行决定是否发送。',
          'finding.bundle-manifest-invalid.what': '这个插件的安装信息读不出来，DSH 无法正常识别它。',
          'finding.plugin-incompatible.what': '这个插件标注支持的版本与你正在用的 DSH 不同，因此没有被加载。',
          'finding.bundle-manifest-invalid.fix': '先备份损坏文件，再重新安装这个插件。',
          'finding.package-dir-broken.what': '插件缺少必要的安装信息，可能是安装中断造成的。',
          'finding.package-dir-broken.fix': '先备份不完整的文件，再重新安装插件。',
          'finding.dependency-missing.what': '这个插件需要的配套文件没有安装完整。',
          'finding.dependency-missing.fix': '重新安装这个插件，然后重启 DSH。',
          'finding.patch-invalid.title': '插件设置文件读不出来',
          'finding.patch-invalid.what': '插件设置文件可能被改坏了，DSH 可能无法启动。',
          'finding.patch-invalid.fix': '从备份恢复设置文件；不确定时，请把问题详情交给熟悉 DSH 的人。',
          'finding.patch-not-array.title': '插件设置文件格式不正确',
          'finding.patch-not-array.what': 'DSH 无法按当前格式读取插件设置。',
          'finding.patch-not-array.fix': '从备份恢复设置文件，或请熟悉 DSH 的人协助。',
          'finding.patch-empty-entry.title': '插件设置里有空白记录',
          'finding.patch-empty-entry.what': '编辑插件设置后留下了空白记录，可能干扰启动。',
          'finding.patch-empty-entry.fix': '可以使用下面的清理功能，先备份再移除空白记录。',
          'finding.plugin-manifest-invalid.title': '插件安装信息读不出来',
          'finding.plugin-manifest-invalid.what': '无法读取插件的安装信息，暂时不能判断版本是否合适。',
          'finding.profile-bundles-empty.title': '当前环境还没有启用插件',
          'finding.profile-bundles-empty.what': '刚开始使用或尚未安装插件时，这属于正常情况。',
          'finding.profile-bundles-empty.fix': '如果你记得装过插件，请确认当前使用环境是否选对。',
          'finding.profile-missing.title': '找不到当前使用环境',
          'finding.profile-missing.what': '当前环境的文件夹不存在。',
          'finding.profile-missing.fix': '确认选对了使用环境，再重新启动 DSH。',
          'finding.profile-manifest-missing.title': '当前环境的设置文件丢失',
          'finding.profile-manifest-missing.what': '缺少 DSH 读取当前环境所需的设置文件。',
          'finding.profile-manifest-invalid.title': '当前环境的设置文件损坏',
          'finding.profile-manifest-invalid.what': 'DSH 读不懂当前环境的设置文件。',
        },
        advanced: {
          liveChanges: '最近的启动状态变化',
          liveDuplicate: '名称为 {tool} 的功能重复，DSH 拒绝了后一次注册。',
          liveFailureHelp: '检查插件更新及重复功能，调整后重新扫描。',
          reviewTitle: '升级前检查', reviewTarget: '准备升级到的 DSH 版本', reviewRun: '检查升级影响',
          reviewNoTarget: '输入准备使用的 DSH 版本，查看哪些插件可能受影响。',
          reviewSnapshot: '下载当前检查记录',
          reviewLimits: '根据插件标注的支持版本和设置文件判断，尚未试用插件功能。',
          'review.exempted': '已允许跳过版本检查', 'review.undeclared': '没有标注支持版本',
          'review.incompatible': '未标注支持此版本', 'review.compatible': '标注支持此版本',
          reviewCore: '当前环境中还有一份 DSH 组件 {name}@{version}，尚未确认实际使用的是哪一份。',
          reviewDuplicate: '设置中重复添加了 {id}，出现在 {layer}。',
          reviewSharedWrite: '{packages} 标注会修改同一文件 {path}，是否真的冲突仍需验证。',
          reviewOverride: '{id} 的设置被后面的配置替换：{before} → {after}',
          reviewRemoved: '后面的配置没有保留这些设置项：{keys}', reviewModuleChanged: '后面的配置改用了另一个模块。',
        },
      },
      en: {
        daily: {
          reviewNoActivation: 'Plugin startup information is unavailable. Please check again shortly.',
          liveDuplicate: 'The feature name {tool} is used more than once, so DSH did not start this plugin.',
          liveFailureHelp: 'Check whether this plugin has an update, then select Rescan.',
          versionProfile: 'DSH {version} · Current setup: {profile}',
          repairSafety: 'Review the changes first. Broken files move to a backup location so they can be recovered.',
          restoreFrom: 'Backup location: {path}', quarantined: 'Moved to backup: {path}',
          'plan.bundle-manifest-invalid': 'Move the damaged plugin folder to a backup location.',
          'plan.package-dir-broken': 'Back up incomplete plugin files so the plugin can be reinstalled.',
          'plan.patch-empty-entry': 'Back up settings, then remove empty records.',
          'plan.residue': 'Move files left by an earlier installation to a backup location.',
          recordsTitle: 'Plugins allowed to try starting', recordsWhy: 'These plugins temporarily skip the version check. You can cancel that permission here.',
          recordsUndo: 'Cancel permission',
          rescueTitle: 'Plugin version does not match',
          rescueWhy: 'The trial runs plugin code with access to files and networks available to your account. Read the explanation first.',
          rescueTestedOn: 'DSH used for this trial: {version}',
          rescueVerdictRuns: 'The plugin started in this trial. Its other features and any malicious behavior have not been checked.',
          rescueVerdictBrokenWhy: 'It did not start this time. No startup permission was saved. Code that ran may still have had other effects.',
          rescueVerdictInconclusive: 'This trial was inconclusive. No startup permission was saved. Code that ran may still have had other effects.',
          rescuePreparing: 'Preparing a problem summary…', rescueCheckingReportsNow: 'Looking for similar reports…',
          rescuePluginWhy: 'This plugin does not list support for your DSH version. Check for an update first. If you trust its source, you can try a startup check.',
          rescueApply: 'Allow startup next time', rescueConfirmTitle: 'Confirm this version may start',
          rescueConfirmWhat: 'Allow {name}@{version} to try starting on DSH {host}.',
          rescueConfirmWill1: 'Saves a startup permission. It does not repair plugin code.',
          rescueConfirmWill2: 'The next DSH launch will skip this plugin’s version check.',
          rescueConfirmWill3: 'Cancel it under “Plugins allowed to try starting”.',
          rescueConfirmLimit: 'This trial showed that it started once. Its other features and safety are unverified.',
          rescueConfirmYes: 'Confirm startup permission', rescueApplied: 'Allowed to start next time',
          rescueAppliedWhat: 'Check the plugin’s features after reopening DSH. Cancel the permission below if problems occur.',
          rescueChoiceAiAction: 'Prepare a problem summary', rescueAskAi: 'Prepare a summary for my AI',
          rescueChoiceAiWhat: 'Prepares text for an AI you use. Nothing is sent automatically.',
          rescueCopyPrompt: 'Copy problem summary', rescueAiReady: 'Problem summary ready, not sent',
          rescueAiReadyWhat: 'Plugin versions and this check’s result are ready to copy to your AI. Review the content before sending.',
          rescueCheckReports: 'Look for similar reports', rescueOpenIssue: 'Open the feedback page',
          rescueNoReportsWhat: 'A feedback draft is ready for you to review and send to the plugin author.',
          rescueNoFile: 'Review the content on the page and decide whether to send it.',
          'finding.bundle-manifest-invalid.what': 'The plugin’s installation information cannot be read, so DSH cannot identify it.',
          'finding.plugin-incompatible.what': 'The plugin lists support for a different DSH version, so it was not loaded.',
          'finding.bundle-manifest-invalid.fix': 'Back up the damaged files, then reinstall the plugin.',
          'finding.package-dir-broken.what': 'Required installation information is missing, possibly because installation was interrupted.',
          'finding.package-dir-broken.fix': 'Back up the incomplete files, then reinstall the plugin.',
          'finding.dependency-missing.what': 'Some supporting files this plugin needs are missing.',
          'finding.dependency-missing.fix': 'Reinstall the plugin, then restart DSH.',
          'finding.patch-invalid.title': 'Plugin settings cannot be read',
          'finding.patch-invalid.what': 'The settings file may be damaged, which can prevent DSH from starting.',
          'finding.patch-invalid.fix': 'Restore a settings backup. If unsure, share the details with someone familiar with DSH.',
          'finding.patch-not-array.title': 'Plugin settings have the wrong format',
          'finding.patch-not-array.what': 'DSH cannot read the settings in their current format.',
          'finding.patch-not-array.fix': 'Restore a settings backup, or ask someone familiar with DSH for help.',
          'finding.patch-empty-entry.title': 'Plugin settings contain empty records',
          'finding.patch-empty-entry.what': 'Empty records left after editing settings may interfere with startup.',
          'finding.patch-empty-entry.fix': 'Use the cleanup below to back up settings and remove the empty records.',
          'finding.plugin-manifest-invalid.title': 'Plugin installation information cannot be read',
          'finding.plugin-manifest-invalid.what': 'Version support cannot be checked until the installation information can be read.',
          'finding.profile-bundles-empty.title': 'No plugins are enabled in this setup',
          'finding.profile-bundles-empty.what': 'This is normal when you first start or have not installed plugins yet.',
          'finding.profile-bundles-empty.fix': 'If you remember installing plugins, check that the right setup is selected.',
          'finding.profile-missing.title': 'Current setup was not found',
          'finding.profile-missing.what': 'The folder for this setup does not exist.',
          'finding.profile-missing.fix': 'Check that the right setup is selected, then restart DSH.',
          'finding.profile-manifest-missing.title': 'Current setup settings are missing',
          'finding.profile-manifest-missing.what': 'The settings file DSH needs for this setup is missing.',
          'finding.profile-manifest-invalid.title': 'Current setup settings are damaged',
          'finding.profile-manifest-invalid.what': 'DSH cannot read the settings for this setup.',
        },
        advanced: {
          liveChanges: 'Recent startup changes',
          liveDuplicate: 'The feature name {tool} is duplicated. DSH rejected the later registration.',
          liveFailureHelp: 'Check plugin updates and duplicate features, then rescan after making changes.',
          reviewTitle: 'Before you upgrade', reviewTarget: 'DSH version you plan to use', reviewRun: 'Check upgrade impact',
          reviewNoTarget: 'Enter the DSH version you plan to use to check which plugins may be affected.',
          reviewSnapshot: 'Download current check record',
          reviewLimits: 'Checks the support versions and settings listed by plugins. Plugin features have not been tried.',
          'review.exempted': 'Allowed to skip the version check', 'review.undeclared': 'No supported versions listed',
          'review.incompatible': 'Support not listed for this version', 'review.compatible': 'Lists support for this version',
          reviewCore: 'This setup contains another copy of DSH component {name}@{version}. The copy actually used is unverified.',
          reviewDuplicate: 'Settings add {id} more than once in {layer}.',
          reviewSharedWrite: '{packages} list writes to the same file {path}. An actual conflict is unverified.',
          reviewOverride: 'Later settings replace {id}: {before} → {after}',
          reviewRemoved: 'The later settings omit these fields: {keys}', reviewModuleChanged: 'The later settings select another module.',
        },
      },
    }
    for (const [language, modes] of Object.entries(AUDIENCE_COPY)) {
      for (const [view, entries] of Object.entries(modes)) {
        for (const [key, value] of Object.entries(entries)) dictionaries[language][`audience.${view}.${key}`] = value
      }
    }
    // The host locale registry uses flat keys and owns fallback and live language changes.
    for (const [language, findings] of Object.entries({ zh: COPY, en: COPY_EN })) {
      for (const [id, fields] of Object.entries(findings)) {
        for (const [field, text] of Object.entries(fields)) dictionaries[language][`finding.${id}.${field}`] = text
      }
    }

    /** Poll the host snapshot; the route is cheap and cached server-side for a few seconds. */
    /**
     * POST JSON to one of this plugin's write routes.
     *
     * The control key is minted per launch and handed to the page as a cookie. Cookies are scoped by
     * host, not port, so when DSH restarts on a different port the browser keeps sending the previous
     * launch's key — every write then fails with 401 until something re-issues the cookie. A reload
     * would fix it, but being asked to reload after a restart is a bad answer: on a 401 this refreshes
     * the key from the status route (which is what issues the cookie) and retries exactly once.
     * @param {string} path
     * @param {object} body
     * @returns {Promise<object>} the parsed response.
     */
    async function readSnapshot(path) {
      const controller = new AbortController()
      let timer
      try {
        return await Promise.race([
          (async () => {
            const response = await fetch(path, { headers: { accept: 'application/json' },
              credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
            if (!response.ok) {
              const error = new Error(`HTTP ${response.status}`)
              error.status = response.status
              throw error
            }
            return response.json()
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('requestTimeout')
              reject(error)
              controller.abort()
            }, 15_000)
          }),
        ])
      } finally { clearTimeout(timer) }
    }

    async function postWrite(path, body) {
      const send = () => fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(controlKey === undefined ? {} : { 'x-plugin-health-key': controlKey }),
        },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(body ?? {}),
      })
      /** Re-read the status snapshot, which is the only thing that knows this launch's key. */
      const refreshKey = async () => {
        try {
          const data = await readSnapshot(STATUS_PATH)
          if (typeof data?.key === 'string' && data.key !== '') controlKey = data.key
        } catch { /* the retry below will report the failure */ }
      }
      if (controlKey === undefined) await refreshKey()
      let response = await send()
      if (response.status === 401) {
        // A stale or absent key: refresh once and retry once. Any other status is a real answer.
        await refreshKey()
        response = await send()
      }
      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try { detail = (await response.json()).error ?? detail } catch { /* keep the status text */ }
        throw new Error(detail)
      }
      return response.json()
    }

    function useStatus(intervalMs = 30000) {
      const [state, setState] = React.useState({ loading: true, error: undefined, data: undefined })
      const request = React.useRef({ sequence: 0, alive: true, pending: false })
      const reload = React.useCallback(async (fresh = false) => {
        const sequence = ++request.current.sequence
        request.current.pending = true
        try {
          const data = await readSnapshot(fresh === true ? `${STATUS_PATH}?fresh=1` : STATUS_PATH)
          if (request.current.alive && sequence === request.current.sequence) {
            setState({ loading: false, error: undefined, data })
          }
        } catch (error) {
          if (request.current.alive && sequence === request.current.sequence) {
            setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }))
          }
        } finally {
          if (sequence === request.current.sequence) request.current.pending = false
        }
      }, [])
      React.useEffect(() => {
        request.current.alive = true
        const load = async () => {
          if (!request.current.alive || request.current.pending || (typeof document !== 'undefined' && document.hidden)) return
          await reload()
        }
        load()
        const timer = setInterval(load, intervalMs)
        return () => {
          request.current.alive = false
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
    /**
     * Rescue flow. Phases are explicit so the component can render exactly one action set:
     *
     *   idle → rehearsing → rehearsed → confirming → applying → done
     *
     * `confirming` exists so a write never happens on the same click that reveals its
     * consequences; the user restates the trade-off before the exemption is written.
     */
    /**
     * Ask the host for a fresh update check.
     *
     * The boot-time check is silent by design; this is the path a user drives. Deliberately not
     * optimistic: the state shown afterwards is whatever the host reported, including a failure.
     */
    function useUpdate(reload, t) {
      const [phase, setPhase] = React.useState('idle')
      const [state, setState] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [install, setInstall] = React.useState(undefined)
      const busy = React.useRef(false)
      const check = React.useCallback(async () => {
        if (busy.current) return
        busy.current = true
        setPhase('checking')
        setError(undefined)
        try {
          setState(await postWrite(UPDATE_PATH, {}))
          setPhase('done')
          await reload()
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          // A refused key is not a network problem, and saying so costs the user a pointless
          // investigation into their connection.
          setError(/control key/u.test(message) ? t('updateDenied') : message)
          setPhase('failed')
        } finally { busy.current = false }
      }, [reload, t])
      /**
       * Install the version the check found.
       *
       * Deliberately not optimistic: the result rendered afterwards is whatever the host says is on
       * disk. A successful install still needs a restart, and the panel says so rather than implying
       * the new code is already running.
       */
      const installNow = React.useCallback(async (version) => {
        if (busy.current) return
        busy.current = true
        setPhase('installing')
        setError(undefined)
        setInstall(undefined)
        try {
          const result = await postWrite(UPDATE_PATH, { action: 'install', version })
          setInstall(result)
          setPhase(result?.phase === 'failed' ? 'installFailed' : 'installed')
          if (result?.phase !== 'failed') await reload()
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          setError(/control key/u.test(message) ? t('updateDenied') : message)
          setPhase('installFailed')
        } finally { busy.current = false }
      }, [reload, t])
      return { phase, state, error, install, check, installNow }
    }

    function useRescue(reload) {
      const [phase, setPhase] = React.useState('idle')
      const [verdict, setVerdict] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [applied, setApplied] = React.useState(undefined)
      const [handoffResult, setHandoffResult] = React.useState(undefined)
      const [reportResult, setReportResult] = React.useState(undefined)
      const [disabled, setDisabled] = React.useState(undefined)
      const [copied, setCopied] = React.useState(false)
      const call = React.useCallback((action, body) => postWrite(`${RESCUE_PATH}/${action}`, body), [])
      const rehearse = React.useCallback(async (plugin) => {
        setError(undefined); setApplied(undefined); setVerdict(undefined)
        setHandoffResult(undefined); setReportResult(undefined); setPhase('rehearsing')
        try {
          const result = await call('rehearse', plugin)
          setVerdict(result)
          setPhase('rehearsed')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('idle')
        }
      }, [call])
      /** Ask for confirmation instead of writing: the consequences are shown first. */
      const beginConfirm = React.useCallback(() => setPhase('confirming'), [])
      const cancel = React.useCallback(() => setPhase('rehearsed'), [])
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
      const handoff = React.useCallback(async (body) => {
        setPhase('handoff'); setError(undefined)
        try {
          setHandoffResult(await call('handoff', body))
          setPhase('rehearsed')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('rehearsed')
        }
      }, [call])
      const report = React.useCallback(async (body) => {
        setPhase('report'); setError(undefined)
        try {
          setReportResult(await call('report', body))
          setPhase('rehearsed')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('rehearsed')
        }
      }, [call])
      /**
       * Copy the prepared prompt. The clipboard write happens only on this click — the tool
       * has already written the file, and this just saves the user from hunting for it.
       */
      const copyPrompt = React.useCallback(async () => {
        try {
          await navigator.clipboard.writeText(handoffResult?.prompt ?? '')
          setCopied(true)
        } catch {
          setCopied(false)
          setError('clipboard is unavailable; open prompt.md from the folder shown above')
        }
      }, [handoffResult])
      const reset = React.useCallback(() => {
        setPhase('idle'); setVerdict(undefined); setError(undefined); setApplied(undefined)
        setHandoffResult(undefined); setReportResult(undefined); setCopied(false); setDisabled(undefined)
      }, [])
      /** Revoke one recorded exemption; the caller re-reads the status afterwards. */
      const undo = React.useCallback(async (target) => {
        return call('undo', typeof target === 'string' ? { key: target } : target ?? {})
      }, [call])
      /**
       * Switch the plugin off so DSH keeps working. Offered as the honest alternative when a
       * rescue failed: an unusable plugin should not stay in the way of a usable host.
       */
      const disable = React.useCallback(async (body) => {
        setPhase('disabling'); setError(undefined)
        try {
          const result = await call('disable', body)
          setDisabled(result)
          setPhase('disabled')
          if (typeof reload === 'function') await reload()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('rehearsed')
        }
      }, [call, reload])
      return {
        phase, verdict, applied, error, handoffResult, reportResult, copied, disabled,
        rehearse, beginConfirm, cancel, apply, handoff, report, copyPrompt, reset, undo, disable,
      }
    }

    /**
     * Button hierarchy.
     *
     * Colour carries meaning, so the variants are named for intent rather than hue: a
     * destructive action must never be the green one, or the eye reads "safe" and clicks it.
     *
     *   primary    the next step in the current flow            (filled, accent)
     *   secondary  an alternative that is equally safe          (outline)
     *   danger     changes or removes something                 (filled, muted red)
     *
     * `check` uses the neutral accent because a read-only rehearsal changes nothing; only
     * the action that follows it gets the filled treatment.
     */
    const BUTTON = {
      primary: { background: '#245fc5', color: '#fff', border: 0, weight: 600 },
      danger: { background: '#946000', color: '#fff', border: 0, weight: 600 },
      secondary: { background: 'transparent', color: 'inherit', border: '1px solid rgba(128,128,128,.38)', weight: 400 },
    }

    function buttonStyle(variant = 'secondary', { compact = false } = {}) {
      const spec = BUTTON[variant] ?? BUTTON.secondary
      return {
        border: spec.border,
        borderRadius: 8,
        padding: compact ? '5px 11px' : '8px 14px',
        cursor: 'pointer',
        background: spec.background,
        color: spec.color,
        font: 'inherit',
        fontSize: compact ? 12 : 13,
        fontWeight: spec.weight,
        whiteSpace: 'nowrap',
      }
    }

    /**
     * One incompatible plugin. The flow is deliberately linear so the page never shows a
     * choice whose consequence is unclear:
     *
     *   idle → [检查能不能救] → rehearsed
     *   rehearsed + runs   → [临时放行] → confirm → done
     *   rehearsed + broken → [让 AI 分析] [查看已有报告] [重新检查]
     *
     * A broken verdict deliberately offers no exemption button at all: exempting a plugin
     * that cannot boot hides a real breakage behind a gate that no longer warns.
     */
    function RescueCard({ plugin, reload, technical, t }) {
      const rescue = useRescue(reload)
      const [trial, setTrial] = React.useState(false)
      const trialRef = React.useRef(null)
      const trialPending = React.useRef(false)
      React.useEffect(() => { if (trial) trialRef.current?.focus() }, [trial])
      const busy = ['rehearsing', 'applying', 'confirming', 'handoff', 'report', 'disabling'].includes(rescue.phase)
      const showResult = rescue.verdict !== undefined
      const canApply = rescue.verdict?.canApply === true
      const color = rescue.verdict === undefined
        ? COLORS.warn
        : canApply ? COLORS.ok : rescue.verdict.verdict === 'broken' ? COLORS.error : COLORS.warn
      const verdictTitle = rescue.verdict?.verdict === 'runs' ? t('rescueVerdictOk')
        : rescue.verdict?.verdict === 'broken' ? t('rescueVerdictBroken') : t('rescueVerdictUnknown')

      /**
       * The confirmation step: restate exactly what will change before anything is written.
       *
       * The panel is long enough that this block lands below the fold on a laptop screen, and a
       * decision the user cannot see is a decision they cannot make — so it scrolls itself into
       * view when it appears.
       */
      const confirmRef = React.useRef?.(undefined)
      React.useEffect(() => {
        if (rescue.phase !== 'confirming') return
        const node = confirmRef?.current
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
        }
      }, [rescue.phase])
      const confirmation = rescue.phase === 'confirming'
        ? h('div', {
          key: 'confirm',
          ref: confirmRef,
          style: { marginTop: 10, padding: 12, borderRadius: 8, background: 'rgba(178,106,0,.10)', border: '1px solid rgba(178,106,0,.30)', fontSize: 13, lineHeight: 1.7 },
        }, [
          h('div', { key: 't', style: { fontWeight: 700, color: COLORS.warn, marginBottom: 4 } }, t('rescueConfirmTitle')),
          h('div', { key: 'w', style: { opacity: 0.9 } }, t('rescueConfirmWhat', { name: plugin.name, version: plugin.version, host: rescue.verdict?.hostVersion ?? '' })),
          h('ul', { key: 'l', style: { margin: '6px 0 0', paddingLeft: 18, opacity: 0.85 } }, [
            h('li', { key: 'a' }, t('rescueConfirmWill1')),
            h('li', { key: 'b' }, t('rescueConfirmWill2')),
            h('li', { key: 'c' }, t('rescueConfirmWill3')),
          ]),
          h('div', { key: 'd', style: { marginTop: 6, opacity: 0.8 } }, t('rescueConfirmLimit')),
          h('div', { key: 'b', style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
            h('button', {
              key: 'y',
              onClick: () => rescue.apply({ plugin: plugin.name, version: plugin.version }),
              style: buttonStyle('primary'),
            }, t('rescueConfirmYes')),
            h('button', { key: 'n', onClick: rescue.cancel, style: buttonStyle('secondary') }, t('cancel')),
          ]),
        ])
        : null

      /**
       * Broken or inconclusive: present the two decisions that actually exist, side by side.
       *
       * The point is that neither is a dead end. "Turn it off" restores a usable DSH right now;
       * "hand it to my AI" is a bounded repair attempt. Anything vaguer would leave the user
       * staring at a plugin that does not work with no idea what to do.
       */
      const fallbackActions = rescue.phase === 'rehearsed' && !canApply
        ? h('div', { key: 'fb', style: { marginTop: 12 } }, [
          h('div', { key: 'w', style: { fontSize: 13, opacity: 0.85, lineHeight: 1.6, marginBottom: 10 } }, t('rescueFallbackWhy')),
          h('div', { key: 'choices', style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, [
            // Choice 1: stop using it. Always available, always reversible.
            h('div', {
              key: 'off',
              style: { flex: '1 1 260px', padding: 12, borderRadius: 8, border: '1px solid rgba(128,128,128,.25)' },
            }, [
              h('div', { key: 't', style: { fontSize: 13, fontWeight: 700, marginBottom: 4 } }, t('rescueChoiceOffTitle')),
              h('div', { key: 'd', style: { fontSize: 12, opacity: 0.75, lineHeight: 1.6, marginBottom: 10 } }, t('rescueChoiceOffWhat')),
              h('button', {
                key: 'b',
                onClick: () => rescue.disable({ plugin: plugin.name, entryId: plugin.id }),
                style: buttonStyle('danger'),
              }, t('rescueChoiceOffAction')),
            ]),
            // Choice 2: attempt a repair with the user's own agent, under stated limits.
            h('div', {
              key: 'ai',
              style: { flex: '1 1 260px', padding: 12, borderRadius: 8, border: '1px solid rgba(128,128,128,.25)' },
            }, [
              h('div', { key: 't', style: { fontSize: 13, fontWeight: 700, marginBottom: 4 } }, t('rescueChoiceAiTitle')),
              h('div', { key: 'd', style: { fontSize: 12, opacity: 0.75, lineHeight: 1.6, marginBottom: 10 } }, t('rescueChoiceAiWhat')),
              h('button', {
                key: 'b',
                onClick: () => rescue.handoff({ plugin: plugin.name, version: plugin.version, rehearsalVerdict: rescue.verdict?.verdict }),
                style: buttonStyle('secondary'),
              }, t('rescueChoiceAiAction')),
            ]),
          ]),
          h('div', { key: 'more', style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
            h('button', {
              key: 'rp',
              onClick: () => rescue.report({ plugin: plugin.name, version: plugin.version, rehearsalVerdict: rescue.verdict?.verdict }),
              style: buttonStyle('secondary'),
            }, t('rescueCheckReports')),
            h('button', {
              key: 'again',
              onClick: () => setTrial(true),
              style: buttonStyle('secondary'),
            }, t('rescueRecheck')),
          ]),
        ])
        : null

      /** The plugin is switched off: say so, and say how to reverse it. */
      const disabledNote = rescue.disabled !== undefined && rescue.disabled.disabled === true
        ? h('div', { key: 'off', style: { marginTop: 10, padding: 10, borderRadius: 8, background: 'rgba(178,106,0,.10)', fontSize: 13, lineHeight: 1.6 } }, [
          h('div', { key: 't', style: { fontWeight: 600, color: COLORS.warn } }, t('rescueDisabledTitle')),
          h('div', { key: 'd', style: { marginTop: 4, opacity: 0.9 } }, t('rescueDisabledWhat')),
        ])
        : null

      return h('div', {
        'data-plugin': `${plugin.name}@${plugin.version}`,
        style: { marginTop: 10, padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(128,128,128,.25)' },
      }, [
        h('div', { key: 'h', style: { display: 'flex', gap: 7, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 4 } }, [
          h('span', { key: 'n', style: { fontWeight: 600, fontSize: 13 } }, plugin.name),
          h('span', { key: 'v', style: { fontSize: 12, opacity: 0.55 } }, plugin.version),
        ]),
        h('div', { key: 'w', style: { fontSize: 12.5, opacity: 0.78, lineHeight: 1.55 } },
          t('rescuePluginWhy')),
        trial ? h('section', { key: 'trial', className: 'dph-card', 'data-trial-confirmation': true }, [
          h('h3', { key: 'title', ref: trialRef, tabIndex: -1 }, t('trialTitle')),
          h('p', { key: 'risk' }, t('trialRisk')),
          h('div', { key: 'actions', className: 'dph-actions', style: { marginTop: 12 } }, [
            h('button', { key: 'confirm', type: 'button', style: buttonStyle('primary'), onClick: async () => {
              if (trialPending.current) return
              trialPending.current = true
              setTrial(false)
              try { await rescue.rehearse({ plugin: plugin.name, version: plugin.version }) }
              finally { trialPending.current = false }
            } }, t('trialConfirm')),
            h('button', { key: 'cancel', type: 'button', style: buttonStyle('secondary'), onClick: () => setTrial(false) }, t('trialCancel')),
          ]),
        ]) : null,
        busy
          ? h('div', { key: 'b', style: { marginTop: 10, fontSize: 13, opacity: 0.7 } },
            rescue.phase === 'rehearsing' ? t('rescueChecking')
              : rescue.phase === 'applying' ? t('rescueApplying')
                : rescue.phase === 'handoff' ? t('rescuePreparing')
                  : rescue.phase === 'report' ? t('rescueCheckingReportsNow')
                    : t('rescueApplying'))
          : null,
        rescue.error !== undefined
          ? h('div', { key: 'e', style: { marginTop: 10, fontSize: 13, color: COLORS.warn } },
            technical ? t('rescueFailed', { error: rescue.error }) : [
              h('p', { key: 'message' }, t('operationFailed')),
              h(DiagnosticDetail, { key: 'detail', value: rescue.error, t }),
            ])
          : null,
        showResult
          ? h('div', {
            key: 'r',
            style: { marginTop: 10, padding: 10, borderRadius: 8, fontSize: 13, lineHeight: 1.6, color, background: 'rgba(128,128,128,.08)' },
          }, [
            h('div', { key: 'm', style: { fontWeight: 600 } }, verdictTitle),
            h('div', { key: 'd', style: { marginTop: 4, opacity: 0.9 } },
              rescue.verdict.messageKey === undefined ? rescue.verdict.message : t(rescue.verdict.messageKey)),
            rescue.verdict.hostVersion
              ? h('div', { key: 'h', style: { marginTop: 4, fontSize: 12, opacity: 0.6 } }, t('rescueTestedOn', { version: rescue.verdict.hostVersion }))
              : null,
          ])
          : null,
        confirmation,
        trial ? null : fallbackActions,
        disabledNote,
        rescue.applied !== undefined && rescue.applied.applied === true
          ? h('div', { key: 'a', style: { marginTop: 10, fontSize: 13, color: COLORS.ok, lineHeight: 1.6 } }, [
            h('div', { key: 't', style: { fontWeight: 600 } }, t('rescueApplied')),
            h('div', { key: 'd', style: { marginTop: 4, opacity: 0.9 } }, t('rescueAppliedWhat')),
          ])
          : null,
        rescue.handoffResult !== undefined
          ? h('div', { key: 'ho', style: { marginTop: 10, fontSize: 13, lineHeight: 1.6 } }, [
            h('div', { key: 't', style: { fontWeight: 600, color: COLORS.info } }, t('rescueAiReady')),
            h('div', { key: 'd', style: { marginTop: 4, opacity: 0.85 } }, t('rescueAiReadyWhat')),
            h('div', { key: 'p', style: { marginTop: 6, fontSize: 12, opacity: 0.65, wordBreak: 'break-all' } }, rescue.handoffResult.directory),
            h('div', { key: 'b', style: { marginTop: 8 } }, [
              h('button', {
                key: 'copy',
                onClick: () => rescue.copyPrompt(),
                style: buttonStyle('secondary'),
              }, rescue.copied === true ? t('rescueCopied') : t('rescueCopyPrompt')),
            ]),
          ])
          : null,
        rescue.reportResult?.checked === false
          ? h('p', { key: 'report-failed', role: 'status' }, t('reportsUnavailable'))
          : rescue.reportResult !== undefined
          ? h('div', { key: 'rp', style: { marginTop: 10, fontSize: 13, lineHeight: 1.6 } }, [
            h('div', { key: 't', style: { fontWeight: 600, color: COLORS.info } },
              rescue.reportResult.existing.length > 0 ? t('rescueReportsFound') : t('rescueNoReports')),
            ...(rescue.reportResult.existing.length > 0
              ? rescue.reportResult.existing.slice(0, 5).map(item => h('div', { key: item.number, style: { marginTop: 4, fontSize: 12 } }, [
                h('a', { key: 'a', href: safeReportUrl(item.url), target: '_blank', rel: 'noreferrer noopener', style: { color: COLORS.info } },
                  `#${item.number} [${item.state}] ${item.title}`),
              ]))
              : [h('div', { key: 'n', style: { marginTop: 6, fontSize: 12, opacity: 0.8 } }, t('rescueNoReportsWhat')),
                h('div', { key: 'b', style: { marginTop: 8 } }, [
                  h('a', {
                    key: 'new',
                    href: safeReportUrl(rescue.reportResult.newIssueUrl),
                    target: '_blank',
                    rel: 'noreferrer',
                    style: { ...buttonStyle('secondary'), display: 'inline-block', textDecoration: 'none', color: 'inherit' },
                  }, t('rescueOpenIssue')),
                ])]),
            h('div', { key: 'f', style: { marginTop: 8, fontSize: 12, opacity: 0.6 } }, t('rescueNoFile')),
          ])
          : null,
        h('div', { key: 'act', hidden: trial, style: { marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
          rescue.phase === 'idle'
            ? h('button', {
              key: 'go',
              onClick: () => setTrial(true),
              style: buttonStyle('primary'),
            }, t('rescueCheck'))
            : null,
          rescue.phase === 'rehearsed' && canApply
            ? h('button', {
              key: 'apply',
              onClick: () => rescue.beginConfirm(),
              style: buttonStyle('danger'),
            }, t('rescueApply'))
            : null,
          rescue.phase === 'done'
            ? h('button', { key: 'reset', onClick: rescue.reset, style: buttonStyle('secondary') }, t('acknowledge'))
            : null,
        ]),
      ])
    }

    /** Recorded exemptions: the undo surface, plus the "upstream fixed it" prompt. */
    function RescueRecords({ rescues, onUndo, t }) {
      if (!Array.isArray(rescues) || rescues.length === 0) return null
      return h('div', { key: 'records', style: { marginTop: 18, padding: 14, borderRadius: 10, background: 'rgba(128,128,128,.06)' } }, [
        h('div', { key: 't', style: { fontSize: 13, fontWeight: 700, marginBottom: 6 } }, t('recordsTitle')),
        h('div', { key: 's', style: { fontSize: 12, opacity: 0.65, marginBottom: 8, lineHeight: 1.6 } }, t('recordsWhy')),
        ...rescues.map(entry => h('div', {
          key: entry.key,
          style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', padding: '6px 0', fontSize: 13, borderTop: '1px solid rgba(128,128,128,.15)' },
        }, [
          h('span', { key: 'n', style: { fontWeight: 600 } }, `${entry.name}@${entry.version}`),
          h('span', { key: 'h', style: { fontSize: 12, opacity: 0.6 } }, t('recordsOn', { host: entry.runtimeVersion })),
          entry.stale
            ? h('span', { key: 's', style: { fontSize: 12, color: COLORS.warn } }, t('recordsStale', { installed: entry.installedVersion ?? '?' }))
            : null,
          h('button', {
            key: 'u',
            onClick: () => onUndo(entry.key),
            style: { ...buttonStyle('secondary', { compact: true }), marginLeft: 'auto' },
          }, t('recordsUndo')),
        ])),
      ])
    }

    /** Shown when rescue is available: the list of incompatible plugins with their actions. */
    function RescuePanel({ rescuable, reload, profileKey, technical, t }) {
      if (!Array.isArray(rescuable) || rescuable.length === 0) return null
      return h('div', { key: 'rescue', style: { marginTop: 18 } }, [
        h('div', { key: 't', style: { fontSize: 14, fontWeight: 700, marginBottom: 4 } }, t('rescueTitle')),
        h('div', { key: 's', style: { fontSize: 12, opacity: 0.65, marginBottom: 4, lineHeight: 1.6 } },
          t('rescueWhy')),
        ...rescuable.map(plugin => h(RescueCard, { key: `${profileKey}/${plugin.name}@${plugin.version}/${plugin.id ?? ''}`, plugin, reload, technical, t })),
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
      const busy = React.useRef(false)

      const call = (dryRun) => postWrite(REPAIR_PATH, { dryRun, ...(dryRun ? {} : { planToken: plan?.planToken }) })

      const start = async () => {
        if (busy.current) return
        busy.current = true
        setPhase('planning')
        setError(undefined)
        try {
          const next = await call(true)
          setPlan(next)
          setPhase(next.planned.length === 0 ? 'nothing' : 'planned')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('error')
        } finally { busy.current = false }
      }

      const confirm = async () => {
        if (busy.current) return
        busy.current = true
        setPhase('applying')
        setError(undefined)
        try {
          const next = await call(false)
          setResult(next)
          setPhase('done')
          await reload()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setPhase('error')
        } finally { busy.current = false }
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
        key: 'dot',
        'aria-hidden': true,
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
    function DiagnosticDetail({ value, technical = false, t }) {
      const content = h('div', { style: { opacity: 0.75, fontSize: 12, wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace' } }, value)
      return technical ? content : h(Disclosure, { title: t('technicalDetails'), body: content })
    }

    function Finding({ issue, technical, t }) {
      const copy = Object.hasOwn(COPY, issue.id)
        ? { title: t(`finding.${issue.id}.title`), what: t(`finding.${issue.id}.what`), fix: t(`finding.${issue.id}.fix`) }
        : { title: issue.title, what: '', fix: issue.fix }
      return h(Disclosure, {
        title: copy.title, severity: issue.severity, t,
        badge: ['error', 'warn', 'info'].includes(issue.severity) ? t(`severity.${issue.severity}`) : '',
        body: [
          copy.what ? h('div', { key: 'what', style: { marginBottom: 8, opacity: 0.85 } }, copy.what) : null,
          issue.detail ? h(DiagnosticDetail, { key: 'detail', value: issue.detail, technical, t }) : null,
          copy.fix ? h('div', { key: 'fix', style: { color: COLORS.info } }, t('nextStep', { fix: copy.fix })) : null,
        ],
      })
    }

    /** One-line verdict a first-time user can act on without reading the list. */
    function Verdict({ errorCount, warnCount, scanned, t }) {
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
          borderInlineStart: '3px solid ' + (clean ? COLORS.ok : errorCount > 0 ? COLORS.error : COLORS.warn),
          background: clean ? 'rgba(52,168,83,.08)' : 'rgba(178,106,0,.08)',
        },
      }, [
        h('span', { key: 'd', style: { width: 8, height: 8, borderRadius: '50%', background: clean ? COLORS.ok : COLORS.warn, flex: '0 0 auto' } }),
        h('span', { key: 't', style: { fontWeight: 600 } }, clean ? t('ready') : t('attention')),
        ...parts,
        scanned !== undefined ? h('span', { key: 's' }, t('installedChecked', { count: scanned })) : null,
      ])
    }

    /** The one border-and-padding treatment every secondary control in this panel uses. */
    function PanelButton({ onClick, disabled, href, label, title }) {
      const style = {
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 8,
        padding: '7px 14px',
        cursor: disabled === true ? 'default' : 'pointer',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        opacity: disabled === true ? 0.55 : 1,
        textDecoration: 'none',
        display: 'inline-block',
        whiteSpace: 'nowrap',
      }
      if (href !== undefined) {
        // A real anchor, not a click handler: the desktop shell hands target="_blank" to the
        // system browser, which a window.open call is not always allowed to do.
        return h('a', { href, target: '_blank', rel: 'noreferrer noopener', style }, label)
      }
      return h('button', { type: 'button', onClick, disabled: disabled === true, 'aria-label': label, title, style }, label)
    }

    function ScanButton({ onClick, busy, sampledAt, t }) {
      const label = t(busy ? 'scanning' : 'rescan')
      const messages = [t('scanReadOnly'), t('liveCadence')]
      if (sampledAt) messages.push(t('liveSample', { time: new Date(sampledAt).toLocaleTimeString(t('dateLocale')) }))
      const description = messages.join(' ')
      return h('span', { className: 'dph-scan' }, [
        h('button', {
          type: 'button', onClick, disabled: busy, 'aria-label': label,
          'aria-description': description, style: buttonStyle('secondary'), key: 'button',
        }, label),
        h('span', { key: 'tip', className: 'dph-scan-tip', 'aria-hidden': true }, description),
      ])
    }

    function downloadJson(filename, data) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function initialView() {
      try {
        const saved = window.localStorage.getItem(VIEW_KEY)
        if (VIEWS.includes(saved)) return saved
      } catch { /* Some DSH surfaces do not allow browser storage. */ }
      return 'daily'
    }

    /** Search non-failed loader entries, grouped by package prefix. */
    function EntryList({ rows, t, stateName }) {
      const [query, setQuery] = React.useState('')
      const needle = query.trim().toLowerCase()
      const matches = needle === ''
        ? rows
        : rows.filter(row => `${row.name} ${row.id}`.toLowerCase().includes(needle))
      const groups = [
        { key: 'user', label: t('liveUserInstalled'), rows: matches.filter(row => !isHostPackage(row.name)) },
        { key: 'host', label: t('liveOfficial'), rows: matches.filter(row => isHostPackage(row.name)) },
      ].filter(group => group.rows.length > 0)
      const row = (entry) => h('div', { key: entry.id, className: 'dph-row' }, [
        h('div', { key: 'head', className: 'dph-row-head' }, [
          h('strong', { key: 'name' }, entry.name),
          h('span', { key: 'state', className: 'dph-chip' }, stateName(entry.state)),
        ]),
        h('div', { key: 'id', className: 'dph-muted' }, entry.id),
      ])
      return h(Disclosure, {
        title: `${t('liveOther')} (${rows.length})`,
        revealKey: needle === '' ? null : needle,
        body: [
          h('label', { key: 'search', className: 'dph-search' }, [
            h('span', { key: 'label', className: 'dph-muted' }, t('liveSearch')),
            h('input', {
              key: 'input',
              type: 'search',
              value: query,
              placeholder: t('liveSearchHint'),
              'aria-label': t('liveSearchHint'),
              onChange: (event) => setQuery(event.target.value),
            }),
          ]),
          matches.length === 0
            ? h('p', { key: 'none', className: 'dph-muted' }, t('liveNoMatch'))
            : groups.map(group => h('div', { key: group.key, className: 'dph-entry-group' }, [
                h('div', { key: 'label', className: 'dph-muted dph-group-label' },
                  `${group.label} · ${t('liveCount', { count: group.rows.length })}`),
                ...group.rows.map(row),
              ])),
        ],
      })
    }

    /** Identify DSH and Cordis package entries by prefix. */
    function isHostPackage(name) {
      return typeof name === 'string' && (name.startsWith('@deepseek-ai/') || name.startsWith('cordis'))
    }

    function RuntimeReview({ live, advanced, t }) {
      if (!live) return h('section', { className: 'dph-card' }, [
        h('h3', { key: 'title' }, t('reviewActivation')),
        h('p', { key: 'none', className: 'dph-muted' }, t('reviewNoActivation')),
      ])
      const failed = live.entries.filter(row => row.state === 'failed')
      const others = live.entries.filter(row => row.state !== 'failed')
      const active = live.entries.filter(row => row.state === 'active').length
      const formatTime = (value) => new Date(value).toLocaleTimeString(t('dateLocale'))
      const stateName = (state) => t(`review.${state ?? 'absent'}`)
      return h('section', { className: 'dph-card' }, [
        h('h3', { key: 'title' }, t('reviewActivation')),
        h('div', { key: 'metrics', className: 'dph-metrics', role: 'status' },
          [[active, 'liveActive'], [failed.length, 'liveFailed'], [others.length - active, 'liveWaiting']].map(([count, label]) =>
            h('div', {
              key: label, className: 'dph-metric',
              'data-attention': label === 'liveFailed' && count > 0 ? '' : undefined,
            }, [
              h('span', { key: 'label', className: 'dph-metric-label' }, t(label)),
              h('strong', { key: 'count' }, count),
            ]))),
        failed.map(row => h('div', { key: row.id, className: 'dph-failed' }, [
          h('strong', { key: 'name' }, row.name),
          advanced ? h('div', { key: 'id', className: 'dph-muted' }, `${row.id} · ${stateName(row.state)}`) : null,
          row.diagnostic?.kind === 'duplicate-tool' ? h('p', { key: 'diagnostic' }, t('liveDuplicate', row.diagnostic)) : null,
        ])),
        failed.length ? h('p', { key: 'help', className: 'dph-muted' }, t('liveFailureHelp')) : null,
        h('div', { key: 'advanced', hidden: !advanced }, [
          others.length ? h(EntryList, { key: 'entries', rows: others, t, stateName }) : null,
          live.sampledAt ? h(Disclosure, { key: 'changes', title: t('liveChanges'),
            badge: String((live.changes ?? []).length), body: [
              (live.changes ?? []).length === 0 ? h('p', { key: 'none' }, t('liveNoChanges')) :
                live.changes.map((change, index) => h('div', { key: index, className: 'dph-row' }, [
                  h('div', { key: 'event' }, t('liveTransition', { ...change, before: stateName(change.before), after: stateName(change.after) })),
                  h('div', { key: 'time', className: 'dph-muted' }, formatTime(change.sampledAt)),
                ])),
            ],
          }) : null,
        ]),
      ])
    }

    // Assessments need a readable, applicable declaration. Count exemptions as assessed and
    // keep them out of the actionable mismatch count, as in the package list.
    function declarationCounts(packages) {
      const mismatches = packages.filter(row => row.declaration?.state === 'incompatible')
      const judged = packages.filter(row => ['compatible', 'incompatible', 'exempted'].includes(row.declaration?.state)).length
      return { mismatches, judged }
    }

    function reportRevision(review) {
      // A target-version verdict changes when the target changes; it is not a disk change.
      return JSON.stringify([review.profile, review.currentVersion,
        review.packages.map(row => [row.name, row.source, row.version, row.fingerprint]), review.patches, review.limits])
    }

    /**
     * A one-field upgrade preview, usable in any view mode.
     *
     * The full ProfileReview below carries the same query plus the package list, patches and findings —
     * useful when you are already diagnosing, too much when the question is simply "will the next
     * version break me". This asks that question and reads back one sentence.
     */
    function UpgradePreview({ review, t }) {
      const [target, setTarget] = React.useState(review.currentVersion ?? '')
      const [result, setResult] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState('')
      const sequence = React.useRef(0)

      const run = async (event) => {
        event.preventDefault()
        const wanted = target.trim()
        if (wanted === '') return
        const mine = ++sequence.current
        setBusy(true)
        setFailed('')
        try {
          const query = new URLSearchParams({ target: wanted, fresh: '1' })
          const data = await readSnapshot(`${STATUS_PATH}?${query}`)
          if (mine !== sequence.current) return
          if (data?.review?.targetVersion !== wanted) { setFailed('reviewFail'); return }
          const { mismatches, judged } = declarationCounts(data.review.packages)
          setResult({ version: wanted, affected: mismatches.map(row => row.name), judged })
        } catch {
          if (mine === sequence.current) setFailed('reviewFail')
        } finally {
          if (mine === sequence.current) setBusy(false)
        }
      }

      return h('section', { className: 'dph-card', 'data-dph-upgrade-preview': '' }, [
        h('h3', { key: 't' }, t('reviewInline')),
        h('form', { key: 'f', onSubmit: run, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 8 } }, [
          h('label', { key: 'l', style: { display: 'grid', gap: 4, fontSize: 12 } }, [
            t('reviewInlineLabel'),
            h('input', {
              key: 'i',
              value: target,
              placeholder: review.currentVersion ?? '',
              maxLength: 100,
              disabled: busy,
              onChange: (event) => { setTarget(event.target.value); setResult(undefined); setFailed('') },
            }),
          ]),
          h('button', { key: 'b', type: 'submit', disabled: busy || target.trim() === '', style: buttonStyle('primary') },
            t(busy ? 'checking' : 'reviewInlineRun')),
        ]),
        failed ? h('p', { key: 'e', role: 'status', style: { fontSize: 13, color: COLORS.warn } }, t(failed)) : null,
        result === undefined ? null : h('p', {
          key: 'r', role: 'status', style: { fontSize: 13, marginTop: 10, color: result.affected.length > 0 ? COLORS.warn : 'inherit' },
        }, [
          t('reviewResult', { version: result.version, judged: result.judged, count: result.affected.length }),
          result.affected.length > 0 ? ' ' + result.affected.slice(0, 6).join(', ') : null,
        ]),
      ])
    }

    function ProfileReview({ review, stale, t }) {
      // Pre-filled with the running host version: the common question is "would the version I am on
      // reject anything", and an empty required field made the reader find that version themselves.
      const [target, setTarget] = React.useState(review.currentVersion ?? '')
      const [preview, setPreview] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState('')
      const request = React.useRef(0)
      const sourceKey = reportRevision(review)
      const [previewKey, setPreviewKey] = React.useState('')
      React.useEffect(() => () => { request.current++ }, [])
      const submit = async (event) => {
        event.preventDefault()
        const sequence = ++request.current
        setBusy(true)
        setFailed('')
        setPreview(null)
        try {
          const query = new URLSearchParams({ target: target.trim(), fresh: '1' })
          const data = await readSnapshot(`${STATUS_PATH}?${query}`)
          if (data.review?.targetVersion !== target.trim() || data.review?.profile !== review.profile) {
            throw new Error('invalid-target')
          }
          if (sequence === request.current) {
            setPreview(data.review)
            setPreviewKey(reportRevision(data.review))
          }
        } catch (error) {
          if (sequence === request.current) setFailed(error.message === 'requestTimeout' ? 'requestTimeout' :
            error.status === 400 || error.message === 'invalid-target' ? 'reviewInvalidTarget' : 'reviewNetworkFail')
        } finally {
          if (sequence === request.current) setBusy(false)
        }
      }
      const result = preview ?? review
      const { mismatches, judged } = declarationCounts(result.packages)
      const packages = [...mismatches, ...result.packages.filter(row => row.declaration.state !== 'incompatible')]
      // A fresh preview can be newer than the panel's cached scan. Only a later observation
      // can invalidate it; otherwise that old panel would flag a newly checked config as stale.
      const newerScan = !preview?.capturedAt || !review.capturedAt || Date.parse(review.capturedAt) >= Date.parse(preview.capturedAt)
      return h('section', { className: 'dph-card' }, [
        h('h3', { key: 'title' }, t('reviewTitle')),
        h('form', { key: 'form', onSubmit: submit, style: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 8 } }, [
          h('label', { key: 'field', style: { display: 'grid', gap: 4, fontSize: 12 } }, [
            t('reviewTarget'),
            h('input', { key: 'target', value: target, placeholder: review.currentVersion ?? '0.2.1-rc.5',
              maxLength: 100, disabled: busy, onChange: (event) => {
                setTarget(event.target.value)
                setPreview(null)
                setFailed('')
              },
            }),
          ]),
          h('button', { key: 'run', type: 'submit', disabled: busy || target.trim() === '', style: buttonStyle('primary') }, t(busy ? 'checking' : 'reviewRun')),
          h('button', { key: 'save', type: 'button', onClick: () => downloadJson('dsh-profile-snapshot.json', review),
            style: buttonStyle('secondary') }, t('reviewSnapshot')),
        ]),
        h('p', { key: 'result', role: 'status', style: { fontSize: 13 } },
          failed ? t(failed) : result.targetVersion
            ? t('reviewResult', { version: result.targetVersion, judged, count: mismatches.length })
            : t('reviewNoTarget')),
        preview && (stale || (newerScan && sourceKey !== previewKey)) ? h('p', { key: 'stale', role: 'status', style: { color: COLORS.warn } }, t('previewStale')) : null,
        h(Disclosure, { key: 'packages', title: `${t('reviewPackages')} (${packages.length})`,
          revealKey: preview && mismatches.length > 0 ? preview : null,
          body: packages.map(row => h('div', { key: row.name, className: 'dph-row' }, [
            h('div', { key: 'head', className: 'dph-row-head' }, [
              h('strong', { key: 'name' }, `${row.name}@${row.version ?? '?'}`),
              h('span', { key: 'state', className: 'dph-chip', style: { color: row.declaration.state === 'incompatible' ? COLORS.error : 'inherit' } }, t(`review.${row.declaration.state}`)),
            ]),
            row.declaration.requirements ? h('div', { key: 'requirements', className: 'dph-muted' }, Object.values(row.declaration.requirements).join(', ')) : null,
          ])),
        }),
        ...result.findings.map((finding, index) => h('p', { key: `finding-${index}`, style: { fontSize: 13 } },
          finding.kind === 'profile-host-package' ? t('reviewCore', finding) :
            finding.kind === 'duplicate-insert-id' ? t('reviewDuplicate', finding) :
            finding.kind === 'declared-shared-write' ? t('reviewSharedWrite', {
              packages: finding.packages.join(', '), path: `${finding.scope}:${finding.path}`,
            }) :
              [
                t('reviewOverride', { id: finding.id, before: finding.previousLayer, after: finding.layer }),
                finding.moduleChanged ? ` ${t('reviewModuleChanged')}` : '',
                finding.removedKeys.length ? ` ${t('reviewRemoved', { keys: finding.removedKeys.join(', ') })}` : '',
              ])),
        h(Disclosure, { key: 'coverage', title: t('reviewSources'), body: [
          h('p', { key: 'limit' }, t('reviewLimits')),
          h('ul', { key: 'limits' }, result.limits.map(limit => {
            const [kind, detail] = limit.split(/:(.*)/u)
            return h('li', { key: limit }, t(`limit.${kind}`, { detail: detail ?? '' }))
          })),
        ] }),
        h('p', { key: 'privacy', className: 'dph-muted' }, t('exportHelp')),
      ])
    }

    function HealthSection({ t: translate }) {
      const { loading, error, data, reload } = useStatus()
      const repair = useRepair(reload)
      const rescue = useRescue(reload)
      const [scanning, setScanning] = React.useState(false)
      const [copied, setCopied] = React.useState(undefined)
      const [view, setView] = React.useState(initialView)
      const t = React.useCallback((key, params) => {
        const scoped = `audience.${view}.${key}`
        return translate(Object.hasOwn(dictionaries.en, scoped) ? scoped : key, params)
      }, [translate, view])
      const technical = view === 'developer'
      const advanced = view !== 'daily'
      const live = data?.liveReview ?? (Array.isArray(data?.review?.activation)
        ? { entries: data.review.activation } : null)
      const failedCount = live?.entries.filter(row => row.state === 'failed').length ?? 0
      const issues = data?.issues ?? []
      const rescuable = data?.rescuable ?? []
      const actionable = issues.filter((issue) => issue.severity !== 'info')
      const doctorCommand = 'dsh-plugin-health doctor'
      const copyDoctor = async () => {
        try {
          await navigator.clipboard.writeText(doctorCommand)
          setCopied(true)
        } catch {
          setCopied(false)
        }
      }
      const autoFixable = actionable.filter((issue) => issue.autoFixable === true)
      const summary = data?.summary ?? {}
      const scanned = data?.scanned?.plugins?.total
      // The boot-time check already ran; this hook only handles the user asking again.
      const update = useUpdate(reload, t)
      const updateState = update.state ?? data?.update
      const ourVersion = updateState?.currentVersion
      const latestVersion = updateState?.latestVersion

      const rescan = React.useCallback(async () => {
        setScanning(true)
        try {
          await reload(true)
        } finally {
          setScanning(false)
        }
      }, [reload])

      /**
       * Undo one recorded exemption. Deliberately not optimistic: the list re-reads from
       * disk afterwards, so the panel can never claim a rescue was reverted when it was not.
       */
      const undoRescue = React.useCallback(async (key) => {
        try {
          await rescue.undo({ key })
          await reload()
        } catch {
          await reload()
        }
      }, [rescue, reload])

      return h('div', { className: 'dph-panel', 'data-view': view }, [
        h('style', { key: 'styles' }, PANEL_CSS),
        h('div', { key: 'head', className: 'dph-head' }, [
          h('h2', { key: 'title' }, t('nav')),
          h('div', { key: 'actions', className: 'dph-actions' }, [
            h(ScanButton, { key: 'scan', onClick: rescan, busy: scanning || loading, sampledAt: live?.sampledAt, t }),
            h(PanelButton, {
              key: 'upd',
              onClick: update.check,
              disabled: ['checking', 'installing'].includes(update.phase),
              label: update.phase === 'checking' ? t('checkingUpdate') : t('checkUpdate'),
            }),
            h(PanelButton, { key: 'all', href: COMPAT_URL, label: t('browseAll') }),
            h('div', { key: 'view', className: 'dph-mode', role: 'group', 'aria-label': t('viewLabel') },
              VIEWS.map(mode => {
                const label = t('view.' + mode)
                return h('button', {
                  key: mode, type: 'button', 'aria-label': label, 'aria-pressed': view === mode,
                  onClick: () => {
                    setView(mode)
                    try { window.localStorage.setItem(VIEW_KEY, mode) } catch { /* Session-only fallback. */ }
                  },
                }, label)
              })),
          ]),
        ]),
        // Only speak up when there is something to do. A permanent "up to date" line trains people
        // to ignore the strip, which is where a real update notice has to appear.
        update.phase === 'failed'
          ? h('div', { key: 'uf', style: { fontSize: 13, color: COLORS.warn, marginBottom: 10 } },
            t('updateFailed', { error: update.error ?? '' }))
          : null,
        update.phase === 'done' && updateState?.updateAvailable === false
          ? h('div', { key: 'uo', style: { fontSize: 13, opacity: 0.7, marginBottom: 10 } },
            t('updateUpToDate', { version: latestVersion ?? '' }))
          : null,
        updateState?.updateAvailable === true
          ? h('div', {
            key: 'ua',
            style: {
              marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
              background: 'rgba(26,115,232,.10)', border: '1px solid rgba(26,115,232,.35)',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            },
          }, [
            h('div', { key: 't', style: { flex: '1 1 240px', minWidth: 0 } },
              t('updateAvailable', { version: latestVersion ?? '', current: ourVersion ?? '' })),
            h(PanelButton, {
              key: 'go',
              onClick: () => update.installNow(latestVersion),
              disabled: ['checking', 'installing'].includes(update.phase),
              label: update.phase === 'installing' ? t('updating') : t('updateNow'),
            }),
            // The command stays available for anyone who would rather do it themselves; it is no
            // longer the only way to act.
            h('div', {
              key: 'h',
              style: {
                flex: '1 1 100%', opacity: 0.7, wordBreak: 'break-all', fontSize: 11.5,
                fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
              },
            }, t('updateHowTo', {
              command: updateState.upgradeHint ?? `dsh plugin add dsh-plugin-health@${latestVersion ?? ''}`,
            })),
          ])
          : null,
        update.phase === 'installed'
          ? h('div', {
            key: 'ui',
            style: {
              marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
              background: 'rgba(19,115,51,.10)', border: '1px solid rgba(19,115,51,.35)',
            },
          }, [
            h('div', { key: 't', style: { fontWeight: 600 } },
              t('updateDone', { version: update.install?.targetVersion ?? latestVersion ?? '' })),
          ])
          : null,
        update.phase === 'installFailed'
          ? h('div', {
            key: 'uf2',
            style: {
              marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13,
              color: COLORS.warn, background: 'rgba(197,34,31,.06)', border: '1px solid rgba(197,34,31,.30)',
            },
          }, [
            h('div', { key: 't', style: { fontWeight: 600, marginBottom: 3 } },
              t('updateInstallFailed', { error: update.error ?? update.install?.error ?? '' })),
            // The package manager's own words, because "exited with code 1" is not actionable.
            (update.install?.log ?? []).length > 0
              ? h('pre', {
                key: 'log',
                style: {
                  margin: '6px 0 0', padding: 8, borderRadius: 6, fontSize: 11.5, overflow: 'auto',
                  maxHeight: 120, background: 'rgba(128,128,128,.12)',
                  fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', whiteSpace: 'pre-wrap',
                },
              }, update.install.log.join('\n'))
              : null,
            h('div', { key: 'retry', style: { marginTop: 8 } },
              h(PanelButton, {
                onClick: () => update.installNow(latestVersion),
                label: t('updateRetry'),
              })),
          ])
          : null,
        loading ? h('div', { key: 'l', style: { fontSize: 13, opacity: 0.7 } }, t('checking')) : null,
        error !== undefined ? h('div', { key: 'e', role: 'status', style: { fontSize: 13, color: COLORS.warn } }, [
          h('div', { key: 't', style: { fontWeight: 600, marginBottom: 4 } }, t('checkFailed')),
          error === 'requestTimeout' ? h('div', { key: 'd' }, t('requestTimeout')) :
            h(DiagnosticDetail, { key: 'd', value: error, technical, t }),
          h('div', { key: 'h', style: { marginTop: 4, opacity: 0.7 } }, t('checkRetry')),
          data ? h('p', { key: 'stale' }, t('staleStatus')) : null,
        ]) : null,
        !loading && error === undefined
          ? h(Verdict, {
            key: 'v',
            t,
            errorCount: (summary.error ?? 0) + failedCount,
            warnCount: summary.warn ?? 0,
            scanned,
          })
          : null,
        data?.review ? h(UpgradePreview, { key: 'upgrade-preview', review: data.review, t }) : null,
        data ? h(RuntimeReview, { key: 'runtime', live, advanced, t }) : null,
        !loading && data && actionable.length > 0 ? h('div', { key: 'list' },
          actionable.map((issue, index) => h(Finding, { key: `${issue.id}-${index}`, issue, technical, t }))) : null,
        !loading && data && actionable.length === 0 && failedCount === 0 && error === undefined
          ? h('div', { key: 'clean-actions', className: 'dph-actions' }, [
            h(PanelButton, { key: 'doctor', onClick: copyDoctor, label: t('healthyDoctor'), title: doctorCommand }),
            copied !== undefined ? h('span', { key: 'copied', role: 'status' },
              copied ? t('healthyCopied') : h('code', null, doctorCommand)) : null,
          ]) : null,
        !loading && error === undefined && !advanced && issues.length > actionable.length
          ? h('div', { key: 'info', style: { marginTop: 6, fontSize: 12, opacity: 0.55 } },
            t('omitted', { count: issues.length - actionable.length }))
          : null,
        // The cleanup flow belongs next to the findings it acts on: it deals with leftover files,
        // not with compatibility. Placing it below the rescue card made it look like part of that
        // flow, and its old green fill read as "safe" for a destructive action.
        error === undefined && autoFixable.length > 0 && repair.phase === 'idle'
          ? h('div', { key: 'cleanup', style: { marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
            h('button', {
              key: 'b',
              onClick: () => repair.start(),
              style: buttonStyle('danger'),
            }, t('repair', { count: autoFixable.length })),
            h('span', { key: 'h', style: { fontSize: 12, opacity: 0.6, flex: '1 1 220px' } },
              t('repairSafety')),
          ])
          : null,
        // The two rescue sections sit under the finding list. A rule above each keeps them from
        // reading as part of that list, which is a different kind of information (what is wrong
        // versus what can be done).
        !loading && error === undefined && rescuable.length > 0
          ? h('div', { key: 'rescue-divider', style: { marginTop: 22, borderTop: '1px solid rgba(128,128,128,.22)' } })
          : null,
        !loading && error === undefined
          ? h(RescuePanel, { key: 'rescue', rescuable, reload, profileKey: `${data.home}/${data.profile}`, technical, t })
          : null,
        !loading && error === undefined && (data?.rescues ?? []).length > 0
          ? h('div', { key: 'records-divider', style: { marginTop: 22, borderTop: '1px solid rgba(128,128,128,.22)' } })
          : null,
        !loading && error === undefined
          ? h(RescueRecords, { key: 'records', rescues: data?.rescues ?? [], onUndo: undoRescue, t })
          : null,
        repair.phase === 'planning' ? h('div', { key: 'p', style: { marginTop: 14, fontSize: 13, opacity: 0.7 } }, t('planning')) : null,
        repair.phase === 'error' ? h('section', { key: 'repair-error', role: 'alert', className: 'dph-card' }, [
          h('h3', { key: 'title', style: { color: COLORS.error } }, t('repairFailed')),
          h('p', { key: 'help' }, t('repairFailedHelp')),
          h(DiagnosticDetail, { key: 'error', value: repair.error, technical, t }),
          h('div', { key: 'actions', className: 'dph-actions', style: { marginTop: 12 } }, [
            h('button', { key: 'retry', type: 'button', onClick: repair.start, style: buttonStyle('secondary') }, t('repairRetry')),
            h('button', { key: 'cancel', type: 'button', onClick: repair.reset, style: buttonStyle('secondary') }, t('cancel')),
          ]),
        ]) : null,
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
                onClick: () => repair.confirm(),
                style: buttonStyle('danger'),
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
            technical && repair.result.restoreRun
              ? h('div', { key: 'restore', style: { fontSize: 12, marginTop: 6 } },
                `${t('restorePreview')}: `, h('code', null, `dsh-plugin-health repair --restore ${repair.result.restoreRun}`))
              : null,
            h('div', { key: 'r', style: { marginTop: 10 } }, [
              h('button', {
                key: 'again',
                onClick: repair.reset,
                style: buttonStyle('secondary', { compact: true }),
              }, t('acknowledge')),
            ]),
          ])
          : null,
        data?.review ? h('div', { key: 'advanced-review', hidden: !advanced, className: 'dph-enter' },
          h(ProfileReview, { key: `${data.home}/${data.review.profile}`, review: data.review, stale: error !== undefined, t })) : null,
        advanced && issues.some(issue => issue.severity === 'info') ? h(Disclosure, {
          key: 'information', title: t('infoFindings'), badge: String(issues.length - actionable.length),
          body: issues.filter(issue => issue.severity === 'info').map((issue, index) => h(Finding, { key: `${issue.id}-${index}`, issue, technical, t })),
        }) : null,
        data ? h('section', { key: 'developer', hidden: view !== 'developer', className: 'dph-card dph-enter' }, [
          h('h3', { key: 'title' }, t('liveDeveloper')),
          h('p', { key: 'help', className: 'dph-muted' }, t('liveDeveloperHelp')),
          h('p', { key: 'one' }, t('developerPreflight')),
          h('code', { key: 'review', className: 'dph-code' }, 'dsh-plugin-health review --json --target <version>'),
          h('p', { key: 'two' }, t('developerCombination')),
          h('code', { key: 'smoke', className: 'dph-code' }, 'dsh-plugin-health smoke --dsh-dir <dir> --plugin <name@version> --with <name@version> --boot-only'),
          h('p', { key: 'trust', className: 'dph-muted' }, t('developerTrust')),
          live?.sampledAt ? h('div', { key: 'export', style: { marginTop: 12 } }, h('button', {
            type: 'button', style: buttonStyle('secondary'),
            onClick: () => downloadJson('dsh-runtime-review.json', { schemaVersion: 1, profile: data.profile, runtimeVersion: data.runtimeVersion, ...live }),
          }, t('liveExport'))) : null,
          h('p', { key: 'privacy', className: 'dph-muted' }, t('exportHelp')),
        ]) : null,
        h('footer', { key: 'meta', className: 'dph-muted', style: { marginTop: 20 } }, [
          h('p', { key: 'security' }, t('securityScope')),
          data ? h('div', { key: 'last' }, t('lastChecked', { time: new Date(data.generatedAt).toLocaleString(t('dateLocale')) })) : null,
          data ? h('div', { key: 'version' }, t('versionProfile', { version: data.runtimeVersion ?? t('unknown'), profile: data.profile ?? t('unknown') })) : null,
          data && advanced ? h('div', { key: 'home' }, data.home) : null,
        ]),
      ])
    }

    /**
     * Sidebar entry that exists only while there is something worth acting on.
     *
     * Two kinds now: plugins the scan flagged, and an update of this plugin. An update is a lower
     * priority than a broken plugin, so when both apply the issue count leads and the update is a
     * second line — the user came here because something is wrong, not to upgrade a tool.
     */
    function AlertEntry(props) {
      const { t } = props
      // Whether the last press failed to reach the settings surface. Kept in state rather than
      // written into the DOM: mutating the button's text would clobber the spans React renders, and
      // the replaced text would then be matched by any future handler that looks at the label.
      const [openFailed, setOpenFailed] = React.useState(false)
      React.useEffect(() => { setOpenFailed(false) }, [props.kind, props.count, props.version])
      const tone = props.kind === 'update' ? COLORS.info : COLORS.error
      const background = props.kind === 'update' ? 'rgba(26,115,232,.10)' : 'rgba(217,48,37,.10)'
      return h('button', {
        'data-dph-alert': props.kind,
        onClick: () => props.open((ok) => { if (!ok) setOpenFailed(true) }),
        title: t(openFailed ? 'alertOpenFailed' : (props.kind === 'update' ? 'alertUpdateTitle' : 'alertTitle')),
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          border: 0,
          borderRadius: 8,
          padding: '8px 10px',
          cursor: 'pointer',
          background,
          color: tone,
          font: 'inherit',
          fontSize: 13,
          fontWeight: 600,
          textAlign: 'left',
        },
      }, [
        h('span', { key: 'i' }, openFailed ? '!' : props.kind === 'update' ? '↑' : '!'),
        h('span', { key: 't', style: { flex: 1 } },
          openFailed
            ? t('alertOpenFailed')
            : props.kind === 'update'
              ? t('alertUpdate', { version: props.version ?? '' })
              : t('alertCount', { count: props.count })),
        h('span', { key: 'a', style: { fontSize: 12, opacity: 0.7 } },
          openFailed ? t('alertRetry') : t('view')),
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
        /**
         * Open the settings surface.
         *
         * The previous version called `layout.selectPanel('settings')` inside an empty catch.
         * That never worked: `selectPanel` only accepts keys registered in the host's `main`
         * registry (`conversation`, `plugins`, `schedules`, …) and *throws* for an unknown one,
         * while the settings surface is a modal owned by the shell, not a main panel. The empty
         * catch swallowed the throw, so the button looked dead — which is exactly what a user
         * reported.
         *
         * The shell exposes no public "open settings" service; the supported ways in are:
         *
         *   1. dispatch the `settings.open` command's own key combination, which the shell
         *      registers as a command (`Ctrl/Cmd+,`, or `Ctrl+Alt+,` in the browser);
         *   2. click the shell's own settings trigger if it can be found in the DOM.
         *
         * Both are attempted, and if neither lands the alert says so instead of doing nothing.
         */
        /**
         * The settings dialog, by the markup DSH actually emits.
         *
         * Read out of @deepseek-ai/dsh-client-ui-settings-general 0.2.1-rc.4, lib/client.js:280-293:
         *   <div role="dialog" aria-modal="true" data-shortcut-modal="settings" aria-labelledby=…>
         * The same markup is in 0.2.0-rc.2, 0.2.1-rc.5 and 0.2.2-rc.1. The earlier list
         * (data-dsh-settings, data-testid=…) was invented, so this never matched and the strip
         * reported failure while the dialog was plainly open. Re-check these against the package
         * when the supported host range moves.
         */
        const SETTINGS_DIALOG_SELECTORS = [
          '[data-shortcut-modal="settings"]',
          '[role="dialog"][aria-modal="true"][data-shortcut-modal="settings"]',
        ]

        /**
         * The settings button, by the same markup (lib/client.js:451-462):
         *   <button aria-label="设置" aria-haspopup="dialog" aria-expanded=…>
         * `aria-haspopup="dialog"` is what distinguishes it from any other gear labelled
         * "Settings" inside another plugin's UI.
         */
        const SETTINGS_SELECTORS = [
          'button[aria-haspopup="dialog"][aria-label="设置"]',
          'button[aria-haspopup="dialog"][aria-label="Settings"]',
          'button[aria-haspopup="dialog"][title="设置"]',
          'button[aria-haspopup="dialog"][title="Settings"]',
        ]

        /** Is the settings dialog on screen? Only the real markup counts. */
        const settingsVisible = () => {
          for (const selector of SETTINGS_DIALOG_SELECTORS) {
            for (const element of document.querySelectorAll(selector)) {
              if (element.getClientRects().length > 0) return true
            }
          }
          return false
        }

        /**
         * Click the shell's settings button, if one matching the real markup is present.
         *
         * No synthetic keyboard event: the desktop build receives shortcuts natively and its DOM
         * keydown handler returns early, so a dispatched event does nothing there; on the web build
         * the shortcut toggles, so combining it with a click would close settings again. Clicking the
         * real button is the one path that works in both.
         */
        const clickShellTrigger = () => {
          for (const selector of SETTINGS_SELECTORS) {
            for (const element of document.querySelectorAll(selector)) {
              if (element.disabled) continue
              if (element.getClientRects().length === 0) continue
              // Never press a control inside this tool's own panel.
              if (element.closest?.('.dph-panel, .dph-disclosure')) continue
              try {
                element.click()
                return true
              } catch { /* try the next match */ }
            }
          }
          return false
        }

        /**
         * Try to open settings, then report what actually happened once the frame has settled.
         *
         * DSH mounts the dialog asynchronously, so the answer is read after a delay rather than
         * assumed from the click.
         * @param {(ok: boolean) => void} done called once with the outcome
         */
        const openSettingsSurface = (done) => {
          if (settingsVisible()) { done(true); return }
          if (!clickShellTrigger()) { done(false); return }
          setTimeout(() => done(settingsVisible()), 250)
        }

        /**
         * Keep the sidebar alert in step with the snapshot.
         *
         * Two bugs lived here. The count was captured in `inject` at registration time, so it never
         * updated; and once the alert existed the refresh returned early, so a later clean scan left
         * a stale "N issues" chip on screen that no longer matched the panel. The count now lives in
         * a variable the registration reads on each render, and the alert is torn down and rebuilt
         * when the number changes — the slot has no other way to update its props.
         */
        let alertKey
        let alertAlive = true
        let alertSequence = 0
        const refreshAlert = () => {
          const sequence = ++alertSequence
          readSnapshot(STATUS_PATH)
            .then((data) => {
              if (!data || !alertAlive || sequence !== alertSequence) return
              const count = (data?.issues ?? []).filter((issue) => issue.severity !== 'info').length
                + (data?.liveReview?.entries ?? []).filter(row => row.state === 'failed').length
              // The boot-time check leaves its answer in the status snapshot, so the sidebar can
              // mention an update without a request of its own.
              const updateVersion = data?.update?.updateAvailable === true ? data.update.latestVersion : undefined
              // Findings outrank an update: a broken plugin is why the user is looking at this panel.
              const kind = count > 0 ? 'issues' : (updateVersion === undefined ? 'none' : 'update')
              const key = `${kind}:${count}:${updateVersion ?? ''}`
              if (key === alertKey) return
              try { disposeAlert?.() } catch {}
              disposeAlert = undefined
              alertKey = key
              if (kind === 'none') return
              layoutCtx.slots.inject(ALERT_SLOT, () => {
                const dispose = layoutCtx.slots.register({
                  name: ALERT_SLOT,
                  id: ALERT_ID,
                  order: 90,
                  locale: NS,
                  inject: () => ({
                    kind,
                    count,
                    version: updateVersion,
                    open: (done) => openSettingsSurface(done),
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
        return () => {
          alertAlive = false
          clearInterval(timer)
          disposeAlert?.()
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
