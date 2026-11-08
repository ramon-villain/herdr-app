import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { settings } from "herdr";

const ROW = 26;

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const baseName = (snap) => snap.base?.replace(/^origin\//, "") ?? "master";
const chip = (t, text, color) => div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(color ?? t.muted).flex_none().child(text);

function pushedChip(t, snap) {
  if (snap.pushed === "pushed") return chip(t, "pushed", t.ansi2);
  if (snap.pushed === "unpushed") return chip(t, snap.unpushedCommits ? `${snap.unpushedCommits} unpushed` : "unpushed", t.blocked);
  return chip(t, "not pushed", t.blocked);
}

function aheadBehind(t, snap) {
  if (snap.ahead === null) return chip(t, "no base");
  return chip(t, `↑${snap.ahead} ↓${snap.behind} ${baseName(snap)}`, snap.ahead || snap.behind ? t.foreground : t.muted);
}

function header(view, t, cx) {
  const tab = (mode, label) => div().id(`gitview-${mode}`).px(10).py(4).rounded(6).text_size(12).cursor_pointer()
    .bg(view.mode === mode ? t.selected : t.background).text_color(view.mode === mode ? t.foreground : t.muted)
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => view.setMode(mode, cx)).child(label);
  return h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
    .child(tab("changes", "Changes")).child(tab("branches", "Branches"))
    .child(div().flex_1())
    .child(div().id("gitview-graph").px(10).py(4).rounded(6).text_size(12).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).on_click(() => view.openGraph()).child("Graph ↗"));
}

function summary(view, t) {
  const snap = view.snap;
  if (!snap) return div().p(12).text_color(t.dim).child(view.error || (view.loading ? "Loading…" : "No folder"));
  return v_flex().flex_none().px(12).py(8).gap(4).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().font_semibold().truncate().min_w(0).child(snap.detached ? `detached at ${snap.sha?.slice(0, 7) ?? ""}` : snap.branch))
      .child(div().flex_1()).child(aheadBehind(t, snap)).child(pushedChip(t, snap)))
    .when(Boolean(snap.latest), (el) => el.child(h_flex().gap(8).text_size(11).text_color(t.muted)
      .child(div().text_color(t.dim).flex_none().child(snap.latest.sha.slice(0, 7)))
      .child(div().flex_1().min_w(0).truncate().child(snap.latest.subject))
      .child(div().text_color(t.dim).flex_none().child(ago(snap.latest.time)))));
}

// One flat list so the window only draws the rows on screen, even with thousands of files.
function listItems(snap) {
  const items = [];
  const section = (id, title, files, total) => {
    if (!total) return;
    items.push({ head: title, count: total });
    for (const file of files) items.push({ section: id, file });
    if (total > files.length) items.push({ more: total - files.length });
  };
  section("uncommitted", "Uncommitted", snap.uncommitted, snap.uncommittedTotal);
  section("unpushed", snap.pushed === "none" ? "Committed, not on origin" : "Committed, not pushed", snap.unpushed, snap.unpushedTotal);
  return items;
}

function listRow(view, t, item) {
  if (item.head) return h_flex().w_full().h(ROW).flex_none().px(8).gap(6).items_center().text_size(11).text_color(t.dim).child(div().font_semibold().child(item.head)).child(`${item.count}`);
  if (item.more) return div().w_full().h(ROW).flex_none().px(8).text_size(11).text_color(t.dim).child(`+${item.more} more not listed`);
  const { section, file } = item, parts = file.path.split("/"), name = parts.pop();
  const on = view.open?.section === section && view.open.path === file.path;
  const color = file.status === "A" ? t.ansi2 : file.status === "M" ? t.blocked : t.ansi1;
  return h_flex().id(`gitview-${section}-${file.path}`).w_full().h(ROW).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
    .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
    .child(div().w(14).text_size(11).text_color(color).child(file.status))
    .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
    .when(file.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${file.add}`)))
    .when(file.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${file.del}`)));
}

