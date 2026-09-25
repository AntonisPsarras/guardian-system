#!/bin/sh
# Guardian installer - place the runtime files into a Home Assistant /config.
#
#   sh tools/guardian-install.sh                 # dry run: says what it would do
#   sh tools/guardian-install.sh --apply         # actually copy
#   sh tools/guardian-install.sh --apply --config-dir /path/to/config
#   sh tools/guardian-install.sh --apply --replace-my-automations
#                                                # required if you already have
#                                                # automations/scripts/scenes
#
# POSIX sh on purpose: the Home Assistant OS SSH add-on is BusyBox ash, not bash.
#
# WHAT THIS REPLACES
#
# INSTALL.md §3 was a twelve-row table of "copy this there", with four separate
# ways to get it subtly wrong: creating /config/guardian-ui instead of
# /config/www/guardian-ui (the panel 404s), copying the .sh with CRLF endings
# (BusyBox ash fails naming the interpreter, not the file), copying only some of
# the five versioned halves (the system runs and misbehaves quietly), and
# overwriting an existing configuration.yaml (destroys work, no undo).
#
# WHAT IT DELIBERATELY DOES NOT DO
#
#   * Never overwrites a configuration.yaml it did not write. It prints the
#     merge block instead.
#
#     ONE EXCEPTION, added in the forty-fourth pass, and stated here rather than
#     buried where it happens: it rewrites the ?v= digits inside a
#     guardian-ui/*.js query string, and nothing else, after taking a
#     timestamped backup and verifying that no other line moved. That
#     cache-buster is a value this script's own release wrote in the first
#     place, and leaving it stale is what made every upgrade report a version
#     mismatch on a correct install for three releases running. The narrower
#     promise is the honest one: it never touches anything in configuration.yaml
#     except the cache-buster it wrote.
#   * Never overwrites an existing automations.yaml, scripts.yaml or scenes.yaml
#     without --replace-my-automations, and never without taking a timestamped
#     backup first.
#
#     Until the forty-third pass this file claimed configuration.yaml was "the
#     one step here that can destroy work". It was not. Those three files are
#     where Home Assistant's UI automation, script and scene editors write
#     EVERYTHING a household has ever built, and they were on the unconditional
#     copy list with no backup, no prompt and no undo - so the first command a
#     stranger with an existing install ran silently destroyed all of it, and
#     printed "updated    automations.yaml" while doing it. configuration.yaml
#     was carefully protected; the three files that actually belong to the user
#     were not. That asymmetry had no reason behind it.
#   * Never copies www/guardian-ui/preview.html. That is a design harness, and
#     /config/www is served as /local with NO authentication - anything put
#     there is readable by every device on the LAN and every tailnet peer.
#     Only the two files the running panel needs are deployed.
#   * Never opens a port, changes any authentication setting, writes a
#     credential, or makes a network call. There is no install shortcut here
#     that trades a security property for speed.
#   * Never touches esphome/secrets.yaml or the Frigate config. Those are
#     tools/guardian-gen-secrets.py and INSTALL.md §8 respectively.

set -eu

APPLY=0
REPLACE_MINE=0
CONFIG_DIR=/config
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STAMP=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo backup)

while [ $# -gt 0 ]; do
    case "$1" in
        --apply) APPLY=1 ;;
        --replace-my-automations) REPLACE_MINE=1 ;;
        --config-dir) CONFIG_DIR=${2:?--config-dir needs a path}; shift ;;
        --config-dir=*) CONFIG_DIR=${1#*=} ;;
        -h|--help) sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

# The three files Home Assistant's own UI editors own. Overwriting one of these
# destroys a household's work, so each needs an explicit opt-in AND a backup.
# Kept as a list rather than a test against FILES so that adding a row to FILES
# can never silently add a user-owned file to the unconditional copy set.
is_user_owned() {
    case "$1" in
        automations.yaml|scripts.yaml|scenes.yaml) return 0 ;;
        *) return 1 ;;
    esac
}

