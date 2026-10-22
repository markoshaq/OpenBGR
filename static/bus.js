/**
 * A tiny synchronous event bus for cross-module notifications. It exists so
 * callers that only need to *ask for a side effect* (close the context menu,
 * re-probe the clipboard) do not have to import the module that owns it.
 * Handlers run synchronously in subscription order.
 * This module has no imports and no side effects.
 */

const handlers = new Map();

/**
 * Subscribes `fn` to `name`; returns an unsubscribe function.
 * Handlers may return a Promise: `emit` does not await it (fire-and-forget
 * side effects like the clipboard probe match the old call sites).
 */
export function on(name, fn) {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(fn);
  return () => off(name, fn);
}

/** Removes a subscription previously added with `on`. */
export function off(name, fn) {
  const set = handlers.get(name);
  if (!set) return;
  set.delete(fn);
  if (!set.size) handlers.delete(name);
}

/** Calls every `name` subscriber with `detail`, in subscription order. */
export function emit(name, detail) {
  const set = handlers.get(name);
  if (!set) return;
  for (const fn of set) fn(detail);
}
