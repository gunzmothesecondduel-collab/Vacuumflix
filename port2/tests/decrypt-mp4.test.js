const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const cp = require('node:child_process');
const { DecryptMp4 } = require('../runtime/decrypt-mp4');
const bridge = require('../runtime/cdmbridge');
function fixture() {
  const r = cp.spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=16x16:r=24', '-frames:v', '8', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']);
  assert.equal(r.status, 0, String(r.stderr)); return r.stdout;
}
async function convert(input, chunkSize = input.length, options) {
  const chunks = [], data = [];
  for (let i = 0; i < input.length; i += chunkSize) chunks.push(input.subarray(i, i + chunkSize));
  await pipeline(Readable.from(chunks), new DecryptMp4(options), new Writable({ write(b, _, cb) { data.push(b); cb(); } }));
  return Buffer.concat(data);
}
test('clear fragmented MP4 stays byte-identical, including split box headers', async () => {
  const clear = fixture();
  for (const n of [1, 7, 1024, clear.length]) assert.deepEqual(await convert(clear, n), clear);
});
test('decrypts compressed fragments before completion and never decodes or re-encodes video', async t => {
  const clear = fixture(), encrypted = Buffer.from(clear);
  encrypted.write('encv', encrypted.indexOf('avc1'));
  const original = bridge.call, calls = []; let noKey = true;
  t.after(() => { bridge.call = original; });
  bridge.call = async (op, args) => {
    calls.push(op);
    if (op === bridge.OP.DROP_TRACK) return { status: 0, rets: [] };
    if (op === bridge.OP.SET_INIT) {
      assert.equal(args[2], 'decrypt-only'); const init = Buffer.from(args[1]); init.write('avc1', init.indexOf('encv'));
      return { status: 0, rets: [init, Buffer.alloc(16), Buffer.alloc(0), Buffer.from('decrypt-only')] };
    }
    assert.equal(op, bridge.OP.DECRYPT);
    if (noKey) { noKey = false; return { status: 1, rets: [Buffer.from('Decrypt status 2; no CDM key statuses reported')] }; }
    const start = Number(args[2]); assert.deepEqual(args[1], clear.subarray(start, start + args[1].length));
    return { status: 0, rets: [args[1]] }; // CDM mocked: this fixture has clear compressed samples.
  };
  assert.deepEqual(await convert(encrypted, 13), clear);
  assert(calls.includes(bridge.OP.DROP_TRACK)); assert(!calls.includes(bridge.OP.VDEC_SEG));
});
test('reports missing key diagnostics when the license wait expires', async t => {
  const encrypted = fixture(); encrypted.write('encv', encrypted.indexOf('avc1'));
  const original = bridge.call; t.after(() => { bridge.call = original; });
  bridge.call = async (op, args) => {
    if (op === bridge.OP.DROP_TRACK) return { status: 0, rets: [] };
    if (op === bridge.OP.SET_INIT) return { status: 0, rets: [args[1], Buffer.alloc(16), Buffer.alloc(0), Buffer.from('decrypt-only')] };
    return { status: 1, rets: [Buffer.from('Decrypt status 2; fragment offset 100, sample 1/1; no reported key matches this sample')] };
  };
  await assert.rejects(convert(encrypted, encrypted.length, { keyWaitMs: 0 }), /fragment offset 100, sample 1\/1; no reported key matches/);
});
test('refuses unsupported host, failed decryption and changed byte offsets', async t => {
  const encrypted = fixture(); encrypted.write('encv', encrypted.indexOf('avc1'));
  const original = bridge.call; t.after(() => { bridge.call = original; });
  for (const mode of ['old-host', 'decrypt-failure', 'length-change']) {
    bridge.call = async (op, args) => {
      if (op === bridge.OP.DROP_TRACK) return { status: 0, rets: [] };
      if (op === bridge.OP.SET_INIT) return { status: 0, rets: [args[1], Buffer.alloc(16), Buffer.alloc(0), Buffer.from(mode === 'old-host' ? '' : 'decrypt-only')] };
      return mode === 'decrypt-failure' ? { status: 1, rets: [Buffer.from('Decrypt status 4')] } : { status: 0, rets: [Buffer.alloc(0)] };
    };
    await assert.rejects(convert(encrypted), mode === 'old-host' ? /updated CDM/ : mode === 'decrypt-failure' ? /decryption failed/ : /byte offsets/);
  }
});
test('rejects truncated and oversized MP4 boxes', async () => {
  await assert.rejects(convert(fixture().subarray(0, 100)), /Incomplete/);
  const box = Buffer.alloc(8); box.writeUInt32BE(70 * 1024 * 1024); box.write('mdat', 4);
  await assert.rejects(convert(box), /box size/);
});
