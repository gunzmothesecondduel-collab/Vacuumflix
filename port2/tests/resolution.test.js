const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { patchPlayer, limitManifest, limitSource } = require('../runtime/resolution');

const ext = path.join(__dirname, '../../tvui/apps/gibbontvui/20261016_37301/release/ext');
const bundles = fs.readdirSync(ext).filter(f => f.includes('nrdjs.min.js'));
function player(bundle, enabled, height = 720) {
  let code = fs.readFileSync(path.join(ext, bundle), 'utf8');
  if (enabled) code = patchPlayer(code);
  const start = code.indexOf('_makePlayerManifest:function(e)');
  const end = code.indexOf(',_verifyVideoTracks:function', start);
  assert(start >= 0 && end > start, 'find real player manifest builder');
  return vm.runInNewContext('({' + code.slice(start, end) + '})', { __limitVideoResolution: manifest => limitManifest(manifest, height) });
}
function fixture() {
  return { movieId: 1, duration: 100, locations: [], servers: [], audio_tracks: [{ streams: [{ id: 'audio' }] }],
    video_tracks: [
      { track_id: 'main', maxHeight: 1080, drmHeader: { bytes: 'drm' }, streams: [
        { id:'sd', res_w:640, res_h:480 }, { id:'hd', res_w:1280, res_h:720 },
        { id:'wide', res_w:1280, res_h:536 }, { id:'fullhd', res_w:1920, res_h:1080 },
        { id:'overwidth', res_w:1920, res_h:720 }, { id:'unknown', res_h:720 },
      ] },
      { track_id: 'alternate', streams: [{ id:'camel', resW:1280, resH:720 }, { id:'1080', resW:1920, resH:1080 }] }
    ] };
}

test('bundled player keeps its original streams unless the option is enabled', () => {
  assert(bundles.length > 0);
  for (const bundle of bundles) {
    const original = fixture();
    const result = player(bundle, false)._makePlayerManifest(original);
    assert.equal(result.video_tracks[0].streams.length, 6);
    assert.equal(result.video_tracks[1].streams.length, 2);
  }
});

test('patched player caps each track and leaves audio, DRM and original manifest intact', () => {
  for (const bundle of bundles) {
    const original = fixture(), snapshot = JSON.stringify(original);
    const result = player(bundle, true)._makePlayerManifest(original);
    assert.deepEqual(Array.from(result.video_tracks[0].streams, s => s.id), ['sd', 'hd', 'wide']);
    assert.deepEqual(Array.from(result.video_tracks[1].streams, s => s.id), ['camel']);
    assert.deepEqual(result.video_tracks.map(t => t.track_id), ['main', 'alternate']);
    assert.deepEqual(result.video_tracks[0].drmHeader, original.video_tracks[0].drmHeader);
    assert.equal(result.audio_tracks[0].streams[0].id, 'audio');
    assert.equal(JSON.stringify(original), snapshot);
  }
});

test('fails clearly if no stream has known dimensions within the limit', () => {
  const m = fixture(); m.video_tracks[0].streams = [{ res_h:720 }, { res_w:1920, res_h:1080 }];
  assert.throws(() => player(bundles[0], true)._makePlayerManifest(m), /no stream at or below/);
});

test('fails closed if the player hook is absent or ambiguous', () => {
  const code = fs.readFileSync(path.join(ext, bundles[0]), 'utf8');
  assert.throws(() => patchPlayer('new player version'), /unsupported Netflix player version/);
  assert.throws(() => patchPlayer(code + code), /unsupported Netflix player version/);
});

test('player profile remapping still works after the cap and leaves the source unchanged', () => {
  for (const bundle of bundles) {
    const original = fixture();
    original.video_tracks[0].spoofedProfile = 'mapped-track';
    original.video_tracks[0].streams[0].spoofedContentProfile = 'mapped-stream';
    const result = player(bundle, true)._makePlayerManifest(original);
    assert.equal(result.video_tracks[0].profile, 'mapped-track');
    assert.equal(result.video_tracks[0].streams[0].content_profile, 'mapped-stream');
    assert.equal(original.video_tracks[0].profile, undefined);
    assert.equal(original.video_tracks[0].streams[0].content_profile, undefined);
  }
});

