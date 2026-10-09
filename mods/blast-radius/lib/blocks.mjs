export const BLOCK_LIMIT = 16 * 1024;
const ITEM_MAX = 200;
const TITLE_MAX = 60;

export const COULD_NOT_MEASURE = Object.freeze({ type: "callout", tone: "info", text: "Couldn't measure this one." });

export function clip(text, max) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function count(value) {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

export function plural(value, one, many = `${one}s`) {
  return `${count(value)} ${value === 1 ? one : many}`;
}

export function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || amount >= 10 ? Math.round(amount).toString() : amount.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${units[unit]}`;
}

export function title(text) {
  return clip(text, TITLE_MAX);
}

export function stats(heading, items) {
  return { type: "stats", title: heading, items: items.map((item) => (item.hint ? { label: item.label, value: String(item.value), hint: item.hint } : { label: item.label, value: String(item.value) })) };
}

export function list(heading, items) {
  return { type: "list", title: heading, items: items.map((item) => clip(item, ITEM_MAX)), ordered: false };
}

export function kv(items, heading = null) {
  const block = { type: "kv", items: items.map((item) => ({ key: item.key, value: clip(item.value, ITEM_MAX) })) };
  return heading ? { ...block, title: heading } : block;
}

export function callout(tone, text, heading = null) {
  const block = { type: "callout", tone, text: clip(text, 400) };
  return heading ? { ...block, title: heading } : block;
}

function size(blocks) {
  return Buffer.byteLength(JSON.stringify(blocks), "utf8");
}

export function capBlocks(blocks) {
  let out = blocks.map((block) => ({ ...block, ...(Array.isArray(block.items) ? { items: [...block.items] } : {}) }));
  while (size(out) > BLOCK_LIMIT) {
    const longest = out.filter((block) => block.type === "list" && block.items.length > 1).sort((a, b) => b.items.length - a.items.length)[0];
    if (longest) {
      longest.items.pop();
      continue;
    }
    if (out.length > 1) {
      out = out.slice(0, -1);
      continue;
    }
    return [COULD_NOT_MEASURE];
  }
  return out;
}
