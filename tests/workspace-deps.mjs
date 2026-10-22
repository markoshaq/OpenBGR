/**
 * Test helper: injects the real tab-strip operations into the workspace
 * domain modules, mirroring the boot wiring in static/app.js. Call once per
 * test file that exercises batch/segmentation code paths, after
 * installDomShims(); inject stubs into initBatch/initBatchPanel/initBatchRun/
 * initSegmentation directly for narrower isolation.
 */

export async function wireRealTabOps() {
  const { initBatch } = await import("../static/batch.js");
  const { initBatchPanel } = await import("../static/batch-panel.js");
  const { initBatchRun } = await import("../static/batch-run.js");
  const { initSegmentation } = await import("../static/segmentation.js");
  const {
    renderTabBar,
    closeTabImmediate,
    switchToTab,
    ingestImageFile,
    hideTabGhost,
    setViewMode,
    syncMenuBarState,
  } = await import("../static/tabs.js");

  initSegmentation({ setViewMode, syncMenuBarState });
  initBatchPanel({ renderTabBar, hideTabGhost, closeTabImmediate });
  initBatchRun({ syncMenuBarState });
  initBatch({ renderTabBar, closeTabImmediate, switchToTab, ingestImageFile });
}