test('480p cap filters each track on the bundled players without changing source or DRM', () => {
  for (const bundle of bundles) {
    const original = fixture();
    original.video_tracks[0].streams.push({ id: 'wide-sd', res_w: 854, res_h: 480 }, { id: 'too-wide', res_w: 960, res_h: 400 });
    original.video_tracks[1].streams.push({ id: 'camel-sd', resW: 720, resH: 480 });
    const snapshot = JSON.stringify(original);
    const result = player(bundle, true, 480)._makePlayerManifest(original);
    assert.deepEqual(Array.from(result.video_tracks[0].streams, s => s.id), ['sd', 'wide-sd']);
    assert.deepEqual(Array.from(result.video_tracks[1].streams, s => s.id), ['camel-sd']);
    assert.deepEqual(result.video_tracks[0].drmHeader, original.video_tracks[0].drmHeader);
    assert.equal(JSON.stringify(original), snapshot);
  }
});

test('480p cap rejects HD-only tracks without modifying the manifest', () => {
  const original = fixture(), snapshot = JSON.stringify(original);
  assert.throws(() => limitManifest(original, 480), /480p limit:.*854x480/);
  assert.equal(JSON.stringify(original), snapshot);
  assert.throws(() => limitManifest(original, 360), /Unsupported playback resolution limit/);
});

function normalize(bundle, manifest, height, enabled = true) {
  let code = fs.readFileSync(path.join(ext, bundle), 'utf8');
  if (enabled) code = patchPlayer(code);
  const start = code.indexOf('eM(c,d),');
  const end = code.indexOf(',F.A.isAtLeast4_2', start);
  assert(start >= 0 && end > start);
  const context = { c: manifest, d: {},
    eM(c) { if (c.videoTracks) { c.video_tracks = c.videoTracks; delete c.videoTracks; } },
    __limitVideoSource: c => limitSource(c, height),
    eE: { error() { throw new Error('missing normalized tracks'); } },
  };
  vm.runInNewContext(code.slice(start, end), context);
  return manifest;
}

test('JSASE response processing caps streams before constructing shared track indexes', () => {
  for (const bundle of bundles) for (const height of [480, 720]) {
    const m = fixture();
    m.video_tracks[1].streams.push({ id: 'sd2', res_w: 640, res_h: 480 });
    const video = m.video_tracks, audio = m.audio_tracks, drm = video[0].drmHeader;
    // Exercise the v3 alias arriving before normalization.
    m.videoTracks = video; delete m.video_tracks;
    normalize(bundle, m, height);
    assert.equal(m.video_tracks, video);
    assert.equal(m.audio_tracks, audio);
    assert.equal(m.tracks[0], video[0]);
    assert.equal(m.tracks[1], video[1]);
    assert.equal(m.tracks[2], audio[0]);
    assert.equal(video[0].drmHeader, drm);
    for (const track of video) for (const stream of track.streams) {
      assert((stream.res_h ?? stream.resH) <= height);
      assert((stream.res_w ?? stream.resW) <= (height === 480 ? 854 : 1280));
    }
    const uncapped = normalize(bundle, fixture(), height, false);
    assert(uncapped.tracks[0].streams.some(s => s.res_h === 1080));
  }
});

test('JSASE cap rejects HD-only responses atomically and permits audio-only responses', () => {
  const m = fixture(), snapshot = JSON.stringify(m);
  assert.throws(() => limitSource(m, 480), /no stream at or below/);
  assert.equal(JSON.stringify(m), snapshot);
  const audio = { audio_tracks: [{ streams: [] }] };
  assert.equal(limitSource(audio, 480), audio);
  for (const bundle of bundles) {
    const code = fs.readFileSync(path.join(ext, bundle), 'utf8');
    assert.throws(() => patchPlayer(code.replace('eM(c,d),Array.isArray(c.video_tracks)', 'newResponseProcessor()')), /unsupported Netflix manifest processor/);
  }
});

test('pre-existing shared indexes retain capped lists; detached indexes fail closed', () => {
  const m = fixture(); m.tracks = m.video_tracks.concat(m.audio_tracks);
  const tracks = m.tracks;
  limitSource(m, 720);
  assert.equal(m.tracks, tracks);
  assert(!m.tracks[0].streams.some(s => s.res_h === 1080));
  const detached = fixture(); detached.tracks = JSON.parse(JSON.stringify(detached.video_tracks));
  const snapshot = JSON.stringify(detached);
  assert.throws(() => limitSource(detached, 720), /detached video track indexes/);
  assert.equal(JSON.stringify(detached), snapshot);
});
