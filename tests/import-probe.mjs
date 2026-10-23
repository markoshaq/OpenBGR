/**
 * Import-safety probe for tests/architecture.test.mjs.
 *
 * Usage: node tests/import-probe.mjs <static-module-name>
 *
 * Installs the DOM shim, wraps the global side-effect entry points (fetch,
 * timers, event listeners) with counters, imports the named static/ module,
 * then prints a JSON line: {fetch, timers, listeners, error}. A side-effect-
 * free module reports all-zero counts and error: null.
 */

import { installDomShims, FakeElement } from "./dom-shim.mjs";

const counts = { fetch: 0, timers: 0, listeners: 0 };

const origElemAdd = FakeElement.prototype.addEventListener;
FakeElement.prototype.addEventListener = function (...args) {
  counts.listeners++;
  return origElemAdd.apply(this, args);
};

globalThis.fetch = () => {
  counts.fetch++;
  return new Promise(() => {});
};
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
globalThis.setTimeout = (...args) => {
  counts.timers++;
  return realSetTimeout(...args);
};
globalThis.setInterval = (...args) => {
  counts.timers++;
  return realSetInterval(...args);
};
globalThis.addEventListener = () => {
  counts.listeners++;
};
globalThis.removeEventListener = () => {};

installDomShims();
const docAdd = document.addEventListener?.bind(document);
if (docAdd) {
  document.addEventListener = (...args) => {
    counts.listeners++;
    return docAdd(...args);
  };
}

const name = process.argv[2];
let error = null;
try {
  await import(new URL(`../static/${name}`, import.meta.url));
} catch (err) {
  error = String((err && err.stack) || err);
}
process.stdout.write(JSON.stringify({ ...counts, error }));
