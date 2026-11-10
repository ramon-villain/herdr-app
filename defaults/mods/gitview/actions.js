// What the branch menu and the diff's send button do beyond reading. Each one runs only from a click.
// The host's calls are passed in, so scripts/refmenu.test.ts drives them with a fake git, gh and fm-inbox.sh.
import { CATALOG, commitUrl, compareUrl } from "./refmenu.js";

const firstLine = (text) => (text ?? "").trim().split("\n")[0] || "no output";

const AUTH = /Authentication failed|Permission denied|could not read Username|Invalid username or password|Repository not found|returned error: 40[13]/;
const NETWORK = /Could not resolve host|Connection (timed out|refused|reset)|Network is unreachable|early EOF|timed out|unable to access/;

// git push prints "To <url>" before the refusal, and the url says nothing about why.
const PUSH_KINDS = [
  ["stale", /stale info/, "Rejected: the remote branch moved since it was last fetched"],
  ["behind", /non-fast-forward|fetch first|Updates were rejected/, "Rejected: the remote has commits this branch lacks (rebased?)"],
  ["hook", /remote rejected|hook declined|protected branch|GH006|GH013/, "Rejected by a hook or rule on the remote"],
  ["auth", AUTH, "Not signed in, or not allowed to push"],
  ["network", NETWORK, "Could not reach the remote"],
];

const PULL_KINDS = [
  ["diverged", /Not possible to fast-forward|non-fast-forward|diverging branches|have diverged/, "Not pulled: the branch has commits the remote lacks, so it is not a fast-forward"],
  ["dirty", /would be overwritten|local changes|unstaged changes|uncommitted changes/, "Not pulled: uncommitted changes in the checkout would be overwritten"],
  ["auth", AUTH, "Not signed in, or not allowed to read the remote"],
  ["network", NETWORK, "Could not reach the remote"],
];

function explain(kinds, stderr, fallback) {
  const lines = (stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("To "));
  for (const [kind, re, summary] of kinds) {
    const line = lines.find((l) => re.test(l));
    if (line) return { kind, summary, line };
  }
  return { kind: "other", summary: fallback, line: lines.find((l) => /rejected|error|fatal/i.test(l)) ?? lines[0] ?? "no output" };
}

/** Reads a failed push's stderr into its kind, the plain words for it and the git line that says so. */
export const explainPush = (stderr) => explain(PUSH_KINDS, stderr, "Push failed");

/**
 * @param {{ exec: Function, openLink: (url: string) => void, copy: (text: string) => void, notify: (n: object) => void, inbox: string, pushFailed?: (failure: object) => void }} host
 * `inbox` is the path of Firstmate's bin/fm-inbox.sh. `pushFailed` keeps the failure that the error toast's `gitview.pushError` action opens.
 */
