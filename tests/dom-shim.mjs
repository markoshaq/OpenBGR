/**
 * Minimal DOM/browser shims for node --test. Call `installDomShims()` before
 * dynamically importing `static/*.js` modules, which capture `document`,
 * `localStorage`, `Image`, and `navigator` at import time.
 */

class FakeClassList {
  constructor(el) {
    this._el = el;
  }
  get _set() {
    return this._el._classes;
  }
  add(...names) {
    names.forEach((n) => n && this._set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this._set.delete(n));
  }
  toggle(name, force) {
    const on = force === undefined ? !this._set.has(name) : Boolean(force);
    if (on) this._set.add(name);
    else this._set.delete(name);
    return on;
  }
  contains(name) {
    return this._set.has(name);
  }
}

function parseAttr(content) {
  const m = content.match(/^([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]+)))?$/);
  if (!m) return null;
  return { name: m[1], value: m[2] ?? m[3] ?? m[4] ?? null };
}

/** Parses one compound selector (tag/#id/.class/[attr]) into testable parts. */
function parseCompound(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let i = 0;
  if (!/^[#.]/.test(sel)) {
    const m = sel.match(/^[\w*-]+/);
    if (m) {
      out.tag = m[0] === "*" ? null : m[0].toUpperCase();
      i = m[0].length;
    }
  }
  while (i < sel.length) {
    if (sel[i] === "#") {
      const m = sel.slice(i + 1).match(/^[\w-]+/);
      out.id = m[0];
      i += 1 + m[0].length;
    } else if (sel[i] === ".") {
      const m = sel.slice(i + 1).match(/^[\w-]+/);
      out.classes.push(m[0]);
      i += 1 + m[0].length;
    } else if (sel[i] === "[") {
      const end = sel.indexOf("]", i);
      const attr = parseAttr(sel.slice(i + 1, end));
      if (attr) out.attrs.push(attr);
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return out;
}

/** True when the element matches every part of one compound selector. */
function matchesCompound(el, sel) {
  const c = parseCompound(sel);
  if (!(el instanceof FakeElement)) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const attr of c.attrs) {
    const v = el.getAttribute(attr.name);
    if (attr.value === null ? v === null : v !== attr.value) return false;
  }
  return true;
}

/** Descendant-combinator matching: last compound matches el, rest match ancestors. */
function matchesSelector(el, sel) {
  const compounds = sel.trim().split(/\s+/);
  if (!matchesCompound(el, compounds[compounds.length - 1])) return false;
  let node = el.parentElement;
  for (let i = compounds.length - 2; i >= 0; i--) {
    while (node && !matchesCompound(node, compounds[i])) node = node.parentElement;
    if (!node) return false;
    node = node.parentElement;
  }
  return true;
}

function* walk(root) {
  for (const child of root.children) {
    yield child;
    yield* walk(child);
  }
}

export class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.textContent = "";
    this.title = "";
    this.draggable = false;
    this._classes = new Set();
    this._attrs = {};
    this._listeners = {};
    this.style = {
      setProperty() {},
      removeProperty() {},
      getPropertyValue: () => "",
    };
    this.classList = new FakeClassList(this);
    if (this.tagName === "CANVAS") {
      const self = this;
      // Records drawImage args so tests can assert source/dest rects.
      this._drawCalls = [];
      this._ctx = {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "high",
        fillStyle: "#000",
        drawImage(...args) {
          self._drawCalls.push(args);
        },
        fillRect() {},
        clearRect() {},
        createPattern: () => ({}),
        getImageData(x, y, w, h) {
          return { data: new Uint8ClampedArray(w * h * 4) };
        },
        putImageData() {},
      };
      // Encode the canvas dims into the blob so tests can assert output size.
      this.toBlob = (cb, mime) =>
        cb(new Blob([`${self.width}x${self.height}`], { type: mime }));
      this.getContext = () => self._ctx;
    }
  }

  get className() {
    return [...this._classes].join(" ");
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get id() {
    return this._attrs.id || "";
  }
  set id(v) {
    this._attrs.id = v;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }
  get lastElementChild() {
    return this.children[this.children.length - 1] || null;
  }
  get childNodes() {
    return this.children;
  }

  setAttribute(name, value) {
    this._attrs[name] = String(value);
  }
  getAttribute(name) {
    return name in this._attrs ? this._attrs[name] : null;
  }
  removeAttribute(name) {
    delete this._attrs[name];
  }

  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n));
  }
  insertBefore(node, ref) {
    node.remove();
    node.parentElement = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children.forEach((c) => {
      c.parentElement = null;
    });
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
  }

  contains(node) {
    for (let n = node; n; n = n.parentElement) {
      if (n === this) return true;
    }
    return false;
  }
  closest(sel) {
    for (let n = this; n; n = n.parentElement) {
      if (matchesSelector(n, sel)) return n;
    }
    return null;
  }
  matches(sel) {
    return matchesSelector(this, sel);
  }

  querySelectorAll(sel) {
    const sels = sel.split(",").map((s) => s.trim());
    const out = [];
    for (const el of walk(this)) {
      if (sels.some((s) => matchesSelector(el, s))) out.push(el);
    }
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type];
    if (list) {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
  }
  dispatch(type, event = {}) {
    event.type = type;
    event.target = this;
    event.preventDefault ||= () => {};
    event.stopPropagation ||= () => {};
    (this._listeners[type] || []).forEach((fn) => fn.call(this, event));
  }
  click() {
    if (typeof this.onclick === "function") {
      this.onclick({ preventDefault() {}, stopPropagation() {} });
    }
    this.dispatch("click", { stopPropagation() {} });
  }
  focus() {}
  select() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
  }
}

