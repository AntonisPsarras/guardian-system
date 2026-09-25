"""Prove guardian-preflight.py still catches the faults it was written for.

    python tools/guardian-selftest-preflight.py

Injects each real bug the fortieth through forty-third passes fixed, one at a
time, confirms preflight FAILS and names it, and reverts. Exits 0 only if every
fault was caught and the tree is clean afterwards.

READ THE `N of M` LINE, NOT THE COLUMN. A fault whose anchor has drifted out of
the tree prints SKIP, in the same column as CAUGHT, and a run full of SKIPs looks
like a run full of passes. The count at the end is the only thing that cannot be
misread.

WHY THIS EXISTS

A guard written after the bugs, and never shown to catch them, is not a guard -
it is a comment that runs. Most of the faults below were live in this repo and
passed every check it had; the checks that catch them now were written
afterwards, from the outside, and nothing but this file demonstrates that they
work. It is also the regression test for the checks themselves: narrowing the
"alert" definition or the raising-domain list to quieten a false positive can
silently stop it catching the true ones, and that change would otherwise look
like an improvement.

The forty-first pass is the case in point, twice over. It taught preflight to
walk into blocking script calls, which is how the guardian_reconcile_presence
fault below was found at all. And it moved the Major Alarm Handler's push from
"action: script.guardian_notify_broadcast" to script.turn_on so the siren could
not wait on the internet - which moved the severity that marks it an alert from
"data:" to "data: variables:". A checker still reading only "data:" would have
stopped recognising the highest-severity alert in the system as an alert, gone
silent on the whole automation, and reported a clean run. The "lamp step back in
front of the siren" fault exists to make that specific regression loud.

The forty-second pass is the case in point a third time, and worse: the seven
faults at the foot of this list were all LIVE while every check above them
passed, because both earlier passes believed continue_on_error guards any step.
It does not - Home Assistant re-raises vol.Invalid, TemplateError and
ServiceNotFound whatever the flag says. So the Major Alarm Handler's lamp step
was ending the sequence in front of its own siren loop with a guard on it and a
comment above it explaining why the guard was sufficient. A fault list that only
contains bugs somebody already found is a list that lags the code; these five are
here so the next narrowing of those rules is loud.

The forty-third pass is the case in point a FOURTH time, and it is the reason to
distrust the shape rather than the flag. Its five faults come from the parts of
the tree nothing had ever read - the card crypto, the portal firmware, and the
installer - and the worst of them involved no continue_on_error at all. An NTAG
whose GET_VERSION failed was enrolled with no password and reported "enrolled",
because the call that sets the password sat behind an unrelated clause in the
same conjunction, underneath a comment stating that this exact case was fixed.
Same failure as the forty-second pass, different language, no flag involved: a
guard that reads like a guard and is not.

That pass also caught one of these checks being too weak, on itself. The first
installer check tested only that the words "is_user_owned" and "guardian-backup"
appeared in the file - so the fault below, which neuters the gate to match
nothing while leaving it looking intact, walked straight past it and printed
MISSED. A check that tests for vocabulary rather than behaviour is the same class
of thing as a comment that runs.

It writes only to the repository files it names, always restores them, and makes
no network call. Safe to run on the dev box. Do not run it against a live
/config - it deliberately makes the tree temporarily wrong.
"""
import io, os, subprocess, sys, time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Home Assistant's own valid_entity_id pattern, quoted exactly as the tree
# writes it inside the `none` sentinel. Kept as one constant because it appears
# in two anchors below and in eleven places in the YAML: a fault whose anchor
# has silently drifted reports SKIP, not MISSED, and SKIP is the failure mode
# that looks like a pass.
SENTINEL_PATTERN = r"'^(?!.+__)(?!_)[\da-z_]+(?<!_)\.(?!_)[\da-z_]+(?<!_)$'"

