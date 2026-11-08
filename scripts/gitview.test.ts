import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore: the mod is plain JS
import { createReader } from "../defaults/mods/gitview/git.js";

const exec = async (command: string, args: string[], options: { cwd?: string } = {}) => {
  const p = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, stdout, stderr };
};
const reader = createReader({ exec, readTextFile: async (path: string) => Bun.file(path).text() });

const roots: string[] = [];
afterAll(async () => { for (const dir of roots) await rm(dir, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]) {
  const r = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function commit(cwd: string, file: string, text: string, message = file) {
  await mkdir(join(cwd, file, ".."), { recursive: true });
  await writeFile(join(cwd, file), text);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
}

// A clone of a bare origin with one commit on master, origin/HEAD set.
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "gitview-"));
  roots.push(dir);
  const origin = join(dir, "origin.git"), work = join(dir, "work");
  await git(dir, "init", "--bare", "-b", "master", origin);
  await git(dir, "clone", origin, work);
  await git(work, "checkout", "-b", "master");
  await commit(work, "README.md", "hello\n", "first");
  await git(work, "push", "-u", "origin", "master");
  await git(work, "remote", "set-head", "origin", "master");
  return { dir, origin, work };
}

test("a clean checkout on master is level with origin and pushed", async () => {
  const { work } = await repo();
  const s = await reader.read(work, null);
  expect(s).toMatchObject({ ok: true, branch: "master", detached: false, base: "origin/master", ahead: 0, behind: 0, pushed: "pushed", uncommittedTotal: 0, unpushedTotal: 0 });
  expect(s.latest).toMatchObject({ subject: "first" });
  expect(s.root).toBe(await git(work, "rev-parse", "--show-toplevel"));
});

test("a folder inside the repo reads the same repo", async () => {
  const { work } = await repo();
  await mkdir(join(work, "src"));
  expect((await reader.read(join(work, "src"), null)).root).toBe(await git(work, "rev-parse", "--show-toplevel"));
});

test("a dirty checkout lists modified, staged, deleted and untracked files with line counts", async () => {
  const { work } = await repo();
  await commit(work, "a.txt", "1\n2\n3\n");
  await commit(work, "gone.txt", "x\n");
  await git(work, "push");
  await writeFile(join(work, "a.txt"), "1\n2\n3\n4\n5\n");
  await writeFile(join(work, "staged.txt"), "s\n");
  await git(work, "add", "staged.txt");
  await Bun.$`rm ${join(work, "gone.txt")}`;
  await writeFile(join(work, "new.txt"), "n\n");
  const s = await reader.read(work, null);
  const byPath = Object.fromEntries(s.uncommitted.map((f: any) => [f.path, f]));
  expect(Object.keys(byPath).sort()).toEqual(["a.txt", "gone.txt", "new.txt", "staged.txt"]);
  expect(byPath["a.txt"]).toMatchObject({ status: "M", add: 2, del: 0, fresh: false });
  expect(byPath["gone.txt"]).toMatchObject({ status: "D", del: 1 });
  expect(byPath["new.txt"]).toMatchObject({ status: "A", fresh: true });
  expect(byPath["staged.txt"]).toMatchObject({ status: "A", fresh: false });
  expect(s.uncommittedTotal).toBe(4);
  expect(s.unpushedTotal).toBe(0);
});

test("files with spaces in the name keep them", async () => {
  const { work } = await repo();
  await commit(work, "dir/two words.txt", "t\n");
  await writeFile(join(work, "my file.txt"), "n\n");
  const s = await reader.read(work, null);
  expect(s.uncommitted.map((f: any) => f.path)).toEqual(["my file.txt"]);
  expect(s.unpushed.map((f: any) => f.path)).toEqual(["dir/two words.txt"]);
});

