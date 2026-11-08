// The captain note for a selection in the Git graph's diff, shaped like the browser extension's notes
// (a tag line, the typed message, labelled context lines, the selection quoted). No host calls.

export const NOTE_TAG = "[herdr] ask";
const SELECTION_LIMIT = 4000;

const line = (label, value) => (value ? `${label}: ${String(value).replace(/\s+/g, " ").slice(0, 500)}` : "");
const span = (from, to) => (from === to ? String(from) : `${from}-${to}`);

/** The new-side and old-side line numbers a run of diff rows covers; removed lines only count on the old side. */
export function lineRanges(rows) {
  let next = null, old = null;
  for (const r of rows) {
    if (r.next !== undefined) next = next ? [Math.min(next[0], r.next), Math.max(next[1], r.next)] : [r.next, r.next];
    else if (r.kind === "-" && r.old !== undefined) old = old ? [Math.min(old[0], r.old), Math.max(old[1], r.old)] : [r.old, r.old];
  }
  return { next, old };
}

/** The selected rows as they read in a diff: a sign column first, hunk headers as they are. */
export function selectedText(rows) {
  const text = rows.map((r) => (r.kind === "@" || r.kind === "" ? r.text : `${r.kind || " "}${r.text}`)).join("\n");
  return text.length > SELECTION_LIMIT ? `${text.slice(0, SELECTION_LIMIT)}\n… (cut: the selection is longer)` : text;
}

/**
 * @param {{ message?: string, repo: { name: string, root: string }, commit: { sha: string, subject?: string } | null, branches: string[], file: string, mode: "diff" | "file", rows: object[] }} note
 * `commit` is null for the uncommitted changes of a working copy.
 */
export function noteBody({ message, repo, commit, branches, file, mode, rows }) {
  const { next, old } = lineRanges(rows);
  const lines = [next && `${span(...next)}${old ? " (new side)" : ""}`, old && `${next ? "removed " : ""}${span(...old)} (old side)`].filter(Boolean).join(", ");
  const text = selectedText(rows);
  return [
    NOTE_TAG, (message ?? "").trim() || "Look at this selection from the Herdr Git view.", "",
    ...[
      line("Repo", `${repo.name} (${repo.root})`),
      line("Commit", commit ? `${commit.sha.slice(0, 11)} ${commit.subject ?? ""}` : "uncommitted changes in the working copy"),
      line("Branch", branches.join(", ")),
      line("File", file),
      line("Lines", lines),
      line("View", mode === "file" ? "File View" : "Diff View"),
    ].filter(Boolean),
    `Selection:\n${text.replace(/^/gm, "> ")}`,
  ].join("\n");
}

/**
 * The note for a question about a branch, tag or commit, from the right-click menu: the tag line, the typed message and labelled context lines.
 * @param {{ message?: string, repo: { name: string, root: string }, ref: { type: "branch" | "remote" | "tag" | "commit", name: string, sha: string | null, subject?: string } }} note
 */
export function askBody({ message, repo, ref }) {
  const commit = ref.sha ? `${ref.sha.slice(0, 11)}${ref.subject ? ` ${ref.subject}` : ""}` : "";
  return [
    NOTE_TAG, (message ?? "").trim() || "Look at this from the Herdr Git view.", "",
    ...[
      line("Repo", `${repo.name} (${repo.root})`),
      ref.type === "commit" ? "" : line(ref.type === "tag" ? "Tag" : ref.type === "remote" ? "Remote branch" : "Branch", ref.name),
      line(ref.type === "commit" ? "Commit" : "Tip", commit),
    ].filter(Boolean),
  ].join("\n");
}