FAILED=0
CHANGES=0
PREFLIGHT_OK=1

say()  { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }
warn() { printf '  !  %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Every failure is reported and counted rather than swallowed. A copy that
# silently did not happen is the exact failure mode this script exists to end.
note_fail() { warn "$*"; FAILED=$((FAILED + 1)); }

say "Guardian installer"
say "  repo:   $REPO"
say "  config: $CONFIG_DIR"
if [ "$APPLY" -eq 0 ]; then
    say "  mode:   DRY RUN - nothing will be written. Re-run with --apply."
else
    say "  mode:   APPLY"
fi
say ""

[ -d "$REPO/packages" ] || die "$REPO does not look like the Guardian repo (no packages/)."

if [ ! -d "$CONFIG_DIR" ]; then
    if [ "$APPLY" -eq 1 ]; then
        die "$CONFIG_DIR does not exist. On Home Assistant OS this is /config; \
pass --config-dir if yours is elsewhere."
    fi
    warn "$CONFIG_DIR does not exist yet (fine for a dry run)."
fi

# ---------------------------------------------------------------------------
# 1. Directories.
#
# www/guardian-ui is the one people get wrong: Home Assistant serves /config/www
# as /local, so the panel must live under www/ and nowhere else.
# ---------------------------------------------------------------------------
say "1. Directories"
for d in packages themes guardian www www/guardian-ui; do
    if [ -d "$CONFIG_DIR/$d" ]; then
        step "exists      $CONFIG_DIR/$d"
    elif [ "$APPLY" -eq 1 ]; then
        mkdir -p "$CONFIG_DIR/$d" && step "created     $CONFIG_DIR/$d" \
            || note_fail "could not create $CONFIG_DIR/$d"
        CHANGES=$((CHANGES + 1))
    else
        step "would create $CONFIG_DIR/$d"
        CHANGES=$((CHANGES + 1))
    fi
done
say ""

# ---------------------------------------------------------------------------
# 2. Runtime files.
#
# This list IS the deployment contract. Anything not named here does not reach
# /config - which is how preview.html, docs/, 3D-Models/ and the .md files are
# kept out, rather than by asking the reader to skip rows in a table.
# ---------------------------------------------------------------------------
FILES="
automations.yaml:automations.yaml
scripts.yaml:scripts.yaml
scenes.yaml:scenes.yaml
packages/guardian.yaml:packages/guardian.yaml
packages/guardian_rfid.yaml:packages/guardian_rfid.yaml
www/guardian-ui/guardian-panel.js:www/guardian-ui/guardian-panel.js
www/guardian-ui/set-default-panel.js:www/guardian-ui/set-default-panel.js
guardian/guardian-luminance.py:guardian/guardian-luminance.py
guardian/guardian-luminance.sh:guardian/guardian-luminance.sh
"

# guardian-luminance.sh must arrive as LF. A CRLF copy fails under BusyBox ash
# with a message that names the interpreter, so the file is the last place
# anybody looks.
to_lf() { tr -d '\r' < "$1" > "$2"; }

say "2. Runtime files"
BLOCKED=0
for pair in $FILES; do
    src=$REPO/${pair%%:*}
    dst=$CONFIG_DIR/${pair#*:}
    rel=${pair#*:}

    [ -f "$src" ] || { note_fail "missing from the repo: ${pair%%:*}"; continue; }

    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
        step "unchanged   $rel"
        continue
    fi
    if [ -f "$dst" ]; then done_verb="updated  "; will_verb="would update"
    else                  done_verb="copied   "; will_verb="would copy  "; fi

    # An existing automations.yaml / scripts.yaml / scenes.yaml is the
    # household's own work, written by Home Assistant's UI editors. Refuse it
    # unless they said so, and say exactly what would be lost. Reported once per
    # file and counted, so the run ends INSTALL INCOMPLETE rather than looking
    # like a success with three quiet skips in the middle.
    if [ -f "$dst" ] && is_user_owned "$rel" && [ "$REPLACE_MINE" -eq 0 ]; then
        warn "refused to overwrite YOUR $rel"
        step "   $dst already exists and is where Home Assistant's UI editors"
        step "   save everything you have built. Guardian's copy would replace it"
        step "   wholesale, not merge with it."
        step "   Back it up and re-run with --replace-my-automations, or merge"
        step "   Guardian's $rel into yours by hand."
        BLOCKED=$((BLOCKED + 1))
        FAILED=$((FAILED + 1))
        continue
    fi

    if [ "$APPLY" -eq 1 ]; then
        # Back up before EVERY overwrite, not just the user-owned ones. The
        # timestamp is what makes it safe to re-run: a fixed .bak name would be
        # overwritten by the second run with the file the first run just wrote,
        # destroying the only copy of the original at exactly the moment
        # somebody is trying to recover it.
        if [ -f "$dst" ]; then
            if cp "$dst" "$dst.guardian-backup-$STAMP"; then
                step "backed up   $rel -> $(basename "$dst").guardian-backup-$STAMP"
            else
                note_fail "could not back up $rel - NOT overwriting it"
                continue
            fi
        fi
        copied=0
        case "$rel" in
            # The old form was `to_lf ... && chmod ... || true`, which swallowed
            # every failure, and the success test below was `[ -f "$dst" ]` -
            # which passes even when tr wrote nothing, because `>` creates the
            # file before tr runs. A zero-byte guardian-luminance.sh was
            # reported as "copied". Compare the content instead of asking
            # whether a file exists.
            *.sh)
                if to_lf "$src" "$dst"; then
                    chmod +x "$dst" 2>/dev/null || true
                    if [ -s "$dst" ] && [ "$(tr -d '\r' < "$src" | wc -c)" -eq "$(wc -c < "$dst")" ]; then
                        copied=1
                    fi
                fi
                ;;
            # `cp` used to be a bare command in an if-body, so under `set -e` a
            # failure aborted the whole script mid-loop and the note_fail below
            # was unreachable - leaving half the deployment on disk with no
            # message, which is the exact partial-install this script exists to
            # prevent. Guarding it keeps the loop alive and the failure counted.
            *)
                if cp "$src" "$dst"; then copied=1; fi
                ;;
        esac
        if [ "$copied" -eq 1 ]; then step "$done_verb   $rel"; else note_fail "copy failed: $rel"; fi
    else
        step "$will_verb $rel"
    fi
    CHANGES=$((CHANGES + 1))
done
say ""

# ---------------------------------------------------------------------------
# 3. configuration.yaml - the one file that can destroy work.
# ---------------------------------------------------------------------------
say "3. configuration.yaml"
CFG_SRC=$REPO/configuration.yaml
CFG_DST=$CONFIG_DIR/configuration.yaml
MERGE_NEEDED=0

if [ ! -f "$CFG_SRC" ]; then
    note_fail "missing from the repo: configuration.yaml"
elif [ ! -f "$CFG_DST" ]; then
    if [ "$APPLY" -eq 1 ]; then
        # The `&&` used to be the only thing checking this copy, which means a
        # failure was invisible twice over: `set -e` exempts a non-final command
        # in an AND-OR list, so the script did not stop, and nothing printed or
        # counted anything either. FAILED stayed 0, the run ended "Files are in
        # place", and the user restarted Home Assistant onto a box with no
        # configuration.yaml at all - which boots HA's own default and loads
        # none of Guardian.
        if cp "$CFG_SRC" "$CFG_DST"; then
            step "copied      configuration.yaml (none was there)"
        else
            note_fail "copy failed: configuration.yaml"
        fi
    else
        step "would copy  configuration.yaml (none is there)"
    fi
    CHANGES=$((CHANGES + 1))
elif cmp -s "$CFG_SRC" "$CFG_DST"; then
    step "unchanged   configuration.yaml"
else
    MERGE_NEEDED=1
    warn "$CFG_DST already exists and differs from the repo copy."
    warn "NOT overwriting it. Merge the block printed at the end by hand."
fi
say ""

# ---------------------------------------------------------------------------
# 4. Preflight.
# ---------------------------------------------------------------------------
say "4. Preflight"
PY=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then PY=$candidate; break; fi
done

if [ -z "$PY" ]; then
    warn "no python3 on PATH, skipping preflight."
    warn "The Home Assistant SSH add-on has no python3; run"
    warn "tools/guardian-preflight.py from your workstation instead."
else
    # Quoted, so a repo or config path containing a space reaches preflight as
    # one argument. `$PF_ARGS` unquoted split "--repo /home/me/My Projects/..."
    # into three words and preflight read the wrong path.
    set -- --repo "$REPO"
    [ "$APPLY" -eq 1 ] && set -- "$@" --config-dir "$CONFIG_DIR"
    # Preflight failing does NOT count as an install failure and does not
    # suppress the punch list below. The two halves are independent: an
    # esphome/secrets.yaml still holding template values is a real problem, but
    # it blocks flashing the devices (INSTALL.md §7), not the restart that makes
    # the Home Assistant half live. Hiding "restart Home Assistant" behind it
    # would leave the files copied and the user with no idea what to do next.
    if "$PY" "$REPO/tools/guardian-preflight.py" "$@"; then
        PREFLIGHT_OK=1
    else
        PREFLIGHT_OK=0
        warn "preflight reported problems (above). Fix them before you flash the"
        warn "devices; the Home Assistant half below is unaffected."
    fi
fi
say ""

# ---------------------------------------------------------------------------
# 5. What is left, and what only a human can do.
# ---------------------------------------------------------------------------
# The ?v= cache-buster is read out of the repo's own configuration.yaml rather
# than written here, so nothing below can drift from the release the user is
# actually installing. A stale version string in a merge block would be the same
# half-copied-install bug this script exists to prevent, just relocated into the
# fix for it.
VERSION=$(sed -n 's|.*guardian-panel\.js?v=\([0-9][0-9.]*\).*|\1|p' \
    "$CFG_SRC" 2>/dev/null | head -1)
[ -n "$VERSION" ] || VERSION="SEE-configuration.yaml"

# THE UPGRADE PATH'S CACHE TRAP, AND THE ONE EDIT THIS SCRIPT NOW MAKES.
#
# On an existing install this script copies the new guardian-panel.js but leaves
# the user's configuration.yaml alone - so module_url still carries the PREVIOUS
# ?v=. Every browser that already holds the old file under that url keeps
# serving it against the new backend, and the panel reports a version
# disagreement on an install that is otherwise completely correct.
#
# ?v= only works once per value: a browser that requests the NEW url while the
# OLD file is still on disk caches the wrong bytes against the right address for
# a month. That is why the files above are copied before any restart is
# suggested.
#
# Until the forty-fourth pass this printed a warning and stopped. That was
# better than nothing and it relied on somebody reading a line of console output
# during an upgrade, so it recurred on EVERY release - and the household spent
# three releases being told by Diagnostics to clear a cache that held nothing
# stale. A warning nobody acts on is a defect with a paper trail.
#
# So this is now the ONE edit this script makes to a configuration.yaml it did
# not write, and it is deliberately the smallest edit that can exist:
#
#   * It rewrites ONLY the ?v= digits inside a guardian-ui/*.js query string.
#     Not the line, not the block, not the file - the substitution is anchored
#     on `guardian-ui/<name>.js?v=` so nothing else in a household's
#     configuration.yaml can match it.
#   * It backs the file up first, with the same timestamped scheme every other
#     overwrite in this script uses, and REFUSES to edit if the backup fails.
#   * It verifies afterwards that the ONLY difference between the backup and the
#     new file is ?v= lines. If anything else moved, it puts the original back
#     and says so. sed is being trusted with a household's Home Assistant
#     configuration; it does not get to be trusted without a receipt.
#   * It prints what it changed and where the backup is.
#
# The promise this script makes therefore narrows, and the header says so: it
# never touches anything in configuration.yaml except the cache-buster it wrote
# in the first place.
CFG_VBUMPED=0
if [ -f "$CFG_DST" ] && [ "$VERSION" != "SEE-configuration.yaml" ]; then
    LIVE_V=$(sed -n 's|.*guardian-ui/[A-Za-z0-9._-]*\.js?v=\([0-9][0-9.]*\).*|\1|p' \
        "$CFG_DST" 2>/dev/null | head -1)
    if [ -n "$LIVE_V" ] && [ "$LIVE_V" != "$VERSION" ]; then
        if [ "$APPLY" -eq 1 ]; then
            CFG_BAK=$CFG_DST.guardian-backup-$STAMP
            if cp "$CFG_DST" "$CFG_BAK"; then
                # The capture group deliberately ends BEFORE `.js`, so the
                # backreference in the replacement is followed by a `.` and not
                # by a digit. `\1$VERSION` would read as `\12...` for a version
                # starting with 2, and only GNU sed resolves that the way it
                # looks - this script is written to survive BusyBox.
                if sed "s|guardian-ui/\([A-Za-z0-9._-]*\)\.js?v=[0-9][0-9.]*|guardian-ui/\1.js?v=$VERSION|g" \
                        "$CFG_BAK" > "$CFG_DST.guardian-tmp-$STAMP" 2>/dev/null; then
                    # Every differing line must be a ?v= line, in both
                    # directions. A sed that ate something else fails here.
                    #
                    # `|| true` is load-bearing: `grep -c` exits 1 when the
                    # count is ZERO, which is the success case, and under
                    # `set -e` that killed the whole script one line after the
                    # backup was taken. Caught by running it.
                    STRAY=$(diff "$CFG_BAK" "$CFG_DST.guardian-tmp-$STAMP" 2>/dev/null \
                        | grep '^[<>]' | grep -cv 'guardian-ui/[A-Za-z0-9._-]*\.js?v=' || true)
                    if [ "${STRAY:-1}" -eq 0 ]; then
                        if mv "$CFG_DST.guardian-tmp-$STAMP" "$CFG_DST"; then
                            step "bumped      configuration.yaml ?v=$LIVE_V -> ?v=$VERSION"
                            step "backed up   configuration.yaml -> $(basename "$CFG_BAK")"
                            CFG_VBUMPED=1
                        else
                            note_fail "could not replace configuration.yaml; original is untouched"
                        fi
                    else
                        rm -f "$CFG_DST.guardian-tmp-$STAMP"
                        note_fail "the ?v= edit would have changed $STRAY other line(s) in configuration.yaml - NOT edited"
                    fi
                else
                    rm -f "$CFG_DST.guardian-tmp-$STAMP"
                    note_fail "could not rewrite configuration.yaml ?v= - it is untouched"
                fi
            else
                note_fail "could not back up configuration.yaml - NOT editing it"
            fi
        else
            step "would bump  configuration.yaml ?v=$LIVE_V -> ?v=$VERSION (backed up first)"
            CFG_VBUMPED=1
        fi
        if [ "$CFG_VBUMPED" -eq 0 ]; then
            say "   !  YOUR configuration.yaml still says guardian-ui/...js?v=$LIVE_V"
            say "      and this release is $VERSION. Edit every ?v= in"
            say "      $CFG_DST to $VERSION BEFORE you restart, or"
            say "      browsers will keep serving the old panel and More -> Diagnostics"
            say "      will report a version mismatch on a correct install."
        fi
        say ""
    fi
fi

if [ "$MERGE_NEEDED" -eq 1 ]; then

    say "MERGE THIS INTO YOUR EXISTING $CFG_DST"
    say "----------------------------------------------------------------------"
    # Unquoted heredoc: $VERSION is the only expansion, and no other $ appears.
    cat <<MERGE
http:
  ip_ban_enabled: true
  login_attempts_threshold: 5

recorder:
  exclude:
    entities:
      - input_text.portal_pin_hash
    entity_globs:
      - input_text.rfid_*_card_id

frontend:
  themes: !include_dir_merge_named themes
  extra_module_url:
    - /local/guardian-ui/set-default-panel.js?v=$VERSION

automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml

panel_custom:
  - name: guardian-panel
    sidebar_title: Guardian
    sidebar_icon: mdi:shield-home
    url_path: guardian
    module_url: /local/guardian-ui/guardian-panel.js?v=$VERSION
    require_admin: false
    config:
      camera: camera.door_camera
      historyHours: 24

homeassistant:
  packages: !include_dir_named packages
  allowlist_external_dirs:
    - /config
MERGE
    say "----------------------------------------------------------------------"
    say "  * Do NOT declare homeassistant: twice - merge into the block you have."
    say "  * The http: and recorder: blocks are security settings, not optional:"
    say "    without http: Home Assistant allows unlimited login attempts, and"
    say "    without the recorder: exclusion the PIN hash goes into every backup."
    say "  * Already using packages:? Point it at your existing directory and put"
    say "    Guardian's two files in it, rather than adding a second key."
    say ""
fi

if [ "$FAILED" -gt 0 ]; then
    say "INSTALL INCOMPLETE - $FAILED file operation(s) failed above. Nothing"
    say "below is worth doing until they are fixed."
    exit 1
fi

if [ "$APPLY" -eq 0 ]; then
    say "Dry run complete. $CHANGES change(s) would be made. Re-run with --apply."
    [ "$PREFLIGHT_OK" -eq 0 ] && exit 1
    exit 0
fi

say "Files are in place. NOW DO THESE - none can be automated:"
say ""
say "  1. RESTART Home Assistant. A full restart, not a reload: packages/ merges"
say "     only at startup, and the panel does not appear in the sidebar until"
say "     then. Settings -> System -> top right -> Restart Home Assistant."
say ""
say "  2. Two minutes later, read the 'Guardian setup' persistent notification."
say "     script.guardian_setup_wizard runs itself and lists everything still"
say "     missing, by entity id. That list is the rest of this install."
say ""
say "  3. Things Home Assistant offers no way to provision from YAML:"
say "       - File notify integration -> /config/guardian_data_log.jsonl,"
say "         Timestamp OFF, entity id notify.guardian_data_log"
say "       - Companion app signed in on at least one phone (the ONLY source of"
say "         notify targets - without one Guardian cannot alarm anybody)"
say "       - Master PIN: Developer Tools -> Actions -> script.guardian_set_pin"
say "       - Door camera: Guardian -> More -> Install"
say "       - input_number.guardian_luma_rotate = 90 if you built the Door Lamp"
say "         module (its camera is mounted on its side). The wizard will not"
say "         guess this and a wrong value measures the wrong part of the room."
say ""
say "  4. Frigate person detection needs an mqtt: block in the Frigate config"
say "     and an authenticated broker. See INSTALL.md §8."
say ""
say "  5. Do NOT port-forward 8123. Guardian is a LAN system; use Tailscale or a"
say "     VPN if you want it from outside. See INSTALL.md § What leaves your"
say "     network."

if [ "$PREFLIGHT_OK" -eq 0 ]; then
    say ""
    say "Preflight problems are still outstanding (section 4). They do not affect"
    say "the restart above, but fix them before flashing the devices."
    exit 1
fi