function diffRow({ kind, number, text }, t) {
  if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
  return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
    .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
    .child(div().flex_1().min_w(0).truncate().child(text));
}

function changes(view, t) {
  const snap = view.snap, items = snap ? listItems(snap) : [];
  return v_flex().flex_1().min_h(0)
    .child(summary(view, t))
    .when(Boolean(snap), (el) => el
      .child(div().flex_1().min_h(60).max_h(items.length * ROW + 12).relative().border_b(1).border_color(t.border)
        .child(v_virtual_list("gitview-files", items.length, ROW, (i) => items[i].file ? `${items[i].section}\0${items[i].file.path}` : `row:${i}`, (range) => items.slice(range.start, range.end).map((item) => listRow(view, t, item)))
          .on_item_click((key, cx) => { const [section, path] = key.split("\0"); if (path) view.pick(section, path, cx); }).size_full().p(6))
        .child(Scrollbar.vertical("gitview-files").viewport_from_layout().absolute().inset_0())
        .when(!items.length, (e) => e.child(div().absolute().p(12).text_color(t.dim).child("Nothing changed or unpushed"))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("gitview-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(view.diffWidth).h_full().child(v_virtual_list("gitview-diff", view.diff.length, 20, (i) => String(i),
            (range) => view.diff.slice(range.start, range.end).map((row) => diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("gitview-diff").viewport_from_layout().absolute().inset_0())
        .when(!view.open && items.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes")))));
}

function branchRow(view, t, { space, on, snap }) {
  const base = h_flex().id(`gitview-space-${space.id}`).flex_none().w_full().px(12).py(8).gap(10).cursor_pointer()
    .when(space.active, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => { view.select(space.id); cx.notify(); });
  if (!snap?.ok) {
    return base.child(v_flex().flex_1().min_w(0).gap(2).child(div().font_semibold().truncate().child(space.name))
      .child(div().text_size(11).text_color(t.dim).child(snap?.reason ?? "Loading…")));
  }
  const pr = view.prs.get(view.prKey(snap, on));
  return base.child(v_flex().flex_1().min_w(0).gap(3)
    .child(h_flex().gap(8).items_center()
      .child(div().font_semibold().flex_1().min_w(0).truncate().child(space.name))
      .when(Boolean(pr), (e) => e.child(div().id(`gitview-pr-${space.id}`).flex_none().text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); view.openLink(pr.url); }).child(`${pr.state === "MERGED" ? "merged " : pr.isDraft ? "draft " : ""}PR #${pr.number}`))))
    .child(div().text_size(11).text_color(t.muted).truncate().child(snap.detached ? `detached at ${snap.sha?.slice(0, 7) ?? ""}` : snap.branch))
    .when(Boolean(snap.latest), (e) => e.child(h_flex().gap(8).text_size(11).text_color(t.muted)
      .child(div().text_color(t.dim).flex_none().child(snap.latest.sha.slice(0, 7)))
      .child(div().flex_1().min_w(0).truncate().child(snap.latest.subject))
      .child(div().text_color(t.dim).flex_none().child(ago(snap.latest.time)))))
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(aheadBehind(t, snap)).child(pushedChip(t, snap))
      .when(snap.uncommittedTotal > 0, (e) => e.child(chip(t, `${snap.uncommittedTotal} uncommitted`, t.blocked)))));
}

function branches(view, t) {
  return div().flex_1().min_h(0).relative()
    .child(v_flex().id("gitview-branches").absolute().inset_0().overflow_y_scroll().children(view.rows.map((row) => branchRow(view, t, row)))
      .when(!view.rows.length, (e) => e.child(div().p(12).text_color(t.dim).child(view.loading ? "Loading…" : "No spaces"))))
    .child(Scrollbar.vertical("gitview-branches").absolute().inset_0());
}

export function renderPanel(view, t) {
  return v_flex().id("gitview").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
    .child(header(view, t))
    .child(view.mode === "changes" ? changes(view, t) : branches(view, t));
}
