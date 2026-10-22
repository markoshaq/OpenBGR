/**
 * Headless-browser smoke test for the OpenBGR frontend.
 *
 * Starts the app server (NO_BROWSER=1) and drives a headless Chromium-family
 * browser (Chrome / Brave / Chromium / Edge; override with CHROME_BIN) over
 * the raw DevTools protocol, then exercises the real boot path: bridge,
 * menus, Escape cascade, dropdowns, settings, tooltips, backdrop, paste,
 * and stage input. Exits nonzero on any failed check or console error.
 *
 * Usage: node scripts/browser_smoke.mjs [--port N] [--url URL]
 *   --url points at an already-running server and skips spawning one.
 * Requires Node >= 22 (native WebSocket) and a venv or system python.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (typeof WebSocket !== "function") {
  console.error(
    `browser_smoke.mjs needs Node >= 22 for the native WebSocket client (got ${process.version}).`
  );
  process.exit(1);
}

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const PORT = Number(argVal("--port") || 7861);
const BASE_URL = argVal("--url") || `http://127.0.0.1:${PORT}/`;
const CDP_PORT = 9333 + (PORT % 100);
const STARTUP_TIMEOUT_MS = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(name);
  }
};

function findChrome() {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error("No Chromium-family browser found; set CHROME_BIN.");
  }
  return found;
}

function findPython() {
  const venv = join(REPO, ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok) return;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error(`Server did not come up at ${BASE_URL}`);
}

// The page-side probe: exercises live app wiring and reports observable state.
const PROBE = `(async () => {
  const r = {};
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const key = (k, o = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...o }));
  r.bridgeKeys = Object.keys(window.openBGR || {}).length;
  r.tierLabel = document.getElementById("tierDropdownLabel")?.textContent;
  const trig = document.querySelector("#menuBar .menu-root .menu-trigger");
  trig.click();
  r.menuOpen = !!document.querySelector("#menuBar .menu-root.open");
  key("Escape");
  r.menuClosedByEsc = !document.querySelector("#menuBar .menu-root.open");
  document.getElementById("tierDropdownBtn").click();
  r.tierOpen = document.getElementById("tierDropdown").classList.contains("open");
  document.body.click();
  r.tierClosedOutside = !document.getElementById("tierDropdown").classList.contains("open");
  key(",", { metaKey: true });
  r.prefsOpen = document.getElementById("infoModal").classList.contains("active");
  key("Escape");
  r.prefsClosed = !document.getElementById("infoModal").classList.contains("active");
  const tipHost = document.querySelector("[data-tooltip]");
  tipHost?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  r.tooltip = document.querySelector(".floating-tooltip.visible")?.textContent || null;
  document.querySelector('.mode-chip[data-mode="blur"]')?.click();
  r.blurChip = document.querySelector('.mode-chip[data-mode="blur"]')?.classList.contains("active");
  document.querySelector('.mode-chip[data-mode="checker"]')?.click();
  const c = document.createElement("canvas");
  c.width = 8; c.height = 8;
  c.getContext("2d").fillRect(0, 0, 8, 8);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "paste.png", { type: "image/png" }));
  window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt }));
  await wait(300);
  r.tabsAfterPaste = document.querySelectorAll("[data-tab-id]").length;
  r.statFile = document.getElementById("statFile")?.textContent;
  const vp = document.getElementById("viewport");
  vp.dispatchEvent(new WheelEvent("wheel", { deltaX: 10, deltaY: -10, bubbles: true, cancelable: true }));
  r.zoomAfterWheel = document.getElementById("btnZoomReset")?.textContent;
  vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
  r.zoomAfterPinch = document.getElementById("btnZoomReset")?.textContent;
  document.getElementById("prefThemeLight")?.click();
  r.themeLight = document.documentElement.classList.contains("theme-light");
  document.getElementById("prefThemeDark")?.click();
  document.getElementById("viewSplit")?.click();
  r.viewSplit = document.getElementById("viewSplit").classList.contains("active");
  return r;
})()`;

async function main() {
  const chrome = findChrome();
  console.log(`browser: ${chrome}`);
  console.log(`target:  ${BASE_URL}`);

  if (!argVal("--url")) {
    const py = findPython();
    const server = spawn(py, ["app.py"], {
      cwd: REPO,
      env: { ...process.env, NO_BROWSER: "1", PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(server);
    server.stderr.on("data", (d) => {
      const line = String(d).trim();
      if (line) process.stderr.write(`[server] ${line}\n`);
    });
    console.log(`server:  spawned ${py} app.py (port ${PORT})`);
  }

  const browser = spawn(chrome, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "openbgr-smoke-"))}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ]);
  children.push(browser);

  try {
    await waitForServer();

    let targets;
    for (let i = 0; i < 100; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
        if (targets.some((t) => t.type === "page")) break;
      } catch (_) {}
      await sleep(200);
    }
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("No debuggable page target found.");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });

    let id = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const ex = msg.params.exceptionDetails;
        consoleErrors.push(ex.exception?.description || ex.text);
      } else if (
        msg.method === "Runtime.consoleAPICalled" &&
        msg.params.type === "error"
      ) {
        consoleErrors.push(
          msg.params.args.map((a) => a.value ?? a.description).join(" ")
        );
      }
    };
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, res);
        ws.onerror = rej;
        ws.send(JSON.stringify({ id: i, method, params }));
      });

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.navigate", { url: BASE_URL });
    await sleep(3000);

    const res = await send("Runtime.evaluate", {
      expression: PROBE,
      awaitPromise: true,
      returnByValue: true,
    });
    const r = res.result?.result?.value;
    if (!r) {
      throw new Error(
        `Probe returned nothing: ${JSON.stringify(res.result ?? res)}`
      );
    }
    console.log(JSON.stringify(r, null, 2));

    check("window.openBGR bridge installed (20+ commands)", r.bridgeKeys >= 20);
    check("tier dropdown mirrors selected tier", Boolean(r.tierLabel));
    check("menu trigger opens dropdown", r.menuOpen === true);
    check("Escape closes open menu", r.menuClosedByEsc === true);
    check("tier dropdown opens", r.tierOpen === true);
    check("outside click closes tier dropdown", r.tierClosedOutside === true);
    check("Cmd+, opens settings", r.prefsOpen === true);
    check("Escape closes settings", r.prefsClosed === true);
    check("tooltip renders", typeof r.tooltip === "string");
    check("blur backdrop chip activates", r.blurChip === true);
    check("paste ingests one image tab", r.tabsAfterPaste === 1);
    check("stat line shows pasted file", r.statFile === "PASTE.PNG");
    check("plain wheel pans without zoom", r.zoomAfterWheel === "100%");
    check("ctrl-wheel pinch zooms", r.zoomAfterPinch !== "100%");
    check("theme toggle applies light class", r.themeLight === true);
    check("view button activates split mode", r.viewSplit === true);
    check("no page console errors", consoleErrors.length === 0,
      consoleErrors.join(" | "));
    ws.close();
  } finally {
    for (const child of children) child.kill("SIGTERM");
  }

  if (failures.length) {
    console.error(`\nsmoke FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nsmoke passed");
}

main().catch((err) => {
  console.error(`smoke error: ${err.message}`);
  for (const child of children) child.kill("SIGTERM");
  process.exit(1);
});
