'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../journal-core.js');
const NOW = new Date('2026-10-13T02:00:00.000Z'); // Shanghai 10:00.
const LATER = new Date('2026-10-13T03:30:00.000Z');
const copy = value => JSON.parse(JSON.stringify(value));
const task = patch => core.makeEntry({ type: 'task', text: 'Task', location: 'daily', date: '2026-10-13', ...patch }, NOW);
const byId = (entries, id) => entries.find(entry => entry.id === id);
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

test('Shanghai date changes at 16:00 UTC', () => {
  assert.equal(core.getToday(new Date('2026-10-12T15:59:59.000Z')), '2026-10-12');
  assert.equal(core.getToday(new Date('2026-10-12T16:00:00.000Z')), '2026-10-13');
});

test('legacy migration chains share identity without inventing timestamps', () => {
  const legacy = [
    { id: 'origin', text: 'Legacy task', type: 'task', status: 'migrated', location: 'daily', date: '2026-10-10', target: 'leaf' },
    { id: 'leaf', text: 'Legacy task', type: 'task', status: 'completed', location: 'daily', date: '2026-10-12', sourceId: 'origin' },
    { id: 'note', text: 'Old note', type: 'note', status: 'open', location: 'daily', date: '2026-10-12' },
  ];
  const snapshot = copy(legacy), normalized = core.normalize(freeze(legacy), NOW);
  assert.deepEqual(legacy, snapshot); assert.equal(normalized.length, 3);
  assert.ok(byId(normalized, 'origin').taskId);
  assert.equal(byId(normalized, 'origin').taskId, byId(normalized, 'leaf').taskId);
  assert.equal(byId(normalized, 'origin').status, 'migrated');
  assert.equal(byId(normalized, 'leaf').taskState, 'completed');
  normalized.forEach(entry => {
    assert.ok(entry.createdAt == null, 'Unknown creation time stays unknown');
    assert.ok(entry.completedAt == null, 'Unknown completion time stays unknown');
  });
});

test('tracking retains older open tasks and includes due, upcoming, undated and completed', () => {
  const older = task({ text: 'Older', date: '2026-10-10', plannedDate: '2026-10-10' });
  const overdue = task({ text: 'Missed', date: '2026-10-11', plannedDate: '2026-10-11', dueDate: '2026-10-12' });
  const today = task({ text: 'Today', plannedDate: '2026-10-13' });
  const upcoming = task({ text: 'Tomorrow', date: '2026-10-14', plannedDate: '2026-10-14' });
  const undated = task({ text: 'Undated', location: 'collection', collection: 'Ideas', date: '', plannedDate: '' });
  const completed = task({ text: 'Done' });
  const entries = core.changeTask([older, overdue, today, upcoming, undated, completed], completed.id, 'complete', NOW);
  const snapshot = copy(entries), buckets = core.tracking(freeze(entries), NOW);
  assert.deepEqual(entries, snapshot);
  for (const [bucket, expected] of Object.entries({ older, overdue, today, upcoming, undated, completed })) {
    assert.ok(Array.isArray(buckets[bucket]), bucket + ' is an array');
    assert.ok(buckets[bucket].some(entry => entry.taskId === expected.taskId), bucket + ' contains its task');
  }
  assert.ok(!buckets.overdue.some(entry => entry.taskId === completed.taskId));
  assert.ok(!buckets.older.some(entry => entry.taskId === completed.taskId));
});

test('date-only deadlines last through the Shanghai calendar day', () => {
  const entry = task({ plannedDate: '2026-10-12', dueDate: '2026-10-13', dueTime: '' });
  assert.equal(core.isLate(entry, new Date('2026-10-13T15:59:59.000Z')), false);
  assert.equal(core.isLate(entry, new Date('2026-10-13T16:00:00.000Z')), true);
  const timed = task({ plannedDate: '2026-10-13', plannedTime: '09:00', dueDate: '2026-10-13', dueTime: '10:00' });
  assert.equal(core.isLate(timed, new Date('2026-10-13T01:59:59.000Z')), false);
  assert.equal(core.isLate(timed, new Date('2026-10-13T02:01:00.000Z')), true);
});