test("a branch ahead of master with commits not pushed lists the committed files", async () => {
  const { work } = await repo();
  await git(work, "checkout", "-b", "feature");
  await commit(work, "one.txt", "1\n", "add one");
  await commit(work, "src/two.txt", "2\n", "add two");
  const s = await reader.read(work, null);
  expect(s).toMatchObject({ branch: "feature", ahead: 2, behind: 0, upstream: null, remote: null, pushed: "none", unpushedTotal: 2 });
  expect(s.unpushed.map((f: any) => [f.status, f.path]).sort()).toEqual([["A", "one.txt"], ["A", "src/two.txt"]]);
  expect(s.latest.subject).toBe("add two");
});

test("pushing without -u still counts as pushed through origin/<branch>", async () => {
  const { work } = await repo();
  await git(work, "checkout", "-b", "feature");
  await commit(work, "one.txt", "1\n");
  await git(work, "push", "origin", "feature");
  expect(await reader.read(work, null)).toMatchObject({ ahead: 1, upstream: null, remote: "origin/feature", pushed: "pushed", unpushedTotal: 0 });
  await commit(work, "two.txt", "2\n");
  const s = await reader.read(work, null);
  expect(s).toMatchObject({ pushed: "unpushed", unpushedTotal: 1 });
  expect(s.unpushed.map((f: any) => f.path)).toEqual(["two.txt"]);
});

test("an upstream with unpushed commits counts them and lists only those files", async () => {
  const { work } = await repo();
  await git(work, "checkout", "-b", "feature");
  await commit(work, "one.txt", "1\n");
  await git(work, "push", "-u", "origin", "feature");
  await commit(work, "two.txt", "2\n");
  await commit(work, "three.txt", "3\n");
  const s = await reader.read(work, null);
  expect(s).toMatchObject({ upstream: "origin/feature", pushed: "unpushed", unpushedCommits: 2, ahead: 3, unpushedTotal: 2 });
  expect(s.unpushed.map((f: any) => f.path).sort()).toEqual(["three.txt", "two.txt"]);
});

test("a branch behind master counts the commits it lacks", async () => {
  const { dir, work } = await repo();
  await git(work, "checkout", "-b", "feature");
  const other = join(dir, "other");
  await git(dir, "clone", join(dir, "origin.git"), other);
  await git(other, "checkout", "master");
  await commit(other, "later.txt", "l\n");
  await commit(other, "later2.txt", "l\n");
  await git(other, "push", "origin", "master");
  // The reader never fetches: the new master is only known once someone else fetches.
  expect((await reader.read(work, null)).behind).toBe(0);
  await git(work, "fetch");
  expect(await reader.read(work, null)).toMatchObject({ ahead: 0, behind: 2, base: "origin/master" });
});

test("diverged from master reports both sides", async () => {
  const { dir, work } = await repo();
  await git(work, "checkout", "-b", "feature");
  await commit(work, "mine.txt", "m\n");
  const other = join(dir, "other");
  await git(dir, "clone", join(dir, "origin.git"), other);
  await git(other, "checkout", "master");
  await commit(other, "theirs.txt", "t\n");
  await git(other, "push", "origin", "master");
  await git(work, "fetch");
  expect(await reader.read(work, null)).toMatchObject({ ahead: 1, behind: 1 });
});

test("a detached head has no branch, still reports commits since master and the latest commit", async () => {
  const { work } = await repo();
  await commit(work, "x.txt", "x\n", "on master");
  await git(work, "checkout", "--detach");
  await commit(work, "y.txt", "y\n", "detached work");
  const s = await reader.read(work, null);
  expect(s).toMatchObject({ ok: true, branch: null, detached: true, ahead: 2, pushed: "none" });
  expect(s.latest.subject).toBe("detached work");
  expect(s.unpushed.map((f: any) => f.path).sort()).toEqual(["x.txt", "y.txt"]);
});

