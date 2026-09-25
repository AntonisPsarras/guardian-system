# Deploying the Guardian third-pass fixes

> **Installing Guardian for the first time? Read [`INSTALL.md`](INSTALL.md)
> instead.** This file is the upgrade changelog — release notes written
> pass-by-pass, explaining why each fix exists and how to verify it on a system
> that is already running. It is deliberately historical: the `## Order` section
> below is a fourteenth-pass artifact and still names helpers that no longer
> exist. Reading it as an install guide is what INSTALL.md exists to stop.

Rollback point: `git checkout 9b61bf9`. Take a full HA backup first regardless.

This release fixes the auto lamp switching the wrong way, a master PIN that
could never be accepted, an authentication state machine that got stuck when
super surveillance was switched off, and the ESP modules dropping off the
network. It adds a doorbell link indicator to the portal screen, a system reset,
and watchdogs that repair stuck state without you.

---

## Fourth pass — card enrollment and the elevated-mode grace challenge

Rollback point for this pass alone: `git checkout b9d9c22`.

Read this section together with the rest of the document; the file map, the order
of operations and the network notes are all unchanged. **Both Home Assistant and
the portal must be updated, in that order** — the portal imports six new entities
and renders blanks until they exist. The doorbell is unchanged this pass and does
not need reflashing.

### What changed

**A card that had just been enrolled gave no confirmation on screen.** The cause
was not card matching. `input_text.set_value` emits no state change when it
writes the value a helper already holds, and both the LED mirror automation and
the portal's own repaint test keyed off that event — so a second `GRANTED`
arriving inside the first one's three-second window was swallowed, and the
earlier run's timer still cleared the screen underneath it. Enrolling a card and
then scanning it is exactly that sequence. Every verdict now goes through
`script.guardian_set_display`, which bumps `input_number.portal_display_seq`, and
both consumers watch the counter. The portal also flashes a short coloured bar
under the status strip on each verdict, so a repeat reads as a new event.

**Enrollment mode is now a session.** It no longer switches itself off after one
card; it stays open so several can be added, shows `# to exit` on the panel, and
expires by itself after two minutes idle. With all four slots occupied it asks
for a slot on the keypad instead of refusing — the system never chooses whose
card to overwrite. Presenting an already-registered card now says so, with its
slot number, instead of silently opening a passage window.

**Super surveillance no longer sirens on every opening.** An opening with no
completed passage window starts a 30-second authentication challenge: the portal
shows `AUTHENTICATE` with a countdown, the lamp goes amber, and a short tone
repeats every five seconds. Either a registered card or the master PIN ends it.
Silence, three wrong PINs, or a stolen card raises the full alarm exactly as
before. The one case that still alarms instantly is an opening from **inside**
while all four cards read `Away` — nobody should be in the house to open it.

**The reader stopped seeing cards after an enrollment session.** Reported during
testing of the above, and fixed in the same pass. Every card scan *waited* on the
lamp: `- action: script.guardian_lamp_success` blocks until the called script
returns, and `guardian_lamp_feedback` takes 2–3 seconds on a good day (a 15 s
`wait_template`, a `light.turn_on` against a cloud-connected Tapo bulb, a 2 s
hold, then a restore). `process_rfid_scan` is `mode: queued, max: 10`, so ten
runs parked on the lamp fill the queue and Home Assistant **drops every further
scan** — no screen change, no audio, nothing. It went unnoticed while enrollment
disabled itself after one card; now that a session stays open and cards are
presented one after another, the queue fills in seconds and the reader looks
dead. All lamp calls are now fired with `script.turn_on` and no longer block.

The same flaw was in the new challenge code: the supervisor called
`script.guardian_lamp_warning`, which waits up to five minutes for the challenge
to end, so the warning chirp loop after it would never have run at all.

**Card reads are now logged at INFO on both devices.** The RC522 component
announces tags with `ESP_LOGD` and both devices run at `level: INFO`, so a card
read has never appeared in the device log — which made "the reader saw nothing"
and "Home Assistant dropped the scan" the same observation from outside. If
`RFID tag read (interior portal): ...` appears in the ESPHome log, the hardware
is fine and any fault is Home Assistant-side.

### New helpers created by `packages/guardian.yaml`

All of these appear automatically on the full restart in step 2. Nothing to
create by hand.

| Helper | Default | Purpose |
|---|---|---|
| `input_number.portal_display_seq` | 0 | Verdict counter. Do not write it by hand. |
| `input_number.guardian_entry_challenge_seconds` | 30 | Grace window length, 10–120. |
| `input_boolean.guardian_entry_challenge` | off | A challenge is open. |
| `input_text.guardian_enrollment_slot` | empty | Keypad-chosen slot for the next card. |
| `input_text.guardian_challenge_origin` | none | `outside` / `inside` / `unknown`. |
| `timer.guardian_enrollment_window` | 2 min | Enrollment idle expiry. |
| `timer.guardian_entry_challenge` | 30 s | Grace window. |
| `sensor.guardian_rfid_free_slots`, `sensor.guardian_rfid_slot_map`, `sensor.guardian_enrollment_target_slot` | — | Read by the portal's enrollment screen. |

`input_boolean.super_surveillance_mode`, `input_boolean.portal_mfa_pending`,
`input_number.mfa_failed_attempts`, `input_text.portal_display_state`,
`input_text.rfid_1_hash` … `rfid_4_hash` and `input_select.rfid_1` … `rfid_4`
are still UI helpers this repo does not create. They are unchanged.

> **Check `input_text.rfid_N_hash` maximum length is at least 64** — the same
> trap as `portal_pin_hash` in step 4. Enrollment now reads the hash back after
> writing it and raises "Guardian: card did not save" if it was truncated, so
> this failure is no longer silent, but fixing the helper is still on you.

### Verify this pass

19. **The bug that started this.** Enable enrollment, enroll a card, and scan
    that same card again within two seconds. The screen must show `REGISTERED /
    Already in slot N` with a fresh coloured pulse. Before this pass it showed
    nothing at all while still playing the welcome tone.
20. **Enrollment session.** The panel must read `PRESENT CARD / Saving to slot N`
    with a slot map and `# to exit`. Enroll a card — enrollment stays **on**.
    Press `#` — it goes off. Turn it on and walk away: it must switch itself off
    after two minutes with a notification.
21. **All slots full.** Fill all four hashes and enable enrollment. The panel must
    read `SELECT SLOT / All full - press 1-4 to replace`. Present a card before
    choosing: `ALL SLOTS FULL`, and **nothing is overwritten**. Press `3`, present
    the card, then confirm `input_text.rfid_3_hash` is exactly 64 characters.
22. **Truncation guard.** Temporarily set one `rfid_N_hash` helper's max to 20 and
    enroll into it. You must get `DENIED` on the panel and a "card did not save"
    push, not a false success. Put the max back.
23. **Challenge from outside.** With super surveillance on, open the door with a
    key and no prior scan. Expect **no siren**: `AUTHENTICATE` with a countdown,
    amber lamp, a tone every five seconds. Scan a registered card — cleared.
    Repeat and clear it with the master PIN instead. Repeat once more and let it
    run out — full alarm, with the origin in the reason.
24. **Challenge from inside.** With at least one card set `At home`, open from
    inside using the lever: a challenge starts. Set all four cards to `Away` and
    repeat: **immediate alarm**, no grace.
25. **No regressions.** A normal (non-elevated) scan still opens a 20-second
    passage window and still flips presence on the opening; scan-then-PIN-then-
    open still works in elevated mode; three wrong PINs still alarm — and must
    raise exactly **one** alarm, not one for the PIN lockout and a second for the
    challenge timing out.
26. **Recovery.** Press `input_button.guardian_reset` during a live challenge.
    The challenge, the chirp, the amber lamp and the enrollment session must all
    clear together.

---

## Fifth pass — enrollment still said the slots were full after the hashes were cleared

Home Assistant files only. **Full restart**, not a reload: the occupancy
templates live in `packages/guardian.yaml` and are only merged at startup. The
portal and doorbell firmware are unchanged; do not reflash them for this pass.

**The enrollment screen kept announcing ALL SLOTS FULL after the card hashes
were emptied.** Occupancy on that screen is three template sensors
(`sensor.guardian_rfid_free_slots`, `sensor.guardian_rfid_slot_map`,
`sensor.guardian_enrollment_target_slot`). They built entity ids in a loop
(`'input_text.rfid_' ~ i ~ '_hash'`). Home Assistant's template listener
extractor only sees a complete quoted entity id, so clearing a hash produced
**no sensor update** — the portal kept rendering `XXXX` / `none` / zero free
slots. `process_rfid_scan` was never the liar: it reads the helpers at tap time
and would have enrolled. The screen was cosmetic, and a confident false
"full" stopped people presenting the card that would have worked.

The three sensors now name `input_text.rfid_1_hash` … `rfid_4_hash` as four
literal `states()` calls so they actually refresh.

**There was no machine path to clear a slot.** `script.guardian_reset` does not
touch hashes. Developer Tools → States **Set State** looks empty and does not
persist; the hash comes back on the next write or restart. The supported clear
is now Developer Tools → Actions → **`script.guardian_clear_rfid_slot`**
(`1`–`4` or `all`). It writes `input_text.set_value` with an empty string,
reads the lengths back, and does **not** flip At home/Away.

**A tap that really has nowhere to go now proves it.** The
`guardian_enrollment_full` notification always includes live helper lengths,
`empty_slot` / `target_slot`, and the three portal sensors, so the next "all
slots full" either shows four `64ch` helpers (they were not cleared) or a
sensor/helper disagreement (the screen was stale).

Lamp calls in `process_rfid_scan` were already `script.turn_on`. The remaining
`action: script.*` calls are short helper writes (`guardian_set_display`,
`guardian_reconcile_presence`, `guardian_authorize_passage`,
`guardian_clear_entry_challenge`) and must stay blocking because the next
branch depends on them. Do not convert them, and do not raise `max: 10` as a
substitute.

### New / changed this pass

| Item | What to do |
|---|---|
| `packages/guardian.yaml` occupancy templates | Full HA restart. No new helpers. |
| `script.guardian_clear_rfid_slot` | New. Run from Developer Tools → Actions. |
| `guardian_enrollment_full` notification | Richer text; same notification id. |

### Verify this pass

27. **Clear is a service, not Set State.** With known 64-character hashes in
    place, run `script.guardian_clear_rfid_slot` with `slot: all`. The
    persistent notification must report four `0ch` lengths (or `7ch` if a
    helper is missing and reads `unknown` — that is free, not occupied).
    Developer Tools → States on `input_text.rfid_1_hash` … `rfid_4_hash` must
    be empty, and `sensor.guardian_rfid_slot_map` must become `----` without a
    second restart. If a slot stays `64ch`, that helper's **min** length is
    above 0; set it to 0 and run the script again.

28. **The idle enrollment screen follows the helpers.** Enable enrollment.
    The portal must read `PRESENT CARD / Saving to slot 1` with four empty
    boxes, not `SELECT SLOT / All full`. `sensor.guardian_enrollment_target_slot`
    must be `1`, `sensor.guardian_rfid_free_slots` must be `4`.

29. **A tap enrolls into the first free slot.** Present a card. Expect
    `GRANTED`, then `input_text.rfid_1_hash` exactly 64 characters. Enrollment
    stays **on**. Present the same card again: `REGISTERED / Already in slot 1`.

30. **Enrollment off recognises that card.** Press `#` or turn the boolean
    off. Present the same card: `GRANTED` (or `AUTHENTICATE` / MFA if elevated
    mode is on — not `DENIED` / `Card not recognised`). Presence
    (`input_select.rfid_1`) may stay put until the door opens; that is
    intended. The occupancy boxes are hashes, not At home/Away.

31. **A real full house still asks for a slot.** Fill all four hashes, enable
    enrollment: `SELECT SLOT / All full`. Present a card **before** pressing
    `1`–`4`: `ALL SLOTS FULL`, nothing overwritten, and
    `guardian_enrollment_full` lists four `64ch` live lengths. Press `3`,
    present the card, confirm slot 3 is a new 64-character hash.

32. **If it still misbehaves, send this pack before changing matching.** Turn
    on `input_boolean.guardian_verbose_notifications`. Paste the template
    below into Developer Tools → Template. Then one interior tap with
    enrollment on, one with it off. Collect: portal idle text vs the 3-second
    flash; the `guardian_scan_debug_*` / `guardian_scan_trace_*` /
    `guardian_enrollment_full` notes; ESPHome `RFID tag read (interior portal):
    …`; HA log lines about `process_rfid_scan` already running / queue full;
    last rows of `/config/guardian_data_log.jsonl`. Report **lengths and
    prefixes only**, not full hashes.

```jinja
free={{ states('sensor.guardian_rfid_free_slots') }}
map={{ states('sensor.guardian_rfid_slot_map') }}
target={{ states('sensor.guardian_enrollment_target_slot') }}
enroll={{ states('input_boolean.guardian_enrollment_mode') }}
chosen='{{ states('input_text.guardian_enrollment_slot') }}'
display={{ states('input_text.portal_display_state') }} seq={{ states('input_number.portal_display_seq') }}
elevated={{ states('binary_sensor.guardian_elevated_mode') }}
{% for i in range(1, 5) %}
{{ i }}: len={{ states('input_text.rfid_' ~ i ~ '_hash')|string|trim|lower|length }}
 max={{ state_attr('input_text.rfid_' ~ i ~ '_hash', 'max') }}
 mode={{ state_attr('input_text.rfid_' ~ i ~ '_hash', 'mode') }}
 sel={{ states('input_select.rfid_' ~ i) }}
{% endfor %}
```

How to read it:

- Sensors say `none` / `XXXX` but helper lengths are not 64 → occupancy
  sensors did not refresh (this pass is not deployed, or HA was reloaded
  instead of restarted).
- Lengths are 64 after a "delete" → the helpers the script reads were never
  emptied. Use `script.guardian_clear_rfid_slot`, not Set State.
- ESP log, no `guardian_scan_debug_*` → the event never reached Home Assistant.
- Debug note exists, portal silent, no `guardian_scan_trace_*` →
  `process_rfid_scan` was dropped (queue). Check the HA log.
- Trace `ENROLL_PICK` with four `64ch` → the script is correct; the slots
  are full. Press `1`–`4` or clear.
- Trace `ENROLL_PICK` while helper lengths are `0ch` and `empty_slot` /
  `target_slot` print as `'1'` → Home Assistant stored the slot as the
  integer 1, so `1 in ['1','2','3','4']` failed (F-53). Copy the new
  `scripts.yaml` and reload scripts.
- Enrollment off, `DENIED_CARD`, hashes empty → nothing is enrolled; matching
  is doing its job.
- Enrollment off, `GRANTED`, presence unchanged, door not opened → expected.
  Presence commits on a matching door open; `guardian_reconcile_presence`
  only flips a card that is already on the wrong side.

33. **Enrollment actually writes (F-53).** After copying the updated
    `scripts.yaml` **and** `automations.yaml`, Developer tools → YAML →
    **Reload Scripts** and **Reload Automations** (or a full restart). Hashes
    still empty, verbose on, enrollment on, present a card **once**. The
    trace title must be `ENROLL -> slot 1`, not `ENROLL_PICK`.
    `input_text.rfid_1_hash` must become 64 characters. Same card again:
    `REGISTERED / Already in slot 1`. Enrollment off, same card: `GRANTED`
    (or MFA if elevated). At home/Away still may not flip until the door
    opens.

---

## Sixth pass — RFID success left the Tapo green

Home Assistant files only: `automations.yaml` and `scripts.yaml`. **Reload
Scripts and Reload Automations** (or a full restart). No `packages/guardian.yaml`
change, no new helpers, and neither ESPHome device needs a reflash. The portal
LED path is unchanged; this pass is the room bulb (`light.tapo_lamp`).

**A successful card left the Tapo on green instead of a short confirmation.**
Two independent things stacked. `guardian_lamp_feedback` held success green for
two seconds, then restored whatever it had snapshotted. `Guardian: Complete
Authorized Passage` then fired `guardian_lamp_success` again when the door
opened. That queue serialises flashes, so a walk-through was two seconds plus
two seconds. Worse, the second run captured `was_on` *after* the first
`light.turn_on` green (and after a laggy Tapo cloud `turn_off`), and
`guardian_restore_lamp` prefers `prev_rgb` when it is present, so it restored
**on + (0, 255, 0)** and the bulb stayed green.

The scan (and the PIN path that calls `guardian_authorize_passage`) already
flashes green. Passage completion now updates presence and clears that
direction's window only. The success hold is **1 s** (was 2 s). If a snapshot
sees the lamp already at the flash colour `(0, 255, 0)`, it is treated as
"was off" and that rgb is not handed to restore.

Rejected still blinks red three times. MFA / CHALLENGE amber still holds until
the challenge ends. `process_rfid_scan` lamp calls stay `script.turn_on`; do
not put a blocking `action: script.guardian_lamp_*` back on the scan path.

### New / changed this pass

| Item | What to do |
|---|---|
| `Guardian: Complete Authorized Passage` | Copy `automations.yaml`. No lamp flash on door-open. |
| `script.guardian_lamp_feedback` | Copy `scripts.yaml`. Success hold 1 s; refuse to restore flash-green. |

### Verify this pass

34. **Reload, then one GRANTED with the door shut.** Developer Tools → YAML →
    **Reload Scripts** and **Reload Automations**. Watch `light.tapo_lamp` and
    `input_text.portal_display_state` in Developer Tools → States. Present a
    registered card in normal mode and **do not open the door**. The Tapo must
    go green for about one second, then off (or back to whatever it was before
    the tap — not green). `portal_display_state` returning to `IDLE` is the
    portal LED / screen timer and is still three seconds; that is not this
    bulb.

35. **GRANTED and walk through.** Same tap, open the door during or just after
    the flash. Presence must still flip. The Tapo must **not** go green a
    second time when the door opens. If it stays green after
    `portal_display_state` is `IDLE`, the restore guard missed a leftover
    flash colour — check `light.tapo_lamp` attributes (`rgb_color`,
    `brightness`) while it is stuck.

36. **Rejected is unchanged.** Present an unknown card. The Tapo must blink
    red three times (0.5 s on / 0.5 s off) and then restore, not sit green.

37. **Challenge amber still holds.** With super surveillance on, open the door
    with no scan. The Tapo must go amber and stay amber until a registered
    card or the master PIN, then restore. A successful card in that window
    still gets the short green confirmation, then idle — not a second green
    when the door is already open.

---

## Seventh pass — the downstairs window that looked like daylight

Home Assistant files plus `guardian/guardian-luminance.sh`. **Full restart**,
not a reload: the new helpers live in `packages/guardian.yaml` and are only
merged at startup. Copy the shell script to `/config/guardian/` with **LF**
line endings. Neither ESPHome device needs a reflash.

**A downstairs window in the C110 frame made a dark landing look bright enough
to leave the Tapo off at night.** `guardian-luminance.sh` used a whole-frame
mean. The live night card (`2026-08-14 22:20`) is almost black except a warm
rectangle in the stair opening (roughly x=52–63%, y=13–33%, about 3–5% of the
frame, luma near 255). That patch pulls a mean of a dark floor (~8) up to
~18, or a grainier floor (~40) into the **45–90 hold band**. Hold restores
the previous state, so a lamp that is already off at dusk stays off all
night. The immediate sun clamp (`on_sun_override`) never fires: that path
needs luma ≥ 90. By day the same opening is 15–20% of the frame, so dropping
only the brightest 10% of pixels would not remove it.

The sampler now crops the **bottom 60%** (the landing, approach, and RFID
plinth — below the window) and takes the **25th percentile** of luma there.
Whole-frame p25 is unsafe: the left soffit is ~20% of the frame and stays
dark at noon, so it would read as night in daylight. Thresholds stay **45 /
90**; the 45-point gap already stops flapping, and this statistic is more
stable than a mean, not less. Historical `luma=` values in
`guardian_lamp_last_result` are **not comparable** to the new number.

**A valid-looking reading that stays in the hold band could still stick the
lamp.** The existing sun clamp only acts when a numeric reading *crosses* a
threshold and contradicts the sky. The new fallback tracks how long
`light.tapo_lamp` has disagreed with sun elevation (`< -6` → should be on,
`> 10` → should be off; twilight has no expected state and **clears** the
clock so dusk cannot accumulate). After
`input_number.guardian_lamp_mismatch_max_minutes` (default 30) it forces
4000 K / 45% or off, even when the camera number is valid, and writes
`on_mismatch` / `off_mismatch`. Same bound both ways — it does not turn the
lamp off faster to save power.

It runs in two places with the same script
(`script.guardian_apply_lamp_sun_mismatch`): at the **end** of
`guardian_sample_ambient_light`, after the choose and after clearing
`guardian_lamp_presample` (so hold cannot win the same run, and the watchdog
cannot restore a pre-force blackout), and on an independent `:30` ten-minute
tick so a dead sampler cannot stick the lamp. It does **not** fire while
sampling, during a feedback flash, or while the display is `ALARM` /
`CHALLENGE` / `MFA`. It does not increment `guardian_lamp_fail_streak`.

### New / changed this pass

| Item | What to do |
|---|---|
| `guardian/guardian-luminance.sh` | Copy to `/config/guardian/`. LF endings. Invoked via `sh`; `chmod +x` not needed. |
| `input_number.guardian_lamp_mismatch_max_minutes` | New. Default 30, range 10–180. `initial:` only on first create. |
| `input_text.guardian_lamp_mismatch_since` | New. Do not write it by hand. |
| `script.guardian_apply_lamp_sun_mismatch` | New. Called by the sampler and the fallback automation. |
| `Guardian: Lamp Sun-Mismatch Fallback` | New. Copy `automations.yaml`. |
| `script.guardian_sample_ambient_light` / `script.guardian_reset` | Copy `scripts.yaml`. |

### Verify this pass

38. Copy `guardian-luminance.sh` to `/config/guardian/`, Developer Tools → YAML
    → **Check configuration**, then a **full restart**. Run
    `script.guardian_sample_ambient_light`. `input_text.guardian_lamp_last_result`
    must still be one line. After dark, `luma=` must be **well below 45** even
    with the yellow downstairs window visible on the live camera card.

39. **The immediate clamp must not regress.** After dark, set
    `input_number.guardian_bright_threshold` to `10` and run the sampler.
    The lamp must switch **on** and the result must still read
    `on_sun_override`. Restore the threshold to `90`.

40. **Noon.** Run the sampler. `luma=` must be **≥ 90** and the lamp off
    (`off_camera` or `off_sun_override`). If luma sits in 45–90, lower
    `guardian_bright_threshold` by hand until a clear day reading is
    `off_camera`, then record the new pair in `last_result` history. If a
    dark night sample is still **> 45**, raise `guardian_dark_threshold`.
    Existing installs ignore YAML `initial:` on those two helpers.

41. **Mismatch, night.** After dark, turn `light.tapo_lamp` **off** by hand
    and set `guardian_lamp_mismatch_max_minutes` to `10`. Within about 10–11
    minutes (the `:30` tick, or the next sample), the lamp must go **on** at
    4000 K / 45%, `last_result` must contain `on_mismatch`, and a
    `guardian_lamp_mismatch_timeout` notification must appear. Restore the
    helper to `30`. Repeat by day: force the lamp **on** by hand → expect
    `off_mismatch` and the lamp off. Same 10-minute bound.

42. **Do not fight sampling, the watchdog, or the alarm.** Start
    `script.guardian_sample_ambient_light` and, while
    `input_boolean.guardian_lamp_sampling` is on, confirm the fallback does
    not run (the `:30` tick is skipped; the sampler applies the script only
    at the end). Abort a sample: the watchdog must still restore
    `guardian_lamp_presample`. Raise a test alarm: the Tapo must stay **red**
    until dismiss; the fallback must not turn it off or to 4000 K. Dismiss
    then hands the lamp back via the sampler, not via the mismatch path.

43. **Reset.** Press `input_button.guardian_reset`.
    `input_text.guardian_lamp_mismatch_since` must read `none` and
    `guardian_lamp_mismatch_timeout` must be dismissed.

---

## Eighth pass — auto-calibrate the Tapo lamp without replacing this home's path

Home Assistant files plus `guardian/guardian-luminance.sh`. **Full restart**,
not a reload: `input_select.guardian_lamp_luma_mode`, `sensor.guardian_lamp_cal`
and the two `shell_command`s live in `packages/guardian.yaml` and are only
merged at startup. Copy the shell script to `/config/guardian/` with **LF**
line endings. Neither ESPHome device needs a reflash.

**The 60 % / p25 crop is this landing, not a portable day/night signal.** A
second house, a bumped camera, or a downstairs lamp that was not there when
the crop was chosen would need another YAML edit. This pass adds a first-class
choice rather than retuning the current path as the only system.

`input_select.guardian_lamp_luma_mode` defaults to **Manual (this home)**:
exactly today's crop (bottom 60 %), pixel p25, and
`input_number.guardian_dark_threshold` / `guardian_bright_threshold` (45/90).
The calibrator never writes those two helpers. Switching back to Manual on the
next sample restores that behaviour even if a learned profile exists on disk.

**Auto-calibrate** learns from this camera's own lamp-off / IR-off snapshots.
It stores a 16×9 tile vector per sample (`/config/guardian/luma-samples.jsonl`),
builds a mask that ignores tiles which stay bright at night (windows, IR
leftover, stair voids) or dark at noon (soffits), takes pixel p25 over the
rest, and derives a hysteresis band biased so almost all night samples sit
below `dark` — the lamp must still come on when the entry is actually dark.
Until that profile passes sanity checks (≥8 night and ≥8 day samples, each
class spanning ≥3 hours, ≥16 relevant tiles, day−night gap ≥30), Auto **does
not guess**: the sampler uses `on_sun` / `off_sun` / twilight `hold` and F-38 /
F-55 still sit behind that. A valid camera number during learning does **not**
increment `guardian_lamp_fail_streak`.

Collection is a jsonl append after the probe has already printed its float, so
a learn failure cannot turn a good reading into F-10 "unavailable". Retune
runs as `script.turn_on` of `script.guardian_lamp_cal_retune` **after**
`guardian_lamp_sampling` is cleared — it does not extend the 60 s watchdog or
the 15 s `command_timeout`. It does not fire during alarm red or challenge
amber; those already own the lamp, and this script is only started from the
sampler's success path after the flag is off.

`last_result` gains a short suffix (`manual` / `learn` / `auto`) so a wrong
auto decision is visible the same way F-42 made a wrong camera number visible.
The helper is still 100 characters.

### New / changed this pass

| Item | What to do |
|---|---|
| `guardian/guardian-luminance.sh` | Copy to `/config/guardian/`. LF endings. `--retune` is the same file. |
| `input_select.guardian_lamp_luma_mode` | New. Default **Manual (this home)**. `initial:` only on first create. |
| `sensor.guardian_lamp_cal` | New command_line. Cats `/config/guardian/luma-cal.txt`. |
| `shell_command.guardian_luma_write_run` / `guardian_luma_retune` | New. Package restart. |
| `script.guardian_lamp_cal_retune` | New. Fired with `script.turn_on` after each sample. |
| `script.guardian_sample_ambient_light` / `script.guardian_reset` | Copy `scripts.yaml`. Reset does **not** delete learned files. |

Host-only files (not in git): `/config/guardian/luma-run.env`,
`luma-samples.jsonl`, `luma-profile.json`, `luma-cal.txt`.

### Verify this pass

44. Copy `guardian-luminance.sh` to `/config/guardian/`, Developer Tools → YAML
    → **Check configuration**, then a **full restart**. Confirm
    `input_select.guardian_lamp_luma_mode` is **Manual (this home)** and
    `input_number.guardian_dark_threshold` / `guardian_bright_threshold` are
    still 45/90 (existing installs ignore YAML `initial:` on those two). Run
    `script.guardian_sample_ambient_light`. `guardian_lamp_last_result` must
    still be one line, now ending `manual`. After dark, `luma=` must still be
    **well below 45** with the downstairs window in the live camera card.

45. **Auto, cold start.** Set the select to **Auto-calibrate**. Run the
    sampler after dark. `last_result` must contain `learn` and `on_sun` (not
    `on_camera`), the lamp must go **on**, and 45/90 must not change.
    `sensor.guardian_lamp_cal` is `0` or unavailable. Repeat by day: `off_sun`
    and the lamp off.

46. **Auto, ready.** After at least one afternoon and one evening of Auto (or
    of Manual — samples are collected in both modes),
    `sensor.guardian_lamp_cal` becomes `1` with `dark` / `bright` attributes
    and a `guardian_lamp_cal_ready` notification. The next night sample should
    read `auto` and still turn the lamp **on** when the entry is dark. If it
    flaps, the gap is too small — switch to Manual rather than editing 45/90.

47. **Switch back.** Set the select to **Manual (this home)** and run the
    sampler. `last_result` ends `manual`. luma is again the bottom-60% p25
    (historical auto `luma=` values are not comparable). 45/90 still decide.

48. **Do not regress seventh-pass safety.** Repeat DEPLOY 39 (bright threshold
    10 after dark → `on_sun_override` while Manual), 41 (mismatch 10 minutes),
    and 42 (sampling flag, watchdog restore, alarm stays red). Point the camera
    entity at nonsense after dark: `FAILED` and `on_sun`. A missing or stale
    `ambient.jpg` must still print nothing from the shell script (exit
    non-zero).

49. **Reset** does not wipe calibration. Press `input_button.guardian_reset`.
    `guardian_lamp_cal_ready` is dismissed; `luma-profile.json` is still on
    disk; the mode select is unchanged.

---

## Ninth pass — configurable RFID slots and visitor keys

Home Assistant files plus a portal reflash. **Full restart**, not a reload:
`packages/guardian_rfid.yaml` is a new package, the occupancy sensors moved,
and `pending_entry_slot` / `pending_exit_slot` grew from max 15 to 32. Copy
HA first, migrate the UI helpers (below), restart, **then** flash the portal.
The doorbell is unchanged.

The slot count used to be the literal `4`, copied independently into Jinja
unrolls, `range(1, 5)` loops, `['1','2','3','4']` whitelists, and a C++
`for (i = 0; i < 4)`. There was no per-slot metadata: each key was an
anonymous hash + At home/Away select, both created by hand in Settings →
Helpers, which is how a helper whose max was under 64 silently truncated
an enrollment.

**After this pass the rack lives in one file.** Edit
[`packages/guardian_rfid.yaml`](packages/guardian_rfid.yaml) to grow or
shrink. Cap is 9 (one keypad digit). Default stays 4. The portal reads
`sensor.guardian_rfid_slot_map.length()` for the box count and the keypad
range, so after **one** firmware flash, adding a slot is HA YAML plus a
restart — no second flash.

