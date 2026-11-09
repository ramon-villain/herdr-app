import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { settings } from "herdr";
import { lineSegments, markFinds } from "./model.js";
import { diffPalette } from "./palette.js";

const ROW = 24, LANE = 9, MID = 12, LEFT_W = 300, RIGHT_W = 390, LABEL_W = 170, GRAPH_MAX = 230;
const LANE_COLORS = ["#4f8cff", "#b04fe0", "#ff4f7b", "#ff8a3d", "#f5c542", "#9bd34a", "#3fd08a", "#2fc7d6", "#4a6cf0", "#8a5cf0", "#e0509b", "#d6a04a"];
const STATUS = { A: "A", M: "M", D: "D", U: "U" };

const x = (lane) => lane * LANE + 8;
const line = (px, py, w, h, color) => div().absolute().left(px).top(py).w(w).h(h).bg(color);
const clamp99 = (n) => (n > 99 ? "99+" : String(n));
const shorten = (name, n) => (name.length > n ? `${name.slice(0, n - 1)}…` : name);
const dateText = (ms) => new Date(ms).toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" });

// ---- the commit list

/** The lines of one graph row. Lanes right of the column are not drawn: the column is as wide as the window gives it. */
function lanesOf(row, width, head, stash) {
  const cells = [], limit = Math.floor((width - 6) / LANE);
  const at = (lane) => lane < limit;
  for (const p of row.pass) if (at(p.lane)) cells.push(line(x(p.lane) - 1, 0, 2, ROW, LANE_COLORS[p.color]));
  if (row.top && at(row.lane)) cells.push(line(x(row.lane) - 1, 0, 2, MID + 1, LANE_COLORS[row.color]));
  for (const m of row.merging) {
    if (!at(m.lane)) continue;
    cells.push(line(x(m.lane) - 1, 0, 2, MID + 1, LANE_COLORS[m.color]));
    cells.push(line(x(row.lane), MID - 1, x(m.lane) - x(row.lane) + 1, 2, LANE_COLORS[m.color]));
  }
  for (const e of row.edges) {
    if (!at(e.to)) continue;
    if (e.to !== row.lane) cells.push(line(Math.min(x(row.lane), x(e.to)), MID - 1, Math.abs(x(e.to) - x(row.lane)) + 1, 2, LANE_COLORS[e.color]));
    cells.push(line(x(e.to) - 1, MID, 2, ROW - MID, LANE_COLORS[e.color]));
  }
  if (at(row.lane)) {
    const dot = div().absolute().left(x(row.lane) - 5).top(MID - 5).w(10).h(10).rounded_full();
    if (stash) cells.push(div().absolute().left(x(row.lane) - 4).top(MID - 4).w(8).h(8).rounded(2).bg(LANE_COLORS[row.color]));
    else cells.push(head ? dot.border(2).border_color(LANE_COLORS[row.color]).bg("#00000000") : dot.bg(LANE_COLORS[row.color]));
  }
  return cells;
}

function labelsOf(graph, c, color, t) {
  const at = graph.info.bySha.get(c.sha);
  if (!at && !c.stash) return div().w(LABEL_W).flex_none();
  const { remotes, tags } = graph.show;
  const all = c.stash ? [{ n: c.stash, k: "stash" }]
    : [...at.heads.map((n) => ({ n, k: "head" })), ...(remotes ? at.remotes.map((n) => ({ n, k: "remote" })) : []), ...(tags ? at.tags.map((n) => ({ n, k: "tag" })) : [])];
  if (!all.length) return div().w(LABEL_W).flex_none();
  const first = all[0], extra = all.length - 1;
  const fill = first.k === "head" ? LANE_COLORS[color] : first.k === "tag" ? t.ansi3 : first.k === "stash" ? t.ansi5 : t.muted;
  return h_flex().w(LABEL_W).flex_none().pr(6).gap(4).items_center()
    .child(div().min_w(0).flex_shrink_0().max_w(extra ? LABEL_W - 40 : LABEL_W - 8).px(6).h(18).rounded(4).cursor_pointer().bg(`${fill}55`).text_size(11).truncate().child(first.k === "tag" ? `◆ ${first.n}` : first.n))
    .when(extra > 0, (e) => e.child(div().text_size(10).text_color(t.dim).flex_none().child(`+${extra}`)));
}

