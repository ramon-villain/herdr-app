// State and loading for the whole-tab Git graph. It only reads, through the shared reader in git.js.
import { layoutLanes } from "./lanes.js";
import { agoLabel, branchTree, fileTree, hunkStarts, markWords, stepHunk } from "./model.js";
import { diffRows } from "./git.js";

// Every page walks the whole history to sort it, whatever its size, so the first page is small for a quick first paint and later ones are big.
const FIRST_PAGE = 500;
const PAGE = 5000;
const MAX_REVEAL_PAGES = 40;
const LISTED = 3000;
const WORKTREE_READS = 3;

// A commit never changes, so what was read for it stays right until the cache drops it.
const KEPT_DETAILS = 40;
const KEPT_VIEWS = 16;
// Files of a selected commit whose diff is read before anyone asks, so the first click on one draws at once.
const PREFETCHED_FILES = 8;

// The left tree's big sections start closed: thousands of remote branches and tags are for searching, not scrolling.
const OPEN = { local: true, remote: false, worktrees: true, stashes: true, tags: false };

const refOf = { branch: (name) => `refs/heads/${name}`, remote: (name) => `refs/remotes/${name}`, tag: (name) => `refs/tags/${name}` };

const SHOW_KEY = "gitview.graph.show";

// Remote branches and tags are for looking things up, so the graph starts without them; the choice is kept.
function savedShow() {
  try { return { remotes: false, tags: false, ...JSON.parse(localStorage.getItem(SHOW_KEY) ?? "{}") }; } catch { return { remotes: false, tags: false }; }
}

export class Graph {
  /** @param {ReturnType<typeof import("./git.js").createReader>} git @param {() => { dir: string | null, on: string | null }} locate */
  constructor(git, locate, scroll) {
    this.git = git; this.locate = locate; this.scroll = scroll;
    this.info = null; this.error = null; this.loading = false; this.status = "";
    this.worktree = null; this.ab = new Map(); this.wt = new Map(); this.wipSnap = null;
    this.commits = []; this.rows = []; this.index = new Map(); this.carry = undefined; this.done = false; this.lastAgo = null; this.maxWidth = 1;
    this.selected = null; this.detail = null; this.detailError = null; this.panelOpen = true;
    this.file = null; this.view = null; this.mode = "diff"; this.hunkAt = -1;
    this.filter = ""; this.collapsed = new Set(); this.open = { ...OPEN };
    this.hidden = new Set(); this.soloed = new Set(); this.menu = null;
    this.query = ""; this.matches = null; this.onlyMatches = false; this.searching = false; this.hitAt = -1; this.hitCache = null; this.searchRun = 0;
    this.fileMode = "path"; this.wantMore = false; this.signature = null; this.leftCache = null;
    this.run = 0; this.picking = false;
    this.details = new Map(); this.views = new Map(); this.itemsCache = null; this.wipKey = null;
    this.show = savedShow(); this.loaded = 0; this.placed = new Set();
  }

  get on() { return this.where?.on ?? null; }
  get root() { return this.worktree ?? this.info?.root; }
  get refs() { return { hidden: [...this.hidden], solo: [...this.soloed], remotes: this.show.remotes, tags: this.show.tags, extra: (this.info?.stashes ?? []).map((st) => st.base).filter(Boolean) }; }

  /** Turns remote branches or tags in the graph on or off, and keeps the choice. */
  toggleShow(kind, cx) {
    this.show = { ...this.show, [kind]: !this.show[kind] };
    try { localStorage.setItem(SHOW_KEY, JSON.stringify(this.show)); } catch { /* storage can be unavailable */ }
    this.refsChanged(cx);
  }

