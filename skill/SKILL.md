---
name: local-review
description: Local, branch-specific code review threads stored in .git and shown in VS Code. Use when asked to review a branch locally, leave or draft review comments, address or re-review a local review, or check review threads, instead of GitHub PR comments.
---

# Local review (`lrv`)

Review threads live in `.git/review/<branch>/` of the current repository and show inline in the user's VS Code. Always go through the `lrv` CLI; never read or write the files directly. Run it from inside the repository; it works on the current branch.

Pass your role on every single call with `--author`. The CLI refuses to run without it. Don't rely on `LRV_AUTHOR`: environment variables don't carry over between your shell calls, and `VAR=value command` is Bash-only syntax.

- `--author reviewer` when you are reviewing.
- `--author builder` when you are fixing the code in response to a review.

Comment bodies go in a file (in your scratchpad), passed with `--body-file <file>`; this works the same in Bash and PowerShell.

Never act as `human`; only the user publishes drafts, deletes threads or clears a review.

## Statuses

`draft` (reviewer's proposal, awaiting the user's approval) → `open` (published) → `addressed` or `disputed` (builder) → `resolved` (reviewer or user). A thread is reopened with an explicit `open`; a reply alone never changes the status.

## As the reviewer

1. Review the branch's changes (usually `git diff main...HEAD` plus uncommitted work).
2. For each finding, write the body to a file and create a draft on the exact lines:

   ```
   lrv add <file> <start>-<end> --author reviewer --body-file <body file>
   ```

   The body uses this layout:

   ````
   $(warning) **<one-line summary of the problem>**

   <what is wrong and why it matters, in one to three sentences>

   **Failure scenario**
   <concrete inputs or sequence, and the wrong result>

   **Suggestion**
   ```diff
   - <current code>
   + <proposed code>
   ```
   ````

   One finding per thread. Use line numbers from the current working tree. The icon gives the severity: `$(error)` blocking, `$(warning)` important, `$(lightbulb)` consider. Leave out the failure scenario when it is obvious. Don't use HTML such as `<details>`: VS Code's comment box doesn't resize when it expands.
3. Tell the user how many drafts you created; they will edit, delete or publish them in VS Code.
4. On a re-review, run `lrv list --status addressed,disputed --author reviewer`, read each with `lrv show <id> --author reviewer`, check the code, then either:
   - `lrv status <id> resolved --author reviewer`, or
   - `lrv reply <id> --status open --body-file <file> --author reviewer`, saying why it is not done yet.

## As the builder

1. `lrv list --status open --json --author builder` lists what to do, with current line numbers (`startLine`/`endLine` are already adjusted for later edits; `outdated: true` means the code under the thread has changed since it was written, and `snippet` holds the original code).
2. Fix each thread, then reply:
   - `lrv reply <id> --status addressed --body-file <file> --author builder`, saying what changed and the commit if any, or
   - `lrv reply <id> --status disputed --body-file <file> --author builder`, saying why you are not changing it.
3. You cannot resolve threads, and you cannot see drafts.

## Other commands

- `lrv show <id>`: the whole thread.
- `lrv list --status <s>[,<s>...]`: filter; without `--status`, every thread except drafts.
- `lrv edit <id> <comment id> --body <text>`: correct your own comment.
- `--json` on `list`, `show` and the write commands gives machine-readable output.
