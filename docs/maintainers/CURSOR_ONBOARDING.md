# Guardian System — onboarding prompt for a new AI assistant

Paste this whole file as your first message in Cursor (or point Cursor's agent at it and
say "read this before doing anything"). It's written so a fresh session gets full context
without having to rediscover it by trial and error.

## What this project is

This is **not application source code** — it's the config tree for a home security system
called "Guardian" built on **Home Assistant** (YAML automations/scripts/helpers) plus two
**ESPHome** microcontroller devices (a door "interior portal" with RFID reader, keypad,
display and lamp control, and a video doorbell). There's no build/test/lint pipeline; the
only way to "run" this code is to deploy it to a real Home Assistant instance and physical
ESP32 hardware. Treat correctness reasoning as primary — you cannot execute this code
locally.

## Repo layout

| File | Role |
|---|---|
| `configuration.yaml` | HA root config. Wires in automations/scripts/scenes/packages, registers the Guardian control panel via `panel_custom:`, and loads `set-default-panel.js` so Guardian is the system landing page. |
| `automations.yaml` | ~4,500 lines. All HA automations — RFID dispatch, door direction, MFA/PIN challenges, presence, lamp, watchdogs. |
| `scripts.yaml` | ~6,400 lines. All HA scripts — `process_rfid_scan`, `guardian_authorize_passage`, `guardian_set_display`, lamp sampling, enrollment, notifications, self-tests. |
| `packages/guardian.yaml` | ~1,700 lines. HA `helpers` package: `input_boolean`/`input_text`/`input_number`/`timer`/`sensor` entities the automations/scripts depend on. Only merged into HA on a **full restart**, not a reload. |
| `packages/guardian_rfid.yaml` | RFID slot helpers (hash, presence, policy), `sensor.guardian_rfid_slots` whitelist, trigger-based occupancy sensors. **This is the file to edit to grow/shrink the key rack.** Full restart. |
| `esphome/portal-unit.yaml` | ~2,800 lines. Firmware config for the interior door portal: RFID (RC522), keypad, 240×135 ST7789 IPS, lamp/LED, door contact + IMU swing sensor, DFPlayer. |
| `esphome/doorbell-unit.yaml` | ~300 lines. Firmware config for the doorbell unit: RFID reader, button, status LED. |
| `esphome/secrets.yaml.example` | Template for the real (gitignored) `esphome/secrets.yaml` — wifi creds, per-device OTA/AP/encryption keys, `doorbell_unit__ip`, `portal_unit__ip` / gateway / subnet / dns. |
| `frigate/config.yml.example` | Template for the real (gitignored) `frigate/config.yml`. Frigate (NVR/person-detection) add-on config; feeds the `frigate/events` MQTT topic an automation listens to for "person detected while away." The real file carries the camera RTSP password and broker credentials, which is why only the `.example` is tracked. |
| `tools/guardian-preflight.py` | **The only automated check in the repo.** Validates YAML (incl. `!include` / `!lambda`), the version literals, `.sh` line endings, script references, duplicate automation ids, `esphome/secrets.yaml` placeholders, that nothing under `www/guardian-ui/` references an external URL, and **that nothing can quietly cancel an alert** — no step that can raise standing in front of one, *including inside a script that a blocking `action:` call reaches*; no alert stranded below a `stop`; no unguarded step inside a loop that sounds the alarm; **no templated `entity_id` that cannot fall back to a valid one, and no templated service name outside the single script allowed to have one** (forty-second — `continue_on_error` does *not* suppress `vol.Invalid`, `TemplateError` or `ServiceNotFound`, so those two arguments are unguardable by it); and **that every `guardian_*` reference resolves to an id Home Assistant would actually mint** from a template `name:` or an ESPHome device + entity name. That family has now found eight real fail-opens across three passes, including one that ended the Major Alarm Handler in front of its own siren loop. Two more families were added in the forty-fifth pass, and both are **arithmetic over the tree rather than pattern-matching in it**: that **no startup branch tests a helper for a value its own `initial:` makes unreachable** (an `initial:` is applied on every start and skips `restore_state`, so such a branch is dead code — this is how a live alarm was ended by every Home Assistant restart with the recovery code sitting right there), and that **every script has capacity for every blocking call that can arrive at once** (a blocking `action: script.x` against a script at `max` is DISCARDED SILENTLY and the caller proceeds as though it ran; `continue_on_error` is irrelevant, because nothing raised). No network, no secret values read. Run it after any edit. |
| `tools/guardian-selftest-preflight.py` | **The test for the test.** Injects every real fail-open the fortieth pass onward fixed, confirms preflight names each one, and reverts. **Read the `N of M faults caught.` line it prints, never the column** — a fault whose anchor has drifted prints `SKIP` in the same column as `CAUGHT`, and a run full of SKIPs reads like a run full of passes. The count is deliberately not repeated here: a hand-transcribed count in prose is exactly what went stale in DEPLOY.md step 293, and `check_selftest_count_documented` now guards the one place that still quotes it. Run it after changing any check in `guardian-preflight.py` — narrowing a rule to quieten a false positive can silently stop it catching the true ones, and that change looks like an improvement. One of them exists solely to catch that: moving the alarm push to `script.turn_on` moved the `severity` that marks it an alert into `data: variables:`, and a checker still reading only `data:` would go silent on the whole Major Alarm Handler and report a clean run. |
| `tools/guardian-gen-secrets.py` | Generates `esphome/secrets.yaml` — 2 API keys, 3 OTA/AP passwords, the 64-hex card master key — asking only for Wi-Fi and addresses. Exists because the old hand-copy path shipped a 64-zero `guardian_rfid_mac_key` that passed validation and built. |
| `tools/guardian-install.sh` | POSIX `sh` installer, run on the HA host. Dry-run by default. Copies the nine runtime files (never `preview.html`), normalises the `.sh` to LF, refuses to overwrite an existing `configuration.yaml`, then runs preflight and prints the manual punch list. |
| `guardian/guardian-luminance.py` | Python probe (deployed to `/config/guardian/` on the HA host). `command_line` and `--retune` invoke `python3` on this file. |
| `guardian/guardian-luminance.sh` | Thin `exec python3` wrapper for the same probe. HA does not run this. |
| `www/guardian-ui/guardian-panel.js` | The Guardian control panel — a Home Assistant custom panel (single ES module, no build step, no HACS) registered by `panel_custom:` in `configuration.yaml`. The household landing page over the system: it reads entity state and calls existing helpers/scripts and contains no business logic. Deploys to `/config/www/guardian-ui/`. |
| `www/guardian-ui/set-default-panel.js` | One-shot extra module (`frontend.extra_module_url`). First admin session writes system `default_panel: guardian`. Settings → Dashboards cannot list a custom panel, so this is the equivalent of "Set as default". |
| `docs/maintainers/GUARDIAN_UI.md` | Design and architecture of that panel: why a custom panel rather than Lovelace or HACS, the information architecture, the design system, the security boundaries it enforces structurally, and how to add a control without a rewrite. |
| `docs/maintainers/GUARDIAN_AUDIT.md` | **Read this first for deep understanding.** A ground-truth audit of the system as originally found (bugs, dead code, entity cross-checks, full state-machine reconstruction of RFID scan → door open → presence flows), followed by a running log (§8+) of what was fixed in each commit batch and what remains outstanding. |
| `INSTALL.md` | **The canonical day-one path.** Prerequisites, file placement (including the merge path for an existing `configuration.yaml`), the one full restart, the setup wizard, the config flows YAML cannot provision, and a post-install verification checklist. Separate from `DEPLOY.md` on purpose — this is "fresh Home Assistant → working system", not "what changed since last release". |
| `docs/` | Hardware index ([`docs/README.md`](../README.md)): assembly, printable PDFs, parts checklist, DFPlayer tracks. |
| `docs/documentation/` | Assembly markdown, photographs, and a printable PDF for the interior portal, doorbell, and lamp+camera. Linked from INSTALL §1 and `3D-Models/README.md`. |
| `PCBs/` | KiCad 10 projects and Gerber+drill zips (`Interior-Portal/`, `Doorbell/`). `PCBs/README.md` is the fab + BOM note. |
| `3D-Models/` | Index only. Print files are the three `.3mf` profiles on MakerWorld / Printables. This tree does not ship STLs. |
| `secrets.yaml.example` | A signpost, not a template: Guardian's Home Assistant config references **no** `!secret` keys. Points at the three real credential surfaces (`esphome/secrets.yaml`, Frigate add-on env vars, the master PIN). |
| `DEPLOY.md` | Release notes + deployment runbook, written pass-by-pass (each "pass" = a batch of commits). Explains *why* each fix was needed, what new helpers/entities it introduces, exact manual verification steps, and network/Frigate troubleshooting notes. This is the changelog **and** the test plan — there is no automated test suite, so DEPLOY.md's "Verify" checklists are the closest thing to one. |
| `docs/reference-images/` | Local-only source photography of one install. Not in the public tree. Assembly steps live in `docs/documentation/`. |
| A Home Assistant editor screenshot (historical; not in this tree) | Used historically as ground truth for which entities actually exist in the HA UI (helpers created by hand in the HA UI, not in YAML, don't show up in this repo's grep). |

