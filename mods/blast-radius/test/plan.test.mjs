import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanProbe, discardProbes, existProbes, git, globProbe, pushProbes, sizeProbes, validRef, validRev } from "../lib/plan.mjs";
import { radius, targetsOf } from "../lib/radius.mjs";

const G = ["git", "--no-pager", "--no-optional-locks"];

function recorder(answers = {}) {
  const calls = [];
  const run = async (argv, cwd, timeoutMs) => {
    calls.push({ argv, cwd, timeoutMs });
    const key = argv.join(" ");
    const found = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return found ? found[1] : { code: 0, stdout: "", stderr: "", timed_out: false };
  };
  return { run, calls };
}

const data = (command) => ({ request_id: "r1", command, cwd: "/work/repo", destructive: true });

test("pure probe builders", () => {
  assert.deepEqual(git("status"), [...G, "status"]);
  assert.deepEqual(globProbe("dist", "*.map"), ["find", "dist", "-mindepth", "1", "-maxdepth", "1", "-name", "*.map"]);
  assert.deepEqual(existProbes(["a", "-b"]), {
    dirs: ["find", "a", "./-b", "-maxdepth", "0", "-type", "d"],
    other: ["find", "a", "./-b", "-maxdepth", "0", "!", "-type", "d"],
  });
  assert.deepEqual(sizeProbes(["a"]), { files: ["find", "a", "!", "-type", "d"], size: ["du", "-sk", "a"] });
  assert.deepEqual(pushProbes("HEAD", "refs/remotes/origin/main"), {
    count: [...G, "rev-list", "--count", "HEAD..refs/remotes/origin/main"],
    subjects: [...G, "log", "--format=%s", "-n", "5", "HEAD..refs/remotes/origin/main"],
  });
  assert.deepEqual(pushProbes(null, "refs/remotes/origin/old").count, [...G, "rev-list", "--count", "refs/remotes/origin/old", "--not", "--branches"]);
});

test("discard probes depend on what the command throws away", () => {
  const [reset] = targetsOf("git reset --hard HEAD~2");
  assert.deepEqual(discardProbes(reset), {
    status: [...G, "status", "--porcelain", "--untracked-files=no", "--"],
    diff: [...G, "diff", "--shortstat", "HEAD~2", "--"],
    leaving: [...G, "rev-list", "--count", "HEAD~2..HEAD"],
  });
  const [checkout] = targetsOf("git checkout -- src a.ts");
  assert.deepEqual(discardProbes(checkout), {
    status: [...G, "status", "--porcelain", "--untracked-files=no", "--", "src", "a.ts"],
    diff: [...G, "diff", "--shortstat", "--", "src", "a.ts"],
  });
  const [hard] = targetsOf("git reset --hard");
  assert.deepEqual(discardProbes(hard).diff, [...G, "diff", "--shortstat", "HEAD", "--"]);
  assert.equal(discardProbes(hard).leaving, undefined);
});

test("clean probe is always a dry run with the same selection", () => {
  const [target] = targetsOf("git clean -fdx -e .env");
  assert.deepEqual(cleanProbe(target), [...G, "clean", "-n", "-d", "-x", "-e", ".env", "--"]);
  assert.ok(!cleanProbe(target).includes("-f"));
});

test("ref validation rejects option-like and range input", () => {
  assert.equal(validRef("main"), true);
  assert.equal(validRef("feature/x"), true);
  assert.equal(validRef("-delete"), false);
  assert.equal(validRef("a..b"), false);
  assert.equal(validRef("a b"), false);
  assert.equal(validRev("HEAD~3"), true);
  assert.equal(validRev("--all"), false);
});

test("rm runs existence, then size probes, from the worktree root", async () => {
  const { run, calls } = recorder({
    "find web/dist web/a.txt -maxdepth 0 -type d": { code: 0, stdout: "web/dist\n" },
    "find web/dist web/a.txt -maxdepth 0 ! -type d": { code: 0, stdout: "web/a.txt\n" },
    "find web/a.txt web/dist ! -type d": { code: 0, stdout: "web/a.txt\nweb/dist/x.js\n" },
    "du -sk": { code: 0, stdout: "4\tweb/a.txt\n8\tweb/dist\n" },
  });
  const blocks = await radius(data("cd web && rm -rf dist a.txt"), run);
  assert.deepEqual(calls.map((call) => call.argv.join(" ")), [
    "find web/dist web/a.txt -maxdepth 0 -type d",
    "find web/dist web/a.txt -maxdepth 0 ! -type d",
    "find web/a.txt web/dist ! -type d",
    "du -sk web/a.txt web/dist",
  ]);
  assert.ok(calls.every((call) => call.cwd === undefined && call.timeoutMs <= 1500));
  assert.deepEqual(blocks[0].items, [{ label: "Files", value: "2" }, { label: "Size", value: "12 KB" }]);
});

