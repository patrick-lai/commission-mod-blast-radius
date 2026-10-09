import { posix } from "node:path";
import { nextCwd } from "./shell.mjs";

const PATHLIKE = /(^\.$)|\/|\.[A-Za-z0-9]+$/;
const BRANCH_FLAGS = new Set(["-b", "-B", "--orphan", "-c", "-C", "--detach", "--track", "-t"]);
const DB_TASKS = {
  "db:drop": "Drops the database.",
  "db:drop:all": "Drops every database in the config.",
  "db:reset": "Drops the database, recreates it and loads the schema.",
  "db:migrate:reset": "Drops the database and runs every migration again.",
  "db:schema:load": "Replaces the database schema; existing tables lose their data.",
  "db:purge": "Empties the database.",
  "db:truncate_all": "Deletes every row in every table.",
};
const ARTISAN = {
  "migrate:fresh": "Drops every table and runs every migration again.",
  "migrate:reset": "Rolls back every migration.",
  "migrate:refresh": "Rolls back and reruns every migration.",
  "db:wipe": "Drops every table, view and type.",
};
const VALUED = new Set(["--host", "--port", "--username", "--user", "--maintenance-db", "--command", "--execute", "--file"]);
const SQL = /\b(drop\s+(table|database|schema|view|index)\b|truncate\s+(table\s+)?\w|delete\s+from\b)/i;

function name(word) {
  return word ? posix.basename(word.v) : "";
}

function values(words) {
  return words.map((word) => word.v);
}

function rmTarget(step) {
  let recursive = false;
  let force = false;
  let ended = false;
  const operands = [];
  for (const word of step.words.slice(1)) {
    const value = word.v;
    if (!ended && value === "--") {
      ended = true;
      continue;
    }
    if (!ended && value.startsWith("--")) {
      if (value === "--recursive") recursive = true;
      if (value === "--force") force = true;
      continue;
    }
    if (!ended && value.startsWith("-") && value.length > 1) {
      if (/[rR]/.test(value)) recursive = true;
      if (value.includes("f")) force = true;
      continue;
    }
    operands.push(word);
  }
  return { family: "rm", recursive, force, operands, cwd: step.cwd, fromStdin: step.fromStdin === true, text: step.text };
}

function gitSplit(args) {
  const marker = args.findIndex((word) => word.v === "--");
  const before = marker === -1 ? args : args.slice(0, marker);
  const after = marker === -1 ? [] : args.slice(marker + 1);
  return { before, after, marked: marker !== -1 };
}

function discard(step, cwd, fields) {
  return { family: "git-discard", cwd, text: step.text, source: null, paths: [], full: false, unstageOnly: false, ...fields };
}

function reset(step, cwd, args) {
  if (!args.some((word) => word.v === "--hard")) return null;
  const { before } = gitSplit(args);
  const ref = before.find((word) => !word.v.startsWith("-"));
  return discard(step, cwd, { mode: "reset", source: ref ? ref.v : null, full: true });
}

function checkout(step, cwd, args) {
  if (args.some((word) => BRANCH_FLAGS.has(word.v) || word.v.startsWith("--orphan") || word.v.startsWith("--track"))) return null;
  const force = args.some((word) => word.v === "-f" || word.v === "--force");
  const { before, after, marked } = gitSplit(args);
  const operands = before.filter((word) => !word.v.startsWith("-"));
  if (marked) {
    const source = operands[0] ? operands[0].v : null;
    return discard(step, cwd, { mode: "checkout", source, paths: values(after), full: source !== null || force });
  }
  if (operands.length === 0) return force ? discard(step, cwd, { mode: "checkout", full: true }) : null;
  if (operands.length === 1) {
    const only = operands[0];
    if (PATHLIKE.test(only.v) || only.glob) return discard(step, cwd, { mode: "checkout", paths: [only.v], full: force });
    return force ? discard(step, cwd, { mode: "checkout", full: true }) : null;
  }
  return discard(step, cwd, { mode: "checkout", source: operands[0].v, paths: values(operands.slice(1)), full: true });
}

