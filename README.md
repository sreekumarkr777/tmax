# Switchboard (working name)

An agent-native terminal for Claude Code. Every tab is an agent session, optionally in its own git worktree, and the app always knows what each agent is doing.

## Run it

```bash
cd ~/Workshop/switchboard
npm install      # node-pty ships a macOS prebuild; no compiler needed
npm start
```

You need `claude` on your PATH. To use a different binary, run `SWITCHBOARD_CLAUDE=/path/to/claude npm start`.

## What v0.1 does

- **Agent sessions.** Each one runs `claude` in a real terminal (xterm.js and node-pty). When Claude exits, the tab drops to a normal shell.
- **Worktree per agent.** Tick the box and the session gets its own worktree at `<repo>.worktrees/<name>` on branch `sb/<name>`.
- **Live status.** Claude Code hooks report every event to the app over localhost: working, needs you, your turn, error. Your own `~/.claude` settings are left untouched; the hooks are passed in with `--settings` for each session.
- **⌘J** jumps to the next agent waiting on you. A dock badge counts agents that need you, and you get a macOS notification when one needs you while the app isn't focused.
- **Mission Control (⌘0):** every agent as a card, plus a **collision warning** when two agents edit the same file.
- **Safety border.** The window frame turns teal, amber or red with the active session's permission mode.
- **Inspector.** Shows the context-window gauge (read from the session transcript), tool and subagent counts, files read and written, and Claude's last reply.
- **Timeline strip.** Every tool call appears as a colour-coded tick.
- **Spoken alerts** (speaker button). For now this uses macOS `say` with a different voice per agent. Kokoro is the planned engine.

## Shortcuts

| Key | Action |
| --- | --- |
| ⌘T | New agent in the current folder (no form) |
| ⌘⇧T | New agent with options (folder, prompt, worktree, permissions) |
| ⌘O | Pick a folder and start an agent there (or drop a folder on the window) |
| ⌘⇧N | New plain shell |
| ⌘N | New window |
| ⌘D / ⌘⇧D | Split right (new shell) / close split |
| ⌘F, ⌘G, ⌘⇧G | Find in terminal, next, previous |
| ⌘K | Clear the terminal |
| ⌘J | Next agent that needs you |
| ⌘0 | Mission Control |
| ⌘1–9 | Switch session |
| ⌘I | Toggle inspector |
| ⌘, | Settings |
| ⌘W / ⌘⇧W | Close session / close window |
| ⌘= / ⌘- | Text size |
| ⌘⇧R | Reload the window (sessions and output are kept) |

Terminal basics: ⌘-click a link or a file path (`src/a.ts:42`) to open it, right-click for copy/paste/find/split, Option+←/→ jumps words while Option still types `#` and `€`, double-click a session to rename it, and drop files onto a terminal to type their paths.

Sessions come back after a restart: shells reopen in the folder you left them in with their output, and agents resume their Claude conversation (`claude --resume`). Turn this off in Settings.

## Layout

```
main.js            Electron main: PTYs, hook server, notifications, voice, menu
preload.js         The only bridge between the UI and main
src/state.js       Hook events → session model (pure, unit-tested)
src/hooks.js       Localhost hook server + per-session --settings file
src/git.js         Repo detection and worktrees
src/transcript.js  Context gauge from the transcript JSONL
renderer/          UI (plain HTML/CSS/JS, no build step)
test/              npm test, plus a headless screenshot smoke test
```

## Not built yet

Rewind/fork from the timeline, best-of-N compare, a permission inbox you can answer from inside the app, inline diff review, and Kokoro voice with spoken commands.
