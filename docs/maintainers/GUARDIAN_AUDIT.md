# Guardian System — Audit

Audit date: 2026-08-13

> **Status: fixes applied.** This document records the original audit. Sections 1–4
> describe the system **as found**; do not read them as current state. Section 8,
> appended after the fix batches, records what shipped, what is deliberately still
> open, and what must be done on the live system before any of it takes effect.
> Every batch is a separate commit; `b501509` is the unmodified baseline.

---

> ## READ THIS FIRST — this document is a historical record, not a description of the tree
>
> **Reconciled against HEAD in the forty-third pass.** Everything in Section 0
> and Section 5 below described a *partial export taken before this was a git
> repository*, and it was left standing for forty-two passes while the tree grew
> underneath it. The last pass never opened this file at all. A reader who took
> its first ninety lines at face value would mistrust the 2,800 useful ones that
> follow, which is why this box is here rather than a quiet edit.
>
> | Section 0 said | HEAD |
> |---|---|
> | `automations.yaml` 776 lines, 21 automations | **4,364 lines, 68 automations** |
> | `scripts.yaml` 506 lines, 8 scripts | **6,100+ lines, 36 scripts** |
> | `packages/guardian.yaml` 83 lines | **1,657 lines** |
> | `esphome/portal-unit.yaml` 528 lines | **2,500+ lines** |
> | "No `.git` — this is not a git repository" (R-01) | **88 commits.** R-01 is resolved. |
> | No `scenes.yaml`, no `themes/`, no `/config/guardian/` | **all three exist** |
> | `docs/*.docx (2)` | there were **three**; deleted in the forty-third pass, text moved into `INSTALL.md` §1 |
> | `docs/*.docx` "not inspected — review before publishing" (§4, §6) | **inspected and clean.** Resolved. |
>
> **The findings themselves (F-01 … F-58) were NOT rewritten.** They are the
> record of what was true when each was written, and several are cited by name
> from `DEPLOY.md` and from comments in the YAML. Where one has since been fixed,
> the pass that fixed it says so. Two worth stating here because Section 1 below
> still lists them as broken: **F-03 is fixed** — `button.play_welcome` became
> `button.guardian_interior_portal_play_welcome`, an ESPHome-derived id that
> preflight now verifies — and **F-07 is fixed**, `guest_bypass` having been
> deleted outright in the forty-first pass. Portal firmware now emits
> `esphome.tamper_alert`; Home Assistant still needs a portal reflash before
> that event can fire the alarm.
>
> What has *not* changed is the value of the reconstructed state machine in
> Section 2 and the reasoning in Section 3. Read those. Read Section 0 as
> archaeology.

## 0. Scope, access, and caveats

### What I could read

*(As it stood when this audit was written. See the reconciliation box above for
what these files look like now — every line count here is between three and
twenty times too small.)*

```
automations.yaml          776 lines   21 automations
scripts.yaml              506 lines    8 scripts
configuration.yaml         13 lines
packages/guardian.yaml     83 lines
packages/guardian-luminance.sh  11 lines   <-- see F-01
esphome/portal-unit.yaml  528 lines
esphome/doorbell-unit.yaml 188 lines
frigate/config.yml         61 lines
screenshots/perfect-exit-ui.png (historical; not in this tree)
docs/*.docx (2)
```

### What is NOT present in this copy

*(All six of these are now false. Kept because several findings below reason
from them, and deleting the premise would leave those findings looking
arbitrary.)*

- **No `.git`** — this is not a git repository. See R-01. **→ Resolved: 88 commits.**
- **No `secrets.yaml`** (core or ESPHome). The `!secret` key-existence check below could not be completed.
  **→ `secrets.yaml.example` and `tools/guardian-gen-secrets.py` now exist; preflight checks the ESPHome side.**
- **No `.storage/`** — no entity registry available. **→ Still true, and still the reason entity ids are derived statically.**
- **No `scenes.yaml`**, no `themes/` directory, despite `configuration.yaml` referencing both. **→ Both exist.**
- **No `/config/guardian/` directory**, and no `www/guardian/`. **→ `guardian/` exists and holds the luminance probe.**
- No live HA instance reachable from here. **→ Still true, and still the single largest limitation on every pass.**

This is a partial export, not a full config root. Findings marked **[VERIFY]** need confirmation against the real
`/config` tree or a Developer Tools → States export.

### Ground truth used for "does this entity exist"

A Home Assistant automation-editor screenshot (historical; not in this tree) rendered `Guardian: Perfect Exit`. It resolves
`input_text.portal_display_state` to its friendly name **"Portal Display State"**, while flagging two other entities
as **"Unknown entity"**. That is authoritative for those three entities:

| Entity | Editor verdict |
|---|---|
| `input_text.portal_display_state` | **exists** (UI helper) |
| `input_text.pending_exit_slot` | **DOES NOT EXIST** |
| `button.play_welcome` | **DOES NOT EXIST** |

By extension, the other YAML-undefined entities that the system uses constantly and that the user reports as working
(`input_select.rfid_1..4`, `input_text.rfid_1..4_hash`, `input_text.portal_pin_hash`,
`input_boolean.super_surveillance_mode`, `input_boolean.portal_mfa_pending`, `input_number.mfa_failed_attempts`) are
almost certainly UI helpers living in `.storage/`. They are **not** flagged as bugs. Two exceptions are flagged
below as [VERIFY] because nothing corroborates them.

---

## 1. Inventory: entity reference cross-check

### Defined in `packages/guardian.yaml`

`input_boolean`: `guardian_enrollment_mode`, `guardian_lamp_sampling`
`input_text`: `pending_mfa_slot`, `pending_entry_slot`, `pending_mfa_source`, `guardian_camera_entity`,
`guardian_camera_ir_entity`, `guardian_frigate_camera_name`
`input_number`: `guardian_dark_threshold`, `guardian_bright_threshold`
`timer`: `guardian_entry_window`, `guardian_exit_window`, `guardian_mfa_window`
`sensor`: `guardian_camera_luminance` (command_line)

### Referenced but NOT defined in any YAML in this tree

| Entity | Refs | Status |
|---|---|---|
| `input_text.pending_exit_slot` | 11 | **BROKEN** — confirmed Unknown entity (F-02) |
| `button.play_welcome` | 1 | **BROKEN** — confirmed Unknown entity (F-03) |
| `input_text.last_doorbell_rfid_time` | 1 (write-only) | **[VERIFY]** (F-04) |
| `binary_sensor.doorbell_button` | 1 | **[VERIFY]** — probable slug mismatch (F-05) |
| `notify.mobile_app` | 2 | **BROKEN** — not a real service (F-06) |
| `input_text.portal_display_state` | 20 | OK — UI helper, editor-confirmed |
| `input_select.rfid_1..4` | many | OK — UI helpers (presumed) |
| `input_text.rfid_1..4_hash` | many | OK — UI helpers (presumed) |
| `input_text.portal_pin_hash` | 1 | OK — UI helper (presumed) |
| `input_boolean.super_surveillance_mode` | 6 | OK — UI helper (presumed) |
| `input_boolean.portal_mfa_pending` | 9 | OK — UI helper (presumed) |
| `input_boolean.guest_bypass` | 2 (write-only) | Exists, but **dead** (F-07) |
| `input_number.mfa_failed_attempts` | 6 | OK — UI helper (presumed) |

### ESPHome-derived entity IDs — slug verification

`portal-unit.yaml` has `friendly_name: Guardian Interior Portal`, so HA generates
`<domain>.guardian_interior_portal_<name_slug>`.

| Referenced | ESPHome `name:` | Verdict |
|---|---|---|
| `binary_sensor.guardian_interior_portal_door_contact` | "Door Contact" | correct |
| `light.guardian_interior_portal_portal_led` | "Portal LED" | correct |
| `button.guardian_interior_portal_play_welcome` | "Play Welcome" | correct |
| `button.guardian_interior_portal_play_denied` | "Play Denied" | correct |
| `button.guardian_interior_portal_play_alarm` | "Play Alarm" | correct |
| `button.guardian_interior_portal_play_doorbell` | "Play Doorbell" | correct |
| `button.guardian_interior_portal_play_mfa_challenge` | "Play MFA Challenge" | correct |
| `button.play_welcome` | — | **WRONG** (F-03) |
| `binary_sensor.doorbell_button` | doorbell unit, friendly_name "Smart Doorbell", name "Doorbell Button" | expected `binary_sensor.smart_doorbell_doorbell_button` — **probable mismatch** (F-05) |

### `!secret` keys referenced — could not be verified (no `secrets.yaml` in this copy)

ESPHome: `wifi_ssid`, `wifi_password`, `portal_unit__ota_password`, `portal_unit__ap_ssid`,
`portal_unit__ap_password`, `portal_unit__encryption_key`, `doorbell_unit__encryption_key`,
`doorbell_unit__ota_password`, `doorbell_unit__fallback_password`.

Note: portal and doorbell are separate ESPHome devices and, in a standard HA OS install, share a single
`/config/esphome/secrets.yaml`. All nine keys must exist there. No core-config `!secret` references exist.
**Name-existence check pending.** No secret values were read at any point.

---

## 2. State machine reconstruction

Described as the code actually behaves, not as intended. Confirm these before reading section 3.

### 2.1 RFID scan → dispatch

Both readers fire `esphome.rfid_scanned` with `uid` + `source`. `Guardian: RFID Scanned` (`mode: queued`, max 10)
validates `source ∈ {doorbell, interior_portal}` and calls `script.process_rfid_scan`.

`process_rfid_scan` hashes the UID (SHA-256, unsalted), scans slots 1–4 for a matching
`input_text.rfid_N_hash`, and computes `elevated_mode = super_surveillance_mode OR hour < 5`. Then, in order:

1. **Matched + card marked Stolen/Lost** → fire `guardian.stolen_card_scanned`, display `STOLEN`, play denied, red lamp flash. No alarm, no passage window.
2. **Matched + elevated_mode** → cancel both passage timers and clear both pending slots, cancel MFA timer, set `pending_mfa_slot`/`pending_mfa_source`, turn on `portal_mfa_pending`, start 15 s `guardian_mfa_window`, display `MFA`, play challenge.
3. **Matched, normal mode** → `script.guardian_authorize_passage`.
4. **No match + enrollment mode on + a free slot** → write the hash into that slot, set it "At home", turn enrollment off, display `GRANTED`, welcome, green lamp.
5. **Default (unknown card)** → fire `guardian.unknown_card_scanned`, force enrollment off, display `DENIED`, play denied, red lamp. *No push notification.*

### 2.2 Authorize passage (intent, not presence)

`guardian_authorize_passage(slot, source)`:

- `source == doorbell` → cancel exit window, clear `pending_exit_slot`, set `pending_entry_slot = slot`, start 20 s **entry** window, stamp `last_doorbell_rfid_time`.
- `source == interior_portal` → cancel entry window, clear `pending_entry_slot`, set `pending_exit_slot = slot`, start 20 s **exit** window.
- anything else → `stop` with error.

Then display `GRANTED`, play welcome, green lamp. Presence is **not** changed here — that is the correct design.

### 2.3 Door opening → direction classification

`esphome.door_opened` carries ESP-computed `handle_moved_recently` (ESP window: 4000 ms) and
`handle_motion_age_ms`. `Guardian: Door Open Direction` picks the **first** matching branch:

1. entry window active → `guardian.door_opened_from_outside` (confidence high)
2. exit window active → `guardian.door_opened_from_inside` (high)
3. `handle_moved_recently == true` **and** `age ≤ 2000 ms` → `guardian.door_opened_from_inside` (**medium**)
4. default → `guardian.door_direction_unknown`

Note the HA-side window (2000 ms) is stricter than the ESP-side window (4000 ms); HA's is authoritative.

### 2.4 Passage completion

`Guardian: Complete Authorized Passage` listens to both direction events, reads the matching pending slot, and
only if it is 1–4: sets `input_select.rfid_N` to "At home" (entry) or "Away" (exit), cancels the matching timer,
clears the pending slot, green lamp.

`Guardian: Clear Expired Passage` clears the pending slot when either window timer finishes.

`Guardian: Uncertain Door Direction` responds to the unknown-direction event with a **persistent notification only**.

### 2.5 Perfect Exit — a second, parallel exit path

`Guardian: Perfect Exit` triggers on the *same* `esphome.rfid_scanned` event (filtered to `interior_portal`),
independently of the dispatcher. If the UID matches a slot currently "At home": set `pending_exit_slot`, display
`GRANTED`, press `button.play_welcome`, then `wait_for_trigger` on `guardian.door_opened_from_inside` for 30 s.
On success → slot "Away", clear pending, green lamp. On timeout → clear pending. `mode: single`.

This runs **concurrently with** `process_rfid_scan`, which is already handling the same scan.

### 2.6 Forgetful exit

`Guardian: Forgetful Exit Warning` fires on `door_opened_from_inside` when `pending_exit_slot ∉ {1,2,3,4}` and
super surveillance is off → red lamp + push to both phones.

### 2.7 MFA challenge

`Guardian: Master PIN Entry Handler` triggers on `esphome.pin_entered`, gated on `portal_mfa_pending == on`.

- **PIN correct** (`stored_hash` is 64 chars and matches) → cancel MFA timer, reset fail counter, clear pending flag, then:
  - slot 1–4, valid source, **door contact `off`** → `guardian_authorize_passage`, display `GRANTED`, welcome.
  - slot valid, **door contact `on`** → `guardian.major_alarm` ("Door was already open when MFA was completed").
  - otherwise → `DENIED` + denied tone.
  - Finally clear `pending_mfa_slot` / `pending_mfa_source`.
- **PIN wrong** → increment `mfa_failed_attempts`; at ≥3 → reset counter, cancel timer, clear MFA state, fire `guardian.major_alarm` ("Maximum PIN attempts exceeded"). Below 3 → `DENIED`, denied tone, red lamp, 3 s delay, then back to `MFA` if still pending.

`Guardian: MFA Timeout` — on `guardian_mfa_window` finishing while still pending: clear state and fire
`guardian.major_alarm` ("MFA authentication timed out").

`Guardian: Elevated Opening Supervisor` — on **any** `esphome.door_opened` while elevated_mode is on and neither
passage window is active: wipe MFA state and fire `guardian.major_alarm`. This is the "MFA pending never authorizes
a physical opening" guard.

### 2.8 Alarm

`Guardian: Major Alarm Handler` (`mode: restart`) sets display `ALARM`, turns the Tapo lamp full red, pushes to
both phones with a `MUTE_GUARDIAN_ALARM` action, then loops `play_alarm` every 3 s **while** display state is
`ALARM`. `Guardian: Dismiss Alarm from Phone` handles the notification action: display → `IDLE` (which ends the
loop), clear MFA pending + lamp sampling, clear pending MFA slots, cancel MFA timer, lamp off.

### 2.9 Ambient light sampling

`Guardian: Camera-Based Lamp Control` runs on `hours: /3, minutes: /10` and at HA start (+120 s delay), calling
`script.guardian_sample_ambient_light`:

1. Bail if already sampling, if display is `ALARM`, or if `guardian_lamp_feedback` is running.
2. Read camera/IR entity names from input_texts; bail if the camera entity is invalid/unavailable.
3. Set `guardian_lamp_sampling` on; **turn the Tapo lamp off**; if an IR entity is configured, `switch.turn_off` it.
4. Wait 5 s → `camera.snapshot` to `/config/www/guardian/ambient.jpg` (`continue_on_error`) → wait 1 s.
5. Stamp `sample_marker = now()`; force `homeassistant.update_entity` on `sensor.guardian_camera_luminance`.
6. `wait_template` for the sensor to be numeric **and** `last_updated > sample_marker`, 10 s timeout, continue on timeout.
7. Re-enable IR if it was on.
8. `luminance ≤ dark_threshold` → lamp on, 4000 K, 45 %. `luminance ≥ bright_threshold` → lamp off. **Otherwise → restore previous lamp state (no-op).**
9. Clear the sampling flag.

`Guardian: Lamp Sampling Watchdog` clears a stuck sampling flag after 60 s or at HA start.

### 2.10 Person detected while away

`Guardian: Frigate Person Detected While Away` — MQTT `frigate/events`, requires `type == 'new'`,
`after.label == 'person'`, `after.camera == states('input_text.guardian_frigate_camera_name')`, not a false
positive, **and all four `input_select.rfid_*` are not "At home"** → push to both phones.

### 2.11 Doorbell

`esphome.doorbell_pressed` → press `button.guardian_interior_portal_play_doorbell`. Separately,
`binary_sensor.doorbell_button` → on turns on `input_boolean.guest_bypass` for 60 s.

---

## 3. Findings

Severity: **BUG** (broken behavior today) / **HARDENING** (works, but defeatable or fragile) / **COSMETIC**.

---

### F-01 — `guardian-luminance.sh` does not exist; the file with that name contains YAML — **BUG, critical**

`packages/guardian.yaml:73-84` configures:

```
command: sh /config/guardian/guardian-luminance.sh /config/www/guardian/ambient.jpg
```

Two independent failures:

1. **The path `/config/guardian/` does not exist in this tree.** The only file with that name is
   `packages/guardian-luminance.sh` — wrong directory.
2. **`packages/guardian-luminance.sh` is not a shell script.** Its 11 lines are a verbatim copy of the
   `command_line:` YAML block from `packages/guardian.yaml:73-84`. It appears to be a copy/paste accident: the
   sensor definition was pasted into the file that was supposed to hold the script. Running `sh` against it
   produces syntax errors on stderr and nothing on stdout.

Consequence, exactly as predicted: command produces no stdout → `value_template` renders `"" | float | round(1)`
→ the sensor stays `unknown`/errors → `wait_template` at `scripts.yaml:422` never satisfies → 10 s timeout →
`wait.completed` false → `luminance_valid` false → **both** `choose` branches at `scripts.yaml:443-465` fail →
`default` → `guardian_restore_lamp` puts the lamp back exactly as it was. The lamp never changes based on ambient
light, in either direction, silently.

Also note `packages/guardian-luminance.sh` sits inside the `packages/` directory that `configuration.yaml:14`
loads with `!include_dir_named packages`. That loader only reads `.yaml`, so the stray file is ignored rather than
double-registering the sensor — no parse error, but it is a trap for the next person.

This is the root cause of the reported symptom. Not a hypothesis.

**Fix A (recommended, minimal):** write a real `/config/guardian/guardian-luminance.sh` that takes a JPEG path and
prints one number, and delete/replace the mis-pasted file. ImageMagick is not present in HA OS by default, so the
script must not assume it — see F-08.

**Fix B:** drop the shell script entirely and compute luminance inside HA. Larger diff, no external dependency.
Only worth it if F-08 shows no usable binary exists.

---

### F-02 — `input_text.pending_exit_slot` is undefined — **BUG, critical**

Editor-confirmed "Unknown entity" in the screenshot. Referenced 11 times across `automations.yaml` and
`scripts.yaml`. Every sibling (`pending_entry_slot`, `pending_mfa_slot`, `pending_mfa_source`) is defined at
`packages/guardian.yaml:13-25`; this one was simply omitted.

Failure mode — every read returns `unknown`, every write errors:

- `scripts.yaml:171,201` — `guardian_authorize_passage` cannot record exit intent. **All exits break.**
- `automations.yaml:637` — `Complete Authorized Passage` reads `unknown` → slot check fails → **presence is never set to Away**.
- `automations.yaml:261` — `Forgetful Exit Warning` sees `unknown ∉ {1,2,3,4}` → **fires on every single exit**, including correctly scanned ones. This is the highest-annoyance false positive in the system and is exactly the "family disables the system" risk the design philosophy warns about.
- `automations.yaml:207` — `Perfect Exit` write fails, so its own success branch is meaningless.

**Fix:** add to `packages/guardian.yaml` alongside the others:

```yaml
  pending_exit_slot:
    name: Guardian Pending Exit Slot
    initial: none
    max: 4
```

One caveat: adding a YAML helper with the same object_id as a `.storage` helper collides. The editor says none
exists, so this is safe — but confirm against Settings → Devices & Services → Helpers before applying.

---

