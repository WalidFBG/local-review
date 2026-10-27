# Local Review

Branch-specific review threads stored in `.git/review/`, shared between AI agents (through the `lrv` CLI) and you (through a VS Code extension). See [DESIGN.md](DESIGN.md).

## Build

```
npm install
npm test
npm run build
npm run package --workspace local-review
```

## Install

- **Extension:** `code --install-extension packages/extension/local-review.vsix`
- **CLI:** `npm install -g ./packages/cli` (after `npm run build`), then `lrv --help`.
- **Claude Code skill:** copy `skill/` to `~/.claude/skills/local-review/`.

## Use

- **Agents:** the skill tells them to pass `--author reviewer` or `--author builder` on every `lrv` call. The CLI refuses to run without an author.
- **You, from a terminal:** pass `--author human` (or your own name), or set `LRV_AUTHOR` in your shell profile.
- **You:** threads appear in the editor gutter and the Comments panel. Hover a line's gutter to add a comment. Use the thread's title buttons to publish, resolve, reopen, set the status or delete.
