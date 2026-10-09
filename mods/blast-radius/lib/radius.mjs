import { commands } from "./shell.mjs";
import { classify } from "./classify.mjs";
import { budget, makeProbe, measure, Unmeasurable } from "./measure.mjs";
import { callout, capBlocks, COULD_NOT_MEASURE, title } from "./blocks.mjs";

export const SLOT = "permission.detail";
export const BUDGET_MS = 2400;
const MAX_TARGETS = 3;
const COMMAND_MAX = 8000;

export function targetsOf(command) {
  if (typeof command !== "string" || !command.trim()) return [];
  return commands(command.slice(0, COMMAND_MAX)).map(classify).filter((target) => target !== null).slice(0, MAX_TARGETS);
}

export async function radius(data, run, { now = Date.now, budgetMs = BUDGET_MS } = {}) {
  if (data.destructive !== true || typeof data.cwd !== "string") return null;
  const targets = targetsOf(data.command);
  if (targets.length === 0) return null;
  const probe = makeProbe(run, budget(budgetMs, now));
  const blocks = [];
  let measured = 0;
  for (const target of targets) {
    try {
      blocks.push(...(await measure(target, { probe, worktree: data.cwd })));
      measured += 1;
    } catch (error) {
      blocks.push(error instanceof Unmeasurable ? callout("info", error.message, title(target.text)) : { ...COULD_NOT_MEASURE, title: title(target.text) });
    }
  }
  if (measured === 0 && targets.length > 1) return [COULD_NOT_MEASURE];
  return capBlocks(blocks);
}

export function publication(event, blocks) {
  const key = typeof event.data.request_id === "string" ? event.data.request_id : String(event.data.request_id ?? "");
  if (blocks === null) return { thread_id: event.thread_id, slot: SLOT, key, clear: true };
  return { thread_id: event.thread_id, slot: SLOT, key, blocks };
}

export function processRunner(call, threadId) {
  return (argv, cwd, timeoutMs) => {
    const params = { thread_id: threadId, argv, timeout_ms: timeoutMs };
    if (cwd !== undefined) params.cwd = cwd;
    return call("process.run", params, { timeoutMs: timeoutMs + 500 });
  };
}

export function setup({ call }) {
  return {
    deadlines: { "permission.request": 2800 },
    handlers: {
      "permission.request": async (event) => {
        if (event.data.request_id === undefined) return [];
        const blocks = await radius(event.data, processRunner(call, event.thread_id));
        return [publication(event, blocks)];
      },
    },
    fallback: (event) => (event.hook === "permission.request" && event.data.request_id !== undefined ? [publication(event, [COULD_NOT_MEASURE])] : []),
  };
}
