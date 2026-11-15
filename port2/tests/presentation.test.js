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
  let now = 1000;
  const shown = [], released = [], timers = [];
  const pr = { q: [], clock0: null, srcs: new Set(), st: { in: 0, shown: 0, drop: 0, reanchor: 0, lagMax: 0 } };
  const context = { pr, paused: false, Date: { now: () => now }, mlog() {}, setTimeout(fn) { timers.push(fn); return timers.length; } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const st = { onFrame(_sz, frame) { shown.push(frame); } };
  const src = { stdout: { pause() {}, resume() {} } };
  return { pr, shown, released,
    at(time) { now = time; while (timers.length) timers.shift()(); },
    frame(pts, frame) { context.prEnqueue(st, {}, frame, pts, src, f => released.push(f)); },
  };
}

test('slow decoding drops a lone late frame without delaying the video clock', () => {
  const s = scheduler();
  s.frame(0, 'first'); s.at(1060);
  const clock = s.pr.clock0;
  s.at(3000); s.frame(1 / 24, 'late');
  assert.equal(s.pr.clock0, clock, 'audio clock must not be abandoned under load');
  assert.equal(s.pr.st.drop, 1);
  assert.deepEqual(s.shown, ['first']);
  assert.deepEqual(s.released, ['first', 'late']);
  s.frame(2, 'caught up'); s.at(3060);
  assert.deepEqual(s.shown, ['first', 'caught up']);
});

test('queued late frames are discarded and timely frames retain their deadline', () => {
  const s = scheduler();
  s.frame(0, 'first'); s.frame(1 / 24, 'second'); s.frame(2 / 24, 'third');
  s.at(1220);
  assert.equal(s.pr.st.drop, 2);
  assert.deepEqual(s.shown, ['third']);
  assert.equal(s.released.length, 3);
});

test('a timestamp discontinuity still establishes a new deadline', () => {
  const s = scheduler(); s.frame(0, 'first'); s.at(1060);
  s.frame(20, 'seek'); s.at(1120);
  assert.deepEqual(s.shown, ['first', 'seek']);
});