**Helper consolidation is complete.** Every `input_*` / `timer` entity referenced
anywhere in this tree is declared in `packages/guardian.yaml` or
`packages/guardian_rfid.yaml` — 179 of them, zero referenced-but-undeclared. A
fresh install needs no hand-created helpers at all, and the screenshot ground
truth described in the table above is now a historical aid rather than a
necessary one. If you add a helper reference, add the declaration in the same
commit; the diff that proves this is in `DEPLOY.md`'s thirty-eighth pass.

**Important quirk, now only for *migrating* installs:** seven helpers that used
to exist only as Home Assistant UI helpers (`portal_pin_hash`,
`portal_display_state`, `super_surveillance_mode`, `portal_mfa_pending`,
`mfa_failed_attempts`, `last_doorbell_rfid_time`) are declared in
`packages/guardian.yaml`. Migrating an existing install requires deleting the UI
copies **before** the package is loaded — see `DEPLOY.md` thirty-fourth pass. A
fresh install is unaffected. Do not add `initial:` to `portal_pin_hash`. RFID
slot helpers live in `packages/guardian_rfid.yaml`.

**The `initial:` rule, and its first-boot corollary.** YAML `initial:` is applied
on every Home Assistant start and *skips* `restore_state`, so it must never
appear on anything a household configures. The corollary is that a helper with
no `initial:` and nothing to restore — a genuinely first boot — falls back to its
`min`, silently. `script.guardian_setup_wizard` exists to close that gap: it
applies the documented first-boot values once, guarded by
`input_boolean.guardian_setup_complete`, and reports what YAML cannot provision.
If you add an `input_number` a household configures, add its recommended value
to that script.

