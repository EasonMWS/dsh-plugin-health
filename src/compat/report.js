/**
 * Markdown and SVG renderers for a compatibility matrix.
 * @module compat/report
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostSummary } from './matrix.js'

/**
 * Render a matrix as a Markdown report.
 * @param {object} matrix - matrix document from `evaluateMatrix`.
 * @returns {string} Markdown text.
 */
export function matrixToMarkdown(matrix) {
  const hosts = matrix.hosts
  const header = ['Plugin', 'Version', ...hosts.map((host) => `dsh ${host}`), 'Notes']
  const lines = [
    `# DSH plugin compatibility matrix`,
    '',
    `Generated at ${matrix.generatedAt}. Hosts: ${hosts.join(', ')}.`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (const plugin of matrix.plugins) {
    const cells = hosts.map((host) => {
      const result = plugin.results[host]
      if (result.compatible === true) return '✅'
      if (result.compatible === false) return result.exempted ? '⚠️ exempted' : '❌'
      return '⚠️ error'
    })
    const notes = []
    for (const host of hosts) {
      const result = plugin.results[host]
      if (result.compatible === false) {
        notes.push(`${host}: ${Object.entries(result.requirements).map(([key, range]) => `${key} ${range}`).join(', ')}`)
      }
      if (result.compatible === null) notes.push(`${host}: ${result.error}`)
    }
    lines.push(`| ${plugin.name} | ${plugin.version} | ${cells.join(' | ')} | ${notes.join('; ') || ''} |`)
  }
  lines.push('', '## Host totals', '')
  for (const summary of hostSummary(matrix)) {
    lines.push(`- **${summary.host}**: ${summary.compatible}/${summary.total} compatible, ${summary.incompatible} incompatible, ${summary.errors} errors`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Render one static shields-style SVG badge.
 * @param {{label: string, value: string, color: string, minWidth?: number}} options - badge text and colour.
 * @returns {string} SVG document.
 */
export function badgeSvg({ label, value, color, minWidth = 132 }) {
  const labelWidth = Math.max(56, label.length * 7 + 16)
  const valueWidth = Math.max(56, value.length * 7 + 16)
  const width = Math.max(minWidth, labelWidth + valueWidth)
  const height = 20
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient>
  <rect width="${width}" height="${height}" rx="3" fill="#555"/>
  <rect x="${labelWidth}" width="${width - labelWidth}" height="${height}" rx="3" fill="${color}"/>
  <rect width="${width}" height="${height}" rx="3" fill="url(#g)"/>
  <g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14" text-anchor="middle">${escapeXml(label)}</text>
    <text x="${labelWidth + (width - labelWidth) / 2}" y="14" text-anchor="middle" font-weight="bold">${escapeXml(value)}</text>
  </g>
</svg>`
}

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[character])
}

/**
 * Write one badge per plugin plus a host summary badge.
 * @param {object} matrix - matrix document.
 * @param {string} outDir - directory to write into.
 * @returns {{directory: string, files: string[]}} written badges.
 */
export function writeBadges(matrix, outDir) {
  const directory = join(outDir, 'badges')
  mkdirSync(directory, { recursive: true })
  const files = []
  for (const plugin of matrix.plugins) {
    const results = matrix.hosts.map((host) => plugin.results[host])
    const compatible = results.filter((result) => result.compatible === true).length
    const total = matrix.hosts.length
    const color = compatible === total ? '#2f9e44' : compatible === 0 ? '#c92a2a' : '#e67700'
    const file = join(directory, `${safeFileName(plugin.name)}.svg`)
    writeFileSync(file, `${badgeSvg({ label: 'dsh compat', value: `${compatible}/${total} hosts`, color })}\n`)
    files.push(file)
  }
  for (const summary of hostSummary(matrix)) {
    const color = summary.incompatible === 0 && summary.errors === 0 ? '#2f9e44' : summary.compatible === 0 ? '#c92a2a' : '#e67700'
    const file = join(directory, `host-${safeFileName(summary.host)}.svg`)
    writeFileSync(file, `${badgeSvg({ label: `dsh ${summary.host}`, value: `${summary.compatible}/${summary.total} ok`, color })}\n`)
    files.push(file)
  }
  return { directory, files }
}

/**
 * Make a portable file name from a package name.
 * @param {string} name - package name.
 * @returns {string} file name.
 */
export function safeFileName(name) {
  return String(name).replace(/^@/, '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-')
}