class FakeImage {
  constructor() {
    this._src = "";
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.onload = null;
    this.onerror = null;
  }
  set src(v) {
    this._src = v;
    this.currentSrc = v;
    this.complete = true;
    if (!this.naturalWidth) {
      this.naturalWidth = 100;
      this.naturalHeight = 100;
    }
    queueMicrotask(() => this.onload?.());
  }
  get src() {
    return this._src;
  }
  removeAttribute(name) {
    if (name === "src") this._src = "";
  }
}

class FakeFileReader {
  readAsDataURL(blob) {
    Promise.resolve(blob.arrayBuffer()).then((buf) => {
      this.result =
        "data:application/octet-stream;base64," +
        Buffer.from(buf).toString("base64");
      this.onloadend?.();
    });
  }
}

/** Installs the shims on globalThis and returns the fake document + registry. */
export function installDomShims() {
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  documentElement.appendChild(body);

  const byId = new Map();
  const document = {
    documentElement,
    body,
    activeElement: null,
    // Every createElement("canvas") in order, for draw-call inspection.
    _canvases: [],
    getElementById(id) {
      // Elements are auto-created on first lookup and attached to <body> so
      // querySelector can still reach them from tests.
      if (!byId.has(id)) {
        const el = new FakeElement("div");
        el.id = id;
        body.appendChild(el);
        byId.set(id, el);
      }
      return byId.get(id);
    },
    createElement: (tag) => {
      const el = new FakeElement(tag);
      if (tag === "canvas") document._canvases.push(el);
      return el;
    },
    querySelector: (sel) =>
      documentElement.querySelectorAll(sel)[0] || null,
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    contains: (el) => documentElement.contains(el),
    execCommand: () => false,
  };

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  globalThis.document = document;
  globalThis.Image = FakeImage;
  globalThis.FileReader = FakeFileReader;
  globalThis.HTMLElement = FakeElement;
  globalThis.window = globalThis;
  globalThis.innerWidth = 1400;
  globalThis.innerHeight = 900;
  try {
    globalThis.navigator = { onLine: true, userAgent: "node-test", platform: "node" };
  } catch (_) {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true, userAgent: "node-test", platform: "node" },
      configurable: true,
    });
  }
  if (!URL.createObjectURL) {
    let seq = 0;
    URL.createObjectURL = () => `blob:mock-${++seq}`;
    URL.revokeObjectURL = () => {};
  }

  return { document, byId, storage: store };
}