A slot now has a policy: `resident` (today's behaviour) or `visitor`
(authorized key, never an occupant). Visitor keys still open the door, still
answer MFA and entry challenges, and can still be flagged Stolen/Lost. They
never flip presence to At home, and occupancy readers (`house_empty`,
Frigate's all-away gate, the portal roster) skip them.

You set the policy from the portal, not from Helpers. During enrollment,
press **0** to toggle guest mode (`PRESENT CARD · GUEST`). The next unknown
card is enrolled as a visitor and forced Away. An already-registered card
tapped in that session updates its policy without rewriting the hash. `#`
still ends the session; `*` still clears the slot choice. The guest flag is
cleared whenever enrollment mode turns on or off.

### One-time helper migration — do this BEFORE the restart that loads the package

Live `input_text.rfid_1_hash` … `rfid_4_hash` and `input_select.rfid_1` …
`rfid_4` are UI helpers. YAML with the same entity ids will conflict.
**Do not copy `packages/guardian_rfid.yaml` onto a running install that still
has those UI helpers.**

1. Developer Tools → Template, dump the live rack (hashes are shown; copy them
   somewhere private, they *are* the keys):

```jinja
{% for i in range(1, 5) %}
{{ i }}: hash={{ states('input_text.rfid_' ~ i ~ '_hash') }}
  max={{ state_attr('input_text.rfid_' ~ i ~ '_hash', 'max') }}
  presence={{ states('input_select.rfid_' ~ i) }}
  options={{ state_attr('input_select.rfid_' ~ i, 'options') }}
{% endfor %}
```

2. Settings → Devices & Services → Helpers: delete the four `rfid_N_hash`
   text helpers and the four `rfid_N` dropdowns. Do not delete anything
   else. The stored hashes die with them — that is why step 1 exists.
3. Copy `packages/guardian_rfid.yaml` into `/config/packages/`, copy the
   updated `packages/guardian.yaml`, `scripts.yaml`, `automations.yaml`.
4. **Full Home Assistant restart.** Packages do not merge on a YAML reload.
   Confirm `sensor.guardian_rfid_slots` is `1,2,3,4`,
   `input_select.rfid_1_policy` is `resident`, and each
   `input_text.rfid_N_hash` has max 64.
5. Restore each hash with Developer Tools → Actions → `input_text.set_value`
   (not Set State). Presence defaults to Away and policy to resident, which
   matches "nobody is home until they scan" and preserves today's
   authorization behaviour. If a card was flagged **Stolen** (without
   `/Lost`), re-select **Stolen/Lost** on that slot — the YAML option list
   is the latter. Scan each remaining card once at the reader they are
   actually on if you want presence corrected immediately.
6. Confirm `sensor.guardian_rfid_slot_map` updates when you clear or write a
   hash **without** a second restart. That is the trigger-based occupancy
   sensors doing the job the Jinja extractor could not.
7. Flash the portal firmware so keypad `0` and `slot_map.length()` exist.

If a leftover UI helper is still winning, enrollment will look like the old
truncation bug (GRANTED, then the card never matches). Delete the UI helper,
restart, restore the hash.

### Growing the rack later (e.g. 4 → 6)

In `packages/guardian_rfid.yaml` only:

1. Duplicate the `rfid_5` / `rfid_5_hash` / `rfid_5_policy` helper triple
   (and 6).
2. Add those entity ids to the occupancy trigger `entity_id` list.
3. Change `sensor.guardian_rfid_slots` to `1,2,3,4,5,6`.

Full restart. The portal picks the new count up from the slot-map string.
Do not leave a whitelist id without helpers, and do not leave a helper
without a whitelist id.

Shrink the other way: `script.guardian_clear_rfid_slot` on the retiring ids
first (so leftover hashes cannot match), then delete the triples / trigger
lines / whitelist ids.

### New helpers created by `packages/guardian_rfid.yaml`

| Helper | Default | Purpose |
|---|---|---|
| `input_text.rfid_1_hash` … `rfid_4_hash` | empty, max 64 | Card hashes. Same entity ids as the old UI helpers. |
| `input_select.rfid_1` … `rfid_4` | Away | Presence. Options: Away / At home / Stolen/Lost. |
| `input_select.rfid_N_policy` | resident | `resident` or `visitor`. |
| `input_boolean.guardian_enroll_as_visitor` | off | Enrollment session flag, toggled by keypad 0. |
| `sensor.guardian_rfid_slots` | `1,2,3,4` | Runtime whitelist every script/automation loops. |

`pending_entry_slot` / `pending_exit_slot` max is now 32 (was 15). Existing
helpers do **not** pick up a new `max:` — raise them by hand in Helpers if
the UI copies are the ones still live, or confirm the YAML copies after
migration.

50. **Migration survived.** After the restart, Developer Tools → States:
    four `rfid_N_hash` helpers, each max 64, restored hashes exactly 64
    characters; four `rfid_N_policy` helpers reading `resident`;
    `sensor.guardian_rfid_slots` = `1,2,3,4`; `sensor.guardian_rfid_slot_map`
    matches occupied/free. A scan of an existing resident card still
    GRANTED.

51. **Occupancy sensors still listen.** Clear slot 2 with
    `script.guardian_clear_rfid_slot` (`slot: 2`). `slot_map` must lose that
    `X` without a second restart. Re-enroll the card.

52. **Visitor enrollment from the door.** Enable enrollment. Press 0. The
    portal must read `PRESENT CARD · GUEST`. Present a spare card. Presence
    for that slot must be Away even if you enrolled at the interior reader.
    Policy must be `visitor`. Enrollment stays on.

53. **Retag an existing card without rewriting the hash.** Still in guest
    enrollment, present a resident card you are not replacing. Expect
    `REGISTERED / Already in slot N`. That slot's policy becomes `visitor`,
    its hash is unchanged, presence is Away. Press 0 again (guest off), tap
    the same card: policy returns to `resident`. Hash still unchanged.

54. **Visitor does not count as home.** With every resident Away and a
    visitor slot that you force to At home in Developer Tools, open from
    inside in elevated mode using the lever: a challenge starts, not the
    empty-house siren. `house_empty` ignores visitors. Put the visitor back
    to Away.

55. **Visitor still authorizes.** Visitor card at the doorbell, door opens
    in the 20s window: GRANTED, opening classified as authorized, visitor
    presence stays Away (or is forced Away). A resident who scanned in the
    same window still flips.

56. **Portal keypad follows the map.** After the firmware flash, enrollment
    with four slots still accepts 1–4 and ignores 5–9. (Growing to 6 is a
    YAML edit you do not have to do now; if you do, 5 and 6 must work
    without another flash.)

---

## Tenth pass — keypad PIN change

Home Assistant files plus a **portal** reflash. The doorbell is unchanged.
**Full restart**, not a reload: new helpers in `packages/guardian.yaml` only
appear at startup. Copy HA first, restart, **then** flash the portal so it
can import `input_boolean.guardian_pin_change_mode`.

Changing the master PIN used to mean Developer Tools → Actions →
`script.guardian_set_pin` with the plaintext typed into a form field. Only
whoever has HA UI access could rotate it, and a non-technical household
member could not do it at the door.

**PIN-change mode is a session, armed from the HA UI, completed at the
keypad.** Turning `input_boolean.guardian_pin_change_mode` **on does not
change the PIN.** The portal asks for the current PIN (`#` to confirm), then
a new PIN (`#` to finish), and only then calls `script.guardian_set_pin`.
There is no re-type step and no password field on the dashboard — only the
same kind of toggle as enrollment. An attacker with only HA UI access still
cannot rotate the PIN. An attacker with only physical access cannot enter
the flow, because the mode has to be armed from the UI first.

It is mutually exclusive with enrollment (the newly enabled mode is
refused). An MFA or entry challenge still wins the keypad; if one starts
mid-session, PIN-change aborts with no change.

Add the boolean to the same dashboard as enrollment. It is off by default.

### New helpers created by `packages/guardian.yaml`

All of these appear automatically on the full restart. Nothing to create by
hand.

| Helper | Default | Purpose |
|---|---|---|
| `input_boolean.guardian_pin_change_mode` | off | UI arming switch. Does not write the PIN. |
| `input_text.guardian_pin_change_step` | `none` | `none` / `current` / `new`. |
| `input_number.guardian_pin_change_fails` | 0 | Mild-path retries. Not written while elevated. |
| `timer.guardian_pin_change_window` | 40 s | Per-step timeout. `restore: false`. |

`script.guardian_set_pin` / `guardian_verify_pin` still exist. Verify now
calls `script.guardian_pin_matches` (the same compare the keypad flow and
the MFA handler use) so the expression cannot drift a third time.

### Verify this pass

57. **Toggle alone does not change the PIN.** Note
    `input_text.portal_pin_hash`. Turn `guardian_pin_change_mode` **on**.
    The portal must show `CURRENT PIN` with a countdown and a repeating
    tone. The hash must be **unchanged**. Turn the mode off (or press `#`
    on an empty buffer). Hash still unchanged.

58. **Happy path.** Arm the mode. Type the current PIN, press `#`. Type a
    new 4–6 digit PIN, press `#`. Expect `GRANTED`, mode **off**,
    `script.guardian_set_pin`'s "master PIN updated" notification, and a
    `pin_change` / `success` row in the data log. Confirm with
    `script.guardian_verify_pin` using the **new** PIN. No helper should
    ever have held the digits.

59. **Wrong current PIN stays on CURRENT.** Arm, enter an incorrect PIN,
    `#`. Expect `DENIED`, then `CURRENT PIN` again, mode still **on**.
    `portal_pin_hash` unchanged.

60. **`#` and timeout abort.** Arm, type one digit, press `#`. Mode off,
    hash unchanged, data log `abandoned`. Arm again and wait 40 s with no
    keys: same. Neither case may increment `mfa_failed_attempts` or raise
    `guardian.major_alarm`, including while elevated mode is on.

61. **Mutex with enrollment.** Turn enrollment on, then PIN-change: PIN-change
    must snap back off and enrollment stay on. Reverse: PIN-change on, then
    enrollment: enrollment snaps back off. The portal must not show both
    screens.

62. **Mild vs alarm (the branching this pass exists to preserve).** Super
    surveillance **off**, night elevation **off**. Arm PIN-change. Enter the
    **wrong** current PIN three times. Expect `DENIED` each time, mode off
    on the third, `mfa_failed_attempts` still **0**, **no**
    `guardian.major_alarm`, data log `failed_mild`. Repeat with super
    surveillance **on**: the third wrong current PIN must fire
    `guardian.major_alarm` (`Maximum PIN attempts exceeded`) and log
    `escalated`. `mfa_failed_attempts` is the counter that reached 3; do
    not invent a second lockout.

63. **Restart cannot strand the flow.** Arm PIN-change so the portal shows
    `CURRENT PIN`, then restart Home Assistant. After Startup State Recovery
    (~30 s) the boolean must be **off**, the display must not still read a
    `PIN_CHANGE_*` state, and the hash must be unchanged. A "PIN change
    cancelled" push is expected.

Developer Tools → Template, while testing:

```jinja
pin_change={{ states('input_boolean.guardian_pin_change_mode') }}
step={{ states('input_text.guardian_pin_change_step') }}
mild_fails={{ states('input_number.guardian_pin_change_fails') }}
mfa_fails={{ states('input_number.mfa_failed_attempts') }}
hash_len={{ states('input_text.portal_pin_hash') | string | trim | lower | length }}
elevated={{ states('binary_sensor.guardian_elevated_mode') }}
display={{ states('input_text.portal_display_state') }}
timer={{ states('timer.guardian_pin_change_window') }}
enroll={{ states('input_boolean.guardian_enrollment_mode') }}
```

`step` is `current` while the portal asks for the existing PIN, then `new`
until `#` finishes. It must never be a 4–6 digit string.

---

## Eleventh pass — the Guardian control panel

Home Assistant files only. **No device reflash, no new helpers, no new
automations, no new scripts.** A **restart** is still required, because
`configuration.yaml` gains a `panel_custom:` block and that is only read at
startup.

Everything Guardian does was reachable only through Home Assistant's
auto-generated dashboard: one flat, undifferentiated list of raw helpers,
where `input_number.guardian_dark_threshold` sits beside
`input_text.pending_exit_slot` with nothing to say that changing the first is
routine and changing the second breaks a passage window. Day-to-day use meant
hunting entity ids, and the risk of editing the wrong one was real and
untracked.

**This pass adds a second UI layer and changes nothing underneath it.** The
panel reads entity state and calls existing helpers and scripts. It has no
automations, no scripts, no template sensors and no business logic of its own.
`automations.yaml`, `scripts.yaml` and `packages/*.yaml` remain the sole source
of truth for behaviour; the panel is a view onto them. Settings → Helpers,
Developer Tools and the existing Lovelace dashboard are all untouched and stay
available — this is the everyday-safe surface, not a replacement for the
administrative one.

Design and architecture are documented separately in **`GUARDIAN_UI.md`**,
including the full entity classification (read-only status vs. safe control vs.
never-exposed internals) and why each control sits where it does.

### What it is, technically

A **Home Assistant custom panel** — one ES module at
`/config/www/guardian-ui/guardian-panel.js`, registered by a `panel_custom:`
block. No HACS, no custom cards, no bundler, no build step, no Python, no
dependencies. Home Assistant injects its own `hass` object, so the panel gets
live state, authenticated service calls, signed camera URLs, recorder history
and the event bus without a token or a second auth path of its own. It appears
in the sidebar as **Guardian** and works identically in the companion app.

`require_admin: false`, deliberately: the point is that a household member who
is not a Home Assistant administrator can use it. What makes that safe is
described below, not the admin flag.

### Security boundaries the panel preserves

These are the existing documented decisions, re-stated as properties of the
panel rather than assumptions about it. Each is enforced structurally.

| Decision | How the panel keeps it |
|---|---|
| The master PIN never transits the HA frontend (tenth pass) | `input_boolean.guardian_pin_change_mode` is a toggle and nothing else. There is no `<input>` anywhere in the file that can accept a PIN, and no call site for `script.guardian_set_pin` / `guardian_verify_pin` — those stay in Developer Tools, where the argument is visible for what it is. |
| Card and PIN digests are unsalted (audit F-20) | No hash value is ever rendered. `input_text.rfid_N_hash` and `input_text.portal_pin_hash` are read for **length only** — 64 characters means occupied, the same rule `packages/guardian_rfid.yaml` uses. |
| Reset is Home Assistant-side only, never on the keypad | It is HA-side here too, and behind a press-and-hold rather than a tap. So are: silencing an alarm, retiring a card slot, flagging a card Stolen/Lost, and rebooting either device. |
| The state machine owns its own helpers | `pending_entry_slot`, `pending_exit_slot`, `pending_mfa_slot`, `pending_mfa_source`, `portal_display_state`, `portal_display_seq`, `guardian_challenge_origin`, the fail counters and the lamp's internal marks are **read-only** in the panel, listed under System → Internals. Tapping one opens Home Assistant's own more-info dialog, which is where an edit belongs. |
| The JSONL data log stays off the network | The Activity view does **not** read `/config/guardian_data_log.jsonl`, and the log must not be moved under `/config/www` to make it readable. `/local` is served **without authentication**, and `card_rejected` rows carry the computed card hash — against unsalted SHA-256 that is a card-cloning oracle for anyone who can reach the host. |

### Activity history — what it can and cannot show

The Activity view has two sources and they are not equivalent.

**Recorder history** covers everything that is an entity state: door
open/close, per-slot presence, alarms with their reason, entry and PIN
challenges, enrollment and PIN-change sessions, elevated-mode transitions,
lamp verdicts, faults, and portal/doorbell connectivity. This is genuine
history — it reads back as far as the recorder keeps.

**The event bus** covers the rest. Rejected cards, door-direction verdicts,
presence corrections and Frigate detections are fired as `guardian.*` /
`esphome.*` events, not entity states, so there is nothing for the recorder to
replay. The panel subscribes to them live, which means **those rows appear only
from the moment the panel is opened.**

That gap is stated rather than closed. Closing it would need a new
trigger-based template sensor holding the last N events — new logic, in a
release whose entire premise is that it adds none. The complete forensic record
remains the JSONL data log on the host, read offline, exactly as before.

### Growing the rack, adding a sensor

The panel reads `sensor.guardian_rfid_slots` at runtime and loops it, the same
way every script and automation in this system does. Going from four slots to
six in `packages/guardian_rfid.yaml` needs **no change to the panel** — the
roster, the rack strip, the enrollment slot picker, the activity feed and the
history query all pick up the new ids on the restart that loads the package.

Entity ids are declared once, in a single registry block near the top of the
file, and resolved through a fallback that also matches by suffix. That is why
Home Assistant renaming the doorbell's entities to the `eisodos_` prefix — which
already happened once, and left the live config carrying two different prefixes
for entities on the same device — does not break the panel a second time.

### New files this pass

| File | Destination | Note |
|---|---|---|
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Create the `guardian-ui` directory. Plain text; line endings do not matter. |
| `configuration.yaml` | `/config/configuration.yaml` | **No longer unchanged.** Gains the `panel_custom:` block. |
| `GUARDIAN_UI.md` | — | Documentation. Not deployed. |

**Cache.** `/config/www` is served as `/local` with long cache headers. The
`?v=` on `module_url` is what makes a browser fetch a new build. When you
update the panel, bump `GUARDIAN_UI_VERSION` in `guardian-panel.js` **and** the
`?v=` in `configuration.yaml` together. If a change does not appear, that is
almost always the reason — the second-most-likely is that the file landed in
`/config/guardian-ui/` rather than `/config/www/guardian-ui/`.

### Verify this pass

64. **The panel loads at all.** After the restart, **Guardian** appears in the
    sidebar with a shield icon. Opening it shows a hero card reading
    *"Guardian is watching"* (or whatever state you are actually in) and five
    tabs. A blank page means the module did not load: open the browser console
    and check for a 404 on
    `/local/guardian-ui/guardian-panel.js` — wrong directory — or a syntax
    error, which means a truncated copy.

65. **It reflects reality, live.** With the panel open, change
    `input_boolean.super_surveillance_mode` from Developer Tools. The hero must
    change to *"A PIN is required to pass"* within a second, with no reload.

66. **The countdown is real.** Arm super surveillance and scan a registered
    card. The hero must show a ring counting down from the MFA window, labelled
    `PIN TIMEOUT`, ticking once a second. Scroll the page while it runs — the
    scroll position must not jump.

67. **No hash is anywhere.** With every slot occupied, open Access. Each slot
    must read *"Card registered"* and nothing else. Search the rendered page for
    any 64-character hex string: there must be none. Same on System →
    Internals — `portal_pin_hash` is deliberately not in that list at all.

68. **PIN change is still keypad-only.** Access → Master PIN → turn the toggle
    on. The portal must show `CURRENT PIN`. `input_text.portal_pin_hash` must be
    unchanged, and the panel must offer no field of any kind to type into.
    Turn it off.

69. **Press-and-hold actually gates.** System → Reset. **Tap** "Hold to reset
    Guardian" and release immediately: nothing must happen. Press and hold for
    a second: the button fills, and `guardian.system_reset` fires (a "system
    reset" push arrives). This is the same test for card retirement and for the
    alarm banner's silence control.

70. **A non-admin household member can use it.** Log in as a non-administrator
    user. Guardian must be in their sidebar, presence and state must render, and
    arming super surveillance must work. Settings must still be absent from
    their sidebar — the panel is an addition to what they can reach, not a
    promotion.

71. **Activity reads back.** Open Activity. Rows must appear for the last 24
    hours: door openings, presence changes, lamp verdicts. Then scan an unknown
    card with the panel open — a *"Card not recognised"* row must appear at the
    top within a second. Close the panel, scan another unknown card, reopen: that
    second scan is **not** in the list, and that is expected, not a bug (see
    above).

72. **A missing entity degrades, it does not crash.** Rename any Guardian helper
    in Settings → Helpers. The panel must keep rendering, with that one row
    showing `—` or "unknown". Rename it back.

73. **Both themes.** Switch Home Assistant between light and dark. The panel
    must follow, with no washed-out or unreadable text in either. Check the
    alarm state in both — it is the highest-contrast case.

Developer Tools → Template, while testing:

```jinja
countdown_ends={{ states('sensor.guardian_portal_countdown_ends') }}
countdown_total={{ states('sensor.guardian_portal_countdown_total') }}
countdown_label={{ states('sensor.guardian_portal_countdown_label') }}
faults='{{ states('sensor.guardian_faults') }}'
presence={{ states('sensor.guardian_presence_summary') }}
slots={{ states('sensor.guardian_rfid_slots') }}
map={{ states('sensor.guardian_rfid_slot_map') }}
lamp={{ states('input_text.guardian_lamp_last_result') }}
```

Those eight are the entities the panel leans on hardest. If the panel looks
wrong, check them here first — the panel is a view, so a wrong value here is a
system problem and a wrong value only there is a panel problem.

---

## Twelfth pass — household-app redesign of the Guardian panel

Home Assistant files. **No device reflash, no new helpers.** A **restart** is
required: `configuration.yaml`'s `panel_custom` `module_url` `?v=` is only
read at startup, and `automations.yaml` gains one event fire on an existing
automation.

The eleventh-pass panel was functionally complete and visually wrong: a
near-black console, five peer tabs, a hero cloned onto every view, and Frigate
presented as "key set / not set". This pass keeps the custom-panel contract
(one ES module, no HACS, no PIN field, no hash, press-and-hold reset) and
rebuilds the product on top of it.

**What changed**

- Four tabs — Home, Camera, Activity, More — with nested screens for keys,
  lamp, security, devices, notifications, install, diagnostics, internals and
  reset. Compact status bar instead of a hero on every tab. Light is the
  default look; dark is a dimmed home app.
- Camera is first-class. Live video still uses signed `camera_proxy` /
  `camera_proxy_stream` URLs. Frigate camera / occupancy / person-image
  entities are discovered from `input_text.guardian_frigate_camera_name`.
  Clips appear only if `media_source://frigate` browses. A Frigate sidebar
  item is opened when `hass.panels` (or `config.frigatePath`) names one.
- `panel_custom.config.lamp` is the light this panel toggles. Lamp
  *automation* in `automations.yaml` / `scripts.yaml` still names
  `light.tapo_lamp`.
- The existing `Guardian: Data Log - Frigate Person Detected` automation now
  also fires `guardian.person_detected` with `{ camera, type, label }` so
  Activity can show live detections to non-admin users without reading the
  JSONL log (audit F-58).

**Cache.** Bump `GUARDIAN_UI_VERSION` in the panel **and** `?v=` on
`module_url` together. This pass is `2.0.0`.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Overwrite. `?v=2.0.0`. |
| `configuration.yaml` | `/config/configuration.yaml` | `module_url ?v=2.0.0`, `config.lamp`, optional `frigatePath`. |
| `automations.yaml` | `/config/automations.yaml` | Event fire on the existing Frigate data-log automation only. |
| `GUARDIAN_UI.md` | — | Documentation. Not deployed. |

Developer Tools → YAML → **Check configuration**, then **restart**. Reload
automations is not enough for the `panel_custom` cache bump.

### Verify this pass

74. **It loads as a home app, not a console.** After the restart, Guardian
    opens on a light canvas (if HA is in light mode) with four tabs: Home,
    Camera, Activity, More. There is no full-width gradient hero on Camera
    or Activity. A blank page is still a 404 or a syntax error — check
    `/local/guardian-ui/guardian-panel.js?v=2.0.0`.

75. **Phone chrome.** On a narrow phone, the four tabs sit in one row, do
    not wrap, and clear the home indicator. Open More → Keys: the top bar
    shows Back and returns to More. Open More → Reset: the hold buttons sit
    in the scroller, not under the tab bar.

76. **Tablet band.** At roughly 700–1000 px wide, the bottom tabs remain.
    There is no left rail and no hidden top bar.

77. **Desktop.** At ≥1100 px a left rail lists the four destinations. More
    shows a list beside the page. Nested Back is in the content, not only
    in a hidden top bar.

78. **Camera, Frigate off.** With no Frigate integration entities, Camera
    still shows the door camera from `input_text.guardian_camera_entity`.
    Live is a green/quiet label, not alarm-red. Pause / Live does not tear
    down the stream on an unrelated state change (scroll the page during a
    challenge). Person detection copy is honest: configured key, live-only
    events, clips in Frigate.

79. **Camera, Frigate on.** If a `camera.*` / occupancy sensor matching
    `door_camera` exists, Camera offers Home camera | Frigate and occupancy.
    If the Frigate add-on is in the sidebar, **Open Frigate** goes there.
    If `media_source://frigate` is empty, no fake clip strip.

80. **Live Frigate row.** With the panel on Activity → Camera, walk past
    the door camera so `frigate/events` fires (MQTT must actually be
    configured — see the Frigate notes at the end of this file). A "Person
    at the door" row must appear without a reload. Close the panel, walk
    past again, reopen: that walk is **not** in the list unless Frigate
    published an occupancy binary sensor, which *is* recorder history.

81. **Install / shareability.** More → Install. Camera, IR, Frigate key and
    phone fields are helpers with empty-looking placeholders, not a wall of
    `unknown`. The lamp row names `config.lamp`. Rename
    `input_text.guardian_camera_entity` away from a real camera: Home peek
    and Camera degrade; the panel does not crash.

82. **Doorbell status light.** Camera (and More → Devices → Doorbell) shows
    the onboard LED when that entity exists. It was registered and unrendered
    in 1.0.0.

83. **Security boundaries still hold.** Access/Keys still has no PIN field.
    Search the rendered page for a 64-character hex string: none. More →
    Reset: tap-and-release does nothing; hold fires `guardian.system_reset`.
    Internals still lists `guest_bypass` as unused.

84. **Both themes, both densities.** Switch HA light/dark. Check alarm and
    idle. Check a 320 px-wide window and a 1400 px window.

Developer Tools → Template, same eight entities as step 73, plus:

```jinja
camera='{{ states('input_text.guardian_camera_entity') }}'
frigate='{{ states('input_text.guardian_frigate_camera_name') }}'
lamp={{ states('light.tapo_lamp') }}
```

---

## Thirteenth pass — panel scroll, mobile menu, door camera, lamp colour

Home Assistant files. **No device reflash.** A **restart** is required:
`configuration.yaml`'s `panel_custom` `module_url` `?v=` is only read at
startup. `packages/guardian.yaml` changes `input_text.guardian_camera_entity`
`initial:` to `camera.door_camera`; that does **not** rewrite an existing
helper — Save it from More → Install after deploy, or set it in Developer
Tools → States.

**What changed**

- The panel host fills the Home Assistant content area. Only the inner
  scroller moves, so Camera / More / Activity can be scrolled on a phone and
  a PC, and the bottom tab bar stays on screen.
- Below 1100 px the top bar has a menu button that opens Home / Camera /
  Activity / More. Nested pages still have Back. Desktop keeps the single
  left rail; More is no longer a second sidebar.
- Live view prefers `camera.door_camera` when the helper is still empty,
  `none`, or `camera.tapo_c110`. Lamp sampling keeps reading the helper as
  stored until Save. Install fields have a visible Save button; leaving the
  page also flushes a dirty field.
- More → Lamp has a Tapo-style colour wheel, brightness, white temperature
  and presets. Ambient automation still owns on/off.

**Cache.** Bump `GUARDIAN_UI_VERSION` in the panel **and** `?v=` on
`module_url` together. This pass is `2.1.0`.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Overwrite. `?v=2.1.0`. |
| `configuration.yaml` | `/config/configuration.yaml` | `module_url ?v=2.1.0`, `config.camera: camera.door_camera`. |
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | `guardian_camera_entity` initial `camera.door_camera`. Full restart. Existing helper value is unchanged until Save. |

Developer Tools → YAML → **Check configuration**, then **restart**. Reloading
automations is not enough for the `panel_custom` cache bump.

### Verify this pass

85. **Scroll.** Open Camera. The doorbell card including Status light is
    reachable by scrolling on a phone and on a desktop browser. The bottom
    tabs (phone) stay visible; they are not clipped off the screen.

86. **Phone menu.** On a narrow phone, the top bar shows a menu icon. It
    opens Home / Camera / Activity / More. Home from that menu returns to
    the home view. Nested More → Keys still shows Back.

87. **More is one column.** At ≥1100 px, More does **not** grow a second
    left list beside an empty "Choose a section". The section list is in
    the main column; opening Keys replaces it, with in-content Back.

88. **Door camera.** Camera → Home camera shows `camera.door_camera` even
    if the helper still reads `camera.tapo_c110`. More → Install: the
    camera field shows `camera.door_camera` with Save enabled. Tap Save,
    leave the page, come back: it is still `camera.door_camera`.
    Developer Tools → States confirms the helper.

89. **Lamp colour.** More → Lamp. With `light.tapo_lamp` on, the colour
    wheel, brightness slider, White/Colour toggle and preset dots work.
    Home still has the on/off switch; the colour dot opens this page.
    A luminance sample still turns the lamp on or off afterwards.

90. **Press feedback.** Tapping Arm, Pause/Refresh/Open, a More row, or a
    tab changes colour (and slightly scales) on press. Reduced-motion OS
    setting removes it.

Developer Tools → Template, same entities as step 84, plus confirm:

```jinja
camera='{{ states('input_text.guardian_camera_entity') }}'
door={{ states('camera.door_camera') }}
lamp_mode={{ state_attr('light.tapo_lamp', 'color_mode') }}
```

---

## Fourteenth pass — enrolled cards surviving a Home Assistant restart

Home Assistant files only. **Full restart**, not a reload: the rack helpers
live in `packages/guardian_rfid.yaml` and packages are merged at startup.
No portal or doorbell reflash. The control panel is unchanged; it was
already reading occupancy from hash length, so an empty rack on that
screen was the hashes actually being empty, not a second copy of the
list going stale.

**Enrolled cards were forgotten after some time, then denied, and the
Guardian panel showed no keys registered.** "Some time" was a Home
Assistant restart (update, host reboot, add-on restart, config change).
Enrollment itself was fine: `process_rfid_scan` wrote a 64-character
SHA-256 through `input_text.set_value`, the card GRANTED, occupancy
went to `X`. The next start wiped every `input_text.rfid_N_hash` to
empty, `sensor.guardian_rfid_slot_map` became `----`, the panel counted
zero registered keys, and the same card was `DENIED_CARD`.

The ninth pass moved the rack from UI helpers (no `initial`, restore
works) into YAML with `initial: ''` on the hashes and `initial: Away` /
`initial: resident` on the selects. Home Assistant `input_text` (and
`input_select`) are explicit: **if `initial` is set to any value,
including empty, that value is applied on every start and restore is
skipped.** UI-created helpers typically have no `initial` in storage, so
they survived; the YAML copies did not. Comments elsewhere in this repo
that "`initial:` only applies when the helper is first created" are true
for some helper types and for UI helpers, and **false for YAML
`input_text` / `input_select`**. That is what made `initial: ''` look
safe.

`guardian_enroll_as_visitor` still has `initial: false`. That is a
session flag; resetting it on start is correct. Ephemeral helpers in
`packages/guardian.yaml` (`pending_*`, `guardian_enrollment_slot`,
display state) should keep `initial:` so a restart clears in-flight
state. Other YAML `input_text` helpers that hold *configuration*
(`guardian_camera_entity`, `guardian_frigate_camera_name`,
`guardian_presence_trackers`, …) have the same restore-skip if they
declare `initial:` — out of scope this pass.

There is no second store. The UI helpers already survived on
`.storage/core.restore_state`; omitting `initial:` puts the YAML rack
back on that path. Developer Tools → States **Set State** still does
not persist — use enrollment or `input_text.set_value`.

If a restart has already emptied the hashes, this pass cannot invent
them back. Re-enroll (or `input_text.set_value` each 64-character
digest), then restart once more to prove they stick.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian_rfid.yaml` | `/config/packages/guardian_rfid.yaml` | Full restart. No `initial:` on hashes, presence, or policy. |

### Verify this pass

91. **Lengths before the restart.** Developer Tools → Template:

```jinja
{% set ids = (states('sensor.guardian_rfid_slots') | string).split(',')
             | map('trim') | reject('eq', '') | list %}
map={{ states('sensor.guardian_rfid_slot_map') }}
{% for i in ids %}
{{ i }}: len={{ states('input_text.rfid_' ~ i ~ '_hash') | string | trim | lower | length }}
  presence={{ states('input_select.rfid_' ~ i) }}
  policy={{ states('input_select.rfid_' ~ i ~ '_policy') }}
{% endfor %}
```

    Occupied is 64 after trim/lower. If every length is 0, the previous
    restart already wiped them — skip to 93, then come back to 92.

92. **A restart does not empty a 64-character hash.** Copy the updated
    package, **Check configuration**, full restart. Re-run the template.
    Lengths, presence (including Stolen/Lost) and policy (including
    visitor) must match step 91. Guardian → More → Keys must show the
    same number of registered keys as `X` characters in `slot_map`.
    Scan a card that was enrolled before this restart: `GRANTED` (or
    MFA if elevated), never `DENIED_CARD`.

93. **Empty rack recovers and then sticks.** If step 91 was all zeros:
    enable enrollment, present each card, confirm 64-character hashes
    and the panel showing them registered. Full restart. The template
    must still show those 64-character lengths and the same card must
    still GRANTED. Do not plant hashes with Set State.

94. **Clear still works.** `script.guardian_clear_rfid_slot` with
    `slot: 1` (or a spare). That length becomes 0, `slot_map` loses
    that `X`, without a second restart. Re-enroll if you still need
    the card.

---

## What is NOT copy-paste

| | Why it is different |
|---|---|
| `esphome/secrets.yaml` | **Two extra keys**, `doorbell_unit__ip` and `guardian_rfid_mac_key` (64 hex characters, identical on both devices). Either missing key is a build-time failure. |
| `guardian/guardian-luminance.sh` | **Eighth pass: copy to `/config/guardian/`.** LF line endings. Replaces the seventh-pass crop-only copy. Runtime files (`luma-*.jsonl` / `.json` / `.txt` / `.env`) are created on the host; do not copy them from another machine. |
| Helper *values* | For **YAML `input_text` / `input_select`**, `initial:` is applied on **every Home Assistant start** and skips restore (fourteenth pass: that is how enrolled RFID hashes were wiped). Omit `initial:` on anything that must survive a restart. For UI-created helpers, and for some other helper types, `initial:` is first-create only and an existing value must be changed by hand. |
| Frigate | No config change this release. The clips-not-reaching-the-NAS problem is host-side — see the separate section at the end. |
| `www/guardian-ui/guardian-panel.js` | **Eleventh pass: copy to `/config/www/`, not `/config/`.** `/config/www` is what Home Assistant serves as `/local`; anywhere else and the panel 404s. The `?v=` in `configuration.yaml` must be bumped alongside `GUARDIAN_UI_VERSION` in the file itself, or browsers keep serving the cached build. |

> **This release requires reflashing BOTH units.** Previous releases left the
> doorbell untouched; this one does not. The doorbell gains an API status sensor
> and an explicit address, and the portal gains the doorbell indicator, the PIN
> screen fix and the connectivity changes.
>
> **Order matters:** deploy the Home Assistant files and restart *first*, then
> flash the portal, then the doorbell. The portal imports three new HA entities
> and renders blanks until they exist.

---

## File map

| Repo | Destination |
|---|---|
| `automations.yaml` | `/config/automations.yaml` |
| `scripts.yaml` | `/config/scripts.yaml` |
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` |
| `packages/guardian_rfid.yaml` | `/config/packages/guardian_rfid.yaml` (**ninth pass**, new. UI RFID helpers must be deleted first — see ninth pass. **Fourteenth pass:** no `initial:` on hashes / presence / policy. **Fifteenth pass:** `rfid_N_card_id` + `rfid_N_counter`; occupancy is 16-hex card_id. **Nineteenth pass:** slots 1–9, `rfid_N_name`, `guardian_enroll_pending_name`, presence roster / key labels; occupancy skips empty slots.) |
| `esphome/portal-unit.yaml` | ESPHome dashboard → **rebuild and flash** |
| `esphome/doorbell-unit.yaml` | ESPHome dashboard → **rebuild and flash** |
| `esphome/components/guardian_rfid/` | Copy next to the device YAML (`/config/esphome/components/guardian_rfid/` if compiling in the ESPHome add-on). Local `external_components` path is relative to the YAML. |
| `guardian/guardian-luminance.py` | `/config/guardian/guardian-luminance.py` (**twenty-third pass:** command_line and `--retune` invoke this. Python accepts CRLF.) |
| `guardian/guardian-luminance.sh` | `/config/guardian/guardian-luminance.sh` (thin `exec python3` wrapper. LF. Not what HA runs.) |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` (**eleventh pass**, new. Create the directory. Not `/config/guardian-ui/`. **Twenty-third pass:** `2.7.0`.) |
| `www/guardian-ui/set-default-panel.js` | `/config/www/guardian-ui/set-default-panel.js` (**twenty-ninth pass**, new. Same directory as the panel. Loaded on every page via `frontend.extra_module_url`.) |
| `configuration.yaml` | `/config/configuration.yaml` (**eleventh pass**: gains the `panel_custom:` block. **Twenty-third pass:** `?v=2.7.0`. **Twenty-ninth pass:** `frontend.extra_module_url` so Guardian is the system landing page.) |

`frigate/config.yml` is comment-only this pass (why luma rotates instead of go2rtc). No Frigate restart.

---

## Order

> **Historical — fourteenth pass. Superseded by [`INSTALL.md`](INSTALL.md).**
> Kept as the record of what that release asked for, not as instructions. Step 5
> below tells you to set `input_boolean.guardian_night_elevation`, a helper that
> was removed several passes ago and exists nowhere in this tree; the helper
> values it lists are now applied by `script.guardian_setup_wizard` on first
> boot. Do not follow this section on a new install.

### 1. Backup

Settings → System → Backups → full backup.

### 2. Home Assistant files

Copy `automations.yaml`, `scripts.yaml`, `packages/guardian.yaml`, and
`guardian/guardian-luminance.sh` to `/config/guardian/` with LF line endings.

Eleventh pass adds two more: `configuration.yaml` to `/config/`, and
`www/guardian-ui/guardian-panel.js` to `/config/www/guardian-ui/` — create that
directory first. `configuration.yaml` is the reason this pass still needs a
restart despite touching no helpers: `panel_custom:` is read at startup only.

Developer Tools → YAML → **Check configuration**, then **restart**. A full
restart, not a reload: `packages/` is only merged at startup, so the new helpers,
the two new template entities and `binary_sensor.guardian_elevated_mode` will not
appear otherwise. The eighth-pass helpers (`guardian_lamp_luma_mode`,
`sensor.guardian_lamp_cal`, the two lamp `shell_command`s) appear on that
same restart. Leave `guardian_lamp_luma_mode` on **Manual (this home)** unless
you intend to start Auto-calibrate. The tenth-pass PIN-change helpers
(`guardian_pin_change_mode` and its step / pending-hash / fail counter /
40 s timer) appear on that restart too; flash the portal afterwards so it
can import the boolean. The doorbell is unchanged this pass.

### 3. Prove notifications work — before anything else

Developer Tools → Actions → **`script.guardian_notification_selftest`**.

Everyday alerts go through `script.guardian_notify_broadcast` /
`script.guardian_notify_person`. Recipients are the phones linked on each
RFID slot (`input_select.rfid_N_notify_target`), drawn from
`sensor.guardian_notify_targets_available`. If no slot has a phone linked,
broadcast fans out to every object id on that sensor. Every call site sets
`continue_on_error`, so a broken target fails silently — which is the most
likely reason you have never received a Guardian notification.

The script leaves one of two persistent notifications:

| What you see | What it means |
|---|---|
| "self-test passed" **and** a phone buzzes | Working. Continue. |
| "self-test passed" but **no phone buzzes** | Routing is fine; the problem is on the device. Check the companion app's notification permissions and battery optimisation. |
| "self-test running" still showing, no "passed"/"FAILED" | The call raised. Confirm `sensor.guardian_notify_targets_available` lists your companion-app notify object ids (Developer Tools → States) and that Keys, People & Alerts can pick them. |

### 4. Set the master PIN properly

**This is the fix for "the PIN is never accepted."** `input_text.portal_pin_hash`
was previously filled in by hand, and the verifier compared it case-sensitively
against a lowercase SHA-256. Windows tooling (`Get-FileHash`, `certutil`) emits
**uppercase** hex — 64 characters, so it looked correct and passed every sanity
check, and could never match.

Developer Tools → Actions → **`script.guardian_set_pin`**, enter your PIN (4–6
digits). Then **`script.guardian_verify_pin`** with the same PIN — it must report
"PIN matches". Neither script writes the PIN anywhere in plaintext.

If the action fails with **`'int' object has no attribute 'encode'`**, the
copy of `scripts.yaml` on the host is older than this fix: Developer Tools
passes a digits-only PIN as an integer, and `sha256` needs a string. Copy
the updated `scripts.yaml`, reload scripts or restart, and run it again.

If `guardian_set_pin` reports the hash was **rejected**, the
`input_text.portal_pin_hash` helper has a maximum length below 64 and truncated
it. Raise it in Settings → Devices & Services → Helpers and run the script again.

Verification now tolerates a legacy uppercase or whitespace-padded hash, so your
existing cards keep working — but set the PIN through the script anyway, so the
two sides can never drift apart again.

### 5. Set the helper values by hand

These will **not** pick up their new `initial:` values on an existing install:

| Helper | Set to | Why |
|---|---|---|
| `input_boolean.guardian_night_elevation` | **off** | Confirm this. It is the old hardcoded "PIN required 00:00–05:00" rule, now opt-in. With it off, switching super surveillance off genuinely disables all PIN challenges. |
| `input_text.guardian_camera_ir_entity` | your C110 night-vision entity | Still outstanding from the previous release. The lamp is now correct without it, but the camera keeps measuring nonsense at night until it is set. |
| `input_text.guardian_frigate_camera_name` | `door_camera` | Still outstanding. Person-detection stays dead until changed. |
| `input_boolean.guardian_verbose_notifications` | off | On is useful for a day or two while confirming the fixes; it pushes every lamp decision and every rejected card. |

### 6. Add the doorbell's IP to `esphome/secrets.yaml`

```yaml
doorbell_unit__ip: "192.168.0.174"
```

Use the address reserved for the doorbell in your router's DHCP table. If there
is no reservation, make one first — the device still gets its address by DHCP,
and this value only tells Home Assistant where to look, so the two must agree.

The doorbell build **will fail** until this key exists. That is intentional: a
silently wrong address here is far harder to diagnose than a build error.

### 7. Flash the portal, then the doorbell

ESPHome dashboard → `portal-unit` → Install → Wirelessly, then `doorbell-unit`.

Both units gain a `Status` entity. The portal also gains `Restart` and `Restart
in Safe Mode` buttons, which it never had.

---

## Verify

### Before anything else — the parse check

Run this on the repo before copying `scripts.yaml` or `automations.yaml` to the
Pi. It takes a second and it catches the one class of mistake that is invisible
in review and silent at runtime:

```bash
python -c "import yaml,re; s=yaml.safe_load(open('scripts.yaml',encoding='utf-8')); a=yaml.safe_load(open('automations.yaml',encoding='utf-8')); t=open('scripts.yaml',encoding='utf-8').read()+open('automations.yaml',encoding='utf-8').read(); i=[x.get('id') for x in a]; print('missing scripts:', sorted(c for c in set(re.findall(r'script[.]([a-z0-9_]+)', t)) if c not in s and c not in ('turn_on','turn_off','toggle','reload'))); print('duplicate automation ids:', sorted({x for x in i if i.count(x)>1}))"
```

Both lists must be empty, apart from the known non-call `guardian_lamp_`, which
is the glob `script.guardian_lamp_*` inside a comment at the top of
`process_rfid_scan`.

Why this exists. YAML mappings allow duplicate keys and Home Assistant keeps the
*last* one, so deleting a top-level script key by accident does not fail — it
silently welds that script's body onto the previous one. That is exactly what
happened to `guardian_clear_entry_challenge`: a hunk that appended steps to
`guardian_lamp_warning` swallowed the blank line and the key after it, so
`script.guardian_lamp_warning` became the clear-challenge script. The Elevated
Opening Supervisor calls that script to hold the lamp amber, which meant every
unauthorised opening in Super Surveillance cancelled its own challenge about a
second after raising it: no countdown, no amber, no chirp, no alarm, and the
callers of the real clear script failed with "service not found" on a correct
card+PIN. Nothing in Home Assistant's own config check reports either fault.

The same command also catches a reused automation `id`. An id is the entity's
unique_id: Home Assistant registers the first and rejects the rest, so a
copy-pasted id makes an automation quietly not exist. Two notify-target
automations were lost that way, which is why no RFID slot could hold a linked
phone and every Guardian alert fell back to the legacy phone group.

### The lamp

1. Run `script.guardian_sample_ambient_light` by hand.
   `input_text.guardian_lamp_last_result` must show something like
   `22:20 luma=31.4 sun=-12.3 on_camera`. That one line is now the whole story:
   what it measured, where the sun was, and what it decided.

2. **The decisive test.** After dark, set
   `input_number.guardian_bright_threshold` to `10`, forcing the camera reading
   to demand "lamp off", and run the sampler. **The lamp must switch on anyway**,
   and the result must read `on_sun_override`. Restore the threshold to `90`.

3. Point `input_text.guardian_camera_entity` at a nonsense value and run the
   sampler after dark. The lamp must still come on (`on_sun`) and the result must
   read `FAILED`. Run it three times — a push must arrive on the third.

4. Confirm the portal's status strip no longer shows a permanent amber warning
   triangle. Two separate false faults fed it: `LUMA`, because the luminance
   sensor is *expected* to be unavailable between samples, and `IMU`, which had
   been inverted so it reported a fault whenever the IMU was healthy.

5. If a "camera brightness disagrees with the sun" notification appears, the lamp
   is being driven correctly but the camera is lying — set the IR entity from
   step 5 above.

6. Watch `light.tapo_lamp` in the logbook overnight. If it still switches off at
   a time no Guardian automation ran, something outside Home Assistant is doing
   it — check the Tapo app's own schedules and Away mode. Nothing in this repo
   can see those.

### PIN and cards

7. With super surveillance **on**, scan a card → PIN screen → correct PIN →
   `GRANTED`. This was not previously possible.
8. Enter one wrong PIN, let the window expire, then start a fresh challenge. The
   screen must read **3 left**, not 2 — the counter is now per-challenge.
9. Press `#` on an empty keypad three times. Nothing must happen and
   `input_number.mfa_failed_attempts` must stay 0. Previously each press was a
   counted failed attempt and three of them raised a full alarm.
10. Present an unregistered card in normal mode. The portal must read
    **DENIED / Card not recognised** — never "PIN tries left".
11. Confirm `guardian_night_elevation` is off, then scan a card at 02:00. No PIN
    challenge.
12. Start a challenge, then switch `super_surveillance_mode` **off** mid-
    challenge. The challenge must clear within seconds and **no alarm** must
    fire.

### Reset and self-healing

13. Set `input_boolean.portal_mfa_pending` to `on` by hand with no timer running.
    Within two minutes `Guardian: Auth State Watchdog` must clear it and leave a
    notification — with no intervention.
14. Set `input_text.portal_display_state` to `ALARM` by hand, then press
    `input_button.guardian_reset`. The siren stops, the display returns to
    `IDLE`, all four pending helpers read `none`, and `mfa_failed_attempts` is 0.

### Doorbell status — the new feature

15. Power the doorbell down. The portal's `DB` dot must go red within seconds,
    the diagnostics page must read `OFFLINE <n>m`, and a push must arrive after
    five minutes. Power it back up: green, and a recovery push.
16. Stop Home Assistant. The portal must show `NO LINK` **and the `DB` dot must
    go grey** — not green, not red. The value comes from Home Assistant, so with
    Home Assistant unreachable its age is unknown and any colour would be a lie.

### Connectivity

17. Watch `binary_sensor.guardian_interior_portal_status` and
    `binary_sensor.smart_doorbell_doorbell_link` for 24 hours. Every gap is now a
    recorded disconnect rather than something inferred from a door sensor.
18. If drops continue, ping both units by IP continuously and compare against
    resolving them by `.local` name. Name resolution failing while the IP
    responds confirms the mDNS diagnosis below.

### Stage B — the elevated-mode circumstance fixes

These are the checks for the eight paths the elevated-mode audit found silent.
Most of them can only be confirmed at the real door.

**Copy `packages/guardian.yaml` and restart before testing any of this.** Two new
helpers live there — `input_number.guardian_empty_house_grace_seconds` and
`input_number.guardian_challenge_seconds_applied` — and test 23 reads both.
Nothing breaks if they are missing (every reader falls back to the configured
challenge length, and the one write is `continue_on_error`), but the short
window and the countdown scaling will not be there to see.

19. **Occupancy simulation during an alarm.** Raise a major alarm after dark with
    elevated mode on (`input_text.portal_display_state` to `ALARM` by hand is
    enough), then run `script.guardian_occupancy_pulse` directly. **Nothing must
    happen** — the lamp must stay full red. Before this, the pulse replaced red
    with 2700 K warm white and then handed the bulb to `guardian_restore_lamp`,
    which refuses to restore a Guardian hold colour and so turned the lamp *off*:
    the alarm's most visible signal, extinguished by the simulation. Repeat with
    `input_boolean.guardian_entry_challenge` on instead of the alarm; the amber
    hold must survive too.

20. **Portal offline while elevated.** With elevated mode **on**, power the
    portal down and leave it down. A high-priority push must arrive at **90
    seconds**, saying elevated mode is on and door openings are not being
    detected — and then **nothing further at five minutes**. One outage must
    produce exactly one push. Power it back up and confirm the single recovery
    message. Repeat with elevated mode **off**: no push at 90 seconds, the
    ordinary one at five minutes.

21. **Stranded CHALLENGE screen.** Set `input_text.portal_display_state` to
    `CHALLENGE` by hand with `input_boolean.guardian_entry_challenge` off. Within
    two minutes `Guardian: Auth State Watchdog` must clear it, exactly as test 13
    does for `MFA`. `Guardian: Portal LED Mirror` deliberately gives the
    CHALLENGE screen no return-to-IDLE delay, so before this branch existed that
    screen sat there indefinitely.

22. **A clone presented to a live challenge.** Open an elevated-mode challenge,
    then present a card whose rolling counter is stale (the copy, not the
    original). The portal must read `CLONE`, the owner must get the critical
    push — **and the siren must start immediately**, with
    `input_text.guardian_alarm_reason` naming the clone and its slot. It used to
    show CLONE and then wait out the rest of the window in silence.

23. **The empty-house pair. This one is a decision, not a pass/fail.** Run the
    same test twice: open the door from inside, corroborated by the lever, with
    elevated mode on and every occupied resident card reading `Away`.
    - With `input_text.guardian_presence_trackers` populated and every tracker
      `not_home`: **instant siren**, as before.
    - With that helper empty, or with any tracker `home`: **a shortened
      challenge** of `input_number.guardian_empty_house_grace_seconds` seconds
      (10 by default), which still becomes the same full alarm if nobody answers.
      Confirm the portal countdown bar is scaled to the short window and empties
      cleanly, and that the timeout alarm reason says `within 10s` and not
      `within 30s`. Those two surfaces read
      `input_number.guardian_challenge_seconds_applied`, which the supervisor
      writes immediately before starting the timer.

24. **Door left open.** With elevated mode on and no challenge running, prop the
    door open. A high-priority push at **two minutes**, a full alarm at **five**.
    Then repeat with a challenge running — neither must fire, because the
    challenge already owns that opening and is counting down to its own alarm. A
    door genuinely propped open on a summer evening will trip this; the two
    `for:` values in `Guardian: Door Left Open` are what to raise.

25. **Two PINs at once.** Open a challenge, then submit the master PIN from the
    keypad and from the phone within a second of each other. Both attempts must
    be *evaluated* — a wrong one must increment
    `input_number.mfa_failed_attempts`. Under the old `mode: single` on
    `script.guardian_pin_matches` the second call was dropped with a log warning
    and its attempt was never counted at all, which is the same brute-force gap
    `mode: queued` was introduced on the PIN handler to close.

26. **Nothing was weakened.** With elevated mode **off**, scan a card, walk
    through inside the 20 s window, and confirm presence flips as it always did
    and no challenge opens. That path was not touched and must not have moved.

27. **Alarm stays up if the door is worked again.** Raise a full alarm (open
    the door in elevated mode and wait out the challenge, or set
    `input_text.portal_display_state` to `ALARM` by hand and fire
    `guardian.major_alarm`). Then close and reopen the door. **The siren must
    keep running** and the portal must stay on `ALARM` — not flip back to
    `CHALLENGE`, not start a new countdown, not send another unauthorised-opening
    push. The supervisor used to treat the timeout's teardown (challenge flag
    off so the lamp can see ALARM) as permission to open a fresh grace window,
    which is how working the door extended grace indefinitely. Dismiss from the
    phone is the only way off `ALARM`.

28. **Occupancy / sampler during a challenge.** With
    `input_boolean.guardian_entry_challenge` on (or the doorbell-exit PIN window
    on), run `script.guardian_sample_ambient_light` and
    `script.guardian_occupancy_pulse` directly. Neither must change the lamp
    colour. The sampler's last-result line must read `challenge hold`. Repeat
    with `ALARM` on the display; last-result must still read `alarm hold`.

---

## The network switch

Two of the four reported problems started with the switch upgrade, and the same
handful of switch features explain both.

1. **IGMP snooping** — disable it, or enable an IGMP querier on that VLAN. A
   switch that prunes multicast without a querier kills mDNS, and mDNS is how
   Home Assistant used to find the doorbell. `use_address` in this release makes
   the doorbell immune, but anything else relying on discovery is still affected.
2. Confirm the portal's static address in `esphome/secrets.yaml` is **outside** the router's DHCP
   pool, and that the doorbell's reservation matches `doorbell_unit__ip`.
3. Disable EEE / green ethernet on the Home Assistant and NAS ports. It saves
   negligible power and is a known cause of intermittent link drops.
4. Enable portfast / edge-port on access ports. Without it, STP blocks for ~30
   seconds after every link event.
5. Keep MTU consistent end to end. Do not enable jumbo frames unless every device
   on the path agrees — a mismatch lets small packets through while large
   transfers stall, which is exactly what a working mount that never writes looks
   like.
6. Confirm the switch has not placed IoT devices and Home Assistant on different
   VLANs.

---

## Frigate clips not reaching the NAS

No configuration in this repo can fix this — the mount is host-side. But the
mechanism is worth stating, because it explains the confusing part of the
symptom.

**Frigate hardcodes `/media/frigate`, and its events database lives in the
add-on's own config directory.** So when the media mount is stale, read-only or
missing, the database keeps recording events and the UI keeps listing them, while
recordings and thumbnails go nowhere. Events with no thumbnail are not a cache
problem — those files were never written, and they will never appear.

Work through these in order, stopping at the first failure:

1. **Settings → System → Storage.** Is the `frigate` mount connected? Its usage
   must be **Media** and its name must be exactly `frigate`, because Home
   Assistant mounts media shares at `/media/<name>` and Frigate will not look
   anywhere else. Renaming that share silently disables recording.
2. **Restart the Frigate add-on**, even if the mount now looks healthy. A
   container that was running when the mount dropped keeps the stale mount
   namespace; re-establishing the mount underneath it changes nothing until the
   add-on restarts. Mount first, then add-on.
3. **Read the Frigate add-on log** for `Unable to write`, `Read-only file
   system`, `permission denied`, `Failed to create directory`, `No space left`.
4. **From the SSH add-on:**

```bash
ls -la /media/frigate/recordings && df -h /media/frigate && touch /media/frigate/.write_test && rm /media/frigate/.write_test
```

   A mount that reads but will not write is the most common post-switch state.
5. **Compare the two NAS shares.** Backups working proves the NAS is up — not
   that this export is reachable *and* writable. Check the protocol (NFS vs SMB),
   and for NFS the export's host ACL and squash setting. If the switch change
   altered Home Assistant's IP, an IP-restricted export would fail while the
   backup share, with a broader ACL, keeps working. **This is the most likely
   single cause.**
6. **Switch side** — the list above, particularly MTU.
7. **Verify with a fresh detection**, not by reloading old events.

Two things to note while you are in there:

- **`frigate/config.yml` has no `mqtt:` block**, yet `Guardian: Frigate Person
  Detected While Away` and its data log both trigger on the `frigate/events`
  topic. If MQTT is not configured for the add-on, that burglar alert has never
  fired. Verify by subscribing to `frigate/events` in Developer Tools → MQTT
  while walking past the camera.
- `record.continuous.days: 0` + `record.motion.days: 0` + `mode: active_objects`
  means **only person-event sub-segments are retained, by design**. If you expect
  the NAS to fill with continuous footage, the config forbids it. That is a
  decision to revisit, not a fault.

---

## Fifteenth pass — on-card rolling authenticator

Factory UID is no longer the credential. Cheap magic-card clones of an
enrolled UID were a perfect key: both readers sent only the UID, Home
Assistant hashed it, and nothing was read from or written to the card.
This pass puts an HMAC and a rolling counter in NTAG user memory, verified
and rotated **on the ESP while the card is still on the coil**. Home
Assistant stores `card_id` + `last_counter` and rejects a dump clone after
the real key (or the copy) has rotated past it.

**UID-only cards, including MIFARE Classic, cannot be enrolled.** Use
genuine NTAG213 (or 215). Every existing key must be re-enrolled. The
master PIN is unchanged and is the recovery path if a write desyncs a
card.

**Order matters:** Home Assistant full restart first (new helpers), then
flash the portal, then the doorbell, then re-enroll. Copy
`esphome/components/guardian_rfid/` next to the device YAML. Add
`guardian_rfid_mac_key` to `esphome/secrets.yaml` — 64 hex characters,
**the same value on both devices**. Generate with
`python -c "import secrets; print(secrets.token_hex(32))"`. Changing the
key invalidates every card.

A tap is still nearly instantaneous (~50–80 ms on-device). Hold the card
if the portal says HOLD CARD (enrollment write failed). Day-to-day grants
do not wait on Home Assistant to write the card.

### New helpers created by `packages/guardian_rfid.yaml`

All of these appear on the full restart. No `initial:` on credentials or
counters (same restart-wipe trap as the fourteenth pass).

| Helper | Default | Purpose |
|---|---|---|
| `input_text.rfid_1_card_id` … `rfid_4_card_id` | unset, max 16, password | On-card identifier. Occupied = 16 lowercase hex. |
| `input_number.rfid_1_counter` … `rfid_4_counter` | unset / 0 | Last accepted rolling counter. Shared by both readers. |
| `input_text.rfid_N_hash` | still declared | **Not a credential.** Cleared on enroll and on `guardian_clear_rfid_slot` so a leftover UID digest is not a cloning oracle. |

`sensor.guardian_rfid_free_slots` / `slot_map` / enrollment target now
key off card_id, not hash length 64.

### What changed in the readers

Stock `rc522_i2c` turns the antenna off before `on_tag`, so YAML cannot
read or write NTAG pages. Both units replace it with the local
`guardian_rfid` component. Events are `esphome.rfid_scanned` with
`result`, `card_id`, `counter`, `rotated`, `uid_bytes`, `source` — not
the factory UID. Doorbell poll is 250 ms (was 1 s). Doorbell imports
enrollment mode so an outdoor tap can enroll.

Portal screens: `HOLD`, `CLONE` (COPY DETECTED), `UNSUPPORTED` (WRONG
CARD). Verbose notifications and the RFID data-log no longer print UID,
card_id or MAC.

Control panel `2.2.0`: occupancy is 16-hex card_id, still never rendered.

### Verify

95. **Secret exists.** `esphome/secrets.yaml` has `guardian_rfid_mac_key`
    of exactly 64 hex characters. Portal and doorbell builds both succeed.

96. **Helpers exist.** After the full restart, Developer Tools → States
    shows `input_text.rfid_1_card_id` … `rfid_4_card_id` and
    `input_number.rfid_1_counter` … `rfid_4_counter`. Occupancy
    (`sensor.guardian_rfid_slot_map`) is `----` until re-enrollment —
    old UID hashes no longer count as occupied.

97. **Classic / UID-only is refused.** Present a 4-byte MIFARE Classic
    blank with enrollment on. Portal shows WRONG CARD / `UNSUPPORTED`,
    not GRANTED. `input_text.rfid_N_card_id` stays empty.

98. **NTAG enroll.** Enrollment on, genuine NTAG213, hold until GRANTED.
    `rfid_N_card_id` is 16 hex, `rfid_N_counter` is ≥ 1, `rfid_N_hash` is
    empty. Same card again in enrollment: `ENROLL_DUP:N`, not a second slot.

99. **Grant still feels like a tap.** Enrollment off, present the new
    key. GRANTED (or MFA if elevated) without holding. ESPHome log line is
    `RFID scan (...): result=ok uid_bytes=7 rotated=true` — no UID hex.
    Counter on the helper increased by 1.

100. **Doorbell and portal share the counter.** Scan at the doorbell, then
     at the portal. Both grant. `rfid_N_counter` is the max of the two
     writes, never rewound.

101. **Copy is rejected after a rotate.** After step 99, a UID-only clone
     of that key is DENIED_CARD / WRONG CARD, not GRANTED. A full dump
     clone taken *before* the rotate, presented *after* the real key has
     been used, shows COPY DETECTED and notifies. The real key still
     GRANTED.

102. **Clear.** `script.guardian_clear_rfid_slot` `slot: 1` (or a spare).
     card_id length 0, counter 0, that `X` leaves `slot_map`. Re-enroll
     if you still need the card.

103. **Panel cache.** Guardian panel footer shows `2.2.0`. If it still
     says `2.1.0`, the `?v=` on `module_url` was not copied.
     More → Keys counts registered keys by card_id, not hash length.

104. **Restart keeps card_id.** Full Home Assistant restart. Template:

```jinja
{% set ids = states('sensor.guardian_rfid_slots').split(',') | map('trim') | list %}
{% for i in ids %}
{{ i }}: id_len={{ states('input_text.rfid_' ~ i ~ '_card_id') | string | trim | lower | length }}
 c={{ states('input_number.rfid_' ~ i ~ '_counter') }}
{% endfor %}
map={{ states('sensor.guardian_rfid_slot_map') }}
```

     16-character ids and the counters from step 99 must survive. Scan:
     GRANTED, not DENIED_CARD.

---

## Sixteenth pass — taps never left the reader

The fifteenth-pass authenticator compiled and (if flashed) ran, but a
physical tap produced no `RFID scan (...): result=...` line and no
Home Assistant event. Matching, occupancy, and the `scripts.yaml`
`event_data` indent were already correct in this tree. The reader
raised the RF field for 1 ms and then sent REQA; ISO 14443 wants ≥5 ms
after PICC power-up. Stock `rc522_i2c` accidentally waited longer
because it is async. A too-small FIFO buffer could also abort SELECT
with no log.

**Recopy** `esphome/components/guardian_rfid/` to
`/config/esphome/components/guardian_rfid/` (create `components` if
ESPHome Save still fails). Rebuild and flash **portal**, then
**doorbell**. Same `guardian_rfid_mac_key`. Do not restore UID-only as
the credential. MIFARE Classic / UID-only blanks stay `unsupported_tag`.

Home Assistant YAML does not need a rewrite for this pass. Recopy
`scripts.yaml` / `packages/guardian_rfid.yaml` / `automations.yaml` only
if the live host is behind the fifteenth pass (missing `rfid_N_card_id`,
or `event_data` nested under `event:`).

### Verify

105. **PCD came up.** Portal ESPHome log after flash: `MFRC522 version
     0x91` / `0x92` / `0xB2` (clone), **not** `0x00` / `0xFF`, and no
     `Component guardian_rfid is marked FAILED`. A tap that still has
     no `RFID scan (...)` line may instead show
     `RFID PICC present but select failed source=interior_portal`
     (WARN, visible at INFO).

106. **NTAG enroll.** Enrollment on. Genuine NTAG213 (or 215), hold on
     the coil until GRANTED. Log:
     `RFID scan (interior portal): result=enrolled uid_bytes=7 rotated=true`.
     `input_text.rfid_N_card_id` is 16 hex, `rfid_N_counter` ≥ 1,
     `rfid_N_hash` empty.

107. **GRANT.** Enrollment off. Same key, tap (no hold).
     `result=ok uid_bytes=7 rotated=true`, GRANTED (or MFA if elevated).
     Counter on the helper increased by 1.

108. **Classic still refused.** Enrollment on, 4-byte MIFARE Classic /
     UID-only blank: WRONG CARD / `result=unsupported_tag`. Slot
     `card_id` stays empty. That is by design — do not “fix” it by
     hashing UID.

---

## Seventeenth pass — phantom RxIRq aborted SELECT

The sixteenth-pass 10 ms field-on delay made REQA succeed. Every tap then
failed at anticollision: `RFID xfer cmd=0x93 empty fifo irq=0x64 err=0x00`
and `PICC present but select failed`, no Home Assistant event. Idle polls
already showed the same signature on REQA (`cmd=0x26 empty fifo irq=0x64`).
That is a documented MFRC522 phantom: RxIRq with ErrorReg=0 and FIFOLevel=0
when RxNoErr is off. This driver sampled IRQ immediately after StartSend
and treated that as the end of the transfer, so TX ringing killed SELECT
before the UID arrived. Stock `rc522` waits ≥2 ms and does not force 48 dB
gain.

**Recopy** `esphome/components/guardian_rfid/` to
`/config/esphome/components/guardian_rfid/`. Rebuild and flash **portal**,
then **doorbell**. Same `guardian_rfid_mac_key`. Home Assistant YAML does
not change this pass. Temporarily raise both units’ logger to DEBUG for
the checks below, then set it back to INFO — DEBUG saturates the API log
buffer on the doorbell’s weak link.

If idle `empty fifo irq=0x64` is gone but SELECT still returns empty FIFO,
the next datum is FIFOLevel immediately after writing the 2-byte ANTICOLL
payload (must be 2). That path is not implicated by the current logs.

### Verify

109. **Idle is a timer timeout.** DEBUG, no card on the coil. Doorbell and
     portal: `RFID xfer cmd=0x26 timeout(timer) irq=0x45` (or a quiet
     `RFID REQA ... status=1`). Not a flood of `empty fifo irq=0x64`.

110. **SELECT copies UID.** DEBUG, tap an NTAG (card or keychain) on each
     reader. `RFID REQA ... status=0`, then
     `RFID xfer cmd=0x93 ok fifo=5 ...`, not `empty fifo`. Then
     `RFID scan (...): result=...` at INFO.

111. **Enroll / grant still work.** Sixteenth-pass items 106–108 on the
     portal; a doorbell tap in enrollment and in normal mode must also
     emit `esphome.rfid_scanned`. Classic / UID-only blanks stay
     `unsupported_tag`.

112. **Logger back to INFO.** After 109–111, both YAML files `logger.level:
     INFO`, rebuild, flash. Routine polls must not stream DEBUG xfer lines
     over the API.

---

## Eighteenth pass — MIFARE Classic 1K uses the same GDN1 payload

Classic SAK `0x08/0x18/0x09/0x19` used to fire `unsupported_tag` after a
successful SELECT (`uid_bytes=4`, no `0x60`/`0x30`/`0xA2`). Grobotronics
MIFARE 1K fobs (S303BNR-BK) were seen then denied, including during
enrollment. UID hashing is still not a credential.

**Recopy** `esphome/components/guardian_rfid/` to
`/config/esphome/components/guardian_rfid/`. Rebuild and flash **portal**,
then **doorbell**. Same `guardian_rfid_mac_key`. Home Assistant YAML does
not change this pass — Classic emits the same `esphome.rfid_scanned`
fields (`result`, `card_id`, `counter`, `rotated`, `uid_bytes`, `source`).

The seventeenth-pass RF/SELECT fix is unchanged: idle must stay
`timeout(timer) irq=0x45`, not `empty fifo irq=0x64`. Crypto1 is broken;
a sector dump is a clone until the next rotate. Classic is not NTAG
PWD/PACK.

Temporarily raise both units’ logger to DEBUG for 113–116, then set it
back to INFO.

### Verify

113. **NTAG still enrolls and grants.** Enrollment on, NTAG213: log
     `RFID scan (...): result=enrolled uid_bytes=7`. DEBUG:
     `branch=ntag`, `xfer cmd=0x60` (GET_VERSION), writes `cmd=0xA2`. No
     `RFID classic AUTH`. Enrollment off:
     `result=ok uid_bytes=7 rotated=true`.

114. **Classic 1K enrolls and grants.** Existing MIFARE 1K fob,
     enrollment on: `result=enrolled uid_bytes=4`, not
     `unsupported_tag`. DEBUG: `sak=0x08` (or `0x18`/`0x09`/`0x19`),
     `branch=classic`, `RFID classic AUTH`, writes `cmd=0xA0`. No
     GET_VERSION Transceive, no `cmd=0xA2`. Enrollment off: `result=ok`
     (rotate). Repeat on **portal and doorbell**.

115. **Idle is still a timer timeout.** DEBUG, no card: `RFID xfer
     cmd=0x26 timeout(timer) irq=0x45` (or a quiet `RFID REQA ...
     status=1`). Not a flood of `empty fifo irq=0x64`.

116. **Logger back to INFO.** After 113–115, both YAML files
     `logger.level: INFO`, rebuild, flash.

---

## Nineteenth pass — named keys, and add/remove from the Guardian panel

Rollback for this pass is the commit before it. Copy
`packages/guardian_rfid.yaml`, `scripts.yaml`, `automations.yaml`, the
panel JS and `configuration.yaml`, then a **full restart**. Flash the
**interior portal** after that restart (new HA text sensors and the KEYS
idle page). The doorbell is unchanged. The keypad cap was already 9; the
portal already draws `sensor.guardian_rfid_slot_map.length()` with
smaller boxes when that string is longer than 6.

### What changed

**Keys had numbers, not people.** The panel labelled each slot from
`input_select.rfid_N`'s YAML `friendly_name` (`RFID 1`). There was no
place to store a person name, so Home, Keys, the presence summary and
the activity feed all said "RFID" or "Key 2".

Each slot now has `input_text.rfid_N_name` (max 32, no `initial:`, so a
restart does not wipe it). The Guardian panel reads that first. The
presence summary, the enrolled-card push and the presence-correction
note do the same, falling back to `Key N` when the helper is empty.

**Adding a fifth key meant editing YAML.** The rack was four helper
sets and `sensor.guardian_rfid_slots: "1,2,3,4"`. The panel already
looped that whitelist; growing it still required a package edit and a
restart. This pass pre-declares slots 1–9 (the keypad / `ENROLL_DUP`
cap) and sets the whitelist to `1,2,3,4,5,6,7,8,9`. After one restart,
More → Keys & PIN is how you add and remove keys: **Add a key** writes
the next free slot, **Hold: delete this key** calls
`script.guardian_clear_rfid_slot` (which now also clears the name).

**Empty rack positions are not residents.** With nine whitelist ids,
counting every slot as a person would show `0/9 home` and a leftover
`At home` after retire would suppress the empty-house siren and the
Frigate away-alert. Occupancy readers (`sensor.guardian_presence_summary`,
`house_empty`, the Frigate person-while-away gate, the panel roster)
skip a slot unless `rfid_N_card_id` is 16 lowercase hex — the same
occupied rule enrollment already uses. Visitors with a card still appear
on the roster; they still do not count in home/total.

**Naming during enrollment.** `input_text.guardian_enroll_pending_name`
is a session helper (`initial: ''`). It is cleared when enrollment mode
turns on or off, and after a successful enroll (only once the name write
reads back). Type the name *after* tapping **Add a key**, then present
the card. A blank pending name leaves an existing name on overwrite and
leaves a new slot unnamed until Keys → Save. The panel flushes the name
on debounce, blur, and when the phone is locked or backgrounded, so
walking to the door does not lose it. Re-tapping an already-registered
card during enrollment also applies a non-empty pending name (rename).

**Add and delete are named.** More → Keys & PIN: **Add a key** (not an
enrollment toggle) starts the session; **Hold: delete this key** on a
registered card runs `script.guardian_clear_rfid_slot`. Home and More
both say “Add or delete keys”.

**Interior portal idle loop.** Idle page 1 is **KEYS**: each occupied
key’s name and HOME / AWAY / GUEST / LOST, from
`sensor.guardian_presence_roster`. The footer still shows only the
count (`1/2 home`) so Super Surveillance is not overflowed. Enrollment
boxes and ENROLL_DUP use `sensor.guardian_rfid_key_labels` and the
pending name so the OLED talks about people; the keypad is still 1–9
when replacing.

GRANTED itself is still slot-agnostic on the small display.

### New / changed helpers (`packages/guardian_rfid.yaml`)

| Helper | Default | Purpose |
|---|---|---|
| `input_text.rfid_1_name` … `rfid_9_name` | unset, max 32 | Person name. No `initial:`. |
| `input_text.guardian_enroll_pending_name` | `''` | Name for the next enrolled card. Session; wiped on restart and whenever enrollment mode flips. |
| `input_text.rfid_5_hash` … `rfid_9_hash` | unset, max 64, password | Same leftover-id / F-20 wipe as 1–4. |
| `input_text.rfid_5_card_id` … `rfid_9_card_id` | unset, max 16, password | Occupied = 16 lowercase hex. |
| `input_number.rfid_5_counter` … `rfid_9_counter` | unset / 0 | Rolling counter. |
| `input_select.rfid_5` … `rfid_9` | Away | Presence. |
| `input_select.rfid_5_policy` … `rfid_9_policy` | resident | `resident` or `visitor`. |
| `sensor.guardian_rfid_slots` | `1,2,3,4,5,6,7,8,9` | Runtime whitelist. |
| `sensor.guardian_presence_roster` | packed | Portal KEYS page: `Anton\|HOME;Sam\|AWAY`. Occupied keys only. |
| `sensor.guardian_rfid_key_labels` | packed | Enrollment boxes / ENROLL_DUP: `Anton;-;Sam`. Same order as the slot map. |

Existing `card_id` values in slots 1–4 are untouched. Name the people
already enrolled from Keys after the restart.

### Cache

Panel `2.9.2` (enrollment name-then-present copy). Bump `GUARDIAN_UI_VERSION` and
`configuration.yaml` `module_url ?v=` together.

### Device flash

Copy `esphome/portal-unit.yaml` and flash the **interior portal** after
the HA restart (new text sensors). The doorbell is unchanged.

### Verify

117. **Full restart loaded the rack.** Developer Tools → States:
     `sensor.guardian_rfid_slots` is `1,2,3,4,5,6,7,8,9`;
     `input_text.rfid_5_card_id` … `rfid_9_card_id` exist;
     `input_text.rfid_1_name` exists. Existing cards in 1–4 still
     GRANTED.

118. **Empty slots are not people.** With two occupied resident keys
     (one At home, one Away) and seven empty positions, Home shows
     `1/2`, not `1/9`. `sensor.guardian_presence_summary` matches.
     Forcing an empty slot to At home in Developer Tools must **not**
     change that count and must **not** block the empty-house path.

119. **Name a key.** More → Keys & PIN: an occupied card shows a name
     field. Type a person name, Save. Home roster, the capacity strip
     initials, and the presence summary use that name. A hard refresh
     after a restart still shows it.

120. **Add a key from the panel.** Keys → **Add a key**: enrollment
     turns on. Status title is **Name the key, then present it**; the
     session note matches. Type a name. Before presenting the card,
     Developer Tools → States must show
     `input_text.guardian_enroll_pending_name` equal to that name
     (status title becomes **Present the card**; body says “add {Name}'s
     key”; field shows **Saved**). Present an unknown card at either
     reader. GRANTED. The new key is occupied, labelled with that name,
     and the pending-name field is empty for the next card. Enrollment
     stays on until **Cancel**. Also confirm after typing then locking
     the phone briefly: pending still holds the name, and the tap still
     labels the key. Off Keys & PIN, status shows **Name the key** +
     **Cancel**; on Keys & PIN only the form **Cancel** (no Keys button).

121. **Add without a name.** Add a key, pending name blank, present
     another unknown card. The slot appears as `Key N`. Name it from
     the card afterwards.

122. **Remove a key.** **Hold: delete this key** on an occupied card.
     That `card_id` is empty, the name is empty, the roster row is gone,
     free-slots increased by one. Other keys unchanged.

123. **Rack full.** Fill all nine slots (or pick an occupied name from
     the picker). The portal still asks for a digit 1–9 when every
     box is full; occupied boxes show names. Overwriting a slot with a
     blank pending name keeps the previous person name.

124. **Panel cache.** Guardian panel footer shows `2.9.2`. If it still
     says an older version, the `?v=` on `module_url` was not copied.

125. **Portal KEYS page.** After flashing the interior portal, idle
     eight seconds: the loop shows **KEYS** with each person’s name and
     HOME / AWAY / GUEST / LOST, not only `1/4 home`. The footer count
     may still say `1/2 home`.

126. **Portal add copy.** Add a key, type Anton, walk to the portal:
     `PRESENT CARD` / `Adding Anton`. A duplicate tap with the same
     pending name: `REGISTERED` / `Already Anton` (or renames an
     unnamed registered key to Anton). Without a pending name:
     `Already registered` if unnamed.

---

## Twentieth pass — live stream at Frigate quality, HA sidebar hamburger

Home Assistant files. **No device reflash.** A **restart** is required:
`configuration.yaml`'s `panel_custom` `module_url` `?v=` is only read at
startup.

**What changed**

- Camera live view no longer uses `/api/camera_proxy_stream/` in an
  `<img>` (Frigate's detect MJPEG, 640×360 @ 5 fps). Live mounts Home
  Assistant's `ha-camera-stream` (WebRTC/HLS on Stream 1 / ~720p 15 fps).
  Pause is still a signed snapshot. If `ha-camera-stream` is not defined
  yet, live falls back to the old MJPEG `<img>` and upgrades when the
  element appears. The player is kept across unrelated re-renders.
  Camera opens live by default. Home peek stays still-only.
- Below 1100 px the top-bar hamburger fires `hass-toggle-menu` — the same
  event as Home Assistant's own menu button — so Overview, Settings and
  other panels are reachable. The custom full-width drawer that duplicated
  Home / Camera / Activity / More is gone. Bottom tabs and the desktop
  rail are unchanged.

**Cache.** Bump `GUARDIAN_UI_VERSION` in the panel **and** `?v=` on
`module_url` together. This pass is `2.4.0`.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Overwrite. `?v=2.4.0`. |
| `configuration.yaml` | `/config/configuration.yaml` | `module_url ?v=2.4.0`. |

Developer Tools → YAML → **Check configuration**, then **restart**. Reloading
automations is not enough for the `panel_custom` cache bump.

### Verify this pass

127. **HA sidebar from Guardian.** On a phone, open Guardian. The
     hamburger does **not** slide in Home / Camera / Activity / More
     (those stay on the bottom tabs). It opens Home Assistant's sidebar
     so Overview, Settings and Frigate are reachable. Desktop (≥1100 px)
     still has no Guardian top bar.

128. **Live is Stream 1, not detect.** Open Camera. It starts live
     without tapping Play. Motion should match the Frigate app (~720p
     15 fps), not the 5 fps detect MJPEG. Pause shows a still; Live
     resumes. Scroll the Camera tab or start a challenge: the stream
     must not tear down. Home peek is still a still.

129. **Panel cache.** Guardian panel footer shows `2.4.0`. If it still
     says `2.3.1`, the `?v=` on `module_url` was not copied.

---

## Twenty-first pass — the panel's visual layer, and one drawing per device

Home Assistant files. **No device reflash.** A **restart** is required:
`configuration.yaml`'s `panel_custom` `module_url` `?v=` is only read at
startup.

This pass changes **no entity, no service call and no screen's contents.**
`GUARDIAN_UI.md` §3's four tabs and §5's rules are untouched: still no PIN
input anywhere in the file, still no `card_id` or hash rendered, destructive
actions still press-and-hold only, Internals still read-only, still no business
logic. If a verification step below shows different *information* than it did
on `2.4.1`, that is a bug in this pass, not an intended change.

**What changed**

- **Palette and type.** The canvas moves off iOS grey to warm paper
  (`#F3F2EF`), and dark comes up off pure black to `#16171A` with surfaces
  that lift rather than cast shadows — a dimmed home app, not a console. The
  four cool status tones had drifted to within a few degrees of each other, so
  "a passage is open" and "a key is being added" rendered as the same teal;
  `arm` / `elev` / `pass` / `info` are now four separable hues. **All eight
  tone meanings are unchanged.** No webfont was added — a font-host `<link>`
  is the network dependency §2 exists to avoid.
- **One hand-drawn illustration per physical device**, from the photographs in
  `docs/reference-images/`. There are **three devices, not four**: the camera
  has no housing, its lens sits in the door lamp's bottom band, so the Camera
  tab shows a crop of the lamp rather than an invented fourth object. Inline
  SVG, no gradients and no `<filter>`, so nothing needs an `id` and the same
  device can appear twice on one screen. A drawing reads exactly two colours it
  did not choose: `--tone` (the status tone the model already picked) and
  `--lampc` (the same `light.*` attributes the colour wheel writes).
- **Home's four health cells** became a drawn device rack — same four
  subsystems, same entities, same tap-through to more-info.
- **Motion**, all declared in one keyframes block: entrance stagger, a sliding
  tab indicator, a status-LED heartbeat *only* when that device has something
  pending, and a two-ring detection ping at the lens in the warn tone. The
  stagger fires on navigation only, so an alarm arriving never restages the
  page under whoever is reading it. `prefers-reduced-motion` still disables all
  of it.

**Cache.** Bump `GUARDIAN_UI_VERSION` in the panel **and** `?v=` on
`module_url` together. This pass is `2.5.0`.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Overwrite. `?v=2.5.0`. |
| `configuration.yaml` | `/config/configuration.yaml` | `module_url ?v=2.5.0`. |

`www/guardian-ui/preview.html` and `GUARDIAN_UI.md` also changed and are **not
deployed** — the first is the offline dev harness, the second is documentation.

Developer Tools → YAML → **Check configuration**, then **restart**. Reloading
automations is not enough for the `panel_custom` cache bump.

### Verify this pass

130. **Panel cache.** More → footer shows `2.5.0`. If it still says `2.4.1`,
     the `?v=` on `module_url` was not copied. Hard-refresh the browser; on
     the companion app, Settings → Companion → clear the frontend cache.

131. **The device rack on Home.** Four cells at the bottom of Home, each
     drawn: the portal, the doorbell, the camera lens in its lamp band, and
     the door. Tapping each still opens Home Assistant's more-info dialog for
     the same entity as before. Pull the doorbell's power: its cell greys out
     and its dot goes red within the usual offline window.

132. **The portal's screen tells the truth.** More → Devices → Interior
     portal. The illustrated OLED shows the same state word as the status bar
     at the top of the screen. Arm super surveillance — both change together.
     Toggle **Screen backlight** off: the illustrated screen goes dark and the
     keypad stops glowing. Toggle it back on.

133. **The lamp illustration matches the lamp.** More → Lamp. The frosted
     panels carry the lamp's actual colour. Drag the hue wheel: the drawing
     follows the wheel, and both follow the bulb. Turn the lamp off: the
     panels go frosted white and the glow disappears.

134. **Live is still not alarm.** Camera. The lens drawing shows a small
     steady dot in the ok tone while live, not red, and no full-screen wash.
     Walk in front of the camera with Frigate publishing: two rings expand
     from the lens and **stop**. They must not loop.

135. **Nothing animates at rest.** Leave Guardian open on Home, idle, for a
     minute. Nothing should be moving — no blinking LEDs, no pulsing. Then
     open Settings → Accessibility and turn on reduce motion: the entrance
     stagger and every animation above stop.

136. **An alarm does not restage the page.** With Activity open and scrolled
     down, trigger a challenge from the door. The status bar changes and the
     new rows arrive, but the page must not fade-and-slide in again or jump
     to the top.

137. **Dark theme.** Switch Home Assistant to dark. Guardian follows. The
     canvas is a dark grey room, not black, and the device drawings stay
     legible — white ABS still reads as white plastic, not as a grey blob.

---

## Twenty-second pass — the lamp sampler that never wrote a verdict

Home Assistant files plus `guardian/guardian-luminance.sh` and the Guardian
panel. **Full restart**, not a reload: `input_number.guardian_luma_rotate`
and the extended `shell_command.guardian_luma_write_run` live in
`packages/guardian.yaml`. Copy the shell script to `/config/guardian/` with
**LF** line endings. Bump `configuration.yaml` `module_url` `?v=2.6.0` with
`GUARDIAN_UI_VERSION`. Neither ESPHome device needs a reflash. Frigate does
not need a restart (rotation is in the luminance probe, not in go2rtc).

**Last decision on More → Lamp stayed empty.** `script.guardian_sample_ambient_light`
bailed on a leading `condition:` when `input_text.guardian_camera_entity` was
still `camera.tapo_c110` / `none` / unavailable. That return happened *before*
`input_text.guardian_lamp_last_result` was written. Live view already preferred
`camera.door_camera` for those leftover helper values, so Camera looked fine
while Measure now and the 10-minute tick did nothing. Manual and Auto-calibrate
both looked dead; the bulb was only ever changed by hand.

The sampler now resolves the camera the same way the panel does (legacy or
unavailable helper → `camera.door_camera` when that entity exists). A missing
camera or lamp **writes** `FAILED camera_unavailable` / `FAILED lamp_unavailable`
(and `FAILED already_running` / `alarm` / `feedback` instead of a silent no-op).
A missing camera still sun-switches the lamp (`on_sun` / `off_sun`) so night
does not stay dark waiting for a snapshot.

**The night still is sideways, and IR is still on.** Frigate's JPEG is
landscape with the floor on the left (90° CCW from the seventh-pass C110
crop). Manual `y>=0.40` was measuring the wrong strip. `guardian-luminance.sh`
now applies `rotate=` from luma-run.env (default **90** CCW, helper
`input_number.guardian_luma_rotate`) **before** the crop. Live view stays
sideways on purpose — uprighting Frigate would transcode both streams.

Night-vision entity still defaults to `none`. An IR / magenta still is
detected by chroma and reported as luma **12** (below the 45 dark threshold)
instead of an IR-flooded 146, and is not appended to `luma-samples.jsonl`.
If the Tapo integration still exposes a night-vision `switch` or `select`,
set it on More → Install so the camera itself leaves IR mode during the
sample.

### New / changed this pass

| Item | What to do |
|---|---|
| `script.guardian_sample_ambient_light` | Copy `scripts.yaml`. No silent abort. Camera fallback. |
| `guardian/guardian-luminance.sh` | Copy to `/config/guardian/`. LF endings. `rotate=` + IR-like cap. |
| `input_number.guardian_luma_rotate` | New. Default 90. `initial:` only on first create. |
| `shell_command.guardian_luma_write_run` | Now writes `rotate=` and `ir=`. Package restart. |
| `www/guardian-ui/guardian-panel.js` | `2.6.0`. Sampler camera = live camera. Rotate control. |
| `configuration.yaml` | `module_url ?v=2.6.0`. |

### Verify this pass

138. Copy `scripts.yaml`, `packages/guardian.yaml`, `guardian/guardian-luminance.sh`
     (LF), `www/guardian-ui/guardian-panel.js`, and `configuration.yaml`.
     Developer Tools → YAML → **Check configuration**, then a **full restart**.
     Guardian footer shows `2.6.0`. `input_number.guardian_luma_rotate` exists
     and is **90**.

139. **Last decision is no longer empty.** More → Lamp → Measure now. Within
     ~15 s `input_text.guardian_lamp_last_result` is a one-line verdict
     (`luma=`… or `FAILED …`). If it is still `none`, the new scripts.yaml
     is not the one Home Assistant loaded.

140. **Helper leftover.** If `input_text.guardian_camera_entity` is still
     `camera.tapo_c110` or `none`, live view and the measurement-chain camera
     row both show `camera.door_camera`, and the sample still runs. Save
     `camera.door_camera` on More → Install so the helper matches.

141. **Night.** After dark, Measure now. The lamp must go **on** (`on_camera`,
     `on_sun`, or `on_sun_override`). `luma=` on an IR-looking still with
     night vision unset should be **12** (capped), not ~146. Set the Tapo
     night-vision entity on Install if it exists, then measure again — luma
     should be a real dark p25, still well below 45.

142. **Rotation.** With rotate at 90, a Manual night sample that used to sit
     in the 45–90 hold band should now be `on_camera` or the IR cap. If the
     live feed is already upright, set rotate to **0** and re-measure.

143. **Day.** Next morning, a sample must turn the lamp **off** (`off_camera`
     or `off_sun` / `off_sun_override`) without a manual toggle.

144. **Do not regress seventh/eighth-pass safety.** Repeat DEPLOY 41
     (mismatch 10 minutes) and 42 (sampling flag, watchdog, alarm stays red).
     Stuck `guardian_lamp_sampling` now writes `FAILED already_running hold`
     instead of doing nothing.

---

## Twenty-third pass — CRLF killed the probe; daytime hold restored the lamp

Home Assistant files plus `guardian/guardian-luminance.py` (and the thin
`.sh` wrapper). **Full restart**, not a reload: `command_line` and
`shell_command.guardian_luma_retune` live in `packages/guardian.yaml`. Bump
`configuration.yaml` `module_url` `?v=2.7.0` with `GUARDIAN_UI_VERSION`.
Neither ESPHome device needs a reflash. Frigate does not need a restart.

**52 consecutive `FAILED` samples, sensor `unavailable`, BusyBox
`set: illegal option -`.** The probe was copied from Windows with CRLF.
Ash treated `set -eu` as `set -eu\r` and exited 2 before Python ran. Camera,
Frigate snapshot (`ambient.jpg` was fresh), and sun fallback were fine.
`dos2unix` on the host unblocked Measure now (`luma=61 hold`). The SSH add-on
has **no** `python3`; that `python3: not found` is not a core failure. Do not
test the probe from `core-ssh`.

HA now calls `python3 /config/guardian/guardian-luminance.py` directly.
Python accepts CRLF, so the next Samba/Windows copy cannot break ash. The
`.sh` file is a four-line `exec` wrapper for anyone who still types `sh …`
inside the **homeassistant** container.

**`13:51 luma=12.0 sun=60.0 off_sun_override` plus a night-vision lecture.**
The IR chroma cap fired on an underexposed noon still and printed 12. The
sampler was right to leave the lamp off and wrong to blame
`input_text.guardian_camera_ir_entity`. The cap now runs only when
`luma-run.env` sun elevation is missing or ≤ 10. `off_sun_override` at noon
talks about auto-exposure, not a Tapo NV entity. Do not Save the Install
placeholder `switch.your_camera_night_vision`.

**Lamp on in daylight → Measure now → comes back on.** Hysteresis `hold`
restored presample. A valid daytime reading inside 45–90 is now
`off_day_hold` and the lamp **stays off** after the blackout. Night and
twilight still `hold` and restore.

Missing `/config/guardian/luma-cal.txt` in Manual mode no longer spam
`cat: … return code 1` every poll: the command_line echoes a `ready:0` stub.

### New / changed this pass

| Item | What to do |
|---|---|
| `guardian/guardian-luminance.py` | **Copy to `/config/guardian/`.** This is what HA runs. |
| `guardian/guardian-luminance.sh` | Copy to `/config/guardian/` if you still want the wrapper. LF. |
| `packages/guardian.yaml` | `python3 …luminance.py`; quiet `luma-cal.txt`. Full restart. |
| `script.guardian_sample_ambient_light` | `off_day_hold`; split override notifications. Copy `scripts.yaml`. |
| `www/guardian-ui/guardian-panel.js` | `2.7.0`. Knows `off_day_hold`. |
| `configuration.yaml` | `module_url ?v=2.7.0`. |

### Verify this pass

145. Copy `scripts.yaml`, `packages/guardian.yaml`, `guardian/guardian-luminance.py`,
     `www/guardian-ui/guardian-panel.js`, and `configuration.yaml`. Developer
     Tools → YAML → **Check configuration**, then a **full restart**. Guardian
     footer shows `2.7.0`.

146. **Do not use the SSH add-on to run the probe.** `python3: not found` there
     is expected. Measure now is the test.

147. **Day, lamp already off.** More → Lamp → Measure now. Last decision is
     `luma=`… `off_day_hold` (or `off_camera` / `off_sun_override` if the
     number is outside 45–90), **not** `FAILED`, **not** `hold`. Luma is not
     `12.0` at sun > 10°. Fail streak is 0. The lamp stays off.

148. **Day, lamp on.** Turn the lamp on, then Measure now. It blacks out, then
     **stays off** (`off_day_hold` or another `off_*`). It must not restore on.

149. **Night.** After dark, Measure now. The lamp goes **on** (`on_camera`,
     `on_sun`, or `on_sun_override`). An IR-looking still with night vision
     unset may still cap at **12**. `hold` may still restore a lamp that was
     already on.

150. Logs: `cat /config/guardian/luma-cal.txt` must not ERROR on a Manual
     install that has never retuned. `set: illegal option` must not return.

---

## Twenty-fourth pass — the device renders, rebuilt from the STLs

**One file plus a `?v=` bump.** `www/guardian-ui/guardian-panel.js` to
`/config/www/guardian-ui/`, and `configuration.yaml` `module_url` `?v=2.8.0`
with `GUARDIAN_UI_VERSION`. No restart is strictly required for the panel —
Home Assistant serves `/config/www` as `/local` — but the `?v=` is what makes a
browser pick it up, and that lives in `configuration.yaml`, so in practice this
is a copy, a **reload of the YAML** (or a restart), and a hard reload in the
browser. **No entity, no service, no automation and no script changed.**
Neither ESPHome device needs a reflash. Frigate does not need a restart.

**The door lamp was drawn as a pentagon.** The twenty-first pass traced it from
`docs/reference-images/door-lamp-photos/lamp-1.jpg`, a three-quarter photograph
taken from above, in which the top face is visible and foreshortens the top
edge. Every drawing in this panel is now measured off `3D-Models/*.stl` first
and checked against the photographs second. The mesh says the lamp is a
**hexagonal lantern**, 254 × 192 × 89 mm: a flat back, two short side walls, two
shoulders turned 27.5°, a 93-wide front face, three 86 × 118 frosted panels over
a 67 mm gloss-black skirt, and the camera lens flush in that skirt. Square-on,
its outline is a rectangle — so the hexagon is carried by per-facet shading plus
six units of foreshortening on the outer edges, not by distorting the silhouette.

**The doorbell was drawn with its cover off.** It carried the Ø54 rear wall cone
in the hero — mounting, not product — and its face came from `image9.jpg`, which
is the module on the bench mid-build: button plate, four M3 screws, bare 12 mm
red switch. None of that is on the wall. The cover goes on last, and the cover
*is* the button. The hero is now the mounted unit: the 86 × 95 body, the 77 × 86
cover standing 8 mm proud of it, and the bell mark centred on that cover. No
screws, no bezel, no dome, no cone. The part is thin unpainted PETG and reads
translucent, so the RGB status light shows as the cover glowing from within
rather than as a pilot lamp.

**The interior portal was arranged correctly and rendered flat.** Same
73 × 182.75 × 57.5 body, same speaker / 1.14″ 240×135 IPS / 3×4 keypad stack,
now with real materials: printed PETG with its layer lines, a chrome-rimmed
cone, white type on a backlit LCD, moulded keys. The drawn status LED above the
speaker is gone — the 5 mm RGB LED is optional in the build document and this
unit was printed without one. The Status LED row on the portal page is already
guarded by `exists()`, so it simply does not appear on a build like this.

The rule that forbade gradients existed because two copies of a drawing can sit
on one screen and their `id`s would collide. Ids are now namespaced per drawing
(`g-portal-sm-body`) rather than banned. `<filter>` is still banned — Home draws
four of these at once, and filter regions are the expensive part.

**And they were still pictures dropped into cards.** More → Devices is now a
gallery: a live **signal path** (doorbell → portal → door; camera → Guardian →
lamp, with a link that lights only while it is carrying something), then one
**device card** per physical device — including the door lamp & camera, which
was reachable at More → Lamp but had never been listed as a device. Each device
page opens on a **hero**: the render on a lit floor, the state sentence, and
three stat tiles. Home keeps its four health cells, the same entities and the
same tap-through, restyled to match.

### New / changed this pass

| Item | What to do |
|---|---|
| `www/guardian-ui/guardian-panel.js` | **Copy to `/config/www/guardian-ui/`.** `2.8.0`. All three renders rebuilt; `DEVICE`, `deviceCard()`, `sysFlow()`, `devStage()` stats. |
| `configuration.yaml` | `module_url ?v=2.8.0`. Reload YAML or restart. |
| `www/guardian-ui/preview.html` | Import string bumped to `?v=2.8.0`. Local harness only — not deployed. |
| `GUARDIAN_UI.md` | §4 rewritten: geometry provenance, the namespaced-id rule, the presentation components. |
| `3D-Models/`, `docs/reference-images/` | Source material for the above. Not deployed. |

### Verify this pass

151. Copy `guardian-panel.js` and `configuration.yaml`. Developer Tools → YAML →
     **Check configuration**, reload (or restart), then **hard reload** the
     browser. The Guardian footer shows `2.8.0`. If it still shows `2.7.0` the
     `?v=` did not take.

152. **The lamp is not a pentagon.** More → Lamp. The lantern is wider than it
     is tall, its outline is a rectangle, three frosted panels sit over a black
     skirt, and the lens is in that skirt. Turn the lamp on: the panels take the
     colour wheel's colour, all three of them.

153. **The doorbell matches the one on the wall.** More → Devices → Doorbell.
     Two white slabs, the front one standing proud, and a red bell mark centred
     on it. No cylinder, no screws, no separate round button — hold the panel up
     next to the real doorbell and they should be the same object. Toggle Status
     light: the cover picks up a faint glow from inside rather than a lamp
     appearing on it.

154. **The portal screen still tracks the system, and has no LED.** More →
     Devices → Interior portal. Nothing sits above the speaker. The drawn LCD
     reads whatever the status bar reads — start a challenge and confirm the
     drawn screen changes with it.

155. **Devices gallery.** More → Devices shows the signal path and three cards.
     With everything healthy, no link is lit and nothing animates. Press the
     doorbell: the doorbell → portal link lights. Open the door: portal → door
     lights.

156. **Home rack.** Scroll Home to the bottom. Four cells, each render on a lit
     well with a coloured top edge. Tapping one still opens Home Assistant's
     more-info dialog for that entity.

157. **Dark mode.** Switch the Home Assistant theme to dark and re-check the lamp
     and the gallery. The renders invert with the scheme; nothing renders black
     on black, and no shape renders unfilled (an unfilled shape means a gradient
     reference did not resolve).

158. **Offline.** Power the doorbell down. Its render greys out and its card says
     nobody can be admitted from outside.

---

## Twenty-ninth pass — Guardian is the Home Assistant landing page

Home Assistant files. **No device reflash. No entity, no service, no
automation and no script changed.** A **full restart** is required:
`frontend.extra_module_url` and `panel_custom` are both read at startup.

Guardian was already the household control surface. Opening Home Assistant
still landed on Overview because Settings → Dashboards only lists Lovelace
dashboards, and Guardian is a `panel_custom` at `/guardian`. That screen
cannot grow a row for it without turning the panel into Lovelace, which
this repository will not do.

The switch that screen *does* write is system frontend data
`core.default_panel`. Since 2025.12 that value may be any registered panel
path. A tiny module, loaded on every page via `extra_module_url`, does that
write on the first **admin** session after deploy, then sets
`guardian_primary_applied` so a later "Set as default" on Overview is not
overwritten. Non-admins inherit the house default; they cannot call
`frontend/set_system_data`. Overview, Lights, Settings, Frigate and the rest
stay in the sidebar. Settings → Dashboards still has no Guardian row — that
is the Home Assistant limitation this pass works around, not a missed copy.

If the first admin visit after the restart is already on Overview, the
module reloads onto `/guardian` from that stock landing only. It will not
yank anyone out of Settings.

### New / changed this pass

| Item | What to do |
|---|---|
| `www/guardian-ui/set-default-panel.js` | **Copy to `/config/www/guardian-ui/`.** New file. |
| `www/guardian-ui/guardian-panel.js` | Unchanged this pass (`2.10.0`). Copy only if that directory is being created fresh. |
| `configuration.yaml` | `frontend.extra_module_url` pointing at the new file `?v=2.10.0`. Comment on `panel_custom` updated: landing surface, not a replacement of HA. **Full restart.** |
| `GUARDIAN_UI.md` | §2: custom panel vs Dashboards; how `default_panel` is written. Not deployed. |

### Verify this pass

159. Copy `set-default-panel.js` and `configuration.yaml`. Developer Tools →
     YAML → **Check configuration**, then **restart** (a YAML reload does
     not pick up `extra_module_url`). Log in as an **administrator**. Open
     `http://<host>:8123/` (no path). It must load Guardian, not Overview.
     The browser console must not 404 `/local/guardian-ui/set-default-panel.js`.

160. **Sidebar.** Guardian sits at the top of the sidebar. Overview / Home,
     Lights, Security, Climate, Energy, Maintenance, Settings, Developer
     Tools and Frigate (if installed) are all still there. Nothing was
     hidden.

161. **Settings → Dashboards still has no Guardian row.** That is correct.
     Overview no longer carries the home-circle "this is the default"
     marker, because the system default is a panel that page cannot
     display. Do not "fix" this by wrapping Guardian as a Lovelace
     dashboard.

162. **Companion / second browser.** Open Home Assistant as a non-admin
     household user (or a second browser profile) at `/`. It must land on
     Guardian. If it still opens Overview, that user has a profile override:
     Profile → Default dashboard → use system settings, then reload.

163. **One-shot, then restore.** After 159 has run, Settings → Dashboards →
     Overview → **Set as default**. Reload `/`. It must land on Overview
     and stay there across another reload — the module must not fight.
     Restore the house default from an admin session's browser console
     (Settings cannot set Guardian):

     ```
     const hass = document.querySelector('home-assistant').hass;
     await hass.connection.sendMessagePromise({
       type: 'frontend/set_system_data',
       key: 'core',
       value: { ...hass.systemData, default_panel: 'guardian',
                guardian_primary_applied: true },
     });
     ```

     Open `/` again. Guardian must load.

164. **Phone hamburger still reaches HA.** On a phone, Guardian's menu still
     opens Home Assistant's sidebar (Overview, Settings, Frigate), not
     Guardian's own tabs. Those stay on the bottom.

---

## Thirtieth pass — one hamburger, rail vs tabs from HA sidebar state

Home Assistant files. **No device reflash. No entity, no service, no
automation and no script changed.** A **full restart** is required:
`panel_custom` `module_url` `?v=` is only read at startup.

Below 1100 px the panel always showed its own top-bar hamburger and bottom
tabs, even when Home Assistant had already docked its sidebar (from ~870 px)
with a hamburger of its own. That is the iPad band: two menu buttons, and
the four destinations stuck at the bottom while a collapsed HA sidebar left
room for a rail.

Chrome now reads `home-assistant-main` (`narrow` / `expanded`) and the
panel's remaining width:

- Phone / overlay: bottom tabs + Guardian hamburger (`hass-toggle-menu`).
- Docked, collapsed: left rail, no Guardian hamburger.
- Docked, expanded, panel ≥ 900 px: left rail (desktop, unchanged).
- Docked, expanded, tighter than 900 px: bottom tabs, no Guardian hamburger.
- Sidebar always hidden: Guardian hamburger stays; rail if the panel is wide.

**Cache.** Bump `GUARDIAN_UI_VERSION` in the panel **and** `?v=` on
`module_url` / `extra_module_url` together. This pass is `2.11.1`
(`2.11.0` still drew Guardian's hamburger on iPad when HA's sidebar was
expanded, because `home-assistant-main` lives in HA's shadow root and the
panel treated the squeezed content width as a phone).

### Files this pass

| File | Destination | Note |
|---|---|---|
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Overwrite. `?v=2.11.1`. |
| `www/guardian-ui/preview.html` | not deployed | Offline frames now include a fake HA sidebar. |
| `configuration.yaml` | `/config/configuration.yaml` | `module_url` and `extra_module_url` `?v=2.11.1`. **Full restart.** |
| `GUARDIAN_UI.md` | not deployed | Layout section rewritten off the 1100 px cut. |

Developer Tools → YAML → **Check configuration**, then **restart**. Reloading
automations is not enough for the `panel_custom` cache bump.

### Verify this pass

165. **Phone, overlay.** Open Guardian on a phone (or a browser under 870 px).
     One hamburger, in Guardian's top bar. It opens Home Assistant's sidebar,
     not Home / Camera / Activity / More. Those four stay on the bottom tabs.

166. **iPad, HA expanded.** On an iPad-class width with the HA sidebar
     showing labels (12.9" portrait, 10.2" landscape, or a ~1024 px window):
     no Guardian hamburger next to the Guardian title. The four destinations
     are on the **bottom**. HA's own menu button is the only one.

167. **iPad, HA collapsed.** Collapse the HA sidebar to icons on that same
     screen. The four destinations move to a **left rail**. Still no
     Guardian hamburger.

168. **Desktop, HA expanded.** On a wide browser (≥ ~1280 px) with the HA
     sidebar expanded, the left rail stays. Status, camera and who-is-home
     are not pushed under a bottom tab bar.

169. **Sidebar always hidden.** Profile → Sidebar → always hidden (or the
     equivalent). Guardian's hamburger comes back so Overview / Settings
     remain reachable. On a wide window the rail stays; on a narrow one,
     the bottom tabs.

170. **Panel cache.** Guardian panel footer shows `2.11.1`. If it still
     says `2.10.0` or `2.11.0`, the `?v=` on `module_url` was not copied.

---

## Thirty-first pass — Super Surveillance schedule

Home Assistant files. **Full restart** — new helpers live in
`packages/guardian.yaml`, which is not picked up by a YAML reload, and
`panel_custom` `module_url` `?v=` is only read at startup. **No device
reflash.**

Night auto-elevation is gone. Super Surveillance is one concept: the
manual switch, or a weekday × hour schedule the household can see and
edit. Both raise the same `binary_sensor.guardian_elevated_mode`. The
status bar no longer turns off a hidden night boolean to “disarm.”

**Default.** The seven day booleans `initial: true` and the hours
`initial: 0` / `5`. That is the old hardcoded 00:00–05:00 window as
configuration, not a rule. `initial:` applies only when Home Assistant
first creates the helper. After this restart the new days will be on,
so cards will demand a PIN between midnight and 05:00 unless you
deselect days. That is intentional and visible on Home and More →
Security.

**Orphans.** `input_boolean.guardian_night_elevation` and
`input_number.guardian_night_elevation_start` / `_end` are no longer in
the package. If they still appear under Settings → Devices & Services →
Helpers, delete them. Nothing reads them.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | Overwrite. New helpers + elevated-mode template. **Restart.** |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Overwrite. `?v=2.16.0`. |
| `www/guardian-ui/preview.html` | not deployed | Mock entities updated. |
| `configuration.yaml` | `/config/configuration.yaml` | `module_url` and `extra_module_url` `?v=2.16.0`. **Full restart.** |
| `scripts.yaml` | `/config/scripts.yaml` | Comment only. |

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

171. **Manual.** Super surveillance **on**, schedule days all off (or a
     window that does not include now). Scan a card → PIN challenge.

172. **Schedule.** Super surveillance **off**, today selected, hours
     00:00–05:00. At 02:00 a card raises a PIN challenge. The panel
     status and More → Security say the schedule is why, not the switch.

173. **Schedule off.** Super surveillance **off**, every day deselected.
     At 02:00 a card opens a passage window with **no** PIN. Switching
     the manual toggle off does not re-arm anything.

174. **Wrap.** Monday on, Tuesday off, start 22, end 6. Monday 23:00 and
     Tuesday 01:00 both require a PIN. Tuesday 07:00 does not (unless
     the switch is on). Wednesday 01:00 does not, because the window
     belongs to Monday.

175. **Disarm during a scheduled window.** With the switch on and the
     schedule matching, Disarm turns the switch off and you **stay**
     elevated. More → Security still shows the schedule as the reason.
     Edit schedule / deselect today to leave elevated mode. The bar
     must not empty the week for you.

176. **Panel cache.** Guardian panel footer shows `2.16.0`.

---

## Thirty-second pass — Super Surveillance programs

Home Assistant files. **Full restart** — new helpers live in
`packages/guardian.yaml`, which is not picked up by a YAML reload, and
`panel_custom` `module_url` `?v=` is only read at startup. **No device
reflash.**

The single weekday × hour window is now a rack of four independent
programs. Super Surveillance is still one concept: the manual switch, or
any enabled program whose weekday + hour window matches now. Both raise
the same `binary_sensor.guardian_elevated_mode`. There is no master
toggle and the status bar still never writes a program from Disarm.

**Default.** Program 1 `initial:` enabled, every day on, start 0 / end 5
— the old 00:00–05:00 window as configuration. Programs 2–4 start
disabled with no days. `initial:` applies only when Home Assistant first
creates the helper.

**Orphans.** `input_boolean.guardian_ss_schedule_mon` … `_sun` and
`input_number.guardian_ss_schedule_start` / `_end` are no longer in the
package. If the live window was customized, copy it onto program 1
before deleting those helpers from Settings → Devices & Services →
Helpers. Nothing in the new package reads them.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | Overwrite. Program rack + elevated-mode template. **Restart.** |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Overwrite. `?v=2.17.0`. |
| `www/guardian-ui/preview.html` | not deployed | All four program slots mocked. |
| `configuration.yaml` | `/config/configuration.yaml` | `module_url` and `extra_module_url` `?v=2.17.0`. **Full restart.** |

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

177. **Manual.** Super surveillance **on**, every program disabled (or a
     window that does not include now). Scan a card → PIN challenge.

178. **Program 1 default.** Super surveillance **off**, program 1 enabled
     with every day on, hours 00:00–05:00. At 02:00 a card raises a PIN
     challenge. The panel status and More → Security name program 1 (or
     its label), not the switch.

179. **OR.** Program 1 weeknights 00:00–05:00 and program 2 Saturday
     14:00–18:00, both enabled. Saturday 15:00 and Tuesday 02:00 both
     require a PIN. Tuesday 15:00 does not (unless the switch is on).

180. **Wrap, per program.** Program 3: Sunday on, Monday off, start 22,
     end 6. Sunday 23:00 and Monday 01:00 both require a PIN. Monday
     07:00 does not. Tuesday 01:00 does not, because the window belongs
     to Sunday. Other programs off.

181. **Disabled never elevates.** Program 3 still filled in as above but
     **enabled off**. Sunday 23:00 does not require a PIN. Days and hours
     are still on the card.

182. **Disarm during a program window.** With the switch on and a program
     matching, Disarm turns the switch off and you **stay** elevated.
     More → Security still shows the program as the reason. Edit schedule
     / disable that program to leave elevated mode. The bar must not
     clear days for you.

183. **Panel list.** More → Security shows four program cards. Home does
     not pretend one window is the whole schedule (e.g. `2 programs ·
     next 22:00` or `On now — Weeknights`). `www/guardian-ui/preview.html`
     mocks every slot; use it for the list UI.

184. **Panel cache.** Guardian panel footer shows `2.17.0`.

---

## Thirty-third pass — phone associations survive a restart

Home Assistant files. **Full restart** — new helpers live in
`packages/guardian_rfid.yaml` / `packages/guardian.yaml`, which are not
picked up by a YAML reload. **No device reflash.**

YAML `input_text` with `initial:` (including empty string) skipped
restore on every start. That wiped `guardian_presence_trackers`,
`guardian_camera_entity`, `guardian_frigate_camera_name`, and
`guardian_camera_ir_entity`. Those helpers now omit `initial:`.

`input_select.rfid_N_notify_target` YAML options are only `none`, so
restore-state rejected the previously selected phone before the options
refresh ran. Each selection is mirrored to `input_text.rfid_N_notify_saved`
(no `initial:`). `script.guardian_refresh_notify_target_options` rebuilds
options, then re-applies the saved id if it is still in
`sensor.guardian_notify_targets_available`.

The one-shot "Migrate Notify Targets Once" automation and
`input_boolean.guardian_notify_targets_migrated` are gone. The parse-time
`notify.guardian_alerts` group with two personal device names is gone;
zero-linked-phone fallback fans out to the discovery sensor.

**First restart after this deploy.** The new saved helpers start empty
and the selects still boot as `none`, so re-link phones on Keys, People
& Alerts **once**. Then restart again to prove they stick. If
`guardian_presence_trackers` / camera helpers were set since the last
boot, this restart should keep them; if the last boot already emptied
them, set them again in More → Install (Save).

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | No `initial:` on camera / presence helpers. No notify group. **Restart.** |
| `packages/guardian_rfid.yaml` | `/config/packages/guardian_rfid.yaml` | `rfid_N_notify_saved`. **Restart.** |
| `automations.yaml` | `/config/automations.yaml` | Persist automation `1786500000035`. One-shot migrate automation deleted. |
| `scripts.yaml` | `/config/scripts.yaml` | Restore after set_options; discovered-companion fallback. |
| `www/guardian-ui/preview.html` | not deployed | Generic mock phones. |

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

185. **Config helpers stick.** Set `input_text.guardian_presence_trackers`
     to a real comma-separated `device_tracker.*` list, set
     `guardian_camera_entity` and `guardian_frigate_camera_name` to the
     values you actually use, Save. Full restart. All three still hold
     those values — not empty, not the old YAML `initial:`.

186. **Two slots, two phones.** On Keys, People & Alerts, link two
     occupied slots to two **different** discovered phones. Confirm
     `input_text.rfid_N_notify_saved` matches each select. Full restart.
     After ~8 seconds (options refresh), both selects still show those
     phones — not `none`.

187. **Unlink stays unlinked.** Set one of those slots back to Not
     linked. Restart. That slot is still `none`; the other slot still
     has its phone.

188. **No personal identifiers.** Config, automations, scripts, and the
     panel preview contain no personal companion-app service names.
     Historical `GUARDIAN_AUDIT.md` changelog rows that document the old
     hardcoded call sites can stay. `automations.yaml` has no
     "Migrate Notify Targets Once" automation.

189. **Self-test.** `script.guardian_notification_selftest` leaves
     "passed" (or "FAILED" with a named step). A linked phone buzzes on
     the mapped-person step; with no slots linked, the fallback step
     buzzes every discovered companion app.

---

## Thirty-fourth pass — installer portability

Home Assistant files. **Full restart** — new helpers live in
`packages/guardian.yaml`, which are not picked up by a YAML reload.
**Portal reflash is optional this pass** if you add the new
`portal_unit__ip` / `__gateway` / `__subnet` / `__dns` keys to the live
`esphome/secrets.yaml` *before* the next flash; HA YAML does not depend
on it. **No doorbell reflash.**

This pass removes house-specific hardcodes from runtime YAML: the Tapo
lamp entity, doorbell `eisodos_` prefixes, leftover Tapo C110 camera
fallbacks, portal static IPs, and YAML `initial:` on user-config
helpers that skipped restore_state on every start.

### Live error: a leftover Companion notify service

`automation.guardian_elevated_mode_door_supervisor` failing with an unknown
household Companion notify action is **not in this repo and never
was** (`git log -S` / `git grep` across history are empty). The tracked
automation is `Guardian: Elevated Opening Supervisor`
(`id: '1775221552333'` → `automation.guardian_elevated_opening_supervisor`)
and it calls `script.guardian_notify_broadcast`. History only ever had
a Companion notify entity name, later removed.

The live box has a ghost automation (UI-created, renamed, or left in
`.storage/` from a never-committed copy). Do **not** add that notify
service or that automation id to YAML.

**On the Pi:**

1. Settings → Automations: find both names. Delete anything named like
   “Elevated Mode Door Supervisor” that is **not** sourced from
   `automations.yaml` (no `id: '1775221552333'`).
2. Developer Tools → States: confirm
   `automation.guardian_elevated_mode_door_supervisor` vs
   `automation.guardian_elevated_opening_supervisor`. If the former has
   no matching YAML id, it is orphaned — delete it.
3. Developer Tools → Services: list `notify.*`. Absence of the
   leftover Companion notify service confirms the stale call target.
4. Optional: search `/config/.storage` and `/config/*.yaml` for that
   leftover notify name.
5. Reload automations / restart after deleting the orphan.

### UI helper migration (this house — order is not optional)

Seven helpers used to exist only in the HA UI. They are now in
`packages/guardian.yaml`. A UI helper and a YAML helper with the same
object id collide.

1. Copy `input_text.portal_pin_hash` out of Developer Tools → States, in
   full, and keep it somewhere outside Home Assistant. If it is lost the
   master PIN is gone and only `script.guardian_set_pin` can make a new
   one.
2. Delete these seven helpers in Settings → Devices & Services → Helpers:
   `super_surveillance_mode`, `portal_mfa_pending`, `guest_bypass`,
   `mfa_failed_attempts`, `portal_display_state`, `portal_pin_hash`,
   `last_doorbell_rfid_time`.
3. Only then copy the new `packages/guardian.yaml`. `portal_pin_hash`
   has `max: 64` and **no `initial:`**.
4. Restart, restore the recorded hash, or set a fresh PIN with
   `script.guardian_set_pin`. Confirm 64 lowercase hex characters.
5. Confirm all seven exist and hold the expected values before walking
   away.

### New helpers / sensors (this house's pre-filled defaults)

| Helper / sensor | This house | Purpose |
|---|---|---|
| `input_select.guardian_lamp_target` + `input_text.guardian_lamp_saved` | `tapo_lamp` auto-selected if that light exists and saved is empty | Closed-set room lamp |
| `sensor.guardian_lamp_entity` | `light.tapo_lamp` | Resolved entity automations call |
| `sensor.guardian_lights_available` | discovered `light.*` | CSV of object ids |
| `binary_sensor.guardian_doorbell_button` | suffix-resolved | Portable doorbell press |
| `sensor.guardian_doorbell_entities` | attributes map real ids | Prefix-agnostic doorbell |
| `sensor.guardian_presence_trackers_available` | discovered `device_tracker.*` | Install picker |
| `sensor.guardian_presence_trackers_resolved` | filtered CSV | Person-away gate |
| The seven migrated UI helpers | existing restored values | See table above |

Recommended first-boot numbers if restore_state has nothing (new install):
dark 45, bright 90, luma rotate 90, mismatch 30 min, Program 1 00:00–05:00
every day, entry challenge 30 s, empty-house grace 10 s, doorbell exit PIN
10 min. This install keeps current values via restore_state because
`initial:` was omitted on those helpers.

### Portal secrets (defer reflash)

Add to live `esphome/secrets.yaml` (gitignored):

```
portal_unit__ip: "192.168.0.173"
portal_unit__gateway: "192.168.0.1"
portal_unit__subnet: "255.255.255.0"
portal_unit__dns: "192.168.0.1"
```

`esphome/secrets.yaml.example` uses placeholder `192.168.0.x` addresses.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | Helpers, discovery, no `initial:` on settings. **Restart.** |
| `automations.yaml` | `/config/automations.yaml` | Lamp consume + refresh/persist `1786500000036`/`0037`. Doorbell button proxy. |
| `scripts.yaml` | `/config/scripts.yaml` | Lamp variable; `guardian_refresh_lamp_options`; camera fallthrough. |
| `configuration.yaml` | `/config/configuration.yaml` | Panel `?v=2.18.0`. `config.lamp` remains a fallback. |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/` | Install picker. Version `2.18.0`. |
| `scenes.yaml` | `/config/scenes.yaml` | Empty list so the include loads. |
| `themes/` | `/config/themes/` | Empty dir so `include_dir_merge_named` loads. |
| `esphome/portal-unit.yaml` | flash later | `!secret` LAN keys. |
| `esphome/secrets.yaml.example` | not deployed | Placeholders + new portal keys. |

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

190. **PIN hash.** After the UI-helper migration, `portal_pin_hash` is 64
     lowercase hex. A known PIN still matches.

191. **Lamp sticks.** More → Install shows the room lamp as `tapo_lamp`
     (or your pick). Full restart. After ~8 seconds the select is still
     that light, not `none`. `sensor.guardian_lamp_entity` is
     `light.tapo_lamp`. A sample still blacks that bulb.

192. **Doorbell.** Press the button. `binary_sensor.guardian_doorbell_button`
     goes on. Guest Bypass Trigger can fire (flag still unused). Reset
     with restart-devices still reboots the doorbell.

193. **SS program 1.** If you had 00:00–05:00 every day, it is still that
     after restart (not reset by `initial:`).

194. **Presence.** More → Install lists live `device_tracker.*`. Adding
     one writes `guardian_presence_trackers`. A typo that is not in the
     discovery list does not count as home/away.

195. **Orphan automation gone.** The leftover Companion notify error is
     absent after deleting the ghost automation. Elevated Opening
     Supervisor still runs from YAML.

196. **Panel cache.** Footer shows `2.18.0`.

---

## Thirty-fifth pass — programs are created, not pre-shown; test alerts

Home Assistant files. **Full restart** — four new helpers live in
`packages/guardian.yaml`, which is not picked up by a YAML reload, and
`panel_custom` `module_url` `?v=` is only read at startup. **No device
reflash.**

Two changes, unrelated except that both land in the panel.

**Programs are created, not pre-provisioned in the UI.** More → Security
used to show four program cards whether or not the household had ever
touched them. The rack of four still exists — Home Assistant cannot make
a helper at runtime — but a rack position is now claimed rather than
shown. `Create Program` claims the first free one; `Delete program` hands
it back. Neither needs a restart: both only write helper states.

Three entities carry this, mirroring the RFID slot pattern exactly:

- `input_boolean.guardian_ss_N_created` (N = 1…4). The claim marker. No
  `initial:`.
- `sensor.guardian_ss_programs` — unchanged, and still `1,2,3,4`. It is
  **capacity**, not contents.
- `sensor.guardian_ss_programs_created` — new, trigger-based. The
  positions that are actually programs, and **the only copy of the
  created predicate**. The panel lists it and
  `binary_sensor.guardian_elevated_mode` loops it, so an unclaimed or
  deleted position cannot elevate even if a stale `_enabled` survived on
  it.

**`_created` and `_enabled` are different questions.** Disabling a
program leaves it created and visible, marked "Disabled — days and hours
are kept". Only Delete clears `_created`, and Delete is unconditional —
identical whether the program was on or off. Delete asks "Delete
&lt;name&gt;?" first and does nothing until you press Delete in that
sheet.

**No migration step.** A position also reads as created when it carries
leftover configuration — enabled, any day on, `start != end`, or a name.
So an install that already had Program 1 at 00:00–05:00 still shows it
the moment this deploys, with nothing to do by hand. That arm only ever
*adds* a program to the list; `script.guardian_delete_ss_program` clears
every term it tests, so a deleted position stays gone.

**Fresh installs now start empty.** Previous passes shipped four blank
cards; a new install now shows none until `Create Program` is tapped.
Creating one writes the window this repo has always recommended —
enabled, every day, 00:00–05:00 — so **a created program is live
immediately and will elevate that night** until it is edited.

**Send test alert.** Each key's "Alerts go to" selector on More → Keys,
People & Alerts now has a `Send test alert` button beside it, greyed out
while the selector reads none. It calls `script.guardian_notify_test`,
a thin wrapper over `guardian_notify_person` with `critical: false` — so
it reuses the existing validated path (slot checked against
`sensor.guardian_rfid_slots`, phone checked against
`sensor.guardian_notify_targets_available` before any `notify.*`) and
adds no second unvalidated one. `critical: false` is deliberate: a test
must reach the one selected phone or nothing, never fall back to
broadcast and report success for a link that is actually broken. The
panel reports the script's own verdict in a sheet, the same way the
Delivery self-test does.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | Overwrite. Four `_created` helpers, `guardian_ss_programs_created`, elevated-mode loops it. **Restart.** |
| `scripts.yaml` | `/config/scripts.yaml` | Overwrite. `guardian_notify_test`, `guardian_create_ss_program`, `guardian_delete_ss_program`. |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Overwrite. `?v=2.19.0`. |
| `www/guardian-ui/preview.html` | not deployed | Mocks `_created`, the new sensor, and both scripts. |
| `configuration.yaml` | `/config/configuration.yaml` | `module_url` and `extra_module_url` `?v=2.19.0`. **Full restart.** |

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

197. **Existing programs survive.** Straight after the restart, More →
     Security still lists whatever programs were configured before this
     pass. `sensor.guardian_ss_programs_created` names them. Nothing had
     to be turned on by hand.

198. **Create.** Tap `Create Program`. One card appears — enabled, every
     day, 00:00–05:00 — and the chips go from *n* to *n+1* programs with
     one fewer free. **No restart.**

199. **Disable is not delete.** Switch a program off. The card **stays**,
     reading "Disabled — days and hours are kept", its days and hours
     intact, and its Delete button still works. `_created` is still on.

200. **Delete asks first.** Tap `Delete program`. A sheet reads "Delete
     &lt;name&gt;?" with Delete and Cancel. Cancel changes nothing.
     Delete removes the card, and its days, name and hours are cleared.
     **No restart.**

201. **Delete works either way.** Repeat 200 on an *enabled* program and
     on a *disabled* one. Same result both times.

202. **Deleted stays deleted.** After a full restart, a deleted position
     is still absent — the leftover-configuration arm does not resurrect
     it.

203. **Rack full.** Create four. `Create Program` greys out and the chip
     reads "All 4 programs in use". Delete one to free it.

204. **Empty.** With every program deleted, More → Security shows "No
     programs yet. Tap Create Program to add one." and Home reads "No
     programs — only the switch above elevates". The manual switch still
     elevates.

205. **Unclaimed cannot elevate.** With no programs created, set the
     clock into what used to be program 1's window. A card does **not**
     raise a PIN challenge. `binary_sensor.guardian_elevated_mode` is
     off.

206. **Test alert.** On a key whose "Alerts go to" reads none, `Send
     test alert` is greyed. Pick a phone; it enables. Tap it — **that**
     phone buzzes with "Guardian: test alert", no other phone does, and
     the panel shows "Test alert sent" naming the phone. A phone that
     does not buzz on a reported success is a device problem
     (notification permissions, battery optimisation), not routing.

207. **Panel cache.** Guardian panel footer shows `2.19.0`.

---

## Thirty-sixth pass — phone links never consulted, a chirp that waited

Home Assistant files. **Full restart** — `sensor.guardian_notify_targets_available`
changes shape in `packages/guardian_rfid.yaml`, which a YAML reload does not
pick up, and `panel_custom` `module_url` `?v=` is only read at startup.
**No device reflash.**

**The link was real; the check was not.** Every *Send test alert* answered
"Nothing was sent, this key has no phone linked" with a phone plainly
selected. `mapped` in `script.guardian_notify_person` validated the picked
object id against `sensor.guardian_notify_targets_available` — a
**trigger-based** sensor that renders `unknown` after a template reload and
empty while `mobile_app` is still loading — while the picker rendered from
the select's `options` attribute, which persists in `.storage` forever.

That sensor is now a plain state-driven template sensor over `states.notify`
(minus `guardian_data_log` / `guardian_alerts` / `persistent_notification`).
Same entity id, same CSV state, plus a `phones` list attribute. It never goes
`unknown`, and it lists any notify target — tablets included — not only
`mobile_app`. Send-time validation is the union of the live `notify` domain
and that CSV.

**Three things that would have brought it back:**

- A blank discovery list no longer rewrites every select's options to
  `['none']` (which made Home Assistant fail-safe the selects, which the
  persist automation then mirrored into `input_text.rfid_N_notify_saved`,
  permanently destroying the restore copy). Automation `1786500000035` now
  refuses to mirror `none` / `''` at all.
- Payload alerts called `notify.<entity object id>`, which is not a service.
  Every `priority: high` push and the doorbell-exit PIN `textInput` failed
  silently behind `continue_on_error`. They now resolve the Companion
  service (`notify.mobile_app_<device slug>`) from the device registry, and
  fall back to `notify.send_message` with a `notify_payload_dropped` log
  when there is none.
- A skip verdict now carries a reason, so "no phone picked" and "that phone
  is not registered any more" stop reading as the same sentence.

**Panel (`2.20.0`).** The key card is rebuilt on the panel's own vocabulary:
group chrome with a tone edge, a header band, labelled fields, and one
action grid where **Send test alert** and **Hold: stolen** share a row at
equal height, collapsing to one column on narrow *cards* (the card is its own
CSS container). Picking a phone now waits for the read-back instead of
firing and forgetting.

**Unrelated, same deploy — the Super Surveillance chirp.** It was heard only
after an RFID scan. The repeat loop was always triggered by the door contact,
but it sat behind a blocking `action: script.guardian_notify_broadcast`. One
chirp now fires immediately after the challenge flag is set, the broadcast is
`script.turn_on`, and the loop delays before pressing so the opening edge is
not double-chirped.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian_rfid.yaml` | `/config/packages/guardian_rfid.yaml` | Discovery sensor is state-driven. **Restart.** |
| `scripts.yaml` | `/config/scripts.yaml` | `allowed` / `svc` / skip `reason`; refresh no longer resets options. |
| `automations.yaml` | `/config/automations.yaml` | Persist `not_to: none`; immediate chirp; non-blocking broadcast. |
| `configuration.yaml` | `/config/configuration.yaml` | `?v=2.20.0`. **Restart.** |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | Key card, `setNotifyTarget`, verdict wording. |
| `www/guardian-ui/preview.html` | not deployed | Mock now applies and rejects `select_option`. |

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

208. **Discovery survives a reload.** Developer Tools → Template:
     `{{ states('sensor.guardian_notify_targets_available') }}` lists your
     phones' notify object ids. Developer Tools → **Reload template
     entities**, render it again. Still lists them — **not** `unknown`.
     This is the regression that caused the bug.

209. **A linked key can be tested.** Keys, People & Alerts → pick a phone →
     **Send test alert**. Sheet says "Test alert sent" and the phone buzzes.

210. **The other verdict is honest.** Pick a phone, then stop that phone's
     companion app registering (or pick a slot whose phone is off the
     network long enough to deregister). The sheet says "That phone is not
     reachable", naming it — not "no phone linked".

211. **Payloads still carry.** Run the doorbell-exit PIN flow. The
     notification arrives **with** the PIN text-input action. Check the
     Guardian log for `notify_payload_dropped`; there should be none.

212. **Links survive a restart.** Confirm `input_text.rfid_N_notify_saved`
     matches each select. Full restart. After ~8 s every select is back on
     its phone and its `options` attribute lists them. Restart **again** —
     still there. Then set one slot to **Not linked**, restart, and confirm
     that slot alone is `none` with its saved helper empty.

213. **Chirp at the door.** Super Surveillance on, no passage window: open
     the door. The challenge tone sounds within about a second — before any
     phone push — and repeats every 5 s until the challenge is answered.
     Scanning is no longer what starts it.

214. **Panel cache.** Guardian panel footer shows `2.20.0`. The key card has
     labelled fields and **Send test alert** sits beside **Hold: stolen** at
     the same height; check it at phone width, at the two-up rack width, and
     with the sidebar expanded.


## Thirty-seventh pass — the system can say when it is half installed

Home Assistant files. **Full restart** — two new template sensors live in
`packages/`, which a YAML reload does not merge, and `panel_custom`
`module_url` `?v=` is only read at startup. **No device reflash.**

**THE ROOT CAUSE, found at the end of this pass.** Every phone link in this
house was dead for the entire life of the feature, and it was one missing
`| string` in `script.guardian_notify_person`:

```jinja
target: {{ … if which in (rack list) else 'none' }}      ← broken
target: {{ … if (which | string | trim) in (rack list) else 'none' }}   ← fixed
```

Home Assistant re-parses a rendered template into a native Python type.
`which: '{{ slot | string | trim }}'` renders the text `1` and comes back as the
**integer** `1`. Building the entity id still worked, because `~` stringifies —
which is why every *read* of the picker, in the panel and in `guardian_selfcheck`
and in Developer Tools, correctly returned the phone. But `1 in ['1','2',…]` is
`False` in Jinja, so the slot was ruled off the rack, `target` fell to the else
branch, and a key with a phone plainly selected reported *"no phone linked"*.

Every other slot check in this system already coerced inside the template —
`(matched_slot | string | trim) in (…)` — and worked. `guardian_notify_person`
held the only two that compared the already-converted variable, and they were
the only two on the notification path. That is why notifications were the one
broken feature. **Never compare a script variable to a list of strings without
`| string`.**

Three passes hardened the wrong things — the picker, the discovery sensor, the
restore mirror — because all three were plausible and none of them was ever
consulted: this comparison had already decided the answer before any of them
ran. The lesson is not about templates. It is that a symptom ("no phone
linked") was trusted as a description of the mechanism instead of as a string
some branch chose to emit.

**Why the rest of this pass exists.** The leading theory was a half-finished
deploy: the thirty-sixth pass fixed the bug in the repo and the live house kept
reporting it, and the YAML half not reaching the Pi — or reaching it without the
full restart `packages/` requires — would look exactly like that. The panel was
new, so everything *looked* deployed.

That theory was **wrong**, but it was not cheap to rule out, and ruling it out
by hand is what this pass makes unnecessary. Everything below stands on its own
merits: it is what finally made the real cause findable, by proving the deploy
was clean and forcing the search back into the logic.

That failure is undetectable from inside Home Assistant, and it does not
announce itself as a deployment problem. It announces itself as a **setup**
problem: old `script.guardian_notify_person` answering a new panel's question
returns `decision: skip` with no `reason`, the panel falls through to its
generic branch, and a key with a phone plainly selected is told *"this key has
no phone linked."* Diagnosing it took Developer Tools, SSH and a `git show`
against a previous commit. That is a fair thing to ask of the author and not a
fair thing to ask of anyone who adopts this.

Guardian ships as loose files copied into `/config` — panel under `www/`,
helpers and templates in `packages/`, logic in `scripts.yaml`, wiring in
`automations.yaml`. Nothing makes them arrive together and two of them need a
restart rather than a reload, so a partial deploy is the *normal* way for this
system to break. It now detects and reports its own.

**Every half declares its version.**

| Half | Where the version lives |
|---|---|
| `packages/guardian.yaml` | `sensor.guardian_version` state |
| `packages/guardian_rfid.yaml` | `sensor.guardian_rfid_version` state |
| `scripts.yaml` | alias of `script.guardian_version_marker` — a script's alias *is* its `friendly_name`, so the version rides in the state machine with no helper and no extra restart-created state |
| `automations.yaml` | presence of `automation.guardian_persist_rfid_notify_targets` — what matters there is whether the automation that mirrors a phone link into its restore helper exists at all |
| the panel | `GUARDIAN_UI_VERSION` |

`sensor.guardian_version` aggregates the first four into attributes; the panel
compares all five. A disagreement is **reported, never resolved** — the panel
cannot know which version was intended, only that they disagree. Bump all five
in the same commit.

**An infrastructure failure is no longer reported as the user's fault.**
`script.guardian_notify_person` gates on `sensor.guardian_rfid_slots` before it
will read a slot's phone link. When `packages/guardian_rfid.yaml` has not
merged that sensor is absent, `states()` returns `unknown`, and `target`
collapsed to `'none'` — reported as *"no phone linked"*. There is now a
`rack_ready` variable and a third skip reason, **`not_ready`**, tested *first*,
which says Guardian is not fully installed and that nothing is wrong with the
household's keys or phones.

This is deliberately **not** fixed by inlining `1,2,3,…` into the script. The
rack is one list in one place on purpose; a second copy is how it drifts. The
defect was never the dependency — it was reporting the dependency's absence as
a verdict about the user's configuration.

**Two checks stopped being Developer Tools rituals.** `More → Diagnostics` now
opens with an **Installation** card (every half, its version, and whether the
slot rack answers) and an **Alert routing** card (per enrolled key, whether its
alert would arrive right now, in the same vocabulary the script decides with).
An incomplete install is also pushed onto the fault list as `INSTALL`, so a
household that never opens Diagnostics still sees it. **Backend self check**
(new `script.guardian_selfcheck`, read-only) and the existing **Notification
self-test** are buttons on that page. A check nobody can find is a check
nobody runs.

`guardian_selfcheck` asks the *backend* what it sees rather than trusting the
browser, because the two can genuinely disagree: a UI-created helper left in
`.storage` can shadow the YAML one under a slightly different object id, and
the panel's entity resolver falls back to a suffix match — so the picker can
show one helper's value while every script reads another. It reports
`helper: missing` per slot when that is the case.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | `sensor.guardian_version`. **Restart.** |
| `packages/guardian_rfid.yaml` | `/config/packages/guardian_rfid.yaml` | `sensor.guardian_rfid_version`. **Restart.** |
| `scripts.yaml` | `/config/scripts.yaml` | **The `\| string` fix on `target` and `mapped`** — this is the one that makes alerts work. Plus `rack_ready` / `not_ready`, version marker, `guardian_selfcheck`. |
| `configuration.yaml` | `/config/configuration.yaml` | `?v=2.21.1`. **Restart.** |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` | `buildInstall()`, Diagnostics cards, `not_ready` verdict. |

`automations.yaml` is unchanged this pass, but copy it anyway if you are unsure
what is on the box — Diagnostics will tell you whether it is there.

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

215. **The version check works, proved by breaking it.** `More →
     Diagnostics` → Installation: all five rows green and equal to `2.21.1`.
     Now edit `/config/scripts.yaml` and change the marker alias to
     `... Version 1.0.0`, **Reload Scripts**, reopen Diagnostics: `scripts.yaml`
     is flagged, and a fault appears saying Guardian's files are from
     different versions. Put it back and reload. A check that has never been
     seen failing has not been verified.

216. **A half-installed system says so.** Rename `/config/packages/
     guardian_rfid.yaml` aside and restart. Diagnostics reports the RFID
     package missing and the slot rack missing; **Send test alert** answers
     *"Guardian is not fully installed"* — **not** "this key has no phone
     linked". Restore the file and restart.

217. **Backend self check.** Diagnostics → Tests → **Backend self check** →
     **Run**. The sheet names every version, whether the rack is readable,
     how many phones Home Assistant can see, and any key that cannot be
     alerted. It sends nothing — no phone should buzz.

218. **Routing matches reality.** Alert routing lists one row per enrolled
     key. A key marked **Reachable** must pass **Send test alert**; a key
     marked **Unreachable** must produce *"That phone is not reachable"*.
     If those two ever disagree, the card is lying and that is the bug.

219. **Panel cache.** Guardian panel footer shows `2.21.1`.

220. **The actual fix — a linked key sends.** Developer Tools → Actions →
     `script.guardian_notify_test`, YAML mode, `slot: "1"`, response variable
     on. Response is `decision: person`, `recipients` names the phone,
     `recipient_count: 1` — **not** `skip` / `not_selected`. The phone buzzes.
     Then the same from **Send test alert** on the panel.

221. **The int/string trap stays closed.** Developer Tools → Template:
     `{{ 1 in ['1','2'] }}` renders `False` and
     `{{ (1 | string) in ['1','2'] }}` renders `True`. Any future slot
     comparison must look like the second one. Grep before adding one:
     `grep -n "in ((states('sensor.guardian_rfid_slots')" scripts.yaml
     automations.yaml` — every hit must coerce on the left.


## Thirty-eighth pass — a fresh install can now install itself

Home Assistant files. **Full restart** — one new helper lives in
`packages/guardian.yaml`, which a YAML reload does not merge, and
`panel_custom` `module_url` `?v=` is only read at startup. **No device
reflash.** All five version literals move to `2.22.0`.

Nothing about running Guardian changes in this pass. What changes is *starting*
it.

**The audit that prompted this found less than expected, which is the good
news.** A systematic diff of every `input_*` / `timer` / `counter` entity
referenced anywhere in this tree against every helper declared in `packages/`
comes back clean: 179 declared, **zero referenced-but-undeclared**. The
`packages:` include is wired in `configuration.yaml`. There is no HACS
dependency and no Lovelace resource to register. The house-specific hardcodes
(`light.tapo_lamp`, the doorbell's `eisodos_` prefix, the Tapo C110 camera) are
already gone, replaced by discovery sensors. Six passes of portability work did
what they set out to do, and "create these helpers by hand" is genuinely no
longer a step.

**What was left was a different shape of problem, and it was invisible.**

`initial:` on a YAML helper is applied on every Home Assistant start and *skips*
`restore_state`. That is how enrolled card hashes were once wiped on every
restart (fourteenth pass), so this repo now correctly omits `initial:` on
anything a household configures. The cost of that correct decision only appears
on a **genuinely first** boot, where there is nothing to restore either: Home
Assistant falls back to each `input_number`'s `min`. A brand-new install comes
up with a dark threshold of 0, a bright threshold of 0, a ten-second entry
challenge and a two-minute doorbell-exit PIN window — and says nothing, because
those are not errors. They are wrong numbers that look deliberate. The
recommended first-boot values have been sitting in the thirty-fourth pass of
this file since it was written, and nothing has ever applied them.

The second half is the set of things Home Assistant offers no YAML for at all:
the File notify integration behind `notify.guardian_data_log`, the MQTT
integration behind the Frigate person triggers, the Companion app that is the
only source of a `notify.*` target, the config flow behind a camera. Each of
those failed later, somewhere else, as a symptom that did not name its cause —
the same class of failure the thirty-seventh pass fixed for half-copied files.

**`script.guardian_setup_wizard`** does both jobs. It applies the documented
numbers exactly once, gated on a new `input_boolean.guardian_setup_complete`, so
running it again is a re-check and never a reset. Then it reports — by entity
id, by integration, by menu path, and by the value it wants — everything still
missing. Every line is actionable and no line blames the household for an absent
integration, which is the rule `guardian_notify_person`'s `not_ready` verdict
already follows. The deployment half of the answer is not re-derived: it calls
`script.guardian_selfcheck` and folds in what that already knows. One copy.

Two values it deliberately refuses to guess. `guardian_luma_rotate` stays at 0,
because a wrong rotation measures the wrong part of the room and only the person
who mounted the camera knows. The master PIN is a credential, so it is reported,
not invented.

`Guardian: First Boot Setup` runs it two minutes after the first start — late
enough that the `notify.*` entities and the ESPHome devices have finished
registering, because reporting "no phones, portal missing" on a healthy install
would be worse than reporting late.

**`INSTALL.md` is new and is now the canonical day-one path.** This file stays
the upgrade changelog. Its `## Order` section — the only thing here that ever
resembled an install guide — was a fourteenth-pass artifact still instructing
new users to set `input_boolean.guardian_night_elevation`, which has not existed
for several passes. It is marked historical rather than rewritten.

**Nine data-log automations gained `continue_on_error`.** All four equivalents
in `scripts.yaml` already had it; these nine did not, so a fresh install with no
File integration logged an error on every door event. Each is a single-action
logging automation, so nothing downstream changes — only the noise.

**`frigate/config.yml` gained a commented `mqtt:` block.** It was redacted
before publishing because it carries broker credentials, and its absence from a
copied file is indistinguishable from it not being needed — in which case
`frigate/events` never publishes and person detection is silently inert.

**And it now admits its `{PLACEHOLDER}` credentials usually do not work.**
Frigate expands an environment-variable placeholder only when that variable is
present in its own container environment, and the Home Assistant OS add-on has
no supported place to set one. The failure is silent and misleading: the literal
string `{FRIGATE_RTSP_USER}` is handed to ffmpeg as a username, and what the
household sees is an authentication error or *"No frames have been received"* —
neither of which points at the config file. The file and INSTALL.md § 2 now say
plainly that most installs must type the credentials into the go2rtc URLs, and
what to do about the fact that this file is committed (gitignore it first; use a
dedicated camera account). The placeholders stay as the shipped default because
they are the right shape on a Docker install, not because they are reliable
here.

### New helper (`packages/guardian.yaml`)

| Helper | Purpose |
|---|---|
| `input_boolean.guardian_setup_complete` | Has the wizard applied this install's first-boot defaults. **No `initial:`** — it must restore, or every restart would re-apply the defaults over the household's own settings, which is the exact `initial:` bug this repo has fixed twice. Off on a fresh install. Clear it by hand to deliberately re-run the writes. |

### Values the wizard writes on first boot

From this file's thirty-fourth pass, "Recommended first-boot numbers". Every one
is in step and within bounds, so `set_value` can never be silently rejected.

| Helper | Falls back to | Wizard writes |
|---|---|---|
| `guardian_dark_threshold` | 0 | 45 |
| `guardian_bright_threshold` | 0 | 90 |
| `guardian_entry_challenge_seconds` | 10 | 30 |
| `guardian_empty_house_grace_seconds` | 5 | 10 |
| `guardian_doorbell_exit_pin_minutes` | 2 | 10 |
| `guardian_lamp_mismatch_max_minutes` | 10 | 30 |
| `guardian_frigate_camera_name` | unset | `door_camera`, only if unset |
| `guardian_camera_entity` | unset | the single discovered camera, only if exactly one exists |
| `guardian_luma_rotate` | 0 | *nothing* — reported instead |

### Files this pass

| File | Destination | Note |
|---|---|---|
| `INSTALL.md` | not deployed | **New.** The day-one path. |
| `secrets.yaml.example` | not deployed | **New.** A signpost: Guardian's HA config uses no `!secret` keys. |
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | `guardian_setup_complete`; `sensor.guardian_version` → `2.22.0`. **Restart.** |
| `packages/guardian_rfid.yaml` | `/config/packages/guardian_rfid.yaml` | `sensor.guardian_rfid_version` → `2.22.0`. **Restart.** |
| `scripts.yaml` | `/config/scripts.yaml` | `guardian_setup_wizard`; marker alias → `2.22.0`. |
| `automations.yaml` | `/config/automations.yaml` | `Guardian: First Boot Setup` (`1786500000038`); `continue_on_error` on nine data-log calls. |
| `configuration.yaml` | `/config/configuration.yaml` | Both `?v=` → `2.22.0`. **Restart.** |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/` | Setup check card on Install; `GUARDIAN_UI_VERSION` `2.22.0`. |
| `frigate/config.yml` | Frigate add-on config | Commented `mqtt:` template. Nothing live changed; no Frigate restart needed unless you uncomment it. |

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

222. **The wizard reports, on an install you know is healthy.** Developer Tools
     → Actions → `script.guardian_setup_wizard` with `apply_defaults: false`.
     The persistent notification says *Guardian is ready* and lists nothing
     under "still needed". If it lists something, it is right and you are
     wrong — check it before dismissing it.

223. **It does not re-write your settings.** Note
     `input_number.guardian_entry_challenge_seconds`. Change it to something
     else. Run the wizard again from **More → Install → Setup check**. The value
     is unchanged. This is the whole safety property of the pass: a re-check
     button that quietly reset thresholds would be worse than no button.

224. **It writes exactly once, proved by resetting it.** Turn
     `input_boolean.guardian_setup_complete` off. Run the wizard with
     `force: true`. The six numbers go to their documented values and the helper
     goes back on. Restart Home Assistant fully: the helper is **still on** (it
     restores) and the numbers are **still yours**. If the helper comes back
     off, something has added `initial:` to it — remove it.

225. **A half-installed system is named, not blamed.** Rename
     `/config/packages/guardian_rfid.yaml` aside and restart. The wizard's first
     blocker is *packages/guardian_rfid.yaml did not load*, naming the file and
     the restart. It does not report a missing PIN or a missing phone as the
     headline. Restore the file and restart.

226. **The File integration line is actionable.** With
     `notify.guardian_data_log` absent, the wizard names the integration, the
     menu path, the file path, and that Timestamp must be OFF. Follow it
     verbatim; re-run; that blocker is gone.

227. **The nine data-log calls no longer raise.** Before adding the File
     integration, open a door. The log shows no `notify.send_message` error. Add
     the integration and open it again: one JSON line is appended to
     `/config/guardian_data_log.jsonl`.

228. **First boot really is automatic.** On a machine where
     `guardian_setup_complete` is off, restart Home Assistant and walk away. Two
     minutes later the *Guardian setup* persistent notification is there without
     anyone having called anything.

229. **Panel cache.** Guardian panel footer shows `2.22.0`, and More →
     Diagnostics → Installation shows all five halves at `2.22.0`.


## Thirty-ninth pass — each person chooses what reaches their own phone

Home Assistant files. **Full restart** — eighteen new helpers live in
`packages/guardian_rfid.yaml`, which a YAML reload does not merge, and
`panel_custom` `module_url` `?v=` is only read at startup. **No device
reflash.** All five version literals move to `2.23.0`.

Every alert went to every linked phone. Routing had been solved twice over —
which phone, and whether Home Assistant could still see it — but nothing ever
asked whether the person holding it wanted this particular thing. The result is
a household that mutes the Companion app, which also mutes the alarm. This pass
is about not making people choose between hearing everything and hearing
nothing.

**Identity was the design question, and the answer was already in the file.**
Guardian has no logged-in user: the panel is registered `require_admin: false`
and never reads `hass.user`, deliberately, so that a non-admin household member
can use it. There is no `person:` integration and no slot↔HA-user map. What
there *is* is a rack of nine keys, each already carrying a name, a presence, a
policy and a phone. A person here **is** a key slot, so preferences hang off the
slot beside the phone link they govern. Two people in one house hold
independent settings and neither can affect the other's delivery — that falls
out of the storage shape rather than being enforced anywhere.

**The taxonomy is two axes, because one was not enough.** A single radio (all /
urgent only / just me) cannot express the thing people actually want, which is
"quiet about the house, but always tell me when my own key is used" —
that is loudness *and* subject, and one control cannot say both. So: a level
(`Everything` / **`Important`** / `Urgent only` / `Off`) crossed with six
category switches (`mine`, `security`, `access`, `presence`, `camera`,
`system`, named after the five the Activity filter already uses, plus `mine`).
Each alert now carries `category`, `severity`, `nonmaskable` and
`subject_slot`, and each recipient slot is tested against its own two helpers.

**Two invariants, and both are the point of the pass rather than details of it.**

*Fail open.* The field defaults are `category: system`, `severity: important`,
which pass at the default level, so a call site nobody tagged behaves exactly as
before. An unknown level string reads as `Important`; an unreadable mute list
reads as empty. The helpers are read **directly** in the slot loop, never
through `sensor.guardian_notify_prefs` — that sensor exists for Developer Tools
and is trigger-based, and the twenty-second pass is the record of what happens
when the alert path trusts a sensor that can render `unknown`. For routing it
meant every mapped alert was skipped; for preferences it would mean everyone
appearing to have opted out of everything.

*Off is not a kill switch.* Major alarm, stolen card and portal tamper pass
`nonmaskable: true` and reach every linked phone regardless of preference. This
is not a hedge — a settings screen on a burglar alarm that can silently disable
the burglar alarm is a trap, and the person who set Off six months ago will not
remember doing it. The panel says so on the same screen. `nonmaskable` is an
explicit field at the call sites rather than derived from `severity == urgent`,
so the set of alerts allowed to override a stated wish stays short, deliberate
and greppable. `guardian_notify_test` also passes it: a test exists to prove the
pipe, and one a muted category ate would look exactly like a broken phone link.

The broadcast path grew one branch worth naming. "Nobody has linked a phone"
and "everyone linked one and none of them wants this" are different facts, and
the existing no-linked-phone fallback fans out to every discovered device. Left
alone, that fallback would have posted every muted alert to every phone in the
house. `linked_ids` is now computed unfiltered alongside `slot_ids`, and the
filtered-empty case stops with `decision: filtered` **before** the fallback
branch. Two slots sharing one phone union their preferences — slot-level opt-out
cannot be enforced against a shared device, so it errs toward delivery.

### Files this pass

| File | Destination | Note |
|---|---|---|
| `packages/guardian_rfid.yaml` | `/config/packages/guardian_rfid.yaml` | 18 helpers (`rfid_N_notify_level`, `rfid_N_notify_mute`); `sensor.guardian_notify_prefs`; `sensor.guardian_rfid_version` → `2.23.0`. **Restart.** |
| `packages/guardian.yaml` | `/config/packages/guardian.yaml` | `sensor.guardian_version` → `2.23.0`. **Restart.** |
| `scripts.yaml` | `/config/scripts.yaml` | Filtering in both notify scripts; preference reset in `guardian_clear_rfid_slot`; tagged call sites; self-test cases 5–6; marker alias → `2.23.0`. |
| `automations.yaml` | `/config/automations.yaml` | Category / severity / `nonmaskable` on sixteen call sites. |
| `configuration.yaml` | `/config/configuration.yaml` | Both `?v=` → `2.23.0`. **Restart.** |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/` | `personAlerts` page; `setNotifyLevel` / `setNotifyCategory`; `GUARDIAN_UI_VERSION` `2.23.0`. |

Developer Tools → YAML → **Check configuration**, then **restart**.

### Verify this pass

230. **Defaults are invisible.** On a key nobody has touched,
     `input_select.rfid_N_notify_level` reads `Important` and
     `input_text.rfid_N_notify_mute` is empty. Open a door, scan a card: the
     same pushes arrive as before, minus the routine ones.

231. **Two people, two answers.** Set slot 1 to `Urgent only`, slot 2 to
     `Everything`, both with a phone. Developer Tools → Actions →
     `script.guardian_notify_broadcast` with `category: camera`,
     `severity: important`. The response `recipients` contains **slot 2's phone
     only**. This is the per-user property; if both appear, nothing else in this
     pass matters.

232. **My key beats the floor.** With slot 1 still on `Urgent only`, call
     `guardian_notify_broadcast` with `category: mine`, `severity: routine`,
     `subject_slot: 1`. Slot 1's phone is in `recipients`. Switch *My key* off
     on that person's screen and repeat: it is not.

233. **Off is not off for the alarm.** Set slot 1 to `Off` and mute all six
     categories. Fire `guardian.major_alarm` from Developer Tools → Events.
     **The phone still buzzes.** If it does not, `nonmaskable: true` has been
     lost from `automations.yaml:765` and the alarm is now maskable.

234. **Fail open.** Call `guardian_notify_broadcast` with *only* `title` and
     `message` — no `category`, no `severity`. It reaches everyone, exactly as
     it did before this pass.

235. **No fallback leak.** With every category muted on every linked slot, call
     it with `category: system`, `severity: routine`. The response is
     `decision: filtered`, `recipient_count: 0` — **not** `fallback`, and no
     phone buzzes. A `fallback` here means the filtered-empty stop is in the
     wrong place and muting has become a broadcast.

236. **Self-test covers the filter.** Run
     `script.guardian_notification_selftest`. Six lines, all pass. Line 5 names
     the level it read off the first linked slot and the decision it expected;
     line 6 asserts `nonmaskable` overrode it. It reads preferences and never
     writes them — check your own settings are untouched afterwards.

237. **The screen edits one person.** More → Keys, People & Alerts → a key →
     Notifications. Toggle every switch. In Developer Tools → States, only that
     slot's `rfid_N_notify_*` helpers changed. Back returns to the key card, not
     to the More index.

238. **A deleted key does not bequeath its settings.** Set a key to `Off`, hold
     Delete on it, enroll a new card into that slot. Its level reads
     `Important` with nothing muted.

239. **Panel cache.** Guardian panel footer shows `2.23.0`, and More →
     Diagnostics → Installation shows all five halves at `2.23.0`.


## Fortieth pass — the alarm could be cancelled by the step standing in front of it

**Full restart.** Three new helpers.

The thirty-ninth pass fixed one fail-open in the Major Alarm Handler and wrote
down the rule that produced the fix: *get the push out first, because nothing
else in the sequence is a precondition for it; guard every cosmetic step with
`continue_on_error`; and leave exactly one step unguarded, and only where a
failure there means the alert cannot happen anyway.* The rule was right. It was
applied in one automation and nowhere else, and the same class of bug was still
live on the highest-severity path in the system.

**A stolen key scanned while the portal was offline produced total silence.**
`process_rfid_scan` sounds the siren early, ahead of the decision trace and the
alarm proper, on the reasoning that somebody holding a key its owner reported
missing is standing at the door right now. That press targets
`button.guardian_interior_portal_play_alarm` — an entity on the **portal**. The
scan reaches it from **either** reader, and the doorbell does not need the portal
to be up. So with the portal rebooting, roaming between access points, or inside
the five minutes `Guardian: Portal Offline Watchdog` exists to announce,
`button.press` raised; a raising step ends the sequence; and
`event: guardian.major_alarm` twenty lines below never fired. No push, no reason
written, no ALARM screen, and no siren loop to resume when the portal came back.
The rest of the scan — trace, reconcile, counter write, the whole `choose` —
never ran either.

That is strictly worse than the instance already fixed. The Major Alarm Handler
case needed a half-copied install or a startup race. This one needed a portal
briefly off the network, which this repo ships two watchdogs and a ninety-second
elevated-mode timer to acknowledge as normal. The comment above the press said
"nothing above it may suppress it"; the press was the thing suppressing
everything below it.

The clone branch had the same shape: an unguarded `play_denied` press in front
of the `guardian.major_alarm` raised when a forged copy answers a live entry
challenge. Less severe only because the critical push above it was already
guarded and had already gone out.

Four more were found the same way and are the same rule: the verbose scan trace
(a *diagnostic* standing in front of every alert the scan can raise), the
enrollment write-failure notice, the doorbell-exit PIN badge, and the
notification self-test's own preamble. `Guardian: Stolen Card Alert` and
`Guardian: Uncertain Door Direction` each had a `persistent_notification.create`
in front of the push, both interpolating an event key with no `| default` — and
in the second case the push *is* the remedy for F-17, which called that path the
quietest event in the system. Both notifications now run after the push and are
guarded.

**None of these were found by reading.** They were found by walking the YAML,
which is why the fix is not seven `continue_on_error` lines but a check:
preflight now fails when a step that can raise stands in front of a step that
alerts, naming both line numbers. Two things it has to get right, both learned
from wrong answers on the way:

- **Sibling `choose` / `if` branches are not sequential.** Reading the file top
  to bottom reports three pairs in `Guardian: Master PIN Entry Handler` that can
  never both run. Each branch is walked against the steps before the container,
  not against its siblings.
- **A step that is itself an alert still counts as a predecessor of a later
  one.** The stolen-key press both sounds the siren and aborted the alarm proper.
  A checker that stops at the first alert misses the one bug that mattered most.

"Alert" means `guardian.major_alarm`, a `play_alarm` press, or a notify call
tagged `severity: urgent` or `nonmaskable` — not every notify call.
`guardian_sample_ambient_light` reports a broken lamp sampler through the same
script, and forty lamp findings would drown the four that matter. A check nobody
reads catches nothing.

**`automations.yaml` had no version literal.** Every other runtime file declared
one so a half-copied install could be caught before it became a symptom
somewhere else. The largest one did not — 3,900 lines holding the Major Alarm
Handler, every watchdog and every detection path. What stood in for it was a
presence probe: `guardian_selfcheck` and `sensor.guardian_version` both asked
whether *one* automation entity existed. A 2.22.0 `automations.yaml` beside a
2.24.0 everything-else answers "present" to that, so preflight passed clean and
More → Diagnostics said **"Guardian is healthy"** for exactly the case the check
exists to catch. Presence is not agreement. It now carries a marker automation in
the same idiom as `script.guardian_version_marker`, and is compared by version in
all three places.

**The Frigate detection channel had no watchdog.** Guardian detects three ways:
the portal's door contact, the doorbell's reader, and Frigate person-detection
over MQTT. The first two each got an offline watchdog. The third did not — so if
the broker died, the add-on stopped, or the camera key drifted, "person detected
while all cards are away" silently never fired again and nothing said so.
`script.guardian_setup_wizard` names the MQTT chain at install time, which
covers day one and not day four hundred.

The heartbeat is also stamped on Home Assistant start, and that is the honest
state rather than fabricated evidence: at restart Guardian has no information
either way about a channel it has not heard from yet. Both alternatives are
wrong — an unstamped helper reads as 1970 and would fire "camera detection
offline" seconds after a fresh install, before MQTT had connected, and a stamp
restored from before a long outage would fire it after every planned restart.
Both are the watchdog crying wolf, which is what teaches a household to ignore
it. Stamping at start gives the channel one window to prove itself; a genuinely
dead Frigate still trips fifteen minutes later, and the only cost is that an
outage spanning a restart is reported up to fifteen minutes late. For the same
reason an unreadable helper counts as *not* stale: "Guardian cannot tell" is not
"Frigate is down".

It is built from automations and a heartbeat rather than an `mqtt:` binary
sensor, deliberately: an `mqtt:` entity block needs the MQTT integration
configured, and Guardian must install cleanly on a household running no Frigate
and no broker at all. An automation with an MQTT trigger degrades to never
firing, which is what `Guardian: Frigate Person Detected While Away` has always
done. Watching the heartbeat rather than the `frigate/available` LWT is also
deliberate — the LWT only arrives if the *broker* is alive to publish it, so it
cannot report the case where the broker is the thing that died. A stale
heartbeat covers both, and a network partition as well.

**The alarm was the one thing the data log did not record.** Eleven kinds of
event were logged — every door opening, every card, every PIN change, every
presence correction — and not the alarm firing, and not the alarm being
silenced. The second matters more: `Guardian: Dismiss Alarm from Phone` ends a
live alarm on a bare notification action, with no PIN and no record of which
device sent it, and the Disable Alarm button reaches every linked phone on a
lock screen. That is a defensible choice — an alarm nobody can stop from the
phone in their hand is one people disable permanently instead — but leaving no
trace is not. Two new Data Log automations record both. They are separate
automations on the same events, never steps inside the alarm sequence, so a log
write can never stand in front of a siren.

Two things were left as design decisions rather than changed: no factor is added
before dismissal, and `portal_display_state` is deliberately **not** recorded at
dismissal, because both automations run concurrently on the same event and the
read would race the dismiss automation's own write of `IDLE`. A field that is
right most of the time is worse in an audit log than no field at all.

**Two documentation claims were not true.** `GUARDIAN_UI.md` said of per-person
notification settings that "neither can change what the other receives" — but
every key card carries a Notifications row and `viewPersonAlerts` renders
whichever slot the nav arg names, so whoever holds the panel reaches everyone's
page. The separation is one of *storage*, not permission, and the paragraph
immediately above it described the mechanism that contradicts it.

Second, nothing anywhere stated the authorization model. The panel is
`require_admin: false` by design, and Home Assistant does not by default
restrict which services a non-admin account may call — so **one Home Assistant
account is full control of Guardian**, and everything the panel withholds is one
API call away. The `ACTIONS` block's discipline is real and worth keeping: it
makes the blast radius of that file auditable by reading one function. It is not
a permission system, and a reader who mistook it for one would hand out logins
they should not. Both are now stated in `GUARDIAN_UI.md` §5 and in the README.

`README.md` and `LICENSE` (MIT) now exist; the repo had neither.

### New helpers

| Entity | Why |
|---|---|
| `input_boolean.guardian_frigate_offline_notified` | One-outage-one-push latch for the Frigate watchdog, matching the portal and doorbell latches. |
| `input_datetime.guardian_frigate_last_seen` | Liveness stamp written from `frigate/stats` and `frigate/events`. Frigate publishes no status entity, so liveness has to be recorded as it arrives. |
| `automation.guardian_automations_version_marker` | The version literal for `automations.yaml`. Never triggers, does nothing. |

### Verify

240. **Preflight.** `python tools/guardian-preflight.py` passes, reporting seven
     agreeing version literals at `2.24.0` and "no raising step in front of an
     alert".
241. **The check catches the real bug.** Remove `continue_on_error: true` from
     the `play_alarm` press in `process_rfid_scan`. Preflight must FAIL and name
     that line against the `guardian.major_alarm` below it. Restore it.
242. **The check has no false positives.** Confirm preflight stays silent on
     `Guardian: Master PIN Entry Handler`, whose presses and alarm sit in sibling
     branches, and on the Major Alarm Handler, whose order is already correct.
243. **Version guard.** Set the automations marker alias back to `2.23.0`.
     Preflight must FAIL and name `automations.yaml`; More → Diagnostics must
     report the disagreement rather than "Guardian is healthy". Restore it.
244. **Stolen key with the portal down — the bug itself.** Power the interior
     portal off. Scan a key marked **Stolen/Lost** at the **doorbell**. Before
     this pass: nothing at all. Now: the push arrives,
     `input_text.guardian_alarm_reason` holds the reason, and
     `input_text.portal_display_state` reads `ALARM` — so the siren loop starts
     the moment the portal reconnects. Power it back on and confirm it does.
245. **Stolen key with the portal up.** Siren immediately, push, ALARM screen
     naming the reason. Unchanged behaviour; this is the regression check on the
     fix above.
246. **Alarm audit trail.** After 245, dismiss from the phone. Two new lines in
     `/config/guardian_data_log.jsonl`: `major_alarm` carrying the reason, and
     `alarm_dismissed` carrying the `device_id` of the phone that pressed it.
247. **Frigate watchdog.** Stop the Frigate add-on. Within fifteen minutes a push
     must say camera detection is offline. Restart it; the recovery push must
     arrive exactly once. Confirm `input_datetime.guardian_frigate_last_seen` is
     being stamped while Frigate runs.
248. **A household with no Frigate is never told its Frigate is down.** Clear
     `input_text.guardian_frigate_camera_name` and confirm the watchdog stays
     silent through at least two of its five-minute ticks.
249. **Panel cache.** Guardian panel footer shows `2.24.0`, and More →
     Diagnostics → Installation shows every half at `2.24.0` — including
     `automations.yaml`, which now reports a version rather than `present`.



## Forty-first pass — the siren waited on the internet, and died the first time the portal blinked

**Full restart.** Two new helpers. Two new automations, two removed.

The fortieth pass wrote the rule and applied it everywhere it could see: *get the
push out first, because nothing else in the sequence is a precondition for it;
guard every cosmetic step; leave a step unguarded only where its failure means
the alert cannot happen anyway.* The rule is right about cancellation and it is
silent about time, and the Major Alarm Handler is where that mattered.

**"First" was reading as "finished first".** The handler's opening step was
`- action: script.guardian_notify_broadcast`, and `action:` **waits**. That
script walks every linked phone in a `repeat: for_each`, calling
`notify.mobile_app_*` — HTTPS out to Apple's or Google's push infrastructure, one
recipient at a time. `continue_on_error` catches the failure; it does not make
the call fast. So with the house's internet down — the cut line, the dead router,
the outage somebody caused on purpose — every recipient burned its own client
timeout in turn, and the display write and the siren loop sat behind all of them.
**The local response to a break-in was gated on reaching the internet.**

The remedy is not to move the push later; the fortieth pass was right that
nothing may cancel it. It is to stop waiting for it. `script.turn_on` with
`data: variables:` starts the push and returns immediately, so it can neither be
cancelled by anything below it nor delay anything below it — strictly better on
both axes than the ordering it replaces. The idiom is not new here. `Guardian:
Elevated Opening Supervisor` already uses it, with a comment saying in almost
these words that a push must never hold the challenge's own sound hostage. That
lesson was written down three hundred lines above the automation that needed it
most, for a chirp, while the siren waited.

**And the siren killed itself.** The loop is `repeat: while display == ALARM`
with one step in it: a `button.press` on `play_alarm`, which is an entity on the
**portal**. An error inside a `repeat` ends the whole run. The press was
unguarded. So the first press into a disconnected portal ended the siren
permanently — the ALARM screen still up, the reason still written, the push
already sent, and nothing anywhere able to re-enter the loop short of a Home
Assistant restart. Two entirely ordinary ways in: the portal was already off the
network when the alarm fired — which is the case the fortieth pass fixed
*upstream*, in `process_rfid_scan`, so that a stolen key at the doorbell reached
this handler at all — or the portal dropped mid-alarm, which is what pulling its
power or flapping an access point looks like.

The fortieth pass therefore fixed the path into this handler and left the handler
free to fall silent the same way at the end of it. Step 244 says of that fix:
*"the siren loop starts the moment the portal reconnects. Power it back on and
confirm it does."* Nothing implemented that. It was a specification written as a
description, and it had never been run. It is true now, by two changes:
`continue_on_error` on the press, so the loop retries every three seconds instead
of dying and resumes on its own the moment the portal answers; and
`Guardian: Sound Alarm On Portal Reconnect`, which presses once on reconnect so
the wait is immediate rather than up to three seconds. That automation
deliberately presses rather than re-firing `guardian.major_alarm`: re-firing
would restart the handler and send a second alarm push, so a portal roaming
between access points during an alarm would push once per roam.

**`mode: restart` reopened the window its own conditions were written to close.**
`Guardian: Elevated Opening Supervisor` refuses to run while
`input_boolean.guardian_entry_challenge` is on, and the comment on that condition
says exactly why: *"restarting the clock on it would let someone extend the
window indefinitely by working the door."* Correct — for the period after the
flag is set. The run opens with a `wait_for_trigger` of up to three seconds
before it sets that flag, and during those three seconds every condition still
passes, so a second `esphome.door_opened` cancelled the in-flight run under
`restart` and started the escrow over. A door worked open, shut and open again
faster than every three seconds deferred the challenge, and therefore the alarm,
for as long as somebody kept working it. `mode: single` drops the duplicate edge,
which is what those conditions already say should happen. Not `queued`: a run
that waited out a two-hundred-second chirp loop and then reasoned about a
three-minute-old door event is worse than one that never ran.

**Two recovery notifications had never once been sent.** `Guardian: Startup State
Recovery` asked "were we mid-challenge?" by reading `portal_mfa_pending`,
`guardian_entry_challenge` and `guardian_doorbell_exit_pin`, and "were we
mid-PIN-change?" by reading `guardian_pin_change_mode` — thirty seconds into a
start, when all four carry `initial: false`, which Home Assistant applies on
every start and which *skips* `restore_state`. Both variables were always false.
A household whose PIN challenge was killed by a routine restart was told nothing,
which is the gap those two branches exist to close, and several comments
elsewhere in the tree assert the opposite — that these booleans restore — and are
simply wrong.

The obvious fix is to drop `initial: false`, and it buys a notification with a
detection hole. A restored `guardian_entry_challenge` is a *condition* on the
Elevated Opening Supervisor, so for the thirty seconds before
`guardian_reset_auth` runs, an elevated-mode opening would be neither challenged
nor alarmed. Two new latches carry the fact across the restart instead, written
by `Guardian: Record An Interrupted Flow At Shutdown` on
`EVENT_HOMEASSISTANT_FINAL_WRITE` — the last stage at which a write still reaches
the restore snapshot — and consumed by Startup State Recovery on the way past.
The flags keep clearing on boot exactly as before. The honest limit is stated in
the automation and repeated here: a power cut or a crash writes nothing and sends
no notice. This is a courtesy after a planned restart, not evidence.

**Preflight could not see three things, and one of them was live.** The fortieth
pass's rule is about ORDER, and `RAISING_DOMAINS` is a list of *domains* —
`script.` is not one. So `- action: script.foo` scored as harmless and `foo`'s
body was never walked, even though that call blocks and Home Assistant hands the
callee's error back to the caller. `process_rfid_scan` calls
`guardian_reconcile_presence` in front of both the clone alarm and the stolen-key
alarm, and the last step of that script was an unguarded
`persistent_notification.create` — a domain already in the list, simply never
looked at from there. **That is the fortieth pass's own bug, one call deep,
passing its own check.** Preflight now walks into blocking script calls (not into
guarded ones — `continue_on_error` on the call really does catch what the callee
raised) and names the script a finding came from.

The other two are not ordering problems at all. A `stop` does not raise, and an
alert below one is not at risk but *unreachable*, which no `continue_on_error`
fixes; it is reported separately because the remedy is different. And a loop that
sounds an alarm can kill itself: nothing precedes the press inside the siren
`repeat`, so there was no "in front of" to report, and the rule was structurally
incapable of expressing the bug above. Only loops containing an alert are
reported — losing the elevated challenge's chirp is not losing an alarm.

`input_select.select_option` and `input_number.set_value` were added to the
raising set on the same reasoning and then **taken back out**, which is recorded
in the tool where the next person will propose it again. Both genuinely raise.
The rule produced fifteen findings and thirteen were wrong, because the checker
cannot read a bound — `guardian_set_display` writes `portal_display_seq` as
`... + 1) % 10000` into a helper with `max: 9999`, and is called from nearly
everything — and cannot see a guard that is not `continue_on_error`:
`guardian_reconcile_presence` tests `option_exists` in a condition three lines
above its `select_option`, the single most careful instance in the repo, reported
as a fault. The two real instances were in `process_rfid_scan`'s enrollment
branch and are fixed by hand. A check nobody reads catches nothing.

`tools/guardian-selftest-preflight.py` now injects nine faults rather than five.
One of the four new ones exists purely as a regression guard on this pass: moving
the alarm push to `script.turn_on` moved the `severity` that marks it an alert
from `data:` to `data: variables:`, and a checker still reading only `data:`
would have stopped recognising the highest-severity alert in the system, gone
silent on the whole automation, and reported a clean run.

**Two inert features were removed rather than commented harder.**
`Guardian: Portal Tamper Alert` waited on `esphome.tamper_alert`, which no
firmware emits; `input_boolean.guest_bypass` was written by one automation and
read by nothing, and had been in that state since audit F-07. Both carried honest
comments saying so. Comments are not visible in a stranger's automation list or
entity list — what is visible is a line reading "Portal Tamper Alert" and a
helper called "Guest Bypass", and the argument for keeping them ("easier to
finish than one that does not exist") is an argument that only holds for the
person who wrote them. The tamper design survives, below, where it belongs. The
panel's notification copy claimed tamper was non-maskable in three places and no
longer does.

**One security comment was overstating itself.** `script.guardian_set_pin` said
its authorisation gate stopped "every HA account and every leaked long-lived
token" replacing the master PIN. It does not: route 2 passes on
`input_boolean.guardian_pin_change_mode` being on, and turning that on is itself
a service call any account can make — so the gate raises the cost from one API
call to two. It cannot be tightened from inside Home Assistant (any nonce is a
helper the same caller can write, and the keypad flow has nowhere to hold a
verified old PIN except a helper, which would mean storing a plaintext PIN to
protect a PIN), so the comment is corrected rather than the code. Same class as
the `GUARDIAN_UI.md` claim the fortieth pass removed.

**What this pass deliberately did not do: the firmware.** The largest gap in
Guardian is not in this changelog's usual territory. The siren exists only as a
`dfplayer.play_mp3` behind a template button, and the only thing that ever
presses it is a Home Assistant automation, over Wi-Fi, every three seconds.
Neither ESP32 makes any decision on its own, and `homeassistant.event` is dropped
rather than queued when the API is disconnected — so jamming 2.4 GHz, cutting
power to the access point, or taking Home Assistant down silences the entire
system and leaves no record it happened. Everything above makes the siren survive
a portal that blinks. None of it makes the house make a noise on its own. That
work is specified under *Before this is published* and was not written here,
because it needs a reflash of the only source of door events and cannot be built
or heard from a machine with no hardware attached.

**And the version check itself was reporting a lie.** After deploying everything
above, More → Diagnostics showed `automations.yaml` as **missing** on a correct,
complete, fully restarted install — with every other half reading 2.25.0. Not a
copy error. `sensor.guardian_version` and `script.guardian_selfcheck` both read
that version with
`state_attr('automation.guardian_automations_version_marker', 'friendly_name')`,
copying the idiom used one attribute above for `scripts.yaml`. **The idiom does
not transfer.** A script's entity id comes from its YAML *key*, so
`script.guardian_version_marker` is exactly right. Automations are a *list* and
have no key — Home Assistant slugifies the **alias** — so the marker is
`automation.guardian_automations_version_2_25_0`, and nothing has ever been
called `...version_marker`. That attribute has returned `missing` on every
install since the fortieth pass wrote it, which means the half-copied-install
detector has been crying wolf for a whole release. A warning that is always on
is a warning nobody reads, and this one guards the failure mode the entire tool
exists for.

Do **not** fix it by pointing at the slugified alias. That id is sticky: the
entity registry keys on the automation's `id:` and keeps the entity_id minted on
first load, so a house that first saw 2.24.0 keeps
`automation.guardian_automations_version_2_24_0` through every later bump. Any
lookup embedding the version is wrong from the second release onward. Both
templates now match on the alias **prefix**, which survives that. It costs a walk
of the automation domain, which the previous comment rejected on cost — Home
Assistant rate-limits a template iterating a whole domain to one render a minute
for exactly this reason, so the answer is at worst a minute stale after a
restart, against an answer that was previously wrong always.

Nothing caught this because preflight reads the **files** and the fault was in
how a template reads the **running system**. Step 249 — look at More →
Diagnostics after a deploy — is the check that would have, and step 249 had never
been run. That is the whole argument of this pass's *Still outstanding* entry,
demonstrated on itself within a day. Preflight now asserts the alias prefix as a
contract across the three files that share it, and the self-test breaks it in one
of them; that is the most a static check can do here, and it is less than
running step 249 once.

### New helpers

| Entity | Why |
|---|---|
| `input_boolean.guardian_restart_mid_challenge` | Carries "a challenge was live when we went down" across a restart, so Startup State Recovery can say so. The flags themselves cannot: `initial: false` clears them before anything at start can read them. |
| `input_boolean.guardian_restart_mid_pin_change` | The same, for a keypad PIN-change session. |
| `automation.guardian_sound_alarm_on_portal_reconnect` | Presses the siren the instant the portal returns during a live alarm, instead of waiting out the loop's three-second tick. |
| `automation.guardian_record_an_interrupted_flow_at_shutdown` | Writes the two latches above at `EVENT_HOMEASSISTANT_FINAL_WRITE`. |

### Removed

| Entity | Why |
|---|---|
| `automation.guardian_portal_tamper_alert` | Inert since it was written — nothing emits `esphome.tamper_alert`. Its design is preserved under *Still outstanding*. |
| `automation.guardian_guest_bypass_trigger` | Wrote a flag nothing read. |
| `input_boolean.guest_bypass` | The flag nothing read (audit F-07). Delete it by hand on an existing install; a removed YAML helper does not disappear from the entity registry on its own. |

### Verify

250. **Preflight.** `python tools/guardian-preflight.py` passes, reporting nine
     agreeing version literals at `2.25.0` — nine, not seven; `INSTALL.md`'s two
     `?v=` strings joined the check in the fortieth pass and step 240 undercounted
     them — and "no raising step in front of an alert, stranded behind a stop, or
     able to end an alarm loop".
251. **The check for the check.** `python tools/guardian-selftest-preflight.py`
     reports CAUGHT on all nine faults and leaves the tree clean.
252. **Cross-file attribution.** Remove `continue_on_error: true` from the
     `persistent_notification.create` at the end of `guardian_reconcile_presence`.
     Preflight must FAIL naming that line **against alerts inside
     `process_rfid_scan`**, with the words "inside script.guardian_reconcile_presence".
     A finding that names only line numbers means the inlining did not happen.
     Restore it.
253. **No false positive on the careful instance.** Confirm preflight stays silent
     on the `input_select.select_option` in `guardian_reconcile_presence`, which is
     guarded by an `option_exists` condition rather than by `continue_on_error`.
254. **The alarm still sounds with the internet down.** Unplug the router's WAN
     (leave the LAN and the AP up, so the portal stays reachable) and fire
     `guardian.major_alarm` from Developer Tools. The siren must start
     **immediately**, not after the push attempts time out. Before this pass, with
     four linked phones, it waited for four failing pushes first. Time it.
255. **Alarm with the portal down, then power it on — step 244 finished.** Power
     the interior portal off. Scan a key marked **Stolen/Lost** at the doorbell.
     Confirm the push, `input_text.guardian_alarm_reason`, and
     `input_text.portal_display_state` reading `ALARM`, as step 244 already asks.
     Then power the portal on: **the siren must start within about three seconds
     of it reconnecting, with no Home Assistant restart.** Before this pass it
     never started at all, and step 244 claimed it would. This is the step that
     proves both halves.
256. **Portal pulled mid-alarm.** With the siren running, cut power to the portal
     for thirty seconds, then restore it. The siren must resume on its own. The
     alarm must not be cancelled, and no second alarm push should arrive.
257. **A worked door cannot defer the challenge.** In elevated mode, open, close
     and open the door again three times in under nine seconds. The challenge must
     open on the FIRST edge and its timer must run from there; the later edges must
     be dropped (an "already running" warning for `Guardian: Elevated Opening
     Supervisor` in the log is the expected, correct trace). Before this pass each
     edge restarted a three-second escrow and no challenge ever opened.
258. **The restart notice, which has never fired.** Start a keypad PIN change,
     leave it at the "enter current PIN" screen, and restart Home Assistant from
     Developer Tools → YAML → Restart. Within about thirty seconds a push must say
     the PIN change was cancelled. Repeat with a live entry challenge for the
     other notice. Then restart Home Assistant with nothing running and confirm
     **neither** notice arrives — one restart, at most one notice, and only when
     something was actually interrupted.
259. **The two removals.** `Guardian: Portal Tamper Alert` and
     `Guardian: Guest Bypass Trigger` are gone from Settings → Automations. On an
     **existing** install, delete `input_boolean.guest_bypass` by hand in
     Settings → Devices & Services → Helpers — removing it from the package does
     not remove the entity from the registry, and a leftover will sit there
     labelled "Guest Bypass" doing nothing forever.
260. **Version — and this is step 249 done properly.** Guardian panel footer shows
     `2.25.0`, and More → Diagnostics → Installation shows **every one of the four
     halves at `2.25.0` with no banner**. `automations.yaml` in particular must
     show a version and not `missing`: it reported `missing` on every correct
     install for the whole life of 2.24.0 and nobody looked. If it still says
     `missing` here, the marker automation did not load — check
     Settings → Automations for an entry whose name begins "Guardian - Automations
     Version", and confirm the restart was a full restart rather than a YAML
     reload.
261. **The marker survives the next bump.** Whenever you next change the version,
     re-check step 260 before anything else. The marker's entity id is frozen at
     whatever the first install minted, so it will read
     `...version_2_25_0` forever while its name tracks the alias — which is
     exactly why the lookup matches on the name prefix and not on the id.


## Forty-second pass — the guard that does not guard

**Version 2.26.0. Full restart** — `configuration.yaml` and
`packages/guardian.yaml` both change, and packages only merge on a full restart.
`automations.yaml` and `scripts.yaml` would each be satisfied by a reload; the
package is not, so restart and do not reason about which half you touched.
One new script. No new helpers, nothing removed.

**On the version bump.** The panel is the one file this pass does not change,
and its `GUARDIAN_UI_VERSION` moves anyway, because every literal is one
number and the four halves are compared against each other. Leaving the panel at
2.25.0 while the backend went to 2.26.0 would make More → Diagnostics report a
mismatch on a correct install — which is the crying-wolf failure the previous
commit fixed, reintroduced from the other direction. The bump is not decoration:
this pass changes four runtime files, and a copy that takes some of them and not
others is exactly what the marker exists to catch.

The fortieth and forty-first passes are the same pass twice: *a step that fails
takes the alarm down with it.* Both diagnosed it correctly, both reached for
`continue_on_error`, and both wrote comments stating that the remedy holds. It
holds for about half of what it was applied to. Home Assistant's
`_ScriptRun._handle_exception`:

```python
if not continue_on_error:
    raise exception
...
# These are incorrect scripts, and not runtime errors that need to
# be handled and thus cannot be stopped by `continue_on_error`.
if isinstance(exception, (vol.Invalid, exceptions.TemplateError,
                          exceptions.ServiceNotFound,
                          exceptions.InvalidEntityFormatError,
                          exceptions.NoEntitySpecifiedError,
                          exceptions.ConditionError)):
    raise exception
# Only Home Assistant errors can be ignored.
if not isinstance(exception, exceptions.HomeAssistantError):
    raise exception
```

`continue_on_error` catches a device that is reachable in principle and did not
answer. That is a real class and it is the class both earlier passes were
thinking about — a portal that dropped off Wi-Fi mid-alarm. It does **not**
catch an `entity_id` that is not an entity id, or a service name that does not
exist, because Home Assistant classes those as *misconfiguration* rather than
runtime failure and refuses to swallow them. Those are precisely what a
**templated argument** produces on a half-copied install, in the startup window,
or when a phone leaves the device registry — which is to say, precisely the
conditions this system exists to survive.

**The Major Alarm Handler was ending in front of its own siren loop.** Its
penultimate step set the lamp red at
`entity_id: "{{ states('sensor.guardian_lamp_entity') }}"`, with
`continue_on_error: true` and eight lines of comment above it naming the exact
hazard: *"a half-copied install with no packages/guardian.yaml, or the template
entity not yet rendered in the startup window that Guardian: Startup State
Recovery can re-fire an alarm into. states() then returns unknown, which is
neither a valid entity id nor the none sentinel."* Every word of that is right.
The conclusion drawn from it — that `continue_on_error` therefore covered it —
is wrong. `unknown` fails `cv.entity_id`, the service schema raises
`vol.Invalid`, and `vol.Invalid` is on the list above. The step ended the
sequence, and **the siren `repeat` on the very next line never ran**: the alarm
pushed to every phone in the house and the house stayed silent.

Both reachable cases are ordinary. A copy that misses `packages/` is the failure
mode the version checker exists for. And `Guardian: Startup State Recovery`
deliberately re-fires `guardian.major_alarm` during start — which is the window
in which a template entity has not rendered yet. The two passes that were about
the siren not sounding both left this in place, and the fortieth pass's own rule
about ordering could not see it, because ordering was never the problem.

**The same class, one script over.** `script.guardian_reset` presses the
doorbell's restart button at
`state_attr('sensor.guardian_doorbell_entities', 'restart')`, which renders `''`
on any install where no doorbell has been flashed. `''` is not an entity id
either, so on a portal-only house the reset stopped there — before the ambient
re-sample, before the `guardian.system_reset` event, and before its own "system
reset" confirmation push. The household pressed Reset, got a partial reset, and
was told nothing.

**The remedy is not a bigger guard.** There is no bigger guard; nothing in Home
Assistant catches `vol.Invalid` inside a sequence. The argument itself has to
become incapable of being invalid, so every templated `entity_id` in the tree now
falls back to the literal `none` — `ENTITY_MATCH_NONE`, always schema-valid,
matches nothing:

```yaml
entity_id: >-
  {% set e = states('sensor.guardian_lamp_entity') | string | trim %}
  {{ e if e is match('^(?!.+__)(?!_)[\da-z_]+(?<!_)\.(?!_)[\da-z_]+(?<!_)$') else 'none' }}
```

`continue_on_error` stays on those steps. It is still the right guard for the
thing it actually guards, and the two are now doing separate jobs rather than
one of them pretending to do both.

**A service name cannot be fixed that way**, because no template function can ask
whether a service exists. `guardian_notify_broadcast` sends a payload alert with
`action: notify.{{ svc }}`, where `svc` is `mobile_app_<slugified device name>`
resolved from the **device** registry. The `target in allowed` test one condition
above proves the notify **entity** exists — a different registry, and Home
Assistant is actively migrating `mobile_app` from the first to the second, so the
gap between them widens with each release. When they disagree the call raises
`ServiceNotFound`; the call sits inside `repeat: for_each` over the recipients;
an error inside a `repeat` ends the whole run. **One stale phone dropped the
alarm push to every recipient after it in the list**, in silence, with
`continue_on_error: true` on the line and a comment saying that handled it. Three
more copies of the same call live in `guardian_notify_person`, one of them on the
branch a stolen card and a major alarm reach.

All four now call `script.guardian_notify_send_one` with `script.turn_on`. That
script's only job is the one service call, in its own run, where a
`ServiceNotFound` still logs loudly and cannot reach the caller's sequence. The
caller loses the ability to learn whether the send worked — which it never had,
because `continue_on_error` was hiding an outcome it was failing to catch. The
fan-out also stops being serial, which is the same win the forty-first pass took
one level up. The injection rule is unchanged: `svc` is still resolved from the
device registry and still never templated from an open string.

**Auto-calibrate has never once run.** `shell_command.guardian_luma_write_run`
was `printf 'mode=%s\n...' '{{ ... }}' > /config/guardian/luma-run.env`. Home
Assistant runs a `shell_command` whose arguments contain templates through
`create_subprocess_exec` — **shell=False** — specifically so a rendered value can
never be read as shell syntax. That is the right call and it is not negotiable
from here. But with no shell there is no redirection: `>` and the path were
handed to `printf` as two more arguments, `printf` reused its format string for
them, the whole thing went to stdout, and **the file was never created**.
`printf` exited 0, so the `shell_command` reported success on every run.

`read_run()` therefore fell back to `mode=manual, sun=None, rotate=90,
ir=False` on every single measurement. So `input_select.guardian_lamp_luma_mode`
set to Auto-calibrate did nothing, `input_number.guardian_luma_rotate` did
nothing, the IR-frame rejection never engaged, and the probe's own sun term was
always absent — for the entire life of the feature, across several passes that
tuned it. It survived because **this house's correct rotation is 90 and 90 is
also the fallback**. A house with any other camera orientation has been measuring
a frame rotated the wrong way with nothing to see. The file write moved into
`guardian-luminance.py --write-run`, where it needs no shell at all and the
values stay arguments.

**The recorder exclusion list stopped one glob short**, which is worse than
having none, because a partial list reads exactly like a complete one. It
excludes `input_text.portal_pin_hash` and `input_text.rfid_*_card_id` on the
stated reasoning that a small keyspace makes a hash reversible and a recorded
value reaches every backup. `input_text.rfid_*_hash` is the same argument and was
not excluded. It holds an unsalted `sha256` of a raw card UID — legacy, since
enrollment writes card ids now and `guardian_reset` wipes these, but still
populated on any install migrated from before that change. A 4-byte MIFARE
Classic UID is a 2^32 keyspace, which is a *weaker* hash than the PIN the same
block already excludes, and recovering it yields the UID that clones the card.

**What preflight learned, and what it still cannot do.** Two new checks, and both
are about the difference between what a file says and what Home Assistant does
with it. `check_unguardable_arguments` reports a templated `entity_id` that
cannot fall back to a valid one, and a templated service name anywhere but the
one script allowed to hold one — and refuses to accept `continue_on_error` as a
mitigation for either, in those words, because that is the belief that produced
both bugs. `check_derived_entities` resolves every `guardian_*` reference against
the id Home Assistant would **mint**: template and `command_line` entities from
their `name:`, ESPHome entities from device `friendly_name` + entity name. That
is the generalisation of the version-marker bug the last commit fixed — preflight
had done it for `script.guardian_*` since the thirty-eighth pass and for nothing
else. It also pins two contracts nobody had written down: that the portal's
`friendly_name` slugifies to `guardian_interior_portal`, and that the doorbell's
ends in `smart_doorbell`, which is what every doorbell lookup in
`packages/guardian.yaml` matches on. **Rename the doorbell and the entire
doorbell half of the system silently addresses nothing.**

Writing those checks produced six findings on the tree; four were checker gaps
and two were the live bugs above. The gaps are recorded in the tool because each
one is a way the next version of this check will be wrong: `wifi_info` nests its
`name:` a level below `platform:`, `command_line:` mints entities the same way
`template:` does, a bare `'entry'` in a comparison is not a failed entity id, and
the `none` sentinel is written two ways in this repo.

`tools/guardian-selftest-preflight.py` now injects seventeen faults rather than
ten. Seven is the right number to add: every one of them was **live** while every
check above it in that file passed.

**What this pass deliberately did not do.** Nothing in the firmware. The largest
gap in Guardian is still that the house makes no noise without Wi-Fi and Home
Assistant, and that is still specified under *Before this is published* rather
than written, for the same reason as last time: it needs a reflash of the only
source of door events and cannot be built or heard from a machine with no
hardware attached. Everything above makes the alarm survive a half-installed
Home Assistant. None of it makes the house decide anything on its own.

**And one thing worth saying plainly.** Every bug in this pass was introduced by
correct-sounding prose. The comments above them were more careful than most
production code, named the right hazard, and drew one wrong conclusion — and
because the conclusion was written down confidently, two subsequent passes read
it and moved on. The static checks are worth more than the comments, and running
step 262 once is worth more than both.

**The version banner had the wrong remedy, which is why it kept coming back.**
More → Diagnostics has reported a version mismatch on almost every release, the
household has restarted Home Assistant, and the banner has stayed — because a
restart cannot fix it. The panel knew two numbers: the literal compiled into the
JavaScript it is *running*, and what the backend reports. Those two disagreeing
has two causes with two different fixes, and the card only ever printed one of
them: *"copy the files marked below and restart Home Assistant fully."*

That is right when a backend file is stale. It is wrong, and unfixable by
following it, when the **panel** is the stale half — which is the common case,
for a reason worth stating: `guardian-panel.js` is the file whose contents
usually do not change in a release. Only its version literal does. So to anyone
copying "what changed" it looks like a file that does not need copying, and a
browser still executing a module it cached earlier is invisible from the server
side. Home Assistant has no way to drop a module a browser already holds. The
household restarts, sees the same banner, and learns the warning as noise —
exactly what the previous commit fixed from the other direction.

The panel now reads a **third** number: the `?v=` off its own `import.meta.url`,
which is set by `configuration.yaml` and delivered fresh with the panel
registration. That says what *should* be running while the literal says what
*is*, and the two together separate the cases. When the panel is the stale half
the card now says so in those words, marks the four backend rows **correct**
instead of telling you to re-copy them, and prescribes the only thing that works:
copy that one file, then hard-refresh (`Ctrl-Shift-R`).

`check_deployed` gained the same test on the host, where it can be run before
anyone opens a browser: presence was never agreement, and `--config-dir` now
scans the deployed version literals rather than only checking that nine files
exist. `tools/guardian-install.sh --apply` already passes `--config-dir`, so
every install gets it for free.

**And there is a third cause, found by looking rather than reasoning: a poisoned
cache buster.** The reported symptom was the banner on *one PC* while every other
device — app and web — showed 2.26.0 correctly, surviving a logout and login.
That rules out both causes above: the file on disk is right, and the panel is
right everywhere else.

`?v=` works **once per value**. If any browser requests
`guardian-panel.js?v=2.26.0` while the old file is still on disk, Home Assistant
serves the old bytes under the new URL with a month-long `Cache-Control`, and
that browser has now cached the wrong content against the *new* address. The
buster is spent. Logging out does not touch it — authentication and the HTTP
cache are unrelated — which is exactly why that was tried and did nothing.

The window is the gap between the restart and the file copy: the restart is what
publishes the new `?v=` to every browser, so a browser that loads the page in
that gap poisons itself and every device that loads afterwards is fine. **Copy
every file, panel included, before restarting.** `guardian-install.sh` already
does; the manual path is where the panel gets copied last, because its contents
did not change.

The banner now says this in the right order — *check another device first* — and
names cache clearing rather than `Ctrl-Shift-R`, which is unreliable here: the
panel is a dynamically imported module, and a hard reload does not dependably
re-fetch one. `INSTALL.md` carries the full procedure and the prevention.

And the sentence in `INSTALL.md` that tells a household which version to expect
had read **2.24.0 for two releases**. The two `?v=` strings a paragraph away from
it were checked; the prose naming the number was not — so the one line whose
entire job is to state the version was the one line free to be wrong. It is the
tenth version site now. The count keeps growing; read it out of preflight rather
than from memory.

### New entities

| Entity | Why |
|---|---|
| `script.guardian_notify_send_one` | The only place in the repo allowed to template a service name, so a `ServiceNotFound` from a stale phone cannot end the caller's alarm fan-out. Called with `script.turn_on` only; preflight fails if anything calls it blocking. |

### Removed

Nothing.

### Verify

262. **The alarm sounds on a half-installed system.** This is the step the bug
     this pass fixes would fail, and no earlier step covers it. Rename
     `/config/packages` to `/config/packages.off`, restart Home Assistant, then
     fire `guardian.major_alarm` from Developer Tools → Events. **The siren must
     sound.** Before this pass the handler raised at the lamp step and the siren
     loop below it never ran — a full alarm that pushed to every phone and made
     no noise in the house. Rename the directory back and restart when done.
263. **The same thing without the surgery.** With `packages/` in place, point
     `input_select.guardian_lamp_target` at nothing, so
     `sensor.guardian_lamp_entity` resolves to `none`. Fire
     `guardian.major_alarm`. Siren sounds, no error in the log. This proves the
     sentinel path; 262 proves the invalid-id path.
264. **The fan-out survives a dead phone.** Link two phones to two key slots.
     Remove the Companion app from the first, or rename its device in
     Settings → Devices so the `mobile_app_*` service no longer matches, and wait
     for the entity to go stale. Fire `guardian.major_alarm`. **The second phone
     must still receive it.** Before this pass the `repeat` ended on the first
     failing recipient and everyone after it got nothing.
265. **The mute button still arrives.** On the same alarm, confirm the push
     carries its "Disable Alarm" action and that pressing it silences the siren.
     This has been unverified since the forty-first pass moved the push to
     `script.turn_on`, and it is now one indirection further from the call site.
266. **Reset with no doorbell.** On an install with no doorbell flashed (or with
     the doorbell powered off long enough to leave the registry), run
     `script.guardian_reset` with `restart_devices: true`. The "system reset"
     confirmation push must arrive and the lamp must re-sample. Before this pass
     the script stopped at the doorbell restart and did neither.
267. **The lamp run-env exists — the cheapest check in this document.** Run
     `script.guardian_sample_ambient_light` from Developer Tools, then on the
     host:

     ```
     cat /config/guardian/luma-run.env
     ```

     It must exist and read `mode=`, `sun=`, `rotate=`, `ir=` with current
     values. **If this file is absent, or its mtime predates this deploy, that is
     the lamp finding confirmed on hardware** — it means it was never being
     written and every measurement since the feature shipped used the fallbacks.
268. **Auto-calibrate is now reachable.** Set the lamp mode to Auto-calibrate,
     run a sample, and confirm `luma-run.env` reads `mode=auto`. Then set
     `input_number.guardian_luma_rotate` to a value that is not 90 and confirm
     the next sample's `rotate=` follows it. Neither was true before this pass.
269. **The card hashes stop being recorded.** Confirm `input_text.rfid_1_hash`
     gains no new history after the restart. An exclusion does not remove
     existing rows — purge them with `recorder.purge_entities` if the install is
     old enough to have had a value in that helper.
270. **Preflight and its self-test.** `python tools/guardian-preflight.py` passes
     with the two new lines — "every templated entity_id falls back to a valid
     id..." and "every `guardian_*` template and ESPHome entity reference
     resolves...", and every version literal agreeing at **2.26.0** (it prints
     the count; do not check it against a number remembered from a previous
     release, because that count has changed four times).
     `python tools/guardian-selftest-preflight.py` must end with the line
     **`17 of 17 faults caught.`** and leave the tree clean. Read that line, not
     the column: an anchor that drifted because the code it points at was
     reformatted prints `SKIP`, in the same column as `CAUGHT`, and a fault that
     never ran is a guard that was never demonstrated. The count line exists
     because that happened twice while this pass was being written.
272. **The version banner now names the right half.** This is the one that has
     been misfiring every release. After deploying, open More → Diagnostics.
     Expect all five rows green at 2.26.0. Then, to prove the new diagnosis,
     re-copy an OLD `guardian-panel.js` over the new one, hard-refresh, and look
     again: the banner must say *"Home Assistant asked your browser for panel
     2.26.0 and got 2.25.0"*, mark **This panel** as the red row, and mark the
     four backend rows **"this file is fine"**. Before this pass it marked the
     four correct files red and told you to restart, which never helped. Copy the
     correct panel back and hard-refresh.
273. **The same check without a browser.** On the host:

     ```
     python3 tools/guardian-preflight.py --config-dir /config
     ```

     It must report "every deployed file reports 2.26.0". Re-copy an old panel
     and it must FAIL naming `www/guardian-ui/guardian-panel.js` and telling you
     to hard-refresh. Presence was all this checked before, so nine present files
     and one of them stale reported clean.
274. **The doorbell contract, on paper.** Change `friendly_name` in
     `esphome/doorbell-unit.yaml` to something not ending in "Smart Doorbell" and
     run preflight: it must fail naming the suffix. Change it back. Not a
     hardware step — it is the demonstration that the assumption the whole
     doorbell half rests on is now written somewhere a machine reads.


## Forty-third pass — the parts nobody had read

**Version 2.27.0. FULL RESTART, and BOTH DEVICES MUST BE REFLASHED.**
`packages/guardian.yaml` is untouched this time, but `configuration.yaml`'s
`?v=` moves and packages only merge at startup, so restart rather than reasoning
about which half you touched. The reflash is not optional: the card-acceptance
fixes are in `esphome/components/guardian_rfid/`, which compiles into *both*
firmwares, and the offline siren is in `portal-unit.yaml`.

**Copy every file, panel included, BEFORE restarting.** `?v=` works exactly once
per value; a browser that requests the new url while the old file is still on
disk caches the wrong bytes against the right address for a month.

### What this pass is

The previous audits went over the Home Assistant half repeatedly and never
opened three things: the card crypto (`guardian_rfid`, 1,554 lines of C++ and
Python), the portal firmware beyond one button, and `tools/guardian-install.sh`
— the first command a stranger ever runs. All three had defects worse than
anything left on the publish list.

The shape that keeps recurring, now three passes running: **a guard that reads
like a guard and is not.** The fortieth and forty-first passes wrote
`continue_on_error` over steps it cannot cover. The forty-second found it and
fixed the class. This pass found the same thing again in C++, in a place no
`continue_on_error` was involved at all — and, worse, with a comment directly
above it explaining why the guard was sufficient.

### 1. An NTAG could be enrolled with no password at all

`guardian_rfid.cpp`, the enrollment tail:

```cpp
if (!this->picc_classic_ && this->have_version_ && !this->protect_ntag_()) {
  // abort
}
...
this->fire_scan_("enrolled", true);
```

`have_version_` sits in the middle of the conjunction. When GET_VERSION had
failed it is false, the whole condition is false, **`protect_ntag_()` is never
called**, and control falls straight through to `fire_scan_("enrolled", true)`.
The card is bound to a slot with its 36-byte payload world-readable by any
phone, and `enrolled` is indistinguishable from a properly protected
enrollment. Nothing is logged.

The comment above that line said the return value was now checked, so a card
whose PWD/AUTH0 writes failed being "still reported enrolled — with its payload
left world-readable and nothing anywhere saying so" could no longer happen. It
could. The comment described the fix and the code did not implement it.

And the trigger was ordinary: `ntag_get_version_` returns `ST_UNSUPPORTED` on a
short frame **or one bad CRC**, and it had no retry, while the write paths on
either side of it retry three times. One garbled frame during enrollment
produced an unprotected credential. Many NTAG213 clones do not implement
GET_VERSION at all.

Now: GET_VERSION retries three times, and a false `have_version_` is a *failure*
in its own statement rather than a clause that can skip the next one.

### 2. The NTAG password was never an authentication factor

`consume_payload_` opened with `(void) ntag_pwd_ok;` — the answer to "was this
card actually behind a password?" was computed and thrown away. A tag whose
payload read with no password was accepted exactly like one behind `PROT=1`.

So the attack was never "break the 32-bit password". It was **"do not set one"**:
copy the 36 bytes onto an unprotected UID-writable NTAG, the plain read
succeeds, no NAK, `PWD_AUTH` is never attempted, the MAC verifies against the
spoofed UID, and the reader reports `ok`.

It is now recorded and published as `protected` on `esphome.rfid_scanned`.
Deliberately *not* made a hard refusal: that would lock out every card enrolled
before this pass, including any the bug above left unprotected — which is
precisely the population that needs to be let in and re-enrolled rather than
turned away at the door.

The MIFARE path had the mirror problem: it passed a hardcoded `true`, claiming a
card still on the published transport key `FFFFFFFFFFFF` was protected. It now
passes `!classic_legacy_key_`, which is what the word means.

### 3. The transport key, and what was being said under it

`FFFFFFFFFFFF` is not merely an upgrade trigger, it is an accepted credential —
any Classic card not yet upgraded, or whose upgrade soft-failed, is readable by
any thirty-euro reader and clonable onto a magic card. There is now an
`allow_transport_key` option to sunset it once a fleet is fully upgraded.

**It defaults to `true`, and the plan for this pass said `false`.** That was
wrong, and the implementation is where it showed: a factory-blank Classic card
authenticates with *nothing else*, so defaulting to false makes Classic
enrollment impossible and strands every card not yet re-scanned — locking people
out of their own door to close a hole that one scan closes without hurting
anyone. Enrollment is exempt from the flag for the same reason.

The ordering was also backwards. `maybe_upgrade_classic_()` ran *after*
`write_payload_`, so a card's freshly rotated counter and MAC — and on
enrollment, a brand-new `card_id` — went out over the air in a Crypto1 session
keyed with a key printed in this repository, and the sector was secured
immediately afterwards. Upgrading first costs nothing, because
`classic_upgrade_trailer_` re-authenticates with the new key before returning.

### 4. Five HMAC call sites that could write uninitialised stack

`hmac_sha256_` can return false; all five callers discarded it, then `memcpy`'d
`out[32]` — never written on that path — into a password, a Crypto1 key, or a
MAC. On the verify path that is fail-closed. On the **write** paths it is
fail-corrupt, and `write_payload_`'s read-back verify would still *pass*,
because it compares the card against what we intended to write rather than
against what we should have written. The card is reported `enrolled` while being
permanently unusable. The trailer case is worse still: six random bytes as Key A
brick the sector, with no un-protect path in this component.

Every derivation now returns a status, every caller checks it, and the three
exactly-fitting buffers assert the UID bounds they silently depended on.

`verify_mac_` also compared with `memcmp`. **Not exploitable here** — one
measurement per 500 ms poll, against RF and `delay(10)` jitter orders of
magnitude larger than the early-exit delta — and fixed anyway, because a MAC
compared with `memcmp` is a defect whatever the surrounding timings are.

**What was NOT done, and why.** Adding a domain-separation label to
`compute_mac_` was in the plan for this pass. It changes the MAC input, and the
MAC is stored *on the card* — so every enrolled key in the house would fail
`verify_mac_` at once and become a `bad_mac` security alarm, with re-enrollment
the only recovery. That is the same cost this repository refuses to pay for key
rotation. The separation currently holds by length, so it is now enforced by a
`static_assert` and a minimum-UID check instead of being replaced.

### 5. The installer destroyed a household's own automations

`tools/guardian-install.sh` had `automations.yaml`, `scripts.yaml` and
`scenes.yaml` on its unconditional copy list, with a bare `cp` and **no backup
anywhere in the file**. Those are exactly where Home Assistant's UI automation,
script and scene editors save everything a household has ever built. A stranger
with an existing install lost all of it on the first command, and the output
said `updated    automations.yaml`.

The header claimed it never overwrites a `configuration.yaml` it did not write,
and called that "the one step here that can destroy work". `configuration.yaml`
was carefully protected. The three files that actually belong to the user were
not, and the asymmetry had no reason behind it.

Now: every overwrite takes a timestamped `.guardian-backup-<stamp>` first (a
fixed `.bak` would be destroyed by the second run, at exactly the moment
somebody is trying to recover), and those three additionally require
`--replace-my-automations`.

Three silent-failure paths went with it. A failing `cp` was a bare command in an
`if` body, so `set -e` aborted the script mid-loop and the `note_fail` written to
catch it was unreachable — a partial file set, no message, exactly the
half-installed state the script exists to prevent. `to_lf`'s failure was masked
by `|| true` while `>` had already created the file, so a zero-byte
`guardian-luminance.sh` reported `copied`. And a failed fresh-machine
`configuration.yaml` copy was invisible twice over — `set -e` exempts a
non-final command in an AND-OR list, and nothing else checked — after which the
script printed "Files are in place".

### 6. The notification self-test could not fail for the reason people run it

`guardian_notify_person` returns `decision: person` after sends that all carry
`continue_on_error`, and `guardian_notification_selftest` asserted
`decision == 'person'` as a **pass**. So the one tool a household runs to answer
"can this alarm reach my phone?" reported six green checks on a house where
every send was failing.

`continue_on_error` stays — one dead phone must not take down a major-alarm push
to everybody else. The reporting changed: a `delivery: unconfirmed` field, a
title that says **routing**, and a closing paragraph naming what six passes do
and do not prove. Home Assistant's notify platforms give no delivery receipt, so
`unconfirmed` is the honest answer rather than a placeholder for a better one.

### 7. The siren had no way to stop

`Guardian: Major Alarm Handler`'s loop was `repeat: while` on one `input_text`,
with no iteration bound and no timeout. Two ways it ran forever: nobody home to
acknowledge it, or — the subtle one — the write that clears it goes through
`script.guardian_set_display`, which is `mode: queued, max: 25`, and a blocking
call to a queued script at max is **discarded silently**. That script's own
comment reasons carefully about a dropped write meaning no alarm *starts*; the
mirror case, where the dropped write is the IDLE that would have *ended* one, is
considered nowhere.

The forty-second pass wrote "cap the total duration" as a constraint on the
*offline* siren, which did not exist yet. The online one, running in a house for
the whole life of the system, had no cap at all. It is now bounded at 400
iterations — twenty minutes — which is also inside the legal limit for an
audible alarm in most jurisdictions.

### 8. A guard that ran after the thing it guarded

`guardian_reconcile_presence` computed `slot_ok`, its validator, in the **same
`variables:` mapping** as `current: {{ states(entity) }}` and an `expected:`
that built `input_select.rfid_` + slot + `_policy`. Home Assistant renders a
mapping as a unit with no ordering guarantee, so the guard ran after — or
instead of — what it guarded, and an empty slot rendered `input_select.rfid_`
and `input_select.rfid__policy`: a trailing underscore and a double underscore,
both rejected by Home Assistant's own `valid_entity_id`.

`states()` **validates its argument and raises `TemplateError`**, and a raising
template inside a `variables:` block **cannot be guarded at all** —
`continue_on_error` attaches to a step's action, and here the failure is in
rendering an argument. The script simply ends, and it is called blocking from
`process_rfid_scan`.

Not reachable from that caller today, which gates on its own `slot_ok` first.
Reachable from Developer Tools and the panel — and this script re-derives
`slot_ok` precisely because it does not trust its caller.

The new preflight check found two more of the same shape, including one on the
notification path, in the very mapping whose type-coercion bug once made every
phone link in the house dead.

### 9. The panel fired actions the user had cancelled

`disconnectedCallback` cleared five timers and not `_holdTimer` — the only one
that issues a service call. A press-and-hold arms 1100 ms against `this._hass`,
which is not nulled, so a panel torn down mid-hold still fired. Reachable:
`script.guardian_reset {restart_devices: true}` and `guardian_clear_rfid_slot`.

Worse, `_holdEl` was not in the re-render guard, so any state change mid-hold
replaced the button's DOM node — the progress fill vanished, which reads exactly
like a cancelled hold, and the action went through 1.1 seconds later anyway.
Both fixed, plus a `blur` cancel for focus stolen by the OS.

`set-default-panel.js` counted `/lovelace/*` **subpaths** as a "stock landing"
and redirected with `location.replace` up to twenty seconds after load — pulling
someone out of their own dashboard with no Back button. Exact matches only now,
and `assign`.

### 10. The luminance fix removed the instance and left the class

The forty-second pass fixed the shell redirect. It did not fix the shape: the
call site carries `continue_on_error`, and `read_run()` ended `except OSError:
pass`, so a **missing** `luma-run.env` was indistinguishable from a present one
holding the defaults. If `python3` does not resolve inside the container, the
original bug returns byte for byte, reported as success. Two swallowed failures
in series is how a feature stays inert for its whole life.

`read_run()` now reports absence on stderr, which the `command_line` sensor puts
in the log. **Whether `python3` resolves still needs the host to confirm** —
`create_subprocess_exec` uses `execvp` semantics and `python3` is on `PATH` in
the official container, HA OS and a Core venv, but that is reasoning, not a
result. The point of this change is that the system can now tell you.

### New entities

| Entity | Why |
|---|---|
| `number.guardian_interior_portal_offline_authority_hours` | How long the portal keeps believing the house was armed after Home Assistant stops answering. Default 4 h. A number and not a constant, because it decides whether a door screams at 3am on day two of a power cut and the household must be able to see and change it. |
| `number.guardian_interior_portal_offline_siren_max_minutes` | Hard cap on the local siren. Default 5 min. |
| `automation.guardian_offline_siren_report` | Turns `esphome.offline_siren_report` into an urgent nonmaskable push. Without it the offline siren is unfalsifiable. |
| `esphome.rfid_scanned` gains `protected` | "false" means this card's payload is readable by any reader. Previously computed and discarded. |
| `esphome.offline_siren_report` (event) | What the portal did while it was alone. |

### Removed

| Entity | Why |
|---|---|
| `docs/*.docx` (three files) | Re-checked and clean, then deleted for size: 124 MB of embedded images carrying 45 KB of text, referenced by nothing in the build. The text is now in `INSTALL.md` §1. They remain in git history. |

### Preflight

Ten checks became fifteen, and seventeen self-test faults became twenty-two —
one per new guard, each injected as the real defect it was:

- a `variables:` entry that reads a sibling of its own map;
- an actuator loop with no iteration bound;
- a card accepted or enrolled with no protection decision;
- a `reboot_timeout` left to its default on either device;
- an installer that can overwrite a user-owned file without a backup.

The installer check is deliberately stricter than it first looks: it verifies
that `is_user_owned()` actually *names* the three files and that a backup `cp`
is really written, because the first version tested only that the words
appeared — and the fault injection, which neuters the gate to match nothing
while leaving it looking intact, walked straight past it. That is the failure
this whole file exists to prevent, caught on the check written to prevent it.

### Verify

**Nothing below has been run.** Steps 275–282 need hardware that was not present
when they were written; 283–288 can be done from a browser and a terminal.

275. **Preflight and the check for the check.**
     `python tools/guardian-preflight.py` passes with **fifteen** checks and
     reports the version literals agreeing at 2.27.0 — read the number it
     prints, do not trust this sentence, it has been wrong before.
     `python tools/guardian-selftest-preflight.py` must end **`22 of 22 faults
     caught.`** and leave the tree clean. **Read the `N of M` line, not the
     column**: a drifted anchor prints `SKIP` in the same column as `CAUGHT`.
276. **A real card still works at all.** THIS IS THE ONE THAT COMES FIRST. Flash
     both devices, then tap every enrolled key at both readers. Every one must
     report `ok`. The card-acceptance path changed in five places and the
     Classic upgrade now happens *before* the payload write; if a key that
     worked yesterday does not work now, stop, and do not leave this on a door
     you rely on.
277. **An NTAG that cannot be protected is refused.** Present a tag that does
     not answer GET_VERSION (many NTAG213 clones) in enrollment mode. It must
     report `write_fail` and log "GET_VERSION failed, cannot locate the config
     pages". Before this pass it reported `enrolled` and left the card readable.
278. **`protected` is reported honestly.** Scan a normally enrolled NTAG: the
     `esphome.rfid_scanned` event carries `protected: true`. Scan a factory
     Classic card that has never been upgraded: `protected: false`.
279. **The offline siren sounds. THIS HAS NEVER BEEN HEARD.** Put the house in
     elevated mode, confirm the portal shows it, then **stop Home Assistant** (or
     power off the access point). Wait for the portal to show NO LINK. Open the
     door. **The siren must start within about three seconds** and the screen
     must read `!! ALARM !!` with "No link to Home Assistant". Time it.
280. **Both stops work.** Repeat 279 twice: stop it once with a valid card at the
     portal reader, and once by pressing any keypad key. Both must silence it
     immediately.
281. **The cap holds.** Repeat 279 and walk away. It must stop on its own at
     `Offline Siren Max Minutes` and no later.
282. **It reports what it did, and the portal did not reboot underneath it.**
     Bring Home Assistant back. Within about ten seconds a push must arrive
     naming the number of events, the total seconds, and how the last one ended.
     Confirm the counters reset — a second reconnect must not re-report the same
     events. Separately: leave Home Assistant stopped for twenty-five minutes
     with elevated mode last-known ON and confirm the portal does **not** reboot
     (watch its uptime); then leave it stopped past `Offline Authority Hours` and
     confirm it *does* reboot once authority has lapsed. That is the watchdog
     doing its job, and it is what the old 15-minute default would have broken.
283. **The installer refuses to eat your automations.** On a config that already
     has an `automations.yaml`, run `sh tools/guardian-install.sh --apply`. It
     must REFUSE, name the file, and end INSTALL INCOMPLETE. Re-run with
     `--replace-my-automations` and confirm an
     `automations.yaml.guardian-backup-<stamp>` appears **containing the original
     content**. Run it twice and confirm the first backup is not overwritten.
284. **The self-test stops overclaiming.** Run More → Notification self-test with
     a phone that is genuinely unreachable (airplane mode, or unlink it). The
     notification title must say **routing**, and the closing paragraph must say
     delivery is not confirmed. It is allowed to pass; it is not allowed to imply
     the phone buzzed.
285. **The alarm still stops itself.** Fire `guardian.major_alarm`, leave it
     entirely alone, and confirm the siren stops on its own at about twenty
     minutes rather than running until somebody returns.
286. **A hold you cancelled does nothing.** Open More → Devices, start a hold on
     "Hold to reset and reboot both devices", and while holding, switch to
     another app or another tab for two seconds. Nothing must reboot. Repeat,
     holding while a door event arrives (open the door) so the view re-renders
     under your finger: the button must stay put and nothing must fire.
287. **The panel no longer hijacks your dashboard.** With Guardian as the default
     panel, navigate to one of your own Lovelace views and wait thirty seconds.
     You must stay there.
288. **Version.** Panel footer reads `2.27.0`, and More → Diagnostics →
     Installation shows **all four halves at 2.27.0 with no banner**. If the
     banner appears on one device only, it is the spent cache-buster: clear that
     browser's cache — a hard refresh does not reliably re-fetch a dynamically
     imported ES module.

## Forty-fourth pass — the banner that prescribed the opposite of the cure, and the first firmware build

Two things happened in this pass. The first is a bug the household found before
any audit did: a live Diagnostics banner, on every device, giving advice that
could not work. The second is that **the firmware in this repository was
compiled for the first time in its history.**

### 1. Diagnostics named the cure for the direction that was not happening

**Symptom.** After 2.27.0 was deployed, every device in the house showed:

> Home Assistant asked your browser for panel 2.26.0 and got 2.27.0. The rest of
> Guardian is fine — do not re-copy it, and restarting Home Assistant will not
> fix this. […] Clearing the browser cache is then the whole fix […]

Every sentence after the first was wrong, and clearing the cache — the one
action it insisted on — could not possibly help. The household cleared it
anyway, repeatedly, because the banner said to.

**Root cause.** `guardian-panel.js` computed

```js
const panelStale = !!requested && requested !== ui;
```

A plain inequality, with no notion of direction, feeding text that described one
cause and prescribed its cure. The two directions have opposite causes and
opposite cures:

| | cause | cure |
|---|---|---|
| `requested > ui` | the browser is executing an **old file** against a new backend | clear the cache; a restart does nothing |
| `requested < ui` | the file on disk is **new and loaded correctly**; `configuration.yaml`'s `?v=` is stale | edit `configuration.yaml` and restart; **the cache holds nothing stale** |

Only the first was ever described. The second is the one that actually happens,
and it happens on **every single upgrade**, because `guardian-install.sh`
deliberately never overwrites an existing `configuration.yaml` — so the panel
file is replaced and the `?v=` beside it is not. `?v=` is only a cache *key*; it
does not select a version, so the old URL served the new bytes and the panel
correctly reported a disagreement it then misdiagnosed. Fresh installs never see
it, which is why no install-time check caught it.

**This is the third recurrence of "Diagnostics prescribes a remedy that cannot
work."** The fortieth pass found one. The forty-second fixed
restart-versus-cache-clear and introduced *this* variant in the same breath, by
treating a two-directional comparison as one-directional. Fixing the instance
three times has not worked, so this pass fixes the class.

**The fix.** A named classifier, `classifyPanelVersion(requested, ui)`,
returning one of four states — `match`, `unknown`, `browser_behind`,
`config_behind` — each carrying its own `cause`, `remedy` and `tone`. Three
things follow from that shape:

- **The remedy is a field on a state, not text at the point of display.** There
  is exactly one place either can be wrong.
- **The `unknown` state carries an empty remedy by construction.** This is the
  rule that generalises the whole class: *Diagnostics may describe what it sees
  whenever it likes; it may only prescribe against a cause it has established.*
- **Comparison is numeric per component.** `2.9.0` against `2.10.0` is the case
  a string compare gets backwards, and getting it backwards means printing the
  other direction's cure — which is the bug itself.

`config_behind` is also toned `warn` rather than `alarm`. It describes a
correctly deployed, fully working install whose cache-buster is one release
behind. Painting that red taught the household that a red Guardian banner is
noise, which is the expensive part.

**Two further sites were making the same mistake and are fixed with it.** The
Home health summary said *"Copy www/guardian-ui/guardian-panel.js, then
hard-refresh — restarting will not help"*, where in the live direction copying
the file is exactly wrong and a restart is part of the cure. And the per-file
rows said a backend file *"matches what Home Assistant asked for"* on a test
that only held in one direction; they now compare against `requested` and say it
only when it is true.

### 2. The check, and why it executes rather than reads

`check_panel_version_directions` slices `classifyPanelVersion` out of the panel
and **runs it under node**, asserting across five cases that the two directions
produce different states *and different, non-empty* remedies, that neither names
the other's cure, and that `unknown` prescribes nothing.

It executes rather than pattern-matches because **a check that tests for
vocabulary passes on a neutered guard** — the forty-third pass's first installer
check did exactly that and its own fault injection walked past it. The fault
injection here collapses the classifier back to a single branch while leaving
every state name, every remedy string and the whole table **intact**: a
vocabulary check reports clean on it. Only running it fails.

`node` is not a Guardian dependency. Where it is absent the check degrades to a
warning plus the structural assertion that nothing compares the two versions
outside the classifier — scanned against a copy with comments and string bodies
blanked, because otherwise the check matches its own documentation.

### 3. THE FIRMWARE WAS COMPILED. IT IS STILL UNFLASHED AND UNHEARD.

**Every firmware claim in the forty-third pass was reasoning, not result.** That
pass wrote ~400 lines of C++ and the entire offline siren on a machine with no
ESPHome installed. This pass installed ESPHome 2026.8.2 and built both devices.

**Both compiled.**

| device | result | RAM | Flash |
|---|---|---|---|
| `portal-unit` | `Successfully compiled program` | 34.9% | 27.3% (1,073,883 B) |
| `doorbell-unit` | `Successfully compiled program` | — | — |

Everything the previous pass wrote blind builds: the ~350 changed lines in
`guardian_rfid.cpp`, the `static_assert`, the constant-time compares,
`App.safe_reboot()`, the `static` local inside a lambda,
`id(dfplayer_unit).play_mp3(4)`, the `dfplayer:` id, and both new `number:`
entities — including the `initial_value` + `restore_value` pairing that looked
like a schema violation and is not.

**One compiler warning in the whole build**, `-Wempty-body` at
`guardian_rfid.cpp:317`, because `ESP_LOGD` compiles to nothing above debug
level. Harmless, and braced anyway: the first build of this firmware in its
history produced exactly one warning, and a build with one accepted warning is a
build where the second one is not noticed.

**Say it plainly: compiling is not flashing.** The offline siren remains
**unbuilt into any running device, unflashed and unheard**. The ESP32s on this
door are running a build that predates the forty-third pass entirely, so they do
**not** currently have the offline siren, the NTAG protection fix, the
GET_VERSION retries, or `reboot_timeout: 0s`. Steps 279–282 have still never
been run. An untested siren and no siren are the same evidence.

**Build note for the next pass:** `esphome compile` **cannot run under Git Bash**
— ESP-IDF's installer refuses MSYS/Mingw and aborts. Run it from native
PowerShell. And do not pipe it to `tail`: the pipe returns `tail`'s exit code, so
a failed build reports success. That masked the first failure in this pass.

### 4. The installer now bumps the cache-buster it wrote, instead of warning about it

The banner above was correct about its own cause: `?v=` goes stale on every
upgrade because the installer never rewrites `configuration.yaml`. The
forty-third pass added a printed warning about it. That was better than nothing
and it relied on somebody reading a line of console output during an upgrade, so
it recurred every release — **a warning nobody acts on is a defect with a paper
trail**.

`guardian-install.sh` now makes exactly one edit to a `configuration.yaml` it did
not write, and the promise in its header narrows to match: *it never touches
anything in configuration.yaml except the cache-buster it wrote*. The edit is
deliberately the smallest that can exist:

- It rewrites **only** the digits inside a `guardian-ui/*.js?v=` query. The
  substitution is anchored on that shape, so nothing else in a household's file
  can match.
- It takes a **timestamped backup first**, with the same scheme every other
  overwrite uses, and refuses to edit if the backup fails.
- It then **diffs the result against the backup and requires every differing
  line to be a `?v=` line.** If anything else moved, the original goes back.
  `sed` is being pointed at a household's Home Assistant configuration; it does
  not get to be trusted without a receipt.
- It prints the before/after version and the backup path, and is idempotent.

**Two bugs in that code were found by running it, not by reading it**, which is
worth recording because both are invisible on the page. `grep -c` exits **1**
when the count is zero — the success case — so under `set -eu` the script died
one line after taking the backup. And `\1$VERSION` in the `sed` replacement
reads as backreference `\12` for a version starting with `2`; only GNU sed
resolves that the way it looks, and this script is written to survive BusyBox.
The capture group now ends before `.js` so the backreference is followed by a
`.`.

### 5. "Off" gave the household a Home Assistant error dialog

**Symptom.** Pressing **Off** on a person's notification level produced a raw HA
error: *"Invalid option: Off (possible options: Important, Everything, Urgent
only). Guardian's own state is unchanged."*

**Root cause.** The panel drew all four levels from its own constant and called
`input_select.select_option` with whichever was pressed. The deployed helper had
three. **Nothing detected it, because version agreement is not entity
agreement**: every half reported the same version, and the version check compares
literals in five files while saying nothing about whether the entities those
files declare have the shape the panel drives.

**Fix.** The control is now drawn from the **entity's own `options` attribute**.
A button that cannot work is never offered, and the gap is *reported* — with the
cause (an `input_select`'s options come from the package that declares it) and
the remedy (copy `packages/guardian_rfid.yaml` and restart **fully**; packages do
not merge on a reload). Same rule as the banner: describe what you found, and
prescribe only against a cause you established.

### 6. Three of the four notification levels looked identical, because their effect was never drawn

**Symptom.** Moving between Everything, Important and Urgent only appeared to
change nothing, and the six category switches looked the same at every level, so
the level control read as decorative.

**Root cause.** It was not decorative — its effect was simply never shown. The
backend rule in `guardian_notify_person` is

```
wants = nomask or (cat not in muted
                   and ((subj == me and 'mine' not in muted) or rank >= floor))
```

The level is a **floor on severity**, ANDed with the category switch. The switches
are unaffected by the floor, so drawing them identically at every level was
accurate and useless: a household that moved the level and watched nothing change
concluded, reasonably, that the level did nothing.

**Fix.** Each category row now states **what it will actually deliver at the
current level**, so moving the level visibly rewrites all six:

| level | a normal category says |
|---|---|
| Everything | "Everything in this category." |
| Important | "Only the important and urgent ones." |
| Urgent only | "Only the urgent ones." |
| Off | "Nothing at this level — only alarms and stolen cards, which always come through." |

`My key` says *"Everything about your own key, at every level"* at all four,
because it clears the floor by its own branch — previously that was mentioned
only in a hint on one level, which made it look like a quirk of that level rather
than the rule it is. A muted category says so, and says it applies at **any**
level.

**And "Custom" is now a state the screen names.** A person with muted categories
is not on their chosen level; they are on that level with exceptions, and the
level control alone could not show it. Someone who muted three categories months
ago saw a screen identical to someone who had muted none and read their own
setting as "Important", which was not what was gating their alerts. The card now
carries a `Important · customised` pill, a count, and a note saying what is
actually narrower than the level claims.

### New entities

None. No helper, automation, script or ESPHome entity was added or removed. The
notification work reads entities that already existed.

### Removed

Nothing.

### Preflight

Three new checks (**18 total**):

- `check_panel_version_directions` — executes the classifier under node.
- `check_notify_level_contract` — every level the panel offers must be declared
  by every `rfid_N_notify_level` helper, **and** the panel's `LEVEL_FLOOR` must
  equal `guardian_notify_person`'s own `floors` map. The second matters more
  than the first: a drifted transcription does not throw, it produces a screen
  that describes somebody's alerting confidently and wrongly.
- `check_installer_backups` extended to cover the new `configuration.yaml` edit —
  backup before the edit, and the stray-line count actually acted on.

Four new fault injections — **26 of 26 faults caught**.

### Deploy class

`www/guardian-ui/guardian-panel.js` is the only deployed file whose behaviour
changed; the version bump touches the other halves. **Full restart** (the
version literals live in `packages/`, which merge only on a full restart) **plus
a cache clear or a `?v=` bump**. The `guardian_rfid.cpp` change is cosmetic and
needs a **reflash** to take effect — there is no reason to reflash for it alone.

**Note the ordering trap on this particular upgrade.** If you copy the panel but
leave `configuration.yaml` at the old `?v=`, browsers holding the old key keep
serving the old file and you will not see this fix at all. Bump both `?v=` lines
to `2.28.0` and restart, or clear the cache once.

### Verify

289. **The banner tells the truth in the direction that is happening.** On a
     tree at 2.28.0 with `configuration.yaml` still at `?v=2.27.0`, More →
     Diagnostics → Installation must read *"configuration.yaml still asks for the
     old panel"*, must name **editing configuration.yaml and restarting**, must
     say clearing the cache cannot fix it, and must be **amber, not red**. The
     four backend rows must all read *"Matches this panel"* with no alarm tone.
290. **And in the other direction.** Bump both `?v=` lines to `2.28.0`, restart,
     and load the panel in a browser that still holds the 2.27.0 module. It must
     read *"This page is running an old panel"*, must name **clearing the cache**,
     and must say a restart will not help. This is the only case the old banner
     described and it must not have regressed.
291. **Neither cure appears under the other cause.** In 289 the word "cache" must
     not appear as an instruction; in 290 `configuration.yaml` must not.
292. **No banner at all when they agree.** With `?v=2.28.0` and a cleared cache,
     the Installation card shows all halves at 2.28.0 and no note.
293. **The check catches the bug it was written for.** `python
     tools/guardian-selftest-preflight.py` must end **`26 of 26 faults caught.`**
     Read the count line, not the column. *(Said `23 of 23` until the
     forty-fifth pass. It was a hand-transcribed number and it was wrong on the
     day it was written — this same pass's own Preflight section said 26 four
     paragraphs earlier and the tool printed 26. Anyone running step 293 on a
     correct tree concluded the tree was broken.
     `check_selftest_count_documented` now compares the newest quoted figure
     against the real injection count, so this cannot drift again.)*
294. **The firmware still builds.** From **PowerShell, not Git Bash**:
     `esphome compile esphome/portal-unit.yaml` and the same for
     `doorbell-unit.yaml`. Both must end `Successfully compiled program` with
     **zero** compiler warnings.
295. **The installer bumps the cache-buster, and only that.** On a copy of a
     live `/config` whose `configuration.yaml` is at the previous `?v=`, run
     `tools/guardian-install.sh --config-dir <copy> --apply`. It must print
     `bumped configuration.yaml ?v=<old> -> ?v=<new>` and a backup path, and
     `diff` between the backup and the new file must show **only** `?v=` lines.
     Run it a second time: it must print nothing about bumping. *(Done on a
     synthetic config in the forty-fourth pass — both `?v=` lines moved, a
     household `input_boolean` block a few lines below was untouched, and the
     second run was silent. Not yet run against a real `/config`.)*
296. **"Off" no longer errors, or is no longer offered.** Open More → a key →
     notifications and press **Off**. Either it takes — the pill reads `Off` —
     or the level is not offered at all and the card explains that
     `packages/guardian_rfid.yaml` has not merged and needs a full restart.
     **What must not happen is a Home Assistant error dialog.** If Off is
     missing, copy that package, restart fully, and repeat.
297. **The levels visibly differ.** On the same screen, move between Everything,
     Important and Urgent only. **Every one of the six category rows must change
     its bold line** — "Everything in this category", "Only the important and
     urgent ones", "Only the urgent ones". At Off, five of the six must read
     "Nothing at this level"; `My key` must keep saying it comes through at every
     level.
298. **Custom is visible.** Mute one category. The card must show a
     `… · customised` pill, a `1 of 6 muted` count, and a note saying what
     actually reaches the phone is narrower than the level says. Unmute it and
     both must disappear.
299. **The described behaviour is the real behaviour.** This is the one that
     needs a phone. With a person on **Urgent only** and nothing muted, fire a
     routine event and confirm **no** push arrives; fire an alarm and confirm one
     does. The screen now makes a specific promise per category and per level,
     and steps 296–298 only prove the screen is self-consistent. *Needs a real
     phone; not done.*

## Forty-fifth pass — the alarm a restart ended, and the capacity nobody counted

This pass began by verifying the forty-fourth rather than inheriting it, which is
the rule that has found a live bug in every predecessor it was applied to. It did
so again, twice: once in code nobody had questioned, and once in the forty-fourth
pass's own verify steps.

**Two of the three findings here were established by executing an analysis over
the tree, not by reading it.** That distinction matters because the second
finding had already been *reasoned about* — a plausible list of four affected
scripts existed — and the arithmetic disagreed with the reasoning about three of
the four while naming three others the reasoning had missed.

### 1. A Home Assistant restart ended a live alarm, and the code written to resume it could never run

**Symptom, and why nobody saw it.** There is none. That is the finding. An alarm
in progress ended silently on every restart — no siren, no second push, no
record, and nothing anywhere reporting that it had happened.

**Root cause.** `packages/guardian.yaml` declares:

```yaml
portal_display_state:
  # Session state: initial: none so a restart does
  # not restore ALARM with no siren loop running (audit F-19).
  initial: none
```

`initial:` is applied by Home Assistant on **every** start and **skips
restore_state**. So that helper reads `none` at every boot, always. And
`Guardian: Startup State Recovery` contained:

```yaml
# A restart kills the loop, but portal_display_state restores to ALARM […]
# Re-fire the event to re-arm it rather than clearing the alarm.
- if:
  - condition: state
    entity_id: input_text.portal_display_state
    state: ALARM
  then:
  - event: guardian.major_alarm
```

The comment and the helper state opposite things and the helper is right. **The
condition could never be true. The branch had never fired on any install, on any
version, since it was written.**

There was no other durable trace either: `guardian.major_alarm` is a bus event,
`input_text.guardian_alarm_reason` also carries `initial: none`, and
`Guardian: Record An Interrupted Flow At Shutdown` latches a mid-challenge and a
mid-PIN-change and **not** a live alarm.

**This is the same trap, in the same automation, twenty lines apart.** That
automation's own comment reads: *"all four carry initial: false, which Home
Assistant applies on every start and which skips restore_state. So both variables
were ALWAYS false and neither notification below has ever been sent."* The class
was found, four instances were fixed by hand, and the fifth was left standing in
the one branch that resumes the burglar alarm. Fixing instances by hand is what
the check below exists to stop.

**The fix.** One restore-surviving latch, `input_text.guardian_alarm_latch`,
declared with **no `initial:`** — that absence is the entire feature — holding
either `none` or the ISO timestamp at which the display was last set to ALARM.

Three properties are deliberate:

- **It is written from exactly one place.** `guardian_set_display`'s own alias is
  *"the single way to put a verdict on the portal"*, so the latch is set there and
  nowhere else. Latch and screen then move together or not at all, and all
  fifty-odd existing writers — `Dismiss Alarm from Phone`, `guardian_reset`,
  `guardian_clear_doorbell_exit_pin` — clear it correctly with no edit.
- **It is a timestamp, not a flag**, because the startup reader needs *how long
  ago*, not merely *whether*. A `restore_state` snapshot can be fifteen minutes
  stale, so a latch found at boot proves an alarm was running at some point and
  only its age separates "restarted during a break-in" from "the power came back
  after an eight-hour cut".
- **`input_number.guardian_alarm_resume_minutes`, default 30**, bounds that age,
  and it is a helper rather than a compiled constant for the same reason the
  offline siren's staleness bound is a `number` on the device: this is the figure
  that decides whether a house screams at 3am on day two of an outage, and a
  household must be able to see and change it. 30 is comfortably above the
  fifteen-minute snapshot worst case and far below any real outage.

**Read early, acted on late, and never cleared by hand.** The latch is snapshotted
into a variable *before* `guardian_reset_auth` runs, because that script ends by
writing IDLE through `guardian_set_display` whenever the display is neither ALARM
nor IDLE — which at boot it never is — and that write clears the latch. Nothing
in the branch writes the latch directly: resuming fires the handler, which writes
ALARM and stamps a fresh timestamp, and not resuming leaves the reset's IDLE
write to have already cleared it. Both paths go through the single writer.

**An alarm too old to resume now says so** rather than vanishing, as an important
(not urgent) broadcast. The bound exists because re-sounding it is the wrong
answer; saying nothing at all is a different wrong answer.

### 2. Blocking-call capacity, counted rather than reasoned

A blocking `action: script.x` against a `queued` or `single` script already at
max is **discarded silently** — it does not raise, and the caller proceeds as
though it ran. The rule was already known here; the quantity nobody had computed
is the **demand**.

```
demand   = over every unit that blocking-calls it, how many runs that unit
           can have in flight  (1 for single/queued/restart, max for parallel)
capacity = max for queued and parallel, 1 for single
```

`capacity >= demand` is a **proof** that no blocking call can ever find the queue
full. Home Assistant offers no script mode that structurally cannot drop, so this
arithmetic is the strongest guarantee available. Executed over all 36 scripts and
68 automations, three failed it:

| script | was | capacity | demand | what a drop costs |
|---|---|---|---|---|
| `guardian_sample_ambient_light` | `single` | 1 | **6** | certain, not theoretical — `single` has no queue, so the second concurrent caller is discarded always |
| `guardian_notify_broadcast` | `parallel/20` | 20 | **36** | a major alarm's nonmaskable escalation reaching nobody's phone |
| `guardian_reset_auth` | `queued/3` | 3 | **4** | the teardown of three timers that each count down to `guardian.major_alarm` — the siren fires at somebody who authenticated correctly |

**The reasoned list was wrong in both directions, which is the argument for
computing it.** A prior analysis had named four scripts —
`guardian_clear_entry_challenge`, `guardian_reset_auth`,
`guardian_clear_doorbell_exit_pin`, `guardian_start_doorbell_exit_pin`. Three of
those four have headroom today (3/2, 3/2 and 5/1), because their callers are
`queued` or `single` units that serialise and therefore hold one call each. They
are one new caller away from the fault with nothing recording the margin — which
is a reason for the check, not for editing them. Meanwhile the two worst
instances were not on the list at all.

**And the first count of `notify_broadcast` came out at 21 instead of 36**, by
leaving out the callers that pass `continue_on_error`. That flag has *nothing* to
do with dropping: it decides what happens when a callee **raises**, and a call
discarded for want of a queue slot never runs and never raises. A guarded
blocking call occupies capacity and is deceived by a drop exactly like an
unguarded one. Count every blocking call.

`script.turn_on` is correctly excluded: the caller does not wait and is not told
a result, so a drop there deceives nobody — which is why several hot paths in
this repository use that idiom deliberately.

**`guardian_sample_ambient_light` moved to `queued`, not to a higher parallel
max.** `single` was doing real work: the script blacks the bulb out and restores
it from `prev_brightness`/`prev_kelvin` captured at the top, so two concurrent
runs would each capture the other's blackout as the "previous" state and leave
the lamp off. `queued` serialises exactly as `single` does and keeps that race
closed; it simply stops throwing the second call away. The trade is explicit — a
redundant sample is now taken a moment late rather than lost.

### 3. The NTAG protection state was published to nobody, and it still is on this door

The forty-third pass recorded the on-card protection state as *"surfaced on the
scan event"* to the household. Both devices do emit it, on every scan, and
**nothing in `automations.yaml`, `scripts.yaml`, `packages/` or the panel read
it** — an event with no subscriber.

It was being dropped earlier than anyone had noticed: `Guardian: RFID Scanned`
forwards `uid`, `source`, `result`, `card_id`, `counter` and `rotated` into
`process_rfid_scan` and never passed `protected`, so the field was gone before any
script could have read it however much it wanted to.

**Now consumed, stored per slot, and shown — and it gates nothing.** That last
part is not caution, it is the two lessons this component has already paid for:
refusing an unprotected tag would lock out every card enrolled before the
protection fix existed, which on this door is all of them, and that is exactly
the population that most needs to be let in *and told*. No condition on any path
that opens a door reads this.

**Three states, not two, which is why the helper is a pair list.**
`input_text.guardian_card_protection` holds `1p,3u` — `p` protected, `u`
unprotected, **absent means no reader has ever said**. A plain list of
unprotected ids would collapse "protected" and "nobody has ever looked" into the
same blank, and the second is the state every key in this house is actually in:
both devices are running firmware older than the field and say nothing on every
scan. Telling a household their keys had been checked and passed when nothing has
ever looked at them is the one thing this must not do.

The panel renders it from a `CARD_PROTECTION` table with the same shape and the
same rule as `classifyPanelVersion`: the remedy is a **field on a state**, and a
state may only prescribe against a cause it has established. `unprotected` names
a fix because something is established to be wrong. `not checked` says plainly
that nothing is known to be wrong, and names the reason nobody knows — which is a
different claim, and a true one.

**The dispatcher defaults the field to empty, not `false`.** A reader running
older firmware sends nothing, and reading that as "unprotected" would report
every key in the house as clonable, which is an accusation rather than a finding.

### 4. A verify step that could not be satisfied

Step 293 told a reader to confirm `23 of 23 faults caught.` The same pass's own
Preflight section said 26 four paragraphs earlier, and the tool printed 26.
Anyone running step 293 on a correct tree concluded the tree was broken. Corrected
in place — it is that pass's own transcription error, not a renumbering — and
`check_selftest_count_documented` now compares the newest quoted figure against
the real injection count so it cannot drift again. Earlier passes keep their own
counts; those are a record.

### New entities

| entity | file | why |
|---|---|---|
| `input_text.guardian_alarm_latch` | `packages/guardian.yaml` | the only durable evidence of a live alarm. **No `initial:`** — that is the feature |
| `input_number.guardian_alarm_resume_minutes` | `packages/guardian.yaml` | how old that evidence may be and still resume. Default 30 |
| `input_text.guardian_card_protection` | `packages/guardian_rfid.yaml` | per-slot on-card protection as `1p,3u`. **No `initial:`** — a finding about physical cards does not stop being true across a restart |

### Removed

Nothing.

### Preflight

Three new checks (**21 total**):

- `check_startup_reachable_state` — no condition in a `homeassistant: start`
  automation may test a helper for a value its own `initial:` makes unreachable.
  Reported exactly one violation on the tree as found, and retro-catches the
  four-flag bug a previous pass fixed by hand.
- `check_blocking_call_capacity` — computes demand and capacity from the call
  graph and fails on any script with less room than the blocking calls that can
  arrive at once.
- `check_selftest_count_documented` — the newest `N of M faults caught` in this
  file must equal the real injection count.

Three new fault injections — **29 of 29 faults caught**.

### Deploy class

**FULL RESTART, plus the panel and a `?v=` bump.** Three new helpers live in
`packages/`, which merge only on a **full restart** and never on a reload — a
reload leaves the latch absent, and an absent latch means an alarm still does not
survive a restart. `www/guardian-ui/guardian-panel.js` must be recopied for the
key list. The installer bumps `configuration.yaml`'s `?v=` itself now; verify
that rather than assume it.

**NO REFLASH IS REQUIRED, AND ONE FEATURE IS INERT WITHOUT ONE.** No firmware
file changed in this pass. But finding 3 reads a field only a device flashed with
the forty-third pass or later actually sends, and **both devices on this door
predate it**. Every key will therefore read **Not checked** until step 276 has
been run — which is correct, honest, and exactly why that third state exists.

### Verify

300. **The alarm survives a restart.** Fire `guardian.major_alarm` from
     Developer Tools. With the siren running, restart Home Assistant fully. Within
     about thirty seconds of it coming back the alarm must **resume** — ALARM on
     the portal, the siren sounding, a second push — with a reason naming how many
     minutes ago it started. *Needs a real siren and a real phone; not done.*
301. **And it does not resume from an old one.** Set
     `input_number.guardian_alarm_resume_minutes` to 1, fire an alarm, dismiss it,
     set `input_text.guardian_alarm_latch` by hand to a timestamp two hours old,
     and restart. The alarm must **not** resume, and a broadcast must arrive
     saying an alarm ended by an outage and was not resumed. *Not done.*
302. **The latch tracks the screen and nothing else writes it.** Watch
     `input_text.guardian_alarm_latch` while a card is scanned, a challenge opens
     and an alarm is dismissed. It must be a timestamp exactly while the display
     reads ALARM and `none` at every other moment.
303. **The branch that was dead is now live.** `python
     tools/guardian-preflight.py` must report **21 checks** and
     *"no startup branch tests a helper for a value its own initial: makes
     unreachable"*.
304. **The capacity check holds.** Same run must report *"every script has
     capacity for every blocking call that can arrive at once"* and name the
     tightest margins. If a future pass adds a caller, this is the line that will
     say so.
305. **The self-test proves all three new guards.** `python
     tools/guardian-selftest-preflight.py` must end **`30 of 30 faults caught.`**
     Read the count line, **not** the column — a SKIP prints in the same column as
     a CAUGHT. The tree must be clean afterwards.
306. **Every key reads "Not checked", and that is the correct answer today.**
     More → Keys, People & Alerts. Every registered key must show a **Card
     security** field reading *Not checked*, with text saying nothing is known to
     be wrong and that the readers only report it from 2.29.0 onward. **A key
     reading "Protected" before either device has been reflashed is a bug** — it
     would mean the panel is treating silence as a pass.
307. **And it changes once the firmware is flashed.** After step 276, tap each
     key. A card enrolled by the current firmware must read **Protected**; one
     enrolled before the protection fix must read **Clonable**, carry a warn-toned
     badge, and name re-enrolling as the fix. **Whatever it reads, the door must
     still open** — this gates nothing, and a key that stops working because of
     this pass is the most serious possible regression from it. *Needs a real
     card; not done.*
### 5. A working install was reporting itself as broken, on every upgrade

**Symptom, reported by the household on the running system.** A **NEEDS
ATTENTION** card on the landing page: *"configuration.yaml still asks for the old
panel."* It survived repeated cache clears. Everything about it was true, the
remedy it named was correct, and **nothing was wrong with the system.**

**Root cause, and it is not the banner's text — it is which channel the banner
used.** `buildInstall` folded two different questions into one `ok` flag:

| question | answer | what it should drive |
|---|---|---|
| Is Guardian deployed correctly **right now**? | yes — panel 2.29.0, all four backend halves 2.29.0, rack answering | NEEDS ATTENTION |
| Will the **next** upgrade land correctly? | no — `?v=` is a release behind, so a browser will be served a cached panel | a maintenance note |

`config_behind` is the second, and it was being reported through the first. The
forty-fourth pass toned it `warn` rather than `alarm` for exactly this reason and
**stopped one step short: the tone changed and the banner did not.** So a fully
working install put a red-flavoured card on the household's landing page, every
release, saying nothing was wrong in six sentences — and it stayed through cache
clears, because clearing the cache genuinely cannot fix it. That is how a
household learns that a Guardian banner is furniture, and losing that channel is
expensive, because the same channel has to carry *"your browser is running old
logic against a new backend"*, which is a real fault.

**`ok` now excludes only `browser_behind`.** The stale cache-buster is still
reported in full, on the Installation card, as the maintenance job it is —
opening with *"Guardian is deployed correctly and running 2.29.0"* and then the
one outstanding item. It is no longer a fault on the home page, and
`config_behind` was removed from the fault-title list entirely: it can no longer
be the sole reason `ok` is false, so reaching that list with a stale `?v=` means
something else is wrong and naming the cache-buster would bury the real fault
under the cosmetic one.

**And the remedy now names the tool first.** It opened with *"Edit
configuration.yaml"*, and a household read that every release for three releases
running — because **a remedy that is a manual edit is a remedy somebody has to
remember.** `guardian-install.sh --apply` has rewritten exactly this line since
the forty-fourth pass. **Verified this pass against a synthetic `/config` at the
previous version:** both `?v=` lines moved to 2.29.0, a timestamped backup was
written, and nothing else in the file changed. The hand-edit stays as the
fallback for somebody who deploys by copying files — which is how this kept
recurring, since the fix lived in a tool they were not running.

### 6. The deployed-tree check would have told a household to destroy their own configuration.yaml

Found by running the tool against a `/config` built to reproduce the report in
finding 5 — everything at 2.29.0, `configuration.yaml` at `?v=2.28.0`. It caught
the drift precisely, and then printed:

> Copy configuration.yaml ?v= #1, configuration.yaml ?v= #2 again from the same
> commit, then restart Home Assistant fully.

**Nothing copies `configuration.yaml`.** `guardian-install.sh` deliberately
refuses to, because that file holds the household's own `http:`,
`recorder:` and `panel_custom` blocks. Following that instruction replaces all of
it with the repository's. And it is the *one* file that goes stale on every
single upgrade, so it was by far the most likely line anybody would ever read out
of this check.

**Fourth recurrence of "prescribes a remedy that cannot work", and the first
outside the panel** — sitting in the checker written to catch that class in other
files. The remedy is now split by what each file actually needs: copy, for the
files Guardian owns; the installer or a two-line hand-edit, for
`configuration.yaml`, with an explicit *do not copy it*.

**And two of the nine deployed files had no staleness detection at all.**
`_scan_versions` reads version literals, and `www/guardian-ui/set-default-panel.js`
and `guardian/guardian-luminance.py` carry none — so a copy of either from two
releases ago was reported by nothing, anywhere, forever. The second is 747 lines
deciding what the door lamp measures and therefore when it comes on.
`check_deployed` now byte-compares the five Guardian-owned files against the
tree, which is stronger than a literal anyway: it also catches a file edited
twice inside one release where the household copied the first edit. Line endings
are normalised first, or a Windows checkout against a Pi would fail every run.

*Proven by reproduction rather than by fault injection: the self-test's
`--config-dir .` uses the repository as its own deployed tree, so the two sides
are the same bytes by construction and a drift cannot be injected. Demonstrated
live instead — appending one line to a copy of `guardian-luminance.py` in a
synthetic `/config` produced* `a deployed file differs from the repository`, *and
that same drift was undetectable before this change.* The wrong-remedy half **is**
fault-injected, at 30 of 30.

308. **The version is consistent.** Preflight must report all literals at
     **2.29.0**, and More → Diagnostics → Installation must show every half at
     2.29.0 with no banner once `configuration.yaml` is bumped and the cache
     cleared.
309. **A stale cache-buster is no longer a NEEDS ATTENTION card.** On a tree at
     2.29.0 whose `configuration.yaml` still says `?v=2.28.0`, the Guardian home
     page must show **no** install fault. More → Diagnostics → Installation must
     show an amber note opening *"Guardian is deployed correctly and running
     2.29.0"*, naming `tools/guardian-install.sh --apply` **before** the
     hand-edit, and all five rows at 2.29.0.
310. **The real one still shouts.** Load the panel in a browser holding a genuinely
     older module against a 2.29.0 backend. That **must** still raise NEEDS
     ATTENTION, titled *"This page is running an old panel"*, and name clearing
     the cache. This is the fault the channel exists for and it must not have
     been quietened along with the noise.
311. **The installer closes it without an edit.** On a copy of the live `/config`,
     run `tools/guardian-install.sh --config-dir <copy> --apply`, then `diff`
     against the backup it wrote: only `?v=` lines may differ. *(Run this pass
     against a synthetic `/config` at 2.28.0 — both lines moved to 2.29.0, backup
     written, nothing else touched. Not yet run against a real `/config`.)*
312. **RUN PREFLIGHT AGAINST THE PI, NOT JUST THE REPOSITORY.** This is the step
     that would have caught the whole of finding 5 before it reached a screen,
     and nothing in this document had ever told anyone to do it:

     ```
     python tools/guardian-preflight.py --config-dir /config
     ```

     It must report *"all 9 runtime files present"*, *"every deployed file
     reports 2.29.0"* and *"all 5 Guardian-owned files … are byte-identical to
     this tree"*. **Make this the last step of every deploy.** The repository
     passing says the tree is correct; only this says the tree is correct *and on
     the Pi*, and those are different claims that have now been confused once.
313. **The remedy for a stale configuration.yaml never says "copy it".** With
     `/config` at the previous `?v=`, step 312 must fail with **DO NOT COPY
     configuration.yaml** and name the installer. It must not tell anyone to
     overwrite a file holding their own `http:` and `recorder:` blocks.

## Forty-sixth pass — a genuine key that died until re-enroll, and docs that still said the PCBs were missing

This pass began from a live report: **occasionally a registered key is not
recognised; re-enrolling the same card makes it work again.** Re-enrollment
mints a new `card_id` and resets the counter. That is a clue, not a fix. The
suspected cause was a rolling-counter desync. The code agrees, and it is not
the clone window.

### 1. Torn rotate write, empty `card_id`, DENIED_CARD

`write_payload_` committed NTAG pages in address order, so the counter (page 8)
went down before the MAC (pages 9–12). Classic did the same: block 5 holds the
counter and most of the MAC. A lift between them left GDN1 with a new counter
and an old or mixed MAC. The next poll `verify_mac_` failed.

`handle_selected_` clears `card_id_hex_` at the start of every presentation.
`fire_scan_("bad_mac")` therefore reached Home Assistant with an empty
`card_id`. `process_rfid_scan` matches slots on a 16-hex `card_id`. No match
is **DENIED_CARD / "Card not recognised"** — which is exactly the report —
not HOLD, not COPY DETECTED.

This was already named under *Still outstanding* ("A card withdrawn mid-write
becomes a permanent alarm against its owner"). The recommended format change
(journal page / dual-counter MAC) would invalidate every enrolled card. This
pass heals it **without** changing the on-card layout:

- **Counter last.** NTAG writes MAC pages before the counter page. Classic
  writes the MAC-tail block before the counter block. A torn write is then
  either still the old consistent payload or has the new MAC against the old
  counter, both recoverable.
- **Torn-write MAC recovery.** If GDN1 is present and the MAC fails for the
  on-card counter, the reader tries `counter-1` (old MAC, new counter) and
  `counter+1` (new MAC, old counter). A dump clone is internally consistent, so
  this is not a stale-counter accept. On a hit it rewrites a fully consistent
  payload for the intended next counter and fires `ok` / `rotated=true` only
  after that rewrite verifies.
- **`pending_retry_` must not condemn, and must not double-rotate.** The
  intended next counter is stashed when a rotate write starts. If a later poll
  already verifies at that value, the reader fires `ok/rotated` and does **not**
  rotate again (the old path would have skipped a counter Home Assistant never
  saw). If the MAC is still broken, it retries the stashed payload. `bad_mac`
  is only a terminal verdict.
- **`card_id` is always taken from GDN1 before any `bad_mac`**, so a registered
  key that still cannot be healed paints HOLD, not "Card not recognised".
- INFO logs on both devices: `RFID scan (...): result=... card_id=...
  counter=... rotated=...`.

**`window_ok` is unchanged.** Clone detection stays `rotated && reported <=
stored`. A double-tap that reports the same post-rotate counter is still CLONE.
Do not re-enroll to "fix" COPY DETECTED.

HOLD copy now says hold / retry, and **re-enroll only after three HOLDs on the
same key**. The DFPlayer volume is set to 30 on portal boot (it was whatever
the module powered up at).

None of this has been run against a real card. Compiling is not flashing, and
flashing is not a tap.

### 2. The hardware files were already in the tree. The docs said they were not.

`3D-Models/Main/` holds the current exploded print set. `3D-Models/OLD/` holds
the superseded monoliths. `PCBs/Doorbell/` and `PCBs/Interior-Portal/` are
KiCad 10 schematic+board+project **and** Gerber+drill zips.
**Closed later:** `3D-Models/` is an index only. Meshes are not in this tree;
print files are the three `.3mf` profiles on MakerWorld / Printables. README, INSTALL §1
and this file's *Before this is published* list used to say **no schematic,
six `.stl` files**, then **no Gerbers**. Those sentences are now false, and
replacing them with "the hardware is a product" would also be false.

Honest remainder: no CPL / pick-and-place (THT proto boards, hand-solder),
nets are auto-named off generic connectors, there is no KiCad project for the
lamp because the lamp is a commercial bulb and a commercial camera in a
printed housing. Passives are valued (doorbell button 10 kΩ; portal 1 kΩ and
1000 µF 10 V). The doorbell RFID header is labelled `RFID1`. Firmware GPIO
remains the pin authority. The doorbell board file does line up with
GPIO21 / 22 / 23 / 0–2 if `XIAO_LEFT1` is the D0–D6 row. The portal board was
not reverse-mapped pin-by-pin from KiCad text.

`Top-Scew-Cover.stl` is `Top-Screw-Cover.stl`. Panel SVG envelope numbers are
still the old monolith measurements; they were not re-measured from the
exploded set.

### 3. The publish bar, on the first screen

README and INSTALL now open with **ready with documented caveats**, and the
caveats are on that screen: offline siren unheard, Gerbers-for-proto-fab-not-CPL,
card key in outdoor flash, rotation bricks cards, Classic clonable, publish a
fresh repo not this git history, preflight is static, one HA account is full
control, no tamper. Moving any of that into this pass's footnotes is how a
stranger gets misled.

### New entities

None.

### Removed

Nothing.

### Deploy class

**FULL RESTART, then reflash both ESP32s.** Scripts and the panel changed;
packages only moved a version literal, which still needs a full restart.
RFID recovery and DFPlayer volume live in firmware. Order: copy / installer
`--apply` / restart, **then** flash portal and doorbell. An unflashed reader
still kills a genuine key that is lifted mid-write.

**Copy `www/guardian-ui/guardian-panel.js` even though most of it did not
change.** Its version literal did.

### Verify

314. **A registered key that used to die until re-enroll HOLDs or grants.**
     Flash both readers. Enable
     `input_boolean.guardian_verbose_notifications`. Present a known NTAG,
     lift during the write (the HOLD CARD prompt), wait two seconds, tap
     again. The portal must not say "Card not recognised". Acceptable:
     GRANTED, or HOLD CARD with a persistent notification telling you to
     retry and not to re-enroll yet. ESPHome must log
     `RFID scan (...): result=... card_id=... counter=... rotated=...` with a
     16-hex `card_id` even on `bad_mac`. Compare that line to
     `input_text.rfid_N_card_id` and `input_number.rfid_N_counter`.
     *Needs a real card; not done.*
315. **Three HOLDs, then re-enroll is actually the remedy.** If the same key
     HOLDs three times in a row with `result=bad_mac` and a matching
     `card_id`, re-enroll it. That is the unrecoverable torn-MAC case
     (Classic mixed block), not the first tap.
316. **CLONE is still CLONE.** Doorbell then portal on the same key (old
     steps 99–101). Both grant; the helper is the max of the two, never
     rewound. A second rotated event with the same `reported` as `stored`
     must still say COPY DETECTED, not GRANT. Do not widen `window_ok` if
     this fires on a real double-tap — look at that clause first, as the
     comment already says.
317. **The siren volume is no longer "whatever the module remembers".** After
     the portal reflash, press Play Alarm. It must be loud enough to be an
     alarm at volume 30. If it is not, the speaker and the housing are the
     remaining variables. *Needs a real DFPlayer; not done.*
318. **INSTALL §1 matches the tree.** A stranger opening `3D-Models/Main/`
     sees the exploded sets named in that section; `OLD/` is labelled
     archive; `PCBs/` exists; the GPIO table includes doorbell I²C GPIO22/23;
     the text does **not** say "six `.stl` files" or "no KiCad project".
319. **The first screen states the caveats.** README's status banner and
     INSTALL's opening list both name: no proven offline siren, schematic
     not fab-ready, outdoor flash holds the card key, rotation bricks cards,
     fresh repo before public GitHub. None of those live only in this pass.
320. **Preflight.** `python tools/guardian-preflight.py` reports all literals
     at **2.30.0**. The self-test count is still the one in step 305 — this
     pass added no injections, so do not transcribe a new figure here.
321. **Check configuration** on the live Home Assistant after copy and
     restart, before relying on a door. *Needs the Pi; not done.*

## Forty-seventh pass — tamper both halves, encryption as opt-in, keys bound to accounts

This pass restores portal tamper as a firmware+Home Assistant pair, documents
ESP32 flash encryption as a USB/eFuse opt-in (not a default brick), and binds
RFID slots to Home Assistant user ids with script-side enforcement so a second
account cannot edit someone else's keys or mute the house alarm. Lockstep
**2.32.0**. It does not implement the offline-siren proof, does not touch
on-card RFID crypto or tear-recovery, and does not turn encryption on in the
shipped YAML.

### Why

Tamper was deleted in the forty-first pass because nothing emitted
`esphome.tamper_alert`. An honest comment in an automation list is not a
feature. The IMU rides on the **lever**, not the case: magnet defeat is the
leaf rotating while the reed still reads closed; spoofed contact is the reed
opening while the leaf never rotated. Both predicates, plus debounce and an
`imu_healthy` gate, now live in `esphome/portal-unit.yaml`. Home Assistant
fires `guardian.major_alarm` first. The panel has no fake tamper sensor —
ALARM + `guardian_alarm_reason` is the state.

The outdoor unit still holds `guardian_rfid_mac_key`. Removing it from the
doorbell breaks outdoor GDN1. Enabling flash encryption by default would brick
OTA-only devices and can kill C6 USB Serial JTAG. The YAML therefore ships
commented `sdkconfig_options` and INSTALL.md § Flash encryption. Shipped
default remains **off**.

Home Assistant has no general per-service ACL. `require_admin` stays false so
non-admins can use Keys/Notifications. Empty roster helpers are today's
single-account behaviour. When a second user exists, unassigned keys are
admin-only; assigned keys are editable by that `hass.user.id` and by admins.
Scripts check `context.user_id` and fail closed. Notify routing is unchanged:
critical (alarm, stolen card, tamper) still ignores Off.

### New helpers

| Helper | Package | Notes |
|---|---|---|
| `input_text.rfid_1_ha_user_id` … `rfid_9_ha_user_id` | `packages/guardian_rfid.yaml` | No `initial:`. Empty = unassigned. Wiped by `script.guardian_clear_rfid_slot`. |
| `input_text.guardian_ha_admin_ids` | `packages/guardian.yaml` | Comma-separated HA user ids. No `initial:`. |
| `input_text.guardian_ha_user_ids` | `packages/guardian.yaml` | Same. 0–1 users = single-account mode. |

New scripts: `guardian_refresh_ha_roster`, `guardian_set_house_mode`,
`guardian_slot_write`. New automations: `Guardian: Portal Tamper Alert`
(`1789200000001`) and `Guardian: Data Log - Portal Tamper` (`1789200000002`).

### Deploy class

**FULL RESTART. Portal reflash required for tamper.** Doorbell YAML is
unchanged for tamper; both device YAMLs only gained commented encryption
blocks. Order: copy / installer `--apply` / restart, then flash the portal.
Encryption stays off unless you follow INSTALL.md § Flash encryption over USB.

**Copy `www/guardian-ui/guardian-panel.js`.** Its version literal is 2.32.0.

### Verify

322. **Single-account is unchanged.** One Home Assistant user, empty roster:
     Keys, Notifications, enrollment and mute behave as they did. No extra
     setup.
323. **Two users, mapped key.** Add a second person, open Guardian as admin
     once, link their key, pick their phone. They see their card as editable
     and other people presence-only. They cannot edit the other key's mute.
324. **Unassigned slot.** With two users on the roster, an unlinked key is
     admin-only to edit.
325. **Admin override.** An administrator can still name, mute, steal, and
     delete any key, and can unlink.
326. **Alarm still reaches the right phone.** Mute the mapped user's
     categories to Off. Fire a stolen-card or major alarm. The push must
     still arrive (`nonmaskable`). A second account cannot mute the house
     alarm.
327. **Script refuse.** As the non-admin, Developer Tools →
     `script.guardian_slot_write` on the *other* slot's `notify_mute` must
     stop with the persistent notification and leave the helper unchanged.
     `process_rfid_scan` and the Major Alarm Handler are not gated.
328. **Tamper, magnet defeat.** Portal reflash. Hold the reed closed and move
     the leaf/handle. ALARM, reason *Portal tamper: magnet defeat*. Slam-shut
     must not. *Needs the door; not claimed from this environment.*
329. **Tamper, spoofed contact.** Open the reed, door still shut. After the
     debounce, ALARM, *spoofed contact*. A normal inside/outside open must
     not. *Needs the door.*
330. **Encryption still off unless opted in.** Shipped YAML has the
     `sdkconfig_options` commented. `python tools/guardian-preflight.py`
     reports **2.32.0**. `python tools/guardian-selftest-preflight.py` still
     ends **`36 of 36 faults caught.`** — RFID HA account persist plus
     per-person notify persist and lock.
     Do not burn eFuses from CI.
331. **Preview.** `www/guardian-ui/preview.html` Admin vs Member: Keys,
     Notifications, More (Diagnostics/Install/Reset hidden for Member).
332. **Check configuration** on the live Home Assistant after copy and
     restart. *Needs the Pi; not done.*

## Still outstanding

*Found in the forty-third pass and deliberately not fixed. Each says why, so the
next pass starts from a decision rather than a rediscovery.*

- **The IMU can latch and report an entry from outside as "inside", confidence
  95, with nothing reporting a fault.** `at_rest` in `portal-unit.yaml` gates
  *both* the rest reference and the gyro-bias EMA, and it depends on
  `lever_deg`, which is measured *against that same rest reference*. If the
  lever ever settles more than 3° off — a housing that rotated on the handle, a
  re-mount, a hard slam — the reference can never be relearned. Above the 12°
  tilt threshold `handle_depressed` latches true, and every subsequent opening
  takes the "the inside lever moved, so this came from inside" branch, which is
  the F-21 corroboration channel agreeing with itself. `imu_healthy` checks only
  readiness and sample freshness, so nothing anywhere says it happened; recovery
  is a reboot or the Calibrate button.
  **Certain from the code. Not fixed** because the correct fix is a supervisor
  that distinguishes a latched reference from ordinary drift, and that cannot be
  designed without accelerometer traces from the real door — a threshold guessed
  from here would either never fire or fire on every windy day.
- **A card withdrawn mid-write used to become a permanent alarm against its
  owner.** *(Forty-sixth pass attempted a recovery that does not change the
  on-card format.)* `write_payload_` now commits the counter last; a GDN1
  whose MAC matches `counter-1` or `counter+1` is rewritten consistently;
  `card_id` is published on `bad_mac`; a stashed rotate is not applied twice.
  **Unverified on hardware.** The journal-page / dual-counter MAC layout is
  still the robust fix and still invalidates every enrolled card, so it stays
  waiting on a deliberate format bump. Until steps 314–315 have been run, a
  household that sees "Card not recognised" on a key that worked yesterday
  should HOLD/retry three times, then re-enroll — and capture the ESPHome
  line `RFID scan (...): result=... card_id=... counter=... rotated=...`
  against the helper values. Do not widen `window_ok`.
- **Four garbled frames still produce a security verdict that sticks.**
  `transient_` absorbs three, then falls through to `bad_mac` or
  `unsupported_tag`, and the UID is latched so every retry is suppressed until
  the card is physically lifted. Reduced from one frame to four in an earlier
  pass; not eliminated. A wet or cold antenna reproduces it.
- **`docs/reference-images/` is local-only.** Source photography of one
  install is not in the public tree. Assembly steps are in
  `docs/documentation/`.
- **Tamper detection exists in this tree and needs a portal reflash.**
  Firmware emits `esphome.tamper_alert` (`magnet_defeat` / `spoofed_contact`)
  from the swing integrator plus the reed, gated on `imu_healthy`. Home
  Assistant fires `guardian.major_alarm` first; a parallel data-log
  automation writes `log_type: tamper`. Hardware checks are INSTALL §9
  steps 15–17 / this pass 328–329. Residual IMU rest-reference latch
  (this list, first item) can still bias the gyro EMA; that is why the
  firmware waits on a sustained angle, not a spike, and why an unhealthy
  IMU skips spoofed-contact rather than alarming every real outside open.
- **`input_boolean.guest_bypass` is gone**, along with its automation and the
  panel mapping (forty-first pass). Nothing was ever built on it. On an existing
  install delete the helper by hand — removing it from the package does not
  remove it from the entity registry.
- **The seven UI-only helpers are now in `packages/guardian.yaml`.** Existing
  installs must still follow the thirty-fourth-pass migration order (delete UI
  copies, then restart, then restore `portal_pin_hash`). Skipping the delete
  collides YAML with UI helpers.
- **Live orphan automation.** `automation.guardian_elevated_mode_door_supervisor`
  / a leftover Companion notify service is not in this repo. Delete it on the Pi
  — thirty-fourth pass, “Live error”.
- **`input_text.last_doorbell_rfid_time`** is now declared. Confirm it exists
  after the migration so doorbell-side GRANTED is not aborted.
- **Salted hashing** — see `GUARDIAN_AUDIT.md` §8.4. `script.guardian_set_pin`
  makes the migration much cheaper than it was, since the PIN side no longer
  needs to be hashed by hand.
- **`row()` / `note()` HTML contract is now the default-escape one.** `note()`
  always `esc()`s; trusted markup uses `noteHtml`. `row()` escapes `title` and
  `sub`; `right` stays HTML (switches, pills); `{ subHtml: true }` is only for
  the two callers that compose `sub` from already-escaped pieces. `card()`
  escapes `opts.hint`. A key name in `note()` was stored XSS; that path is
  closed. `right` is still a raw-HTML argument by necessity — do not pass a
  key name through it.
- **A missing `notify.guardian_data_log` is silent, in both directions.** The
  File notify integration is a config flow YAML cannot provision, so on a fresh
  install it does not exist. That is safe — `notify.send_message` with an
  entity_id matching nothing logs a warning and does nothing, so no Data Log
  automation aborts — but it means a household that skipped `INSTALL.md` §6 gets
  a log warning per door event and is never told the log is not being written.
  There is also no rotation. At household rates the file grows on the order of
  tens of megabytes a year, which is a housekeeping matter rather than an SD
  card risk; say so rather than inventing a cron for it. *Reasoned, not tested:
  confirming the no-abort behaviour needs a Home Assistant with the integration
  genuinely absent.*
- **THE HOME ASSISTANT HALF OF THE NTAG PROTECTION SIGNAL EXISTS NOW, AND HAS
  NOTHING TO READ.** *(Forty-fifth pass.)* The forty-third pass recorded the
  on-card protection state as "surfaced" to the household; it was published to an
  event bus with no subscriber, and the dispatcher dropped the field before any
  script saw it. That is fixed — `process_rfid_scan` stores it per slot in
  `input_text.guardian_card_protection` and the panel's key list draws it as
  protected / clonable / **not checked**. **The third state is the one every key
  on this door is in**, because both devices run firmware older than the field and
  send nothing on every scan. So this entry stays on the list: the plumbing is
  done and it carries no data until step 276 has been run. It gates nothing and
  must never be made to — refusing an unprotected tag locks out every card
  enrolled before the fix existed (traps 9 and 10).
- **THE CARD PATH IS NOW UNVERIFIED TOO, AND THAT IS NEW.** *(Forty-third
  pass.)* Until now the unverified surface was the alarm. It is now the alarm
  **and the credential**: `guardian_rfid` was audited for the first time and
  changed in five places — GET_VERSION retries, the enrollment protection split
  out of its conjunction, `ntag_pwd_ok` threaded through, the Classic upgrade
  moved in front of the payload write, and every HMAC return checked. **Not one
  of those has been tried against a real card**, and step 276 exists because the
  first question is not "is it more secure" but "does a key that worked
  yesterday still open the door". Run 276 before 277–278 and before trusting any
  of this on a door you rely on.
- **The alarm path is unverified on hardware.** `INSTALL.md` §9 steps 10–14,
  fortieth-pass steps 244–248, forty-first-pass steps 254–258,
  forty-second-pass steps 262–269 and forty-third-pass steps 275–288 have never
  been run against real hardware.
  **Step 262 is now the one that matters most**: it is the only step that
  exercises the half-installed case, which is the case the forty-second pass
  found the alarm silently failing in. Two passes have now changed the alarm path by
  reasoning and static checking alone, and **step 255 is the one that proves
  both**: it is the finish of step 244, whose claim that the siren resumes on
  reconnect was true of nothing until the forty-first pass. Step 254 — fire an
  alarm with the WAN unplugged and time the siren — is the other one that cannot
  be reasoned about, only measured.
- **The alarm has no siren without Wi-Fi and Home Assistant — WRITTEN, NEVER
  HEARD.** *(Forty-third pass.)* The portal now sounds file 4 on its own when the
  door opens with the API down and elevated mode last-confirmed inside
  `number.…offline_authority_hours`; two independent stops, a hard duration cap,
  and a report handed over on reconnect. See *Before this is published* for the
  design and for the `reboot_timeout` finding that would have defeated it.
  **It now BUILDS** *(forty-fourth pass - `portal-unit` compiles clean, RAM
  34.9%, Flash 27.3%)*, which retires the "unbuilt" half of this entry and
  nothing else. **It is still unflashed and unheard, so this entry stays on
  the list.** The devices on this door are running a build that predates the
  forty-third pass, so they do not carry this feature at all today. It
  moves off it when steps 279–282 have been run and somebody has actually stood
  in front of the door and heard it. Until then the honest description of this
  system is still "no siren without Wi-Fi", because an untested siren and no
  siren are the same evidence.
- **The offline siren dies with the portal's power.** Authority is RAM-only and
  a reboot revokes it, deliberately: an ESP32 with no RTC cannot distinguish a
  fifteen-minute reboot from an eight-hour power cut, and guessing wrong the
  other way means a door that screams at 3am on day two of an outage. So cutting
  power to the portal — not just to the network — still produces a silent house.
  Closing that needs an RTC or a battery-backed counter, i.e. hardware.
- **A POWER CUT STILL ENDS AN ALARM WITH NO RECORD, AND THAT IS ONLY PARTLY
  CLOSED.** *(Forty-fifth pass.)* `input_text.guardian_alarm_latch` restores, so
  an alarm now survives a restart and any outage shorter than
  `guardian_alarm_resume_minutes`. Two limits remain and both are deliberate.
  Home Assistant's `restore_state` snapshot can be up to fifteen minutes stale,
  so an alarm dismissed shortly before an unclean shutdown could in principle be
  re-fired at boot — bounded to a single push and a resumable siren, which is the
  cheaper direction to be wrong in. And an outage longer than the bound
  deliberately does **not** resume, it only notifies: a house that starts
  screaming when the power returns on day two is a house whose alarm gets
  unplugged. Closing the second properly needs the alarm state to live somewhere
  that knows what time it is, which on the Home Assistant side means the recorder
  and on the device side means an RTC.
- **Dismissing an alarm requires no factor.** Any phone holding the alarm push
  can silence it from a lock screen, and the event can be hand-fired from
  Developer Tools by any Home Assistant account. The fortieth pass made this
  *recorded* rather than *gated*, on purpose — decide deliberately whether a PIN
  belongs in front of it rather than inheriting the current answer.

### Before this is published

Two kinds of item. The first three are **behaviour a stranger would be relying
on and would not get**, added in the forty-first pass; the rest were checked in
the fortieth pass and left deliberately undone and affect no running install.

- **THE OFFLINE SIREN IS NOW WRITTEN, AND HAS NEVER MADE A SOUND.**
  *(Forty-third pass. The item below is kept in full because it is the
  specification this was built against and because nothing here is proven.)*
  `portal-unit.yaml` now keeps the last-known `ha_elevated_mode` with the
  millis() at which a live Home Assistant last confirmed it, and on a reed
  opening with the API down and that belief still inside
  `number.…offline_authority_hours` it plays file 4 locally every three seconds.
  Two independent stops — a card that verifies at the portal's own reader, and
  **any** keypad key, needing no credential at all — plus a hard cap from
  `number.…offline_siren_max_minutes`. What it did is counted in `restore_value`
  globals and emitted as `esphome.offline_siren_report` on reconnect, which
  `Guardian: Offline Siren Report` turns into an urgent nonmaskable push.
  **It compiles as of the forty-fourth pass. It is still unflashed and
  unheard. Steps 275–282 have never been run.**

  **One finding from that work belongs in the specification below, because it
  would have silently defeated it.** Neither device stated `reboot_timeout`, so
  both inherited ESPHome's 15-minute default — the portal would have rebooted a
  quarter of an hour into every outage, and a reboot wipes the RAM the authority
  lives in. The feature would have died inside exactly the outage it exists for,
  and an attacker who cut the access point would only have needed to wait. The
  portal is now `0s` on both `wifi:` and `api:`, with a conditional watchdog that
  restores the self-heal except while it holds authority or is sounding; the
  doorbell keeps 15min, because it has no authority to lose. Preflight now fails
  if either device leaves either value unstated.

  **The limitation that could not be engineered away:** authority is RAM-only
  and dies on a reboot. An ESP32 with no RTC cannot distinguish a fifteen-minute
  reboot from an eight-hour power cut, so persisting the flag would mean waking
  up after an unknown interval still believing the house was armed — the 3am
  false alarm the constraint warns about, reached from the other side. A reboot
  can therefore only ever *silence*, never start. Cutting power to the portal
  itself still ends offline protection until Home Assistant returns.

- **THE SYSTEM HAS NO ALARM WITHOUT WI-FI AND HOME ASSISTANT.** This is the
  single largest gap and the one that most cleanly separates "works in this
  house" from "safe to hand to someone else". The siren exists only as
  `dfplayer.play_mp3: file: 4` behind a template button, pressed by a Home
  Assistant automation every three seconds over the network. Neither ESP32
  decides anything on its own, and ESPHome **drops** `homeassistant.event` when
  no API client is connected rather than queuing it, so during an outage the
  door produces no siren, no chirp and no record — not even a late one. Jamming
  2.4 GHz, cutting power to the access point, or stopping Home Assistant
  silences the whole system, and the attacker who does any of those learns
  nothing about whether it worked because nothing announces it.

  **The shape of the fix**, specified and deliberately not written from a
  machine that cannot build or hear it: `portal-unit.yaml` keeps the last-known
  value of `ha_elevated_mode` (it already imports it), and on the reed opening
  while `api_status` reads disconnected AND that last-known value was on, plays
  file 4 locally on a repeating timer until the API returns or a valid card is
  presented at its own reader. The portal already has every input this needs.
  What it does not have is a decision. Note the two hazards to design against:
  the elevated-mode value is stale by definition during a disconnect (bound it —
  ignore it after some hours offline), and a local siren that Home Assistant
  cannot silence needs a local way to stop it or it becomes the reason somebody
  unplugs the portal for good. Wants a reflash and steps 254–256 re-run.

  **Three constraints on that design, added in the forty-second pass**, because
  each one is a way a first attempt gets it wrong. *Bound the staleness
  explicitly*, as a `number` on the device rather than a compiled constant, so a
  household can see and change the figure that decides whether their door screams
  at 3am on day two of a power cut; default it to a few hours. *Give it two ways
  to stop, not one* — a valid card at the portal's own reader, and an
  unconditional local silence that needs no card at all, because the person
  standing in front of a siren they cannot stop is the person who removes the
  fuse. *Cap the total duration* regardless of either, so the worst case is
  minutes of noise and not a day of it. And the portal must record what it did
  while it was alone and hand that to Home Assistant on reconnect, or the whole
  feature is unfalsifiable: a siren nobody can prove sounded is the same evidence
  as a siren that did not.
- **THE HARDWARE CANNOT BE BUILT FROM THIS REPOSITORY, and nothing said so.**
  **Closed later:** KiCad 10 schematic+board and Gerber+drill zips for both
  boards are in `PCBs/` (`Interior-Portal/`, `Doorbell/`); print files left
  the tree and are `Lamp-Final.3mf`, `Internal-Portal-Final.3mf`, and
  `Doorbell-Final.3mf` on MakerWorld / Printables. This bullet is the finding
  as written, not HEAD. What is still missing is pick-and-place / CPL.
  Both devices are built around custom PCBs and **no PCB source is in the tree**
  — no Gerbers, no KiCad project, no schematic; `3D-Models/` holds six `.stl`
  files and nothing else. The build documentation specified wiring by silkscreen
  label ("keypad Pin 1 → ESP_Right1 – Pin 5") and the firmware specifies GPIOs,
  and the artefact that maps between them does not exist here. This is neither a
  doc bug nor a code bug; it is a missing file, and it makes the hardware half
  unbuildable by anybody who does not already own a board. Found in the
  forty-third pass. Either publish the PCB source, or say in `README.md` that
  this is a Home Assistant configuration plus firmware for hardware the reader
  must design themselves. `INSTALL.md` §1 now at least states the GPIO map.
- **The card master key is recoverable from the outdoor unit until flash
  encryption is opted in.** `guardian_rfid_mac_key` compiles into both
  firmwares in cleartext. Neither `esp32:` block enables flash encryption or
  secure boot in the shipped YAML — that is a documented USB/eFuse opt-in
  (INSTALL.md § Flash encryption), not enabled by default, because the burn
  is irreversible and a first encrypted flash over OTA bricks the board.
  Unscrewing the doorbell still yields the key until then.
- **Key rotation destroys every enrolled card and there is no tool for it.**
  After a rotation an upgraded MIFARE Classic sector authenticates with neither
  the new derived key nor the transport key, and a protected NTAG refuses both
  the read and the rewrite; `guardian_rfid` has no un-protect path. Preflight
  names this for Classic and it is equally true for NTAG. Either add a
  reset-with-the-old-key mode to the component and a documented procedure, or
  say plainly in `README.md` and `INSTALL.md` that rotating means buying new
  cards for the whole house. Related and worth saying in the same breath:
  **MIFARE Classic is clonable whatever the keys are** — Crypto1 is broken —
  and the rolling counter then flags whichever card taps *second*, so a
  successful clone ends by accusing the real key. NTAG21x should be the
  recommended medium and Classic should be labelled legacy.
- **`docs/*.docx` — gone as of the forty-third pass.** They were re-checked
  first and the "reviewed and clean" verdict held: the extracted text carries no
  IPs, no personal names, no SSIDs, no coordinates and no MAC addresses; the
  only credential-shaped strings are the generic
  `rtsp://username:password@CAMERA-IP:554` placeholders. They were deleted for
  size, not for content — **124 MB of embedded images carrying 45 KB of text**,
  in a repository whose entire remaining content is about 1 MB, referenced by
  nothing in the build and mentioned by no installer step. The text a person
  actually needs is now in `INSTALL.md` §1. They remain in git history, which is
  noted under the history item below rather than rewritten.
- **`docs/reference-images/` is local-only.** Source photography of one
  install is kept on the author's disk and is not in the public tree.
  Assembly photographs a builder needs live in `docs/documentation/`.
- **A household LAN prefix was in the private git history.** Historical
  commits and an earlier audit table named a real subnet. HEAD runtime
  files and HEAD examples use generic `192.168.0.x` placeholders. That
  private log was discarded when this repository was seeded.
- **Early private commits carried a camera RTSP URL with an embedded
  password.** Rotate that camera account if it was ever the live one —
  it is weak independently of this repo.
- **No git remote exists**, so nothing has ever been pushed and nothing has
  leaked. Because every commit is affected, a history rewrite changes every SHA
  anyway; with no collaborators, a fresh repo seeded from the cleaned tree costs
  the same and carries no rewrite risk. `DEPLOY.md` already preserves the
  pass-by-pass "why" that a squashed log would lose.
- **`guest_bypass` is gone** (forty-first pass). Tamper is restored in the
  forty-seventh pass (firmware + automation + panel copy). On an existing
  install delete the leftover `guest_bypass` helper by hand — removing it from
  the package does not remove it from the entity registry.
- **KICAD IS IN THE TREE; GERBERS AND DRILL ARE TOO; THERE IS NO CPL.**
  `PCBs/Doorbell/` and `PCBs/Interior-Portal/` are KiCad 10 schematic+board
  plus Gerber+drill zips. Later: meshes left this tree; print files are
  `Lamp-Final.3mf`, `Internal-Portal-Final.3mf`, and `Doorbell-Final.3mf` on
  MakerWorld / Printables. Passives are valued. What is still missing is pick-and-place / CPL (these
  are THT proto boards) and GPIO names on the nets. README and INSTALL §1
  now say that, on the first screen. There is no lamp PCB, correctly. The
  first-screen caveats also close the "say so or enable flash encryption"
  item as **documented opt-in, not enabled in shipped YAML**, and "say so or
  add a key-rotation tool" as documentation, not as engineering: the outdoor
  unit still holds the master key in cleartext until the eFuse procedure,
  and rotating it still bricks every card.
- **PUBLISH A FRESH REPOSITORY, NOT THIS LOG.** *(Forty-sixth pass, the git
  decision.)* Runtime files at HEAD are clean. History is not. Seed a new repo
  from this tree before a public GitHub; do not rewrite this one in place.
