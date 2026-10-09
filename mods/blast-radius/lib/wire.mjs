import { createInterface } from "node:readline";

const LOG_MAX = 400;
const DEFAULT_DEADLINE_MS = 9500;
const DEFAULT_CALL_TIMEOUT_MS = 9000;

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorText(error) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

export class CallError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createWire({ write, setup, timers = { setTimeout, clearTimeout } }) {
  let nextCall = 0;
  let hello = null;
  const pending = new Map();

  function send(message) {
    try {
      write(`${JSON.stringify(message)}\n`);
    } catch {
      return;
    }
  }

  function log(level, message) {
    send({ type: "log", level: level === "warn" ? "warn" : "info", message: String(message).slice(0, LOG_MAX) });
  }

  function call(method, params, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    nextCall += 1;
    const id = `c${nextCall}`;
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pending.delete(id);
        reject(new CallError("mods.call_timeout", `${method} did not answer in time`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ type: "call", id, method, params });
    });
  }

  const api = { call, log };
  const config = setup(api);
  const handlers = isRecord(config?.handlers) ? config.handlers : {};
  const fallback = typeof config?.fallback === "function" ? config.fallback : () => [];
  const deadlines = isRecord(config?.deadlines) ? config.deadlines : {};

  function settle(message) {
    const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : null;
    const entry = id === null ? undefined : pending.get(id);
    if (!entry) return;
    pending.delete(id);
    timers.clearTimeout(entry.timer);
    if (message.ok === true) {
      entry.resolve(message.value ?? null);
      return;
    }
    const failure = isRecord(message.error) ? message.error : {};
    entry.reject(new CallError(typeof failure.code === "string" ? failure.code : "mods.call_failed", typeof failure.message === "string" ? failure.message : "the call failed"));
  }

  function safeFallback(event, error) {
    try {
      const value = fallback(event, error);
      return Array.isArray(value) ? value.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  async function dispatch(event) {
    const handler = handlers[event.hook];
    let publish = [];
    if (typeof handler === "function") {
      let timer;
      try {
        const deadline = typeof deadlines[event.hook] === "number" ? deadlines[event.hook] : DEFAULT_DEADLINE_MS;
        const work = Promise.resolve().then(() => handler(event, api));
        const late = new Promise((_, reject) => {
          timer = timers.setTimeout(() => reject(new Error(`${event.hook} ran out of time`)), deadline);
        });
        const result = await Promise.race([work, late]);
        publish = Array.isArray(result) ? result.filter(isRecord) : [];
      } catch (error) {
        log("warn", `${event.hook} failed: ${errorText(error)}`);
        publish = safeFallback(event, error);
      } finally {
        timers.clearTimeout(timer);
      }
    }
    send({ type: "reply", id: event.id, publish });
  }

  function feed(line) {
    const text = String(line ?? "").trim();
    if (!text) return Promise.resolve();
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log("warn", "Ignored a line that is not JSON.");
      return Promise.resolve();
    }
    if (!isRecord(message)) {
      log("warn", "Ignored a message that is not an object.");
      return Promise.resolve();
    }
    if (message.type === "hello") {
      hello = message;
      return Promise.resolve();
    }
    if (message.type === "result") {
      settle(message);
      return Promise.resolve();
    }
    if (message.type === "event") {
      if (typeof message.id !== "number" && typeof message.id !== "string") {
        log("warn", "Ignored an event without an id.");
        return Promise.resolve();
      }
      const event = {
        id: message.id,
        hook: typeof message.hook === "string" ? message.hook : "",
        thread_id: typeof message.thread_id === "string" ? message.thread_id : "",
        workspace_id: typeof message.workspace_id === "string" ? message.workspace_id : "",
        data: isRecord(message.data) ? message.data : {},
      };
      return dispatch(event);
    }
    log("warn", `Ignored a message of type ${String(message.type).slice(0, 40)}.`);
    return Promise.resolve();
  }

  return {
    feed,
    call,
    log,
    hello: () => hello,
    pendingCalls: () => pending.size,
  };
}

export function runStdio(setup) {
  const wire = createWire({ write: (text) => process.stdout.write(text), setup });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    wire.feed(line).catch((error) => wire.log("warn", `Handling a line failed: ${errorText(error)}`));
  });
  lines.on("close", () => process.exit(0));
  process.stdout.on("error", () => process.exit(0));
  process.on("uncaughtException", (error) => wire.log("warn", `Unexpected error: ${errorText(error)}`));
  process.on("unhandledRejection", (error) => wire.log("warn", `Unexpected rejection: ${errorText(error)}`));
  return wire;
}
