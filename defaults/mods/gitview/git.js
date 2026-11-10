// The one place this mod talks to git. Both views read a folder through createReader(), so they
// always agree and neither runs its own git. Everything here only reads: no fetch, checkout, stash,
// reset or write, because these folders belong to people and agents working in them.
import { prsByBranch, catalogUrl } from "./refmenu.js";

// No optional locks, no fsmonitor cookie, no index refresh: a read must write nothing under .git,
// or a folder watch would see it and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const LISTED = 1000;
const DIFF_LINES = 1500;

const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const letter = (xy) => xy.includes("U") || xy === "AA" || xy === "DD" ? "U" : xy.includes("D") ? "D" : xy === "??" || xy.includes("A") ? "A" : "M";

// `status --porcelain=v2 --branch -z`: header lines start with "#", then one entry per file.
function parseStatus(text) {
  const head = { oid: null, branch: null, upstream: null, ab: null }, files = [];
  let total = 0;
  for (const entry of text.split("\0")) {
    if (!entry) continue;
    if (entry.startsWith("# ")) {
      if (entry.startsWith("# branch.oid ")) head.oid = entry.slice(13);
      else if (entry.startsWith("# branch.head ")) head.branch = entry.slice(14);
      else if (entry.startsWith("# branch.upstream ")) head.upstream = entry.slice(18);
      else if (entry.startsWith("# branch.ab ")) {
        const [a, b] = entry.slice(12).split(" ");
        head.ab = { ahead: Math.abs(parseInt(a, 10)) || 0, behind: Math.abs(parseInt(b, 10)) || 0 };
      }
      continue;
    }
    total++;
    if (files.length >= LISTED) continue;
    const kind = entry[0];
    if (kind === "?") files.push({ path: entry.slice(2), status: "A", fresh: true });
    else if (kind === "1" || kind === "u") {
      // "1 XY sub mH mI mW hH hI path" has 8 fields before the path, "u ..." (unmerged) has 10.
      const fields = kind === "1" ? 8 : 10, parts = entry.split(" ");
      files.push({ path: parts.slice(fields).join(" "), status: letter(parts[1]), fresh: false });
    }
  }
  return { head, files, total };
}

function parseStats(results) {
  const stats = {};
  for (const result of results) {
    if (result.code !== 0) continue;
    for (const entry of result.stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}

// `diff --name-status -z`: status, path, status, path...
function parseNameStatus(text) {
  const parts = text.split("\0").filter(Boolean), files = [];
  let total = 0;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    total++;
    if (files.length < LISTED) files.push({ path: parts[i + 1], status: letter(parts[i]) });
  }
  return { files, total };
}

// "refs/remotes/origin/HEAD<tab>refs/remotes/origin/master" and the plain refs that exist.
function pickBase(text) {
  const refs = new Map(text.split("\n").filter(Boolean).map((line) => line.split("\t")));
  const symref = refs.get("refs/remotes/origin/HEAD");
  if (symref?.startsWith("refs/remotes/")) return symref.slice(13);
  if (refs.has("refs/remotes/origin/master")) return "origin/master";
  if (refs.has("refs/remotes/origin/main")) return "origin/main";
  return null;
}

// Numbers each diff line once, so a frame only draws the rows on screen.
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old, old: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next, next: next++, text: line.slice(1) || " " };
    if (kind === " ") return { kind, number: next, old: old++, next: next++, text: line.slice(1) || " " };
    return { kind: "", text: line };
  });
}

/** The hunks of one file's `git diff` output as display lines, cut to what the pane keeps. */
function diffBody(all, file, full) {
  const first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return { lines: [file.binary ? "Binary file changed" : "No text diff available"] };
  while (all.length && all[all.length - 1] === "") all.pop();
  const lines = all.slice(first), limit = full ? FULL_FILE_LINES : DIFF_LINES;
  return { lines: lines.slice(0, limit).map((line) => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line), cut: lines.length > limit };
}

