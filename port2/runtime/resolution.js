'use strict';

// The NRDJS player creates this manifest for the streamer at open and when
// adding another viewable. Preserve track indices used by the rest of NRDJS.
const ANCHOR = '_makePlayerManifest:function(e){var t={movieId:e.movieId,duration:e.duration,locations:e.locations,servers:e.servers,video_tracks:e.video_tracks,audio_tracks:e.audio_tracks};';

const SOURCE_ANCHOR = 'eM(c,d),Array.isArray(c.video_tracks)';

function patchPlayer(code) {
  const start = code.indexOf(ANCHOR);
  if (start < 0 || code.indexOf(ANCHOR, start + ANCHOR.length) >= 0) {
    throw new Error('Resolution limit unavailable: unsupported Netflix player version');
  }
  const source = code.indexOf(SOURCE_ANCHOR);
  if (source < 0 || code.indexOf(SOURCE_ANCHOR, source + SOURCE_ANCHOR.length) >= 0) {
    throw new Error('Resolution limit unavailable: unsupported Netflix manifest processor');
  }
  code = code.replace(SOURCE_ANCHOR, 'eM(c,d),globalThis.__limitVideoSource(c),Array.isArray(c.video_tracks)');
  return code.replace(ANCHOR, ANCHOR + 'globalThis.__limitVideoResolution(t);');
}

function limitManifest(manifest, height = 720) {
  if (height !== 480 && height !== 720) throw new Error('Unsupported playback resolution limit');
  const width = height === 480 ? 854 : 1280;
  const label = height + 'p limit';
  if (!Array.isArray(manifest.video_tracks) || !manifest.video_tracks.length) {
    throw new Error(label + ': manifest has no video tracks');
  }
  const tracks = manifest.video_tracks.map(track => {
    if (!track || !Array.isArray(track.streams)) throw new Error(label + ': video track has no stream list');
    const streams = track.streams.filter(stream => {
      const w = Number(stream && (stream.res_w ?? stream.resW));
      const h = Number(stream && (stream.res_h ?? stream.resH));
      return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= width && h <= height;
    });
    if (!streams.length) throw new Error(label + ': a video track has no stream at or below ' + width + 'x' + height);
    return { ...track, streams };
  });
  manifest.video_tracks = tracks;
  return manifest;
}

// The manifest response processor already normalizes this object in place.
// Keep track objects shared by video_tracks/tracks and their indexes intact so
// JSASE, license selection and streamSelected all see the same stream list.
function limitSource(manifest, height = 720) {
  if (!Array.isArray(manifest.video_tracks) || !manifest.video_tracks.length) return manifest;
  if (Array.isArray(manifest.tracks) && manifest.video_tracks.some(track => !manifest.tracks.includes(track))) {
    throw new Error('Resolution limit unavailable: detached video track indexes');
  }
  const filtered = limitManifest({ ...manifest }, height);
  manifest.video_tracks.forEach((track, i) => { track.streams = filtered.video_tracks[i].streams; });
  return manifest;
}

module.exports = { patchPlayer, limitManifest, limitSource };
