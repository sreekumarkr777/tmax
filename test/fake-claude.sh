#!/bin/sh
# Stand-in for `claude` in the smoke test (prints a banner, then echoes input).
printf '\033[38;5;209m✻\033[0m \033[1mWelcome to Claude Code\033[0m  \033[2m(demo session)\033[0m\n\n'
printf '\033[2m  cwd: %s\033[0m\n\n' "$PWD"
printf '> Sessions expire early on Safari — fix it\n\n'
printf '\033[38;5;209m●\033[0m I traced it to the session cookie: \033[36mmaxAge\033[0m is passed in milliseconds,\n  but the serializer expects seconds. Safari rejects the huge value.\n\n'
printf '\033[38;5;209m●\033[0m \033[1mUpdate\033[0m(src/auth/cookies.ts)\n'
printf '  \033[31m- const maxAge = ttl * 24 * 60 * 60 * 1000;\033[0m\n'
printf '  \033[32m+ const maxAge = ttl * 86400; // seconds (RFC 6265)\033[0m\n\n'
printf '\033[38;5;209m●\033[0m \033[1mBash\033[0m(npm test -- auth --runInBand)\n  \033[2m⎿  Running…\033[0m\n'
exec cat
