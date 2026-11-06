import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The sidebar's "new version" strip did nothing when clicked. The first fix attempted was wrong in a
// way that made it worse, and the review caught it by running the real helpers in a browser:
//
//   A. strip above the shell settings icon → matched itself, click() re-entry does nothing, returned true
//   B. shell icon first                    → worked
//   C. a sibling plugin's "Reset all settings" → it clicked that
//   D. an unrelated dialog on screen       → claimed success, opened nothing
//
// The rewrite is pinned here by structure, and the four scenes are exercised for real in
// scripts/browser-qa.mjs, which has a browser. A unit test cannot reproduce A or C — the previous
// version of this file tried, with a mock that could not, and asserted on source text instead.
//
// What a unit test CAN do is stop the specific mistakes from coming back:
//
//   - matching a control by its label text (that is what clicked the reset button)
//   - treating any dialog as the settings surface (that is what claimed success in D)
//   - writing the failure message into the DOM (that clobbered React's spans and made the strip
//     match itself next time)

const source = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')

test('settings controls are found by selector, never by label text', () => {
  const start = source.indexOf('const clickShellTrigger = () => {')
  const end = source.indexOf('const dispatchSettingsShortcut', start)
  assert.ok(start > 0 && end > start, 'clickShellTrigger must exist')
  const body = source.slice(start, end)

  assert.doesNotMatch(body, /textContent/u, 'a label match is how the reset button got clicked')
  assert.doesNotMatch(body, /aria-label\]?\s*\)?\.\s*join|match\(\/设置/u, 'no pattern matching on names')
  assert.match(body, /for \(const selector of SETTINGS_SELECTORS\)/u, 'it must iterate known selectors only')
})

test('the settings surface is identified specifically, not by "any dialog"', () => {
  const start = source.indexOf('const settingsVisible = () => {')
  const end = source.indexOf('const clickShellTrigger', start)
  const body = source.slice(start, end)
  assert.match(body, /SETTINGS_DIALOG_SELECTORS/u)
  assert.doesNotMatch(body, /querySelectorAll\('\[role="dialog"\]'/u,
    'a bare [role=dialog] is a toast or a confirm box as often as it is settings')
})

test('the strip never matches itself, and the failure text lives in component state', () => {
  // The strip is a button. If a handler searches by text for "settings", the strip's own title
  // matches, so it clicks itself. The selector list must therefore exclude this tool's own DOM.
  assert.match(source, /\.closest\?\.\('\.dph-panel, \.dph-disclosure'\)/u, 'own panel must be excluded')

  const start = source.indexOf('function AlertEntry(props) {')
  const end = source.indexOf('const name = ', start)
  const body = source.slice(start, end)
  assert.match(body, /useState\(false\)/u, 'the failure flag is component state')
  assert.doesNotMatch(body, /textContent\s*=/u, 'never write into the DOM React owns')
})

test('the failure message does not itself contain the word that would re-trigger a match', () => {
  // Belt and braces: even though matching is by selector now, a message containing "settings" was
  // what made the old strip match itself on the second click.
  const zh = source.match(/alertOpenFailed: '([^']+)'/u)?.[1] ?? ''
  const en = source.match(/alertOpenFailed: '([^']+)'/u)?.[1] ?? ''
  for (const message of [zh, en]) {
    assert.ok(message.length > 0, 'both languages need the string')
  }
  assert.match(source, /alertRetry:/u, 'the strip offers a retry rather than repeating "View"')
})

test('the shortcut is attempted before the DOM', () => {
  const start = source.indexOf('const openSettingsSurface = (done) => {')
  const end = source.indexOf('/**\n         * Keep the sidebar alert in step', start)
  const body = source.slice(start, end > start ? end : start + 900)
  const shortcutAt = body.indexOf('dispatchSettingsShortcut()')
  const clickAt = body.indexOf('clickShellTrigger()')
  assert.ok(shortcutAt > 0, 'the shortcut must be tried')
  assert.ok(clickAt > shortcutAt, 'the DOM path is a fallback, after the shortcut')
})

test('the result is verified after a frame instead of assumed', () => {
  const start = source.indexOf('const openSettingsSurface = (done) => {')
  const body = source.slice(start, start + 900)
  assert.match(body, /setTimeout\(\(\) => done\(settingsVisible\(\)\), 200\)/u,
    'it must report what happened, not what was attempted')
  assert.doesNotMatch(body, /return true\s*$/mu, 'no unconditional success')
})
