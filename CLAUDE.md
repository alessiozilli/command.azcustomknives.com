# CLAUDE.md — command.azcustomknives.com

The BUSINESS face of the AZCK Command Center: `https://command.azcustomknives.com`,
served from `main` via GitHub Pages (CNAME in-repo). Born 2026-08-04. This repo is NOT
the archived `command-centre` or `az-command-centre` — those are legacy CC v2 salvage,
never touched, never revived.

**Load the `azck-boot-contract` skill at session start.** Cloud sessions get the
trigger from `.claude/hooks/session-start.sh`; bus identity on this repo is
`forge-code`.

## Hard rules

- **`index.html` is the whole face** — every tab and style lives inline there.
- **`assets/cc-bus-v2.js` is a MIRROR.** Source of truth is
  `azck-faces/assets/cc-bus-v2.js`; carry changes FROM there and bump the `?v=` tag in
  `index.html` on every edit. One deliberate divergence stays: this face's default bus
  lane is `az`, Alessio's face defaults `both` (his call, 2026-08-10). Do not "fix"
  that difference in either direction.
- **`assets/cc-scheduling.js` also syncs FROM azck-faces** (the "Sync cc-scheduling.js
  from azck-faces" commits) — never hand-edit it here.
- **The system map lives in azck-faces** (`CLAUDE.md` + `CC_AUDIT.md` there). One map,
  one home — do not grow a duplicate here.

## Lineage

Boot wiring added 2026-08-12 by the three-faces boot-contract audit (sibling fix:
azck-faces PR #375; dispatch: bus #4703).
