import { test } from "node:test";
import assert from "node:assert/strict";
import { commands, inside, tokenize } from "../lib/shell.mjs";
import { classify, redactUrl } from "../lib/classify.mjs";
import { targetsOf } from "../lib/radius.mjs";

const words = (command) => commands(command).map((step) => step.words.map((word) => word.v));

test("tokenizer handles quoting, escapes, operators and redirections", () => {
  const table = [
    ["rm -rf build", [["rm", "-rf", "build"]]],
    ["rm -rf 'my dir' \"other dir\"", [["rm", "-rf", "my dir", "other dir"]]],
    ["rm my\\ file", [["rm", "my file"]]],
    ["echo a && rm b || rm c; rm d | cat & rm e", [["echo", "a"], ["rm", "b"], ["rm", "c"], ["rm", "d"], ["cat"], ["rm", "e"]]],
    ["rm -rf build > out.log 2>&1", [["rm", "-rf", "build"]]],
    ["rm x # rm y", [["rm", "x"]]],
    ["rm a\nrm b", [["rm", "a"], ["rm", "b"]]],
    ["(cd sub && rm z)", [["rm", "z"]]],
  ];
  for (const [command, expected] of table) assert.deepEqual(words(command), expected, command);
});

test("tokenizer flags globs, variables and home paths", () => {
  const [glob, quoted, variable, sub, home] = tokenize("*.log '*.log' $DIR $(pwd)/x ~/tmp").filter((token) => token.t === "word");
  assert.equal(glob.glob, true);
  assert.equal(quoted.glob, false);
  assert.equal(variable.dynamic, true);
  assert.equal(sub.dynamic, true);
  assert.equal(home.home, true);
});

test("wrappers, env prefixes and nested shells unwrap to the real command", () => {
  const table = [
    ["sudo rm -rf /tmp/x", ["rm", "-rf", "/tmp/x"]],
    ["sudo -u root -E rm x", ["rm", "x"]],
    ["FOO=1 BAR=2 rm x", ["rm", "x"]],
    ["env -i FOO=1 rm x", ["rm", "x"]],
    ["nice -n 5 timeout 30 rm x", ["rm", "x"]],
    ["command rm x", ["rm", "x"]],
    ["bash -c 'rm -rf build'", ["rm", "-rf", "build"]],
    ["sh -lc \"git clean -fd\"", ["git", "clean", "-fd"]],
  ];
  for (const [command, expected] of table) assert.deepEqual(words(command)[0], expected, command);
  const [step] = commands("sudo DATABASE_URL=x rm y");
  assert.equal(step.sudo, true);
  assert.deepEqual(step.env, { DATABASE_URL: "x" });
});

test("cd changes the working folder of later commands", () => {
  assert.equal(commands("cd web && rm -rf dist")[0].cwd, "web");
  assert.equal(commands("cd web/app && cd .. && rm x")[0].cwd, "web");
  assert.equal(commands("cd /abs/path && rm x")[0].cwd, "/abs/path");
  assert.equal(commands("cd $DIR && rm x")[0].cwd, null);
  assert.equal(commands("cd && rm x")[0].cwd, null);
  assert.equal(commands("cd web && bash -c 'cd app && rm x'")[0].cwd, "web/app");
});

test("inside keeps paths within the worktree", () => {
  assert.equal(inside("/w", "."), ".");
  assert.equal(inside("/w", "a/b"), "a/b");
  assert.equal(inside("/w", "/w/a"), "a");
  assert.equal(inside("/w", ".."), null);
  assert.equal(inside("/w", "/etc"), null);
  assert.equal(inside("/w", null), null);
});

test("classifier recognises each family", () => {
  const family = (command) => targetsOf(command).map((target) => target.family);
  const table = [
    ["rm -rf node_modules", ["rm"]],
    ["rm -r -f a b", ["rm"]],
    ["git reset --hard", ["git-discard"]],
    ["git reset --soft HEAD~1", []],
    ["git checkout .", ["git-discard"]],
    ["git checkout -- a.ts b.ts", ["git-discard"]],
    ["git checkout main", []],
    ["git checkout -b feature", []],
    ["git checkout -f", ["git-discard"]],
    ["git restore .", ["git-discard"]],
    ["git restore --staged .", ["git-discard"]],
    ["git clean -fdx", ["git-clean"]],
    ["git push --force", ["git-push"]],
    ["git push -f origin main", ["git-push"]],
    ["git push origin +main", ["git-push"]],
    ["git push origin main", []],
    ["git push origin --delete old", ["git-push"]],
    ["npx prisma migrate reset", ["db"]],
    ["pnpm prisma db push --force-reset", ["db"]],
    ["bundle exec rails db:reset", ["db"]],
    ["rake db:drop", ["db"]],
    ["dropdb app_dev", ["db"]],
    ["psql app -c 'TRUNCATE users'", ["db"]],
    ["psql app -c 'select 1'", []],
    ["python manage.py flush --noinput", ["db"]],
    ["php artisan migrate:fresh", ["db"]],
    ["redis-cli FLUSHALL", ["db"]],
    ["ls -la", []],
    ["cd a && rm x && git clean -f && git reset --hard && rm y", ["rm", "git-clean", "git-discard"]],
  ];
  for (const [command, expected] of table) assert.deepEqual(family(command), expected, command);
});

