'use strict';
const { Transform } = require('node:stream');
const bridge = require('./cdmbridge');
let serial = 0;
const MAX_FRAGMENT = 64 * 1024 * 1024;

// Same-size substitutions preserve the player's original MP4 byte ranges and sidx.
class DecryptMp4 extends Transform {
  constructor({ keyWaitMs = 30000 } = {}) {
    super(); this.track = 'cache-' + process.pid + '-' + (++serial);
    this.keyWaitMs = keyWaitMs;
    this.parts = []; this.collected = 0; this.needed = 8; this.boxSize = 0; this.header = []; this.fragment = null;
    this.offset = 0; this.initialized = false; this.encrypted = false;
  }
  async box(box, type, offset) {
    if (!this.initialized) {
      this.header.push(box);
      if (this.header.reduce((n, b) => n + b.length, 0) > MAX_FRAGMENT) throw new Error('MP4 initialization header is too large');
      if (type !== 'moov') return;
      let init = Buffer.concat(this.header); this.header = [];
      this.encrypted = init.indexOf('encv') > 0 || init.indexOf('enca') > 0;
      if (this.encrypted) {
        const result = await bridge.call(bridge.OP.SET_INIT, [this.track, init, 'decrypt-only']);
        if (result.status !== 0 || String(result.rets[3]) !== 'decrypt-only') throw new Error('Cache requires the updated CDM host with decrypt-only support');
        if (result.rets[0].length !== init.length) throw new Error('CDM changed MP4 header byte offsets');
        init = result.rets[0];
      }
      this.initialized = true; this.push(init); return;
    }
    if (type === 'moof') {
      if (this.fragment) throw new Error('MP4 fragment has no media data');
      this.fragment = [box]; this.fragmentOffset = offset; return;
    }
    if (this.fragment) {
      this.fragment.push(box);
      const size = this.fragment.reduce((n, b) => n + b.length, 0);
      if (size > MAX_FRAGMENT) throw new Error('MP4 fragment exceeds 64 MiB');
      if (type !== 'mdat') return;
      let fragment = Buffer.concat(this.fragment); this.fragment = null;
      if (this.encrypted) {
        let result;
        // A header request can finish before its license response arrives.
        const deadline = Date.now() + this.keyWaitMs;
        do {
          if (this.destroyed) throw new Error('MP4 preparation cancelled');
          result = await bridge.call(bridge.OP.DECRYPT, [this.track, fragment, String(this.fragmentOffset)]);
          if (result.status === 0 || !/^Decrypt status 2(?:;|$)/.test(String(result.rets[0])) || Date.now() >= deadline) break;
          await new Promise(r => setTimeout(r, 100));
        } while (true);
        if (result.status !== 0) throw new Error('Widevine cache decryption failed: ' + String(result.rets[0] || result.status));
        if (result.rets[0].length !== fragment.length) throw new Error('CDM changed MP4 fragment byte offsets');
        fragment = result.rets[0];
      }
      this.push(fragment); return;
    }
    if (type === 'mdat' && this.encrypted) throw new Error('Cache requires fragmented MP4');
    this.push(box);
  }
  _transform(chunk, _, done) {
    (async () => {
      let offset = 0;
      while (offset < chunk.length) {
        const n = Math.min(this.needed - this.collected, chunk.length - offset);
        this.parts.push(chunk.subarray(offset, offset + n)); this.collected += n; offset += n;
        if (this.collected < this.needed) continue;
        if (!this.boxSize) {
          const header = Buffer.concat(this.parts);
          let size = header.readUInt32BE(0), headerSize = 8;
          if (size === 1) {
            if (this.collected < 16) { this.needed = 16; continue; }
            size = Number(header.readBigUInt64BE(8)); headerSize = 16;
          }
          if (!Number.isSafeInteger(size) || size < headerSize || size > MAX_FRAGMENT) throw new Error('Unsupported MP4 box size');
          this.boxSize = size; this.needed = size;
          if (this.collected < size) continue;
        }
        const box = Buffer.concat(this.parts, this.boxSize), type = box.toString('ascii', 4, 8);
        const start = this.offset; this.offset += this.boxSize;
        this.parts = []; this.collected = 0; this.needed = 8; this.boxSize = 0;
        if (this.destroyed) throw new Error('MP4 preparation cancelled');
        await this.box(box, type, start);
      }
    })().then(() => done(), done);
  }
  _destroy(error, done) {
    if (this.encrypted) bridge.call(bridge.OP.DROP_TRACK, [this.track]).catch(() => {});
    done(error);
  }
  _flush(done) {
    done(this.collected || this.fragment || !this.initialized ? new Error('Incomplete fragmented MP4') : null);
  }
}
module.exports = { DecryptMp4 };
