# Local review comments: design

PR-style review threads that live on the local machine, are specific to a branch, and are shared by three participants:

- a **reviewer** agent that drafts threads;
- a **builder** agent that fixes the code, replies, and marks threads addressed or disputed;
- the **human**, who approves the reviewer's drafts and reads, replies, reopens and resolves threads in VS Code.

There is no GitHub, server or account, and nothing is written to the source files.

## Where it lives

- **Repository:** this one, `local-review`. It is a TypeScript monorepo with three packages:
  - `core`: the file format, reading and writing, status rules and re-anchoring. Shared by the other two, so they can't disagree.
  - `cli`: the `lrv` command that agents call.
  - `extension`: the VS Code extension.
- **Extension:** installed once at user level from a `.vsix` file, so every workspace gets it.
- **CLI:** installed once globally (`npm install -g`), so agents can call it from any repo.
- **Agent instructions:** a user-level Claude Code skill (`~/.claude/skills/local-review/`, source in `skill/`) that explains the workflow and the CLI. Every repo gets it, without any changes to that repo.
- **Review data:** stays inside each repo's `.git` folder. It is never committed and goes away with the clone.

## Storage

```
<git common dir>/review/<encoded branch>/<thread id>/
  thread.yaml                                   # file and anchor; written once
  20261027T112240123Z-k3f9a1-reviewer.yaml      # { body: ..., status: draft }
  20261027T113005310Z-77c0de-human.yaml         # { status: open }
  20261027T114002871Z-p81c22-builder.yaml       # { body: ..., status: addressed }
```

- **Inside `.git`:** never committed, and nothing needs to be added to `.gitignore`.
- **Git common dir** (`git rev-parse --git-common-dir`): worktrees of the same repo share reviews.
- **Branch folder name:** the branch name, URL-encoded (`feature/x` becomes `feature%2Fx`), so branch names can never collide with thread folders. A detached HEAD uses `detached-<short sha>`.
- **Clean-up:** delete the branch's folder, or run `lrv clear`.

### Append-only events

Files are never rewritten. Every action is a new, immutable event file.

