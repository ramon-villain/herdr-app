// The one place this mod talks to git. Both views read a folder through createReader(), so they
// always agree and neither runs its own git. Everything here only reads: no fetch, checkout, stash,
// reset or write, because these folders belong to people and agents working in them.

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

  async function read(folder, on, { files = true } = {}) {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
    if (top.code !== 0) return { ok: false, reason: "Not a git repository" };
    const root = top.stdout.trim();
    const [status, refs, log] = await Promise.all([
      git(root, on, ["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=all"]),
      git(root, on, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes/origin/HEAD", "refs/remotes/origin/master", "refs/remotes/origin/main"]),
      git(root, on, ["log", "-1", "--format=%H%x1f%s%x1f%ct"]),
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
    const [counts, committed, numstat] = await Promise.all([
      hasHead && base ? git(root, on, ["rev-list", "--left-right", "--count", `${base}...HEAD`]) : null,
      hasHead && compare ? git(root, on, ["diff", "--name-status", "-z", "--no-renames", `${compare}...HEAD`]) : null,
      files && hasHead && dirtyTotal <= LISTED ? git(root, on, ["diff", "HEAD", "--numstat", "-z", "--no-renames"], 20000) : null,
    ]);
    const stats = numstat ? parseStats([numstat]) : {};
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
  async function diff(snapshot, file, section, on) {
    const { root } = snapshot;
    if (section === "uncommitted" && (file.fresh || !snapshot.hasHead)) {
      const text = readTextFile ? await readTextFile(`${root}/${file.path}`, { on }).catch(() => null) : null;
      if (text === null) return { lines: ["Cannot preview this file (binary, too large, or unreadable)"] };
      if (text.includes("\0")) return { lines: ["Binary file · no text diff"] };
      const add = countLines(text);
      return { add, lines: clip([`@@ -0,0 +1,${add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, DIFF_LINES).map((l) => `+${l}`)]) };
    }
    const range = section === "uncommitted" ? ["HEAD"] : [`${snapshot.remote ?? snapshot.base}...HEAD`];
    const r = await git(root, on, ["diff", ...range, "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path]);
    if (r.code !== 0) throw new Error(r.stderr);
    const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    return { lines: first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : clip(all.slice(first)) };
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

  /** A commit's message, author and changed files (against its first parent, or the empty tree for a root commit). */
  async function commit(root, sha, on) {
    const meta = await git(root, on, ["log", "-1", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B", sha]);
    if (meta.code !== 0) throw new Error(meta.stderr);
    const [hash, parents, author, email, time, ...message] = meta.stdout.split("\x1f");
    const parent = parents ? parents.split(" ") : [], from = parent[0] ?? EMPTY_TREE;
    const [names, numstat] = await Promise.all([
      git(root, on, ["diff", "--name-status", "-z", "--no-renames", from, sha]),
      git(root, on, ["diff", "--numstat", "-z", "--no-renames", from, sha], 30000),
    ]);
    const stats = numstat.code === 0 ? parseStats([numstat]) : {};
    const listed = names.code === 0 ? parseNameStatus(names.stdout) : { files: [], total: 0 };
    return {
      sha: hash, parents: parent, from, author, email, time: Number(time) * 1000, message: message.join("\x1f").trim(),
      files: listed.files.map((f) => ({ ...f, add: 0, del: 0, ...stats[f.path] })), total: listed.total,
    };
  }

  /** One file's change in a commit as display lines. `full` keeps the whole file, not just the hunks. */
  async function fileDiff(detail, file, on, root, { full = false } = {}) {
    const r = await git(root, on, ["diff", full ? "-U100000" : "-U3", "--no-ext-diff", "--no-textconv", "--no-color", detail.from, detail.sha, "--", file.path]);
    if (r.code !== 0) throw new Error(r.stderr);
    const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    if (first < 0) return { lines: [file.binary ? "Binary file changed" : "No text diff available"] };
    const lines = all.slice(first), limit = full ? FULL_FILE_LINES : DIFF_LINES;
    return { lines: lines.slice(0, limit).map((line) => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line), cut: lines.length > limit };
  }

  return { read, diff, repo, aheadBehind, logPage, commit, fileDiff, search };
}
