// The popup a right-click on a branch opens: the actions for the refs it was opened on, drawn the way the app's own menu draws.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { menuEntries, MENU_ROW } from "./refmenu.js";

export function renderRefMenu(state, menu, t, choose, pickRef) {
  const ref = menu.refs[state.ref], list = menuEntries(ref, menu.web);
  let n = -1;
  const header = menu.refs.length === 1
    ? h_flex().h(30).px(8).items_center().text_size(11).text_color(t.muted).child(div().truncate().child(ref.name))
    : h_flex().h(30).px(4).gap(4).items_center().overflow_hidden().children(menu.refs.map((r, i) => div().id(`gv-ref-${i}`).px(6).h(22).flex().items_center().flex_none().max_w(110).truncate().rounded(5).text_size(11)
      .when(i === state.ref, (e) => e.bg(t.selected).text_color(t.foreground)).when(i !== state.ref, (e) => e.text_color(t.muted)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => pickRef(i, cx)).child(r.name)));
  return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
    .child(header)
    .children(list.map((entry) => {
      if (!entry) return div().mx(7).my(4).h(1).bg(t.border);
      const i = ++n;
      return h_flex().id(`gv-menu-${entry.id}`).h(MENU_ROW).px(8).rounded(7).items_center().text_color(t.foreground)
        .when(i === state.at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => choose(entry, cx))
        .child(div().flex_1().truncate().child(entry.label));
    }));
}

/** The dialog a failed push's toast opens: why it failed, the git line that says so, and all of git's output. */
export function renderPushError(failure, t, font, { copy, force, close }) {
  const button = (id, label, onClick) => h_flex().id(id).h(28).px(12).items_center().rounded(7).border_1().border_color(t.input).bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
  return v_flex().id("gv-push-error").size_full().min_h(0).p(18).gap(10).rounded(8).bg(t.popover).text_size(13)
    .child(div().text_size(15).font_semibold().text_color(t.foreground).child(failure.title))
    .child(div().text_color(t.foreground).child(failure.summary))
    .child(div().font_family(font).text_size(12).text_color(t.muted).child(failure.line))
    .child(div().id("gv-push-output").flex_1().min_h(0).max_h(320).overflow_y_scrollbar().p(8).rounded(6).bg(t.background).font_family(font).text_size(11).text_color(t.muted).child(failure.output))
    .child(h_flex().justify_end().gap(8).text_size(12)
      .child(button("gv-push-copy", "Copy output", (_e, cx) => copy(cx)))
      .when(Boolean(failure.push), (e) => e.child(button("gv-push-force", "Force push (with lease)...", (_e, cx) => force(cx))))
      .child(button("gv-push-close", "Close", () => close())));
}