test('start, complete and reopen retain history without mutating prior states', () => {
  const entry = task(), initial = freeze([entry]), snapshot = copy(initial);
  const started = core.changeTask(initial, entry.id, 'start', NOW);
  assert.deepEqual(initial, snapshot); assert.equal(byId(started, entry.id).taskState, 'doing');
  assert.equal(byId(started, entry.id).startedAt, NOW.toISOString());
  const startedSnapshot = copy(started), done = core.changeTask(freeze(started), entry.id, 'complete', LATER);
  assert.deepEqual(started, startedSnapshot); assert.equal(byId(done, entry.id).taskState, 'completed');
  assert.equal(byId(done, entry.id).status, 'completed'); assert.equal(byId(done, entry.id).completedAt, LATER.toISOString());
  assert.ok(byId(done, entry.id).history.length > byId(started, entry.id).history.length);
  const doneSnapshot = copy(done), reopened = core.changeTask(freeze(done), entry.id, 'reopen', LATER);
  assert.deepEqual(done, doneSnapshot); assert.equal(byId(reopened, entry.id).taskState, 'open');
  assert.equal(byId(reopened, entry.id).status, 'open'); assert.ok(byId(reopened, entry.id).completedAt == null);
  assert.ok(byId(reopened, entry.id).history.length > byId(done, entry.id).history.length);
});

test('migration preserves arrows and one task while editing and completing synchronize the chain', () => {
  const source = task({ text: 'Meeting', plannedDate: '2026-10-13' }), initial = freeze([source]), snapshot = copy(initial);
  const scheduled = core.migrate(initial, source.id, { location: 'future', date: '2026-10-14' }, NOW);
  assert.deepEqual(initial, snapshot); assert.equal(byId(scheduled, source.id).status, 'scheduled');
  assert.equal(core.activeTasks(scheduled).filter(entry => entry.taskId === source.taskId).length, 1);
  const future = core.activeTasks(scheduled).find(entry => entry.taskId === source.taskId);
  assert.notEqual(future.id, source.id);
  const moved = core.migrate(freeze(scheduled), future.id, { location: 'daily', date: '2026-10-15' }, LATER);
  const leaf = core.activeTasks(moved).find(entry => entry.taskId === source.taskId);
  assert.equal(moved.filter(entry => entry.taskId === source.taskId).length, 3);
  assert.equal(core.activeTasks(moved).filter(entry => entry.taskId === source.taskId).length, 1);
  assert.equal(byId(moved, future.id).status, 'migrated');
  const edited = core.updateEntry(freeze(moved), leaf.id, { text: 'Revised meeting', plannedDate: '2026-10-15', plannedTime: '09:00', dueDate: '2026-10-15', dueTime: '10:00' }, LATER, leaf.revision);
  edited.filter(entry => entry.taskId === source.taskId).forEach(entry => {
    assert.equal(entry.text, 'Revised meeting'); assert.equal(entry.plannedDate, '2026-10-15');
    assert.equal(entry.plannedTime, '09:00'); assert.equal(entry.dueTime, '10:00');
  });
  const finished = core.changeTask(freeze(edited), leaf.id, 'complete', LATER);
  finished.filter(entry => entry.taskId === source.taskId).forEach(entry => {
    assert.equal(entry.taskState, 'completed'); assert.equal(entry.completedAt, LATER.toISOString());
  });
  assert.equal(byId(finished, source.id).status, 'scheduled'); assert.equal(byId(finished, future.id).status, 'migrated');
  assert.equal(byId(finished, leaf.id).status, 'completed');
});

test('invalid dates, time and deadlines before plans are rejected', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-10-32']) assert.throws(() => task({ date, plannedDate: date }), 'Invalid date: ' + date);
  assert.throws(() => task({ plannedDate: '2026-10-13', plannedTime: '24:01' }));
  assert.throws(() => task({ plannedDate: '2026-10-13', dueDate: '2026-10-12' }));
  assert.throws(() => task({ plannedDate: '2026-10-13', plannedTime: '11:00', dueDate: '2026-10-13', dueTime: '10:00' }));
  const entry = task({ plannedDate: '2026-10-13' });
  assert.throws(() => core.updateEntry([entry], entry.id, { dueDate: '2026-10-12' }, NOW));
});

