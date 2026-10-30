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
import semver from 'semver'

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
/**
 * Upper bound that admits the rest of one prerelease line without opening the next one.
 *
 * `<0.3.0-0` would admit `0.2.2-alpha.1`, which is a different host line the author has not
 * vouched for. The ceiling has to sit immediately above the line being admitted:
 * for `0.2.1-rc.N` that is `0.2.2-0`.
 * @param {string} version - newest enumerated version
 */
function ceilingFor(version) {
  const major = semver.major(version)
  const minor = semver.minor(version)
  const patch = semver.patch(version)
  // A version on a `.0` patch is the first of its line, so its ceiling is the next minor;
  // anything later is a patch line whose ceiling is the next patch.
  return patch === 0 ? `0.${minor + 1}.0-0` : `0.${minor}.${patch + 1}-0`
}

/**
 * Work out what the range *should* say, from what it currently says.
 *
 * The original version of this function printed the declared range back unchanged with a vague
 * comment, which is useless to a maintainer: it names the problem but not the edit. A report is
 * only worth filing if it carries a value the author can paste.
 *
 * Strategy, in order of what a maintainer is likely to accept:
 *
 *   - already a range that merely stops short  → widen the upper bound to the next line
 *   - an enumeration of the same line          → replace with a range covering that line
 *   - an enumeration spanning several lines    → widen to cover from the newest enumerated
 *                                                version, so future nightlies are admitted
 *
 * A version already inside a range needs no change, so it is reported as such.
 * @param {string} range - the declared range string
 * @param {string} runtimeVersion - the host version being rejected
 * @returns {{suggested: string, why: string, keepsEnumeration: boolean}|{error: string}}
 */
export function suggestRange(range, runtimeVersion) {
  if (typeof range !== 'string' || range.trim() === '') return { error: 'empty range' }
  const text = range.trim()
  if (semver.validRange(runtimeVersion) === null) return { error: 'invalid runtime version' }

  // A range that already covers the host needs no edit; say so rather than pretend otherwise.
  if (semver.satisfies(runtimeVersion, text, { includePrerelease: true })) {
    return { suggested: text, why: 'already covers this version', keepsEnumeration: false }
  }

  const alternatives = text.split('||').map(part => part.trim()).filter(Boolean)
  // Collect the concrete versions the author has already vouched for.
  const versions = []
  for (const alternative of alternatives) {
    for (const match of alternative.matchAll(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu)) {
      if (semver.valid(match[1]) !== null) versions.push(match[1])
    }
  }
  if (versions.length === 0) {
    // A range with no explicit version cannot be widened mechanically; ask for the exact edit.
    return { error: 'the declared range names no concrete version to build on' }
  }
  const newest = versions.sort(semver.compare).at(-1)
  const line = `${semver.major(newest)}.${semver.minor(newest)}.${semver.patch(newest)}`
  const ceiling = ceilingFor(newest)

  // Did the author enumerate one version line, or several? A single line can become a range.
  const lines = new Set(versions.map(v => `${semver.major(v)}.${semver.minor(v)}.${semver.patch(v)}`))
  const enumerated = alternatives.length > 1 || versions.length > 1

  if (lines.size === 1) {
    // Same line: replace the whole enumeration with one range covering it and later builds.
    const suggested = `>=${line}-0 <${ceiling}`
    return {
      suggested,
      why: enumerated
        ? `all ${versions.length} enumerated versions sit on the ${line} line, so one range covers them and every later ${line} build`
        : `admits ${line} and every later build on that line`,
      keepsEnumeration: false,
    }
  }

  // Several lines enumerated: keep the history and open the top end only as far as the
  // author's own newest version justifies.
  return {
    suggested: `${text} || >=${newest} <${ceiling}`,
    why: `adds the admitted top of the ${line} line without dropping the versions you already list, and without claiming the next host line`,
    keepsEnumeration: true,
  }
}

/**
 * Compose the issue body.
 *
 * Two rules shaped this: state only what the tool can prove, and make the suggested edit
 * something the maintainer can paste without thinking. The earlier version broke the second
 * rule — it echoed the old range with an explanatory comment, which names the problem but not
 * the change.
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
      lines.push('the code loads, the ranges just do not admit the new host yet.')
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
  const suggestions = []
  for (const [requirement, range] of Object.entries(requirements)) {
    const result = suggestRange(range, runtimeVersion)
    if (result.error !== undefined) suggestions.push({ requirement, range, error: result.error })
    else suggestions.push({ requirement, range, ...result })
  }
  const actionable = suggestions.filter(item => item.suggested !== undefined && item.suggested !== item.range)
  if (actionable.length === 0) {
    lines.push('The declared range already covers this version — the rejection may come from a different field.')
  } else {
    lines.push('```jsonc')
    for (const item of actionable) {
      lines.push(`"${item.requirement}": ${JSON.stringify(item.suggested)}`)
    }
    lines.push('```')
    lines.push('')
    for (const item of actionable) {
      lines.push(`- \`${item.requirement}\`: ${item.why}`)
    }
  }
  const failed = suggestions.filter(item => item.error !== undefined)
  if (failed.length > 0) {
    lines.push('')
    for (const item of failed) lines.push(`- \`${item.requirement}\`: ${item.error} — needs a manual decision`)
  }
  lines.push('')
  if (suggestions.some(item => item.keepsEnumeration === true)) {
    lines.push('> This repository appears to enumerate host versions deliberately. If a CI check requires the')
    lines.push('> enumeration form, add the exact version rather than a range instead of applying the above.')
    lines.push('')
  }
  if (repositoryUrl) lines.push(`Repository: ${repositoryUrl}`)
  if (toolVersion) lines.push(`Checked with \`dsh-plugin-health@${toolVersion}\`.`)
  lines.push('')
  return { title, body: lines.join('\n'), suggestions }
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
