// Pure helpers for the graph view: no host calls, so scripts/gitgraph.test.ts runs them on their own.

const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

/** "10 hours ago": the time marker the graph draws where the age bucket changes. */
export function agoLabel(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 3600) return plural(Math.max(1, Math.floor(s / 60)), "minute");
  if (s < 48 * 3600) return plural(Math.floor(s / 3600), "hour");
  if (s < 60 * 86400) return plural(Math.floor(s / 86400), "day");
  if (s < 730 * 86400) return plural(Math.floor(s / (30 * 86400)), "month");
  return plural(Math.floor(s / (365 * 86400)), "year");
}

/** Local branches as a flat list: folders by "/" prefix first, then branches, each sorted by name. */
export function branchTree(names, filter = "", collapsed = new Set()) {
  const needle = filter.toLowerCase(), root = { dirs: new Map(), leaves: [] };
  for (const name of names) {
    if (needle && !name.toLowerCase().includes(needle)) continue;
    const parts = name.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), leaves: [] });
      node = node.dirs.get(part);
    }
    node.leaves.push({ name, leaf: parts[parts.length - 1] });
  }
  const count = (node) => node.leaves.length + [...node.dirs.values()].reduce((n, d) => n + count(d), 0);
  const items = [];
  const walk = (node, prefix, depth) => {
    for (const [dir, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + dir, open = !collapsed.has(path);
      items.push({ type: "folder", path, name: dir, depth, count: count(child), open });
      if (open) walk(child, `${path}/`, depth + 1);
    }
    for (const { name, leaf } of node.leaves.sort((a, b) => a.name.localeCompare(b.name))) items.push({ type: "branch", name, leaf, depth });
  };
  walk(root, "", 0);
  return items;
}

/** Changed files as a flat tree: a folder row for each new directory, then its files. */
export function fileTree(files) {
  const items = [], seen = new Set();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      if (seen.has(path)) continue;
      seen.add(path);
      items.push({ type: "folder", path, name: parts[i], depth: i });
    }
    items.push({ type: "file", file, name: parts[parts.length - 1], depth: parts.length - 1 });
  }
  return items;
}

const WORDS = /\w+|\s+|[^\w\s]/g;

/** The middle of two lines that differ: [start, end) in the old line and in the new one, or null when there is no common part to leave out. */
export function wordDiff(a, b) {
  const x = a.match(WORDS) ?? [], y = b.match(WORDS) ?? [];
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  if (head === 0 && tail === 0) return null;
  if (head + tail === x.length && head + tail === y.length) return null;
  const len = (t, from, to) => t.slice(from, to).reduce((n, s) => n + s.length, 0);
  const start = len(x, 0, head), startB = len(y, 0, head);
  return { old: [start, start + len(x, head, x.length - tail)], next: [startB, startB + len(y, head, y.length - tail)] };
}

/** Pairs each run of removed lines with the added run that follows it. A pair's changed words are found when a row's `mark` is first read, so only the rows drawn pay for it. */
export function markWords(rows) {
  const out = rows.map((r) => ({ ...r }));
  for (let i = 0; i < out.length;) {
    if (out[i].kind !== "-") { i++; continue; }
    let j = i;
    while (j < out.length && out[j].kind === "-") j++;
    let k = j;
    while (k < out.length && out[k].kind === "+") k++;
    const pairs = Math.min(j - i, k - j);
    for (let n = 0; n < pairs; n++) {
      const removed = out[i + n], added = out[j + n];
      let diff;
      const words = () => (diff === undefined ? (diff = wordDiff(removed.text, added.text)) : diff);
      Object.defineProperty(removed, "mark", { enumerable: true, get: () => words()?.old });
      Object.defineProperty(added, "mark", { enumerable: true, get: () => words()?.next });
    }
    i = k;
  }
  return out;
}

const KEYWORDS = {
  js: "const let var function return if else for while switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof of in this null undefined true false type interface enum implements as",
  rb: "def end class module if elsif else unless case when while until do return yield begin rescue ensure raise require include extend self nil true false and or not then lambda proc",
  py: "def class return if elif else for while in import from as with try except finally raise lambda yield pass None True False and or not is async await",
  rs: "fn let mut pub struct enum impl trait use mod match if else for while loop return self Self crate const static async await move ref true false where as in",
  css: "important",
};
const FAMILY = { ts: "js", tsx: "js", jsx: "js", mjs: "js", cjs: "js", js: "js", rb: "rb", rake: "rb", py: "py", rs: "rs", css: "css", scss: "css", json: "js" };
const HASH_COMMENT = new Set(["rb", "py"]);
const SYNTAX = new Map();

/** A small per-line tokenizer: the app's own highlighter is the Editor component, which cannot colour one row of a diff. */
export function tokenize(text, ext) {
  const family = FAMILY[ext];
  if (!family) return [[text, ""]];
  if (!SYNTAX.has(family)) {
    const words = KEYWORDS[family].split(" ").join("|");
    const comment = HASH_COMMENT.has(family) ? "#.*" : "\\/\\/.*";
    SYNTAX.set(family, new RegExp(`(${comment})|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b\\d[\\w.]*)|\\b(${words})\\b`, "g"));
  }
  const re = SYNTAX.get(family), out = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push([text.slice(at, m.index), ""]);
    out.push([m[0], m[1] ? "comment" : m[2] ? "string" : m[3] ? "number" : "keyword"]);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push([text.slice(at), ""]);
  return out.length ? out : [[text, ""]];
}

/** Cuts a line into runs that share a syntax kind and a changed-words flag. */
export function lineSegments(text, ext, mark) {
  const out = [];
  let at = 0;
  for (const [piece, kind] of tokenize(text, ext)) {
    const end = at + piece.length;
    const cuts = mark ? [mark[0], mark[1]].filter((c) => c > at && c < end) : [];
    let from = at;
    for (const cut of [...cuts, end]) {
      out.push({ text: text.slice(from, cut), kind, hl: Boolean(mark) && from >= mark[0] && cut <= mark[1] });
      from = cut;
    }
    at = end;
  }
  return out;
}

/** Indexes of the rows that open a hunk. */
export const hunkStarts = (rows) => rows.flatMap((r, i) => (r.kind === "@" ? [i] : []));

/** The hunk to step to from the row at `top`: the next one below, or the previous one above. */
export function stepHunk(starts, top, direction) {
  if (!starts.length) return null;
  if (direction > 0) return starts.find((s) => s > top) ?? starts[starts.length - 1];
  return [...starts].reverse().find((s) => s < top) ?? starts[0];
}

/** Rows of the commit list with the age marker the graph draws where the bucket changes. */
export function withMarkers(commits, now = Date.now()) {
  let last = null;
  return commits.map((c) => {
    const label = agoLabel(c.time, now), marker = label !== last ? label : null;
    last = label;
    return marker ? { ...c, marker } : c;
  });
}
