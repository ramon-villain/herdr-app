// What the branch menu and the diff's send button do beyond reading. Each one runs only from a click.
// The host's calls are passed in, so scripts/refmenu.test.ts drives them with a fake git, gh and fm-inbox.sh.
import { commitUrl, compareUrl } from "./refmenu.js";

const firstLine = (text) => (text ?? "").trim().split("\n")[0] || "no output";

/**
 * @param {{ exec: Function, openLink: (url: string) => void, copy: (text: string) => void, notify: (n: object) => void, inbox: string }} host
 * `inbox` is the path of Firstmate's bin/fm-inbox.sh.
 */
export function createActions({ exec, openLink, copy, notify, inbox }) {
  return {
    copyText(text, what) {
      copy(text);
      notify({ title: `Copied ${what}`, body: text.length > 80 ? `${text.slice(0, 77)}…` : text, level: "info", timeout: 2500 });
    },

    copyCommitLink(web, sha) { this.copyText(commitUrl(web, sha), "link to the commit"); },

    /** Pushes the branch to origin with its upstream set, then opens GitHub's page for a pull request from it. The only write to the repo. */
    async pushAndCompare({ root, on, branch, web, base }) {
      notify({ title: `Pushing ${branch}`, body: "git push -u origin", level: "info", timeout: 2500 });
      let pushed;
      try { pushed = await exec("git", ["push", "-u", "origin", branch], { cwd: root, on, timeout: 120000 }); }
      catch (e) { pushed = { code: -1, stderr: String(e) }; }
      if (pushed.code !== 0) {
        notify({ title: `Push of ${branch} failed`, body: firstLine(pushed.stderr), level: "error" });
        return false;
      }
      openLink(compareUrl(web, base, branch));
      return true;
    },

    /**
     * Pushes `branch` to the branch of that name on `remote`. With `lease`, the remote tip the caller saw, it is a force push that
     * the remote refuses when someone moved that branch since. Resolves with whether it went through.
     */
    async pushBranch({ root, on, remote, branch, lease }) {
      notify({ title: `Pushing ${branch}`, body: `git push ${remote}`, level: "info", timeout: 2500 });
      const args = ["push", ...(lease ? [`--force-with-lease=${branch}:${lease}`] : []), remote, branch];
      let pushed;
      try { pushed = await exec("git", args, { cwd: root, on, timeout: 120000 }); }
      catch (e) { pushed = { code: -1, stderr: String(e) }; }
      if (pushed.code !== 0) {
        const lines = (pushed.stderr ?? "").split("\n");
        notify({ title: `Push of ${branch} failed`, body: firstLine(lines.find((l) => /rejected|error|fatal/i.test(l)) ?? pushed.stderr), level: "error" });
        return false;
      }
      notify({ title: `Pushed ${branch}`, body: `${remote}/${branch}`, level: "success", timeout: 3000 });
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