function wipRow(graph, t, gw) {
  const at = graph.index.get(graph.headOf()), row = at === undefined ? { lane: 0, color: 0 } : graph.rows[at], on = graph.selected === "wip";
  const color = LANE_COLORS[row.color], dot = div().absolute().left(x(row.lane) - 5).top(MID - 5).w(10).h(10).rounded_full().border(2).border_color(color);
  return h_flex().w_full().h(ROW).flex_none().items_center().relative().when(on, (e) => e.bg(t.selected))
    .child(h_flex().w(LABEL_W).flex_none().pl(8).child(div().px(6).h(18).flex().items_center().rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.muted).child("WIP")))
    .child(div().w(gw).h(ROW).flex_none().relative().overflow_hidden().child(line(x(row.lane) - 1, MID, 2, ROW - MID, `${color}88`)).child(dot))
    .child(h_flex().flex_1().min_w(0).pl(8).gap(8).items_center().text_size(12).text_color(t.muted)
      .child(div().child(`Uncommitted changes · ${graph.wipSnap.uncommittedTotal} ${graph.wipSnap.uncommittedTotal === 1 ? "file" : "files"}`)));
}

function commitRow(graph, i, t, gw, headSha, keep) {
  const c = graph.commits[i], row = graph.rows[i], on = graph.selected === c.sha, hit = graph.isHit(i);
  return h_flex().w_full().h(ROW).flex_none().items_center().relative()
    .when(keep && !keep.has(c.sha), (e) => e.opacity(0.3))
    .when(hit, (e) => e.bg(`${t.accent}2a`))
    .when(on, (e) => e.bg(t.selected))
    .child(labelsOf(graph, c, row.color, t))
    .child(div().w(gw).h(ROW).flex_none().relative().overflow_hidden().children(lanesOf(row, gw, c.sha === headSha, Boolean(c.stash))))
    .child(h_flex().flex_1().min_w(0).pl(8).pr(8).gap(8).items_center().text_size(12)
      .child(div().flex_none().max_w(560).truncate().when(on, (e) => e.font_semibold()).child(c.subject))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(c.body)))
    .when(Boolean(c.marker), (e) => e.child(div().absolute().right(14).top(4).px(6).h(16).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(c.marker)));
}

function searchBar(graph, view, t) {
  const { shown, all } = graph.visibleRefs(), soloing = graph.soloed.size > 0, changed = graph.hidden.size > 0 || soloing, hits = graph.hits();
  return h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
    .child(Input.new(view.search).w(220).h(24).px(8).rounded(5).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground))
    .when(Boolean(graph.query), (e) => e.child(div().flex_none().child(graph.searching ? "Searching…" : `${hits ? hits.matches.size : 0} found, ${hits ? hits.list.length : 0} loaded`))
      .child(pill(t, "graph-hit-prev", "↑", false, (_e, cx) => graph.jump(-1, cx)))
      .child(pill(t, "graph-hit-next", "↓", false, (_e, cx) => graph.jump(1, cx)))
      .child(pill(t, "graph-only", "Only matches", graph.onlyMatches, (_e, cx) => graph.toggleOnly(cx))))
    .child(div().flex_1())
    .child(div().flex_none().text_color(changed ? t.accent : t.dim).child(soloing ? `Soloing ${shown}/${all}` : `Showing ${shown} of ${all} branches`))
    .when(soloing, (e) => e.child(pill(t, "graph-stop-solo", "Stop Soloing", false, (_e, cx) => graph.stopSolo(cx))))
    .when(changed && !soloing, (e) => e.child(pill(t, "graph-show-all", "Show all", false, (_e, cx) => graph.showAll(cx))));
}

