const assert = require('node:assert/strict');
const cp = require('child_process'), fs = require('fs');

if (process.argv[2] !== 'worker') {
  const { test } = require('node:test');
  for (const mode of ['clear', 'widevine', 'rgba', 'retry', 'retry-partial', 'required-fail', 'required-unavailable', 'gpu-success', 'init-switch', 'init-only-eos', 'disk-cache', 'disk-widevine', 'disk-gpu', 'audio-sync', 'audio-sync-no-video', 'decrypt-retry', 'decrypt-fail']) {
    test('video pipeline: ' + mode, () => {
      const result = cp.spawnSync(process.execPath, [__filename, 'worker', mode], { encoding: 'utf8', timeout: 12000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      if (mode === 'required-fail') { assert.match(result.stderr, /synthetic VA-API failure/); assert.match(result.stderr, /without software fallback/); }
      if ((mode === 'gpu-success' || mode === 'disk-gpu')) assert.match(result.stdout, /FFmpeg VA-API produced video frames/);
    });
  }
} else {
  (async () => {
    const mode = process.argv[3], count = 8, w = 16, h = 16, frameSize = w * h * 3 / 2;
    process.env.VACUUMFLIX_HWACCEL = 'off';
    if (mode === 'rgba') process.env.VACUUMFLIX_GPU_VIDEO = '0';
    const encoded = cp.spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=16x16:r=24',
      '-frames:v', String(count), '-c:v', 'libx264', '-bf', '0', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1']);
    assert.equal(encoded.status, 0, String(encoded.stderr));
    const mp4 = encoded.stdout;
    let boundary = 0;
    while (mp4.toString('ascii', boundary + 4, boundary + 8) !== 'moof') boundary += mp4.readUInt32BE(boundary);
    const init = Buffer.from(mp4.subarray(0, boundary)), frag = mp4.subarray(boundary);
    let attempts = 0;
    let decoderSpawns = 0; const events = [];
    let videoOutput = false, audioStarted = false, audioStartedEarly = false;
    if (mode.startsWith('audio-sync')) {
      const spawn = cp.spawn;
      cp.spawn = (bin, args, opts) => {
        if (bin !== 'ffmpeg') return spawn(bin, args, opts);
        if (args.includes('pulse')) {
          audioStartedEarly = !videoOutput;
          audioStarted = true;
          return spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"], opts);
        }
        const videoScript = mode === 'audio-sync-no-video'
          ? "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"
          : `process.stdin.resume(); setTimeout(() => process.stdout.write(Buffer.alloc(${frameSize * count})), 700); process.stdin.on('end', () => setTimeout(() => process.exit(0), 1000))`;
        const video = spawn(process.execPath, ['-e', videoScript], opts);
        video.stdout.on('data', () => { videoOutput = true; });
        return video;
      };
    }
    if (mode.startsWith('init-')) {
      const spawn = cp.spawn; cp.spawn = (...args) => { decoderSpawns++; return spawn(...args); };
    }
    if (mode.startsWith('retry') || mode.startsWith('required') || (mode === 'gpu-success' || mode === 'disk-gpu')) {
      const gpu = require('../runtime/gpu');
      gpu.videoAcceleration = () => ({ required: mode.startsWith('required'), enabled: mode !== 'required-unavailable', env: process.env, input: ['-threads', '1', '-hwaccel', 'vaapi'] });
      const spawn = cp.spawn;
      cp.spawn = (bin, args, opts) => {
        if (args.includes('-hwaccel')) {
          attempts++;
          if ((mode === 'gpu-success' || mode === 'disk-gpu')) {
            assert(args.indexOf('-hwaccel') < args.indexOf('-i'));
            assert(args.includes('-threads'));
            const cpuArgs = [...args]; cpuArgs.splice(cpuArgs.indexOf('-threads'), 4); // synthetic hardware options
            const vf = cpuArgs.indexOf('-vf'); cpuArgs[vf+1] = cpuArgs[vf+1].replace('hwdownload,format=nv12,', '');
            return spawn(bin, cpuArgs, opts); // no real GPU in CI: exercise successful output handling
          }
          // Reproduce both initialization failure and failure after one frame.
          return spawn(process.execPath, ['-e', mode === 'retry-partial' ? `process.stdout.write(Buffer.alloc(${frameSize})); process.exitCode=1` : "console.error('synthetic VA-API failure'); process.exit(1)"], opts);
        }
        assert(!mode.startsWith('required'), 'required mode must never spawn a software decoder');
        return spawn(bin, args, opts);
      };
    }
    if (mode === 'widevine' || mode === 'disk-widevine' || mode.startsWith('decrypt-')) {
      init.write('encv', init.indexOf('avc1'));
      const bridge = require('../runtime/cdmbridge');
      const plane = Buffer.concat([Buffer.alloc(w*h,81), Buffer.alloc(w*h/4,90), Buffer.alloc(w*h/4,240)]);
      bridge.call = async (op, args) => {
        if (mode.startsWith('decrypt-')) {
          if (op === bridge.OP.SET_INIT) { const clear = Buffer.from(init); clear.write('avc1', clear.indexOf('encv')); return { status: 0, rets: [clear, Buffer.alloc(16), Buffer.alloc(0)] }; }
          assert.equal(op, bridge.OP.DECRYPT);
          assert.equal(args[2], '0', 'streaming must select per-description encryption metadata');
          attempts++;
          if (mode === 'decrypt-fail' || attempts === 1) return { status: 1, rets: [Buffer.from(mode === 'decrypt-fail' ? 'Decrypt status 4' : 'Decrypt status 2')] };
          return { status: 0, rets: [args[1]] };
        }
        if (mode === 'disk-widevine') {
          if (op === bridge.OP.DROP_TRACK) return { status: 0, rets: [] };
          if (op === bridge.OP.SET_INIT) {
            assert.equal(args[2], 'decrypt-only');
            const clear = Buffer.from(init); clear.write('avc1', clear.indexOf('encv'));
            return { status: 0, rets: [clear, Buffer.alloc(16), Buffer.alloc(0), Buffer.from('decrypt-only')] };
          }
          assert.equal(op, bridge.OP.DECRYPT, 'disk playback must not ask Widevine to decode frames');
          return { status: 0, rets: [args[1]] };
        }
        if (op === bridge.OP.SET_INIT) return { status: 0, rets: [init, Buffer.alloc(16), Buffer.from('16x16')] };
        assert.equal(op, bridge.OP.VDEC_SEG);
        const header = Buffer.alloc(8); header.writeUInt32BE(w); header.writeUInt32BE(h,4);
        return { status: 0, rets: [Buffer.concat(Array.from({ length: count }, () => Buffer.concat([header, plane]))), Buffer.from('8,8')] };
      };
    }
    let cacheDirectory, server, finishDownload, downloads = 0;
    if (mode.startsWith('disk-')) {
      process.env.VACUUMFLIX_DISK_CACHE = '1';
      cacheDirectory = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'vacuumflix-pipeline-'));
      process.env.VACUUMFLIX_CACHE_DIR = cacheDirectory;
      const payload = Buffer.concat([init, frag]);
      server = require('http').createServer((req, res) => {
        downloads++;
        if (req.headers.range) { assert.equal(req.headers.range, 'bytes=0-' + (boundary - 1)); res.writeHead(206); res.end(payload.subarray(0, boundary)); return; }
        res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, boundary));
        finishDownload = () => res.end(payload.subarray(boundary));
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
    }
    const media = require('../runtime/media')({ mlog() {}, mono: Date.now, logProxy(_, obj) { obj.emit = (event, data) => { events.push(event); if (mode.startsWith('disk-') && event === 'onchunkcomplete') { if (data.requestId === 1) assert.deepEqual(Buffer.from(data.data), init); else assert.equal(data.data, undefined); } }; obj.addListener = () => {}; return obj; } });
    const player = await new Promise(resolve => media.factory.createPlayer(process.pid, r => resolve(r.player)));
    const sid = media.base.createMediaSource(null, player.path).sourceid;
    const bid = media.base.createSourceBuffers(sid, [1]).bufferids[0];
    if (mode.startsWith('audio-sync')) {
      const audio = media.base.createSourceBuffers(sid, [0]).bufferids[0];
      media.base.attachDataToSourceBuffer(init, sid, audio);
      media.base.attachDataToSourceBuffer(frag, sid, audio);
      media.base.endOfStream(audio);
    }
    if (mode.startsWith('disk-')) {
      const url = 'http://127.0.0.1:' + server.address().port + '/protected.mp4';
      media.base.createRequest(1, 1, url, 0, boundary - 1, 0);
      media.base.createRequest(2, 1, url, boundary, -1, 1);
      media.base.attachRequestToSourceBuffer(1, bid, 0, sid);
      media.base.attachRequestToSourceBuffer(2, bid, 0, sid);
      media.base.endOfStream(bid);
    } else media.base.attachDataToSourceBuffer(init, sid, bid);
    if (!mode.startsWith('init-') && !mode.startsWith('disk-')) { media.base.attachDataToSourceBuffer(frag, sid, bid); media.base.endOfStream(bid); }
    player.open({ videoAttributes: { frameRateValue: 24 } }); player.play();
    const file = '/dev/shm/gibbon_video_' + process.pid + '.rgba';
    try {
      const start = Date.now(); let frame;
      if (mode.startsWith('disk-')) {
        while (!finishDownload) await new Promise(r => setTimeout(r, 10));
        await new Promise(r => setTimeout(r, 50));
        assert.equal(events.filter(e => e === 'oncomplete').length, 1, 'only the license bootstrap header completes before decryption');
        assert(!fs.existsSync(file), 'no video presented before caching completes');
        finishDownload();
      }
      if (mode.startsWith('init-')) {
        await new Promise(r => setTimeout(r, 100));
        assert.equal(decoderSpawns, 0, 'initialization alone must not launch a decoder');
        if (mode === 'init-only-eos') {
          media.base.endOfStream(bid); player.__feed();
          await new Promise(r => setTimeout(r, 50));
          assert.equal(decoderSpawns, 0); assert(events.includes('endofstream')); return;
        }
        const nextInit = Buffer.from(init); nextInit.writeUInt32BE(init.readUInt32BE(12) + 1, 12);
        media.base.attachDataToSourceBuffer(nextInit, sid, bid);
        media.base.attachDataToSourceBuffer(frag, sid, bid); media.base.endOfStream(bid); player.__feed();
      }
      if (mode.startsWith('required')) {
        while (player.state !== player.STOPPED && Date.now() - start < 5000) await new Promise(r => setTimeout(r, 20));
        assert.equal(player.state, player.STOPPED); assert.equal(attempts, mode === 'required-fail' ? 1 : 0);
        assert(!fs.existsSync(file)); return;
      }
      if (mode === 'decrypt-fail') {
        while (!events.includes('error') && Date.now() - start < 5000) await new Promise(r => setTimeout(r, 20));
        assert(events.includes('error'), 'DRM failure must reach the UI');
        assert.equal(player.state, player.STOPPED);
        assert(!fs.existsSync(file), 'failed decryption must never produce a displayed frame');
        assert.equal(attempts, 1, 'permanent failures are not retried'); return;
      }
      if (mode === 'audio-sync-no-video') {
        while (!audioStarted && Date.now() - start < 5000) await new Promise(r => setTimeout(r, 20));
        assert(audioStarted, 'audio can start once an empty video stream has ended');
        assert(!videoOutput); return;
      }
      while (Date.now() - start < 7000) {
        try { frame = fs.readFileSync(file); if (frame.readUInt32LE(8) === count) break; } catch {}
        await new Promise(r => setTimeout(r, 20));
      }
      assert(frame, 'a frame was presented'); assert.equal(frame.readUInt32LE(8), count, 'all frames presented once');
      if (mode === 'audio-sync') { assert(audioStarted, 'audio eventually starts'); assert(!audioStartedEarly, 'audio must wait for the first decoded video frame'); }
      assert.equal(frame.readUInt32LE(0), mode === 'rgba' ? w : (0x80000000 + w));
      assert.equal(frame.length, 12 + (mode === 'rgba' ? w*h*4 : frameSize));
      if (mode === 'widevine' || mode === 'disk-widevine') assert.equal(frame[12], 81, 'Widevine planar pixels pass through unchanged');
      if (mode.startsWith('retry')) assert.equal(attempts, 1);
      if (mode === 'decrypt-retry') assert.equal(attempts, 2, 'missing keys are retried before decoding');
      if (mode === 'init-switch') assert.equal(decoderSpawns, 1);
      if (mode.startsWith('disk-')) {
        assert.equal(downloads, 2, 'one bootstrap header request and one full-file download');
        assert.equal(events.filter(e => e === 'oncomplete').length, 2);
        assert.equal(media.base._requests.get(2).body, undefined, 'cached ranges do not stay in heap');
        assert.equal(fs.readdirSync(cacheDirectory).filter(f => f.endsWith('.mp4')).length, 1);
      }
      console.log(mode + ' passed');
    } finally {
      media.closeAll();
      if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(cacheDirectory, { recursive: true, force: true }); }
      for (const suffix of ['', '.last', '.tmp']) { try { fs.unlinkSync(file + suffix); } catch {} }
    }
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