### F-03 — `button.play_welcome` is undefined — **BUG**

`automations.yaml:217`, `Guardian: Perfect Exit`. Editor-confirmed Unknown entity. Every other button reference in
the config uses the device-prefixed form. The correct ID is
`button.guardian_interior_portal_play_welcome` (`portal-unit.yaml:369-374`, name "Play Welcome").

Failure mode: `button.press` raises on an unknown entity, which **aborts the rest of the automation run**. So in
`Perfect Exit`, the `wait_for_trigger` and the entire success branch after it never execute. Combined with F-02,
`Perfect Exit` is currently a complete no-op that dies three steps in.

**Fix:** change to the prefixed ID. But see F-11 — `Perfect Exit` may be redundant with `process_rfid_scan`
altogether, so decide that first rather than fixing a line you may delete.

---

### F-04 — `input_text.last_doorbell_rfid_time` — **[VERIFY] / BUG**

`scripts.yaml:182-186` writes it; **nothing anywhere reads it**. Not defined in YAML, and unlike the other UI
helpers there is no corroborating evidence it exists. If it doesn't, this write raises mid-script and aborts
`guardian_authorize_passage` before it reaches `input_text.set_value` → `GRANTED`, the welcome tone, and the green
lamp at `scripts.yaml:210-218`. That would mean **every doorbell-side entry silently loses its user feedback** —
the entry timer starts, but the portal never says GRANTED.

Note this only affects the `doorbell` branch; the `interior_portal` branch has no such write.

Check Developer Tools → States for `input_text.last_doorbell_rfid_time`. Then either define it, or (better,
since it is write-only dead code) delete the write.

---

### F-05 — `binary_sensor.doorbell_button` is probably the wrong entity ID — **[VERIFY] / BUG**

`automations.yaml:380`. The doorbell unit declares `friendly_name: Smart Doorbell` (`doorbell-unit.yaml:3`) and
`name: "Doorbell Button"` (`doorbell-unit.yaml:101`), which HA slugs to
`binary_sensor.smart_doorbell_doorbell_button`. The bare form would only be correct if the entity was manually
renamed in the UI.

If wrong, `Guardian: Guest Bypass Trigger` never fires — which currently matters not at all, because of F-07.

---

### F-06 — `notify.mobile_app` is not a real service — **BUG**

`automations.yaml:134` and `automations.yaml:366`, both in tamper handlers. The mobile_app integration registers
per-device services (`notify.mobile_app_<device>`), never a bare `notify.mobile_app`. Neither call has
`continue_on_error`, so both raise.

At `automations.yaml:366` (`Guardian: Tamper Alert`) this is serious: the failing notify is the **first** action,
so the run aborts before setting `ALARM` and before firing `guardian.major_alarm`. **A tamper event produces no
alarm and no notification at all.** Given tamper is the signal that someone is physically attacking the portal,
this is the most consequential false negative in the config.

`automations.yaml:130` uses `notify.persistent_notification`, which is valid.