function graphList(graph, view, t) {
  const gw = Math.min(GRAPH_MAX, Math.max(90, graph.maxWidth * LANE + 16)), headSha = graph.headOf();
  return v_flex().h_full().flex_1().min_h(0).min_w(0)
    .child(searchBar(graph, view, t))
    .child(h_flex().h(26).flex_none().items_center().border_b(1).border_color(t.border).text_size(10).text_color(t.dim)
      .child(div().w(LABEL_W).flex_none().pl(10).child("BRANCH / TAG"))
      .child(div().w(gw).flex_none().child("GRAPH"))
      .child(div().pl(8).child("COMMIT MESSAGE")))
    .child(div().flex_1().min_h(0).relative().on_mouse_move((e, cx) => graph.overLabels(e.local_position.x < LABEL_W, cx))
      .child(v_virtual_list("graph-rows", graph.count(), ROW, (k) => (graph.at(k) < 0 ? "wip" : graph.commits[graph.at(k)].sha), (range) => {
        if (range.end >= graph.count() - 80) graph.wantMore = true;
        const rows = [], keep = graph.highlight();
        for (let k = range.start; k < range.end; k++) rows.push(graph.at(k) < 0 ? wipRow(graph, t, gw) : commitRow(graph, graph.at(k), t, gw, headSha, keep));
        return rows;
      }).track_scroll(view.graphScroll).on_item_click((sha, cx) => graph.select(sha, cx)).on_item_hover((sha, hovered, cx) => graph.hoverRow(sha, hovered, cx)).on_item_secondary_click((sha) => view.openMenu(graph.menuRow(sha))).size_full())
      .child(Scrollbar.vertical("graph-rows").absolute().inset_0())
      .when(!graph.commits.length, (e) => e.child(div().absolute().p(14).text_color(t.dim).child(graph.error ?? (graph.loading ? "Loading…" : "No commits"))))
      .when(Boolean(graph.status), (e) => e.child(div().absolute().bottom(8).right(14).px(8).py(3).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child(graph.status))));
}

// ---- the diff that replaces the graph

// The host refuses a handler registered on a row of a virtual list and draws the whole list blank, so a click on a line
// is read by the list's on_item_click and the row only shows that it is picked.
function pickable(el, graph, i, t) {
  return el.when(graph.picked(i), (e) => e.bg(`${t.accent}38`).border_l(2).border_color(t.accent));
}

function diffLine(r, ext, finds = [], pick = (el) => el) {
  const p = diffPalette;
  if (r.kind === "@") return pick(h_flex().w_full().h(ROW - 4).flex_none().items_center().px(12).bg(p.hunk.ground).text_color(p.hunk.text).child(div().truncate().child(r.text)));
  const add = r.kind === "+", del = r.kind === "-", side = add ? p.added : p.removed;
  const gutter = (n) => div().w(38).flex_none().text_right().pr(6).text_color(add || del ? p.text : p.lineNumber).when(add || del, (e) => e.bg(side.gutter)).child(n === undefined ? "" : String(n));
  return pick(h_flex().w_full().h(ROW - 4).flex_none().items_center()
    .when(add || del, (e) => e.bg(side.line))
    .child(gutter(r.old)).child(gutter(r.next))
    .child(div().w(14).flex_none().text_color(add || del ? side.sign : p.lineNumber).child(add ? "+" : del ? "−" : ""))
    .child(h_flex().flex_1().min_w(0).whitespace_nowrap().overflow_hidden()
      .children(markFinds(r.kind === "" ? [{ text: r.text, kind: "", hl: false }] : lineSegments(r.text, ext, r.mark), finds).map((s) =>
        div().flex_none().text_color(s.find === 2 ? p.find.currentText : s.hl ? p.wordText : p.syntax[s.kind])
          .when(s.hl, (e) => e.bg(side.word)).when(s.find > 0, (e) => e.bg(s.find === 2 ? p.find.current : p.find.match)).child(s.text)))));
}