## How to work in this repo (mirrors how I've been doing it)

1. **Read `GUARDIAN_AUDIT.md` and the relevant section(s) of `DEPLOY.md` before touching
   automations/scripts/packages.** The audit has a full reconstructed state machine for RFID
   scan dispatch, door-direction classification, and the MFA/challenge flow — don't
   re-derive it from scratch, it's already documented and kept current.
2. **Trace call chains fully before changing behavior.** This codebase has caused real bugs
   from things like: a blocking script call (`- action: script.x` instead of
   `script.turn_on`) silently filling an automation's `queued` execution queue and dropping
   all further triggers; `input_text.set_value` not firing a state-changed event when the
   value is unchanged, breaking anything that triggers off that state change; case-sensitive
   hash comparisons breaking on Windows-generated uppercase hex. Read the whole call chain
   (automation → script → helper → ESPHome entity) before assuming a one-line fix is
   sufficient.
3. **Every deploy-affecting change needs a `DEPLOY.md` update**: what changed, why, new
   helpers/entities introduced (with a table like the existing ones), and new numbered
   "Verify" steps appended to the existing checklist (don't renumber old ones). Follow the
   existing prose style — it's dense, precise, explains root cause not just symptom, and
   calls out exactly what a human must do by hand (helper values that don't pick up new
   `initial:` on existing installs, full-restart-vs-reload requirements, secrets that must be
   added manually).
4. **Commit messages in this repo are full sentences describing the fix's effect**, not
   conventional-commit style — e.g. "Stop the enrollment screen claiming the slots are full
   when it has no data", "Trace the scan decision from inside process_rfid_scan". Match that
   voice.
5. **Both HA config and ESPHome device firmware often need to change together** — e.g. a new
   sensor/entity added to `packages/guardian.yaml` that the portal's display firmware reads.
   `DEPLOY.md`'s "What is NOT copy-paste" and "Order matters" sections track deploy ordering
   (HA restart before flashing devices, etc.) — keep that current when you add
   cross-cutting changes.
6. **There is one automated check, and it is static.** Run
   `python tools/guardian-preflight.py` after any edit — it catches the failures
   this repo actually has (a half-copied install, unparseable YAML, a script
   referenced but never defined, a duplicate automation id, a placeholder left in
   `esphome/secrets.yaml`, an external URL in the web-served tree). It exits
   non-zero and names the file and the fix.

   **It does not test behaviour.** Nothing here runs an automation or fires an
   alert. For that, validation is still: HA's Developer Tools → YAML "Check
   configuration", manual Developer Tools → Actions calls to specific scripts (e.g.
   `script.guardian_notification_selftest`, `script.guardian_set_pin` /
   `guardian_verify_pin`), the numbered manual verification steps in `DEPLOY.md`,
   and `INSTALL.md` §9 steps 10-14 for the alarm path specifically. When you make a
   behavioural change, add/update those verification steps rather than claiming
   "tested."

