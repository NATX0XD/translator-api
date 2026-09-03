import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken } from './auth.js';

test('extracts a bearer token', () => {
  assert.equal(extractBearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
});

test('accepts the capitalized header key and odd casing/spacing', () => {
  assert.equal(extractBearerToken({ headers: { Authorization: 'bearer  abc' } }), 'abc');
  assert.equal(extractBearerToken({ headers: { authorization: '  Bearer\tabc  ' } }), 'abc');
});

test('returns null when the header is missing or malformed', () => {
  assert.equal(extractBearerToken({ headers: {} }), null);
  assert.equal(extractBearerToken({}), null);
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken({ headers: { authorization: 'Bearer' } }), null);
  assert.equal(extractBearerToken({ headers: { authorization: 'Bearer ' } }), null);
  assert.equal(extractBearerToken({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(extractBearerToken({ headers: { authorization: 'abc' } }), null);
});