**Fix:** replace both with the two real device services already used elsewhere
(the household's Companion notify services), each with
`continue_on_error: true`, and reorder so the alarm event fires **before** any notify call.

---

### F-07 — Duplicate tamper automations; `guest_bypass` is dead code — **BUG / COSMETIC**

Two automations trigger on `esphome.tamper_alert`: `Guardian: Portal Tamper Alert` (id `1774799858900`) and
`Guardian: Tamper Alert` (id `1775063609192`). They overlap almost entirely; only the second fires
`guardian.major_alarm`. Both are broken by F-06. They should be merged into one.

Separately, neither the portal nor the doorbell ESPHome config **ever fires `esphome.tamper_alert`** — grep both
YAMLs, there is no tamper sensor and no such event. **The tamper detection feature does not exist on the device
side.** The HA half is orphaned. Either implement it on the portal or remove the automations; leaving them creates
a false sense of coverage.

`input_boolean.guest_bypass` is turned on and off by `Guardian: Guest Bypass Trigger` and is **read by nothing**.
Whatever it was meant to suppress, it doesn't.

---

### F-08 — Luminance measurement will misread IR/night-vision — **BUG, and the second half of the lamp problem**

Even with F-01 fixed, the lamp will still misbehave in the dark.

`input_text.guardian_camera_ir_entity` has `initial: none` (`packages/guardian.yaml:30-33`). So
`ir_valid` (`scripts.yaml:380`) is false, the `switch.turn_off` at `scripts.yaml:404` is skipped, and **IR is never
disabled before sampling**. In darkness the C110 switches to night vision and returns a bright, IR-flooded,
monochrome/violet-tinted frame. A naive mean-luma reading of that frame is *high* — often above
`guardian_bright_threshold` (90).

Result: **in the dark, the system measures "bright" and turns the lamp off.** That is the reported symptom, and it
survives fixing F-01. Both must be fixed together or the bug appears unfixed.

Additional problems in the same path:

- The IR handling assumes the `switch` domain (`scripts.yaml:404`, `439`). Tapo IR/night-vision is commonly a `select` ("Night Vision Mode": auto/on/off), not a switch. The template supplies the entity ID but the domain is hardcoded, so a `select.` entity would raise — masked by `continue_on_error: true`, meaning **IR silently stays on**.
- `ir_was_on` is captured *before* IR is turned off, and IR is only re-enabled `if ir_valid and ir_was_on` (`scripts.yaml:435-442`). If the camera was in *auto* mode this reads as neither, and IR may be left off. In a `select`-based setup you would need to save and restore the previous option, not a boolean.
- IR is re-enabled at `scripts.yaml:435` — correctly placed *after* the `wait_template` and after `luminance` is captured into a variable, so the read is not corrupted by re-enabling. That part is right.
- No settling time after disabling IR. The camera needs time to switch out of night mode, drop the IR cut filter, and auto-expose. The 5 s delay at `scripts.yaml:408` is before the snapshot but IR was disabled at essentially the same moment, so 5 s covers both — probably marginal, not clearly wrong.

**Fix A (recommended, smallest correct change):** treat IR state as the darkness signal instead of trying to
normalize around it. If the camera reports night vision active, it is dark — turn the lamp on and skip the
snapshot path entirely. Falls back to luminance sampling when IR is off/unknown. Requires setting
`guardian_camera_ir_entity` to the real entity and generalizing the domain handling.

**Fix B:** normalize in the shell script — detect low saturation (IR frames are near-greyscale) and apply a
separate, much higher threshold pair for IR frames. More faithful to the current design, but two threshold regimes
to tune and it still depends on getting a usable frame.

**Fix C (do this regardless):** set `guardian_camera_ir_entity` to the actual entity and make the domain dynamic.
Without this, A and B are both inert.

---

### F-09 — `last_updated` freshness check silently fails on unchanged readings — **BUG**

`scripts.yaml:422-424`:

```
{{ states('sensor.guardian_camera_luminance') not in ['unknown','unavailable'] and
   states.sensor.guardian_camera_luminance.last_updated > sample_marker }}
```

In HA, `last_updated` advances only when the state **value or attributes change**. A luminance sensor that reads
`72.0` twice in a row does not update `last_updated`. The wait then times out, `wait.completed` is false,
`luminance_valid` is false, and the flow lands in the do-nothing `default` branch.

So even after F-01 and F-08 are fixed, **any two consecutive identical readings cause a silent no-op**, and the
`value_template`'s `round(1)` makes collisions more likely, not less. This is an independent latent bug that will
present as "it works sometimes."

Secondary risk: `sample_marker: '{{ now() }}'` (`scripts.yaml:417`). With native-type rendering this stays a
tz-aware datetime and the comparison works; if it renders to a string the comparison raises, the template
evaluates false forever, and the wait *always* times out. Worth eliminating rather than reasoning about.

**Fix A (recommended):** use `last_reported` (HA 2024.8+), which advances on every update regardless of whether the
value changed.

**Fix B:** drop the freshness check and rely on `homeassistant.update_entity` being synchronous — it awaits the
entity's update before returning, so by the time the next step runs the value is already fresh. Then
`luminance_valid` becomes just `is_number(...)`. Smallest diff, removes the datetime-comparison risk entirely.

Also confirm `scan_interval: 86400` (`packages/guardian.yaml:81`) does not suppress forced updates in your HA
version. The modern `command_line` integration honors `homeassistant.update_entity`, but a 24 h interval means
**if forced updates ever stop working, the sensor is stale for a full day** with no visible failure.

---

### F-10 — `camera.snapshot` failure silently measures a stale image — **BUG**

`scripts.yaml:409-414` has `continue_on_error: true`. If the snapshot fails (camera unavailable, RTSP hiccup,
`/config/www/guardian/` missing), the script proceeds and measures **the previous run's `ambient.jpg`** — a
reading from up to three hours ago, presented as current. With F-09 fixed to use `last_reported`, this is even
worse: the stale read now looks valid and the lamp acts on it.

Also: nothing creates `/config/www/guardian/`. If it does not exist, every snapshot fails from day one.
`allowlist_external_dirs` (`packages/guardian.yaml:2-3`) grants permission but does not create the directory.

**Fix:** have the shell script reject a file older than ~60 s (`find -mmin`) and print nothing, so a stale frame
becomes an invalid reading rather than a confident wrong one. Verify the directory exists.

---

### F-11 — `Perfect Exit` duplicates `process_rfid_scan` and bypasses elevated mode — **HARDENING, significant**

`Guardian: RFID Scanned` describes itself as the "single dispatcher... avoids double-processing interior scans"
(`automations.yaml:3-4`). But `Guardian: Perfect Exit` (`automations.yaml:195-198`) triggers on **the same raw
event**. Every interior scan runs both paths concurrently. Both write `pending_exit_slot`, both press a welcome
button, both call `guardian_lamp_success`.

The security-relevant part: **`Perfect Exit` does not check `elevated_mode`.** `process_rfid_scan` explicitly
routes elevated-mode scans into the MFA challenge instead of granting passage (`scripts.yaml:46-90`). `Perfect
Exit` ignores that and proceeds straight to `GRANTED` + welcome tone + `pending_exit_slot`, then on a door opening
sets the slot to **"Away" with no PIN ever entered**.

Mitigations that make this partial rather than total: `Elevated Opening Supervisor` still alarms on the opening,
and there is no electronic lock to release. But it means in super surveillance mode an attacker with a stolen card
gets a *green light and a welcome chime*, and the presence state machine is driven without authentication. That
contradicts "super surveillance mode must be strict and untrickable."

It is not exploitable **today** only because F-02 and F-03 have `Perfect Exit` aborting on line 3. Fixing those two
bugs without addressing this **activates the bypass.** This is why F-03 should not be fixed in isolation.

**Fix A (recommended):** delete `Guardian: Perfect Exit`. `process_rfid_scan` → `guardian_authorize_passage` →
`Complete Authorized Passage` already implements the exact same flow, with the elevated-mode check and a
timer-based window instead of a 30 s in-automation wait. This removes a whole automation and one class of race.

**Fix B:** keep it, add an `elevated_mode` guard condition and fix the button ID. Retains the duplicate write path
and the F-12 race.

---

### F-12 — Race: `Complete Authorized Passage` vs `Forgetful Exit Warning` — **BUG, false positive**

Both trigger on `guardian.door_opened_from_inside`. `Complete Authorized Passage` clears `pending_exit_slot`
(`automations.yaml:627-632`). `Forgetful Exit Warning` **reads** `pending_exit_slot` in its condition
(`automations.yaml:261-262`). HA runs both concurrently with no ordering guarantee.

If the clear lands before the read, a perfectly correct scanned exit is reported as
"⚠️ exit not registered" plus a red lamp flash. Intermittent, timing-dependent, and precisely the kind of nuisance
alert that gets a system switched off.

`Perfect Exit` clearing the same variable (`automations.yaml:236-238`) makes it a three-way race.

**Fix A (recommended):** have `Forgetful Exit Warning` key off a positive signal instead of the absence of one —
e.g. condition on neither passage timer being active, which `Complete Authorized Passage` cancels *after* the
presence change, or capture the pre-clear value. Cleanest with F-11 Fix A applied, which removes one racer.

**Fix B:** add a short `delay` before the condition. Papers over it; still racy under load.

---

### F-13 — MFA brute-force protection is bypassable via `mode: single` — **HARDENING, security**

`Guardian: Master PIN Entry Handler` is `mode: single` (`automations.yaml:553`). Its wrong-PIN branch ends with
`delay: 00:00:03` (`automations.yaml:544`). During that 3 s window the automation is still running, so **any
`pin_entered` event that arrives is silently dropped** — HA logs a warning and discards it.

A dropped event means `mfa_failed_attempts` is never incremented for that attempt. An attacker entering PINs
faster than one per ~3 s gets attempts that **do not count toward the 3-strike lockout and never fire
`guardian.major_alarm`**. The keypad has no debounce beyond per-key handling; `#` submits immediately.

That defeats the brute-force protection on a 4–6 digit PIN. Directly contradicts the "no soft fallbacks, no state
where a race condition silently grants access" requirement.

**Fix A (recommended):** `mode: queued`, `max: 10`. Every attempt is then counted and the lockout holds. Note that
the 3 s delay then serializes queued attempts, which additionally rate-limits — a bonus.

**Fix B:** move the fail-counter increment to a separate `mode: queued` automation so counting can never be
dropped regardless of what the display logic does. More robust, larger diff.

Related, lower severity: hitting 3 failures **resets the counter to 0** (`automations.yaml:513-517`) and fires the
alarm, but imposes **no lockout**. The attacker simply continues, generating an alarm every 3 attempts. The alarm
is loud, so this is defensible — but consider clearing `portal_mfa_pending` *and* refusing new MFA challenges for
a cooldown period.

---

### F-14 — 15-second MFA window will generate false alarms — **HARDENING, false positive**

`timer.guardian_mfa_window` is 15 s (`packages/guardian.yaml:67-70`). On expiry, `Guardian: MFA Timeout` fires a
**full `guardian.major_alarm`** — red lamp, sirens looping every 3 s, high-priority push to both phones
(`automations.yaml:698-700`).

15 s covers: reading the display, retrieving a 4–6 digit PIN from memory, and typing it on a 3×4 matrix keypad in
the dark, possibly with gloves or full hands. A legitimate family member who fumbles once triggers the full alarm
response. The same is true at 04:59 for anyone up early, since `elevated_mode` includes `hour < 5`.

Compare: the entry and exit windows are 20 s for the far simpler task of opening a door.

The strictness is intentional per the design philosophy, so this is a tuning question, not a defect. But 15 s is
low enough that the practical outcome is the family turning super surveillance off — a net security loss.

**Fix A (recommended):** raise to 30–45 s. Timeout still alarms; nothing about the security model changes.
One-line diff in `packages/guardian.yaml`.

**Fix B:** on the *first* timeout, warn (push only) and re-arm once; alarm on the second. More forgiving, but adds
a soft path into the strict mode — likely unacceptable given the stated requirement. Mentioned only for completeness.

---

### F-15 — Frigate camera name mismatch: person-detection is dead — **BUG, critical false negative**

`frigate/config.yml:2` defines the camera as `door_camera`. `packages/guardian.yaml:34-37` sets
`input_text.guardian_frigate_camera_name` to `initial: front_door`.

`Guardian: Frigate Person Detected While Away` (`automations.yaml:750`) compares
`trigger.payload_json.after.camera` against that input_text. `door_camera != front_door`, so the condition is
**never** true. **The person-detected-while-away alert has never fired and cannot fire.**

This is the single most important false negative found: the intrusion detector is disconnected.

Note `initial:` only applies on first creation — if the helper already exists with a stored value, changing
`initial:` will not update it. Set the value directly, or change the Frigate camera name to match.

**Fix:** set the input_text to `door_camera` (via the UI or Developer Tools → States, not just `initial:`), then
verify by watching the MQTT topic during a real detection.

---

### F-16 — "All cards away" gate makes intrusion detection self-defeating — **HARDENING, design tension**

`automations.yaml:753-755` requires **zero** of the four `input_select.rfid_*` to be "At home" before alerting on a
detected person. Combined with the deliberately permissive exit handling, this is self-defeating: the design
tolerates people leaving without scanning (correctly — that is normal for a family of 4), but every such
unscanned exit leaves a card stuck at "At home", which **permanently suppresses person detection until someone
scans back in.**

One person forgetting once disables the burglar alarm indefinitely. This is the exact "too permissive" gap the
audit brief asks to be flagged: the smart-and-forgiving exit logic and the intrusion detector are in direct
conflict, and the intrusion detector loses.

**Fix A (recommended):** corroborate with phone presence. Alert when all cards are away **or** when no household
`device_tracker` is home. Phone presence is independent of whether anyone remembered to scan, and the brief
explicitly endorses extending contextual inference. Requires knowing the real `device_tracker` entity IDs.

**Fix B:** stale-presence decay — if a slot has been "At home" for more than N hours with no door event and no
phone home, treat it as away for this check. Self-healing, no new integrations, but adds a helper and a
time-based automation.

---

### F-17 — Unclassified door openings produce no push notification — **HARDENING, false negative**

`Guardian: Door Open Direction`'s default branch fires `guardian.door_direction_unknown`, and
`Guardian: Uncertain Door Direction` responds with a **`persistent_notification` only** (`automations.yaml:666-671`)
— a badge in the HA web UI. No push, no lamp, no sound.

"The door opened and Guardian cannot explain why" is close to the definition of an intrusion in normal mode
(daytime, super surveillance off). Today it is the quietest possible response. A daytime forced entry where the
intruder does not touch the handle sensor within 2 s produces nothing anyone will see for hours.

Partially covered by `Forgetful Exit Warning`, but only for openings classified as *from inside* — the
unknown-direction path has no such backstop.

**Fix:** add the same two `notify.mobile_app_*` calls (with `continue_on_error`) used elsewhere. Low false-positive
cost, since this branch requires *both* no active passage window *and* no recent handle motion.

---

### F-18 — Handle motion classifies a forced entry as an exit — **HARDENING**

`Door Open Direction` branch 3 treats `handle_moved_recently` as evidence of an opening **from inside**. But the
MPU6050 is on the door handle and detects *any* handle disturbance, including from outside. Someone forcing or
jimmying the door will disturb the handle, land in branch 3, and be classified `door_opened_from_inside`
(confidence medium).

Consequence: routed to `Complete Authorized Passage` (no-op, no pending slot) and to `Forgetful Exit Warning` —
which does push, but with the message "exit not registered", framing a break-in as a family member forgetting
their card. Also, in super surveillance mode `Forgetful Exit Warning` is **suppressed entirely**
(`automations.yaml:263-265`), so during the strictest mode this path produces **no notification at all** and relies
solely on `Elevated Opening Supervisor` catching it.

The `Elevated Opening Supervisor` does catch it in elevated mode. In normal daytime mode, the outcome is a
misleading "you forgot to scan" push. Acceptable-ish given the design philosophy, but the confidence level should
not be trusted downstream, and `Forgetful Exit Warning` being suppressed in super surveillance mode deserves a
second look — the reason is presumably that the Supervisor covers it, which is true, but it makes the suppression
load-bearing.

---

### F-19 — Device-offline and restart states fail open — **HARDENING**

- **Portal offline:** no `esphome.door_opened` events. The door can be opened with **zero** system response. Nothing monitors portal availability. `binary_sensor.guardian_interior_portal_door_contact` going `unavailable` is never checked outside the MFA handler.
- **MFA handler with an unavailable door contact:** `automations.yaml:457` checks `state: 'off'` and `:477` checks `state: 'on'`; `unavailable` matches neither, falling to `default` → DENIED. **Fails closed. Correct** — worth preserving explicitly if this code is ever refactored.
- **HA restart mid-alarm:** `Major Alarm Handler` is `mode: restart` with a `repeat while display == ALARM` loop. A restart kills the loop, but `input_text.portal_display_state` restores to `ALARM` — so the portal shows ALARM forever with no audio and no way to re-enter the loop except a new alarm event. Recovery requires manually setting the helper.
- **HA restart mid-MFA:** `portal_mfa_pending` restores `on` but `timer.guardian_mfa_window` has `restore: false` (`packages/guardian.yaml:70`), so the timer is gone. `MFA Timeout` never fires. The system sits in MFA-pending indefinitely. Not a grant — a PIN is still required — so it fails closed, but it is a stuck state with no watchdog. Contrast with `Lamp Sampling Watchdog`, which does have a restart trigger; MFA has no equivalent.

**Fix:** add an availability watchdog on the portal ESPHome device (push if unavailable > 5 min), and an
HA-start automation that clears stale `portal_mfa_pending` / `ALARM` state the way the lamp watchdog already does.

---

### F-20 — Unsalted SHA-256 for PINs and RFID UIDs — **HARDENING**

`automations.yaml:555` hashes the PIN with bare `| sha256`; `scripts.yaml:15` does the same for RFID UIDs.

- A 4–6 digit PIN has at most 10⁶ candidates. Unsalted SHA-256 of that space is exhaustible in well under a second, and precomputed tables for all 4–6 digit strings are trivially available.
- RFID UIDs are 4 or 7 bytes with heavily structured, low-entropy vendor prefixes — also brute-forceable.
- The hashes live in `input_text` entities, which are **visible in the HA UI, in Developer Tools → States, in logbook/recorder history, and in any screenshot**. An automation-editor screenshot is a reminder of how easily these leak into a public repo.

The hashing gives obfuscation, not protection. This is a defense-in-depth gap, not an active exploit — an attacker
needs HA access first.

**Fix:** append a long random salt from `secrets.yaml` before hashing, in both places
(`{{ (pin ~ salt) | sha256 }}`). Two-line change, but it invalidates all stored hashes — every card must be
re-enrolled and the PIN re-set. Worth doing before open-sourcing, not urgently otherwise.

---

### F-21 — All device-reported state is trusted without corroboration — **HARDENING**

`handle_moved_recently` and `handle_motion_age_ms` are computed **on the ESP32** (`portal-unit.yaml:226-232`) and
consumed by HA as authoritative evidence of direction. Likewise `esphome.rfid_scanned`, `esphome.door_opened`, and
`esphome.pin_entered` carry a `source` field that HA validates for *membership* (`automations.yaml:10-12`) but
never for *authenticity* — nothing verifies the event actually came from the corresponding device.

Anything able to fire events on the HA event bus (any authenticated API token, any other automation, a compromised
add-on) can forge `esphome.rfid_scanned` with `source: interior_portal`, or forge `door_opened_from_inside`
directly to drive presence. The API is encrypted (`portal-unit.yaml:93-95`, `doorbell-unit.yaml:18-20`), so this
requires prior HA access — again defense-in-depth rather than a live hole.

The one genuine server-side sanity check in the system is the door-contact cross-check in the MFA handler
(`automations.yaml:457`, `:477`) — good pattern, applied in exactly one place.

**Fix:** cross-check `handle_moved_recently` against the independent `binary_sensor.<...>_handle_motion` entity
state (already exposed at `portal-unit.yaml:206-209`) rather than trusting the number in the event payload. Same
sensor, but it arrives through the authenticated ESPHome state channel instead of a free-form event payload.

---

### F-22 — Baseline reset on door close creates a blind window — **HARDENING**

`portal-unit.yaml:233-241`: on door close, after a 2 s delay, `handle_baseline_ready = false` and
`last_handle_motion_ms = 0`. On the next 50 ms tick the baseline re-seeds from the *current* accelerometer reading
and `return`s.

If the door is closed while the handle is still being held down, the baseline is captured in the **deflected**
position. Subsequent handle motion is then measured relative to the wrong rest state, and returning the handle to
its true rest position reads as motion. The `alpha = 0.01f` drift correction at `portal-unit.yaml:286-290` will
recover this over roughly 5–10 s, so it is self-healing.

More significant: `last_handle_motion_ms = 0` **erases the motion history**. A rapid close-then-reopen within the
2 s window loses the handle evidence, so the reopen is classified as `door_direction_unknown` (which, per F-17, is
the silent branch). Narrow, but it is a real path to a suppressed alert.

---

### F-23 — Timer `restore: false` on all three windows — **COSMETIC / HARDENING**

`packages/guardian.yaml:62,66,70`. On HA restart, active entry/exit/MFA windows vanish. For entry/exit this fails
closed (a legitimate passage in progress is forgotten → the opening becomes unknown-direction). For MFA it creates
the stuck state in F-19. Restarts are rare enough that this is acceptable; noted for completeness.

---

## 4. Pre-open-source cleanup

The brief asks for anything hardcoding personal information, even if it looks like a placeholder.

| Location | Content | Note |
|---|---|---|
| `frigate/config.yml:7,10,59,61` | a camera RTSP URL with an embedded password | **Credentials in plaintext, ×4.** Rotate that camera account if it was ever live. Move to Frigate's `{FRIGATE_RTSP_USER}`/`{FRIGATE_RTSP_PASSWORD}` env substitution. |
| `frigate/config.yml` | a LAN address | Internal IP, ×4. |
| `esphome/portal-unit.yaml:65-69` | a static LAN address, gateway, and subnet | Static IP + LAN topology. Move to `!secret` or document as user-configurable. |
| `automations.yaml` (10 occurrences) | Companion notify entity names | **Real personal names and device models.** Template these to a `notify` group (e.g. `notify.guardian_alerts`) — improves the code *and* removes the PII, since adding a family member currently means editing 10 call sites. |
| `esphome/doorbell-unit.yaml:57` | `ssid: Doorbell Fallback` | Harmless, but inconsistent — the portal uses `!secret portal_unit__ap_ssid` for the same thing. |
| `packages/guardian.yaml:28` | `camera.tapo_c110` | Device-specific default; fine, worth documenting. |
| a Home Assistant editor screenshot (historical; not in this tree) | — | Re-check any future screenshots for hash values and entity IDs (see F-20). |
| `docs/*.docx` | ~~not inspected~~ **RESOLVED (forty-third pass)** | Inspected: no IPs, no names, no SSIDs, no coordinates. Deleted for size (124 MB of images, 45 KB of text); text moved into `INSTALL.md` §1. |

---

## 5. Repository state

### R-01 — Not a git repository — ~~blocking for the fix phase~~ **RESOLVED**

> **Resolved long ago and never marked.** The tree has been under git since
> shortly after this was written and is at 88 commits; the recommendation below
> was taken, including the `.gitignore`. Left in place because the *reason* it
> gives — that a burglar alarm in daily use by four people had no rollback path
> — is the argument that produced `DEPLOY.md`'s pass-by-pass record.

`git status` → `fatal: not a git repository`. Nothing here is under version control, so none of the fixes below can
be delivered as a reviewable diff, and there is no rollback path for a system described as production and in daily
use by four people.

Recommend `git init` + an initial commit of the current state **before** any file is modified, with a `.gitignore`
covering `secrets.yaml`, `.storage/`, `*.db`, `www/guardian/*.jpg`, and ESPHome build directories.

### R-02 — This tree is not a complete config root

`configuration.yaml` references `scenes.yaml` and `themes/`, neither of which is present. Either this is a partial
export (most likely), or HA is not currently starting. Confirm which before applying fixes — if I am working
against a partial copy, the paths in every fix need re-verification against the real `/config`.

---

## 6. Findings summary

| # | Severity | Finding |
|---|---|---|
| F-01 | **BUG, critical** | `guardian-luminance.sh` missing; the file with that name contains YAML. Root cause of the lamp bug. |
| F-02 | **BUG, critical** | `input_text.pending_exit_slot` undefined — breaks all exits, false-warns on every one |
| F-15 | **BUG, critical** | Frigate camera name mismatch (`door_camera` vs `front_door`) — person detection has never fired |
| F-06 | **BUG** | `notify.mobile_app` invalid → tamper alerts produce no alarm and no notification |
| F-03 | **BUG** | `button.play_welcome` undefined → aborts `Perfect Exit` |
| F-08 | **BUG** | IR/night-vision not disabled or normalized → measures "bright" in the dark |
| F-09 | **BUG** | `last_updated` freshness check silently no-ops on repeated readings |
| F-10 | **BUG** | Snapshot failure silently measures a stale image |
| F-12 | **BUG** | Race clears `pending_exit_slot` before the forgetful-exit check reads it |
| F-04 | **[VERIFY]** | `input_text.last_doorbell_rfid_time` — may abort doorbell-entry feedback |
| F-05 | **[VERIFY]** | `binary_sensor.doorbell_button` probable slug mismatch |
| F-07 | **BUG/COSMETIC** | Duplicate tamper automations; `esphome.tamper_alert` is never fired by any device; `guest_bypass` is dead |
| F-13 | **HARDENING, security** | `mode: single` drops rapid PIN attempts → brute-force lockout bypass |
| F-11 | **HARDENING, security** | `Perfect Exit` duplicates the dispatcher and skips the elevated-mode MFA gate |
| F-16 | **HARDENING** | "All cards away" gate lets one forgotten scan disable intrusion detection indefinitely |
| F-17 | **HARDENING** | Unclassified door openings produce only a persistent notification |
| F-14 | **HARDENING** | 15 s MFA window → likely false alarms → mode gets disabled |
| F-18 | **HARDENING** | Handle motion misclassifies forced entry as an exit |
| F-19 | **HARDENING** | Portal offline / HA restart mid-flow leave stuck or unmonitored states |
| F-20 | **HARDENING** | Unsalted SHA-256 for PINs and RFID UIDs |
| F-21 | **HARDENING** | ESP-reported values trusted without server-side corroboration |
| F-22 | **HARDENING** | Handle baseline reset erases motion history for 2 s after close |
| F-23 | **COSMETIC** | Timers do not survive restart |
| R-01 | **Blocking** | Not a git repository |
| R-02 | **Blocking** | Partial config tree; `scenes.yaml` and `themes/` absent |

---

## 7. Proposed fix batches

**No files will be modified until each batch is approved separately.**

**Batch 0 — safety net.** `git init`, `.gitignore`, baseline commit. No config changes. *(R-01)*

**Batch 1 — undefined entities.** Add `pending_exit_slot`; fix `button.play_welcome`; fix `notify.mobile_app` ×2 and reorder the tamper actions; resolve F-04/F-05 against the live registry. Restores exits, tamper alerts, and stops the false "exit not registered" storm. *(F-02, F-03, F-06, F-04, F-05)*
→ **Must be sequenced with Batch 4**: fixing F-03 alone activates the F-11 bypass.

**Batch 2 — the lamp.** Write a real `guardian-luminance.sh` (with a staleness guard), verify `/config/guardian/` and `/config/www/guardian/`, delete the mis-pasted file, switch to `last_reported`, set the real IR entity and handle its domain, and pick an IR strategy. Largest batch; entirely within the lamp path and no security impact. *(F-01, F-08, F-09, F-10)*

**Batch 3 — reconnect intrusion detection.** Correct the Frigate camera name and verify against live MQTT; add push notifications to the unknown-direction branch. *(F-15, F-17)*

**Batch 4 — MFA and exit-path hardening.** `mode: queued` on the PIN handler; remove or gate `Perfect Exit`; fix the forgetful-exit race; raise the MFA window. Touches security logic — worth reviewing line by line. *(F-13, F-11, F-12, F-14)*

**Batch 5 — resilience.** Portal availability watchdog; HA-start cleanup for stale MFA/ALARM state. *(F-19)*

**Batch 6 — pre-release.** Notify group replacing the 10 hardcoded call sites; secrets for IPs and RTSP credentials; salted hashing (requires re-enrollment); `.docx` review. *(Section 4, F-20)*

**Deferred, needs a decision:** F-16 (presence corroboration — needs the real `device_tracker` entity IDs);
F-07 tamper (implement device-side, or remove the orphaned automations); F-21, F-18, F-22, F-23.

---

## 8. Post-fix status

Applied across commits `a15c0ca`, `afcd8d7`, `9019b8a`, `f460ea6`, and the final
batch. Baseline for rollback: `b501509`.

### 8.1 Required on the live system

**None of the following are code changes. Without them, parts of the fixes do nothing.**

| # | Action | Why |
|---|---|---|
| 1 | Set `input_text.guardian_frigate_camera_name` to `door_camera` | `initial:` only applies at helper creation. Until changed, person-detection stays dead (F-15). |
| 2 | Set `input_text.guardian_camera_ir_entity` to the real night-vision entity | Until set, `ir_valid` is false, IR stays on, and dark scenes still measure bright (F-08). |
| 3 | Confirm `/config/www/guardian/` exists | `allowlist_external_dirs` grants permission but does not create the directory. If missing, every snapshot has always failed. |
| 4 | Deploy `guardian-luminance.sh` to `/config/guardian/` | Repo path is `guardian/guardian-luminance.sh`. `chmod +x` not needed; invoked via `sh`. |
| 5 | Set `FRIGATE_RTSP_USER`, `FRIGATE_RTSP_PASSWORD`, `FRIGATE_CAMERA_HOST` in the Frigate add-on config | Config now uses env substitution. **Streams fail if unset.** |
| 6 | *(none)* — `secrets.yaml` needs no changes and no reflash is required | All 9 `!secret` keys referenced by the ESPHome configs already exist. The portal static IP stays inline by request; see 8.3. |
| 7 | Rotate the camera RTSP credentials | They were committed in plaintext and are in git history (`b501509`). |
| 8 | Optionally set `input_text.guardian_presence_trackers` | Empty = original behaviour. Populated = fixes F-16. |

### 8.2 Fixed

| # | Fix |
|---|---|
| F-01 | Real `guardian-luminance.sh` written (Python + Pillow). Verified: grey 0/45/90/128/255 exact; corrupt/empty/missing produce no output and non-zero exit. |
| F-02 | `input_text.pending_exit_slot` defined. |
| F-03 | Resolved by removing `Perfect Exit`. |
| F-06 | Invalid `notify.mobile_app` replaced; alarm-critical actions reordered ahead of notify calls. |
| F-07 | Duplicate tamper automations merged into one. **Device side still absent** - see 8.3. |
| F-08 | IR handling made domain-agnostic (`switch` **and** `select`), restores the previous select option rather than a boolean. Measured: IR frame 146 luma vs 14 with IR off - same darkness, opposite lamp decisions. |
| F-09 | `last_updated` to `last_reported`; `now()` to `utcnow()`. |
| F-10 | 60s staleness guard in the script, plus an `availability` template on the sensor. |
| F-11 | `Perfect Exit` removed; the elevated-mode bypass is gone. |
| F-12 | Race removed by reading the immutable event payload (`reason == recent_interior_handle_motion`) instead of shared mutable state. |
| F-13 | `mode: queued` **and** action-time read-modify-write. Either alone leaves the bypass open. |
| F-14 | MFA window 15s to 40s. |
| F-15 | Frigate camera name corrected to `door_camera`. |
| F-16 | Opt-in presence corroboration; phones authoritative when configured. 9 template cases verified. |
| F-17 | Unexplained openings now push instead of only writing a persistent notification. |
| F-19 | Portal offline watchdog (5 min, latched) and startup state recovery added. |
| - | **Found during fixing, not in the original audit:** with the script printing nothing on failure, empty input through `float(0)` yields `0.0`, which reads as pitch dark and would switch the lamp **on** for every failed read. Blocked by the `availability` template. |
| - | Notify group replaces 10 hardcoded personal call sites. |
| - | Frigate RTSP credentials and camera IP moved to environment substitution. |

### 8.3 Deliberately still open

| # | Item | Why not fixed |
|---|---|---|
| F-04 | `input_text.last_doorbell_rfid_time` | Needs a Developer Tools to States export. If absent, this write aborts `guardian_authorize_passage` before GRANTED/welcome/lamp, so every doorbell-side entry loses its feedback. **Check this first.** |
| F-05 | `binary_sensor.doorbell_button` | Same. Expected `binary_sensor.smart_doorbell_doorbell_button`. Only affects `guest_bypass`, which is dead anyway. |
| F-07 | Tamper device side | **Neither ESPHome config fires `esphome.tamper_alert`.** No tamper sensor exists on either device. The HA half is now correct but cannot run. Implement device-side, or delete the automation - do not leave it as false assurance. |
| F-20 | Unsalted SHA-256 | See 8.4. |
| F-18 | Handle motion misclassifies forced entry as an exit | Correctly caught in elevated mode by the Elevated Opening Supervisor. In normal mode it produces a misleading "you forgot to scan" push. Fixing needs a design decision about `Forgetful Exit Warning` being suppressed in super surveillance mode, which makes the Supervisor load-bearing. |
| F-21 | ESP-reported values trusted | Requires HA access to exploit. Suggested fix: cross-check `handle_moved_recently` against `binary_sensor.<...>_handle_motion`, which arrives over the authenticated state channel rather than a free-form event payload. |
| F-22 | Handle baseline reset erases motion history for 2s after close | Narrow; self-healing via drift correction. |
| F-23 | Timers do not survive restart | Now partly mitigated by startup recovery. |
| - | `input_boolean.guest_bypass` | Still written and read by nothing. Left pending the F-05 answer, since both concern the same dead feature. |
| - | Portal static IP, gateway, subnet | Reverted to inline at the user's request, to avoid adding keys to `secrets.yaml`. Still exposes LAN topology. Before publishing, either move to `!secret` or drop `manual_ip:` and use a DHCP reservation, as the doorbell already does. |
| - | Doorbell fallback AP SSID | Same reason. Not sensitive; genericise before publishing. |
| - | `docs/*.docx` | ~~Not inspected~~ **RESOLVED (forty-third pass)** - inspected and clean, then deleted for size. Text is now in `INSTALL.md` §1. |

### 8.4 Salted hashing (F-20) - not applied, deliberately

Recommended, but **not** bundled into these batches. Three reasons:

1. **It requires re-enrollment.** Salting invalidates all stored hashes: all four
   cards must be re-enrolled and the PIN hash regenerated. That is a disruptive
   migration for a household of 4 and should be a deliberate, scheduled act, not
   a side effect of a bug-fix batch.

2. **A naive implementation would leak the salt.** `automations.yaml` and
   `scripts.yaml` are UI-managed - the screenshot confirms these automations are
   edited in the HA UI. HA rewrites those files on save and does not round-trip
   `!secret`, so a `!secret` there would be replaced by the literal salt on the
   next UI edit, committing it to the repo. Doing this safely means moving PIN
   verification into a package-defined script (packages are never rewritten by
   the UI) returning a response variable - a structural change to the
   security-critical path, which deserves its own review rather than riding along.

3. **Marginal value is genuinely low here.** Reading `input_text.portal_pin_hash`
   already requires HA access, and anyone with HA access can simply turn off
   `super_surveillance_mode`. Salting raises the cost of *offline* cracking after
   a leak - real, but defense-in-depth, not a live hole.

Worth doing before open-sourcing. It can be scoped as its own batch with the
migration steps on request.

### 8.5 Verification performed

Static and simulated only - **nothing was run against the live system or hardware.**

- All 7 config files parse; 22 automations structurally well-formed (checked
  after every batch).
- Luminance script executed against 9 generated fixtures covering grey levels, a
  simulated IR frame, corrupt, empty, and missing input.
- `availability` regex checked against 12 realistic stdout cases.
- MFA fail-counter simulated across 3 configurations by 6 rapid attempts.
- F-16 presence template rendered against 9 state combinations.
- All 9 `!secret` keys cross-checked by name against the live `secrets.yaml` key list. **Values never read.**
- Repo swept for personal identifiers, IPs, and plaintext credentials.

The one thing static analysis cannot confirm is whether `homeassistant.update_entity`
forces a refresh on a `command_line` sensor with `scan_interval: 86400` in your HA
version. If the lamp still does not respond after 8.1 is complete, check that
first: watch `sensor.guardian_camera_luminance` in Developer Tools while running
`script.guardian_sample_ambient_light` manually.

---

## 9. Second pass — presence drift, and the lamp that still did not work

Prompted by two reports from the live system: presence tracking coping badly with
four people who do not always scan, and the ambient-light lamp still not
switching after the batch-2 fixes.

### F-24 — `sample_marker` is a string; the lamp has **never** been switched by luminance — **BUG, critical**

`script.guardian_sample_ambient_light` captured its freshness marker as
`sample_marker: '{{ utcnow() }}'` and compared it against
`states.sensor.guardian_camera_luminance.last_reported`.

Home Assistant renders script variables to text and then `literal_eval`s them.
`str(datetime)` is `"2026-08-14 20:00:00.123456+00:00"`, which does not
`literal_eval`, so `sample_marker` stayed a **`str`**. The comparison was
therefore `datetime > str` — a `TypeError` on every run.

Consequences, in order: the wait template could never evaluate true → the 10 s
timeout always elapsed → `wait.completed` was `False` → `luminance_valid` was
`False` → the closing `choose` always fell into its `default` branch, which only
restores the lamp's previous state. **The lamp was never turned on or off by
measured luminance, on any run, since the sampler was written.**

This is the residue of F-09. That entry flagged this exact comparison as a
secondary risk and recommended eliminating the freshness check; the fix that
shipped changed `last_updated` → `last_reported` and `now()` → `utcnow()` and
left the type mismatch in place. `utcnow()` vs `now()` was never the problem.

**Fixed:** `sample_marker: '{{ as_timestamp(utcnow()) }}'`, compared against
`as_timestamp(states.sensor...last_reported, 0)`. `as_timestamp` renders as a
float literal, which `literal_eval` parses back to a float, so both sides are
numbers and the expression cannot raise.

**Lesson recorded:** a template that raises inside `wait_template` is
indistinguishable from one that is merely false. Anything comparing a script
variable against a live state object should compare numbers or strings, never
datetimes.

### F-25 — Failure of the sampler was structurally invisible — **HARDENING**

The `default` branch of that `choose` handled two completely different cases
identically: "the reading landed inside the hysteresis band, do nothing" and
"there is no usable reading at all". That is why F-24 survived a full audit and
months of running — the system's response to a totally broken measurement chain
was to quietly restore the lamp and report nothing, anywhere.

**Fixed:** the `default` branch now raises a self-replacing persistent
notification when `luminance_valid` is false, naming the three deployment causes
(`/config/www/guardian/` missing, `guardian-luminance.sh` not deployed, CRLF line
endings). A later good reading dismisses it.

### F-26 — Lamp sampling schedule covered a third of the day — **BUG**

`time_pattern` with `hours: /3` **and** `minutes: /10` is not "every three hours"
as the description claimed. It fires at :00,:10,…,:50 of hours 0,3,6,9,12,15,18,21
— 48 times a day, clustered into eight one-hour bursts, with nothing at all for
the other sixteen hours. At 22:20 the next sample was 00:00.

**Fixed:** `minutes: /10` with an adaptive condition — sample every 10 minutes
while the lamp is off (the blackout is invisible then, and dusk is caught within
10 minutes), every 30 minutes while it is on (limits the visible night-time dip
to twice an hour). The IR settle delay also drops from 5 s to 2 s when no IR
entity is configured, since nothing was switched and only the lamp transition has
to settle. `mode: single` → `queued` / `max: 2`, so a tick landing inside the
120 s startup delay is absorbed rather than dropped with a warning.

### F-27 — `Guardian Faults` reported the IMU as faulty when it is healthy — **BUG**

`is_state('binary_sensor...imu_healthy', 'on')` added an `IMU` fault — inverted
relative to every other clause in that template, which all flag the bad state. The
portal status strip therefore showed a permanent IMU fault on a perfectly healthy
portal, and would have stayed silent on a real one. **Fixed:** `'on'` → `'off'`.

### F-28 — Presence drifts permanently and nothing ever reconciles it — **BUG, design**

`input_select.rfid_N` was written in exactly two places: enrollment, and
`Guardian: Complete Authorized Passage` after a scan **and** a matching physical
opening. Nothing else. The reader a card was presented to — direct physical
evidence of which side of the door that card is on — was discarded.

So every missed scan stranded a card on the wrong side **permanently**. There was
no path back: an `Away` card scanned on the interior portal was accepted without
comment and stayed `Away`. In a four-person house missed scans are not an edge
case, they are the normal operating condition, and the errors only accumulate.

It also has a security consequence. The Frigate person-detected-while-away alert
falls back to an "all four cards Away" gate (F-16), so a single card stuck at
`At home` disables intrusion detection indefinitely — and stranding a card at
`At home` is exactly what forgetting to scan on the way out does.

**Fixed:** new `script.guardian_reconcile_presence`, called from
`process_rfid_scan` before any branch. A doorbell scan proves the card is
outside; an interior-portal scan proves it is inside. When the recorded state
contradicts that, it is corrected, `guardian.presence_corrected` is fired, and a
persistent notification is written — deliberately not a push, because
corrections are routine and pushing them would train the family to ignore
Guardian. Stolen/Lost cards and non-`At home`/`Away` states are never touched,
and the target option is checked against the helper's actual `options` before
writing, because these are UI helpers whose option lists this repo cannot see.

Reconciling at scan time rather than at window expiry is both simpler and
strictly more correct: the card is provably at the reader's side *before* any
crossing, so the rule is idempotent and holds whether or not an opening follows.

Enrollment had the same blind spot — it hardcoded `At home` even when enrolling a
card at the doorbell reader. Now sided from `source`.

### F-29 — A second scan overwrote the first; groups lost everyone but the last — **BUG**

`pending_entry_slot` / `pending_exit_slot` held a single slot id. Three people
leaving together with two of them scanning flipped only the last scanner's card;
the other was silently discarded and left stranded per F-28.

**Fixed:** both helpers now hold a comma-separated list (`max: 4` → `15`).
`guardian_authorize_passage` appends idempotently and restarts the timer, so a
late scanner extends the window for everyone already queued.
`Complete Authorized Passage` iterates with `repeat` / `for_each` and completes
all of them, skipping (with a `system_log` warning) rather than aborting the group
if a helper lacks the option. The existing list is inherited **only** while its
timer is genuinely `active`, so an expired or restart-restored value is never
appended to. With only four valid ids and a whitelist filter the stored value
cannot exceed `"1,2,3,4"` — 7 characters — so the helper limit is unreachable.

### F-30 — Each scan destroyed the opposite passage window — **BUG, false alarm**

`guardian_authorize_passage` cancelled the opposite timer and wiped the opposite
pending slot on every scan. Person A scans at the doorbell to come in; person B
inside scans to go out two seconds later; **A's entry window is gone.** A's
opening then falls through to the physics branches and is reported as
`key_entry_no_lever` ("keyed entry" push) or as `door_direction_unknown`
(high-priority "unexplained door opening" push) — and in elevated mode the
Elevated Opening Supervisor turns it into a siren. Two family members using the
door within twenty seconds of each other is not an unusual event.

**Fixed:** the windows are independent and may run concurrently.
`Guardian: Door Open Direction` gains a pair of leading branches for the
both-active case, disambiguating on the ESPHome `verdict` (which reports `inside`
only on a qualified lever rotation and `outside` only on a confirmed swing with
the lever at rest), then on lever corroboration, then on which window started
most recently. Ties resolve toward entry — a stale `At home` cannot suppress the
person-detection alarm once `guardian_presence_trackers` is populated, so it is
the safer failure. These branches emit their own `reason` values
(`both_windows_imu_verdict` / `_lever` / `_recency`), which keeps the two
consumers that filter on `reason` unaffected and makes the ambiguous cases
visible in the training log. Only the chosen direction's window is consumed; the
other keeps its remaining time.

### F-31 — Pending slots survive a restart; their timers do not — **BUG**

`pending_entry_slot` / `pending_exit_slot` are `input_text` and restore across a
restart. `timer.guardian_entry_window` / `_exit_window` are `restore: false` and
come back idle. `Guardian: Startup State Recovery` cleared only the MFA trio, so a
restored pending slot could sit there indefinitely — unable to expire (that needs
`timer.finished`) and unable to be consumed normally — and then flip the wrong
person on some later opening.

**Fixed:** startup recovery now cancels both passage timers and clears both
pending lists after its 30 s settle.

### 9.1 Also added

`Guardian: Data Log - Presence Corrected` writes one JSONL row per correction, so
how often scans are actually missed — and by whom — becomes measurable rather
than assumed. `Guardian Portal Countdown Label` gains a `PASSAGE` case, since with
concurrent windows it previously reported only `ENTRY`.

### 9.2 Verification performed

Static and simulated only — **nothing was run against the live system or hardware.**

- `automations.yaml`, `scripts.yaml` and `packages/guardian.yaml` parse; 30
  automations, all ids unique.
- The list-parsing idiom rendered against 13 inputs covering `none`, `unknown`,
  `unavailable`, empty, whitespace, duplicates, out-of-range ids and a full
  four-slot list. It never raises, and always yields a bounded whitelist.
- The both-windows tie-break ladder rendered across all 18 combinations of
  verdict × lever corroboration × window recency.

### 9.3 Unchanged, by decision

A scan in elevated mode still opens a 40 s PIN challenge, and an unanswered
challenge is still a full `guardian.major_alarm`. Reconciliation does not soften
that — it governs where a card *is*, not whether an opening was authorised.

`input_boolean.guest_bypass` (§8.3) is still written by one automation and read by
nothing.

---

## 10. Third pass — the lamp inverted, the PIN that could not be right, and a switch

Prompted by four reports from the live system: the lamp switching off at night
and wanting on during the day; the master PIN never being accepted, and the
system "hallucinating" — rejecting cards and reporting *password denied* — once
super surveillance was switched off; both ESP modules intermittently showing as
"State Unknown"; and Frigate clips no longer reaching the NAS since a network
switch was replaced.

Three of the four resolved to specific defects in this repo. The fourth resolved
to a mechanism outside it, documented in `DEPLOY.md` rather than fixed here.

Several findings below are regressions introduced by the previous two passes.
That is worth stating plainly: F-27 and F-25 were both "fixes" that made their
symptom worse or moved it, and the pattern in each case was the same — reasoning
about intent from an entity's *name* rather than checking the code that produces
it.

### F-32 — The stored PIN hash was never lowercased; the PIN could not be accepted — **BUG, critical**

`automations.yaml` computed `entered_hash` with the `sha256` filter, which emits
**lowercase** hex, and read `stored_hash` as
`states('input_text.portal_pin_hash') | string | trim` — trimmed, but never
lowercased.

`input_text.portal_pin_hash` is a hand-populated UI helper, and the tools people
reach for on Windows to produce a SHA-256 — `Get-FileHash`, `certutil -hashfile`,
most online calculators — emit **uppercase** hex. An uppercase digest is still
exactly 64 characters, so it sailed past the `stored_hash | length == 64` guard,
looked entirely correct in the helper, and could never match on any comparison.

Every attempt therefore fell to the failure branch. Three of them fired
`guardian.major_alarm` — a siren looping every three seconds and a high-priority
push to both phones — for entering the correct PIN three times.

**Fixed:** `| lower` on the stored side, and a new `script.guardian_set_pin`
which writes the helper using the *identical* expression the verifier uses, so
the two sides cannot drift apart again. `script.guardian_verify_pin` reports a
match without touching the fail counter, the display, or the alarm path, and
names the specific defect it finds — wrong length, or "only matches after
normalising".

**Lesson recorded:** a value that only a human ever writes needs either a
machine-written path or a normalising read. This had both halves missing at once.

### F-33 — The same defect in the RFID path, one card at a time — **BUG**

`scripts.yaml` compared `states('input_text.rfid_' ~ i ~ '_hash')` against
`uid_hash` with **no `string`, no `trim`, no `lower` and no length check** — the
PIN path at least trimmed.

Cards enrolled through enrollment mode were written by the same filter and
matched fine. Any slot filled in by hand did not, and the failure is per-slot: a
single trailing space in `rfid_3_hash`, trivially introduced by pasting from a
terminal, killed card 3 permanently while cards 1, 2 and 4 kept working. That is
"some cards are accepted and others are not", exactly as reported.

**Fixed:** stored values are now normalised identically to the entered value and
must be 64 characters to be compared at all. Verified against uppercase,
whitespace-padded, uppercase-plus-newline, and truncated stored hashes.

`empty_slot` had the mirror problem — it treated only `''`/`none`/`unknown`/
`unavailable` as free, so a slot holding whitespace or a truncated hash was
neither matchable nor enrollable and was permanently dead. It now treats anything
that is not a well-formed hash as empty.

### F-34 — A rejected card reported a password failure — **BUG, and the "hallucination"**

`input_text.portal_display_state` is a single untyped channel written by both
auth paths, and both wrote the literal string `DENIED`. The firmware could not
tell them apart, so its `DENIED` screen unconditionally rendered `DENIED` above
`N PIN tries left`, where `N` is `3 - input_number.mfa_failed_attempts`.

Present an unrecognised card in normal mode, with no PIN challenge anywhere in
sight, and the portal announced a **password** failure for a **card**, counting
down a counter belonging to an unrelated MFA session. With the counter latched
at 3 (F-35) it read "0 PIN tries left" with no challenge having ever occurred.

Note that `STOLEN` already had its own state and its own screen. `DENIED` should
have followed that pattern and did not.

**Fixed:** a distinct `DENIED_CARD` state rendering *"Card not recognised"*; the
PIN subtitle now additionally requires `portal_mfa_pending`, so even a stale
`DENIED` cannot borrow it.

### F-35 — `mfa_failed_attempts` latched across sessions — **BUG**

Enumerating every path that ends an MFA challenge, only three of eight reset the
counter: a correct PIN, reaching three, and Home Assistant starting. MFA timeout,
the Elevated Opening Supervisor, dismissing the alarm from a phone, a new scan
re-arming the challenge, and elevated mode simply ending all left it standing.

So the "3 tries" the portal promises were not per-challenge at all. One wrong
digit today, walk away, timer expires; tomorrow the *first* wrong keystroke hits
three and raises a major alarm on attempt one. It also corrupted the card screen
through F-34.

**Fixed:** zeroed at the start of every challenge and on every exit path.

### F-36 — Nothing triggered on super surveillance; leaving it stranded a challenge — **BUG, design**

`input_boolean.super_surveillance_mode` appeared in six places, all of them
`condition:`. **No automation anywhere triggered on it.** Switching it off ran no
cleanup whatsoever.

Worse, elevated mode was the disjunction
`super_surveillance_mode == on or now().hour < 5`, copy-pasted inline in four
places. That half self-activated at midnight and self-deactivated at 05:00 with
no state transition anywhere — so it could not be switched off, and nothing could
react to it ending.

Leaving elevated mode mid-challenge therefore left `portal_mfa_pending` on, both
pending helpers populated, the `MFA` screen showing, and the 40 s timer still
running. That timer then fired `Guardian: MFA Timeout`, which has no
elevated-mode condition, turning a deliberate mode change into a full
siren-and-push `guardian.major_alarm` in normal mode.

**Fixed:** `binary_sensor.guardian_elevated_mode` is now the single definition,
replacing all four inline copies. The night rule became an opt-in
`input_boolean.guardian_night_elevation` (**default off**) with configurable
start/end hours, wrap-around handled and verified across eight cases. A new
`Guardian: Elevated Mode Deactivated` triggers on the entity going `off` and
clears a live challenge silently.

**Lesson recorded:** an expression copy-pasted into four conditions is not a
mode. Making it an entity is what made it observable, disableable, and reactable
— the bug was structural, not arithmetic.

### F-37 — A bare `#` was a countable failed attempt — **BUG**

`matrix_keypad.on_key` fired `esphome.pin_entered` on `#` with no length guard,
so pressing `#` on an empty buffer sent an empty PIN. Home Assistant hashed the
empty string, failed the comparison, and **incremented the fail counter**. Three
stray presses by someone leaning on the panel raised a major alarm.

`current_pin` was also never cleared when a challenge started or ended — only by
`#` or the 45 s idle flush, which is deliberately longer than the 40 s window. So
digits typed into a challenge that ended early survived into the next one.

**Fixed:** submission requires 4–6 digits (matching what `guardian_set_pin` will
store and the 6-character buffer cap); a short `#` clears the buffer instead of
submitting; and the buffer is cleared whenever the display state is not `MFA`.

### F-38 — The lamp measured an IR-illuminated frame and switched off in the dark — **BUG, the reported inversion**

The decision logic was correct. The measurement was not, in both directions:

- With `guardian_camera_ir_entity` still `none` (an outstanding manual step from
  §8.1), night vision was never disabled and a dark scene measured ~146 luma —
  above the bright threshold of 90 — so **the darker it got, the more certain the
  system became that it should switch the lamp off.**
- The no-IR settle delay had been cut from 5 s to 2 s in §9 for cosmetic reasons.
  2 s is inside the C110's auto-exposure recovery window, so a daytime frame
  taken 2 s after blacking the bulb reads far darker than the scene is — below
  the dark threshold of 45. **The lamp wants to come on at noon.**

Both reported symptoms, one measurement chain.

**Fixed, and deliberately not by clamping.** Sun elevation is now consulted, but
merely refusing to act on a contradicted reading would have left an already-off
lamp off all night: a camera reporting 146 luma in the dark reports it on *every*
sample. A reading that contradicts the sky is not just untrustworthy — it is
evidence about *which way* it is wrong. So a "bright" reading below −6°
elevation switches the lamp **on**, and a "dark" reading above +10° switches it
**off**. Between −6° and +10° the camera decides alone, which is dusk and dawn,
and the entire reason for measuring rather than following a clock.

The settle delay went back up, to 4 s. Verified across 17 combinations of
validity × luma × sun elevation, including inverted thresholds.

### F-39 — A failed sample left the bulb dark with no way back — **BUG**

The sampler turns the lamp off as its first visible act and only restores it in
its closing `choose`. Any interruption in between — a restart, a snapshot that
hangs, the script being stopped — left the lamp off, with the only copy of its
previous state held in a script variable that died with the run.
`Guardian: Lamp Sampling Watchdog` cleared the stuck flag and walked away.

At night that is indistinguishable from "the lamp turned itself off", which is
what was reported.

**Fixed:** `input_text.guardian_lamp_presample` records the pre-blackout state
before the blackout; the watchdog reads it back, restores the lamp and says so.

### F-40 — The `LUMA` fault was permanent and self-inflicted — **BUG**

`sensor.guardian_faults` flagged `LUMA` when `sensor.guardian_camera_luminance`
was unavailable. But that sensor is *expected* to be unavailable almost always:
its `command_line` poll runs on `scan_interval: 86400` against an `ambient.jpg`
that is minutes old, trips the 60 s staleness guard added for F-10, and exits
non-zero. Outside the few seconds of an actual sample, unavailable is the correct
and intended state.

So the portal showed a permanent amber fault triangle, and the same
`is_number()` guard silently disabled `Guardian: Occupancy Simulation` — which
had therefore never run in surveillance mode.

**Fixed:** the fault is now keyed off the sampler's own recorded verdict, and
occupancy simulation is gated on sun elevation, which is available every second
of the day.

### F-41 — The IMU fault clause was inverted, again, in the other direction — **BUG, regression**

F-27 changed this clause from `'on'` to `'off'`, reasoning that every other
clause flags the bad state and an entity named `imu_healthy` must therefore be
`on` when healthy.

The firmware declares it `device_class: problem` with `return !(healthy)`. **`on`
means faulty.** The original `'on'` was correct; the fix inverted it, and the
portal has been reporting an IMU fault on a perfectly healthy portal ever since —
the exact symptom F-27 set out to remove.

**Fixed:** back to `'on'`, with the firmware's lambda quoted in the comment.

**Lesson recorded:** this is the second time this clause was changed based on
what the entity is called. `device_class: problem` inverts the meaning of `on`,
and the name `imu_healthy` actively fights that. Read the producer.

### F-42 — A lamp decision was invisible, so a wrong one could not be noticed — **HARDENING**

The single lamp notification fired only when the reading was *unusable*. A
reading that was valid but wrong — the 146 above — switched the lamp and reported
nothing, anywhere. This is the same structural blindness as F-25, one level up:
that fix made "no reading" visible and left "wrong reading" silent.

**Fixed:** `input_text.guardian_lamp_last_result` records every verdict with its
inputs (`22:20 luma=31.4 sun=-12.3 on_camera`), visible in the UI, in history and
on the portal's diagnostics page. An override raises a notification naming the
likely cause. Three consecutive failures escalate from a web badge to a push,
because a badge is exactly what went unread for months.

A rejected card was equally invisible — `guardian.unknown_card_scanned` was fired
and consumed by nothing, not even a data-log row. It now writes one, including
the computed hash, which is also how to diagnose a 7-byte-UID card that
enumerates inconsistently on the RC522 and hashes differently on every tap.

### F-43 — No way to reset, and nothing that self-healed — **HARDENING, requested**

No reset script existed. The most complete cleanup was bound to
`homeassistant.start`, and inside it the fail-counter reset was nested within
`if portal_mfa_pending == on` — so the state most likely to be stale was cleared
only in the case where it mattered least.

**Fixed:** `script.guardian_reset_auth` (state machine) and
`script.guardian_reset` (everything, plus a wedged `ALARM`, every Guardian
notification, and handing the lamp back to automatic control), exposed as
`input_button.guardian_reset`. Startup recovery now calls the former
unconditionally.

`Guardian: Auth State Watchdog` repairs two states the system cannot reach
legitimately and previously could not escape: pending with no timer behind it,
and an `MFA` screen with nothing pending. Both self-clear in two minutes.

**Deliberately Home Assistant-side only, not on the keypad.** Clearing a live
challenge from the wall panel is precisely what an intruder would want.

### F-44 — The doorbell was reachable only by mDNS — **BUG, and the switch story**

`doorbell-unit.yaml` had no `manual_ip` and no `use_address`, so Home Assistant
and the ESPHome dashboard resolved it as `doorbell-unit` over **mDNS**, which is
multicast. A managed switch with IGMP snooping enabled and no querier on the
segment prunes exactly that traffic.

This explains the asymmetry in the report — sometimes one module, sometimes both.
The portal has always had `use_address` set to a static LAN address and never needed name
resolution; the doorbell always did.

**Fixed:** `use_address: !secret doorbell_unit__ip`. A new secrets key, so the
build fails loudly until it is set — chosen over a placeholder because a silently
wrong address on hardware that is awkward to reach is far worse than a build
error.

Also fixed alongside: the portal had **no `power_save_mode`**, so it ran the
ESP32 default of `LIGHT` — modem sleep between DTIM beacons, and the most common
reason an ESPHome node flaps to unavailable. The doorbell has always set `none`,
with a comment explaining why; the portal, equally mains-powered and driving a
backlit display, was simply missed. It also had no `dns1` despite `manual_ip`,
leaving it with no resolver at all, and a bare `logger:` (DEBUG) pushing every
line to each connected API client.

### F-45 — The link indicator could stick on "connected" — **HARDENING, regression risk**

Commit `a4914b2` replaced a plain `api_connected` bool with a reference count,
correctly fixing a flicker when a second API client disconnected. But a count is
only right while *every* disconnect fires its handler: a socket that dies without
one leaves the count above zero permanently — i.e. permanently claiming
CONNECTED, rendering `SYSTEM ARMED` and a green dot off stale cached values.

That is strictly worse than the flicker it replaced, because the whole purpose of
the indicator is to distinguish "armed" from "I lost Home Assistant twenty
minutes ago".

**Fixed:** both units now expose `binary_sensor: platform: status`, and the
display reads ESPHome's own view rather than a hand-maintained shadow. The count
survives only to drive the status LED, where being wrong is cosmetic — and it now
goes red only when the *last* client disconnects, which it previously did not.

`Guardian: Portal Offline Watchdog` also stops inferring availability from the
door contact going `unavailable` and reads the status entity directly.

### 10.1 Also added

**Doorbell link status on the portal** (requested). Neither unit exposed any
status entity, and the only doorbell health signal anywhere was the `DOORBELL`
token in the fault strip, derived from its WiFi-signal sensor going unavailable —
a proxy with up to 30 s of lag that nothing alerted on. Now: a `status` sensor on
the device, `binary_sensor.guardian_doorbell_online` and
`sensor.guardian_doorbell_link` in Home Assistant, a labelled `DB` dot in the
portal's status strip (in the 43 px gap at x 53–95, the only unconditionally free
space in the strip), a detail line on the diagnostics page, and a
`Guardian: Doorbell Offline Watchdog` mirroring the portal's.