function pill(t, id, text, on, onClick) {
  return div().id(id).px(10).h(24).flex().items_center().text_size(11).cursor_pointer().border_1().border_color(t.border)
    .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(onClick).child(text);
}

/** A bar drawn over the code takes the pointer itself: the list under it would read the same press as a click on a line and clear the picked lines. */
function shield(bar) {
  const stop = (_e, cx) => cx.stop_propagation();
  return bar.on_mouse_down("left", stop).on_mouse_up("left", stop);
}

/** The find bar over the top right of the file pane: the text, the place of the current match among all, and the way to step and close. */
function findBar(graph, view, t, total) {
  const at = Math.min(graph.find.at, total - 1);
  return shield(h_flex().absolute().top(8).right(18).h(32).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12))
    .child(Input.new(view.findInput).w(180).h(24).px(6).rounded(4).bg(t.background).text_size(12).text_color(t.foreground))
    .child(div().w(54).flex_none().text_size(11).text_color(t.muted).child(graph.find.query ? (total ? `${at + 1} of ${total}` : "No results") : ""))
    .child(pill(t, "graph-find-prev", "↑", false, () => view.findStep(-1)))
    .child(pill(t, "graph-find-next", "↓", false, () => view.findStep(1)))
    .child(pill(t, "graph-find-close", "✕", false, (_e, cx) => view.findClose(cx)));
}

/** The bar over the bottom of the file pane while lines are picked: what is picked, an optional message, and the send. */
function sendBar(graph, view, t) {
  const n = graph.pick.to - graph.pick.from + 1;
  return shield(h_flex().absolute().bottom(8).left(12).right(12).h(36).px(8).gap(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12))
    .child(div().flex_none().text_size(11).text_color(t.muted).child(`${n} ${n === 1 ? "line" : "lines"}`))
    .child(Input.new(view.noteInput).flex_1().min_w(0).h(24).px(6).rounded(4).bg(t.background).text_size(12).text_color(t.foreground))
    .child(pill(t, "graph-send-pick", view.sending ? "Sending…" : "Send to firstmate", false, (_e, cx) => view.sendPick(cx)))
    .child(pill(t, "graph-send-close", "✕", false, (_e, cx) => { graph.pick = null; cx.notify(); }));
}

/** The box over the bottom of the tab that a right-click on a ref or commit opens: what it is about, a message, and the send. */
function askBar(graph, view, t) {
  const { ask } = graph;
  return shield(h_flex().absolute().bottom(12).left(320).right(12).h(40).px(8).gap(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.popover).shadow_lg().text_size(12))
    .child(div().flex_none().max_w(200).truncate().text_size(11).text_color(t.muted).child(ask.type === "commit" ? ask.name : `${ask.type === "tag" ? "tag" : "branch"} ${ask.name}`))
    .child(Input.new(view.askInput).flex_1().min_w(0).h(24).px(6).rounded(4).bg(t.background).text_size(12).text_color(t.foreground))
    .child(pill(t, "graph-ask-send", view.sending ? "Sending…" : "Send to firstmate", false, (_e, cx) => view.sendAsk(cx)))
    .child(pill(t, "graph-ask-close", "✕", false, (_e, cx) => { graph.ask = null; cx.notify(); }));
}

