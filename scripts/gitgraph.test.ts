import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore: the mod is plain JS
import { createReader, refArgs, diffRows, parseRefs, parseLog, parseWorktrees, parseStashes, parseAheadBehind } from "../defaults/mods/gitview/git.js";
// @ts-ignore
import { Graph } from "../defaults/mods/gitview/graph.js";
// @ts-ignore
import { layoutLanes, COLORS } from "../defaults/mods/gitview/lanes.js";
// @ts-ignore
import { agoLabel, branchTree, fileTree, wordDiff, markWords, tokenize, lineSegments, hunkStarts, stepHunk } from "../defaults/mods/gitview/model.js";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });
const lay = (commits: any[]) => layoutLanes(commits).rows;

// ---- lane layout

test("a straight line stays in one lane and one colour", () => {
  const rows = lay([c("c", "b"), c("b", "a"), c("a")]);
  expect(rows.map((r: any) => r.lane)).toEqual([0, 0, 0]);
  expect(new Set(rows.map((r: any) => r.color)).size).toBe(1);
  expect(rows.map((r: any) => r.top)).toEqual([false, true, true]);
  expect(rows[0].edges).toEqual([{ to: 0, color: rows[0].color }]);
  expect(rows[2].edges).toEqual([]);
});

test("two branches off one parent take two lanes and meet at the parent", () => {
  // x and y both sit on p
  const rows = lay([c("x", "p"), c("y", "p"), c("p", "r"), c("r")]);
  expect(rows.map((r: any) => r.lane)).toEqual([0, 1, 0, 0]);
  expect(rows[1].edges).toEqual([{ to: 1, color: rows[1].color }]);
  expect(rows[2].merging).toEqual([{ lane: 1, color: rows[1].color }]);
  expect(rows[2].top).toBe(true);
  expect(rows[1].pass).toEqual([{ lane: 0, color: rows[0].color }]);
});

test("a merge opens a lane for its second parent and the lane ends where the branch forks", () => {
  // m merges f into main; both come from base
  const rows = lay([c("m", "main1", "f1"), c("f1", "base"), c("main1", "base"), c("base")]);
  expect(rows[0].edges.map((e: any) => e.to)).toEqual([0, 1]);
  expect(rows[1]).toMatchObject({ lane: 1, top: true });
  expect(rows[2]).toMatchObject({ lane: 0 });
  expect(rows[3].lane).toBe(0);
  expect(rows[1].edges.map((e: any) => e.to)).toEqual([1]);
  expect(rows[3].merging.map((m: any) => m.lane)).toEqual([1]);
  expect(rows[1].color).not.toBe(rows[2].color);
});

test("two lanes waiting for one commit join it as merging lines", () => {
  const rows = lay([c("a", "base"), c("b", "base"), c("c", "base"), c("base")]);
  expect(rows.map((r: any) => r.lane)).toEqual([0, 1, 2, 0]);
  expect(rows[3].merging.map((m: any) => m.lane).sort()).toEqual([1, 2]);
  expect(rows[3].top).toBe(true);
});

test("a merge whose second parent already has a lane draws an edge to it", () => {
  const rows = lay([c("a", "p"), c("m", "q", "p"), c("q"), c("p")]);
  expect(rows[1].edges.map((e: any) => e.to)).toEqual([1, 0]);
});

test("an octopus merge draws one edge per parent", () => {
  const rows = lay([c("o", "p1", "p2", "p3", "p4"), c("p1"), c("p2"), c("p3"), c("p4")]);
  expect(rows[0].edges.map((e: any) => e.to)).toEqual([0, 1, 2, 3]);
  expect(new Set(rows[0].edges.map((e: any) => e.color)).size).toBe(4);
  expect(rows.slice(1).map((r: any) => r.lane)).toEqual([0, 1, 2, 3]);
});

test("a second child of the same parent keeps its own lane until the parent", () => {
  const rows = lay([c("a", "p"), c("b", "q"), c("c", "p"), c("p"), c("q")]);
  // c keeps its own lane 2 until p, where lanes 0 and 2 join
  expect(rows[2].lane).toBe(2);
  expect(rows[2].edges).toEqual([{ to: 2, color: rows[2].color }]);
  expect(rows[3].merging.map((m: any) => m.lane)).toEqual([2]);
});