## Current branch state

- Working branch: `fix/presence-reconciliation-and-lamp`, based on `master`. All work
  since has continued on it; `master` is long stale and is not a useful comparison point
  any more. Read `DEPLOY.md` back-to-front for what a pass changed, not `git diff master`.
- Current version: **2.32.0**, declared in **every** site preflight lists — twelve at
  the time of writing, and the number has grown four times. Preflight checks all of
  them and prints the count, so bump by running it rather than by counting from
  memory. Roughly: five literals (`packages/guardian.yaml`,
  `packages/guardian_rfid.yaml`, the `scripts.yaml` and `automations.yaml` marker
  aliases, `GUARDIAN_UI_VERSION` in the panel), two `?v=` strings in
  `configuration.yaml`, two more in `INSTALL.md`, and the prose sentence in
  `INSTALL.md` § Version consistency that tells a household which number to expect —
  that one had been wrong for two releases because nothing checked it.
- **Copy `www/guardian-ui/guardian-panel.js` on every release even when its contents
  did not change**, because its version literal did. It is the file people skip, and
  skipping it produces the Diagnostics version banner with a remedy — restart fully —
  that cannot fix it; a browser holding a cached module needs a hard refresh. The
  panel now diagnoses that case separately by reading `?v=` back off
  `import.meta.url`. See `INSTALL.md` § *Diagnostics says the versions disagree*.
- The last two passes are both about the alarm not happening: the fortieth on a step that
  can raise standing in front of an alert, the forty-first on the alarm waiting for a push
  to the internet before making a local noise, and on the siren loop ending itself the
  first time it pressed a button on an offline portal. If you touch
  `Guardian: Major Alarm Handler`, read that section of `DEPLOY.md` first — its step order
  is a safety property and every line of it is load-bearing for a reason that is written
  down.
- `GUARDIAN_AUDIT.md` is itself versioned and has been appended to (not rewritten) after each
  fix batch — section 8 onward is the "as fixed" record. Keep appending in that style rather
  than editing history sections 1–4 (which are deliberately preserved as "as found").

## Domain vocabulary quick reference

- **Interior portal** — the main door unit (RFID + keypad + display + lamp + door
  contact/IMU).
- **Passage window** — a timed grace period (`entry`/`exit` timers) opened after a valid
  RFID/PIN authorization, during which a door opening is treated as intentional rather than
  an intrusion.
- **Elevated mode** — `binary_sensor.guardian_elevated_mode`: the manual
  `super_surveillance_mode` switch, or any enabled Super Surveillance program
  whose weekday + hour window matches now. Programs are created, not
  pre-shown: the rack of four helper sets is pre-provisioned (Home Assistant
  cannot make a helper at runtime) but a position only becomes a program when
  Create Program claims it, and Delete hands it back. What exists is
  `sensor.guardian_ss_programs_created` — the only copy of that predicate;
  `sensor.guardian_ss_programs` is capacity. Created and enabled are different
  questions: disabling a program keeps it visible and configured. Creating one
  writes enabled / every day / 00:00–05:00, so it is live immediately.
  Downstream treats the switch and every program identically. Requires
  PIN/MFA in addition to a valid card.
- **Entry challenge** — the 10–120s grace period (default 30s) given for an unauthenticated
  opening while super surveillance is on, before a full alarm fires. Origin-aware
  (inside vs. outside).
- **Presence** — per-card "At home"/"Away" state (`input_select.rfid_N`), reconciled by
  passage-window completion and (per the current branch) self-healing watchdogs.
- **Lamp** — discovered `light.*` via `sensor.guardian_lamp_entity` (this house
  defaults to `light.tapo_lamp` when that entity exists), auto-switched based
  on ambient luminance sampling (`guardian-luminance.py` + camera brightness)
  with a sun-elevation override.
- **Frigate** — separate NVR add-on for person detection; integrates via MQTT
  (`frigate/events`), not native HA integration — has a known misconfiguration noted in
  `DEPLOY.md` (no `mqtt:` block in `frigate/config.yml` at last audit).

## What I'd want you to do first

Read `GUARDIAN_AUDIT.md` in full and the last two "pass" sections of `DEPLOY.md`, then
`git log --oneline -30` and `git diff master..HEAD --stat` to see what's already changed on
this branch, before proposing or making any edits. Ask before restructuring
`GUARDIAN_AUDIT.md` or `DEPLOY.md`'s historical sections — they're intentionally kept as a
record, not just current-state docs.