function diffPane(graph, view, t, cx) {
  const hits = graph.findHits(), at = Math.min(graph.find.at, hits.length - 1), byRow = new Map();
  hits.forEach((h, i) => byRow.set(h.row, [...(byRow.get(h.row) ?? []), { from: h.from, to: h.to, current: i === at }]));
  const file = graph.file, parts = file.path.split("/"), name = parts.pop(), ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const rows = graph.view?.rows ?? [];
  return v_flex().h_full().flex_1().min_h(0).min_w(0).font_family(settings().font_family ?? "JetBrains Mono")
    .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.muted).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().flex_none().child(name)))
      .child(div().id("graph-diff-close").w(24).h(24).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => graph.closeFile(cx)).child("✕")))
    .child(h_flex().h(36).flex_none().px(12).gap(0).items_center().justify_between().border_b(1).border_color(t.border).text_size(11)
      .child(div().w(80))
      .child(h_flex().child(pill(t, "graph-file-view", "File View", graph.mode === "file", (_e, cx) => graph.setMode("file", cx)))
        .child(pill(t, "graph-diff-view", "Diff View", graph.mode === "diff", (_e, cx) => graph.setMode("diff", cx))))
      .child(h_flex().w(80).justify_end()
        .child(pill(t, "graph-hunk-prev", "↑", false, () => graph.step(-1, view.diffScroll)))
        .child(pill(t, "graph-hunk-next", "↓", false, () => graph.step(1, view.diffScroll)))))
    .child(div().flex_1().min_h(0).relative().text_size(11).bg(diffPalette.ground).on_mouse_down("left", (e) => { view.extendPick = e.modifiers.shift; })
      .child(v_virtual_list("graph-diff", rows.length, ROW - 4, (i) => String(i), (range) => rows.slice(range.start, range.end).map((r, k) => diffLine(r, ext, byRow.get(range.start + k), (el) => pickable(el, graph, range.start + k, t))))
        .track_scroll(view.diffScroll).on_item_click((key, cx) => { graph.clickPick(Number(key), view.extendPick); cx.notify(); }).size_full())
      .child(Scrollbar.vertical("graph-diff").absolute().inset_0())
      .when(graph.find.open, (e) => e.child(findBar(graph, view, t, hits.length)))
      .when(Boolean(graph.pick), (e) => e.child(sendBar(graph, view, t)))
      .when(!graph.view, (e) => e.child(div().absolute().p(14).text_color(t.dim).child("Loading…")))
      .when(Boolean(graph.view?.cut), (e) => e.child(div().absolute().bottom(graph.pick ? 52 : 8).right(14).px(8).py(3).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child("Long file: showing the first lines"))));
}

// ---- the branch tree

