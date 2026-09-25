# Maintainer documentation

These files are for people changing Guardian, not for a first install.
Start at [`INSTALL.md`](../../INSTALL.md) if you are putting this on a
Home Assistant box.

| File | Read it for |
|---|---|
| [`../../DEPLOY.md`](../../DEPLOY.md) | Changelog and manual test plan, written pass-by-pass. |
| [`GUARDIAN_AUDIT.md`](GUARDIAN_AUDIT.md) | Original audit, reconstructed state machine, and a running log of what each batch fixed. Historical sections describe the system as found. |
| [`GUARDIAN_UI.md`](GUARDIAN_UI.md) | The custom panel: why it exists, information architecture, design system, security boundaries. |
| [`CURSOR_ONBOARDING.md`](CURSOR_ONBOARDING.md) | Orientation for a new contributor (human or AI): repo layout, traps this codebase has sprung, how to work in it. |
| [`print-listings.md`](print-listings.md) | Paste-ready MakerWorld / Printables listing copy. |
| [`archive/GUARDIAN_UI_PROMPT.md`](archive/GUARDIAN_UI_PROMPT.md) | Historical prompt used to design the panel. Not current spec. |

Runtime files stay at the repository root. Do not move `INSTALL.md` or
`DEPLOY.md` — preflight reads both from there.