const clip = (lines) => lines.slice(0, DIFF_LINES).map((line) => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FULL_FILE_LINES = 6000;

/** `for-each-ref` with %(refname) %(objectname) %(*objectname), NUL-separated: local, remote and tag refs, tags peeled to their commit. */
export function parseRefs(text) {
  const heads = [], remotes = [], tags = [], bySha = new Map();
  const put = (sha, kind, name) => {
    let at = bySha.get(sha);
    if (!at) bySha.set(sha, at = { heads: [], remotes: [], tags: [] });
    at[kind].push(name);
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [ref, sha, peeled] = line.split("\0"), target = peeled || sha;
    if (ref.startsWith("refs/heads/")) { const name = ref.slice(11); heads.push({ name, sha }); put(sha, "heads", name); }
    else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice(13);
      if (name.endsWith("/HEAD")) continue;
      remotes.push({ name, sha }); put(sha, "remotes", name);
    } else if (ref.startsWith("refs/tags/")) { const name = ref.slice(10); tags.push({ name, sha: target }); put(target, "tags", name); }
  }
  return { heads, remotes, tags, bySha };
}

/** `log --format=%H %P %an %ct %s %b` with unit separators and a record separator after each commit. */
export function parseLog(text) {
  const commits = [];
  for (const record of text.split("\x1e")) {
    const [sha, parents, author, time, subject, body] = record.replace(/^\n/, "").split("\x1f");
    if (!sha || sha.length < 40) continue;
    commits.push({ sha, parents: parents ? parents.split(" ") : [], author, time: Number(time) * 1000, subject, body: (body ?? "").replace(/\s+/g, " ").trim().slice(0, 300) });
  }
  return commits;
}

/** `worktree list --porcelain`: one block per checkout. */
export function parseWorktrees(text) {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const w = { path: "", sha: null, branch: null, detached: false, bare: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) w.path = line.slice(9);
      else if (line.startsWith("HEAD ")) w.sha = line.slice(5);
      else if (line.startsWith("branch ")) w.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") w.detached = true;
      else if (line === "bare") w.bare = true;
    }
    return w;
  }).filter((w) => w.path);
}

/** `stash list --format=%gd %H %ct %P %gs` joined by unit separators: a stash's first parent is the commit it was made on. */
export function parseStashes(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [name, sha, time, parents, subject] = line.split("\x1f");
    return { name, sha, time: Number(time) * 1000, base: parents.split(" ")[0] || null, subject };
  });
}

/** `for-each-ref --format=%(refname) %(ahead-behind:<base>)`. */
export function parseAheadBehind(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    const behind = Number(parts.pop()), ahead = Number(parts.pop());
    out.set(parts.join(" ").replace(/^refs\/heads\//, ""), { ahead, behind });
  }
  return out;
}

/**
 * `for-each-ref --format=%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track,nobracket)` of refs/heads:
 * for each branch whose upstream is the remote branch of the same name, the commits it has and that remote branch lacks (`ahead`) or the other way (`behind`).
 * A branch cut from origin/master has that upstream, and pushing to it would push to master, so it is left out.
 * `tips` maps "<remote>/<branch>" to the sha the remote branch was last fetched at.
 */
export function parsePushStates(text, tips) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const [name, remote, ref, track] = line.split("\0");
    if (!name || !remote || remote === "." || !ref?.startsWith("refs/heads/") || track === "gone") continue;
    const tip = ref.slice(11) === name ? tips.get(`${remote}/${name}`) : null;
    if (tip) out.set(name, { remote, tip, ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0) });
  }
  return out;
}

/** `for-each-ref` output of the same format as parsePushStates: the remote branch each local branch pulls from, whatever its name. */
export function parseUpstreams(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const [name, remote, ref, track] = line.split("\0");
    if (name && remote && remote !== "." && ref?.startsWith("refs/heads/") && track !== "gone") out.set(name, { remote, branch: ref.slice(11) });
  }
  return out;
}

const escapeGlob = (name) => name.replace(/[\\*?[\]]/g, "\\$&");

/**
 * The ref arguments of a log: every branch, remote branch and tag unless some are hidden, or only the soloed refs.
 * Refs are full names. git applies each --exclude to the next --branches, --remotes or --tags only, and matches it
 * without that option's refs/<kind>/ prefix. `extra` are commits to walk as well: the ones stashes were made on.
 */
