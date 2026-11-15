'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { patchPlayer } = require('../runtime/cache-player');
const resolution = require('../runtime/resolution');
const ext = path.join(__dirname, '../../tvui/apps/gibbontvui/20261016_37301/release/ext');
const bundles = fs.readdirSync(ext).filter(f => f.includes('nrdjs.min.js'));

function predicates(code) {
  const start = code.indexOf('e.checkFastplay=function(t,i,r){');
  const end = code.indexOf(',e.getVideoFrameRate=function', start);
  assert(start >= 0 && end > start, 'real startup predicates are present');
  const context = {
    e: { checkDrmHeaderInManifest: () => true },
    n: { A: { fastplay: true, maxPtsForFastplay: 100, maxPtsForMcClearen: 100 } },
    nrdjs: { videoPreparer: { manifestCache: { checkEnabled: () => true } } },
    nrdp: { device: { capability: { supportDrmPlaybackTransition: true } } },
    v() {},
  };
  vm.runInNewContext(code.slice(start, end), context);
  return context.e;
}

test('disk cache disables license-deferred startup on the bundled players', () => {
  assert(bundles.length);
  for (const file of bundles) {
    const code = fs.readFileSync(path.join(ext, file), 'utf8');
    const manifest = { hasClearProfile: true, hasMcClearen: true };
    const patched = patchPlayer(code);
    const original = predicates(code), cached = predicates(patched);
    assert.equal(original.checkFastplay('movie', 0, manifest), true);
    assert.equal(original.checkMcClearen('movie', 0, manifest), true);
    assert.equal(cached.checkFastplay('movie', 0, manifest), false);
    assert.equal(cached.checkMcClearen('movie', 0, manifest), false);
    assert.equal(predicates(resolution.patchPlayer(patched)).checkFastplay('movie', 0, manifest), false);
    assert.equal(patched.replace('e.checkFastplay=function(t,i,r){return!1;', 'e.checkFastplay=function(t,i,r){')
      .replace('e.checkMcClearen=function(e,t,i,r){return!1;', 'e.checkMcClearen=function(e,t,i,r){'), code);
  }
});

test('rejects missing or ambiguous hooks', () => {
  const code = fs.readFileSync(path.join(ext, bundles[0]), 'utf8');
  assert.throws(() => patchPlayer('new player version'), /unsupported Netflix player version/);
  assert.throws(() => patchPlayer(code + code), /unsupported Netflix player version/);
});
