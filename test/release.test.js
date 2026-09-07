const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "../scripts/release.sh");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GITHUB_OUTPUT: "",
    GITHUB_STEP_SUMMARY: "",
  };
  function git(...args) {
    const result = spawnSync("git", args, { cwd: work, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "--bare", remote);
  git("init", "--initial-branch=main");
  git("remote", "add", "origin", remote);
  function commit() {
    git("commit", "--allow-empty", "-m", "Test commit");
    return git("rev-parse", "HEAD");
  }
  const initial = commit();
  git("push", "origin", "main");
  function run(mode, tag = "v1.0.0", branch = "main", sha = initial) {
    return spawnSync("bash", [script, mode], {
      cwd: work,
      env: { ...env, RELEASE_TAG: tag, RELEASE_BRANCH: branch, RELEASE_SHA: sha },
      encoding: "utf8",
    });
  }
  function success(...args) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  function rejected(args, message) {
    const result = run(...args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, message);
  }
  function ref(name) {
    return git("--git-dir", remote, "rev-parse", `${name}^{commit}`);
  }
  function absent(name) {
    assert.equal(git("ls-remote", "origin", name), "");
  }
  return { remote, work, git, commit, initial, run, success, rejected, ref, absent };
}

test("first release publishes an annotated tag and matching major branch", (t) => {
  const f = fixture(t);
  assert.match(f.success("resolve"), new RegExp(`sha=${f.initial}\\nmajor=v1`));
  f.success("publish");
  assert.equal(f.ref("refs/tags/v1.0.0"), f.initial);
  assert.equal(f.ref("refs/heads/v1"), f.initial);
  assert.equal(f.git("--git-dir", f.remote, "cat-file", "-t", "refs/tags/v1.0.0"), "tag");
});

test("subsequent release fast-forwards; a new major leaves the old major alone", (t) => {
  const f = fixture(t);
  f.success("publish");
  const next = f.commit();
  f.git("push", "origin", "main");
  f.success("publish", "v1.1.0", "main", next);
  assert.equal(f.ref("refs/heads/v1"), next);
  assert.equal(f.ref("refs/tags/v1.1.0"), next);
  f.success("publish", "v2.0.0", "main", next);
  assert.equal(f.ref("refs/heads/v2"), next);
  assert.equal(f.ref("refs/heads/v1"), next);
  assert.equal(f.ref("refs/tags/v1.0.0"), f.initial);
});

test("source advancement does not change the resolved release commit", (t) => {
  const f = fixture(t);
  f.success("resolve");
  f.commit();
  f.git("push", "origin", "main");
  f.success("publish");
  assert.equal(f.ref("refs/heads/v1"), f.initial);
});

test("invalid and prerelease tags are rejected", (t) => {
  const f = fixture(t);
  for (const tag of ["1.0.0", "v01.0.0", "v1.00.0", "v1.0.01", "v1.0.0-rc.1", "v1.0.0+build", "v1", "v1.0.0; touch injected"]) {
    f.rejected(["resolve", tag], /canonical/);
  }
  f.absent("refs/heads/v1");
});

test("missing and invalid source branches are rejected", (t) => {
  const f = fixture(t);
  f.rejected(["resolve", "v1.0.0", "missing"], /Source branch does not exist/);
  for (const branch of ["main~1", "HEAD", "-main", "@{-1}"]) {
    f.rejected(["resolve", "v1.0.0", branch], /Invalid branch name/);
  }
  f.absent("refs/tags/v1.0.0");
});

test("duplicate and older versions are rejected with numeric ordering", (t) => {
  const f = fixture(t);
  f.success("publish", "v1.10.0");
  f.rejected(["publish", "v1.10.0"], /already exists/);
  f.rejected(["publish", "v1.9.99"], /newer than v1.10.0/);
  f.success("publish", "v1.10.1");
  f.absent("refs/tags/v1.9.99");
});

test("conflicting major tags are rejected", (t) => {
  const f = fixture(t);
  f.git("tag", "v1");
  f.git("push", "origin", "refs/tags/v1");
  f.rejected(["publish"], /Major tag conflicts/);
  f.absent("refs/heads/v1");
  f.absent("refs/tags/v1.0.0");
});

test("divergent major branch is rejected before creating a tag", (t) => {
  const f = fixture(t);
  f.git("checkout", "-b", "v1");
  const divergent = f.commit();
  f.git("push", "origin", "v1");
  f.rejected(["publish"], /cannot fast-forward/);
  f.absent("refs/tags/v1.0.0");
  assert.equal(f.ref("refs/heads/v1"), divergent);
});

test("publication rechecks remote tags after resolution", (t) => {
  const f = fixture(t);
  f.success("resolve");
  f.git("tag", "v1.1.0");
  f.git("push", "origin", "refs/tags/v1.1.0");
  f.rejected(["publish"], /newer than v1.1.0/);
  f.absent("refs/tags/v1.0.0");
});

test("atomic push rejects a racing branch update without publishing the tag", (t) => {
  const f = fixture(t);
  f.git("push", "origin", "HEAD:refs/heads/v1");
  const next = f.commit();
  f.git("push", "origin", "main");
  f.git("checkout", "-b", "racer", f.initial);
  const racer = f.commit();
  // Ensure a distinct sibling even if commit timestamps coincide.
  const divergent = racer === next ? f.commit() : racer;
  f.git("push", "origin", "HEAD:refs/heads/racer");
  const hook = path.join(f.work, ".git/hooks/pre-push");
  fs.writeFileSync(hook, `#!/bin/sh\ngit --git-dir='${f.remote}' update-ref refs/heads/v1 ${divergent}\n`);
  fs.chmodSync(hook, 0o755);
  f.rejected(["publish", "v1.0.0", "main", next], /atomic|failed to push/);
  f.absent("refs/tags/v1.0.0");
  assert.equal(f.ref("refs/heads/v1"), divergent);
});

test("server rejection of a tag also leaves the major branch unpublished", (t) => {
  const f = fixture(t);
  const hook = path.join(f.remote, "hooks/update");
  fs.writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\n');
  fs.chmodSync(hook, 0o755);
  f.rejected(["publish"], /atomic|failed to push/);
  f.absent("refs/tags/v1.0.0");
  f.absent("refs/heads/v1");
});