function leftRow(item, t, graph) {
  const row = h_flex().w_full().h(ROW).flex_none().items_center().gap(6).text_size(12).pr(10).cursor_pointer();
  const indent = (depth) => div().w(8 + (depth ?? 0) * 14).flex_none();
  if (item.type === "section") {
    return row.pl(8).bg(t.surface).text_size(11).font_semibold().text_color(t.muted)
      .child(div().w(10).flex_none().child(item.open ? "▾" : "▸")).child(div().flex_1().child(item.title))
      .child(div().text_color(t.dim).child(item.shown !== item.total ? `${item.shown}/${item.total}` : String(item.total)));
  }
  if (item.type === "head") return row.pl(8).bg(t.selected).font_semibold().child(div().text_color(t.ansi2).child("●")).child(div().flex_1().min_w(0).truncate().child(`HEAD · ${item.name}`));
  if (item.type === "folder") return row.child(indent(item.depth)).text_color(t.muted).child(div().w(10).flex_none().child(item.open ? "▾" : "▸")).child(div().flex_1().min_w(0).truncate().child(item.name)).child(div().text_size(10).text_color(t.dim).child(String(item.count)));
  if (item.type === "branch") {
    const ab = item.ab;
    return row.child(indent(item.depth + 1)).when(item.hidden, (e) => e.opacity(0.45))
      .when(item.marked === "tip", (e) => e.bg(t.selected).font_semibold())
      .when(item.marked === "contains", (e) => e.bg(t.hover))
      .child(div().w(5).h(5).rounded_full().flex_none().bg(item.solo || item.marked ? t.accent : t.dim))
      .child(div().flex_1().min_w(0).truncate().child(item.leaf))
      .when(item.hidden, (e) => e.child(div().text_size(10).text_color(t.dim).flex_none().child("hidden")))
      .when(item.solo, (e) => e.child(div().text_size(10).text_color(t.accent).flex_none().child("solo")))
      .when(Boolean(ab && (ab.ahead || ab.behind)), (e) => e.child(div().text_size(10).text_color(t.muted).flex_none().child(`${clamp99(ab.ahead)}↑ ${clamp99(ab.behind)}↓`)));
  }
  if (item.type === "worktree") {
    const on = item.w.path === graph.worktree;
    const wip = item.wip;
    return row.child(indent(1)).when(on, (e) => e.bg(t.selected)).child(div().flex_1().min_w(0).truncate().child(item.name))
      .when(Boolean(wip?.changed), (e) => e.child(div().text_size(10).text_color(t.blocked).flex_none().child(`${wip.changed} changed`)))
      .when(Boolean(wip && (wip.ahead || wip.behind)), (e) => e.child(div().text_size(10).text_color(t.muted).flex_none().child(`${clamp99(wip.ahead ?? 0)}↑ ${clamp99(wip.behind ?? 0)}↓`)));
  }
  if (item.type === "stash") return row.child(indent(1)).child(div().flex_1().min_w(0).truncate().child(item.s.subject)).child(div().text_size(10).text_color(t.dim).child(item.s.name.replace("stash@", "")));
  if (item.type === "more") return row.child(indent(1)).text_color(t.dim).child(`+${item.count} more, filter to narrow`);
  return row.child(indent(1)).when(item.hidden, (e) => e.opacity(0.45)).child(div().flex_1().min_w(0).truncate().child(item.name))
    .when(item.hidden, (e) => e.child(div().text_size(10).text_color(t.dim).flex_none().child("hidden")))
    .when(item.solo, (e) => e.child(div().text_size(10).text_color(t.accent).flex_none().child("solo")));
}

function leftPane(graph, view, t) {
  const items = graph.left(), info = graph.info;
  const shown = graph.commits.length;
  return v_flex().w(LEFT_W).h_full().flex_none().min_h(0).border_r(1).border_color(t.border)
    .child(v_flex().flex_none().p(10).gap(6)
      .child(h_flex().text_size(11).text_color(t.muted).gap(6).items_center().child(div().flex_1().child(`Viewing ${shown}${graph.done ? "" : "+"}`))
        .child(div().text_color(t.dim).child("Graph shows"))
        .child(pill(t, "graph-show-remote", "Remote", graph.show.remotes, (_e, cx) => graph.toggleShow("remotes", cx)))
        .child(pill(t, "graph-show-tags", "Tags", graph.show.tags, (_e, cx) => graph.toggleShow("tags", cx))))
      .child(Input.new(view.input).h(28).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground)))
    .child(div().flex_1().min_h(0).relative()
      .child(v_virtual_list("graph-left", items.length, ROW, (i) => items[i].key, (range) => items.slice(range.start, range.end).map((item) => leftRow(item, t, graph)))
        .track_scroll(view.leftScroll).on_item_click((key, cx) => graph.clickLeft(key, cx)).on_item_hover((key, hovered, cx) => graph.hoverLeft(key, hovered, cx)).on_item_secondary_click((key) => view.openMenu(graph.menuLeft(key))).size_full())
      .child(Scrollbar.vertical("graph-left").absolute().inset_0())
      .when(!info, (e) => e.child(div().absolute().p(12).text_color(t.dim).child(graph.error ?? "Loading…"))));
}

// ---- the selected commit

