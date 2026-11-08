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
