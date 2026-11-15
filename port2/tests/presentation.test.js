'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

// Exercise the production scheduler with a controlled clock and decoded frames.
function scheduler() {
  const source = fs.readFileSync(require.resolve('../runtime/media'), 'utf8');
  const start = source.indexOf('    function prRun() {');
  const end = source.indexOf('    function makeChain(', start);
  assert(start >= 0 && end > start);
  let now = 1000, audioPts = null;
  const shown = [], released = [], timers = [];
  const pr = { q: [], clock0: null, srcs: new Set(), st: { in: 0, shown: 0, drop: 0, reanchor: 0, lagMax: 0 } };
  const context = { pr, audioClock: { position: () => audioPts }, paused: false, Date: { now: () => now }, mlog() {}, setTimeout(fn) { timers.push(fn); return timers.length; } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const st = { onFrame(_sz, frame) { shown.push(frame); } };
  const src = { stdout: { pause() {}, resume() {} } };
  return { pr, shown, released,
    audio(pts) { audioPts = pts; },
    at(time) { now = time; for (const fn of timers.splice(0)) fn(); },
    frame(pts, frame, sess) { context.prEnqueue(st, {}, frame, pts, src, f => released.push(f), sess); },
  };
}

test('slow decoding preserves the clock and presents periodic progress', () => {
  const s = scheduler();
  s.frame(0, 'first'); s.at(1060);
  const clock = s.pr.clock0;
  s.at(3000); s.frame(1 / 24, 'late');
  assert.equal(s.pr.clock0, clock, 'audio clock must not be abandoned under load');
  assert.deepEqual(s.shown, ['first', 'late'], 'sustained overload must still report progress');
  s.frame(2 / 24, 'drop');
  assert.equal(s.pr.st.drop, 1);
  assert.deepEqual(s.released, ['first', 'late', 'drop']);
  s.frame(2, 'caught up'); s.at(3060);
  assert.deepEqual(s.shown, ['first', 'late', 'caught up']);
});

test('queued late frames are discarded and timely frames retain their deadline', () => {
  const s = scheduler();
  s.frame(0, 'first'); s.frame(1 / 24, 'second'); s.frame(2 / 24, 'third');
  s.at(1220);
  assert.equal(s.pr.st.drop, 1);
  assert.deepEqual(s.shown, ['first', 'third']);
  assert.equal(s.released.length, 3);
});

test('a timestamp discontinuity still establishes a new deadline', () => {
  const s = scheduler(); s.frame(0, 'first'); s.at(1060);
  s.frame(20, 'seek'); s.at(1120);
  assert.deepEqual(s.shown, ['first', 'seek']);
});

// UI/image work on a slow CPU can delay the first presentation timer.
test('late startup timer cannot discard every frame before the first update', () => {
  const s = scheduler();
  s.frame(0, 'first'); s.frame(1 / 24, 'second');
  s.at(3000);
  assert.deepEqual(s.shown, ['first']);
  assert.equal(s.pr.clock0, 1060);
  assert.equal(s.pr.st.drop, 1);
  s.at(3300); s.frame(2 / 24, 'third');
  assert.deepEqual(s.shown, ['first', 'third']);
  assert.equal(s.pr.clock0, 1060);
});

test('video follows the audio session clock despite host-clock delay', () => {
  const s = scheduler();
  s.audio(100); s.frame(0, 'first', 100);
  assert.deepEqual(s.shown, ['first']);
  s.frame(1 / 25, 'second', 100.04);
  s.at(5000);
  assert.deepEqual(s.shown, ['first'], 'host time cannot advance video past stalled audio');
  s.audio(100.04); s.at(5040);
  assert.deepEqual(s.shown, ['first', 'second']);
});