test("many parallel branches get their own lanes and freed lanes are reused", () => {
  const tips = Array.from({ length: 30 }, (_, i) => c(`t${i}`, "root"));
  const rows = lay([...tips, c("root")]);
  expect(rows.slice(0, 30).map((r: any) => r.lane)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  expect(rows[29].pass.length).toBe(29);
  expect(rows[30].merging.length).toBe(29);
  expect(rows[30].width).toBe(30);
  // the colours cycle through the palette
  expect(rows[COLORS].color).toBe(rows[0].color);
  const after = layoutLanes([c("n", "m"), c("m")], { lanes: [], color: 0 }).rows;
  expect(after.map((r: any) => r.lane)).toEqual([0, 0]);
});

test("laying out in pages gives the same rows as one pass", () => {
  const log = [c("m", "a", "f"), c("f", "base"), c("a", "base"), c("x", "y"), c("y", "base"), c("base", "root"), c("root")];
  const whole = layoutLanes(log);
  const first = layoutLanes(log.slice(0, 3));
  const second = layoutLanes(log.slice(3), first.carry);
  expect([...first.rows, ...second.rows]).toEqual(whole.rows);
});

test("30k commits in 600 interleaved branches lay out quickly", () => {
  const log: any[] = [];
  const last = Array.from({ length: 600 }, (_, i) => `b${i}-0`);
  for (let n = 0; n < 50; n++) for (let b = 0; b < 600; b++) { const sha = `b${b}-${n + 1}`; log.push(c(sha, n === 49 ? "root" : `b${b}-${n + 2}`)); }
  log.push(c("root"));
  const start = performance.now();
  layoutLanes(log);
  expect(performance.now() - start).toBeLessThan(2000);
  expect(last.length).toBe(600);
});

// ---- the pure model

test("age labels pick the unit by size", () => {
  const now = Date.UTC(2026, 10, 8);
  expect(agoLabel(now - 30 * 1000, now)).toBe("1 minute ago");
  expect(agoLabel(now - 10 * 3600 * 1000, now)).toBe("10 hours ago");
  expect(agoLabel(now - 3 * 86400 * 1000, now)).toBe("3 days ago");
  expect(agoLabel(now - 100 * 86400 * 1000, now)).toBe("3 months ago");
});

test("branches group into folders by prefix and filter by substring", () => {
  const names = ["master", "bugbash/a", "bugbash/b", "bugbash2/c", "backup/x", "feat/deep/one"];
  const tree = branchTree(names);
  expect(tree.map((i: any) => `${i.depth}${i.type[0]}:${i.path ?? i.name}`)).toEqual([
    "0f:backup", "1b:backup/x", "0f:bugbash", "1b:bugbash/a", "1b:bugbash/b", "0f:bugbash2", "1b:bugbash2/c", "0f:feat", "1f:feat/deep", "2b:feat/deep/one", "0b:master",
  ]);
  expect(tree.find((i: any) => i.path === "bugbash").count).toBe(2);
  expect(branchTree(names, "", new Set(["bugbash"])).some((i: any) => i.name === "a")).toBe(false);
  expect(branchTree(names, "BUGBASH2").map((i: any) => i.name)).toEqual(["bugbash2", "bugbash2/c"]);
});

test("changed files group into a tree", () => {
  const tree = fileTree([{ path: "src/b.ts" }, { path: "src/a/c.ts" }, { path: "README.md" }]);
  expect(tree.map((i: any) => [i.type, i.depth, i.name])).toEqual([["file", 0, "README.md"], ["folder", 0, "src"], ["folder", 1, "a"], ["file", 2, "c.ts"], ["file", 1, "b.ts"]]);
});

test("word diff leaves out what the two lines share", () => {
  const a = "import { debounceTimeoutUIFlicker } from '@/constants/timeouts'";
  const b = "import { debounceTimeoutUIFlicker, slowLoadTimeout } from '@/constants/timeouts'";
  const d = wordDiff(a, b);
  expect(b.slice(...d.next)).toBe(", slowLoadTimeout");
  expect(a.slice(...d.old)).toBe("");
  expect(wordDiff("abc", "xyz")).toBeNull();
});

test("a removed run pairs with the added run after it", () => {
  const rows = markWords(diffRows(["@@ -1,2 +1,2 @@", "-const a = 1;", "-keep", "+const a = 2;", "+keep"]));
  expect(rows[1].mark).toEqual([10, 11]);
  expect(rows[3].mark).toEqual([10, 11]);
  expect(rows[2].mark).toBeUndefined();
});

test("diff rows keep the old and new line number of every row", () => {
  const rows = diffRows(["@@ -6,3 +6,3 @@", " same", "-gone", "+came", " tail"]);
  expect(rows.map((r: any) => [r.kind, r.old, r.next])).toEqual([["@", undefined, undefined], [" ", 6, 6], ["-", 7, undefined], ["+", undefined, 7], [" ", 8, 8]]);
});

test("syntax kinds come out for code and nothing is invented for other files", () => {
  const kinds = tokenize("const x = 'a'; // hi", "ts").filter(([, k]: any) => k).map(([, k]: any) => k);
  expect(kinds).toEqual(["keyword", "string", "comment"]);
  expect(tokenize("plain text", "md")).toEqual([["plain text", ""]]);
  expect(tokenize("  42 + 1", "py").filter(([, k]: any) => k).map(([t]: any) => t)).toEqual(["42", "1"]);
});

test("line segments split at syntax and changed-word edges together", () => {
  const segs = lineSegments("const a = 2;", "ts", [10, 11]);
  expect(segs.map((s: any) => s.text).join("")).toBe("const a = 2;");
  expect(segs.filter((s: any) => s.hl).map((s: any) => s.text)).toEqual(["2"]);
  expect(segs.find((s: any) => s.text === "const").kind).toBe("keyword");
});

test("stepping goes to the next hunk below and the previous one above", () => {
  const starts = hunkStarts([{ kind: "@" }, { kind: " " }, { kind: "@" }, { kind: "+" }, { kind: "@" }]);
  expect(starts).toEqual([0, 2, 4]);
  expect(stepHunk(starts, -1, 1)).toBe(0);
  expect(stepHunk(starts, 0, 1)).toBe(2);
  expect(stepHunk(starts, 4, 1)).toBe(4);
  expect(stepHunk(starts, 4, -1)).toBe(2);
  expect(stepHunk(starts, 0, -1)).toBe(0);
  expect(stepHunk([], 0, 1)).toBeNull();
});

// ---- parsers

test("refs, stashes, worktrees and ahead-behind parse", () => {
  const sha = (n: string) => n.padEnd(40, "0");
  const refs = parseRefs([`refs/heads/main\0${sha("a")}\0`, `refs/remotes/origin/main\0${sha("a")}\0`, `refs/remotes/origin/HEAD\0${sha("a")}\0`, `refs/tags/v1\0${sha("t")}\0${sha("b")}`].join("\n"));
  expect(refs.heads).toEqual([{ name: "main", sha: sha("a") }]);
  expect(refs.remotes.map((r: any) => r.name)).toEqual(["origin/main"]);
  expect(refs.tags).toEqual([{ name: "v1", sha: sha("b") }]);
  expect(refs.bySha.get(sha("a"))).toEqual({ heads: ["main"], remotes: ["origin/main"], tags: [] });
  expect(refs.bySha.get(sha("b")).tags).toEqual(["v1"]);
  expect(parseStashes("stash@{0}\x1fabc\x1f1700000000\x1fbase idx\x1fWIP on main: x y")).toEqual([{ name: "stash@{0}", sha: "abc", time: 1700000000000, base: "base", subject: "WIP on main: x y" }]);
  expect(parseWorktrees("worktree /a\nHEAD aaa\nbranch refs/heads/main\n\nworktree /b\nHEAD bbb\ndetached\n")).toEqual([
    { path: "/a", sha: "aaa", branch: "main", detached: false, bare: false }, { path: "/b", sha: "bbb", branch: null, detached: true, bare: false }]);
  expect([...parseAheadBehind("refs/heads/a 3 4\nrefs/heads/b 0 0\n")]).toEqual([["a", { ahead: 3, behind: 4 }], ["b", { ahead: 0, behind: 0 }]]);
});

// ---- the reader on a real repo

const verbs: string[][] = [];
const exec = async (command: string, args: string[], options: { cwd?: string } = {}) => {
  if (command === "git") verbs.push(args);
  const p = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, stdout, stderr };
};
const reader = createReader({ exec });

