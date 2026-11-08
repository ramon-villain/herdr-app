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
import { agoLabel, branchTree, fileTree, wordDiff, markWords, tokenize, lineSegments, hunkStarts, stepHunk, findMatches, stepMatch, markFinds, findKey } from "../defaults/mods/gitview/model.js";

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
  expect(merge.files[0]).toMatchObject({ add: 0, del: 0 });
  await merge.stats;
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

test("one batched read gives each file the same lines as reading it alone", async () => {
  const { work } = await fixture();
  const [tip] = await reader.logPage(work, 0, null, 1);
  const detail = await reader.commit(work, tip.sha, null);
  const alone = await reader.fileDiff(detail, detail.files[0], null, work);
  const batch = await reader.diffBatch(work, null, [detail.from, detail.sha], [detail.files[0], { path: "absent.ts" }]);
  expect([...batch.keys()]).toEqual([detail.files[0].path]);
  expect(batch.get(detail.files[0].path)).toEqual(alone);
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
const cx = { notify() {}, spawn(work: (cx: any) => Promise<void>) { work(cx); } };

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

// ---- speed: what is read together, kept and skipped

test("a commit's file lists start with its message when the parents are known, and the counts follow the list", async () => {
  const calls: string[] = [];
  const release: Record<string, () => void> = {};
  const fake = createReader({
    exec: (_c: string, args: string[]) => {
      const verb = args.find((a) => a === "log" || a === "diff") + (args.includes("--numstat") ? "-numstat" : "");
      calls.push(verb);
      return new Promise((resolve) => {
        release[verb] = () => resolve({
          code: 0, stderr: "",
          stdout: verb === "log" ? "abc\x1fp1\x1fAnn\x1fa@b\x1f1700000000\x1fsubject" : verb === "diff-numstat" ? "3\t1\tsrc/a.ts\0" : "M\0src/a.ts\0",
        });
      });
    },
  });
  const pending = fake.commit("/r", "abc", null, ["p1"]);
  // log, name-status and numstat are all running before any of them answered
  expect(calls.sort()).toEqual(["diff", "diff-numstat", "log"]);
  release.log(); release.diff();
  const detail = await pending;
  expect(detail.files).toEqual([{ status: "M", path: "src/a.ts", add: 0, del: 0 }]);
  release["diff-numstat"]();
  await detail.stats;
  expect(detail.files[0]).toMatchObject({ add: 3, del: 1 });
});

test("a commit without a parents hint still waits for its message to name the parent", async () => {
  const calls: string[] = [];
  const fake = createReader({
    exec: async (_c: string, args: string[]) => {
      calls.push(args.find((a) => a === "log" || a === "diff")!);
      return { code: 0, stderr: "", stdout: args.includes("log") ? "abc\x1fp1\x1fAnn\x1fa@b\x1f1700000000\x1fsubject" : "" };
    },
  });
  const pending = fake.commit("/r", "abc", null);
  expect(calls).toEqual(["log"]);
  await pending;
  expect(calls).toEqual(["log", "diff", "diff"]);
});

test("changed words are found only for the rows that are read, and equal what the eager version found", () => {
  const lines = ["@@ -1,3 +1,3 @@", "-const a = 1;", "-let b = 2;", "+const a = 2;", "+let b = 3;"];
  const rows = markWords(diffRows(lines));
  expect(rows.map((r: any) => r.mark)).toEqual([undefined, [10, 11], [8, 9], [10, 11], [8, 9]]);
  expect(Object.keys(rows[1])).toContain("mark");
});

function cachedGraph(overrides: Record<string, any> = {}) {
  const calls = { commit: 0, fileDiff: [] as string[], batch: [] as string[][] };
  const git = {
    commit: async (_root: string, sha: string) => {
      calls.commit++;
      const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((n) => `${n}.ts`).map((path) => ({ path, status: "M", add: 0, del: 0 }));
      return { sha, parents: ["p"], from: "p", files, total: 10, stats: Promise.resolve() };
    },
    fileDiff: async (_d: any, file: any) => { calls.fileDiff.push(file.path); return { lines: ["@@ -1 +1 @@", "-a", "+b"], cut: false }; },
    diffBatch: async (_root: string, _on: any, _range: string[], files: any[]) => {
      calls.batch.push(files.map((f) => f.path));
      return new Map(files.map((f) => [f.path, { lines: ["@@ -1 +1 @@", "-a", "+b"], cut: false }]));
    },
    ...overrides,
  };
  const g = new Graph(git, () => ({ dir: "/r", on: null }), { scroll_to_item() {} });
  g.info = { root: "/r", heads: [], remotes: [], tags: [], worktrees: [], stashes: [], bySha: new Map() };
  g.commits = [{ sha: "s1", parents: ["p"] }, { sha: "s2", parents: ["p"] }]; g.index = new Map([["s1", 0], ["s2", 1]]);
  return { g, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("selecting a commit reads the diffs of its files in one run, and opening one then draws at once", async () => {
  const { g, calls } = cachedGraph();
  await g.select("s1", cx);
  await settle();
  expect(calls.batch).toEqual([["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((n) => `${n}.ts`)]);
  const opened = g.openFile("b.ts", cx);
  // the rows are there before the open call has yielded
  expect(g.view?.rows.map((r: any) => r.kind)).toEqual(["@", "-", "+"]);
  await opened;
  // only File View's read for the file just opened
  expect(calls.fileDiff).toEqual(["b.ts"]);
});

test("a file the batch left out is read on its own, and a failed batch falls back to one read per file", async () => {
  const { g, calls } = cachedGraph({ diffBatch: async (_r: string, _o: any, _g: string[], files: any[]) => new Map(files.slice(1).map((f) => [f.path, { lines: ["@@ -1 +1 @@", "+a"], cut: false }])) });
  await g.select("s1", cx);
  await settle();
  expect(calls.fileDiff).toEqual(["a.ts"]);
  const failing = cachedGraph({ diffBatch: async () => { throw new Error("x"); } });
  await failing.g.select("s1", cx);
  await settle();
  expect(failing.calls.fileDiff).toHaveLength(10);
});

test("the uncommitted files' diffs are read in one run, File View reads the whole file, and a changed list starts over", async () => {
  const { g, calls } = cachedGraph();
  const files = [{ path: "m.ts", status: "M" }, { path: "n.ts", status: "M" }, { path: "new.ts", status: "A", fresh: true }];
  const read: any[] = [];
  g.git.diff = async (_s: any, file: any, _sec: string, _on: any, o: any) => { read.push([file.path, o?.full]); return { lines: ["@@ -1 +1 @@", "+a"], cut: false }; };
  g.git.read = async () => ({ ok: true, root: "/r", sha: "h", ahead: 0, behind: 0, uncommittedTotal: 3, uncommitted: files });
  g.worktree = "/r";
  await g.loadWip(cx);
  await settle();
  expect(calls.batch).toContainEqual(["m.ts", "n.ts"]);
  await g.select("wip", cx);
  await g.openFile("m.ts", cx);
  expect(g.view.rows).toHaveLength(3);
  expect(read).toEqual([["m.ts", true]]);
  g.setMode("file", cx);
  await settle();
  expect(read).toHaveLength(1);
  expect(g.view).not.toBeNull();
  const before = calls.batch.length;
  g.git.read = async () => ({ ok: true, root: "/r", sha: "h", ahead: 0, behind: 0, uncommittedTotal: 3, uncommitted: [{ ...files[0], add: 5 }, files[1], files[2]] });
  await g.loadWip(cx);
  await settle();
  expect(calls.batch.length).toBeGreaterThan(before);
});

test("a commit selected again is not read again, and an open during a read joins it", async () => {
  const { g, calls } = cachedGraph();
  await g.select("s1", cx);
  await g.select("s2", cx);
  await g.select("s1", cx);
  await settle();
  expect(calls.commit).toBe(2);
  const before = calls.fileDiff.length;
  await Promise.all([g.openFile("j.ts", cx), g.openFile("j.ts", cx)]);
  expect(calls.fileDiff.length - before).toBe(1);
  await g.openFile("j.ts", cx);
  expect(calls.fileDiff.length - before).toBe(1);
});

test("the full-file view is its own cache entry, and a failed read is not kept", async () => {
  let fail = true;
  const { g, calls } = cachedGraph({
    fileDiff: async (_d: any, file: any, _on: any, _root: any, { full }: any) => { calls.fileDiff.push(`${file.path}:${full}`); if (fail && full) throw new Error("x"); return { lines: ["@@ -1 +1 @@", "+a"], cut: false }; },
  });
  await g.select("s1", cx);
  await g.openFile("d.ts", cx);
  g.setMode("file", cx);
  await settle();
  expect(g.view.rows[0].text).toMatch(/Cannot preview/);
  fail = false;
  g.setMode("diff", cx);
  g.setMode("file", cx);
  await settle();
  expect(g.view.rows.map((r: any) => r.kind)).toEqual(["@", "+"]);
  expect(calls.fileDiff.filter((c) => c === "d.ts:true").length).toBeGreaterThanOrEqual(2);
});

test("opening another file keeps File View selected and shows its whole file", async () => {
  const { g } = cachedGraph({
    fileDiff: async (_d: any, _file: any, _on: any, _root: any, { full }: any) => ({ lines: full ? ["@@ -1,2 +1,2 @@", " x", "+whole"] : ["@@ -1 +1 @@", "+a"], cut: false }),
    diffBatch: async (_r: string, _o: any, _g: string[], files: any[], opts?: any) => new Map(files.map((f) => [f.path, { lines: opts?.full ? ["@@ -1,2 +1,2 @@", " x", "+whole"] : ["@@ -1 +1 @@", "+a"], cut: false }])),
  });
  await g.select("s1", cx);
  await g.openFile("a.ts", cx);
  g.setMode("file", cx);
  await settle();
  await g.openFile("b.ts", cx);
  await settle();
  expect(g.mode).toBe("file");
  expect(g.view.rows.map((r: any) => r.text)).toContain("whole");
});

test("in File View the whole files of the next few are read in one run, and only those", async () => {
  const fullBatches: string[][] = [];
  const { g } = cachedGraph({
    diffBatch: async (_r: string, _o: any, _g: string[], files: any[], opts?: any) => {
      if (opts?.full) fullBatches.push(files.map((f) => f.path));
      return new Map(files.map((f) => [f.path, { lines: ["@@ -1 +1 @@", "+a"], cut: false }]));
    },
  });
  await g.select("s1", cx);
  await g.openFile("b.ts", cx);
  await settle();
  expect(fullBatches).toEqual([]);
  g.setMode("file", cx);
  await settle();
  expect(fullBatches).toEqual([["c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"]]);
  expect(g.cachedView(g.detail, g.detail.files[2], "file")).not.toBeNull();
  expect(g.cachedView(g.detail, g.detail.files[8], "file")).toBeNull();
  await g.openFile("c.ts", cx);
  await settle();
  expect(fullBatches).toEqual([["c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"], ["i.ts"]]);
});

test("the file rows are built once per commit and layout", async () => {
  const { g } = cachedGraph();
  await g.select("s1", cx);
  const flat = g.fileItems();
  expect(g.fileItems()).toBe(flat);
  g.fileMode = "tree";
  expect(g.fileItems()).not.toBe(flat);
  expect(g.fileItems()).toBe(g.fileItems());
  expect(g.fileItems().every((item: any) => item.type === "file" || item.type === "folder")).toBe(true);
});

test("the poll reloads when the probe changes and otherwise only refreshes the uncommitted files", async () => {
  let signature: string | null = "a";
  const reloads: string[] = [];
  const g: any = new Graph({ probe: async () => signature, pullRequests: async () => new Map(), read: async () => ({ ok: true, uncommittedTotal: 0, uncommitted: [] }) }, () => ({ dir: "/r", on: null }), {});
  g.info = { root: "/r" }; g.signature = "a"; g.worktree = "/r";
  g.load = async () => { reloads.push("load"); };
  await g.poll(cx);
  expect(reloads).toEqual([]);
  signature = "b";
  await g.poll(cx);
  expect(reloads).toEqual(["load"]);
  signature = null;
  await g.poll(cx);
  expect(reloads).toEqual(["load"]);
});

test("an unchanged uncommitted state does not redraw", async () => {
  let notified = 0;
  const snap = { ok: true, sha: "x", ahead: 0, behind: 0, uncommittedTotal: 1, uncommitted: [{ path: "a", status: "M", add: 1, del: 0 }] };
  const g: any = new Graph({ read: async () => ({ ...snap }) }, () => ({ dir: "/r", on: null }), {});
  g.info = { root: "/r" }; g.worktree = "/r";
  const counting = { notify() { notified++; } };
  g.git.diffBatch = async () => new Map();
  await g.loadWip(counting);
  await g.loadWip(counting);
  expect(notified).toBe(1);
  snap.uncommittedTotal = 2;
  await g.loadWip(counting);
  expect(notified).toBe(2);
});

test("the first look at a folder draws the tracked changes while the untracked scan is still running", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => { release = r; });
  const tracked = { path: "a", status: "M", add: 1, del: 0 }, fresh = { path: "b", status: "A", fresh: true };
  const read = async (_p: string, _on: any, o: any) => {
    if (o.untracked === false) return { ok: true, root: "/r", sha: "x", ahead: 0, behind: 0, uncommittedTotal: 1, uncommitted: [tracked] };
    await slow;
    return { ok: true, root: "/r", sha: "x", ahead: 0, behind: 0, uncommittedTotal: 2, uncommitted: [tracked, fresh] };
  };
  const g: any = new Graph({ read, diffBatch: async () => new Map() }, () => ({ dir: "/r", on: null }), {});
  g.info = { root: "/r" }; g.worktree = "/r";
  const loading = g.loadWip(cx);
  await settle();
  expect(g.wipSnap.uncommitted).toEqual([tracked]);
  release();
  await loading;
  expect(g.wipSnap.uncommitted).toEqual([tracked, fresh]);
});

test("the probe is equal while nothing moved and differs after a commit, a branch, a tag or a stash", async () => {
  const { work } = await fixture();
  const seen = [await reader.probe(work, null)];
  expect(await reader.probe(work, null)).toBe(seen[0]);
  await commit(work, "n.txt", "n\n", "next");
  seen.push(await reader.probe(work, null));
  await git(work, "branch", "other");
  seen.push(await reader.probe(work, null));
  await git(work, "tag", "v9");
  seen.push(await reader.probe(work, null));
  await writeFile(join(work, "m.txt"), "changed\n");
  await git(work, "stash");
  seen.push(await reader.probe(work, null));
  expect(new Set(seen).size).toBe(5);
  expect((await reader.probe(join(work, ".."), null))).toBeNull();
});

// A click's cx stops working once its handler returns; only the cx a spawned task receives can still redraw.
function clickCx() {
  const task = { drawn: 0, notify() { this.drawn++; }, spawn() {} };
  const click: any = { live: true, notify() { if (!this.live) throw new Error("click cx used after its handler returned"); }, spawn(work: (cx: any) => Promise<void>) { work(task); } };
  return { click, task, returned() { click.live = false; } };
}

test("a slow file opened by click and a switch of view redraw through the task's cx, not the click's", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let releaseFull: () => void = () => {};
  const fullGate = new Promise<void>((r) => { releaseFull = r; });
  const { g } = cachedGraph({
    diffBatch: async () => { await gate; return new Map(); },
    fileDiff: async (_d: any, _f: any, _on: any, _root: any, { full }: any) => { if (full) await fullGate; else await gate; return { lines: ["@@ -1 +1 @@", "+a"], cut: false }; },
  });
  await g.select("s1", cx);
  const open = clickCx();
  const opening = g.openFile("e.ts", open.click);
  open.returned();
  expect(g.view).toBeNull();
  release();
  await opening;
  expect(g.view?.rows).toHaveLength(2);
  expect(open.task.drawn).toBeGreaterThan(0);

  const mode = clickCx();
  g.setMode("file", mode.click);
  mode.returned();
  expect(g.view).toBeNull();
  releaseFull();
  await settle();
  expect(g.view).not.toBeNull();
  expect(mode.task.drawn).toBeGreaterThan(0);
});

test("a commit selected by click that is not cached yet redraws through the task's cx", async () => {
  const { g } = cachedGraph();
  const pick = clickCx();
  const picking = g.select("s2", pick.click);
  pick.returned();
  await picking;
  expect(g.detail?.sha).toBe("s2");
  expect(pick.task.drawn).toBeGreaterThan(0);
});

test("the clones call lists the folders that hold a checkout and leaves out plain folders", async () => {
  const { dir } = await fixture();
  await mkdir(join(dir, "plain"));
  expect((await reader.clones(dir, null)).sort()).toEqual(["work", "wt"]);
  expect(await reader.clones(join(dir, "missing"), null)).toEqual([]);
});

function repoGraph(space: string | null = "sp1") {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  const git: any = {
    clones: async () => ["firstmate", "zeta", "overseer"],
    repo: async (dir: string) => ({ ok: true, root: dir, heads: [], remotes: [], tags: [], worktrees: [{ path: dir, branch: "master", sha: "x" }], stashes: [], bySha: new Map(), base: "origin/master" }),
    probe: async () => "p", aheadBehind: async () => new Map(), read: async () => ({ ok: false }), logPage: async () => [],
  };
  const g = new Graph(git, () => ({ dir: "/own", on: null, space }), { scroll_to_item() {} }, "/projects/");
  return { g, git, store };
}

test("the repository dropdown lists overseer first, switches the view to that repo, and remembers the pick per space", async () => {
  const { g } = repoGraph();
  await g.load(cx);
  await settle();
  expect(g.repos.map((r: any) => r.path)).toEqual(["/projects/overseer", "/projects/firstmate", "/projects/zeta"]);
  g.pickRepo("/projects/firstmate", cx);
  await settle();
  expect(g.info.root).toBe("/projects/firstmate");
  expect(g.worktree).toBe("/projects/firstmate");

  const again = new Graph(g.git, () => ({ dir: "/own", on: null, space: "sp1" }), { scroll_to_item() {} }, "/projects");
  await again.load(cx);
  expect(again.info.root).toBe("/projects/firstmate");

  g.pickRepo(null, cx);
  await settle();
  expect(g.info.root).toBe("/own");
  const reset = new Graph(g.git, () => ({ dir: "/own", on: null, space: "sp1" }), { scroll_to_item() {} }, "/projects");
  await reset.load(cx);
  expect(reset.info.root).toBe("/own");
});

test("a space with no stored pick opens on the overseer clone and still lists its own repo", async () => {
  const { g } = repoGraph();
  await g.load(cx);
  await settle();
  expect(g.info.root).toBe("/projects/overseer");
  expect(g.repo).toBe("/projects/overseer");
  expect(g.ownRoot).toBe("/own");
});

test("a stored pick wins over the overseer default, and so does the space's own repo picked on purpose", async () => {
  const { g, store } = repoGraph();
  store.set("gitview.graph.repo", JSON.stringify({ sp1: "/projects/zeta", sp2: "" }));
  await g.load(cx);
  expect(g.info.root).toBe("/projects/zeta");
  const own = new Graph(g.git, () => ({ dir: "/own", on: null, space: "sp2" }), { scroll_to_item() {} }, "/projects");
  await own.load(cx);
  expect(own.info.root).toBe("/own");
});

test("without an overseer clone the space keeps its own repo", async () => {
  const { g, git } = repoGraph();
  git.clones = async () => ["firstmate", "zeta"];
  await g.load(cx);
  expect(g.info.root).toBe("/own");
  expect(g.repo).toBeNull();
});

test("a space on another machine offers no local clones", async () => {
  const { g } = repoGraph();
  g.locate = () => ({ dir: "/own", on: "box", space: "sp1" });
  await g.load(cx);
  await settle();
  expect(g.repos).toEqual([]);
});

// ---- find in the file pane

const findRows = [
  { kind: "@", text: "@@ -1,3 +1,3 @@ Foo" },
  { kind: "", text: "foo bar FOO" },
  { kind: "+", text: "no hit here" },
  { kind: "-", text: "a foofoo" },
];

test("find matches case-insensitively, skips hunk headers, and finds each occurrence once", () => {
  expect(findMatches(findRows, "foo")).toEqual([
    { row: 1, from: 0, to: 3 }, { row: 1, from: 8, to: 11 }, { row: 3, from: 2, to: 5 }, { row: 3, from: 5, to: 8 },
  ]);
  expect(findMatches(findRows, "")).toEqual([]);
  expect(findMatches(findRows, "zzz")).toEqual([]);
});

test("stepping wraps at both ends and starts from the matching end", () => {
  expect(stepMatch(3, -1, 1)).toBe(0);
  expect(stepMatch(3, -1, -1)).toBe(2);
  expect(stepMatch(3, 2, 1)).toBe(0);
  expect(stepMatch(3, 0, -1)).toBe(2);
  expect(stepMatch(0, -1, 1)).toBe(-1);
});

test("find marks cut the segments at the match edges and flag the current one stronger", () => {
  const segs = [{ text: "foo bar", kind: "" }, { text: " baz", kind: "string" }];
  const out = markFinds(segs, [{ from: 2, to: 5, current: false }, { from: 8, to: 10, current: true }]);
  expect(out.map((s: any) => [s.text, s.find])).toEqual([["fo", 0], ["o b", 1], ["ar", 0], [" ", 0], ["ba", 2], ["z", 0]]);
  expect(markFinds(segs, [])).toBe(segs);
});

test("cmd+f opens the bar, and enter, cmd+g and escape only act while it is open", () => {
  const mod = (o: object = {}) => ({ platform: false, control: false, shift: false, alt: false, ...o });
  expect(findKey("f", mod({ platform: true }), false)).toBe("open");
  expect(findKey("f", mod({ control: true }), false)).toBe("open");
  expect(findKey("f", mod({ platform: true, shift: true }), false)).toBeNull();
  expect(findKey("f", mod(), false)).toBeNull();
  expect(findKey("enter", mod(), false)).toBeNull();
  expect(findKey("g", mod({ platform: true }), false)).toBeNull();
  expect(findKey("escape", mod(), false)).toBeNull();
  expect(findKey("enter", mod(), true)).toBe("next");
  expect(findKey("enter", mod({ shift: true }), true)).toBe("prev");
  expect(findKey("g", mod({ platform: true }), true)).toBe("next");
  expect(findKey("g", mod({ platform: true, shift: true }), true)).toBe("prev");
  expect(findKey("escape", mod(), true)).toBe("close");
  expect(findKey("a", mod(), true)).toBeNull();
});

test("the graph finds in the open file, steps with wrap-around, scrolls to the match, and closes", () => {
  const { g } = repoGraph();
  const scrolled: any[] = [];
  const handle = { scroll_to_item: (i: number, how: string) => scrolled.push([i, how]) };
  expect(g.openFind()).toBe(false);
  g.file = { path: "a.ts" }; g.view = { rows: findRows };
  expect(g.openFind()).toBe(true);
  g.setFind("foo", handle);
  expect(g.findHits().length).toBe(4);
  expect(g.find.at).toBe(0);
  expect(scrolled.at(-1)).toEqual([1, "center"]);
  g.stepFind(1, handle); g.stepFind(1, handle); g.stepFind(1, handle);
  expect([g.find.at, scrolled.at(-1)]).toEqual([3, [3, "center"]]);
  g.stepFind(1, handle);
  expect(g.find.at).toBe(0);
  g.stepFind(-1, handle);
  expect(g.find.at).toBe(3);
  g.setFind("zzz", handle);
  expect(g.findHits()).toEqual([]);
  expect(g.find.at).toBe(-1);
  g.closeFind();
  g.setFind("foo", handle);
  expect(g.findHits()).toEqual([]);
});

test("find follows the rows of the other view and goes away with the file", () => {
  const { g } = repoGraph();
  const handle = { scroll_to_item() {} };
  g.file = { path: "a.ts" }; g.view = { rows: findRows };
  g.openFind(); g.setFind("bar", handle);
  expect(g.findHits().length).toBe(1);
  g.view = { rows: [{ kind: "", text: "bar bar bar" }] };
  expect(g.findHits().length).toBe(3);
  g.closeFile({ notify() {} });
  expect(g.find.open).toBe(false);
  expect(g.findHits()).toEqual([]);
});

// ---- the branch of the selected commit

function branchGraph(heads: { name: string; sha: string }[]) {
  const scrolled: number[] = [];
  const g: any = new Graph({}, () => ({ dir: null, on: null }), { scroll_to_item() {} }, null, { scroll_to_item: (at: number) => scrolled.push(at) });
  g.commits = [c("d", "c"), c("c", "b"), c("b", "a"), c("a"), c("x", "b")];
  g.commits.forEach((commit: any, i: number) => g.index.set(commit.sha, i));
  g.info = { heads, remotes: [], tags: [], stashes: [], worktrees: [], bySha: new Map() };
  return { g, scrolled };
}
const markedNames = (g: any) => g.left().filter((i: any) => i.marked).map((i: any) => `${i.name}:${i.marked}`);

test("the branch whose tip is the selected commit is marked, expanded and scrolled to", async () => {
  const { g, scrolled } = branchGraph([{ name: "master", sha: "d" }, { name: "feat/deep/one", sha: "x" }]);
  g.collapsed.add("feat"); g.collapsed.add("feat/deep");
  expect(markedNames(g)).toEqual([]);
  await g.select("x", cx);
  expect(markedNames(g)).toEqual(["feat/deep/one:tip"]);
  expect(g.left().some((i: any) => i.type === "folder" && i.path === "feat/deep")).toBe(true);
  expect(g.left().findIndex((i: any) => i.marked)).toBe(scrolled[0]);
});

test("a commit that is no branch tip marks the branches that contain it", async () => {
  const { g } = branchGraph([{ name: "master", sha: "d" }, { name: "side", sha: "x" }, { name: "old", sha: "a" }]);
  await g.select("b", cx);
  expect(markedNames(g)).toEqual(["master:contains", "side:contains"]);
  await g.select("c", cx);
  expect(markedNames(g)).toEqual(["master:contains"]);
});

test("the mark goes when nothing is selected", async () => {
  const { g } = branchGraph([{ name: "master", sha: "d" }]);
  await g.select("d", cx);
  expect(markedNames(g)).toEqual(["master:tip"]);
  g.selected = null;
  expect(markedNames(g)).toEqual([]);
});

test("marking 575 branches over 5000 commits is one cheap pass", async () => {
  const { g } = branchGraph(Array.from({ length: 575 }, (_, i) => ({ name: `b/${i}`, sha: `h${i}` })));
  g.commits = Array.from({ length: 5000 }, (_, i) => c(`s${i}`, `s${i + 1}`));
  g.commits.forEach((commit: any, i: number) => g.index.set(commit.sha, i));
  g.info.heads[0].sha = "s0";
  const start = performance.now();
  await g.select("s4000", cx);
  g.left();
  expect(markedNames(g)).toEqual(["b/0:contains"]);
  expect(performance.now() - start).toBeLessThan(100);
});

// ---- solo

/** A click's cx stops working once its handler returns; a task's cx keeps working. */
function soloClick() {
  const state = { open: true, spawned: 0 };
  const task: any = { notify() {}, spawn(work: any) { work(task); } };
  const click: any = {
    state,
    notify() { if (!state.open) throw new Error("the click's cx is gone"); },
    spawn(work: any) { state.spawned++; work(task); },
  };
  return click;
}
const settleLog = async (g: any) => { for (let i = 0; i < 50 && (g.loading || !g.commits.length); i++) await new Promise((r) => setTimeout(r, 5)); };

test("soloing a branch lists its commits even though the click's cx is gone when the log returns", async () => {
  const log = [{ sha: "a1", parents: [], subject: "x", author: "", time: 1, body: "" }];
  const g: any = new Graph({ logPage: async () => { await new Promise((r) => setTimeout(r, 1)); return log; } }, () => ({ dir: null, on: null }), { scroll_to_item() {} });
  g.info = { root: "/r", heads: [{ name: "a", sha: "a1" }], remotes: [], tags: [], stashes: [], worktrees: [], bySha: new Map() };
  const click = soloClick();
  g.solo("refs/heads/a", click);
  click.state.open = false;
  await settleLog(g);
  expect(g.error).toBeNull();
  expect(g.commits.map((c: any) => c.sha)).toEqual(["a1"]);
});

test("soloing several branches walks all of them, and Stop Soloing brings the rest back", async () => {
  const seen: any[] = [];
  const g: any = new Graph({ logPage: async (_r: string, _s: number, _o: any, _n: number, refs: any) => { seen.push(refs); return []; } }, () => ({ dir: null, on: null }), { scroll_to_item() {} });
  g.info = { root: "/r", heads: [{ name: "a", sha: "a1" }, { name: "b", sha: "b1" }], remotes: [], tags: [], stashes: [], worktrees: [], bySha: new Map() };
  const click = soloClick();
  g.solo("refs/heads/a", click); await new Promise((r) => setTimeout(r, 5));
  g.solo("refs/heads/b", click); await new Promise((r) => setTimeout(r, 5));
  expect(seen.at(-1).solo).toEqual(["refs/heads/a", "refs/heads/b"]);
  expect(g.visibleRefs()).toEqual({ shown: 2, all: 2 });
  g.solo("refs/heads/a", click); await new Promise((r) => setTimeout(r, 5));
  expect(seen.at(-1).solo).toEqual(["refs/heads/b"]);
  g.stopSolo(click); await new Promise((r) => setTimeout(r, 5));
  expect(seen.at(-1).solo).toEqual([]);
});
