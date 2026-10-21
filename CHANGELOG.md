# Changelog

## [0.11.3]

- Mutating API endpoints now require a per-session token, blocking drive-by writes and deletes from other sites
- Edge refinement on 24MP photos: separable filters up to 67x faster; despill 4.0s down to 1.6s, defringe 2.1s down to 1.5s
- Batch ZIP streams files to disk (~2GB peak down to one at a time) and reports the 4 GiB limit instead of writing a corrupt archive
- FP16 model compaction streams per-tensor: ~1.3GB peak RAM down to ~424MB
- Native file dialogs use one-shot HTTP grants: no base64, no 48 MB limit, parallel multi-file fetches
- Fixed Restart exiting instead of restarting, and Quick Action batches duplicating files after a delegation timeout or misreporting a cancel as failures
- /api/refine calls serialize and coalesce instead of stacking ~1GB of composes per toggle click
- macOS clipboard probe reads the pasteboard counter instead of spawning osascript per focus (172ms down to microseconds); Finder-copied images now paste
- Fixed stuck pan/split drag after off-window mouse release and dead tabs from non-image drops
- Misc: cheaper preview/loupe/batch-panel updates, no runaway timers or .venv walk on /api/status, slower pending-file poll, bounded caches, batch saves off the event loop