# Changelog

## [0.12.0]

- Batch saves now surface the real failure reason (HTTP detail, picker denial, ZIP write error) instead of a generic failed status
- Refine and batch-request errors show the server's detail message rather than a bare status code
- Frontend unit coverage grows from 9 to 34 tests: tab lifecycle, batch queue and run/cancel paths, byte-level ZIP output, export passthrough
- Internal: data-driven keyboard shortcut table, split the batch run, tab switch, segmentation, and app entrypoint into smaller helpers, funnel preference writes through one helper
- Removed dead CSS rules and an unused test constant
- ELAPSED in the status bar only appears after a run finishes; the live timer remains on the processing overlay