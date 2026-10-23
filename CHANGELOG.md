# Changelog

## [0.12.0]

### Added

- Auto-crop to subject with adjustable padding and a live crop guide
- Edge Shift and Edge Feather sliders with instant preview refinement
- Blur and custom photo backdrops alongside grid and flat colors
- Aspect ratio presets and a Fit / Stretch canvas toggle
- Retry Failed button re-runs only failed batch items
- Offline mode: Block Internet Access cuts all Hugging Face traffic, and checkpoints can be imported manually under Settings > Models
- Open Recent, Reopen Closed Tab (Shift+Cmd/Ctrl+T), and Copy Original Image in the File and Edit menus
- Open action after export or batch opens the saved file or folder in the file manager
- Animated GIF and WebP input with a frame filmstrip, playback controls, and a Start/End trim range with steppers
- Animated processing runs the trimmed frame range with live progress and cancel; refinement, backdrop, and export settings apply to every frame
- Animated GIF export honors crop, scale, dimensions, and backdrops; trimmed ranges get a `-f<start>-<end>` filename tag
- Individual frame export as PNG, WebP, JPG, or mask, to a folder or a ZIP
- CLI and Quick Action detect animated inputs and output animated cutouts

### Changed

- Native OS menu bar on macOS and Linux, with a macOS Window menu; Windows and the browser keep the in-app bar
- Faster repeat exports with an accurate file size readout, including the real encoded size for animations
- New tabs and newly loaded images start with fresh sidebar settings instead of inheriting the last image's
- Model dropdown hides the active model and shows its use case under the name
- Export folder picking works in a plain browser too
- Small images and animation frames skip upscaling to the model's full resolution: lower GPU memory and much faster frames
- Models load in FP16 at startup (~1.4 GB less RAM); machines under ~10 GB default to Lite
- Animation decoding caps frame count and pixel memory, warning when frames are dropped
- Lower memory usage after processing high-resolution images
- Release builds on pull requests now run only when the `build-release` label is attached; tags and manual dispatch are unchanged
- Past release notes are kept in a collapsed section below; GitHub release notes still extract only the current section
- Keyboard shortcut table, text-field gate, and platform label rewrites moved into `static/shortcuts.js` with unit tests
- The frontend entry point is now a thin boot file: menus, keyboard, file open and drop, paste, Open Recent, backdrop, model dropdown, tooltips, settings, workspace controls, stage input, and the `window.openBGR` bridge live in side-effect-free modules under `static/`, each with unit tests
- The largest frontend modules are split by responsibility: export (pipeline, UI sync, IO actions, ZIP writer), tabs (lifecycle, segmentation), and batch (queue, panel, runner), with a small event bus for cross-module signals
- Frontend checks now include a repeatable headless-browser smoke test (`npm run test:smoke`) that exercises menus, paste, zoom, and settings in a real browser
- The frontend import graph is now acyclic and stays that way: an architecture test enforces acyclic imports, side-effect-free modules, and bounded file sizes
- Refine cache skips images over ~64 MP so very large jobs stop pinning hundreds of MB between jobs
- Model disk sizes behind /api/status are cached for 30 seconds instead of rescanning the Hugging Face cache per call
- `Start Mac.command` renamed to `start_mac.command`

### Fixed

- The refine path raises a real 500 on a missing image instead of an assert that `-O` strips
- Desktop export no longer opens a white page with the raw file; it uses a native save dialog
- Auto-Crop on animations unions every trimmed frame so moving subjects aren't clipped
- Start/End frame entries clamp to the valid range
- The toast action no longer turns dark on hover
- Keyboard shortcuts and image paste no longer fire while typing in text fields
- Unknown CLI flags fail with a usage error instead of being silently ignored
- Signal exits report 128 + signum so killed processes no longer report success
- Offline mode, session token persistence, and settings writes warn instead of failing silently
- Download progress falls back to phase-only with a warning when Hugging Face internals change
- Runtime dependencies now have upper bounds so unvetted majors can't auto-resolve into releases
- Shared UI constants (accents, tier aliases, tier keys) are drift-checked by the repo integrity test
- Test suite runs on Python 3.10 via a tomli fallback for tomllib

### Security

- Reject non-loopback Host headers so the session token cannot leak through DNS rebinding
- /api/save only writes into folders picked through the app's folder dialog
- Upload bodies are capped at 256 MB before buffering

<details>
<summary>Past releases</summary>

### [0.11.3]

#### Security

- Mutating API endpoints now require a per-session token, blocking drive-by writes and deletes from other sites

#### Changed

- Edge refinement on 24MP photos: separable filters up to 67x faster; despill 4.0s down to 1.6s, defringe 2.1s down to 1.5s
- Batch ZIP streams files to disk (~2GB peak down to one at a time) and reports the 4 GiB limit instead of writing a corrupt archive
- FP16 model compaction streams per-tensor: ~1.3GB peak RAM down to ~424MB
- Native file dialogs use one-shot HTTP grants: no base64, no 48 MB limit, parallel multi-file fetches
- Refine toggles coalesce instead of stacking ~1GB of work per click
- Misc: cheaper preview/loupe/batch-panel updates, no runaway timers or .venv walk on /api/status, slower pending-file poll, bounded caches, batch saves off the event loop

#### Fixed

- Restart exiting instead of restarting, and Quick Action batches duplicating files after a delegation timeout or misreporting a cancel as failures
- Finder-copied images now paste, with the clipboard check costing microseconds instead of spawning osascript per focus
- Stuck pan/split drag after off-window mouse release and dead tabs from non-image drops

### [0.11.2]

#### Added

- Batch rows get checkboxes (with a toggle-all) to pick which images run; skipped rows dim
- Right-click a tab to rename it
- Processing overlay shows a live elapsed timer; ELAPSED at the bottom only shows the finished total

#### Changed

- Batch queue polish: plain background, no footer hint, header shows just the image count; batch tabs keep their live "(N)" count
- Settings reorganized: GENERAL is now the default tab and System info moved under About

### [0.11.1]

#### Fixed

- Quitting, restarting, or closing the window no longer hangs while a model is still downloading; the app exits immediately
- Cancelling a model download actually stops the transfer instead of letting it finish in the background
- Installing or uninstalling a model while another is loading no longer freezes the app; it responds with a busy status
- More reliable memory cleanup during image processing and icon generation

#### Changed

- Version number comes from a single source; dev checkouts report a dev version rather than a stale one
- Internal reorganization: Quick Action split into focused modules, icon renderer moved into the package, tests organized by area

</details>
