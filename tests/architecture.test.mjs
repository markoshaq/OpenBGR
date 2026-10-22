/**
 * Architectural guardrails for static/.
 *
 * Enforced rules, kept honest by CI rather than review:
 *  - the module import graph is acyclic (dependency injection or bus events
 *    carry calls back upward; see CONTRIBUTING.md "Frontend architecture"),
 *  - every module except app.js imports without running side effects
 *    (no fetch, timers, or listeners at module scope; verified by spawning
 *    tests/import-probe.mjs per module),
 *  - file sizes stay bounded so no module regrows into a god-file.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATIC_DIR = new URL("../static/", import.meta.url);
const BOOT_MAX_LINES = 120;
const MODULE_MAX_LINES = 1000;

const modules = readdirSync(STATIC_DIR).filter((f) => f.endsWith(".js")).sort();

function importEdges(file) {
  const src = readFileSync(new URL(file, STATIC_DIR), "utf8");
  const edges = [];
  for (const m of src.matchAll(/from\s+["']\.\/([\w-]+\.js)["']/g)) {
    edges.push(m[1]);
  }
  for (const m of src.matchAll(/import\s+["']\.\/([\w-]+\.js)["']/g)) {
    edges.push(m[1]);
  }
  return edges;
}

test("static/ module import graph is acyclic", () => {
  const graph = new Map(modules.map((m) => [m, importEdges(m)]));
  const state = new Map(); // 0 = unvisited, 1 = in stack, 2 = done
  let cycle = null;

  const visit = (node, stack) => {
    if (cycle) return;
    state.set(node, 1);
    for (const dep of graph.get(node) || []) {
      if (!graph.has(dep)) continue;
      const s = state.get(dep) || 0;
      if (s === 1) {
        cycle = [...stack, node, dep].join(" -> ");
        return;
      }
      if (s === 0) visit(dep, [...stack, node]);
    }
    state.set(node, 2);
  };
  for (const m of modules) {
    if ((state.get(m) || 0) === 0) visit(m, []);
  }
  assert.equal(cycle, null, `import cycle: ${cycle}`);
});

test("file sizes stay bounded (boot <= 120, modules <= 1000 lines)", () => {
  const offenders = modules
    .map((m) => {
      const lines = readFileSync(new URL(m, STATIC_DIR), "utf8").split("\n").length - 1;
      const cap = m === "app.js" ? BOOT_MAX_LINES : MODULE_MAX_LINES;
      return lines > cap ? `${m} (${lines} > ${cap})` : null;
    })
    .filter(Boolean);
  assert.deepEqual(offenders, []);
});

test("every module except app.js is import-safe (zero side effects)", () => {
  for (const m of modules) {
    if (m === "app.js") continue;
    const out = execFileSync(
      process.execPath,
      ["tests/import-probe.mjs", m],
      { cwd: ROOT, encoding: "utf8", timeout: 30000 }
    );
    const res = JSON.parse(out.trim().split("\n").pop());
    assert.equal(res.error, null, `${m} threw at import: ${res.error}`);
    assert.deepEqual(
      { fetch: res.fetch, timers: res.timers, listeners: res.listeners },
      { fetch: 0, timers: 0, listeners: 0 },
      `${m} ran side effects at import time`
    );
  }
});