The dot is drawn **grey, not red, whenever the portal's own link is down**. The
value arrives from Home Assistant, so when Home Assistant is unreachable it is a
cached reading of unknown age; green would be a confident lie about the one thing
the indicator exists to report, and red would invent an outage.

`script.guardian_notification_selftest`. Every alert fans out through
`notify.guardian_alerts` and every call site sets `continue_on_error`, so a
broken group is silent everywhere — the likeliest reason no Guardian notification
had ever arrived. This one call deliberately omits `continue_on_error` and
distinguishes "the service raised" from "the service worked but no phone buzzed".

The four door-physics sensors published at 500 ms with no filters — eight state
messages per second, forever, over the same API connection the door events use,
all recorded. They exist only to be charted while tuning. They now use
`delta or heartbeat`, keeping full resolution on movement and dropping an idle
door to one message a minute.

The portal gained `Restart` and `Restart in Safe Mode` buttons, which it never
had — there was no way to reboot it short of pulling power or reflashing.

**F-05 resolved.** `Guardian: Guest Bypass Trigger` triggered on
`binary_sensor.doorbell_button`, which does not exist, so it could never fire.
The real id is `binary_sensor.smart_doorbell_doorbell_button`, derivable from the
doorbell's `friendly_name` and the sensor's `name`. Previously flagged as needing
a states export; it did not.

