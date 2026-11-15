'use strict';

// FFmpeg progress timestamps are relative to asetpts=PTS-STARTPTS. PulseAudio
// queues 100ms of output; estimate the audible session position behind writes.
class AudioClock {
  constructor(now = Date.now) { this.now = now; this.reset(); }
  reset() { this.source = null; this.sample = null; this.pending = ''; }
  start(source, sessionStart) {
    this.reset(); this.source = source; this.startPts = sessionStart;
  }
  update(source, chunk) {
    if (source !== this.source) return;
    this.pending += String(chunk);
    const lines = this.pending.split('\n'); this.pending = lines.pop().slice(-4096);
    for (const line of lines) {
      const match = /^out_time_us=(\d+)\r?$/.exec(line);
      if (!match || !Number.isFinite(this.startPts)) continue;
      const elapsed = Number(match[1]) / 1e6;
      if (!Number.isFinite(elapsed) || (this.sample && elapsed < this.sample.elapsed)) continue;
      this.sample = { elapsed, at: this.now() };
    }
  }
  position() {
    if (!this.sample) return null;
    // Interpolate between 100ms progress reports, but stop advancing if the
    // writer stalls rather than letting video run ahead through an underrun.
    const delta = Math.max(0, Math.min(0.1, (this.now() - this.sample.at) / 1000));
    return this.startPts + Math.max(0, this.sample.elapsed - 0.1 + delta);
  }
}
module.exports = { AudioClock };
