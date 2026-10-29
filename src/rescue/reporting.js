/**
 * Upstream reporting: never ask a maintainer the same question twice.
 *
 * The user's complaint about eager reporting was specific — being told to file an
 * issue every time a scan runs is noise. So this module separates two actions that
 * are easy to conflate:
 *
 *   - `findExistingReports` is read-only and cheap: it answers "has someone already
 *     told the maintainer?" and, when the answer is yes, the UI can just link to it
 *     so the user adds a +1 instead of opening a duplicate.
 *   - `buildReport` only prepares text. Nothing here sends anything; handing the text
 *     to the user (or to their own tooling) stays an explicit, visible decision.
 *
 * The GitHub search API is used without authentication when no token is supplied,
 * which is rate limited but adequate for a check the user triggers by hand.
 * @module rescue/reporting
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Markers that let a later scan recognise our own reports. */
export const REPORT_MARKER = 'dsh-plugin-health-report'

/**
 * Parse `owner/repo` from the many shapes a package.json repository field takes.
 * @param {object} manifest
 * @returns {string|undefined}
 */
export function repositorySlug(manifest) {
  const raw = typeof manifest?.repository === 'string' ? manifest.repository : manifest?.repository?.url
  if (typeof raw !== 'string') return undefined
  // npm shorthand forms: `github:o/r`, `gitlab:o/r`, `o/r`.
  const shorthand = raw.match(/^(?:github|gitlab|bitbucket):([\w.-]+)\/([\w.-]+)$/u)
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`
  const cleaned = raw.replace(/^git\+/u, '').replace(/\.git$/u, '')
  const match = cleaned.match(/github\.com[:/]([^/]+)\/([^/#]+)/u)
  if (match) return `${match[1]}/${match[2]}`
  if (/^[\w.-]+\/[\w.-]+$/u.test(cleaned)) return cleaned
  return undefined
}

/**
 * Build the search terms used to detect a duplicate report.
 * @param {{name: string, runtimeVersion: string}} input
 */
export function searchQuery({ name, runtimeVersion }) {
  return `${name} ${runtimeVersion} compatibility`
}

/**
 * Ask GitHub whether an equivalent report already exists.
 * @param {object} options
 * @param {string} options.slug - `owner/repo`
 * @param {string} options.name - package name
 * @param {string} options.runtimeVersion
 * @param {string} [options.token]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{checked: boolean, existing: object[], error?: string}>}
 */
export async function findExistingReports({
  slug, name, runtimeVersion, token, fetchImpl = fetch,
  apiBase = 'https://api.github.com',
}) {
  const query = encodeURIComponent(`repo:${slug} ${searchQuery({ name, runtimeVersion })}`)
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-health' }
  if (token) headers.authorization = `Bearer ${token}`
  try {
    const response = await fetchImpl(`${apiBase}/search/issues?q=${query}&per_page=10`, { headers })
    if (!response.ok) return { checked: false, existing: [], error: `GitHub responded ${response.status}` }
    const body = await response.json()
    const existing = (body.items ?? []).map(item => ({
      number: item.number, title: item.title, state: item.state, url: item.html_url,
    }))
    return { checked: true, existing }
  } catch (error) {
    return { checked: false, existing: [], error: error.message }
  }
}

/**
 * Compose the issue body. It states only what this tool can prove: the declared
 * requirements, the host version, and the rehearsal verdict — never a claim about
 * what the plugin's code does or does not contain.
 * @param {object} input
 * @returns {{title: string, body: string}}
 */
export function buildReport({
  name, version, runtimeVersion, requirements = {}, rehearsal, repositoryUrl, toolVersion,
}) {
  const title = `${runtimeVersion} compatibility: declared requirements reject ${runtimeVersion}`
  const lines = []
  lines.push(`<!-- ${REPORT_MARKER} -->`)
  lines.push('')
  lines.push(`\`${name}@${version}\` declares DSH requirements that do not include \`${runtimeVersion}\`,`)
  lines.push('so the host rejects it during installation.')
  lines.push('')
  lines.push('### Declared requirements')
  lines.push('')
  lines.push('| Requirement | Declared range |')
  lines.push('| --- | --- |')
  for (const [requirement, range] of Object.entries(requirements)) {
    lines.push(`| \`${requirement}\` | \`${String(range).replace(/\|/gu, '\\|')}\` |`)
  }
  lines.push('')
  if (rehearsal !== undefined) {
    lines.push('### Runtime check')
    lines.push('')
    if (rehearsal === 'runs') {
      lines.push(`In an isolated DSH home on \`${runtimeVersion}\`, this exact version **installs and boots**`)
      lines.push('once the requirement is exempted. So this looks like a declaration-only problem:')
      lines.push('the code loads, the peer ranges just do not admit the new host yet.')
    } else if (rehearsal === 'broken') {
      lines.push(`In an isolated DSH home on \`${runtimeVersion}\`, this exact version still fails to boot`)
      lines.push('even after the requirement is exempted, so there is more to fix than the ranges.')
    } else {
      lines.push('The isolated runtime check was inconclusive for this version.')
    }
    lines.push('')
  }
  lines.push('### Suggested change')
  lines.push('')
  lines.push('```jsonc')
  lines.push(`// instead of enumerating every tested prerelease (each new nightly then needs another edit)`)
  for (const [requirement, range] of Object.entries(requirements).slice(0, 3)) {
    lines.push(`"${requirement}": ${JSON.stringify(range)}`)
  }
  lines.push(`// admit the whole line, or enumerate the exact test target if a CI check requires it`)
  lines.push('```')
  lines.push('')
  lines.push('If the repository runs its own enumeration check, add the exact version instead of a range —')
  lines.push('a range can fail that gate.')
  lines.push('')
  if (repositoryUrl) lines.push(`Repository: ${repositoryUrl}`)
  if (toolVersion) lines.push(`Checked with \`dsh-plugin-health@${toolVersion}\`.`)
  lines.push('')
  return { title, body: lines.join('\n') }
}

/**
 * Record that a report was prepared, so the UI can show it instead of asking again.
 * @param {string} profileDir
 * @param {object} record
 */
export function rememberReport(profileDir, record) {
  const path = join(profileDir, 'plugin-health-reports.json')
  let state = {}
  try { state = JSON.parse(readFileSync(path, 'utf8')) } catch { state = {} }
  state[`${record.name}@${record.runtimeVersion}`] = { ...record, at: new Date().toISOString() }
  try { writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`) } catch { /* optional */ }
}

/**
 * Read back previously prepared reports.
 * @param {string} profileDir
 */
export function readReports(profileDir) {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'plugin-health-reports.json'), 'utf8'))
  } catch {
    return {}
  }
}