### 10.2 Verification performed

Static and simulated only — **nothing was run against the live system or
hardware.**

- All five Home Assistant YAML files and both ESPHome configs parse. 35
  automations, all ids unique; 14 scripts.
- Every `entity_id` referenced across `automations.yaml`, `scripts.yaml` and
  `packages/guardian.yaml` was cross-checked against what this repo defines, what
  the two ESPHome configs will create (slugs derived from `friendly_name` plus
  entity `name`), and the known set of UI helpers. One unresolved reference was
  found and fixed — F-05 above.
- Every `id(...)` referenced in a portal lambda resolves to a declared id, and no
  global is left written-but-never-read.
- The lamp decision ladder rendered across 17 cases: valid and invalid readings,
  camera agreeing and contradicting the sky, both hysteresis edges, twilight,
  missing sun entity, and inverted thresholds.
- Card matching rendered against clean, uppercase, whitespace-padded,
  uppercase-plus-newline, truncated and empty stored hashes; `empty_slot` against
  five occupancy patterns.
- `binary_sensor.guardian_elevated_mode` rendered across eight cases including a
  window wrapping midnight and a degenerate start == end.
- The presample stash round-tripped through its four parsing templates.
- The fault strip rendered healthy, doorbell-offline, and triple-fault.
- Every `guardian_lamp_last_result` line checked against the helper's 100-char
  limit.

### 10.3 Unchanged, by decision

The Frigate config. `record.continuous.days: 0` means only person-event
sub-segments are retained, which is deliberate — but worth confirming it still
matches intent, since it means the NAS will never hold continuous footage. The
clips-not-saving problem itself is host-side and is documented in `DEPLOY.md`.

Salted hashing (§8.4) is still not applied. `script.guardian_set_pin` makes the
migration materially cheaper, since the PIN side no longer needs hashing by hand.

`input_boolean.guest_bypass` is still read by nothing. Its trigger works now,
which is the smaller half of the problem.

---

## 11. Fourth pass — the card that enrolled but never confirmed, and a siren with no grace

Prompted by three reports from the live system: enrollment mode working but
offering no limits and no way to choose a slot once full; a card that, once
registered, produced *no confirmation on the screen at all* while unregistered
cards were still rejected normally; and super surveillance sirening the instant
the door opened.

The second of those looked like a card-matching bug and was not one. It is worth
recording why, because the same mechanism was silently degrading four other
screens.

### F-46 — A repeated display verdict was invisible; the screen cleared underneath it — **BUG, high**

`input_text.set_value` writing the value a helper **already holds** emits no
`state_changed` event. Two consumers depended on that event and neither had any
other trigger:

- `Guardian: Portal LED Mirror` (`mode: restart`), whose `GRANTED` branch drives
  the LED, waits three seconds, and then writes `IDLE`.
- The portal display lambda, which woke the backlight and reset the idle rotation
  on `st != id(ui_prev_state)`.

So a second identical verdict inside the first one's three-second window did not
re-trigger the mirror, did not repaint, and — the damaging part — did not cancel
the *earlier* run, which went on to drop the screen to `IDLE` underneath the
newer verdict it had never seen.

Enrolling a card writes `GRANTED` (`scripts.yaml`, enrollment branch). Scanning
that card immediately afterwards matches, calls `guardian_authorize_passage`, and
writes `GRANTED` again. That is precisely the swallowed case. The audio and the
lamp still fired, because those are unconditional `button.press` and script
calls — which is exactly why the report was "no confirmation **on the screen**"
rather than "the card is not recognised", and why an unknown card, which writes
the *different* string `DENIED_CARD`, was always rejected visibly. The asymmetry
in the report was the diagnosis.

Fixed by routing every verdict through `script.guardian_set_display`, which
writes the string and then increments `input_number.portal_display_seq`. The
mirror triggers on the counter; the portal compares the counter as well as the
string. The counter bump is deliberately the script's **last** step, so the
`mode: restart` cancellation it causes cannot interrupt the write it is
reporting. The portal additionally flashes a half-second accent bar under the
status strip on each verdict, because holding the screen for the full three
seconds fixes the correctness problem but a repeat still has to be *legible* to a
person as a new event.

Also latent in the same mechanism: two consecutive `DENIED` results, two
consecutive `DENIED_CARD` results, and a `CHALLENGE` re-assert would each have
been swallowed the same way.

### F-47 — A truncated card hash enrolled successfully and then never matched — **BUG, medium**

`input_text.set_value` truncates silently to the helper's `max`. The
`input_text.rfid_N_hash` helpers are hand-created in the UI and their maximum is
not guaranteed to be 64 — the same trap `DEPLOY.md` already documents for
`portal_pin_hash`. A truncated value is not 64 characters, so it can never match
*and* is not counted as occupied: the card reported `GRANTED`, was rejected
forever afterwards, and its slot was silently re-enrollable. At the door that is
indistinguishable from F-46.

Enrollment now reads the hash back and, on a mismatch, reports `DENIED`, pushes,
and posts a persistent notification naming the helper and the likely cause,
instead of claiming success.

### F-48 — Enrollment could not target a slot, and refused to work when full — **DESIGN, medium**

Allocation was first-free-wins with no way to choose, so re-enrolling one
person's card meant clearing that person's helper by hand in the Home Assistant
UI first, and with all four slots occupied the feature simply refused — the
person at the door was shown `DENIED / Card not recognised`, which is both untrue
(the card was never looked up) and unactionable, with the only explanation in a
persistent notification in the web UI.

Slots are now selectable from the portal keypad (`1`-`4`), the panel renders the
slot map and which slot the next card lands in, and the full case asks for a
choice rather than picking a victim. The system still never overwrites a slot on
its own.

Two related gaps closed at the same time: enrollment mode no longer disables
itself after one card — it is a session, ended by `#` on the keypad — and,
because that removes the accidental bound on how long it stays open, it now
expires after two minutes idle. While it is on, *any* unrecognised card presented
by *anyone* is written into a slot, so the expiry is not optional. An
already-registered card presented during a session now reports its slot instead
of silently opening a 20-second passage window.

### F-49 — Elevated mode alarmed on the reed edge, with no path to authenticate — **DESIGN, high**

`Guardian: Elevated Opening Supervisor` raised `guardian.major_alarm` directly
from `esphome.door_opened`, with no delay anywhere in the path, and actively
**tore down** any in-flight PIN challenge first. The PIN handler independently
refused a correct PIN whenever the door contact read `on`, and treated it as an
intrusion. The system was strictly scan-then-open; there was no representable
state in which someone could authenticate *after* entering.

The practical consequence is not a security property, it is that the family
switches the mode off. A forgotten scan at 2am produced a full siren and a
high-priority push to two phones.

Replaced with a bounded challenge. An opening with no completed passage window
now sets `input_boolean.guardian_entry_challenge`, starts
`timer.guardian_entry_challenge` (default 30s, configurable), shows
`AUTHENTICATE` with a countdown, holds the lamp amber, and repeats the existing
MFA tone every five seconds. Either proof clears it — a registered card at either
reader, or the master PIN. Timeout, three wrong PINs, or a stolen card raise the
full alarm.

Direction is decided from the same payload fields and the same corroboration rule
`Guardian: Door Open Direction` applies, including the F-21 check against the
authenticated ESPHome state channel, because the event payload is forgeable. The
supervisor deliberately still triggers on the raw `esphome.door_opened` rather
than the derived direction events: `Guardian: Complete Authorized Passage`
cancels the passage timers in response to those same events, so waiting for them
would race the window condition against the thing that clears it.

**One case still alarms instantly**: an opening from inside, corroborated by the
lever, with all four cards reading `Away`. Nobody should be in the house to open
it, and there is no one to offer a grace window to. "Believed empty" requires
every slot to *positively* read `Away` — a slot that is unknown, unavailable or
flagged stolen says nothing about occupancy, and treating silence as absence
would turn a missing helper into an instant siren. An `unknown` direction verdict
takes the challenge path, since an unanswered challenge still alarms: leniency
there costs a delay, never a detection.

`Guardian: Unscanned Key Entry` no longer raises its own alarm in elevated mode.
It fired on the same opening and would have started the siren instantly,
defeating the window; it now pushes at high priority instead, which is the half
of its old behaviour that had value — it reaches someone who is *not* at the door
and cannot see the countdown.

### F-50 — Card scans blocked on the lamp and were silently dropped — **BUG, critical**

Found by the live system immediately after the fourth pass shipped: enrollment
worked, and then the readers stopped responding entirely — no screen change, no
audio, and nothing in the ESPHome device log.

`process_rfid_scan` ended every verdict with `- action: script.guardian_lamp_success`
(or `_rejected`). `action:` **waits** for the called script to return, and
`guardian_lamp_feedback` is slow by construction: a 15 s `wait_template` on the
sampling flag, a `light.turn_on` against a cloud-connected Tapo bulb, a two
second hold, then a restore through `guardian_restore_lamp`. Two to three
seconds per scan on a healthy system, far longer whenever the bulb is slow or
`guardian_lamp_sampling` is stuck on.

`process_rfid_scan` is `mode: queued, max: 10`, as is its dispatcher
`Guardian: RFID Scanned`. Ten runs parked on the lamp fill the queue, and Home
Assistant then **drops every further scan** with nothing but a warning in its own
log.

This was latent for as long as the code existed and never fired, because a scan
was previously an isolated event — and enrollment, crucially, disabled itself
after a single card. F-48 deliberately made enrollment a session that stays open,
which is precisely the workload that presents cards one after another. The queue
fills within seconds of a normal enrollment session, and from that point the
reader appears dead.

Two things made it hard to see from outside:

- The RC522 component announces tags with `ESP_LOGD` and both devices run at
  `logger: level: INFO`, so a successful card read has **never** appeared in the
  device log. "The reader saw nothing" and "Home Assistant dropped the scan"
  were therefore the same observation.
- A dropped queued run produces no user-visible artifact at all.

Fixed by firing every lamp call with `script.turn_on` instead of `action:`, in
both `scripts.yaml` and `automations.yaml` — twelve call sites. Lamp feedback is
cosmetic and must never sit in the path of an access decision. `on_tag` and
`on_tag_removed` now log at INFO on both devices, so the reader and the Home
Assistant side can be told apart in one glance at the log.

The same defect was present in new code from this pass and had not yet been
observed: `Guardian: Elevated Opening Supervisor` called
`script.guardian_lamp_warning` with `action:`, and that script deliberately waits
on the challenge flag for up to five minutes. The supervisor would have parked
there for the entire challenge and the warning chirp loop that follows it would
never have run.

The general rule this establishes, and the reason it is recorded here rather than
just fixed: **`action: script.X` is a blocking call.** Anything on the path
between a card and a verdict must use `script.turn_on` unless the verdict
genuinely depends on the result.

### 11.1 Also added

- `Guardian: Data Log - Entry Challenge` records both ends of every challenge,
  and the door-opened row gained the effective elevated flag and all four
  presence values, so a challenge-or-alarm decision can be replayed offline. Ten
  challenges answered in the last two seconds means the window is too short.
- The auth watchdog, the startup recovery, `guardian_reset_auth`,
  `guardian_reset`, `Guardian: Elevated Mode Deactivated` and the phone dismiss
  action all clear the challenge. Its timer is `restore: false` and its expiry
  raises a major alarm, so a stranded challenge is worse than a stranded PIN
  challenge, not better.
- Startup recovery re-arms the enrollment idle timer, which does not survive a
  restart while the `input_boolean` does — otherwise a restart mid-session
  produced exactly the unbounded window the expiry exists to prevent.
- PIN entry keeps keypad priority over enrollment. An MFA challenge and an entry
  challenge are both time-limited and both end in an alarm if unanswered; letting
  a convenience feature swallow those digits would be a security bug, not a UI
  quirk.

### 11.2 Verification performed

Static and simulated only — **nothing was run against the live system or
hardware.** ESPHome was not available in this environment, so `esphome config`
must be run before flashing.

- All Home Assistant YAML files and both ESPHome configs parse; all automation
  ids remain unique; 17 scripts.
- `target_slot` rendered against chosen/unchosen and free/full combinations,
  including a whitespace-padded keypad choice.
- `house_empty` rendered all-Away and mixed.
- The templated challenge duration rendered at 10, 30, 90, 120 and a non-numeric
  value.
- Every remaining direct write to `input_text.portal_display_state` across
  `scripts.yaml` and `automations.yaml` was enumerated and converted; the
  survivors are reads and conditions only.

### 11.3 Deliberately not changed

Enrollment is still permitted while elevated mode is on. Turning it on is an
authenticated act in the Home Assistant UI, and blocking it there would surprise
more than it protects.

Salted hashing (§8.4, F-20) is still not applied.

The portal footer's mode label is still computed locally from
`input_boolean.super_surveillance_mode` plus a hardcoded `t.hour < 5`, so it can
still disagree with `binary_sensor.guardian_elevated_mode` and the configurable
night window. It is cosmetic, and out of scope for this pass.

---

## 12. Fifth pass — the enrollment screen that would not believe an empty slot

Prompted by a live report: enrollment mode on, hashes deleted from every slot,
and the portal still said all slots were full; enrollment mode off, the module
log showed every tap, and slot status did not change.

Two screens say "full", and they are not the same decision. The idle enrollment
paint in `esphome/portal-unit.yaml` reads `sensor.guardian_enrollment_target_slot`.
A tap that flashes `ENROLL_PICK` is `process_rfid_scan` itself, which reads
`input_text.rfid_N_hash` at that instant and does not consult those sensors.
Treating them as one bug is how a stale screen and a genuinely full helper
table become indistinguishable.

Presence (`input_select.rfid_N` At home/Away) is a third thing. An unknown card
is not supposed to move it. A matched card only self-corrects immediately if it
is already on the wrong side of the door; the passage commit still waits for a
matching opening inside the 20s window. "Module log + no slot change" is
therefore expected for an unenrolled card, a dropped scan, or a scan with no
door open — not evidence that the RC522 failed. The INFO `RFID tag read`
line only proves the tag reached firmware.

### F-51 — Occupancy templates did not subscribe to the hash helpers — **BUG, high**

`sensor.guardian_rfid_free_slots`, `sensor.guardian_rfid_slot_map` and
`sensor.guardian_enrollment_target_slot` built entity ids as
`'input_text.rfid_' ~ i ~ '_hash'`. Home Assistant's template listener
extractor only sees a complete quoted entity id in `states('…')`. Dynamic
concatenation matches nothing, so emptying a hash produced **no sensor
update**. The portal kept rendering `XXXX` / `none` / zero free slots until
an unrelated tracked entity changed or Home Assistant restarted.

`guardian_enrollment_target_slot` does literally mention
`input_text.guardian_enrollment_slot`, but turning enrollment on writes that
helper to `''`; if it was already empty there is no state change, so even
opening a session would not recompute the map.