test('new future plans reject past dates while legacy past plans remain readable', () => {
  const entry = task();
  assert.throws(() => core.migrate([entry], entry.id, { location: 'future', date: '2026-10-12' }, NOW));
  assert.throws(() => task({ location: 'future', date: '2026-10-12', plannedDate: '2026-10-12' }));
  const legacy = core.normalize([{ id: 'old-future', text: 'Old plan', type: 'task', status: 'open', location: 'future', date: '2026-10-12' }], NOW);
  assert.equal(legacy.length, 1); assert.equal(legacy[0].id, 'old-future');
});

test('expected revision rejects stale edits without changing saved content', () => {
  const entry = task({ text: 'Original' }), initial = freeze([entry]), snapshot = copy(initial);
  assert.ok(Number.isInteger(entry.revision));
  const updated = core.updateEntry(initial, entry.id, { text: 'First editor' }, LATER, entry.revision);
  assert.deepEqual(initial, snapshot); const current = byId(updated, entry.id);
  assert.equal(current.text, 'First editor'); assert.ok(current.revision > entry.revision);
  const updatedSnapshot = copy(updated);
  assert.throws(() => core.updateEntry(freeze(updated), entry.id, { text: 'Stale editor' }, LATER, entry.revision));
  assert.deepEqual(updated, updatedSnapshot); assert.equal(byId(updated, entry.id).text, 'First editor');
});

test('events can be marked occurred, reopened and cancelled with timestamped history', () => {
  const event = core.makeEntry({ type: 'event', text: 'Discuss ideas', location: 'daily', date: '2026-10-13', plannedDate: '2026-10-13', plannedTime: '10:00' }, NOW);
  const initial = freeze([event]), snapshot = copy(initial), occurred = core.changeEvent(initial, event.id, 'occur', LATER);
  assert.deepEqual(initial, snapshot); assert.equal(byId(occurred, event.id).type, 'event');
  assert.equal(byId(occurred, event.id).eventState, 'occurred'); assert.equal(byId(occurred, event.id).occurredAt, LATER.toISOString());
  assert.ok(byId(occurred, event.id).history.length > event.history.length);
  const reopened = core.changeEvent(freeze(occurred), event.id, 'reopen', LATER);
  assert.equal(byId(reopened, event.id).eventState, 'planned'); assert.ok(byId(reopened, event.id).occurredAt == null);
  const cancelled = core.changeEvent(freeze(reopened), event.id, 'cancel', LATER);
  assert.equal(byId(cancelled, event.id).eventState, 'cancelled');
});

test('rescheduling an event moves its daily date and records the change without mutation', () => {
  const event = core.makeEntry({ type: 'event', text: 'Meeting', location: 'daily', date: '2026-10-13', plannedDate: '2026-10-13', plannedTime: '10:00' }, NOW);
  const initial = freeze([event]), snapshot = copy(initial);
  const moved = core.updateEntry(initial, event.id, { plannedDate: '2026-10-14', plannedTime: '14:00' }, LATER, event.revision);
  assert.deepEqual(initial, snapshot); assert.equal(byId(moved, event.id).date, '2026-10-14');
  assert.equal(byId(moved, event.id).plannedDate, '2026-10-14'); assert.equal(byId(moved, event.id).plannedTime, '14:00');
  assert.ok(byId(moved, event.id).history.length > event.history.length);
});

test('completion timeliness uses actual completion time and does not invent legacy completion time', () => {
  const late = task({ date: '2026-10-12', plannedDate: '2026-10-12', dueDate: '2026-10-12' });
  const lateDone = byId(core.changeTask([late], late.id, 'complete', NOW), late.id);
  assert.equal(core.isLate(lateDone, LATER), true);
  const onTime = task({ plannedDate: '2026-10-13', dueDate: '2026-10-14' });
  const onTimeDone = byId(core.changeTask([onTime], onTime.id, 'complete', NOW), onTime.id);
  assert.equal(core.isLate(onTimeDone, new Date('2026-10-15T02:00:00.000Z')), false);
  const legacy = core.normalize([{ id: 'legacy-done', text: 'Done long ago', type: 'task', status: 'completed', location: 'daily', date: '2026-10-11', dueDate: '2026-10-12' }], NOW)[0];
  assert.ok(legacy.completedAt == null);
  assert.notEqual(core.isLate(legacy, NOW), true);
});