  async load(cx) {
    const run = ++this.run;
    this.where = this.locate();
    if (!this.where.dir) { this.error = "No folder"; return; }
    this.loading = true; this.error = null; cx.notify();
    try {
      const dir = this.worktree ?? this.where.dir;
      const info = await this.git.repo(dir, this.on);
      if (run !== this.run) return;
      if (!info.ok) { this.error = info.reason; this.info = null; return; }
      this.info = info; this.leftCache = null;
      if (!this.worktree || !info.worktrees.some((w) => w.path === this.worktree)) this.worktree = info.worktrees.find((w) => info.root === w.path)?.path ?? info.root;
      // Not awaited: the first paint does not wait for it, and the poll skips its check until it is there.
      this.signature = null;
      this.git.probe(dir, this.on).then((signature) => { if (run === this.run) this.signature = signature; }).catch(() => null);
      this.reset();
      cx.notify();
      this.git.aheadBehind(info.root, info.base, this.on).then((ab) => { if (run === this.run) { this.ab = ab; this.leftCache = null; cx.notify(); } }).catch(() => null);
      this.loadWorktrees(run, cx);
      this.loadWip(cx);
      await this.page(run, cx);
    } catch (e) { if (run === this.run) this.error = String(e); } finally { if (run === this.run) { this.loading = false; cx.notify(); } }
  }

  reset() {
    this.commits = []; this.rows = []; this.index = new Map(); this.carry = undefined; this.done = false; this.lastAgo = null; this.maxWidth = 1;
    this.hitCache = null; this.loaded = 0; this.placed = new Set();
  }

  /** The history again for new hide or solo settings, without reading the repo's refs again. */
  async relog(cx) {
    const run = ++this.run;
    this.reset(); this.loading = true; cx.notify();
    try { await this.page(run, cx); } catch (e) { if (run === this.run) this.error = String(e); } finally { if (run === this.run) { this.loading = false; cx.notify(); } }
  }

  /** The timer's check: reload when a ref, a stash or a checkout moved, and refresh the uncommitted files of the shown copy. */
  async poll(cx) {
    if (this.loading || !this.info) return;
    const signature = await this.git.probe(this.root, this.on);
    if (signature !== null && this.signature !== null && signature !== this.signature) { this.load(cx); return; }
    await this.loadWip(cx);
  }

  async page(run, cx) {
    if (this.done) return;
    const size = this.loaded ? PAGE : FIRST_PAGE;
    const fetched = await this.git.logPage(this.info.root, this.loaded, this.on, size, this.refs);
    if (run !== this.run) return;
    if (fetched.length < size) this.done = true;
    this.loaded += fetched.length;
    const page = this.withStashes(fetched);
    const laid = layoutLanes(page, this.carry);
    this.carry = laid.carry;
    page.forEach((c, i) => {
      const label = agoLabel(c.time);
      this.index.set(c.sha, this.commits.length);
      this.commits.push(label !== this.lastAgo ? { ...c, marker: label } : c);
      this.lastAgo = label;
      this.rows.push(laid.rows[i]);
      if (laid.rows[i].width > this.maxWidth) this.maxWidth = laid.rows[i].width;
    });
    cx.notify();
  }

  /** Each stash becomes a node of its own just above the commit it was made on, with that commit as its only parent. */
  withStashes(page) {
    const stashes = this.info.stashes.filter((s) => s.base && !this.placed.has(s.sha));
    if (!stashes.length) return page;
    const bySha = new Map(page.map((c, i) => [c.sha, i])), at = new Map();
    for (const s of stashes) {
      const i = bySha.get(s.base);
      if (i === undefined) continue;
      this.placed.add(s.sha);
      at.set(i, [...(at.get(i) ?? []), { sha: s.sha, parents: [s.base], author: "", time: s.time, subject: s.subject, body: "", stash: s.name }]);
    }
    return page.flatMap((c, i) => [...(at.get(i) ?? []), c]);
  }

  more(cx) {
    this.wantMore = false;
    if (this.loading || this.done || !this.info) return;
    this.loading = true;
    const run = this.run;
    this.page(run, cx).catch((e) => { this.error = String(e); }).finally(() => { if (run === this.run) { this.loading = false; cx.notify(); } });
  }

