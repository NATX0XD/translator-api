import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResponseSchema } from './responseSchema.js';

test('two-way pins translations to exactly one entry', () => {
  const translations = buildResponseSchema(true).properties.translations;
  assert.equal(translations.minItems, 1);
  assert.equal(translations.maxItems, 1);
});

test('one-way leaves the array unbounded, so several targets still work', () => {
  const translations = buildResponseSchema(false).properties.translations;
  assert.equal('minItems' in translations, false);
  assert.equal('maxItems' in translations, false);
});

test('the rest of the contract is unchanged either way', () => {
  for (const twoWay of [true, false]) {
    const schema = buildResponseSchema(twoWay);
    assert.deepEqual(schema.required, ['detected', 'translations']);
    assert.deepEqual(schema.properties.translations.items.required, ['lang', 'text']);
    assert.equal(schema.properties.detected.type, 'string');
  }
});