function fileRow(item, t, graph) {
  const row = h_flex().w_full().h(ROW).flex_none().items_center().gap(6).text_size(12).pr(10);
  if (item.type === "folder") return row.child(div().w(8 + item.depth * 12).flex_none()).text_color(t.muted).child(div().truncate().child(`▾ ${item.name}`));
  const { file } = item, on = graph.file?.path === file.path, color = file.status === "A" ? t.ansi2 : file.status === "D" ? t.ansi1 : t.blocked;
  const parts = file.path.split("/"), name = parts.pop();
  const label = graph.fileMode === "tree"
    ? h_flex().flex_1().min_w(0).child(div().w(8 + item.depth * 12).flex_none()).child(div().truncate().child(item.name))
    : h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : "")).child(div().flex_none().child(name));
  return row.cursor_pointer().pl(8).when(on, (e) => e.bg(t.selected)).child(div().w(12).flex_none().text_color(color).child(STATUS[file.status] ?? "M")).child(label)
    .when(file.add > 0, (e) => e.child(div().text_size(10).text_color(t.ansi2).child(`+${file.add}`)))
    .when(file.del > 0, (e) => e.child(div().text_size(10).text_color(t.ansi1).child(`−${file.del}`)));
}

function detailPane(graph, view, t, items) {
  const d = graph.detail, c = graph.commits[graph.index.get(graph.selected)];
  if (!graph.selected) return v_flex().w(RIGHT_W).flex_none().border_l(1).border_color(t.border).p(14).text_color(t.dim).text_size(12).child("Select a commit");
  const [subject, ...rest] = (d?.message ?? c?.subject ?? "").split("\n");
  const body = rest.join("\n").trim(), boxH = Math.min(190, 24 + Math.ceil(subject.length / 27) * 20 + (body ? 16 + Math.ceil(body.length / 48) * 15 : 0));
  return v_flex().w(RIGHT_W).h_full().flex_none().min_h(0).border_l(1).border_color(t.border)
    .child(div().h(34).flex_none().flex().items_center().justify_center().text_size(11).text_color(t.muted).border_b(1).border_color(t.border).child(d?.wip ? "uncommitted changes" : c?.stash ? `stash: ${c.stash}` : `commit: ${graph.selected.slice(0, 7)}`))
    .child(v_flex().flex_none().h(boxH).overflow_y_scrollbar().p(12).gap(6).child(div().text_size(14).child(subject)).when(Boolean(body), (e) => e.child(div().text_size(11).text_color(t.muted).child(body))))
    .child(h_flex().flex_none().px(12).py(8).gap(10).border_t(1).border_color(t.border).text_size(11)
      .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(12).truncate().child(d?.author ?? c?.author ?? "")).child(div().text_color(t.muted).child(d?.wip ? "not committed yet" : `authored ${dateText(d?.time ?? c?.time ?? 0)}`)))
      .child(div().text_color(t.muted).flex_none().child(d?.parents.length ? `parent${d.parents.length > 1 ? "s" : ""}: ${d.parents.map((p) => p.slice(0, 6)).join(" ")}` : "root commit")))
    .child(h_flex().flex_none().px(12).h(30).items_center().gap(8).text_size(11).text_color(t.muted)
      .child(div().flex_1().child(d ? `${d.total} ${d.total === 1 ? "file" : "files"} changed` : graph.detailError ?? "Loading…"))
      .child(pill(t, "graph-path", "Path", graph.fileMode === "path", (_e, cx) => { graph.fileMode = "path"; cx.notify(); }))
      .child(pill(t, "graph-tree", "Tree", graph.fileMode === "tree", (_e, cx) => { graph.fileMode = "tree"; cx.notify(); })))
    .child(div().flex_1().min_h(0).relative()
      .child(v_virtual_list("graph-files", items.length, ROW, (i) => items[i].file?.path ?? `dir:${items[i].path}`, (range) => items.slice(range.start, range.end).map((item) => fileRow(item, t, graph)))
        .track_scroll(view.filesScroll).on_item_click((key, cx) => { if (!key.startsWith("dir:")) graph.openFile(key, cx); }).size_full())
      .child(Scrollbar.vertical("graph-files").absolute().inset_0()));
}

// ---- the tab

