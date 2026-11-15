'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual host with a synthetic UI, isolated from real credentials,
// viewer and CDM. An interval keeps it alive until the requested exit.
function runHost(code, preload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumflix-exit-'));
  try {
    const runtime = path.join(dir, 'port2/runtime');
    fs.cpSync(path.join(__dirname, '../runtime'), runtime, { recursive: true });
    const ui = path.join(dir, 'tvui/apps/gibbontvui/20261016_37301/release');
    fs.mkdirSync(ui, { recursive: true });
    fs.writeFileSync(path.join(ui, 'darwinBootstrap.js'), `
      if (nrdp.device.capability.hasSuspend !== false) throw new Error('incorrect suspend capability');
      setInterval(() => {}, 1000);
      setTimeout(() => { console.log('synthetic UI requests exit'); ${code} }, 50);
    `);
    const env = { ...process.env, HOME: dir, NOCDMHOST: '1', NODESKTOPENTRY: '1', NOBOOTURL: '1', NOV8CACHE: '1', WINDOW: '0' };
    const args = [];
    if (preload) { const file = path.join(dir, 'preload.js'); fs.writeFileSync(file, preload); args.push('--require', file); }
    const result = cp.spawnSync(process.execPath, [...args, path.join(runtime, 'host.js')], { env, cwd: runtime, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.match(result.stdout, /synthetic UI requests exit/);
    return result;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Netflix exit closes the host and suspend is not advertised', () => {
  const result = runHost('nrdp.exit();');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('explicit non-restart exit codes are propagated', () => {
  const result = runHost('nrdp.exit(42);');
  assert.equal(result.status, 42, result.stdout + result.stderr);
});

test('foreground restart uses existing restart path', () => {
  const result = runHost('nrdp.exit(75);', `
    const cp = require('node:child_process'), spawn = cp.spawn;
    cp.spawn = function(bin, args, opts) {
      if (bin === 'sh' && args[1].startsWith('sleep 0.5; kill -9')) {
        console.log('restart subprocess requested');
        return { unref() {} };
      }
      return spawn(bin, args, opts);
    };
  `);
  assert.match(result.stdout, /restart subprocess requested/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('bundled exit fallback uses nrdp.exit when suspend is unsupported', () => {
  const filename = path.join(__dirname, '../../tvui/apps/gibbontvui/20261016_37301/release/darwinBootstrap.js');
  const code = fs.readFileSync(filename, 'utf8');
  const start = code.indexOf('KF44:function('), end = code.indexOf('},KHTo:function', start);
  assert(start >= 0 && end > start, 'bundled exit module found');
  let exits = 0, suspends = 0;
  const context = { nrdp: { device: { capability: { hasSuspend: false } } }, nrdjs: { suspend: { requestSuspend() { suspends++; } } } };
  const module = vm.runInNewContext('({' + code.slice(start, end + 1) + '})', context).KF44;
  const exports = {};
  module({}, exports, id => id === 'TqRt' ? { default: x => x } : { default: () => { exits++; } });
  assert.equal(exports.default(), false);
  assert.equal(exits, 1);
  assert.equal(suspends, 0);
});

test('exit waits for asynchronous media cleanup', () => {
  const result = runHost('nrdp.exit();', `
    const Module = require('node:module'), original = Module._load;
    Module._load = function(id, parent, main) {
      const value = original.call(this, id, parent, main);
      if (id !== './media' || !parent.filename.endsWith('/host.js')) return value;
      return ctx => {
        const media = value(ctx), close = media.closeAll;
        media.closeAll = async () => { await close(); await new Promise(r => setTimeout(r, 100)); console.log('media cleanup completed'); };
        return media;
      };
    };
  `);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /media cleanup completed/);
});
