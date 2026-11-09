import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore: the mod is plain JS
import { webUrl, commitUrl, compareUrl, branchOf, prsByBranch, menuEntries } from "../defaults/mods/gitview/refmenu.js";
// @ts-ignore
import { noteBody, lineRanges, selectedText, NOTE_TAG } from "../defaults/mods/gitview/note.js";
// @ts-ignore
import { createActions } from "../defaults/mods/gitview/actions.js";
// @ts-ignore
import { createReader, diffRows } from "../defaults/mods/gitview/git.js";
// @ts-ignore
import { Graph } from "../defaults/mods/gitview/graph.js";
// @ts-ignore
import { menuHeight, menuKey } from "../defaults/mods/gitview/refmenu.js";

const scratch: string[] = [];
afterAll(async () => { for (const dir of scratch) await rm(dir, { recursive: true, force: true }); });

/** A folder with fake programs on a PATH of their own: each one logs its arguments to `calls` and prints what the test gave it. */
async function fakes(programs: Record<string, { out?: string; code?: number }>) {
  const dir = await mkdtemp(join(tmpdir(), "refmenu-"));
  scratch.push(dir);
  const bin = join(dir, "bin"), calls = join(dir, "calls");
  await mkdir(bin);
  for (const [name, { out = "", code = 0 }] of Object.entries(programs)) {
    await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${calls}"\nprintf '%s' '${out}'\nexit ${code}\n`);
    await chmod(join(bin, name), 0o755);
  }
  const exec = async (command: string, args: string[] = [], options: { cwd?: string; env?: Record<string, string> } = {}) => {
    const p = Bun.spawn([command, ...args], { cwd: options.cwd, stdout: "pipe", stderr: "pipe", env: { PATH: `${bin}:/usr/bin:/bin`, ...options.env } });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { dir, exec, calls: async () => (existsSync(calls) ? (await readFile(calls, "utf8")).split("\n").filter(Boolean) : []) };
}

// ---- where a branch lives

test("origin URLs of every shape point at the repository's page on GitHub, and other hosts at nothing", () => {
  const web = "https://github.com/sensortower/overseer";
  for (const url of ["git@github.com:sensortower/overseer.git", "https://github.com/sensortower/overseer.git", "https://github.com/sensortower/overseer", "ssh://git@github.com/sensortower/overseer.git", "https://user@github.com/sensortower/overseer/", " git@github.com:sensortower/overseer.git\n"]) {
    expect(webUrl(url)).toBe(web);
  }
  expect(webUrl("git@gitlab.com:a/b.git")).toBeNull();
  expect(webUrl("https://github.com.evil.example/a/b")).toBeNull();
  expect(webUrl("/tmp/some/bare.git")).toBeNull();
  expect(webUrl(null)).toBeNull();
});

test("the compare page and the commit page encode what a branch name may contain", () => {
  const web = "https://github.com/o/r";
  expect(compareUrl(web, "master", "feat/a b#1")).toBe("https://github.com/o/r/compare/master...feat/a%20b%231?expand=1");
  expect(compareUrl(web, null, "feat/x")).toBe("https://github.com/o/r/compare/feat/x?expand=1");
  expect(commitUrl(web, "abc")).toBe("https://github.com/o/r/commit/abc");
  expect(branchOf({ type: "remote", name: "origin/feat/x" })).toBe("feat/x");
  expect(branchOf({ type: "branch", name: "feat/x" })).toBe("feat/x");
});

test("a branch's pull request is its open one, else the newest", () => {
  const pr = (n: number, state: string, head = "a") => ({ headRefName: head, number: n, state, url: `u${n}`, isDraft: false });
  const found = prsByBranch([pr(5, "MERGED"), pr(9, "CLOSED"), pr(2, "MERGED", "b")], [pr(7, "OPEN"), pr(5, "MERGED")]);
  expect(found.get("a")).toMatchObject({ number: 7, state: "OPEN" });
  expect(found.get("b")).toMatchObject({ number: 2 });
  expect(prsByBranch([pr(3, "CLOSED"), pr(8, "MERGED")]).get("a")).toMatchObject({ number: 8 });
});

// ---- what the menu offers

const labels = (rows: any[]) => rows.map((r) => (r ? r.label : "-"));

test("a branch without a pull request offers Push and create PR beside the copies, solo and hide", () => {
  const rows = menuEntries({ type: "branch", name: "feat/x", sha: "a".repeat(40), pr: null }, "https://github.com/o/r");
  expect(labels(rows)).toEqual(["Solo", "Hide", "-", "Copy branch name", "Copy commit sha", "Copy link to commit on origin", "Ask firstmate...", "-", "Push and create PR"]);
  expect(rows.map((r) => r?.id)).toContain("pushPr");
});

test("a branch with an open pull request offers to open it and nothing to create", () => {
  const rows = menuEntries({ type: "branch", name: "x", sha: "s", pr: { number: 12, state: "OPEN" }, solo: true, hidden: true }, "https://github.com/o/r");
  expect(labels(rows)).toEqual(["Unsolo", "Show", "-", "Copy branch name", "Copy commit sha", "Copy link to commit on origin", "Ask firstmate...", "-", "Open PR #12"]);
});

test("a closed pull request can be opened or replaced, a merged one only opened", () => {
  const web = "https://github.com/o/r";
  expect(labels(menuEntries({ type: "branch", name: "x", pr: { number: 4, state: "CLOSED" } }, web)).slice(-2)).toEqual(["Open PR #4 (closed)", "Push and create PR"]);
  expect(labels(menuEntries({ type: "branch", name: "x", pr: { number: 4, state: "MERGED" } }, web)).slice(-1)).toEqual(["Open PR #4 (merged)"]);
});

test("a remote branch is already pushed, so it only creates the PR; a tag has no PR rows", () => {
  const web = "https://github.com/o/r";
  expect(labels(menuEntries({ type: "remote", name: "origin/x", sha: "s", pr: null }, web)).slice(-1)).toEqual(["Create PR"]);
  const tag = menuEntries({ type: "tag", name: "v1", sha: "s" }, web);
  expect(labels(tag)).toEqual(["Solo", "Hide", "-", "Copy tag name", "Copy commit sha", "Copy link to commit on origin", "Ask firstmate..."]);
});

test("without a GitHub origin the menu has no link or PR rows, and without a sha no sha rows", () => {
  expect(labels(menuEntries({ type: "branch", name: "x", sha: "s", pr: null }, null))).toEqual(["Solo", "Hide", "-", "Copy branch name", "Copy commit sha", "Ask firstmate..."]);
  expect(labels(menuEntries({ type: "branch", name: "x" }, "https://github.com/o/r")).slice(3)).toEqual(["Copy branch name", "Ask firstmate...", "-", "Push and create PR"]);
});

test("the popup keys move over the actions and wrap, Enter returns the action, Esc closes", () => {
  const menu = { web: null, refs: [{ type: "branch", name: "x", sha: "s" }] };
  const state = { at: 0, ref: 0 };
  expect(menuKey(state, "down", menu)).toBe(true);
  expect(state.at).toBe(1);
  expect(menuKey(state, "enter", menu)).toMatchObject({ id: "hide" });
  menuKey(state, "up", menu); menuKey(state, "up", menu);
  expect(state.at).toBe(4);
  expect(menuKey(state, "escape", menu)).toBe("close");
  expect(menuKey(state, "x", menu)).toBe(false);
  expect(menuHeight(menu)).toBeGreaterThan(menuHeight({ web: null, refs: [{ type: "tag", name: "t" }] }) - 1);
});

// ---- pull requests from gh, kept by the graph

test("the reader asks gh for open and all pull requests in the repo's folder and merges them", async () => {
  const f = await fakes({ gh: { out: '[{"headRefName":"feat","number":3,"url":"https://github.com/o/r/pull/3","state":"OPEN","isDraft":false}]' } });
  const found = await createReader({ exec: f.exec }).pullRequests(f.dir, null);
  expect(found.get("feat")).toMatchObject({ number: 3, state: "OPEN" });
  const calls = await f.calls();
  expect(calls).toHaveLength(2);
  expect(calls.some((c) => c.includes("gh pr list --state open --limit 300"))).toBe(true);
  expect(calls.some((c) => c.includes("gh pr list --state all --limit 150"))).toBe(true);
});

test("a gh that fails rejects instead of answering with no pull requests", async () => {
  const f = await fakes({ gh: { code: 1 } });
  await expect(createReader({ exec: f.exec }).pullRequests(f.dir, null)).rejects.toThrow();
});

const graphWith = (reader: any) => {
  const g: any = new Graph(reader, () => ({ dir: "/r", on: null }), {});
  g.info = { root: "/r", base: "origin/master", heads: [], remotes: [], tags: [], worktrees: [], bySha: new Map() };
  return g;
};
const cx = { notify() {}, spawn(work: (cx: any) => Promise<void>) { work(cx); } };
const settle = () => new Promise((r) => setTimeout(r, 5));

test("the graph asks gh in the background, keeps the answer for two minutes, and backs off after a failure", async () => {
  let asked = 0, fail = false, resolve: (m: Map<string, any>) => void = () => {};
  const g = graphWith({ pullRequests: () => { asked++; return fail ? Promise.reject(new Error("no gh")) : new Promise((r) => { resolve = r as any; }); } });
  g.refreshPrs(cx);
  g.refreshPrs(cx);
  expect(asked).toBe(1);
  // the menu opens while gh is still answering, with no pull request to show
  expect(g.menuFor([{ type: "branch", name: "feat", sha: "s" }]).refs[0].pr).toBeNull();
  resolve(new Map([["feat", { number: 3, state: "OPEN", url: "u" }]]));
  await settle();
  expect(g.menuFor([{ type: "branch", name: "feat", sha: "s" }]).refs[0].pr).toMatchObject({ number: 3 });
  g.refreshPrs(cx);
  expect(asked).toBe(1);
  g.prs.tried -= 121000;
  fail = true;
  g.refreshPrs(cx);
  await settle();
  expect(asked).toBe(2);
  g.refreshPrs(cx);
  g.prs.tried -= 121000;
  g.refreshPrs(cx);
  expect(asked).toBe(2);
});

test("another repo's pull requests are not shown on this one", async () => {
  const g = graphWith({ pullRequests: async () => new Map([["feat", { number: 3, state: "OPEN" }]]) });
  g.refreshPrs(cx);
  await settle();
  g.info.root = "/other";
  expect(g.menuFor([{ type: "branch", name: "feat", sha: "s" }]).refs[0].pr).toBeNull();
});

test("the menu opens for a left-column branch with its state, and for a commit row with each label drawn on it", () => {
  const g = graphWith({});
  g.web = "https://github.com/o/r";
  g.hidden.add("refs/heads/a"); g.soloed.add("refs/heads/b");
  g.leftMap = new Map([["branch:a", { type: "branch", name: "a", sha: "s1" }], ["section:local", { type: "section" }], ["remote:origin/a", { type: "remote", name: "origin/a", sha: "s1" }]]);
  expect(g.menuLeft("branch:a")).toMatchObject({ web: g.web, base: "master", root: "/r", refs: [{ type: "branch", name: "a", ref: "refs/heads/a", hidden: true, solo: false }] });
  expect(g.menuLeft("section:local")).toBeNull();
  expect(g.menuLeft("missing")).toBeNull();
  g.info.bySha = new Map([["s1", { heads: ["a", "b"], remotes: ["origin/a"], tags: ["v1"] }]]);
  expect(g.menuRow("s1").refs.map((r: any) => r.name)).toEqual(["a", "b", "commit s1"]);
  expect(g.menuRow("b".repeat(40))).toBeNull();
  g.show = { remotes: true, tags: true };
  expect(g.menuRow("s1").refs.map((r: any) => [r.type, r.name, r.solo])).toEqual([["branch", "a", false], ["branch", "b", true], ["remote", "origin/a", false], ["tag", "v1", false], ["commit", "commit s1", false]]);
});

test("Ask firstmate on a branch or a commit files a note with the repo, the ref and the sha, and nothing is sent by building it", () => {
  const g = graphWith({});
  g.web = "https://github.com/o/r";
  g.commits = [{ sha: "a".repeat(40), subject: "fix: the thing" }]; g.index.set("a".repeat(40), 0);
  expect(g.askNote("x")).toBeNull();
  g.askAbout({ type: "branch", name: "feat/x", sha: "a".repeat(40) });
  expect(g.askNote("why is this slow?")).toBe([
    "[herdr] ask", "why is this slow?", "", "Repo: o/r (/r)", "Branch: feat/x", "Tip: aaaaaaaaaaa fix: the thing",
  ].join("\n"));
  g.askAbout({ type: "commit", name: "commit aaaaaaa", sha: "a".repeat(40) });
  expect(g.askNote("")).toBe(["[herdr] ask", "Look at this from the Herdr Git view.", "", "Repo: o/r (/r)", "Commit: aaaaaaaaaaa fix: the thing"].join("\n"));
  expect(labels(menuEntries({ type: "commit", name: "c", sha: "s" }, "https://github.com/o/r"))).toEqual(["Copy commit sha", "Copy link to commit on origin", "Ask firstmate..."]);
});

// ---- push and create PR: only on a click, through a fake git

function actionsOn(f: Awaited<ReturnType<typeof fakes>>) {
  const seen = { opened: [] as string[], copied: [] as string[], notes: [] as any[] };
  const actions = createActions({
    exec: (command: string, args: string[], options: any) => f.exec(command, args, options),
    openLink: (url: string) => seen.opened.push(url),
    copy: (text: string) => seen.copied.push(text),
    notify: (n: any) => seen.notes.push(n),
    inbox: join(f.dir, "bin", "fm-inbox.sh"),
  });
  return { actions, seen };
}

test("Push and create PR pushes the branch with its upstream and then opens GitHub's compare page", async () => {
  const f = await fakes({ git: {} });
  const { actions, seen } = actionsOn(f);
  expect(await actions.pushAndCompare({ root: f.dir, on: null, branch: "feat/x", web: "https://github.com/o/r", base: "master" })).toBe(true);
  expect(await f.calls()).toEqual(["git push -u origin feat/x"]);
  expect(seen.opened).toEqual(["https://github.com/o/r/compare/master...feat/x?expand=1"]);
});

test("a failed push opens nothing and says why", async () => {
  const f = await fakes({ git: { code: 1 } });
  const { actions, seen } = actionsOn(f);
  expect(await actions.pushAndCompare({ root: f.dir, on: null, branch: "feat/x", web: "https://github.com/o/r", base: "master" })).toBe(false);
  expect(seen.opened).toEqual([]);
  expect(seen.notes.at(-1)).toMatchObject({ level: "error", title: "Push of feat/x failed" });
});

test("copying puts the text on the clipboard and says what was copied", () => {
  const { actions, seen } = actionsOn({ dir: "/x" } as any);
  actions.copyText("feat/x", "branch name");
  actions.copyCommitLink("https://github.com/o/r", "abc");
  expect(seen.copied).toEqual(["feat/x", "https://github.com/o/r/commit/abc"]);
  expect(seen.notes.map((n: any) => n.title)).toEqual(["Copied branch name", "Copied link to the commit"]);
});

// ---- picking lines of a diff and sending them to firstmate

const rowsOf = (lines: string[]) => diffRows(lines);
const sample = rowsOf(["@@ -10,3 +10,4 @@", " keep", "-gone", "+new one", "+new two", " tail"]);

test("the line numbers of a pick are the new side's, with removed lines named on the old side", () => {
  expect(lineRanges(sample.slice(1, 5))).toEqual({ next: [10, 12], old: [11, 11] });
  expect(lineRanges([sample[2]])).toEqual({ next: null, old: [11, 11] });
  expect(lineRanges([sample[3]])).toEqual({ next: [11, 11], old: null });
  expect(lineRanges([sample[0]])).toEqual({ next: null, old: null });
});

test("the selection reads as in a diff and is cut when long", () => {
  expect(selectedText(sample.slice(0, 4))).toBe("@@ -10,3 +10,4 @@\n keep\n-gone\n+new one");
  const long = selectedText([{ kind: "+", next: 1, text: "x".repeat(5000) }]);
  expect(long.length).toBeLessThan(4100);
  expect(long).toEndWith("(cut: the selection is longer)");
});

test("the note names the repo, commit, file, lines and view, and quotes the selection like the extension's notes", () => {
  const body = noteBody({ message: "why is this here?", repo: { name: "o/r", root: "/p/r" }, commit: { sha: "a".repeat(40), subject: "feat: x" }, branches: ["master", "feat/x"], file: "src/a.ts", mode: "diff", rows: sample.slice(1, 4) });
  expect(body.split("\n")).toEqual([
    NOTE_TAG, "why is this here?", "",
    "Repo: o/r (/p/r)", `Commit: ${"a".repeat(11)} feat: x`, "Branch: master, feat/x", "File: src/a.ts", "Lines: 10-11 (new side), removed 11 (old side)", "View: Diff View",
    "Selection:", ">  keep", "> -gone", "> +new one",
  ]);
});

test("a pick in the working copy names its branch and no commit, and a note with no message still asks something", () => {
  const body = noteBody({ repo: { name: "r", root: "/r" }, commit: null, branches: ["wip"], file: "a.ts", mode: "file", rows: [{ kind: "+", next: 4, text: "x" }] });
  expect(body).toContain("Look at this selection from the Herdr Git view.");
  expect(body).toContain("Commit: uncommitted changes in the working copy");
  expect(body).toContain("Lines: 4\n");
  expect(body).toContain("View: File View");
});

function pickGraph() {
  const g: any = graphWith({});
  g.web = "https://github.com/o/r";
  g.info.bySha = new Map([["c".repeat(40), { heads: ["feat/x"], remotes: [], tags: [] }]]);
  g.info.worktrees = [{ path: "/r", branch: "wt" }]; g.worktree = "/r";
  g.detail = { sha: "c".repeat(40), message: "feat: x\n\nbody" };
  g.file = { path: "src/a.ts" }; g.mode = "diff";
  g.view = { rows: sample };
  return g;
}

test("clicking a line picks it, shift widens it, and clicking the lone pick again clears it", () => {
  const g = pickGraph();
  g.clickPick(2, false);
  expect(g.pick).toMatchObject({ from: 2, to: 2 });
  g.clickPick(4, true);
  expect([g.pick.from, g.pick.to]).toEqual([2, 4]);
  g.clickPick(1, true);
  expect([g.pick.from, g.pick.to]).toEqual([1, 2]);
  g.clickPick(5, false);
  expect([g.pick.from, g.pick.to]).toEqual([5, 5]);
  g.clickPick(5, false);
  expect(g.pick).toBeNull();
  expect([g.picked(5)]).toEqual([false]);
});

test("the graph builds the note from the picked rows and the commit on show", () => {
  const g = pickGraph();
  expect(g.pickNote("hi")).toBeNull();
  g.clickPick(3, false); g.clickPick(4, true);
  const body = g.pickNote("hi");
  expect(body).toContain("Repo: o/r (/r)");
  expect(body).toContain("Commit: ccccccccccc feat: x");
  expect(body).toContain("Branch: feat/x");
  expect(body).toContain("Lines: 11-12");
  expect(body).toContain("> +new one\n> +new two");
  g.detail = { wip: true, sha: null, message: "Uncommitted changes" };
  expect(g.pickNote("")).toContain("Branch: wt");
  expect(g.pickNote("")).toContain("uncommitted changes in the working copy");
});

test("changing file, view or repo drops the pick", async () => {
  const g = pickGraph();
  g.detail.files = [g.file];
  g.clickPick(1, false);
  g.setMode("file", cx);
  expect(g.pick).toBeNull();
  g.clickPick(1, false);
  g.closeFile(cx);
  expect(g.pick).toBeNull();
});

// ---- the send reaches the queue

test("sendNote files one note through fm-inbox.sh with a request id, so a retry replays", async () => {
  const f = await fakes({ "fm-inbox.sh": { out: "queued n123 for firstmate" } });
  const { actions, seen } = actionsOn(f);
  const id = await actions.sendNote("herdr-abc-123", "[herdr] ask\nline two\n- dash first");
  expect(id).toBe("n123");
  const calls = await readFile(join(f.dir, "calls"), "utf8");
  expect(calls).toContain("fm-inbox.sh note --request-id herdr-abc-123 -- [herdr] ask\nline two\n- dash first");
  expect(seen.notes.at(-1)).toMatchObject({ title: "Sent to firstmate", body: "n123" });
});

test("a queue that refuses the note raises, so the pick stays for another try", async () => {
  const f = await fakes({ "fm-inbox.sh": { out: "", code: 1 } });
  const { actions } = actionsOn(f);
  await expect(actions.sendNote("herdr-x", "body")).rejects.toThrow();
});

// The real fm-inbox.sh, writing into a scratch FM_HOME so the live inbox is never touched.
const REAL_INBOX = "/Volumes/Coding/firstmate/bin/fm-inbox.sh";
test.skipIf(!existsSync(REAL_INBOX))("a picked selection lands in a scratch FM_HOME's inbox as one note, and a retry replays it", async () => {
  const home = await mkdtemp(join(tmpdir(), "refmenu-fmhome-"));
  scratch.push(home);
  await mkdir(join(home, "state"), { recursive: true });
  const exec = async (command: string, args: string[] = []) => {
    const p = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", FM_HOME: home } });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, stdout, stderr };
  };
  const actions = createActions({ exec, openLink() {}, copy() {}, notify() {}, inbox: REAL_INBOX });
  const g = pickGraph();
  g.clickPick(3, false); g.clickPick(4, true);
  const body = g.pickNote("what does this do?");
  const id = await actions.sendNote("herdr-test-1", body);
  const again = await actions.sendNote("herdr-test-1", body);
  expect(again).toBe(id);
  const note = await readFile(join(home, "state", "inbox", `${id}.note`), "utf8");
  expect(note).toContain("[herdr] ask\nwhat does this do?");
  expect(note).toContain("File: src/a.ts");
  expect(note).toContain("> +new one\n> +new two");
});

test("a branch with commits its remote branch lacks offers Push, and a rebased one a Force push that needs confirming", () => {
  const web = "https://github.com/o/r";
  const ahead = menuEntries({ type: "branch", name: "x", sha: "s", pr: { number: 12, state: "OPEN" }, push: { remote: "origin", ahead: 2, behind: 0 } }, web);
  expect(labels(ahead).slice(-3)).toEqual(["-", "Push 2 commits to origin", "Open PR #12"]);
  expect(ahead.find((r: any) => r?.id === "push")).toBeTruthy();
  const rebased = menuEntries({ type: "branch", name: "x", sha: "s", pr: null, push: { remote: "origin", ahead: 1, behind: 3 } }, null);
  expect(labels(rebased).slice(-2)).toEqual(["-", "Force push (with lease)"]);
  const none = (push: any, type = "branch") => labels(menuEntries({ type, name: "x", sha: "s", push }, null)).join();
  expect(none({ remote: "origin", ahead: 0, behind: 2 })).not.toContain("push");
  expect(none(null)).not.toContain("push");
  expect(none({ remote: "origin", ahead: 1, behind: 0 }, "remote")).not.toContain("Push");
});