test("the default branch falls back to origin/main, and to none without a remote", async () => {
  const { dir, work } = await repo();
  await git(work, "branch", "-m", "master", "main");
  await git(work, "push", "origin", "main");
  await git(work, "remote", "set-head", "origin", "--delete");
  await git(work, "update-ref", "-d", "refs/remotes/origin/master");
  expect(await reader.read(work, null)).toMatchObject({ base: "origin/main", ahead: 0 });

  const local = join(dir, "local");
  await mkdir(local);
  await git(local, "init", "-b", "master");
  await commit(local, "a.txt", "a\n");
  expect(await reader.read(local, null)).toMatchObject({ ok: true, base: null, ahead: null, behind: null, remote: null, pushed: "none", unpushedTotal: 0 });
});

test("a repository with no commit yet reads without a latest commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gitview-"));
  roots.push(dir);
  await git(dir, "init", "-b", "master");
  await writeFile(join(dir, "a.txt"), "a\n");
  expect(await reader.read(dir, null)).toMatchObject({ ok: true, branch: "master", latest: null, hasHead: false, uncommittedTotal: 1 });
});

test("a folder that is not a repository says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gitview-"));
  roots.push(dir);
  expect(await reader.read(dir, null)).toEqual({ ok: false, reason: "Not a git repository" });
});

test("a copy with thousands of changed files lists a bounded page and counts them all", async () => {
  const { work } = await repo();
  await mkdir(join(work, "bulk"));
  await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(join(work, "bulk", `f${i}.txt`), `${i}\n`)));
  const started = performance.now();
  const s = await reader.read(work, null);
  expect(s.uncommittedTotal).toBe(3000);
  expect(s.uncommitted.length).toBe(1000);
  expect(performance.now() - started).toBeLessThan(5000);
});

test("reading writes nothing under .git", async () => {
  const { work } = await repo();
  await git(work, "checkout", "-b", "feature");
  await commit(work, "one.txt", "1\n");
  await writeFile(join(work, "dirty.txt"), "d\n");
  await writeFile(join(work, "one.txt"), "changed\n");
  const snapshot = async () => {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else out.push(`${path} ${(await stat(path)).mtimeMs} ${(await stat(path)).size}`);
      }
    };
    await walk(join(work, ".git"));
    return out.sort();
  };
  const before = await snapshot();
  const s = await reader.read(work, null);
  await reader.diff(s, s.uncommitted.find((f: any) => f.path === "one.txt"), "uncommitted", null);
  await reader.diff(s, s.unpushed[0], "unpushed", null);
  expect(await snapshot()).toEqual(before);
});

test("diffs: a changed file, an untracked file, and a committed-not-pushed file", async () => {
  const { work } = await repo();
  await git(work, "checkout", "-b", "feature");
  await commit(work, "one.txt", "1\n2\n");
  await writeFile(join(work, "one.txt"), "1\nTWO\n");
  await writeFile(join(work, "fresh.txt"), "a\nb\n");
  const s = await reader.read(work, null);

  const changed = await reader.diff(s, s.uncommitted.find((f: any) => f.path === "one.txt"), "uncommitted", null);
  expect(changed.lines).toEqual([expect.stringMatching(/^@@ /), " 1", "-2", "+TWO"]);

  const fresh = await reader.diff(s, s.uncommitted.find((f: any) => f.path === "fresh.txt"), "uncommitted", null);
  expect(fresh.lines).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);

  const committed = await reader.diff(s, s.unpushed[0], "unpushed", null);
  expect(committed.lines).toEqual(["@@ -0,0 +1,2 @@", "+1", "+2"]);
});

test("a binary file shows a placeholder instead of a diff", async () => {
  const { work } = await repo();
  await writeFile(join(work, "img.bin"), Buffer.from([0, 1, 2, 0, 255]));
  const s = await reader.read(work, null);
  const out = await reader.diff(s, s.uncommitted[0], "uncommitted", null);
  expect(out.lines).toEqual(["Binary file · no text diff"]);
});
