// Replaces the previous version of this file, which the review showed could not have caught anything:
// its mock returned null from closest(), the extracted failure function was never executed, and it
// asserted on source text for an attribute the component did not have.
//
// These tests pin the specific mistakes that were made, using the markup DSH actually emits. The
// interaction itself is exercised in scripts/browser-qa.mjs, which has a browser.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')

test('the settings dialog selector matches the markup DSH really uses', () => {
  // From @deepseek-ai/dsh-client-ui-settings-general 0.2.1-rc.4, lib/client.js:280-293. The previous
  // list ([data-dsh-settings], data-testid=…) was invented, so it never matched: the dialog opened
  // and the strip still reported failure.
  assert.match(source, /\[data-shortcut-modal="settings"\]/u,
    'the real dialog carries data-shortcut-modal="settings"')
  assert.doesNotMatch(source, /'\[data-dsh-settings\]'/u, 'the invented attribute must be gone')
})

test('the settings button selector requires aria-haspopup', () => {
  // lib/client.js:451-462. Without aria-haspopup, any gear labelled "Settings" inside another
  // plugin's UI matches — which is how the reset button got pressed.
  assert.match(source, /button\[aria-haspopup="dialog"\]\[aria-label="设置"\]/u)
  assert.match(source, /button\[aria-haspopup="dialog"\]\[aria-label="Settings"\]/u)
})

test('clickShellTrigger matches by selector only, never by label text', () => {
  const start = source.indexOf('const clickShellTrigger = () => {')
  const end = source.indexOf('const openSettingsSurface', start)
  assert.ok(start > 0 && end > start)
  const body = source.slice(start, end)
  assert.doesNotMatch(body, /textContent/u, 'reading textContent to match is how the reset button was hit')
  assert.match(body, /for \(const selector of SETTINGS_SELECTORS\)/u)
})

test('no synthetic keyboard event is dispatched', () => {
  // The desktop build receives shortcuts natively and its DOM keydown handler returns early, so a
  // dispatched event does nothing there; on the web build the shortcut toggles, so it would close
  // settings again after the click opened it.
  assert.doesNotMatch(source, /dispatchSettingsShortcut/u, 'the shortcut path must be gone')
  assert.doesNotMatch(source, /new KeyboardEvent/u, 'and so must the synthetic event')
})

test('the failure text does not hard-code a key combination', () => {
  // Wrong on macOS (Cmd), wrong on the web build (Ctrl+Alt), and wrong for anyone who rebound it.
  assert.doesNotMatch(source, /Ctrl\+(逗号|Comma)/u, 'point at the button instead of a key')
  const messages = [...source.matchAll(/alertOpenFailed: '([^']+)'/gu)].map((m) => m[1])
  assert.equal(messages.length, 2, 'one message per language')
  for (const message of messages) assert.ok(message.length > 0)
})

test('the outcome is read from the DOM after a delay, not assumed', () => {
  const start = source.indexOf('const openSettingsSurface = (done) => {')
  const body = source.slice(start, start + 400)
  assert.match(body, /setTimeout\(\(\) => done\(settingsVisible\(\)\), 250\)/u,
    'the answer comes from whether the dialog appeared')
  assert.doesNotMatch(body, /return true\s*$/mu, 'no unconditional success')
})

test('the strip reports failure in component state, not by writing the DOM', () => {
  const start = source.indexOf('function AlertEntry(props) {')
  const end = source.indexOf('const name = ', start)
  const body = source.slice(start, end)
  assert.match(body, /useState\(false\)/u, 'the failure flag is state')
  assert.doesNotMatch(body, /textContent\s*=/u, 'never write into nodes React owns')
  assert.match(body, /alertRetry/u, 'the strip offers a retry')
})