test("rm flags and operands", () => {
  const [target] = targetsOf("rm -rf -- -weird 'a b' *.tmp");
  assert.equal(target.recursive, true);
  assert.equal(target.force, true);
  assert.deepEqual(target.operands.map((word) => word.v), ["-weird", "a b", "*.tmp"]);
  assert.deepEqual(target.operands.map((word) => word.glob), [false, false, true]);
  const [plain] = targetsOf("rm a.txt");
  assert.equal(plain.recursive, false);
});

test("git discard modes record source, paths and what is lost", () => {
  const pick = (command) => {
    const [target] = targetsOf(command);
    return { mode: target.mode, source: target.source, paths: target.paths, full: target.full, unstageOnly: target.unstageOnly };
  };
  assert.deepEqual(pick("git reset --hard origin/main"), { mode: "reset", source: "origin/main", paths: [], full: true, unstageOnly: false });
  assert.deepEqual(pick("git checkout -- src"), { mode: "checkout", source: null, paths: ["src"], full: false, unstageOnly: false });
  assert.deepEqual(pick("git checkout HEAD -- src"), { mode: "checkout", source: "HEAD", paths: ["src"], full: true, unstageOnly: false });
  assert.deepEqual(pick("git restore --source=HEAD~1 a.ts"), { mode: "restore", source: "HEAD~1", paths: ["a.ts"], full: true, unstageOnly: false });
  assert.deepEqual(pick("git restore -SW a.ts"), { mode: "restore", source: null, paths: ["a.ts"], full: true, unstageOnly: false });
  assert.deepEqual(pick("git restore --staged a.ts"), { mode: "restore", source: null, paths: ["a.ts"], full: false, unstageOnly: true });
  assert.equal(targetsOf("git -C sub reset --hard")[0].cwd, "sub");
});

test("git clean keeps only the selection flags", () => {
  const [target] = targetsOf("git clean -ffdx -e .env --exclude=keep -- build");
  assert.deepEqual(target.flags, ["-d", "-x", "-e", ".env", "--exclude=keep"]);
  assert.deepEqual(target.paths, ["build"]);
});

test("git push resolves remotes and refspecs", () => {
  const pick = (command) => {
    const [target] = targetsOf(command);
    return { remote: target.remote, refs: target.refs, lease: target.lease, everything: target.everything };
  };
  assert.deepEqual(pick("git push -f"), { remote: null, refs: [], lease: false, everything: false });
  assert.deepEqual(pick("git push --force-with-lease origin feature"), { remote: "origin", refs: [{ local: "feature", remote: "feature" }], lease: true, everything: false });
  assert.deepEqual(pick("git push origin +local:refs/heads/remote"), { remote: "origin", refs: [{ local: "local", remote: "remote" }], lease: false, everything: false });
  assert.deepEqual(pick("git push origin :gone"), { remote: "origin", refs: [{ local: "", remote: "gone" }], lease: false, everything: false });
  assert.deepEqual(pick("git push --force --all"), { remote: null, refs: [], lease: false, everything: true });
});

test("database tools name their target without leaking credentials", () => {
  const target = (command) => targetsOf(command)[0].target;
  assert.equal(target("DATABASE_URL=postgres://me:secret@db.internal:5432/app npx prisma migrate reset"), "app on db.internal:5432");
  assert.equal(target("npx prisma migrate reset"), null);
  assert.equal(target("RAILS_ENV=production bin/rails db:drop"), "the production database");
  assert.equal(target("rake db:drop RAILS_ENV=staging"), "the staging database");
  assert.equal(target("dropdb -h db.internal --if-exists app_dev"), "app_dev on db.internal");
  assert.equal(target("psql -h localhost -d shop -c 'DROP TABLE orders'"), "shop on localhost");
  assert.equal(target("psql postgres://u:pw@h/shop -c 'drop table x'"), "shop on h");
  assert.equal(target("mysql -h db -e 'DROP DATABASE app'"), "a database on db");
  assert.equal(redactUrl("not a url"), null);
  for (const command of ["DATABASE_URL=postgres://me:secret@db/app npx prisma migrate reset"]) {
    assert.ok(!JSON.stringify(targetsOf(command)[0].target).includes("secret"));
  }
});

test("classify ignores empty and odd input", () => {
  assert.equal(classify(null), null);
  assert.equal(classify({ words: [] }), null);
  assert.deepEqual(targetsOf(""), []);
  assert.deepEqual(targetsOf(42), []);
  assert.deepEqual(targetsOf("'unterminated"), []);
  assert.deepEqual(targetsOf("rm \"unterminated").map((target) => target.family), ["rm"]);
});
