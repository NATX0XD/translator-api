import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemInstruction } from './prompt.js';

test('default instruction is unchanged for the normal path', () => {
  assert.equal(
    buildSystemInstruction(false),
    "Expert Translator. Detect source language (English name). Translate by Formality(0-100) & Objective per target."
  );
});

test('two-way instruction asks for a single non-source translation', () => {
  const instruction = buildSystemInstruction(true);
  assert.match(instruction, /exactly one/i);
  assert.match(instruction, /not the source/i);
});