export function refArgs({ hidden = [], solo = [], remotes = true, tags = true, extra = [] } = {}) {
  if (solo.length) return solo;
  const args = [];
  for (const [prefix, option] of [["refs/heads/", "--branches"], ["refs/remotes/", "--remotes"], ["refs/tags/", "--tags"]]) {
    if ((prefix === "refs/remotes/" && !remotes) || (prefix === "refs/tags/" && !tags)) continue;
    for (const ref of hidden) if (ref.startsWith(prefix)) args.push(`--exclude=${escapeGlob(ref.slice(prefix.length))}`);
    args.push(option);
  }
  return [...args, "HEAD", ...extra];
}

/**
 * @param {{ exec: Function, readTextFile?: Function }} host herdr's `exec` and `readTextFile`.
 * `read(folder, on, { files })` resolves with one snapshot of the repo holding `folder`:
 *   { ok: false, reason } when it is not a repo, else
 *   { ok: true, root, branch (null when detached), detached, sha, base, ahead, behind, upstream, remote,
 *     pushed: "pushed" | "unpushed" | "none", unpushedCommits, uncommitted, uncommittedTotal,
 *     unpushed, unpushedTotal, latest: { sha, subject, time } | null }
 * ahead and behind count commits against `base` (origin's default branch); `remote` is the ref the
 * branch is compared with for "unpushed" (its upstream, else origin/<branch> when that exists).
 * `files: false` skips the per-file numbers the overview does not draw.
 */
