const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { patchPlayer, limitManifest } = require('../runtime/resolution');

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
