'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AudioClock } = require('../runtime/audio-clock');

test('audio progress follows session timestamps and the configured output buffer', () => {
  const c = new AudioClock(() => 1000), src = {};
  c.start(src, 126.76);
  assert.equal(c.position(), null);
  c.update(src, 'out_time_us=600');
  assert.equal(c.position(), null);
  c.update(src, '000\nprogress=continue\n');
  assert.equal(c.position(), 127.26);
  c.update(src, 'out_time_us=800000\n');
  assert(Math.abs(c.position() - 127.46) < 1e-9);
});

test('missing or stalled audio progress never advances on the host clock', () => {
  let now = 1000;
  const c = new AudioClock(() => now), src = {};
  c.start(src, 0); c.update(src, 'out_time_us=N/A\n');
  assert.equal(c.position(), null);
  c.update(src, 'out_time_us=50000\n'); assert.equal(c.position(), 0);
  c.update(src, 'out_time_us=1000000\n'); now += 5000;
  assert.equal(c.position(), 1);
});

test('replacement audio ignores late progress from the previous process', () => {
  const c = new AudioClock(() => 1000), a = {}, b = {};
  c.start(a, 0); c.update(a, 'out_time_us=2000000\n');
  c.start(b, 20); c.update(a, 'out_time_us=3000000\n');
  assert.equal(c.position(), null);
  c.update(b, 'out_time_us=1000000\n'); assert.equal(c.position(), 20.9);
  c.update(b, 'out_time_us=100\n'); assert.equal(c.position(), 20.9);
  c.reset(); assert.equal(c.position(), null);
});
