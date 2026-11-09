// Pure helpers for the Git graph's branch menu: where a branch lives on GitHub, which pull request it has, and what the menu offers.
// No host calls, so scripts/refmenu.test.ts runs them on their own.

/** "https://github.com/owner/repo" for an origin URL (https, ssh:// or scp-like), or null when origin is not on github.com. */
export function webUrl(remote) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[/:](?:\d+\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec((remote ?? "").trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

const encodeRef = (name) => name.split("/").map(encodeURIComponent).join("/");

const CATALOG = "http://catalog.localhost:8888";

/** Firstmate's catalog page for a branch: it redirects to the card that names it and answers 404 when none does. */
export const catalogUrl = (branch) => `${CATALOG}/branch/${encodeRef(branch)}`;

export const commitUrl = (web, sha) => `${web}/commit/${sha}`;

/** GitHub's page for opening a pull request from `branch` into `base`. */
export const compareUrl = (web, base, branch) => `${web}/compare/${base ? `${encodeRef(base)}...` : ""}${encodeRef(branch)}?expand=1`;

/** The branch a remote-tracking name like "origin/feat/x" stands for. */
export const branchOf = (ref) => (ref.type === "remote" ? ref.name.replace(/^[^/]+\//, "") : ref.name);

/**
 * The pull request each branch has, from the lists `gh pr list --json headRefName,number,url,state,isDraft` printed:
 * an open one wins over any other, else the newest.
 */
export function prsByBranch(...lists) {
  const best = new Map();
  for (const list of lists) {
    for (const pr of list) {
      const have = best.get(pr.headRefName);
      const open = pr.state === "OPEN";
      if (!have || (open !== (have.state === "OPEN") ? open : pr.number > have.number)) best.set(pr.headRefName, pr);
    }
  }
  return best;
}

/**
 * The rows of the menu for one ref, in order; `null` is a divider.
 * @param {{ type: "branch" | "remote" | "tag" | "commit", name: string, sha?: string, hidden?: boolean, solo?: boolean, pr?: { number: number, state: string } | null, push?: { remote: string, ahead: number, behind: number } | null }} ref
 * @param {string | null} web the repository's page on GitHub, when origin is there
 */
export function menuEntries(ref, web) {
  const isTag = ref.type === "tag", rows = [];
  if (ref.type === "commit") {
    rows.push({ id: "copySha", label: "Copy commit sha" });
    if (web) rows.push({ id: "copyLink", label: "Copy link to commit on origin" });
    rows.push({ id: "askFm", label: "Ask firstmate..." });
    return rows;
  }
  rows.push({ id: "solo", label: ref.solo ? "Unsolo" : "Solo" }, { id: "hide", label: ref.hidden ? "Show" : "Hide" }, null);
  rows.push({ id: "copyName", label: isTag ? "Copy tag name" : "Copy branch name" });
  if (ref.sha) rows.push({ id: "copySha", label: "Copy commit sha" });
  if (ref.sha && web) rows.push({ id: "copyLink", label: "Copy link to commit on origin" });
  rows.push({ id: "askFm", label: "Ask firstmate..." });
  const tail = [], push = ref.push;
  if (ref.type === "branch" && push?.ahead) {
    tail.push(push.behind
      ? { id: "forcePush", label: "Force push (with lease)" }
      : { id: "push", label: `Push ${push.ahead} ${push.ahead === 1 ? "commit" : "commits"} to ${push.remote}` });
  }
  if (!isTag && web) {
    const pr = ref.pr, open = pr?.state === "OPEN";
    if (pr) tail.push({ id: "openPr", label: `Open PR #${pr.number}${open ? "" : ` (${pr.state.toLowerCase()})`}` });
    if (!open && pr?.state !== "MERGED") tail.push(ref.type === "branch" ? { id: "pushPr", label: "Push and create PR" } : { id: "createPr", label: "Create PR" });
  }
  if (!isTag) tail.push({ id: "openCard", label: "Open catalog card" });
  if (tail.length) rows.push(null, ...tail);
  return rows;
}

const ROW = 28, DIVIDER = 9, HEAD = 30, PAD = 10;
export const MENU_ROW = ROW;
export const MENU_WIDTH = 260;

const rowsOf = (menu, i) => menuEntries(menu.refs[i], menu.web);

/** The popup's height for the longest list among the refs it can show. */
export function menuHeight(menu) {
  const longest = Math.max(...menu.refs.map((_r, i) => {
    const list = rowsOf(menu, i);
    return list.filter(Boolean).length * ROW + list.filter((e) => !e).length * DIVIDER;
  }));
  return PAD + HEAD + longest;
}

/** Up, down, Enter and Esc over the actions: true when the highlight moved, the action on Enter, "close" on Esc, false for a key it does not use. */
export function menuKey(state, key, menu) {
  const actions = rowsOf(menu, state.ref).filter(Boolean);
  if (key === "down") state.at = (state.at + 1) % actions.length;
  else if (key === "up") state.at = (state.at + actions.length - 1) % actions.length;
  else if (key === "enter") return actions[state.at] ?? true;
  else if (key === "escape") return "close";
  else return false;
  return true;
}
