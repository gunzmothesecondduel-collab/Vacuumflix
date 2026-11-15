'use strict';

// These startup modes defer DRM acquisition until after playback starts. Full
// file preparation needs the license before any protected sample is read.
const HOOKS = [
  'e.checkFastplay=function(t,i,r){',
  'e.checkMcClearen=function(e,t,i,r){',
];

function patchPlayer(code) {
  for (const hook of HOOKS) {
    const start = code.indexOf(hook);
    if (start < 0 || code.indexOf(hook, start + hook.length) >= 0) {
      throw new Error('Disk cache cannot configure license startup: unsupported Netflix player version');
    }
    code = code.slice(0, start) + hook + 'return!1;' + code.slice(start + hook.length);
  }
  return code;
}

module.exports = { patchPlayer };