function topBar(graph, t) {
  const repoName = (graph.info?.root ?? graph.repo)?.split("/").pop() ?? "";
  const current = graph.info?.worktrees.find((w) => w.path === graph.worktree);
  return h_flex().h(46).flex_none().px(14).gap(18).items_center().border_b(1).border_color(t.border)
    .child(v_flex().relative()
      .child(div().text_size(10).text_color(t.dim).child("repository"))
      .child(div().id("graph-repo").flex().gap(6).cursor_pointer().on_click((_e, cx) => { graph.pickingRepo = !graph.pickingRepo; graph.picking = false; cx.notify(); })
        .child(div().font_semibold().child(repoName)).child(div().text_color(t.muted).child("▾"))))
    .child(v_flex().relative()
      .child(div().text_size(10).text_color(t.dim).child("worktree"))
      .child(div().id("graph-worktree").flex().gap(6).cursor_pointer().on_click((_e, cx) => { graph.picking = !graph.picking; graph.pickingRepo = false; cx.notify(); })
        .child(div().font_semibold().child(current?.branch ?? (current ? `detached ${current.sha?.slice(0, 7)}` : "HEAD"))).child(div().text_color(t.muted).child("▾"))))
    .child(div().flex_1())
    .child(div().text_size(11).text_color(t.dim).child("read only"));
}

function worktreeMenu(graph, t) {
  return v_flex().absolute().top(44).left(160).w(360).max_h(320).overflow_y_scrollbar().rounded(8).border_1().border_color(t.border).bg(t.popover).p(4).shadow_lg()
    .children(graph.info.worktrees.map((w, i) => h_flex().id(`graph-wt-${i}`).h(28).px(8).gap(8).items_center().rounded(5).cursor_pointer().text_size(12)
      .when(w.path === graph.worktree, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => graph.pickWorktree(w.path, cx))
      .child(div().flex_1().min_w(0).truncate().child(w.branch ?? `detached ${w.sha?.slice(0, 7)}`))
      .child(div().text_size(10).text_color(t.dim).truncate().max_w(170).child(w.path.split("/").pop()))));
}

function repoMenu(graph, t) {
  const own = graph.ownRoot ? [{ name: graph.ownRoot.split("/").pop(), note: "this space", path: null }] : [];
  const choices = [...own, ...graph.repos.filter((r) => r.path !== graph.ownRoot).map((r) => ({ ...r, note: r.path.split("/").slice(0, -1).pop() }))];
  return v_flex().absolute().top(44).left(14).w(300).max_h(360).overflow_y_scrollbar().rounded(8).border_1().border_color(t.border).bg(t.popover).p(4).shadow_lg()
    .children(choices.map((r, i) => h_flex().id(`graph-repo-${i}`).h(28).px(8).gap(8).items_center().rounded(5).cursor_pointer().text_size(12)
      .when(r.path === graph.repo, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => graph.pickRepo(r.path, cx))
      .child(div().flex_1().min_w(0).truncate().child(r.name))
      .child(div().text_size(10).text_color(t.dim).truncate().max_w(120).child(r.note))));
}

export function renderGraphTab(graph, view, t) {
  const items = graph.fileItems();
  return v_flex().id("gitgraph").track_focus(view.handle).on_key_down((e, cx) => view.onKey(e, cx)).size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(13)
    .child(topBar(graph, t))
    .child(h_flex().w_full().flex_1().min_h(0).items_stretch()
      .child(leftPane(graph, view, t))
      .child(graph.file ? diffPane(graph, view, t) : graphList(graph, view, t))
      .when(graph.panelOpen, (e) => e.child(detailPane(graph, view, t, items))))
    .when(graph.picking && Boolean(graph.info), (e) => e.child(worktreeMenu(graph, t)))
    .when(graph.pickingRepo, (e) => e.child(repoMenu(graph, t)))
    .when(Boolean(graph.ask), (e) => e.child(askBar(graph, view, t)));
}
