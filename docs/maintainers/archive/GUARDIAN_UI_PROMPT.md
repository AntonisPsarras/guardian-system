# Prompt: Design and build the Guardian System control UI

## What you're building

Guardian is a home security system running on Home Assistant: RFID/keypad door
entry, PIN-based elevated-mode authentication, ambient-light-driven lamp
automation, a video doorbell, Frigate person detection, and a layered
alarm/challenge state machine — all implemented in `automations.yaml`,
`scripts.yaml`, `packages/guardian.yaml`, and `packages/guardian_rfid.yaml`,
with two ESPHome devices (`esphome/portal-unit.yaml`,
`esphome/doorbell-unit.yaml`) as the physical front end.

That logic is correct, hard-won, and heavily documented (`GUARDIAN_AUDIT.md`,
`DEPLOY.md`) — treat it as ground truth you build **on top of**, not
something to modify. Home Assistant's default auto-generated Lovelace UI
exposes all of this as a flat, undifferentiated list of raw helpers with no
sense of what matters, so day-to-day use means hunting through entity IDs and
risking a change to the wrong `input_number` or `input_select`. The goal is a
second, deliberately designed UI layer — a dashboard (or dashboards) that
sits above the raw entity/settings UI — that a household member can glance
at, understand instantly, and act on safely, without ever needing to open
Settings → Helpers or Developer Tools.

## Your task

Read the codebase yourself before designing anything: `GUARDIAN_AUDIT.md` and
`CURSOR_ONBOARDING.md` for the conceptual model, `packages/guardian.yaml` and
`packages/guardian_rfid.yaml` for the full helper/entity inventory, and
`automations.yaml`/`scripts.yaml` to understand which entities are
read-only status vs. safe user-facing controls vs. internal state that should
never be exposed for direct editing. Then produce a plan and implement it.
You have full discretion over dashboard technology (native Lovelace YAML,
custom cards via HACS, a bespoke web front end talking to the HA API,
whatever gets the best result), information architecture, visual design
system, and file/dashboard structure. Nothing below is a layout spec —
it's the set of things the UI must account for and the priorities to weigh
them against. Reason about the best way to surface all of it yourself.

## What exists, so nothing gets left out

Use this as a completeness checklist while you explore the code, not as a
component list to transcribe literally — go read the actual YAML for exact
entity IDs, valid states, and edge cases before wiring anything up.

**Presence & occupancy** — per-resident RFID slot state (Away/At
home/Stolen-Lost), visitor vs. resident policy per slot, a computed household
presence summary, and (opt-in) phone-based presence trackers that can
override card-based presence as the authoritative signal.

**Entry/exit & authentication flow** — passage windows (entry/exit grace
timers), elevated ("super surveillance") mode with an optional night
auto-elevation schedule (configurable hour window), MFA/PIN challenges, the
post-opening entry challenge grace period with origin tracking
(inside/outside), and full alarm state with a human-readable reason.

**RFID slot / key management** — a fixed-size key rack (currently 4 slots,
architecturally capped at 9), per-slot enrollment (with a visitor toggle and
optional explicit slot targeting), free-slot/occupied-slot visibility, and
slot retirement/clearing.

**Master PIN** — keypad-driven PIN rotation, initiated from the dashboard as
a mode toggle only — deliberately no password field or PIN entry in the web
UI itself; the actual PIN never transits Home Assistant's frontend. Preserve
that boundary.

**Lamp automation** — ambient-light-driven on/off control of `light.tapo_lamp`
with two modes (a hand-tuned "Manual (this home)" luminance path and a
self-learning "Auto-calibrate" path), configurable dark/bright thresholds, a
sun-elevation mismatch fallback with a configurable grace period, live
last-decision/last-result reporting, and a sampling-failure streak counter.

**Doorbell & cameras** — doorbell chime/live view, camera snapshot access,
Frigate person-detection integration, and connectivity/health status for both
the doorbell and interior portal devices (link quality, online/offline,
IMU health).

**Alerts & notifications** — the shared "Guardian Alerts" notification
group, a verbose-notification opt-in for diagnostic-level pushes, and
remote alarm dismissal.

**Diagnostics & faults** — a compact live fault indicator
(`sensor.guardian_faults`), per-subsystem online/offline state, and the
countdown/label template sensors that describe whatever timed window
(entry, exit, MFA, challenge, PIN change, enrollment) is currently active —
these exist specifically to drive a live status/progress display, use them.

**History** — per-event data logs already written by the system (door
opened/closed, direction resolution, RFID scans, rejected cards, entry
challenges, PIN changes, presence corrections, Frigate detections) — surface
these as human-readable activity history, not raw log dumps.

**Admin/manual overrides** — the full-system reset button and other
low-frequency manual controls. These are intentionally friction-heavy in the
current design (e.g. reset is HA-side only, not on the physical keypad,
specifically so a person at the door can't trigger it) — respect that intent
in how prominent and how gated you make the equivalent dashboard control.

## Design priorities

Everything above must be reachable, but not everything is equally important
moment-to-moment. Design the information hierarchy around actual usage
frequency and stakes:

- **Highest priority, always visible:** current security/presence state, any
  active alarm or challenge with its countdown, and live fault/health status.
  This is what someone checks in passing multiple times a day.
- **Frequent, one or two taps away:** arming/elevating, viewing who's home,
  checking the doorbell/camera, lamp mode.
- **Occasional:** enrolling/managing RFID keys, initiating a PIN change,
  reviewing activity history, tuning lamp thresholds or the Super
  Surveillance schedule.
- **Rare, deliberately tucked away:** full reset, notification verbosity,
  self-test/diagnostic scripts, and any other admin-grade controls — these
  should still be fully present and functional, just not competing for
  attention with the things used daily.

Don't omit or water down any capability to achieve this hierarchy — every
control and every piece of state listed above needs a home somewhere in the
UI. The hierarchy is about layout and prominence, not feature-cutting.

## Constraints

- This is a second layer over Home Assistant's existing frontend, not a
  replacement for it or a fork of Home Assistant itself — the standard
  Settings/Developer Tools UI should remain available for actual
  administration; this UI is the everyday-safe surface.
- Read from and call into the existing helpers/scripts/automations as they
  are. Do not introduce new automations, scripts, or business logic to make
  the UI possible — if something genuinely needs a new template sensor or
  helper to be displayable cleanly, flag it and justify it rather than
  quietly adding logic. The audited system in `automations.yaml`/
  `scripts.yaml`/`packages/*.yaml` is the source of truth for behavior.
- Preserve every existing security-relevant UX decision baked into the
  system (no PIN field in the dashboard, reset kept off the physical keypad,
  etc.) — these were deliberate, documented choices, not oversights.
- Should be usable well by multiple household members with different comfort
  levels with tech, on both phone and larger screens.
- Whatever you build should be modular enough that adding a 5th/6th RFID
  slot, a new sensor, or a new automation later doesn't require a UI
  rewrite.

## Design bar

Visual and interaction design should be genuinely excellent — the kind of
polish and coherence you'd expect from a well-designed consumer smart-home
app, not a stock Home Assistant card grid. Strong hierarchy, a real design
system (consistent color/status language, typography, spacing), thoughtful
motion/feedback for live state (countdowns, alarms, fault indicators), and
layouts that hold up in both light and dark. Treat this as a flagship piece
of the whole project, not a utility screen.

## Deliverable

Your own plan for how to structure this (single dashboard vs. multiple views,
technology choice, file layout), followed by the implementation. Document
what you built and why in enough depth that it stays maintainable alongside
`GUARDIAN_AUDIT.md`/`DEPLOY.md`'s existing style.