function restore(step, cwd, args) {
  let staged = false;
  let worktree = false;
  let source = null;
  const paths = [];
  let ended = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].v;
    if (!ended && value === "--") {
      ended = true;
      continue;
    }
    if (!ended && value.startsWith("-")) {
      if (value === "--staged" || value === "-S") staged = true;
      else if (value === "--worktree" || value === "-W") worktree = true;
      else if (value === "-SW" || value === "-WS") {
        staged = true;
        worktree = true;
      } else if (value === "--source" || value === "-s") {
        source = args[index + 1] ? args[index + 1].v : null;
        index += 1;
      } else if (value.startsWith("--source=")) source = value.slice("--source=".length);
      else if (value.startsWith("-s") && value.length > 2) source = value.slice(2);
      continue;
    }
    paths.push(value);
  }
  if (paths.length === 0) return null;
  const touchesWorktree = worktree || !staged;
  if (!touchesWorktree) return discard(step, cwd, { mode: "restore", paths, unstageOnly: true });
  return discard(step, cwd, { mode: "restore", source, paths, full: staged || source !== null });
}

function clean(step, cwd, args) {
  const flags = [];
  const paths = [];
  let ended = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].v;
    if (!ended && value === "--") {
      ended = true;
      continue;
    }
    if (!ended && (value === "-e" || value === "--exclude")) {
      if (args[index + 1]) flags.push("-e", args[index + 1].v);
      index += 1;
      continue;
    }
    if (!ended && value.startsWith("--exclude=")) {
      flags.push(value);
      continue;
    }
    if (!ended && value.startsWith("--")) {
      continue;
    }
    if (!ended && value.startsWith("-") && value.length > 1) {
      for (const letter of value.slice(1)) {
        if ((letter === "d" || letter === "x" || letter === "X") && !flags.includes(`-${letter}`)) flags.push(`-${letter}`);
      }
      continue;
    }
    paths.push(value);
  }
  return { family: "git-clean", cwd, text: step.text, flags, paths };
}

function push(step, cwd, args) {
  let force = false;
  let lease = false;
  let everything = false;
  let deleting = false;
  const operands = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index].v;
    if (value === "-f" || value === "--force") force = true;
    else if (value.startsWith("--force-with-lease") || value === "--force-if-includes") {
      force = true;
      lease = true;
    } else if (value === "--all" || value === "--mirror" || value === "--tags") everything = true;
    else if (value === "-d" || value === "--delete") deleting = true;
    else if (value === "-o" || value === "--push-option" || value === "--repo" || value === "--receive-pack") index += 1;
    else if (value.startsWith("-")) {
      if (/^-[a-zA-Z]+$/.test(value) && value.includes("f")) force = true;
    } else operands.push(value);
  }
  const remote = operands[0] ?? null;
  const refspecs = operands.slice(1);
  if (refspecs.some((spec) => spec.startsWith("+"))) force = true;
  if (refspecs.some((spec) => spec.startsWith(":"))) deleting = true;
  if (!force && !deleting) return null;
  const refs = refspecs.map((spec) => {
    const plain = spec.replace(/^\+/, "");
    const colon = plain.indexOf(":");
    const local = colon === -1 ? plain : plain.slice(0, colon);
    const remoteBranch = (colon === -1 ? plain : plain.slice(colon + 1)).replace(/^refs\/heads\//, "");
    return { local: deleting && colon <= 0 ? "" : local, remote: remoteBranch };
  });
  return { family: "git-push", cwd, text: step.text, remote, refs, lease, everything, deleting };
}