`process_rfid_scan` was unaffected — it evaluates the helpers at tap time —
which is why a card presented against that lying screen could still have
enrolled, and why the report sounded like "the matcher is broken" when the
matcher had not been asked. The first version of this screen, when target was
empty, announced ALL SLOTS FULL; that was already replaced with PRESENT CARD
/ slot data not received for *missing* data. Stale *wrong* data is worse: it
is a confident false statement about the user's cards.

**Fixed:** each occupancy template now names `input_text.rfid_1_hash` …
`rfid_4_hash` as four literal `states()` calls, same 64-character rule. The
screen and the script still compute independently so two cards in a row cannot
race a template; they just listen to the same helpers. Requires a **full
Home Assistant restart** — packages are not merged on reload.

### F-52 — There was no machine path to clear a hash — **DESIGN, medium**

Enrollment writes `input_text.rfid_N_hash` through `input_text.set_value`.
Nothing in the other direction existed. `script.guardian_reset` leaves hashes
alone, which is correct for a recovery that must not wipe the household's
cards. The documented recovery for a full house is keypad `1`–`4` to
overwrite; the documented recovery for an empty house was "edit the helper".

Developer Tools → States **Set State** is the trap that looks like that edit.
It changes the current state machine value and does not persist through the
helper's stored value. The field looks empty, occupancy (if it were listening)
would look free, and the next restart or real write puts the hash back.
Password-mode `input_text` helpers also look blank while still holding 64
characters.

**Fixed:** `script.guardian_clear_rfid_slot` writes `''` via
`input_text.set_value` for slot `1`–`4` or `all`, reads the lengths back, and
reports a slot that is still 64 characters (helper `min` above 0, or the write
rejected). Presence is not touched.

The `guardian_enrollment_full` notification now always prints live helper
lengths next to the three portal sensors, and names `empty_slot` /
`target_slot` / the keypad helper. That is the discriminant for the next
report: four `64ch` means the script is correctly refusing; sensors saying
full against `0ch` helpers means F-51 is back or not deployed.

### 12.1 Queue audit (F-50)

`process_rfid_scan` lamp calls are still `script.turn_on`. Remaining
`action: script.*` sites are `guardian_set_display`,
`guardian_reconcile_presence`, `guardian_authorize_passage` and
`guardian_clear_entry_challenge` — helper writes and events, no delay, no
lamp wait. They stay as `action:` because the next branch depends on their
result. `max: 10` was not raised. If a live install still drops scans, the HA
log `already running` / queue-full warning is the evidence; do not assume this
class of bug from an ESPHome tag-read line alone. Verbose
`Guardian: RFID Scan Debug` fires on the **event**, and the in-script
`guardian_scan_trace_*` note fires inside `process_rfid_scan` — one without
the other is a dropped script, not a dead reader.

### 12.2 Deliberately not changed

Hash algorithm, UID normalisation, and the occupancy rule (64 characters after
trim/lower). Auto-overwriting slot 1 when full. Treating `input_select.rfid_N`
as occupancy. Portal firmware — the idle screen already distinguishes missing
sensor data from `target == none`; it will render correctly once the sensors
tell the truth.

Salted hashing (§8.4, F-20) is still not applied.

### 12.3 Verification performed

Static only — **nothing was run against the live system or hardware.**

- `packages/guardian.yaml` and `scripts.yaml` parse; 18 scripts;
  `script.guardian_clear_rfid_slot` is present; `guardian_clear_rfid_slot` is
  on the `guardian_reset` dismiss list.
- Occupancy templates contain four literal `states('input_text.rfid_N_hash')`
  calls each, plus `input_text.guardian_enrollment_slot` on the target sensor.

Live checks are `DEPLOY.md` fifth-pass items 27–32. Item 32 is the
maximum-context pack if the helpers and the screen still disagree after a
full restart.

### F-53 — Slot `"1"` was stored as integer `1`, so enrollment never wrote — **BUG, critical**

Live traces after F-51/F-52: occupancy sensors were correct (`free=4`,
`map=----`, helper lengths `0ch`), the event reached Home Assistant, and
`process_rfid_scan` ran. The trace printed `empty_slot: '1'` and
`target_slot: '1'` (and, on one tap, keypad `'2'` / `target_slot: '2'`) and
then took **`ENROLL_PICK (no target slot)`**. The hashes stayed empty, so
the next scan with enrollment off was a correct `DENIED_CARD`.

Home Assistant coerces a script (or automation) variable whose rendered
value is only digits into an `int`. The enrollment write condition was
`target_slot in ['1', '2', '3', '4']`. In Jinja, `1 in ['1', '2', '3', '4']`
is false. The title template used the same test, which is why it named
ENROLL_PICK while printing a target of 1. Matched-card branches happened
to use `matched_slot | trim`, which stringifies, so this would have looked
like "enrollment is broken, recognition is fine" if any hashes had existed.

**Fixed:** every slot membership test in `process_rfid_scan`,
`guardian_authorize_passage`, `guardian_reconcile_presence`,
`guardian_clear_rfid_slot`, and the master PIN passage choose now uses
`| string | trim` before comparing to `['1', '2', '3', '4']`. Pending-slot
list appends stringify too, so `1` and `"1"` cannot both sit in the window
list. Reload scripts and automations; packages are unchanged.

---

## 13. Seventh pass — the downstairs window that looked like daylight

Prompted by two C110 stills of the frame the sampler actually reads: a night
card (`2026-08-14 22:20`) that is almost black except one warm rectangle, and
a day card (`2026-08-19 17:06`) that shows why that rectangle exists.

### F-54 — A downstairs window pulled a whole-frame mean into the hold band — **BUG**

`guardian-luminance.sh` printed the mean luma of the entire drafted frame.
The night still has a lit window through the stair opening at roughly
x=52–63%, y=13–33% (about 3–5% of the frame, luma near 255). The door,
approach, and RFID plinth are in the dark remainder (luma ~0–15).

A 4% patch at ~255 on a floor of ~8 pulls a mean to ~18. A grainier night
floor (~40) lands near ~50, which is **inside** `guardian_dark_threshold` (45)
and `guardian_bright_threshold` (90). The sampler's `hold` branch restores
the previous lamp state. A lamp that is already off at dusk therefore stays
off all night. `on_sun_override` never fires: that path needs luma ≥ 90.

By day the same stair opening is ~15–20% of the frame. Discarding only the
brightest 10% of pixels would not remove it. A whole-frame 25th percentile
would also be wrong in the other direction: the left soffit is ~20% of the
frame and stays dark at noon, so p25 of the full frame can look like night
in daylight and spam `off_sun_override`.

**Fixed:** crop the bottom 60% (`y ≥ 0.40`), which excludes the night window
(`y ≤ 0.33`) and most of the stair void, and take the 25th percentile of
ITU-R 601-2 luma inside that crop. Fail-closed contract unchanged (no
stdout, non-zero exit, 60s mtime guard, `availability` regex). Thresholds
left at 45/90: the 45-point gap already stops flapping, and this statistic
is more stable than a mean. Historical `luma=` values in
`guardian_lamp_last_result` are not comparable.

### F-55 — A valid in-band reading could hold the lamp in the wrong state indefinitely — **BUG**

F-38's sun clamp is immediate and threshold-crossing: luma ≥ 90 at
elevation < −6 forces the lamp on (`on_sun_override`); luma ≤ 45 at
elevation > +10 forces it off. A reading that stays in 45–90 is `hold`.
That is exactly the downstairs-window mean, and also any persistent light
that fools a "valid" number without crossing 90. Missing/stale readings
already fall through to `on_sun` / `off_sun`; this hole is the valid-but-
wrong case those paths do not cover.

**Fixed:** `input_text.guardian_lamp_mismatch_since` records when
`light.tapo_lamp` first disagreed with the sun-expected state (elevation
< −6 → on, > +10 → off). After
`input_number.guardian_lamp_mismatch_max_minutes` (default 30, same bound
both ways) `script.guardian_apply_lamp_sun_mismatch` forces 4000 K / 45% or
off and writes `on_mismatch` / `off_mismatch`. Twilight (−6 to +10) and a
missing `sun.sun` have no expected state and **clear** the clock — F-38 left
that band to the camera on purpose; accumulating through dusk would force
the instant night begins.

The script is the single implementation, called from two places:

1. The end of `guardian_sample_ambient_light`, after the choose and after
   clearing `guardian_lamp_presample`. Hold cannot win the same run, and the
   watchdog cannot restore a pre-force blackout.
2. `Guardian: Lamp Sun-Mismatch Fallback`, `time_pattern` minutes `/10`
   seconds `30`, so it does not share Camera-Based Lamp Control's `:00`
   tick. A dead sampler therefore cannot stick the lamp.

It does not fire while `guardian_lamp_sampling` is on (except the sample-end
call, which passes `from_sampler`), while `guardian_lamp_feedback` is
running, or while the display is `ALARM` / `CHALLENGE` / `MFA`. A `for:`-on-
lamp-state trigger was rejected: the sampler's 5 s blackout every 30 minutes
while the lamp is on would reset an "on too long" clock forever. It does not
increment `guardian_lamp_fail_streak`. `guardian_reset` clears
`mismatch_since` and dismisses `guardian_lamp_mismatch_timeout`.

### 13.1 Also unchanged, by decision

Adaptive 10/30-minute sampling cadence — that is about the visible blackout,
not energy. Occupancy simulation. ESPHome. `packages/forgegraph-command.txt`.

### 13.2 Verification performed

Static only — **nothing was run against the live system or hardware.**

- Crop + p25 chosen against the two C110 stills; screenshot pixels were not
  used as absolute luma (UI chrome, compression). Live noon/night
  `last_result` pairs are DEPLOY.md items 38 and 40.
- Fail-closed exits 1/2/3/10/11/12/13 still print nothing.
- Decision ladder unchanged; `on_mismatch` / `off_mismatch` are applied
  after the choose.
- `guardian_lamp_last_result` lines with `on_mismatch` / `off_mismatch`
  checked against the helper's 100-character limit.

Live checks are `DEPLOY.md` seventh-pass items 38–43.

---

## 14. Eighth pass — auto-calibrate without replacing this home's path

Prompted by the need for the Tapo door-lamp to stay readable at night in any
home, not only the landing whose downstairs window produced F-54. Energy cost
is irrelevant; the lamp must still track real day/night and must never fail
to come on when it is actually dark.

### F-56 — The 60 % / p25 geometry is this landing, not a portable signal — **HARDENING**

Seventh-pass `guardian-luminance.sh` crops `y ≥ 0.40` and reports p25 because
that is where *this* C110's door, approach, and RFID plinth sit, and because
a lit downstairs window at roughly x=52–63 %, y=13–33 % pulled a whole-frame
mean into the 45–90 hold band. That geometry is correct here and must remain
a first-class option. It is not universal: a different tilt, a soffit that
fills the bottom of the frame, or a window that sits in the lower 60 % would
need another hand-tuned crop. Changing the script under this house to chase
a second framing would silently retune a path that is already working.

**Added:** `input_select.guardian_lamp_luma_mode`, default **Manual (this
home)**. Manual is exactly today's crop, statistic, and
`input_number.guardian_dark_threshold` / `guardian_bright_threshold` (45/90).
The calibrator never writes those helpers. Switching the select back restores
the previous behaviour on the next sample; learned files stay on disk.

**Auto-calibrate** learns three things from the existing lamp-off / IR-off
snapshot, not from a second house visit:

1. A 16×9 tile mask. Tiles that are bright at night (windows, IR leftover,
   stair voids), dark at noon (soffits), or that barely change are ignored.
   Per-tile **medians** across many samples drop headlights and specular hits.
2. Pixel p25 over the remaining tiles — F-54's statistic, without assuming
   this landing's 60 % crop.
3. A hysteresis band from the night and day distributions of that statistic,
   biased so almost all lamp-off night samples sit below `dark`.

Until sanity checks pass (≥8 night and ≥8 day samples, each class spanning
≥3 hours, ≥16 relevant tiles, day typical − night typical ≥30), Auto does
not apply camera thresholds. The sampler uses `on_sun` / `off_sun` / twilight
`hold`. F-38's immediate clamp and F-55's mismatch clock remain behind that,
so a random framing cannot invent daylight at night. A valid reading during
learning does not increment `guardian_lamp_fail_streak`.

The probe still prints one float or nothing (F-10 availability regex
unchanged). Mode is passed via `/config/guardian/luma-run.env` because the
`command_line` command cannot read the select. Samples append to jsonl
**after** stdout is flushed; retune is `script.turn_on` of
`script.guardian_lamp_cal_retune` after `guardian_lamp_sampling` is cleared,
so it cannot extend the 60 s watchdog, fight presample restore (F-39), or
run inside the 15 s `command_timeout`. Learned dark/bright live on
`sensor.guardian_lamp_cal` (cats `luma-cal.txt`), not on the Manual helpers.
`guardian_lamp_last_result` gains `manual` / `learn` / `auto` (F-42).
`guardian_reset` dismisses `guardian_lamp_cal_ready` and does **not** delete
the profile.

### 14.1 Also unchanged, by decision

Mismatch fallback, alarm-red pin, challenge/MFA amber, IR-off-before-sample,
`as_timestamp` freshness, occupancy simulation, ESPHome,
`packages/forgegraph-command.txt`. No `script.guardian_lamp_cal_forget` —
wipe the host json/jsonl by hand if a bumped camera should start over.

### 14.2 Verification performed

Static only — **nothing was run against the live system or hardware.**

- Manual branch of `guardian-luminance.sh` is the seventh-pass crop + p25
  isolated as `luma_manual()`. Fail-closed exits 1/2/3/10/11/12/13 still
  print nothing.
- Auto cold-start skips `on_camera` / `off_camera` / sun-override threshold
  crossings.
- `last_result` suffix checked against the helper's 100-character limit.

Live checks are `DEPLOY.md` eighth-pass items 44–49.

---

## 15. Ninth pass — configurable RFID slots and visitor policy

The slot count was the literal `4`, copied independently into occupancy
templates, `range(1, 5)` loops, `['1','2','3','4']` whitelists, and a C++
display/keypad bound. Each slot was an anonymous UI helper triplet (hash +
presence, no name, no role). Growing the rack meant touching every
automation, and a family-member key that should never count as home had
nowhere to live.

**Fixed:** `packages/guardian_rfid.yaml` declares the hash, presence, and
policy helpers, plus `sensor.guardian_rfid_slots` (`1,2,3,4`) as the runtime
whitelist. Occupancy sensors (`free_slots`, `slot_map`,
`enrollment_target_slot`, presence summary) are trigger-based so they can
loop; the trigger `entity_id` list is the remaining unroll, sitting next to
the helper declarations. Scripts and automations read the whitelist instead
of a literal four. Cap is 9. Pending-slot helpers grew to max 32.

Policy is `resident` (default) or `visitor`. Visitors still authorize
passage, MFA, and entry challenges. `guardian_reconcile_presence` never
writes At home for them and forces Away if they somehow are. Complete
Authorized Passage still consumes their window (so a guest walk-through is
not unexplained) but skips the At-home write. Enrollment writes visitor +
Away when `input_boolean.guardian_enroll_as_visitor` is on; tapping an
already-registered card in that session updates policy without rewriting
the hash. Keypad 0 toggles the flag (`esphome.enrollment_guest_toggled`).
`house_empty`, Frigate's all-away gate, and the portal roster count
resident slots only.

ESPHome follows `sensor.guardian_rfid_slot_map.length()` for the keypad
range and the box row, so after one flash the firmware is count-agnostic.
The WiFi-bar loop at ~1593 is unrelated (four RSSI bars, not RFID).

**Migration:** the live UI helpers collide with the YAML entity ids. Dump
hashes, delete the UI helpers, copy the package, full restart, restore
hashes. See `DEPLOY.md` ninth pass. Historical F-51 (extractor) is why the
occupancy sensors stayed trigger-based rather than going back to a Jinja
`~ i ~` loop.

Grow later: three edits in `packages/guardian_rfid.yaml` (helper triple,
trigger line, whitelist string), then restart.

Live checks are `DEPLOY.md` ninth-pass items 50–56.

---

## 16. Tenth pass — keypad PIN change

The only way to rotate the master PIN was `script.guardian_set_pin` from
Developer Tools → Actions, with the plaintext typed into a form field. A
household member at the door had no path, and anyone with HA UI access
could rotate the credential without ever standing at the portal.

**Fixed:** `input_boolean.guardian_pin_change_mode` (off by default) arms a
keypad session modeled on enrollment. Turning the toggle **on does not
change the PIN.** The portal asks for the current PIN (`#` to confirm), then
a new 4–6 digit PIN (`#` to finish), and only then calls
`script.guardian_set_pin`. There is no re-type step and no password helper
on the dashboard. HA-only access cannot rotate the PIN; physical-only
access cannot enter the flow.

Compare is `script.guardian_pin_matches` (`trim` / `sha256` vs stored
`trim | lower`, matches only if the stored value is 64 characters).
`guardian_verify_pin` and the Master PIN Entry Handler now call it instead
of carrying a second copy of that expression (F-32/F-33).
`guardian_set_pin`'s write is unchanged (`clean | sha256`). Plaintext never
lands in a helper.

Wrong current PIN is mode-dependent. Outside elevated mode it is mild:
`DENIED`, a denied tone, `input_number.guardian_pin_change_fails`, three
tries then the mode drops. It does not touch `mfa_failed_attempts` and does
not fire `guardian.major_alarm`. While `binary_sensor.guardian_elevated_mode`
is on, the same miss increments `mfa_failed_attempts` and the existing
3-strike path fires `guardian.major_alarm` with `Maximum PIN attempts
exceeded`. Timeout and a short `#` abort with no change and no strike, even
when elevated.

Keypad priority extends the enrollment gate: MFA or entry challenge, then
PIN-change, then enrollment, then the idle PIN buffer. A short `#` during
PIN-change fires `esphome.pin_change_cancel`. Firmware keeps `current_pin`
for `MFA`, `CHALLENGE`, and `PIN_CHANGE_*` (F-37 had only `MFA`, which also
wiped challenge digits every second).

Restart: the boolean restores, the 40 s timer does not. `guardian_reset_auth`
clears the mode; Startup State Recovery notifies; the auth watchdog repairs
a restored flag with no timer.

Data log: `Guardian: Data Log - PIN Change` writes timestamp and outcome
(`success` / `failed_mild` / `abandoned` / `escalated`) only.

### 16.1 Deliberately unchanged

RFID enrollment writes, MFA/entry-challenge success and timeout paths
(aside from calling the shared match script), `guardian_set_pin` hashing,
salted hashing still not applied. Enrollment still has no PIN-change
equivalent of "stay open for several cards" — a successful change ends the
session.

### 16.2 Verification performed

Static only — **nothing was run against the live system or hardware.**
Jinja `sha256` is SHA-256 hex of the UTF-8 string, same as Python
`hashlib.sha256`.

- Match: pin `1234` →
  `03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4`
  (64 chars). `matches` is true when stored is that digest after
  `trim | lower`.
- Uppercase stored (F-32): stored
  `03AC6742…C846F4` lowercases to the same digest; `matches` true.
- Mismatch: `1234` vs hash of `5678` → `matches` false.
- Empty / short stored: length ≠ 64 → `matches` false, mode start
  reverts the toggle (step 1 could never succeed).
- Bounds: `^[0-9]{4,6}$` rejects `123` and `1234567`, accepts `1234` and
  `123456`. Firmware will not submit shorter than 4.
- Mild vs elevated: not-elevated miss writes only
  `guardian_pin_change_fails`; third miss logs `failed_mild` and turns
  the mode off. Elevated miss writes `mfa_failed_attempts`; third miss
  fires `guardian.major_alarm` and logs `escalated`. An invalid new PIN
  (wrong length) returns to NEW and writes neither counter.
- Mutex: pin-change-on while enrollment is on turns pin-change back off
  before the 40 s timer starts; the reverse refuses enrollment. Toggle-on
  does not call `guardian_set_pin`.

Live checks are `DEPLOY.md` tenth-pass items 57–63.

