# herdr-kurtzmann

A Herdr panel that follows the focused Claude Code session and lists every file
it and its subagents wrote or edited, with a fuzzy filter, an inline preview
(rendered markdown, highlighted code) and diffs against the file as it was
before the session touched it.

Named after [Mr. Kurtzmann](https://www.youtube.com/watch?v=esSUJJmlPPI), head
of Records in Terry Gilliam's *Brazil*: the man in charge of the archive, in a
permanent panic over the smallest discrepancy in the paperwork. It also sounds
like it belongs next to `grep` and `cron`.

![Kurtzmann](preview.png)

## Two ways to use it

**As a side panel next to Files and Changes (the layout).**

```sh
./install.sh
herdr-app do layout.switch --name main-kurtzmann
```

Click **Kurtzmann** in the tab bar. `ctrl-shift-l` switches back to your own layout.
`main-kurtzmann` and `tabs-kurtzmann` are clones of Herdr's `main` layout and
`tabs` mod (0.1.18) with a Kurtzmann block and button added; they don't receive
Herdr's later changes to those.

**As a pane, on any layout (the mod only).** `./install.sh --mod-only`, then run
"Kurtzmann: open beside this pane" from the command palette.

`install.sh` copies into `~/.config/herdr-app` (or `$HERDR_APP_HOME`), keeps
your `config.json`, and runs `herdr-app check`. Herdr loads a symlinked mod
folder but doesn't hot-reload it, so copy rather than symlink. While developing,
`./install.sh --watch` (needs `fswatch`) reinstalls on every save.

## How it works

**Finding the session.** When focus changes (and every 5 seconds), Kurtzmann
asks herdr-core which process runs in the focused terminal (`hc get <terminal>
--json`, its `foreground.pid`). Claude Code registers every running session in
`~/.claude/sessions/<pid>.json`, which gives the `sessionId` and working folder.
No guessing from the folder, so two sessions in the same repo stay apart. If
the focused terminal isn't Claude Code (a shell, a pager Kurtzmann opened, the
panel itself), the last session stays shown.

**Finding the files.** The session's transcript is
`~/.claude/projects/*/<sessionId>.jsonl`, and each subagent has its own in
`<sessionId>/subagents/agent-*.jsonl` (named by the `.meta.json` beside it).
A small `python3` filter reads only the bytes added since the last poll, up to
the last complete line, and keeps three kinds of records: the session's AI
title; tool results that carry a `structuredPatch` (a Write or Edit that
succeeded, with `type: "create"` marking a new file); and Claude Code's
file-history records, which say where it backed up each file before editing it.
Results are cached per session, so switching back is instant.

**Diffing.** Before Claude Code first edits a file in a session, it saves a
copy in `~/.claude/file-history/<sessionId>/`. The earliest backup of a file is
its state before the session, so Diff compares that with the file now: only the
session's changes, committed or not, inside a repo or not. A file with no
backup that the session created shows whole. Subagents don't record their own
backups; for their files Kurtzmann falls back to the original content recorded
in the first edit's result when there is one, else offers only "vs HEAD"
(`git diff HEAD` in the file's folder). Inline diffs use `git diff --no-index`;
`D` opens the same comparison in `difft`.

**Opening things.** Pagers, diffs and terminal editors open with Herdr's
`terminal.open` as ordinary terminals beside the focused pane, which close
when the program exits. GUI editors and the system app run directly.

**Cost.** Transcripts are polled every 5 seconds and git every 30, both paused
while the window is hidden. Inline previews stop at 400 KB and inline diffs at
4000 lines.

## What it reads and runs

It reads Claude Code's files under `~/.claude` (`sessions/`, `projects/`
transcripts and subagent transcripts, `file-history/` backups), runs `hc get`,
`git` (read-only queries), `python3` (transcript parsing), `sh` and `wc`, and
the viewers below. It writes nothing except temp files under `$TMPDIR` when it
reconstructs a file's original content for a diff. Local machine only.

## Keys

List: `/` filter, `u` uncommitted only, `j` `k` move, `↵` view, `d` diff,
`o` open in pager or app, `D` difft in a split, `e` editor, `f` reveal,
`r` refresh.

A `●` after a file means it has uncommitted changes in its git repo (modified,
staged, untracked or deleted, per `git status`). The **Uncommitted** toggle
beside the filter (or `u`) shows only those; files outside any git repo are
hidden while it's on. The toggle is remembered.
Detail: `1` `2` `3` or `tab` Preview, Diff, vs HEAD; `esc` back.

The actions are also commands you can bind in `keys.json`, acting on the
selected file (or the one open in the detail view): `kurtzmann.view`,
`kurtzmann.diff`, `kurtzmann.open`, `kurtzmann.opendiff`, `kurtzmann.editor`,
`kurtzmann.finder`, plus `kurtzmann.uncommitted` to flip the toggle. They reach the panel only while it's shown. For example:

```json
{ "global": { "ctrl-shift-e": "kurtzmann.editor" } }
```

A failing action shows a toast with the reason.

## Tools

Defaults: `glow` for markdown, `jq` for JSON, `bat` (if installed) or `less -R`
for the rest, `difft` for diffs, `open` for images/PDFs and reveal (macOS),
`$VISUAL`/`$EDITOR` for editing. Override any of them by copying
`mods/kurtzmann/config.example.json` to `config.json` in the same folder.
Commands run with `sh -c`; `{file}`, `{before}`, `{after}` and `{dir}` are
passed as quoted arguments. On Linux, set `app` to `xdg-open {file}` and
`reveal` to something like `xdg-open "$(dirname {file})"`.
