import { posix } from "node:path";
import { inside } from "./shell.mjs";
import { bytes, callout, count, kv, list, plural, stats, title } from "./blocks.mjs";
import { branchProbe, cleanProbe, discardProbes, existProbes, globProbe, MAX_OPERANDS, pushProbes, remoteRefFor, sizeProbes, upstreamProbe, validRef, validRev } from "./plan.mjs";

const PROBE_MAX_MS = 1500;
const PROBE_MIN_MS = 200;
const SLACK_MS = 150;
const SHOWN = 10;
const GLOB = /[*?[]/;

export class Unmeasurable extends Error {}

export function budget(totalMs, now) {
  const start = now();
  return { remaining: () => totalMs - (now() - start) };
}

function normalise(result) {
  const value = typeof result === "object" && result !== null ? result : {};
  return {
    code: typeof value.code === "number" ? value.code : null,
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    timed_out: value.timed_out === true,
  };
}

export function makeProbe(run, clock) {
  return async (argv, cwd) => {
    const left = clock.remaining() - SLACK_MS;
    if (left < PROBE_MIN_MS) throw new Error("ran out of time");
    const timeout = Math.floor(Math.min(PROBE_MAX_MS, left));
    return normalise(await run(argv, cwd === "." ? undefined : cwd, timeout));
  };
}

export function outputLines(result) {
  const text = result.stdout;
  const parts = text.split("\n");
  const complete = text === "" || text.endsWith("\n");
  if (!complete) parts.pop();
  const lines = parts.filter((line) => line.length > 0);
  return { lines, partial: !complete || result.timed_out || text.length >= 60000 };
}

function clean(path) {
  const normalised = posix.normalize(path);
  return normalised.startsWith("./") ? normalised.slice(2) : normalised;
}

function baseOf(target, worktree) {
  const base = target.cwd === null ? null : inside(worktree, target.cwd);
  if (base === null) throw new Unmeasurable("Couldn't tell which folder this runs in.");
  return base;
}

function firstShown(lines, noun) {
  return lines.length > SHOWN ? `First ${SHOWN} of ${count(lines.length)} ${noun}` : noun.charAt(0).toUpperCase() + noun.slice(1);
}

async function measureRm(target, { probe, worktree }) {
  const base = baseOf(target, worktree);
  const notes = [];
  if (target.fromStdin) notes.push("paths come from another command");
  const literal = [];
  const globs = [];
  for (const word of target.operands.slice(0, MAX_OPERANDS)) {
    if (word.dynamic || word.home) {
      notes.push(`${word.v} uses a variable or home folder`);
      continue;
    }
    const rel = posix.isAbsolute(word.v) ? inside(worktree, word.v) : inside(worktree, posix.join(base, word.v));
    if (rel === null) {
      notes.push(`${word.v} is outside the worktree`);
      continue;
    }
    if (!word.glob) {
      literal.push(rel);
      continue;
    }
    const parts = rel.split("/");
    const at = parts.findIndex((part) => GLOB.test(part));
    if (at !== parts.length - 1) {
      notes.push(`${word.v} has a pattern in a folder name`);
      continue;
    }
    globs.push({ dir: parts.slice(0, -1).join("/") || ".", pattern: parts[at], raw: word.v });
  }
  const matched = await Promise.all(globs.map(async (glob) => {
    const result = await probe(globProbe(glob.dir, glob.pattern), ".");
    const hidden = glob.pattern.startsWith(".");
    return outputLines(result).lines.map(clean).filter((path) => hidden || !posix.basename(path).startsWith("."));
  }));
  const candidates = [...new Set([...literal, ...matched.flat()])];
  if (candidates.length === 0) {
    return [callout("info", notes.length ? `Not measured: ${notes.join("; ")}.` : "Nothing to delete at these paths.", title(target.text))];
  }
  const exist = existProbes(candidates);
  const [dirResult, otherResult] = await Promise.all([probe(exist.dirs, "."), probe(exist.other, ".")]);
  const dirs = outputLines(dirResult).lines.map(clean);
  const others = outputLines(otherResult).lines.map(clean);
  const targets = [...others, ...(target.recursive ? dirs : [])];
  if (!target.recursive && dirs.length) notes.push(`${plural(dirs.length, "folder")} skipped without -r`);
  if (targets.length === 0) {
    return [callout("info", notes.length ? `Nothing to delete at these paths. ${notes.join("; ")}.` : "Nothing to delete at these paths.", title(target.text))];
  }
  const sizes = sizeProbes(targets);
  const [fileResult, sizeResult] = await Promise.all([probe(sizes.files, "."), probe(sizes.size, ".")]);
  const files = outputLines(fileResult);
  const kilobytes = outputLines(sizeResult).lines.reduce((sum, line) => sum + (Number.parseInt(line, 10) || 0), 0);
  const sizeKnown = !sizeResult.timed_out && outputLines(sizeResult).lines.length > 0;
  const shown = files.lines.map(clean);
  const blocks = [stats(title(target.text), [
    { label: "Files", value: `${count(shown.length)}${files.partial ? "+" : ""}` },
    sizeKnown ? { label: "Size", value: bytes(kilobytes * 1024) } : { label: "Size", value: "Unknown", hint: "took too long" },
  ])];
  if (shown.length) blocks.push(list(firstShown(shown, "files"), shown.slice(0, SHOWN)));
  if (notes.length) blocks.push(list("Not measured", notes));
  blocks.push(shown.length ? callout("warn", "rm deletes these for good; they don't go to the Trash.") : callout("info", "Only empty folders would be removed."));
  return blocks;
}

export function parseShortstat(text) {
  const match = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(text);
  if (!match) return { files: 0, insertions: 0, deletions: 0 };
  return { files: Number(match[1]), insertions: Number(match[2] ?? 0), deletions: Number(match[3] ?? 0) };
}

export function parsePorcelain(text, full) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" || x === "!") continue;
    if (!(full ? x !== " " || y !== " " : y !== " ")) continue;
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    out.push(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return out;
}

async function measureDiscard(target, { probe, worktree }) {
  const base = baseOf(target, worktree);
  if (target.unstageOnly) return [callout("info", "Only unstages these changes; the files keep their edits.", title(target.text))];
  if (target.source !== null && !validRev(target.source)) throw new Unmeasurable("Couldn't read the commit this resets to.");
  const probes = discardProbes(target);
  const [status, diff, leaving] = await Promise.all([probe(probes.status, base), probe(probes.diff, base), probes.leaving ? probe(probes.leaving, base) : Promise.resolve(null)]);
  if (status.code !== 0) throw new Error("git status failed");
  const files = parsePorcelain(status.stdout, target.full);
  const lines = diff.code === 0 ? parseShortstat(diff.stdout) : null;
  const commits = leaving && leaving.code === 0 ? Number.parseInt(leaving.stdout.trim(), 10) || 0 : 0;
  const extra = commits > 0 ? [kv([{ key: "Commits leaving the branch", value: `${count(commits)} (still in the reflog)` }])] : [];
  if (files.length === 0 && (lines === null || lines.files === 0)) {
    return [callout(commits > 0 ? "warn" : "info", "Nothing uncommitted would be lost.", title(target.text)), ...extra];
  }
  const items = [{ label: "Files", value: count(Math.max(files.length, lines ? lines.files : 0)) }];
  items.push(lines ? { label: "Lines", value: `+${count(lines.insertions)} −${count(lines.deletions)}` } : { label: "Lines", value: "Unknown" });
  return [
    stats(title(target.text), items),
    ...(files.length ? [list(firstShown(files, "files"), files.slice(0, SHOWN))] : []),
    ...extra,
    callout("warn", target.full ? "Uncommitted changes in these files, staged or not, are lost for good." : "Unstaged changes in these files are lost for good. Staged changes stay."),
  ];
}

async function measureClean(target, { probe, worktree }) {
  const base = baseOf(target, worktree);
  const result = await probe(cleanProbe(target), base);
  if (result.code !== 0) throw new Error("git clean -n failed");
  const { lines, partial } = outputLines(result);
  const paths = lines.filter((line) => line.startsWith("Would remove ")).map((line) => line.slice("Would remove ".length));
  if (paths.length === 0) return [callout("info", "No untracked files would be removed.", title(target.text))];
  const sized = await probe(sizeProbes(paths).size, base);
  const kilobytes = outputLines(sized).lines.reduce((sum, line) => sum + (Number.parseInt(line, 10) || 0), 0);
  const known = !sized.timed_out && outputLines(sized).lines.length > 0;
  const warning = target.flags.includes("-x") || target.flags.includes("-X") ? "Untracked files aren't in git, so they can't be recovered. This includes ignored files such as build output and .env files." : "Untracked files aren't in git, so they can't be recovered.";
  return [
    stats(title(target.text), [
      { label: "Entries", value: `${count(paths.length)}${partial ? "+" : ""}` },
      known ? { label: "Size", value: bytes(kilobytes * 1024) } : { label: "Size", value: "Unknown", hint: "took too long" },
    ]),
    list(firstShown(paths, "entries"), paths.slice(0, SHOWN)),
    callout("warn", warning),
  ];
}

async function pushPairs(target, probe, base) {
  if (target.refs.length) {
    if (target.remote === null || !validRef(target.remote)) throw new Unmeasurable("Couldn't tell which remote this pushes to.");
    return target.refs.slice(0, 3).map((ref) => ({ remote: target.remote, branch: ref.remote, local: ref.local === "" ? null : ref.local }));
  }
  if (target.remote === null) {
    const upstream = await probe(upstreamProbe(), base);
    const name = upstream.stdout.trim();
    const slash = name.indexOf("/");
    if (upstream.code !== 0 || slash <= 0) throw new Unmeasurable("This branch has no upstream, so there is nothing to compare.");
    return [{ remote: name.slice(0, slash), branch: name.slice(slash + 1), local: "HEAD" }];
  }
  if (!validRef(target.remote)) throw new Unmeasurable("Couldn't tell which remote this pushes to.");
  const head = await probe(branchProbe(), base);
  const branch = head.stdout.trim();
  if (head.code !== 0 || branch === "" || branch === "HEAD") throw new Unmeasurable("Couldn't tell which branch this pushes.");
  return [{ remote: target.remote, branch, local: "HEAD" }];
}

async function measurePush(target, { probe, worktree }) {
  const base = baseOf(target, worktree);
  if (target.everything) return [callout("warn", "Force-pushes every branch or tag at once; not measured branch by branch.", title(target.text))];
  const pairs = await pushPairs(target, probe, base);
  const blocks = [];
  for (const pair of pairs) {
    const name = `${pair.remote}/${pair.branch}`;
    if (!validRef(pair.branch) || (pair.local !== null && !validRev(pair.local))) {
      blocks.push(callout("info", `Couldn't read the branch names in ${name}.`, title(target.text)));
      continue;
    }
    const probes = pushProbes(pair.local, remoteRefFor(pair.remote, pair.branch));
    const [counted, subjects] = await Promise.all([probe(probes.count, base), probe(probes.subjects, base)]);
    if (counted.code !== 0) {
      blocks.push(callout("info", `There's no local copy of ${name}. Fetch first to compare.`, title(target.text)));
      continue;
    }
    const lost = Number.parseInt(counted.stdout.trim(), 10) || 0;
    const lease = target.lease ? " With --force-with-lease, the push stops if the remote moved since then." : "";
    if (lost === 0) {
      blocks.push(callout("info", `Nothing on ${name} is missing from your branch, as of your last fetch.${lease}`, title(target.text)));
      continue;
    }
    const lines = subjects.code === 0 ? outputLines(subjects).lines : [];
    blocks.push(stats(title(target.text), [{ label: "Remote commits lost", value: count(lost) }]));
    blocks.push(kv([{ key: "Remote branch", value: name }]));
    if (lines.length) blocks.push(list(lost > lines.length ? `Newest ${lines.length} of ${count(lost)}` : "Commits", lines));
    const verb = pair.local === null ? "would be deleted with the branch" : "aren't in your branch and would be overwritten";
    blocks.push(callout("warn", `These commits on ${name} ${verb}. Counted from your last fetch.${lease}`));
  }
  return blocks;
}

function measureDb(target) {
  return [
    kv([{ key: "Tool", value: target.tool }, { key: "Target", value: target.target ?? "Not named in the command" }], title(target.text)),
    callout("warn", `${target.action} Databases aren't queried here, so nothing was measured.`),
  ];
}

export async function measure(target, context) {
  switch (target.family) {
    case "rm":
      return measureRm(target, context);
    case "git-discard":
      return measureDiscard(target, context);
    case "git-clean":
      return measureClean(target, context);
    case "git-push":
      return measurePush(target, context);
    case "db":
      return measureDb(target);
    default:
      throw new Error("unknown family");
  }
}