test('future-plan placement begins tomorrow; same-day work belongs in daily records', () => {
  const entry = task();
  assert.throws(() => core.migrate([entry], entry.id, { location: 'future', date: '2026-10-13' }, NOW));
  assert.throws(() => task({ location: 'future', date: '2026-10-13', plannedDate: '2026-10-13' }));
  const tomorrow = core.migrate([entry], entry.id, { location: 'future', date: '2026-10-14' }, NOW);
  assert.equal(core.activeTasks(tomorrow)[0].date, '2026-10-14');
});

test('postponing beyond a deadline preserves that deadline and still permits text editing', () => {
  const entry = task({ text: 'Deadline task', plannedDate: '2026-10-13', dueDate: '2026-10-14' });
  const moved = core.migrate([entry], entry.id, { location: 'daily', date: '2026-10-15' }, NOW);
  const leaf = core.activeTasks(moved)[0], snapshot = copy(moved);
  assert.equal(leaf.plannedDate, '2026-10-15'); assert.equal(leaf.dueDate, '2026-10-14');
  const edited = core.updateEntry(freeze(moved), leaf.id, { text: 'Renamed deadline task' }, LATER, leaf.revision);
  assert.deepEqual(moved, snapshot);
  assert.equal(byId(edited, leaf.id).text, 'Renamed deadline task'); assert.equal(byId(edited, leaf.id).dueDate, '2026-10-14');
  assert.equal(core.isLate(byId(edited, leaf.id), new Date('2026-10-15T02:00:00.000Z')), true);
  assert.ok(core.tracking(edited, new Date('2026-10-15T02:00:00.000Z')).overdue.some(item => item.id === leaf.id));
});

test('future task rescheduling preserves task identity, state and dates after normalization', () => {
  const source = task();
  const scheduled = core.migrate([source], source.id, { location: 'future', date: '2026-10-15' }, NOW);
  const future = core.activeTasks(scheduled)[0];
  const started = core.changeTask(scheduled, future.id, 'start', NOW);
  const moved = core.updateEntry(started, future.id, { plannedDate: '2026-10-13' }, LATER);
  const reloaded = core.normalize(moved, LATER), leaf = byId(reloaded, future.id);
  assert.equal(leaf.location, 'daily'); assert.equal(leaf.date, '2026-10-13'); assert.equal(leaf.plannedDate, '2026-10-13');
  assert.equal(leaf.taskId, source.taskId); assert.equal(leaf.taskState, 'doing'); assert.equal(leaf.startedAt, NOW.toISOString());
  assert.equal(byId(reloaded, source.id).status, 'scheduled'); assert.equal(core.activeTasks(reloaded).length, 1);
  const later = core.updateEntry(reloaded, leaf.id, { text: 'Still doing' }, LATER);
  assert.equal(byId(later, leaf.id).taskState, 'doing'); assert.equal(byId(later, leaf.id).plannedDate, '2026-10-13');
});

test('legacy event text time is inferred only when an actual date is known', () => {
  const legacy = [
    { id: 'daily-time', type: 'event', text: '14:00 Meeting', location: 'daily', date: '2026-10-13', status: 'open' },
    { id: 'month-time', type: 'event', text: '14:00 Monthly meeting', location: 'monthly', date: '2026-10', status: 'open' },
    { id: 'collection-time', type: 'event', text: '14:00 Meeting idea', location: 'collection', collection: 'Ideas', date: '2026-10-13', status: 'open' },
    { id: 'explicit-null', type: 'event', text: '14:00 Literal text', location: 'daily', date: '2026-10-13', status: 'open', plannedTime: null },
  ];
  const snapshot = copy(legacy), normalized = core.normalize(freeze(legacy), NOW);
  assert.deepEqual(legacy, snapshot); assert.equal(byId(normalized, 'daily-time').plannedTime, '14:00');
  assert.equal(byId(normalized, 'explicit-null').plannedTime, null);
  for (const id of ['month-time', 'collection-time']) {
    assert.equal(byId(normalized, id).plannedDate, null); assert.equal(byId(normalized, id).plannedTime, null);
    const edited = core.updateEntry(normalized, id, { text: 'Editable old event' }, LATER);
    assert.equal(byId(edited, id).text, 'Editable old event');
  }
});
