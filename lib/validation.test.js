import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslateRequest } from './validation.js';

const target = (lang) => ({ lang, objective: 'general', formality: 50 });

test('two-way with exactly two targets is accepted', () => {
  assert.equal(validateTranslateRequest({ twoWay: true, targets: [target('Thai'), target('English')] }).ok, true);
});

test('two-way with the wrong number of targets is rejected', () => {
  for (const targets of [[], [target('Thai')], [target('Thai'), target('English'), target('Japanese')]]) {
    const result = validateTranslateRequest({ twoWay: true, targets });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid Request');
    assert.match(result.message, /exactly two/i);
  }
});

test('two-way with a non-array targets is rejected', () => {
  for (const targets of [undefined, null, 'Thai', { lang: 'Thai' }]) {
    assert.equal(validateTranslateRequest({ twoWay: true, targets }).ok, false);
  }
});

test('the one-way path is left alone', () => {
  assert.equal(validateTranslateRequest({ twoWay: false, targets: [target('Thai')] }).ok, true);
  assert.equal(validateTranslateRequest({ targets: [target('Thai')] }).ok, true);
  assert.equal(validateTranslateRequest({ twoWay: false, targets: undefined }).ok, true);
});