- **Event file name:** a UTC timestamp to the millisecond, a random suffix and the author. Events sort by file name, which orders them by time, with the suffix breaking ties. The time and author are read from the name and not repeated inside the file.
- **Event contents:** any of `body` (a comment), `status` (a status change) and `edits` (the id of an earlier comment whose body this event replaces). An edit carries a body and nothing else.
- **Creating a file:** the writer writes the content to a hidden temporary file in the same folder, hard-links it to the final name, then deletes the temporary file. Linking fails if the name already exists, so no write can replace another, and readers never see a half-written event. Readers ignore names starting with `.`.
- **Creating a thread:** the writer creates the thread folder (creating a folder fails if it exists, so ids can't clash), writes the first event, and writes `thread.yaml` last. Readers skip folders without `thread.yaml`, so a thread only appears once it is complete.
- **Deleting a thread:** removes its folder. This is the only destructive action, and only the human does it.
- **Unrecognised files** in a thread folder are an error, not silently skipped.

### Thread file

```yaml
file: src/orders/OrderService.cs
anchor:
  startLine: 52
  endLine: 54
  commit: 3f2a9c1e8b4d...   # HEAD when the thread was created; null before the first commit
  dirty: false              # true if the anchored text differed from that commit
  snippet: |
    var total = order.Lines.Sum(line => line.Price);
```

### Derived state

- **Status:** the `status` of the latest event that has one.
- **Comments:** every event with a body that is not an edit, in order, with later edits applied. Status-only events show as entries in the thread's history.
- **Created by / at:** the first event.
- **Location and outdated:** worked out on read (see Anchoring), never stored.

## Statuses

| Status | Set by | Meaning |
| --- | --- | --- |
| `draft` | reviewer (on creation) | Proposed, awaiting the human's approval. Hidden from the builder. |
| `open` | human (publishing a draft, or reopening); reviewer (reopening) | Needs action. |
| `addressed` | builder, human | Fixed; the reply says how. Waits for the reviewer or the human. |
| `disputed` | builder, human | Not changing it; the reply says why. |
| `resolved` | reviewer, human | Done. |

- **Roles:** the author names `reviewer` and `builder` are the two agent roles. Any other author name, `human` by default, has the human's rights.
- **Creating threads:** the reviewer can only create drafts. Anyone else creates open threads.
- **Drafts:** only the human can change a draft, by publishing it (an `open` event), editing it or deleting it. The builder can't read or write drafts.
- **Reopening:** an explicit `open` event; a reply never changes the status on its own.
- **Editing:** authors can edit their own comments. The human can also edit the reviewer's comments on a draft before publishing it.
- **Invalid changes** (the builder resolving, a status set to what it already is) are rejected with an error.

## Anchoring

When the code moves, the thread should follow it. When the code under it changes, the thread is marked outdated, the same way GitHub does.

1. **Committed anchor** (`dirty: false`, and the commit still has the file): run `git diff -U0 <commit> -- <file>` against the working tree and shift the line range through the hunks.
   - Hunks entirely above the range shift it. Hunks below it don't matter.
   - A hunk that overlaps the range makes the thread **outdated**.
   - If the file is gone from the working tree, `git diff -M --diff-filter=R` finds a rename, and the diff is taken across it. A deleted file makes the thread outdated.
2. **Everything else** (the anchor was dirty, the commit is gone after a rebase, or the file didn't exist at that commit): search the current file for the exact snippet and take the match nearest the old line. No match means outdated.

- **Outdated threads** stay at the best-known line and show the stored snippet, so the original code is still visible.
- **Saved files only:** the diff runs against the file on disk, so threads move when a file is saved, not while you type.
- **In memory only:** re-anchoring never writes to disk. Each refresh caches one diff per file.

## VS Code extension

- **Comments:** built on the built-in Comments API, which provides the gutter icons, inline threads and the reply box.
- **Sidebar:** a Local Review view in the activity bar, because the built-in Comments panel can't be grouped or trimmed. Sections follow who acts next: *Needs your approval* (drafts), *Waiting for you* (addressed, disputed), *With the builder* (open) and *Resolved* (collapsed). Each section has a coloured status icon, and the section and its rows are tinted in that colour. A row is just the start of the first comment (plus `disputed` or `outdated` when they apply). Hover shows the file and line, the comment and the latest reply; clicking opens the thread. Rows have approve, resolve and reopen buttons. The view's badge counts threads that need you.
- **Status changes:** not shown as comments. The thread title says who set the current status, and the history stays in the event files and `lrv show`.
- **Labels:** each thread is labelled with a coloured status marker, plus `outdated` when it applies. Each author role has its own coloured avatar.
- **Reply box:** hidden until you press Reply on the thread, so threads stay compact to read.
- **Watching:**
  - the current branch's review folder, so agent writes show up within about 200 ms;
  - `<git dir>/HEAD`, from `git rev-parse --git-dir`, to switch to the other branch's review on checkout (in a worktree this is the worktree's own folder, not the common dir);
  - saved and changed workspace files, to re-anchor.
- **Thread actions:** reply, approve and send to the builder (drafts), resolve, reopen, set status, delete.
- **Comment actions:** edit.
- **Commands:** publish all drafts, clear the branch's review, refresh.
- **Your author name:** the `localReview.author` setting, `human` by default.

## CLI for agents

```
lrv add <file> <start>[-<end>] (--body <text> | --body-file <path|->) [--status draft|open]
lrv list [--status <s>[,<s>...]] [--json]
lrv show <id> [--json]
lrv reply <id> (--body <text> | --body-file <path|->) [--status <s>]
lrv status <id> <status>
lrv edit <id> <comment id> (--body <text> | --body-file <path|->)
lrv publish (<id>... | --all)
lrv delete <id>
lrv clear
lrv move <old branch> <new branch>
```

- **Author:** `--author`, or the `LRV_AUTHOR` environment variable, `human` by default. A reviewer agent runs with `LRV_AUTHOR=reviewer`, and a builder agent with `LRV_AUTHOR=builder`.
- **Context:** the repo and branch come from the current directory, the same way git does it.
- **`list`:** shows every thread except drafts by default. Drafts are only listed when asked for with `--status draft`, and never to the builder.
- **Line numbers in output:** `list` and `show` give re-anchored line numbers, so the builder edits the right place.
- **`--json`:** a stable shape for agents. The default output is short and readable.
- **Branch renames:** storage is keyed by branch name, so renaming a branch leaves its review behind. `lrv move` carries it over.

## Agent workflow

- **Reviewer agent:** reviews the diff against `main` and runs `lrv add` once per finding, which creates a draft. On later passes it runs `lrv list --status addressed,disputed`, then resolves the thread or replies and reopens it.
- **Human:** reads the drafts in VS Code, edits or deletes them, and publishes the rest. Has the final say on resolving.
- **Builder agent:** runs `lrv list --status open`, fixes the code, and replies with `--status addressed` (naming the commit) or `--status disputed` (giving the reason).
- **Notifications:** agents don't get notified of new comments. The human starts each pass ("address the review", "re-review").

## Milestones

1. `core` and `cli`: format, append-only storage, status rules, derived state and re-anchoring, with unit tests.
2. Extension, read-only: threads, labels, watchers and branch switching.
3. Extension write-back: new thread, reply, edit, status, publish, resolve/reopen and delete.
4. Claude Code skill and packaging (`.vsix`, global CLI install); try it on a real branch.

## Limits

- Threads anchor to lines on the working-tree side only. There is no "comment on the old version of a line" as on GitHub.
- A review left on a deleted branch stays until it is cleared or moved.