---

## 17. Eleventh pass — the control panel, and classifying every entity by who may write it

No behavioural change. Nothing in `automations.yaml`, `scripts.yaml`,
`packages/guardian.yaml` or `packages/guardian_rfid.yaml` was touched this
pass, no helper was added, and no ESPHome device was reflashed. What was added
is a second UI layer — a Home Assistant custom panel at
`www/guardian-ui/guardian-panel.js`, registered by a `panel_custom:` block in
`configuration.yaml`. Design rationale is in `GUARDIAN_UI.md`; deployment is
`DEPLOY.md`'s eleventh pass.

The audit-relevant part is not the panel. It is the classification the panel
forced, which had never been written down: **which entities are status, which
are safe for a household member to write, and which belong to the state
machine and must not be exposed for direct editing at all.**

Until now that distinction existed only as tribal knowledge. Home Assistant's
auto-generated dashboard renders `input_number.guardian_dark_threshold` and
`input_text.pending_exit_slot` as the same kind of editable box, and the second
one is load-bearing: `Complete Authorized Passage` reads it to decide whether
presence changes, and F-02 is the record of what happens when it is wrong.

### 17.1 Classification

**Class A — read-only status.** Published by the system, never written by a
person. Anything that writes these is either the state machine or a bug.

`sensor.guardian_faults`, `sensor.guardian_presence_summary`,
`sensor.guardian_rfid_slots`, `sensor.guardian_rfid_free_slots`,
`sensor.guardian_rfid_slot_map`, `sensor.guardian_enrollment_target_slot`,
`sensor.guardian_ss_programs`,
`sensor.guardian_portal_countdown_ends` / `_total` / `_label`,
`sensor.guardian_doorbell_link`, `sensor.guardian_camera_luminance`,
`sensor.guardian_lamp_cal`, `binary_sensor.guardian_elevated_mode`,
`binary_sensor.guardian_doorbell_online`, every ESPHome-published entity on
both devices, and every `timer.*` state.

**Class B — safe user-facing controls.** A household member changing one of
these changes an intended setting, and a wrong value is recoverable by
changing it back.

`input_boolean.super_surveillance_mode`,
`guardian_ss_N_enabled`, `guardian_ss_N_mon` … `_sun`,
`guardian_enrollment_mode`, `guardian_enroll_as_visitor`,
`guardian_pin_change_mode` (as a *mode*, see class D),
`guardian_verbose_notifications`; `input_select.rfid_N`,
`input_select.rfid_N_policy`, `input_select.guardian_lamp_luma_mode`;
`input_number.guardian_dark_threshold`, `guardian_bright_threshold`,
`guardian_lamp_mismatch_max_minutes`, `guardian_entry_challenge_seconds`,
`guardian_ss_N_start` / `_end`; `input_text.guardian_ss_N_name`,
`input_text.guardian_camera_entity`,
`guardian_camera_ir_entity`, `guardian_frigate_camera_name`,
`guardian_presence_trackers`; `input_button.guardian_reset`;
`light.tapo_lamp`; the portal's `number.*` tuning entities.

**Class C — internal state. Never expose for direct editing.** Written only by
automations and scripts, read as evidence, and consistent only as a set. A hand
edit to any one of them desynchronises it from the timer, boolean or counter it
travels with — which is the F-19 / F-31 / F-36 failure shape, arrived at from
the UI instead of from a restart.

`input_text.pending_entry_slot`, `pending_exit_slot`, `pending_mfa_slot`,
`pending_mfa_source`, `portal_display_state`, `guardian_challenge_origin`,
`guardian_pin_change_step`, `guardian_alarm_reason`,
`guardian_last_door_summary`, `guardian_lamp_presample`,
`guardian_lamp_mismatch_since`, `guardian_lamp_last_result`,
`guardian_enrollment_slot` (see the exception below);
`input_number.portal_display_seq`, `mfa_failed_attempts`,
`guardian_pin_change_fails`, `guardian_lamp_fail_streak`;
`input_boolean.portal_mfa_pending`, `guardian_entry_challenge`,
`guardian_lamp_sampling`, `guardian_portal_offline_notified`,
`guardian_doorbell_offline_notified`, `guest_bypass`.

The panel renders every class C entity read-only under System → Internals, with
a tap-through to Home Assistant's own more-info dialog. The escape hatch is
deliberate: the claim is "not here", not "nowhere".

**One documented exception.** `input_text.guardian_enrollment_slot` is class C
by provenance — the keypad writes it via `Guardian: Enrollment Slot Selected` —
but it is the only way to target a slot when the rack is full, and requiring
someone to walk to the door to press a digit while already holding the phone
that armed enrollment is friction with no security value. The panel writes it,
and only while enrollment mode is on. It does **not** restart
`timer.guardian_enrollment_window` as a side effect, which the keypad path
does; that is offered as an explicit "Keep open" button instead, so the idle
expiry is never silently extended by a UI that happens to be left open.

**Class D — never exposed, in any form.**

`input_text.portal_pin_hash` and `input_text.rfid_N_hash`. Read for **length
only** (64 after `trim | lower` means occupied — the same rule
`packages/guardian_rfid.yaml` uses); the values are never rendered. F-20 stands:
the digests are unsalted, so a rendered card hash is a card-cloning oracle for
anyone who can read the screen or the page source.

`script.guardian_set_pin` and `script.guardian_verify_pin` take a PIN as an
argument and therefore have no call site in the panel. They stay in Developer
Tools, where the argument is visibly a PIN being typed into Home Assistant,
rather than being dressed up as an ordinary settings field. This preserves the
tenth-pass boundary exactly: PIN-change is armed from the UI as a mode and
completed at the keypad, and the PIN never transits the frontend.

### 17.2 A new finding, from writing the history view

**F-57 — the data log is unreadable by anything except a human on the host —
DESIGN, accepted.**

The five `Guardian: Data Log - *` automations write JSON lines to
`/config/guardian_data_log.jsonl` through the File notify integration. That
file is the only record of the events that are *not* entity states: rejected
cards with their computed hash, door-direction verdicts, presence corrections,
Frigate detections, PIN-change outcomes. The recorder has no equivalent —
custom events are not logbook entries — so those categories have no history any
frontend can read back.

The obvious fix, moving the log under `/config/www` so a browser can fetch it,
is **wrong and must not be done.** `/local` is served without authentication.
Anyone who can reach the Home Assistant host could then read `card_rejected`
rows, which carry the SHA-256 the reader computed. Against unsalted hashing
(F-20) that is a direct card-cloning oracle, and a considerably worse
regression than the gap it closes.

Accepted as-is. The panel's Activity view reconstructs everything that *is* an
entity state from the recorder, and subscribes to the event bus for the rest —
so those rows exist live, from the moment the panel is opened, and not before.
Closing the gap properly would need a trigger-based template sensor holding the
last N events as an attribute list, which is new logic and out of scope for a
pass whose premise is that it adds none. Recorded here so the next person does
not rediscover it and reach for the `/config/www` shortcut.

### 17.3 Deliberately unchanged

- **No new template sensor.** `sensor.guardian_portal_countdown_ends` /
  `_total` / `_label` already existed for the portal display and turned out to
  be exactly what a progress ring needs; the panel reuses them rather than
  publishing a second projection that could disagree with the screen at the
  door.
