import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { forbiddenTerminology, noticeRoute, verifyLocalePairs, verifyTerminology } from './check-locales.mjs'

test('notice routes keep POSIX separators on every platform', () => {
  // `markdownFiles` builds its paths with `path.relative`, which separates with
  // backslashes on Windows. The notice is a routed link, so a backslash there
  // makes every Chinese mirror look like it is missing its source notice.
  const relative = ['01-product', '00-overview.md'].join(path.sep)

  assert.equal(noticeRoute(relative), '/spec/01-product/00-overview')
  assert.equal(noticeRoute('03-runtime/01-ipc-protocol.md'), '/spec/03-runtime/01-ipc-protocol')
  assert.ok(!noticeRoute(relative).includes('\\'))
})

test('every English specification has a valid Chinese mirror', () => {
  const { englishFiles, missing, invalid } = verifyLocalePairs()

  assert.ok(englishFiles.length > 0, 'expected to discover English specifications')
  assert.deepEqual(missing, [], 'Chinese specifications missing for the listed English pages')
  assert.deepEqual(invalid, [], 'Chinese pages whose source notice or structure is invalid')
})

test('the Chinese specifications contain no forbidden terminology', () => {
  // The counts matter as much as the check: a rule wide enough to match a
  // legitimate sentence makes the gate noise that people learn to ignore.
  assert.deepEqual(verifyTerminology(), [], 'banned terminology found in the Chinese specifications')
})

test('the Electron main-process rule matches only the wrong form', () => {
  const rule = forbiddenTerminology.find(({ pattern }) => pattern.test('Electron 主要'))

  assert.ok(rule, 'expected a rule covering the Electron main-process mistranslation')
  assert.ok(!rule.pattern.test('Electron 主进程'), 'the corrected form must not match')
  assert.ok(!rule.pattern.test('Electron 主要进程'), 'a longer correct form must not match')
})
