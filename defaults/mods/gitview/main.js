import { View } from "gpui-kit";
import { spaces, panes, focused, exec, readTextFile, window, theme, run } from "herdr";
import { createReader, diffRows } from "./git.js";
import { renderPanel } from "./views.js";

const REFRESH_MS = 10000;
const WORKERS = 3;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(space, all) {
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
}

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

export default class GitView extends View {
  init(_props, cx) {
    this.git = createReader({ exec, readTextFile });
    this.mode = "changes";
    this.snap = null; this.error = null; this.rows = []; this.diff = []; this.diffWidth = 300;
    this.open = null; this.prs = new Map(); this.ghMissing = new Set(); this.prQueue = [];
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.refresh(cx);
    cx.notify();
  }

  // Runs on a space gaining focus (render sees the new place) and on the slow timer.
  stamp() {
    return this.mode === "changes" ? key() : spaces().find((s) => s.active)?.id ?? null;
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true; this.seen = this.stamp();
    const work = this.mode === "changes" ? this.refreshOne(cx) : this.refreshAll(cx);
    work.catch((e) => { this.error = String(e); }).finally(() => {
      this.loading = false;
      if (this.stamp() !== this.seen) this.refresh(cx);
      cx.notify();
    });
  }

  async refreshOne(cx) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.snap = null; this.open = null; this.diff = []; this.error = null;
    }
    if (!cwd) return;
    const snap = await this.git.read(cwd, on, { files: true });
    if (key() !== context) return;
    this.on = on;
    if (!snap.ok) { this.snap = null; this.open = null; this.diff = []; this.error = snap.reason; return; }
    this.error = null; this.snap = snap;
    const listed = this.open && this.listFor(this.open.section).some((f) => f.path === this.open.path);
    if (this.open && !listed) { this.open = null; this.diff = []; }
    if (!this.open) {
      const first = snap.uncommitted[0] ? { section: "uncommitted", path: snap.uncommitted[0].path } : snap.unpushed[0] ? { section: "unpushed", path: snap.unpushed[0].path } : null;
      if (first && !this.closed) this.open = first;
    }
    if (this.open) await this.loadDiff(this.open, context);
  }

  async refreshAll(cx) {
    const all = panes(), targets = spaces().map((space) => ({ space, dir: place(space, all), on: space.machine ?? null }));
    const rows = new Array(targets.length);
    const reads = new Map();
    let next = 0;
    // A few folders at a time: twenty worker copies must not start eighty git processes at once.
    const worker = async () => {
      while (next < targets.length) {
        const i = next++, { space, dir, on } = targets[i], id = `${on}|${dir}`;
        if (!reads.has(id)) reads.set(id, dir ? this.git.read(dir, on, { files: false }).catch((e) => ({ ok: false, reason: String(e) })) : Promise.resolve({ ok: false, reason: "No folder" }));
        rows[i] = { space, on, snap: await reads.get(id) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, targets.length) }, worker));
    this.rows = rows;
    this.queuePrs(cx);
  }

  listFor(section) {
    return section === "uncommitted" ? this.snap?.uncommitted ?? [] : this.snap?.unpushed ?? [];
  }

  async loadDiff(target, context) {
    const file = this.listFor(target.section).find((f) => f.path === target.path);
    if (!file) return;
    let lines;
    try {
      const result = await this.git.diff(this.snap, file, target.section, this.on);
      if (result.add !== undefined) file.add = result.add;
      lines = result.lines;
    } catch { lines = ["Cannot preview this diff (too large or unreadable)"]; }
    if (key() === context && this.open === target) this.setLines(lines);
  }

  setLines(lines) {
    this.diff = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 50));
  }

  pick(section, path, cx) {
    const same = this.open?.section === section && this.open.path === path;
    this.open = same ? null : { section, path }; this.closed = same;
    this.setLines([]);
    if (this.open) {
      const target = this.open, context = this.context;
      cx.spawn(async (cx) => { await this.loadDiff(target, context); cx.notify(); });
    }
    cx.notify();
  }

  // gh asks the network, so once per branch tip, one at a time, and never for a row that has no PR to find.
  queuePrs(cx) {
    for (const { snap, on } of this.rows) {
      if (!snap?.ok || !snap.branch || this.ghMissing.has(on) || snap.branch === snap.base?.replace(/^origin\//, "")) continue;
      const id = this.prKey(snap, on);
      if (this.prs.has(id)) continue;
      this.prs.set(id, null);
      this.prQueue.push({ id, root: snap.root, branch: snap.branch, on });
    }
    if (this.prRunning || !this.prQueue.length) return;
    this.prRunning = true;
    cx.spawn(async (cx) => {
      try {
        for (let job = this.prQueue.shift(); job; job = this.prQueue.shift()) {
          if (this.ghMissing.has(job.on)) continue;
          try {
            const r = await exec("gh", ["pr", "list", "--head", job.branch, "--state", "all", "--limit", "5", "--json", "url,number,state,isDraft"], { cwd: job.root, on: job.on, timeout: 8000 });
            const found = r.code === 0 ? JSON.parse(r.stdout || "[]") : [];
            this.prs.set(job.id, found.find((pr) => pr.state === "OPEN") ?? found[0] ?? null);
          } catch { this.ghMissing.add(job.on); }
          cx.notify();
        }
      } finally { this.prRunning = false; }
    });
  }

  prKey(snap, on) {
    return `${on}|${snap.root}|${snap.branch}|${snap.sha}`;
  }

  select(id) {
    run("space.select", { id });
  }

  openLink(url) {
    const platform = window()?.platform;
    exec(platform === "macos" ? "open" : platform === "windows" ? "explorer" : "xdg-open", [url]).catch(() => null);
  }

  render(cx) {
    if (this.stamp() !== this.seen) this.refresh(cx);
    return renderPanel(this, theme(), cx);
  }
}
