// Lane layout for the commit graph: a pure function from commits (newest first, children before
// parents, as `git log --topo-order` gives them) to the lane and colour of every commit and the
// lines to draw in its row. It is paged: pass the `carry` of one page to the next.

export const COLORS = 12;

const free = (lanes) => {
  const i = lanes.indexOf(null);
  return i < 0 ? lanes.length : i;
};
const target = (lanes, sha) => lanes.findIndex((l) => l && l.sha === sha);

/**
 * @param {{ sha: string, parents: string[] }[]} commits
 * @param {{ lanes: ({ sha: string, color: number } | null)[], color: number }} [carry]
 * @returns {{ rows: Row[], carry: object }} where a Row is
 *   { sha, lane, color,
 *     top: a line comes into the dot from above,
 *     merging: [{ lane, color }] other lanes that end at this commit (a vertical from the top, then across),
 *     pass: [{ lane, color }] lanes that run straight through the row,
 *     edges: [{ to, color }] one per parent: straight down when `to` is the dot's lane, else across then down,
 *     width: lanes in use in this row }
 */
export function layoutLanes(commits, carry = { lanes: [], color: 0 }) {
  const lanes = carry.lanes.slice();
  let nextColor = carry.color;
  const fresh = () => nextColor++ % COLORS;
  const rows = [];
  for (const { sha, parents } of commits) {
    let lane = -1;
    const merging = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.sha !== sha) continue;
      if (lane < 0) lane = i;
      else merging.push({ lane: i, color: lanes[i].color });
    }
    const top = lane >= 0;
    const color = top ? lanes[lane].color : fresh();
    if (!top) lane = free(lanes);

    const ending = new Set(merging.map((m) => m.lane));
    const pass = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] && i !== lane && !ending.has(i)) pass.push({ lane: i, color: lanes[i].color });

    lanes[lane] = null;
    for (const m of merging) lanes[m.lane] = null;

    const edges = [];
    parents.forEach((parent, k) => {
      // A first parent always keeps this commit's own lane, so a branch stays visible down to the commit it forks from.
      const known = k === 0 ? -1 : target(lanes, parent);
      if (known >= 0) { edges.push({ to: known, color: lanes[known].color }); return; }
      const to = k === 0 ? lane : free(lanes), c = k === 0 ? color : fresh();
      lanes[to] = { sha: parent, color: c };
      edges.push({ to, color: c });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane, ...pass.map((p) => p.lane), ...merging.map((m) => m.lane), ...edges.map((e) => e.to)) + 1;
    rows.push({ sha, lane, color, top, merging, pass, edges, width });
  }
  return { rows, carry: { lanes, color: nextColor } };
}
