import { posix } from "node:path";

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&"];
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const MAX_NESTING = 2;

function blank() {
  return { t: "word", v: "", glob: false, quoted: false, dynamic: false, home: false };
}

function skipExpansion(text, start) {
  const next = text[start + 1];
  if (text[start] === "`") {
    const close = text.indexOf("`", start + 1);
    return close === -1 ? text.length : close + 1;
  }
  if (next === "(" || next === "{") {
    const open = next;
    const shut = open === "(" ? ")" : "}";
    let depth = 0;
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === open) depth += 1;
      else if (text[index] === shut) {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return text.length;
  }
  if (next === "'") {
    const close = text.indexOf("'", start + 2);
    return close === -1 ? text.length : close + 1;
  }
  let index = start + 1;
  if (index < text.length && /[@*#?$!0-9-]/.test(text[index])) return index + 1;
  while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index += 1;
  return index;
}

export function tokenize(source) {
  const text = typeof source === "string" ? source : "";
  const tokens = [];
  let word = null;
  const begin = () => {
    word ??= blank();
    return word;
  };
  const end = () => {
    if (word) tokens.push(word);
    word = null;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\r") {
      end();
      index += 1;
      continue;
    }
    if (char === "\n") {
      end();
      tokens.push({ t: "op", v: ";" });
      index += 1;
      continue;
    }
    if (char === "#" && !word) {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "'") {
      const current = begin();
      current.quoted = true;
      const close = text.indexOf("'", index + 1);
      const stop = close === -1 ? text.length : close;
      current.v += text.slice(index + 1, stop);
      index = stop + 1;
      continue;
    }
    if (char === '"') {
      const current = begin();
      current.quoted = true;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && index + 1 < text.length && '"\\$`\n'.includes(text[index + 1])) {
          if (text[index + 1] !== "\n") current.v += text[index + 1];
          index += 2;
          continue;
        }
        if (text[index] === "$" || text[index] === "`") current.dynamic = true;
        current.v += text[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "\\") {
      if (text[index + 1] === "\n") {
        index += 2;
        continue;
      }
      begin().v += text[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === "$" || char === "`") {
      const current = begin();
      current.dynamic = true;
      const stop = skipExpansion(text, index);
      current.v += text.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "<" || char === ">" || (char === "&" && text[index + 1] === ">")) {
      if (word && !word.quoted && /^\d+$/.test(word.v)) word = null;
      else end();
      let stop = index + 1;
      while (stop < text.length && stop - index < 3 && "<>&|".includes(text[stop])) stop += 1;
      tokens.push({ t: "redir", v: text.slice(index, stop) });
      index = stop;
      continue;
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (operator) {
      end();
      tokens.push({ t: "op", v: operator });
      index += operator.length;
      continue;
    }
    if (char === "(" || char === ")") {
      end();
      tokens.push({ t: "op", v: char });
      index += 1;
      continue;
    }
    const current = begin();
    if (current.v === "" && !current.quoted && char === "~") current.home = true;
    if (char === "*" || char === "?" || char === "[") current.glob = true;
    current.v += char;
    index += 1;
  }
  end();
  return tokens;
}

export function segments(tokens) {
  const out = [];
  let words = [];
  let skipNext = false;
  for (const token of tokens) {
    if (token.t === "redir") {
      skipNext = true;
      continue;
    }
    if (token.t === "op") {
      if (words.length) out.push({ words, after: token.v });
      words = [];
      skipNext = false;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    words.push(token);
  }
  if (words.length) out.push({ words, after: null });
  return out;
}

function skipOptions(words, start, withValue) {
  let index = start;
  while (index < words.length && words[index].v.startsWith("-") && words[index].v.length > 1) {
    const flag = words[index].v;
    index += 1;
    if (flag === "--") break;
    if (withValue.test(flag)) index += 1;
  }
  return index;
}

export function unwrap(words) {
  const env = {};
  let sudo = false;
  let fromStdin = false;
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    const value = word.v;
    if (!word.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      const name = value.slice(0, value.indexOf("="));
      env[name] = value.slice(name.length + 1);
      index += 1;
      continue;
    }
    if (value === "sudo" || value === "doas") {
      sudo = true;
      index = skipOptions(words, index + 1, /^-[ugCDhprtUT]$/);
      continue;
    }
    if (value === "env") {
      index = skipOptions(words, index + 1, /^-[uCS]$/);
      continue;
    }
    if (value === "command" || value === "builtin" || value === "exec" || value === "nohup" || value === "time") {
      index = skipOptions(words, index + 1, /^$/);
      continue;
    }
    if (value === "nice") {
      index = skipOptions(words, index + 1, /^-n$/);
      continue;
    }
    if (value === "timeout") {
      index = skipOptions(words, index + 1, /^-[sk]$/) + 1;
      continue;
    }
    if (value === "xargs") {
      fromStdin = true;
      index = skipOptions(words, index + 1, /^-[IJLnPsEd]$/);
      continue;
    }
    break;
  }
  const rest = words.slice(index);
  const shell = rest[0] ? posix.basename(rest[0].v) : "";
  if (rest.length >= 3 && SHELLS.has(shell) && /^-[a-z]*c$/.test(rest[1].v) && !rest[2].dynamic) {
    return { words: [], env, sudo, fromStdin, nested: rest[2].v };
  }
  return { words: rest, env, sudo, fromStdin, nested: null };
}

export function nextCwd(cwd, word) {
  if (!word || word.dynamic || word.home || word.glob || word.v === "-" || word.v === "") return null;
  if (posix.isAbsolute(word.v)) return posix.normalize(word.v);
  if (cwd === null) return null;
  return posix.normalize(posix.join(cwd, word.v));
}

function joinCwd(outer, inner) {
  if (inner === null) return null;
  if (posix.isAbsolute(inner)) return inner;
  if (outer === null) return null;
  return posix.normalize(posix.join(outer, inner));
}

export function display(word) {
  if (word.v !== "" && !/[\s"'$`\\|&;<>()]/.test(word.v)) return word.v;
  return `'${word.v.replace(/'/g, "'\\''")}'`;
}

export function commands(command, depth = 0) {
  const found = [];
  let cwd = ".";
  for (const segment of segments(tokenize(command))) {
    const unwrapped = unwrap(segment.words);
    if (unwrapped.nested !== null) {
      if (depth >= MAX_NESTING) continue;
      for (const inner of commands(unwrapped.nested, depth + 1)) {
        found.push({ ...inner, cwd: joinCwd(cwd, inner.cwd), env: { ...unwrapped.env, ...inner.env }, sudo: unwrapped.sudo || inner.sudo });
      }
      continue;
    }
    const words = unwrapped.words;
    if (!words.length) continue;
    const name = words[0].v;
    if (name === "cd" || name === "pushd") {
      cwd = nextCwd(cwd, words[1]);
      continue;
    }
    found.push({ words, env: unwrapped.env, sudo: unwrapped.sudo, fromStdin: unwrapped.fromStdin, cwd, text: words.map(display).join(" ") });
  }
  return found;
}

export function inside(worktree, path) {
  if (path === null || typeof worktree !== "string" || !posix.isAbsolute(worktree)) return null;
  const absolute = posix.isAbsolute(path) ? posix.normalize(path) : posix.normalize(posix.join(worktree, path));
  const relative = posix.relative(posix.normalize(worktree), absolute);
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative)) return null;
  return relative;
}
