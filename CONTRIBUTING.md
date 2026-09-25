# Contributing

Guardian is a Home Assistant config tree plus two ESPHome firmwares.
There is no application build and no behavioural test runner. The only
way to run this code is on a real Home Assistant instance and real
hardware.

## Before you edit

1. Read [`INSTALL.md`](INSTALL.md) if you have not installed it.
2. Read [`docs/maintainers/CURSOR_ONBOARDING.md`](docs/maintainers/CURSOR_ONBOARDING.md)
   for layout and the traps this repo has already sprung.
3. For behaviour changes, read the reconstructed state machine in
   [`docs/maintainers/GUARDIAN_AUDIT.md`](docs/maintainers/GUARDIAN_AUDIT.md)
   and the newest pass in [`DEPLOY.md`](DEPLOY.md).

Do not add YAML `initial:` to a helper a household configures. That
value is applied on every Home Assistant start and skips restore.
`script.guardian_setup_wizard` is the first-boot path.

## Checks you must run

```bash
python tools/guardian-preflight.py
```

```bash
python tools/guardian-selftest-preflight.py
```

Preflight is static: YAML parse, version literals, script references,
alert sequencing, no leftover secret placeholders, no external URLs
under `www/guardian-ui/`. It does not fire an alarm.

The selftest injects each real fail-open preflight was written to catch
and confirms it still names them. Run it after changing any rule in
`tools/guardian-preflight.py`. Read the `N of M faults caught.` line,
not the per-row column.

After deploy, Home Assistant *Check configuration* and the numbered
steps in `DEPLOY.md` are the behavioural checks.

## What not to commit

- `esphome/secrets.yaml`, `frigate/config.yml`, `.env`, keys
- `docs/reference-images/` (local source photography of one install)
- Camera snapshots, HA `.storage/`, databases, logs
- KiCad backups (`*-backups/`, `*.kicad_prl`, `*.lck`)

Never `git add -f` a secrets file.

## Pull requests

- Keep hardware paths where Home Assistant and ESPHome expect them
  (`automations.yaml`, `scripts.yaml`, `packages/`, `esphome/`, `www/`,
  `guardian/`).
- Bump every version literal together (preflight will refuse a split).
- If the change is a deploy-affecting fix, add a short `DEPLOY.md` note
  with what changed and how to verify it.
- Hardware / print listing copy lives in
  [`docs/maintainers/print-listings.md`](docs/maintainers/print-listings.md).
