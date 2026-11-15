<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:072ae5131ca233cb62eafcaa46b924070839d4f5992fb2a3bc8f16ff8d152a92 -->

<!-- coderabbit-ai-generated-section:v1:0fd9f8760939fdda5702921eceabc4a17969305349445e5823c02af9f883248d -->

# Vacuumflix
- Netflix with its original TV/console interface, made for **SteamOS** and **Bazzite**
- Runs on any Linux desktop and works with a game controller
- Uses **Widevine L3** and plays back at up to **1080p**, depending on your network
- Early version, may contain bugs. Feedback is welcome!

## Start

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/01d5e50c-dbda-460b-9ea3-1b9eb8c9be63" />

## Profile

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/d7b29c24-6df5-4e20-8773-f934e622f968" />

## Home

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/799ebd09-cc6e-432a-9759-3804e7352f15" />

## Player

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/1361ced6-efc0-41e9-bf30-a5ff547d3b10" />

## Installation

Download the Flatpak or the .tar.gz file from the [releases page](https://github.com/Ciphay/Vacuumflix/releases/tag/V1.0) and install it:

```sh
flatpak install --user Netflix.flatpak
flatpak run io.vacuumflix.Vacuumflix
```

This is the recommended way, especially on **SteamOS** and **Bazzite**, whose root file systems are read-only.

Or build it yourself:

```sh
git clone https://github.com/Ciphay/Vacuumflix.git
cd Vacuumflix
./build.sh            # builds the Flatpak and installs it
flatpak run io.vacuumflix.Vacuumflix
./build.sh package    # optional: standalone folder + single executable in dist/
```

Building needs `git`, `gcc`, `g++`, `pkg-config`, SDL2 and OpenGL ES development files, `node`, `ffmpeg`, `curl`, `xz`, `python3` with Pillow, the Noto fonts, and `flatpak` with the 25.08 runtimes:

```sh
flatpak install --user flathub org.freedesktop.Platform//25.08 org.freedesktop.Sdk//25.08
```

On Arch-based distros (tested on CachyOS):

```sh
sudo pacman -S git base-devel sdl2 nodejs ffmpeg curl python-pillow xz noto-fonts noto-fonts-cjk flatpak
```

Building on an immutable distro such as Bazzite has not been tested; use a `distrobox` container if you try.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:6c6f18855a3d24b07d2cc39344c22a1941accee893e450b74d066dc5c2955887 -->

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:8e998c2e318030008c42e808730d41e3e4065c343ac0ccee4bd23f19443b6a1f -->

## Limit playback resolution

Set `VACUUMFLIX_MAX_RESOLUTION=720` to select Netflix video streams up to
1280×720. Lower resolutions remain available for adaptive playback. If a video
track has no eligible stream, playback reports an error instead of selecting a
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:fd842695764c5a50a858aeb0acc9b1318a15ad2fe47ca3e5e2156fb9d17753f0 -->

higher resolution. Unset the variable to use the normal limit (up to 1080p).

For slower CPUs, `VACUUMFLIX_MAX_RESOLUTION=480` selects streams up to 854×480.
This reduces decoding work; real-time playback on a Celeron N3050 remains
unverified. Use the normal CDM decoder with disk caching off when decrypt-only
playback reports an unusable key.

<!-- /coderabbit-ai-generated:v1 -->

```sh
VACUUMFLIX_MAX_RESOLUTION=720 ./netflix
# Flatpak:
flatpak run --env=VACUUMFLIX_MAX_RESOLUTION=720 io.vacuumflix.Vacuumflix
```

This limits the downloaded video rendition; it does not resize the UI. The limit
is applied to the bundled Netflix player and depends on its manifest format.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:a61f439646e2ccce7c5b8e446f42039c282166c2b5fcf6b4617f823908c70a2e -->

## Decrypted MP4 disk buffer

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:e0ff39a48cfb9a5f4e9114ad3c0776e9a7b4918028da757e09e8d4066a7704e3 -->

Rebuild the app and restart it so the updated CDM host is used.

Set `VACUUMFLIX_DISK_CACHE=1` to download and decrypt each selected fragmented

<!-- /coderabbit-ai-generated:v1 -->
MP4 rendition completely before its media ranges reach playback. A small initial
header request is allowed through first so the player can obtain its license.
Video and audio stay compressed in separate MP4 files; there is no raw-frame
cache or re-encoding. Widevine performs decryption during preparation, and
FFmpeg decodes the cached video using the configured VA-API/software mode.

`VACUUMFLIX_DISK_CACHE=1` deliberately changes the normal protected playback
path: it writes **clear MP4 data** to a private, session-only cache. Files are
removed on normal app exit and abandoned files are removed at the next launch.
The app still needs an authenticated Netflix session and a usable Widevine
license to prepare protected content. If the CDM refuses decrypt-only access,
preparation reports an error; it does not silently use Widevine frame decoding.
Actual Netflix/CDM compatibility and CPU savings on a Celeron N3050 have not
been verified.

The combined cache limit is **10 GB (10,000,000,000 bytes)**, including audio,
video and incomplete downloads. Unused files are evicted first. If the active
renditions cannot fit, preparation fails; choose a smaller rendition such as
720p. Downloads require a server that supplies complete MP4 files with HTTP 200.
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:918c2288479f44839360068d7fb013fe1c83f79c726a9c22f8597c3777d4c5f1 -->

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:369cae500ded231a71d1df02831af69b2d514bf6bc8f457064135eadbed622cd -->

A rendition switch may require another complete download. Preparation logs appear
with `[cache]`; startup can take as long as downloading and decrypting the title.
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:a3d591e653aa7ca0f8623353245a025f88cbbf62c1f26ffc7d97297a0937cca2 -->

Disk caching disables Fastplay and McClearen, which can delay license acquisition
until playback begins. This allows the player to request a license before playback.

<!-- /coderabbit-ai-generated:v1 -->

<!-- /coderabbit-ai-generated:v1 -->
Interrupted connections and network stalls retry at most twice, restarting the
complete download and decryption. Reads paused by decryption do not count toward
the 30-second network stall timeout. Cancelling playback also cancels retries.



<!-- /coderabbit-ai-generated:v1 -->

`VACUUMFLIX_CACHE_DIR` selects the cache directory. The default is
`$XDG_CACHE_HOME/vacuumflix/decrypted-mp4`, or
`~/.cache/vacuumflix/decrypted-mp4`. Only one app instance can own a cache
directory at a time. Use a disk directory writable by the application; Flatpak
uses its own cache location by default. Leave `VACUUMFLIX_DISK_CACHE` unset for
normal playback.

```sh
VACUUMFLIX_DISK_CACHE=1 VACUUMFLIX_MAX_RESOLUTION=720 LIBVA_DRIVER_NAME=i965 ./netflix
# Flatpak:
flatpak run --env=VACUUMFLIX_DISK_CACHE=1 --env=VACUUMFLIX_MAX_RESOLUTION=720 --env=LIBVA_DRIVER_NAME=i965 io.vacuumflix.Vacuumflix
```

Development checks: `node --test port2/tests/mp4-cache.test.js port2/tests/decrypt-mp4.test.js port2/tests/media.test.js`.
Native bridge check: compile `port2/tests/cdm_cache.cpp` with
`g++ -std=c++17 -O2 -Wno-attributes -ldl -lpthread` and run the resulting binary.

## GPU acceleration

<!-- /coderabbit-ai-generated:v1 -->


<!-- /coderabbit-ai-generated:v1 -->
The UI, animations, video scaling and video colour conversion use OpenGL ES 3.
Video frames stay in planar YUV until the GPU shader draws them, reducing frame
transfer size from four bytes per pixel to approximately 1.5. The CPU still runs
application logic, image/text loading, audio and DRM.

VA-API decoding is enabled automatically for video decoded by FFmpeg. The app
tries available `/dev/dri/renderD*` devices, uses libva's selected driver, and
tries `i965` if automatic driver initialization fails. An unsupported codec or
decoder error retries the stream in software without replaying displayed frames.
Default protected Netflix playback uses Widevine's software decoder and GPU
presentation. The optional decrypted MP4 disk buffer above instead prepares
compressed clear media for FFmpeg, where VA-API decoding can be used.
Widevine L3 and the existing playback quality limits are unchanged.

### Legacy Intel (i965/libva)

Install your distribution's **i965 VA-API driver** on the build machine to include
`i965_drv_video.so` and its dependencies in the package. On Debian/Ubuntu this is
`i965-va-driver`; on Arch it is `libva-intel-driver`. An FFmpeg build with VA-API
support and an OpenGL ES 3 driver are also required. Host/runtime drivers are
searched before the bundled fallback. Flatpak already grants GPU device access;
its runtime Intel VA-API extension can also supply the driver.

Force legacy Intel for a standalone install:

```sh
LIBVA_DRIVER_NAME=i965 ./netflix
```

Or for Flatpak:

```sh
flatpak run --env=LIBVA_DRIVER_NAME=i965 io.vacuumflix.Vacuumflix
```

Options (also accepted with Flatpak's `--env=NAME=value`):

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:cbeeff17c9ab399a7bd9153187e6ee5667fd41aa3e0a944ae21e8caf91bd60a2 -->

- `VACUUMFLIX_HWACCEL=auto` (default): try VA-API, then software.
- `VACUUMFLIX_HWACCEL=vaapi`: require VA-API for FFmpeg video decoding; stop playback
  with the FFmpeg error if hardware initialization or decoding fails. This mode
  now forbids the software fallback that earlier versions allowed. It does not
  replace Widevine's own decoder. For legacy Intel, run
  `LIBVA_DRIVER_NAME=i965 VACUUMFLIX_HWACCEL=vaapi ./netflix` (or pass both variables
  with Flatpak's `--env=` option). Hardware decoding uses one decoder thread to
  limit surface demand. A successful device probe confirms initialization only;
  the app logs when FFmpeg actually produces video frames through VA-API.

<!-- /coderabbit-ai-generated:v1 -->
- `VACUUMFLIX_HWACCEL=off`: software decoding with GPU presentation.
- `VACUUMFLIX_VAAPI_DEVICE=/dev/dri/renderD128`: select a specific GPU.
- `LIBVA_DRIVER_NAME` and `LIBVA_DRIVERS_PATH`: standard libva overrides, preserved.
- `VACUUMFLIX_GPU_VIDEO=0`: use the original RGBA conversion path for diagnostics.

Startup logs show the OpenGL vendor/renderer and selected VA-API device/driver.
`llvmpipe` or `softpipe` in the renderer means Mesa is rendering on the CPU: check
your system's graphics driver and GPU permissions. `vainfo` with
`LIBVA_DRIVER_NAME=i965` can check which codecs your hardware supports.
The planar shader uses limited-range BT.709 for HD and BT.601 for SD; FFmpeg
normalizes clear streams to that format, and Widevine's I420 output is assumed
to use those TV colour conventions. Frames still pass through system memory;
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:cf95f2d46f0eeef01e4d79611d9ff201f577e73375a0b8e928941abcea434602 -->

this is not a zero-copy DMA-BUF pipeline.

### Development checks

Run `./port2/tests/run_gpu.sh` with Node, FFmpeg (including libx264), GCC, SDL2
and GLES development files installed. It checks driver selection and video
fallbacks, and renders test pixels through the actual shader using SDL's
offscreen Mesa backend. Physical i965 decoding still needs an Intel GPU;
these tests can run with Mesa software rendering.


<!-- /coderabbit-ai-generated:v1 -->
## Disclaimer


<!-- /coderabbit-ai-generated:v1 -->
Vacuumflix is an unofficial client. It is not affiliated with, endorsed or supported by Netflix, Inc. "Netflix" is a trademark of Netflix, Inc.

- A valid Netflix subscription is required. Vacuumflix does not provide, unlock or bypass access to any content.
- Playback uses Widevine L3 (software DRM), so the maximum quality is 1080p. Normal playback keeps DRM handling in Widevine. The optional disk buffer stores session-only clear MP4 data after licensed CDM decryption, as described above.
- The Netflix TV interface scripts and the boot animation belong to Netflix, Inc.; the Widevine CDM belongs to Google. They are included only so the app works as tested, and their owners keep all rights.
- Netflix can change its servers or interface at any time, which may break parts of the app until it is updated.


<!-- /coderabbit-ai-generated:v1 -->