const roots: string[] = [];
afterAll(async () => { for (const dir of roots) await rm(dir, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]) {
  const r = await exec("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
  verbs.pop();
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function commit(cwd: string, file: string, text: string, message: string) {
  await mkdir(join(cwd, file, ".."), { recursive: true });
  await writeFile(join(cwd, file), text);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gitgraph-"));
  roots.push(dir);
  const work = join(dir, "work");
  await git(dir, "init", "-b", "master", work);
  await commit(work, "a.ts", "const a = 1;\nconst b = 2;\n", "first\n\nthe body of the first commit");
  await git(work, "checkout", "-b", "feat/x");
  await commit(work, "a.ts", "const a = 1;\nconst b = 3;\nconst c = 4;\n", "change a");
  await git(work, "checkout", "master");
  await commit(work, "m.txt", "m\n", "main work");
  await git(work, "merge", "--no-ff", "-m", "merge feat", "feat/x");
  await git(work, "tag", "v1");
  await git(work, "tag", "-a", "v2", "-m", "annotated");
  await writeFile(join(work, "dirty.txt"), "wip\n");
  await git(work, "add", "dirty.txt");
  await git(work, "stash");
  const wt = join(dir, "wt");
  await git(work, "worktree", "add", "-b", "side", wt);
  return { dir, work, wt };
}

test("the repo call reads refs, tags peeled to commits, stashes and every checkout", async () => {
  const { work, wt } = await fixture();
  const info = await reader.repo(work, null);
  expect(info.ok).toBe(true);
  expect(info.heads.map((h: any) => h.name).sort()).toEqual(["feat/x", "master", "side"]);
  expect(info.tags.map((t: any) => t.name).sort()).toEqual(["v1", "v2"]);
  const head = await git(work, "rev-parse", "HEAD");
  expect(info.tags.find((t: any) => t.name === "v2").sha).toBe(head);
  expect(info.stashes).toHaveLength(1);
  expect(info.worktrees.map((w: any) => w.branch).sort()).toEqual(["master", "side"]);
  expect(info.worktrees.some((w: any) => w.path.endsWith("/wt"))).toBe(true);
  expect((await reader.repo(wt, null)).root).toContain("wt");
  expect((await reader.repo(join(work, ".."), null)).ok).toBe(false);
});

test("log pages come in topo order over every ref and join without gaps", async () => {
  const { work } = await fixture();
  const all = await reader.logPage(work, 0, null, 100);
  expect(all.map((c: any) => c.subject)).toContain("first");
  expect(all).toHaveLength(Number(await git(work, "rev-list", "--branches", "--remotes", "--tags", "HEAD", "--count")));
  const first = await reader.logPage(work, 0, null, 2), second = await reader.logPage(work, 2, null, 2), rest = await reader.logPage(work, 4, null, 50);
  expect([...first, ...second, ...rest].map((c: any) => c.sha)).toEqual(all.map((c: any) => c.sha));
  const seen = new Set<string>();
  for (const c of all) { for (const p of c.parents) expect(seen.has(p)).toBe(false); seen.add(c.sha); }
  const firstCommit = all.find((c: any) => c.subject === "first");
  expect(firstCommit.body).toBe("the body of the first commit");
  expect(all[0].parents).toHaveLength(2);
  const laid = layoutLanes(all);
  expect(laid.rows).toHaveLength(all.length);
});

test("a commit lists its files against the first parent and a root commit against the empty tree", async () => {
  const { work } = await fixture();
  const all = await reader.logPage(work, 0, null, 100);
  const merge = await reader.commit(work, all[0].sha, null);
  expect(merge.message).toBe("merge feat");
  expect(merge.files.map((f: any) => [f.status, f.path])).toEqual([["M", "a.ts"]]);
  expect(merge.files[0]).toMatchObject({ add: 2, del: 1 });
  const root = await reader.commit(work, all.find((c: any) => c.subject === "first").sha, null);
  expect(root.parents).toEqual([]);
  expect(root.files.map((f: any) => [f.status, f.path])).toEqual([["A", "a.ts"]]);
});

test("a file diff gives hunks, and the full view keeps the whole file", async () => {
  const { work } = await fixture();
  const [tip] = await reader.logPage(work, 0, null, 1);
  const detail = await reader.commit(work, tip.sha, null);
  const hunk = await reader.fileDiff(detail, detail.files[0], null, work);
  expect(hunk.lines[0]).toMatch(/^@@ /);
  expect(hunk.lines).toContain("-const b = 2;");
  expect(hunk.lines).toContain("+const b = 3;");
  const full = await reader.fileDiff(detail, detail.files[0], null, work, { full: true });
  expect(full.lines.length).toBeGreaterThanOrEqual(hunk.lines.length);
});

test("ahead and behind come per local branch", async () => {
  const { work } = await fixture();
  const ab = await reader.aheadBehind(work, "master", null);
  expect(ab.get("master")).toEqual({ ahead: 0, behind: 0 });
  expect(ab.get("feat/x")).toEqual({ ahead: 0, behind: 2 });
  expect((await reader.aheadBehind(work, null, null)).size).toBe(0);
});

test("the graph reads with git verbs that cannot write", async () => {
  verbs.length = 0;
  const { work } = await fixture();
  verbs.length = 0;
  const info = await reader.repo(work, null);
  const [tip] = await reader.logPage(work, 0, null, 3);
  const detail = await reader.commit(work, tip.sha, null);
  await reader.fileDiff(detail, detail.files[0], null, work);
  await reader.aheadBehind(work, "master", null);
  expect(info.ok).toBe(true);
  const allowed = new Set(["status", "rev-parse", "rev-list", "log", "diff", "for-each-ref", "stash", "worktree"]);
  const READ_FLAGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
  expect(verbs.length).toBeGreaterThan(5);
  for (const args of verbs) {
    const rest = args[0] === "rev-parse" ? args : args.slice(READ_FLAGS.length);
    expect(allowed.has(rest[0])).toBe(true);
    if (rest[0] === "stash") expect(rest[1]).toBe("list");
    if (rest[0] === "worktree") expect(rest[1]).toBe("list");
  }
});

test("hidden refs are excluded and soloed refs are the only ones walked", () => {
  expect(refArgs()).toEqual(["--branches", "--remotes", "--tags", "HEAD"]);
  expect(refArgs({ remotes: false, tags: false })).toEqual(["--branches", "HEAD"]);
  expect(refArgs({ extra: ["abc"] }).slice(-2)).toEqual(["HEAD", "abc"]);
  expect(refArgs({ hidden: ["refs/heads/a[1]", "refs/remotes/origin/x"] })).toEqual(["--exclude=a\\[1\\]", "--branches", "--exclude=origin/x", "--remotes", "--tags", "HEAD"]);
  expect(refArgs({ hidden: ["refs/heads/a"], solo: ["refs/heads/b"] })).toEqual(["refs/heads/b"]);
});

test("hiding a branch drops the commits only it reaches, and soloing keeps just its history", async () => {
  const { work } = await fixture();
  await git(work, "checkout", "-b", "lone");
  await commit(work, "lone.txt", "l\n", "lone work");
  await git(work, "checkout", "master");
  const subjects = async (refs: any) => (await reader.logPage(work, 0, null, 100, refs)).map((c: any) => c.subject);
  expect(await subjects({})).toContain("lone work");
  expect(await subjects({ hidden: ["refs/heads/lone"] })).not.toContain("lone work");
  expect((await subjects({ solo: ["refs/heads/lone"] })).sort()).toEqual(["lone work", "main work", "merge feat", "change a", "first"].sort());
  expect((await subjects({ solo: ["refs/heads/feat/x"] })).sort()).toEqual(["change a", "first"]);
});

test("search finds commits by message, author and changed file over the whole history", async () => {
  const { work } = await fixture();
  const subjects = async (q: string) => {
    const shas = await reader.search(work, q, null, {});
    return (await reader.logPage(work, 0, null, 100, {})).filter((c: any) => shas.has(c.sha)).map((c: any) => c.subject).sort();
  };
  expect(await subjects("CHANGE a")).toEqual(["change a"]);
  expect(await subjects("main work")).toEqual(["main work"]);
  expect(await subjects("m.txt")).toEqual(["main work"]);
  expect((await subjects("T")).length).toBeGreaterThan(0);
  expect(await subjects("no-such-thing")).toEqual([]);
});

function graphOf(commits: any[]) {
  const g = new Graph({}, () => ({ dir: null, on: null }), { scroll_to_item() {} });
  g.commits = commits; g.info = { heads: [], remotes: [], tags: [], worktrees: [], bySha: new Map() };
  return g;
}
const cx = { notify() {} };

test("the list has an uncommitted row first only when there are changes, and only matches when asked", () => {
  const g = graphOf([{ sha: "a1", subject: "x" }, { sha: "b2", subject: "y" }, { sha: "c3", subject: "z" }]);
  expect([g.count(), g.at(0)]).toEqual([3, 0]);
  g.wipSnap = { uncommittedTotal: 2, uncommitted: [] };
  expect([g.count(), g.at(0), g.at(1), g.position(2)]).toEqual([4, -1, 0, 3]);
  g.matches = new Set(["b2", "c3"]); g.query = "q";
  expect([g.count(), g.at(1), g.isHit(1), g.isHit(0)]).toEqual([4, 0, true, false]);
  g.onlyMatches = true;
  expect([g.count(), g.at(0), g.at(1), g.position(2)]).toEqual([2, 1, 2, 1]);
});

test("a sha prefix matches too, and a short query matches nothing", () => {
  const g = graphOf([{ sha: "abcdef1" }, { sha: "123456" }]);
  g.matches = new Set(); g.query = "abcd";
  expect(g.isHit(0)).toBe(true);
  expect(g.isHit(1)).toBe(false);
  g.hitCache = null; g.query = "ab";
  expect(g.isHit(0)).toBe(false);
});

test("clicking the selected commit again closes the right panel and once more opens it", async () => {
  const g = graphOf([{ sha: "a1" }]);
  g.git = { commit: async () => ({ files: [] }) };
  g.info.root = "/r";
  await g.select("a1", cx);
  expect([g.selected, g.panelOpen]).toEqual(["a1", true]);
  await g.select("a1", cx);
  expect(g.panelOpen).toBe(false);
  await g.select("a1", cx);
  expect(g.panelOpen).toBe(true);
  await g.select("wip", cx);
  expect(g.selected).toBe("wip");
});

test("the counter says how many branches the graph draws", () => {
  const g = graphOf([]);
  g.info.heads = [{ name: "a" }, { name: "b" }]; g.info.remotes = [{ name: "origin/a" }, { name: "origin/c" }];
  expect(g.visibleRefs()).toEqual({ shown: 2, all: 2 });
  g.show = { remotes: true, tags: false };
  expect(g.visibleRefs()).toEqual({ shown: 4, all: 4 });
  g.hidden.add("refs/heads/a"); g.hidden.add("refs/tags/v1");
  expect(g.visibleRefs()).toEqual({ shown: 3, all: 4 });
  g.soloed.add("refs/heads/b");
  expect(g.visibleRefs()).toEqual({ shown: 1, all: 4 });
});

test("a stash is its own node above the commit it was made on, with only that commit as parent", () => {
  const g = graphOf([]);
  g.info.stashes = [{ name: "stash@{0}", sha: "s1", base: "b", time: 5, subject: "WIP on x" }, { name: "stash@{1}", sha: "s2", base: "far", time: 4, subject: "later" }];
  g.placed = new Set();
  const page = g.withStashes([{ sha: "a", parents: ["b"] }, { sha: "b", parents: [] }]);
  expect(page.map((c: any) => c.sha)).toEqual(["a", "s1", "b"]);
  expect(page[1]).toMatchObject({ parents: ["b"], stash: "stash@{0}", subject: "WIP on x" });
  // placed once, and a stash whose base is on a later page waits for it
  expect(g.withStashes([{ sha: "b", parents: [] }]).map((c: any) => c.sha)).toEqual(["b"]);
  expect(g.withStashes([{ sha: "far", parents: [] }]).map((c: any) => c.sha)).toEqual(["s2", "far"]);
  const rows = layoutLanes(page).rows;
  expect(rows[1].edges).toHaveLength(1);
});

test("remote branches and tags stay out of the graph until turned on, and the choice is kept", async () => {
  const stored: Record<string, string> = {};
  (globalThis as any).localStorage = { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; } };
  const g = graphOf([]);
  g.show = { remotes: false, tags: false }; g.git = { logPage: async () => [] };
  expect(g.refs).toMatchObject({ remotes: false, tags: false });
  g.info.root = "/r"; g.info.stashes = [];
  g.toggleShow("tags", cx);
  expect(JSON.parse(stored["gitview.graph.show"])).toEqual({ remotes: false, tags: true });
  expect(new Graph({}, () => ({}), {}).show).toEqual({ remotes: false, tags: true });
  delete (globalThis as any).localStorage;
  expect(new Graph({}, () => ({}), {}).show).toEqual({ remotes: false, tags: false });
});

test("a real stash is listed with its base commit", async () => {
  const { work } = await fixture();
  const info = await reader.repo(work, null);
  expect(info.stashes[0].base).toBe(await git(work, "rev-parse", "HEAD"));
});