FAULTS = [
    ('stolen key + portal offline went silent', 'scripts.yaml',
     "    - action: button.press\n      continue_on_error: true\n      target:\n        entity_id: button.guardian_interior_portal_play_alarm",
     "    - action: button.press\n      target:\n        entity_id: button.guardian_interior_portal_play_alarm",
     'play_alarm'),

    ('cloned key during a challenge did not alarm', 'scripts.yaml',
     "      - action: button.press\n        continue_on_error: true\n        target:\n          entity_id: button.guardian_interior_portal_play_denied\n      - action: script.turn_on\n        target:\n          entity_id: script.guardian_lamp_rejected\n      # Same escalation as the stolen branch below",
     "      - action: button.press\n        target:\n          entity_id: button.guardian_interior_portal_play_denied\n      - action: script.turn_on\n        target:\n          entity_id: script.guardian_lamp_rejected\n      # Same escalation as the stolen branch below",
     'play_denied'),

    ('stolen-card badge in front of the push', 'automations.yaml',
     "  - action: script.guardian_notify_person\n    continue_on_error: true\n    data:\n      slot: \"{{ trigger.event.data.slot | default('', true) | string | trim }}\"\n      critical: true",
     "  - action: persistent_notification.create\n    data:\n      title: injected\n      message: injected\n      notification_id: guardian_stolen_card\n  - action: script.guardian_notify_person\n    continue_on_error: true\n    data:\n      slot: \"{{ trigger.event.data.slot | default('', true) | string | trim }}\"\n      critical: true",
     'persistent_notification.create'),

    ('stale automations.yaml reported healthy', 'automations.yaml',
     "alias: Guardian - Automations Version 2.32.5",
     "alias: Guardian - Automations Version 2.25.0",
     'automations.yaml'),

    ('INSTALL.md merge block gone stale', 'INSTALL.md',
     "guardian-ui/guardian-panel.js?v=2.32.5",
     "guardian-ui/guardian-panel.js?v=2.25.0",
     'INSTALL.md'),

    # ---- forty-first pass ---------------------------------------------------

    # The bug the fortieth pass's checker could not see, because it stopped at
    # the call boundary: process_rfid_scan calls guardian_reconcile_presence
    # with "action:", which is blocking, so an error in the callee ends the
    # CALLER - in front of the clone alarm and the stolen-key alarm. Unguard the
    # notification at the end of the callee and preflight must name it against
    # an alert in a different file's script, which it can only do by walking in.
    ('unguarded step inside a blocking script call', 'scripts.yaml',
     "  - action: persistent_notification.create\n    continue_on_error: true\n    data:\n      notification_id: 'guardian_presence_corrected_{{ slot_id }}'",
     "  - action: persistent_notification.create\n    data:\n      notification_id: 'guardian_presence_corrected_{{ slot_id }}'",
     'inside script.guardian_reconcile_presence'),

    # A stop does not raise, so the ordering rule cannot see it - and an alert
    # below one is not merely at risk, it is unreachable. Put an unconditional
    # stop at the top of the Major Alarm Handler and preflight must say the
    # siren below it can never run.
    ('a stop stranded the alert below it', 'automations.yaml',
     "  - action: script.turn_on\n    continue_on_error: true\n    target:\n      entity_id: script.guardian_notify_broadcast",
     "  - stop: injected\n  - action: script.turn_on\n    continue_on_error: true\n    target:\n      entity_id: script.guardian_notify_broadcast",
     'unreachable'),

    # The Major Alarm Handler's own ordering, re-proved after the push moved
    # from a blocking call to script.turn_on in the forty-first pass. That move
    # changed where the alert's severity lives in the YAML - under
    # "data: variables:" instead of "data:" - and a checker that kept reading
    # only "data:" would have quietly stopped recognising the most important
    # alert in the system while still reporting a clean run.
    #
    # The anchor tracks the forty-second pass's rewrite of that step: the
    # entity_id now falls back to the `none` sentinel, because continue_on_error
    # was never able to catch what an invalid one raises. The ORDERING rule this
    # fault tests is unchanged - drop the guard and the lamp stands in front of
    # the siren again.
    ('lamp step back in front of the siren', 'automations.yaml',
     "  - action: light.turn_on\n    continue_on_error: true\n    target:\n      entity_id: >-",
     "  - action: light.turn_on\n    target:\n      entity_id: >-",
     'light.turn_on'),

    # And the siren loop itself, which no ordering rule can express: the press
    # inside the repeat is the FIRST step of the loop body, so nothing stands in
    # front of it - and it targets a PORTAL entity, so it raises whenever the
    # portal is offline, and an error inside a repeat ends the whole run. That
    # killed the siren permanently, with the ALARM screen still up and no path
    # back into the loop. Expect the loop rule's own wording, not just the
    # entity name, so this cannot pass on some other rule happening to mention
    # play_alarm.
    ('siren loop killed by its own first press', 'automations.yaml',
     "      - action: button.press\n        continue_on_error: true\n        target:\n          entity_id: button.guardian_interior_portal_play_alarm",
     "      - action: button.press\n        target:\n          entity_id: button.guardian_interior_portal_play_alarm",
     'ends the loop for good'),

    # The fortieth pass's version marker was read through
    # automation.guardian_automations_version_marker, an entity that cannot
    # exist: a SCRIPT's entity id comes from its YAML key, an AUTOMATION's is
    # slugified from its alias. So More -> Diagnostics reported automations.yaml
    # as "missing" on every correct install for a whole release - the
    # half-copied-install check crying wolf, which is how a household learns to
    # ignore it. Nothing caught it because preflight reads the files and the
    # fault was in how a template reads the running system.
    #
    # Both templates now match the alias PREFIX, which makes that string a
    # contract across three files. Break it in one of them.
    ('version marker lookup drifted from the alias', 'packages/guardian.yaml',
     "'^Guardian - Automations Version '",
     "'^Guardian Automations Version '",
     'Does not search for'),

    # ----------------------------------------------------------------------
    # The forty-second pass. Everything above this line is guarded by
    # continue_on_error somewhere; these five are the faults continue_on_error
    # CANNOT guard, which is why they were live in a tree that passed every
    # earlier check.
    # ----------------------------------------------------------------------

    # THE ONE THAT WAS LIVE, and the reason this whole family exists. The Major
    # Alarm Handler set the lamp red at a bare "{{ states(...) }}". That sensor
    # reads unknown with packages/ missing or not yet rendered, "unknown" is not
    # a valid entity id, and vol.Invalid is re-raised whatever continue_on_error
    # says - so the sequence ended and the SIREN LOOP ON THE NEXT LINE never
    # ran. Take the sentinel back off and preflight must say so.
    ('siren lost to an entity_id that cannot be guarded', 'automations.yaml',
     "      entity_id: >-\n        {% set e = states('sensor.guardian_lamp_entity') | string | trim %}\n"
     "        {{ e if e is match(" + SENTINEL_PATTERN + ") else 'none' }}\n"
     "    data:\n      rgb_color:",
     "      entity_id: \"{{ states('sensor.guardian_lamp_entity') }}\"\n"
     "    data:\n      rgb_color:",
     'templated entity_id that continue_on_error cannot guard'),

    # The same class one call deep, in the step that half-completed every reset
    # on a house with no doorbell.
    ('reset aborted on an empty doorbell attribute', 'scripts.yaml',
     "        entity_id: >-\n          {% set e = state_attr('sensor.guardian_doorbell_entities', 'restart')\n"
     "             | default('', true) | string | trim %}\n"
     "          {{ e if e is match(" + SENTINEL_PATTERN + ") else 'none' }}",
     "        entity_id: \"{{ state_attr('sensor.guardian_doorbell_entities', 'restart') }}\"",
     'templated entity_id that continue_on_error cannot guard'),

    # A templated service name back out in the open. ServiceNotFound is re-raised
    # too, and this call sits inside a repeat over the recipients - so one stale
    # phone dropped the alarm push to every recipient after it.
    ('templated service name back outside its isolation', 'scripts.yaml',
     "            - action: script.turn_on\n              continue_on_error: true\n"
     "              target:\n                entity_id: script.guardian_notify_send_one\n"
     "              data:\n                variables:\n                  svc: '{{ svc }}'\n"
     "                  title: '{{ title }}'\n                  message: '{{ message }}'\n"
     "                  payload: '{{ extra }}'",
     "            - action: notify.{{ svc }}\n              continue_on_error: true\n"
     "              data:\n                title: '{{ title }}'\n                message: '{{ message }}'\n"
     "                data: '{{ extra }}'",
     'templated service name outside the one script'),

    # Isolation is worth nothing if somebody waits on the isolator: a blocking
    # call hands the callee's ServiceNotFound straight back to the caller.
    ('the isolation script called blocking', 'scripts.yaml',
     "            - action: script.turn_on\n              continue_on_error: true\n"
     "              target:\n                entity_id: script.guardian_notify_send_one",
     "            - action: script.guardian_notify_send_one\n              continue_on_error: true\n"
     "              target:\n                entity_id: script.guardian_notify_send_one",
     'called blocking'),

    # The version-marker class, generalised. Rename an entity in the firmware
    # and every Home Assistant reference to it silently addresses nothing -
    # exactly how automation.guardian_automations_version_marker behaved.
    ('portal entity renamed out from under the HA tree', 'esphome/portal-unit.yaml',
     '    name: "Play Alarm"',
     '    name: "Play Siren"',
     'declares no entity named'),

    # THE ONE THE HOUSEHOLD ACTUALLY HITS, EVERY RELEASE. Every runtime file is
    # present in /config and one of them is last release's copy - almost always
    # the panel, because its CONTENTS usually do not change in a release, only
    # its version literal, so it is the file that looks like it does not need
    # copying. check_deployed used to test presence only, so it said "all 9
    # runtime files present" and the household found out from a red banner in
    # the UI with a remedy - restart fully - that cannot fix a stale panel.
    #
    # Runs preflight with --config-dir . because this check is about the
    # deployed tree; the repo has the same shape, so it stands in for /config.
    ('a deployed tree where only the panel is stale', 'www/guardian-ui/guardian-panel.js',
     "const GUARDIAN_UI_VERSION = '2.32.5';",
     "const GUARDIAN_UI_VERSION = '2.25.0';",
     'deployed files are from different versions',
     ('--config-dir', '.')),

    # The sentence in INSTALL.md that tells a household which version to expect.
    # It read 2.24.0 for two releases: the two ?v= strings a paragraph away were
    # checked and the prose naming the number was not, so the one line whose
    # whole job is to state the version was the one line free to be wrong.
    ('INSTALL.md prose names the wrong version', 'INSTALL.md',
     "they all read\n**2.32.5**:",
     "they all read\n**2.24.0**:",
     'version mismatch across the halves'),

    # ---- forty-third pass ---------------------------------------------------
    #
    # Five checks for the five classes this pass found in the parts of the tree
    # nothing had ever read: the card crypto, the portal firmware, and the
    # installer. Every one of these faults was LIVE at 2.27.0 and every check
    # above it passed, which is the same argument the forty-second pass block
    # makes and the reason this file exists.

    # An NTAG whose GET_VERSION failed was reported "enrolled" with NO PASSWORD
    # SET and its payload world-readable. have_version_ sat in the middle of the
    # conjunction, so a false value short-circuited protect_ntag_() away
    # entirely - and the comment directly above the line asserted that this
    # exact case had been fixed. Third occurrence of "a comment claiming a guard
    # holds, above code where it does not".
    ('an NTAG enrolled with no password at all',
     'esphome/components/guardian_rfid/guardian_rfid.cpp',
     "  if (!this->picc_classic_) {\n    if (!this->have_version_) {",
     "  if (!this->picc_classic_ && this->have_version_ && !this->protect_ntag_()) {\n    if (false) {",
     'protect_ntag_'),

    # The NTAG password was confidentiality-only, never an authentication
    # factor: consume_payload_ discarded ntag_pwd_ok, so a payload copied onto
    # an UNPROTECTED tag was accepted exactly like one behind PROT=1. The attack
    # was not "break the password", it was "do not set one".
    ('the NTAG password reduced to decoration',
     'esphome/components/guardian_rfid/guardian_rfid.cpp',
     "  this->ntag_protected_ = ntag_pwd_ok;",
     "  (void) ntag_pwd_ok;",
     'ntag_pwd_ok'),

    # The siren loop had no bound at all. Its only exit was one input_text, and
    # the write that clears it goes through a `queued, max: 25` script - where a
    # blocking call at max is DISCARDED SILENTLY. Nothing could stop the noise.
    ('a siren loop with no bound', 'automations.yaml',
     "      - condition: template\n        value_template: '{{ (repeat.index if repeat is defined else 1) <= 400 }}'\n      sequence:\n      - action: button.press\n        continue_on_error: true\n        target:\n          entity_id: button.guardian_interior_portal_play_alarm",
     "      sequence:\n      - action: button.press\n        continue_on_error: true\n        target:\n          entity_id: button.guardian_interior_portal_play_alarm",
     'unbounded actuator loop'),

    # Both reboot_timeouts defaulted to 15 minutes and neither was written down,
    # while the comment on the wifi one claimed it could be read "at a glance
    # next to the API timeout below" - which did not exist. The portal therefore
    # rebooted a quarter of an hour into every outage, wiping the RAM the
    # offline siren's authority lives in, so the alarm would have died inside
    # exactly the outage it exists for.
    ('the portal rebooting out from under its own siren',
     'esphome/portal-unit.yaml',
     "  reboot_timeout: 0s\n  on_client_connected:",
     "  on_client_connected:",
     'reboot_timeout'),

    # The first command a stranger runs. automations.yaml, scripts.yaml and
    # scenes.yaml are where Home Assistant's UI editors save everything a
    # household has ever built, and they were on the unconditional copy list
    # with no backup, no prompt and no undo - while the file's own header
    # claimed configuration.yaml was "the one step here that can destroy work".
    # Injected by neutering the gate rather than deleting it, because that is
    # how this fails in real life: is_user_owned() still exists, still reads
    # like a protection, and matches nothing. A check that only asserts the
    # function is present would report a clean run on it.
    ('the installer destroying a household\'s own automations',
     'tools/guardian-install.sh',
     "        automations.yaml|scripts.yaml|scenes.yaml) return 0 ;;",
     "        __no_file_is_ever_user_owned__) return 0 ;;",
     'destroy'),

    # ---- forty-fourth pass --------------------------------------------------

    # THE LIVE BUG, PUT BACK. After 2.27.0 shipped, every device in the house
    # showed a Diagnostics banner saying Home Assistant had asked for 2.26.0 and
    # got 2.27.0, telling the household not to re-copy anything, that a restart
    # would not help, and that clearing the browser cache was "the whole fix".
    # All three were wrong: the file on disk was NEW and had loaded correctly,
    # nothing stale was in the cache, and the only cure was the configuration.yaml
    # edit the banner told them not to make. `requested !== ui` is a comparison
    # with two directions and one branch.
    #
    # Injected by collapsing the classifier back to that one branch, and NOT by
    # deleting anything: every state, every remedy string and the whole table
    # survive the injection intact, so a check that looked for the vocabulary
    # would report a clean run on it - which is trap 12, and is how this pass's
    # predecessor's first installer check walked past its own fault. What
    # changes is only what the function RETURNS, which is why preflight runs it
    # rather than reading it.
    ('Diagnostics prescribing a cure for the wrong direction',
     'www/guardian-ui/guardian-panel.js',
     "  for (let i = 0; i < 3; i += 1) {\n"
     "    if (a[i] > b[i]) return named('browser_behind');\n"
     "    if (a[i] < b[i]) return named('config_behind');\n"
     "  }\n"
     "  return named('match');",
     "  if (String(requested) !== String(ui)) return named('browser_behind');\n"
     "  return named('match');",
     'config_behind'),

    # The installer may now edit a household's configuration.yaml - the ?v=
    # cache-buster only - because leaving it stale made every upgrade report a
    # version mismatch on a correct install, and the printed warning that was
    # supposed to prevent that relied on somebody reading console output during
    # an upgrade. Three releases proved they do not.
    #
    # That permission is only safe while the backup is taken FIRST. Injected by
    # removing the backup and leaving everything else - the edit, the
    # verification, the message that says "backed up" - exactly as it was, so
    # the script still claims in its own output to have made a backup it did
    # not make. A check that grepped for the word would pass on this.
    ('the installer editing configuration.yaml with no backup',
     'tools/guardian-install.sh',
     '            if cp "$CFG_DST" "$CFG_BAK"; then',
     '            if true; then',
     'no backup'),

    # THE SECOND LIVE BUG THE HOUSEHOLD FOUND. Pressing "Off" on a person's
    # notification level produced a raw Home Assistant error dialog - "Invalid
    # option: Off (possible options: Important, Everything, Urgent only)" -
    # because the panel drew four levels from its own constant while the
    # helper declared three. Every version literal agreed while it happened:
    # version agreement is not entity agreement, and nothing checked the shape
    # of the entities the panel actually drives.
    #
    # Injected by removing the option from ONE rack, which is how it happens -
    # a partially updated package, not a wholesale one.
    ('the panel offering a level the helper does not have',
     'packages/guardian_rfid.yaml',
     "  rfid_1_notify_level:\n    name: \"RFID 1 Notify Level\"\n    icon: mdi:bell-cog\n    options:\n      - Important\n      - Everything\n      - Urgent only\n      - Off",
     "  rfid_1_notify_level:\n    name: \"RFID 1 Notify Level\"\n    icon: mdi:bell-cog\n    options:\n      - Important\n      - Everything\n      - Urgent only",
     'error dialog'),

    # The panel now tells each person what a level will actually deliver, per
    # category, by transcribing guardian_notify_person's own severity floors.
    # A drifted transcription does not throw - it produces a screen that
    # describes somebody's alerting confidently and wrongly, which is worse
    # than the dialog above because nothing anywhere reports it. Injected by
    # moving ONE floor, the way a real edit would.
    ('the panel describing alerting by the wrong severity floors',
     'www/guardian-ui/guardian-panel.js',
     "const LEVEL_FLOOR = { Everything: 0, Important: 1, 'Urgent only': 2, Off: 3 };",
     "const LEVEL_FLOOR = { Everything: 0, Important: 0, 'Urgent only': 2, Off: 3 };",
     'LEVEL_FLOOR'),

    # ---- forty-fifth pass ----------------------------------------------------

    # THE ALARM A RESTART ENDED, WITH THE RECOVERY CODE SITTING RIGHT THERE.
    # "Guardian: Startup State Recovery" tested portal_display_state for ALARM to
    # re-fire an interrupted alarm; that helper declares initial: none, which is
    # applied on every start and skips restore_state, so the branch had never
    # fired on any install and a routine restart silenced a live burglar alarm.
    #
    # Injected by pointing the condition back at the display, which is the exact
    # line that was there. NOTE WHAT SURVIVES THE INJECTION: the event, the
    # reason, the comment above it and every word of the branch are untouched -
    # only the entity under test changes. A check that matched on vocabulary
    # would see a branch that still says every right thing and report clean. Only
    # resolving the helper's initial: and asking whether the value is reachable
    # catches it, which is the standard the forty-third pass had to learn twice.
    ('an alarm resume branch that can never run', 'automations.yaml',
     "    - condition: template\n      value_template: '{{ alarm_ts | float(0) > 0 and (alarm_age_minutes | float(0)) <= (resume_within | float(30)) }}'",
     "    - condition: state\n      entity_id: input_text.portal_display_state\n      state: ALARM",
     'can never be true'),

    # THE BLOCKING CALL THAT IS DISCARDED SILENTLY. guardian_reset_auth tears
    # down three timers that each count down to guardian.major_alarm, and it sat
    # at queued/max: 3 against four callers that can each hold one blocking call.
    # The fourth was dropped without raising, its caller carried on as though the
    # teardown had happened, and the siren fired at somebody who had just
    # authenticated correctly.
    #
    # Injected by putting the number back. There is no vocabulary here at all -
    # one digit, in a file full of other numbers, with the explanatory comment
    # left fully intact above it. It can only be caught by computing the demand
    # from the call graph and comparing it to the capacity.
    ('a blocking call to a script with no room for it', 'scripts.yaml',
     "  # Raise this number when a fifth caller appears; the check will say so.\n  mode: queued\n  max: 10",
     "  # Raise this number when a fifth caller appears; the check will say so.\n  mode: queued\n  max: 3",
     'silently discarded'),

    # A VERIFY STEP THAT CANNOT BE SATISFIED. The forty-fourth pass's step 293
    # told a reader to confirm `23 of 23 faults caught.` while the tool printed
    # 26. Somebody following it on a correct tree concludes the tree is broken,
    # and spends an afternoon on it.
    #
    # Injected by putting the wrong number back into the NEWEST step, since that
    # is the only one the check reads - earlier passes quote what was true when
    # they were written and are deliberately never renumbered.
    ('DEPLOY.md quoting a fault count that cannot happen', 'DEPLOY.md',
     '`36 of 36 faults caught.`',
     '`23 of 23 faults caught.`',
     'does not produce'),

    # THE REMEDY THAT WOULD HAVE DESTROYED A HOUSEHOLD'S CONFIGURATION.
    # check_deployed named every stale file in one sentence and prescribed one
    # cure for all of them - "copy it again from the same commit". For
    # configuration.yaml that is not merely useless, it is destructive: nothing
    # copies that file, guardian-install.sh deliberately refuses to, and
    # following the instruction replaces a household's own http:, recorder: and
    # panel_custom blocks with the repository's. It is also the ONE file that
    # goes stale on every single upgrade, so it was the most likely line anybody
    # would ever read out of this check.
    #
    # Fourth recurrence of "prescribes a remedy that cannot work", and the first
    # one outside guardian-panel.js - sitting in the checker written to catch
    # exactly that class in other files.
    #
    # Injected by winding configuration.yaml's ?v= back, which is precisely the
    # state every upgraded install is in, and asserting the output refuses to
    # say "copy it".
    ('the deployed-tree check telling a household to copy configuration.yaml',
     'configuration.yaml',
     'guardian-panel.js?v=2.32.5',
     'guardian-panel.js?v=2.25.0',
     'DO NOT COPY configuration.yaml',
     ('--config-dir', '.')),

    # Picking a person on a key card called guardian_slot_write, the service
    # resolved, and five seconds later the helper was still unknown. A YAML
    # initial: would look like a fix for that first write and would unlink
    # everyone on every restart. A panel that only sends value collides with
    # input_text.set_value inside the script.
    ('an RFID HA user helper that wipes on restart',
     'packages/guardian_rfid.yaml',
     "  rfid_1_ha_user_id:\n    name: RFID 1 HA User\n    max: 64",
     "  rfid_1_ha_user_id:\n    name: RFID 1 HA User\n    initial: ''\n    max: 64",
     'declares initial:'),
    ('the account picker sending only value',
     'www/guardian-ui/guardian-panel.js',
     "  return { slot: String(slot || ''), op: String(op), payload };",
     "  return { slot: String(slot || ''), op: String(op), value: payload };",
     'does not send payload'),
    ('the account picker still sending value alongside payload',
     'www/guardian-ui/guardian-panel.js',
     "  return { slot: String(slot || ''), op: String(op), payload };",
     "  return { slot: String(slot || ''), op: String(op), payload, value: payload };",
     'still sends value'),
    ('a notify-level helper that wipes on restart',
     'packages/guardian_rfid.yaml',
     '  rfid_1_notify_level:\n    name: "RFID 1 Notify Level"\n    icon: mdi:bell-cog',
     '  rfid_1_notify_level:\n    name: "RFID 1 Notify Level"\n    initial: Important\n    icon: mdi:bell-cog',
     'declares initial:'),
    ('the notify tabs have no persistNotifyLevel',
     'www/guardian-ui/guardian-panel.js',
     '  persistNotifyLevel:',
     '  persistNotifyLevelRemoved:',
     'persistNotifyLevel'),
    ('personAlerts still treats house admins as notify editors',
     'www/guardian-ui/guardian-panel.js',
     '  if (!canEditNotifyPrefs(hass, slot)) {',
     '  if (!canEditSlot(hass, slot)) {',
     'canEditNotifyPrefs'),
]


