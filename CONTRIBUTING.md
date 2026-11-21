# Contributing to Tmax

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Getting set up

```bash
git clone https://github.com/sreekumarkr777/tmax.git
cd tmax
npm install
npm start
```

You need macOS, Node.js 18+, and Claude Code (`claude` on your PATH).

## Before you open a pull request

- Run `npm test`. It covers session state, the hook bridge and the token meter.
- For UI changes, run the screenshot test and look at the images:

  ```bash
  SB_SMOKE=1 SB_SMOKE_OUT=/tmp/tmax-shots SB_USER_DATA=/tmp/tmax-profile \
    TMAX_CLAUDE="$PWD/test/fake-claude.sh" npx electron .
  ```

  It uses a throwaway profile and a stand-in for Claude, so it never touches your real sessions.
- Keep changes focused: one feature or fix per pull request.
- The renderer is plain HTML, CSS and JavaScript with no build step. Please keep it that way.

## Where things live

| Path | What it does |
| --- | --- |
| `main.js` | Electron main process: terminals, hooks, windows, settings, restore |
| `preload.js` | The only bridge between the UI and the main process |
| `src/state.js` | Turns Claude Code hook events into session state |
| `src/hooks.js` | Localhost hook server and per-session settings file |
| `src/usage.js` | Token and cost meter from the transcript |
| `renderer/` | The UI |
| `site/` | The landing page (GitHub Pages) |

## Reporting bugs

Open an issue with what you did, what you expected and what happened. Include your macOS and Claude Code versions (`claude --version`).
