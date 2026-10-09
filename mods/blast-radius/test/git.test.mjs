import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { radius } from "../lib/radius.mjs";

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "blast-radius-")));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "build/assets"), { recursive: true });
  writeFileSync(join(root, "build/a.js"), "a\n".repeat(100));
  writeFileSync(join(root, "build/assets/b.css"), "b\n");
  writeFileSync(join(root, "keep.txt"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  return { root, git };
}

function runner(root, seen) {
  return (argv, cwd, timeoutMs) =>
    new Promise((resolve) => {
      seen.push(argv);
      const [program, ...args] = argv;
      execFile(program, args, { cwd: cwd === undefined ? root : join(root, cwd), timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), timed_out: Boolean(error && error.killed) });
      });
    });
}

function text(blocks) {
  return JSON.stringify(blocks);
}

test("rm -rf counts the files and size it would delete without deleting them", async () => {
  const { root } = repo();
  try {
    const seen = [];
    const blocks = await radius({ destructive: true, cwd: root, command: "rm -rf build" }, runner(root, seen));
    assert.ok(Array.isArray(blocks) && blocks.length > 0);
    assert.match(text(blocks), /"label":"Files","value":"2"/);
    assert.match(text(blocks), /build\/a\.js/);
    assert.ok(!seen.some((argv) => argv[0] === "rm"), "the command itself never runs");
    execFileSync("test", ["-f", join(root, "build/a.js")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git reset --hard reports the uncommitted changes it would throw away", async () => {
  const { root } = repo();
  try {
    writeFileSync(join(root, "keep.txt"), "one\nchanged\nthree\n");
    const blocks = await radius({ destructive: true, cwd: root, command: "git reset --hard" }, runner(root, []));
    assert.match(text(blocks), /keep\.txt/);
    execFileSync("grep", ["-q", "changed", join(root, "keep.txt")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git clean -fd lists untracked files through a dry run", async () => {
  const { root } = repo();
  try {
    writeFileSync(join(root, "scratch.log"), "x\n");
    const seen = [];
    const blocks = await radius({ destructive: true, cwd: root, command: "git clean -fd" }, runner(root, seen));
    assert.match(text(blocks), /scratch\.log/);
    assert.ok(seen.every((argv) => !(argv[0] === "git" && argv[1] === "clean") || argv.includes("-n")));
    execFileSync("test", ["-f", join(root, "scratch.log")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("force push counts the remote commits that would be dropped", async () => {
  const { root, git } = repo();
  const remote = realpathSync(mkdtempSync(join(tmpdir(), "blast-remote-")));
  try {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-q", "-u", "origin", "main");
    writeFileSync(join(root, "keep.txt"), "remote only\n");
    git("commit", "-q", "-am", "Remote only change");
    git("push", "-q", "origin", "main");
    git("reset", "-q", "--hard", "HEAD~1");
    const blocks = await radius({ destructive: true, cwd: root, command: "git push --force origin main" }, runner(root, []));
    assert.match(text(blocks), /Remote only change/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("a command that is not destructive shows nothing", async () => {
  const { root } = repo();
  try {
    assert.equal(await radius({ destructive: false, cwd: root, command: "rm -rf build" }, runner(root, [])), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
