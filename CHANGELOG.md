# Changelog

## [0.11.1]

- Quitting, restarting, or closing the window no longer hangs while a model is still downloading; the app now exits immediately
- Cancelling a model download now actually stops the transfer instead of letting it finish in the background
- Installing or uninstalling a model while another is loading no longer freezes the app; it responds right away with a busy status
- More reliable memory cleanup during image processing and icon generation
- Version number now comes from a single source instead of being hardcoded in several places; dev checkouts report a dev version rather than a stale one
- Internal reorganization: Quick Action split into focused modules (runner, settings, native integration), icon renderer moved into the package, tests organized by area