  // ---- worktrees and the uncommitted row

  async loadWorktrees(run, cx) {
    const list = [...this.info.worktrees];
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const w = list[next++];
        const snap = await this.git.read(w.path, this.on, { files: false }).catch(() => null);
        if (run !== this.run) return;
        if (snap?.ok) { this.wt.set(w.path, { changed: snap.uncommittedTotal, ahead: snap.ahead, behind: snap.behind }); this.leftCache = null; cx.notify(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKTREE_READS, list.length) }, worker));
  }

  async loadWip(cx) {
    const path = this.root, run = this.run;
    const snap = await this.git.read(path, this.on, { files: true }).catch(() => null);
    if (run !== this.run || path !== this.root) return;
    const key = snap?.ok ? JSON.stringify([path, snap.sha, snap.ahead, snap.behind, snap.uncommittedTotal, snap.uncommitted]) : null;
    if (key !== null && key === this.wipKey) return;
    this.wipKey = key;
    this.wipSnap = snap?.ok && snap.uncommittedTotal > 0 ? snap : null;
    if (snap?.ok) this.wt.set(path, { changed: snap.uncommittedTotal, ahead: snap.ahead, behind: snap.behind });
    this.leftCache = null;
    if (this.selected === "wip") this.detail = this.wipDetail();
    cx.notify();
  }

  wipDetail() {
    const s = this.wipSnap;
    return s ? { wip: true, sha: null, parents: s.sha ? [s.sha] : [], from: "HEAD", author: "Working copy", time: Date.now(), message: "Uncommitted changes", files: s.uncommitted, total: s.uncommittedTotal } : null;
  }

  pickWorktree(path, cx) {
    this.picking = false;
    if (path !== this.worktree) {
      this.worktree = path; this.wipSnap = null; this.wipKey = null; this.leftCache = null;
      if (this.selected === "wip") { this.selected = null; this.detail = null; this.file = null; this.view = null; }
      this.loadWip(cx);
    }
    cx.notify();
  }

  /** The commit a worktree has checked out, for the HEAD marker. */
  headOf() {
    return this.info?.worktrees.find((w) => w.path === this.worktree)?.sha ?? this.info?.head ?? null;
  }

  // ---- the rows the list shows: the uncommitted row, then every commit or only the matches

  hits() {
    if (!this.matches) return null;
    if (this.hitCache?.n !== this.commits.length || this.hitCache.matches !== this.matches) {
      const q = this.query.toLowerCase(), list = [];
      this.commits.forEach((c, i) => { if (this.matches.has(c.sha) || (q.length >= 4 && c.sha.startsWith(q))) list.push(i); });
      this.hitCache = { n: this.commits.length, matches: this.matches, list, set: new Set(list) };
    }
    return this.hitCache;
  }

  get offset() { return this.wipSnap && !(this.onlyMatches && this.matches) ? 1 : 0; }
  count() { return this.offset + (this.onlyMatches && this.matches ? this.hits().list.length : this.commits.length); }
  /** The commit index shown at list position `k`, or -1 for the uncommitted row. */
  at(k) { return k < this.offset ? -1 : this.onlyMatches && this.matches ? this.hits().list[k - this.offset] : k - this.offset; }
  position(commit) { return this.offset + (this.onlyMatches && this.matches ? this.hits().list.indexOf(commit) : commit); }
  isHit(i) { return Boolean(this.matches) && this.hits().set.has(i); }

  // ---- selecting

  /** Clicking the selected row again closes the right panel to give the graph room. */
  select(key, cx) {
    if (this.selected === key) { this.panelOpen = !this.panelOpen; cx.notify(); return Promise.resolve(); }
    this.panelOpen = true;
    return key === "wip" ? this.selectWip(cx) : this.selectCommit(key, cx);
  }

  async selectWip(cx) {
    this.selected = "wip"; this.detail = this.wipDetail(); this.detailError = null; this.file = null; this.view = null;
    cx.notify();
  }

  async selectCommit(sha, cx) {
    this.selected = sha; this.detail = this.details.get(sha) ?? null; this.detailError = null; this.file = null; this.view = null;
    cx.notify();
    if (this.detail) { this.prefetch(this.detail, cx); return; }
    try {
      const detail = await this.git.commit(this.info.root, sha, this.on, this.commits[this.index.get(sha)]?.parents);
      keep(this.details, sha, detail, KEPT_DETAILS);
      if (this.selected !== sha) return;
      this.detail = detail;
      cx.notify();
      // The line counts of a big commit come last; draw them when they land.
      detail.stats.then(() => { if (this.detail === detail) cx.notify(); });
      this.prefetch(detail, cx);
    } catch (e) { if (this.selected === sha) { this.detailError = String(e); cx.notify(); } }
  }

  /** The changed files as the list shows them: one row per file, or a folder row ahead of each new directory. Rebuilt only when the commit or the layout changes. */
  fileItems() {
    const detail = this.detail, mode = this.fileMode;
    if (!detail) return [];
    if (this.itemsCache?.detail !== detail || this.itemsCache.mode !== mode) {
      const items = mode === "tree" ? fileTree(detail.files) : detail.files.map((file) => ({ type: "file", file, name: file.path, depth: 0 }));
      this.itemsCache = { detail, mode, items };
    }
    return this.itemsCache.items;
  }

  /** Reads the diffs of the first files in the list, one after the other, while the person is still looking at the commit. */
  async prefetch(detail, cx) {
    const files = this.fileItems().filter((item) => item.type === "file").slice(0, PREFETCHED_FILES);
    for (const { file } of files) {
      if (this.selected !== detail.sha) return;
      await this.viewFor(detail, file, "diff").catch(() => null);
    }
  }

  /** One file's rows for the diff pane, from the cache, from a read already under way, or from a new one. */
  viewFor(detail, file, mode) {
    const key = `${detail.sha}\0${file.path}\0${mode}`;
    let entry = this.views.get(key);
    if (!entry) {
      entry = { view: null };
      entry.promise = this.git.fileDiff(detail, file, this.on, this.info.root, { full: mode === "file" })
        .then(({ lines, cut }) => (entry.view = { rows: markWords(diffRows(lines)), cut }))
        .catch((e) => { this.views.delete(key); throw e; });
      keep(this.views, key, entry, KEPT_VIEWS);
    }
    return entry.promise;
  }

  /** The view for a file when it has been read already. */
  cachedView(detail, file, mode) {
    return this.views.get(`${detail.sha}\0${file.path}\0${mode}`)?.view ?? null;
  }

  /** Scrolls the graph to a commit, loading older pages when it is not there yet. */
  async reveal(sha, cx) {
    const run = this.run;
    if (this.selected !== sha) await this.select(sha, cx);
    this.panelOpen = true;
    this.status = "";
    for (let n = 0; !this.index.has(sha) && !this.done && n < MAX_REVEAL_PAGES; n++) {
      this.status = "Loading history…"; cx.notify();
      this.loading = true;
      try { await this.page(run, cx); } finally { this.loading = false; }
      if (run !== this.run) return;
    }
    this.status = this.index.has(sha) ? "" : "Not in the graph: turn Remote or Tags on, or show the branch";
    if (this.index.has(sha)) this.scroll.scroll_to_item(this.position(this.index.get(sha)), "center");
    cx.notify();
  }

  // ---- files and their diff

  async openFile(path, cx) {
    const file = this.detail?.files.find((f) => f.path === path);
    if (!file) return;
    this.file = file; this.mode = "diff"; this.hunkAt = -1; this.view = this.cachedView(this.detail, file, "diff");
    cx.notify();
    if (!this.view) await this.loadView(cx);
  }

  async loadView(cx) {
    const { file, detail, mode } = this;
    try {
      let view;
      if (detail.wip) {
        const { lines, cut } = await this.git.diff(this.wipSnap, file, "uncommitted", this.on);
        view = { rows: markWords(diffRows(lines)), cut };
      } else view = await this.viewFor(detail, file, mode);
      if (this.file === file && this.mode === mode) this.view = view;
    } catch { if (this.file === file) this.view = { rows: [{ kind: "", text: "Cannot preview this diff (too large or unreadable)" }] }; }
    this.hunkAt = -1;
    cx.notify();
  }

  setMode(mode, cx) {
    if (this.mode === mode || !this.file) return;
    this.mode = mode; this.view = this.detail.wip ? null : this.cachedView(this.detail, this.file, mode);
    cx.notify();
    if (!this.view) this.loadView(cx);
  }

  closeFile(cx) { this.file = null; this.view = null; cx.notify(); }

  step(direction, handle) {
    const at = stepHunk(hunkStarts(this.view?.rows ?? []), this.hunkAt, direction);
    if (at === null) return;
    this.hunkAt = at;
    handle.scroll_to_item(at, "top");
  }

  // ---- search

  /** Finds the commits matching `text` on the server, so the whole history is searched and not only the loaded part. */
  async setQuery(text, cx) {
    this.query = text.trim(); this.hitAt = -1;
    const run = ++this.searchRun, query = this.query;
    if (query.length < 2) { this.matches = null; this.searching = false; this.hitCache = null; cx.notify(); return; }
    this.searching = true; cx.notify();
    try {
      const shas = await this.git.search(this.info.root, query, this.on, this.refs);
      if (run !== this.searchRun) return;
      this.matches = shas; this.hitCache = null;
    } catch { if (run === this.searchRun) this.matches = new Set(); }
    if (run === this.searchRun) this.searching = false;
    cx.notify();
  }

  toggleOnly(cx) { this.onlyMatches = !this.onlyMatches; cx.notify(); }

  /** Jumps to the next or previous match among the loaded commits. */
  jump(direction, cx) {
    const hits = this.hits();
    if (!hits?.list.length) return;
    this.hitAt = Math.min(hits.list.length - 1, Math.max(0, this.hitAt + direction));
    const i = hits.list[this.hitAt];
    this.select(this.commits[i].sha, cx);
    this.scroll.scroll_to_item(this.position(i), "center");
  }

  // ---- hide and solo

  keyRef(item) { return item && refOf[item.type] ? refOf[item.type](item.name) : null; }

  hide(ref, cx) {
    if (!this.hidden.delete(ref)) this.hidden.add(ref);
    this.soloed.delete(ref);
    this.refsChanged(cx);
  }
  solo(ref, cx) {
    if (!this.soloed.delete(ref)) { this.soloed.add(ref); this.hidden.delete(ref); }
    this.refsChanged(cx);
  }
  showAll(cx) { this.hidden.clear(); this.soloed.clear(); this.refsChanged(cx); }
  refsChanged(cx) {
    this.leftCache = null; this.menu = null;
    if (this.query.length >= 2) this.setQuery(this.query, cx);
    this.relog(cx);
  }

  /** "Showing 12 of 4278 branches": what the graph draws, counting local and remote branches. */
  visibleRefs() {
    const all = (this.info?.heads.length ?? 0) + (this.show.remotes ? this.info?.remotes.length ?? 0 : 0);
    if (this.soloed.size) return { shown: this.soloed.size, all };
    return { shown: all - [...this.hidden].filter((r) => !r.startsWith("refs/tags/")).length, all };
  }

  // ---- the left column

  toggleSection(id, cx) { this.open[id] = !this.open[id]; this.leftCache = null; cx.notify(); }
  toggleFolder(path, cx) {
    if (!this.collapsed.delete(path)) this.collapsed.add(path);
    this.leftCache = null; cx.notify();
  }
  setFilter(text, cx) { this.filter = text; this.leftCache = null; cx.notify(); }

  /** The left column as one flat list so the window draws only the rows on screen. */
  left() {
    if (this.leftCache) return this.leftCache;
    const info = this.info, items = [];
    if (!info) return (this.leftCache = items);
    const needle = this.filter.toLowerCase(), match = (name) => !needle || name.toLowerCase().includes(needle);
    const section = (id, title, total, shown) => {
      items.push({ type: "section", id, title, total, shown, open: this.open[id], key: `section:${id}` });
      return this.open[id] || Boolean(needle);
    };
    const mark = (item) => {
      const ref = this.keyRef(item);
      return ref ? { ...item, hidden: this.hidden.has(ref), solo: this.soloed.has(ref) } : item;
    };
    const head = info.worktrees.find((w) => w.path === this.worktree);
    items.push({ type: "head", name: head?.branch ?? "HEAD", sha: this.headOf(), key: "head" });
    const locals = info.heads.map((h) => h.name), tree = branchTree(locals, this.filter, this.collapsed);
    const shas = new Map(info.heads.map((h) => [h.name, h.sha]));
    if (section("local", "LOCAL", locals.length, tree.filter((i) => i.type === "branch").length)) {
      for (const item of tree) items.push(mark({ ...item, key: `${item.type}:${item.path ?? item.name}`, sha: shas.get(item.name), ab: this.ab.get(item.name) }));
    }
    const remotes = info.remotes.filter((r) => match(r.name));
    if (section("remote", "REMOTE", info.remotes.length, remotes.length)) {
      for (const r of remotes.slice(0, LISTED)) items.push(mark({ type: "remote", name: r.name, sha: r.sha, depth: 0, key: `remote:${r.name}` }));
      if (remotes.length > LISTED) items.push({ type: "more", count: remotes.length - LISTED, key: "more:remote" });
    }
    if (section("worktrees", "WORKTREES", info.worktrees.length, info.worktrees.length)) {
      for (const w of info.worktrees) if (match(w.branch ?? w.path)) items.push({ type: "worktree", w, name: w.branch ?? `detached ${w.sha?.slice(0, 7)}`, wip: this.wt.get(w.path), key: `worktree:${w.path}` });
    }
    if (section("stashes", "STASHES", info.stashes.length, info.stashes.length)) {
      for (const s of info.stashes) if (match(s.subject)) items.push({ type: "stash", s, sha: s.sha, key: `stash:${s.name}` });
    }
    const tags = info.tags.filter((t) => match(t.name));
    if (section("tags", "TAGS", info.tags.length, tags.length)) {
      for (const t of tags.slice(0, LISTED)) items.push(mark({ type: "tag", name: t.name, sha: t.sha, depth: 0, key: `tag:${t.name}` }));
      if (tags.length > LISTED) items.push({ type: "more", count: tags.length - LISTED, key: "more:tag" });
    }
    this.leftMap = new Map(items.map((i) => [i.key, i]));
    return (this.leftCache = items);
  }

  clickLeft(key, cx) {
    const item = this.leftMap?.get(key);
    if (!item) return;
    this.menu = null;
    if (item.type === "section") this.toggleSection(item.id, cx);
    else if (item.type === "folder") this.toggleFolder(item.path, cx);
    else if (item.type === "worktree") this.pickWorktree(item.w.path, cx);
    else if (item.sha) this.reveal(item.sha, cx);
  }

  /** Right-click on a branch, remote branch or tag opens the Hide and Solo bar. */
  menuLeft(key, cx) {
    const item = this.leftMap?.get(key);
    this.menu = item && this.keyRef(item) ? item : null;
    cx.notify();
  }
}

/** Stores `value` under `key` and drops the oldest entries beyond `limit`. */
function keep(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  for (const old of map.keys()) {
    if (map.size <= limit) break;
    map.delete(old);
  }
}