def write(path, text, tries=8):
    """Windows hands out transient EINVAL/EACCES on files an indexer is holding.
    Retry, and never leave the file truncated if the write cannot happen."""
    last = None
    for i in range(tries):
        try:
            with io.open(path, 'w', encoding='utf-8', newline='') as f:
                f.write(text)
            return
        except OSError as e:
            last = e
            time.sleep(0.25 * (i + 1))
    raise last


def preflight(extra=()):
    r = subprocess.run([sys.executable, 'tools/guardian-preflight.py'] + list(extra),
                       cwd=REPO, capture_output=True, text=True)
    return r.returncode, r.stdout


def main():
    rc, out = preflight()
    if rc != 0:
        print('BASELINE IS NOT CLEAN - aborting'); print(out); return 1
    print('baseline: preflight passes\n')

    ok = True
    caught_n = 0
    for entry in FAULTS:
        # A sixth element is extra argv for preflight. Only check_deployed needs
        # it: that check is about the tree on the Pi, not the repo, and the repo
        # happens to have the same shape - so --config-dir . exercises it here.
        name, rel, good, bad, expect = entry[:5]
        extra = entry[5] if len(entry) > 5 else ()
        path = os.path.join(REPO, rel)
        original = io.open(path, encoding='utf-8').read()
        if original.count(good) < 1:
            print('SKIP  %-46s (anchor not found)' % name); ok = False; continue
        # replace only the first occurrence, which is the site under test
        injected = original.replace(good, bad, 1)
        write(path, injected)
        try:
            rc, out = preflight(extra)
        finally:
            write(path, original)
        caught = rc != 0 and expect in out
        print('%-5s %-46s %s' % ('CAUGHT' if caught else 'MISSED', name,
                                 '' if caught else '<-- preflight did not name %r' % expect))
        caught_n += 1 if caught else 0
        if not caught:
            ok = False

    rc, out = preflight()
    print('\nrestored: preflight %s' % ('passes' if rc == 0 else 'FAILS'))
    # Say the count out loud. A SKIP - an anchor that drifted because the code
    # it points at was reformatted - prints in the same column as a CAUGHT and
    # reads like one when you are scanning, and a fault that never ran is a
    # guard that was never demonstrated. This pass hit that twice.
    print('%d of %d faults caught.%s' % (caught_n, len(FAULTS),
          '' if ok else '  SOME DID NOT RUN OR WERE NOT CAUGHT - see above.'))
    return 0 if ok and rc == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
