#!/usr/bin/env python3
"""Guardian preflight - validate a Guardian tree before it becomes a live system.

    python tools/guardian-preflight.py [--config-dir /config] [--repo .]

Exits 0 if everything a static check can see is right, 1 otherwise. Every
failure names the file, the value it found and the value or action it wants.

WHY THIS EXISTS

Guardian ships as loose YAML that nothing forces to arrive together, and
CURSOR_ONBOARDING.md is blunt that no automated tests exist. The normal way this
system breaks is therefore not a crash - it is a half-copied install that comes
up looking fine and is wrong days later, somewhere else, as a symptom that does
not name its cause. INSTALL.md's own §9 exists because of this. Every check
below is one of those silent failures made loud, at the only moment it is cheap
to fix.

It is deliberately dependency-light: PyYAML if available (and it degrades to a
textual check if not), nothing else. It makes no network call, reads no
credential value, and writes nothing. Safe to run at any time, on the dev box or
on the Home Assistant host.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:  # pragma: no cover - exercised only on a bare interpreter
    yaml = None


# --------------------------------------------------------------------------
# Home Assistant's YAML tags. PyYAML's safe_load does not know them, so
# configuration.yaml fails to parse on !include before any real problem is
# reached. Register them as no-ops: this checks SYNTAX, not resolution.
# --------------------------------------------------------------------------
HA_TAGS = (
    "!include",
    "!include_dir_named",
    "!include_dir_merge_named",
    "!include_dir_list",
    "!include_dir_merge_list",
    "!secret",
    "!env_var",
    "!input",
    # ESPHome's own tags. portal-unit.yaml and doorbell-unit.yaml are full of
    # !lambda; without these the device YAML "fails" on line 467 for a reason
    # that has nothing to do with the file being wrong.
    "!lambda",
    "!extend",
    "!remove",
    "!force",
)


def _ha_loader():
    class HALoader(yaml.SafeLoader):
        pass

    def opaque(loader, node):
        if isinstance(node, yaml.ScalarNode):
            return loader.construct_scalar(node)
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node)
        return loader.construct_mapping(node)

    for tag in HA_TAGS:
        HALoader.add_constructor(tag, opaque)
    return HALoader


class Report:
    """Collects findings so every problem is reported, not just the first."""

    def __init__(self):
        self.failures = []
        self.warnings = []
        self.notes = []

    def fail(self, where, what, fix):
        self.failures.append((where, what, fix))

    def warn(self, where, what, fix):
        self.warnings.append((where, what, fix))

    def ok(self, message):
        self.notes.append(message)

    def render(self):
        for message in self.notes:
            print("  ok    %s" % message)
        if self.warnings:
            print()
            for i, (where, what, fix) in enumerate(self.warnings, 1):
                print("  warn %d. %s" % (i, where))
                print("          %s" % what)
                print("          -> %s" % fix)
        if self.failures:
            print()
            for i, (where, what, fix) in enumerate(self.failures, 1):
                print("  FAIL %d. %s" % (i, where))
                print("          %s" % what)
                print("          -> %s" % fix)
        print()
        if self.failures:
            print(
                "PREFLIGHT FAILED - %d problem(s), %d warning(s)."
                % (len(self.failures), len(self.warnings))
            )
            return 1
        if self.warnings:
            print("Preflight passed with %d warning(s)." % len(self.warnings))
            return 0
        print("Preflight passed.")
        return 0


def read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


# --------------------------------------------------------------------------
# 1. Every YAML file parses.
# --------------------------------------------------------------------------
YAML_FILES = [
    "configuration.yaml",
    "automations.yaml",
    "scripts.yaml",
    "scenes.yaml",
    "packages/guardian.yaml",
    "packages/guardian_rfid.yaml",
    "esphome/portal-unit.yaml",
    "esphome/doorbell-unit.yaml",
    "frigate/config.yml.example",
]


def check_yaml(repo, rep):
    if yaml is None:
        rep.warn(
            "PyYAML not installed",
            "YAML syntax could not be checked.",
            "pip install pyyaml, then re-run. Everything else still ran.",
        )
        return {}
    loader = _ha_loader()
    loaded = {}
    for rel in YAML_FILES:
        path = os.path.join(repo, rel)
        if not os.path.isfile(path):
            rep.fail(
                rel,
                "File is missing from the repository tree.",
                "Restore it. Guardian's YAML is not optional per-file; see INSTALL.md §3.",
            )
            continue
        try:
            loaded[rel] = yaml.load(read(path), Loader=loader)
        except yaml.YAMLError as err:
            mark = getattr(err, "problem_mark", None)
            where = " line %d" % (mark.line + 1) if mark else ""
            rep.fail(
                "%s%s" % (rel, where),
                "YAML does not parse: %s" % (getattr(err, "problem", err),),
                "Fix the syntax. Home Assistant would refuse to start on this.",
            )
    if len(loaded) == len(YAML_FILES):
        rep.ok("all %d YAML files parse" % len(YAML_FILES))
    return loaded


# --------------------------------------------------------------------------
# 2. The version literals agree.
#
# Guardian ships as files that nothing forces to arrive together. The panel
# reports a mismatch on More -> Diagnostics, but only once the system is already
# running and only if someone looks. This is the same check, before the restart.
#
# automations.yaml is in this list as of 2.24.0. It had no version literal for
# the whole life of the check, which meant the largest runtime file - the one
# holding the Major Alarm Handler, every watchdog and every detection path - was
# the only one a stale copy of could pass preflight clean.
# --------------------------------------------------------------------------
VERSION_SOURCES = [
    ("packages/guardian.yaml", r"state:\s*'(\d+\.\d+\.\d+)'"),
    ("packages/guardian_rfid.yaml", r"state:\s*'(\d+\.\d+\.\d+)'"),
    ("scripts.yaml", r"alias:\s*Guardian - Backend Version (\d+\.\d+\.\d+)"),
    ("automations.yaml", r"alias:\s*Guardian - Automations Version (\d+\.\d+\.\d+)"),
    ("www/guardian-ui/guardian-panel.js", r"GUARDIAN_UI_VERSION\s*=\s*'(\d+\.\d+\.\d+)'"),
    ("www/guardian-ui/preview.html", r"guardian-panel\.js\?v=(\d+\.\d+\.\d+)"),
]


def _scan_versions(root, rep=None):
    """Every version literal under `root`, keyed by where it was found.

    Split out of check_versions so check_deployed can run the identical scan
    against /config. Presence of a file is not agreement between files, and the
    deployed tree is where they actually drift apart.
    """
    found = {}
    for rel, pattern in VERSION_SOURCES:
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            continue
        match = re.search(pattern, read(path))
        if match:
            found[rel] = match.group(1)
        elif rep is not None:
            rep.fail(
                rel,
                "No version literal matched %r." % pattern,
                "Each half declares a version; this one is unreadable.",
            )

    config = os.path.join(root, "configuration.yaml")
    if os.path.isfile(config):
        for i, version in enumerate(
                re.findall(r"guardian-ui/[\w.-]+\.js\?v=(\d+\.\d+\.\d+)", read(config))):
            found["configuration.yaml ?v= #%d" % (i + 1)] = version
    return found


def check_versions(repo, rep):
    found = {}
    for rel, pattern in VERSION_SOURCES:
        path = os.path.join(repo, rel)
        if not os.path.isfile(path):
            continue
        match = re.search(pattern, read(path))
        if match:
            found[rel] = match.group(1)
        else:
            rep.fail(
                rel,
                "No version literal matched %r." % pattern,
                "Each half declares a version; this one is unreadable.",
            )

    config = os.path.join(repo, "configuration.yaml")
    if os.path.isfile(config):
        qs = re.findall(r"guardian-ui/[\w.-]+\.js\?v=(\d+\.\d+\.\d+)", read(config))
        if len(qs) != 2:
            rep.fail(
                "configuration.yaml",
                "Expected two cache-busting ?v= query strings, found %d." % len(qs),
                "module_url and frontend.extra_module_url must both carry ?v=.",
            )
        for i, version in enumerate(qs):
            found["configuration.yaml ?v= #%d" % (i + 1)] = version

    # INSTALL.md §3 prints a configuration.yaml merge block for a household that
    # already has one, and that block carries the two ?v= strings literally.
    #
    # It is in this check because it went stale exactly the way everything else
    # here does, and with the same consequence. The merge path is the one people
    # take when they already run Home Assistant, the ?v= is what makes a browser
    # pick up a new panel, and a stale one there hands them a cached old panel
    # against a new backend - which is the half-copied install this file exists
    # to prevent, arriving through the instructions rather than the copy.
    #
    # tools/guardian-install.sh already prints this block with the version read
    # out of the repo. The prose copy had no such guard.
    install_doc = os.path.join(repo, "INSTALL.md")
    if os.path.isfile(install_doc):
        doc = read(install_doc)
        qs = re.findall(r"guardian-ui/[\w.-]+\.js\?v=(\d+\.\d+\.\d+)", doc)
        for i, version in enumerate(qs):
            found["INSTALL.md ?v= #%d" % (i + 1)] = version
        # "In this release they all read **2.26.0**" - the sentence that TELLS a
        # household which number to expect. It sat at 2.24.0 through two releases
        # because only the ?v= strings around it were checked, so the one line
        # naming the version was the one line free to be wrong. Same failure as
        # the merge block above, one paragraph away from it.
        prose = re.search(r"they all read\s*\n?\*\*(\d+\.\d+\.\d+)\*\*", doc)
        if prose:
            found["INSTALL.md version consistency prose"] = prose.group(1)

    if not found:
        return
    distinct = sorted(set(found.values()))
    if len(distinct) > 1:
        rep.fail(
            "version mismatch across the halves",
            "Found %s." % ", ".join("%s=%s" % (k, v) for k, v in sorted(found.items())),
            "A half-copied install. Copy every file from the same commit "
            "(INSTALL.md § Version consistency), and bump them together.",
        )
    else:
        rep.ok("all %d version literals agree at %s" % (len(found), distinct[0]))


# --------------------------------------------------------------------------
# 2b. The automations version marker is actually reachable.
#
# WHY THIS EXISTS: the check above compares the version literals, and one of
# them was being read through an entity that has never existed.
#
# sensor.guardian_version and script.guardian_selfcheck both report the version
# of automations.yaml. Until the forty-first pass they did it with
# state_attr('automation.guardian_automations_version_marker', 'friendly_name'),
# copying the idiom used one line above for scripts.yaml. It does not transfer.
# A SCRIPT's entity id comes from its YAML key, so script.guardian_version_marker
# is right. Automations are a LIST with no key - Home Assistant slugifies the
# ALIAS - so the marker is automation.guardian_automations_version_2_25_0 and
# nothing was ever called ...version_marker. Both templates therefore returned
# 'missing' on every install since the day they were written, and More ->
# Diagnostics showed a "files did not all come from the same version" banner on
# a perfectly correct deploy: the check for a half-copied install crying wolf,
# which is precisely how a household learns to ignore it.
#
# Nothing caught it because preflight reads the FILES and the bug was in how a
# template reads the running SYSTEM. DEPLOY.md step 249 - look at More ->
# Diagnostics after a deploy - is the check that would have, and it had never
# been run.
#
# Both templates now match on the alias prefix instead, which survives the
# entity id being frozen at whatever the first install minted. That makes the
# prefix a contract between three files, so this asserts it. It cannot prove the
# lookup resolves on a live system - only a restart shows that - but it does
# stop the string drifting in one place, which is the way this breaks next.
# --------------------------------------------------------------------------
MARKER_PREFIX = "Guardian - Automations Version "


def check_version_marker(repo, rep):
    alias = os.path.join(repo, "automations.yaml")
    readers = ("packages/guardian.yaml", "scripts.yaml")

    if os.path.isfile(alias) and not re.search(
            r"alias:\s*%s\d+\.\d+\.\d+" % re.escape(MARKER_PREFIX), read(alias)):
        rep.fail(
            "automations.yaml",
            "No automation alias matches %r + a version." % MARKER_PREFIX,
            "The version marker's alias is the only thing carrying "
            "automations.yaml's version into the running system. Restore it.",
        )
        return

    missing = [rel for rel in readers
               if os.path.isfile(os.path.join(repo, rel))
               and MARKER_PREFIX not in read(os.path.join(repo, rel))]
    if missing:
        rep.fail(
            ", ".join(missing),
            "Does not search for %r." % MARKER_PREFIX,
            "sensor.guardian_version and script.guardian_selfcheck both find the "
            "marker automation by this alias prefix. If it drifts, they silently "
            "report automations.yaml as 'missing' and Diagnostics claims a "
            "half-copied install on a correct one.",
        )
        return

    # Comment lines are stripped first. The note explaining this bug names the
    # dead entity on purpose - a check that forbade writing down what went wrong
    # would push the explanation out of the file it belongs in.
    def uncommented(rel):
        return "\n".join(
            line for line in read(os.path.join(repo, rel)).splitlines()
            if not line.lstrip().startswith("#")
        )

    stale = [rel for rel in readers
             if os.path.isfile(os.path.join(repo, rel))
             and "automation.guardian_automations_version_marker" in uncommented(rel)]
    if stale:
        rep.fail(
            ", ".join(stale),
            "Still looks up automation.guardian_automations_version_marker.",
            "That entity cannot exist: an automation's entity id is slugified "
            "from its alias, not from a key. Match on the alias prefix instead - "
            "and note the slugified id is frozen by the entity registry at "
            "whatever the FIRST install minted, so embedding the version in a "
            "lookup is wrong from the second release onward.",
        )
        return

    rep.ok("the automations version marker is reachable by alias prefix")


# --------------------------------------------------------------------------
# 3. guardian-luminance.sh is LF.
#
# A CRLF copy breaks BusyBox ash on the Home Assistant host, and the failure is
# an opaque "not found" naming the interpreter rather than the file.
# --------------------------------------------------------------------------
def check_line_endings(repo, rep):
    rel = "guardian/guardian-luminance.sh"
    path = os.path.join(repo, rel)
    if not os.path.isfile(path):
        rep.fail(rel, "Missing.", "See INSTALL.md §3.")
        return
    with open(path, "rb") as f:
        blob = f.read()
    if b"\r\n" in blob:
        rep.fail(
            rel,
            "Has CRLF line endings.",
            "Convert to LF. On the Home Assistant host BusyBox ash fails on the "
            "trailing \\r with a message that names the interpreter, not this file. "
            "tools/guardian-install.sh normalises this automatically.",
        )
    else:
        rep.ok("guardian-luminance.sh is LF")


# --------------------------------------------------------------------------
# 4. Every referenced Guardian script exists, and automation ids are unique.
# --------------------------------------------------------------------------
def check_script_refs(repo, loaded, rep):
    scripts = loaded.get("scripts.yaml")
    if not isinstance(scripts, dict):
        return
    defined = set(scripts.keys())

    referenced = set()
    for rel in ("automations.yaml", "scripts.yaml", "packages/guardian.yaml",
                "packages/guardian_rfid.yaml"):
        path = os.path.join(repo, rel)
        if os.path.isfile(path):
            # The lookahead keeps prose out of the results. scripts.yaml:52 talks
            # about "action: script.guardian_lamp_*" as a class of call, and a
            # bare \w+ match reports the glob stem as a missing script.
            referenced |= set(
                re.findall(r"script\.(guardian_[a-z0-9_]+)(?![*\w])", read(path))
            )

    # script.turn_on / turn_off are Home Assistant's own, not Guardian scripts.
    missing = sorted(referenced - defined - {"turn_on", "turn_off"})
    if missing:
        rep.fail(
            "scripts.yaml",
            "Referenced but not defined: %s." % ", ".join("script." + m for m in missing),
            "A call to a missing script raises at run time, inside whatever "
            "sequence invoked it. Define it or remove the call.",
        )
    else:
        rep.ok("all %d referenced guardian_* scripts are defined" % len(referenced))


def check_automation_ids(repo, loaded, rep):
    autos = loaded.get("automations.yaml")
    if not isinstance(autos, list):
        return
    seen = {}
    dupes = []
    for entry in autos:
        if not isinstance(entry, dict):
            continue
        aid = str(entry.get("id", ""))
        alias = entry.get("alias", "(no alias)")
        if aid in seen:
            dupes.append((aid, seen[aid], alias))
        seen[aid] = alias
    if dupes:
        rep.fail(
            "automations.yaml",
            "Duplicate automation ids: %s."
            % "; ".join("%s used by %r and %r" % d for d in dupes),
            "Home Assistant keeps only one of each id and drops the rest silently.",
        )
    else:
        rep.ok("%d automations, all ids unique" % len(seen))


# --------------------------------------------------------------------------
# 5. Nothing that can raise stands in front of an alert.
#
# THE RULE THIS ENFORCES, and why it is worth a static check.
#
# Home Assistant ends a sequence at the first step that raises. So any step that
# can fail, placed in front of a step that alerts, is a switch that silently
# turns the alarm off - and the conditions that make it fail (a device offline,
# a template entity not yet rendered, a helper that did not merge) are exactly
# the conditions under which an alarm matters most.
#
# This has now bitten three times. The Major Alarm Handler had an unguarded
# light.turn_on in front of both the push and the siren (fixed in 8e89db4).
# process_rfid_scan had an unguarded button.press on a PORTAL entity in front of
# the stolen-key alarm - and a stolen key can be scanned at the DOORBELL, so an
# offline portal turned "stolen key at the door" into total silence. The clone
# branch had the same press in front of its own alarm.
#
# All three were found by walking the YAML, not by reading it. That is what this
# does, every run:
#
#   push first, since nothing else is a precondition for it;
#   continue_on_error on every cosmetic step;
#   and leave a step unguarded only where a failure there means the alert
#   cannot happen anyway - guardian_set_display is the one such step, because
#   the siren loop gates on the state it writes.
#
# TWO THINGS THIS GETS RIGHT that a naive document-order scan does not:
#
#   * Sibling `choose` / `if` branches are mutually exclusive. A press in one
#     branch cannot abort an alarm in another. Reading the file top to bottom
#     reports three such pairs in "Guardian: Master PIN Entry Handler" that can
#     never both run. Each branch is therefore walked against the steps before
#     the choose, not against its siblings.
#   * A step that is ITSELF an alert still counts as a predecessor of a later
#     one. The stolen-key press is an alerting step (it sounds the siren) AND
#     the thing that aborted the alarm proper twenty lines below. A checker that
#     stops at the first alert misses the one bug that mattered most.
#
# THREE THINGS IT COULD NOT SEE, added in the forty-first pass. The rule above
# is about ORDER. Two of these are not order problems at all, and the first is
# an order problem the rule was looking straight through:
#
#   * IT STOPPED AT THE CALL BOUNDARY. RAISING_DOMAINS is a list of domains, and
#     "script." is not one, so "action: script.foo" scored as harmless and foo's
#     body was never walked. But that call BLOCKS, and Home Assistant hands the
#     callee's error back to the caller - so an unguarded step inside foo ends
#     the caller's sequence and cancels an alert twenty lines below the call.
#     That was live: process_rfid_scan calls guardian_reconcile_presence in
#     front of both the clone alarm and the stolen-key alarm, and the last step
#     of that script was an unguarded persistent_notification.create - a domain
#     already in the list, simply never looked at from there. A blocking call is
#     now walked in line at the call site. A call carrying continue_on_error is
#     not, because that genuinely catches whatever the callee raised.
#
#   * A STOP IS NOT A RAISE, and an alert below one is not at risk - it is
#     unreachable, which no amount of continue_on_error fixes. Reported
#     separately, in its own words, because the remedy is different.
#
#   * A LOOP THAT SOUNDS AN ALARM CAN KILL ITSELF. The siren is a repeat-while
#     whose body is one button.press on a PORTAL entity. Nothing precedes that
#     press, so there is no "in front of" to report - and an error inside a
#     repeat ends the entire run, so the first press into a disconnected portal
#     ended the siren for good, ALARM still on the screen, nothing anywhere able
#     to re-enter the loop. The fortieth pass fixed the path INTO this handler
#     and left the handler itself able to fall silent the same way. Only loops
#     containing an alert are reported: losing the elevated challenge's chirp is
#     not losing an alarm.
# --------------------------------------------------------------------------

# Steps that reach something outside Home Assistant's own helper state, and so
# can raise when a device is unavailable, an integration has not loaded, or a
# service name does not resolve. input_text and variable writes are local and
# are deliberately not in this set; see LOCAL_RAISING_ACTIONS for the two local
# writes that DO raise.
RAISING_DOMAINS = (
    "light.", "switch.", "button.", "media_player.", "number.", "select.",
    "climate.", "fan.", "cover.", "lock.", "camera.", "vacuum.", "siren.",
    "persistent_notification.", "notify.", "tts.", "remote.",
)

# TRIED AND REJECTED, recorded so it is not re-proposed as an obvious omission.
#
# FIRST, A CORRECTION TO THE NOTE BELOW, made in the forty-second pass. It
# treats input_select.select_option and input_number.set_value as one class.
# They are two, and the difference is the whole subject of this file's newer
# checks:
#
#   * input_select.select_option raises HomeAssistantError on an option the
#     helper does not carry. continue_on_error DOES swallow that.
#   * input_number.set_value raises voluptuous.Invalid on a value outside
#     min/max. continue_on_error does NOT swallow that - _handle_exception
#     re-raises vol.Invalid, TemplateError, ServiceNotFound,
#     InvalidEntityFormatError, NoEntitySpecifiedError and ConditionError
#     whatever the flag says, because those are misconfiguration rather than a
#     device failing to answer.
#
# So "add continue_on_error" was never a valid remedy for half of what the rule
# reported. Removing the rule was still right, for the volume reason below; the
# reasoning recorded for it was half wrong and would have misled the next
# person. See check_unguardable_arguments, which is the part of this class that
# a static checker CAN decide.
#
# input_select.select_option raises on an option the helper does not carry and
# input_number.set_value raises on a value outside min/max, so both genuinely
# belong to the class this check is about, and both were added here as
# "templated argument, unguarded" in the forty-first pass. The rule produced
# fifteen findings and thirteen of them were wrong, for two reasons the checker
# cannot see past:
#
#   * It cannot read a bound. guardian_set_display writes portal_display_seq as
#     "... + 1) % 10000" into a helper whose max is 9999. That is arithmetically
#     incapable of raising, and because guardian_set_display is called from
#     nearly everything, it alone accounted for eleven findings.
#   * It cannot see a guard that is not continue_on_error.
#     guardian_reconcile_presence tests option_exists in a condition three lines
#     above its select_option, with a comment explaining exactly this hazard -
#     the single most careful instance in the repo, reported as a fault.
#
# Both real instances were in process_rfid_scan's enrollment branch and are
# fixed. Leaving the rule in would have meant fifteen findings on a clean tree,
# and the argument in ALERTING_ACTIONS below applies with full force: a check
# nobody reads catches nothing. If this comes back it needs constant-folding for
# the first case and condition-awareness for the second, not a wider net.
LOCAL_RAISING_ACTIONS = {}

# What counts as an alert worth protecting.
#
# Not every notify call. guardian_sample_ambient_light reports a broken lamp
# sampler through the same script, and a lamp step standing in front of a lamp
# notice is not a fault - it is the notice describing what just failed. Forty of
# those drown the four that matter, and a check nobody reads catches nothing.
#
# The line is the repo's own vocabulary: severity urgent, or nonmaskable, is
# exactly how a call site says "this one must arrive". Everything routine is
# advisory and may be lost to a failure upstream of it without anyone coming to
# harm.
ALERTING_ACTIONS = (
    "script.guardian_notify_broadcast",
    "script.guardian_notify_person",
)
ALERTING_EVENT = "guardian.major_alarm"
PROTECTED_SEVERITIES = ("urgent",)


def _line_loader(rel):
    """A loader that stamps every mapping with the file and line it started on.

    Kept separate from _ha_loader so the dicts the other checks read stay
    clean - this one injects keys that are not in the file.

    The file name is stamped as well as the line because a blocking script call
    is now walked in line at its call site: the step that can raise and the
    alert it stands in front of routinely live in different files, and a finding
    that names a line number without a file is unactionable.
    """
    base = _ha_loader()

    class LineLoader(base):
        pass

    def mapping(loader, node):
        data = loader.construct_mapping(node, deep=True)
        data["__line__"] = node.start_mark.line + 1
        data["__file__"] = rel
        return data

    LineLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping
    )
    return LineLoader


def _step_action(step):
    action = step.get("action") or step.get("service") or ""
    return action if isinstance(action, str) else ""


def _called_script(step):
    """The guardian_* script a BLOCKING call names, or None.

    "action: script.foo" waits for foo and, critically, inherits its errors: a
    step inside foo that raises ends the CALLER's sequence too. script.turn_on
    and script.turn_off are fire-and-forget and inherit nothing.
    """
    action = _step_action(step)
    if not action.startswith("script.") or action in ("script.turn_on", "script.turn_off"):
        return None
    return action[len("script."):]


def _alert_payload(step):
    """The data mapping an alerting script call was given, wherever it lives.

    A blocking call puts it under `data:`; script.turn_on puts it under
    `data: variables:`. The Major Alarm Handler's push moved from the first form
    to the second in the forty-first pass so it could not delay the siren, and a
    checker that only looked at `data:` would have quietly stopped recognising
    the most important alert in the system as an alert at all.
    """
    data = step.get("data")
    if not isinstance(data, dict):
        return {}
    variables = data.get("variables")
    return variables if isinstance(variables, dict) else data


def _classify(step):
    """(is_alert, risk_description_or_None) for one leaf step."""
    action = _step_action(step)

    is_alert = step.get("event") == ALERTING_EVENT or (
        action == "button.press" and "play_alarm" in str(step.get("target", ""))
    )
    target_script = ""
    if action in ("script.turn_on", "script.turn_off"):
        target = step.get("target") or {}
        if isinstance(target, dict):
            target_script = str(target.get("entity_id", "")).strip()
    if action in ALERTING_ACTIONS or target_script in ALERTING_ACTIONS:
        data = _alert_payload(step)
        severity = str(data.get("severity", "")).strip().lower()
        nonmaskable = str(data.get("nonmaskable", "")).strip().lower()
        if severity in PROTECTED_SEVERITIES or nonmaskable == "true":
            is_alert = True

    risk = None
    if step.get("continue_on_error"):
        return is_alert, None

    entity = ""
    target = step.get("target") or {}
    if isinstance(target, dict):
        entity = str(target.get("entity_id", "")).strip()

    if action.startswith(RAISING_DOMAINS):
        risk = "%s %s" % (action, entity) if entity else action
    elif action in LOCAL_RAISING_ACTIONS:
        data = step.get("data")
        argument = ""
        if isinstance(data, dict):
            argument = str(data.get(LOCAL_RAISING_ACTIONS[action], ""))
        if "{{" in argument or "{%" in argument:
            risk = "%s %s (templated %s)" % (action, entity, LOCAL_RAISING_ACTIONS[action])
    return is_alert, risk


# Keys whose value is a nested sequence that runs in line with its parent.
_INLINE_SEQ = ("sequence", "actions")
# Keys whose values are mutually exclusive alternatives.
_BRANCH_SEQ = ("then", "else", "default")


def _collect_alerts(seq, out):
    """Every alerting step anywhere under `seq`, as (file, line).

    Used only to describe what a `stop` made unreachable. It does not need the
    path model - by the time this is called nothing below the stop can run at
    all, so the question is simply "was there an alert down there".
    """
    if not isinstance(seq, list):
        return
    for step in seq:
        if not isinstance(step, dict):
            continue
        nested = False
        for key in _BRANCH_SEQ + _INLINE_SEQ:
            if isinstance(step.get(key), list):
                _collect_alerts(step[key], out)
                nested = True
        for entry in step.get("choose") or []:
            if isinstance(entry, dict) and isinstance(entry.get("sequence"), list):
                _collect_alerts(entry["sequence"], out)
                nested = True
        repeat = step.get("repeat")
        if isinstance(repeat, dict) and isinstance(repeat.get("sequence"), list):
            _collect_alerts(repeat["sequence"], out)
            nested = True
        for entry in step.get("parallel") or []:
            if isinstance(entry, dict):
                _collect_alerts([entry], out)
                nested = True
        if nested:
            continue
        if _classify(step)[0]:
            out.append((step.get("__file__"), step.get("__line__")))


def _collect_loop_risks(seq, out):
    """Every unguarded step under `seq` that can raise, as (file, line, desc).

    Used only for repeat bodies. Position is irrelevant here - anywhere inside
    the loop is in front of the loop's next iteration.
    """
    if not isinstance(seq, list):
        return
    for step in seq:
        if not isinstance(step, dict):
            continue
        nested = False
        for key in _BRANCH_SEQ + _INLINE_SEQ:
            if isinstance(step.get(key), list):
                _collect_loop_risks(step[key], out)
                nested = True
        for entry in step.get("choose") or []:
            if isinstance(entry, dict) and isinstance(entry.get("sequence"), list):
                _collect_loop_risks(entry["sequence"], out)
                nested = True
        inner = step.get("repeat")
        if isinstance(inner, dict) and isinstance(inner.get("sequence"), list):
            _collect_loop_risks(inner["sequence"], out)
            nested = True
        if nested:
            continue
        risk = _classify(step)[1]
        if risk:
            out.append((step.get("__file__"), step.get("__line__"), risk))


def _walk(seq, before, findings, scripts=None, stack=(), unreachable=None, via=None,
          loops=None):
    """Walk one sequence.

    `before` is the list of (file, line, risk) that may already have run on THIS
    execution path. Returns (path, terminated) - what a following step should
    consider may have run, and whether control can reach a following step at all.

    `scripts` maps a guardian_* script name to its sequence, so a BLOCKING
    "action: script.foo" can be walked in line at the call site. That is the
    whole point of it: Home Assistant propagates an error out of a blocking
    script call into the caller, so an unguarded step inside foo ends the
    caller's sequence and can cancel an alert twenty lines below the call. The
    original rule stopped at the domain of the step - and "script." is not a
    domain that raises - so this class was invisible. It was live in
    guardian_reconcile_presence, which process_rfid_scan calls in front of both
    the clone alarm and the stolen-key alarm.

    `stack` is the call stack of script names, which is what keeps a recursive
    or mutually recursive pair from walking forever.
    """
    if not isinstance(seq, list):
        return before, False
    path = list(before)
    for index, step in enumerate(seq):
        if not isinstance(step, dict):
            continue
        line = step.get("__line__")
        file_name = step.get("__file__")

        # A stop ends this path. Nothing after it in this sequence runs, so an
        # alert below it is not "behind a risky step" - it is unreachable, which
        # no amount of continue_on_error can fix and which the ordering rule
        # cannot see. Report what was lost and stop walking.
        if "stop" in step:
            if unreachable is not None:
                lost = []
                _collect_alerts(seq[index + 1:], lost)
                for lost_file, lost_line in lost:
                    unreachable.append((file_name, line, str(step.get("stop"))[:60],
                                        lost_file, lost_line))
            return path, True

        # A container contributes its branches; it is not itself a leaf.
        branches = []
        exhaustive = False
        for key in _BRANCH_SEQ:
            if isinstance(step.get(key), list):
                branches.append(step[key])
        if isinstance(step.get("then"), list) and isinstance(step.get("else"), list):
            exhaustive = True
        chose = False
        for entry in step.get("choose") or []:
            if isinstance(entry, dict) and isinstance(entry.get("sequence"), list):
                branches.append(entry["sequence"])
                chose = True
        if chose and isinstance(step.get("default"), list):
            exhaustive = True
        repeat = step.get("repeat")
        if isinstance(repeat, dict) and isinstance(repeat.get("sequence"), list):
            branches.append(repeat["sequence"])
            # A LOOP THAT SOUNDS AN ALARM IS NOT AN ORDERING PROBLEM, and this
            # is the one shape the fortieth pass's rule structurally cannot
            # express. Its siren is a repeat-while whose body is a single
            # button.press on a PORTAL entity: nothing precedes that press, so
            # there is no "in front of" to report - and yet an error inside a
            # repeat ends the whole run, so the first press into a disconnected
            # portal ended the siren for good, with the ALARM screen still up
            # and no path back into the loop. Guarded, the same press just
            # retries every three seconds and resumes when the portal answers.
            #
            # Narrow on purpose: only loops that contain an alert. The elevated
            # challenge's chirp loop is the same construction and is not a
            # finding, because losing a chirp is not losing an alarm.
            alerts_inside = []
            _collect_alerts(repeat["sequence"], alerts_inside)
            if alerts_inside and loops is not None:
                risky = []
                _collect_loop_risks(repeat["sequence"], risky)
                for risk_file, risk_line, risk_desc in risky:
                    loops.append((risk_file, risk_line, risk_desc,
                                  alerts_inside[0][0], alerts_inside[0][1]))
        for entry in step.get("parallel") or []:
            if isinstance(entry, dict):
                inner = entry.get("sequence")
                branches.append(inner if isinstance(inner, list) else [entry])
        for key in _INLINE_SEQ:
            if isinstance(step.get(key), list):
                branches.append(step[key])

        # A blocking call to a known script is a branch that always runs, in
        # line, carrying the caller's path in and its own risks back out.
        #
        # continue_on_error on the CALL is what stops this: it catches whatever
        # the callee raised, so the callee's steps cannot end the caller's
        # sequence and there is nothing to inherit. Every blocking alerting call
        # in this repo is guarded that way, which is also why inlining them
        # would be wrong.
        called = _called_script(step)
        if (called and scripts and called in scripts and called not in stack
                and not step.get("continue_on_error")):
            # The call may itself be the alert - "action:
            # script.guardian_notify_person" with severity urgent - and that has
            # to be scored at the call site before its body is walked, or a
            # checker that inlines silently stops recognising the alerts it was
            # written to protect.
            is_alert, _risk = _classify(step)
            if is_alert and path:
                for risk_file, risk_line, risk_desc in path:
                    findings.append((risk_file, risk_line, risk_desc, file_name, line))
            # A script that stops does not stop its caller: `stop` ends the
            # script's own run and the caller carries on with the next step.
            path, _inner_stop = _walk(
                scripts[called], path, findings, scripts, stack + (called,),
                unreachable, called, loops)
            continue

        if branches:
            # Each alternative sees only what preceded the container. What
            # follows the container must assume any of them may have run - and
            # only the alternatives that can actually fall out of the container
            # contribute, since a branch that stopped has no "after".
            after = list(path)
            stopped = []
            for branch in branches:
                branch_path, branch_stop = _walk(
                    branch, path, findings, scripts, stack, unreachable, via, loops)
                stopped.append(branch_stop)
                if branch_stop:
                    continue
                for item in branch_path:
                    if item not in after:
                        after.append(item)
            path = after
            # Only an exhaustive container - if/else, or choose with a default -
            # can end the outer path, and only when every arm of it does. An if
            # with no else always has a fall-through.
            if exhaustive and stopped and all(stopped):
                return path, True
            continue

        is_alert, risk = _classify(step)
        if is_alert and path:
            for risk_file, risk_line, risk_desc in path:
                findings.append((risk_file, risk_line, risk_desc, file_name, line))
        if risk:
            if via:
                # Name the script the step actually lives in. Without this a
                # finding reads as two line numbers in one file with no hint
                # that a blocking call is what connects them, which is the one
                # thing a reader needs to know to act on it.
                risk = "%s [inside script.%s, reached by a blocking call]" % (risk, via)
            path.append((file_name, line, risk))
    return path, False


def check_alert_ordering(repo, rep):
    if yaml is None:
        return
    findings = []
    unreachable = []
    loops = []
    units = 0

    # Scripts are loaded first and kept, because the automation walk needs them:
    # a blocking "action: script.foo" in an automation is walked into foo's body.
    bodies = {}
    path = os.path.join(repo, "scripts.yaml")
    if os.path.isfile(path):
        scripts = yaml.load(read(path), Loader=_line_loader("scripts.yaml")) or {}
        for name, body in scripts.items():
            if isinstance(body, dict) and isinstance(body.get("sequence"), list):
                bodies[name] = body["sequence"]

    def record(found, unit):
        for risk_file, risk_line, desc, alert_file, alert_line in found:
            findings.append(
                "%s:%s %s -- unguarded, in front of the alert at %s:%s (%s)"
                % (risk_file, risk_line, desc, alert_file, alert_line, unit)
            )

    path = os.path.join(repo, "automations.yaml")
    if os.path.isfile(path):
        autos = yaml.load(read(path), Loader=_line_loader("automations.yaml"))
        for entry in autos if isinstance(autos, list) else []:
            if isinstance(entry, dict):
                units += 1
                found = []
                _walk(entry.get("actions"), [], found, bodies, (), unreachable,
                      None, loops)
                record(found, repr(entry.get("alias", "?")))

    for name, sequence in bodies.items():
        units += 1
        found = []
        _walk(sequence, [], found, bodies, (name,), unreachable, None, loops)
        record(found, "script." + name)

    if findings:
        rep.fail(
            "a step that can raise stands in front of an alert",
            "; ".join(sorted(set(findings))),
            "Home Assistant ends a sequence at the first step that raises, so "
            "each of these can silently cancel the alert below it. Put the "
            "push first - nothing else is a precondition for it - and add "
            "continue_on_error: true to the cosmetic step. Leave a step "
            "unguarded only where its failure means the alert cannot happen "
            "anyway. A step inside a script reached by a blocking "
            "'action: script.foo' counts: the error comes back out of the call.",
        )
    if unreachable:
        rep.fail(
            "a stop makes an alert below it unreachable",
            "; ".join(sorted(set(
                "%s:%s stop (%s) -- the alert at %s:%s below it can never run" % item
                for item in unreachable))),
            "A stop ends the run. Nothing after it in that sequence executes, so "
            "no amount of continue_on_error saves the alert - move the alert "
            "above the stop, or make the stop conditional.",
        )
    if loops:
        rep.fail(
            "a raising step inside a loop that sounds an alarm",
            "; ".join(sorted(set(
                "%s:%s %s -- unguarded inside the repeat that sounds the alert "
                "at %s:%s, so the first failure ends the loop for good" % item
                for item in loops))),
            "An error inside a repeat ends the whole run, and nothing re-enters "
            "the loop. Add continue_on_error: true so the loop retries on its "
            "next tick instead of dying - a siren that stops the first time the "
            "portal blinks is not a siren.",
        )
    if not findings and not unreachable and not loops:
        rep.ok(
            "no raising step in front of an alert, stranded behind a stop, or "
            "able to end an alarm loop (%d sequences checked, blocking script "
            "calls walked in line)" % units
        )


# --------------------------------------------------------------------------
# 6. No external URL under www/guardian-ui/.
#
# Regression guard. preview.html once pulled the Material Design Icons webfont
# from a CDN, and INSTALL.md told the reader to copy that whole directory into
# /config/www - which Home Assistant serves as /local with no authentication. So
# the security system's host shipped an unauthenticated page that reached out to
# a third party. Nothing here may reference an off-box host again.
# --------------------------------------------------------------------------
ALLOWED_URL = re.compile(r"https?://(www\.w3\.org|localhost|127\.0\.0\.1)")


# --------------------------------------------------------------------------
# 6b. Arguments that continue_on_error cannot guard.
#
# THE PREMISE THE PREVIOUS TWO PASSES WERE BUILT ON IS ONLY HALF TRUE. Both
# fixed "a step that raises cancels the alert below it" by adding
# continue_on_error, and both wrote comments asserting the guard holds. Home
# Assistant's _ScriptRun._handle_exception says otherwise:
#
#     if isinstance(exception, (vol.Invalid, exceptions.TemplateError,
#                               exceptions.ServiceNotFound,
#                               exceptions.InvalidEntityFormatError,
#                               exceptions.NoEntitySpecifiedError,
#                               exceptions.ConditionError)):
#         raise exception
#     # Only Home Assistant errors can be ignored.
#
# continue_on_error catches a device that is reachable in principle and did not
# answer. It does NOT catch an entity_id that is not an entity id (vol.Invalid)
# or a service name that does not exist (ServiceNotFound). Those are exactly
# what a TEMPLATED argument produces on a half-copied install, in the startup
# window, or when a phone leaves the device registry - which is to say, exactly
# the conditions this system exists to survive.
#
# Two live faults were found by writing this check, both in code carrying a
# comment claiming continue_on_error covered them:
#
#   * Guardian: Major Alarm Handler set the lamp red at
#     "{{ states('sensor.guardian_lamp_entity') }}". That sensor reads unknown
#     with packages/ missing or not yet rendered - and "unknown" fails the
#     service schema. The step raised, the sequence ended, and THE SIREN LOOP
#     ON THE NEXT LINE NEVER RAN. The alarm pushed to every phone and the house
#     stayed silent.
#   * script.guardian_reset pressed the doorbell's restart button at an
#     attribute that is '' on any install with no doorbell. Same raise; the
#     reset stopped before the ambient re-sample, the guardian.system_reset
#     event and its own confirmation push.
#
# THE REMEDY IS NOT A BIGGER GUARD, IT IS AN ARGUMENT THAT CANNOT BE INVALID.
# A templated entity_id must fall back to the literal `none` - ENTITY_MATCH_NONE,
# always schema-valid, matches nothing - or be built so it cannot render junk in
# the first place. Four shapes pass:
#
#   S1  contains "else 'none'"                     the sentinel idiom
#   S2  chooses among entity-id literals and reads no state
#   S3  has a literal "domain.prefix" before the first substitution
#   S4  is a bare {{ var }} whose assignment satisfies S1-S3
#
# A templated SERVICE name cannot be made safe this way - there is no template
# function that asks whether a service exists - so it gets a structural rule
# instead: exactly one script in this repo may template one, it must be that
# script's only service call, and nothing may call it blocking.
# --------------------------------------------------------------------------
# Home Assistant's own valid_entity_id pattern, quoted for a Jinja `is match`
# test. Not a looser approximation: "^[a-z_]+\.[a-z0-9_]+$" accepts light.rfid_
# and my__light.x, both of which cv.entity_id rejects, so a sentinel built on it
# would hand vol.Invalid straight through the guard it exists to be.
HA_ENTITY_ID_PATTERN = r"'^(?!.+__)(?!_)[\da-z_]+(?<!_)\.(?!_)[\da-z_]+(?<!_)$'"
ENTITY_ID_RE = re.compile(r"^[a-z_]+\.[a-z0-9_]+$")
LITERAL_PREFIX_RE = re.compile(r"^[a-z_]+\.[a-z0-9_]*$")
STATE_CALL_RE = re.compile(
    r"\b(?:states|state_attr|is_state|is_state_attr|expand|device_entities|"
    r"integration_entities|area_entities|label_entities|device_id)\s*\("
)
BARE_VAR_RE = re.compile(r"^\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}$")

# The one place a service name may be templated, and the only way it may be
# reached. Both halves are the contract; either alone is not.
ISOLATED_SERVICE_SCRIPT = "guardian_notify_send_one"


def _has_template(val):
    return isinstance(val, str) and ("{{" in val or "{%" in val)


# The sentinel, in the two shapes the repo writes it: as an else-expression
# inside {{ }}, and as literal output between {% else %} and {% endif %}.
SENTINEL_RE = re.compile(r"else\s*['\"]?none['\"]?|%\}\s*none\s*\{%")


def _entity_arg_ok(val, safe_vars, _depth=0):
    """True when this entity_id template cannot render an invalid entity id."""
    text = " ".join(val.split())
    if SENTINEL_RE.search(text):
        return True                                             # S1
    head = text.split("{", 1)[0].strip()
    if head and LITERAL_PREFIX_RE.match(head):
        return True                                             # S3
    if not STATE_CALL_RE.search(text):                          # S2
        lits = re.findall(r"'([^']*)'|\"([^\"]*)\"", text)
        flat = [a or b for a, b in lits]
        # Only the DOTTED literals are candidate entity ids; a bare 'entry' in
        # "if trigger.id == 'entry'" is a comparison value, not a target.
        dotted = [s for s in flat if "." in s]
        if dotted and all(ENTITY_ID_RE.match(s) for s in dotted):
            return True
    m = BARE_VAR_RE.match(text)                                 # S4
    if m and _depth == 0:
        assigned = safe_vars.get(m.group(1))
        if assigned is not None and _entity_arg_ok(assigned, safe_vars, 1):
            return True
    return False


def _collect_variable_assignments(node, out):
    """Every name: template pair written by a `variables:` block in the tree."""
    if isinstance(node, dict):
        block = node.get("variables")
        if isinstance(block, dict):
            for k, v in block.items():
                if isinstance(v, str) and isinstance(k, str):
                    out.setdefault(k, v)
        for v in node.values():
            _collect_variable_assignments(v, out)
    elif isinstance(node, list):
        for v in node:
            _collect_variable_assignments(v, out)


def _collect_templated_args(node, safe_vars, bad_ids, svc_calls):
    if isinstance(node, dict):
        for key in ("entity_id",):
            for holder in (node, node.get("target") if isinstance(node.get("target"), dict) else {}):
                val = holder.get(key) if isinstance(holder, dict) else None
                if _has_template(val) and not _entity_arg_ok(val, safe_vars):
                    bad_ids.append(" ".join(val.split())[:110])
        act = node.get("action") or node.get("service")
        if _has_template(act):
            svc_calls.append(" ".join(act.split())[:80])
        for v in node.values():
            _collect_templated_args(v, safe_vars, bad_ids, svc_calls)
    elif isinstance(node, list):
        for v in node:
            _collect_templated_args(v, safe_vars, bad_ids, svc_calls)


def check_unguardable_arguments(repo, rep):
    loader = _ha_loader()
    bad_ids, stray_svc, blocking = [], [], []
    for rel in ("automations.yaml", "scripts.yaml", "packages/guardian.yaml"):
        path = os.path.join(repo, rel)
        if not os.path.isfile(path):
            continue
        try:
            data = yaml.load(read(path), Loader=loader)
        except Exception:
            return                      # check_yaml already reported this
        safe_vars = {}
        _collect_variable_assignments(data, safe_vars)
        if rel == "scripts.yaml" and isinstance(data, dict):
            for name, body in data.items():
                ids, svcs = [], []
                _collect_templated_args(body, safe_vars, ids, svcs)
                bad_ids += [("%s: %s" % (rel, t)) for t in ids]
                if svcs and name != ISOLATED_SERVICE_SCRIPT:
                    stray_svc += [("%s in script.%s" % (t, name)) for t in svcs]
        else:
            ids, svcs = [], []
            _collect_templated_args(data, safe_vars, ids, svcs)
            bad_ids += [("%s: %s" % (rel, t)) for t in ids]
            stray_svc += [("%s in %s" % (t, rel)) for t in svcs]
        # A blocking call re-raises whatever the callee raised, so isolating the
        # service call is worth nothing if somebody waits on the isolator.
        for lineno, line in enumerate(read(path).splitlines(), 1):
            if re.match(r"\s*-?\s*(action|service):\s*script\.%s\s*$"
                        % ISOLATED_SERVICE_SCRIPT, line):
                blocking.append("%s:%d" % (rel, lineno))

    if bad_ids:
        rep.fail(
            "templated entity_id that continue_on_error cannot guard",
            "; ".join(bad_ids),
            "An entity_id that renders to something that is not an entity id "
            "raises vol.Invalid, which Home Assistant re-raises REGARDLESS of "
            "continue_on_error - so the step ends the sequence and everything "
            "below it, including any siren, never runs. Fall back to the "
            "literal `none` (ENTITY_MATCH_NONE), using Home Assistant's own "
            "valid_entity_id pattern so a trailing underscore or a stray space "
            "cannot slip through: "
            "{% set e = states('...') | string | trim %}"
            "{{ e if e is match(" + HA_ENTITY_ID_PATTERN + ") else 'none' }}",
        )
    elif stray_svc:
        pass
    if stray_svc:
        rep.fail(
            "templated service name outside the one script allowed to have it",
            "; ".join(stray_svc),
            "A service name that does not resolve raises ServiceNotFound, which "
            "continue_on_error re-raises - and inside a repeat that ends the "
            "whole fan-out, so one stale phone drops the alarm push to every "
            "recipient after it. Move the call into "
            "script.%s and fire it with script.turn_on."
            % ISOLATED_SERVICE_SCRIPT,
        )
    if blocking:
        rep.fail(
            "script.%s called blocking" % ISOLATED_SERVICE_SCRIPT,
            "; ".join(blocking),
            "That script exists to keep a ServiceNotFound off the caller's "
            "sequence. A blocking `action:` call hands the callee's exception "
            "straight back, so this undoes the whole point of it. Use "
            "script.turn_on.",
        )
    if not (bad_ids or stray_svc or blocking):
        rep.ok(
            "every templated entity_id falls back to a valid id, and the one "
            "templated service name is isolated behind script.turn_on"
        )


# --------------------------------------------------------------------------
# 6c. References resolve against what Home Assistant DERIVES, not only against
#     what this tree declares.
#
# This is the generalisation of the bug the forty-first pass shipped and the
# commit after it fixed: sensor.guardian_version read the automations version
# from "automation.guardian_automations_version_marker", an entity that cannot
# exist, because an automation's entity_id is slugified from its ALIAS while a
# script's comes from its YAML key. It returned "missing" on every install for a
# whole release and no static check could see it, because preflight read the
# FILES and the fault was in how a template reads the RUNNING SYSTEM.
#
# So: resolve every guardian_* entity reference against the id Home Assistant
# would MINT. Template entities are slugified from `name:`. ESPHome entities are
# the device's friendly_name plus the entity name, both slugified. Preflight has
# done this for script.guardian_* since the thirty-eighth pass and for nothing
# else.
#
# ONE HONEST LIMIT, the same one the marker carries: an entity_id is sticky. The
# registry keys on unique_id and keeps whatever id was minted on first load, so
# renaming `name:` on an existing install does not move the entity. What this
# check describes is what a FRESH install gets - which is the install a stranger
# has, and the one nobody here can test.
# --------------------------------------------------------------------------
PORTAL_PREFIX = "guardian_interior_portal_"
DOORBELL_SUFFIX = "smart_doorbell"


def _slug(text):
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", str(text).lower())).strip("_")


def _esphome_entity_names(repo, rel):
    """(device slug, {entity name slugs}) for one ESPHome device file."""
    path = os.path.join(repo, rel)
    if not os.path.isfile(path):
        return None, set()
    try:
        data = yaml.load(read(path), Loader=_ha_loader())
    except Exception:
        return None, set()
    dev = _slug((data.get("esphome") or {}).get("friendly_name") or "")
    names = set()

    # Every `name:` under a component section, at any depth. Not just siblings
    # of `platform:` - wifi_info nests one level deeper (ip_address: name: ...)
    # and its entities are exactly the ones packages/guardian.yaml resolves by
    # suffix, so a shallower walk reported them as missing.
    def walk(node):
        if isinstance(node, dict):
            if isinstance(node.get("name"), str):
                names.add(_slug(node["name"]))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    for key, section in data.items():
        if key in ("esphome", "wifi", "api", "ota", "logger", "substitutions"):
            continue
        walk(section)
    return dev, names


def check_derived_entities(repo, rep):
    declared = set()
    for rel in ("packages/guardian.yaml", "packages/guardian_rfid.yaml"):
        path = os.path.join(repo, rel)
        if not os.path.isfile(path):
            continue
        try:
            data = yaml.load(read(path), Loader=_ha_loader())
        except Exception:
            return
        for block in (data.get("template") or []):
            if not isinstance(block, dict):
                continue
            for domain in ("sensor", "binary_sensor"):
                for ent in (block.get(domain) or []):
                    if isinstance(ent, dict) and ent.get("name"):
                        declared.add("%s.%s" % (domain, _slug(ent["name"])))
        # command_line: mints entities the same way - from `name:` - and two of
        # the lamp subsystem's sensors live there rather than under template:.
        for block in (data.get("command_line") or []):
            if not isinstance(block, dict):
                continue
            for domain in ("sensor", "binary_sensor"):
                ent = block.get(domain)
                if isinstance(ent, dict) and ent.get("name"):
                    declared.add("%s.%s" % (domain, _slug(ent["name"])))

    portal_dev, portal_names = _esphome_entity_names(repo, "esphome/portal-unit.yaml")
    bell_dev, bell_names = _esphome_entity_names(repo, "esphome/doorbell-unit.yaml")

    problems = []
    if portal_dev and portal_dev + "_" != PORTAL_PREFIX:
        problems.append(
            "esphome/portal-unit.yaml friendly_name slugifies to '%s', but the "
            "Home Assistant tree hardcodes '%s'" % (portal_dev, PORTAL_PREFIX)
        )
    if bell_dev and not bell_dev.endswith(DOORBELL_SUFFIX):
        problems.append(
            "esphome/doorbell-unit.yaml friendly_name slugifies to '%s', which "
            "does not end in '%s' - every doorbell lookup in "
            "packages/guardian.yaml matches on that suffix" % (bell_dev, DOORBELL_SUFFIX)
        )

    # Every hardcoded portal entity must be an entity this firmware declares.
    text = "\n".join(
        read(os.path.join(repo, r))
        for r in ("automations.yaml", "scripts.yaml", "packages/guardian.yaml")
        if os.path.isfile(os.path.join(repo, r))
    )
    if portal_names:
        for ref in sorted(set(re.findall(
                r"\b[a-z_]+\.%s([a-z0-9_]+)" % PORTAL_PREFIX, text))):
            if ref not in portal_names:
                problems.append(
                    "portal entity '%s%s' is referenced but esphome/portal-unit.yaml "
                    "declares no entity named '%s'" % (PORTAL_PREFIX, ref, ref)
                )
    # Every doorbell suffix match must name an entity this firmware declares.
    if bell_names:
        for ref in sorted(set(re.findall(
                r"endswith\('%s_([a-z0-9_]+)'\)" % DOORBELL_SUFFIX, text))):
            if ref not in bell_names:
                problems.append(
                    "packages/guardian.yaml resolves the doorbell by the suffix "
                    "'%s_%s', but esphome/doorbell-unit.yaml declares no entity "
                    "named '%s'" % (DOORBELL_SUFFIX, ref, ref)
                )
    # Every guardian_* template sensor referenced must be one the packages mint.
    esph_ok = re.compile(r"^(?:%s|.*%s_)" % (PORTAL_PREFIX, DOORBELL_SUFFIX))
    for ref in sorted(set(re.findall(r"\b((?:binary_)?sensor\.guardian_[a-z0-9_]+)", text))):
        obj = ref.split(".", 1)[1]
        if ref in declared or esph_ok.match(obj):
            continue
        problems.append(
            "'%s' is referenced but no template entity in packages/ is named "
            "so - Home Assistant slugifies the `name:`, not the unique_id" % ref
        )

    if problems:
        rep.fail(
            "an entity reference does not resolve to an id Home Assistant would mint",
            "; ".join(problems),
            "Fix the reference, or the `name:` / `friendly_name:` it is derived "
            "from. This is the class the version-marker bug belonged to: the "
            "file was right and the id it named could never exist.",
        )
    else:
        rep.ok(
            "every guardian_* template and ESPHome entity reference resolves to "
            "an id Home Assistant would derive"
        )


def check_no_external_urls(repo, rep):
    root = os.path.join(repo, "www", "guardian-ui")
    if not os.path.isdir(root):
        return
    hits = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith((".html", ".js", ".css")):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, repo).replace(os.sep, "/")
            for lineno, line in enumerate(read(path).splitlines(), 1):
                for url in re.findall(r"https?://[^\s\"'<>)]+", line):
                    if not ALLOWED_URL.match(url):
                        hits.append((rel, lineno, url))
    if hits:
        rep.fail(
            "external URL in the web-served tree",
            "; ".join("%s:%d %s" % h for h in hits),
            "/config/www is served as /local with NO authentication. Anything "
            "here is fetchable by every device on the LAN and every tailnet peer, "
            "and an external reference makes that page call off-box. Inline it or "
            "drop it.",
        )
    else:
        rep.ok("no external URLs under www/guardian-ui/")


# --------------------------------------------------------------------------
# 7. esphome/secrets.yaml is real.
#
# Only reports whether a value is still a template. Never prints a secret.
# --------------------------------------------------------------------------
REQUIRED_SECRETS = [
    "wifi_ssid", "wifi_password",
    "portal_unit__encryption_key", "portal_unit__ota_password",
    "portal_unit__ap_ssid", "portal_unit__ap_password",
    "doorbell_unit__encryption_key", "doorbell_unit__ota_password",
    "doorbell_unit__fallback_password", "doorbell_unit__ip",
    "portal_unit__ip", "portal_unit__gateway",
    "portal_unit__subnet", "portal_unit__dns",
    "guardian_rfid_mac_key",
]


def check_esphome_secrets(repo, rep):
    path = os.path.join(repo, "esphome", "secrets.yaml")
    if not os.path.isfile(path):
        rep.warn(
            "esphome/secrets.yaml",
            "Not present. The two devices cannot be built without it.",
            "Run: python tools/guardian-gen-secrets.py  "
            "(Not needed if you are only installing the Home Assistant half.)",
        )
        return
    if yaml is None:
        return
    try:
        data = yaml.load(read(path), Loader=_ha_loader())
    except yaml.YAMLError as err:
        rep.fail("esphome/secrets.yaml", "Does not parse: %s" % err, "Fix the syntax.")
        return
    if not isinstance(data, dict):
        rep.fail("esphome/secrets.yaml", "Is not a mapping.", "See secrets.yaml.example.")
        return

    missing = [k for k in REQUIRED_SECRETS if k not in data]
    if missing:
        rep.fail(
            "esphome/secrets.yaml",
            "Missing key(s): %s." % ", ".join(missing),
            "No key is optional; a missing one is an ESPHome build failure.",
        )

    placeholders = [
        k for k, v in data.items()
        if isinstance(v, str) and "PLACEHOLDER" in v.upper()
    ]
    if placeholders:
        rep.fail(
            "esphome/secrets.yaml",
            "Still holds template value(s) for: %s." % ", ".join(sorted(placeholders)),
            "Replace them. python tools/guardian-gen-secrets.py --force regenerates "
            "everything except your Wi-Fi and addresses.",
        )

    key = str(data.get("guardian_rfid_mac_key", ""))
    if key and "PLACEHOLDER" not in key.upper():
        if not re.fullmatch(r"[0-9a-fA-F]{64}", key):
            rep.fail(
                "esphome/secrets.yaml: guardian_rfid_mac_key",
                "Is not 64 hex characters (length %d)." % len(key),
                'python -c "import secrets; print(secrets.token_hex(32))"',
            )
        elif len(set(key.lower())) == 1:
            rep.fail(
                "esphome/secrets.yaml: guardian_rfid_mac_key",
                "Is a single repeated character - it was copied from the template.",
                "Every card credential derives from this key: the NTAG21x password "
                "and the MIFARE Classic sector keys. Generate a real one with "
                "tools/guardian-gen-secrets.py. Note that rotating it later locks "
                "already-upgraded Classic cards out.",
            )

    pk = str(data.get("portal_unit__encryption_key", ""))
    dk = str(data.get("doorbell_unit__encryption_key", ""))
    if pk and pk == dk:
        rep.warn(
            "esphome/secrets.yaml",
            "Both devices share one API encryption key.",
            "Give them separate keys so one leaked key does not read the other "
            "device's API traffic.",
        )

    if not any(f[0].startswith("esphome/secrets.yaml") for f in rep.failures):
        rep.ok("esphome/secrets.yaml has all %d keys, none templated"
               % len(REQUIRED_SECRETS))


# --------------------------------------------------------------------------
# 8. Deployed tree (only when --config-dir points at a real /config).
# --------------------------------------------------------------------------
DEPLOYED = [
    "configuration.yaml", "automations.yaml", "scripts.yaml", "scenes.yaml",
    "packages/guardian.yaml", "packages/guardian_rfid.yaml",
    "www/guardian-ui/guardian-panel.js", "www/guardian-ui/set-default-panel.js",
    "guardian/guardian-luminance.py",
]


def check_deployed(config_dir, rep, repo_root):
    missing = [p for p in DEPLOYED if not os.path.isfile(os.path.join(config_dir, p))]
    if missing:
        rep.fail(
            config_dir,
            "Not copied: %s." % ", ".join(missing),
            "Run tools/guardian-install.sh --apply, or copy them by hand per "
            "INSTALL.md §3.",
        )
    else:
        rep.ok("all %d runtime files present in %s" % (len(DEPLOYED), config_dir))

    # THE ONE THAT ACTUALLY BITES, EVERY RELEASE. Presence is not agreement:
    # every file can be there and one of them can be last release's copy. The
    # panel is the usual culprit, because its CONTENTS often do not change in a
    # release - only its version literal does - so it looks unchanged to somebody
    # copying "what changed", and a browser that has cached it is invisible from
    # the server side. The symptom is More -> Diagnostics reporting a mismatch
    # for a household that believes it copied everything.
    #
    # Same scan as check_versions, pointed at the deployed tree instead of the
    # repo, so it names the file rather than leaving it to be found in the UI.
    if not missing:
        found = _scan_versions(config_dir)
        distinct = sorted(set(found.values()))
        if len(distinct) > 1:
            newest = max(distinct)
            behind = sorted(k for k, v in found.items() if v != newest)
            panel_behind = any("guardian-panel.js" in k for k in behind)
            # SPLIT BY WHAT THE FILE ACTUALLY NEEDS, because "copy it again" is
            # WRONG for configuration.yaml and following it destroys a
            # household's own Home Assistant configuration.
            #
            # This check named every stale entry in one sentence and prescribed
            # one cure for all of them. configuration.yaml is never copied by
            # anything - guardian-install.sh deliberately does not overwrite it
            # and only rewrites the digits inside its ?v= - so the one file that
            # goes stale on EVERY upgrade was also the one whose printed remedy
            # would have overwritten a household's http:, recorder: and
            # panel_custom config with the repository's.
            #
            # Fourth recurrence of "Diagnostics prescribes a remedy that cannot
            # work", and the first outside the panel: the fortieth, forty-second
            # and forty-fourth passes each fixed one in guardian-panel.js while
            # this one sat in the checker that is supposed to catch them.
            config_behind = sorted(k for k in behind if k.startswith("configuration.yaml"))
            copy_behind = sorted(k for k in behind if not k.startswith("configuration.yaml"))
            remedy = []
            if copy_behind:
                remedy.append(
                    "Copy %s again from the same commit, then restart Home "
                    "Assistant fully." % ", ".join(copy_behind))
            if config_behind:
                remedy.append(
                    "DO NOT COPY configuration.yaml - it is yours, not "
                    "Guardian's, and overwriting it replaces your http:, "
                    "recorder: and panel_custom settings. Its ?v= is only a "
                    "cache-buster: run tools/guardian-install.sh --apply, which "
                    "rewrites just those digits after taking a backup, or edit "
                    "the two guardian-ui/*.js?v= values by hand. Then restart "
                    "fully.")
            if panel_behind:
                remedy.append(
                    "THEN HARD-REFRESH THE BROWSER (Ctrl-Shift-R). The panel is "
                    "one of the stale files, and a Home Assistant restart does "
                    "not clear a module the browser is already holding - this is "
                    "the step people skip and then report the banner as a false "
                    "alarm.")
            rep.fail(
                "deployed files are from different versions",
                "Found %s." % ", ".join("%s=%s" % (k, v) for k, v in sorted(found.items())),
                "  ".join(remedy),
            )
        elif distinct:
            rep.ok("every deployed file reports %s" % distinct[0])

        # TWO OF THE NINE DEPLOYED FILES CARRY NO VERSION LITERAL AT ALL, so the
        # scan above is structurally blind to them: a stale
        # www/guardian-ui/set-default-panel.js or guardian/guardian-luminance.py
        # reports nothing, forever. The second is 747 lines that decide what the
        # door lamp measures and therefore when it comes on, and a copy from two
        # releases ago would have been reported by nothing anywhere.
        #
        # Byte comparison, which is stronger than a version literal anyway: it
        # also catches the case a literal cannot see, where a file is edited
        # twice inside one release and the household copied the first edit. Only
        # the files Guardian owns outright - the three Home Assistant's own UI
        # editors write to are excluded here for the same reason
        # guardian-install.sh will not overwrite them without an opt-in, and
        # configuration.yaml is excluded because it is the household's.
        project_owned = [
            "packages/guardian.yaml", "packages/guardian_rfid.yaml",
            "www/guardian-ui/guardian-panel.js",
            "www/guardian-ui/set-default-panel.js",
            "guardian/guardian-luminance.py",
        ]
        drifted = []
        for rel in project_owned:
            here = os.path.join(repo_root, rel)
            there = os.path.join(config_dir, rel)
            if not (os.path.isfile(here) and os.path.isfile(there)):
                continue
            # Normalise line endings before comparing. A checkout on Windows can
            # legitimately hold CRLF where the Pi holds LF, and reporting that as
            # a stale deploy would be a false alarm every single run - which is
            # the fastest way to teach somebody to ignore this check.
            def body(path):
                with open(path, "rb") as handle:
                    return handle.read().replace(b"\r\n", b"\n")
            if body(here) != body(there):
                drifted.append(rel)
        if drifted:
            rep.fail(
                "a deployed file differs from the repository",
                "%s differ%s from this tree." % (", ".join(drifted),
                                                 "" if len(drifted) > 1 else "s"),
                "Copy %s into %s and restart Home Assistant fully. Two of these "
                "files carry no version literal, so nothing else in Guardian can "
                "tell you they are stale." % (", ".join(drifted), config_dir),
            )
        else:
            rep.ok("all %d Guardian-owned files in %s are byte-identical to this "
                   "tree" % (len(project_owned), config_dir))

    # preview.html is a design harness with no auth in front of it.
    stray = os.path.join(config_dir, "www", "guardian-ui", "preview.html")
    if os.path.isfile(stray):
        rep.warn(
            "%s" % stray.replace(os.sep, "/"),
            "The design harness is deployed. It is not part of the running system "
            "and /config/www has no authentication in front of it.",
            "Delete it. tools/guardian-install.sh never copies it.",
        )


# ---------------------------------------------------------------------------
# The forty-third pass's checks. Each one exists because a real defect in this
# repo passed every check above it.
# ---------------------------------------------------------------------------

# `states(x)` VALIDATES x and raises TemplateError when it is not a well-formed
# entity id - and TemplateError is one of the exceptions _ScriptRun re-raises
# whatever continue_on_error says. Worse, a raising template inside a
# `variables:` block cannot be guarded at all: continue_on_error applies to a
# step's ACTION, not to rendering its arguments, so the script simply ends.
#
# check_unguardable_arguments above only inspects `entity_id` keys and the
# action/service name. It cannot see this, because the dangerous thing is an
# argument INSIDE a template. guardian_reconcile_presence computed
# `current: {{ states(entity) }}` in the same variables map as the `slot_ok`
# that validates it, so the guard ran after the thing it guarded, and an empty
# slot rendered `input_select.rfid_` - a trailing underscore, which Home
# Assistant's own valid_entity_id rejects.
def check_states_arguments(repo, rep):
    """No entry of a `variables:` map may consume a SIBLING of the same map.

    Two independent reasons, and the second is the one that bites.

    Ordering. Home Assistant renders a variables mapping as a unit and does not
    guarantee that one entry sees another's value; the tree already knows this
    and says so at the second variables map in guardian_sample_ambient_light
    ("script variable maps are not all guaranteed to be ordered"). A sibling
    reference therefore reads either the intended value or nothing.

    Unguardability. When the consumer is states(), reading "nothing" is not a
    quiet wrong answer. states() VALIDATES its argument and raises TemplateError
    on anything that is not a well-formed entity id - and TemplateError is one
    of the exceptions _ScriptRun re-raises regardless of continue_on_error.
    Inside a `variables:` block there is nothing to put continue_on_error ON:
    the failure is in rendering the argument, not in running a step. The script
    simply ends, and if it was called blocking the caller loses its whole flow.

    That is exactly how guardian_reconcile_presence was written. `slot_ok`, the
    validator, sat in the same mapping as `current: {{ states(entity) }}` and
    `expected:`, which built `input_select.rfid_' ~ slot ~ '_policy'`. So the
    guard ran after - or instead of - the things it guarded, and an empty slot
    rendered `input_select.rfid_` and `input_select.rfid__policy`: a trailing
    underscore and a double underscore, both rejected by Home Assistant's own
    valid_entity_id.

    check_unguardable_arguments cannot see any of this. It inspects `entity_id`
    keys and the action/service name; here the dangerous thing is an argument
    inside a template, in a step that has no service call at all.
    """
    findings = []
    consumers = re.compile(r"\b(?:states|state_attr|is_state|is_state_attr)\s*\(\s*([a-z_][a-z0-9_]*)\b", re.I)

    for rel in ("automations.yaml", "scripts.yaml", "packages/guardian.yaml"):
        path = os.path.join(repo, rel)
        if not os.path.exists(path):
            continue
        try:
            docs = yaml.load(read(path), Loader=_ha_loader())
        except Exception:
            continue

        def walk(node, alias=None):
            if isinstance(node, dict):
                alias = node.get("alias", alias)
                vs = node.get("variables")
                if isinstance(vs, dict):
                    names = set(vs.keys())
                    for key, val in vs.items():
                        if not isinstance(val, str):
                            continue
                        for m in consumers.finditer(val):
                            ref = m.group(1)
                            # Referring to itself is impossible; referring to a
                            # sibling is the hazard.
                            if ref in names and ref != key:
                                findings.append((rel, alias or "?", key, ref))
                            # Concatenation onto a sibling renders an id like
                            # `input_select.rfid_` when that sibling is empty.
                        for m in re.finditer(
                            r"\b(?:states|state_attr|is_state)\s*\(\s*['\"][a-z_]+\.[a-z_]*['\"]\s*~\s*\(?\s*([a-z_][a-z0-9_]*)",
                            val, re.I,
                        ):
                            ref = m.group(1)
                            if ref in names and ref != key:
                                findings.append((rel, alias or "?", key, ref))
                for v in node.values():
                    walk(v, alias)
            elif isinstance(node, list):
                for v in node:
                    walk(v, alias)

        walk(docs)

    findings = sorted(set(findings))
    if findings:
        rep.fail(
            "a variables: entry consumes a sibling of the same map",
            "%d site(s) read one variable from inside another in the SAME "
            "`variables:` mapping:\n        %s"
            % (
                len(findings),
                "\n        ".join(
                    "%s  %s:  %s  reads  %s" % f for f in findings[:10]
                ),
            ),
            "Home Assistant does not guarantee ordering within one variables "
            "mapping, and states() raises TemplateError on a malformed id - "
            "which continue_on_error CANNOT catch inside a variables block, "
            "because there is no action to guard. Split them into two steps and "
            "put the validator, with its condition, in the earlier one.",
        )
    else:
        rep.ok("no variables: entry reads a sibling of its own map")


def check_bounded_actuator_loops(repo, rep):
    """A `repeat: while` that presses a siren must have a bound."""
    unbounded = []
    for rel in ("automations.yaml", "scripts.yaml"):
        path = os.path.join(repo, rel)
        if not os.path.exists(path):
            continue
        try:
            docs = yaml.load(read(path), Loader=_ha_loader())
        except Exception:
            continue

        def walk(node, alias=None):
            if isinstance(node, dict):
                alias = node.get("alias", alias)
                rep_node = node.get("repeat")
                if isinstance(rep_node, dict) and "while" in rep_node:
                    body = yaml.safe_dump(rep_node.get("sequence") or [])
                    drives = "button.press" in body or "dfplayer" in body
                    conds = rep_node.get("while") or []
                    bounded = any(
                        "repeat.index" in yaml.safe_dump(c) for c in conds
                    ) or "count" in rep_node
                    if drives and not bounded:
                        unbounded.append((rel, alias or "?"))
                for v in node.values():
                    walk(v, alias)
            elif isinstance(node, list):
                for v in node:
                    walk(v, alias)

        walk(docs)
    if unbounded:
        rep.fail(
            "an unbounded actuator loop",
            "%d `repeat: while` loop(s) press a physical actuator with no "
            "iteration bound:\n        %s"
            % (
                len(unbounded),
                "\n        ".join("%s  %s" % u for u in unbounded),
            ),
            "Add a second while-condition on repeat.index. A siren whose only "
            "exit is one helper value runs forever when nothing writes that "
            "helper - and script.guardian_set_display is `queued, max: 25`, so "
            "the write that would END the alarm can be DISCARDED SILENTLY.",
        )
    else:
        rep.ok("every actuator loop has an iteration bound as well as a state condition")


def check_reboot_timeouts(repo, rep):
    """Both devices must state reboot_timeout rather than inherit it."""
    missing = []
    for rel in ("esphome/portal-unit.yaml", "esphome/doorbell-unit.yaml"):
        path = os.path.join(repo, rel)
        if not os.path.exists(path):
            continue
        text = read(path)
        for block in ("wifi", "api"):
            m = re.search(r"(?m)^%s:\s*$" % block, text)
            if not m:
                continue
            nxt = re.search(r"(?m)^[a-z_]+:\s*$", text[m.end():])
            body = text[m.end(): m.end() + (nxt.start() if nxt else len(text))]
            if not re.search(r"^\s+reboot_timeout:", body, re.M):
                missing.append("%s  %s:" % (rel, block))
    if missing:
        rep.fail(
            "a reboot_timeout left to its default",
            "%d device block(s) do not state reboot_timeout:\n        %s"
            % (len(missing), "\n        ".join(missing)),
            "ESPHome defaults both to 15min. That silently reboots the portal a "
            "quarter of an hour into any outage, which wipes the RAM the offline "
            "siren's authority lives in - so the alarm would die inside exactly "
            "the outage it exists for. Write the value down, whichever value you "
            "choose.",
        )
    else:
        rep.ok("both devices state wifi and api reboot_timeout explicitly")


def check_installer_backups(repo, rep):
    """The installer must not cp onto a user-owned file without a backup."""
    path = os.path.join(repo, "tools", "guardian-install.sh")
    if not os.path.exists(path):
        return
    text = read(path)
    problems = []

    # The gate must actually NAME the files Home Assistant's UI editors own.
    # Testing that the function exists is not enough: an is_user_owned() that
    # matches nothing reads exactly like one that works, and the whole defect
    # this check exists for is a protection that looks present and is not.
    m = re.search(r"is_user_owned\s*\(\)\s*\{(.*?)\n\}", text, re.S)
    if not m:
        problems.append("no is_user_owned() gate is defined")
    else:
        body = m.group(1)
        for owned in ("automations.yaml", "scripts.yaml", "scenes.yaml"):
            if owned not in body:
                problems.append("is_user_owned() does not cover %s" % owned)

    # A backup must be TAKEN, not merely mentioned. Require the cp that writes
    # it, so a message naming the backup path cannot stand in for making one.
    if not re.search(r"cp\s+\"\$dst\"\s+\"\$dst\.guardian-backup-", text):
        problems.append("no timestamped backup is copied before an overwrite")
    if "--replace-my-automations" not in text:
        problems.append("no explicit opt-in flag for replacing user files")

    # The backup must be taken BEFORE the copy that overwrites.
    b = text.find('cp "$dst" "$dst.guardian-backup-')
    c = text.rfind('cp "$src" "$dst"')
    if b != -1 and c != -1 and b > c:
        problems.append("the backup is taken after the copy that overwrites")

    # THE ONE EDIT THIS SCRIPT MAKES TO A configuration.yaml IT DID NOT WRITE.
    #
    # The forty-fourth pass gave the installer permission to rewrite the ?v=
    # cache-buster in place, because leaving it stale made every upgrade report
    # a version mismatch on a correct install and the printed warning was not
    # enough - three releases proved that. Permission to edit a household's
    # configuration.yaml comes with three conditions, and this asserts all of
    # them, in order, because the danger is not the edit but an edit whose
    # safety net was removed later by someone tidying.
    if "CFG_VBUMPED" in text or "guardian-tmp-" in text:
        bak = text.find('cp "$CFG_DST" "$CFG_BAK"')
        edit = text.find('mv "$CFG_DST.guardian-tmp-$STAMP" "$CFG_DST"')
        if bak == -1:
            problems.append(
                "configuration.yaml is edited in place with no backup taken")
        elif edit != -1 and bak > edit:
            problems.append(
                "the configuration.yaml backup is taken after the edit lands")
        # The edit must be verified to have moved nothing but ?v= lines. sed is
        # being pointed at a household's Home Assistant configuration; it does
        # not get to be trusted without a receipt.
        if not re.search(r"STRAY=\$\(diff .*grep -cv", text, re.S):
            problems.append(
                "nothing verifies that the ?v= rewrite changed only ?v= lines")
        elif not re.search(r'\[ "\$\{STRAY:-1\}" -eq 0 \]', text):
            problems.append(
                "the stray-line count is computed but never acted on")

    if problems:
        rep.fail(
            "tools/guardian-install.sh can destroy a household's own work",
            "; ".join(problems),
            "automations.yaml, scripts.yaml and scenes.yaml are where Home "
            "Assistant's UI editors save everything a household has built. "
            "Overwriting one needs a timestamped backup first AND an explicit "
            "--replace-my-automations, or the first command a stranger runs "
            "silently destroys all of it.",
        )
    else:
        rep.ok("the installer backs up and gates every user-owned file it would overwrite")


def check_card_acceptance(repo, rep):
    """A card may not be accepted or enrolled without a protection decision."""
    path = os.path.join(repo, "esphome", "components", "guardian_rfid", "guardian_rfid.cpp")
    if not os.path.exists(path):
        return
    text = read(path)
    problems = []
    if re.search(r"\(void\)\s*ntag_pwd_ok", text):
        problems.append(
            "consume_payload_ discards ntag_pwd_ok, so an unprotected tag is "
            "accepted exactly like a password-protected one"
        )
    # The have_version_ short-circuit: protect_ntag_() must not sit behind
    # have_version_ in the same condition, or a failed GET_VERSION skips it.
    if re.search(r"have_version_\s*&&\s*!this->protect_ntag_\(\)", text):
        problems.append(
            "protect_ntag_() sits behind have_version_ in one condition, so a "
            "failed GET_VERSION skips the protection entirely and still reports "
            "\"enrolled\""
        )
    if re.search(r"consume_payload_\(pages,\s*rst == ST_OK,\s*true\)", text):
        problems.append(
            "the Classic path hardcodes ntag_pwd_ok=true, claiming a card still "
            "on the published transport key is protected"
        )
    for fn in ("derive_pwd_pack_", "derive_classic_keys_"):
        for m in re.finditer(r"this->%s\(([^;]*)\);" % fn, text):
            if m.group(1).count(",") + 1 < 3:
                problems.append(
                    "%s is called without checking whether the derivation "
                    "succeeded; on failure it memcpy's uninitialised stack into "
                    "a key" % fn
                )
    if problems:
        rep.fail(
            "the card reader can accept a card it cannot show is genuine",
            "\n        ".join(problems),
            "A Guardian card is a bearer token: its only protection is that the "
            "payload cannot be read. Every path that reports \"ok\" or "
            "\"enrolled\" must have made an explicit decision about whether this "
            "card was actually behind a secret.",
        )
    else:
        rep.ok("no card is accepted or enrolled without an explicit protection decision")


# --------------------------------------------------------------------------
# 16. Diagnostics may not prescribe a cure for a cause it has not established.
#
# THIS IS THE THIRD TIME. The fortieth pass found Diagnostics naming a remedy
# that could not work; the forty-second fixed restart-versus-cache-clear and
# introduced this variant in the same breath, by treating a two-directional
# comparison as one-directional; and the household found the result on every
# screen in the house the day 2.27.0 shipped - a banner telling them to clear a
# cache that held nothing stale, for a fault whose only cure was the edit the
# banner told them not to make.
#
# So this check is not "does the panel mention both directions". A check that
# tests for VOCABULARY passes on a neutered guard - the last pass's first
# installer check did exactly that and its own fault injection walked straight
# past it. This one EXECUTES the classifier and reads what it returns.
#
# classifyPanelVersion is deliberately self-contained in guardian-panel.js: no
# imports, no closure, its whole vocabulary in one object literal. That is what
# makes it sliceable and runnable here. If a future edit gives it a dependency
# on the rest of the panel, the slice stops evaluating and this check fails
# loudly rather than quietly weakening, which is the correct direction to fail.
#
# node is not a Guardian dependency and a household installing this must not
# need one, so its absence degrades to a warning plus the structural
# assertions. Every machine that runs the self-test has it.
# --------------------------------------------------------------------------
PANEL_VERSION_CASES = [
    # requested,  ui,        expected state
    ("2.26.0", "2.27.0", "config_behind"),    # the live bug: file new, url old
    ("2.27.0", "2.26.0", "browser_behind"),   # browser holds an old copy
    ("2.27.0", "2.27.0", "match"),
    ("", "2.27.0", "unknown"),                # no ?v= at all - say nothing
    # A string compare gets this one backwards ('9' > '1'), and getting it
    # backwards means printing the other direction's cure, which IS the bug.
    ("2.9.0", "2.10.0", "config_behind"),
]


def _blank_js_comments_and_strings(text):
    """`text` with comment and string bodies replaced by spaces, length intact.

    Offsets are preserved so a match found here indexes straight back into the
    original file. Without this the structural scan below matches its own
    documentation: the comment above classifyPanelVersion quotes the bare
    `requested !== ui` it exists to forbid, and CSS inside the panel's template
    literals is full of /* */ that is not JavaScript comment at all.

    Deliberately not a JavaScript parser. It tracks the four things that can
    swallow a `!==` - line comment, block comment, quoted string, template
    literal - and nothing else. Regex literals are not tracked, which can only
    make it blank too little, never too much, so it errs towards reporting.
    """
    out = list(text)
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            while i < n and text[i] != "\n":
                out[i] = " "
                i += 1
        elif c == "/" and nxt == "*":
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                if text[i] != "\n":
                    out[i] = " "
                i += 1
            for _ in range(2):
                if i < n:
                    out[i] = " "
                    i += 1
        elif c in "\"'`":
            quote = c
            i += 1
            while i < n:
                if text[i] == "\\":
                    out[i] = " "
                    if i + 1 < n:
                        out[i + 1] = " "
                    i += 2
                    continue
                if text[i] == quote:
                    i += 1
                    break
                if text[i] != "\n":
                    out[i] = " "
                i += 1
        else:
            i += 1
    return "".join(out)


def _slice_classifier(text):
    """The body of classifyPanelVersion, by brace matching. None if absent."""
    start = text.find("function classifyPanelVersion(")
    if start < 0:
        return None
    depth = 0
    i = text.find("{", start)
    if i < 0:
        return None
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return None


def check_panel_version_directions(repo, rep):
    path = os.path.join(repo, "www", "guardian-ui", "guardian-panel.js")
    if not os.path.isfile(path):
        return
    text = read(path)

    body = _slice_classifier(text)
    if body is None:
        rep.fail(
            "www/guardian-ui/guardian-panel.js",
            "classifyPanelVersion() is missing.",
            "The panel/configuration.yaml version comparison must go through one "
            "named classifier, so that which DIRECTION the two numbers disagree "
            "in decides the remedy. A bare inequality has one branch for two "
            "causes with opposite cures.",
        )
        return

    # The structural half, which holds with or without node: nothing may compare
    # the two versions outside the classifier. Scanned against a copy with
    # comments and string bodies blanked, so the check does not trip over its
    # own documentation - the comment above classifyPanelVersion quotes the very
    # inequality it forbids, which is exactly the prose a future reader needs.
    code = _blank_js_comments_and_strings(text)
    span = (text.find("function classifyPanelVersion("), 0)
    span = (span[0], span[0] + len(body))
    for m in re.finditer(r"requested\s*(?:!==|!=|===|==)\s*ui\b", code):
        if not (span[0] <= m.start() < span[1]):
            rep.fail(
                "www/guardian-ui/guardian-panel.js",
                "line %d: a bare `%s` compares the requested and running panel "
                "versions outside classifyPanelVersion()."
                % (text.count("\n", 0, m.start()) + 1, m.group(0).strip()),
                "That is the shape of the bug: one branch for two directions "
                "with opposite cures. Route it through classifyPanelVersion().",
            )
            return

    node = shutil.which("node")
    if not node:
        rep.warn(
            "www/guardian-ui/guardian-panel.js",
            "node was not found, so classifyPanelVersion() was checked for shape "
            "but never RUN.",
            "Install node to have this checked by behaviour. Nothing else in "
            "Guardian needs it.",
        )
        return

    harness = body + """