test("globs are listed with find in their folder, never expanded by a shell", async () => {
  const { run, calls } = recorder({ "find dist -mindepth 1": { code: 0, stdout: "dist/a.map\ndist/.hidden.map\n" } });
  await radius(data("rm dist/*.map"), run);
  assert.deepEqual(calls[0].argv, ["find", "dist", "-mindepth", "1", "-maxdepth", "1", "-name", "*.map"]);
  assert.deepEqual(calls[1].argv, ["find", "dist/a.map", "-maxdepth", "0", "-type", "d"]);
});

test("paths outside the worktree or behind variables are never probed", async () => {
  const { run, calls } = recorder();
  const blocks = await radius(data("rm -rf / ~/x $HOME/y ../z"), run);
  assert.equal(calls.length, 0);
  assert.equal(blocks[0].type, "callout");
  assert.match(blocks[0].text, /^Not measured: /);
});

test("git discard probes run in the command's folder", async () => {
  const { run, calls } = recorder();
  await radius(data("cd pkg && git checkout ."), run);
  assert.deepEqual(calls.map((call) => [call.argv.slice(3).join(" "), call.cwd]), [
    ["status --porcelain --untracked-files=no -- .", "pkg"],
    ["diff --shortstat -- .", "pkg"],
  ]);
});

test("push without arguments resolves the upstream first", async () => {
  const { run, calls } = recorder({ [`${G.join(" ")} rev-parse`]: { code: 0, stdout: "origin/main\n" } });
  await radius(data("git push --force"), run);
  assert.deepEqual(calls.map((call) => call.argv.slice(3).join(" ")), [
    "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
    "rev-list --count HEAD..refs/remotes/origin/main",
    "log --format=%s -n 5 HEAD..refs/remotes/origin/main",
  ]);
});

test("push to a named remote uses the current branch", async () => {
  const { run, calls } = recorder({ [`${G.join(" ")} rev-parse`]: { code: 0, stdout: "feature\n" } });
  await radius(data("git push -f origin"), run);
  assert.deepEqual(calls.map((call) => call.argv.slice(3).join(" ")), [
    "rev-parse --abbrev-ref HEAD",
    "rev-list --count HEAD..refs/remotes/origin/feature",
    "log --format=%s -n 5 HEAD..refs/remotes/origin/feature",
  ]);
});

test("database commands are never executed or probed", async () => {
  const { run, calls } = recorder();
  const blocks = await radius(data("DATABASE_URL=postgres://u:p@db/app npx prisma migrate reset"), run);
  assert.equal(calls.length, 0);
  assert.deepEqual(blocks[0].items, [{ key: "Tool", value: "prisma" }, { key: "Target", value: "app on db" }]);
  assert.equal(blocks[1].tone, "warn");
});

test("the destructive command itself is never among the probes", async () => {
  for (const command of ["rm -rf build", "git reset --hard", "git clean -fdx", "git push -f origin main", "git checkout ."]) {
    const { run, calls } = recorder({ [`${G.join(" ")} rev-parse`]: { code: 0, stdout: "origin/main\n" } });
    await radius(data(command), run);
    for (const call of calls) {
      assert.notEqual(call.argv[0], "rm", command);
      const sub = call.argv[0] === "git" ? call.argv[3] : null;
      assert.ok(sub === null || ["status", "diff", "clean", "rev-parse", "rev-list", "log"].includes(sub), `${command}: ${call.argv.join(" ")}`);
      if (sub === "clean") assert.equal(call.argv[4], "-n");
    }
  }
});

test("probes stay inside the time budget", async () => {
  let clock = 0;
  const { run, calls } = recorder({ "find a -maxdepth 0 -type d": { code: 0, stdout: "a\n" } });
  const slow = async (argv, cwd, timeoutMs) => {
    clock += 1000;
    return run(argv, cwd, timeoutMs);
  };
  const blocks = await radius(data("rm -rf a"), slow, { now: () => clock, budgetMs: 2200 });
  assert.equal(calls.length, 2);
  assert.equal(blocks[0].text, "Couldn't measure this one.");
});

test("nothing to show for non-destructive or unrecognised commands", async () => {
  const { run } = recorder();
  assert.equal(await radius({ ...data("rm -rf x"), destructive: false }, run), null);
  assert.equal(await radius(data("ls -la"), run), null);
  assert.equal(await radius({ request_id: "r", destructive: true }, run), null);
});
