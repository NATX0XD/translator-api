import test from 'node:test';
import assert from 'node:assert/strict';
import { planToUpdate } from './firestorePlan.js';

test('absolute fields pass through untouched', () => {
  const update = planToUpdate({ set: { tokens_today: 0, last_reset_date: '2026-09-03' }, increment: {}, delete: [] });
  assert.deepEqual(update, { tokens_today: 0, last_reset_date: '2026-09-03' });
});

test('increments and deletes become FieldValue sentinels, not raw numbers', () => {
  const update = planToUpdate({ set: {}, increment: { live_seconds_today: 42 }, delete: ['live_session'] });

  assert.equal(typeof update.live_seconds_today, 'object');
  assert.notEqual(update.live_seconds_today, 42, 'a raw 42 here would overwrite instead of add');
  assert.equal(typeof update.live_session, 'object');
});

test('all three kinds compose into one update', () => {
  const update = planToUpdate({
    set: { live_seconds_limit: 600 },
    increment: { live_seconds_today: 30 },
    delete: ['live_session'],
  });

  assert.deepEqual(Object.keys(update).sort(), ['live_seconds_limit', 'live_seconds_today', 'live_session']);
  assert.equal(update.live_seconds_limit, 600);
});

test('missing increment/delete keys are tolerated', () => {
  assert.deepEqual(planToUpdate({ set: { a: 1 } }), { a: 1 });
});