const out = %s.map(([r, u]) => {
  const v = classifyPanelVersion(r, u);
  return { state: v.state, remedy: String(v.remedy || ''), cause: String(v.cause || '') };
});
console.log(JSON.stringify(out));
""" % json.dumps([[r, u] for r, u, _ in PANEL_VERSION_CASES])

    tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".mjs", delete=False, encoding="utf-8")
    try:
        tmp.write(harness)
        tmp.close()
        proc = subprocess.run(
            [node, tmp.name], capture_output=True, text=True, timeout=60)
    except Exception as exc:  # noqa: BLE001 - reported, not swallowed
        rep.fail(
            "www/guardian-ui/guardian-panel.js",
            "classifyPanelVersion() could not be evaluated: %s" % exc,
            "It must stay self-contained - no imports and no closure over the "
            "rest of the panel - so this check can run it.",
        )
        return
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    if proc.returncode != 0:
        rep.fail(
            "www/guardian-ui/guardian-panel.js",
            "classifyPanelVersion() did not evaluate: %s"
            % (proc.stderr.strip().splitlines() or ["no output"])[-1],
            "It must stay self-contained - no imports and no closure over the "
            "rest of the panel - so this check can run it.",
        )
        return

    try:
        got = json.loads(proc.stdout)
    except ValueError:
        rep.fail(
            "www/guardian-ui/guardian-panel.js",
            "classifyPanelVersion() returned nothing this check could read.",
            "It must return an object with `state`, `cause` and `remedy`.",
        )
        return

    problems = []
    by_state = {}
    for (requested, ui, want), res in zip(PANEL_VERSION_CASES, got):
        by_state[res["state"]] = res
        if res["state"] != want:
            problems.append(
                "requested=%r running=%r classified as %r, expected %r"
                % (requested or "(none)", ui, res["state"], want))

    behind = by_state.get("browser_behind")
    config = by_state.get("config_behind")

    # THE BEHAVIOUR THIS CHECK EXISTS FOR. Two opposite causes must not be
    # answered with one cure. Collapsing the classifier back to a plain
    # inequality reproduces the live bug and trips this, which is why the
    # fault injection breaks the behaviour rather than deleting a keyword.
    if behind and config:
        if behind["remedy"] == config["remedy"]:
            problems.append(
                "both directions prescribe the SAME remedy - that is the bug "
                "itself, one branch serving two opposite causes")
        for res in (behind, config):
            if not res["remedy"].strip():
                problems.append(
                    "%s names no remedy, but its cause IS established"
                    % res["state"])
        # And neither may name the other's cure.
        if re.search(r"clear(ing)?\b[^.]{0,40}\bcache", config["remedy"], re.I) \
                and "cannot fix this" not in config["remedy"]:
            problems.append(
                "the config_behind remedy tells the household to clear the "
                "browser cache, which cannot fix a stale ?v= in "
                "configuration.yaml - this is the live 2.27.0 bug")
        if re.search(r"edit\b[^.]{0,40}configuration\.yaml", behind["remedy"], re.I):
            problems.append(
                "the browser_behind remedy tells the household to edit "
                "configuration.yaml, which cannot fix a cached browser copy")

    # The state that means "I cannot tell" must prescribe nothing at all. This
    # is the rule that generalises the whole class: no cure without a cause.
    unknown = by_state.get("unknown")
    if unknown and unknown["remedy"].strip():
        problems.append(
            "the `unknown` state names a remedy. Diagnostics may describe what "
            "it sees whenever it likes; it may only PRESCRIBE against a cause "
            "it has established")

    if problems:
        rep.fail(
            "Diagnostics prescribes a remedy that cannot work",
            "\n        ".join(problems),
            "This has now happened three times. The panel/configuration.yaml "
            "version comparison has two directions with opposite cures: an old "
            "file in the browser (clear the cache) and a stale ?v= in "
            "configuration.yaml (edit it and restart - the cache holds nothing "
            "stale). Each state carries its own remedy, and the state that "
            "cannot name a cause carries none.",
        )
    else:
        rep.ok(
            "the panel version banner branches on direction, and no state "
            "prescribes a cure for a cause it has not established (%d cases "
            "executed under node)" % len(PANEL_VERSION_CASES))


# --------------------------------------------------------------------------
# 17. The panel may not offer, or describe, a choice the backend does not have.
#
# On this house, pressing "Off" on a person's notification level produced a raw
# Home Assistant error dialog - "Invalid option: Off (possible options:
# Important, Everything, Urgent only)" - because the panel drew its four levels
# from a constant in its own file while the deployed input_select had three.
#
# Nothing detected it. Every half reported the same version, because VERSION
# AGREEMENT IS NOT ENTITY AGREEMENT: the check compares the version literals in
# five files and says nothing about whether the entities those files declare
# have the shape the panel drives. A household got an error dialog from Home
# Assistant itself, which is the failure mode this project exists to prevent.
#
# Two couplings are asserted here, and they are different in kind.
#
#   OPTIONS   Every level the panel offers must be declared by every
#             rfid_N_notify_level helper. This is the one that produced the
#             error dialog.
#
#   FLOORS    The panel's LEVEL_FLOOR must equal the `floors` map inside
#             guardian_notify_person. The panel now tells each person what a
#             level will actually deliver, per category, and it can only do
#             that by transcribing the backend's own severity floors. A
#             transcription that drifts does not throw - it produces a screen
#             that describes someone's alerting confidently and wrongly, which
#             is worse than the error dialog it replaced.
# --------------------------------------------------------------------------
def check_notify_level_contract(repo, rep):
    panel = os.path.join(repo, "www", "guardian-ui", "guardian-panel.js")
    pkg = os.path.join(repo, "packages", "guardian_rfid.yaml")
    scripts = os.path.join(repo, "scripts.yaml")
    if not (os.path.isfile(panel) and os.path.isfile(pkg) and os.path.isfile(scripts)):
        return
    ptext = read(panel)
    problems = []

    m = re.search(r"const NOTIFY_LEVELS = \[(.*?)\n\];", ptext, re.S)
    if not m:
        rep.fail("www/guardian-ui/guardian-panel.js",
                 "NOTIFY_LEVELS is missing.",
                 "The panel's level list is half of a contract with "
                 "packages/guardian_rfid.yaml and guardian_notify_person.")
        return
    offered = re.findall(r"value:\s*'([^']+)'", m.group(1))

    # Every notify-level helper must declare every option the panel offers.
    ptxt = read(pkg)
    racks = re.findall(
        r"^  (rfid_\d+_notify_level):\s*$(.*?)(?=^  \w|\Z)", ptxt, re.S | re.M)
    if not racks:
        problems.append("no rfid_N_notify_level helpers found in "
                        "packages/guardian_rfid.yaml")
    for name, body in racks:
        declared = re.findall(r"^\s+- (.+)$", body, re.M)
        declared = [d.strip() for d in declared]
        for opt in offered:
            if opt not in declared:
                problems.append(
                    "the panel offers %r but %s does not declare it - pressing "
                    "it gives the household a Home Assistant error dialog"
                    % (opt, name))

    # The panel's transcription of the backend's severity floors.
    fm = re.search(r"const LEVEL_FLOOR = \{([^}]*)\}", ptext)
    bm = re.search(r"\{%\s*set floors = \{(.*?)\}\s*%\}", read(scripts), re.S)
    if not fm:
        problems.append("LEVEL_FLOOR is missing from the panel")
    elif not bm:
        problems.append("the floors map could not be found in scripts.yaml")
    else:
        def pairs(text):
            return {
                k.strip().strip("'\""): int(v)
                for k, v in re.findall(r"'?([\w ]+)'?\s*:\s*(\d+)", text)
            }
        pf, bf = pairs(fm.group(1)), pairs(bm.group(1))
        if pf != bf:
            problems.append(
                "the panel's LEVEL_FLOOR %r does not match the backend's floors "
                "%r, so the screen describes each person's alerting wrongly"
                % (pf, bf))

    if problems:
        rep.fail(
            "the panel offers or describes a notification choice the backend "
            "does not have",
            "\n        ".join(problems),
            "The level control and the per-category text are drawn from the "
            "panel but enforced by guardian_notify_person and declared by "
            "packages/guardian_rfid.yaml. All three must agree, or the "
            "household is shown a button that errors or a description of their "
            "alerting that is not true.",
        )
    else:
        rep.ok(
            "every notification level the panel offers is declared by the "
            "backend, and its severity floors match guardian_notify_person")


def _declared_initials(repo):
    """entity_id -> the `initial:` a package declares for it, normalised.

    Only helpers that DECLARE one appear. That is the whole point: a helper with
    an initial: cannot carry a value across a restart, and a helper without one
    can.
    """
    out = {}
    for rel in ("packages/guardian.yaml", "packages/guardian_rfid.yaml"):
        path = os.path.join(repo, rel)
        if not os.path.isfile(path):
            continue
        try:
            doc = yaml.load(read(path), Loader=_ha_loader()) or {}
        except Exception:
            continue
        for domain in ("input_boolean", "input_number", "input_text",
                       "input_select", "counter"):
            for name, body in (doc.get(domain) or {}).items():
                if isinstance(body, dict) and "initial" in body:
                    value = body["initial"]
                    if value is True:
                        value = "on"
                    elif value is False:
                        value = "off"
                    out["%s.%s" % (domain, name)] = (str(value), rel)
    return out


def check_slot_ha_user_persist(repo, rep):
    """Picking a Home Assistant account on a key must actually persist.

    THE BUG THIS IS WRITTEN FOR. The panel picker called
    script.guardian_slot_write, callService resolved, and five seconds later a
    sheet said the account was not saved on this key. States showed
    input_text.rfid_1_ha_user_id still unknown. Notification-level tabs on the
    same script worked because they write option: into a helper that already
    had a real state.

    Three halves have to stay true together: the YAML helper has no initial:
    (that would unlink everyone on restart), the script takes a payload field
    so it cannot collide with input_text.set_value's value, and the ha_user_id
    branch stops with error: true when the helper does not match. The panel
    must send payload.
    """
    panel = os.path.join(repo, "www", "guardian-ui", "guardian-panel.js")
    scripts = os.path.join(repo, "scripts.yaml")
    pkg = os.path.join(repo, "packages", "guardian_rfid.yaml")
    if not (os.path.isfile(panel) and os.path.isfile(scripts) and os.path.isfile(pkg)):
        return
    problems = []

    initials = _declared_initials(repo)
    pkg_text = read(pkg)
    for i in range(1, 10):
        name = "rfid_%d_ha_user_id" % i
        if not re.search(r"^  %s:" % name, pkg_text, re.M):
            problems.append("%s is missing from packages/guardian_rfid.yaml" % name)
            continue
        eid = "input_text.%s" % name
        if eid in initials:
            problems.append(
                "%s declares initial: %r — a restart would unlink the key"
                % (eid, initials[eid][0]))

    stext = read(scripts)
    sm = re.search(
        r"^guardian_slot_write:\n(.*?)(?=^[a-zA-Z_][a-zA-Z0-9_]*:|\Z)",
        stext, re.M | re.S)
    if not sm:
        problems.append("script.guardian_slot_write is missing")
    else:
        block = sm.group(1)
        if not re.search(r"^    payload:", block, re.M):
            problems.append(
                "guardian_slot_write has no payload field — a field named "
                "value collides with input_text.set_value")
        if re.search(r"^    value:", block, re.M):
            problems.append(
                "guardian_slot_write still declares a value field, which "
                "collides with input_text.set_value")
        bm = re.search(
            r"which_op == 'ha_user_id'(.*?)(?:which_op == '|default:)",
            block, re.S)
        if not bm:
            problems.append("guardian_slot_write has no ha_user_id branch")
        else:
            branch = bm.group(1)
            if "error: true" not in branch:
                problems.append(
                    "ha_user_id branch does not stop with error: true when "
                    "the helper does not match")
            if "unknown" not in branch:
                problems.append(
                    "ha_user_id branch does not treat unknown as empty")

    ptext = read(panel)
    dm = re.search(r"function slotWriteData\([\s\S]*?\n\}", ptext)
    if not dm:
        problems.append("slotWriteData is missing from the panel")
    else:
        ret = dm.group(0)
        if not re.search(r"(?:,\s*payload\s*[,}]|\bpayload:)", ret):
            problems.append("slotWriteData does not send payload")
        if re.search(r"return \{[^}]*\bvalue:", ret):
            problems.append(
                "slotWriteData still sends value, which collides with "
                "input_text.set_value")
    if "persistHaUser:" not in ptext:
        problems.append(
            "the panel has no persistHaUser — the script write alone left "
            "rfid_N_ha_user_id unknown")
    if not re.search(r"ACTIONS\.persistHaUser\(", ptext):
        problems.append("setSlotUser never calls persistHaUser")

    if problems:
        rep.fail(
            "RFID Home Assistant account linking cannot persist",
            "\n        ".join(problems),
            "script.guardian_slot_write must take payload, seed unknown to "
            "empty, and stop with error: true when the helper does not match. "
            "rfid_N_ha_user_id must not declare initial:. The panel must send "
            "payload.",
        )
    else:
        rep.ok(
            "RFID HA account helpers have no initial:, guardian_slot_write "
            "takes payload and fail-closes ha_user_id, panel sends payload")


def check_notify_pref_persist(repo, rep):
    """Own-account notify level/mute must persist; other-account must lock.

    THE BUG THIS IS WRITTEN FOR. Tapping Important moved the tab, callService
    resolved, and five seconds later a sheet said the level was not saved on
    this key. The panel sent {slot, op, payload} and verified
    input_select.rfid_N_notify_level; a live scripts.yaml that still bound
    raw from value wrote nothing, _awaitState timed out, and there was no
    persistNotifyLevel equivalent of persistHaUser. House admins still saw
    tappable tabs on someone else's Notifications screen because canEditSlot
    is true for every is_admin login.
    """
    panel = os.path.join(repo, "www", "guardian-ui", "guardian-panel.js")
    scripts = os.path.join(repo, "scripts.yaml")
    pkg = os.path.join(repo, "packages", "guardian_rfid.yaml")
    if not (os.path.isfile(panel) and os.path.isfile(scripts) and os.path.isfile(pkg)):
        return
    problems = []

    initials = _declared_initials(repo)
    pkg_text = read(pkg)
    for i in range(1, 10):
        name = "rfid_%d_notify_level" % i
        if not re.search(r"^  %s:" % name, pkg_text, re.M):
            problems.append("%s is missing from packages/guardian_rfid.yaml" % name)
            continue
        eid = "input_select.%s" % name
        if eid in initials:
            problems.append(
                "%s declares initial: %r — a restart would wipe a chosen level"
                % (eid, initials[eid][0]))

    stext = read(scripts)
    sm = re.search(
        r"^guardian_slot_write:\n(.*?)(?=^[a-zA-Z_][a-zA-Z0-9_]*:|\Z)",
        stext, re.M | re.S)
    if not sm:
        problems.append("script.guardian_slot_write is missing")
    else:
        block = sm.group(1)
        if not re.search(r"^    payload:", block, re.M):
            problems.append(
                "guardian_slot_write has no payload field — a field named "
                "value collides with input_text.set_value")
        if re.search(r"^    value:", block, re.M):
            problems.append(
                "guardian_slot_write still declares a value field, which "
                "collides with input_text.set_value")
        if "notify_pref" not in block:
            problems.append(
                "guardian_slot_write does not split notify prefs from other "
                "personal ops — house admins would still write someone else's "
                "notify_level")
        bm = re.search(
            r"which_op == 'notify_level'(.*?)(?:which_op == '|default:)",
            block, re.S)
        if not bm:
            problems.append("guardian_slot_write has no notify_level branch")
        elif "continue_on_error" in bm.group(1):
            problems.append(
                "notify_level branch has continue_on_error on the real write")

    ptext = read(panel)
    dm = re.search(r"function slotWriteData\([\s\S]*?\n\}", ptext)
    if not dm:
        problems.append("slotWriteData is missing from the panel")
    else:
        ret = dm.group(0)
        if not re.search(r"(?:,\s*payload\s*[,}]|\bpayload:)", ret):
            problems.append("slotWriteData does not send payload")
        if re.search(r"return \{[^}]*\bvalue:", ret):
            problems.append(
                "slotWriteData still sends value, which collides with "
                "input_text.set_value")
    if "persistNotifyLevel:" not in ptext:
        problems.append(
            "the panel has no persistNotifyLevel — the script write alone "
            "left rfid_N_notify_level unchanged")
    if not re.search(r"ACTIONS\.persistNotifyLevel\(", ptext):
        problems.append("setNotifyLevel never calls persistNotifyLevel")
    if "persistNotifyMute:" not in ptext:
        problems.append(
            "the panel has no persistNotifyMute — category switches would "
            "look saved without writing input_text.rfid_N_notify_mute")
    if not re.search(r"ACTIONS\.persistNotifyMute\(", ptext):
        problems.append("setNotifyCategory never calls persistNotifyMute")
    if "function canEditNotifyPrefs" not in ptext:
        problems.append("canEditNotifyPrefs is missing from the panel")
    vm = re.search(
        r"function viewPersonAlerts\([\s\S]*?\nfunction viewKeys\(", ptext)
    if not vm:
        problems.append("viewPersonAlerts is missing from the panel")
    elif "canEditNotifyPrefs" not in vm.group(0):
        problems.append(
            "viewPersonAlerts does not gate on canEditNotifyPrefs — house "
            "admins would still get tappable Everything/Important tabs on "
            "someone else's key")

    if problems:
        rep.fail(
            "per-person notification prefs cannot persist or are not locked",
            "\n        ".join(problems),
            "The panel must persist notify_level / notify_mute on the exact "
            "helper ids after guardian_slot_write, send payload not value, "
            "and lock the Notifications editor with canEditNotifyPrefs. "
            "rfid_N_notify_level must not declare initial:.",
        )
    else:
        rep.ok(
            "notify prefs persist on the exact helpers, have no initial:, "
            "and personAlerts is locked with canEditNotifyPrefs")


def check_startup_reachable_state(repo, rep):
    """No startup condition may test a value its own `initial:` forbids.

    THE BUG THIS IS WRITTEN FOR. "Guardian: Startup State Recovery" tested
    input_text.portal_display_state for ALARM in order to re-fire an alarm that a
    restart had interrupted. That helper is declared `initial: none`, which Home
    Assistant applies on every start and which SKIPS restore_state - so the
    condition could never be true, the branch had never fired on any install, and
    a Home Assistant restart ended a live burglar alarm in silence with the
    recovery code sitting right there unreachable.

    IT IS A CLASS, NOT AN INSTANCE, AND THE SAME AUTOMATION PROVES IT. Twenty
    lines above that branch is a comment recording the identical trap being found
    in four OTHER helpers - "all four carry initial: false ... so both variables
    were ALWAYS false and neither notification below has ever been sent". It was
    found there, fixed by hand for those four, and left standing in the one
    branch that resumes the alarm. Fixing instances by hand is what this check
    exists to stop.

    Scoped to automations triggered by `homeassistant: start`, because that is
    where "what does the system believe in its first seconds" is decided and
    where an initial: is guaranteed to have just been applied.
    """
    if yaml is None:
        return
    initials = _declared_initials(repo)
    path = os.path.join(repo, "automations.yaml")
    if not initials or not os.path.isfile(path):
        return
    try:
        autos = yaml.load(read(path), Loader=_ha_loader()) or []
    except Exception:
        return

    dead = []

    def conditions(node, out):
        if isinstance(node, list):
            for item in node:
                conditions(item, out)
        elif isinstance(node, dict):
            if node.get("condition") == "state" and "entity_id" in node and "state" in node:
                out.append(node)
            for value in node.values():
                conditions(value, out)

    def templates(node, out):
        if isinstance(node, list):
            for item in node:
                templates(item, out)
        elif isinstance(node, dict):
            for key, value in node.items():
                if key == "value_template" and isinstance(value, str):
                    out.append(value)
                else:
                    templates(value, out)

    for auto in autos:
        if not isinstance(auto, dict):
            continue
        trigs = auto.get("triggers") or auto.get("trigger") or []
        if isinstance(trigs, dict):
            trigs = [trigs]
        if not any(isinstance(t, dict) and t.get("trigger") == "homeassistant"
                   and t.get("event") == "start" for t in trigs):
            continue
        alias = auto.get("alias") or auto.get("id") or "?"
        body = auto.get("actions") or auto.get("action") or []

        found = []
        conditions(body, found)
        for cond in found:
            ents = cond["entity_id"]
            ents = [ents] if isinstance(ents, str) else ents
            wants = cond["state"]
            wants = wants if isinstance(wants, list) else [wants]
            for ent in ents:
                if ent not in initials:
                    continue
                init, src = initials[ent]
                if all(str(w) != init for w in wants):
                    dead.append(
                        "%s\n            condition: %s == %r, but %s declares "
                        "initial: %r" % (alias, ent, wants[0], src, init))

        tpls = []
        templates(body, tpls)
        for tpl in tpls:
            for ent, (init, src) in initials.items():
                pattern = r"is_state\(\s*'%s'\s*,\s*'([^']*)'\s*\)" % re.escape(ent)
                for match in re.finditer(pattern, tpl):
                    if match.group(1) != init:
                        dead.append(
                            "%s\n            template: is_state('%s', %r), but %s "
                            "declares initial: %r" % (alias, ent, match.group(1),
                                                      src, init))

    if dead:
        rep.fail(
            "a startup condition that can never be true",
            "%d condition(s) in a homeassistant:start automation test a value "
            "the helper's own initial: makes unreachable:\n        %s"
            % (len(dead), "\n        ".join(dead)),
            "`initial:` is applied on every start and SKIPS restore_state, so "
            "the helper is at its initial value when this runs and the branch is "
            "dead code. Carry the evidence in a helper that declares NO initial: "
            "and therefore restores - the way "
            "input_text.guardian_alarm_latch does for an interrupted alarm - and "
            "test that instead.",
        )
    else:
        rep.ok(
            "no startup branch tests a helper for a value its own initial: "
            "makes unreachable (%d helpers with an initial: considered)"
            % len(initials))


def _unit_modes(repo):
    """(callers, callees) - every automation and script with its mode and max.

    callers: name -> how many runs of that unit can be in flight at once.
    callees: script name -> how many runs of it can exist before one is dropped.
    """
    def mode_of(body):
        mode = body.get("mode", "single")
        return mode, body.get("max", 10 if mode in ("queued", "parallel") else None)

    def blocking_calls(seq, out):
        if not isinstance(seq, list):
            return
        for step in seq:
            if not isinstance(step, dict):
                continue
            svc = step.get("action") or step.get("service")
            # script.turn_on / script.turn_off are FIRE AND FORGET. The caller
            # does not wait and is not told a result, so a drop there deceives
            # nobody - which is exactly why several hot paths in this repo use
            # that idiom deliberately. Only "action: script.x" is counted.
            if (isinstance(svc, str) and svc.startswith("script.")
                    and svc not in ("script.turn_on", "script.turn_off")):
                out.append(svc.split(".", 1)[1])
            for key in ("then", "else", "default", "sequence", "actions"):
                if isinstance(step.get(key), list):
                    blocking_calls(step[key], out)
            for entry in step.get("choose") or []:
                if isinstance(entry, dict):
                    blocking_calls(entry.get("sequence") or [], out)
            repeat = step.get("repeat")
            if isinstance(repeat, dict):
                blocking_calls(repeat.get("sequence") or [], out)
            for entry in step.get("parallel") or []:
                if isinstance(entry, dict):
                    blocking_calls(entry.get("sequence") or [entry], out)

    callers, callees = {}, {}
    spath = os.path.join(repo, "scripts.yaml")
    if os.path.isfile(spath):
        scripts = yaml.load(read(spath), Loader=_ha_loader()) or {}
        for name, body in scripts.items():
            if not isinstance(body, dict):
                continue
            mode, mx = mode_of(body)
            calls = []
            blocking_calls(body.get("sequence") or [], calls)
            # A queued or single unit executes exactly ONE run at a time, so it
            # can hold at most one blocking call however deep its own queue is.
            # Only parallel multiplies.
            callers["script." + name] = (
                (mx or 10) if mode == "parallel" else 1, set(calls), mode, mx)
            # As a CALLEE, queued counts its whole queue: max is 1 running plus
            # max-1 waiting. single has no queue at all, which is why it is the
            # sharpest form of this bug.
            callees[name] = ((mx or 10) if mode in ("queued", "parallel") else 1,
                             mode, mx)
    apath = os.path.join(repo, "automations.yaml")
    if os.path.isfile(apath):
        autos = yaml.load(read(apath), Loader=_ha_loader()) or []
        for auto in autos:
            if not isinstance(auto, dict):
                continue
            mode, mx = mode_of(auto)
            calls = []
            blocking_calls(auto.get("actions") or auto.get("action") or [], calls)
            callers["auto: %s" % (auto.get("alias") or auto.get("id"))] = (
                (mx or 10) if mode == "parallel" else 1, set(calls), mode, mx)
    return callers, callees


def check_blocking_call_capacity(repo, rep):
    """Every script must have room for every blocking call that can arrive.

    A blocking `action: script.x` against a queued or single script already at
    max is DISCARDED SILENTLY - it does not raise, nothing is logged that anyone
    would connect to the symptom, and the caller proceeds as though it ran. This
    check computes both sides of that from the call graph rather than trusting a
    max somebody chose once:

        demand  = sum over every unit that blocking-calls it of how many runs
                  that unit can have in flight (1 for single/queued/restart, max
                  for parallel)
        capacity = max for queued and parallel, 1 for single

    capacity >= demand is a proof that no blocking call can ever find the queue
    full. Home Assistant has no script mode that structurally cannot drop, so
    this arithmetic is the strongest guarantee available - and it is the part
    nobody had done.

    Three scripts failed it when it was written, and the arithmetic is what found
    all three: guardian_reset_auth at 3 against 4 callers, which drops the
    teardown of three alarm timers that then fire a siren at somebody who
    authenticated correctly; guardian_notify_broadcast at 20 against 36, which
    drops a major alarm's escalation to the phones; and
    guardian_sample_ambient_light on mode: single against 6, which has no queue
    at all and therefore drops on the second concurrent caller, always.

    COUNT EVERY BLOCKING CALL, GUARDED OR NOT. continue_on_error decides what
    happens when a callee RAISES. A call discarded for want of a queue slot never
    runs and never raises, so the flag has no bearing on it whatsoever - a guarded
    blocking call occupies capacity and is deceived by a drop exactly like an
    unguarded one. Excluding them is how the first count of notify_broadcast came
    out at 21 instead of 36.
    """
    if yaml is None:
        return
    try:
        callers, callees = _unit_modes(repo)
    except Exception:
        return
    if not callees:
        return

    demand = {}
    who = {}
    for unit, (weight, calls, _mode, _mx) in callers.items():
        for callee in calls:
            if callee not in callees:
                continue
            demand[callee] = demand.get(callee, 0) + weight
            who.setdefault(callee, []).append((unit, weight))

    short = []
    for name, need in sorted(demand.items()):
        capacity, mode, mx = callees[name]
        if capacity >= need:
            continue
        top = sorted(who[name], key=lambda p: -p[1])[:3]
        short.append(
            "%s  mode: %s, max: %s -> capacity %d, demand %d\n            "
            "biggest callers: %s"
            % (name, mode, mx, capacity, need,
               ", ".join("%s (%d)" % (u, w) for u, w in top)))

    if short:
        rep.fail(
            "a script that can have a blocking call silently discarded",
            "%d script(s) have less capacity than the blocking calls that can "
            "arrive at once:\n        %s" % (len(short), "\n        ".join(short)),
            "Raise `max:` above the demand, or make the offending call sites "
            "non-blocking with script.turn_on. A blocking call to a script at "
            "max is DISCARDED SILENTLY and the caller proceeds as though it "
            "ran - so on an alarm-ending path this is a siren nobody stopped, "
            "and continue_on_error does not help because nothing raised.",
        )
    else:
        margins = sorted(
            (callees[n][0] - d, n) for n, d in demand.items())
        tightest = ", ".join("%s +%d" % (n, m) for m, n in margins[:3])
        rep.ok(
            "every script has capacity for every blocking call that can arrive "
            "at once (%d scripts called blocking; tightest margins: %s)"
            % (len(demand), tightest))


def check_selftest_count_documented(repo, rep):
    """DEPLOY.md's newest fault count must equal the self-test's actual one.

    The forty-fourth pass's step 293 told a reader to confirm `23 of 23 faults
    caught.` while the same pass's own Preflight section said 26 and the tool
    printed 26. Anybody following that verify step on a correct tree concludes
    the tree is broken - a verify step that cannot be satisfied is worse than no
    verify step, because it spends somebody's afternoon.

    Only the LAST count in the file is checked. Earlier passes quote the count
    that was true when they were written; those are a historical record and are
    never renumbered.
    """
    dpath = os.path.join(repo, "DEPLOY.md")
    spath = os.path.join(repo, "tools", "guardian-selftest-preflight.py")
    if not (os.path.isfile(dpath) and os.path.isfile(spath)):
        return
    quoted = re.findall(r"(\d+) of (\d+) faults caught", read(dpath))
    if not quoted:
        return
    documented = int(quoted[-1][1])
    # Count the injection tuples by their anchor, not by the word FAULTS: a
    # check that matches the list's NAME rather than its CONTENTS passes on an
    # empty list, which is the vocabulary-versus-behaviour trap this repository
    # has now been bitten by twice.
    body = read(spath)
    block = body.split("FAULTS = [", 1)
    actual = None
    if len(block) == 2:
        depth, end = 1, None
        for index, char in enumerate(block[1]):
            if char == "[":
                depth += 1
            elif char == "]":
                depth -= 1
                if depth == 0:
                    end = index
                    break
        if end is not None:
            actual = len(re.findall(r"^\s{4}\('", block[1][:end], re.M))
    if not actual:
        return
    if actual != documented:
        rep.fail(
            "DEPLOY.md quotes a fault count the self-test does not produce",
            "The newest verify step says `%d of %d faults caught.` and "
            "tools/guardian-selftest-preflight.py defines %d injections."
            % (int(quoted[-1][0]), documented, actual),
            "Update the newest step to %d. Leave every earlier pass's count "
            "alone - those record what was true when they were written and are "
            "never renumbered." % actual,
        )
    else:
        rep.ok("DEPLOY.md's newest verify step quotes the real fault count (%d)"
               % actual)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Validate a Guardian tree before it becomes a live system."
    )
    parser.add_argument(
        "--repo", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="Guardian repository root (default: the parent of tools/).",
    )
    parser.add_argument(
        "--config-dir", default=None,
        help="A Home Assistant /config to additionally check as a deployed tree.",
    )
    args = parser.parse_args(argv)

    repo = os.path.abspath(args.repo)
    print("Guardian preflight")
    print("  repo: %s" % repo)
    if args.config_dir:
        print("  config: %s" % os.path.abspath(args.config_dir))
    print()

    rep = Report()
    loaded = check_yaml(repo, rep)
    check_versions(repo, rep)
    check_version_marker(repo, rep)
    check_line_endings(repo, rep)
    check_script_refs(repo, loaded, rep)
    check_automation_ids(repo, loaded, rep)
    check_alert_ordering(repo, rep)
    check_blocking_call_capacity(repo, rep)
    check_startup_reachable_state(repo, rep)
    check_unguardable_arguments(repo, rep)
    check_states_arguments(repo, rep)
    check_bounded_actuator_loops(repo, rep)
    check_derived_entities(repo, rep)
    check_no_external_urls(repo, rep)
    check_card_acceptance(repo, rep)
    check_panel_version_directions(repo, rep)
    check_notify_level_contract(repo, rep)
    check_slot_ha_user_persist(repo, rep)
    check_notify_pref_persist(repo, rep)
    check_reboot_timeouts(repo, rep)
    check_installer_backups(repo, rep)
    check_selftest_count_documented(repo, rep)
    check_esphome_secrets(repo, rep)
    if args.config_dir:
        check_deployed(os.path.abspath(args.config_dir), rep, repo)

    return rep.render()


if __name__ == "__main__":
    sys.exit(main())
