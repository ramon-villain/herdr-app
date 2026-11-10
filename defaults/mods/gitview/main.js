import { View } from "gpui-kit";
import { InputState, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, window, theme, settings, run, props as modProps, openOverlay, closeOverlay, shared, setShared, notify, nextCommand } from "herdr";
import { createReader, diffRows } from "./git.js";
import { findKey, fileKey } from "./model.js";
import { renderPanel } from "./views.js";
import { Graph } from "./graph.js";
import { renderGraphTab } from "./graphview.js";
import { createActions } from "./actions.js";
import { compareUrl, catalogUrl, branchOf, menuHeight, menuKey, MENU_WIDTH } from "./refmenu.js";
import { renderRefMenu, renderPushError } from "./popup.js";

const REFRESH_MS = 10000;
const WORKERS = 3;
// Where Firstmate keeps its clones; the repository dropdown of the Git graph lists them.
const PROJECTS = "/Volumes/Coding/firstmate/projects";
// Firstmate's note queue, the one the browser extension's notes end in.
const INBOX = "/Volumes/Coding/firstmate/bin/fm-inbox.sh";
// The branch menu popup hands what was picked to the Git graph tab that opened it through this shared value.
const MENU_REQUEST = "gitview.menu";

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
    if (modProps()?.menu) return this.initMenu(cx);
    if (modProps()?.failure) return this.initPushError(cx);
    if (modProps()?.graph) return this.initGraph(cx);
    this.mode = "changes";
    this.snap = null; this.error = null; this.rows = []; this.diff = []; this.diffWidth = 300;
    this.open = null; this.prs = new Map(); this.ghMissing = new Set(); this.prQueue = [];
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  // The whole-tab graph: the repo of the active space, whichever pane holds the keyboard.
  initGraph(cx) {
    this.graphScroll = VirtualListScrollHandle.new();
    this.diffScroll = VirtualListScrollHandle.new();
    this.leftScroll = VirtualListScrollHandle.new();
    this.filesScroll = VirtualListScrollHandle.new();
    this.graph = new Graph(this.git, () => {
      const space = spaces().find((s) => s.active);
      return { dir: space ? place(space, panes()) : null, on: space?.machine ?? null, space: space?.id ?? null };
    }, this.graphScroll, modProps()?.projects ?? PROJECTS, this.leftScroll, this.filesScroll);
    this.input = InputState.new({ placeholder: "Filter branches, tags and stashes" });
    this.input.on("change", (_e, cx) => this.graph.setFilter(this.input.value(), cx));
    this.search = InputState.new({ placeholder: "Search message, author, sha or file" });
    this.search.on("change", (_e, cx) => this.graph.setQuery(this.search.value(), cx));
    this.handle = cx.focus_handle();
    this.id = Math.random().toString(36).slice(2);
    this.lastRequest = shared(MENU_REQUEST)?.t;
    this.noteInput = InputState.new({ placeholder: "Message for firstmate (optional)" });
    this.noteInput.on("submit", (_e, cx) => this.sendPick(cx));
    this.askInput = InputState.new({ placeholder: "Ask firstmate about this" });
    this.askInput.on("submit", (_e, cx) => this.sendAsk(cx));
    this.findInput = InputState.new({ placeholder: "Find in file" });
    this.findInput.on("change", (_e, cx) => { this.graph.setFind(this.findInput.value(), this.diffScroll); cx.notify(); });
    // Enter may reach the field's submit, onKey, or both; onKey knows about shift, so submit waits a moment and steps only if onKey did not.
    this.findInput.on("submit", (_e, cx) => {
      const pressed = Date.now();
      cx.timer.after(30, (cx) => { if ((this.steppedAt ?? 0) < pressed) { this.findStep(1); cx.notify(); } });
    });
    this.graph.load(cx);
    cx.timer.every(15000, (cx) => this.graph.poll(cx).catch(() => null));
    cx.timer.every(400, (cx) => { if (this.graph.wantMore) this.graph.more(cx); });
    cx.spawn(async () => {
      for (;;) { if (await nextCommand() === "pushError") this.showPushError(); }
    });
  }

  // ---- a failed push: the toast's click opens the whole git output, with the way to Copy it or force the push

  showPushError() {
    const failure = this.pushFailure;
    if (failure) openOverlay({ mod: "gitview", kind: "dialog", width: 640, props: { failure, tab: this.id } });
  }

  initPushError() {
    this.failure = modProps().failure;
  }

  /** Hands the confirm step to the tab that pushed, which names the branch and both shas before anything is forced. */
  forcePushFromError(cx) {
    const { failure, tab, overlay } = modProps();
    closeOverlay(overlay);
    setShared(MENU_REQUEST, { t: Date.now() + Math.random(), tab, action: "forcePush", ref: { name: failure.branch, sha: failure.sha, push: failure.push }, root: failure.root, on: failure.on });
    cx.notify();
  }

  // ---- the branch menu: a popup opened on a right-click, which answers through shared state

  openMenu(menu) {
    if (menu) openOverlay({ mod: "gitview", kind: "popup", width: MENU_WIDTH, height: menuHeight(menu), props: { menu, tab: this.id } });
  }

  initMenu(cx) {
    this.menuState = { at: 0, ref: 0 };
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  chooseEntry(entry, cx) {
    const { menu, tab, overlay } = modProps(), ref = menu.refs[this.menuState.ref];
    closeOverlay(overlay);
    setShared(MENU_REQUEST, { t: Date.now() + Math.random(), tab, action: entry.id, ref, web: menu.web, base: menu.base, root: menu.root, on: menu.on });
    cx.notify();
  }

  renderMenu(cx) {
    const { menu, overlay } = modProps(), state = this.menuState;
    return renderRefMenu(state, menu, theme(), (entry, cx) => this.chooseEntry(entry, cx), (i, cx) => { state.ref = i; state.at = 0; cx.notify(); })
      .id("gitview-menu").track_focus(this.handle).on_key_down((e, cx) => {
        const hit = menuKey(state, e.key, menu);
        if (hit === "close") closeOverlay(overlay);
        else if (hit && hit !== true) this.chooseEntry(hit, cx);
        else if (!hit) return;
        cx.notify();
      });
  }

  /** Runs what a popup picked, when this tab is the one that opened it. */
  takeRequest(cx) {
    const request = shared(MENU_REQUEST);
    if (!request || request.t === this.lastRequest) return;
    this.lastRequest = request.t;
    // render may not notify or start a log, and a spawned body runs at once, so the sleep moves the action out of the render phase.
    if (request.tab === this.id) cx.spawn(async (task) => { await task.sleep(0); await this.act(request, task); });
  }

  actions(cx) {
    return createActions({ exec, openLink: (url) => this.openLink(url), copy: (text) => cx.write_to_clipboard(text), notify, inbox: modProps()?.inbox ?? INBOX, pushFailed: (failure) => { this.pushFailure = failure; } });
  }

  async act({ action, ref, web, base, root, on }, cx) {
    const graph = this.graph, actions = this.actions(cx);
    if (action === "askFm") { graph.askAbout(ref); this.askInput.focus(); }
    else if (action === "solo") graph.solo(ref.ref, cx);
    else if (action === "hide") graph.hide(ref.ref, cx);
    else if (action === "copyName") actions.copyText(ref.name, ref.type === "tag" ? "tag name" : "branch name");
    else if (action === "copySha") actions.copyText(ref.sha, "commit sha");
    else if (action === "copyLink") actions.copyCommitLink(web, ref.sha);
    else if (action === "openCard") this.openLink(catalogUrl(branchOf(ref)));
    else if (action === "openPr") this.openLink(ref.pr.url);
    else if (action === "createPr") this.openLink(compareUrl(web, base, branchOf(ref)));
    else if (action === "pushPr") await actions.pushAndCompare({ root, on, branch: ref.name, web, base, sha: ref.sha, push: ref.push });
    else if (action === "push") { if (await actions.pushBranch({ root, on, remote: ref.push.remote, branch: ref.name, sha: ref.sha, push: ref.push })) graph.load(cx); }
    else if (action === "pull") { if (await actions.pullBranch({ root, on, remote: ref.pull.remote, upstream: ref.pull.branch, branch: ref.name, held: graph.info.worktrees.find((w) => w.branch === ref.name)?.path })) graph.load(cx); }
    else if (action === "deleteBranch") await this.askDelete({ root, on, name: ref.name, sha: ref.sha });
    else if (action === "forcePush") graph.confirmPush = { root, on, name: ref.name, sha: ref.sha, ...ref.push };
    cx.notify();
  }

  /** A branch a worktree has checked out cannot go; any other asks for confirmation first. */
  async askDelete(branch) {
    const held = this.graph.info.worktrees.find((w) => w.branch === branch.name);
    if (held) notify({ title: `Kept ${branch.name}`, body: `it is checked out in ${held.path}`, level: "error", timeout: 8000 });
    else await this.graph.askDelete(branch);
  }

  /** The delete the captain confirmed. */
  deleteNow(cx) {
    const c = this.graph.confirmDelete;
    if (!c || this.pushing) return;
    this.pushing = true;
    cx.notify();
    cx.spawn(async (task) => {
      const deleted = await this.actions(task).deleteBranch(c);
      this.graph.confirmDelete = null;
      this.pushing = false;
      if (deleted) this.graph.load(task);
      task.notify();
    });
  }

  /** The Force push the captain confirmed: it only goes through when the remote branch is still at the tip the confirmation showed. */
  forcePush(cx) {
    const c = this.graph.confirmPush;
    if (!c || this.pushing) return;
    this.pushing = true;
    cx.notify();
    cx.spawn(async (task) => {
      const pushed = await this.actions(task).pushBranch({ root: c.root, on: c.on, remote: c.remote, branch: c.name, lease: c.tip });
      this.graph.confirmPush = null;
      this.pushing = false;
      if (pushed) this.graph.load(task);
      task.notify();
    });
  }

  // ---- send the picked lines of the open file to firstmate

  sendPick(cx) {
    const body = this.sending ? null : this.graph.pickNote(this.noteInput.value());
    if (!body) return;
    this.sending = true;
    cx.notify();
    cx.spawn(async (task) => {
      try {
        await this.actions(task).sendNote(`herdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, body);
        this.graph.pick = null;
        this.noteInput.set_value("");
      } catch (e) { notify({ title: "Could not send to firstmate", body: String(e.message ?? e), level: "error" }); }
      this.sending = false;
      task.notify();
    });
  }

  sendAsk(cx) {
    const body = this.sending ? null : this.graph.askNote(this.askInput.value());
    if (!body) return;
    this.sending = true;
    cx.notify();
    cx.spawn(async (task) => {
      try {
        await this.actions(task).sendNote(`herdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, body);
        this.graph.ask = null;
        this.askInput.set_value("");
      } catch (e) { notify({ title: "Could not send to firstmate", body: String(e.message ?? e), level: "error" }); }
      this.sending = false;
      task.notify();
    });
  }

  findStep(direction) {
    this.steppedAt = Date.now();
    this.graph.stepFind(direction, this.diffScroll);
  }

  findClose(cx) {
    this.graph.closeFind();
    this.handle.focus();
    cx.notify();
  }

  /** cmd+f and its keys, only while something in the Git graph tab holds the keyboard: this handler sits on the tab's root, so no other pane sees them. */
  onKey(e, cx) {
    const step = fileKey(e.key, e.modifiers);
    // An input takes the arrows for its caret; only the tab's own handle means the list has the keyboard.
    if (step && this.handle.is_focused() && this.graph.detail && !this.graph.find.open) {
      if (this.graph.stepFile(step, cx)) { cx.stop_propagation(); cx.notify(); }
      return;
    }
    const action = findKey(e.key, e.modifiers, this.graph.find.open);
    if (!action || (action === "open" && !this.graph.file)) return;
    if (action === "open") {
      this.graph.openFind();
      this.findInput.focus();
      // The field is drawn by the next render, so it can only take the keyboard after that.
      cx.timer.after(50, () => this.findInput.focus());
    } else if (action === "close") this.findClose(cx);
    else this.findStep(action === "next" ? 1 : -1);
    cx.stop_propagation();
    cx.notify();
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

  openGraph() {
    run("tab.new", { mod: "gitview", props: { graph: true }, name: "Git graph" });
  }

  openLink(url) {
    const platform = window()?.platform;
    exec(platform === "macos" ? "open" : platform === "windows" ? "explorer" : "xdg-open", [url]).catch(() => null);
  }

  render(cx) {
    if (this.menuState) return this.renderMenu(cx);
    if (this.failure) return renderPushError(this.failure, theme(), settings().font_family ?? "JetBrains Mono", {
      copy: (cx) => this.actions(cx).copyText(this.failure.output, "git output"),
      force: (cx) => this.forcePushFromError(cx),
      close: () => closeOverlay(modProps().overlay),
    });
    if (this.graph) {
      this.takeRequest(cx);
      return renderGraphTab(this.graph, this, theme());
    }
    if (this.stamp() !== this.seen) this.refresh(cx);
    return renderPanel(this, theme(), cx);
  }
}