export function createReader({ exec, readTextFile }) {
  const git = (root, on, args, timeout = 15000) => exec("git", [...READ, ...args], { cwd: root, on, timeout });

  async function read(folder, on, { files = true, untracked = true } = {}) {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
    if (top.code !== 0) return { ok: false, reason: "Not a git repository" };
    const root = top.stdout.trim();
    // The line counts do not depend on the status, and the status is the slow one, so they run beside it.
    const [status, refs, log, numstat] = await Promise.all([
      git(root, on, ["status", "--porcelain=v2", "--branch", "-z", "--no-renames", untracked ? "--untracked-files=all" : "--untracked-files=no"]),
      git(root, on, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes/origin/HEAD", "refs/remotes/origin/master", "refs/remotes/origin/main"]),
      git(root, on, ["log", "-1", "--format=%H%x1f%s%x1f%ct"]),
      files ? git(root, on, ["diff", "HEAD", "--numstat", "-z", "--no-renames"], 20000) : null,
    ]);
    if (status.code !== 0) return { ok: false, reason: status.stderr.trim() || "git status failed" };
    const { head, files: dirty, total: dirtyTotal } = parseStatus(status.stdout);
    const hasHead = log.code === 0 && log.stdout.trim() !== "";
    const detached = head.branch === "(detached)", branch = detached ? null : head.branch;
    const base = refs.code === 0 ? pickBase(refs.stdout) : null;
    const upstream = head.upstream;

    let remote = upstream;
    if (!remote && branch && hasHead) {
      const sibling = await git(root, on, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
      if (sibling.code === 0) remote = `origin/${branch}`;
    }
    const compare = remote ?? base;
    const [counts, committed] = await Promise.all([
      hasHead && base ? git(root, on, ["rev-list", "--left-right", "--count", `${base}...HEAD`]) : null,
      hasHead && compare ? git(root, on, ["diff", "--name-status", "-z", "--no-renames", `${compare}...HEAD`]) : null,
    ]);
    const stats = numstat && hasHead && dirtyTotal <= LISTED ? parseStats([numstat]) : {};
    const [latestSha, subject, time] = hasHead ? log.stdout.trim().split("\x1f") : [];
    const [behind, ahead] = counts?.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
    const unpushed = committed?.code === 0 ? parseNameStatus(committed.stdout) : { files: [], total: 0 };

    // The upstream's own ahead count is exact; for a sibling ref the committed diff is the best we have.
    const upstreamAhead = head.ab ? head.ab.ahead : null;
    let pushed = "none";
    if (remote) pushed = (upstreamAhead ?? (unpushed.total > 0 ? 1 : 0)) > 0 ? "unpushed" : "pushed";
    return {
      ok: true, root, branch, detached, sha: hasHead ? latestSha : null, base, ahead, behind, upstream, remote, pushed,
      unpushedCommits: upstreamAhead,
      uncommitted: dirty.map((file) => ({ ...file, add: 0, del: 0, ...stats[file.path] })), uncommittedTotal: dirtyTotal,
      unpushed: unpushed.files, unpushedTotal: unpushed.total,
      latest: hasHead ? { sha: latestSha, subject, time: Number(time) * 1000 } : null,
      hasHead,
    };
  }

  /** The diff of one listed file as display lines. `section`: "uncommitted" or "unpushed". */
  async function diff(snapshot, file, section, on, { full = false } = {}) {
    const { root } = snapshot;
    if (section === "uncommitted" && (file.fresh || !snapshot.hasHead)) {
      const text = readTextFile ? await readTextFile(`${root}/${file.path}`, { on }).catch(() => null) : null;
      if (text === null) return { lines: ["Cannot preview this file (binary, too large, or unreadable)"] };
      if (text.includes("\0")) return { lines: ["Binary file · no text diff"] };
      const add = countLines(text);
      return { add, lines: clip([`@@ -0,0 +1,${add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, DIFF_LINES).map((l) => `+${l}`)]) };
    }
    const range = section === "uncommitted" ? ["HEAD"] : [`${snapshot.remote ?? snapshot.base}...HEAD`];
    const r = await git(root, on, ["diff", full ? "-U100000" : "-U3", ...range, "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path]);
    if (r.code !== 0) throw new Error(r.stderr);
    return diffBody(r.stdout.replace(/\n$/, "").split("\n"), file, full);
  }

  /** What the graph view starts from: the repo holding `folder`, its checkouts, refs and stashes. */
  async function repo(folder, on) {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
    if (top.code !== 0) return { ok: false, reason: "Not a git repository" };
    const root = top.stdout.trim();
    const [worktrees, refs, stashes, head, base] = await Promise.all([
      git(root, on, ["worktree", "list", "--porcelain"]),
      git(root, on, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"], 30000),
      git(root, on, ["stash", "list", "--format=%gd%x1f%H%x1f%ct%x1f%P%x1f%gs"]),
      git(root, on, ["rev-parse", "HEAD"]),
      git(root, on, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes/origin/HEAD", "refs/remotes/origin/master", "refs/remotes/origin/main"]),
    ]);
    if (refs.code !== 0) return { ok: false, reason: refs.stderr.trim() || "git for-each-ref failed" };
    return {
      ok: true, root, head: head.code === 0 ? head.stdout.trim() : null, base: base.code === 0 ? pickBase(base.stdout) : null,
      worktrees: worktrees.code === 0 ? parseWorktrees(worktrees.stdout) : [],
      stashes: stashes.code === 0 ? parseStashes(stashes.stdout) : [],
      ...parseRefs(refs.stdout),
    };
  }

  /** Commits ahead of and behind `base` for every local branch. Slow on thousands of branches, so it is its own call. */
  async function aheadBehind(root, base, on) {
    if (!base) return new Map();
    const r = await git(root, on, ["for-each-ref", `--format=%(refname) %(ahead-behind:${base})`, "refs/heads"], 60000);
    return r.code === 0 ? parseAheadBehind(r.stdout) : new Map();
  }

  /**
   * What each local branch has that its remote branch lacks, by branch name. A branch without an upstream is paired with
   * origin/<name> when that exists and the branch is in `unpaired` (the ones with a pull request), which costs one git call each.
   */
  async function pushStates(root, on, remotes, unpaired = []) {
    const tips = new Map(remotes.map((r) => [r.name, r.sha]));
    const r = await git(root, on, ["for-each-ref", "--format=%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track,nobracket)", "refs/heads"], 30000);
    const states = r.code === 0 ? parsePushStates(r.stdout, tips) : new Map();
    await Promise.all(unpaired.filter((name) => !states.has(name) && tips.has(`origin/${name}`)).map(async (name) => {
      const counts = await git(root, on, ["rev-list", "--left-right", "--count", `refs/heads/${name}...refs/remotes/origin/${name}`]);
      if (counts.code !== 0) return;
      const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
      states.set(name, { remote: "origin", tip: tips.get(`origin/${name}`), ahead, behind });
    }));
    return states;
  }

  /** The upstream of every local branch that has a remote one, by branch name. */
  async function upstreams(root, on) {
    const r = await git(root, on, ["for-each-ref", "--format=%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track,nobracket)", "refs/heads"], 30000);
    return r.code === 0 ? parseUpstreams(r.stdout) : new Map();
  }

  /** One page of the log over every branch, remote branch, tag and HEAD (not the stash, which is drawn in its own section), parents after children. `skip` is the commits already loaded. */
  async function logPage(root, skip, on, size, refs) {
    const r = await git(root, on, ["log", ...refArgs(refs), "--topo-order", "--format=%H%x1f%P%x1f%an%x1f%ct%x1f%s%x1f%b%x1e", `--skip=${skip}`, `-n${size}`], 60000);
    if (r.code !== 0) throw new Error(r.stderr);
    return parseLog(r.stdout);
  }

  /** The commits whose message, author or a changed file's path contain `text` (case-insensitive), at most 5000 of each kind. */
  async function search(root, text, on, refs) {
    const base = ["log", ...refArgs(refs), "--format=%H", "-n5000", "-i"];
    const needle = escapeGlob(text);
    const runs = await Promise.all([
      git(root, on, [...base, "--fixed-strings", `--grep=${text}`], 60000),
      git(root, on, [...base, "--fixed-strings", `--author=${text}`], 60000),
      git(root, on, [...base, "--", `:(icase,glob)**/*${needle}*`], 60000),
    ]);
    const shas = new Set();
    for (const r of runs) if (r.code === 0) for (const sha of r.stdout.split("\n")) if (sha) shas.add(sha);
    return shas;
  }

  /**
   * A commit's message, author and changed files (against its first parent, or the empty tree for a root commit).
   * `parents` are the commit's parents when the caller already has them: the message and both file lists then start
   * together instead of the lists waiting for the message. The result is ready once the file list is, with every
   * file's add and del at 0; `stats` resolves after the line counts, which the slow numstat computes, are filled in.
   */
  async function commit(root, sha, on, parents) {
    const meta = git(root, on, ["log", "-1", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%B", sha]);
    const listFiles = (from) => {
      const names = git(root, on, ["diff", "--name-status", "-z", "--no-renames", from, sha]);
      names.catch(() => null);
      // The counts are a bonus: a failed numstat leaves the files at 0.
      return [names, git(root, on, ["diff", "--numstat", "-z", "--no-renames", from, sha], 30000).catch(() => ({ code: -1 }))];
    };
    let lists = parents ? listFiles(parents[0] ?? EMPTY_TREE) : null;
    const head = await meta;
    if (head.code !== 0) throw new Error(head.stderr);
    const [hash, parentList, author, email, time, committed, ...message] = head.stdout.split("\x1f");
    const parent = parentList ? parentList.split(" ") : [], from = parent[0] ?? EMPTY_TREE;
    lists ??= listFiles(from);
    const names = await lists[0];
    const listed = names.code === 0 ? parseNameStatus(names.stdout) : { files: [], total: 0 };
    const files = listed.files.map((f) => ({ ...f, add: 0, del: 0 }));
    const byPath = new Map(files.map((f) => [f.path, f]));
    const stats = lists[1].then((numstat) => {
      if (numstat.code !== 0) return;
      for (const [path, stat] of Object.entries(parseStats([numstat]))) Object.assign(byPath.get(path) ?? {}, stat);
    });
    return { sha: hash, parents: parent, from, author, email, time: Number(time) * 1000, committed: Number(committed) * 1000, message: message.join("\x1f").trim(), files, total: listed.total, stats };
  }

  /** One file's change in a commit as display lines. `full` keeps the whole file, not just the hunks. */
  async function fileDiff(detail, file, on, root, { full = false } = {}) {
    const r = await git(root, on, ["diff", full ? "-U100000" : "-U3", "--no-ext-diff", "--no-textconv", "--no-color", detail.from, detail.sha, "--", file.path]);
    if (r.code !== 0) throw new Error(r.stderr);
    return diffBody(r.stdout.replace(/\n$/, "").split("\n"), file, full);
  }

  /**
   * The diffs of several files from one git run, as a Map of path to what diff() or fileDiff() resolve with. `range` is the
   * revisions to compare, with the working copy when it is just ["HEAD"]. A file git quotes in its header is left out of the Map.
   */
  async function diffBatch(root, on, range, files, { full = false } = {}) {
    const r = await git(root, on, ["-c", "core.quotePath=false", "diff", full ? "-U100000" : "-U3", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", ...range, "--", ...files.map((f) => f.path)], 30000);
    if (r.code !== 0) throw new Error(r.stderr);
    const byPath = new Map(files.map((f) => [f.path, f])), out = new Map();
    let path = null, block = [];
    const flush = () => { if (path !== null && byPath.has(path)) out.set(path, diffBody(block, byPath.get(path), full)); };
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("diff --git ")) {
        flush();
        // "a/P b/P": both sides are the same path without renames, so the path is the middle of the line.
        const rest = line.slice(11), size = (rest.length - 5) / 2;
        path = Number.isInteger(size) && rest.startsWith("a/") ? rest.slice(2, 2 + size) : null;
        block = [];
      } else block.push(line);
    }
    flush();
    return out;
  }

  /**
   * Everything the poll compares to see whether refs, stashes or checkouts moved, as one string that is equal while
   * nothing did. It skips the tags' names and what repo() peels, so a poll is a fraction of a repo() read and parses nothing.
   */
  async function probe(root, on) {
    const [refs, tags, stashes, worktrees, head] = await Promise.all([
      git(root, on, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes"], 30000),
      git(root, on, ["for-each-ref", "--format=.", "refs/tags"], 30000),
      git(root, on, ["stash", "list", "--format=%H"]),
      git(root, on, ["worktree", "list", "--porcelain"]),
      git(root, on, ["rev-parse", "HEAD"]),
    ]);
    return refs.code === 0 && tags.code === 0 ? [refs, tags, stashes, worktrees, head].map((r) => r.stdout).join("\0") : null;
  }

  /** How many commits of the local `branch` are not in `base`, or null when git cannot say. */
  async function unmerged(root, on, branch, base) {
    if (!base) return null;
    const r = await git(root, on, ["rev-list", "--count", `${base}..refs/heads/${branch}`]);
    return r.code === 0 ? Number(r.stdout.trim()) : null;
  }

  /** The URL of origin, or null. */
  async function remoteUrl(root, on) {
    const r = await git(root, on, ["config", "--get", "remote.origin.url"]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /**
   * The pull request of each branch, from `gh`: every open one, and the latest of any state. gh is not git but asks about the
   * same folder, and the network, so callers keep the answer and never wait on it. Rejects when gh cannot answer at all.
   */
  async function pullRequests(root, on) {
    const list = (state, limit) => exec("gh", ["pr", "list", "--state", state, "--limit", String(limit), "--json", "headRefName,number,url,state,isDraft"], { cwd: root, on, timeout: 30000 });
    const answers = (await Promise.all([list("open", 300), list("all", 150)])).filter((r) => r.code === 0);
    if (!answers.length) throw new Error("gh pr list failed");
    return prsByBranch(...answers.map((r) => JSON.parse(r.stdout || "[]")));
  }

  /** Whether Firstmate's catalog has a card for the branch: its /branch page redirects when it does. Always asks this machine. */
  async function hasCard(branch) {
    const r = await exec("curl", ["-s", "-o", "/dev/null", "-m", "3", "-w", "%{http_code}", catalogUrl(branch)], { timeout: 5000 });
    return r.code === 0 && r.stdout.trim() === "302";
  }

  /** The folders directly under `dir` that hold a git checkout, by name. */
  async function clones(dir, on) {
    const r = await exec("sh", ["-c", 'for d in "$1"/*/; do [ -e "${d}.git" ] && basename "$d"; done; true', "sh", dir], { on, timeout: 5000 });
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  }

  return { read, diff, diffBatch, repo, probe, aheadBehind, pushStates, upstreams, logPage, commit, fileDiff, search, clones, remoteUrl, pullRequests, hasCard, unmerged };
}
