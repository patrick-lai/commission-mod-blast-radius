export const MAX_OPERANDS = 50;

export function git(...args) {
  return ["git", "--no-pager", "--no-optional-locks", ...args];
}

export function safePath(path) {
  return path.startsWith("-") ? `./${path}` : path;
}

export function globProbe(dir, pattern) {
  return ["find", safePath(dir), "-mindepth", "1", "-maxdepth", "1", "-name", pattern];
}

export function existProbes(paths) {
  const list = paths.slice(0, MAX_OPERANDS).map(safePath);
  return {
    dirs: ["find", ...list, "-maxdepth", "0", "-type", "d"],
    other: ["find", ...list, "-maxdepth", "0", "!", "-type", "d"],
  };
}

export function sizeProbes(targets) {
  const list = targets.slice(0, MAX_OPERANDS).map(safePath);
  return {
    files: ["find", ...list, "!", "-type", "d"],
    size: ["du", "-sk", ...list],
  };
}

export function discardProbes(target) {
  const paths = target.paths.map(safePath);
  const probes = {
    status: git("status", "--porcelain", "--untracked-files=no", "--", ...paths),
    diff: target.full ? git("diff", "--shortstat", target.source ?? "HEAD", "--", ...paths) : git("diff", "--shortstat", "--", ...paths),
  };
  if (target.mode === "reset" && target.source !== null && target.source !== "HEAD") {
    probes.leaving = git("rev-list", "--count", `${target.source}..HEAD`);
  }
  return probes;
}

export function cleanProbe(target) {
  return git("clean", "-n", ...target.flags, "--", ...target.paths.map(safePath));
}

export function upstreamProbe() {
  return git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
}

export function branchProbe() {
  return git("rev-parse", "--abbrev-ref", "HEAD");
}

export function pushProbes(local, remoteRef) {
  const range = local === null ? [remoteRef, "--not", "--branches"] : [`${local}..${remoteRef}`];
  return {
    count: git("rev-list", "--count", ...range),
    subjects: git("log", "--format=%s", "-n", "5", ...range),
  };
}

export function remoteRefFor(remote, branch) {
  return `refs/remotes/${remote}/${branch}`;
}

export function validRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.startsWith("-") && !/[\s~^:?*[\\]|\.\.|@\{/.test(value);
}

export function validRev(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.startsWith("-") && !/\s/.test(value) && !value.includes("..");
}
