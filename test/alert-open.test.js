import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The sidebar's "new version" strip did nothing when clicked, twice over:
//
//   1. `openSettingsSurface()` dispatched a synthetic keyboard event and returned true whether or not
//      the shell handled it, so the caller's `if (!went)` failure branch was unreachable.
//   2. That branch only wrote to document.title, which no user reads.
//
// These tests pin the behaviour of the fixed helpers by running them against a minimal DOM. They are
// extracted from the bundle rather than imported, because client.js is an IIFE built for the host's
// module loader — but the source is the source, and a behavioural assertion on it beats re-reading it.

const source = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')

/** Pull one function body out of the bundle by its opening line. */
function extract(opening) {
  const start = source.indexOf(opening)
  assert.notEqual(start, -1, `could not find ${opening}`)
  let depth = 0
  let seen = false
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; seen = true }
    else if (source[i] === '}') {
      depth -= 1
      if (seen && depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${opening}`)
}

/** A DOM good enough for these helpers, with a record of what was clicked. */
function makeDom({ settingsButtons = [] } = {}) {
  const clicked = []
  const make = (label, { disabled = false, visible = true } = {}) => {
    const element = {
      disabled,
      textContent: label,
      getAttribute: (name) => (name === 'aria-label' ? label : null),
      getClientRects: () => (visible ? [{}] : []),
      closest: () => null,
      click() { clicked.push(label) },
    }
    return element
  }
  const dialogs = []
  return {
    clicked,
    dialogs,
    document: {
      querySelectorAll: (selector) => {
        if (/dialog/u.test(selector)) return dialogs
        return settingsButtons.map((b) => make(b.label, b))
      },
      querySelector: () => null,
      activeElement: null,
      body: { dispatchEvent: () => {} },
      title: '',
    },
  }
}

/** Run the helper bodies with the globals they expect. */
function load(dom, t = (key) => key) {
  const settingsVisible = new Function('document', `${extract('const settingsVisible = () => {')}; return settingsVisible`)(
    dom.document,
  )
  const clickShellTrigger = new Function('document', `${extract('const clickShellTrigger = () => {')}; return clickShellTrigger`)(
    dom.document,
  )
  const reportOpenFailure = new Function(
    'document', 't', 'alertOpenNotice',
    `let notice; const fn = ${extract('const reportOpenFailure = (element) => {').replace('const reportOpenFailure = ', '')};
     fn;`,
  )
  return { settingsVisible, clickShellTrigger, reportOpenFailure, t }
}

test('the helper no longer reports success for an event nobody handles', () => {
  // The old body returned true unconditionally. The new one checks whether the dialog exists first.
  const body = extract('const openSettingsSurface = (element) => {')
  assert.match(body, /if \(settingsVisible\(\)\) return true/u, 'it must check the dialog first')
  assert.doesNotMatch(body, /return true\s*\}\s*catch/u, 'it must not swallow a failure into success')
  assert.match(body, /if \(!clicked && !dispatchSettingsShortcut\(\)\) return false/u,
    'with no click and no shortcut it must report failure')
})

test('the failure branch is reachable and the message is user-visible', () => {
  const handler = extract('open: (event) => {')
  assert.match(handler, /const went = openSettingsSurface\(event\?\.currentTarget\)/u)
  assert.match(handler, /if \(!went\) reportOpenFailure\(event\?\.currentTarget\)/u,
    'the caller must report, not silently continue')

  const report = extract('const reportOpenFailure = (element) => {')
  assert.match(report, /data-dph-alert-text/u, 'the message goes into the strip the user just pressed')
  assert.match(report, /document\.title/u, 'document.title stays as a secondary signal')
})

test('a settings control is found and clicked', () => {
  const dom = makeDom({ settingsButtons: [{ label: '设置' }] })
  const { clickShellTrigger } = load(dom)
  assert.equal(clickShellTrigger(), true)
  assert.deepEqual(dom.clicked, ['设置'])
})

test('an English settings control is found too', () => {
  const dom = makeDom({ settingsButtons: [{ label: 'Settings' }] })
  const { clickShellTrigger } = load(dom)
  assert.equal(clickShellTrigger(), true)
  assert.deepEqual(dom.clicked, ['Settings'])
})

test('a disabled or invisible control is skipped, and failure is reported', () => {
  const dom = makeDom({
    settingsButtons: [
      { label: '设置', disabled: true },
      { label: 'Settings', visible: false },
    ],
  })
  const { clickShellTrigger } = load(dom)
  assert.equal(clickShellTrigger(), false, 'nothing clickable means failure, not a silent success')
  assert.deepEqual(dom.clicked, [])
})

test('the dialog check looks for a rendered dialog, not just its presence', () => {
  const dom = makeDom()
  const { settingsVisible } = load(dom)
  assert.equal(settingsVisible(), false, 'no dialog at all')

  const hidden = { getClientRects: () => [] }
  dom.dialogs.push(hidden)
  assert.equal(settingsVisible(), false, 'a dialog in the DOM but not on screen does not count')

  dom.dialogs.push({ getClientRects: () => [{}] })
  assert.equal(settingsVisible(), true, 'a rendered dialog counts')
})

test('both languages carry the fallback instruction', () => {
  const zh = source.includes('alertOpenFailed:') && /Ctrl\+逗号|Ctrl\+Comma/u.test(source)
  assert.ok(zh, 'the fallback must tell the user the keyboard route')
  // The English string names both platforms' modifiers.
  assert.match(source, /Cmd\+Comma on a Mac|Cmd\+逗号/u)
})
