/**
 * Plain-text rendering of a `inspectDshHome` result, shared by the CLI and the DSH plugin tool.
 * @module repair/format
 */

/**
 * Render a diagnostic result for humans.
 * @param {{home: string, profiles: string[], profile?: string, profileDir?: string, findings: object[], summary: object}} result
 * @returns {string} text report, one finding per block.
 */
export function formatInspection(result) {
  const lines = [
    `DSH home: ${result.home}`,
    `Profiles: ${result.profiles.length === 0 ? '(none)' : result.profiles.join(', ')}`,
  ]
  if (result.profile !== undefined) lines.push(`Profile: ${result.profile} (${result.profileDir})`)
  for (const item of result.findings) {
    lines.push('', `[${item.severity}] ${item.id}: ${item.title}`)
    if (item.detail !== undefined) lines.push(`  ${item.detail}`)
    if (item.fix?.description !== undefined) {
      lines.push(`  fix${item.fix.auto === true ? ' (auto)' : ''}: ${item.fix.description}`)
    }
  }
  lines.push('', `Summary: ${result.summary.error} error(s), ${result.summary.warn} warning(s), ${result.summary.info} info; auto-fixable: ${result.summary.autoFixable}`)
  return lines.join('\n')
}