- **No alarm-dismissal script.** Silencing from the panel calls
  `script.guardian_reset`, which is what that script's own description
  sanctions ("the only path out of a wedged alarm other than the phone
  notification action"). A narrower dismiss-only script would be a third path
  with its own drift risk — the `Dismiss Alarm from Phone` automation already
  had to be patched once for failing to zero `mfa_failed_attempts`.
- **`input_button.guardian_reset` is not pressed by the panel.** It calls
  `script.guardian_reset` directly. The button exists so a reset is reachable
  from a stock dashboard; its automation carries a 30-second timestamp guard
  precisely because an `input_button` state restores across a restart. Going
  straight to the script skips a guard that only exists to compensate for the
  button.
- **`guest_bypass` still does nothing.** It appears in the panel's Internals
  list labelled as such, so the next person reads "unused" rather than assuming
  guests are handled.

### 17.4 Verification performed

Static, plus a simulated Home Assistant state machine — **nothing was run
against the live system or hardware.**

- Every entity id in the panel's registry (93) was cross-checked against
  `automations.yaml`, `scripts.yaml` and `packages/*.yaml` and, for the 18
  device-derived ids that appear in no Home Assistant YAML, against the `name:`
  and `friendly_name:` slugs in `esphome/portal-unit.yaml` and
  `esphome/doorbell-unit.yaml`, including which domain block each `name:` sits
  under. All resolve.
- The panel's pure render functions were exercised against a simulated `hass`
  in eleven states — idle, armed, alarm with a reason, entry challenge with a
  live countdown, MFA pending, enrolling, PIN change, passage open, all four
  faults at once, auto-calibrate ready, phone trackers configured — plus a
  six-slot rack, an entirely empty state machine, and a doorbell whose entities
  carry the `eisodos_` prefix. No exception, and no `undefined` / `NaN` /
  `[object Object]` in any rendered output.
- Asserted as invariants, not conventions: no 64-character hash appears in any
  rendered view; no `type="password"` input exists anywhere in the file; `reset`
  and `clearSlot` are reachable only through the press-and-hold path and never
  as a single tap; the file contains no write to `portal_pin_hash`, no write to
  any `rfid_N_hash`, no call to `guardian_set_display`, and no code path that
  fires `guardian.major_alarm`.
- `configuration.yaml` parses, and `panel_custom[0].name` matches the custom
  element name the module registers.

Live checks are `DEPLOY.md` eleventh-pass items 64–73.

---

## 18. Twelfth pass — panel redesign, and the Frigate event that was never fired

No change to the state machine, the RFID rack, the lamp sampler, or either
ESPHome device. `automations.yaml` gains one `event:` on an existing
automation. `packages/*.yaml` is untouched.

The panel at `www/guardian-ui/guardian-panel.js` was rewritten as a household
app (nested More pages, light-first chrome, Camera as a first-class tab).
Entity classification in §17 still holds. Class D is still unrenderable.
`guest_bypass` is still Internals-only and labelled unused.

### F-58 — Activity claimed live Frigate rows that it never subscribed to —
BUG, presentation, fixed

`GUARDIAN_UI.md` §7 and the eleventh-pass Activity footnote said rejected
cards, door-direction verdicts, presence corrections **and Frigate
detections** appear live via `guardian.*` / `esphome.*` events. The panel's
`LIVE_EVENTS` list had no Frigate type. `Guardian: Data Log - Frigate Person
Detected` writes JSONL from MQTT `frigate/events` and fires no Home Assistant
event. Frontend `mqtt/subscribe` is admin-only; this panel is
`require_admin: false`. So household members could never see a Frigate row,
live or historical, unless a Frigate integration had published an occupancy
sensor.

Moving the JSONL log under `/config/www` remains forbidden (F-57). The fix
is the missing event the docs already assumed: the existing Data Log
automation now also fires `guardian.person_detected` with `camera`, `type`
and `label` only — no snapshot, no card hash. The panel subscribes like
every other live row.

If the Frigate add-on still has no `mqtt:` block (noted at the end of
`DEPLOY.md`), this event never fires either. The Camera tab states that
rather than presenting the camera key as a feed.

Live checks are `DEPLOY.md` twelfth-pass items 74–84.

---

## 19. Fourteenth pass — enrolled cards forgotten after a restart

The ninth pass moved `input_text.rfid_N_hash`, `input_select.rfid_N` and
`input_select.rfid_N_policy` from UI helpers into
`packages/guardian_rfid.yaml` so `max: 64` and visitor policy were
guarantees. The YAML copies were declared with `initial: ''` /
`initial: Away` / `initial: resident`.

Home Assistant YAML `input_text` (and `input_select`) apply `initial` on
**every start**. Restore from `.storage/core.restore_state` is skipped
when `initial` is present, including empty string. Enrollment wrote a
valid 64-character hash through `input_text.set_value`; the next
restart emptied every slot; `process_rfid_scan` then took `DENIED_CARD`
because occupancy is "64 characters after trim/lower". The Guardian
panel uses that same rule, so More → Keys showed no cards registered —
it was not a second, stale copy of the rack.

UI helpers typically have no `initial` in storage, which is why the
pre-ninth-pass rack survived restarts and why Developer Tools → States
Set State still does not persist (DEPLOY.md fifth pass). Comments in
`packages/guardian.yaml` that "`initial:` only applies when the helper
is first created" are true for some helper types and for UI helpers,
and false here.

**Fixed:** omit `initial:` on the hash, presence, and policy helpers.
Occupancy already treats non-64 values (`''`, `unknown`, truncated) as
empty, so a first-boot unset hash is a free slot. Enrollment always
writes presence and policy. `guardian_enroll_as_visitor` keeps
`initial: false` (session flag). No second store; restore_state is
what the UI helpers already used.

A restart that already ran under the old YAML has already emptied the
hashes. This pass cannot reconstruct them. Re-enroll, then restart
again to prove they stick.

Same class of bug, not this pass: YAML `input_text` configuration
helpers in `packages/guardian.yaml` that still declare `initial:`
(`guardian_camera_entity`, `guardian_frigate_camera_name`,
`guardian_presence_trackers`, …) will also reset on every start.
Ephemeral helpers (`pending_*`, enrollment slot, display state) should
keep `initial:` so a restart clears in-flight state.

Live checks are `DEPLOY.md` fourteenth-pass items 91–94.

---

## 20. Fifteenth pass — UID was the whole credential

Prompted by the observation that Guardian "verifies the factory code,
not the data written inside the key," so copying a card is easy.

Both readers sent `esphome.rfid_scanned` with the factory UID only.
`process_rfid_scan` compared `sha256(uid)` to `input_text.rfid_N_hash`.
Enrollment wrote that digest into Home Assistant, never onto the card.
A cheap UID-clone of an enrolled 4-byte (or 7-byte) key was a perfect
key. F-20 (unsalted UID hashes as a cloning oracle if leaked) was the
same trust root from the other direction.

Stock ESPHome `rc522_i2c` cannot fix this: it turns the antenna off
before `on_tag`, so a YAML lambda never has a selected PICC to read or
write. A local component (`esphome/components/guardian_rfid`) now owns
both readers. While the card is ACTIVE it reads NTAG pages, checks
`HMAC-SHA256(master, uid||card_id||counter)[:16]`, writes `counter+1`
and a new MAC, then fires `result` / `card_id` / `counter` / `rotated`
— not the UID.

Home Assistant matches `rfid_N_card_id` (16 hex). Occupancy is that
shape, not hash length 64. A ±1 window on `rfid_N_counter` accepts a
failed write (`stored-1`) and the other reader (`stored+1`); anything
older is `CLONE` (notify, deny, do not auto-Stolen). Grant still
happens if the rotate write fails; HA does not advance the counter
until `rotated: true`. MIFARE Classic is `UNSUPPORTED`. Enrollment
refuses UID-only events.

The HMAC master key lives in `esphome/secrets.yaml` as
`guardian_rfid_mac_key`, identical on both devices, never on the card,
never in an `input_text`. Verbose notifications and the RFID data-log
no longer print UID, card_id or MAC.

This is not DESFire challenge-response. The secret still sits in user
memory; a dump clone works until the next successful rotate. That is
the strongest design the RC522 can host. Every existing key must be
re-enrolled on NTAG213.

Live checks are `DEPLOY.md` fifteenth-pass items 95–104.

---

## 21. Sixteenth pass — the new reader never finished a tap

After the fifteenth-pass authenticator shipped, keys were not seen and
not registered. Home Assistant was already on `result` / `card_id`.
`process_rfid_scan` occupancy, the dispatcher, and the `event_data`
indent at the unknown-card default were not the break. Classic SAK
refuse and “no UID-only enroll” stay; this pass does not hash UID
again.

The tap died on the ESP before `RFID scan (interior portal): result=...`.
Stock `rc522_i2c` starts REQA and returns to `loop()` (the 20 ms IMU
poll sits in between) and waits ≥2 ms before reading IRQ, so the PICC
has several milliseconds of field. `guardian_rfid` asked in the same
call **1 ms** after `pcd_antenna_on_()`. ISO 14443 wants an unmodulated
field of ≥5 ms after power-up; NTAG213 is slower to boot than Classic.
REQA timed out, SELECT never ran, `fire_scan_` never ran.

A second silent abort: `pcd_transceive_` returned `ST_ERROR` when FIFO
held more bytes than the caller buffer (2 for REQA, 5 for anticollision).
Stock uses a large shared buffer. Extra CRC/garbage aborted SELECT with
no log line.

**Fixed in `esphome/components/guardian_rfid`:** 5 ms settle after
antenna on (still cycling the field off at the end of `update()` so
`pending_retry_` recovers via IDLE); poll CommandReg PowerDown before
`pcd_init_()`; transceive reads an 18-byte scratch and copies
`min(fifo, cap)`; TimerIRq does not win over RxIRq/IdleIRq; empty FIFO
after a success IRQ is a timeout; WRITE ACK accepts `0x0A` in either
nibble; WARN if REQA succeeded and SELECT failed; baud registers reset
before REQA.

Crypto stays on-device. Recopy the component folder and reflash both
units. Live checks are `DEPLOY.md` sixteenth-pass items 105–108.

---

## 22. Seventeenth pass — REQA succeeded, SELECT saw an empty FIFO

The sixteenth-pass field-on delay made REQA reachable. A tap then logged
`RFID REQA ... status=0` followed by `RFID xfer cmd=0x93 empty fifo
irq=0x64 err=0x00` and `PICC present but select failed` on every card
and keychain, enrollment or not. No I2C errors, version register good,
address 0x28 on the bus.

Idle polls already printed the same IRQ signature on **REQA**
(`cmd=0x26 empty fifo irq=0x64 err=0x00`). `irq=0x64` is TxIRq + RxIRq
+ LoAlertIRq; ErrorReg was 0. That is not a SELECT-only protocol bug:
the PCD was completing a receive with no bytes in the FIFO. REQA
`status=0` only meant FIFOLevel was non-zero (ATQA); `picc_request_a_`
did not require two bytes. SELECT is the first command that cannot
succeed if the first RxIRq has an empty FIFO.

NXP MFRC522 Rev 3.9: with RxNoErr=0, RxIRq can fire with no FIFO data;
RxMultiple=0 deactivates the receiver after a frame. `pcd_transceive_`
sampled ComIrqReg immediately after StartSend and treated empty FIFO as
terminal, so TX ringing / a sub-4-bit phantom shut the receiver off
before the PICC’s ~87 µs anticollision response. Stock `rc522` waits
≥2 ms before reading IRQ and never forces RFCfgReg (reset 33 dB). This
driver polled immediately, aborted on empty FIFO, and wrote RFCfg 0x70
(48 dB).

**Fixed in `esphome/components/guardian_rfid`:** wait ≥2 ms after
StartSend; on RxIRq + empty FIFO + no ErrorReg `0x13` bits, log
RxLastBits, clear RxIRq, stay in Transceive until FIFO has data or
TimerIRq; Idle after a completed transfer; RxModeReg 0x08 (RxNoErr) in
`pcd_init_()` and `update()` (the baud reset must not write 0x00);
RxSelReg 0x88 (RxWait=8 bit-clocks); leave RFCfgReg at reset 33 dB;
REQA is present only when two ATQA bytes arrived.

The 10 ms field-on settle stays. Recopy the component and reflash both
units. Live checks are `DEPLOY.md` seventeenth-pass items 109–112.

---

## 23. Eighteenth pass — Classic 1K stores GDN1 in sector 1

Classic SAK `0x08/0x18/0x09/0x19` was refused after SELECT with
`unsupported_tag`, so Grobotronics MIFARE 1K fobs never enrolled. Factory
UID hashing stays dead: both media still authenticate
`HMAC-SHA256(master, uid||card_id||counter)[:16]` and emit the same
`esphome.rfid_scanned` shape. Classic packs the 36-byte NTAG page map
into sector 1 blocks 4–6 (trailer left as keys). MFAuthent uses factory
transport `FFFFFFFFFFFF` (Key A, then Key B). Crypto1 is broken: a
sector dump is a clone until the next rotate. Classic is not NTAG
PWD/PACK.

The seventeenth-pass RF/SELECT path is unchanged. Recopy the component
and reflash both units. Live checks are `DEPLOY.md` eighteenth-pass
items 113–116.

---

## 24. Nineteenth pass — named keys, and add/remove without editing YAML

The rack was four YAML helper sets and `sensor.guardian_rfid_slots =
"1,2,3,4"`. The Guardian panel already looped that whitelist, but the
label on each slot was `input_select.rfid_N`'s YAML `friendly_name`
(`RFID 1`). Adding a fifth key was a package edit plus a full restart.
Empty positions still counted as residents, which would have become
`0/9 home` the moment the whitelist grew.

**Fixed:** `packages/guardian_rfid.yaml` pre-declares slots 1–9 (keypad
/ `ENROLL_DUP` cap) and sets the whitelist to `1,2,3,4,5,6,7,8,9`.
Each slot has `input_text.rfid_N_name` (max 32, no `initial:`).
`input_text.guardian_enroll_pending_name` is a session helper
(`initial: ''`), cleared when enrollment mode turns on or off and after
a successful enroll. `process_rfid_scan` writes a non-empty pending name
onto the target slot; `guardian_clear_rfid_slot` wipes the name with the
card_id. Occupancy readers — `sensor.guardian_presence_summary`,
`house_empty`, the Frigate person-while-away gate, the panel roster —
skip any id whose `rfid_N_card_id` is not 16 lowercase hex.

More → Keys & PIN no longer hides add/remove behind an enrollment
toggle: **Add a key** / **Hold: delete this key**. The pending name is
debounced to the helper while typing.

**Portal.** Idle page 1 draws `sensor.guardian_presence_roster`
(name + HOME/AWAY/GUEST/LOST). Enrollment boxes and ENROLL_DUP read
`sensor.guardian_rfid_key_labels` and
`input_text.guardian_enroll_pending_name`. Flash the interior portal
after the HA restart. Doorbell unchanged.

**Classification.** `input_text.rfid_N_name` is class B: a household
member may edit it from More → Keys & PIN. It is not a credential.
`input_text.guardian_enroll_pending_name` is class C session state, same
shape as `guardian_enroll_as_visitor`. The panel writes it only while
enrollment is on, the same documented exception as
`input_text.guardian_enrollment_slot` (§17.1). The roster and key-label
sensors are derived, like `sensor.guardian_presence_summary`.

Live checks are `DEPLOY.md` nineteenth-pass items 117–126.

---

## 25. Twenty-second pass — the lamp sampler that never wrote a verdict

Prompted by More → Lamp Last decision staying empty, with night stills of
the door camera lamp-off (IR/magenta, almost black) and lamp-on (upright
hallway, JPEG rotated 90° CCW).

### F-56 — The sampler aborted before `last_result`, so both luma modes looked dead — **BUG**

`script.guardian_sample_ambient_light` began with `condition:` gates:
sampling off, not ALARM, feedback off, then camera+lamp available. Those
returns wrote nothing. Thirteenth-pass live view already preferred
`camera.door_camera` when `input_text.guardian_camera_entity` was still
`camera.tapo_c110` / `none`, but the sampler kept reading the helper as
stored. An unavailable leftover Tapo entity made every 10-minute tick and
every Measure now a no-op. `guardian_lamp_last_result` stayed `none`.
Auto-calibrate never reached `on_sun` either, because that branch is after
the same gates.

**Fixed:** resolve the camera like the panel (`legacy` or unavailable →
`camera.door_camera` when that entity exists). Replace the silent
conditions with writes: `FAILED already_running` / `alarm` / `feedback` /
`lamp_unavailable` / `camera_unavailable`. A missing camera still
sun-switches the lamp. Fail streak + notification on camera/lamp misses.

### F-57 — Manual crop assumed an upright JPEG; Frigate's still is 90° CCW — **BUG**

Seventh-pass `y>=0.40` excluded a downstairs window at the **top** of the
C110 frame. The Frigate `door_camera` JPEG is the same scene with the
floor on the **left**. Bottom 60% of that still is not the landing.

**Fixed:** `input_number.guardian_luma_rotate` (default 90, CCW) is written
into luma-run.env and applied in `guardian-luminance.sh` before the crop
and before Auto-calibrate tiles. Live/detect are not transcoded.

### F-58 — Unconfigured IR still lets night vision look like daylight — **BUG**

`input_text.guardian_camera_ir_entity` still defaults to `none`. Frigate
exposes no night-vision entity. An IR-on night frame can read ~146 luma
(F-08) and turn the lamp off, or land in the 45–90 hold band.

**Fixed:** when `ir=0` in luma-run.env, a near-greyscale or magenta still
is reported as 12.0 and is not appended to `luma-samples.jsonl`. Sun
override still catches a false dark at noon. Install copy tells the
household to set the Tapo night-vision `switch`/`select` if it exists.

Live checks are `DEPLOY.md` twenty-second-pass items 138–144.

---

## 26. Super Surveillance schedule — one concept, not a night mode

The night-elevation boolean and its two hour helpers were a second code
path inside `binary_sensor.guardian_elevated_mode`. They are gone.

Elevated mode is now `input_boolean.super_surveillance_mode` OR the
schedule: seven weekday booleans (`guardian_ss_schedule_mon` … `_sun`)
plus start/end hours. A wrapping window belongs to the start day.
00:00–05:00 every day is the default configuration, not hardcoded
logic. No days selected is how the schedule is off. Downstream still
reads only `binary_sensor.guardian_elevated_mode`.

F-36's lesson stands: elevated mode is an entity so it can be watched
and cleaned up. The schedule is visible and editable in More → Security;
nothing re-arms on the clock with no UI.

Live checks are the new `DEPLOY.md` pass for this change.

---

## 27. Super Surveillance programs — several windows, still one mode

The single weekday × hour program could not express a household that wants
weeknights, a Saturday afternoon, and a Sunday overnight at once. That is
now a fixed rack of four YAML programs, discovered at runtime the same way
RFID slots are (`sensor.guardian_ss_programs`).

Elevated mode is still one entity: `input_boolean.super_surveillance_mode`
OR any enabled program whose weekday + hour window matches now. Wrap is
per program and still belongs to the start day. Empty or disabled programs
never elevate. Overlaps are fine (OR). There is no master toggle and no
silent re-arm. Downstream still reads only
`binary_sensor.guardian_elevated_mode`.

Names are optional `input_text` helpers with no `initial:` so a restart
cannot wipe them.

**Created is not enabled** (thirty-fifth pass). Showing four blank cards
to a household that had configured none of them was the same mistake as
listing nine empty RFID slots as if they were people, and it made
"delete a program" unexpressible: with nothing but `_enabled` and the
schedule, an off program and a never-made one are the same state. So the
rack gained `input_boolean.guardian_ss_N_created`, and
`sensor.guardian_ss_programs_created` — trigger-based, so its template
may build entity ids with Jinja — became the runtime list.
`sensor.guardian_ss_programs` stays static and means capacity.

Both the panel and `binary_sensor.guardian_elevated_mode` read the
created sensor rather than re-deriving the predicate, so an unclaimed or
deleted position cannot elevate on a stale `_enabled`. `_created` is
written only by `script.guardian_create_ss_program` /
`script.guardian_delete_ss_program`; no toggle touches it, which is what
makes disable-is-not-delete structural rather than a UI convention.
Delete is unconditional — it does not read `_enabled` — so it behaves
identically on an on or an off program.

The created predicate also adopts a position carrying leftover
configuration (enabled, any day, `start != end`, or a name). That is a
one-way migration for installs older than the flag: it only ever adds to
the list, and delete clears every term it tests.

F-36's lesson stands: elevated mode is an entity so it can be watched
and cleaned up. Every program is visible and editable in More → Security.

Live checks are the new `DEPLOY.md` pass for this change.

---

## 28. Twenty-third pass — phone associations forgotten after a restart

The fourteenth pass omitted `initial:` on RFID hash, presence, and
policy helpers so enrolled cards survived a reboot. The same class of
bug was still live on YAML configuration helpers in
`packages/guardian.yaml`: `input_text.guardian_camera_entity`,
`guardian_frigate_camera_name`, `guardian_presence_trackers`, and
`guardian_camera_ir_entity` all declared `initial:` (including
`initial: ''`). Home Assistant applies that value on **every start** and
skips `.storage/core.restore_state`. After a restart the tracker list
was empty, so person-detection silently dropped back to card-only
presence (F-16's original failure mode).

**Fixed:** omit `initial:` on those four helpers. Ephemeral helpers
(`pending_*`, enrollment slot, alarm/display/lamp session state) keep
`initial:` so a restart still clears in-flight state. `input_number`
helpers that still declare `initial:` (thresholds, Super Surveillance
hours) are the same restore-skip class; not this pass.

`input_select.rfid_N_notify_target` lost its **selected value**, not just
its options list. YAML `options:` is `[none]`; restore-state refuses a
phone that is not in that list, so every slot reset to `none` before
automation `1786500000033` rebuilt options eight seconds later. The
one-shot "Migrate Notify Targets Once" automation was not a
fix: `input_boolean.guardian_notify_targets_migrated` latched `on` after
the first boot, and it only name-matched two hardcoded devices.

**Fixed:** each selection is mirrored to `input_text.rfid_N_notify_saved`
(no `initial:`). After `script.guardian_refresh_notify_target_options`
sets options, it re-applies the saved object id if the select is still
empty and that id is in the refreshed list and in
`sensor.guardian_notify_targets_available`. Clearing a slot also wipes
the saved helper so a later refresh cannot resurrect the mapping.
That one-shot migration and the migrated boolean are deleted.

The parse-time `notify.guardian_alerts` group in `packages/guardian.yaml`
named two personal companion-app services. A YAML notify group cannot be
made dynamic. **Fixed:** when no slot has a phone linked,
`script.guardian_notify_broadcast` fans out to every object id on
`sensor.guardian_notify_targets_available` using the same closed-set
`notify.{{ target }}` path as mapped phones. If that sensor is empty,
the alert is logged only. Preview mocks no longer use those device
names.

Existing installs must re-link phones **once** after this deploy (the
new saved helpers start empty). A second restart is the proof they
stick.

Live checks are `DEPLOY.md` thirty-third-pass items 185–189.

---

## 29. Thirty-fourth pass — installer portability

A sweep of every layer for values that would break on someone else's
house, network, or hardware. Notify targets were already dynamic
(twenty-third / thirty-third pass). This pass applies the same
discovery → closed-set `input_select` → persisted `input_text` (no
`initial:`) pattern to the room lamp, suffix-discovers the doorbell so
YAML no longer names `eisodos_`, and declares the seven UI-only helpers
in `packages/guardian.yaml`.

**Live error (not in this repo).**
`automation.guardian_elevated_mode_door_supervisor` /
a household Companion notify service do not appear in current files or git
history. The tracked supervisor is `Guardian: Elevated Opening
Supervisor` (`1775221552333`) calling `script.guardian_notify_broadcast`.
The live failure is a ghost automation in Home Assistant `.storage/`
(gitignored). Delete it on the Pi; do not fabricate YAML for it.
`DEPLOY.md` thirty-fourth pass lists the exact steps.

**Fixed in YAML:**

- Seven helpers that lived only in the UI
  (`portal_display_state`, `portal_pin_hash` max 64 with no `initial:`,
  `mfa_failed_attempts`, `portal_mfa_pending`, `super_surveillance_mode`,
  `guest_bypass`, `last_doorbell_rfid_time`). Existing installs must
  delete the UI copies before the package is loaded.
- `light.tapo_lamp` (~60 script/automation sites) now goes through
  `sensor.guardian_lamp_entity`, fed by
  `sensor.guardian_lights_available` + `input_select.guardian_lamp_target`
  + `input_text.guardian_lamp_saved`. First refresh selects `tapo_lamp`
  when that light exists and saved is empty, so this house keeps working.
- Camera sampler: leftover `camera.tapo_c110` is an unset sentinel;
  `camera.door_camera` is used only if that entity exists.
- Doorbell YAML uses suffix discovery
  (`sensor.guardian_doorbell_entities`,
  `binary_sensor.guardian_doorbell_button`). Guest Bypass Trigger and
  `guardian_reset` no longer hardcode `eisodos_`.
- Presence CSV is filtered through
  `sensor.guardian_presence_trackers_available` /
  `_resolved`. Install page lists live trackers.
- Portal static IP / gateway / DNS moved to `!secret`. Example secrets
  use placeholder `192.168.0.x`, not this LAN.
- YAML `initial:` removed from user-config `input_number` /
  Super Surveillance booleans / `guardian_lamp_luma_mode`. Session
  helpers keep `initial:`. Comments that claimed “initial: only on first
  create” were wrong and are corrected.
- Empty `scenes.yaml` and `themes/` so a clean checkout loads.

**Left as product, not helpers:** ESPHome GPIO / IMU C++ thresholds /
RFID I2C, `/config/...` HA paths, Frigate camera key in
`frigate/config.yml`, option string `Manual (this home)`,
`friendly_name: Guardian Interior Portal`. Guest bypass remains unused
(F-07). Tamper and salted hashes remain outstanding.

Live checks are `DEPLOY.md` thirty-fourth-pass items 190–196.



---

## 30. Thirty-sixth pass — the phone link that was never consulted

Reported from the live house: every key had a phone picked under **Alerts
go to**, the picker named it correctly, **Send test alert** was enabled —
and every test answered *"Nothing was sent. This key has no phone
linked."* No alert had ever reached a phone.

**The decision and the display read two different sources.**
`script.guardian_notify_person`'s `mapped` template required the picked
object id to be in `sensor.guardian_notify_targets_available`. That sensor
was **trigger-based** (`homeassistant start` / `entity_registry_updated` /
a ten-minute tick) over `integration_entities('mobile_app')`, so it renders
`unknown` after a template reload and comes back empty in any window where
the mobile_app entries have not finished loading. The picker, meanwhile,
renders from the select's own `options` attribute, which `set_options`
persists in `.storage` **forever**. Correct-looking dropdown, enabled
button, backend certain the slot was unlinked.

**Fixed:** `sensor.guardian_notify_targets_available` is now a plain
state-driven template sensor over `states.notify` (minus Guardian's own
`guardian_data_log` / `guardian_alerts` / `persistent_notification`). It is
never `unknown`, re-renders the moment a notify entity appears or
disappears, needs no tick to become correct, and now covers any notify
target rather than only `mobile_app` — real device names on this install
never followed the `mobile_app_` convention anyway. Entity id and CSV state
shape are unchanged, so all eighteen consumers keep working; a `phones`
list attribute is published alongside `count` because a state is capped at
255 characters and a rack of long device names can exceed it. Send-time
validation is now against the union of the live `notify` domain and that
CSV, so the set the decision is made against cannot go blank underneath it.
Both halves are closed sets of real object ids: the `notify.{{ }}`
injection guard is unchanged.

**Two more defects on the same path, either of which would have brought
the failure straight back.**

- **The restore mirror was being destroyed.** With the sensor empty,
  `guardian_refresh_notify_target_options` wrote `options: ['none']`, Home
  Assistant fail-safed each select back to `none`, and persist automation
  `1786500000035` — which filtered only `unknown`/`unavailable` — mirrored
  that `none` into `input_text.rfid_N_notify_saved`. After that no restart
  could ever restore the link. **Fixed:** a blank discovery list is now a
  no-op instead of a reset; `none` and `''` are in the automation's
  `not_to`; the restore no longer also demands the saved id be in the CSV
  (it is checked against options built from that same CSV moments earlier);
  and a deliberate **Not linked** clears the mirror from the panel, which
  is the one place that knows the unlink was intended.
- **Every alert carrying a payload was calling a service that does not
  exist.** The picker stores the notify **entity** object id
  (`notify.your_phone`); the Companion **service** is a different name
  (`notify.mobile_app_your_phone`). Three branches of
  `guardian_notify_person` and one of `guardian_notify_broadcast` used
  `action: notify.{{ target }}`, all with `continue_on_error: true` — so
  every `priority: high` / `ttl: 0` push, and the doorbell-exit PIN
  `textInput`, failed silently. **Fixed:** an `svc` variable resolves the
  Companion service from the device registry, and only for entities that
  really belong to `mobile_app`; anything else falls back to
  `notify.send_message` with the words and logs `notify_payload_dropped`
  rather than inventing a service name.

**The skip verdict now carries a reason.** `not_selected` (nothing picked)
and `not_registered` (a phone picked whose notify target is gone) were
reported as the same sentence, which is what made this so hard to place.
The panel and the persistent notification now say which.

**Panel.** `setNotifyTarget` replaces the fire-and-forget `setSelect` on
this one picker and waits for the read-back, because a rejected option
left the browser showing a phone the backend did not have — the re-render
is skipped when the view HTML is unchanged, so the stale `<option>`
survived indefinitely.

**Unrelated, same pass — the challenge chirp.** Under Super Surveillance
the "authenticate now" tone was heard only after someone scanned a card.
The repeat loop in `Guardian: Elevated Opening Supervisor` was always
triggered by the reed edge, but it sat behind a display write, a lamp
script, an event and `action: script.guardian_notify_broadcast` — a
blocking, serial, per-phone network fan-out. The first sound anyone
actually heard was the one-shot chirp `process_rfid_scan` plays on a scan.
Same defect class as the blocking-`action: script.X` rule this audit
already records, and already fixed once inside this very automation for
`guardian_lamp_warning`. **Fixed:** one chirp fires
immediately after the challenge flag is set, before anything else in that
branch; the broadcast is `script.turn_on`; the loop delays first and
presses second so iteration one does not double-chirp the same instant.

Live checks are `DEPLOY.md` thirty-sixth-pass items 208–214.

### 8.6 Forty-sixth pass (RFID torn write, hardware docs)

A registered key that occasionally was not recognised, then worked after
re-enroll, was a **torn rotate write** plus an empty `card_id` on `bad_mac`,
not a clone-window false positive and not a random RC522 miss. Firmware now
commits the counter last, heals MAC-vs-counter tears without changing the
on-card format, stashes the intended next counter so a successful write with
a failed read-back does not rotate twice, and always publishes `card_id` from
GDN1. Home Assistant HOLD copy tells the household to retry; re-enroll only
after three HOLDs. `window_ok` was not widened.

Hardware docs now match the tree: exploded STLs under `3D-Models/Main/`,
KiCad under `PCBs/` (schematic-present, not fab-ready), no lamp PCB because
the lamp is a commercial bulb. README/INSTALL first screens carry the
production caveats. Version **2.30.0**. Unverified on hardware: RFID recovery,
DFPlayer volume 30, offline siren, alarm path.
**Closed later:** meshes left this tree; print files are the three `.3mf`
profiles on MakerWorld / Printables. `PCBs/` still holds KiCad + Gerbers.

### 8.7 Forty-seventh pass (tamper, encryption opt-in, multi-account keys)

Portal tamper is a pair again: `esphome/portal-unit.yaml` emits
`esphome.tamper_alert` (`magnet_defeat` / `spoofed_contact`) from the swing
integrator plus GPIO42, debounce, cooldown, `imu_healthy`. Home Assistant
fires `guardian.major_alarm` first; a parallel automation logs
`log_type: tamper`. No HA tamper sensor. Panel copy and activity-feed mapper
restored. Needs a portal reflash; hardware not claimed from this environment.

Flash encryption / secure boot remain **off** in shipped YAML. Both device
files carry a commented development-mode `sdkconfig_options` block. INSTALL
documents USB first, irreversible eFuses, QIO→DIO on the portal, C6 USB-JTAG,
key backup. `guardian_rfid_mac_key` stays on both readers.

RFID slots bind to Home Assistant user ids (`rfid_N_ha_user_id`) plus roster
helpers. Empty roster = single-account. Mutation scripts check
`context.user_id` and refuse with `continue_on_error` then `stop`. Notify
routing unchanged; critical alerts still `nonmaskable`. `require_admin`
stays false. Direct helper writes from Developer Tools are still Home
Assistant's model. Version **2.32.0**.