function gitTarget(step) {
  const words = step.words;
  let cwd = step.cwd;
  let index = 1;
  while (index < words.length) {
    const value = words[index].v;
    if (value === "-C") {
      cwd = nextCwd(cwd, words[index + 1]);
      index += 2;
      continue;
    }
    if (value === "-c" || value === "--git-dir" || value === "--work-tree" || value === "--namespace") {
      index += 2;
      continue;
    }
    if (value.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const sub = words[index] ? words[index].v : "";
  const args = words.slice(index + 1);
  if (sub === "reset") return reset(step, cwd, args);
  if (sub === "checkout") return checkout(step, cwd, args);
  if (sub === "restore") return restore(step, cwd, args);
  if (sub === "clean") return clean(step, cwd, args);
  if (sub === "push") return push(step, cwd, args);
  return null;
}

function stripRunner(list) {
  let words = list;
  const first = () => (words[0] ? words[0].v : "");
  if (["npx", "bunx", "pnpx"].includes(name(words[0]))) {
    words = words.slice(1);
    while (first().startsWith("-")) words = words.slice(first() === "-p" || first() === "--package" ? 2 : 1);
  } else if (["pnpm", "yarn", "bun"].includes(name(words[0]))) {
    words = words.slice(1);
    if (["exec", "dlx", "x", "run"].includes(first())) words = words.slice(1);
  } else if (name(words[0]) === "npm" && ["exec", "x"].includes(words[1] ? words[1].v : "")) {
    words = words.slice(2);
    if (first() === "--") words = words.slice(1);
  } else if (name(words[0]) === "bundle" && words[1] && words[1].v === "exec") {
    words = words.slice(2);
  } else if (/^python[0-9.]*$/.test(name(words[0])) || name(words[0]) === "php") {
    words = words.slice(1);
  }
  return words;
}

export function redactUrl(value) {
  try {
    const url = new URL(value);
    const database = url.pathname.replace(/^\//, "");
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    if (database && host) return `${database} on ${host}`;
    return database || host || null;
  } catch {
    return null;
  }
}

function flagValue(words, short, long) {
  for (let index = 0; index < words.length; index += 1) {
    const value = words[index].v;
    if (short.includes(value) || long.includes(value)) return words[index + 1] ? words[index + 1].v : null;
    for (const flag of long) if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1);
    for (const flag of short) if (value.startsWith(flag) && value.length > flag.length && flag.length === 2) return value.slice(2);
  }
  return null;
}

function cliTarget(words, { databaseShort, databaseLong, hostShort, hostLong, positional }) {
  const url = words.map((word) => word.v).find((value) => /^[a-z][a-z0-9+]*:\/\//i.test(value));
  if (url) return redactUrl(url);
  const host = flagValue(words, hostShort, hostLong);
  let database = flagValue(words, databaseShort, databaseLong);
  if (database && /:\/\//.test(database)) return redactUrl(database);
  if (!database && positional) {
    const skip = new Set();
    words.forEach((word, index) => {
      if (/^-[a-zA-Z]$/.test(word.v) || VALUED.has(word.v)) skip.add(index + 1);
    });
    const operand = words.find((word, index) => index > 0 && !skip.has(index) && !word.v.startsWith("-"));
    database = operand ? operand.v : null;
  }
  if (database && host) return `${database} on ${host}`;
  return database || (host ? `a database on ${host}` : null);
}

function envTarget(env) {
  if (typeof env.DATABASE_URL === "string") return redactUrl(env.DATABASE_URL) ?? "DATABASE_URL set in the command";
  if (typeof env.RAILS_ENV === "string") return `the ${env.RAILS_ENV} database`;
  if (typeof env.RACK_ENV === "string") return `the ${env.RACK_ENV} database`;
  return null;
}

function db(tool, action, target) {
  return { family: "db", tool, action, target };
}

function dbTarget(step) {
  const words = stripRunner(step.words);
  const tool = name(words[0]);
  const args = values(words.slice(1));
  const env = { ...step.env };
  for (const value of args) {
    const match = /^([A-Z_]+)=(.*)$/.exec(value);
    if (match) env[match[1]] = match[2];
  }
  const fromEnv = envTarget(env);
  if (tool === "prisma") {
    if (args[0] === "migrate" && args[1] === "reset") return db("prisma", "Drops the database, recreates it and runs every migration again.", fromEnv);
    if (args[0] === "db" && args[1] === "push" && args.includes("--force-reset")) return db("prisma", "Drops the database and recreates it from the schema.", fromEnv);
    if (args[0] === "db" && args[1] === "push" && args.includes("--accept-data-loss")) return db("prisma", "Applies the schema even where columns or tables lose data.", fromEnv);
    return null;
  }
  if (tool === "rails" || tool === "rake") {
    const task = args.find((value) => Object.hasOwn(DB_TASKS, value));
    return task ? db(tool, DB_TASKS[task], fromEnv) : null;
  }
  if (tool === "manage.py") {
    if (args[0] === "flush") return db("manage.py", "Deletes every row in every table.", fromEnv);
    if (args[0] === "reset_db") return db("manage.py", "Drops the database and creates it empty.", fromEnv);
    return null;
  }
  if (tool === "artisan") {
    const task = args.find((value) => Object.hasOwn(ARTISAN, value));
    return task ? db("artisan", ARTISAN[task], fromEnv) : null;
  }
  if (tool === "supabase" && args[0] === "db" && args[1] === "reset") return db("supabase", "Recreates the local database and runs every migration again.", fromEnv);
  if (tool === "dropdb") return db("dropdb", "Drops the database.", cliTarget(words, { databaseShort: [], databaseLong: [], hostShort: ["-h"], hostLong: ["--host"], positional: true }) ?? fromEnv);
  if (tool === "psql") {
    const sql = flagValue(words, ["-c"], ["--command"]);
    if (!sql || !SQL.test(sql)) return null;
    return db("psql", `Runs SQL that deletes data: ${sql.slice(0, 120)}`, cliTarget(words, { databaseShort: ["-d"], databaseLong: ["--dbname"], hostShort: ["-h"], hostLong: ["--host"], positional: true }) ?? fromEnv);
  }
  if (tool === "mysql" || tool === "mariadb") {
    const sql = flagValue(words, ["-e"], ["--execute"]);
    if (!sql || !SQL.test(sql)) return null;
    return db(tool, `Runs SQL that deletes data: ${sql.slice(0, 120)}`, cliTarget(words, { databaseShort: ["-D"], databaseLong: ["--database"], hostShort: ["-h"], hostLong: ["--host"], positional: true }) ?? fromEnv);
  }
  if (tool === "sqlite3") {
    const sql = args.find((value) => SQL.test(value));
    if (!sql) return null;
    const file = args.find((value) => !value.startsWith("-") && value !== sql);
    return db("sqlite3", `Runs SQL that deletes data: ${sql.slice(0, 120)}`, file ?? null);
  }
  if (tool === "redis-cli") {
    const command = args.find((value) => /^flush(all|db)$/i.test(value));
    return command ? db("redis-cli", command.toLowerCase() === "flushall" ? "Deletes every key in every Redis database." : "Deletes every key in the selected Redis database.", flagValue(words, ["-h"], ["--host"]) ?? fromEnv) : null;
  }
  if (tool === "mongosh" || tool === "mongo") {
    const script = flagValue(words, [], ["--eval"]);
    if (!script || !/dropDatabase|\.drop\(\)|deleteMany\(\s*\{\s*\}\s*\)/.test(script)) return null;
    const url = args.find((value) => /^mongodb(\+srv)?:\/\//.test(value));
    return db(tool, "Runs a script that drops or empties data.", url ? redactUrl(url) : fromEnv);
  }
  return null;
}

export function classify(step) {
  if (!step || !Array.isArray(step.words) || step.words.length === 0) return null;
  const tool = name(step.words[0]);
  const target = tool === "rm" ? rmTarget(step) : tool === "git" ? gitTarget(step) : dbTarget(step);
  return target ? { text: step.text ?? step.words.map((word) => word.v).join(" "), ...target } : null;
}
