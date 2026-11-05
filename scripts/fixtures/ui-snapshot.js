// Synthetic evidence only. No user's profile, credentials, or files are used in browser QA.
export function uiSnapshot(targetVersion, { withRescue = false } = {}) {
  const at = '2026-11-05T12:00:00.000Z'
  const packages = [
    ['dsh-plugin-health', '3.0.0-beta.4', 'compatible'],
    ['dsh-file-organizer', '1.4.2', targetVersion ? 'incompatible' : 'compatible'],
    ['@example/knowledge-base-with-a-long-package-name', '2.1.0', 'compatible'],
  ].map(([name, version, state]) => ({ name, version, declaration: {
    state, requirements: { 'engines.dsh': state === 'incompatible' ? '<0.2.1-0' : '>=0.1.0-0 <0.3.0-0' },
  } }))
  const entries = [
    { id: 'health', name: 'dsh-plugin-health', state: 'active' },
    { id: 'organizer', name: 'dsh-file-organizer', state: 'active' },
    { id: 'knowledge', name: '@example/knowledge-base-with-a-long-package-name', state: 'failed',
      diagnostic: { kind: 'duplicate-tool', tool: 'search_notes' } },
  ]
  return {
    schemaVersion: 4, generatedAt: at, runtimeVersion: '0.2.1-rc.3', profile: 'desktop',
    home: 'C:\\DSH\\演示配置', profileDir: 'C:\\DSH\\演示配置\\profiles\\desktop',
    scanned: { plugins: { total: 3 } }, incompatible: withRescue ? 2 : 0,
    rescuable: withRescue ? [
      { name: 'example-first-plugin', version: '1.0.0', id: 'first', requirements: { 'engines.dsh': '<0.2.0-0' } },
      { name: 'example-second-plugin', version: '2.0.0', id: 'second', requirements: { 'engines.dsh': '<0.2.0-0' } },
    ] : [], rescues: [],
    summary: { error: 1, warn: 0, info: 1 },
    issues: [
      { id: 'bundle-manifest-invalid', severity: 'error', autoFixable: true,
        title: 'Plugin files are damaged', detail: 'C:\\DSH\\演示配置\\profiles\\desktop\\node_modules\\example-plugin\\package.json', fix: '' },
      { id: 'registry-mirror', severity: 'info', title: 'Custom registry', detail: '', fix: '' },
    ],
    update: { currentVersion: '3.0.0-beta.4', latestVersion: '3.0.0-beta.4', updateAvailable: false },
    liveReview: { sampledAt: at, entries, changes: [
      { id: 'knowledge', name: '@example/knowledge-base-with-a-long-package-name',
        before: 'active', after: 'failed', sampledAt: at },
    ] },
    review: {
      schemaVersion: 1, generatedAt: at, profile: 'desktop', currentVersion: '0.2.1-rc.3',
      targetVersion: targetVersion ?? null, packages, activation: entries,
      findings: [{ kind: 'duplicate-insert-id', id: 'search', layer: 'profile' },
        { kind: 'declared-shared-write', packages: ['dsh-file-organizer', '@example/knowledge-base-with-a-long-package-name'], scope: 'workspace', path: '.notes/index.json' }],
      limits: ['launch-overlays-not-read', 'tool-and-file-behavior-not-tested'],
    },
  }
}
