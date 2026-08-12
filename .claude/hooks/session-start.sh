#!/bin/bash
# Boot trigger for Claude Code on the web (cloud sessions).
#
# Why this exists: device-deployed settings and hooks never reach Anthropic-managed
# VMs by design, so the SessionStart hook that boots Forge on beast/iMac/Neo does not
# fire in a cloud session. Skills still sync to the container and are fully loadable —
# nothing was ever telling the session to load them. This file is that trigger, and it
# ships in the repo so it travels with any cloud session that clones this repo.
# Ported from azck-faces (its PR #375 state) by the 2026-08-12 boot-contract audit.
#
# Device-deployed hooks already cover local sessions, so this stays scoped to remote
# to avoid double-firing.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cat <<'BOOT'
=== FORGE BOOT TRIGGER (command.azcustomknives.com, cloud session) ===

You are in a Claude Code on the web session. Device-deployed hooks did NOT run here.
Boot yourself before real work:

1. Load the azck-boot-contract skill and follow it. Skills ARE installed and invocable
   in this container — invoke by name via the Skill tool. The `/` autocomplete menu may
   not list them; that is a UI surface difference, not an availability problem.

2. Device identity: this is an Anthropic-managed cloud VM (hostname `vm`), NOT beast,
   iMac, MacBook or Neo. The locked device-detection rule requires you to name the device
   explicitly in your closing block — name it as the cloud VM. Never inherit "beast" from
   a previous session's memory.

3. Bus identity on this repo is `forge-code`.

4. Repo rules live in CLAUDE.md at the repo root. Read it before editing. This is the
   BUSINESS face: `index.html` is the only face file. `assets/cc-bus-v2.js` and
   `assets/cc-scheduling.js` are MIRRORS from azck-faces — never hand-edit them here;
   the bus module's one deliberate divergence is its default lane `az`.

Boot sequence, receipts, the per-turn contract and the closing block all live in the
azck-boot-contract skill. Do not duplicate them here — load the skill.
BOOT

exit 0
