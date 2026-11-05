import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// An editor on this project decoded a UTF-8 file as GBK and wrote it back: an em dash became three
// replacement characters and `é` became a different character. Only four comment lines were hit, so
// nothing broke — but `src/ui/client.js` carries the Chinese interface text, and the same tool would
// have turned that into mojibake the user sees.
//
// The characters below are what UTF-8 read as GBK produces. None of them occurs naturally in this
// project's prose, so their presence is always a re-encoding accident.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Mojibake markers: the replacements for `—`, `é`, `…`, `→` and friends. */
const MOJIBAKE = /[\u9225\u9358\u93b4\u9510\u935a\u93c8\u951f\u9422\u9511\u9428\uFFFD]/u

const SKIP = new Set(['node_modules', '.git', 'site', 'dsh-health-out', 'coverage'])

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files(path, out)
    else if (/\.(?:js|mjs|md|json|yml)$/u.test(path)) out.push(path)
  }
  return out
}

test('no source or documentation file carries re-encoded text', () => {
  const offenders = []
  for (const path of files(ROOT)) {
    const text = readFileSync(path, 'utf8')
    const match = MOJIBAKE.exec(text)
    if (match === null) continue
    const line = text.slice(0, match.index).split('\n').length
    offenders.push(`${path.slice(ROOT.length + 1)}:${line} contains ${JSON.stringify(match[0])}`)
  }
  assert.deepEqual(offenders, [],
    `a file was decoded as the wrong charset and written back:\n  ${offenders.join('\n  ')}`)
})

test('the interface strings are still readable Chinese, not escapes or garbage', () => {
  // A shallow check on the one file where a bad round-trip would be visible to users.
  const client = readFileSync(join(ROOT, 'src', 'ui', 'client.js'), 'utf8')
  assert.match(client, /插件健康/u, 'the panel title must be real text')
  assert.doesNotMatch(client, /\\u63d2\\u4ef6/u, 'the title must not be escaped into unreadability')
  const han = (client.match(/[\u4e00-\u9fff]/gu) ?? []).length
  assert.ok(han > 200, `expected the Chinese dictionary to still be there, found ${han} characters`)
})
