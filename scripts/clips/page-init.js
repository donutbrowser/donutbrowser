// Runs in the recorded page before the app: a clock the recorder can slow
// down, and a Tauri IPC layer that answers from window.__HANDLERS__.
(() => {
  const realPerfNow = performance.now.bind(performance);
  const RealDate = Date;
  const dateOffset = RealDate.now() - realPerfNow();
  let rate = 1;
  let baseReal = realPerfNow();
  let baseVirtual = baseReal;
  const toVirtual = (real) => baseVirtual + (real - baseReal) * rate;
  const now = () => toVirtual(realPerfNow());

  // Virtual time runs `nextRate` times as fast as real time from here on.
  window.__clipSetRate = (nextRate) => {
    baseVirtual = now();
    baseReal = realPerfNow();
    rate = nextRate;
  };
  window.__clipNow = now;

  performance.now = now;
  const virtualDateNow = () => Math.round(dateOffset + now());
  function dateAtVirtualTime(...args) {
    if (!new.target) return new RealDate(virtualDateNow()).toString();
    return args.length ? new RealDate(...args) : new RealDate(virtualDateNow());
  }
  dateAtVirtualTime.prototype = RealDate.prototype;
  dateAtVirtualTime.now = virtualDateNow;
  dateAtVirtualTime.parse = RealDate.parse;
  dateAtVirtualTime.UTC = RealDate.UTC;
  window.Date = dateAtVirtualTime;

  const realSetTimeout = window.setTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  window.setTimeout = (fn, ms = 0, ...args) =>
    realSetTimeout(fn, (Number(ms) || 0) / rate, ...args);
  window.setInterval = (fn, ms = 0, ...args) =>
    realSetInterval(fn, (Number(ms) || 0) / rate, ...args);
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => realRaf((ts) => cb(toVirtual(ts)));

  // Tauri internals.
  const callbacks = new Map();
  const listeners = new Map();
  let nextId = 1;
  const transformCallback = (cb, once = false) => {
    const id = nextId++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return cb?.(data);
    });
    return id;
  };
  const emit = (event, payload) => {
    for (const handler of listeners.get(event) || []) {
      callbacks.get(handler)?.({ event, id: handler, payload });
    }
  };
  window.__clipEmit = emit;
  window.__clipUnknown = new Set();
  window.__clipCalls = [];

  async function invoke(cmd, args) {
    if (cmd === "plugin:event|listen") {
      if (!listeners.has(args.event)) listeners.set(args.event, []);
      listeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "plugin:event|emit") {
      emit(args.event, args.payload);
      return null;
    }
    window.__clipCalls.push(cmd);
    const handlers = window.__HANDLERS__ || {};
    if (!(cmd in handlers)) {
      window.__clipUnknown.add(cmd);
      return null;
    }
    const handler = handlers[cmd];
    const result =
      typeof handler === "function" ? await handler(args || {}) : handler;
    if (result instanceof Error) throw result.message;
    return result === undefined ? null : result;
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback: (id, data) => callbacks.get(id)?.(data),
    callbacks,
    convertFileSrc: (path, protocol = "asset") =>
      `${protocol}://localhost/${encodeURIComponent(path)}`,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {},
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: "macos",
    os_type: "macos",
    version: "26.0",
    family: "unix",
    arch: "aarch64",
    eol: "\n",
    exe_extension: "",
  };

  // A recording shows no scrollbars and no blinking caret (the caret blinks
  // on real time, so it would flicker in a slowed take).
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent =
      "*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}input,textarea,[contenteditable]{caret-color:transparent!important}";
    document.head.append(style);
  });
})();