export function createActions({ exec, openLink, copy, notify, inbox, pushFailed = () => {} }) {
  /** The toast stays until dismissed. `push` is what the branch menu saw of the remote branch: a lease for the force push only exists with it. */
  function reportPush({ root, on, remote, branch, sha, push, lease }, pushed) {
    const output = (pushed.stderr ?? "").trim() || (pushed.stdout ?? "").trim() || "no output";
    const why = explainPush(output);
    pushFailed({ ...why, title: `Push of ${branch} failed`, output, root, on, remote, branch, sha, push: why.kind === "behind" && !lease ? push : null });
    notify({ title: `Push of ${branch} failed`, body: `${why.summary} · ${why.line}`, level: "error", timeout: 86400000, action: { name: "gitview.pushError" } });
  }

  return {
    copyText(text, what) {
      copy(text);
      notify({ title: `Copied ${what}`, body: text.length > 80 ? `${text.slice(0, 77)}…` : text, level: "info", timeout: 2500 });
    },

    copyCommitLink(web, sha) { this.copyText(commitUrl(web, sha), "link to the commit"); },

    /** Pushes the branch to origin with its upstream set, then opens GitHub's page for a pull request from it. The only write to the repo. */
    async pushAndCompare({ root, on, branch, web, base, sha, push }) {
      notify({ title: `Pushing ${branch}`, body: "git push -u origin", level: "info", timeout: 2500 });
      let pushed;
      try { pushed = await exec("git", ["push", "-u", "origin", branch], { cwd: root, on, timeout: 120000 }); }
      catch (e) { pushed = { code: -1, stderr: String(e) }; }
      if (pushed.code !== 0) {
        reportPush({ root, on, remote: "origin", branch, sha, push }, pushed);
        return false;
      }
      openLink(compareUrl(web, base, branch));
      return true;
    },

    /**
     * Pushes `branch` to the branch of that name on `remote`. With `lease`, the remote tip the caller saw, it is a force push that
     * the remote refuses when someone moved that branch since. Resolves with whether it went through.
     */
    async pushBranch({ root, on, remote, branch, lease, sha, push }) {
      notify({ title: `Pushing ${branch}`, body: `git push ${remote}`, level: "info", timeout: 2500 });
      const args = ["push", ...(lease ? [`--force-with-lease=${branch}:${lease}`] : []), remote, branch];
      let pushed;
      try { pushed = await exec("git", args, { cwd: root, on, timeout: 120000 }); }
      catch (e) { pushed = { code: -1, stderr: String(e) }; }
      if (pushed.code !== 0) {
        reportPush({ root, on, remote, branch, sha, push, lease }, pushed);
        return false;
      }
      notify({ title: `Pushed ${branch}`, body: `${remote}/${branch}`, level: "success", timeout: 3000 });
      return true;
    },

    /**
     * Fast-forwards `branch` to its upstream and never merges, rebases or forces. `held` is the path of the worktree that has the branch
     * checked out, which is pulled in place; any other branch is moved by a fetch that git refuses unless it is a fast-forward.
     * Resolves with whether the branch is now current.
     */
    async pullBranch({ root, on, remote, upstream, branch, held }) {
      const run = (args, cwd = root) => exec("git", args, { cwd, on, timeout: 120000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      const tip = async () => (await run(["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).stdout.trim();
      notify({ title: `Pulling ${branch}`, body: `git ${held ? "pull" : "fetch"} ${remote}`, level: "info", timeout: 2500 });
      const before = await tip();
      const pulled = held ? await run(["pull", "--ff-only", remote, upstream], held) : await run(["fetch", remote, `${upstream}:${branch}`]);
      if (pulled.code !== 0) {
        const output = (pulled.stderr ?? "").trim() || (pulled.stdout ?? "").trim() || "no output";
        const why = explain(PULL_KINDS, output, "Pull failed");
        pushFailed({ ...why, title: `Pull of ${branch} failed`, output, root, on, branch, sha: before, push: null });
        notify({ title: `Pull of ${branch} failed`, body: `${why.summary} · ${why.line}`, level: "error", timeout: 86400000, action: { name: "gitview.pushError" } });
        return false;
      }
      const after = await tip();
      if (after === before) {
        notify({ title: `${branch} is up to date`, body: `${remote}/${upstream}`, level: "success", timeout: 3000 });
        return true;
      }
      const count = Number((await run(["rev-list", "--count", `${before}..${after}`])).stdout.trim());
      notify({ title: `${branch} moved`, body: `${before.slice(0, 7)} to ${after.slice(0, 7)} (${count} ${count === 1 ? "commit" : "commits"})`, level: "success", timeout: 6000 });
      return true;
    },

    /**
     * Deletes the local branch (never the remote one) when it is still at `sha`, then asks the catalog to archive every card that holds it.
     * The toast stays until dismissed and carries the command that restores the branch. Resolves with whether the branch went.
     */
    async deleteBranch({ root, on, name, sha }) {
      const run = (args) => exec("git", args, { cwd: root, on, timeout: 15000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      const tip = (await run(["rev-parse", "--verify", "-q", `refs/heads/${name}`])).stdout.trim();
      if (tip !== sha) {
        notify({ title: `Kept ${name}`, body: tip ? `it moved to ${tip.slice(0, 7)} since you looked` : "it is already gone", level: "error", timeout: 8000 });
        return false;
      }
      const deleted = await run(["branch", "-D", name]);
      if (deleted.code !== 0) {
        notify({ title: `Could not delete ${name}`, body: firstLine(deleted.stderr || deleted.stdout), level: "error", timeout: 86400000 });
        return false;
      }
      let archived = null;
      try {
        const r = await exec("curl", ["-s", "-m", "10", "-X", "POST", "-H", `Origin: ${CATALOG}`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ branch: name }), `${CATALOG}/api/branch-archive`], { timeout: 15000 });
        archived = JSON.parse(r.stdout).archived;
      } catch { /* the catalog is down or refused, the toast says so */ }
      const cards = archived ? `${archived.length} ${archived.length === 1 ? "card" : "cards"} archived` : "cards not archived (catalog did not answer)";
      notify({ title: `Deleted ${name}`, body: `${cards} · restore: git -C ${root} branch ${name} ${sha}`, level: archived ? "success" : "warning", timeout: 86400000 });
      return true;
    },

    /** Files one captain note through fm-inbox.sh, the queue the browser extension's notes end in. Resolves with the note's id. */
    async sendNote(requestId, body) {
      const r = await exec(inbox, ["note", "--request-id", requestId, "--", body], { timeout: 20000 });
      const m = /^(queued|replay) (\S+)/m.exec(r.stdout ?? "");
      if (r.code !== 0 || !m) throw new Error(firstLine(r.stderr || r.stdout));
      notify({ title: "Sent to firstmate", body: m[2], level: "success", timeout: 3000 });
      return m[2];
    },
  };
}
