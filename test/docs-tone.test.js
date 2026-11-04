import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Several tools in this ecosystem overlap with this one — dsh-plugin-health-check, other health-check
// CLIs, marketplace scanners. A page that claims to be the only thing that can do X is either false or
// unfalsifiable, and a reader who knows the ecosystem stops trusting the rest of it.
//
// So: describe what this package does, and let the reader compare.
//
// The hard part is that the word "only" is usually innocent: "only then decides", "we only prove it
// boots", "read-only". What has to go is the *comparative* use — "the only tool that…", "unlike other
// checkers", "唯一能…". The rule is therefore placement-based, not word-based.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

const DOCS = ['README.md', 'docs/README.zh.md', 'SECURITY.md', 'package.json', 'action.yml']

/** Only prose is checked: fenced code and inline code legitimately contain any word. */
function prose(text) {
  return text
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/`[^`]*`/gu, '')
}

/**
 * Phrasings that assert a position relative to other tools.
 *
 * Each is a shape, not a word: "the only <thing>", "only <tool> that", "unlike <other tools>",
 * "no other <thing>", plus the Chinese equivalents. A bare "only" in an adverbial position
 * ("only then", "only proves") does not match.
 */
const COMPARATIVE = [
  [/(?<![A-Za-z-])the only\s+\w+/iu, 'the only …'],
  [/(?<![A-Za-z-])only\s+(tool|plugin|checker|package|project)\b/iu, 'only <noun>'],
  [/\bunique\s+(tool|plugin|checker|approach|feature|solution)/iu, 'unique <noun>'],
  [/\b(exclusive|sole)\s+(tool|plugin|checker|provider)/iu, 'exclusive/sole <noun>'],
  [/\bno other\s+(tool|plugin|checker|package)/iu, 'no other <noun>'],
  [/\bnothing else\s+(can|does|will)/iu, 'nothing else can'],
  [/\bunlike\s+(other|most|any|every)\b/iu, 'unlike other …'],
  [/\b(can|could)\s+(actually|really)\b/iu, 'can actually'],
  [/\bthe first\s+(tool|plugin|checker|package)\b/iu, 'the first <noun>'],
  [/唯一(能|可以|支持|做到)/u, '唯一能…'],
  [/独有|独家|无出其右|无人能|市面上没有/u, '中文独占词'],
  [/首个(能|可以|支持)|第一家/u, '首个能…'],
  [/(其他|别的|市面上的?)(工具|插件|检查器|管理器|产品)[^。\n]{0,15}(只能|只做|不会|做不到|都不)/u, '评价其他工具'],
  [/(静态)?检查(工具|器)?(只|仅)(会|能)(报|扫|看)/u, '评价静态检查工具'],
]

test('no doc asserts a position relative to other tools', () => {
  const offences = []
  for (const file of DOCS) {
    let text
    try { text = read(file) } catch { continue }
    const body = prose(text)
    for (const [pattern, label] of COMPARATIVE) {
      const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
      for (const match of body.matchAll(global)) {
        const from = Math.max(0, match.index - 55)
        offences.push(`${file}: [${label}] …${body.slice(from, match.index + 65).replace(/\s+/gu, ' ')}…`)
      }
    }
  }
  assert.deepEqual(offences, [], `comparative claims found:\n  ${offences.join('\n  ')}`)
})

test('the package description says what it does, not where it ranks', () => {
  const description = JSON.parse(read('package.json')).description
  assert.ok(description.length > 80, 'a description that says nothing is as bad as one that overclaims')
  assert.doesNotMatch(description, /\bcan actually\b|\bthe only\b|\bunique\b|\bexclusive\b/iu)
  assert.match(description, /plugins?\b/iu, 'it has to mention the thing a user searches for')
})

test('the honest comparison stays: what reading declarations cannot tell you', () => {
  // The rule is not "never mention that other approaches exist". It is "do not claim superiority".
  // The measurement table is the honest form: same declaration, three different outcomes.
  assert.match(read('README.md'), /Reading declarations cannot tell them apart/u)
  assert.match(read('docs/README.zh.md'), /读声明分不出它们的区别/u)
})
