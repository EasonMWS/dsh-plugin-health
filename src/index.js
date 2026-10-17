/**
 * Public API of dsh-plugin-health.
 * @module dsh-plugin-health
 */
export {
  evaluatePluginCompatibility,
  satisfiesDshRange,
  unmetRequirements,
  pluginCompatibilityWarning,
} from './compat/evaluate.js'
export {
  createMatrix,
  evaluateMatrix,
  hostSummary,
  parsePluginSpec,
  repositoryUrl,
  resolveHostVersions,
  resolvePlugins,
} from './compat/matrix.js'
export { badgeSvg, matrixToMarkdown, safeFileName, writeBadges } from './compat/report.js'
export { compatibilityLookup, loadCatalog, npmEntries } from './index/catalog.js'
export {
  buildFormat1Index,
  buildPluginEntry,
  healthScore,
  normalizeLocalized,
  normalizeRepository,
  selectedVersions,
  writeIndex,
} from './index/build.js'
export { inspectDshHome, listProfiles, resolveDshHome } from './repair/inspect.js'
export { applyRepairs, planRepairs, removeEmptyPatchEntries } from './repair/apply.js'
export { main, parseArgv, usage } from './cli.js'
