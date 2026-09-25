/* =============================================================================
 * Guardian Control Panel
 * -----------------------------------------------------------------------------
 * A second, deliberately designed UI layer over the Guardian security system.
 * It is a Home Assistant *custom panel* (see panel_custom: in
 * configuration.yaml), not a Lovelace dashboard and not a fork of the frontend.
 * Settings -> Devices & Services -> Helpers and Developer Tools remain the
 * administration surface; this is the everyday-safe one.
 *
 * WHAT THIS FILE MAY AND MAY NOT DO
 *
 *   It reads entity state and calls existing services. That is the whole
 *   contract. It contains NO business logic: no decision about when to alarm,
 *   what elevated mode means, which slot to enroll into, or how the lamp should
 *   behave. Every one of those lives in automations.yaml / scripts.yaml /
 *   packages/*.yaml and is reproduced here only as *presentation* of state the
 *   system already publishes.
 *
 *   Three security boundaries are enforced structurally, not by convention:
 *
 *     1. No PIN input, except the doorbell-exit window. Changing the master
 *        PIN is still typed on the portal keypad. While
 *        input_boolean.guardian_doorbell_exit_pin is on, this panel may
 *        collect the master PIN in memory and submit it to
 *        script.guardian_apply_doorbell_exit_pin. There is no PIN field on
 *        any Lovelace dashboard, and no helper ever stores the digits.
 *     2. No credential is ever rendered. input_text.rfid_N_card_id,
 *        input_text.rfid_N_hash and input_text.portal_pin_hash are read for
 *        LENGTH ONLY (16 hex == occupied for a card_id, 64 == occupied for the
 *        PIN hash). renderHash() does not exist.
 *     3. Destructive and state-machine-clearing actions (system reset, silence
 *        alarm, clear a card slot, flag a card stolen, reboot a device) require
 *        a deliberate press-and-hold. script.guardian_reset is Home
 *        Assistant-side only by design - it must not be one stray tap away
 *        either.
 *
 * NO BUILD STEP. Plain ES module, no dependencies, no bundler, no HACS. Home
 * Assistant serves /config/www as /local with long cache headers, so the
 * version query in configuration.yaml's module_url is what busts the cache:
 * bump GUARDIAN_UI_VERSION here AND the ?v= there in the same commit.
 *
 * LAYOUT OF THIS FILE
 *   1  Version and configuration
 *   2  Entity registry
 *   3  Entity resolver
 *   4  Design tokens and stylesheet
 *   5  Formatting helpers
 *   6  Model - hass states in, one plain object out
 *   7  Actions - every service call the UI can make
 *   8  Markup helpers and shared components
 *   9  Views
 *  10  Activity timeline (recorder history + live event bus)
 *  11  The panel element
 * ========================================================================== */

/* Compared against the backend's own version at runtime - see buildInstall()
 * and sensor.guardian_version. Guardian is loose files copied into /config and
 * nothing makes them arrive together, so "the panel is new" says nothing about
 * scripts.yaml or packages/. When these disagree the panel says so instead of
 * letting old logic answer new questions. */
const GUARDIAN_UI_VERSION = '2.32.5';

/* What configuration.yaml ASKED the browser to load, read back off this module's
 * own URL (`/local/guardian-ui/guardian-panel.js?v=2.32.5`).
 *
 * THIS IS THE THIRD NUMBER, AND WITHOUT IT DIAGNOSTICS GIVES THE WRONG REMEDY.
 * Until now the panel knew two things: the version compiled into the file it is
 * RUNNING (GUARDIAN_UI_VERSION) and the version the backend reports. Those two
 * disagreeing has two completely different causes with two completely different
 * fixes, and the banner only ever printed one of them:
 *
 *   backend is new, panel file was never copied  -> copy the file, restart
 *   backend is new, panel file WAS copied, the
 *   browser is still executing a cached old one  -> hard-refresh; a Home
 *                                                   Assistant restart does
 *                                                   nothing at all
 *
 * The second is the common one, because the panel is the file whose contents
 * usually do not change in a release - only its version literal does - so it is
 * the easy one to skip when copying "what changed", and a browser holding a
 * module is invisible from the server side. Telling that household to restart
 * Home Assistant, watching it not help, and being told to restart again is how a
 * correct warning gets learned as noise.
 *
 * import.meta.url is the one thing that separates them: it is set by
 * configuration.yaml and delivered fresh with the panel registration, so it says
 * what SHOULD be running while the literal above says what IS. Empty when the
 * module is loaded without a query string, in which case this check is skipped
 * rather than guessed at. */
const REQUESTED_UI_VERSION = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || '';
  } catch (err) {
    return '';
  }
})();

/* WHICH WAY ROUND THE TWO NUMBERS ARE, WHICH IS THE WHOLE QUESTION.
 *
 * The number above and GUARDIAN_UI_VERSION disagreeing was read as one fact for
 * three releases: `requested !== ui`, a plain inequality with no notion of
 * direction, feeding a banner that described one cause and prescribed its cure.
 * A comparison with two directions and one branch is a bug waiting for the other
 * direction, and this one arrived on the household's own screens the day 2.27.0
 * was deployed - every device, surviving a cache clear, telling people to clear
 * their cache.
 *
 * The two directions have opposite causes and opposite cures:
 *
 *   requested > ui   The browser is executing an OLD file against a NEW backend.
 *                    Old logic is answering new questions, which is the failure
 *                    this whole comparison exists to catch. Clearing the cache is
 *                    the fix; a Home Assistant restart does nothing at all.
 *
 *   requested < ui   The file on disk is NEW and was loaded correctly - `?v=` is
 *                    only a cache KEY, it does not select a version, so the old
 *                    url served the new bytes. What is stale is the url itself:
 *                    configuration.yaml still carries the previous `?v=` because
 *                    guardian-install.sh does not overwrite a configuration.yaml
 *                    it did not write. Editing those two lines and restarting IS
 *                    the fix, and clearing the cache CANNOT be, because there is
 *                    nothing stale in the cache. This is the normal state of
 *                    every upgraded install until that edit is made.
 *
 * AND THE RULE THAT SHOULD STOP THE FOURTH RECURRENCE. This is the third time
 * Diagnostics has named a remedy that cannot fix the state it detected - the
 * fortieth pass, then restart-versus-cache-clear in the forty-second, now this.
 * Each time the mechanism was the same: a cause was inferred from an ambiguous
 * signal and a cure was printed for it anyway. So the remedy is no longer
 * written at the point of display. It is a field on a NAMED state, and the state
 * that means "the two numbers disagree and I cannot say why" carries an EMPTY
 * remedy by construction. Diagnostics can describe what it sees whenever it
 * likes. It can only prescribe when it has a cause to prescribe against.
 *
 * Self-contained on purpose: no imports, no closure over anything above, its
 * whole vocabulary in one object literal. tools/guardian-preflight.py slices
 * this function out of the file and RUNS it, so the guard is checked by its
 * behaviour rather than by the words in it - a check that tests for vocabulary
 * passes on a neutered guard, which is how the last pass's first installer check
 * walked past its own fault injection.
 *
 * Comparison is numeric per component. '2.9.0' against '2.10.0' is the case a
 * string compare gets backwards, and getting it backwards here means printing
 * the other direction's cure, which is the bug itself. Anything that does not
 * parse as three integers is `unknown` rather than guessed at. */
function classifyPanelVersion(requested, ui) {
  const STATES = {
    match: {
      cause: '',
      remedy: '',
      tone: 'ok',
    },
    unknown: {
      cause: 'Home Assistant did not say which panel version it asked for, so '
        + 'this cannot be checked.',
      /* EMPTY ON PURPOSE. Nothing has been established, so nothing is
       * prescribed. See the note above this function. */
      remedy: '',
      tone: 'idle',
    },
    browser_behind: {
      cause: 'This browser is running an old copy of the panel against a newer '
        + 'Guardian. Old logic is answering new questions, which is what makes '
        + 'a partial deploy look like an ordinary setup mistake.',
      remedy: 'Clear this browser’s cache — Ctrl-Shift-Delete → '
        + 'cached files, or DevTools → Application → Clear site data. A '
        + 'plain Ctrl-Shift-R is often not enough, because this panel is a '
        + 'dynamically imported module and a hard reload does not always re-fetch '
        + 'one. Restarting Home Assistant will not help. If every device shows the '
        + 'old version, then the panel file itself was never copied — copy '
        + 'www/guardian-ui/guardian-panel.js, then clear the cache.',
      tone: 'alarm',
    },
    config_behind: {
      cause: 'The panel file on disk is up to date and loaded correctly. What is '
        + 'out of date is the address Home Assistant asked for it by: the '
        + '?v= cache-buster still names the previous release, because the '
        + 'installer does not overwrite a configuration.yaml it did not write. '
        + 'This is the normal state of an upgraded install until that line is '
        + 'edited.',
      /* NAMES THE TOOL FIRST, AND THAT ORDER IS THE POINT. This text used to
       * open with "edit configuration.yaml", and a household read that every
       * release, on every device, for three releases running - because a remedy
       * that is a manual edit is a remedy somebody has to remember, and the one
       * thing this repository has learned twice over is that they do not.
       * guardian-install.sh has rewritten exactly this line since the
       * forty-fourth pass: it takes a timestamped backup, changes only the
       * digits inside a guardian-ui/*.js?v= query, diffs the result and puts the
       * original back if anything else moved. The hand-edit stays as the
       * fallback for somebody who deploys by copying files, which is how this
       * kept recurring. */
      remedy: 'Run tools/guardian-install.sh --apply — it rewrites both ?v= '
        + 'lines for you and takes a backup first — then restart Home Assistant '
        + 'fully. If you deploy by copying files instead, edit '
        + 'configuration.yaml by hand: set ?v= to the running version on BOTH '
        + 'the panel_custom module_url and the frontend extra_module_url line. '
        + 'Clearing the browser cache cannot fix this: the cache is not holding '
        + 'anything stale. Nothing is broken until the next upgrade — at that '
        + 'point a browser that cached the old address will be served the old '
        + 'panel, which is the fault this prevents.',
      tone: 'warn',
    },
  };

  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v == null ? '' : v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };

  const named = (state) => ({ state, ...STATES[state] });

  const a = parse(requested);
  const b = parse(ui);
  if (!a || !b) return named('unknown');

  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return named('browser_behind');
    if (a[i] < b[i]) return named('config_behind');
  }
  return named('match');
}

/* =============================================================================
 * 1. CONFIGURATION
 *
 * Everything here can be overridden from the `config:` block of the
 * panel_custom entry in configuration.yaml, so a second install with different
 * hardware does not need this file edited.
 *
 * The live camera and the lamp sampler now resolve the same way: the helper
 * if it is a live entity, otherwise camera.door_camera when that entity exists
 * and the helper is empty, `none`, or still the old camera.tapo_c110 sentinel.
 * `config.lamp` is a fallback if sensor.guardian_lamp_entity is unset; lamp
 * automation consumes that sensor, not a hardcoded light id.
 * ========================================================================== */

const DEFAULTS = {
  camera: 'camera.door_camera',
  // No bundled lamp id. sensor.guardian_lamp_entity is the real source and
  // config.lamp is the override; an empty default makes buildLamp report
  // missing, which puts the "pick a light" note on the Lamp page instead of
  // silently pointing a fresh install at whatever bulb this repo grew up with.
  lamp: '',
  historyHours: 24,
  holdMs: 1100,
  frigatePath: '',
};

/* Helper values that used to be the bundled default. Live view and lamp
 * sampling both prefer camera.door_camera when the helper is still one of
 * these and that entity exists. */
const LEGACY_CAMERA_IDS = ['camera.tapo_c110', 'none', ''];

/* =============================================================================
 * 2. ENTITY REGISTRY
 *
 * The single place entity ids appear. Nothing below this block hard-codes one.
 *
 * Per-slot entities are NOT listed: the rack is whatever
 * sensor.guardian_rfid_slots says it is at runtime, exactly like every script
 * and automation in this system. The package pre-declares slots 1-9 (keypad
 * cap). Person names are input_text.rfid_N_name, not the helper friendly_name.
 *
 * Super Surveillance programs are the same pattern:
 * sensor.guardian_ss_programs, then input_boolean.guardian_ss_N_* at runtime.
 *
 * `alt` entries exist because Home Assistant has renamed the doorbell's
 * entities once already (commit "Fix doorbell link/restart entity IDs after HA
 * renamed them to eisodos_ prefix"), which is why the live config now carries
 * two different prefixes for entities on the same device. See resolve().
 * ========================================================================== */

const E = {
  // --- Core state machine -------------------------------------------------
  display: 'input_text.portal_display_state',
  displaySeq: 'input_number.portal_display_seq',
  superSurveillance: 'input_boolean.super_surveillance_mode',
  elevated: 'binary_sensor.guardian_elevated_mode',
  // ssPrograms is the rack (capacity); ssProgramsCreated is what the household
  // actually made and therefore what this panel lists. Never list the rack.
  ssPrograms: 'sensor.guardian_ss_programs',
  ssProgramsCreated: 'sensor.guardian_ss_programs_created',
  mfaPending: 'input_boolean.portal_mfa_pending',
  mfaFails: 'input_number.mfa_failed_attempts',
  entryChallenge: 'input_boolean.guardian_entry_challenge',
  challengeOrigin: 'input_text.guardian_challenge_origin',
  challengeSeconds: 'input_number.guardian_entry_challenge_seconds',
  challengeCardOk: 'input_boolean.guardian_challenge_card_ok',
  challengePinOk: 'input_boolean.guardian_challenge_pin_ok',
  doorbellExitPin: 'input_boolean.guardian_doorbell_exit_pin',
  doorbellExitSlot: 'input_text.guardian_doorbell_exit_slot',
  doorbellExitMinutes: 'input_number.guardian_doorbell_exit_pin_minutes',
  alarmReason: 'input_text.guardian_alarm_reason',

  // --- Timers -------------------------------------------------------------
  tEntry: 'timer.guardian_entry_window',
  tExit: 'timer.guardian_exit_window',
  tMfa: 'timer.guardian_mfa_window',
  tChallenge: 'timer.guardian_entry_challenge',
  tDoorbellExit: 'timer.guardian_doorbell_exit_pin_window',
  tEnroll: 'timer.guardian_enrollment_window',
  tPinChange: 'timer.guardian_pin_change_window',

  // --- Countdown projection (built for exactly this purpose) --------------
  cdEnds: 'sensor.guardian_portal_countdown_ends',
  cdTotal: 'sensor.guardian_portal_countdown_total',
  cdLabel: 'sensor.guardian_portal_countdown_label',

  // --- Pending slots (INTERNAL - display only, never editable here) -------
  pendingEntry: 'input_text.pending_entry_slot',
  pendingExit: 'input_text.pending_exit_slot',
  pendingMfaSlot: 'input_text.pending_mfa_slot',
  pendingMfaSource: 'input_text.pending_mfa_source',

  // --- RFID rack ----------------------------------------------------------
  slots: 'sensor.guardian_rfid_slots',
  freeSlots: 'sensor.guardian_rfid_free_slots',
  slotMap: 'sensor.guardian_rfid_slot_map',
  enrollTarget: 'sensor.guardian_enrollment_target_slot',
  enrollMode: 'input_boolean.guardian_enrollment_mode',
  enrollSlot: 'input_text.guardian_enrollment_slot',
  enrollVisitor: 'input_boolean.guardian_enroll_as_visitor',
  enrollPendingName: 'input_text.guardian_enroll_pending_name',
  // Per-slot on-card protection, as "1p,3u" - `p` protected, `u` unprotected,
  // absent means no reader has ever said. Written by process_rfid_scan; see the
  // helper's own comment in packages/guardian_rfid.yaml for why absent is a
  // third state and not a synonym for protected.
  cardProtection: 'input_text.guardian_card_protection',
  presenceSummary: 'sensor.guardian_presence_summary',
  presenceTrackers: 'input_text.guardian_presence_trackers',
  presenceTrackersAvailable: 'sensor.guardian_presence_trackers_available',
  notifyTargets: 'sensor.guardian_notify_targets_available',
  // What the BACKEND says it is. Its attributes carry the other halves of the
  // deploy - the RFID package, scripts.yaml, automations.yaml - so one entity
  // answers "is all of Guardian actually here, and is it the same version as
  // this panel". See buildInstall().
  version: 'sensor.guardian_version',
  haAdminIds: 'input_text.guardian_ha_admin_ids',
  haUserIds: 'input_text.guardian_ha_user_ids',

  // --- Master PIN ---------------------------------------------------------
  pinChangeMode: 'input_boolean.guardian_pin_change_mode',
  pinChangeStep: 'input_text.guardian_pin_change_step',
  pinChangeFails: 'input_number.guardian_pin_change_fails',
  // Read for LENGTH ONLY, to answer "is a master PIN set at all". Never shown.
  pinHash: 'input_text.portal_pin_hash',

  // --- Lamp ---------------------------------------------------------------
  lamp: 'sensor.guardian_lamp_entity',
  lampTarget: 'input_select.guardian_lamp_target',
  lightsAvailable: 'sensor.guardian_lights_available',
  lampMode: 'input_select.guardian_lamp_luma_mode',
  lampSampling: 'input_boolean.guardian_lamp_sampling',
  lampResult: 'input_text.guardian_lamp_last_result',
  lampPresample: 'input_text.guardian_lamp_presample',
  lampFailStreak: 'input_number.guardian_lamp_fail_streak',
  lampMismatchSince: 'input_text.guardian_lamp_mismatch_since',
  lampMismatchMax: 'input_number.guardian_lamp_mismatch_max_minutes',
  darkThreshold: 'input_number.guardian_dark_threshold',
  brightThreshold: 'input_number.guardian_bright_threshold',
  lumaRotate: 'input_number.guardian_luma_rotate',
  luminance: 'sensor.guardian_camera_luminance',
  lampCal: 'sensor.guardian_lamp_cal',
  sun: 'sun.sun',

  // --- Cameras ------------------------------------------------------------
  cameraEntity: 'input_text.guardian_camera_entity',
  cameraIrEntity: 'input_text.guardian_camera_ir_entity',
  frigateCamera: 'input_text.guardian_frigate_camera_name',

  // --- Portal hardware ----------------------------------------------------
  portalStatus: 'binary_sensor.guardian_interior_portal_status',
  // device_class: problem with "return !(healthy)" in the firmware.
  // ON MEANS FAULTY. Inverted twice historically (audit F-27, F-41) - check
  // esphome/portal-unit.yaml before touching this.
  portalImuProblem: 'binary_sensor.guardian_interior_portal_imu_healthy',
  doorContact: 'binary_sensor.guardian_interior_portal_door_contact',
  handleDepressed: 'binary_sensor.guardian_interior_portal_handle_depressed',
  doorMoving: 'binary_sensor.guardian_interior_portal_door_moving',
  portalWifi: 'sensor.guardian_interior_portal_wifi_signal',
  portalUptime: 'sensor.guardian_interior_portal_uptime',
  portalLed: 'light.guardian_interior_portal_portal_led',
  portalBacklight: 'light.guardian_interior_portal_portal_backlight',
  handleTilt: 'sensor.guardian_interior_portal_handle_tilt',
  swingRate: 'sensor.guardian_interior_portal_door_swing_rate',
  swingAngle: 'sensor.guardian_interior_portal_door_swing_angle',
  vibration: 'sensor.guardian_interior_portal_door_vibration',
  tiltThreshold: 'number.guardian_interior_portal_handle_tilt_threshold',
  swingThreshold: 'number.guardian_interior_portal_swing_rate_threshold',
  handleLookback: 'number.guardian_interior_portal_handle_lookback',
  portalRestart: 'button.guardian_interior_portal_restart',
  portalSafeRestart: 'button.guardian_interior_portal_restart_in_safe_mode',
  calibrateRest: 'button.guardian_interior_portal_calibrate_door_rest',
  playWelcome: 'button.guardian_interior_portal_play_welcome',
  playDenied: 'button.guardian_interior_portal_play_denied',
  playAlarm: 'button.guardian_interior_portal_play_alarm',
  playDoorbell: 'button.guardian_interior_portal_play_doorbell',
  playChallenge: 'button.guardian_interior_portal_play_mfa_challenge',

  // --- Doorbell hardware --------------------------------------------------
  doorbellOnline: 'binary_sensor.guardian_doorbell_online',
  doorbellLink: 'sensor.guardian_doorbell_link',
  doorbellEntities: 'sensor.guardian_doorbell_entities',
  doorbellLinkRaw: 'binary_sensor.eisodos_smart_doorbell_doorbell_link',
  doorbellButton: 'binary_sensor.guardian_doorbell_button',
  doorbellWifi: 'sensor.smart_doorbell_doorbell_wifi_signal',
  doorbellUptime: 'sensor.smart_doorbell_doorbell_uptime',
  doorbellLight: 'light.smart_doorbell_doorbell_status_light',
  doorbellRestart: 'button.eisodos_smart_doorbell_doorbell_restart',
  doorbellSafeRestart: 'button.eisodos_smart_doorbell_doorbell_restart_in_safe_mode',
  doorbellIp: 'sensor.smart_doorbell_doorbell_ip_address',
  doorbellSsid: 'sensor.smart_doorbell_doorbell_connected_ssid',

  // --- Diagnostics and admin ---------------------------------------------
  faults: 'sensor.guardian_faults',
  lastDoor: 'input_text.guardian_last_door_summary',
  verbose: 'input_boolean.guardian_verbose_notifications',
  portalOfflineLatch: 'input_boolean.guardian_portal_offline_notified',
  doorbellOfflineLatch: 'input_boolean.guardian_doorbell_offline_notified',
  resetButton: 'input_button.guardian_reset',
  // Has script.guardian_setup_wizard already applied this install's first-boot
  // defaults. Read-only here: the panel reports it and never writes it, the
  // same rule the rest of the state machine's internals follow.
  setupComplete: 'input_boolean.guardian_setup_complete',
};

/* Entities whose id may have drifted. Checked in order, then by suffix. */
const ALIASES = {
  [E.doorbellLinkRaw]: ['binary_sensor.smart_doorbell_doorbell_link'],
  [E.doorbellRestart]: ['button.smart_doorbell_doorbell_restart'],
  [E.doorbellSafeRestart]: ['button.smart_doorbell_doorbell_restart_in_safe_mode'],
  [E.doorbellButton]: ['binary_sensor.eisodos_smart_doorbell_doorbell_button'],
  [E.doorbellWifi]: ['sensor.eisodos_smart_doorbell_doorbell_wifi_signal'],
  [E.doorbellUptime]: ['sensor.eisodos_smart_doorbell_doorbell_uptime'],
  [E.doorbellLight]: ['light.eisodos_smart_doorbell_doorbell_status_light'],
  [E.doorbellIp]: ['sensor.eisodos_smart_doorbell_doorbell_ip_address'],
  [E.doorbellSsid]: ['sensor.eisodos_smart_doorbell_doorbell_connected_ssid'],
};

/* Read-only internals surfaced in More -> Internals. Never editable here:
 * every one of them is written by the state machine, and a hand edit is how a
 * stranded challenge or a lost passage window happens. Tap opens Home
 * Assistant's own more-info dialog, which is where an edit belongs. */
const INTERNALS = [
  [E.display, 'Portal display state'],
  [E.displaySeq, 'Display sequence'],
  [E.pendingEntry, 'Pending entry slots'],
  [E.pendingExit, 'Pending exit slots'],
  [E.pendingMfaSlot, 'Pending MFA slot'],
  [E.pendingMfaSource, 'Pending MFA source'],
  [E.challengeOrigin, 'Challenge origin'],
  [E.mfaFails, 'MFA failed attempts'],
  [E.pinChangeStep, 'PIN change step'],
  [E.pinChangeFails, 'PIN change fails'],
  [E.lampPresample, 'Lamp pre-sample state'],
  [E.lampMismatchSince, 'Lamp sun-mismatch since'],
  [E.lampFailStreak, 'Lamp fail streak'],
  [E.enrollSlot, 'Enrollment slot choice'],
  [E.portalOfflineLatch, 'Portal offline latch'],
  [E.doorbellOfflineLatch, 'Doorbell offline latch'],
];

/* Nested pages. `parent` is another page id, or '' to return to the tab. */
const PAGE_META = {
  keys: { title: 'Keys, People & Alerts', parent: '' },
  lamp: { title: 'Lamp', parent: '' },
  security: { title: 'Security', parent: '' },
  devices: { title: 'Devices', parent: '' },
  portal: { title: 'Interior portal', parent: 'devices' },
  doorbell: { title: 'Doorbell', parent: 'devices' },
  notifications: { title: 'Notifications', parent: '' },
  /* Parent is keys, not '': this screen belongs to one person, so Back has to
   * land on the card it was opened from and not on the More index. Which
   * person is in _ui.alertsSlot, stashed by the nav action. */
  personAlerts: { title: 'Notification preferences', parent: 'keys' },
  install: { title: 'Install', parent: '' },
  diagnostics: { title: 'Diagnostics', parent: '' },
  internals: { title: 'Internals', parent: '' },
  reset: { title: 'Reset', parent: '' },
  doorSensors: { title: 'Door sensors', parent: '' },
};

/* =============================================================================
 * 3. ENTITY RESOLVER
 *
 * resolve(hass, id) returns the id that actually exists on this install.
 *
 * Order: the canonical id, then any declared alias, then a suffix match across
 * the whole state machine within the same domain. The suffix pass is what
 * survived Home Assistant renaming the doorbell entities: every id on that
 * device still ends in "smart_doorbell_doorbell_<thing>", whatever prefix gets
 * bolted on the front.
 *
 * Results are cached per entity-registry generation, keyed by the number of
 * entities in hass.states, so a device coming back online re-resolves without
 * a page reload.
 * ========================================================================== */

const _resolveCache = new Map();
let _resolveGen = -1;

function resolve(hass, id) {
  if (!hass || !hass.states || !id) return id;
  const gen = Object.keys(hass.states).length;
  if (gen !== _resolveGen) {
    _resolveCache.clear();
    _resolveGen = gen;
  }
  if (_resolveCache.has(id)) {
    const cached = _resolveCache.get(id);
    if (hass.states[cached]) return cached;
    _resolveCache.delete(id);
  }

  const dbKey = {
    [E.doorbellLinkRaw]: 'link',
    [E.doorbellWifi]: 'wifi',
    [E.doorbellUptime]: 'uptime',
    [E.doorbellLight]: 'status_light',
    [E.doorbellRestart]: 'restart',
    [E.doorbellSafeRestart]: 'restart_safe',
    [E.doorbellIp]: 'ip',
    [E.doorbellSsid]: 'ssid',
  }[id];
  if (dbKey) {
    const dbEnt = hass.states[E.doorbellEntities];
    const mapped = dbEnt && dbEnt.attributes && dbEnt.attributes[dbKey];
    if (mapped && hass.states[mapped]) {
      _resolveCache.set(id, mapped);
      return mapped;
    }
  }

  let found = id;
  if (!hass.states[id]) {
    const alts = ALIASES[id] || [];
    const hit = alts.find((a) => hass.states[a]);
    if (hit) {
      found = hit;
    } else if (!/^input_(?:text|select)\.rfid_\d+/.test(String(id))) {
      /* RFID slot helpers are YAML entity ids the scripts write by name.
       * Suffix-matching a UI-created helper here is how the account picker
       * and notify-level tabs can paint one entity while guardian_slot_write
       * updates another. Doorbell/device ids still need the tail fallback. */
      const [domain, object] = id.split('.');
      const tails = [];
      const parts = (object || '').split('_');
      for (let i = 0; i < parts.length - 1; i++) tails.push(parts.slice(i).join('_'));
      for (const tail of tails) {
        if (tail.split('_').length < 3) break;
        const match = Object.keys(hass.states).find(
          (k) => k.startsWith(domain + '.') && k.endsWith('_' + tail)
        );
        if (match) {
          found = match;
          break;
        }
      }
    }
  }
  _resolveCache.set(id, found);
  return found;
}

function so(hass, id) {
  return hass && hass.states ? hass.states[resolve(hass, id)] : undefined;
}
function st(hass, id, fallback = 'unknown') {
  const s = so(hass, id);
  return s ? s.state : fallback;
}
function attr(hass, id, name, fallback = undefined) {
  const s = so(hass, id);
  return s && s.attributes && s.attributes[name] !== undefined ? s.attributes[name] : fallback;
}
function isOn(hass, id) {
  return st(hass, id) === 'on';
}
function num(hass, id, fallback = 0) {
  const v = parseFloat(st(hass, id));
  return Number.isFinite(v) ? v : fallback;
}
function exists(hass, id) {
  return !!so(hass, id);
}
function dead(hass, id) {
  const s = so(hass, id);
  return !s || s.state === 'unavailable' || s.state === 'unknown';
}

/* =============================================================================
 * 4. DESIGN TOKENS AND STYLESHEET
 *
 * Light is the product default. Dark is a dimmed home app, not a SOC.
 * One accent for chrome. Status colour is a dot, a word, or a thin edge.
 *
 *   ok        secure, healthy, at home, granted
 *   arm       super surveillance engaged, nothing pending
 *   elev      elevated mode in force (manual or night window)
 *   pass      a passage window is open - someone is authorised to move
 *   info      enrollment, PIN change, other operator-driven sessions
 *   warn      a challenge is counting down, a fault, a card rejected
 *   alarm     full alarm
 *   idle      off, away, nothing happening, no data
 *
 * The eight tones keep their meanings exactly. What the twenty-first pass changed
 * is craft, not language: the four cool tones (arm / elev / pass / info) used to
 * sit within a few degrees of each other, so "passage open" and "adding a key"
 * were the same teal. They are now four separable hues at one chroma.
 *
 * The wash is warm paper rather than iOS grey, and dark is a dimmed room
 * (#16171A) with surfaces that LIFT, never a black console.
 *
 * A second, smaller palette (--ill-*) exists only for the device illustrations
 * in section 8. It is deliberately separate: those drawings must read as white
 * ABS and black powder-coat in both schemes, and must never borrow a status
 * tone by accident. Status enters an illustration through --tone and nowhere
 * else.
 * ========================================================================== */

const STYLES = `
:host {
  --g-ok: #12764B; --g-arm: #34558A; --g-elev: #6B4FA0; --g-pass: #0E7C7B;
  --g-info: #1E6FBF; --g-warn: #B25A00; --g-alarm: #C0271F; --g-idle: #76767B;
  --g-accent: #1F6B5A; --g-accent-ink: #175245;

  --g-bg: #F3F2EF; --g-bg-2: #FAF9F7;
  --g-surface: #FFFFFF; --g-surface-2: #F4F3F0; --g-surface-3: #E7E5DF;
  --g-line: rgba(30,28,24,0.09); --g-line-2: rgba(30,28,24,0.17);
  --g-text: #1A1917; --g-dim: #5E5C57; --g-faint: #8B8880;
  --g-shadow: 0 1px 1px rgba(30,28,24,.04), 0 8px 20px -14px rgba(30,28,24,.24);
  --g-shadow-lift: 0 1px 2px rgba(30,28,24,.06), 0 14px 32px -18px rgba(30,28,24,.34);

  /* Device illustrations. White printed PETG, gloss black paint, frost, glass. */
  --ill-ink: #2A2A2E;
  --ill-body-0: #FFFFFF;
  --ill-body: #FCFBF9; --ill-body-2: #EBE8E2; --ill-body-3: #D6D2CA;
  --ill-body-4: #B9B4AA;
  --ill-hi: rgba(255,255,255,.85);
  --ill-dark: #2C2D31; --ill-dark-2: #1B1C1F; --ill-dark-3: #3E4046;
  --ill-screen: #0B1216; --ill-glass: #101318; --ill-bell: #D8452E;
  --ill-frost: #F6F5F2;
  /* Added in the twenty-fourth pass, for material rather than for state. */
  --ill-gloss: #17181C; --ill-gloss-2: #34363D; --ill-gloss-3: #0A0B0D;
  --ill-spec: rgba(255,255,255,.92);
  --ill-chrome: #C9CBD0; --ill-chrome-2: #6E727A;
  --ill-screw: #B4B7BC;
  --ill-btn: #E8543A; --ill-btn-2: #A32A16;
  --ill-frost-warm: #FFF6E4; --ill-lcd: #0A2C4A;

  --g-r-xs: 6px; --g-r-sm: 9px; --g-r: 12px; --g-r-lg: 16px; --g-r-xl: 20px;
  --g-r-pill: 999px;
  --g-s1: 4px; --g-s2: 8px; --g-s3: 12px; --g-s4: 16px; --g-s5: 22px; --g-s6: 32px;
  --g-gp: 18px;
  --g-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --g-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --g-ease: cubic-bezier(.22,.61,.36,1);
  --g-ease-out: cubic-bezier(.16,.84,.44,1);
  --g-hit: 44px;

  display: flex;
  flex-direction: column;
  position: absolute;
  inset: 0;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  container-type: inline-size;
  container-name: guardian;
  color-scheme: light;
  background: var(--g-bg);
  color: var(--g-text);
  font-family: var(--g-font);
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
:host([data-scheme="dark"]) {
  --g-ok: #4FC08D; --g-arm: #8FB0E0; --g-elev: #B49BE8; --g-pass: #4FBFB8;
  --g-info: #6FB0F5; --g-warn: #E5A33C; --g-alarm: #FF6B60; --g-idle: #90939A;
  --g-accent: #46A88C; --g-accent-ink: #A9E2CE;

  --g-bg: #16171A; --g-bg-2: #1A1B1F;
  --g-surface: #1F2126; --g-surface-2: #272A30; --g-surface-3: #33373E;
  --g-line: rgba(255,255,255,0.08); --g-line-2: rgba(255,255,255,0.15);
  --g-text: #ECEBE8; --g-dim: #A7A5A0; --g-faint: #7E7C78;
  --g-shadow: none;
  --g-shadow-lift: 0 12px 30px -20px rgba(0,0,0,.9);

  --ill-ink: #101114;
  --ill-body-0: #EDEAE4;
  --ill-body: #D9D6D0; --ill-body-2: #B6B3AC; --ill-body-3: #918E88;
  --ill-body-4: #6E6B66;
  --ill-hi: rgba(255,255,255,.35);
  --ill-dark: #26272B; --ill-dark-2: #16171A; --ill-dark-3: #383A40;
  --ill-screen: #05080A; --ill-glass: #0A0C10; --ill-bell: #E2604A;
  --ill-frost: #C9C6BF;
  --ill-gloss: #131418; --ill-gloss-2: #2B2D33; --ill-gloss-3: #08090B;
  --ill-spec: rgba(255,255,255,.52);
  --ill-chrome: #93969C; --ill-chrome-2: #4C4F55;
  --ill-screw: #83868C;
  --ill-btn: #D8482F; --ill-btn-2: #8C2312;
  --ill-frost-warm: #E4DCC9; --ill-lcd: #072135;

  color-scheme: dark;
  background: var(--g-bg);
  color: var(--g-text);
}

* { box-sizing: border-box; }
button {
  font: inherit; color: inherit; background: none; border: 0; cursor: pointer;
  transition: background-color .15s var(--g-ease), color .15s var(--g-ease),
    border-color .15s var(--g-ease), transform .12s var(--g-ease), filter .12s var(--g-ease),
    box-shadow .15s var(--g-ease);
}
input, select { font: inherit; color: inherit; background: transparent; }
input::placeholder { color: var(--g-faint); }
::selection { background: color-mix(in srgb, var(--g-accent) 26%, transparent); }

/* --- Motion language -------------------------------------------------------
 * Everything animated in this file is declared here, so "does the panel move
 * more than it did?" is answerable by reading one block.
 *
 *   gEnter    view entrance, staggered. Fires on NAVIGATION only - never on a
 *             state change, or an alarm would re-animate the page under you.
 *   gBlink    a device status LED with something pending. Idle LEDs are steady.
 *   gPulseRing person detection at the lens. Two iterations, then it stops.
 *   gChime    doorbell button pressed. Two iterations.
 *   gFlow     a link on the signal path that is carrying something right now -
 *             a press, an open passage, a person in view. A link with nothing
 *             on it does not move, which is the only reason lighting one means
 *             anything.
 *   statusPulse the alarm status bar, unchanged from the eleventh pass.
 * -------------------------------------------------------------------------- */
@keyframes gEnter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes gFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes gBlink { 0%, 46%, 100% { opacity: 1; } 60%, 86% { opacity: .18; } }
@keyframes gPulseRing {
  from { transform: scale(1); opacity: .75; }
  to { transform: scale(2.6); opacity: 0; }
}
@keyframes gChime {
  0%, 100% { transform: none; }
  25% { transform: rotate(-9deg); }
  75% { transform: rotate(9deg); }
}
@keyframes gSweep { from { opacity: .0; } 50% { opacity: .55; } to { opacity: 0; } }
@keyframes gFlow { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }

.shell {
  position: relative;
  display: flex; flex-direction: column; flex: 1;
  min-height: 0; min-width: 0; height: 100%;
  background: var(--g-bg); color: var(--g-text); overflow: hidden;
}
.shell[data-nav="rail"] { flex-direction: row; }

.rail { display: none; }
.shell[data-nav="rail"] .rail {
  display: flex; flex-direction: column; gap: var(--g-s1);
  width: 232px; flex: 0 0 232px; padding: calc(var(--g-s5) + env(safe-area-inset-top)) var(--g-s3) var(--g-s4);
  border-right: 1px solid var(--g-line); background: var(--g-bg-2);
}
.shell[data-nav="rail"] .rail .brand {
  display: flex; align-items: center; gap: 11px;
  padding: 4px 10px var(--g-s5);
}
.shell[data-nav="rail"] .rail .brand ha-icon { color: var(--g-accent); }
.shell[data-nav="rail"] .rail .brand b { font-size: 17px; font-weight: 650; letter-spacing: -.02em; }
.shell[data-nav="rail"] .rail .brand small {
  display: block; font-size: 10.5px; color: var(--g-faint); font-weight: 620;
  letter-spacing: .09em; text-transform: uppercase; margin-top: 1px;
}
.shell[data-nav="rail"] .rail nav { display: flex; flex-direction: column; gap: 2px; }
.shell[data-nav="rail"] .rail nav button {
  position: relative; display: flex; align-items: center; gap: 12px;
  min-height: var(--g-hit); padding: 10px 12px 10px 14px; border-radius: var(--g-r);
  font-size: 15px; font-weight: 520; color: var(--g-dim);
}
.shell[data-nav="rail"] .rail nav button::before {
  content: ''; position: absolute; left: 0; top: 50%; width: 3px; height: 0;
  border-radius: 0 3px 3px 0; background: var(--g-accent);
  transform: translateY(-50%); transition: height .26s var(--g-ease-out);
}
.shell[data-nav="rail"] .rail nav button:hover { background: var(--g-surface); color: var(--g-text); }
.shell[data-nav="rail"] .rail nav button:active { background: color-mix(in srgb, var(--g-accent) 16%, var(--g-surface)); }
.shell[data-nav="rail"] .rail nav button[aria-current="page"] {
  background: var(--g-surface); color: var(--g-accent-ink); font-weight: 620;
  box-shadow: var(--g-shadow);
}
.shell[data-nav="rail"] .rail nav button[aria-current="page"]::before { height: 20px; }
.shell[data-nav="rail"] .rail nav button ha-icon { --mdc-icon-size: 22px; }

.main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--g-bg); }
.workspace { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--g-bg); }
.scroll {
  flex: 1; min-width: 0; min-height: 0;
  overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: var(--g-s4) var(--g-s4) calc(108px + env(safe-area-inset-bottom));
  scrollbar-width: thin; scrollbar-color: var(--g-line-2) transparent;
  background: var(--g-bg);
}
.shell[data-nav="rail"] .scroll { padding: var(--g-s5) var(--g-s5) var(--g-s6); }
.wrap { max-width: 720px; width: 100%; margin: 0 auto; min-width: 0; }
.shell[data-tab="camera"] .wrap { max-width: 920px; }

.topbar {
  display: flex; align-items: center; gap: var(--g-s2);
  flex-shrink: 0;
  min-height: calc(var(--g-hit) + env(safe-area-inset-top));
  padding: calc(6px + env(safe-area-inset-top)) var(--g-s3) 6px;
  border-bottom: 1px solid var(--g-line); background: var(--g-bg-2);
}
.shell[data-menu="0"] .topbar { display: none; }
.shell[data-menu="0"] [data-act="toggleMenu"] { display: none; }
.topbar .title { flex: 1; font-size: 17px; font-weight: 650; letter-spacing: -.02em; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.iconbtn {
  display: grid; place-items: center; width: var(--g-hit); height: var(--g-hit);
  border-radius: var(--g-r); color: var(--g-accent); flex: 0 0 var(--g-hit);
}
.iconbtn[hidden] { display: none; }
.iconbtn:hover { background: var(--g-surface); }
.iconbtn:active { background: color-mix(in srgb, var(--g-accent) 16%, var(--g-surface)); transform: scale(.94); }

.tabs {
  position: relative;
  display: flex; border-top: 1px solid var(--g-line);
  background: var(--g-bg-2);
  padding-bottom: env(safe-area-inset-bottom);
  flex-wrap: nowrap;
  flex-shrink: 0;
}
/* One indicator that slides between four equal tabs. The four transforms below
 * are the only place tab order is encoded in CSS; TABS is the source of truth. */
.tabs::before {
  content: ''; position: absolute; top: -1px; left: 0; width: 25%; height: 2px;
  background: var(--g-accent); border-radius: 0 0 2px 2px;
  transition: transform .32s var(--g-ease-out);
}
.shell[data-tab="home"] .tabs::before { transform: translateX(0); }
.shell[data-tab="camera"] .tabs::before { transform: translateX(100%); }
.shell[data-tab="activity"] .tabs::before { transform: translateX(200%); }
.shell[data-tab="more"] .tabs::before { transform: translateX(300%); }
.shell[data-nav="rail"] .tabs { display: none; }
.tabs button {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 3px;
  min-height: 51px; padding: 8px 2px 6px; font-size: 10.5px; font-weight: 560;
  letter-spacing: .01em; color: var(--g-faint); position: relative;
}
.tabs button ha-icon {
  --mdc-icon-size: 22px;
  transition: transform .28s var(--g-ease-out);
}
.tabs button[aria-current="page"] { color: var(--g-accent); font-weight: 650; }
.tabs button[aria-current="page"] ha-icon { transform: translateY(-1px) scale(1.06); }
.tabs button:active ha-icon { transform: scale(.9); }
.tabs button .dot {
  position: absolute; top: 6px; right: calc(50% - 14px);
  width: 7px; height: 7px; border-radius: 50%; background: var(--g-warn);
  box-shadow: 0 0 0 2px var(--g-bg-2);
}

[data-status] { flex-shrink: 0; }
.status {
  position: relative;
  display: flex; align-items: center; gap: var(--g-s4);
  padding: 14px var(--g-s4) 14px calc(var(--g-s4) - 3px);
  border-bottom: 1px solid var(--g-line);
  background: var(--g-surface);
  border-left: 3px solid transparent;
  transition: background-color .45s var(--g-ease), border-left-color .45s var(--g-ease);
}
.status .copy { flex: 1; min-width: 0; }
.status .eyebrow {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  color: var(--tone, var(--g-dim));
}
.status .eyebrow i {
  width: 7px; height: 7px; border-radius: 50%; background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 20%, transparent);
}
.status[data-live="1"] .eyebrow i { animation: gBlink 2.6s var(--g-ease) infinite; }
.status h1 {
  margin: 5px 0 0; font-size: 19px; font-weight: 660; letter-spacing: -.024em; line-height: 1.18;
  text-wrap: balance;
}
.status p { margin: 5px 0 0; font-size: 13.5px; line-height: 1.45; color: var(--g-dim); max-width: 54ch; }
.status .acts { display: flex; flex-wrap: wrap; gap: var(--g-s2); margin-top: 11px; }
.pinpad { margin-top: 12px; max-width: 240px; }
.pinpad .pindots {
  display: flex; gap: 8px; justify-content: center; margin-bottom: 10px;
}
.pinpad .pindots i {
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--g-line-2);
  box-shadow: inset 0 0 0 1px var(--g-line);
}
.pinpad .pindots i.on { background: var(--tone, var(--g-warn)); }
.pinpad .pinerr {
  margin: 0 0 8px; font-size: 13px; color: var(--g-alarm); text-align: center;
}
.pinpad .pinkeys {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
}
.pinpad .pinkeys .btn { min-height: 44px; padding: 8px 0; }
/* Status colour is an edge, a dot and a word. The only wash in the panel is the
 * alarm one, and it is the message. */
.status[data-tone="alarm"] {
  border-left-color: var(--g-alarm);
  background: color-mix(in srgb, var(--g-alarm) 8%, var(--g-surface));
}
.status[data-tone="warn"] { border-left-color: var(--g-warn); }
.status[data-tone="elev"] { border-left-color: var(--g-elev); }
.status[data-tone="pass"] { border-left-color: var(--g-pass); }
.status[data-tone="info"] { border-left-color: var(--g-info); }
.status[data-tone="alarm"][data-pulse="1"] { animation: statusPulse 2s ease-in-out infinite; }
@keyframes statusPulse {
  0%, 100% { background: color-mix(in srgb, var(--g-alarm) 8%, var(--g-surface)); }
  50% { background: color-mix(in srgb, var(--g-alarm) 17%, var(--g-surface)); }
}
@container guardian (max-width: 520px) {
  .status { flex-direction: column; align-items: flex-start; gap: var(--g-s2); }
}

.pagehead {
  display: flex; align-items: center; gap: var(--g-s2); margin-bottom: var(--g-s5);
}
.pagehead h1 { margin: 0; font-size: 26px; font-weight: 680; letter-spacing: -.03em; flex: 1;
  line-height: 1.1; }
.pagehead .back { color: var(--g-accent); font-size: 15px; font-weight: 550; min-height: var(--g-hit);
  padding: 0 10px 0 0; display: inline-flex; align-items: center; gap: 2px; border-radius: var(--g-r); }
.pagehead .back:hover { background: var(--g-surface); }
.pagehead .back:active { background: color-mix(in srgb, var(--g-accent) 14%, var(--g-surface)); transform: translateX(-2px); }

.stack { display: flex; flex-direction: column; gap: var(--g-s5); }
.home-pair { display: grid; gap: var(--g-s3); grid-template-columns: 1fr; }
@container guardian (min-width: 700px) { .home-pair { grid-template-columns: 1fr 1fr; } }
.span-all { grid-column: 1 / -1; }

.group {
  background: var(--g-surface); border-radius: var(--g-r-lg);
  border: 1px solid var(--g-line);
  box-shadow: var(--g-shadow);
  overflow: hidden;
}
.group > .hd {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--g-s2);
  padding: 15px var(--g-gp) 0;
}
.group > .hd h2 {
  margin: 0; font-size: 10.5px; font-weight: 700; color: var(--g-faint); flex: 1;
  letter-spacing: .1em; text-transform: uppercase;
}
.group > .hd .hint { font-size: 12px; color: var(--g-faint); font-weight: 520; flex: 1 1 14em; line-height: 1.35; }
.group > .bd { padding: 4px var(--g-gp) 14px; display: flex; flex-direction: column; }
.group > .bd.pad { padding: 14px var(--g-gp) 18px; gap: 14px; }
.group-label {
  margin: 0 6px 10px; font-size: 10.5px; font-weight: 700; color: var(--g-faint);
  letter-spacing: .1em; text-transform: uppercase;
}

.ring { position: relative; width: 60px; height: 60px; flex: 0 0 60px; }
.ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-linecap: round; }
.ring .track { stroke: var(--g-line-2); }
.ring .halo { stroke: color-mix(in srgb, var(--tone) 22%, transparent); }
.ring .prog { stroke: var(--tone); transition: stroke-dashoffset .95s linear; }
.ring .val {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-variant-numeric: tabular-nums; font-weight: 680; letter-spacing: -.04em;
  font-size: 16px; line-height: 1;
}

.pill {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  padding: 3.5px 9px; border-radius: var(--g-r-sm);
  font-size: 11.5px; font-weight: 620; letter-spacing: .005em; white-space: nowrap;
  color: var(--tone); background: color-mix(in srgb, var(--tone) 13%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 14%, transparent);
}
.pill.plain { background: var(--g-surface-2); color: var(--g-dim); box-shadow: none; }
.pill ha-icon { --mdc-icon-size: 14px; }
.pill .led {
  width: 6px; height: 6px; border-radius: 50%; background: currentColor;
  box-shadow: 0 0 0 2.5px color-mix(in srgb, currentColor 22%, transparent);
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
button.chip {
  font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 999px;
  border: 1px solid var(--g-line); background: var(--g-surface); color: inherit;
  cursor: pointer;
}
button.chip[aria-pressed="true"] { border-color: var(--g-ok); }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  min-height: var(--g-hit); padding: 10px 16px; border-radius: var(--g-r);
  font-size: 15px; font-weight: 600; letter-spacing: -.012em;
  background: var(--g-surface-2); border: 1px solid var(--g-line);
}
.btn:hover { background: var(--g-surface-3); }
.btn:active {
  transform: scale(.968);
  background: color-mix(in srgb, var(--g-accent) 18%, var(--g-surface-3));
}
.btn ha-icon { --mdc-icon-size: 18px; }
.btn.tone { color: var(--tone); border-color: color-mix(in srgb, var(--tone) 30%, var(--g-line));
  background: color-mix(in srgb, var(--tone) 7%, var(--g-surface-2)); }
.btn.solid {
  background: var(--g-accent); border-color: transparent; color: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,.1), 0 6px 14px -10px color-mix(in srgb, var(--g-accent) 80%, black);
}
.btn.solid:hover { filter: brightness(1.07); }
.btn.solid:active { filter: brightness(.92); transform: scale(.968); box-shadow: none; }
.btn.wide { width: 100%; }
.btn[disabled] { opacity: .38; pointer-events: none; }
.btn.sm { min-height: 40px; padding: 8px 14px; font-size: 13px; border-radius: var(--g-r-sm); }

.hold {
  position: relative; overflow: hidden; touch-action: none;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.hold .fill {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: color-mix(in srgb, var(--tone) 30%, transparent);
  transition: width 60ms linear; pointer-events: none;
}
.hold[data-holding="1"] .fill { transition: width var(--hold-ms) linear; width: 100%; }
.hold[data-holding="1"] { border-color: color-mix(in srgb, var(--tone) 55%, var(--g-line)); }
.hold > span, .hold > ha-icon { position: relative; }

/* Rows. Separators start after the leading icon column, iOS-style, so a list of
 * navigation rows reads as one object rather than a stack of boxes. */
.row {
  display: flex; align-items: center; gap: 14px;
  min-width: 0; min-height: 54px; padding: 14px 4px;
  margin: 0 -4px;
  border-radius: var(--g-r-sm);
  position: relative;
  transition: background-color .15s var(--g-ease);
}
.row::after {
  content: ''; position: absolute; left: 4px; right: 4px; bottom: 0; height: 1px;
  background: var(--g-line);
}
.row:last-child::after { display: none; }
.row.has-lead::after { left: 50px; }
.row .lbl { flex: 1; min-width: 0; }
.row .lbl b { display: block; font-size: 15px; font-weight: 530; letter-spacing: -.012em; }
.row .lbl small { display: block; font-size: 12.5px; color: var(--g-faint); margin-top: 2px; line-height: 1.4; }
.row .val { font-size: 14px; font-weight: 530; color: var(--g-dim); font-variant-numeric: tabular-nums;
  text-align: right; max-width: 52%; overflow: visible;
  display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.row .val.tone { color: var(--tone); }
.row.click, .row.nav { cursor: pointer; }
.row.click:hover, .row.nav:hover { background: color-mix(in srgb, var(--g-accent) 7%, transparent); }
.row.click:active, .row.nav:active { background: color-mix(in srgb, var(--g-accent) 13%, transparent); }
.row.nav .chev { color: var(--g-faint); --mdc-icon-size: 20px; flex: 0 0 20px;
  transition: transform .18s var(--g-ease); }
.row.nav:hover .chev { transform: translateX(2px); color: var(--g-dim); }
.row .lead {
  width: 32px; height: 32px; flex: 0 0 32px; display: grid; place-items: center;
  border-radius: var(--g-r-sm); color: var(--tone, var(--g-accent));
  background: color-mix(in srgb, var(--tone, var(--g-accent)) 11%, transparent);
}
.row .lead ha-icon { --mdc-icon-size: 19px; }

.sw {
  position: relative; width: 51px; height: 31px; flex: 0 0 51px; border-radius: var(--g-r-pill);
  background: var(--g-surface-3);
  box-shadow: inset 0 0 0 1px var(--g-line);
  transition: background-color .24s var(--g-ease);
}
.sw i {
  position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.22);
  transition: transform .24s var(--g-ease-out), width .18s var(--g-ease);
}
.sw:active i { width: 31px; }
.sw[data-on="1"] { background: var(--g-accent); box-shadow: none; }
.sw[data-on="1"] i { transform: translateX(20px); }
.sw[data-on="1"]:active i { transform: translateX(16px); }
.sw[data-busy="1"] { opacity: .55; pointer-events: none; }

.seg {
  display: flex; gap: 2px; padding: 3px; border-radius: var(--g-r);
  background: var(--g-surface-2); box-shadow: inset 0 0 0 1px var(--g-line);
}
.seg button {
  flex: 1; min-height: 40px; padding: 8px 12px; border-radius: var(--g-r-xs);
  font-size: 13px; font-weight: 600; color: var(--g-dim); white-space: nowrap;
}
.seg button:hover { color: var(--g-text); }
.seg button:active { background: color-mix(in srgb, var(--g-accent) 14%, var(--g-surface)); }
.seg button[aria-pressed="true"] {
  background: var(--g-surface); color: var(--g-text);
  box-shadow: 0 1px 2px rgba(0,0,0,.07), 0 0 0 1px var(--g-line);
}
.seg.block { flex-wrap: wrap; }
.seg.days button {
  min-width: 0; padding: 8px 6px; font-size: 12.5px;
}
.seg.days button[aria-pressed="true"] {
  background: color-mix(in srgb, var(--tone) 16%, var(--g-surface));
  color: var(--tone);
  box-shadow: 0 1px 2px rgba(0,0,0,.07), 0 0 0 1px color-mix(in srgb, var(--tone) 28%, var(--g-line));
}

.activity-filters {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px;
  padding: 3px;
  margin-bottom: 12px;
  border-radius: var(--g-r);
  background: var(--g-surface-2);
  box-shadow: inset 0 0 0 1px var(--g-line);
}
.activity-filters button {
  min-height: 40px;
  padding: 8px 4px;
  border-radius: var(--g-r-xs);
  font-size: 12px;
  font-weight: 600;
  color: var(--g-dim);
  white-space: nowrap;
}
.activity-filters button:hover { color: var(--g-text); }
.activity-filters button:active { background: color-mix(in srgb, var(--g-accent) 14%, var(--g-surface)); }
.activity-filters button[aria-pressed="true"] {
  background: var(--g-surface); color: var(--g-text);
  box-shadow: 0 1px 2px rgba(0,0,0,.07), 0 0 0 1px var(--g-line);
}
@container guardian (min-width: 560px) {
  .activity-filters { grid-template-columns: repeat(7, 1fr); }
  .activity-filters button { font-size: 13px; padding: 8px 12px; }
}

.activity-day {
  display: flex;
  align-items: stretch;
  gap: 2px;
  margin-bottom: 12px;
  padding: 3px;
  border-radius: var(--g-r);
  background: var(--g-surface-2);
  box-shadow: inset 0 0 0 1px var(--g-line);
}
.activity-day .label {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 15px;
  font-weight: 620;
  letter-spacing: -.01em;
  padding: 0 10px;
}
.activity-day .btn {
  flex: 0 0 40px;
  width: 40px;
  min-width: 40px;
  min-height: 40px;
  padding: 0 0 3px;
  display: grid;
  place-items: center;
  font-size: 20px;
  font-weight: 500;
  line-height: 0;
  letter-spacing: 0;
  color: var(--g-accent);
  background: var(--g-surface);
  border-color: transparent;
  box-shadow: 0 1px 2px rgba(0,0,0,.07), 0 0 0 1px var(--g-line);
}
.activity-day .btn[disabled] {
  background: transparent;
  box-shadow: none;
}

.activity-foot {
  display: flex;
  flex-direction: column;
  gap: var(--g-s5);
  margin-top: var(--g-s5);
  padding-bottom: var(--g-s5);
}

.numctl { display: flex; align-items: center; gap: var(--g-s3); padding: 6px 0 12px; }
.numctl .stepper {
  display: flex; align-items: center; gap: 2px; padding: 2px;
  border-radius: var(--g-r); background: var(--g-surface-2);
  box-shadow: inset 0 0 0 1px var(--g-line);
}
.numctl .stepper button {
  width: 40px; height: 40px; border-radius: var(--g-r-xs); display: grid; place-items: center;
  color: var(--g-accent); font-size: 20px; font-weight: 500; line-height: 1;
}
.numctl .stepper button:active { background: color-mix(in srgb, var(--g-accent) 16%, transparent); transform: scale(.9); }
.numctl .stepper .n {
  min-width: 56px; text-align: center; font-size: 15px; font-weight: 660;
  font-variant-numeric: tabular-nums; letter-spacing: -.02em;
}
.numctl input[type=range] {
  flex: 1; -webkit-appearance: none; appearance: none; height: 5px; border-radius: 3px;
  background: var(--g-surface-3); outline: none;
}
.numctl input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%;
  background: var(--g-accent); border: 3px solid var(--g-surface); cursor: grab;
  box-shadow: 0 1px 4px rgba(0,0,0,.22);
}
.numctl input[type=range]::-moz-range-thumb {
  width: 16px; height: 16px; border-radius: 50%; background: var(--g-accent);
  border: 3px solid var(--g-surface); cursor: grab;
}

.field {
  width: 100%; min-height: var(--g-hit); padding: 10px 13px; border-radius: var(--g-r);
  background: var(--g-surface-2); border: 1px solid var(--g-line);
  color: var(--g-text); font-size: 15px; margin: 4px 0 10px;
  transition: border-color .15s var(--g-ease), box-shadow .15s var(--g-ease);
}
.field.mono { font-family: var(--g-mono); font-size: 13px; }
.field:focus { outline: none; border-color: var(--g-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-accent) 16%, transparent); }
.field[data-dirty="1"] { border-color: var(--g-accent); }
.notify-pick {
  display: flex; flex-direction: column; gap: 6px;
  margin: 10px 0 4px; color: var(--g-dim); font-size: 13px; font-weight: 600;
}
.notify-pick .field { margin: 0; appearance: auto; }
.notify-hint {
  margin: 6px 0 0; font-size: 13px; font-weight: 400; color: var(--g-dim);
}
.notify-hint.tone { color: var(--tone); }
.savefield { display: flex; gap: 10px; align-items: stretch; margin: 4px 0 14px; }
.savefield .field { flex: 1; margin: 0; min-width: 0; }
.savefield .btn { flex: 0 0 auto; min-width: 84px; }
.savefield .livehint {
  flex: 0 0 auto; min-width: 72px; display: grid; place-items: center;
  padding: 0 10px; border-radius: var(--g-r); font-size: 12px; font-weight: 650;
  letter-spacing: .01em; color: var(--g-faint); background: var(--g-surface-2);
  border: 1px solid var(--g-line); white-space: nowrap;
}
.savefield .livehint[data-state="saving"] { color: var(--g-accent); border-color: color-mix(in srgb, var(--g-accent) 40%, var(--g-line)); }
.savefield .livehint[data-state="saved"] { color: var(--g-ok); border-color: color-mix(in srgb, var(--g-ok) 40%, var(--g-line)); }
.savefield .livehint[data-state="error"] { color: var(--g-alarm); border-color: color-mix(in srgb, var(--g-alarm) 40%, var(--g-line)); }
.slot .savefield { margin: 0; }

/* The key card. Group chrome plus a tone edge, a header band on surface-2 and a
 * body of labelled fields - the same shape as every other card in the panel,
 * where this one used to be a flat stack of unlabelled controls. */
.slots { display: grid; gap: var(--g-s3); grid-template-columns: 1fr; }
@container guardian (min-width: 620px) { .slots { grid-template-columns: 1fr 1fr; } }
.slot {
  border-radius: var(--g-r-lg); overflow: hidden;
  background: var(--g-surface); display: flex; flex-direction: column;
  border: 1px solid var(--g-line); border-top: 3px solid var(--tone);
  box-shadow: var(--g-shadow);
  transition: box-shadow .2s var(--g-ease), border-color .2s var(--g-ease);
  /* Its own container, so the action pair collapses on the CARD's width. The
   * panel-level query cannot see it: at 620px the rack goes two-up and each
   * card is half as wide as the container being measured. */
  container-type: inline-size; container-name: slot;
}
.slot:hover { border-color: var(--g-line-2); border-top-color: var(--tone); box-shadow: var(--g-shadow-lift); }
.slot[data-target="1"] {
  border-color: var(--g-accent); border-top-color: var(--g-accent);
  box-shadow: 0 0 0 1px var(--g-accent), var(--g-shadow-lift);
}
.slot-hd {
  display: flex; align-items: center; gap: var(--g-s3); min-width: 0;
  padding: 13px var(--g-gp);
  background: var(--g-surface-2); border-bottom: 1px solid var(--g-line);
}
/* The dot's ring has to match whatever it sits on, and in the header band that
 * is surface-2, not surface. */
.slot-hd .avatar .dot { border-color: var(--g-surface-2); }
.slot-hd .who { min-width: 0; }
.slot-hd .who b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slot-badges { margin-left: auto; display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; }
.slot-bd { display: flex; flex-direction: column; gap: var(--g-s4); padding: var(--g-s4) var(--g-gp) 18px; }
.sfield { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.slabel {
  font-size: 10.5px; font-weight: 700; color: var(--g-faint);
  letter-spacing: .1em; text-transform: uppercase;
}
.sfield .field { margin: 0; appearance: auto; }
.sfield .savefield { margin: 0; }
.sfield .notify-hint { margin: 0; }
/* Send test alert and Hold: stolen, one row, equal height, at every width. Two
 * equal tracks rather than flex so the pair cannot go ragged when one label
 * wraps; minmax(0,1fr) lets a long phone-era label shrink instead of pushing
 * the card into a horizontal scroll. */
.slot-foot { display: flex; flex-direction: column; gap: var(--g-s2); }
.slot-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--g-s2); align-items: stretch; }
.slot-actions > .btn { width: 100%; min-width: 0; }
.slot-actions > .btn > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
@container slot (max-width: 320px) { .slot-actions { grid-template-columns: 1fr; } }

.avatar {
  width: 38px; height: 38px; flex: 0 0 38px; border-radius: 50%; display: grid; place-items: center;
  font-size: 12.5px; font-weight: 700; letter-spacing: .01em;
  background: color-mix(in srgb, var(--tone, var(--g-idle)) 14%, var(--g-surface-2));
  color: color-mix(in srgb, var(--tone, var(--g-idle)) 78%, var(--g-text));
  position: relative;
}
.avatar .dot {
  position: absolute; right: -1px; bottom: -1px; width: 11px; height: 11px; border-radius: 50%;
  background: var(--tone); border: 2.5px solid var(--g-surface);
}

.rack { display: flex; gap: 6px; flex-wrap: wrap; }
.rack .k {
  flex: 1 0 28px; min-width: 28px; height: 28px; border-radius: var(--g-r-sm);
  display: grid; place-items: center; font-size: 11px; font-weight: 650;
  background: var(--g-surface-2); color: var(--g-faint);
}
.rack .k[data-full="1"] { background: color-mix(in srgb, var(--g-ok) 14%, var(--g-surface-2)); color: var(--g-ok); }
.rack .k[data-target="1"] { outline: 2px solid var(--g-accent); color: var(--g-accent); }

/* The device rack on Home. Same four subsystems the eleventh pass listed as
 * health cells - portal, doorbell, camera, door sensing - same entities, same
 * tap-through. The twenty-fourth pass gave the render its own lit well and the
 * cell a tone edge, so Home and the Devices gallery read as one system rather
 * than as two different treatments of the same three objects. */
.health { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--g-s2); }
@container guardian (min-width: 560px) { .health { grid-template-columns: repeat(4, 1fr); } }
.hcell {
  display: flex; flex-direction: column; align-items: stretch; gap: 8px;
  padding: 10px 10px 11px;
  border-radius: var(--g-r-lg); background: var(--g-surface);
  border: 1px solid var(--g-line); border-top: 3px solid var(--tone);
  box-shadow: var(--g-shadow);
  min-height: var(--g-hit); cursor: pointer; text-align: left;
  transition: border-color .18s var(--g-ease), transform .16s var(--g-ease), box-shadow .18s var(--g-ease);
}
.hcell:hover { border-color: var(--g-line-2); border-top-color: var(--tone); box-shadow: var(--g-shadow-lift); }
.hcell:active { transform: scale(.978); }
.hcell .art {
  height: 82px; display: grid; place-items: center; pointer-events: none;
  border-radius: var(--g-r-sm); padding: 4px;
  background:
    radial-gradient(74% 54% at 50% 14%, color-mix(in srgb, var(--tone) 11%, transparent), transparent 70%),
    radial-gradient(58% 28% at 50% 100%, color-mix(in srgb, var(--g-text) 8%, transparent), transparent 72%),
    var(--g-surface-2);
  overflow: hidden;
}
.hcell .art svg { height: 100%; width: auto; max-width: 100%; display: block; }
.hcell .cap { display: flex; align-items: center; gap: 7px; min-width: 0; }
.hcell .led {
  width: 7px; height: 7px; border-radius: 50%; background: var(--tone); flex: 0 0 7px;
  box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--tone) 20%, transparent);
}
.hcell .t { min-width: 0; }
.hcell .t b { display: block; font-size: 13px; font-weight: 620; letter-spacing: -.01em; }
.hcell .t small { display: block; font-size: 11px; color: var(--g-faint); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.cam {
  position: relative; border-radius: var(--g-r-lg); overflow: hidden;
  background: #0E0F11; aspect-ratio: 16 / 9; display: grid; place-items: center;
  border: 1px solid var(--g-line); box-shadow: var(--g-shadow);
}
.cam img,
.cam ha-camera-stream,
.cam video {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.cam ha-camera-stream { min-width: 0; min-height: 0; }
.cam .ph { color: #9A9A9F; font-size: 14px; text-align: center; padding: var(--g-s4); line-height: 1.5; }
.cam .ov { position: absolute; left: 10px; top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
.cam .ov .pill {
  background: rgba(8,8,10,.66); color: #fff;
  font-size: 12.5px; font-weight: 650; padding: 6px 10px;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.09);
}
.cam .ov .pill .led { color: var(--tone); }
.cam .ov .pill.plain { background: rgba(8,8,10,.66); color: #fff; }
/* A one-off vignette so a dark frame does not fight the overlay pills. */
.cam::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(0,0,0,.24), rgba(0,0,0,0) 34%);
}
.cam:has(.ph)::after { opacity: 0; }

.peek { cursor: pointer; }
[data-cam]:not(:empty) { margin-bottom: var(--g-s5); }
.cam-tools { display: flex; flex-direction: column; align-items: stretch; gap: 12px; margin-top: 14px; }
.activity-more { margin: 0; }
.cam-tools .seg { width: 100%; }
.cam-tools .acts { display: flex; flex-wrap: wrap; gap: 12px; }
.cam-tools .acts .btn { flex: 1 1 108px; min-height: 44px; padding: 10px 16px; }

.snapstrip { display: flex; gap: 8px; overflow-x: auto; padding: 4px 0 8px; }
.snapstrip button {
  flex: 0 0 auto; width: 112px; border-radius: var(--g-r); overflow: hidden;
  background: var(--g-surface-2); text-align: left;
}
.snapstrip img { width: 112px; height: 72px; object-fit: cover; display: block; background: #111; }
.snapstrip span { display: block; padding: 6px 8px; font-size: 11px; color: var(--g-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.tl { display: flex; flex-direction: column; }
.tl .day {
  font-size: 10.5px; font-weight: 700; color: var(--g-faint); padding: var(--g-s4) 4px var(--g-s2);
  letter-spacing: .1em; text-transform: uppercase;
  position: sticky; top: -1px; background: var(--g-bg); z-index: 1;
}
.ev { display: flex; gap: var(--g-s3); padding: 10px 0; position: relative; }
.ev::before {
  content: ''; position: absolute; left: 15px; top: 0; bottom: 0; width: 1px;
  background: var(--g-line);
}
.ev:first-of-type::before { top: 16px; }
.ev:last-child::before { bottom: calc(100% - 16px); }
.ev .dot {
  width: 31px; height: 31px; flex: 0 0 31px; border-radius: 50%; display: grid; place-items: center;
  background: color-mix(in srgb, var(--tone) 12%, var(--g-surface));
  box-shadow: 0 0 0 3px var(--g-bg);
  color: var(--tone); position: relative; z-index: 1;
}
.ev .dot ha-icon { --mdc-icon-size: 16px; }
.ev[data-live="1"] .dot { box-shadow: 0 0 0 3px var(--g-bg), inset 0 0 0 1px color-mix(in srgb, var(--tone) 40%, transparent); }
.ev .body { flex: 1; min-width: 0; padding-top: 4px; }
.ev .body b { font-size: 15px; font-weight: 530; letter-spacing: -.01em; }
.ev .body small { display: block; font-size: 12.5px; color: var(--g-faint); margin-top: 2px; line-height: 1.45; }
.ev .when { font-size: 12px; color: var(--g-faint); font-variant-numeric: tabular-nums; padding-top: 7px; white-space: nowrap; }

.scrim { position: fixed; inset: 0; background: rgba(6,6,8,.58); z-index: 50;
  animation: gFade .18s var(--g-ease); }
.sheet {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 51;
  background: var(--g-surface); border-radius: var(--g-r-xl) var(--g-r-xl) 0 0;
  padding: var(--g-s4) var(--g-s4) calc(var(--g-s5) + env(safe-area-inset-bottom));
  max-height: 82vh; overflow-y: auto;
  border-top: 3px solid var(--tone);
  box-shadow: 0 -18px 50px -24px rgba(0,0,0,.5);
  animation: sheetUp .28s var(--g-ease-out);
}
@keyframes sheetUp { from { transform: translateY(18px); opacity: 0; } to { transform: none; opacity: 1; } }
@container guardian (min-width: 700px) {
  .sheet {
    left: 50%; right: auto; bottom: auto; top: 50%;
    transform: translate(-50%, -50%); width: min(520px, 92cqw);
    border-radius: var(--g-r-lg);
    animation: none;
  }
}
.sheet .grab { width: 36px; height: 4px; border-radius: 2px; background: var(--g-line-2);
  margin: -4px auto var(--g-s4); }
@container guardian (min-width: 700px) { .sheet .grab { display: none; } }
.sheet h3 { margin: 0 0 6px; font-size: 19px; font-weight: 660; letter-spacing: -.02em; }
.sheet p { margin: 0 0 var(--g-s4); font-size: 15px; line-height: 1.5; color: var(--g-dim); }

.note {
  display: flex; gap: 10px; padding: 12px 14px; border-radius: var(--g-r);
  background: color-mix(in srgb, var(--tone) 7%, var(--g-surface));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 16%, var(--g-line));
  font-size: 13px; line-height: 1.5; color: var(--g-dim);
}
.note ha-icon { --mdc-icon-size: 18px; color: var(--tone); flex: 0 0 auto; }
.note b { color: var(--g-text); font-weight: 620; }
.mono { font-family: var(--g-mono); font-size: 12px; }
.empty { text-align: center; padding: var(--g-s6) var(--g-s4); color: var(--g-faint); font-size: 15px; line-height: 1.5; }
.empty ha-icon { --mdc-icon-size: 32px; display: block; margin: 0 auto var(--g-s3); opacity: .4; }
.stat { display: flex; align-items: baseline; gap: 8px; padding: 8px 0 6px; flex-wrap: wrap; }
.stat b { font-size: 30px; font-weight: 670; letter-spacing: -.035em; font-variant-numeric: tabular-nums;
  line-height: 1.05; }
.stat span { font-size: 13.5px; color: var(--g-faint); font-weight: 520; }
.danger-zone { border-color: color-mix(in srgb, var(--g-alarm) 32%, var(--g-line)); }
.who b { display: block; font-size: 16px; font-weight: 620; letter-spacing: -.015em; }
.who small { display: block; font-size: 12px; color: var(--g-faint); margin-top: 2px; }

.wheel-wrap { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 4px 0 8px; }
.wheel {
  position: relative;
  width: min(260px, 72vw);
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(circle at center, #fff 0%, rgba(255,255,255,0) 68%),
    conic-gradient(from 90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  box-shadow: inset 0 0 0 1px var(--g-line);
  touch-action: none;
  cursor: crosshair;
}
:host([data-scheme="dark"]) .wheel {
  background:
    radial-gradient(circle at center, #2c2c2e 0%, rgba(44,44,46,0) 68%),
    conic-gradient(from 90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
}
.wheel .knob {
  position: absolute;
  width: 22px; height: 22px; border-radius: 50%;
  border: 3px solid #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,.35);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.swatches { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.swatch {
  width: 36px; height: 36px; border-radius: 50%;
  border: 2px solid var(--g-line);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.08);
}
.swatch:active { transform: scale(.94); }
.swatch[aria-pressed="true"] { border-color: var(--g-accent); box-shadow: 0 0 0 2px var(--g-accent); }
.lamp-dot {
  width: 18px; height: 18px; border-radius: 50%;
  border: 2px solid var(--g-line-2);
  flex: 0 0 18px;
  cursor: pointer;
  transition: transform .12s var(--g-ease), background-color .4s var(--g-ease);
}
.lamp-dot:active { transform: scale(.9); }
.kelvin-track {
  flex: 1; -webkit-appearance: none; appearance: none; height: 8px; border-radius: 4px; outline: none;
  background: linear-gradient(90deg, #ffb36b, #fff4e0, #cfe8ff);
}

/* A setting drawn as the thing it controls. Locked (the default) lets a phone
 * scroll the page over it; the padlock unlocks the drawing to drag. */
.tune {
  display: block; width: 100%; margin: 2px 0 6px;
  position: relative;
  border-radius: var(--g-r); background: var(--g-surface-2);
  box-shadow: inset 0 0 0 1px var(--g-line);
  padding: 10px 12px 4px;
  touch-action: pan-y; cursor: default; user-select: none; -webkit-user-select: none;
}
.tune svg {
  display: block; margin: 0 auto; width: 100%; height: auto; max-height: 215px; overflow: hidden;
  pointer-events: none;
}
.tune[data-unlocked="1"] {
  touch-action: none; cursor: grab;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-accent) 55%, var(--g-line)),
    0 0 0 3px color-mix(in srgb, var(--g-accent) 22%, transparent);
}
.tune[data-unlocked="1"] svg { pointer-events: auto; }
.tune[data-unlocked="1"].tune--dragging,
.tune[data-unlocked="1"]:active { cursor: grabbing; }
.tune:focus { outline: none; }
.tune:focus-visible {
  box-shadow: inset 0 0 0 1px var(--g-line), 0 0 0 3px color-mix(in srgb, var(--g-accent) 30%, transparent);
}
.tune[data-unlocked="1"]:focus-visible {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-accent) 55%, var(--g-line)),
    0 0 0 3px color-mix(in srgb, var(--g-accent) 30%, transparent);
}
.tune-lock {
  position: absolute; top: 4px; right: 4px; z-index: 2;
  display: grid; place-items: center;
  width: var(--g-hit); height: var(--g-hit);
  border-radius: var(--g-r);
  color: var(--g-dim);
  background: color-mix(in srgb, var(--g-surface) 92%, transparent);
  padding: 0;
  touch-action: manipulation;
  cursor: pointer;
}
.tune-lock:hover { background: var(--g-surface); color: var(--g-accent); }
.tune-lock:active { transform: scale(.94); }
.tune-lock ha-icon { --mdc-icon-size: 20px; }
.tune[data-unlocked="1"] .tune-lock {
  color: var(--g-accent);
  background: color-mix(in srgb, var(--g-accent) 12%, var(--g-surface));
}
/* The door under the gauge is cropped into, so it must clip to its viewBox -
 * the leaf is several times the size of the frame and would otherwise run out
 * across the card and the one beside it. The height cap keeps three of these in
 * one card from turning the page into a scroll; past it the drawing centres and
 * letterboxes, which _tuneUnits accounts for. */
.tune .grab { cursor: grab; }
.tune .ghost { opacity: .28; }
.tunesay {
  margin: 6px 2px 8px; font-size: 12.5px; line-height: 1.45; color: var(--g-faint);
  cursor: auto; touch-action: pan-y;
}
.tunesay b { color: var(--g-text); font-weight: 620; font-variant-numeric: tabular-nums; }

/* A tuner that carries two values - the lamp's dark and bright thresholds are
 * one hysteresis band, and the gap between them is the setting. role="slider"
 * takes one value, so with two thumbs the container is a group and each thumb
 * is its own slider, focusable and arrow-keyable in the drawing where it sits.
 * The two bare steppers underneath remain the precise path, exactly as on the
 * single-value tuners. */
.tune[role="group"] { cursor: default; }
.tune[data-unlocked="1"][role="group"] { cursor: grab; }
.tune [data-thumb] { cursor: grab; outline: none; }
.tune [data-thumb] .halo { opacity: 0; transition: opacity .12s var(--g-ease); }
.tune[data-unlocked="1"] [data-thumb] .halo { opacity: .4; }
.tune [data-thumb]:focus-visible .halo { opacity: 1; }
.tune[data-tune="hours"] [data-band],
.tune[data-tune="hours"] [data-band2],
.tune[data-tune="hours"] [data-band3],
.tune[data-tune="hours"] [data-knob],
.tune[data-tune="hours"] .halo {
  transition: x .22s var(--g-ease), width .22s var(--g-ease), opacity .2s var(--g-ease);
}
.tune--dragging[data-tune="hours"] [data-band],
.tune--dragging[data-tune="hours"] [data-band2],
.tune--dragging[data-tune="hours"] [data-band3],
.tune--dragging[data-tune="hours"] [data-knob],
.tune--dragging[data-tune="hours"] .halo { transition: none; }

/* A read-only drawing inside a card: same materials and padding as .tune, but
 * it is not a control and must not look grabbable or claim a gesture. */
.illstage {
  display: block; width: 100%; margin: 2px 0 6px;
  border-radius: var(--g-r); background: var(--g-surface-2);
  box-shadow: inset 0 0 0 1px var(--g-line);
  padding: 10px 12px 4px;
}
.illstage svg { display: block; margin: 0 auto; width: 100%; height: auto; max-height: 215px; overflow: hidden; }
.illsay {
  margin: 6px 2px 8px; font-size: 12.5px; line-height: 1.45; color: var(--g-faint);
}
.illsay b { color: var(--g-text); font-weight: 620; font-variant-numeric: tabular-nums; }

/* The what-if probes. Deliberately plain range inputs: the two drawings above
 * already carry the geometry, and a probe is a scratch value rather than a
 * setting, so it does not get a grab handle of its own. */
.probe { display: grid; gap: 2px; margin: 2px 0 10px; }
.probe label {
  display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
  font-size: 12.5px; color: var(--g-faint); font-weight: 560;
}
.probe label b { color: var(--g-text); font-weight: 620; font-variant-numeric: tabular-nums; }
.probe input[type="range"] { width: 100%; accent-color: var(--tone); }

/* Three small "how far along is the calibrator" meters. */
.meters { display: grid; gap: 9px; margin: 4px 0 6px; }
.meter { display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; align-items: baseline; }
.meter b { font-size: 12.5px; font-weight: 560; color: var(--g-dim); }
.meter span { font-size: 12px; color: var(--g-faint); font-variant-numeric: tabular-nums; }
.meter i {
  grid-column: 1 / -1; height: 4px; border-radius: 2px; background: var(--g-line-2);
  display: block; overflow: hidden;
}
.meter i::after {
  content: ''; display: block; height: 100%; width: var(--fill, 0%);
  border-radius: 2px; background: var(--tone);
}

/* --- Device renders ---------------------------------------------------------
 * The drawings themselves are built in section 8. Everything here is presentation:
 * the stage they sit on, how they read offline, and the four micro-animations
 * they are allowed. A drawing recolours through --tone (status) and --lampc
 * (the lamp's own light) and through nothing else.
 * -------------------------------------------------------------------------- */
.devstage {
  display: grid; place-items: center;
  padding: var(--g-s5) var(--g-s4) var(--g-s4);
  background:
    radial-gradient(120% 80% at 50% 12%, color-mix(in srgb, var(--tone) 9%, transparent), transparent 68%),
    var(--g-surface-2);
  border-radius: var(--g-r-lg);
  border: 1px solid var(--g-line);
  overflow: hidden;
  transition: background .5s var(--g-ease);
}
/* The floor the object stands on. A studio sweep rather than a rule: the
 * render's own contact shadow lands on it, which is what stops these reading
 * as pictures pasted onto a card. */
.devstage .floor {
  width: 100%; display: grid; place-items: center;
  padding-bottom: var(--g-s3);
  background:
    radial-gradient(58% 34% at 50% 100%, color-mix(in srgb, var(--g-text) 7%, transparent), transparent 72%),
    linear-gradient(180deg, transparent 62%, color-mix(in srgb, var(--g-text) 3.5%, transparent) 100%);
}
.devstage .plinth { display: none; }
/* Stat tiles under the render: signal, uptime, and the one live signal that
 * device actually has. Three at most - this is a hero, not a table. */
.devstats {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 1px; width: 100%; margin-top: var(--g-s3);
  background: var(--g-line); border-radius: var(--g-r); overflow: hidden;
}
.devstats .tile {
  background: var(--g-surface); padding: 10px 8px; text-align: center; min-width: 0;
}
.devstats .tile b {
  display: block; font-size: 15px; font-weight: 620; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.devstats .tile small {
  display: block; font-size: 10.5px; font-weight: 700; letter-spacing: .09em;
  text-transform: uppercase; color: var(--g-faint); margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dev { display: block; width: 100%; height: auto; }
.devstage .dev { max-width: 240px; }
.devstage[data-dev="lamp"] .dev, .devstage[data-dev="lens"] .dev { max-width: 360px; }
.devstage[data-dev="doorbell"] .dev { max-width: 290px; }

/* --- Device card ------------------------------------------------------------
 * The unit the gallery and Home are built from: the object, placed; who it is;
 * what it is doing right now; and the chips its own page would lead with. */
.devcard {
  display: grid; grid-template-columns: 104px 1fr 20px; align-items: center;
  gap: var(--g-s3); width: 100%; text-align: left;
  padding: 12px 14px 12px 12px;
  background: var(--g-surface); border: 1px solid var(--g-line);
  border-left: 3px solid var(--tone);
  border-radius: var(--g-r-lg); box-shadow: var(--g-shadow);
  transition: border-color .18s var(--g-ease), transform .16s var(--g-ease),
    box-shadow .18s var(--g-ease), background-color .18s var(--g-ease);
}
.devcard:hover { box-shadow: var(--g-shadow-lift); border-color: var(--g-line-2); border-left-color: var(--tone); }
.devcard:active { transform: scale(.985); }
.devcard + .devcard { margin-top: var(--g-s3); }
.devcard .well {
  height: 92px; display: grid; place-items: center; border-radius: var(--g-r);
  background:
    radial-gradient(72% 52% at 50% 16%, color-mix(in srgb, var(--tone) 10%, transparent), transparent 70%),
    radial-gradient(60% 30% at 50% 100%, color-mix(in srgb, var(--g-text) 8%, transparent), transparent 72%),
    var(--g-surface-2);
  overflow: hidden; padding: 6px;
}
.devcard .well .dev { max-height: 80px; width: auto; max-width: 100%; }
.devcard .meta { min-width: 0; display: block; }
.devcard .eyebrow {
  display: flex; align-items: center; gap: 5px;
  font-size: 10.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
  color: var(--g-faint);
}
.devcard .eyebrow ha-icon { --mdc-icon-size: 14px; color: var(--tone); }
.devcard .meta b {
  display: block; font-size: 15.5px; font-weight: 600; letter-spacing: -.015em; margin-top: 3px;
}
.devcard .meta small {
  display: block; font-size: 12.5px; color: var(--g-dim); margin-top: 2px; line-height: 1.35;
}
.devcard .chips { margin-top: 8px; }
.devcard .chev { color: var(--g-faint); --mdc-icon-size: 20px; transition: transform .16s var(--g-ease); }
.devcard:hover .chev { transform: translateX(2px); color: var(--g-dim); }
@container guardian (max-width: 400px) {
  .devcard { grid-template-columns: 78px 1fr 20px; }
  .devcard .well { height: 76px; }
  .devcard .well .dev { max-height: 66px; }
}

/* --- Signal path ------------------------------------------------------------
 * Two rows: the admission path, and the watching path. A link only lights when
 * that link is carrying something, which is why it is worth drawing at all. */
.sysflow {
  display: flex; align-items: stretch; gap: 2px;
}
.flowlabel {
  font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  color: var(--g-faint); margin-bottom: 7px;
}
.flowlabel.second { margin-top: var(--g-s4); }
.fnode {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center;
  gap: 2px; padding: 10px 4px 9px; border-radius: var(--g-r);
  background: var(--g-surface-2); border: 1px solid var(--g-line); position: relative;
}
.fnode ha-icon { --mdc-icon-size: 21px; color: var(--tone); }
.fnode b {
  font-size: 12px; font-weight: 620; letter-spacing: -.01em; margin-top: 2px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fnode small {
  font-size: 10.5px; color: var(--g-faint); font-weight: 520;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fnode .fdot {
  position: absolute; top: 7px; right: 7px; width: 6px; height: 6px; border-radius: 50%;
  background: var(--tone); box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--tone) 20%, transparent);
}
.flink {
  flex: 0 0 26px; display: grid; place-items: center; position: relative;
}
.flink i {
  display: block; width: 100%; height: 2px; border-radius: 2px;
  background: var(--g-line-2);
}
.flink::after {
  content: ''; position: absolute; right: 1px;
  border: 4px solid transparent; border-left-color: var(--g-line-2);
}
.flink.on i { background: var(--tone); }
.flink.on::after { border-left-color: var(--tone); }
.flink.on i { animation: gFlow 1.6s var(--g-ease) infinite; }
.flink span {
  position: absolute; top: -13px; left: 50%; transform: translateX(-50%);
  font-size: 9.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  color: var(--tone); white-space: nowrap;
}
/* Never wrap. Three nodes and two links always fit one row; below 520px they
 * simply get tighter, because a chain that wraps stops being a chain. */
@container guardian (max-width: 520px) {
  .fnode { padding: 9px 2px 8px; }
  .fnode ha-icon { --mdc-icon-size: 19px; }
  .fnode b { font-size: 11.5px; }
  .fnode small { font-size: 10px; }
  .fnode .fdot { top: 5px; right: 5px; width: 5px; height: 5px; }
  .flink { flex: 0 0 20px; }
  .flink span { display: none; }
}

/* Every drawn part transitions, so a state change reads as the object changing
 * rather than the page repainting. */
.dev .lit, .dev .glass, .dev .screen, .dev .panelglass, .dev .glow, .dev .key {
  transition: fill .45s var(--g-ease), opacity .45s var(--g-ease), stroke .45s var(--g-ease);
}
.dev text { font-family: var(--g-font); }
/* One drawing per device, at two detail levels. The Home rack draws these 74px
 * tall, where screws, key legends, layer lines and specular streaks are all
 * sub-pixel - so they are dropped rather than kept as a second drawing. Form
 * gradients stay, which is what makes a thumbnail still read as an object. */
.dev--sm .fine, .dev--sm .dtl, .dev--sm .tex, .dev--sm .spec { display: none; }
.dev--sm .shadow { opacity: .7; }

/* Offline: the object is still there, it just is not answering. */
.devstage[data-online="0"] .dev, .hcell[data-online="0"] .art .dev,
.devcard[data-online="0"] .well .dev {
  filter: grayscale(1); opacity: .48;
}

/* A status LED with something pending has a slow heartbeat. An idle LED is
 * steady - nothing on this panel animates only because it is on screen. */
.dev .statusled[data-blink="1"] { animation: gBlink 2.8s var(--g-ease) infinite; }

/* Person detection at the lens: two rings, then it stops. This element only
 * exists in the markup while a person is in view, so the animation plays on
 * arrival and never loops in the background. */
.dev .ping { transform-box: view-box; }
.dev .ping1 { animation: gPulseRing 1.5s var(--g-ease-out) 2 both; }
.dev .ping2 { animation: gPulseRing 1.5s var(--g-ease-out) .45s 2 both; }
.dev .chime { transform-box: view-box; transform-origin: 150px 162px; animation: gChime .5s var(--g-ease) 2; }

.devcaption {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  margin-top: var(--g-s3); font-size: 12.5px; color: var(--g-dim); font-weight: 520;
  text-align: center;
}
.devcaption .led {
  width: 7px; height: 7px; border-radius: 50%; background: var(--tone); flex: 0 0 7px;
  box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--tone) 20%, transparent);
}

/* --- Entrance --------------------------------------------------------------
 * .entering is added by the panel element after a NAVIGATION render only, and
 * removed when the run finishes. A state change never re-triggers it, which is
 * the whole point: an alarm arriving must not restage the page.
 * -------------------------------------------------------------------------- */
.entering > .stack > *, .entering > :not(.stack) {
  animation: gEnter .38s var(--g-ease-out) both;
}
.entering > .stack > *:nth-child(1), .entering > :not(.stack):nth-child(1) { animation-delay: 0ms; }
.entering > .stack > *:nth-child(2), .entering > :not(.stack):nth-child(2) { animation-delay: 40ms; }
.entering > .stack > *:nth-child(3), .entering > :not(.stack):nth-child(3) { animation-delay: 78ms; }
.entering > .stack > *:nth-child(4), .entering > :not(.stack):nth-child(4) { animation-delay: 112ms; }
.entering > .stack > *:nth-child(5), .entering > :not(.stack):nth-child(5) { animation-delay: 142ms; }
.entering > .stack > *:nth-child(n+6), .entering > :not(.stack):nth-child(n+6) { animation-delay: 166ms; }
[data-cam].entering-cam > * { animation: gEnter .38s var(--g-ease-out) both; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important;
    transition-duration: .001ms !important; animation-delay: 0ms !important; }
}
`;

/* =============================================================================
 * 5. FORMATTING HELPERS
 * ========================================================================== */

const esc = (s) =>
  String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s);
}

function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = Math.round((now - t) / 1000);
  if (d < 45) return 'just now';
  if (d < 90) return 'a minute ago';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 21600) return `${Math.round(d / 3600)}h ago`;
  const then = new Date(t);
  const sameDay = new Date(now).toDateString() === then.toDateString();
  const hm = hhmm(t);
  if (sameDay) return `today ${hm}`;
  const yest = new Date(now - 86400000).toDateString() === then.toDateString();
  return yest ? `yesterday ${hm}` : `${then.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hm}`;
}

let _hour12 = undefined;
function setTimeFormat(hass) {
  const f = hass && hass.locale && hass.locale.time_format;
  _hour12 = f === '12' ? true : f === '24' ? false : undefined;
}
function hhmm(t) {
  const opts = { hour: '2-digit', minute: '2-digit' };
  if (_hour12 !== undefined) opts.hour12 = _hour12;
  return new Date(t).toLocaleTimeString([], opts);
}

function dayLabel(t, now = Date.now()) {
  const d = new Date(t);
  if (new Date(now).toDateString() === d.toDateString()) return 'Today';
  if (new Date(now - 86400000).toDateString() === d.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

const ACTIVITY_MAX_DAYS = 7;
const ACTIVITY_PAGE_SIZE = 12;

function startOfLocalDay(now = Date.now(), daysAgo = 0) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

function hourWindow(start, end) {
  const p = (h) => String(Math.round(h)).padStart(2, '0') + ':00';
  if (start === end) return 'never (start equals end)';
  return `${p(start)} – ${p(end)}` + (start > end ? ' (over midnight)' : '');
}

function ssHourLabel(h) {
  return String(Math.round(h)).padStart(2, '0') + ':00';
}

/* Super Surveillance programs. Same arithmetic as binary_sensor.guardian_elevated_mode
 * in packages/guardian.yaml: a wrapping window belongs to the start day of that
 * program. The YAML is the authority; this is presentation of that state. Monday = 0,
 * matching now().weekday(). JS getDay() is Sunday = 0, hence the +6. */
const SS_DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SS_DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function ssWeekday(now = new Date()) {
  return (now.getDay() + 6) % 7;
}

/* The rack: every pre-provisioned position, claimed or not. Only capacity
 * arithmetic uses this — how many programs can still be added. */
function ssProgramIds(hass) {
  const raw = st(hass, E.ssPrograms, '');
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/* The programs that exist. sensor.guardian_ss_programs_created holds the only
 * copy of the created predicate (see packages/guardian.yaml); do not rebuild it
 * here from the helpers, or a disabled program would read as deleted. */
function ssCreatedProgramIds(hass) {
  const raw = st(hass, E.ssProgramsCreated, '');
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function ssFreeProgramCount(hass) {
  const made = new Set(ssCreatedProgramIds(hass));
  return ssProgramIds(hass).filter((id) => !made.has(id)).length;
}

function ssWindowMatches(start, end, todayOn, ydayOn, hour) {
  if (start === end) return false;
  if (start < end) return todayOn && start <= hour && hour < end;
  return (todayOn && hour >= start) || (ydayOn && hour < end);
}

function ssDaysOn(p) {
  return p.days.filter((d) => d.on);
}

function ssDaysSummary(p) {
  const on = ssDaysOn(p);
  if (!on.length) return 'No days selected';
  if (on.length === 7) return 'Every day';
  return on.map((d) => d.short).join(' · ');
}

function ssProgramMatches(p, now = new Date()) {
  if (!p.enabled) return false;
  const hour = now.getHours();
  const today = ssWeekday(now);
  const yday = (today + 6) % 7;
  return ssWindowMatches(p.start, p.end, p.days[today].on, p.days[yday].on, hour);
}

function ssProgramNextOpen(p, now = new Date()) {
  if (!p.enabled || p.start === p.end) return null;
  const selected = p.days.map((d) => d.on);
  if (!selected.some(Boolean)) return null;
  const hour = now.getHours();
  const today = ssWeekday(now);
  const yday = (today + 6) % 7;
  if (ssWindowMatches(p.start, p.end, selected[today], selected[yday], hour)) return null;
  for (let i = 0; i < 8; i++) {
    const day = (today + i) % 7;
    if (!selected[day]) continue;
    if (i === 0 && hour >= p.start) continue;
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setMinutes(0);
    d.setHours(p.start);
    d.setDate(d.getDate() + i);
    return d;
  }
  return null;
}

/* Created programs only. Every consumer of m.ssPrograms — the cards, ssNowLine,
 * ssHomeSummary, the Home pill — reduces over this list, so filtering once here
 * is what keeps an unclaimed rack position out of all of them. */
function buildSsPrograms(hass, now = new Date()) {
  return ssCreatedProgramIds(hass).map((id) => {
    const days = SS_DAY_KEYS.map((key, i) => {
      const entity = `input_boolean.guardian_ss_${id}_${key}`;
      return { key, short: SS_DAY_SHORT[i], entity, on: isOn(hass, entity) };
    });
    const enabledEntity = `input_boolean.guardian_ss_${id}_enabled`;
    const nameEntity = `input_text.guardian_ss_${id}_name`;
    const startEntity = `input_number.guardian_ss_${id}_start`;
    const endEntity = `input_number.guardian_ss_${id}_end`;
    const start = Math.round(num(hass, startEntity, 0));
    const end = Math.round(num(hass, endEntity, 5));
    const enabled = isOn(hass, enabledEntity);
    const nameRaw = storedName(st(hass, nameEntity, ''));
    const p = {
      id,
      enabledEntity,
      nameEntity,
      startEntity,
      endEntity,
      days,
      enabled,
      start,
      end,
      nameRaw,
      label: nameRaw || `Program ${id}`,
      empty: start === end,
      wrap: start > end,
    };
    p.daysOn = ssDaysOn(p);
    p.live = p.enabled && !p.empty && p.daysOn.length > 0;
    p.matching = ssProgramMatches(p, now);
    p.nextOpen = ssProgramNextOpen(p, now);
    return p;
  });
}

function ssDayStrip(p) {
  return `<div class="seg days block" style="--tone:var(--g-elev)" role="group"
      aria-label="Days ${esc(p.label)} is scheduled">
    ${p.days.map((d) => `<button data-act="toggle" data-arg="${arg({ id: d.entity, on: !d.on })}"
        aria-pressed="${d.on}" aria-label="${esc(d.short)}">${esc(d.short)}</button>`).join('')}
  </div>`;
}

function ssHomeSummary(programs) {
  const matching = programs.filter((p) => p.matching);
  const live = programs.filter((p) => p.live);
  if (matching.length === 1) return `On now — ${matching[0].label}`;
  if (matching.length > 1) return `On now — ${matching.length} programs`;
  if (!live.length) return 'No programs — only the switch above elevates';
  const next = live
    .map((p) => p.nextOpen)
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  const nextTxt = next ? `next ${ssHourLabel(next.getHours())}` : null;
  if (live.length === 1) {
    return nextTxt
      ? `${live[0].label} · ${nextTxt}`
      : `${ssDaysSummary(live[0])} · ${hourWindow(live[0].start, live[0].end)}`;
  }
  return nextTxt ? `${live.length} programs · ${nextTxt}` : `${live.length} programs`;
}

function uptime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '—';
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86400)}d`;
}

function rssiWord(dbm) {
  const v = Number(dbm);
  if (!Number.isFinite(v)) return '—';
  if (v >= -55) return 'excellent';
  if (v >= -67) return 'good';
  if (v >= -75) return 'fair';
  return 'weak';
}

function initials(name, slotId) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return String(slotId);
  if (/^rfid$/i.test(words[0])) return 'K' + slotId;
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function shortName(name, slotId) {
  const w = String(name || '').trim().split(/\s+/)[0];
  return w && !/^rfid$/i.test(w) ? w : `Key ${slotId}`;
}

function objectId(entityId) {
  const i = String(entityId).indexOf('.');
  return i >= 0 ? entityId.slice(i + 1) : String(entityId);
}

function isBlank(v) {
  return !v || ['none', '', 'unknown', 'unavailable'].includes(String(v).trim());
}

function storedName(raw) {
  const v = String(raw || '').trim();
  return v && !['none', 'unknown', 'unavailable'].includes(v.toLowerCase()) ? v : '';
}

/* =============================================================================
 * 6. MODEL
 * ========================================================================== */

function slotIds(hass) {
  const raw = st(hass, E.slots, '');
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : [];
}

function notifyTargetIds(hass) {
  return String(st(hass, E.notifyTargets, '')).split(',').map((s) => s.trim()).filter(Boolean);
}

function isLinkedNotify(target) {
  return !!target && !['none', '', 'unknown', 'unavailable'].includes(target);
}

function linkedHaUserId(raw) {
  const v = String(raw == null ? '' : raw).trim();
  return ['', 'none', 'unknown', 'unavailable'].includes(v) ? '' : v;
}

/* Per-person notification preferences. These two lists ARE the taxonomy, and
 * they are duplicated in scripts.yaml on purpose - the panel cannot read a
 * script's Jinja and the backend cannot read this file, so the shared contract
 * is the six tokens and the four level words. Change one and change the other;
 * the filtering note above guardian_notify_broadcast says the same in reverse.
 *
 * Level order here is reading order, loudest first. It is deliberately NOT the
 * order the helper declares (Important is first there, so a never-set helper
 * comes up on the default) - the segmented control below decides what the
 * household sees, and what the household sees should make sense. */
const NOTIFY_LEVELS = [
  { value: 'Everything', label: 'Everything' },
  { value: 'Important', label: 'Important' },
  { value: 'Urgent only', label: 'Urgent only' },
  { value: 'Off', label: 'Off' },
];

const LEVEL_HINT = {
  Everything: 'Every alert Guardian sends, including lamp results and routine card scans.',
  Important: 'The default. Everything that matters, without the routine chatter.',
  'Urgent only': 'Alarms, unauthorised openings, a person at the door while everyone is out.',
  Off: 'Nothing — except alarms, stolen cards, and tamper, which always come through.',
};

/* THE SEVERITY FLOOR, WHICH IS THE WHOLE OF WHAT THE LEVEL DOES.
 *
 * These numbers are not a panel invention. They are the `floors` and `ranks`
 * maps inside guardian_notify_person, transcribed:
 *
 *   floors = {Everything: 0, Important: 1, 'Urgent only': 2, Off: 3}
 *   ranks  = {routine: 0, important: 1, urgent: 2}
 *   wants  = nomask or (cat not in muted
 *                       and ((subj == me and 'mine' not in muted)
 *                            or rank >= floor))
 *
 * Two things follow that the screen never used to say, and that made three of
 * the four levels look identical from the outside.
 *
 * FIRST: the level is a floor on SEVERITY, not a list of categories. Off is
 * floor 3 and the highest rank is 2, so at Off no severity can ever clear it -
 * what still arrives does so through the other two branches, your own key and
 * the nonmaskable alerts. That is why Off is not a way to turn the alarm off,
 * and why saying so is not marketing.
 *
 * SECOND: the six switches are ANDed with the floor and are not affected by it.
 * Every screen before this one drew them identically at every level, so a
 * household that moved the level and watched nothing change concluded, quite
 * reasonably, that the level did nothing. It does; its effect was simply never
 * drawn. Each row now states what it will actually deliver AT THE CURRENT
 * LEVEL, so moving the level visibly rewrites all six. */
const LEVEL_FLOOR = { Everything: 0, Important: 1, 'Urgent only': 2, Off: 3 };

function haUser(hass) {
  const u = hass && hass.user;
  return {
    id: String((u && u.id) || ''),
    name: String((u && u.name) || ''),
    isAdmin: !!(u && u.is_admin),
  };
}

function rosterUserIds(hass) {
  const raw = String(st(hass, E.haUserIds, '')).trim();
  if (!raw || ['unknown', 'unavailable', 'none'].includes(raw)) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isSingleAccount(hass) {
  return rosterUserIds(hass).length <= 1;
}

function isHouseAdmin(hass) {
  const u = haUser(hass);
  return u.isAdmin || isSingleAccount(hass);
}

function canEditSlot(hass, slot) {
  if (isHouseAdmin(hass)) return true;
  const mapped = String((slot && slot.haUserId) || '').trim();
  const uid = haUser(hass).id;
  return !!(mapped && uid && mapped === uid);
}

/* Notification prefs belong to the mapped Home Assistant user on that key.
 * House admins still link accounts, phones, names, and policy through
 * canEditSlot; they do not get a silent editor for someone else's
 * Everything / Important tabs. Bootstrap (roster length ≤ 1) is the
 * exception, matching guardian_slot_write. */
function canEditNotifyPrefs(hass, slot) {
  if (isSingleAccount(hass)) return true;
  const mapped = linkedHaUserId(slot && slot.haUserId);
  const uid = haUser(hass).id;
  return !!(mapped && uid && mapped === uid);
}

function isAuthRefused(err) {
  const msg = String((err && (err.message || err.error)) || err || '');
  return /unauthorized/i.test(msg);
}

function notifyMuteCsv(hass, id, token, on) {
  const raw = String(st(hass, id, '')).trim();
  const cur = ['unknown', 'unavailable'].includes(raw)
    ? [] : raw.split(',').map((s) => s.trim()).filter(Boolean);
  const next = on ? cur.filter((t) => t !== token)
    : (cur.includes(token) ? cur : cur.concat(token));
  return NOTIFY_CATEGORIES.map((c) => c.token).filter((t) => next.includes(t)).join(',');
}

function rfidSlotFromEntity(id) {
  const m = String(id || '').match(/^input_(?:text|select)\.rfid_(\d+)(?:_|$)/);
  return m ? m[1] : '';
}

const TIERS = [
  { rank: 0, label: 'routine' },
  { rank: 1, label: 'important' },
  { rank: 2, label: 'urgent' },
];

/* What a category actually delivers for this person right now: the level's
 * floor and the category switch combined, in the same order the backend
 * combines them. Returns the sentence the row shows. */
function categoryEffect(level, muted, token) {
  if (muted.includes(token)) {
    return token === 'mine'
      ? { on: false, tone: 'idle', text: 'Muted — nothing about your own key, at any level.' }
      : { on: false, tone: 'idle', text: 'Muted — nothing from this, at any level.' };
  }
  const floor = LEVEL_FLOOR[level] === undefined ? 1 : LEVEL_FLOOR[level];
  const passes = TIERS.filter((t) => t.rank >= floor).map((t) => t.label);
  if (token === 'mine') {
    /* `mine` clears the floor by its own branch, so it is the one category the
     * level does not narrow. The old copy said this only in a hint on Urgent
     * only, which made it look like a quirk of that level. */
    return { on: true, tone: 'ok', text: 'Everything about your own key, at every level.' };
  }
  if (!passes.length) {
    return {
      on: true,
      tone: 'warn',
      text: 'Nothing at this level — only alarms, stolen cards, and tamper, which always come through.',
    };
  }
  return {
    on: true,
    tone: 'ok',
    text: passes.length === TIERS.length
      ? 'Everything in this category.'
      : `Only the ${passes.join(' and ')} ones.`,
  };
}

/* Named for what the household would call them, not for the log_type. The
 * hints name real events on purpose: "Doors & access" means nothing until it
 * says which pushes stop arriving if you switch it off. */
const NOTIFY_CATEGORIES = [
  { token: 'mine', label: 'My key',
    hint: 'When your own card is scanned, enrolled, or challenged for a PIN. Comes through even at Urgent only.',
    icon: 'mdi:account-key-outline' },
  { token: 'security', label: 'Security & alarms',
    hint: 'Alarms, stolen or copied cards, portal tamper, entry with no card scanned.',
    icon: 'mdi:shield-alert-outline' },
  { token: 'access', label: 'Doors & access',
    hint: 'The door left open, an exit that was not registered, PIN changes.',
    icon: 'mdi:door-open' },
  { token: 'presence', label: "Who's home",
    hint: 'Arrivals and departures, and corrections to who Guardian thinks is in.',
    icon: 'mdi:home-account' },
  { token: 'camera', label: 'Camera & doorbell',
    hint: 'Someone seen at the door while everyone is out, and doorbell presses.',
    icon: 'mdi:cctv' },
  { token: 'system', label: 'System health',
    hint: 'The portal or doorbell going offline, lamp and ambient-light problems.',
    icon: 'mdi:heart-pulse' },
];

/* THE THREE THINGS THIS PANEL CAN KNOW ABOUT A CARD'S ON-TAG PROTECTION, each
 * carrying its own label, tone, cause and remedy.
 *
 * Same shape and same rule as classifyPanelVersion: the remedy is a FIELD ON A
 * STATE, not text written at the point of display, so there is exactly one place
 * either can be wrong - and a state may only prescribe against a cause it has
 * established. That rule is what `unknown` is here to honour. Nothing about an
 * unreported card is known to be wrong, so it gets no remedy for the card; what
 * it gets is the reason nobody knows, which is a different claim and a true one.
 *
 * `unprotected` is the only state that names a fix, because it is the only one
 * where something is established to be wrong. Note what that fix is NOT: it is
 * not "refuse the card". Refusing an unprotected tag would lock out every key
 * enrolled before the protection fix existed, which on this door is all of them,
 * and it is exactly the population that most needs to be let in and told. */
const CARD_PROTECTION = {
  u: {
    label: 'Clonable',
    tone: 'warn',
    hint: 'This card holds its payload unprotected, so any reader can read it '
      + 'and a copy would open the door. Delete this key and add it again — the '
      + 'reader password-protects a card as it enrols it.',
  },
  p: {
    label: 'Protected',
    tone: 'ok',
    hint: 'The payload on this card is password-protected on the tag.',
  },
  '': {
    label: 'Not checked',
    tone: 'idle',
    hint: 'Nothing is known to be wrong with this card. The readers only report '
      + 'this from the 2.29.0 firmware onward, and until both devices are '
      + 'flashed no card can be checked either way.',
  },
};

function buildSlots(hass) {
  const target = st(hass, E.enrollTarget, 'none');
  /* WHICH KEYS ARE CLONABLE, AND WHICH NOBODY HAS EVER CHECKED.
   *
   * Both readers have published a `protected` field on every scan since the
   * forty-third pass. Nothing read it: it went onto the event bus and stopped
   * there, while the deploy notes recorded it as "surfaced to the household".
   * An unprotected NTAG's payload is readable by any reader, and a readable
   * bearer token is a clonable card, so this is worth a household knowing.
   *
   * THREE STATES, NOT TWO, which is why the helper is a pair list and not a
   * list of ids. A slot appears as `Np` or `Nu` only once a reader has actually
   * said so; a slot that appears in neither has never been reported. That last
   * state is the one every key on this door is in today, because both devices
   * are running firmware older than the field and say nothing on every scan.
   * Collapsing it into "protected" would tell somebody their keys had been
   * checked and passed when nothing has ever looked at them. */
  const protRaw = String(st(hass, E.cardProtection, '')).trim();
  const protMap = {};
  if (exists(hass, E.cardProtection) && !['unknown', 'unavailable'].includes(protRaw)) {
    protRaw.split(',').map((s) => s.trim()).filter((s) => /^[0-9]+[pu]$/.test(s))
      .forEach((e) => { protMap[e.slice(0, -1)] = e.slice(-1); });
  }
  return slotIds(hass).map((id) => {
    const sel = `input_select.rfid_${id}`;
    const pol = `input_select.rfid_${id}_policy`;
    const notify = `input_select.rfid_${id}_notify_target`;
    const cardId = `input_text.rfid_${id}_card_id`;
    const hash = `input_text.rfid_${id}_hash`;
    const nameEntity = `input_text.rfid_${id}_name`;
    const levelEntity = `input_select.rfid_${id}_notify_level`;
    const muteEntity = `input_text.rfid_${id}_notify_mute`;
    const haUserEntity = `input_text.rfid_${id}_ha_user_id`;
    const presence = st(hass, sel, 'unknown');
    const policy = st(hass, pol, 'resident');
    const notifyTarget = st(hass, notify, 'none');
    /* Read exactly the way the backend reads them, including the fail-open
     * fallbacks: an unknown level is Important and an unreadable mute list is
     * empty. If the panel guessed differently, the screen would describe a
     * person's settings as something other than what actually gates their
     * alerts, which is a worse bug than either default being wrong. */
    const levelRaw = String(st(hass, levelEntity, '')).trim();
    const level = NOTIFY_LEVELS.some((l) => l.value === levelRaw) ? levelRaw : 'Important';
    /* THE OPTIONS THE HELPER ACTUALLY HAS, not the ones this file knows about.
     *
     * The panel drew all four levels from its own constant and called
     * input_select.select_option with whichever one was pressed. On this house
     * the helper only had three - the deployed packages/guardian_rfid.yaml
     * predates `Off` - so pressing Off produced a raw Home Assistant error
     * dialog, "Invalid option: Off (possible options: Important, Everything,
     * Urgent only)", and nothing else anywhere said the backend was short of an
     * option. Version agreement is not entity agreement: every half reported
     * 2.27.0 while a helper the panel drives had the wrong shape.
     *
     * So the control is now drawn from the entity. A button that cannot work is
     * never offered, and the gap is REPORTED rather than silently swallowed -
     * which is the same rule the version banner now follows: describe what you
     * found, and name a remedy only for a cause you established. */
    const levelOptions = attr(hass, levelEntity, 'options', null);
    const levelHas = Array.isArray(levelOptions)
      ? levelOptions.map((o) => String(o).trim()) : null;
    const levelChoices = levelHas
      ? NOTIFY_LEVELS.filter((l) => levelHas.includes(l.value))
      : [];
    const levelMissing = levelHas
      ? NOTIFY_LEVELS.filter((l) => !levelHas.includes(l.value)).map((l) => l.value)
      : NOTIFY_LEVELS.map((l) => l.value);
    const muteRaw = String(st(hass, muteEntity, '')).trim();
    const muted = ['unknown', 'unavailable'].includes(muteRaw)
      ? [] : muteRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const cardIdNorm = String(st(hass, cardId, '')).trim().toLowerCase();
    const occupied = cardIdNorm.length === 16 && /^[0-9a-f]{16}$/.test(cardIdNorm);
    const nameRaw = storedName(st(hass, nameEntity, ''));
    const name = nameRaw || attr(hass, sel, 'friendly_name', `RFID ${id}`);
    return {
      id,
      selEntity: sel,
      polEntity: pol,
      notifyEntity: notify,
      notifyTarget,
      hasNotify: isLinkedNotify(notifyTarget),
      levelEntity,
      muteEntity,
      haUserEntity,
      haUserId: linkedHaUserId(st(hass, haUserEntity, '')),
      level,
      levelChoices,
      levelMissing,
      muted,
      hashEntity: hash,
      nameEntity,
      nameRaw,
      name,
      short: shortName(name, id),
      initials: initials(name, id),
      presence,
      policy,
      visitor: policy === 'visitor',
      occupied,
      /* 'p', 'u' or '' for never reported. Only meaningful on an occupied slot:
       * an empty slot has no card to have a verdict about, so the key list must
       * not draw a protection state for one. */
      protection: occupied ? (protMap[id] || '') : '',
      stolen: presence === 'Stolen/Lost',
      home: presence === 'At home',
      missing: !exists(hass, sel),
      isTarget: target === id,
      changed: (so(hass, sel) || {}).last_changed,
    };
  });
}

function buildCountdown(hass) {
  const ends = num(hass, E.cdEnds, 0);
  const total = num(hass, E.cdTotal, 0);
  const label = String(st(hass, E.cdLabel, '')).trim();
  const remaining = ends > 0 ? Math.max(0, ends - Date.now() / 1000) : 0;
  return {
    ends,
    total,
    label,
    remaining,
    active: remaining > 0 && total > 0,
    pct: total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0,
  };
}

function buildSecurity(hass, m) {
  const display = st(hass, E.display, 'unknown');
  const elevated = isOn(hass, E.elevated);
  const armed = isOn(hass, E.superSurveillance);
  const programs = m.ssPrograms || [];
  const matching = programs.filter((p) => p.matching);
  const scheduled = matching.length > 0;
  const until = matching.length === 1 ? ssHourLabel(matching[0].end) : '';

  if (display === 'ALARM') {
    const reason = st(hass, E.alarmReason, 'none');
    return {
      key: 'alarm', tone: 'alarm', eyebrow: 'Alarm', title: 'Guardian is alarming',
      body: reason && reason !== 'none' ? reason : 'No reason was recorded.',
      elevated, armed, scheduled,
    };
  }
  if (isOn(hass, E.entryChallenge)) {
    const origin = st(hass, E.challengeOrigin, 'unknown');
    const where = origin === 'inside' ? 'from inside' : origin === 'outside' ? 'from outside' : 'from an unresolved direction';
    const cardOk = isOn(hass, E.challengeCardOk);
    const pinOk = isOn(hass, E.challengePinOk);
    const slot = st(hass, E.pendingMfaSlot, 'none');
    const who = m.slots.find((s) => s.id === slot);
    let title = 'Unauthorised opening';
    let body = `The door opened ${where} while elevated mode was on. Scan a registered card AND enter the master PIN at the keypad before the timer runs out. One factor is not enough.`;
    if (cardOk && !pinOk) {
      title = 'Card accepted — PIN still needed';
      body = `${who ? who.short + "'s card" : 'A registered card'} has been scanned. Enter the master PIN at the keypad. The lamp flash means the card was read; one factor is not enough.`;
    } else if (pinOk && !cardOk) {
      title = 'PIN accepted — card still needed';
      body = `The master PIN is in. Scan a registered card. One factor is not enough.`;
    }
    return {
      key: 'challenge', tone: 'warn', eyebrow: 'Authenticate now',
      title, body, elevated, armed, scheduled,
    };
  }
  if (isOn(hass, E.doorbellExitPin)) {
    const slot = st(hass, E.doorbellExitSlot, 'none');
    const who = m.slots.find((s) => s.id === slot);
    const mins = Math.round(num(hass, E.doorbellExitMinutes, 10));
    return {
      key: 'doorbellexit', tone: 'warn', eyebrow: 'Phone PIN',
      title: 'Confirm the exit',
      body: `${who ? who.short + "'s card" : 'A registered card'} was scanned at the doorbell. Enter the master PIN here, or from the linked phone, within ${mins} minute${mins === 1 ? '' : 's'}. An unanswered window becomes a full alarm.`,
      elevated, armed, scheduled,
    };
  }
  if (isOn(hass, E.mfaPending)) {
    const left = Math.max(0, 3 - Math.round(num(hass, E.mfaFails, 0)));
    const slot = st(hass, E.pendingMfaSlot, 'none');
    const who = m.slots.find((s) => s.id === slot);
    const src = st(hass, E.pendingMfaSource, 'none');
    return {
      key: 'mfa', tone: 'warn', eyebrow: 'PIN required',
      title: 'Waiting for the master PIN',
      body: `${who ? who.short + "'s card" : 'A registered card'} was scanned at the ${
        src === 'doorbell' ? 'doorbell' : src === 'interior_portal' ? 'interior portal' : 'reader'
      }. ${left} attempt${left === 1 ? '' : 's'} left.`,
      elevated, armed, scheduled,
    };
  }
  if (isOn(hass, E.pinChangeMode)) {
    const step = st(hass, E.pinChangeStep, 'none');
    return {
      key: 'pinchange', tone: 'elev', eyebrow: 'PIN change',
      title: step === 'new' ? 'Enter the new PIN at the keypad' : 'Enter the current PIN at the keypad',
      body: 'The PIN is typed on the portal, not on this screen.',
      elevated, armed, scheduled,
    };
  }
  if (isOn(hass, E.enrollMode)) {
    const target = st(hass, E.enrollTarget, 'none');
    const visitor = isOn(hass, E.enrollVisitor);
    const pending = storedName(st(hass, E.enrollPendingName, ''));
    const victim = m.slots.find((s) => s.id === target);
    let title;
    let body;
    if (target === 'none') {
      title = 'Pick who to replace';
      body = 'Every key is in use. Choose whose key to replace, then present the new card.';
    } else if (pending) {
      title = 'Present the card';
      body = `Hold it to the doorbell or the interior portal to add ${pending}'s key${visitor ? ' as a visitor' : ''}.`;
    } else if (victim && victim.occupied) {
      title = 'Name the key, then present it';
      body = `Replacing ${victim.short}'s key. Type a name (optional), then hold the new card to the doorbell or the interior portal.`;
    } else {
      title = 'Name the key, then present it';
      body = `Type a name (optional), then hold the card to the doorbell or the interior portal${visitor ? ' as a visitor' : ''}.`;
    }
    return {
      key: 'enroll', tone: 'info', eyebrow: 'Adding a key', title, body,
      elevated, armed, scheduled,
    };
  }
  const entry = st(hass, E.tEntry) === 'active';
  const exitw = st(hass, E.tExit) === 'active';
  if (entry || exitw) {
    const dir = entry && exitw ? 'in both directions' : entry ? 'to come in' : 'to go out';
    return {
      key: 'passage', tone: 'pass', eyebrow: 'Passage open', title: `Authorised ${dir}`,
      body: 'A valid card was scanned. Opening the door now counts as intentional.',
      elevated, armed, scheduled,
    };
  }
  if (elevated) {
    let body = 'Super surveillance is on. Every card scan raises a PIN challenge.';
    if (armed && matching.length === 1) {
      body = `Super surveillance is on, and ${matching[0].label} is in its window until ${until}. Every card scan raises a PIN challenge.`;
    } else if (armed && matching.length > 1) {
      body = `Super surveillance is on, and ${matching.length} programs are in their windows. Every card scan raises a PIN challenge.`;
    } else if (matching.length === 1) {
      body = `${matching[0].label} has Super Surveillance on until ${until}. Every card scan raises a PIN challenge.`;
    } else if (matching.length > 1) {
      body = `${matching.length} programs have Super Surveillance on. Every card scan raises a PIN challenge.`;
    }
    return {
      key: 'elevated', tone: 'elev', eyebrow: 'Elevated',
      title: 'A PIN is required to pass',
      body,
      elevated, armed, scheduled,
    };
  }
  return {
    key: 'idle', tone: 'ok', eyebrow: 'All clear', title: 'The house is watching itself',
    body: 'A registered card opens the door. Super surveillance is off.',
    elevated, armed, scheduled,
  };
}

const FAULT_COPY = {
  DOORBELL: ['Doorbell offline', 'The exterior reader and the doorbell button are not responding.'],
  CAMERA: ['Camera unavailable', 'The door camera is not reporting, so the lamp cannot be measured.'],
  LUMA: ['Light measurement failed', 'The last ambient sample produced no usable reading.'],
  IMU: ['Portal IMU fault', 'The door motion sensor is unhealthy, so inside/outside direction is less reliable.'],
};

/* Is all of Guardian actually installed here, and is it one version?
 *
 * Guardian is not an add-on or a HACS package. It is loose files copied into
 * /config by hand: this panel under www/, helpers and templates in packages/,
 * logic in scripts.yaml, wiring in automations.yaml. Nothing enforces that they
 * arrive together, and two of them need a full restart rather than a reload,
 * so a partial deploy is the normal way for this system to break.
 *
 * A partial deploy is also invisible from the inside, which is what makes it
 * expensive. The panel renders, every control responds, and the stale half
 * answers questions in a vocabulary the fresh half no longer speaks. On this
 * house that produced a key with a phone plainly selected being told "this key
 * has no phone linked" - a deployment fault wearing the costume of a setup
 * mistake. The only way to tell the difference was to SSH in and diff against a
 * git commit, which is a fair thing to ask of the author and not a fair thing
 * to ask of anyone who adopts this.
 *
 * So every half declares its version and this compares them. A mismatch is
 * reported, never resolved: the panel cannot know which version was intended,
 * only that they disagree.
 *
 * `automations.yaml` was checked for PRESENCE rather than version until 2.24.0,
 * on the reasoning that what mattered was whether the automation mirroring a
 * phone link into its restore helper existed at all. That reasoning was too
 * narrow. A stale automations.yaml has that automation too, so the check
 * returned "present" for precisely the case it existed to catch - and the file
 * it was waving through is the one holding the Major Alarm Handler and every
 * watchdog. It now carries a version marker like the other three and is
 * compared the same way; an automations.yaml too old to have the marker reports
 * `missing`, which is the truthful answer.
 *
 * rackReady is called out separately because it is the one missing piece that
 * silently disables all alerting: script.guardian_notify_person will not read a
 * slot's phone link until sensor.guardian_rfid_slots answers. */
function buildInstall(hass) {
  const ui = GUARDIAN_UI_VERSION;
  const present = exists(hass, E.version) && !dead(hass, E.version);
  const shown = (name) => String(attr(hass, E.version, name, 'missing') || 'missing');

  const halves = present ? [
    { file: 'packages/guardian.yaml', shows: st(hass, E.version, 'missing'), want: ui },
    { file: 'packages/guardian_rfid.yaml', shows: shown('rfid_package'), want: ui },
    { file: 'scripts.yaml', shows: shown('scripts'), want: ui },
    { file: 'automations.yaml', shows: shown('automations'), want: ui },
  ].map((h) => ({ ...h, ok: h.shows === h.want })) : [];

  const rackReady = exists(hass, E.slots) && !dead(hass, E.slots);
  const stale = halves.filter((h) => !h.ok);

  /* The running panel and the one configuration.yaml asked for disagree - and
   * WHICH WAY ROUND decides both what is wrong and what fixes it. See
   * classifyPanelVersion, which is the only place that judgement is made.
   *
   * In BOTH directions the four backend rows below are almost always correct and
   * the panel side is the odd one out, so the card must stop telling the
   * household to copy four files that are already right; `panelStale` still
   * carries that, because it is the same answer for both. What must not be
   * shared is the remedy. */
  const requested = REQUESTED_UI_VERSION;
  const version = classifyPanelVersion(requested, ui);
  const panelStale = version.state === 'browser_behind' || version.state === 'config_behind';

  /* TWO DIFFERENT QUESTIONS, AND THEY WERE BEING ANSWERED IN ONE CHANNEL.
   *
   *   Is Guardian deployed correctly RIGHT NOW?      -> `ok`, drives NEEDS ATTENTION
   *   Will the NEXT upgrade land correctly?          -> `cacheKeyStale`, a note
   *
   * `config_behind` is the second question and was being reported through the
   * first. On a fully working install - panel and all four backend halves
   * agreeing, every file present, the rack answering - a stale ?v= produced a
   * NEEDS ATTENTION card on the household's landing page saying nothing was
   * wrong in six sentences. It stayed there through cache clears, because
   * clearing the cache genuinely cannot fix it, and it came back on every single
   * upgrade. That is how a household learns that a Guardian banner is furniture,
   * and losing that is expensive: the same channel has to carry "your browser is
   * running old logic against a new backend", which is a real fault.
   *
   * So `ok` now excludes only browser_behind. The stale cache-buster is still
   * reported, in full, on the Installation card - it IS a latent fault, because
   * the next upgrade will serve a cached panel from the unchanged address - but
   * it is reported as the maintenance job it is rather than as a broken system.
   *
   * The forty-fourth pass toned this warn rather than alarm for exactly this
   * reason and stopped one step short: the tone changed and the banner did not. */
  const cacheKeyStale = version.state === 'config_behind';

  return {
    ui,
    requested,
    version,
    panelStale,
    cacheKeyStale,
    present,
    halves,
    stale,
    rackReady,
    ok: present && stale.length === 0 && rackReady
      && version.state !== 'browser_behind',
  };
}

function buildFaults(hass) {
  const raw = st(hass, E.faults, '');
  const tokens = String(raw === 'unknown' || raw === 'unavailable' ? '' : raw)
    .split(',').map((s) => s.trim()).filter(Boolean);
  return tokens.map((t) => ({
    token: t,
    title: (FAULT_COPY[t] || [t])[0],
    body: (FAULT_COPY[t] || [null, 'Reported by the system health sensor.'])[1],
  }));
}

function buildHealth(hass, camId) {
  const portalUp = st(hass, E.portalStatus) === 'on';
  const doorbellUp = isOn(hass, E.doorbellOnline);
  const camOk = camId && !isBlank(camId) && !dead(hass, camId);
  const imuProblem = st(hass, E.portalImuProblem) === 'on';
  const lumaFailed = String(st(hass, E.lampResult, '')).includes('FAILED');

  return {
    portal: {
      ok: portalUp, label: 'Portal',
      detail: portalUp
        ? `${rssiWord(st(hass, E.portalWifi))} · up ${uptime(st(hass, E.portalUptime))}`
        : 'Offline — door openings are not being detected',
      entity: E.portalStatus,
    },
    doorbell: {
      ok: doorbellUp, label: 'Doorbell',
      detail: doorbellUp
        ? (dead(hass, E.doorbellWifi)
          ? String(st(hass, E.doorbellLink, 'Online'))
          : `${rssiWord(st(hass, E.doorbellWifi))}${dead(hass, E.doorbellUptime) ? '' : ` · up ${uptime(st(hass, E.doorbellUptime))}`}`)
        : String(st(hass, E.doorbellLink, 'Offline')),
      entity: E.doorbellOnline,
    },
    camera: {
      ok: !!camOk, label: 'Camera',
      detail: camOk ? 'Reporting' : 'Not reporting',
      entity: camId,
    },
    imu: {
      ok: !imuProblem, label: 'Door sensing',
      detail: imuProblem ? 'IMU unhealthy' : 'Reed and handle sensor healthy',
      entity: E.portalImuProblem,
    },
    lumaFailed,
  };
}

const LAMP_DECISION = {
  on_camera: ['Lamp on', 'measured dark, and the sun agrees'],
  off_camera: ['Lamp off', 'measured bright, and the sun agrees'],
  on_sun_override: ['Lamp on', 'camera claimed bright while the sun is well down — the camera was wrong'],
  off_sun_override: ['Lamp off', 'camera claimed dark while the sun is well up — the camera was wrong'],
  on_sun: ['Lamp on', 'no usable reading; the sun is well below the horizon'],
  off_sun: ['Lamp off', 'no usable reading; the sun is well up'],
  off_day_hold: ['Lamp off', 'the reading was in the gap, and the sun is well up'],
  hold: ['Held', 'nothing was clear enough to act on — in the gap, or in twilight'],
  on_mismatch: ['Forced on', 'disagreed with the sun for too long'],
  off_mismatch: ['Forced off', 'disagreed with the sun for too long'],
};

const LAMP_FAIL_WHY = {
  camera_unavailable: 'the camera entity was missing or unavailable',
  lamp_unavailable: 'the lamp entity was missing or unavailable',
  already_running: 'a sample was already running, or the sampling flag was stuck on',
  alarm: 'the display is ALARM, so the sampler refused to take the lamp',
  feedback: 'a lamp feedback flash was in progress',
};

function parseLampResult(raw) {
  const s = String(raw || '').trim();
  if (!s || s === 'none' || s === 'unknown') return null;
  const at = (s.match(/^(\d{1,2}:\d{2})/) || [])[1] || '';
  const luma = (s.match(/luma=(-?[\d.]+)/) || [])[1];
  const sun = (s.match(/sun=(-?[\d.]+)/) || [])[1];
  const failed = /\bFAILED\b/.test(s);
  const failReason = (s.match(/\bFAILED\s+(\w+)/) || [])[1] || '';
  const decision = (s.match(/\b(on_camera|off_camera|on_sun_override|off_sun_override|off_day_hold|on_sun|off_sun|hold|on_mismatch|off_mismatch)\b/) || [])[1] || '';
  const mode = (s.match(/\b(manual|learn|auto)\s*$/) || [])[1] || '';
  const d = LAMP_DECISION[decision] || ['Unparsed', s];
  const verdict = failed ? 'Measurement failed' : d[0];
  const failWhy = LAMP_FAIL_WHY[failReason];
  const why = failed
    ? (failWhy
      ? `${failWhy}${decision
        ? `, so the lamp was ${decision.startsWith('on') ? 'switched on' : decision.startsWith('off') ? 'switched off' : 'left as it was'}`
        : ''}`
      : (LAMP_DECISION[decision]
        ? `no usable reading, so the lamp was left ${decision.startsWith('on') ? 'on' : decision.startsWith('off') ? 'off' : 'as it was'}`
        : 'the measurement chain returned nothing usable'))
    : d[1];
  return { at, luma, sun, failed, failReason, decision, mode, verdict, why, raw: s };
}

function lampEntityId(hass, cfg) {
  const resolved = st(hass, E.lamp, 'none');
  if (resolved && resolved.startsWith('light.')
      && hass.states && hass.states[resolved]
      && !['none', 'unknown', 'unavailable'].includes(resolved)) {
    return resolved;
  }
  return resolve(hass, (cfg && cfg.lamp) || DEFAULTS.lamp);
}

function colorModes(hass, entity) {
  const raw = attr(hass, entity, 'supported_color_modes', null);
  return Array.isArray(raw) ? raw.map(String) : [];
}

function buildLamp(hass, cfg) {
  const entity = lampEntityId(hass, cfg);
  const modeRaw = st(hass, E.lampMode, 'Manual (this home)');
  const auto = modeRaw === 'Auto-calibrate';
  const calReady = num(hass, E.lampCal, 0) === 1;
  const mismatchSince = st(hass, E.lampMismatchSince, 'none');
  const mmTs = parseFloat(mismatchSince);
  const sunElev = attr(hass, E.sun, 'elevation', null);
  const modes = colorModes(hass, entity);
  const colorMode = String(attr(hass, entity, 'color_mode', '') || '');
  const hs = attr(hass, entity, 'hs_color', null);
  const rgb = attr(hass, entity, 'rgb_color', null);
  const minK = attr(hass, entity, 'min_color_temp_kelvin', 2500);
  const maxK = attr(hass, entity, 'max_color_temp_kelvin', 6500);
  const canHs = modes.some((m) => ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(m)) || !modes.length;
  const canTemp = modes.includes('color_temp') || modes.includes('white') || !modes.length;
  const canBright = modes.includes('brightness') || canHs || canTemp || attr(hass, entity, 'brightness', null) != null;
  return {
    entity,
    missing: !hass.states || !hass.states[entity],
    modeRaw,
    auto,
    calReady,
    calDark: attr(hass, E.lampCal, 'dark', null),
    calBright: attr(hass, E.lampCal, 'bright', null),
    calDay: attr(hass, E.lampCal, 'n_day', null),
    calNight: attr(hass, E.lampCal, 'n_night', null),
    calTiles: attr(hass, E.lampCal, 'tiles', null),
    sampling: isOn(hass, E.lampSampling),
    on: st(hass, entity) === 'on',
    brightness: attr(hass, entity, 'brightness', null),
    kelvin: attr(hass, entity, 'color_temp_kelvin', null),
    hs: Array.isArray(hs) && hs.length >= 2 ? [Number(hs[0]), Number(hs[1])] : null,
    rgb: Array.isArray(rgb) && rgb.length >= 3 ? rgb.map(Number) : null,
    colorMode,
    minK: Number.isFinite(Number(minK)) ? Number(minK) : 2500,
    maxK: Number.isFinite(Number(maxK)) ? Number(maxK) : 6500,
    canHs,
    canTemp,
    canBright,
    dark: num(hass, E.darkThreshold, 45),
    bright: num(hass, E.brightThreshold, 90),
    rotate: Math.round(num(hass, E.lumaRotate, 90)),
    failStreak: Math.round(num(hass, E.lampFailStreak, 0)),
    mismatchMax: Math.round(num(hass, E.lampMismatchMax, 30)),
    mismatchMinutes: Number.isFinite(mmTs) ? Math.floor((Date.now() / 1000 - mmTs) / 60) : null,
    sunElev: Number.isFinite(Number(sunElev)) ? Number(sunElev) : null,
    result: parseLampResult(st(hass, E.lampResult, 'none')),
    resultChanged: (so(hass, E.lampResult) || {}).last_changed,
    irEntity: st(hass, E.cameraIrEntity, 'none'),
  };
}

function buildPresence(hass, slots) {
  const residents = slots.filter((s) => s.occupied && !s.visitor);
  const home = residents.filter((s) => s.home);
  const raw = st(hass, E.presenceTrackers, '');
  const trackerIds = String(raw === 'unknown' || raw === 'unavailable' ? '' : raw)
    .split(',').map((s) => s.trim()).filter(Boolean);
  const trackers = trackerIds.map((id) => ({
    id,
    exists: !!(hass.states && hass.states[id]),
    state: hass.states && hass.states[id] ? hass.states[id].state : 'missing',
    name: hass.states && hass.states[id]
      ? (hass.states[id].attributes.friendly_name || id) : id,
  }));
  return {
    residents,
    visitors: slots.filter((s) => s.occupied && s.visitor),
    homeCount: home.length,
    total: residents.length,
    names: home.map((s) => s.short),
    summary: st(hass, E.presenceSummary, ''),
    trackers,
    trackersRaw: raw === 'unknown' || raw === 'unavailable' ? '' : raw,
    trackersActive: trackers.length > 0,
    anyTrackerHome: trackers.some((t) => t.state === 'home'),
  };
}

function discoverFrigate(hass, key) {
  const out = { key: key || '', camera: '', occupancy: '', snapshot: '', snapshotUrl: '', personNow: false };
  const k = String(key || '').trim();
  if (isBlank(k)) return out;
  const states = (hass && hass.states) || {};
  const ids = Object.keys(states);
  const alive = (id) => id && states[id] && states[id].state !== 'unavailable';
  const pick = (domain, preds) => {
    for (const pred of preds) {
      const hit = ids.find((id) => id.startsWith(domain + '.') && pred(objectId(id), states[id]));
      if (alive(hit)) return hit;
    }
    return '';
  };

  out.camera = pick('camera', [
    (o) => o === k,
    (o) => o === `frigate_${k}`,
    (o) => o === `${k}_live`,
    (o, s) => s.attributes && s.attributes.camera === k,
    (o) => o.endsWith('_' + k) && !o.includes('person'),
  ]);
  out.occupancy = pick('binary_sensor', [
    (o) => o === `${k}_person_occupancy`,
    (o) => o === `${k}_person`,
    (o) => o === `frigate_${k}_person_occupancy`,
    (o) => o.endsWith(`_${k}_person_occupancy`) || o.endsWith(`_${k}_person`),
    (o, s) => s.attributes && s.attributes.device_class === 'occupancy' && (
      o.includes(k) || (s.attributes.camera === k)),
  ]);
  const img = pick('image', [
    (o) => o === `${k}_person`,
    (o) => o.endsWith(`_${k}_person`),
    (o) => o.includes(k) && o.includes('person'),
  ]);
  const camPerson = pick('camera', [
    (o) => o === `${k}_person` || o.endsWith(`_${k}_person`),
  ]);
  const snapId = img || camPerson;
  if (snapId) {
    out.snapshot = snapId;
    const pic = states[snapId].attributes && states[snapId].attributes.entity_picture;
    if (pic) out.snapshotUrl = pic;
  }
  if (out.occupancy) out.personNow = states[out.occupancy].state === 'on';
  return out;
}

function findFrigatePanel(hass, cfg) {
  const override = cfg && cfg.frigatePath ? String(cfg.frigatePath).replace(/^\/+/, '') : '';
  if (override) return override;
  const panels = (hass && hass.panels) || {};
  for (const [path, p] of Object.entries(panels)) {
    const blob = `${path} ${p && p.title ? p.title : ''} ${p && p.config && p.config.title ? p.config.title : ''}`.toLowerCase();
    if (blob.includes('frigate')) return path;
  }
  return '';
}

function helperCameraRaw(hass) {
  return String(st(hass, E.cameraEntity, '')).trim();
}

function sampleCameraId(hass, cfg) {
  return ambientCameraId(hass, cfg);
}

function ambientCameraId(hass, cfg) {
  const fallback = resolve(hass, (cfg && cfg.camera) || DEFAULTS.camera);
  const fromHelper = helperCameraRaw(hass);
  const door = resolve(hass, 'camera.door_camera');
  const doorOk = !!(hass.states && hass.states[door] && !dead(hass, door));
  const legacy = isBlank(fromHelper) || LEGACY_CAMERA_IDS.includes(fromHelper);
  if (legacy && doorOk) return door;
  if (!isBlank(fromHelper)) {
    const id = resolve(hass, fromHelper);
    if (hass.states && hass.states[id]) return id;
  }
  if (hass.states && hass.states[fallback] && !dead(hass, fallback)) return fallback;
  if (doorOk) return door;
  return resolve(hass, fromHelper || fallback);
}

function buildModel(hass, cfg) {
  const m = {};
  m.slots = buildSlots(hass);
  m.ssPrograms = buildSsPrograms(hass);
  m.notifyTargets = notifyTargetIds(hass).map((id) => ({
    id,
    label: attr(hass, `notify.${id}`, 'friendly_name', id),
  }));
  m.countdown = buildCountdown(hass);
  m.security = buildSecurity(hass, m);
  m.install = buildInstall(hass);
  m.faults = buildFaults(hass);
  /* An incomplete install outranks every fault the backend can report, because
   * an incomplete install is why the backend's reports cannot be trusted. It is
   * pushed onto the same list rather than given its own surface so it reaches
   * the places faults are already counted and shown, and so a household that
   * never opens Diagnostics still sees it. */
  if (!m.install.ok) {
    m.faults.unshift({
      token: 'INSTALL',
      /* config_behind IS NOT IN THIS LIST ANY MORE, and its absence is the fix.
       * It can no longer be the sole reason `ok` is false, so reaching here with
       * a stale ?v= means something ELSE is wrong - and naming the cache-buster
       * then would bury the real fault under the cosmetic one. It is reported in
       * full on the Installation card instead. */
      title: !m.install.present ? 'Guardian backend not installed'
        : !m.install.rackReady ? 'Guardian is only half installed'
          : m.install.version.state === 'browser_behind' ? 'This page is running an old panel'
            : 'Guardian files are from different versions',
      body: !m.install.present
        ? 'The panel is running but no part of Guardian answers in Home Assistant. Copy the packages/ files into /config/packages/ and restart fully.'
        : !m.install.rackReady
          ? 'The RFID slot rack is missing, so no key can be looked up and no alert can be routed. packages/guardian_rfid.yaml has not merged — that needs a full restart, not a reload.'
          /* The remedy itself is never composed here - it comes off the
           * classified state, so there is one place it can be wrong. */
          : m.install.version.state === 'browser_behind'
            ? `Home Assistant asked for panel ${m.install.requested} and this browser is running ${m.install.ui}. ${m.install.version.remedy} See More → Diagnostics.`
            : `${m.install.stale.map((h) => h.file).join(', ')} did not come from the same version as this panel. See More → Diagnostics.`,
    });
  }
  const ambient = ambientCameraId(hass, cfg);
  const sample = sampleCameraId(hass, cfg);
  const stored = helperCameraRaw(hass);
  const frigateKey = st(hass, E.frigateCamera, 'door_camera');
  const frigate = discoverFrigate(hass, isBlank(frigateKey) ? '' : frigateKey);
  m.camera = {
    ambient,
    sample,
    stored: isBlank(stored) ? '' : stored,
    ambientDead: dead(hass, ambient),
    ambientMissing: !hass.states || !hass.states[ambient],
    ir: st(hass, E.cameraIrEntity, 'none'),
    frigateKey: isBlank(frigateKey) ? '' : frigateKey,
    frigate,
    panelPath: findFrigatePanel(hass, cfg),
  };
  m.health = buildHealth(hass, ambient);
  m.lamp = buildLamp(hass, cfg);
  m.presence = buildPresence(hass, m.slots);
  m.door = {
    open: st(hass, E.doorContact) === 'on',
    known: !dead(hass, E.doorContact),
    since: (so(hass, E.doorContact) || {}).last_changed,
    handle: st(hass, E.handleDepressed) === 'on',
    moving: st(hass, E.doorMoving) === 'on',
    lastSummary: st(hass, E.lastDoor, 'none'),
  };
  m.enroll = {
    active: isOn(hass, E.enrollMode),
    target: st(hass, E.enrollTarget, 'none'),
    visitor: isOn(hass, E.enrollVisitor),
    pendingName: storedName(st(hass, E.enrollPendingName, '')),
    free: Math.round(num(hass, E.freeSlots, 0)),
    map: st(hass, E.slotMap, ''),
    chosen: st(hass, E.enrollSlot, ''),
    windowActive: st(hass, E.tEnroll) === 'active',
  };
  m.pin = {
    active: isOn(hass, E.pinChangeMode),
    step: st(hass, E.pinChangeStep, 'none'),
    fails: Math.round(num(hass, E.pinChangeFails, 0)),
    hashSet: String(st(hass, E.pinHash, '')).trim().length === 64,
    blocked: isOn(hass, E.enrollMode) || isOn(hass, E.mfaPending)
      || isOn(hass, E.entryChallenge) || isOn(hass, E.doorbellExitPin),
  };
  m.alarming = m.security.key === 'alarm';
  m.needsAttention = m.alarming || m.security.tone === 'warn' || m.faults.length > 0;
  m.needsInstall = m.camera.ambientMissing || m.lamp.missing;
  return m;
}

function liveCameraId(m, ui) {
  const frigateCam = m.camera.frigate.camera;
  const ambientOk = m.camera.ambient && !m.camera.ambientDead;
  if (ui.camSource === 'frigate' && frigateCam) return frigateCam;
  if (ambientOk) return m.camera.ambient;
  if (frigateCam) return frigateCam;
  return m.camera.ambient || '';
}

/* =============================================================================
 * 7. ACTIONS
 *
 * Every service call the panel can make, in one list, so the blast radius of
 * this UI is auditable by reading a single function.
 *
 * Deliberately absent, and they must stay absent:
 *   - anything that writes input_text.portal_pin_hash
 *   - anything that writes a slot hash
 *   - anything that writes pending_* / portal_display_state / display_seq /
 *     challenge_origin
 *   - anything that fires guardian.major_alarm
 *
 * Narrow exception: while the doorbell-exit window is on, the status banner
 * may collect a PIN in panel memory and pass it once to
 * script.guardian_apply_doorbell_exit_pin. The digits are never written to a
 * helper and never rendered.
 * ========================================================================== */

/* payload is the script field. Do not also send value: a field or service-data
 * key named value is merged into input_text.set_value inside
 * guardian_slot_write, which is how the account picker could call the script
 * and still leave the helper unknown. */
function slotWriteData(slot, op, value) {
  const payload = value == null ? '' : String(value);
  return { slot: String(slot || ''), op: String(op), payload };
}

const ACTIONS = {
  toggleBoolean: (hass, id, on) =>
    hass.callService('input_boolean', on ? 'turn_on' : 'turn_off', {}, { entity_id: resolve(hass, id) }),

  setNumber: (hass, id, value) =>
    hass.callService('input_number', 'set_value', { value }, { entity_id: resolve(hass, id) }),

  setSelect: (hass, id, option) =>
    hass.callService('input_select', 'select_option', { option }, { entity_id: resolve(hass, id) }),

  setText: (hass, id, value) => {
    const slot = rfidSlotFromEntity(id);
    if (slot && /_name$/.test(String(id || ''))) {
      return hass.callService('script', 'guardian_slot_write',
        slotWriteData(slot, 'name', value));
    }
    return hass.callService('input_text', 'set_value', { value }, { entity_id: resolve(hass, id) });
  },

  /* Per-person notification preferences. Two entries rather than one because
   * they write two different helper domains; both are plain writes to
   * rfid_N_notify_* and nothing else, which keeps them inside the rule this
   * list exists to make checkable. */
  setNotifyLevel: (hass, slot, option) =>
    hass.callService('script', 'guardian_slot_write',
      slotWriteData(slot, 'notify_level', option)),

  /* Read-modify-write on ONE comma-separated helper, so the current value has
   * to come from live hass state at the moment of the tap - not from whatever
   * the mute list was when this row was rendered. Toggling two categories
   * quickly against a stale snapshot would have the second write undo the
   * first, which reads to the household as a switch that will not stay off. */
  setNotifyCategory: (hass, id, token, on) => {
    /* The helper stores what is OFF, so switching a category on removes it.
     * Only ever write tokens the panel knows, in a fixed order. A stray value
     * from a hand-edited helper is dropped here rather than preserved. */
    const csv = notifyMuteCsv(hass, id, token, on);
    const slot = rfidSlotFromEntity(id);
    return hass.callService('script', 'guardian_slot_write',
      slotWriteData(slot, 'notify_mute', csv));
  },

  clearBooleans: (hass, ids) => Promise.all((ids || []).map((id) =>
    hass.callService('input_boolean', 'turn_off', {}, { entity_id: resolve(hass, id) }))),

  setEntityNumber: (hass, id, value) =>
    hass.callService('number', 'set_value', { value }, { entity_id: resolve(hass, id) }),

  press: (hass, id) => hass.callService('button', 'press', {}, { entity_id: resolve(hass, id) }),

  pressInputButton: (hass, id) =>
    hass.callService('input_button', 'press', {}, { entity_id: resolve(hass, id) }),

  timerStart: (hass, id) => hass.callService('timer', 'start', {}, { entity_id: resolve(hass, id) }),

  script: (hass, name, data = {}) => hass.callService('script', name, data),

  reset: (hass, restartDevices = false) =>
    hass.callService('script', 'guardian_reset', { restart_devices: !!restartDevices }),

  clearSlot: (hass, slot) => hass.callService('script', 'guardian_clear_rfid_slot', { slot: String(slot) }),

  slotWrite: (hass, slot, op, value) =>
    hass.callService('script', 'guardian_slot_write', slotWriteData(slot, op, value)),

  /* The script path is still required (auth, one-account-per-key). It is not
   * sufficient: a YAML input_text that has never left unknown does not always
   * accept set_value from inside a script whose fields once included value.
   * This writes the exact entity id the picker verifies, after seeding empty
   * when the live state is still unknown. */
  persistHaUser: async (hass, slot, want) => {
    const entityId = `input_text.rfid_${String(slot || '')}_ha_user_id`;
    const payload = want == null ? '' : String(want);
    const others = [];
    if (payload) {
      slotIds(hass).forEach((id) => {
        if (String(id) === String(slot)) return;
        const other = `input_text.rfid_${id}_ha_user_id`;
        const s = hass && hass.states && hass.states[other];
        if (s && linkedHaUserId(s.state) === payload) {
          others.push(hass.callService('input_text', 'set_value',
            { value: '' }, { entity_id: other }));
        }
      });
    }
    await Promise.all(others);
    const cur = hass && hass.states && hass.states[entityId];
    const live = cur ? String(cur.state) : '';
    if (['unknown', 'unavailable'].includes(live)) {
      await hass.callService('input_text', 'set_value',
        { value: '' }, { entity_id: entityId });
    }
    return hass.callService('input_text', 'set_value',
      { value: payload }, { entity_id: entityId });
  },

  /* Same reason as persistHaUser: the script is required for auth, and is not
   * sufficient when a live scripts.yaml still binds raw from a field named
   * value. Direct select_option / set_value on the exact YAML id is what
   * the picker verifies. Do not resolve() these ids. */
  persistNotifyLevel: (hass, slot, option) => {
    const entityId = `input_select.rfid_${String(slot || '')}_notify_level`;
    return hass.callService('input_select', 'select_option',
      { option: String(option || '') }, { entity_id: entityId });
  },

  persistNotifyMute: async (hass, slot, want) => {
    const entityId = `input_text.rfid_${String(slot || '')}_notify_mute`;
    const payload = want == null ? '' : String(want);
    const cur = hass && hass.states && hass.states[entityId];
    const live = cur ? String(cur.state) : '';
    if (['unknown', 'unavailable'].includes(live)) {
      await hass.callService('input_text', 'set_value',
        { value: '' }, { entity_id: entityId });
    }
    return hass.callService('input_text', 'set_value',
      { value: payload }, { entity_id: entityId });
  },

  setHouseMode: (hass, mode, on) =>
    hass.callService('script', 'guardian_set_house_mode', { mode: String(mode), enabled: !!on }),

  refreshHaRoster: (hass, adminIds, userIds) =>
    hass.callService('script', 'guardian_refresh_ha_roster', {
      admin_ids: String(adminIds || ''), user_ids: String(userIds || ''),
    }),

  sampleLamp: (hass) => hass.callService('script', 'guardian_sample_ambient_light', {}),

  retuneLamp: (hass) => hass.callService('script', 'turn_on', {}, { entity_id: 'script.guardian_lamp_cal_retune' }),

  notifySelfTest: (hass) => hass.callService('script', 'guardian_notification_selftest', {}),

  /* Asks the BACKEND what it sees, rather than trusting what this browser has
   * rendered. The two can genuinely disagree: a UI-created helper left in
   * .storage can shadow the YAML one under a slightly different object id, and
   * the panel's entity resolver falls back to a suffix match - so the picker
   * can be showing one helper's value while every script reads another. That
   * divergence is invisible from either side alone, which is exactly why this
   * call is worth making instead of computing the same answer locally. */
  selfCheck: (hass) => {
    if (typeof hass.callWS === 'function') {
      return hass.callWS({
        type: 'call_service',
        domain: 'script',
        service: 'guardian_selfcheck',
        service_data: {},
        return_response: true,
      });
    }
    return Promise.resolve(null);
  },

  /* The setup wizard, run as a RE-CHECK. apply_defaults is false on purpose:
   * this button exists so a household can ask "what is still missing" as often
   * as they like, and a button that silently rewrote their thresholds every
   * time they pressed it would be a trap. The wizard's own first-boot write is
   * gated on input_boolean.guardian_setup_complete and happens once, from the
   * First Boot Setup automation - not from here. */
  setupCheck: (hass) => {
    if (typeof hass.callWS === 'function') {
      return hass.callWS({
        type: 'call_service',
        domain: 'script',
        service: 'guardian_setup_wizard',
        service_data: { apply_defaults: false },
        return_response: true,
      });
    }
    return Promise.resolve(null);
  },

  /* Response-carrying, like applyDoorbellExitPin below: the sheet reports what
   * actually happened rather than assuming it worked. callWS is the only way to
   * read a script response; the plain callService fallback still sends the
   * test, it just leaves the panel without a verdict to show. */
  notifyTest: (hass, slot) => {
    const data = { slot: String(slot) };
    if (typeof hass.callWS === 'function') {
      return hass.callWS({
        type: 'call_service',
        domain: 'script',
        service: 'guardian_notify_test',
        service_data: data,
        return_response: true,
      });
    }
    return hass.callService('script', 'guardian_notify_test', data);
  },

  createSsProgram: (hass) => hass.callService('script', 'guardian_create_ss_program', {}),

  deleteSsProgram: (hass, program) =>
    hass.callService('script', 'guardian_delete_ss_program', { program: String(program) }),

  applyDoorbellExitPin: (hass, pin) => {
    const data = { pin: String(pin), method: 'panel' };
    if (typeof hass.callWS === 'function') {
      return hass.callWS({
        type: 'call_service',
        domain: 'script',
        service: 'guardian_apply_doorbell_exit_pin',
        service_data: data,
        return_response: true,
      });
    }
    return hass.callService('script', 'guardian_apply_doorbell_exit_pin', data);
  },

  occupancyPulse: (hass) =>
    hass.callService('script', 'turn_on', {}, { entity_id: 'script.guardian_occupancy_pulse' }),

  setLight: (hass, id, data) =>
    hass.callService('light', 'turn_on', data, { entity_id: resolve(hass, id) }),
};

/* =============================================================================
 * 8. MARKUP HELPERS AND SHARED COMPONENTS
 * ========================================================================== */

const ICON = {
  home: 'mdi:home-outline', camera: 'mdi:cctv', activity: 'mdi:clock-outline',
  more: 'mdi:dots-horizontal', back: 'mdi:chevron-left', menu: 'mdi:menu',
};

const arg = (o) => esc(JSON.stringify(o));

function pill(text, tone = 'idle', opts = {}) {
  const cls = ['pill', opts.plain ? 'plain' : ''].filter(Boolean).join(' ');
  const led = opts.led ? '<i class="led"></i>' : '';
  const icon = opts.icon ? `<ha-icon icon="${esc(opts.icon)}"></ha-icon>` : '';
  return `<span class="${cls}" style="--tone:var(--g-${tone})">${led}${icon}${esc(text)}</span>`;
}

function btn(label, act, argObj = {}, opts = {}) {
  const cls = ['btn', opts.tone ? 'tone' : '', opts.solid ? 'solid' : '', opts.wide ? 'wide' : '',
    opts.sm ? 'sm' : ''].filter(Boolean).join(' ');
  const tone = opts.toneName ? `--tone:var(--g-${opts.toneName})` : '';
  const icon = opts.icon ? `<ha-icon icon="${esc(opts.icon)}"></ha-icon>` : '';
  const dis = opts.disabled ? 'disabled' : '';
  return `<button class="${cls}" style="${tone}" data-act="${esc(act)}" data-arg="${arg(argObj)}" ${dis}>${icon}<span>${esc(label)}</span></button>`;
}

function exitPinPad(ui) {
  const digits = String(ui.exitPin || '');
  const busy = !!ui.exitPinBusy;
  const err = ui.exitPinError || '';
  const dots = [0, 1, 2, 3, 4, 5].map((i) => `<i class="${i < digits.length ? 'on' : ''}"></i>`).join('');
  const cell = (label, act, argObj, opts) => btn(label, act, argObj, { sm: true, disabled: busy || !!opts.disabled, solid: !!opts.solid });
  return `<div class="pinpad" role="group" aria-label="Master PIN">
    <div class="pindots" aria-hidden="true">${dots}</div>
    ${err ? `<p class="pinerr">${esc(err)}</p>` : ''}
    <div class="pinkeys">
      ${cell('1', 'exitPinDigit', { key: '1' }, {})}
      ${cell('2', 'exitPinDigit', { key: '2' }, {})}
      ${cell('3', 'exitPinDigit', { key: '3' }, {})}
      ${cell('4', 'exitPinDigit', { key: '4' }, {})}
      ${cell('5', 'exitPinDigit', { key: '5' }, {})}
      ${cell('6', 'exitPinDigit', { key: '6' }, {})}
      ${cell('7', 'exitPinDigit', { key: '7' }, {})}
      ${cell('8', 'exitPinDigit', { key: '8' }, {})}
      ${cell('9', 'exitPinDigit', { key: '9' }, {})}
      ${cell('⌫', 'exitPinDigit', { key: 'back' }, {})}
      ${cell('0', 'exitPinDigit', { key: '0' }, {})}
      ${cell('Confirm', 'exitPinSubmit', {}, { solid: true, disabled: digits.length < 4 })}
    </div>
  </div>`;
}

function holdBtn(label, act, argObj = {}, opts = {}) {
  const tone = opts.toneName || 'alarm';
  const cls = ['btn', 'hold', opts.subtle ? '' : 'tone', opts.wide ? 'wide' : '', opts.sm ? 'sm' : ''].filter(Boolean).join(' ');
  const icon = opts.icon ? `<ha-icon icon="${esc(opts.icon)}"></ha-icon>` : '';
  return `<button class="${cls}" style="--tone:var(--g-${tone}); --hold-ms:${DEFAULTS.holdMs}ms"
    data-hold="${esc(act)}" data-arg="${arg(argObj)}">
    <i class="fill"></i>${icon}<span>${esc(label)}</span></button>`;
}

/* opts.act / opts.arg override the default input_boolean toggle. The
 * notification category switches are not booleans - they are members of one
 * comma-separated helper - so they need their own action, but they must look
 * and behave identically to every other switch in the panel. */
function sw(entityId, on, tone = 'ok', opts = {}) {
  const act = opts.act || 'toggle';
  const a = opts.act ? (opts.arg || {}) : { id: entityId, on: !on };
  return `<button class="sw" style="--tone:var(--g-${tone})" data-on="${on ? 1 : 0}"
    data-busy="${opts.busy ? 1 : 0}" data-act="${esc(act)}" data-arg="${arg(a)}"
    role="switch" aria-checked="${on}" aria-label="${esc(opts.label || entityId)}"><i></i></button>`;
}

function row(title, sub, right, opts = {}) {
  const cls = ['row', opts.act ? 'click' : '', opts.nav ? 'nav' : '',
    opts.icon ? 'has-lead' : ''].filter(Boolean).join(' ');
  const tone = opts.toneName ? `--tone:var(--g-${opts.toneName})` : '';
  const attrs = opts.act ? `data-act="${esc(opts.act)}" data-arg="${arg(opts.arg || {})}"` : '';
  const lead = opts.icon ? `<span class="lead"><ha-icon icon="${esc(opts.icon)}"></ha-icon></span>` : '';
  const chev = opts.nav ? '<ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>' : '';
  const subHtml = sub ? (opts.subHtml ? sub : esc(sub)) : '';
  return `<div class="${cls}" style="${tone}" ${attrs}>
    ${lead}<div class="lbl"><b>${esc(title)}</b>${subHtml ? `<small>${subHtml}</small>` : ''}</div>
    ${right ? `<div class="val${opts.toneName ? ' tone' : ''}">${right}</div>` : ''}
    ${chev}
  </div>`;
}

function navRow(title, sub, navArg, opts = {}) {
  return row(title, sub, opts.right || '', {
    act: 'nav', arg: navArg, nav: true, icon: opts.icon, toneName: opts.toneName,
  });
}

function lightObjectIds(hass) {
  return String(st(hass, E.lightsAvailable, '')).split(',').map((s) => s.trim()).filter(Boolean);
}

function lampOptionsStale(hass) {
  const lights = lightObjectIds(hass);
  if (!lights.length) return false;
  const raw = attr(hass, E.lampTarget, 'options', []) || [];
  const set = new Set(raw.map(String));
  return lights.some((id) => !set.has(id));
}

function lampTargetSelect(hass) {
  const raw = attr(hass, E.lampTarget, 'options', null);
  const allowed = (Array.isArray(raw) ? raw : []).map((x) => String(x).trim()).filter(Boolean);
  if (!allowed.includes('none')) allowed.unshift('none');
  const current = st(hass, E.lampTarget, 'none');
  const selected = allowed.includes(current) ? current : 'none';
  const pending = lightObjectIds(hass).some((id) => !allowed.includes(id));
  const label = (id) => {
    if (!id || id === 'none') return 'Not set';
    const named = attr(hass, `light.${id}`, 'friendly_name', '');
    return named ? String(named) : id.replace(/_/g, ' ');
  };
  return `<label class="notify-pick">
    <span>Room lamp</span>
    <select class="field" data-field="setSelect" data-arg="${arg({ id: E.lampTarget })}">
      ${allowed.map((id) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(label(id))}</option>`).join('')}
    </select>
  </label>
    ${selected === 'none' ? '<p class="notify-hint">Not set — lamp automation is idle until you pick a light</p>' : ''}
    ${pending ? '<p class="notify-hint">Updating the light list from Home Assistant…</p>' : ''}`;
}

function presenceTrackerIds(hass) {
  return String(st(hass, E.presenceTrackersAvailable, '')).split(',').map((s) => s.trim()).filter(Boolean);
}

function notifyPhoneLabel(hass, objectId) {
  if (!objectId || objectId === 'none') return 'Not linked';
  const named = attr(hass, `notify.${objectId}`, 'friendly_name', '');
  if (named) return String(named);
  return objectId.replace(/^mobile_app_/, '').replace(/_/g, ' ');
}

function notifySelectOptions(hass, slot) {
  const raw = attr(hass, slot.notifyEntity, 'options', null);
  const allowed = (Array.isArray(raw) ? raw : []).map((x) => String(x).trim()).filter(Boolean);
  if (!allowed.includes('none')) allowed.unshift('none');
  return allowed;
}

function notifyOptionsStale(hass) {
  const phones = notifyTargetIds(hass);
  if (!phones.length) return false;
  return slotIds(hass).some((id) => {
    const raw = attr(hass, `input_select.rfid_${id}_notify_target`, 'options', []) || [];
    const set = new Set(raw.map(String));
    return phones.some((p) => !set.has(p));
  });
}

/* Returns the pieces rather than one blob: slotCard places the picker in the
 * card body and the test button down in the action grid beside Hold: stolen,
 * and a single string could not be split across the two.
 *
 * setNotifyTarget, not the plain setSelect: picking a phone has to be verified
 * against the state that comes back, and picking Not linked has to clear the
 * restore mirror as well. A silent fire-and-forget select_option is how the
 * browser ended up showing a phone the backend did not have. */
function notifyTargetSelect(slot, hass, ui = {}) {
  const allowed = notifySelectOptions(hass, slot);
  const current = allowed.includes(slot.notifyTarget) ? slot.notifyTarget : 'none';
  const pending = notifyTargetIds(hass).some((p) => !allowed.includes(p));
  const linkState = ui.notifyLinkError === slot.id ? 'error' : '';
  const hint = linkState === 'error'
    ? `Home Assistant would not accept that phone — it may have gone offline. ${pending ? 'Refreshing the list…' : 'Try again in a moment.'}`
    : current === 'none' ? 'Not linked — alerts about this key go to everyone'
      : pending ? 'Updating the phone list from Home Assistant…' : '';
  return {
    select: `<select class="field" aria-label="Alerts go to" data-field="setNotifyTarget"
      data-arg="${arg({ id: slot.notifyEntity, slot: slot.id })}">
      ${allowed.map((id) => `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(notifyPhoneLabel(hass, id))}</option>`).join('')}
    </select>`,
    hint,
    hintTone: linkState === 'error' ? 'alarm' : '',
    testBtn: btn('Send test alert', 'notifyTest', { slot: slot.id },
      { sm: true, icon: 'mdi:cellphone-check', disabled: current === 'none' }),
  };
}

function seg(act, options, current, opts = {}) {
  const tone = opts.toneName || 'arm';
  return `<div class="seg ${opts.block ? 'block' : ''}" style="--tone:var(--g-${tone})">
    ${options.map((o) => `<button data-act="${esc(act)}" data-arg="${arg({ ...(opts.arg || {}), value: o.value })}"
      aria-pressed="${o.value === current}">${esc(o.label)}</button>`).join('')}
  </div>`;
}

function numberCtl(entityId, value, min, max, step, opts = {}) {
  const tone = opts.toneName || 'arm';
  const domain = entityId.split('.')[0];
  const act = domain === 'number' ? 'setEntityNumber' : 'setNumber';
  const dec = Math.max(0, String(step).includes('.') ? String(step).split('.')[1].length : 0);
  const show = opts.format ? opts.format(value) : Number(value).toFixed(dec);
  return `<div class="numctl" style="--tone:var(--g-${tone})">
    <div class="stepper">
      <button data-act="${act}" data-arg="${arg({ id: entityId, value: Math.max(min, +(value - step).toFixed(4)) })}" aria-label="decrease">−</button>
      <span class="n">${esc(show)}</span>
      <button data-act="${act}" data-arg="${arg({ id: entityId, value: Math.min(max, +(value + step).toFixed(4)) })}" aria-label="increase">+</button>
    </div>
    ${opts.bare ? '' : `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}"
      data-slider="${act}" data-arg="${arg({ id: entityId })}" aria-label="${esc(opts.label || entityId)}">`}
  </div>`;
}

/* A setting you can see. The picture is the control: drag it and the entity
 * moves, exactly as the range input it replaces did. opts.bare on the numberCtl
 * underneath keeps the stepper - so there is always a precise, keyboard-reachable
 * path to the same number, and the drag is an addition rather than a gate.
 *
 * Everything about the write path is unchanged: the drag resolves to the same
 * setNumber / setEntityNumber action the slider used, via _queueNumber. */
function tuneArg(entityId, bounds) {
  const { min, max, step } = bounds;
  const act = entityId.split('.')[0] === 'number' ? 'setEntityNumber' : 'setNumber';
  return arg({ id: entityId, act, min, max, step });
}

function tuneLockBtn(kind, unlocked) {
  return `<button type="button" class="tune-lock" data-act="tuneLock" data-arg="${arg({ kind })}"
      aria-pressed="${unlocked ? 'true' : 'false'}"
      aria-label="${unlocked ? 'Lock this drawing' : 'Unlock to drag'}">
      <ha-icon icon="${unlocked ? 'mdi:lock-open-variant' : 'mdi:lock'}"></ha-icon>
    </button>`;
}

function tuneDragHint(ui, kind, unlockedText) {
  return (ui && ui.tuneUnlocked === kind)
    ? unlockedText
    : 'Unlock the drawing to drag, or use the stepper below.';
}

function tuneStage(kind, entityId, value, bounds, svgMarkup, opts = {}) {
  const say = opts.say ? `<p class="tunesay" data-tunesay>${opts.say}</p>` : '';
  const tone = `--tone:var(--g-${opts.toneName || 'elev'})`;
  const unlocked = !!opts.unlocked;
  const lock = tuneLockBtn(kind, unlocked);
  const open = unlocked ? ' data-unlocked="1"' : '';
  const disabled = unlocked ? '' : ' aria-disabled="true"';
  /* Two values in one instrument. The lamp's dark and bright thresholds are a
   * single hysteresis band and the gap between them is the setting, so drawing
   * them apart was the thing that made them unreadable. role="slider" carries
   * exactly one value, so a two-thumb tuner is a group whose thumbs are each a
   * slider with their own entity, bounds and aria-value*. The padlock, the write
   * path and the stepper underneath are unchanged. */
  if (!entityId) {
    return `<div class="tune" data-tune="${esc(kind)}" role="group"
        aria-label="${esc(opts.label || kind)}" style="${tone}"${open}${disabled}>
      ${lock}
      ${svgMarkup}
      ${say}
    </div>`;
  }
  const { min, max, step } = bounds;
  return `<div class="tune" data-tune="${esc(kind)}" tabindex="${unlocked ? '0' : '-1'}" role="slider"
      data-tunearg="${tuneArg(entityId, bounds)}"
      aria-label="${esc(opts.label || entityId)}"
      aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}"
      aria-valuetext="${esc(opts.valueText || String(value))}"
      style="${tone}"${open}${disabled}>
    ${lock}
    ${svgMarkup}
    ${say}
  </div>`;
}

/* A read-only drawing on the same stage as a tuner, for the things that are
 * status rather than settings. sun.sun is the reason this exists: the sky is
 * worth drawing and must not be draggable. */
function illStage(svgMarkup, say, toneName = 'idle') {
  /* `say` is trusted HTML (static copy plus already-escaped numbers). Do not
   * pass entity state or a key name through it. */
  return `<div class="illstage" style="--tone:var(--g-${toneName})">
    ${svgMarkup}
    ${say ? `<p class="illsay">${say}</p>` : ''}
  </div>`;
}

function card(title, bodyHtml, opts = {}) {
  const hint = opts.hint ? `<span class="hint">${esc(opts.hint)}</span>` : '';
  const head = title ? `<div class="hd"><h2>${esc(title)}</h2>${hint}</div>` : '';
  return `<div class="group ${opts.cls || ''}">${head}<div class="bd ${opts.pad === false ? '' : 'pad'}">${bodyHtml}</div></div>`;
}

function stack(parts) {
  return `<div class="stack">${parts.filter(Boolean).join('')}</div>`;
}

/* note() always escapes. Trusted markup (static <b>, already-escaped ids) goes
 * through noteHtml. A key name in note() used to be stored XSS in this panel. */
function note(text, tone = 'arm', icon = 'mdi:information-outline') {
  return noteHtml(esc(text), tone, icon);
}

function noteHtml(html, tone = 'arm', icon = 'mdi:information-outline') {
  return `<div class="note" style="--tone:var(--g-${tone})">
    <ha-icon icon="${esc(icon)}"></ha-icon><div>${html}</div></div>`;
}

function empty(text, icon = 'mdi:check-circle-outline') {
  return `<div class="empty"><ha-icon icon="${esc(icon)}"></ha-icon>${esc(text)}</div>`;
}

function pageHead(title) {
  return `<div class="pagehead">
    <button class="back" data-act="back" data-arg="{}" aria-label="Back">
      <ha-icon icon="${ICON.back}"></ha-icon> Back</button>
    <h1>${esc(title)}</h1>
  </div>`;
}

function textField(entityId, value, placeholder = '', opts = {}) {
  const mono = opts.mono ? ' mono' : '';
  const shown = value === 'none' || value == null ? '' : String(value);
  const committed = opts.committed == null || opts.committed === 'none' ? shown : String(opts.committed);
  const dirty = shown !== committed && !opts.saved;
  const label = opts.saved ? 'Saved' : 'Save';
  const live = opts.live ? ' data-live="1"' : '';
  let trail = '';
  if (opts.live) {
    const st = opts.liveState || '';
    const hint = st === 'saving' ? 'Saving…'
      : st === 'saved' ? 'Saved'
      : st === 'error' ? 'Not saved'
      : (opts.liveHint || '');
    trail = `<span class="livehint" data-livehint data-state="${esc(st)}">${esc(hint)}</span>`;
  } else {
    trail = `<button class="btn solid sm" data-act="saveField" data-arg="${arg({ id: entityId })}" ${dirty ? '' : 'disabled'}>${label}</button>`;
  }
  return `<div class="savefield">
    <input class="field${mono}" type="text" spellcheck="false" autocapitalize="off" autocorrect="off"
      value="${esc(shown)}" placeholder="${esc(placeholder)}"
      data-field="setText" data-arg="${arg({ id: entityId })}" data-committed="${esc(committed)}"
      ${dirty ? 'data-dirty="1"' : ''}${live}>
    ${trail}
  </div>`;
}

function rgbCss(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return '';
  return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
}

function kelvinToRgb(k) {
  const t = Math.max(1000, Math.min(12000, Number(k) || 4000)) / 100;
  let r; let g; let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708 * Math.log(t) - 161.1196;
    b = t <= 19 ? 0 : 138.5177 * Math.log(t - 10) - 305.0448;
  } else {
    r = 329.6987 * (t - 60) ** -0.1332;
    g = 288.1222 * (t - 60) ** -0.0755;
    b = 255;
  }
  return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
}

function hsToRgb(h, s, v = 1) {
  const sat = Math.max(0, Math.min(1, (Number(s) || 0) / 100));
  const hue = ((Number(h) || 0) % 360) / 60;
  const c = v * sat;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = v - c;
  let rp = 0; let gp = 0; let bp = 0;
  if (hue < 1) { rp = c; gp = x; }
  else if (hue < 2) { rp = x; gp = c; }
  else if (hue < 3) { gp = c; bp = x; }
  else if (hue < 4) { gp = x; bp = c; }
  else if (hue < 5) { rp = x; bp = c; }
  else { rp = c; bp = x; }
  return [(rp + m) * 255, (gp + m) * 255, (bp + m) * 255];
}

function lampCss(L) {
  if (L.rgb) return rgbCss(L.rgb);
  if (L.hs) return rgbCss(hsToRgb(L.hs[0], L.hs[1]));
  if (L.kelvin) return rgbCss(kelvinToRgb(L.kelvin));
  return 'var(--g-accent)';
}

function wheelKnobStyle(hs) {
  const h = Array.isArray(hs) ? Number(hs[0]) || 0 : 0;
  const s = Array.isArray(hs) ? Math.max(0, Math.min(100, Number(hs[1]) || 0)) : 70;
  const rad = (h * Math.PI) / 180;
  const r = (s / 100) * 42;
  const x = 50 + Math.cos(rad) * r;
  const y = 50 + Math.sin(rad) * r;
  const fill = rgbCss(hsToRgb(h, Math.max(s, 40)));
  return `left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;background:${fill}`;
}

function lampDot(L) {
  return `<span class="lamp-dot" style="background:${esc(lampCss(L))}" title="Lamp colour"
    data-act="nav" data-arg="${arg({ tab: 'more', page: 'lamp' })}" role="button" aria-label="Open lamp colour"></span>`;
}

const LAMP_PRESETS = [
  { id: 'warm', label: 'Warm', kelvin: 2700, css: '#ffb36b' },
  { id: 'soft', label: 'Soft', kelvin: 3500, css: '#ffd7a8' },
  { id: 'day', label: 'Day', kelvin: 4000, css: '#fff4e0' },
  { id: 'cool', label: 'Cool', kelvin: 5000, css: '#e8f1ff' },
  { id: 'daylight', label: 'Daylight', kelvin: 6500, css: '#cfe8ff' },
  { id: 'red', label: 'Red', hs: [0, 100], css: '#e23' },
  { id: 'amber', label: 'Amber', hs: [35, 100], css: '#f90' },
  { id: 'green', label: 'Green', hs: [120, 80], css: '#3c6' },
  { id: 'blue', label: 'Blue', hs: [220, 90], css: '#38f' },
];

function lampColorCard(L, ui = {}) {
  if (L.missing) return '';
  const tone = ui.lampTone || (L.colorMode === 'color_temp' || L.colorMode === 'white' ? 'white' : 'color');
  const showColor = L.canHs && (tone === 'color' || !L.canTemp);
  const showWhite = L.canTemp && (tone === 'white' || !L.canHs);
  const hs = L.hs || [30, 80];
  const bright = L.brightness == null ? 180 : L.brightness;
  const kelvin = L.kelvin == null ? 4000 : L.kelvin;
  const modes = [];
  if (L.canHs) modes.push({ value: 'color', label: 'Colour' });
  if (L.canTemp) modes.push({ value: 'white', label: 'White' });

  const presets = LAMP_PRESETS.filter((p) => (p.hs && L.canHs) || (p.kelvin && L.canTemp));
  const body = [];
  if (modes.length > 1) {
    body.push(seg('lampTone', modes, showWhite ? 'white' : 'color', { toneName: 'ok' }));
  }
  if (showColor) {
    body.push(`<div class="wheel-wrap">
      <div class="wheel" data-wheel role="slider" aria-label="Lamp colour" aria-valuemin="0" aria-valuemax="360">
        <i class="knob" style="${wheelKnobStyle(hs)}"></i>
      </div>
    </div>`);
  }
  if (showWhite) {
    body.push(`<div class="numctl" style="--tone:var(--g-ok)">
      <div class="stepper">
        <span class="n">${Math.round(kelvin)}K</span>
      </div>
      <input class="kelvin-track" type="range" min="${Math.round(L.minK)}" max="${Math.round(L.maxK)}" step="50"
        value="${Math.round(kelvin)}" data-slider="setLight" data-arg="${arg({ id: L.entity, field: 'kelvin' })}"
        aria-label="Colour temperature">
    </div>`);
  }
  if (L.canBright) {
    body.push(`${row('Brightness', '', `${Math.round((bright / 255) * 100)}%`, {})}
      <div class="numctl" style="--tone:var(--g-ok)">
        <input type="range" min="1" max="255" step="1" value="${Math.round(bright)}"
          data-slider="setLight" data-arg="${arg({ id: L.entity, field: 'brightness' })}" aria-label="Brightness">
      </div>`);
  }
  if (presets.length) {
    body.push(`<div class="swatches">${presets.map((p) => {
      const pressed = p.kelvin
        ? (showWhite && Math.abs((L.kelvin || 0) - p.kelvin) < 80)
        : (showColor && L.hs && Math.abs(L.hs[0] - p.hs[0]) < 12);
      return `<button class="swatch" style="background:${p.css}" title="${esc(p.label)}"
        aria-label="${esc(p.label)}" aria-pressed="${pressed ? 'true' : 'false'}"
        data-act="lampPreset" data-arg="${arg({ id: L.entity, hs: p.hs || null, kelvin: p.kelvin || null })}"></button>`;
    }).join('')}</div>`);
  }
  body.push(note('Colour is a manual override. Ambient sampling still turns the lamp on and off.',
    'idle', 'mdi:palette-outline'));
  return card('Colour', body.join(''));
}

/* -----------------------------------------------------------------------------
 * 8b. DEVICE RENDERS
 *
 * Three physical devices, drawn once each. There is no fourth: the security
 * camera has no housing of its own - its lens and IR sensor are set into the
 * door lamp's bottom band, so illLamp() and illLens() are two crops of the same
 * object.
 *
 * GEOMETRY COMES FROM THE MESH, NOT FROM A PHOTOGRAPH. Envelope numbers below
 * were measured off the old monolith STLs (now `3D-Models/OLD/`) and only then
 * checked against docs/reference-images/. The current print set is exploded
 * under `3D-Models/Main/`; this drawing is not re-measured from those parts.
 * The twenty-first pass drew the lamp from a three-quarter photo in which the
 * top face is visible, which foreshortened the top edge into a pentagon. The
 * real object is a hexagonal lantern, 254 wide x 192 tall x 89 deep, and the
 * front elevation of it is a rectangle. The STLs are the printed housings only
 * - the speaker, LCD, keypad, push button, frosted panels and lens are bought
 * parts and are not in the mesh, so those come from the photographs.
 *
 * In all three models Y is vertical and +Z faces the viewer. Millimetres:
 *
 *   portal    73 x 182.75 x 57.5   drawn at 2x
 *   doorbell  86 x 95    x 73.9    drawn at 3x, rear O54 wall cone omitted
 *   lamp      254 x 192  x 89      drawn at 1x
 *
 * HOUSE STYLE, so the three read as one product family:
 *   - front elevation, upright and square to the viewer. Form comes from
 *     shading, not from turning the object.
 *   - one key light, upper left at ~35 degrees, in every drawing. Every face
 *     gradient runs that way, every specular sits on that side, every contact
 *     shadow falls to the lower right.
 *   - three-stop form gradient per face (lit / body / terminator), a rim on the
 *     shadow-side edge, ambient occlusion in every seam and recess.
 *   - gradients and <pattern> yes, <filter> no. Filter regions are the
 *     expensive part and Home draws four of these at once; the only blur stays
 *     a CSS filter, as before.
 *
 * IDS ARE NAMESPACED, NOT AVOIDED. The old rule was "no ids at all", because
 * the same drawing can appear twice. idns() derives a namespace from the kind
 * and size instead, which is deterministic (no counter that changes between
 * renders) and safe by construction: the panel is a shadow-DOM element that
 * swaps a single [data-view] host, so one view is in the DOM at a time and a
 * drawing never repeats at the same size within it.
 *
 * COLOUR DISCIPLINE, unchanged. A drawing knows two colours it did not pick:
 *   --tone    the status tone, chosen once in the model, exactly as every pill
 *             and edge in the panel reads it
 *   --lampc   the lamp's own light, the same light.* attributes the colour
 *             wheel writes
 * Everything else is --ill-*, which is material (printed PETG, gloss black
 * paint, frost, chrome, glass), not state. No status colour is baked into a
 * path, and gradient stops are tokens so dark mode inverts with the scheme.
 *
 * DETAIL BUDGET. The Home rack draws these 74px tall. .dev--sm drops .fine,
 * .dtl, .tex and .spec - the layers that would be sub-pixel there - and keeps
 * the form gradients, so a thumbnail still reads as a solid object rather than
 * as a second, simpler drawing kept in parallel.
 * -------------------------------------------------------------------------- */

/* One id namespace per drawing instance. 'portal' + 'sm' never collides with
 * 'portal' + 'lg'. Pass opts.uid if a call site ever needs a third copy. */
function idns(kind, size, uid) {
  const ns = `g-${kind}-${uid || size || 'lg'}`;
  return { id: (n) => `${ns}-${n}`, ref: (n) => `url(#${ns}-${n})` };
}

/* A linear gradient given as [offset, token, opacity?] stops. x1/y1/x2/y2 are
 * objectBoundingBox unless a userSpace box is passed. */
function grad(id, stops, x1 = 0, y1 = 0, x2 = 0.35, y2 = 1) {
  return `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${
    stops.map(([o, c, a]) =>
      `<stop offset="${o}" style="stop-color:${c}"${a == null ? '' : ` stop-opacity="${a}"`}/>`).join('')
  }</linearGradient>`;
}

function rgrad(id, stops, cx = '50%', cy = '50%', r = '50%', fx = null, fy = null) {
  const f = fx == null ? '' : ` fx="${fx}" fy="${fy}"`;
  return `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"${f}>${
    stops.map(([o, c, a]) =>
      `<stop offset="${o}" style="stop-color:${c}"${a == null ? '' : ` stop-opacity="${a}"`}/>`).join('')
  }</radialGradient>`;
}

/* The layer lines a 0.2mm FDM print leaves. Horizontal, because all of these
 * parts are printed face-up. Hidden at sm, where the pitch is sub-pixel. Ink on
 * a white housing; the door sensors pass --ill-spec instead, because on a black
 * housing the photographed lines are the ridges catching light, not shadow. */
function layerLines(id, pitch = 3, opacity = 0.055, color = 'var(--ill-ink)') {
  return `<pattern id="${id}" width="8" height="${pitch}" patternUnits="userSpaceOnUse">
    <rect width="8" height="${pitch}" fill="none"/>
    <rect width="8" height="${(pitch / 2).toFixed(2)}" y="0" fill="${color}" opacity="${opacity}"/>
  </pattern>`;
}

/* Contact shadow: the object sitting on the stage, not floating over it. Two
 * ellipses so the core is tight and the falloff is wide. */
function contact(cx, cy, rx, ry) {
  return `<g class="shadow">
    <ellipse cx="${cx}" cy="${cy}" rx="${rx * 1.32}" ry="${ry * 1.7}"
      fill="var(--ill-ink)" opacity=".07" style="filter:blur(9px)"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"
      fill="var(--ill-ink)" opacity=".16" style="filter:blur(4px)"/>
  </g>`;
}

/* Four Phillips screws, as photographed: a domed steel head with a cross slot
 * and a seated shadow. Used on the portal's module plates, the doorbell's
 * button plate and the lamp's skirt. */
function screw(x, y, r = 4.6) {
  return `<g class="fine">
    <circle cx="${x}" cy="${y + r * 0.16}" r="${r}" fill="var(--ill-ink)" opacity=".26"/>
    <circle cx="${x}" cy="${y}" r="${r}" fill="var(--ill-screw)"/>
    <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="var(--ill-ink)" stroke-width=".7" opacity=".45"/>
    <path d="M${(x - r * 0.62).toFixed(1)} ${y} H${(x + r * 0.62).toFixed(1)}
             M${x} ${(y - r * 0.62).toFixed(1)} V${(y + r * 0.62).toFixed(1)}"
      stroke="var(--ill-ink)" stroke-width="${(r * 0.28).toFixed(2)}" opacity=".62" stroke-linecap="round"/>
    <path d="M${(x - r * 0.5).toFixed(1)} ${(y - r * 0.5).toFixed(1)}
             a${r} ${r} 0 0 1 ${(r * 0.72).toFixed(1)} -${(r * 0.2).toFixed(1)}"
      fill="none" stroke="var(--ill-spec)" stroke-width=".8" opacity=".7" stroke-linecap="round"/>
  </g>`;
}

/* Fit a line of text to a fixed width. The portal's LCD is 82 units wide
 * whatever the state sentence happens to be. */
function fitFont(text, width, max, min = 5) {
  const len = Math.max(1, String(text).length);
  return Math.max(min, Math.min(max, width / (len * 0.615)));
}

function svgText(text, x, y, size, fill, opts = {}) {
  const weight = opts.weight || 500;
  const ls = opts.ls ? ` letter-spacing="${opts.ls}"` : '';
  const op = opts.opacity != null ? ` opacity="${opts.opacity}"` : '';
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="${size.toFixed(2)}"
    font-weight="${weight}" fill="${fill}"${ls}${op}>${esc(text)}</text>`;
}

/* The stage a render stands on. A device page opens with one of these: the
 * object on a lit floor, the state sentence under it, and up to three stat
 * tiles - so the page answers "is it alive, how well, and what is it doing"
 * before the first row of controls. Nothing here reads an entity; every value
 * is passed in by the view that already had it. */
function devStage(kind, svgMarkup, opts = {}) {
  const tone = opts.tone || 'idle';
  const caption = opts.caption
    ? `<div class="devcaption"><i class="led"></i><span>${esc(opts.caption)}</span></div>`
    : '';
  const stats = (opts.stats || []).filter(Boolean);
  const strip = stats.length
    ? `<div class="devstats">${stats.map((s) => `<div class="tile">
         <b>${s.value}</b><small>${esc(s.label)}</small></div>`).join('')}</div>`
    : '';
  return `<div class="devstage" data-dev="${esc(kind)}" data-online="${opts.online === false ? 0 : 1}"
      style="--tone:var(--g-${tone})${opts.lampc ? `;--lampc:${esc(opts.lampc)}` : ''}">
    <div class="floor">${svgMarkup}</div>
    ${caption}
    ${strip}
  </div>`;
}

/* --- The device registry ----------------------------------------------------
 * One place that knows what the three physical devices are called, what icon
 * stands for each, and where its page is. The Home rack, the Devices gallery,
 * the flow diagram and every nav row read from here, so a device is named the
 * same everywhere and an icon cannot drift between two call sites.
 *
 * There are three entries plus `door`, which is not a device: door sensing is a
 * reed switch and an MPU6050 wired into the portal, and its eyebrow says so.
 * -------------------------------------------------------------------------- */
const DEVICE = {
  portal: {
    name: 'Interior portal', short: 'Portal', icon: 'mdi:tablet-dashboard',
    role: 'Inside the door', page: 'portal',
    blurb: 'Keypad, screen, RFID reader and the door sensors',
  },
  doorbell: {
    name: 'Doorbell', short: 'Doorbell', icon: 'mdi:doorbell',
    role: 'Outside the door', page: 'doorbell',
    blurb: 'Push button and the outside RFID reader',
  },
  lamp: {
    name: 'Door lamp & camera', short: 'Lamp', icon: 'mdi:wall-sconce-flat',
    role: 'Above the door', page: 'lamp',
    blurb: 'The lantern, and the camera lens set into its skirt',
  },
  camera: {
    name: 'Door camera', short: 'Camera', icon: 'mdi:cctv',
    role: 'In the lamp', page: 'lamp',
    blurb: 'Lens and IR sensor, flush in the lamp’s bottom band',
  },
  door: {
    name: 'Door sensing', short: 'Door', icon: 'mdi:door',
    role: 'Wired into the portal', page: 'portal',
    blurb: 'Reed switch on the frame, handle sensor on the lever',
  },
};

/* A device card: the render placed on its own small stage, the live sentence,
 * and the chips the device page would show first. Tapping it opens the device;
 * the status chip still opens Home Assistant's more-info, so the eleventh
 * pass's escape hatch survives the redesign. */
function deviceCard(key, svgMarkup, opts = {}) {
  const d = DEVICE[key];
  const tone = opts.tone || 'idle';
  const chips = (opts.chips || []).filter(Boolean).join('');
  const nav = opts.page === false ? '' : `data-act="nav" data-arg="${arg({ tab: 'more', page: opts.page || d.page })}"`;
  return `<button class="devcard" data-dev="${esc(key)}" data-online="${opts.online === false ? 0 : 1}"
      style="--tone:var(--g-${tone})${opts.lampc ? `;--lampc:${esc(opts.lampc)}` : ''}"
      ${nav} aria-label="${esc(`${d.name}: ${opts.state || ''}`)}">
    <span class="well">${svgMarkup}</span>
    <span class="meta">
      <span class="eyebrow"><ha-icon icon="${esc(d.icon)}"></ha-icon>${esc(d.role)}</span>
      <b>${esc(d.name)}</b>
      <small>${esc(opts.state || d.blurb)}</small>
      ${chips ? `<span class="chips">${chips}</span>` : ''}
    </span>
    <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
  </button>`;
}

/* --- The signal path --------------------------------------------------------
 * What the device gallery is for: not four pictures, but the order in which
 * this house's hardware talks. Every node tone and every lit link comes from
 * the model that the rows on Home already read - no entity is added, and
 * nothing animates unless something is genuinely happening at that link.
 * -------------------------------------------------------------------------- */
function flowNode(key, tone, sub) {
  const d = DEVICE[key];
  return `<div class="fnode" style="--tone:var(--g-${tone})">
    <span class="fdot"></span>
    <ha-icon icon="${esc(d.icon)}"></ha-icon>
    <b>${esc(d.short)}</b><small>${esc(sub)}</small>
  </div>`;
}

function flowLink(active, tone, label) {
  return `<div class="flink${active ? ' on' : ''}" style="--tone:var(--g-${tone})"
    aria-hidden="true"><i></i>${active && label ? `<span>${esc(label)}</span>` : ''}</div>`;
}

function sysFlow(m, hass) {
  const h = m.health;
  const ringing = st(hass, E.doorbellButton) === 'on';
  const person = !!m.camera.frigate.personNow;
  const open = !!m.door.open;
  const t = (ok) => (ok ? 'ok' : 'alarm');

  const guardian = (sub) => `<div class="fnode" style="--tone:var(--g-accent)">
    <span class="fdot"></span><ha-icon icon="mdi:shield-home"></ha-icon>
    <b>Guardian</b><small>${esc(sub)}</small></div>`;

  return card('How it fits together', `
    <div class="flowlabel">Getting in</div>
    <div class="sysflow">
      ${flowNode('doorbell', t(h.doorbell.ok), h.doorbell.ok ? 'Press / card' : 'Offline')}
      ${flowLink(ringing, 'warn', 'ringing')}
      ${flowNode('portal', t(h.portal.ok), h.portal.ok ? 'Decides' : 'Offline')}
      ${flowLink(open, 'pass', 'open')}
      ${flowNode('door', t(h.imu.ok), open ? 'Open' : 'Closed')}
    </div>
    <div class="flowlabel second">Watching</div>
    <div class="sysflow">
      ${flowNode('camera', t(h.camera.ok), h.camera.ok ? 'Watching' : 'No feed')}
      ${flowLink(person, 'warn', 'person')}
      ${guardian(person ? 'Alerting' : 'Deciding')}
      ${flowLink(m.lamp.sampling, 'info', 'verdict')}
      ${flowNode('lamp', m.lamp.missing ? 'idle' : (m.lamp.on ? 'ok' : 'idle'), m.lamp.on ? 'Lit' : 'Dark')}
    </div>
    ${note('Door sensing is not a fourth device. The reed switch on the frame and the handle sensor on the lever are wired into the interior portal.',
      'idle', 'mdi:information-outline')}
  `);
}

/* --- 1. Interior portal ----------------------------------------------------
 * Reference: docs/reference-images/portal-photos/6c29306a…jpg. A vertical white
 * printed enclosure: speaker dome, a screwed-down plate holding the IPS
 * display, and a twelve-key phone keypad. The display is where live state
 * belongs - it is what
 * the real screen at the door is showing. */

const PORTAL_SCREEN_SUB = {
  alarm: 'Alarm sounding',
  challenge: 'Authenticate at the keypad',
  doorbellexit: 'PIN from the linked phone',
  mfa: 'Enter the master PIN',
  pinchange: 'Follow the prompts',
  enroll: 'Present a card',
  passage: 'You may pass',
  elevated: 'PIN required to pass',
  idle: 'Ready for input',
};

/* Keypad legends exactly as moulded on the part: a phone keypad, so 1 carries
 * no letters, 0 carries OPER, and 7/9 use the old PRS/WXY grouping. */
const PORTAL_KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PRS'], ['8', 'TUV'], ['9', 'WXY'],
  ['*', ''], ['0', 'OPER'], ['#', ''],
];

function illPortal(p, opts = {}) {
  const small = opts.size === 'sm';
  const cls = `dev dev-portal${small ? ' dev--sm' : ''}`;
  const g = idns('portal', small ? 'sm' : 'lg', opts.uid);
  const on = p.online;
  const screenOn = on && p.screenOn;
  const lit = screenOn ? '#FFFFFF' : 'var(--ill-body-3)';
  const screenFill = screenOn
    ? 'color-mix(in srgb, var(--tone) 46%, var(--ill-lcd))'
    : 'var(--ill-screen)';

  /* 3 x 4, 24-unit keys on a 29 / 28.7 pitch. The black pad is 92 x 120 units
   * (46 x 60 mm) inside a 116-unit plate, which is what the photograph shows. */
  const keys = [];
  const keyFill = p.backlight ? g.ref('keylit') : g.ref('key');
  const keyInk = p.backlight ? 'var(--ill-body)' : 'var(--ill-body-3)';
  for (let i = 0; i < 12; i++) {
    const x = 59 + (i % 3) * 29;
    const y = 225 + Math.floor(i / 3) * 28.7;
    const [digit, letters] = PORTAL_KEYS[i];
    keys.push(`<rect x="${x}" y="${y + 1.6}" width="24" height="24" rx="4"
      fill="var(--ill-gloss-3)" opacity=".85"/>`);
    keys.push(`<rect class="key" x="${x}" y="${y}" width="24" height="24" rx="4" fill="${keyFill}"/>`);
    keys.push(`<path class="spec" d="M${x + 3.5} ${y + 2.4} h17" stroke="var(--ill-spec)"
      stroke-width="1.1" stroke-linecap="round" opacity="${p.backlight ? 0.3 : 0.16}"/>`);
    if (letters) {
      keys.push(`<text class="dtl" x="${x + 12}" y="${y + 10.4}" text-anchor="middle" font-size="5.6"
        font-weight="620" letter-spacing="0.3" fill="${keyInk}"
        opacity="${p.backlight ? 0.92 : 0.62}">${letters}</text>`);
    }
    keys.push(`<text class="dtl" x="${x + 12}" y="${letters ? y + 19.6 : y + 16.4}" text-anchor="middle"
      font-size="${letters ? 10 : 11}" font-weight="640" fill="${keyInk}"
      opacity="${p.backlight ? 0.97 : 0.7}">${digit}</text>`);
  }

  const l2 = String(p.line2 || '').toUpperCase();
  const l3 = String(p.line3 || '');

  /* One white module plate, recessed into the cover: occluded along its top and
   * left where the cover overhangs it, catching light along the bottom. */
  const plate = (x, y, w, h) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${g.ref('plate')}"/>
    <rect class="tex" x="${x}" y="${y}" width="${w}" height="${h}" fill="${g.ref('lines')}"/>
    <path d="M${x} ${y + h} H${x + w}" stroke="var(--ill-spec)" stroke-width="1" opacity=".5"/>
    <path d="M${x} ${y} H${x + w} M${x} ${y} V${y + h}" stroke="var(--ill-ink)"
      stroke-width="1.4" opacity=".17"/>`;

  return `<svg class="${cls}" viewBox="0 0 200 400" role="img" aria-label="${esc(opts.label || 'Interior portal')}">
    <defs>
      ${grad(g.id('body'), [[0, 'var(--ill-body-0)'], [0.34, 'var(--ill-body)'], [0.82, 'var(--ill-body-2)'], [1, 'var(--ill-body-3)']], 0.1, 0, 0.85, 1)}
      ${grad(g.id('plate'), [[0, 'var(--ill-body)'], [0.4, 'var(--ill-body-0)'], [1, 'var(--ill-body-2)']], 0.15, 0, 0.9, 1)}
      ${grad(g.id('key'), [[0, 'var(--ill-dark-3)'], [0.55, 'var(--ill-dark)'], [1, 'var(--ill-dark-2)']])}
      ${grad(g.id('keylit'), [[0, 'color-mix(in srgb, var(--ill-hi) 26%, var(--ill-dark-3))'],
        [0.55, 'var(--ill-dark-3)'], [1, 'var(--ill-dark)']])}
      ${rgrad(g.id('cone'), [[0, 'var(--ill-dark-3)'], [0.55, 'var(--ill-dark)'],
        [0.88, 'var(--ill-gloss)'], [1, 'var(--ill-gloss-3)']], '38%', '32%', '68%')}
      ${rgrad(g.id('dome'), [[0, 'var(--ill-dark-3)'], [0.6, 'var(--ill-dark)'], [1, 'var(--ill-gloss-3)']], '34%', '28%', '72%')}
      ${grad(g.id('chrome'), [[0, 'var(--ill-chrome)'], [0.3, 'var(--ill-chrome-2)'],
        [0.62, 'var(--ill-chrome)'], [1, 'var(--ill-chrome-2)']], 0.15, 0, 0.85, 1)}
      ${grad(g.id('glass'), [[0, 'var(--ill-spec)', 0.22], [0.5, 'var(--ill-spec)', 0.04], [1, 'var(--ill-spec)', 0]], 0, 0, 0.6, 1)}
      ${layerLines(g.id('lines'), 2, 0.03)}
    </defs>

    ${contact(100, 381, 62, 5)}

    <!-- Body: printed PETG, 73 x 182.75 mm at 2x, 5 mm corner radius. -->
    <rect x="27" y="14" width="146" height="365" rx="10" fill="${g.ref('body')}"/>
    <rect class="tex" x="27" y="14" width="146" height="365" rx="10" fill="${g.ref('lines')}"/>
    <path class="spec" d="M35 17 H165" stroke="var(--ill-spec)" stroke-width="2.4"
      stroke-linecap="round" opacity=".75"/>
    <path class="spec" d="M30 26 V367" stroke="var(--ill-spec)" stroke-width="1.8"
      stroke-linecap="round" opacity=".5"/>
    <path d="M170 26 V367" stroke="var(--ill-body-4)" stroke-width="3" stroke-linecap="round" opacity=".55"/>
    <path d="M35 376 H165" stroke="var(--ill-ink)" stroke-width="2" stroke-linecap="round" opacity=".14"/>
    <rect x="27" y="14" width="146" height="365" rx="10" fill="none"
      stroke="var(--ill-ink)" stroke-width="1.1" opacity=".28"/>

    <!-- Cosmetic front cover: a 3 mm plate over the module screws. The module
         fixings show through the translucent PETG as faint dimples down both
         edges, which is the only marking the frame carries. There is no status
         LED: the RGB LED is optional in the build document and this unit was
         printed without one, so nothing is drawn above the speaker. -->
    <g class="fine" fill="var(--ill-body-4)" opacity=".5">
      <circle cx="35" cy="22" r="2.4"/><circle cx="165" cy="22" r="2.4"/>
      <circle cx="35" cy="371" r="2.4"/><circle cx="165" cy="371" r="2.4"/>
      <circle cx="35" cy="143.5" r="2"/><circle cx="165" cy="143.5" r="2"/>
      <circle cx="35" cy="211" r="2"/><circle cx="165" cy="211" r="2"/>
      <circle cx="35" cy="290" r="2"/><circle cx="165" cy="290" r="2"/>
    </g>

    <!-- 1. Speaker module. O40 mm cone in a chrome rim, domed centre cap. -->
    ${plate(42, 39.5, 116, 104)}
    <circle cx="100" cy="91.5" r="42.5" fill="var(--ill-ink)" opacity=".2"/>
    <circle cx="100" cy="91.5" r="41.5" fill="${g.ref('chrome')}"/>
    <circle cx="100" cy="91.5" r="37" fill="var(--ill-gloss-3)"/>
    <circle cx="100" cy="91.5" r="35" fill="${g.ref('cone')}"/>
    <g class="fine" fill="none" stroke="var(--ill-gloss-3)" stroke-width="1.1" opacity=".55">
      <circle cx="100" cy="91.5" r="30"/><circle cx="100" cy="91.5" r="25.5"/>
    </g>
    <circle cx="100" cy="91.5" r="21" fill="var(--ill-gloss-3)" opacity=".55"/>
    <circle cx="100" cy="91.5" r="12.5" fill="${g.ref('dome')}"/>
    <path class="spec" d="M89 84 a15 15 0 0 1 15 -7" fill="none" stroke="var(--ill-spec)"
      stroke-width="3" stroke-linecap="round" opacity=".3"/>
    <path class="spec" d="M93.5 87.5 a8 8 0 0 1 7 -3.5" fill="none" stroke="var(--ill-spec)"
      stroke-width="2.2" stroke-linecap="round" opacity=".5"/>

    <!-- 2. Display module. 1.14" 240x135 IPS behind its own black bezel. -->
    ${plate(42, 143.5, 116, 67.5)}
    ${screw(53, 154)}${screw(147, 154)}${screw(53, 200.5)}${screw(147, 200.5)}
    <rect x="62" y="154" width="76" height="46" rx="2.5" fill="var(--ill-ink)" opacity=".3"/>
    <rect x="62" y="153" width="76" height="46" rx="2.5" fill="var(--ill-gloss)"/>
    <rect x="62" y="153" width="76" height="46" rx="2.5" fill="none"
      stroke="var(--ill-gloss-3)" stroke-width="1"/>
    ${screenOn
      ? `<rect x="74" y="161" width="52" height="30" rx="1.5" fill="var(--tone)" opacity=".28"
           style="filter:blur(8px)"/>`
      : ''}
    <rect class="screen" x="74" y="161" width="52" height="30" rx="1.5" fill="${screenFill}"/>
    ${screenOn ? `
      <g class="dtl">
        ${svgText('GUARDIAN PORTAL', 100, 168.5, 4.1, lit, { weight: 600, ls: '0.55', opacity: 0.66 })}
        <path d="M79 171 H121" stroke="${lit}" stroke-width="0.6" opacity=".28"/>
        ${svgText(l2, 100, 181, fitFont(l2, 46, 8), lit, { weight: 700, ls: '0.15' })}
        ${svgText(l3, 100, 188.5, fitFont(l3, 46, 4.3), lit, { weight: 500, opacity: 0.68 })}
      </g>` : ''}
    <path class="spec" d="M74 161 h52 v11 z" fill="${g.ref('glass')}"/>

    <!-- 3. Keypad module. 3 x 4 phone keypad, screwed at its four corners. -->
    ${plate(42, 211, 116, 138)}
    ${screw(48, 226)}${screw(152, 226)}${screw(48, 334)}${screw(152, 334)}
    <rect x="54" y="221.5" width="92" height="120" rx="3" fill="var(--ill-ink)" opacity=".28"/>
    <rect x="54" y="220" width="92" height="120" rx="3" fill="var(--ill-gloss)"/>
    ${p.backlight
      ? `<rect x="56" y="222" width="88" height="116" rx="3" fill="var(--ill-hi)" opacity=".13"
           style="filter:blur(9px)"/>`
      : ''}
    <path class="spec" d="M57 222.5 H143" stroke="var(--ill-spec)" stroke-width="1.2"
      stroke-linecap="round" opacity=".22"/>
    ${keys.join('')}
  </svg>`;
}

/* --- 2. Doorbell -----------------------------------------------------------
 * 86 x 95 x 73.9 mm, drawn at 3x. As MOUNTED, which is not what the assembly
 * photographs show: image9.jpg and image5.jpg are the module with its cover
 * off, so they show the button plate, its four M3 screws and the bare 12 mm
 * red button. None of that is visible on the finished unit. The cover goes on
 * last (the build document is explicit: "install the top cover only after the
 * doorbell module is fully mounted"), and from then on the doorbell is two
 * plain slabs of translucent white PETG with a bell mark on the front:
 *
 *   body       86 x 95, r8, against the wall           STL Z 0-66
 *   top cover  77 x 86, r4, standing 8 mm proud        STL Z 66-73.9
 *
 * The cover IS the button - you press the whole face, and the 12 mm switch
 * behind it closes. So no bezel, no dome, no screws, nothing centred on the
 * face except the mark.
 *
 * The O54 rear wall cone (STL Z 2-40, "the hole must be at least 54 mm in
 * diameter") is not drawn either: it is mounting, not product.
 *
 * The material matters here more than on the other two. This part is printed
 * thin and unpainted, so it is genuinely translucent - the photographs show
 * light carrying through the whole slab and the edges glowing. That is also
 * where the status light goes: the RGB LED sits inside, so when it is on the
 * cover glows from within rather than a pilot lamp appearing somewhere. */

/* Drawn in a 100 x 100 box, mark centred at (50, 38). One continuous outline
 * with a flared mouth, a separate crown and a clapper - the shape moulded into
 * the real part, not a heavier interface glyph. */
const BELL_MARK = `
  <circle cx="50" cy="9" r="3.4"/>
  <path d="M21 65.5 L21 62 C27 56.5 29.5 48 29.5 35 C29.5 23 38.5 14 50 14
           C61.5 14 70.5 23 70.5 35 C70.5 48 73 56.5 79 62 L79 65.5 Z"/>
  <path d="M43.5 65 a6.5 5.5 0 0 0 13 0"/>`;

function illDoorbell(d, opts = {}) {
  const small = opts.size === 'sm';
  const cls = `dev dev-doorbell${small ? ' dev--sm' : ''}`;
  const g = idns('doorbell', small ? 'sm' : 'lg', opts.uid);
  const on = d.online;
  const glowing = on && d.lightOn;
  /* Cover spans x 34.5..265.5, y 33.5..291.5; its centre is 150, 162.5. The
   * mark is 29% of the cover's width, which is what the photographs measure. */
  const bellAt = 'translate(150 162.5) scale(1.24) translate(-50 -38)';

  return `<svg class="${cls}" viewBox="0 0 300 330" role="img" aria-label="${esc(opts.label || 'Doorbell')}">
    <defs>
      ${grad(g.id('body'), [[0, 'var(--ill-body-0)'], [0.4, 'var(--ill-body)'], [0.86, 'var(--ill-body-2)'], [1, 'var(--ill-body-3)']], 0.08, 0, 0.9, 1)}
      ${grad(g.id('lid'), [[0, 'var(--ill-body-0)'], [0.46, 'var(--ill-body-0)'],
        [0.8, 'var(--ill-body)'], [1, 'var(--ill-body-2)']], 0.14, 0, 0.86, 1)}
      ${rgrad(g.id('through'), [[0, 'var(--ill-body-0)', 0.9], [0.55, 'var(--ill-body-0)', 0.35],
        [1, 'var(--ill-body-0)', 0]], '42%', '34%', '72%')}
      ${layerLines(g.id('lines'), 3, 0.022)}
    </defs>

    ${contact(150, 308, 116, 7)}

    <!-- Body, 86 x 95 mm, flat to the wall. -->
    <rect x="21" y="20" width="258" height="285" rx="22" fill="${g.ref('body')}"/>
    <rect class="tex" x="21" y="20" width="258" height="285" rx="22" fill="${g.ref('lines')}"/>
    <path class="spec" d="M45 23.5 H255" stroke="var(--ill-spec)" stroke-width="3"
      stroke-linecap="round" opacity=".85"/>
    <path d="M40 31 H260" stroke="var(--ill-body-3)" stroke-width="1.4"
      stroke-linecap="round" opacity=".5"/>
    <path d="M28 46 V276" stroke="var(--ill-body-3)" stroke-width="1.4"
      stroke-linecap="round" opacity=".4"/>
    <path d="M275 50 V276" stroke="var(--ill-body-4)" stroke-width="4" stroke-linecap="round" opacity=".45"/>
    <path d="M45 301 H255" stroke="var(--ill-ink)" stroke-width="2.6" stroke-linecap="round" opacity=".14"/>
    <rect x="21" y="20" width="258" height="285" rx="22" fill="none"
      stroke="var(--ill-ink)" stroke-width="1.2" opacity=".22"/>

    <!-- The cover stands 8 mm proud and is the button. Its shadow falls on the
         body below and right of it; its own top edge takes the key light. -->
    <rect x="38" y="39" width="231" height="258" rx="16" fill="var(--ill-ink)"
      opacity=".17" style="filter:blur(6px)"/>
    <rect x="34.5" y="33.5" width="231" height="258" rx="16" fill="${g.ref('lid')}"/>

    <!-- Thin unpainted PETG: light carries through the slab, brightest where
         it is thinnest and away from the edges. -->
    <rect x="34.5" y="33.5" width="231" height="258" rx="16" fill="${g.ref('through')}" opacity=".3"/>
    ${glowing
      ? `<ellipse cx="150" cy="192" rx="64" ry="58" fill="var(--tone)"
           opacity=".10" style="filter:blur(24px)"/>
         <rect class="lit" x="34.5" y="33.5" width="231" height="258" rx="16"
           fill="var(--tone)" opacity=".025"/>`
      : ''}

    <path class="spec" d="M44 36.5 H256" stroke="var(--ill-spec)" stroke-width="2.6"
      stroke-linecap="round" opacity=".92"/>
    <path class="spec" d="M37.5 46 V279" stroke="var(--ill-spec)" stroke-width="1.8"
      stroke-linecap="round" opacity=".5"/>
    <path d="M262.5 46 V279" stroke="var(--ill-body-3)" stroke-width="2.2"
      stroke-linecap="round" opacity=".5"/>
    <path d="M44 289 H256" stroke="var(--ill-body-4)" stroke-width="2.4"
      stroke-linecap="round" opacity=".55"/>
    <rect x="34.5" y="33.5" width="231" height="258" rx="16" fill="none"
      stroke="var(--ill-ink)" stroke-width="1" opacity=".2"/>

    <!-- The bell mark, printed in a second filament so it sits flush in the
         surface, with just enough of a seated shadow to read as inlaid. -->
    <g class="${d.ringing ? 'chime' : ''}">
      <g transform="${bellAt}" fill="none" stroke="var(--ill-ink)" stroke-width="2.9"
         stroke-linecap="round" stroke-linejoin="round" opacity=".12"
         style="transform-box:view-box">${BELL_MARK}</g>
      <g transform="${bellAt}" fill="none" stroke="var(--ill-bell)" stroke-width="2.4"
         stroke-linecap="round" stroke-linejoin="round">${BELL_MARK}</g>
    </g>
  </svg>`;
}

/* --- 3. Door lamp, and the camera inside it --------------------------------
 * A hexagonal wall lantern, 254 x 192 x 89 mm, drawn 1:1. This is the drawing
 * the twenty-first pass got wrong: it was traced from lamp-1.jpg, a photograph
 * taken from above and to one side, in which the top face is visible and
 * foreshortens the top edge. That produced a pentagon that narrows at both top
 * and bottom. The mesh says otherwise.
 *
 * Plan section through the body, straight off the lamp mesh
 * (now 3D-Models/Main/door-light-camera-stls/; envelope from OLD/door-lamp.stl):
 *
 *   (2,0) (252,0) (252,42) (249,47) (174,86) (171,87)
 *   (84,87) (81,87) (6,48) (2,44)              [X, Z in mm]
 *
 * a flat back against the wall, two short side walls, two shoulders turned
 * 27.5 degrees, and a 93-wide front face. Projected square-on, that is a
 * RECTANGLE divided vertically 5.5 / 75 / 93 / 75 / 5.5, and the turn in the
 * shoulders has to be carried by shading rather than by outline. Horizontally
 * the STL panel plates sit at Y 67..185 of 192: a 7 mm black top rail, three
 * 86 x 118 frosted panels, and a 67 mm gloss-black skirt.
 *
 * The camera is inside that skirt (mesh parts at X 90..164, Y 0..49) on the
 * sloping underside, which is the upward tilt - and which is invisible from the
 * front, so the drawing stays upright and symmetric. Only the lens and the
 * sensor pinhole break the surface. There is no camera housing to draw: this
 * is it, and illLens() is the same drawing under a tighter viewBox. */

/* Body 23..277 across, 24..216 down. The six verticals are the plan section
 * above, offset by +23. The horizontals are the STL panel plates, as fractions
 * of the 192 height so every band foreshortens together.
 *
 * dEdge is the one liberty taken with the projection. A pure orthographic
 * elevation of this object is a flat rectangle, and drawn that way it reads as
 * a window rather than as a lantern - the two shoulders vanish. Six units (3%)
 * of foreshortening on the outer edges is what a viewer standing in front of it
 * actually sees, because those edges are 40 mm further away than the front
 * face. It stays upright, symmetric and true in its proportions; it is the
 * opposite of the three-quarter photo the pentagon came from. */
const LAMP = {
  x0: 23, x1: 28.5, x2: 103.5, x3: 196.5, x4: 271.5, x5: 277,
  yTop: 24, yBot: 216, dTop: 6, dBot: 3.5,
  fRail: 0.036, fPanelTop: 0.047, fPanelBot: 0.641, fSkirt: 0.651, fFacet: 0.760,
  cx: 150, lens: { x: 157, y: 187, r: 11 }, sensor: { x: 133, y: 187 },
};

/* How far a given x has receded: 0 across the front face, 1 at the outer edge. */
function lampK(x) {
  const L = LAMP;
  if (x >= L.x2 && x <= L.x3) return 0;
  if (x <= L.x1) return 1;
  if (x >= L.x4) return 1;
  return x < L.x2 ? (L.x2 - x) / (L.x2 - L.x1) : (x - L.x3) / (L.x4 - L.x3);
}
/* y of the band at height fraction f, at abscissa x. */
function lampY(x, f) {
  const L = LAMP;
  const k = lampK(x);
  const t = L.yTop + k * L.dTop;
  return t + f * ((L.yBot - k * L.dBot) - t);
}
/* A horizontal band between two height fractions, across the given verticals. */
function lampBand(f0, f1, xs) {
  const fwd = xs.map((x) => `${x.toFixed(1)} ${lampY(x, f0).toFixed(2)}`);
  const back = [...xs].reverse().map((x) => `${x.toFixed(1)} ${lampY(x, f1).toFixed(2)}`);
  return `M${fwd.join(' L')} L${back.join(' L')} Z`;
}

function lampDefs(g) {
  return `<defs>
    ${grad(g.id('front'), [[0, 'var(--ill-gloss-2)'], [0.28, 'var(--ill-gloss)'], [1, 'var(--ill-gloss-3)']], 0.2, 0, 0.8, 1)}
    ${grad(g.id('lshoulder'), [[0, 'var(--ill-gloss-3)'], [0.55, 'var(--ill-gloss)'], [1, 'var(--ill-gloss-2)']], 0, 0, 1, 0)}
    ${grad(g.id('rshoulder'), [[0, 'var(--ill-gloss)'], [0.5, 'var(--ill-gloss-3)'], [1, 'var(--ill-gloss-3)']], 0, 0, 1, 0)}
    ${grad(g.id('wall'), [[0, 'var(--ill-gloss-3)'], [1, 'var(--ill-gloss-3)']], 0, 0, 1, 0)}
    ${grad(g.id('rail'), [[0, 'var(--ill-gloss-2)'], [0.4, 'var(--ill-gloss)'], [1, 'var(--ill-gloss-3)']], 0, 0, 0, 1)}
    ${grad(g.id('under'), [[0, 'var(--ill-gloss-3)'], [0.7, 'var(--ill-gloss-3)'], [1, 'var(--ill-gloss)']], 0, 0, 0, 1)}
    ${grad(g.id('post'), [[0, 'var(--ill-gloss-2)'], [0.4, 'var(--ill-gloss)'], [1, 'var(--ill-gloss-3)']], 0, 0, 1, 0)}
    ${grad(g.id('frost'), [[0, 'var(--ill-body-0)'], [0.4, 'var(--ill-frost)'], [1, 'var(--ill-body-2)']], 0.15, 0, 0.6, 1)}
    ${grad(g.id('frostL'), [[0, 'var(--ill-body-2)'], [0.55, 'var(--ill-frost)'], [1, 'var(--ill-body-0)']], 0, 0, 1, 0.5)}
    ${grad(g.id('frostR'), [[0, 'var(--ill-frost)'], [0.5, 'var(--ill-body-2)'], [1, 'var(--ill-body-3)']], 0, 0, 1, 0.5)}
    ${grad(g.id('lit'), [[0, 'var(--ill-frost-warm)'], [0.4, 'var(--lampc, var(--ill-frost))'],
      [1, 'var(--lampc, var(--ill-frost))']], 0.2, 0, 0.6, 1)}
    ${rgrad(g.id('bulb'), [[0, '#FFFFFF', 0.92], [0.4, 'var(--ill-frost-warm)', 0.45],
      [1, 'var(--ill-frost-warm)', 0]], '50%', '46%', '58%')}
    ${rgrad(g.id('lens'), [[0, '#1B4E5C'], [0.4, '#0C2C38'], [0.7, '#061620'], [1, '#02090D']], '34%', '28%', '74%')}
    ${rgrad(g.id('bezel'), [[0, 'var(--ill-chrome-2)'], [0.42, 'var(--ill-dark-3)'],
      [0.8, 'var(--ill-gloss)'], [1, 'var(--ill-gloss-3)']], '32%', '24%', '80%')}
    ${grad(g.id('sheen'), [[0, 'var(--ill-spec)', 0.13], [0.4, 'var(--ill-spec)', 0], [1, 'var(--ill-spec)', 0]], 0, 0, 0.5, 1)}
  </defs>`;
}

/* The object itself, in one coordinate space, so the lamp page and the camera
 * page are the same drawing at two viewBoxes and cannot drift apart. */
function lampShell(g, o) {
  const L = LAMP;
  const on = o.on;
  const level = on ? Math.max(0.34, Math.min(1, (o.brightness == null ? 200 : o.brightness) / 255)) : 0;
  const XS = [L.x0, L.x1, L.x2, L.x3, L.x4, L.x5];

  /* Panel glass, inset 4 units from each post. Lit, all three take --lampc;
   * unlit, the left shoulder catches the key light and the right one loses it,
   * which is the whole reason the hexagon reads at all from straight ahead. */
  const glass = (xa, xb, offFill) => {
    const d = lampBand(L.fPanelTop, L.fPanelBot, [xa, xb]);
    return `<path class="panelglass" d="${d}" fill="${on ? g.ref('lit') : offFill}"/>`;
  };

  return `
    <!-- Silhouette. Nothing is drawn outside this. -->
    <path d="${lampBand(0, 1, XS)}" fill="var(--ill-gloss)"/>

    <!-- Frosted panels: 86 x 118 each, one per facet. -->
    ${glass(32, 99, g.ref('frostL'))}
    ${glass(201, 268, g.ref('frostR'))}
    ${glass(107, 193, g.ref('frost'))}
    ${on ? `
      <g class="lit" opacity="${(level * 0.95).toFixed(3)}">
        <ellipse cx="150" cy="94" rx="54" ry="60" fill="${g.ref('bulb')}"/>
        <ellipse cx="66" cy="96" rx="30" ry="52" fill="${g.ref('bulb')}" opacity=".45"/>
        <ellipse cx="234" cy="96" rx="30" ry="52" fill="${g.ref('bulb')}" opacity=".3"/>
      </g>` : ''}
    <path class="spec" d="${lampBand(L.fPanelTop, 0.28, [107, 193])}" fill="${g.ref('sheen')}"/>

    <!-- Corner posts and panel surrounds, painted the same gloss as the body.
         Each post shows two faces, so each gets its own lateral gradient. -->
    <path d="${lampBand(L.fRail, L.fSkirt, [L.x0, L.x1])}" fill="${g.ref('wall')}"/>
    <path d="${lampBand(L.fRail, L.fSkirt, [L.x4, L.x5])}" fill="${g.ref('wall')}"/>
    <path d="${lampBand(L.fRail, L.fSkirt, [L.x1, 32])}" fill="${g.ref('lshoulder')}"/>
    <path d="${lampBand(L.fRail, L.fSkirt, [268, L.x4])}" fill="${g.ref('rshoulder')}"/>
    <path d="${lampBand(L.fRail, L.fSkirt, [99, 107])}" fill="${g.ref('post')}"/>
    <path d="${lampBand(L.fRail, L.fSkirt, [193, 201])}" fill="${g.ref('post')}"/>
    <path d="${lampBand(L.fRail, L.fPanelTop, XS)}" fill="${g.ref('rail')}" opacity=".9"/>
    <path d="${lampBand(L.fPanelBot, L.fSkirt, XS)}" fill="${g.ref('front')}"/>
    <path d="${lampBand(L.fPanelTop, L.fPanelTop + 0.004, [32, 268])}" fill="var(--ill-ink)" opacity=".5"/>

    <!-- Top rail. The side profile puts a small chamfer on its front edge. -->
    <path d="${lampBand(0, L.fRail, XS)}" fill="${g.ref('rail')}"/>
    <path class="spec" d="${lampBand(0.004, 0.014, [L.x1, L.x2, L.x3, L.x4])}"
      fill="var(--ill-spec)" opacity=".5"/>
    <path d="${lampBand(L.fRail, L.fRail, XS)}" fill="none" stroke="var(--ill-ink)"
      stroke-width="1.2" opacity=".55"/>

    <!-- Skirt: the same three facets in gloss black, with the underside
         receding below the break where the mesh starts to slope. -->
    <path d="${lampBand(L.fSkirt, 1, [L.x0, L.x1])}" fill="${g.ref('wall')}"/>
    <path d="${lampBand(L.fSkirt, 1, [L.x4, L.x5])}" fill="${g.ref('wall')}"/>
    <path d="${lampBand(L.fSkirt, 1, [L.x1, L.x2])}" fill="${g.ref('lshoulder')}"/>
    <path d="${lampBand(L.fSkirt, 1, [L.x3, L.x4])}" fill="${g.ref('rshoulder')}"/>
    <path d="${lampBand(L.fSkirt, 1, [L.x2, L.x3])}" fill="${g.ref('front')}"/>
    <path d="${lampBand(L.fFacet, 1, XS)}" fill="${g.ref('under')}" opacity=".9"/>
    <path class="spec" d="${lampBand(L.fSkirt + 0.006, L.fSkirt + 0.026, [L.x1, L.x2, L.x3, L.x4])}"
      fill="var(--ill-spec)" opacity=".14"/>
    <path class="spec" d="M42 ${lampY(42, L.fSkirt + 0.01).toFixed(1)} L92 ${lampY(92, 0.98).toFixed(1)}"
      stroke="var(--ill-spec)" stroke-width="11" stroke-linecap="round" opacity=".055"/>
    <path d="${lampBand(L.fSkirt, 1, [L.x2, L.x2])}" stroke="var(--ill-gloss-3)" stroke-width="1.6" opacity=".9"/>
    <path d="${lampBand(L.fSkirt, 1, [L.x3, L.x3])}" stroke="var(--ill-gloss-3)" stroke-width="1.6" opacity=".9"/>
    <path d="${lampBand(L.fFacet, L.fFacet, XS)}" fill="none" stroke="var(--ill-gloss-3)"
      stroke-width="1.4" opacity=".8"/>
    <!-- Seams of the printed insert that carries the camera. -->
    <path class="fine" d="${lampBand(L.fFacet, 1, [113, 113])}" stroke="var(--ill-gloss-3)" stroke-width="1.1" opacity=".9"/>
    <path class="fine" d="${lampBand(L.fFacet, 1, [187, 187])}" stroke="var(--ill-gloss-3)" stroke-width="1.1" opacity=".9"/>
    <path class="fine" d="${lampBand(0.996, 0.996, [L.x1, L.x2, L.x3, L.x4])}" fill="none"
      stroke="var(--ill-spec)" stroke-width="1" opacity=".2"/>

    <!-- Light / IR sensor pinhole. -->
    <circle cx="${L.sensor.x}" cy="${L.sensor.y}" r="4" fill="var(--ill-gloss-3)"/>
    <circle cx="${L.sensor.x}" cy="${L.sensor.y}" r="2.2" fill="#04080B"/>
    <circle class="fine" cx="${L.sensor.x - 1.1}" cy="${L.sensor.y - 1.1}" r="1" fill="var(--ill-spec)" opacity=".4"/>

    <!-- The camera lens, flush in the skirt. Coated glass, one hotspot. -->
    <circle cx="${L.lens.x}" cy="${L.lens.y + 1.2}" r="${L.lens.r + 1}" fill="#000" opacity=".5"/>
    <circle cx="${L.lens.x}" cy="${L.lens.y}" r="${L.lens.r}" fill="${g.ref('bezel')}"/>
    <path class="spec" d="M${L.lens.x - 7.6} ${L.lens.y - 6.4} a${L.lens.r} ${L.lens.r} 0 0 1 12 -3.2"
      fill="none" stroke="var(--ill-spec)" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>
    <circle cx="${L.lens.x}" cy="${L.lens.y}" r="${L.lens.r - 2.4}" fill="#04080B"/>
    <circle class="glass" cx="${L.lens.x}" cy="${L.lens.y}" r="${L.lens.r - 3.4}" fill="${g.ref('lens')}"/>
    <circle cx="${L.lens.x}" cy="${L.lens.y}" r="${L.lens.r - 6.6}" fill="#02090D"/>
    <path class="spec" d="M${L.lens.x - 5.4} ${L.lens.y - 3.4} a6.4 6.4 0 0 1 6 -2.8" fill="none"
      stroke="var(--ill-spec)" stroke-width="2.2" stroke-linecap="round" opacity=".55"/>
    <circle class="fine" cx="${L.lens.x + 3.4}" cy="${L.lens.y + 4}" r="1.6" fill="var(--ill-spec)" opacity=".18"/>`;
}

function illLamp(L, opts = {}) {
  const small = opts.size === 'sm';
  const cls = `dev dev-lamp${small ? ' dev--sm' : ''}`;
  const g = idns('lamp', small ? 'sm' : 'lg', opts.uid);
  const on = L.on;
  const level = on ? Math.max(0.34, Math.min(1, (L.brightness == null ? 200 : L.brightness) / 255)) : 0;

  return `<svg class="${cls}" viewBox="0 0 300 250" role="img" aria-label="${esc(opts.label || 'Door lamp')}">
    ${lampDefs(g)}
    ${contact(150, 228, 118, 6)}
    ${on
      ? `<ellipse class="glow" cx="150" cy="96" rx="146" ry="104" fill="var(--lampc)"
           opacity="${(level * 0.36).toFixed(3)}" style="filter:blur(30px)"/>`
      : ''}
    ${lampShell(g, { on, brightness: L.brightness })}
  </svg>`;
}

/* The Camera tab's view of the same object: the identical drawing under a
 * tighter viewBox, so what the camera page shows is provably the lamp's skirt
 * and not a fourth device. Live is a steady ring at the lens in the ok tone,
 * never a red wash - live is not alarm. A detection is two rings that stop. */
function illLens(c, opts = {}) {
  const small = opts.size === 'sm';
  const cls = `dev dev-lens${small ? ' dev--sm' : ''}`;
  const g = idns('lens', small ? 'sm' : 'lg', opts.uid);
  const L = LAMP;

  return `<svg class="${cls}" viewBox="62 128 176 88" role="img"
      aria-label="${esc(opts.label || 'Door camera in the lamp')}">
    ${lampDefs(g)}
    ${lampShell(g, { on: c.lampOn, brightness: c.brightness })}

    ${c.person ? `
      <g class="ping ping1" style="transform-origin:${L.lens.x}px ${L.lens.y}px">
        <circle cx="${L.lens.x}" cy="${L.lens.y}" r="${L.lens.r + 4}" fill="none" stroke="var(--tone)" stroke-width="2.4"/>
      </g>
      <g class="ping ping2" style="transform-origin:${L.lens.x}px ${L.lens.y}px">
        <circle cx="${L.lens.x}" cy="${L.lens.y}" r="${L.lens.r + 4}" fill="none" stroke="var(--tone)" stroke-width="1.6"/>
      </g>` : ''}

    ${c.live
      ? `<g class="statusled" data-blink="0">
           <circle cx="${L.lens.x}" cy="${L.lens.y}" r="${L.lens.r + 2.6}" fill="none"
             stroke="var(--tone)" stroke-width="1.8" opacity=".9"/>
           <circle cx="${L.lens.x}" cy="${L.lens.y}" r="${L.lens.r + 2.6}" fill="none"
             stroke="var(--tone)" stroke-width="5" opacity=".16"/>
         </g>`
      : ''}
  </svg>`;
}

/* --- 4. Door sensing --------------------------------------------------------
 * The fourth cell on Home is door sensing, which lives inside the portal - so
 * this is a diagram of what those sensors watch, drawn to the same rules, not a
 * fourth device. There are TWO of them and they answer different questions:
 *
 *   reed switch    3D-Models/Main/interior-portal-stls/Door-Sensor-Housing1.stl
 *                  20.25 x 41.25 x 29.25  frame half, under
 *                                                           the head, cable out
 *                  Door-Sensor-Housing2.stl
 *                  20.25 x 35.25 x 11.5   leaf half, on the
 *                                                           leaf's top edge
 *     Open or closed. Both halves carry the same 3.5 x 16.7 slot 0.5 under their
 *     rim - reed capsule in one, magnet in the other - so the two register
 *     against each other across the gap, and the gap is the whole mechanism.
 *
 *   handle sensor  MPU-6050-Housing.stl  28 x 17 x 42        collar on the lever
 *     A 28 x 17 x 18.1 box carrying the breakout in a 22 x 4.5 x 12 slot, on a
 *     closed ring - bore O20.5, outer O23 - whose centre is 13.5 below the box.
 *     Which way the lever turned, which is the only thing that says which side an
 *     opening came from: the leaf's swing is one axis and cannot.
 *
 * HANDEDNESS. Until this pass the leaf pivoted on its left edge with the swing
 * arc on the right, which is the mirror of this door. The photographs are taken
 * from inside: the lever points right off its rose and the free edge is on the
 * left. That is not pedantry here - a reed at the hinge corner never separates,
 * so "top left" is only the right answer once the free edge is on the left.
 *
 * SCALE, the one declared liberty, in the spirit of the lamp's dEdge. At the
 * leaf's own scale (~0.073 units/mm) the reed halves are two units across and the
 * handle sensor is 1.5 x 2.3 - sub-pixel even at full size. The two housings, and
 * the handle furniture they clamp to, are drawn at 2.5x that: one factor for all
 * of them, every proportion within and between the parts held to the mesh. This
 * is the one diagram among the four renders rather than a scale drawing of an
 * object, which is what makes that affordable here and nowhere else.
 *
 * Housings are black here, not the white PETG of the other three, and the
 * MPU6050's is printed light grey - all from the build photographs, along with
 * the reed capsule in its window, the two fixings, and the twin-core leaving the
 * frame half for the trunking above the head.
 *
 * TWO DASHED TONE ARCS, one per axis: the big one at the free edge is the leaf's
 * swing, and it brightens while the IMU says the leaf is moving; the small one at
 * the lever's tip is the rotation the handle sensor measures, and the lever
 * itself turns with it. Nothing else in here carries a status colour.
 *
 * Both assemblies sit in .fine/.dtl/.tex, so Home's 74px cell drops them and
 * keeps the door. The tone mark in the reed gap does not: it is the status LED
 * this diagram has always carried, moved to the thing that actually changes.
 * -------------------------------------------------------------------------- */
/* Two decimals, the rounding every measurement in this diagram is quoted at. */
function d2(v) { return v.toFixed(2); }

/* An arc of `r` about (cx, cy) between two angles in degrees, 0 pointing right
 * and positive turning clockwise - the same sense as SVG's rotate(). */
function arcPath(cx, cy, r, a0, a1) {
  const pt = (a) => {
    const t = a * Math.PI / 180;
    return `${d2(cx + r * Math.cos(t))} ${d2(cy + r * Math.sin(t))}`;
  };
  return `M${pt(a0)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${pt(a1)}`;
}

/* Every dimension of the door, in one place, so the tuners on the portal page
 * and the status diagram cannot drift apart. This is the whole reason the parts
 * below are functions rather than one template: the tuners draw the same door,
 * not a second drawing of it kept in parallel. */
function doorGeo(open) {
  /* The leaf's free edge, which everything mounted on the leaf is measured from.
   * The leaf half and the handle ride it, so they travel when the door swings. */
  const lx = open ? 46 : 38;
  const ly = open ? 30 : 20;
  const rake = (12 - ly) / (104 - lx);          /* the leaf's top edge, in plan */
  /* Reed, frame half: 41.25 x 29.25 of front elevation at 2.5x, hung under the
   * head just inboard of the free-edge corner, where the photographs have it. */
  const fx0 = 38, fx1 = 45.53, fy0 = 10.6, fy1 = 15.94;
  /* Handle: rose, lever, and the collar clamped on the lever's neck. A depressed
   * lever is the lever turned, which is what the sensor in the collar reports. */
  const hx = lx + 7.4, hy = open ? 69 : 68;
  return {
    open, lx, ly, rake, fx0, fx1, fy0, fy1, hx, hy,
    leaf: open ? 'M104 12 L46 30 V108 L104 122 Z' : 'M104 12 L38 20 V116 L104 124 Z',
    inset: open ? 'M92 32 L58 43 V97 L92 104 Z' : 'M92 30 L50 35 V101 L92 106 Z',
    /* Reed, leaf half: 35.25 x 11.5, sitting on the leaf's top edge and following
     * its rake, because it is screwed to the leaf and the leaf is in perspective. */
    mx0: lx + 0.6, mx1: lx + 7.03, mh: 2.1,
    my0: ly + rake * 0.6, my1: ly + rake * 7.03,
    /* The gap: a unit and a half closed, thirteen open. The tone mark hangs at the
     * frame half's sensing face, so it bridges the two halves while they are
     * together and is left holding nothing once the leaf carries its magnet off. */
    gx: (fx0 + fx1) / 2, gy: fy1 + 1.15,
    cx: hx + 7.2,                               /* collar and box centre */
  };
}

/* The four materials this diagram is made of. Every call site that draws a door
 * part needs these in its own <defs>, namespaced by its own idns(). */
function doorDefs(g) {
  return `${grad(g.id('leaf'), [[0, 'var(--ill-body)'], [0.5, 'var(--ill-body-2)'], [1, 'var(--ill-body-3)']], 0.1, 0, 0.9, 1)}
      ${grad(g.id('sens'), [[0, 'var(--ill-dark-3)'], [0.45, 'var(--ill-dark)'], [1, 'var(--ill-dark-2)']], 0.1, 0, 0.85, 1)}
      ${grad(g.id('mpu'), [[0, 'var(--ill-body-2)'], [0.4, 'var(--ill-body-3)'], [1, 'var(--ill-body-4)']], 0.12, 0, 0.88, 1)}
      ${grad(g.id('steel'), [[0, 'var(--ill-chrome-2)'], [0.26, 'var(--ill-chrome)'],
        [0.66, 'var(--ill-chrome-2)'], [1, 'var(--ill-chrome-2)']], 0, 0, 0.18, 1)}
      ${layerLines(g.id('lines'), 1.1, 0.12, 'var(--ill-spec)')}`;
}

/* The head and the hinge stile, behind everything. */
function doorFrame() {
  return '<path d="M108 10 H26 V120" fill="none" stroke="var(--ill-body-3)" stroke-width="3.5" stroke-linecap="round"/>';
}

/* The leaf's swing at the free edge, brightening while the IMU says it moves.
 * Radius 42 about (54.66, 68), spanning 180 +/- 54.05 degrees. */
function doorSwingArc(moving) {
  return `<path class="fine" d="M30 34 a42 42 0 0 0 0 68" fill="none" stroke="var(--tone)"
      stroke-width="${moving ? 2.6 : 2}" stroke-dasharray="3 6"
      opacity="${moving ? 0.95 : 0.6}"/>`;
}

function doorLeaf(g, geo) {
  const { open } = geo;
  return `<path class="lit" d="${geo.leaf}" fill="${g.ref('leaf')}" stroke="var(--ill-ink)" stroke-width="1.4"
      stroke-linejoin="round" stroke-opacity=".35"/>
    <path class="spec" d="M104 12 L${open ? 46 : 38} ${open ? 30 : 20} V${open ? 46 : 38} L104 30 Z"
      fill="var(--ill-spec)" opacity=".35"/>
    <path class="fine" d="${geo.inset}" fill="none" stroke="var(--ill-body-4)" stroke-width="1.4" stroke-linejoin="round"/>`;
}

/* `deg` is the lever's rotation about the rose, which is exactly what the tilt
 * threshold measures - so the tuner passes a live value where the status drawing
 * passes 12 or nothing. opts.arc overrides the dashed tone arc's span; opts.hooks
 * adds the data-* attributes the drag handler mutates in place. */
function doorHandle(g, geo, deg, opts = {}) {
  const { hx, hy, cx } = geo;
  const turn = deg ? ` transform="rotate(${deg} ${hx} ${hy})"` : '';
  const arc = opts.arc === null ? null : (opts.arc || [-8, 28]);
  const hook = (name) => (opts.hooks ? ` data-${name}` : '');
  return `<!-- Handle. Polished lever on a round rose, and the grey printed collar with
         the breakout box on top of it, 13.5 above the bar's centre. -->
    <g class="fine">
      <ellipse cx="${hx}" cy="${d2(hy + 0.5)}" rx="4.4" ry="4.75" fill="var(--ill-ink)" opacity=".16"/>
      <ellipse cx="${hx}" cy="${hy}" rx="4.4" ry="4.75" fill="${g.ref('steel')}"/>
      <ellipse cx="${hx}" cy="${hy}" rx="4.4" ry="4.75" fill="none" stroke="var(--ill-ink)"
        stroke-width=".5" opacity=".3"/>
      <g${turn}${hook('lever')}>
        <rect x="${hx}" y="${d2(hy + 1.83)}" width="20.1" height="1.5" rx=".75"
          fill="var(--ill-ink)" opacity=".2"/>
        <rect x="${hx}" y="${d2(hy - 1.83)}" width="20.1" height="3.66" rx="1.83" fill="${g.ref('steel')}"/>
        <path class="spec" d="M${d2(hx + 2)} ${d2(hy - 1.05)} H${d2(hx + 18)}" stroke="var(--ill-spec)"
          stroke-width=".7" stroke-linecap="round" opacity=".6"/>
        <rect x="${d2(cx - 1.55)}" y="${d2(hy - 2.1)}" width="3.1" height="4.2" rx=".85" fill="${g.ref('mpu')}"/>
        <rect x="${d2(cx - 1.55)}" y="${d2(hy - 2.1)}" width="3.1" height="4.2" rx=".85" fill="none"
          stroke="var(--ill-ink)" stroke-width=".4" opacity=".3"/>
        <rect x="${d2(cx - 2.56)}" y="${d2(hy - 5.4)}" width="5.11" height="3.66" rx=".55"
          fill="var(--ill-ink)" opacity=".18"/>
        <rect x="${d2(cx - 2.56)}" y="${d2(hy - 5.76)}" width="5.11" height="3.66" rx=".55" fill="${g.ref('mpu')}"/>
        <rect x="${d2(cx - 2.56)}" y="${d2(hy - 5.76)}" width="5.11" height="3.66" rx=".55" fill="none"
          stroke="var(--ill-ink)" stroke-width=".4" opacity=".32"/>
        <path d="M${d2(cx - 2.2)} ${d2(hy - 2.2)} H${d2(cx + 2.2)}" stroke="var(--ill-ink)"
          stroke-width=".45" opacity=".28"/>
        <path class="spec" d="M${d2(cx - 1.9)} ${d2(hy - 5.3)} H${d2(cx + 1.4)}" stroke="var(--ill-spec)"
          stroke-width=".6" stroke-linecap="round" opacity=".55"/>
        <path d="M${d2(cx + 2.55)} ${d2(hy - 5.5)} V${d2(hy + 1.9)}" stroke="var(--ill-body-4)"
          stroke-width=".5" opacity=".55"/>
        <path class="dtl" d="M${d2(cx - 2.2)} ${d2(hy - 4.5)} C${d2(cx - 5.4)} ${d2(hy - 5.1)} ${d2(hx - 3)} ${d2(hy - 3.6)} ${d2(hx - 3.6)} ${d2(hy - 1.2)}"
          fill="none" stroke="var(--ill-body-4)" stroke-width=".55" stroke-linecap="round"/>
      </g>
      ${arc === null ? '' : `<path${hook('tiparc')} d="${arcPath(hx, hy, 19, arc[0], arc[1])}"
        fill="none" stroke="var(--tone)" stroke-width="1.2" stroke-dasharray="1.8 3"
        stroke-linecap="round" opacity=".55"/>`}
    </g>`;
}

function doorReedLeaf(g, geo) {
  const { mx0, mx1, mh, my0, my1 } = geo;
  return `<!-- Reed, leaf half. It rides the leaf's top edge, so the gap opens when the
         leaf swings, which is the only thing the reed is measuring. -->
    <g class="fine">
      <path d="M${d2(mx0)} ${d2(my0)} L${d2(mx1)} ${d2(my1)} L${d2(mx1)} ${d2(my1 - mh)} L${d2(mx0)} ${d2(my0 - mh)} Z"
        fill="${g.ref('sens')}"/>
      <path class="tex" d="M${d2(mx0)} ${d2(my0)} L${d2(mx1)} ${d2(my1)} L${d2(mx1)} ${d2(my1 - mh)} L${d2(mx0)} ${d2(my0 - mh)} Z"
        fill="${g.ref('lines')}"/>
      <path class="spec" d="M${d2(mx0 + 0.4)} ${d2(my0 - mh + 0.42)} L${d2(mx1 - 0.4)} ${d2(my1 - mh + 0.42)}"
        stroke="var(--ill-spec)" stroke-width=".5" stroke-linecap="round" opacity=".4"/>
      <path d="M${d2(mx1)} ${d2(my1)} V${d2(my1 - mh)}" stroke="var(--ill-body-4)" stroke-width=".45" opacity=".45"/>
      <path d="M${d2(mx0)} ${d2(my0)} L${d2(mx1)} ${d2(my1)}" stroke="var(--ill-ink)" stroke-width=".55" opacity=".35"/>
    </g>`;
}

function doorReedFrame(g, geo) {
  const { fx0, fx1, fy0, fy1 } = geo;
  return `<!-- Reed, frame half. Screwed under the head with its window facing the leaf
         half; the twin-core leaves its far end for the trunking above. -->
    <g class="fine">
      <rect x="${fx0}" y="${fy0}" width="${d2(fx1 - fx0)}" height="${d2(fy1 - fy0)}" rx=".7" fill="${g.ref('sens')}"/>
      <rect class="tex" x="${fx0}" y="${fy0}" width="${d2(fx1 - fx0)}" height="${d2(fy1 - fy0)}" rx=".7"
        fill="${g.ref('lines')}"/>
      <path class="spec" d="M${d2(fx0 + 0.6)} ${d2(fy0 + 0.5)} H${d2(fx1 - 0.9)}" stroke="var(--ill-spec)"
        stroke-width=".6" stroke-linecap="round" opacity=".5"/>
      <path d="M${d2(fx1)} ${d2(fy0 + 0.7)} V${d2(fy1 - 0.7)}" stroke="var(--ill-body-4)"
        stroke-width=".55" opacity=".5"/>
      <path d="M${fx0} ${d2(fy0 + 1.1)} H${d2(fx1)}" stroke="var(--ill-ink)" stroke-width=".5" opacity=".3"/>
      <rect class="dtl" x="${d2(fx0 + 0.55)}" y="${d2(fy1 - 1.05)}" width="${d2(fx1 - fx0 - 1.1)}" height="1.05"
        rx=".3" fill="var(--ill-gloss-3)"/>
      <rect class="dtl" x="${d2((fx0 + fx1) / 2 - 1.53)}" y="${d2(fy1 - 0.87)}" width="3.05" height=".64"
        rx=".32" fill="var(--ill-chrome)" opacity=".75"/>
      <circle cx="${d2(fx0 + 1.75)}" cy="${d2(fy0 + 2.7)}" r=".42" fill="var(--ill-gloss-3)" opacity=".8"/>
      <circle cx="${d2(fx1 - 1.75)}" cy="${d2(fy0 + 2.7)}" r=".42" fill="var(--ill-gloss-3)" opacity=".8"/>
      <path d="M${d2(fx1 - 0.4)} ${d2(fy0 + 1.8)} C${d2(fx1 + 3.4)} ${d2(fy0 + 1.8)} ${d2(fx1 + 3.9)} 7.6 ${d2(fx1 + 7.4)} 7.6 H96"
        fill="none" stroke="var(--ill-ink)" stroke-width="1.5" stroke-linecap="round" opacity=".12"/>
      <path d="M${d2(fx1 - 0.4)} ${d2(fy0 + 1.8)} C${d2(fx1 + 3.4)} ${d2(fy0 + 1.8)} ${d2(fx1 + 3.9)} 7.6 ${d2(fx1 + 7.4)} 7.6 H96"
        fill="none" stroke="var(--ill-body-0)" stroke-width=".9" stroke-linecap="round"/>
    </g>`;
}

function doorGap(geo, blink) {
  return `<!-- The reed gap. This diagram's status LED, moved off an anonymous box on
         the jamb and onto the one dimension the reed switch actually reads. -->
    <g class="statusled" data-blink="${blink ? 1 : 0}">
      <circle cx="${d2(geo.gx)}" cy="${d2(geo.gy)}" r="2.9" fill="var(--tone)" opacity=".16"/>
      <circle cx="${d2(geo.gx)}" cy="${d2(geo.gy)}" r="1.65" fill="var(--tone)"/>
    </g>`;
}

function illDoor(d, opts = {}) {
  const small = opts.size === 'sm';
  const cls = `dev dev-door${small ? ' dev--sm' : ''}`;
  const g = idns('door', small ? 'sm' : 'lg', opts.uid);
  const geo = doorGeo(d.open);
  const deg = d.handleDeg == null ? (d.handle ? 12 : 0) : d.handleDeg;

  return `<svg class="${cls}" viewBox="0 0 130 134" role="img" aria-label="${esc(opts.label || 'Door')}">
    <defs>
      ${doorDefs(g)}
    </defs>
    ${contact(72, 127, 34, 3.4)}
    ${doorFrame()}
    ${doorSwingArc(d.moving)}
    ${doorLeaf(g, geo)}

    ${doorHandle(g, geo, deg)}

    ${doorReedLeaf(g, geo)}

    ${doorReedFrame(g, geo)}

    ${doorGap(geo, d.blink)}
  </svg>`;
}

/* --- 4b. The door's three thresholds, drawn -----------------------------------
 * "12 degrees of handle tilt" and "2500 ms of lookback" are the two most
 * consequential numbers in the system - they decide whether an opening is
 * classified as coming from inside or outside - and as a stepper and a slider
 * they are unguessable. Each of the three is drawn here as the thing it actually
 * gates, built from the same doorGeo() the status diagram is built from.
 *
 * These are controls, not renders, so they carry one thing a device drawing may
 * not: chrome. Axis labels and readouts are --g-faint / --g-text, because they
 * are the panel talking, not the door. The door itself keeps the render rule -
 * --ill-* material, --tone for status, nothing else.
 *
 * All three are read-only functions of a plain object. The drag handler mutates
 * the marked nodes in place while a finger is down (data-lever, data-knob,
 * data-band, data-tunesay) and the next render replaces the whole thing, exactly
 * as the lamp's colour wheel already does with its knob.
 * -------------------------------------------------------------------------- */

/* One formatter per setting, used by the drawing, by the stepper underneath it,
 * by aria-valuetext and by the optimistic repaint - so the four can never quote
 * the same number four ways. */
const TUNE_FMT = {
  tilt: (v) => `${Math.round(v)}°`,
  swing: (v) => `${Math.round(v)} °/s`,
  lookback: (v) => `${(v / 1000).toFixed(1)}s`,
  luma: (v) => String(Math.round(v)),
  rotate: (v) => `${Math.round(v)}°`,
  mmclock: (v) => `${Math.round(v)} min`,
  hours: (v) => String(Math.round(v)).padStart(2, '0') + ':00',
};
function isHoursTune(kind) {
  return kind === 'hours' || (typeof kind === 'string' && kind.startsWith('hours-'));
}
function tuneFmt(kind, v) {
  const f = TUNE_FMT[kind] || (isHoursTune(kind) ? TUNE_FMT.hours : null);
  return f ? f(v) : String(v);
}

/* What the swing threshold means in a unit a person has: how long the leaf would
 * take to travel a right angle at exactly this rate. */
function swingSweep(v) {
  if (!v) return '—';
  const s = 90 / v;
  return `${s.toFixed(s < 10 ? 1 : 0)} s`;
}

/* One tick radiating from a centre, used by both angular tuners. */
function tuneTick(cx, cy, r0, r1, deg, stroke, w, opacity = 1) {
  const a = deg * Math.PI / 180;
  return `<path d="M${d2(cx + r0 * Math.cos(a))} ${d2(cy + r0 * Math.sin(a))} L${d2(cx + r1 * Math.cos(a))} ${d2(cy + r1 * Math.sin(a))}"
      stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" opacity="${opacity}"/>`;
}

function tuneLabel(x, y, text, size, opts = {}) {
  return `<text x="${d2(x)}" y="${d2(y)}" font-size="${size}" font-weight="640"
      text-anchor="${opts.anchor || 'middle'}" fill="${opts.fill || 'var(--g-faint)'}"
      style="font-variant-numeric:tabular-nums">${esc(text)}</text>`;
}

/* HANDLE TILT. The mapping is the identity: illDoor already turns the lever with
 * rotate(deg, rose), and that deg IS the threshold's unit. Drag the lever, read
 * the angle off the rose. A ghost lever stays at rest so the angle is always seen
 * as a difference, and the live tilt sits on the same arc as a needle. */
function illTiltTune(t, opts = {}) {
  const g = idns('tilt', 'tune', opts.uid);
  const geo = doorGeo(false);
  const { hx, hy } = geo;
  const R = 19;                                  /* the tone arc's own radius */
  const v = t.value;
  const at = (r, deg) => {
    const a = deg * Math.PI / 180;
    return [hx + r * Math.cos(a), hy + r * Math.sin(a)];
  };
  const knob = at(R, v);
  const live = t.live == null ? null : Math.max(0, Math.min(t.max, t.live));

  return `<svg viewBox="30 44 70 46" role="img" aria-hidden="true">
    <defs>${doorDefs(g)}</defs>
    ${doorLeaf(g, geo)}

    <!-- The track is the whole rotation the lever can be asked for, rest to max. -->
    <path d="${arcPath(hx, hy, R, 0, t.max)}" fill="none" stroke="var(--g-line-2)"
      stroke-width="2" stroke-dasharray="1.8 2.6" stroke-linecap="round"/>
    ${tuneTick(hx, hy, R - 2.4, R + 2.4, t.min, 'var(--g-faint)', 0.8, 0.7)}
    ${tuneTick(hx, hy, R - 2.4, R + 2.4, t.max, 'var(--g-faint)', 0.8, 0.7)}
    <!-- Set just outside each end of the track, so the knob never lands on one. -->
    ${tuneLabel(...at(R + 7, t.min - 4), `${t.min}°`, 4.2)}
    ${tuneLabel(...at(R + 7, t.max + 6), `${t.max}°`, 4.2)}

    <!-- Rest, kept on screen so the threshold reads as a difference. -->
    <g class="ghost">${doorHandle(g, geo, 0, { arc: null })}</g>

    <!-- Everything from rest to the threshold is the press being asked for. -->
    <path data-band d="${arcPath(hx, hy, R, 0, v)}" fill="none" stroke="var(--tone)"
      stroke-width="2.4" stroke-linecap="round" opacity=".9"/>

    ${doorHandle(g, geo, v, { arc: null, hooks: true })}

    <circle data-knob class="grab" cx="${d2(knob[0])}" cy="${d2(knob[1])}" r="3.6"
      fill="var(--tone)" stroke="var(--g-surface)" stroke-width="1.2"/>

    ${live == null ? '' : `<!-- Where the lever is standing right now. -->
    ${tuneTick(hx, hy, R + 3.4, R + 5.6, live, 'var(--tone)', 1.6)}`}
  </svg>`;
}

/* SWING RATE. A rate is not an angle, so this does not pretend that position on
 * the arc is how far the door has opened - the arc is relabelled as a rate axis,
 * in °/s, with ticks and both ends written on it. What it draws is the firmware's
 * actual two-sided gate: below the line the leaf counts as still and a lever
 * press is allowed to register, above it the leaf counts as moving and presses
 * are thrown away. The knob is the line between the two bands. */
const SWING_ARC = { cx: 54.66, cy: 68, r: 42, a0: 125.95, a1: 234.05 };

function swingAngle(v, min, max) {
  const f = Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
  return SWING_ARC.a0 + f * (SWING_ARC.a1 - SWING_ARC.a0);
}

function illSwingTune(s, opts = {}) {
  const g = idns('swing', 'tune', opts.uid);
  const geo = doorGeo(false);
  const { cx, cy, r, a0, a1 } = SWING_ARC;
  const at = (rr, deg) => {
    const a = deg * Math.PI / 180;
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  };
  const av = swingAngle(s.value, s.min, s.max);
  const knob = at(r, av);
  const live = s.live == null ? null : swingAngle(Math.max(s.min, Math.min(s.max, s.live)), s.min, s.max);
  const ticks = [];
  for (let i = 1; i < 6; i++) {
    const a = a0 + (i / 6) * (a1 - a0);
    ticks.push(tuneTick(cx, cy, r - 2.4, r + 2.4, a, 'var(--g-faint)', 0.7, 0.55));
  }

  return `<svg viewBox="4 22 96 92" role="img" aria-hidden="true">
    <defs>${doorDefs(g)}</defs>
    ${doorLeaf(g, geo)}

    <!-- Still: the leaf is not considered to be moving, and a lever press counts.
         This is the band that grows as the number goes up, so it is the one that
         carries the tone: dragging towards "more" fills more of the track. -->
    <path data-band d="${arcPath(cx, cy, r, a0, av)}" fill="none" stroke="var(--tone)"
      stroke-width="3.4" stroke-linecap="round" opacity=".9"/>
    <!-- Moving: the leaf is swinging, and a lever press is discarded as swing error. -->
    <path data-band2 d="${arcPath(cx, cy, r, av, a1)}" fill="none" stroke="var(--ill-body-4)"
      stroke-width="3.4" stroke-linecap="round" opacity=".5"/>
    ${ticks.join('')}
    ${tuneLabel(...at(r + 6, a0), `${s.min}`, 4.4)}
    ${tuneLabel(...at(r + 6, a1), `${s.max}`, 4.4)}
    <!-- What the two bands mean, which is the whole reason this is not a slider.
         Set hard against the leaf's free edge at x=38, so they sit in the gap
         between the arc and the door rather than straddling either. -->
    ${tuneLabel(36, 82, 'still', 4.6, { anchor: 'end' })}
    ${tuneLabel(36, 56, 'moving', 4.6, { anchor: 'end' })}

    ${doorHandle(g, geo, 0, { arc: null })}

    <circle data-knob class="grab" cx="${d2(knob[0])}" cy="${d2(knob[1])}" r="4.2"
      fill="var(--tone)" stroke="var(--g-surface)" stroke-width="1.3"/>

    ${live == null ? '' : `<!-- What the IMU is reading right now. -->
    ${tuneTick(cx, cy, r + 4, r + 7, live, 'var(--tone)', 1.8)}`}
  </svg>`;
}

/* HANDLE LOOKBACK. This is the one of the three the door's geometry genuinely
 * cannot carry: a window in milliseconds has no representation in a plan view of
 * a door, and drawing it on the leaf would be decoration pretending to be a
 * diagram. So it gets a time axis instead - same materials, same tone rule, and
 * the reed gap's own tone mark standing at t=0, which is the instant the whole
 * window is measured back from.
 *
 * The shaded floor is not decoration either: the firmware holds handle_depressed
 * for 400 ms after the lever returns to rest, so under that value the press is
 * still being reported as held and the lookback is buying nothing. */
const LOOKBACK_AXIS = { x0: 26, x1: 274, y: 54 };
const LOOKBACK_KNOB = { half: 4, height: 40 };

/* Where the pressed-lever glyph sits inside the window, and whether there is
 * room for it at all. At the shortest window the band is twenty units wide and
 * the lever would hang out over the reed mark, so it fades out instead. */
function lookbackLever(bx) {
  const { x1 } = LOOKBACK_AXIS;
  return {
    x: Math.min(bx + 9, x1 - 22),
    opacity: Math.max(0, Math.min(1, (x1 - bx - 26) / 20)).toFixed(2),
  };
}

function illLookbackTune(k, opts = {}) {
  const { x0, x1, y } = LOOKBACK_AXIS;
  const xFor = (ms) => x1 - (Math.max(0, Math.min(k.max, ms)) / (k.max || 1)) * (x1 - x0);
  const bx = xFor(k.value);
  const lever = lookbackLever(bx);
  const floor = xFor(400);
  const ticks = [];
  for (let ms = 1000; ms <= k.max; ms += 1000) {
    const x = xFor(ms);
    ticks.push(`<path d="M${d2(x)} ${y + 12} V${y + 16}" stroke="var(--g-line-2)" stroke-width="1"/>
    ${tuneLabel(x, y + 27, `${ms / 1000}s`, 9.5)}`);
  }

  return `<svg viewBox="0 0 300 92" role="img" aria-hidden="true">
    <!-- Time runs backwards to the left. The door opens at the right-hand end. -->
    <path d="M${x0} ${y + 12} H${x1}" stroke="var(--g-line-2)" stroke-width="1.4" stroke-linecap="round"/>
    ${ticks.join('')}

    <!-- Under 400 ms the lever has not even been released yet. -->
    <rect x="${d2(floor)}" y="${y - 14}" width="${d2(x1 - floor)}" height="26" rx="3"
      fill="var(--ill-body-4)" opacity=".16"/>

    <!-- The window: a press that ended anywhere in here still says "inside". -->
    <rect data-band x="${d2(bx)}" y="${y - 14}" width="${d2(x1 - bx)}" height="26" rx="3"
      fill="var(--tone)" opacity=".2"/>
    <rect data-band2 x="${d2(bx)}" y="${y - 14}" width="${d2(x1 - bx)}" height="26" rx="3"
      fill="none" stroke="var(--tone)" stroke-width="1.4"/>

    <!-- The lever that was pressed, sitting inside the window it has to land in. -->
    <g data-lever transform="translate(${d2(lever.x)} ${y - 1})" opacity="${lever.opacity}">
      <circle cx="0" cy="0" r="5" fill="var(--ill-chrome-2)" stroke="var(--ill-ink)"
        stroke-width=".7" stroke-opacity=".4"/>
      <rect x="0" y="-2.1" width="19" height="4.2" rx="2.1" fill="var(--ill-chrome)"
        stroke="var(--ill-ink)" stroke-width=".5" stroke-opacity=".3" transform="rotate(12)"/>
    </g>

    <!-- t = 0: the reed's two halves separate. This diagram's one status mark. -->
    <path d="M${x1} ${y - 22} V${y + 16}" stroke="var(--tone)" stroke-width="1.6"
      stroke-linecap="round" opacity=".8"/>
    <circle cx="${x1}" cy="${y - 1}" r="7.6" fill="var(--tone)" opacity=".16"/>
    <circle cx="${x1}" cy="${y - 1}" r="4.2" fill="var(--tone)"/>
    ${tuneLabel(x1, y + 27, 'door opens', 9.5, { anchor: 'end' })}

    <!-- The handle. Everything left of it is too long ago to count. -->
    <rect data-knob class="grab" x="${d2(bx - LOOKBACK_KNOB.half)}" y="${y - LOOKBACK_KNOB.height / 2 - 1}"
      width="${LOOKBACK_KNOB.half * 2}" height="${LOOKBACK_KNOB.height}" rx="${LOOKBACK_KNOB.half}"
      fill="var(--tone)" stroke="var(--g-surface)" stroke-width="1.6"/>
    ${tuneLabel(x0, y - 22, 'earlier', 9.5, { anchor: 'start' })}
  </svg>`;
}

/* --- 4c. The lamp's numbers, drawn -------------------------------------------
 * More -> Lamp ended in three cards of bare numbers. "Dark below 45" does not
 * tell a household member whether their landing is dark enough for the lamp to
 * come on; "42.3 degrees" does not say whether that is dusk or noon; "30m" does
 * not say when the sun will overrule a stuck camera. Those are also the first
 * three things you want at 22:00 when the lamp is wrong.
 *
 * What is drawn here is the decision tree in scripts.yaml, not a prettier set of
 * sliders. Three rules held over from the door's tuners:
 *
 *   - the picture is an addition. Every setting keeps its bare numberCtl
 *     stepper, and the write path is the same setNumber through _queueNumber.
 *   - nothing is invented. No sample history is stored anywhere the panel can
 *     reach, so no trail is drawn. sensor.guardian_camera_luminance is
 *     unavailable between samples by design, so the mark falls back to the luma=
 *     of the last result and the sentence says which one it is. sun.sun is
 *     status and gets no handle.
 *   - colour is --tone (status the model picked), --lampc (the lamp's own light,
 *     the same light.* attributes the colour wheel writes) and --ill-* material.
 *     The luma band puts --lampc where the lamp comes on, which is the one place
 *     in the panel where that colour is the literal subject.
 * -------------------------------------------------------------------------- */

/* A read-only port of the decision tree in scripts.yaml ->
 * guardian_sample_ambient_light (its `decision:` variable). It writes nothing,
 * calls nothing, and starts no sample. THE YAML IS THE AUTHORITY: if the two
 * ever disagree, the YAML is right and this is the bug.
 *
 * Note the -3 guard on off_camera. It is in the template and in no document -
 * DEPLOY.md, audit F-38 and F-55 all describe only -6 and +10 - and it means a
 * bright reading with the sun between -6 and -3 is neither an override nor an
 * accepted "bright". It falls through to hold. */
function lampVerdict(i) {
  const bandOk = i.dark < i.bright;
  const night = i.sunOk && i.sunElev < -6;
  const day = i.sunOk && i.sunElev > 10;
  const ok = i.lumaValid && bandOk;
  if (i.auto && !i.calReady) return night ? 'on_sun' : day ? 'off_sun' : 'hold';
  if (ok && i.luma >= i.bright && night) return 'on_sun_override';
  if (ok && i.luma <= i.dark && day) return 'off_sun_override';
  if (ok && i.luma <= i.dark) return 'on_camera';
  if (ok && i.luma >= i.bright && !(i.sunOk && i.sunElev < -3)) return 'off_camera';
  if (!i.lumaValid && night) return 'on_sun';
  if (!i.lumaValid && day) return 'off_sun';
  if (i.lumaValid && day) return 'off_day_hold';
  return 'hold';
}

/* The same two edges the mismatch clock uses to decide what the lamp should be. */
function sunZone(elev) {
  if (elev == null || !Number.isFinite(elev)) return 'unknown';
  if (elev < -6) return 'night';
  if (elev > 10) return 'day';
  return 'twilight';
}

const SUN_ZONE_WORD = {
  night: 'below the horizon',
  twilight: 'in twilight',
  day: 'well up',
  unknown: 'not being reported',
};

const SUN_ZONE_TONE = { night: 'elev', twilight: 'info', day: 'warn', unknown: 'idle' };

/* Which of the three bands a reading falls in, in the words on the drawing. */
function lumaBandWord(v, dark, bright) {
  if (v == null || !Number.isFinite(v)) return null;
  /* Crossed over, so no band means anything: the sampler refuses every camera
   * branch and holds. There is no honest word for where the reading sits. */
  if (dark >= bright) return null;
  if (v <= dark) return 'comes on';
  if (v >= bright) return 'goes off';
  return 'stays as it was';
}

/* The same fact as a sentence a person can read. This says what the light level
 * on its own asks for; whether the sky lets it happen is the next card's job. */
const LUMA_CLAUSE = {
  'comes on': 'dark enough to switch the lamp on',
  'stays as it was': 'inside the gap, so the lamp would be left as it is',
  'goes off': 'bright enough to switch the lamp off',
};

function lumaBandClause(v, dark, bright) {
  const w = lumaBandWord(v, dark, bright);
  return w ? LUMA_CLAUSE[w]
    : 'neither, because the two are crossed over — the lamp can only hold';
}

/* 45-degree hatch, for the hold band and for an inverted overlap. Patterns and
 * gradients are allowed in these drawings; filters are not. */
function hatch(id, color, opacity = 0.55, pitch = 6) {
  return `<pattern id="${id}" width="${pitch}" height="${pitch}"
      patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <path d="M0 0 V${pitch}" stroke="${color}" stroke-width="${(pitch / 3).toFixed(2)}"
      opacity="${opacity}"/>
  </pattern>`;
}

/* One grabbable, focusable thumb inside a multi-value tuner. Everything the
 * pointer and the keyboard need is on this node: which entity it writes, its own
 * bounds, and its own aria-value*. The halo is the focus ring, because an SVG
 * child cannot take the container's outline. */
function tuneBarThumb(name, entityId, value, bounds, x, y, h, opts = {}) {
  const w = opts.w || 4.4;
  return `<g data-thumb="${esc(name)}" data-tunearg="${tuneArg(entityId, bounds)}"
      tabindex="${opts.unlocked ? '0' : '-1'}" role="slider" aria-label="${esc(opts.label || name)}"
      aria-valuemin="${bounds.min}" aria-valuemax="${bounds.max}"
      aria-valuenow="${value}" aria-valuetext="${esc(opts.valueText || String(value))}"
      ${opts.unlocked ? '' : 'aria-disabled="true"'}>
    <rect class="halo" x="${d2(x - w / 2 - 3.2)}" y="${d2(y - 3.2)}"
      width="${d2(w + 6.4)}" height="${d2(h + 6.4)}" rx="${d2(w / 2 + 3.2)}"
      fill="none" stroke="var(--g-accent)" stroke-width="2.2"/>
    <rect data-knob class="grab" x="${d2(x - w / 2)}" y="${d2(y)}"
      width="${w}" height="${h}" rx="${d2(w / 2)}"
      fill="var(--tone)" stroke="var(--g-surface)" stroke-width="1.5"/>
  </g>`;
}

/* THE LIGHT LEVEL BAND. dark and bright are not two settings - they are one
 * hysteresis band, and the gap between them is what stops the lamp flickering.
 * Drawing them as two independent sliders was the thing that made them
 * unreadable, so this is one axis with two thumbs.
 *
 * The axis is luma, and the bar under it is a luminance ramp: black at 0, frost
 * at 255. That mapping is the identity, the same argument that made the handle
 * lever legitimate - it is not a metaphor for brightness, it IS brightness. Over
 * it, the region where the lamp comes on is painted in --lampc, the lamp's own
 * light; the gap is hatched; the region where it goes off is left as the bright
 * end of the ramp. */
const LUMA_AXIS = { x0: 26, x1: 274, y: 44, h: 30, thumbY: 40, thumbH: 38, max: 255 };

function lumaX(v) {
  const { x0, x1, max } = LUMA_AXIS;
  return x0 + (Math.max(0, Math.min(max, v)) / max) * (x1 - x0);
}

/* Where the two headings sit. They ride their own thumb, except when the gap
 * closes far enough that they would print on top of each other, at which point
 * they are pushed apart just enough to stay readable. */
function lumaLabelXs(dx, bx) {
  const { x0, x1 } = LUMA_AXIS;
  const clamp = (x) => Math.min(Math.max(x, x0 + 16), x1 - 16);
  let a = clamp(dx);
  let b = clamp(bx);
  const need = 48;
  if (Math.abs(b - a) < need) {
    const mid = (a + b) / 2;
    const half = need / 2;
    a = clamp(mid - (dx <= bx ? half : -half));
    b = clamp(mid + (dx <= bx ? half : -half));
  }
  return [a, b];
}

/* One reading on the luma axis. Deliberately not shaped like a thumb: the
 * thumbs are settings and this is the world. Solid is a real measurement,
 * dashed and hollow is the what-if probe. */
function lumaMark(v, stroke, dashed) {
  if (v == null || !Number.isFinite(v)) return '';
  const { y, h } = LUMA_AXIS;
  const x = lumaX(v);
  const cy = y + h / 2;
  const dia = (rr) => `M${d2(x)} ${d2(cy - rr)} L${d2(x + rr)} ${d2(cy)} L${d2(x)} ${d2(cy + rr)} L${d2(x - rr)} ${d2(cy)} Z`;
  return `<path d="M${d2(x)} ${y - 2} V${d2(y + h + 2)}" stroke="var(--g-surface)"
      stroke-width="3.4" stroke-linecap="round"/>
    <path d="M${d2(x)} ${y - 2} V${d2(y + h + 2)}" stroke="${stroke}" stroke-width="1.3"
      stroke-linecap="round"${dashed ? ' stroke-dasharray="2.6 2.2"' : ''}/>
    <path d="${dia(6.4)}" fill="var(--g-surface)"/>
    <path d="${dia(4.6)}" fill="${dashed ? 'var(--g-surface)' : stroke}" stroke="${stroke}"
      stroke-width="1.5" stroke-linejoin="round"/>`;
}

function illLumaTune(u, opts = {}) {
  const g = idns('luma', 'tune', opts.uid);
  const { x0, x1, y, h, thumbY, thumbH } = LUMA_AXIS;
  const dx = lumaX(u.dark);
  const bx = lumaX(u.bright);
  const inverted = u.dark >= u.bright;
  const lo = Math.min(dx, bx);
  const hi = Math.max(dx, bx);
  const [lxd, lxb] = lumaLabelXs(dx, bx);

  /* A zone label only when its own zone is wide enough to hold it. Drawn either
   * way so the optimistic repaint has a node to move; opacity is the switch. */
  const zone = (name, xa, xb, text, need) => {
    const fits = !inverted && (xb - xa) >= need;
    return tuneLabel(fits ? (xa + xb) / 2 : 0, 39, text, 8)
      .replace('<text ', `<text data-zone="${name}" opacity="${fits ? 1 : 0}" `);
  };

  const head = (name, x, text, size, fill) => tuneLabel(x, name.startsWith('cap') ? 12 : 25,
    text, size, { fill })
    .replace('<text ', `<text data-lumaval="${name}" `);

  const ticks = [0, 64, 128, 192, 255].map((v) => {
    const x = lumaX(v);
    return `<path d="M${d2(x)} ${y + h} V${d2(y + h + 4)}" stroke="var(--g-line-2)" stroke-width="1"/>
      ${tuneLabel(x, y + h + 15, String(v), 8)}`;
  }).join('');

  return `<svg viewBox="0 0 300 104" role="img" aria-hidden="true">
    <defs>
      ${grad(g.id('ramp'), [[0, 'var(--ill-gloss-3)'], [0.5, 'var(--ill-body-4)'],
    [1, 'var(--ill-frost)']], 0, 0, 1, 0)}
      ${hatch(g.id('hold'), 'var(--ill-body-4)', 0.55)}
      ${hatch(g.id('bad'), 'var(--tone)', 0.45)}
      <clipPath id="${g.id('bar')}">
        <rect x="${x0}" y="${y}" width="${d2(x1 - x0)}" height="${h}" rx="3"/>
      </clipPath>
    </defs>

    <!-- The measured quantity, painted as itself: 0 is black, 255 is frost. -->
    <rect x="${x0}" y="${y}" width="${d2(x1 - x0)}" height="${h}" rx="3" fill="${g.ref('ramp')}"/>

    <g clip-path="url(#${g.id('bar')})">
      <!-- At or darker than the lower threshold, the lamp comes on. Painted in
           the lamp's own light, which is the one place in the panel where that
           colour is the literal subject rather than a decoration.
           Crossed over, this is empty: the sampler skips every camera branch. -->
      <rect data-band x="${x0}" y="${y}" width="${d2(inverted ? 0 : Math.max(0, dx - x0))}"
        height="${h}" fill="var(--lampc, var(--g-warn))" opacity=".72"/>
      <!-- Normally the gap, where nothing happens - which is the entire point of
           it. Crossed over, the same rect covers the whole axis, because then
           nothing on the axis decides anything at all. -->
      <rect data-band2 x="${d2(inverted ? x0 : lo)}" y="${y}"
        width="${d2(inverted ? x1 - x0 : hi - lo)}" height="${h}"
        fill="${inverted ? g.ref('bad') : g.ref('hold')}"/>
      <rect data-band3 x="${d2(lo)}" y="${y}" width="${d2(hi - lo)}" height="${h}"
        fill="var(--g-surface)" opacity="${inverted ? 0 : 0.22}"/>
    </g>
    <rect x="${x0}" y="${y}" width="${d2(x1 - x0)}" height="${h}" rx="3" fill="none"
      stroke="var(--ill-ink)" stroke-width="1" opacity=".18"/>

    ${zone('on', x0, dx, 'comes on', 40)}
    ${zone('hold', dx, bx, 'no change', 40)}
    ${zone('off', bx, x1, 'goes off', 40)}
    ${tuneLabel((x0 + x1) / 2, 39, 'nothing here decides anything', 8)
    .replace('<text ', `<text data-zone="inverted" opacity="${inverted ? 1 : 0}" `)}

    ${ticks}

    <!-- A second, learned pair was drawn here as ghost lines for one revision and
         taken out again. In Auto-calibrate the learned numbers are what decide,
         and a faint mark next to a solid one says the opposite of that: it makes
         the pair in force look like an afterthought and the parked pair look
         live. Which pair is in charge is a sentence, and it is said as one, in
         the note above this drawing. -->


    <g data-lumalive>${lumaMark(u.live, 'var(--tone)', false)}</g>
    <g data-lumaprobe>${lumaMark(u.probe, 'var(--g-info)', true)}</g>

    <!-- Which handle is which, and what it is set to. Without the two headings
         the pair reads as an anonymous "45 ... 90" and, crossed over, as
         nothing at all. -->
    ${head('capdark', lxd, 'dark below', 7.4)}
    ${head('capbright', lxb, 'bright above', 7.4)}
    ${head('dark', lxd, String(Math.round(u.dark)), 11.5, 'var(--g-text)')}
    ${head('bright', lxb, String(Math.round(u.bright)), 11.5, 'var(--g-text)')}

    ${tuneBarThumb('dark', u.darkId, u.dark, u.darkBounds, dx, thumbY, thumbH,
    { label: 'Dark threshold', valueText: `${Math.round(u.dark)} luma`, unlocked: !!u.unlocked })}
    ${tuneBarThumb('bright', u.brightId, u.bright, u.brightBounds, bx, thumbY, thumbH,
    { label: 'Bright threshold', valueText: `${Math.round(u.bright)} luma`, unlocked: !!u.unlocked })}
  </svg>`;
}

/* SUPER SURVEILLANCE HOURS. Same two-thumb instrument as the lamp's light-level
 * band: one axis, two handles, the filled region is the window. 0 is midnight on
 * the left, 23 on the right. When start > end the fill wraps (two rects) because
 * that is how the YAML template treats an overnight window. start == end hatches
 * the whole axis: the window never opens. */
const HOUR_AXIS = { x0: 26, x1: 274, y: 40, h: 28, thumbY: 36, thumbH: 36, max: 23 };

function hourX(v) {
  const { x0, x1, max } = HOUR_AXIS;
  return x0 + (Math.max(0, Math.min(max, v)) / max) * (x1 - x0);
}

function hourLabelXs(sx, ex) {
  const { x0, x1 } = HOUR_AXIS;
  const clamp = (x) => Math.min(Math.max(x, x0 + 18), x1 - 18);
  let a = clamp(sx);
  let b = clamp(ex);
  const need = 52;
  if (Math.abs(b - a) < need) {
    const mid = (a + b) / 2;
    const half = need / 2;
    a = clamp(mid - (sx <= ex ? half : -half));
    b = clamp(mid + (sx <= ex ? half : -half));
  }
  return [a, b];
}

function hourNowMark(hour) {
  if (hour == null || !Number.isFinite(hour)) return '';
  const { y, h } = HOUR_AXIS;
  const x = hourX(hour);
  return `<g data-hournow>
    <path d="M${d2(x)} ${y - 4} V${d2(y + h + 4)}" stroke="var(--g-surface)"
      stroke-width="3.2" stroke-linecap="round"/>
    <path d="M${d2(x)} ${y - 4} V${d2(y + h + 4)}" stroke="var(--tone)" stroke-width="1.3"
      stroke-linecap="round"/>
    ${tuneLabel(x, y - 8, 'now', 8, { fill: 'var(--tone)' })}
  </g>`;
}

function illHoursTune(u, opts = {}) {
  const g = idns('hours', 'tune', opts.uid);
  const { x0, x1, y, h, thumbY, thumbH } = HOUR_AXIS;
  const sx = hourX(u.start);
  const ex = hourX(u.end);
  const wrap = u.start > u.end;
  const empty = u.start === u.end;
  const [lxs, lxe] = hourLabelXs(sx, ex);
  const fmt = (v) => String(Math.round(v)).padStart(2, '0') + ':00';

  const ticks = [0, 6, 12, 18, 23].map((v) => {
    const x = hourX(v);
    return `<path d="M${d2(x)} ${y + h} V${d2(y + h + 4)}" stroke="var(--g-line-2)" stroke-width="1"/>
      ${tuneLabel(x, y + h + 15, String(v).padStart(2, '0'), 8)}`;
  }).join('');

  const sameDayW = empty || wrap ? 0 : Math.max(0, ex - sx);
  const wrapA = wrap && !empty ? Math.max(0, x1 - sx) : 0;
  const wrapB = wrap && !empty ? Math.max(0, ex - x0) : 0;

  return `<svg viewBox="0 0 300 96" role="img" aria-hidden="true">
    <defs>
      ${hatch(g.id('hold'), 'var(--ill-body-4)', 0.45)}
      ${hatch(g.id('bad'), 'var(--tone)', 0.45)}
      <clipPath id="${g.id('bar')}">
        <rect x="${x0}" y="${y}" width="${d2(x1 - x0)}" height="${h}" rx="3"/>
      </clipPath>
    </defs>

    <rect x="${x0}" y="${y}" width="${d2(x1 - x0)}" height="${h}" rx="3"
      fill="var(--g-surface-3)"/>
    <g clip-path="url(#${g.id('bar')})">
      <rect data-band x="${d2(wrap ? sx : sx)}" y="${y}"
        width="${d2(empty ? 0 : (wrap ? wrapA : sameDayW))}" height="${h}"
        fill="color-mix(in srgb, var(--tone) 55%, transparent)"/>
      <rect data-band2 x="${x0}" y="${y}"
        width="${d2(wrap && !empty ? wrapB : 0)}" height="${h}"
        fill="color-mix(in srgb, var(--tone) 55%, transparent)"/>
      <rect data-band3 x="${x0}" y="${y}" width="${d2(x1 - x0)}" height="${h}"
        fill="${empty ? g.ref('bad') : g.ref('hold')}" opacity="${empty ? 1 : 0}"/>
    </g>
    <rect x="${x0}" y="${y}" width="${d2(x1 - x0)}" height="${h}" rx="3" fill="none"
      stroke="var(--ill-ink)" stroke-width="1" opacity=".18"/>

    ${ticks}
    ${hourNowMark(u.nowHour)}

    ${tuneLabel(lxs, 22, fmt(u.start), 11.5, { fill: 'var(--g-text)' })
    .replace('<text ', '<text data-hourval="start" ')}
    ${tuneLabel(lxe, 22, fmt(u.end), 11.5, { fill: 'var(--g-text)' })
    .replace('<text ', '<text data-hourval="end" ')}
    ${tuneLabel((x0 + x1) / 2, 22, 'window never opens', 8)
    .replace('<text ', `<text data-zone="empty" opacity="${empty ? 1 : 0}" `)}

    ${tuneBarThumb('start', u.startId, u.start, u.startBounds, sx, thumbY, thumbH,
    { label: 'Schedule start', valueText: fmt(u.start), unlocked: !!u.unlocked })}
    ${tuneBarThumb('end', u.endId, u.end, u.endBounds, ex, thumbY, thumbH,
    { label: 'Schedule end', valueText: fmt(u.end), unlocked: !!u.unlocked })}
  </svg>`;
}

/* ROTATE STILL. The sampler turns the JPEG counter-clockwise and THEN keeps the
 * bottom 60%, so the only question this setting answers is whether the landing
 * ends up inside the crop. That is a picture, not a number.
 *
 * The scene is a schematic and reads as one. There is no snapshot to overlay
 * here, and a drawn photograph presented as the real crop would be a lie on a
 * tuning screen. What is true in it comes from DEPLOY.md's seventh pass: the
 * stair-void window sits high in the upright frame, and the landing, approach
 * and RFID plinth are below it. The frame itself changes shape with the setting
 * because that is what happens - a 90-degree turn of a landscape still is a
 * portrait still, and the crop is 60% of that. */
const ROT = { cx: 150, cy: 98, w: 90, h: 160, r: 88 };

function rotFrame(deg) {
  const portrait = ((Math.round(deg) % 180) + 180) % 180 === 90;
  return { w: portrait ? ROT.w : ROT.h, h: portrait ? ROT.h : ROT.w };
}

function rotKnob(deg) {
  const a = (-deg - 45) * Math.PI / 180;
  return [ROT.cx + ROT.r * Math.cos(a), ROT.cy + ROT.r * Math.sin(a)];
}

function illRotateTune(t, opts = {}) {
  const g = idns('rot', 'tune', opts.uid);
  const { cx, cy, r } = ROT;
  const deg = t.value;
  const f = rotFrame(deg);
  const fx = cx - f.w / 2;
  const fy = cy - f.h / 2;
  /* The raw JPEG is the upright scene turned 90 degrees clockwise: this camera
     is mounted on its side, and the floor comes out on the left. The setting
     turns it back. */
  const scene = 90 - deg;
  const k = rotKnob(deg);

  return `<svg viewBox="0 0 300 200" role="img" aria-hidden="true">
    <defs>
      ${grad(g.id('floor'), [[0, 'var(--ill-body-3)'], [1, 'var(--ill-body)']], 0, 0, 0.2, 1)}
      ${grad(g.id('wall'), [[0, 'var(--ill-dark-2)'], [1, 'var(--ill-dark)']], 0, 0, 0.3, 1)}
      ${grad(g.id('win'), [[0, 'var(--ill-frost)'], [1, 'var(--ill-frost-warm)']], 0, 0, 0.4, 1)}
      <clipPath id="${g.id('clip')}">
        <rect data-clip x="${d2(fx)}" y="${d2(fy)}" width="${d2(f.w)}" height="${d2(f.h)}" rx="2"/>
      </clipPath>
    </defs>

    <!-- The turn this setting makes, drawn as the track the grip runs on. -->
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--g-line-2)"
      stroke-width="1.2" stroke-dasharray="2 5"/>

    <g clip-path="url(#${g.id('clip')})">
      <!-- The still. Everything inside turns together, because the sampler
           rotates the whole image rather than a window onto it. -->
      <g data-scene transform="translate(${cx} ${cy}) rotate(${d2(scene)})">
        <rect x="-45" y="-80" width="90" height="160" fill="${g.ref('wall')}"/>
        <!-- The landing: the strip the measurement is supposed to be of. -->
        <path d="M-45 80 H45 V16 L18 4 H-20 L-45 18 Z" fill="${g.ref('floor')}"/>
        <path d="M-20 4 L-45 18 M18 4 L45 16" stroke="var(--ill-ink)" stroke-width="1" opacity=".2"/>
        <!-- The door, and the RFID plinth beside it. -->
        <rect x="-20" y="-30" width="38" height="36" fill="var(--ill-dark-3)"/>
        <rect x="22" y="-6" width="9" height="22" rx="2" fill="var(--ill-body-3)"/>
        <!-- The downstairs window that made a dark landing read as bright. -->
        <rect x="-8" y="-59" width="26" height="32" rx="1.5" fill="${g.ref('win')}"/>
      </g>
      <!-- Top 40%: thrown away before the number is taken. -->
      <rect data-dim x="${d2(fx)}" y="${d2(fy)}" width="${d2(f.w)}" height="${d2(f.h * 0.4)}"
        fill="var(--ill-ink)" opacity=".62"/>
    </g>

    <!-- The crop. Only what is inside this becomes the luma number. -->
    <rect data-crop x="${d2(fx)}" y="${d2(fy + f.h * 0.4)}" width="${d2(f.w)}"
      height="${d2(f.h * 0.6)}" fill="none" stroke="var(--tone)" stroke-width="2" rx="2"/>
    <rect data-frame x="${d2(fx)}" y="${d2(fy)}" width="${d2(f.w)}" height="${d2(f.h)}" rx="2"
      fill="none" stroke="var(--g-line-2)" stroke-width="1.4"/>
    <g data-rotcap>
      ${tuneLabel(cx, fy - 7, 'thrown away', 8.5)}
      ${tuneLabel(cx, fy + f.h + 14, 'measured', 8.5, { fill: 'var(--g-text)' })}
    </g>

    <!-- The grip. Turn it the way the camera is turned. -->
    <g data-thumbg>
      <circle class="halo" cx="${d2(k[0])}" cy="${d2(k[1])}" r="12" fill="none"
        stroke="var(--g-accent)" stroke-width="2.2" opacity="0"/>
      <circle data-knob class="grab" cx="${d2(k[0])}" cy="${d2(k[1])}" r="7.5"
        fill="var(--tone)" stroke="var(--g-surface)" stroke-width="1.8"/>
    </g>
    ${tuneLabel(26, 20, `${Math.round(deg)}° CCW`, 10.5,
    { anchor: 'start', fill: 'var(--g-text)' }).replace('<text ', '<text data-rotval ')}
  </svg>`;
}

/* THE SKY. Read-only, because sun.sun is status and a handle on it would be a
 * lie. Three zones, and they are the two edges the whole lamp system turns on:
 * below -6 the lamp is expected on, above +10 expected off, and between them
 * nobody has an expectation and the camera decides alone. That middle band is
 * dusk and dawn, and the reason ambient sampling exists at all.
 *
 * The hairline at -3 is the guard on off_camera in the sampler's template. It is
 * in no document, and without it this drawing would claim that a bright reading
 * at -5 degrees switches the lamp off. It does not - it holds. */
const SKY = { px: 52, py: 134, r: 118, lo: -25, hi: 65 };

function skyAt(elev, rr) {
  const a = Math.max(SKY.lo, Math.min(SKY.hi, elev)) * Math.PI / 180;
  return [SKY.px + rr * Math.cos(a), SKY.py - rr * Math.sin(a)];
}

/* The sun on its arc, with the angle it stands at drawn as an angle: a line
 * back to the pivot on the horizon. Solid is where the sun actually is; dashed
 * and hollow is the what-if probe. */
function sunDisc(elev, solid) {
  if (elev == null || !Number.isFinite(elev)) return '';
  const p = skyAt(elev, SKY.r);
  const stroke = solid ? 'var(--tone)' : 'var(--g-info)';
  return `<path d="M${SKY.px} ${SKY.py} L${d2(p[0])} ${d2(p[1])}" stroke="${stroke}"
      stroke-width="1.4" opacity=".6"${solid ? '' : ' stroke-dasharray="3 2.6"'}/>
    <circle cx="${d2(p[0])}" cy="${d2(p[1])}" r="${solid ? 9 : 7.6}"
      fill="${solid ? 'var(--tone)' : 'var(--g-surface)'}"
      stroke="${solid ? 'var(--g-surface)' : stroke}"
      stroke-width="${solid ? 2.2 : 2.2}"${solid ? '' : ' stroke-dasharray="3 2.4"'}/>`;
}

/* THE SKY. Read-only, because sun.sun is status and a handle on it would be a
 * lie. What the drawing has to carry is the two edges the whole lamp system
 * turns on: below -6 the lamp is expected on, above +10 expected off, and
 * between them nobody has an expectation and the camera decides alone. That
 * middle band is dusk and dawn, and the reason ambient sampling exists at all.
 *
 * The arc is a brightness ramp rather than three flat fills, for the same
 * reason the luma bar is: sky brightness against elevation is the identity, and
 * a ramp spanning the full material range is legible in both schemes, which
 * three flat --ill-* colours were not - --ill-frost on a light surface is
 * invisible. The gradient runs top to bottom of the arc's own box, which is
 * exactly the elevation axis.
 *
 * The hairline at -3 is the guard on off_camera in the sampler's template. It
 * is in no document, and without it this drawing would claim that a bright
 * reading at -5 degrees switches the lamp off. It does not - it holds. */
function illSunArc(s, opts = {}) {
  const g = idns('sky', 'ill', opts.uid);
  const { px, py, r, lo, hi } = SKY;
  /* arcPath measures clockwise from +x with y running down; elevation is the
     mirror of that, hence the negated angles. */
  const arc = (a0, a1, stroke, w, op) =>
    `<path d="${arcPath(px, py, r, -a0, -a1)}" fill="none" stroke="${stroke}"
      stroke-width="${w}" opacity="${op}"/>`;

  const edge = (elev, text) => {
    const a = skyAt(elev, r - 7);
    const b = skyAt(elev, r + 7);
    const t = skyAt(elev, r - 19);
    return `<path d="M${d2(a[0])} ${d2(a[1])} L${d2(b[0])} ${d2(b[1])}"
        stroke="var(--g-text)" stroke-width="1.6" stroke-linecap="round" opacity=".6"/>
      ${tuneLabel(t[0], t[1] + 2.8, text, 7.6)}`;
  };

  const dead = skyAt(-3, r - 5);
  const dead2 = skyAt(-3, r + 5);

  return `<svg viewBox="0 0 300 196" role="img" aria-hidden="true">
    <defs>
      ${grad(g.id('sky'), [[0, 'var(--ill-frost)'], [0.5, 'var(--ill-body-2)'],
    [0.7, 'var(--ill-body-4)'], [0.8, 'var(--ill-gloss)'], [1, 'var(--ill-gloss-3)']], 0, 0, 0, 1)}
    </defs>

    <!-- Everything is measured from here, which is what "elevation" means. -->
    <path d="M20 ${py} H268" stroke="var(--g-line-2)" stroke-width="1.3"
      stroke-dasharray="4 4" stroke-linecap="round"/>
    ${tuneLabel(268, py + 14, 'horizon', 7.6, { anchor: 'end' })}

    <!-- One arc, ramped the way the sky is: day at the top, night below it.
         The casing under it is load-bearing rather than decoration: the ramp
         ends at near-white and near-black, and one of those two ends vanishes
         into the card in each colour scheme. A mid-grey rim keeps both ends
         visible in both. -->
    ${arc(hi, lo, 'var(--g-faint)', 13, 0.5)}
    ${arc(hi, lo, g.ref('sky'), 10, 1)}

    ${edge(10, '+10')}
    ${edge(-6, '-6')}
    <!-- The undocumented one: a bright reading below here is not trusted either. -->
    <path d="M${d2(dead[0])} ${d2(dead[1])} L${d2(dead2[0])} ${d2(dead2[1])}"
      stroke="var(--g-faint)" stroke-width="0.9" stroke-linecap="round" opacity=".75"/>

    ${tuneLabel(...skyAt(46, r + 27), 'day', 8.6)}
    ${tuneLabel(...skyAt(3, r + 31), 'twilight', 8.6)}
    ${tuneLabel(...skyAt(-18, r + 27), 'night', 8.6)}

    <g data-sunprobe>${sunDisc(s.probe, false)}</g>
    <g data-sunlive>${sunDisc(s.elev, true)}</g>
    <circle cx="${px}" cy="${py}" r="2.8" fill="var(--g-faint)"/>
  </svg>`;
}

/* THE SUN-MISMATCH CLOCK. Section 6 says a lone scalar duration is not worth a
 * drawing, and a bare minute count is not. This one is not bare: the panel knows
 * when the disagreement started (input_text.guardian_lamp_mismatch_since), so
 * the axis can carry how long it has already run against where it will fire.
 *
 * When the clock is not running - they agree, or twilight cleared it - the
 * elapsed bar is simply absent. There is nothing honest to draw there. */
const MM_AXIS = { x0: 26, x1: 274, y: 34, h: 24 };

function mmX(min, max) {
  const { x0, x1 } = MM_AXIS;
  return x0 + (Math.max(0, Math.min(max, min)) / (max || 1)) * (x1 - x0);
}

function illMismatchTune(k, opts = {}) {
  const { x0, x1, y, h } = MM_AXIS;
  const kx = mmX(k.value, k.max);
  const ex = k.elapsed == null ? null : mmX(k.elapsed, k.max);
  const ticks = [];
  for (let mn = 30; mn <= k.max; mn += 30) {
    const x = mmX(mn, k.max);
    ticks.push(`<path d="M${d2(x)} ${y + h} V${d2(y + h + 4)}" stroke="var(--g-line-2)" stroke-width="1"/>
      ${tuneLabel(x, y + h + 15, String(mn), 8)}`);
  }

  return `<svg viewBox="0 0 300 92" role="img" aria-hidden="true">
    <path d="M${x0} ${y + h} H${x1}" stroke="var(--g-line-2)" stroke-width="1.4" stroke-linecap="round"/>
    ${ticks.join('')}

    <!-- How long the lamp may disagree with the sky before Guardian stops
         waiting. The same wait applies in both directions. -->
    <rect data-band x="${x0}" y="${y}" width="${d2(kx - x0)}" height="${h}" rx="3"
      fill="var(--tone)" opacity=".16"/>
    <rect data-band2 x="${x0}" y="${y}" width="${d2(kx - x0)}" height="${h}" rx="3"
      fill="none" stroke="var(--tone)" stroke-width="1.4"/>

    ${ex == null ? '' : `<!-- Real elapsed time, from the timestamp the sampler wrote. -->
      <rect x="${x0}" y="${d2(y + 5)}" width="${d2(Math.max(2, ex - x0))}" height="${d2(h - 10)}"
        rx="${d2((h - 10) / 2)}" fill="var(--tone)" opacity=".9"/>`}

    <!-- t = 0: the moment they started disagreeing. -->
    <path d="M${x0} ${y - 5} V${d2(y + h + 4)}" stroke="var(--g-faint)" stroke-width="1.2"
      stroke-linecap="round" opacity=".8"/>

    <rect data-knob class="grab" x="${d2(kx - 3)}" y="${d2(y - 9)}" width="6"
      height="${d2(h + 18)}" rx="3" fill="var(--tone)" stroke="var(--g-surface)" stroke-width="1.6"/>
    ${tuneLabel(Math.min(Math.max(kx, x0 + 46), x1 - 46), y - 14, 'Guardian steps in', 8.4,
    { fill: 'var(--g-text)' }).replace('<text ', '<text data-mmcap ')}

    ${tuneLabel(x0, y + h + 30, ex == null
    ? 'nothing is counting - they agree'
    : `counting for ${Math.round(k.elapsed)} min`, 8, { anchor: 'start' })}
    ${tuneLabel(x1, y + h + 30, 'minutes of disagreement', 8, { anchor: 'end' })}
  </svg>`;
}

/* --- Model to drawing ------------------------------------------------------
 * The only place a device drawing learns anything about the house. Each of
 * these reads the same model fields the rows beside them read - nothing is
 * derived twice, and no drawing calls st()/isOn() itself. */

function portalArt(m, hass, opts = {}) {
  const online = m.health.portal.ok;
  const backlight = exists(hass, E.portalBacklight) ? st(hass, E.portalBacklight) === 'on' : online;
  const s = m.security;
  return illPortal({
    online,
    backlight: online && backlight,
    screenOn: online && backlight,
    line2: s.eyebrow,
    line3: PORTAL_SCREEN_SUB[s.key] || PORTAL_SCREEN_SUB.idle,
  }, opts);
}

function doorbellArt(m, hass, opts = {}) {
  const online = m.health.doorbell.ok;
  const lightOn = exists(hass, E.doorbellLight) && st(hass, E.doorbellLight) === 'on';
  return illDoorbell({
    online,
    lightOn: online && lightOn,
    ringing: online && st(hass, E.doorbellButton) === 'on',
  }, opts);
}

function lensArt(m, ui = {}, opts = {}) {
  return illLens({
    lampOn: m.lamp.on,
    brightness: m.lamp.brightness,
    live: !!ui.cameraLive && !m.camera.ambientDead,
    person: m.camera.frigate.personNow,
  }, opts);
}

function doorArt(m, opts = {}) {
  return illDoor({
    open: m.door.open,
    handle: m.door.handle,
    moving: m.door.moving,
    blink: m.door.open,
  }, opts);
}

function ring(cd, tone) {
  const R = 42;
  const C = 2 * Math.PI * R;
  const off = C * (1 - cd.pct);
  return `<div class="ring" style="--tone:var(--g-${tone})" data-ring>
    <svg viewBox="0 0 96 96" aria-hidden="true">
      <circle class="halo" cx="48" cy="48" r="${R}" stroke-width="11"></circle>
      <circle class="track" cx="48" cy="48" r="${R}" stroke-width="6"></circle>
      <circle class="prog" cx="48" cy="48" r="${R}" stroke-width="6"
        stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" data-ring-prog></circle>
    </svg>
    <div class="val"><span data-ring-val>${clock(cd.remaining)}</span></div>
  </div>`;
}

function statusBar(m, ui = {}, hass) {
  const s = m.security;
  const house = hass ? isHouseAdmin(hass) : true;
  const acts = [];
  if (m.alarming) {
    if (house) {
      acts.push(holdBtn('Hold to silence', 'reset', { restart: false }, { icon: 'mdi:bell-off', toneName: 'alarm', sm: true }));
    }
    acts.push(btn('Camera', 'nav', { tab: 'camera', page: '' }, { icon: 'mdi:cctv', sm: true }));
  } else if (s.key === 'challenge' || s.key === 'mfa' || s.key === 'doorbellexit') {
    acts.push(btn('Camera', 'nav', { tab: 'camera', page: '' }, { icon: 'mdi:cctv', sm: true }));
    if (house) {
      acts.push(holdBtn('Hold to cancel', 'reset', { restart: false }, { icon: 'mdi:close-circle-outline', toneName: 'warn', sm: true }));
    }
  } else if (s.key === 'enroll') {
    const onKeys = ui.tab === 'more' && ui.page === 'keys';
    if (!onKeys) {
      acts.push(btn('Name the key', 'nav', { tab: 'more', page: 'keys' }, { sm: true }));
      if (house) {
        acts.push(btn('Cancel', 'toggle', { id: E.enrollMode, on: false }, { sm: true }));
      }
    }
  } else if (s.key === 'pinchange') {
    if (house) {
      acts.push(btn('Cancel', 'toggle', { id: E.pinChangeMode, on: false }, { sm: true }));
    }
  } else if (house) {
    const showDisarm = s.elevated;
    if (showDisarm && !s.armed && s.scheduled) {
      acts.push(btn('Edit schedule', 'nav', { tab: 'more', page: 'security' },
        { sm: true, icon: 'mdi:calendar-clock' }));
    } else {
      acts.push(btn(showDisarm ? 'Disarm' : 'Arm', 'toggle',
        { id: E.superSurveillance, on: !showDisarm },
        { solid: !showDisarm, sm: true, icon: showDisarm ? 'mdi:shield-off-outline' : 'mdi:shield-lock-outline' }));
    }
  }

  const live = s.tone === 'alarm' || s.tone === 'warn';
  const showBody = s.tone === 'alarm' || s.tone === 'warn' || s.key === 'enroll' || s.key === 'pinchange';
  return `<section class="status" data-tone="${s.tone}" data-pulse="${s.tone === 'alarm' ? 1 : 0}"
      data-live="${live ? 1 : 0}"
      style="--tone:var(--g-${s.tone})" aria-live="${s.tone === 'alarm' ? 'assertive' : 'polite'}">
    ${m.countdown.active ? ring(m.countdown, s.tone) : ''}
    <div class="copy">
      <span class="eyebrow">${live ? '<i></i>' : ''}${esc(s.eyebrow)}</span>
      <h1>${esc(s.title)}</h1>
      ${showBody ? `<p>${esc(s.body)}</p>` : ''}
      <div class="acts">${acts.join('')}</div>
      ${s.key === 'doorbellexit' ? exitPinPad(ui) : ''}
    </div>
  </section>`;
}

function cameraUrls(hass, entityId) {
  const s = hass.states && hass.states[entityId];
  const pic = s && s.attributes && s.attributes.entity_picture;
  if (!pic) return null;
  return { still: pic, stream: pic.replace('/api/camera_proxy/', '/api/camera_proxy_stream/') };
}

function haCameraStreamReady() {
  return typeof customElements !== 'undefined' && !!customElements.get('ha-camera-stream');
}

function bindCamPlayer(host, hass) {
  if (!host || !hass) return;
  const player = host.querySelector('ha-camera-stream[data-keep="cam"]');
  if (!player) return;
  const id = player.getAttribute('data-cam-id');
  const stateObj = id && hass.states ? hass.states[id] : null;
  player.hass = hass;
  if (stateObj) player.stateObj = stateObj;
  player.muted = true;
}

function sameCamNode(a, b) {
  if (!a || !b || a.tagName !== b.tagName) return false;
  if (a.getAttribute('data-cam-id') !== b.getAttribute('data-cam-id')) return false;
  if (a.getAttribute('data-cam-mode') !== b.getAttribute('data-cam-mode')) return false;
  if (a.tagName === 'IMG') return a.src === b.src;
  return true;
}

function camStage(m, hass, ui) {
  const camId = liveCameraId(m, ui);
  const urls = camId ? cameraUrls(hass, camId) : null;
  const live = ui.cameraLive;
  const stateObj = camId && hass.states && hass.states[camId];
  const hasAmbient = m.camera.ambient && !m.camera.ambientMissing;
  const hasFrigate = !!m.camera.frigate.camera;
  const sourceBtns = (hasAmbient && hasFrigate)
    ? seg('camSource', [
      { value: 'ambient', label: 'Home camera' },
      { value: 'frigate', label: 'Frigate' },
    ], ui.camSource === 'frigate' && hasFrigate ? 'frigate' : 'ambient')
    : '';

  const overlay = [];
  overlay.push(pill(live ? 'Live footage' : 'Frozen · last frame', live ? 'ok' : 'idle',
    { led: live, plain: !live }));
  if (m.camera.frigate.personNow) overlay.push(pill('Person', 'warn', { led: true }));
  if (m.lamp.sampling) overlay.push(pill('Measuring light', 'warn'));

  let body;
  if (live && stateObj && haCameraStreamReady()) {
    body = `<ha-camera-stream data-keep="cam" data-cam-mode="live" data-cam-id="${esc(camId)}"></ha-camera-stream>`;
  } else if (urls) {
    const src = live ? urls.stream : `${urls.still}${urls.still.includes('?') ? '&' : '?'}g=${ui.camNonce}`;
    body = `<img data-keep="cam" data-cam-mode="${live ? 'mjpeg' : 'still'}" data-cam-id="${esc(camId)}" src="${esc(src)}" alt="Door camera" referrerpolicy="no-referrer">`;
  } else {
    body = `<div class="ph">${camId
      ? `No picture from this camera yet. Check More → Install if the entity id is wrong.`
      : `No door camera is configured. Open More → Install and point Guardian at yours.`}</div>`;
  }

  return `<div>
    <div class="cam">${body}<div class="ov">${overlay.join('')}</div></div>
    <div class="cam-tools">
      ${sourceBtns}
      <div class="acts">
        ${btn(live ? 'Pause' : 'Live', 'cameraLive', { on: !live },
          { icon: live ? 'mdi:pause' : 'mdi:play', sm: true, solid: !live })}
        ${btn('Refresh', 'cameraRefresh', {}, { icon: 'mdi:refresh', sm: true })}
        ${camId ? btn('Open', 'moreinfo', { id: camId }, { icon: 'mdi:open-in-new', sm: true }) : ''}
      </div>
    </div>
    ${m.lamp.sampling ? note('The lamp is off for a few seconds so the camera can measure the room. This is not a fault.', 'warn', 'mdi:camera-timer') : ''}
  </div>`;
}

/* =============================================================================
 * 9. VIEWS
 * ========================================================================== */

function presenceTone(slot) {
  if (slot.stolen) return 'alarm';
  if (slot.visitor) return 'info';
  return slot.home ? 'ok' : 'idle';
}

function presenceWord(slot) {
  if (slot.missing) return 'No helper';
  if (slot.stolen) return 'Stolen / lost';
  if (slot.visitor) return 'Visitor';
  if (slot.presence === 'At home') return 'At home';
  if (slot.presence === 'Away') return 'Away';
  return slot.presence;
}

function rosterRow(slot) {
  const tone = presenceTone(slot);
  const sub = [
    slot.visitor ? 'Visitor' : 'Resident',
    slot.changed ? ago(slot.changed) : null,
  ].filter(Boolean).join(' · ');
  return `<div class="row click" style="--tone:var(--g-${tone})"
      data-act="moreinfo" data-arg="${arg({ id: slot.selEntity })}">
    <span class="avatar" style="--tone:var(--g-${tone})">${esc(slot.initials)}<i class="dot"></i></span>
    <div class="lbl"><b>${esc(slot.short)}</b><small>${esc(sub)}</small></div>
    <div class="val tone">${esc(presenceWord(slot))}</div>
  </div>`;
}

function viewHome(m, hass, ui) {
  const out = [];
  const p = m.presence;
  const d = m.door;

  if (m.needsInstall) {
    out.push(noteHtml(`This copy of Guardian still needs hardware pointed at it — a door camera, and the lamp this panel should control. <b>More → Install</b> is the place.`,
      'warn', 'mdi:tune-vertical'));
  }

  if (m.faults.length) {
    out.push(card('Needs attention', m.faults.map((f) =>
      row(f.title, f.body, pill(f.token, 'warn'), { toneName: 'warn' })
    ).join('')));
  }

  const camId = m.camera.ambient && !m.camera.ambientDead ? m.camera.ambient : (m.camera.frigate.camera || '');
  const urls = camId ? cameraUrls(hass, camId) : null;
  const peekSrc = urls ? `${urls.still}${urls.still.includes('?') ? '&' : '?'}g=${ui.camNonce}` : '';
  out.push(`<div class="cam peek" data-act="nav" data-arg="${arg({ tab: 'camera', page: '' })}" role="button" aria-label="Open camera">
    ${urls
      ? `<img src="${esc(peekSrc)}" alt="Door camera" referrerpolicy="no-referrer">`
      : `<div class="ph">${m.camera.ambientMissing ? 'Set up the door camera in More → Install' : 'Waiting for a picture'}</div>`}
    <div class="ov">${pill('Snapshot', 'idle', { plain: true })}
      ${pill(d.known ? (d.open ? 'Door open' : 'Door closed') : 'Door unknown',
      d.known ? (d.open ? 'warn' : 'ok') : 'idle', { led: true })}
      ${m.camera.frigate.personNow ? pill('Person', 'warn', { led: true }) : ''}</div>
  </div>`);

  const roster = m.slots.filter((s) => s.occupied);
  const homeLine = roster.length === 0 ? 'No keys yet'
    : p.homeCount === 0 ? 'Nobody home'
    : p.names.length ? p.names.join(', ')
    : 'Everyone home';
  out.push(card('Who is home', `
    <div class="stat"><b>${esc(homeLine)}</b>
      <span>${roster.length ? `${p.homeCount} of ${p.total} residents home` : 'Add a key from Keys, People & Alerts'}</span></div>
    <div>${roster.length ? roster.map(rosterRow).join('') : empty('No keys yet', 'mdi:card-off-outline')}</div>
  `, { hint: p.visitors.length ? `${p.visitors.length} visitor` : '' }));

  out.push(card('', [
    row('Door', d.known ? ago(d.since) : 'Portal not reporting',
      pill(d.known ? (d.open ? 'Open' : 'Closed') : 'Unknown', d.known ? (d.open ? 'warn' : 'ok') : 'idle', { led: true }),
      { act: 'moreinfo', arg: { id: E.doorContact }, toneName: d.known && d.open ? 'warn' : 'ok' }),
    row('Super surveillance', m.security.armed ? 'A PIN is required to pass' : 'A card is enough',
      isHouseAdmin(hass)
        ? sw(E.superSurveillance, m.security.armed, 'elev', { label: 'Super surveillance' })
        : pill(m.security.armed ? 'On' : 'Off', m.security.armed ? 'elev' : 'idle')),
    isHouseAdmin(hass) ? navRow('Schedule',
      ssHomeSummary(m.ssPrograms || []),
      { tab: 'more', page: 'security' },
      {
        icon: 'mdi:calendar-clock',
        right: pill(
          (m.ssPrograms || []).some((p) => p.matching)
            ? 'On now'
            : ((m.ssPrograms || []).some((p) => p.live) ? 'Scheduled' : 'Off'),
          (m.ssPrograms || []).some((p) => p.matching)
            ? 'elev'
            : ((m.ssPrograms || []).some((p) => p.live) ? 'arm' : 'idle'),
          { led: (m.ssPrograms || []).some((p) => p.matching) }),
      }) : '',
    m.lamp.missing
      ? row('Lamp', 'Not configured — More → Install', '—')
      : row('Lamp', m.lamp.result ? m.lamp.result.verdict : (m.lamp.on ? 'On' : 'Off'),
        `${lampDot(m.lamp)}${sw(m.lamp.entity, m.lamp.on, 'ok', { label: 'Lamp' })}`),
    navRow('Keys, People & Alerts', roster.length ? 'Add or delete keys' : 'Add a key', { tab: 'more', page: 'keys' }, { icon: 'mdi:key-chain-variant' }),
  ].join('')));

  /* The device rack. Same four subsystems, same entities, same tap-through to
   * more-info as the eleventh pass shipped - drawn instead of listed, because
   * "the doorbell is the white box by the door" is the one thing a printed
   * label cannot say. */
  const h = m.health;
  const lampc = lampCss(m.lamp);
  const art = {
    portal: portalArt(m, hass, { size: 'sm', label: 'Interior portal' }),
    doorbell: doorbellArt(m, hass, { size: 'sm', label: 'Doorbell' }),
    camera: lensArt(m, ui, { size: 'sm', label: 'Door camera' }),
    imu: doorArt(m, { size: 'sm', label: 'Door sensing' }),
  };
  const cell = (key, x) => {
    const tone = !x.ok ? 'alarm'
      : (key === 'camera' && m.camera.frigate.personNow) ? 'warn'
      : (key === 'imu' && m.door.open) ? 'pass'
      : 'ok';
    const lamp = key === 'camera' ? `;--lampc:${esc(lampc)}` : '';
    return `<button class="hcell" data-art="${key}" data-online="${x.ok ? 1 : 0}"
        style="--tone:var(--g-${tone})${lamp}"
        data-act="moreinfo" data-arg="${arg({ id: x.entity })}"
        aria-label="${esc(`${x.label}: ${x.detail}`)}">
      <span class="art">${art[key]}</span>
      <span class="cap"><i class="led"></i>
        <span class="t"><b>${esc(x.label)}</b><small>${esc(x.detail)}</small></span></span>
    </button>`;
  };
  out.push(`<div class="health">${[
    ['portal', h.portal], ['doorbell', h.doorbell], ['camera', h.camera], ['imu', h.imu],
  ].map(([k, x]) => cell(k, x)).join('')}</div>`);

  return stack(out);
}

/* One labelled control. The micro label is the same 10.5px uppercase ramp the
 * group headers use, so a key card reads like the rest of the panel instead of
 * a stack of anonymous controls. */
function slotField(label, controlHtml, opts = {}) {
  const tone = opts.hintTone ? ` style="--tone:var(--g-${opts.hintTone})"` : '';
  const hintCls = opts.hintTone ? 'notify-hint tone' : 'notify-hint';
  return `<div class="sfield"${tone}>
    <span class="slabel">${esc(label)}</span>
    ${controlHtml}
    ${opts.hint ? `<p class="${hintCls}">${esc(opts.hint)}</p>` : ''}
  </div>`;
}

/* The key card. Rebuilt on the panel's own vocabulary: group chrome with a tone
 * edge (the .hcell idiom - status is an edge, never a wash), a header band that
 * carries the avatar, the name and the state pills, labelled fields in the body,
 * and one action grid at the foot. Send test alert and Hold: stolen share a row
 * there because they are the two things you do TO a key, and the grid keeps
 * them the same height at every width. */
function slotCard(slot, m, ui = {}, hass) {
  const tone = presenceTone(slot);
  const badges = [];
  const editable = canEditSlot(hass, slot);
  const house = isHouseAdmin(hass);
  /* Only the exceptional states. "At home" and "Visitor" are already said by
   * the segmented control and the subtitle a few pixels away, and a pill that
   * repeats the control under it is noise, not status. */
  if (slot.isTarget && m.enroll.active) badges.push(pill('Next card', 'info', { led: true }));
  if (slot.stolen) badges.push(pill('Stolen / lost', 'alarm'));
  /* Badged only when something is actually wrong. "Protected" and "Not checked"
   * are said by the field in the body a few pixels below; a header pill that
   * repeats a non-exceptional state is noise, which is the same rule the two
   * badges above already follow. */
  const prot = CARD_PROTECTION[slot.protection] || CARD_PROTECTION[''];
  if (slot.protection === 'u') badges.push(pill('Clonable', 'warn'));
  const saved = ui.savedFlash === slot.nameEntity;
  const notify = notifyTargetSelect(slot, hass, ui);
  const users = ui.haUsers || [];
  const linkedUser = users.find((u) => u.id === slot.haUserId);
  const userOpts = [{ id: '', name: 'Not linked' }].concat(users);
  if (slot.haUserId && !linkedUser) {
    userOpts.push({ id: slot.haUserId, name: slot.haUserId });
  }
  const userLinkError = ui.slotUserError === slot.id;
  const userHint = userLinkError
    ? `${slot.haUserEntity} · wanted ${ui.slotUserWant === '' ? '(empty)' : (ui.slotUserWant || '(empty)')} · live ${ui.slotUserLive || '(missing)'}`
    : (slot.haUserId
      ? (linkedUser
        ? `${linkedUser.name} can edit this key and its notifications.`
        : 'Linked to a Home Assistant account.')
      : (isSingleAccount(hass)
        ? 'Optional until a second Home Assistant account exists.'
        : 'Unassigned — only an administrator can edit this key.'));
  const suggest = (ui.haUserNotify && slot.haUserId && ui.haUserNotify[slot.haUserId]) || '';
  const suggestHint = suggest && !slot.hasNotify
    ? `Their Companion app looks like ${suggest}. Pick it under Alerts go to.`
    : '';

  if (!editable) {
    return `<div class="slot" style="--tone:var(--g-${tone})">
    <div class="slot-hd">
      <span class="avatar">${esc(slot.initials)}<i class="dot"></i></span>
      <div class="who"><b>${esc(slot.short)}</b>
        <small>${slot.visitor ? 'Visitor key' : 'Resident key'} · ${
          slot.stolen ? 'Stolen / lost' : (slot.home ? 'At home' : 'Away')}</small></div>
      ${badges.length ? `<div class="slot-badges">${badges.join('')}</div>` : ''}
    </div>
  </div>`;
  }

  return `<div class="slot" data-target="${slot.isTarget && m.enroll.active ? 1 : 0}" style="--tone:var(--g-${tone})">
    <div class="slot-hd">
      <span class="avatar">${esc(slot.initials)}<i class="dot"></i></span>
      <div class="who"><b>${esc(slot.short)}</b>
        <small>${slot.visitor ? 'Visitor key' : 'Resident key'}</small></div>
      ${badges.length ? `<div class="slot-badges">${badges.join('')}</div>` : ''}
    </div>
    <div class="slot-bd">
      ${slotField('Name', textField(slot.nameEntity, slot.nameRaw, 'Person name', { saved }))}
      ${slotField('Where they are', seg('setSlotPresence', [
    { value: 'At home', label: 'At home' },
    { value: 'Away', label: 'Away' },
  ], slot.presence, { arg: { slot: slot.id }, toneName: 'ok' }))}
      ${house ? slotField('Key type', seg('setSlotPolicy', [
    { value: 'resident', label: 'Resident' },
    { value: 'visitor', label: 'Visitor' },
  ], slot.policy, { arg: { slot: slot.id }, toneName: 'info' })) : ''}
      ${house ? slotField('Home Assistant account',
    `<select class="field" aria-label="Linked account" data-field="setSlotUser"
      data-arg="${arg({ slot: slot.id })}">
      ${userOpts.map((u) => `<option value="${esc(u.id)}" ${u.id === slot.haUserId ? 'selected' : ''}>${esc(u.name || u.id || 'Unnamed')}</option>`).join('')}
    </select>`, { hint: userHint, hintTone: userLinkError ? 'alarm' : '' }) : ''}
      ${suggestHint ? note(suggestHint, 'info', 'mdi:cellphone-link') : ''}
      ${slotField('Alerts go to', notify.select, { hint: notify.hint, hintTone: notify.hintTone })}
      ${slotField('Card security', pill(prot.label, prot.tone),
    { hint: prot.hint, hintTone: slot.protection === 'u' ? 'warn' : '' })}
      ${navRow('Notifications', notifySummary(slot),
    { tab: 'more', page: 'personAlerts', slot: slot.id }, { icon: 'mdi:bell-cog-outline' })}
      <div class="slot-foot">
        <div class="slot-actions">
          ${notify.testBtn}
          ${house ? (slot.stolen
    ? btn('Not stolen', 'setSlotPresence', { slot: slot.id, value: 'Away' }, { sm: true })
    : holdBtn('Hold: stolen', 'setSlotPresence', { slot: slot.id, value: 'Stolen/Lost' },
      { sm: true, subtle: true, toneName: 'alarm' })) : ''}
        </div>
        ${house ? holdBtn('Hold: delete this key', 'clearSlot', { slot: slot.id },
    { sm: true, wide: true, subtle: true, toneName: 'alarm', icon: 'mdi:delete-outline' }) : ''}
      </div>
    </div>
  </div>`;
}

/* The one line under Notifications on a key card. Says the level, and names
 * what is switched off rather than counting it: "4 of 6 on" makes you open the
 * screen to find out which two, and the whole point of the summary is to
 * answer that without the trip. */
function notifySummary(slot) {
  const off = NOTIFY_CATEGORIES.filter((c) => slot.muted.includes(c.token));
  if (!off.length) return `${slot.level} · everything switched on`;
  if (off.length === NOTIFY_CATEGORIES.length) return `${slot.level} · every category off`;
  if (off.length <= 2) return `${slot.level} · ${off.map((c) => c.label).join(' and ')} off`;
  return `${slot.level} · ${off.length} categories off`;
}

/* Per-person notification preferences, reached from that person's own key card
 * on Keys, People & Alerts. Not an admin panel: it edits one slot's helpers and
 * nothing else, and two people in the same house can hold opposite settings.
 *
 * Which person comes from ui.alertsSlot rather than from a URL, matching how
 * every other nested page in this panel carries state. If that slot has gone -
 * the key was deleted from another browser while this was open - fall back to
 * the keys page rather than rendering a screen of controls pointed at helpers
 * for a person who no longer exists. */
function viewPersonAlerts(m, hass, ui = {}) {
  const slot = m.slots.find((s) => s.id === ui.alertsSlot && s.occupied);
  if (!slot) {
    return stack([
      pageHead('Notification preferences'),
      empty('That key is no longer registered.', 'mdi:key-remove'),
      card('', navRow('Keys, People & Alerts', 'Back to the list',
        { tab: 'more', page: 'keys' }, { icon: 'mdi:key-chain-variant' })),
    ]);
  }
  if (!canEditNotifyPrefs(hass, slot)) {
    return stack([
      pageHead('Notification preferences'),
      note('Those settings belong to someone else.', 'warn', 'mdi:account-lock-outline'),
      card('', `<p class="notify-hint">${esc(notifySummary(slot))}</p>`),
      card('', navRow('Keys, People & Alerts', 'Back to the list',
        { tab: 'more', page: 'keys' }, { icon: 'mdi:key-chain-variant' })),
    ]);
  }

  const out = [pageHead(`${slot.short} — notifications`)];

  if (!slot.hasNotify) {
    out.push(note(`${slot.short} has no phone linked, so none of these settings can do anything yet. Link one under Alerts go to on their key.`,
      'warn', 'mdi:cellphone-off'));
  }

  /* CUSTOM IS A STATE THE SCREEN HAS TO NAME.
   *
   * A person with muted categories is not on their chosen level - they are on
   * that level with exceptions, and the level control alone cannot show it.
   * Before this, someone who had muted three categories months ago saw a screen
   * identical to someone who had muted none, and read their own settings as
   * "Important", which was not what was gating their alerts. */
  const mutedCount = slot.muted.filter(
    (t) => NOTIFY_CATEGORIES.some((c) => c.token === t)).length;
  const custom = mutedCount > 0;
  const pending = ui.pendingLevel && String(ui.pendingLevel.slot) === String(slot.id)
    ? ui.pendingLevel.value : '';
  const shownLevel = pending && NOTIFY_LEVELS.some((l) => l.value === pending)
    ? pending : slot.level;

  out.push(card('How much to send', [
    slot.levelChoices.length
      ? seg('setNotifyLevel', slot.levelChoices, shownLevel,
        { arg: { id: slot.levelEntity, slot: slot.id }, toneName: 'info', block: true })
      : '',
    `<div class="chips" style="margin:10px 0 2px">
      ${pill(custom ? `${shownLevel} · customised` : shownLevel, custom ? 'warn' : 'info',
    { icon: custom ? 'mdi:tune-variant' : 'mdi:bell-ring-outline' })}
      ${custom ? pill(`${mutedCount} of ${NOTIFY_CATEGORIES.length} muted`, 'warn', { plain: true }) : ''}
    </div>`,
    note(LEVEL_HINT[shownLevel], 'idle', 'mdi:information-outline'),
    custom
      ? noteHtml(`This is a custom setup: the level above is <b>${esc(shownLevel)}</b>, but ${mutedCount === 1 ? 'one category is' : `${mutedCount} categories are`} muted underneath it, so what actually reaches this phone is narrower than the level says. Switch them all back on to be exactly on ${esc(shownLevel)}.`,
        'warn', 'mdi:tune-variant')
      : '',
    /* The backend is short of an option this panel knows about. Name the cause
     * and the remedy, and only because both are established: an input_select's
     * options come from the package that declares it, and packages merge on a
     * full restart and not on a reload. */
    slot.levelMissing.length
      ? noteHtml(`Your Home Assistant does not offer ${slot.levelMissing.map((v) => `<b>${esc(v)}</b>`).join(' or ')} on this key, so ${slot.levelMissing.length === 1 ? 'it is' : 'they are'} not shown above. The choice is declared in <b>packages/guardian_rfid.yaml</b>; a copy of that file older than the option, or a package that has not merged, produces exactly this. Copy packages/guardian_rfid.yaml and <b>restart Home Assistant fully</b> — packages do not merge on a reload.`,
        'alarm', 'mdi:playlist-remove')
      : '',
  ].join('')));

  /* The switches sit BELOW the level and are described as exceptions to it,
   * because that is what they are. Presenting them as a flat second list of
   * six equal choices was the version that tested badly on paper: people set a
   * level, then could not tell whether the switches added to it or replaced it.
   *
   * Each row now says what it will actually deliver at the CURRENT level, so
   * moving the level rewrites all six in front of you. Drawing them
   * identically at every level is what made three of the four levels look like
   * they did nothing. */
  out.push(card('What to send', [
    note('These are exceptions to the level above. A switch that is off stops that category at every level; a switch that is on still obeys the level. Each row says what it is doing right now.',
      'idle', 'mdi:tune-variant'),
    NOTIFY_CATEGORIES.map((c) => {
      const on = !slot.muted.includes(c.token);
      const eff = categoryEffect(shownLevel, slot.muted, c.token);
      return row(c.label,
        `${esc(c.hint)}<br><b style="color:var(--g-${eff.tone})">${esc(eff.text)}</b>`,
        sw(slot.muteEntity, on, c.token === 'security' ? 'alarm' : 'ok', {
          label: `${c.label} for ${slot.short}`,
          act: 'setNotifyCategory',
          arg: { id: slot.muteEntity, token: c.token, on: !on },
        }), { icon: c.icon, subHtml: true });
    }).join(''),
  ].join('')));

  out.push(note('Alarms, stolen cards, and tamper always come through, even at Off. Guardian will not let a setting made months ago be the reason nobody hears the alarm.',
    'warn', 'mdi:shield-alert-outline'));

  out.push(card('Check it works', [
    row('Send a test alert',
      slot.hasNotify
        ? `Goes to ${esc(notifyPhoneLabel(hass, slot.notifyTarget))} now. Ignores everything on this screen, so it proves the phone link rather than the settings.`
        : 'Link a phone first.',
      btn('Send', 'notifyTest', { slot: slot.id },
        { sm: true, icon: 'mdi:cellphone-check', disabled: !slot.hasNotify })),
  ].join('')));

  return stack(out);
}

function viewKeys(m, hass, ui = {}) {
  const out = [pageHead('Keys, People & Alerts')];
  const en = m.enroll;
  const house = isHouseAdmin(hass);
  const registered = m.slots.filter((s) => s.occupied);
  const mine = registered.filter((s) => canEditSlot(hass, s));
  const others = registered.filter((s) => !canEditSlot(hass, s));
  const linked = registered.filter((s) => s.hasNotify).length;
  const saved = (id) => ui.savedFlash === id;
  const rackFull = en.free === 0;

  if (house && !en.active) {
    out.push(card('Keys', `
      <div class="chips" style="margin-bottom:12px">
        ${pill(`${registered.length} registered`, 'ok')}
        ${en.free ? pill(`${en.free} can still be added`, 'idle', { plain: true }) : pill('All 9 keys in use', 'warn')}
        ${pill(`${linked} linked to a phone`, linked ? 'ok' : 'warn')}
      </div>
      ${btn('Add a key', 'toggle', { id: E.enrollMode, on: true }, {
        wide: true, solid: true, tone: true, toneName: 'info',
        icon: 'mdi:plus', disabled: m.pin.active,
      })}
      ${m.pin.active ? note('Finish or cancel the PIN change first.', 'warn', 'mdi:alert-outline') : ''}
      ${note('Add writes the card at the doorbell or the interior portal. To remove one, hold Delete on that person’s card below.', 'info', 'mdi:nfc-tap')}
    `));
  } else if (house && en.active) {
    const addBody = [];
    addBody.push(note(rackFull
      ? 'Every key is in use. Choose whose key to replace, then present the new card.'
      : 'Type a name (optional), then hold the card to the doorbell or the interior portal.',
      'info', 'mdi:nfc-tap'));
    const liveState = ui.liveTextId === E.enrollPendingName ? (ui.liveTextState || '') : '';
    const nameHint = liveState === 'saving'
      ? 'Writing the name to Home Assistant…'
      : liveState === 'error'
        ? 'Could not save the name. Check the connection and try again.'
        : en.pendingName
          ? 'Saved — present the card at the doorbell or the interior portal.'
          : 'Leave blank to name the key afterwards. The name is saved before you walk to the door.';
    addBody.push(row('Name', nameHint, ''));
    addBody.push(textField(E.enrollPendingName, en.pendingName, 'Person name', {
      saved: saved(E.enrollPendingName) || liveState === 'saved',
      live: true,
      liveState: liveState || (en.pendingName ? 'saved' : ''),
      liveHint: en.pendingName ? 'Saved' : '',
    }));
    addBody.push(row('Save as',
      en.visitor ? 'Opens the door, never counted as home' : 'Counts towards who is home',
      seg('setEnrollPolicy', [
        { value: 'resident', label: 'Resident' },
        { value: 'visitor', label: 'Visitor' },
      ], en.visitor ? 'visitor' : 'resident', { toneName: 'info' })));
    if (rackFull) {
      addBody.push(row('Replace',
        en.target === 'none' ? 'Pick whose key to overwrite' : `Replacing ${esc((m.slots.find((s) => s.id === en.target) || {}).short || ('key ' + en.target))}`,
        en.target === 'none' ? pill('Choose one', 'warn') : pill('Selected', 'info', { led: true })));
      addBody.push(`<div class="seg block">${m.slots.filter((s) => s.occupied).map((s) =>
        btn(s.short, 'setText', { id: E.enrollSlot, value: s.id },
          { sm: true, tone: en.chosen === s.id || en.target === s.id, toneName: 'info' })).join('')}</div>`);
    }
    addBody.push(row('Keep the window open',
      en.windowActive ? 'Idle timer is running' : 'No idle timer is running',
      btn('Keep open', 'timerStart', { id: E.tEnroll }, { sm: true })));
    addBody.push(btn('Cancel', 'toggle', { id: E.enrollMode, on: false }, {
      wide: true, icon: 'mdi:close',
    }));
    out.push(card('Adding a key', addBody.join('')));
  }

  if (linked === 0) {
    out.push(note('No phones linked — alerts go to everyone (or the legacy group if none are registered).', 'warn', 'mdi:cellphone-off'));
  }

  out.push(`<div class="group-label">${house ? 'Registered keys — hold Delete to remove' : 'Your key'}</div>`);
  out.push(mine.length
    ? `<div class="slots">${mine.map((s) => slotCard(s, m, ui, hass)).join('')}</div>`
    : empty(house ? 'No keys yet. Tap Add a key to register the first one.' : 'No key is linked to this Home Assistant account yet. Ask an administrator.', 'mdi:card-plus-outline'));
  if (others.length) {
    out.push(`<div class="group-label">Others in the house</div>`);
    out.push(`<div class="slots">${others.map((s) => slotCard(s, m, ui, hass)).join('')}</div>`);
  }

  const pin = m.pin;
  if (house) {
  const pinBody = [];
  if (!pin.hashSet) {
    pinBody.push(note('No master PIN is stored yet. Set the first one from Developer Tools, then use this toggle to change it at the keypad.', 'warn', 'mdi:alert-outline'));
  }
  pinBody.push(row('Change PIN at the keypad',
    pin.active
      ? (pin.step === 'new' ? 'Waiting for the new PIN' : 'Waiting for the current PIN')
      : (pin.blocked ? 'Blocked while adding a key or a challenge is open' : 'Starts a keypad session. The PIN is never typed here.'),
    sw(E.pinChangeMode, pin.active, 'elev', { label: 'PIN change mode', busy: pin.blocked && !pin.active })));
  if (pin.active) {
    pinBody.push(row('Step', 'Current PIN + #, then new PIN + #.',
      pill(pin.step === 'new' ? 'New PIN' : 'Current PIN', 'elev', { led: true })));
    if (pin.fails > 0) pinBody.push(row('Failed attempts', 'Three failures end the session', String(pin.fails)));
  }
  out.push(card('Master PIN', pinBody.join('')));
  }
  return stack(out);
}

function viewCameraBody(m, hass, ui) {
  const out = [];
  const dbOnline = m.health.doorbell.ok;
  const lightOn = exists(hass, E.doorbellLight) && st(hass, E.doorbellLight) === 'on';

  out.push(card('Doorbell', [
    row('Reachability', String(st(hass, E.doorbellLink, 'No data')),
      pill(dbOnline ? 'Online' : 'Offline', dbOnline ? 'ok' : 'alarm', { led: true }),
      { act: 'moreinfo', arg: { id: E.doorbellOnline }, toneName: dbOnline ? 'ok' : 'alarm' }),
    exists(hass, E.doorbellButton)
      ? row('Button', `Last pressed ${ago((so(hass, E.doorbellButton) || {}).last_changed)}`,
        pill(st(hass, E.doorbellButton) === 'on' ? 'Pressed' : 'Idle',
          st(hass, E.doorbellButton) === 'on' ? 'warn' : 'idle', { plain: st(hass, E.doorbellButton) !== 'on' }))
      : '',
    exists(hass, E.doorbellLight)
      ? row('Status light', 'Onboard LED on the doorbell unit',
        sw(E.doorbellLight, lightOn, 'ok', { label: 'Doorbell status light' }))
      : '',
    row('Chime', 'Plays on the interior portal',
      btn('Ring', 'press', { id: E.playDoorbell }, { sm: true, icon: 'mdi:bell-ring-outline' })),
    !dbOnline ? note('While the doorbell is offline nobody can be admitted from outside.', 'alarm', 'mdi:alert-outline') : '',
  ].join('')));

  const f = m.camera.frigate;
  const camLive = !!ui.cameraLive && !m.camera.ambientDead;
  /* The lens has no housing of its own: it is set into the door lamp's bottom
   * band, so this is a crop of the lamp, not a fourth device. Live is a steady
   * dot in the ok tone and a detection is two rings that stop - live is not
   * alarm, and it must not read like one. */
  const det = [devStage('lens', lensArt(m, ui, { label: 'The camera lens, set into the door lamp' }), {
    tone: f.personNow ? 'warn' : (camLive ? 'ok' : 'idle'),
    online: !m.camera.ambientDead,
    lampc: lampCss(m.lamp),
    caption: f.personNow
      ? 'A person is in view'
      : `${camLive ? 'Live' : 'Frozen'} · the lens sits in the door lamp`,
    stats: [
      { label: 'Feed', value: camLive ? 'Live' : 'Frozen' },
      { label: 'At the door', value: f.personNow ? 'Person' : 'Clear' },
      { label: 'Lamp', value: m.lamp.on ? 'Lit' : 'Dark' },
    ],
  })];
  if (f.occupancy) {
    det.push(row('At the door', f.personNow ? 'A person is in view' : 'Clear',
      pill(f.personNow ? 'Person' : 'Clear', f.personNow ? 'warn' : 'ok', { led: true }),
      { act: 'moreinfo', arg: { id: f.occupancy }, toneName: f.personNow ? 'warn' : 'ok' }));
  }
  if (f.snapshotUrl) {
    det.push(`<div class="cam" style="aspect-ratio:4/3;margin:8px 0">
      <img src="${esc(f.snapshotUrl)}" alt="Last person snapshot" referrerpolicy="no-referrer">
      <div class="ov">${pill('Last snapshot', 'idle', { plain: true })}</div></div>`);
  }
  det.push(row('Away alert',
    m.presence.trackersActive
      ? 'Uses phone presence, so a missed scan cannot silence it'
      : 'Fires when every resident key reads away — a missed scan can silence it',
    pill(m.presence.trackersActive ? 'Phones' : 'Keys', m.presence.trackersActive ? 'ok' : 'warn')));
  det.push(row('Armed now', 'A person at the door while nobody is home',
    pill(m.presence.homeCount === 0 ? 'Armed' : 'Someone home', m.presence.homeCount === 0 ? 'arm' : 'idle',
      { plain: m.presence.homeCount !== 0 })));

  if (ui.frigateClips && ui.frigateClips.length) {
    det.push(`<div class="snapstrip">${ui.frigateClips.map((c) => {
      const title = c.title || 'Clip';
      const thumb = c.thumbnail || '';
      return `<button data-act="openFrigate" data-arg="{}">
        ${thumb ? `<img src="${esc(thumb)}" alt="">` : '<div style="height:72px;background:var(--g-surface-3)"></div>'}
        <span>${esc(title)}</span></button>`;
    }).join('')}</div>`);
  }

  if (m.camera.panelPath) {
    det.push(btn('Open Frigate', 'openFrigate', {}, { wide: true, icon: 'mdi:open-in-new' }));
  } else if (m.camera.frigateKey) {
    det.push(note('Clips live in the Frigate add-on. This Home Assistant has no Frigate sidebar item to open from here.',
      'idle', 'mdi:information-outline'));
  }

  if (!m.camera.frigateKey) {
    det.push(note('Person detection is off. If you run Frigate, set the camera name in More → Install to match your Frigate config.',
      'idle', 'mdi:motion-sensor'));
  } else if (!f.camera && !f.occupancy) {
    det.push(noteHtml(`Frigate is configured as <b>${esc(m.camera.frigateKey)}</b>. Live video uses your door camera. Detections appear in Activity while this panel is open. Historical clips stay in Frigate.`,
      'idle', 'mdi:motion-sensor'));
  }

  out.push(card('Person detection', det.join('')));

  const d = m.door;
  out.push(card('The door', [
    row('Contact', d.known ? `${d.open ? 'Open' : 'Closed'} · ${ago(d.since)}` : 'Portal not reporting',
      pill(d.known ? (d.open ? 'Open' : 'Closed') : 'Unknown', d.known ? (d.open ? 'warn' : 'ok') : 'idle', { led: true }),
      { act: 'moreinfo', arg: { id: E.doorContact } }),
    navRow('Sensors', 'Handle, swing, last opening', { tab: 'camera', page: 'doorSensors' }, { icon: 'mdi:door' }),
  ].join('')));

  return stack(out);
}

function viewDoorSensors(m, hass) {
  const d = m.door;
  /* The one place the door diagram is drawn at full size, so the reed pair and
   * the handle collar are visible at all - Home's cell is 74px, where both are
   * dropped with the rest of .fine. Same tone rule that cell uses, and the three
   * tiles are the three rows below it, not a fourth reading. */
  const stage = devStage('door', doorArt(m, { label: 'Door sensing' }), {
    tone: !m.health.imu.ok ? 'alarm' : (d.open ? 'pass' : (d.handle ? 'elev' : 'ok')),
    online: m.health.imu.ok,
    caption: !m.health.imu.ok
      ? 'The portal is not reporting its sensors'
      : (d.known
        ? `Reed ${d.open ? 'open' : 'closed'} · handle ${d.handle ? 'depressed' : 'at rest'}`
        : 'Portal not reporting the contact'),
    stats: [
      { label: 'Contact', value: d.known ? (d.open ? 'Open' : 'Closed') : 'Unknown' },
      { label: 'Handle', value: d.handle ? 'Depressed' : 'At rest' },
      { label: 'Leaf', value: d.moving ? 'Moving' : 'Still' },
    ],
  });
  return stack([
    pageHead('Door sensors'),
    stage,
    card('', [
      row('Contact', d.known ? `${d.open ? 'Open' : 'Closed'} since ${ago(d.since)}` : 'Portal not reporting',
        pill(d.known ? (d.open ? 'Open' : 'Closed') : 'Unknown', d.known ? (d.open ? 'warn' : 'ok') : 'idle', { led: true }),
        { act: 'moreinfo', arg: { id: E.doorContact } }),
      row('Handle', 'Corroborates an inside opening',
        pill(d.handle ? 'Depressed' : 'At rest', d.handle ? 'pass' : 'idle', { plain: !d.handle }),
        { act: 'moreinfo', arg: { id: E.handleDepressed } }),
      row('Leaf', 'IMU swing detection',
        pill(d.moving ? 'Moving' : 'Still', d.moving ? 'pass' : 'idle', { plain: !d.moving }),
        { act: 'moreinfo', arg: { id: E.doorMoving } }),
      exists(hass, E.handleTilt) ? row('Handle tilt', '', esc(st(hass, E.handleTilt, '—'))) : '',
      exists(hass, E.swingAngle) ? row('Swing angle', '', esc(st(hass, E.swingAngle, '—'))) : '',
      exists(hass, E.swingRate) ? row('Swing rate', '', esc(st(hass, E.swingRate, '—'))) : '',
      exists(hass, E.vibration) ? row('Vibration', '', esc(st(hass, E.vibration, '—'))) : '',
      d.lastSummary && d.lastSummary !== 'none'
        ? row('Last opening', 'Close direction · dwell · how wide it swung', esc(d.lastSummary))
        : '',
      row('Passage',
        `Entry ${esc(st(hass, E.tEntry, 'idle'))} · exit ${esc(st(hass, E.tExit, 'idle'))}`,
        pill(st(hass, E.tEntry) === 'active' || st(hass, E.tExit) === 'active' ? 'Open' : 'Closed',
          st(hass, E.tEntry) === 'active' || st(hass, E.tExit) === 'active' ? 'pass' : 'idle',
          { plain: st(hass, E.tEntry) !== 'active' && st(hass, E.tExit) !== 'active' })),
      /* The readings are here; the three numbers that act on them are on the
       * portal, which is the device that measures them. */
      exists(hass, E.tiltThreshold)
        ? navRow('Tune door sensing', 'Tilt, swing rate and lookback, on the interior portal',
          { tab: 'more', page: 'portal' }, { icon: 'mdi:tune-vertical' })
        : '',
    ].join('')),
  ]);
}

function viewLamp(m, hass, ui = {}) {
  const L = m.lamp;
  const out = [pageHead('Lamp')];
  const r = L.result;
  const verdictTone = r ? (r.failed ? 'alarm' : r.decision.startsWith('on') ? 'warn' : 'idle') : 'idle';

  if (L.missing) {
    out.push(noteHtml('This panel has no lamp entity to talk to. Set <b>config.lamp</b> in the Guardian panel_custom block to your light. Lamp automation in the YAML still uses this house’s original entity until a later pass.',
      'warn', 'mdi:lightbulb-alert-outline'));
  } else {
    /* The frosted panels read the same light.* attributes the colour wheel
     * below writes, so the drawing and the control cannot disagree. */
    out.push(devStage('lamp', illLamp(L, { label: 'Door lamp' }), {
      tone: L.on ? 'ok' : 'idle',
      online: true,
      lampc: lampCss(L),
      caption: L.on
        ? `On · ${Math.round(((L.brightness == null ? 255 : L.brightness) / 255) * 100)}%${L.kelvin && L.colorMode !== 'hs' ? ` · ${Math.round(L.kelvin)}K` : ''}`
        : 'Off',
      stats: [
        { label: 'Lamp', value: L.on ? 'On' : 'Off' },
        { label: 'Brightness', value: L.on ? `${Math.round(((L.brightness == null ? 255 : L.brightness) / 255) * 100)}%` : '—' },
        { label: 'Last verdict', value: esc(r ? r.verdict : '—') },
      ],
    }));
  }

  out.push(card('Last decision', `
    <div class="stat"><b style="color:var(--g-${verdictTone})">${esc(r ? r.verdict : '—')}</b>
      <span>${esc(r ? r.why : 'No decision recorded yet')}</span></div>
    <div class="chips">
      ${pill(L.on ? 'On' : 'Off', L.on ? 'ok' : 'idle', { led: true, plain: !L.on })}
      ${r && r.luma != null ? pill(`luma ${r.luma}`, 'idle', { plain: true }) : ''}
      ${r && r.sun != null ? pill(`sun ${r.sun}°`, 'idle', { plain: true }) : ''}
      ${L.sampling ? pill('Measuring', 'pass', { led: true }) : ''}
    </div>
    ${L.failStreak > 0 ? noteHtml(`<b>${L.failStreak}</b> consecutive failed sample${L.failStreak === 1 ? '' : 's'}. One is routine. Three means the measurement chain is broken.`,
      L.failStreak >= 3 ? 'alarm' : 'warn', 'mdi:alert-decagram-outline') : ''}
    ${L.mismatchMinutes !== null ? noteHtml(`The lamp has disagreed with the sun for <b>${L.mismatchMinutes} minute${L.mismatchMinutes === 1 ? '' : 's'}</b>. At ${L.mismatchMax} it will be forced.`,
      'warn', 'mdi:timer-alert-outline') : ''}
    ${L.missing ? '' : row('Lamp', L.on ? `${Math.round(((L.brightness || 0) / 255) * 100)}%${L.kelvin ? ` · ${L.kelvin}K` : ''}` : 'Off',
      sw(L.entity, L.on, 'ok', { label: 'Lamp' }))}
    ${btn('Measure now', 'sampleLamp', {}, { icon: 'mdi:camera-metering-center', sm: true })}
    ${!r ? note('No sample has finished. Tap Measure now — this line used to stay empty when the sampler aborted before writing a verdict.',
      'warn', 'mdi:camera-metering-center') : ''}
  `));

  out.push(lampColorCard(L, ui));

  /* Bounds come off each entity's own HA attributes. The fallbacks are the real
   * helper limits in packages/guardian.yaml, not a generic 0-100, so a missing
   * attribute degrades to a correct gauge rather than a nonsense one. */
  const bounds = (id, dmin, dmax, dstep) => ({
    min: attr(hass, id, 'min', dmin),
    max: attr(hass, id, 'max', dmax),
    step: attr(hass, id, 'step', dstep),
  });

  /* What the sampler would be reading. sensor.guardian_camera_luminance is
   * unavailable between samples on purpose, so this falls back to the luma= of
   * the last decision and the sentence underneath says which of the two it is.
   * Nothing is synthesised: with neither, there is simply no mark. */
  const liveRaw = parseFloat(st(hass, E.luminance));
  const liveLuma = Number.isFinite(liveRaw) ? liveRaw : null;
  const lastRaw = r && r.luma != null ? parseFloat(r.luma) : NaN;
  const lastLuma = Number.isFinite(lastRaw) ? lastRaw : null;
  const readLuma = liveLuma != null ? liveLuma : lastLuma;
  const readWhen = liveLuma != null ? 'right now'
    : (r && r.at ? `in the ${esc(r.at)} sample` : 'in the last sample');

  /* Auto-calibrate keeps its own pair and never writes the manual two. Which
   * pair is actually deciding is the thing the mode card exists to say. */
  const calDark = parseFloat(L.calDark);
  const calBright = parseFloat(L.calBright);
  const calUsable = L.calReady && Number.isFinite(calDark) && Number.isFinite(calBright)
    && calDark < calBright;
  const effDark = L.auto && calUsable ? calDark : L.dark;
  const effBright = L.auto && calUsable ? calBright : L.bright;

  const zone = sunZone(L.sunElev);
  const sunOk = zone !== 'unknown';

  /* --- Measurement mode: categorical, so what is drawn is ownership -------- */
  const nDay = Math.max(0, Math.round(Number(L.calDay) || 0));
  const nNight = Math.max(0, Math.round(Number(L.calNight) || 0));
  const nTiles = Math.max(0, Math.round(Number(L.calTiles) || 0));
  const meter = (label, have, need) => `<div class="meter"
      style="--tone:var(--g-${have >= need ? 'ok' : 'info'})">
      <b>${esc(label)}</b><span>${have >= need ? `${have} — enough` : `${have} of ${need}`}</span>
      <i style="--fill:${Math.min(100, Math.round((have / need) * 100))}%"></i>
    </div>`;

  out.push(card('Measurement mode', `
    ${seg('setSelect', [
    { value: 'Manual (this home)', label: 'Manual' },
    { value: 'Auto-calibrate', label: 'Auto-calibrate' },
  ], L.modeRaw, { arg: { id: E.lampMode }, toneName: 'info' })}
    ${!L.auto
    ? note('Manual uses the two light levels below. Leave it here unless you are deliberately starting a calibration.',
      'ok', 'mdi:tune-vertical')
    : calUsable
      ? noteHtml(`Auto-calibrate is deciding with what it taught itself — on at <b>${Math.round(calDark)}</b>,
          off at <b>${Math.round(calBright)}</b>. Your own two numbers below are left exactly as they
          are and come straight back if you switch to Manual.`, 'info', 'mdi:school-outline')
      : noteHtml('Auto-calibrate has not seen enough of this doorway yet, so <b>neither</b> pair is being used. Until it has, the camera is not consulted at all and only the sun decides.',
        'warn', 'mdi:school-outline')}
    ${L.auto ? `
      ${row('Calibration', calUsable
    ? 'It has learned this doorway and is using it'
    : 'It still needs to watch this doorway by day and by night',
    pill(calUsable ? 'Ready' : 'Learning', calUsable ? 'ok' : 'info', { led: true }))}
      <div class="meters">
        ${meter('Nights seen', nNight, 8)}
        ${meter('Days seen', nDay, 8)}
        ${meter('Parts of the frame it trusts', nTiles, 16)}
      </div>
      ${calUsable ? '' : note('These three have to be met, and they are not the whole test — it also wants the samples spread over hours, and a big enough difference between day and night.',
    'idle', 'mdi:information-outline')}
      ${btn('Rebuild the profile', 'retuneLamp', {}, { icon: 'mdi:chart-bell-curve', wide: true })}
    ` : ''}
  `));

  /* --- The what-if --------------------------------------------------------
   * Held in the panel's own memory and nowhere else. Both drawings below take
   * it as a second, dashed mark, so a hypothesis is always visibly a
   * hypothesis and never mistaken for the reading that was actually taken. */
  const whatif = !!ui.lampWhatIf;
  const probeLuma = ui.probeLuma == null
    ? (readLuma == null ? 45 : Math.round(readLuma)) : ui.probeLuma;
  const probeSun = ui.probeSun == null
    ? (L.sunElev == null ? -6 : Math.round(L.sunElev)) : ui.probeSun;

  /* --- The light level band ------------------------------------------------
   * Dark and bright are not two settings. They are one band, and the gap
   * between them is the thing being chosen, so they are drawn as one axis with
   * two handles rather than as two sliders that never mention each other. */
  const darkB = bounds(E.darkThreshold, 0, 255, 1);
  const brightB = bounds(E.brightThreshold, 0, 255, 1);
  const inverted = L.dark >= L.bright;
  const gap = Math.round(L.bright - L.dark);
  const bandClause = lumaBandClause(readLuma, L.dark, L.bright);
  /* Auto-calibrate with a ready profile decides with the pair it learned, so
   * the two below it are kept but not in force. */
  const parked = L.auto && calUsable;
  const rotB = bounds(E.lumaRotate, 0, 270, 90);

  out.push(card('Manual thresholds', `
    ${L.auto && calUsable
    ? noteHtml(`Auto-calibrate is in charge at the moment and is using <b>${Math.round(calDark)}</b> and
        <b>${Math.round(calBright)}</b>. The band below is your own pair — kept exactly as it is, and
        back in force the moment you switch to Manual.`, 'info', 'mdi:school-outline')
    : ''}
    ${L.auto && !calUsable
    ? note('Auto-calibrate is still learning, so nothing below is deciding anything yet. Switch to Manual to use these two now.',
      'warn', 'mdi:school-outline')
    : ''}
    ${row('Light level',
      tuneDragHint(ui, 'luma', 'Drag either end of the band. Everything to the left of it is dark enough for the lamp.'), '', {})}
    ${tuneStage('luma', null, null, null,
    illLumaTune({
      dark: L.dark,
      bright: L.bright,
      darkId: E.darkThreshold,
      brightId: E.brightThreshold,
      darkBounds: darkB,
      brightBounds: brightB,
      live: parked ? null : readLuma,
      probe: whatif && !parked ? probeLuma : null,
      unlocked: ui.tuneUnlocked === 'luma',
    }),
    {
      label: 'Light levels the lamp switches at',
      unlocked: ui.tuneUnlocked === 'luma',
      /* The tone is the model's to pick, as everywhere else. Crossed over is a
       * fault, so the whole instrument goes to the alarm tone rather than a
       * status colour being baked into one path. */
      toneName: inverted ? 'alarm' : 'arm',
      /* Parked means Auto-calibrate is deciding with its own pair, so this one
       * is not in force. The sentence goes conditional rather than claiming a
       * behaviour the sampler is not currently following, and the reading
       * clause is dropped - it would be measured against the wrong pair. The
       * live verdict against the pair that IS in force is two cards down. */
      say: parked
        ? `If these were the ones in force, <b data-sayval="dark">${Math.round(L.dark)}</b> or
           darker would switch the lamp on and <b data-sayval="bright">${Math.round(L.bright)}</b>
           or brighter would switch it off, with a <b data-sayval="gap">${gap}-point</b> gap
           between them where nothing happens.`
        : `At <b data-sayval="dark">${Math.round(L.dark)}</b> or darker the lamp comes on.
        At <b data-sayval="bright">${Math.round(L.bright)}</b> or brighter it goes off. Between
        the two it stays as it was, and that <b data-sayval="gap">${gap}-point</b> gap is what
        stops it flickering.${readLuma == null
    ? ' Nothing has been measured yet, so there is no mark on the band.'
    : ` The doorway read <b>${esc(readLuma.toFixed(1))}</b> ${readWhen} — that is
            <span data-bandword>${esc(bandClause)}</span>.`}`,
    })}
    ${row('Dark below', 'At or darker than this, the lamp comes on', '', {})}
    ${numberCtl(E.darkThreshold, L.dark, darkB.min, darkB.max, darkB.step,
    { toneName: 'arm', label: 'Dark threshold', bare: true, format: TUNE_FMT.luma })}
    ${row('Bright above', 'At or brighter than this, the lamp goes off', '', {})}
    ${numberCtl(E.brightThreshold, L.bright, brightB.min, brightB.max, brightB.step,
    { toneName: 'warn', label: 'Bright threshold', bare: true, format: TUNE_FMT.luma })}
    ${inverted ? note('Dark is not below bright, so there is no gap at all and the lamp will flip on every reading.', 'alarm') : ''}

    ${row('Rotate still',
      tuneDragHint(ui, 'rotate', 'Turn the picture until the doorway floor is inside the marked box.'), '', {})}
    ${tuneStage('rotate', E.lumaRotate, L.rotate, rotB,
    illRotateTune({ value: L.rotate }),
    {
      label: 'Frame rotation',
      unlocked: ui.tuneUnlocked === 'rotate',
      toneName: 'info',
      valueText: tuneFmt('rotate', L.rotate),
      say: `Before it measures anything, the sampler turns the picture
        <b data-tuneval>${esc(tuneFmt('rotate', L.rotate))}</b> and then keeps only the bottom of
        the frame. If live footage has the floor on the left, this should be 90° so it is looking
        at the doorway and not at the ceiling. Live view is never turned — only the still that
        gets measured.`,
    })}
    ${numberCtl(E.lumaRotate, L.rotate, rotB.min, rotB.max, rotB.step,
    { toneName: 'info', label: 'Frame rotation', bare: true, format: TUNE_FMT.rotate })}
  `));

  /* --- Sun fallback: the sky is status, the wait is the setting ------------ */
  const mmB = bounds(E.lampMismatchMax, 10, 180, 5);
  const expected = zone === 'night' ? 'on' : zone === 'day' ? 'off' : null;
  const disagreeing = L.mismatchMinutes !== null;
  const leftToGo = disagreeing ? Math.max(0, L.mismatchMax - L.mismatchMinutes) : null;

  out.push(card('Sun fallback', `
    ${illStage(illSunArc({ elev: L.sunElev, probe: whatif ? probeSun : null }),
    `The sun is <b>${L.sunElev === null ? 'not being reported' : `${esc(L.sunElev.toFixed(1))}°`}</b>,
      ${SUN_ZONE_WORD[zone]}. ${zone === 'night' ? 'The lamp should be on.'
    : zone === 'day' ? 'The lamp should be off.'
      : zone === 'twilight' ? 'At dusk and dawn nobody can say what it should be, so the camera decides on its own — that is the whole reason Guardian measures instead of following a clock.'
        : 'With no sun to check against, the camera decides on its own.'}`,
    SUN_ZONE_TONE[zone])}
    ${row('Sun elevation', 'Read from Home Assistant — not something you set',
    L.sunElev === null ? '—' : `${esc(L.sunElev.toFixed(1))}°`,
    { act: 'moreinfo', arg: { id: E.sun } })}
    ${note('Just below the horizon, between −6° and −3°, a “bright” reading is not trusted either and the lamp simply holds.', 'idle', 'mdi:information-outline')}

    ${row('Force after',
      tuneDragHint(ui, 'mmclock', 'How long the lamp may disagree with the sky before Guardian steps in.'), '', {})}
    ${tuneStage('mmclock', E.lampMismatchMax, L.mismatchMax, mmB,
    illMismatchTune({ value: L.mismatchMax, max: mmB.max, elapsed: L.mismatchMinutes }),
    {
      label: 'Force after',
      unlocked: ui.tuneUnlocked === 'mmclock',
      toneName: 'elev',
      valueText: tuneFmt('mmclock', L.mismatchMax),
      say: `${expected
    ? `With the sun where it is, the lamp should be <b>${expected}</b>.`
    : 'In twilight nothing is expected of the lamp, so this clock is cleared rather than counted.'}
        If it disagrees for <b data-tuneval>${esc(tuneFmt('mmclock', L.mismatchMax))}</b>, Guardian
        stops waiting and switches it itself.${disagreeing
    ? ` They have disagreed for <b>${L.mismatchMinutes}</b> minute${L.mismatchMinutes === 1 ? '' : 's'},
        so that is <b>${leftToGo}</b> to go.`
    : ' They agree at the moment, so nothing is counting.'}
        The same wait applies both ways — it does not switch off sooner to save power.`,
    })}
    ${numberCtl(E.lampMismatchMax, L.mismatchMax, mmB.min, mmB.max, mmB.step,
    { toneName: 'elev', label: 'Force after', bare: true, format: TUNE_FMT.mmclock })}
  `));

  /* --- What the lamp would do ----------------------------------------------
   * lampVerdict() is the sampler's own tree, ported read-only. This card asks
   * it a question and prints the answer; it writes nothing, calls nothing, and
   * cannot start a sample. In Now it is asked about the real reading and the
   * real sky. In Try a reading it is asked about two numbers held in the
   * panel's own memory, and both drawings above grow a dashed second mark. */
  const useValid = whatif ? !ui.probeUnusable : readLuma != null;
  const useLuma = whatif ? probeLuma : (readLuma == null ? 0 : readLuma);
  const useSunOk = whatif ? true : sunOk;
  const useSun = whatif ? probeSun : (L.sunElev == null ? 0 : L.sunElev);
  const dec = lampVerdict({
    auto: L.auto,
    calReady: calUsable,
    dark: effDark,
    bright: effBright,
    lumaValid: useValid,
    luma: useLuma,
    sunOk: useSunOk,
    sunElev: useSun,
  });
  const dw = LAMP_DECISION[dec] || ['—', ''];
  const decTone = dec.startsWith('on') ? 'warn' : dec === 'hold' ? 'idle' : 'ok';
  const sim = {
    auto: L.auto,
    calReady: calUsable,
    dark: L.dark,
    bright: L.bright,
    calDark: calUsable ? calDark : null,
    calBright: calUsable ? calBright : null,
    luma: readLuma,
    lumaValid: readLuma != null,
    sun: L.sunElev,
    sunOk,
  };

  out.push(card('What the lamp would do', `
    <div data-lampsim data-sim="${arg(sim)}">
      ${seg('lampWhatIf', [
    { value: 'now', label: 'Now' },
    { value: 'try', label: 'Try a reading' },
  ], whatif ? 'try' : 'now', { toneName: 'info' })}
      <div class="stat">
        <b data-verdictword data-tone="${decTone}" style="color:var(--g-${decTone})">${esc(dw[0])}</b>
        <span data-verdictwhy>${esc(dw[1])}</span>
      </div>
      ${whatif ? `
        <div class="probe" style="--tone:var(--g-info)">
          <label>How dark the doorway is <b data-probeval="luma">${probeLuma}</b></label>
          <input type="range" min="0" max="255" step="1" value="${probeLuma}"
            data-slider="lampProbe" data-arg="${arg({ field: 'luma' })}"
            aria-label="Try a light level">
        </div>
        <div class="probe" style="--tone:var(--g-info)">
          <label>Where the sun is <b data-probeval="sun">${probeSun}°</b></label>
          <input type="range" min="-20" max="60" step="1" value="${probeSun}"
            data-slider="lampProbe" data-arg="${arg({ field: 'sun' })}"
            aria-label="Try a sun elevation">
        </div>
        ${seg('lampProbe', [
    { value: 'usable', label: 'Camera gave a reading' },
    { value: 'unusable', label: 'Nothing usable' },
  ], ui.probeUnusable ? 'unusable' : 'usable', { arg: { field: 'valid' }, toneName: 'info', block: true })}
        ${note(`This only asks a question. Nothing is switched and no measurement is taken.${parked
    ? ' The light-level band above is not marked, because Auto-calibrate is deciding with its own pair rather than that one.'
    : ' The dashed marks on the two drawings above are following these numbers.'}`,
    'info', 'mdi:help-circle-outline')}
      ` : note(`Worked out from ${readLuma == null ? 'the settings alone, because nothing has been measured yet'
    : (liveLuma != null ? 'the reading being taken right now' : `the last reading, ${esc(r && r.at ? r.at : '')}`)},
        where the sun is, and the settings above — using the same rules the doorway sampler uses.
        Drag a light level above and this changes with it.`, 'idle', 'mdi:scale-balance')}
    </div>
  `));

  const luma = st(hass, E.luminance, 'unavailable');
  out.push(card('Measurement chain', [
    row('Camera', 'Snapshotted with the bulb briefly off',
      `<span class="mono">${esc(m.camera.sample)}</span>`, { act: 'moreinfo', arg: { id: m.camera.sample } }),
    row('Night vision',
      L.irEntity && !isBlank(L.irEntity)
        ? 'Disabled during a measurement so infrared cannot flood the frame'
        : 'Not set — night-vision stills are treated as dark. Set the Tapo night-vision switch or select if it still exists; Frigate has none.',
      pill(L.irEntity && !isBlank(L.irEntity) ? 'Configured' : 'Not set',
        L.irEntity && !isBlank(L.irEntity) ? 'ok' : 'warn')),
    row('Luminance', 'Unavailable between samples on purpose',
      luma === 'unavailable' ? 'Waiting' : esc(luma),
      { act: 'moreinfo', arg: { id: E.luminance } }),
    m.camera.stored && m.camera.stored !== m.camera.sample
      ? noteHtml(`Sampling uses <span class="mono">${esc(m.camera.sample)}</span>, same as live view. The helper still holds <span class="mono">${esc(m.camera.stored)}</span> — tap Save on <b>More → Install</b>.`,
        'warn', 'mdi:content-save-outline')
      : '',
  ].filter(Boolean).join('')));

  return stack(out);
}

function viewMoreIndex(m, hass) {
  const nKeys = m.slots.filter((s) => s.occupied).length;
  const house = isHouseAdmin(hass);
  return stack([
    `<div class="group-label">Household</div>`,
    card('', [
      navRow('Keys, People & Alerts', nKeys ? 'Add or delete keys' : 'Add a key',
        { tab: 'more', page: 'keys' }, { icon: 'mdi:key-chain-variant' }),
      navRow('Lamp', m.lamp.missing ? 'Not configured' : (m.lamp.on ? 'On' : 'Off'),
        { tab: 'more', page: 'lamp' }, { icon: 'mdi:lightbulb-outline' }),
      house ? navRow('Security', m.security.elevated ? 'Super surveillance on' : 'Normal',
        { tab: 'more', page: 'security' }, { icon: 'mdi:shield-lock-outline' }) : '',
    ].filter(Boolean).join('')),
    `<div class="group-label">House</div>`,
    card('', [
      navRow('Devices',
        m.health.portal.ok && m.health.doorbell.ok && m.health.camera.ok
          ? 'Portal, doorbell, lamp & camera' : 'Something is offline',
        { tab: 'more', page: 'devices' },
        { icon: 'mdi:router-wireless',
          toneName: m.health.portal.ok && m.health.doorbell.ok && m.health.camera.ok ? undefined : 'alarm' }),
      navRow('Notifications', isOn(hass, E.verbose) ? 'Verbose on' : 'Events only',
        { tab: 'more', page: 'notifications' }, { icon: 'mdi:bell-outline' }),
      house ? navRow('Install', 'Camera, Frigate, phones, lamp',
        { tab: 'more', page: 'install' }, { icon: 'mdi:tune-vertical' }) : '',
    ].filter(Boolean).join('')),
    house ? `<div class="group-label">Advanced</div>` : '',
    house ? card('', [
      navRow('Diagnostics', m.faults.length ? `${m.faults.length} fault${m.faults.length === 1 ? '' : 's'}` : 'Self-tests and sensors',
        { tab: 'more', page: 'diagnostics' }, { icon: 'mdi:stethoscope' }),
      navRow('Internals', 'State machine, read-only',
        { tab: 'more', page: 'internals' }, { icon: 'mdi:eye-outline' }),
      navRow('Reset', 'Clears Guardian state',
        { tab: 'more', page: 'reset' }, { icon: 'mdi:restore-alert', toneName: 'alarm' }),
    ].join('')) : '',
    `<div class="empty" style="padding:8px">Guardian ${esc(GUARDIAN_UI_VERSION)}</div>`,
  ].filter(Boolean));
}

function ssNowLine(m) {
  const armed = m.security.armed;
  const programs = m.ssPrograms || [];
  const matching = programs.filter((p) => p.matching);
  const live = programs.filter((p) => p.live);
  const until = (p) => ssHourLabel(p.end);
  if (armed && matching.length === 1) {
    return `Active now — the switch and ${matching[0].label} (until ${until(matching[0])})`;
  }
  if (armed && matching.length > 1) {
    return `Active now — the switch and ${matching.length} programs`;
  }
  if (armed) return 'Active now — the manual switch';
  if (matching.length === 1) {
    return `Active now — ${matching[0].label} (until ${until(matching[0])})`;
  }
  if (matching.length > 1) return `Active now — ${matching.length} programs`;
  if (!live.length) {
    return 'Not active. No program is enabled with a window, so only the switch will elevate.';
  }
  if (live.length === 1) {
    return `Not active. ${live[0].label} will elevate ${ssDaysSummary(live[0])}, ${hourWindow(live[0].start, live[0].end)}.`;
  }
  return `Not active. ${live.length} programs are scheduled.`;
}

function ssProgramCard(p, hass, ui = {}) {
  const kind = `hours-${p.id}`;
  const hourB = { min: 0, max: 23, step: 1 };
  const unlocked = ui.tuneUnlocked === kind;
  const tone = p.matching ? 'elev' : (p.live ? 'arm' : 'idle');
  let nowSub = 'Off';
  if (p.matching) nowSub = 'Matching now';
  else if (!p.enabled) nowSub = 'Disabled — days and hours are kept';
  else if (!p.daysOn.length) nowSub = 'No days selected — this program never fires';
  else if (p.empty) nowSub = 'Start equals end, so the window never opens';
  else nowSub = `Scheduled ${hourWindow(p.start, p.end)}`;
  const hoursRow = p.empty
    ? 'Start equals end, so the window never opens'
    : (p.wrap
      ? `From ${hourWindow(p.start, p.end)}. The window belongs to the start day.`
      : hourWindow(p.start, p.end));
  return card(p.label, `
    ${row('Name', 'Shown on Home when this program is why Super Surveillance is on', '', {})}
    ${textField(p.nameEntity, p.nameRaw, 'Weeknights', { saved: ui.savedFlash === p.nameEntity })}
    ${row('Enabled', p.enabled ? 'This program can elevate' : 'Off — days and hours are kept',
      sw(p.enabledEntity, p.enabled, 'elev', { label: `Enable ${p.label}` }))}
    ${row('Now', nowSub,
      pill(p.matching ? 'On now' : (p.live ? 'Scheduled' : 'Off'), tone, { led: p.matching }),
      { toneName: tone })}
    ${row('Days', p.daysOn.length ? ssDaysSummary(p) : 'None — this program never fires',
      btn('Clear days', 'clearSsDays', { ids: p.days.map((d) => d.entity) },
        { sm: true, disabled: !p.daysOn.length }), {})}
    ${ssDayStrip(p)}
    ${row('Hours', hoursRow, '', {})}
    ${tuneStage(kind, null, null, null,
      illHoursTune({
        start: p.start, end: p.end,
        startId: p.startEntity, endId: p.endEntity,
        startBounds: hourB, endBounds: hourB,
        nowHour: new Date().getHours(),
        unlocked,
        uid: p.id,
      }),
      {
        label: `Hours ${p.label} is scheduled`,
        unlocked,
        toneName: p.empty ? 'warn' : 'elev',
        say: p.empty
          ? 'Start and end are the same hour, so this program never opens a window.'
          : `Unlock the drawing to drag either end, or use the steppers below. ${
            p.wrap
              ? 'Start is later than end, so the window runs over midnight and belongs to the day it starts on.'
              : 'Inclusive of the start hour, exclusive of the end.'}`,
      })}
    ${numberCtl(p.startEntity, p.start, 0, 23, 1,
      { toneName: 'elev', label: `${p.label} start`, bare: true, format: (v) => ssHourLabel(v) })}
    ${numberCtl(p.endEntity, p.end, 0, 23, 1,
      { toneName: 'elev', label: `${p.label} end`, bare: true, format: (v) => ssHourLabel(v) })}
    ${!p.enabled ? note('This program is off. Super Surveillance still rises from the switch or any other enabled program.', 'idle', 'mdi:calendar-remove-outline') : ''}
    ${p.enabled && !p.daysOn.length ? note('No days are selected, so this program never fires.', 'idle', 'mdi:calendar-remove-outline') : ''}
    ${p.empty ? note('Start equals end, so the hour window never opens.', 'warn') : ''}
    <div class="chips">
      ${btn('Delete program', 'askDeleteSsProgram', { id: p.id, label: p.label },
    { sm: true, toneName: 'alarm', icon: 'mdi:delete-outline' })}
    </div>
  `);
}

function viewSecurity(m, hass, ui = {}) {
  const armed = m.security.armed;
  const scheduled = m.security.scheduled;
  const nowTone = (armed || scheduled) ? 'elev' : 'idle';
  const programs = m.ssPrograms || [];
  const rack = ssProgramIds(hass).length;
  const free = ssFreeProgramCount(hass);

  return stack([
    pageHead('Security'),
    card('Entry challenge', `
      ${row('Grace period', 'How long someone has to present both a registered card and the master PIN after an unauthorised elevated opening', '', {})}
      ${numberCtl(E.challengeSeconds, num(hass, E.challengeSeconds, 30), 10, 120, 5,
        { toneName: 'warn', label: 'Entry challenge seconds', format: (v) => `${Math.round(v)}s` })}
    `),
    card('Doorbell-exit PIN', `
      ${row('Phone window', 'How long the card owner has to submit the master PIN from their phone after an elevated doorbell-exit scan', '', {})}
      ${numberCtl(E.doorbellExitMinutes, num(hass, E.doorbellExitMinutes, 10), 2, 30, 1,
        { toneName: 'warn', label: 'Doorbell-exit PIN minutes', format: (v) => `${Math.round(v)}m` })}
    `),
    card('Super Surveillance', `
      ${row('Now', ssNowLine(m),
        pill(armed || scheduled ? 'On' : 'Off', nowTone, { led: armed || scheduled }),
        { toneName: nowTone })}
      ${row('Manual', armed ? 'On until you switch it off' : 'A card is enough until a program’s window',
        sw(E.superSurveillance, armed, 'elev', { label: 'Super surveillance' }))}
      <div class="chips" style="margin:12px 0">
        ${pill(`${programs.length} ${programs.length === 1 ? 'program' : 'programs'}`,
    programs.length ? 'ok' : 'idle', { plain: !programs.length })}
        ${free
    ? pill(`${free} can still be added`, 'idle', { plain: true })
    : pill(`All ${rack} programs in use`, 'warn')}
      </div>
      ${btn('Create Program', 'createSsProgram', {}, {
    wide: true, solid: true, tone: true, toneName: 'info',
    icon: 'mdi:plus', disabled: !free,
  })}
      ${!free ? note('Every rack position is claimed. Delete a program below to free one.', 'warn', 'mdi:calendar-alert') : ''}
    `),
    ...(programs.length
      ? programs.map((p) => ssProgramCard(p, hass, ui))
      : [empty('No programs yet. Tap Create Program to add one.', 'mdi:calendar-plus')]),
  ]);
}

/* The device gallery. Three physical devices, each one card - the render, who
 * it is, what it is doing, and the chips its own page leads with - above the
 * signal path that says how the three of them talk. Every value here is read
 * from the same model the device pages read; this page adds no entity. */
function viewDevices(m, hass) {
  const h = m.health;
  const L = m.lamp;
  const lampc = lampCss(L);
  const dbLight = exists(hass, E.doorbellLight) && st(hass, E.doorbellLight) === 'on';
  const person = !!m.camera.frigate.personNow;

  return stack([
    pageHead('Devices'),
    sysFlow(m, hass),

    deviceCard('portal', portalArt(m, hass, { size: 'sm', label: 'Interior portal' }), {
      tone: h.portal.ok ? m.security.tone : 'alarm',
      online: h.portal.ok,
      state: h.portal.ok
        ? `The screen is showing “${m.security.eyebrow}”`
        : 'Not answering — door openings are not being detected',
      chips: [
        pill(h.portal.ok ? 'Online' : 'Offline', h.portal.ok ? 'ok' : 'alarm', { led: true }),
        h.portal.ok && !dead(hass, E.portalWifi) ? pill(rssiWord(st(hass, E.portalWifi)), 'idle', { plain: true }) : '',
        h.imu.ok ? '' : pill('IMU faulty', 'alarm'),
      ],
    }),

    deviceCard('doorbell', doorbellArt(m, hass, { size: 'sm', label: 'Doorbell' }), {
      tone: h.doorbell.ok ? 'ok' : 'alarm',
      online: h.doorbell.ok,
      state: h.doorbell.ok
        ? `Ready · status light ${dbLight ? 'on' : 'off'}`
        : 'Not answering — nobody can be admitted from outside',
      chips: [
        pill(h.doorbell.ok ? 'Online' : 'Offline', h.doorbell.ok ? 'ok' : 'alarm', { led: true }),
        h.doorbell.ok && !dead(hass, E.doorbellWifi) ? pill(rssiWord(st(hass, E.doorbellWifi)), 'idle', { plain: true }) : '',
      ],
    }),

    deviceCard('lamp', illLamp(L, { size: 'sm', label: 'Door lamp and camera' }), {
      tone: person ? 'warn' : (h.camera.ok ? 'ok' : 'alarm'),
      online: h.camera.ok,
      lampc,
      state: L.missing
        ? 'Lamp not configured — More → Install'
        : `${L.on ? 'Lit' : 'Dark'} · ${person ? 'a person is in view' : (h.camera.ok ? 'camera reporting' : 'camera not reporting')}`,
      chips: [
        L.missing ? '' : pill(L.on ? 'On' : 'Off', L.on ? 'ok' : 'idle', { led: true, plain: !L.on }),
        pill(h.camera.ok ? 'Camera' : 'No feed', h.camera.ok ? 'ok' : 'alarm', { plain: h.camera.ok }),
        person ? pill('Person', 'warn', { led: true }) : '',
      ],
    }),
  ]);
}

function viewPortal(m, hass, ui = {}) {
  const h = m.health;
  const out = [pageHead('Interior portal')];
  out.push(devStage('portal', portalArt(m, hass, { label: 'Interior portal' }), {
    tone: h.portal.ok ? m.security.tone : 'alarm',
    online: h.portal.ok,
    caption: h.portal.ok
      ? `The screen at the door is showing “${m.security.eyebrow}”`
      : 'Not answering — door openings are not being detected',
    stats: [
      { label: 'Signal', value: esc(rssiWord(st(hass, E.portalWifi))) },
      { label: 'Uptime', value: esc(uptime(st(hass, E.portalUptime))) },
      { label: 'Door sensing', value: h.imu.ok ? 'Healthy' : 'Faulty' },
    ],
  }));
  out.push(card('', [
    row('Status', h.portal.ok ? 'Reachable' : 'Unreachable — door openings are not being detected',
      pill(h.portal.ok ? 'Online' : 'Offline', h.portal.ok ? 'ok' : 'alarm', { led: true }),
      { act: 'moreinfo', arg: { id: E.portalStatus } }),
    row('Wi-Fi', rssiWord(st(hass, E.portalWifi)), `${esc(st(hass, E.portalWifi, '—'))} dBm`),
    row('Uptime', '', esc(uptime(st(hass, E.portalUptime)))),
    row('IMU', 'On in the firmware means faulty',
      pill(h.imu.ok ? 'Healthy' : 'Faulty', h.imu.ok ? 'ok' : 'alarm', { led: true }),
      { act: 'moreinfo', arg: { id: E.portalImuProblem } }),
    exists(hass, E.portalLed)
      ? row('Status LED', 'Overwritten by the next display verdict',
        sw(E.portalLed, st(hass, E.portalLed) === 'on', 'info', { label: 'Portal LED' }))
      : '',
    exists(hass, E.portalBacklight)
      ? row('Screen backlight', '',
        sw(E.portalBacklight, st(hass, E.portalBacklight) === 'on', 'info', { label: 'Portal backlight' }))
      : '',
  ].join('')));

  /* Door sensing. These three decide whether an opening is read as coming from
   * inside or outside, and as bare numbers they are unguessable - so each one is
   * drawn as the thing it gates, from the same geometry the door diagram uses.
   * The picture writes the entity; the stepper under it writes the same entity by
   * the same action, for anyone who wants to type rather than drag.
   *
   * Bounds come off the entity's own HA attributes. The fallbacks are the
   * firmware's real limits (esphome/portal-unit.yaml), not a generic 0-100, so a
   * missing attribute degrades to a correct gauge rather than a nonsense one. */
  const bounds = (id, dmin, dmax, dstep) => ({
    min: attr(hass, id, 'min', dmin),
    max: attr(hass, id, 'max', dmax),
    step: attr(hass, id, 'step', dstep),
  });
  const liveNum = (id) => {
    if (!exists(hass, id)) return null;
    const v = parseFloat(st(hass, id));
    return Number.isFinite(v) ? v : null;
  };
  const sensing = [];

  if (exists(hass, E.tiltThreshold)) {
    const b = bounds(E.tiltThreshold, 3, 45, 1);
    const v = num(hass, E.tiltThreshold, 12);
    const live = liveNum(E.handleTilt);
    sensing.push(`
      ${row('Handle tilt threshold',
        tuneDragHint(ui, 'tilt', 'Drag the handle to set how far it must turn.'), '', {})}
      ${tuneStage('tilt', E.tiltThreshold, v, b,
    illTiltTune({ value: v, min: b.min, max: b.max, live }),
    {
      label: 'Handle tilt threshold',
      unlocked: ui.tuneUnlocked === 'tilt',
      valueText: tuneFmt('tilt', v),
      say: `The inside handle must turn <b data-tuneval>${esc(tuneFmt('tilt', v))}</b> and stay there
        briefly before Guardian counts it as a press. Only the inside handle can do that, so a real
        press means the door was opened from inside.${
  live == null ? '' : ` The handle is at ${esc(live.toFixed(1))}° right now.`}`,
    })}
      ${numberCtl(E.tiltThreshold, v, b.min, b.max, b.step,
    { toneName: 'elev', label: 'Handle tilt threshold', bare: true, format: TUNE_FMT.tilt })}
    `);
  }

  if (exists(hass, E.swingThreshold)) {
    const b = bounds(E.swingThreshold, 2, 40, 1);
    const v = num(hass, E.swingThreshold, 8);
    const live = liveNum(E.swingRate);
    sensing.push(`
      ${row('Swing rate threshold',
        tuneDragHint(ui, 'swing', 'Drag the line between still and moving.'), '', {})}
      ${tuneStage('swing', E.swingThreshold, v, b,
    illSwingTune({ value: v, min: b.min, max: b.max, live }),
    {
      label: 'Swing rate threshold',
      unlocked: ui.tuneUnlocked === 'swing',
      valueText: tuneFmt('swing', v),
      say: `Below <b data-tuneval>${esc(tuneFmt('swing', v))}</b> the door counts as still and a handle
        press is trusted. Above it, the door is moving and the press is ignored. A door opening all
        the way at this speed would take <b data-tuneval2>${esc(swingSweep(v))}</b>.${
  live == null ? '' : ` The door is moving at ${esc(live.toFixed(1))} °/s now.`}`,
    })}
      ${numberCtl(E.swingThreshold, v, b.min, b.max, b.step,
    { toneName: 'elev', label: 'Swing rate threshold', bare: true, format: TUNE_FMT.swing })}
    `);
  }

  if (exists(hass, E.handleLookback)) {
    const b = bounds(E.handleLookback, 500, 6000, 100);
    const v = num(hass, E.handleLookback, 2500);
    sensing.push(`
      ${row('Handle lookback',
        tuneDragHint(ui, 'lookback', 'Drag how far back a handle press still counts.'), '', {})}
      ${tuneStage('lookback', E.handleLookback, v, b,
    illLookbackTune({ value: v, min: b.min, max: b.max }),
    {
      label: 'Handle lookback',
      unlocked: ui.tuneUnlocked === 'lookback',
      valueText: tuneFmt('lookback', v),
      say: `If you pressed the handle up to <b data-tuneval>${esc(tuneFmt('lookback', v))}</b> before
        the door opened, Guardian still treats it as opened from inside. The shaded end (0.4s) is
        already covered — the handle is still counted as pressed then.`,
    })}
      ${numberCtl(E.handleLookback, v, b.min, b.max, b.step,
    { toneName: 'elev', label: 'Handle lookback', bare: true, format: TUNE_FMT.lookback })}
    `);
  }

  if (sensing.length) {
    out.push(card('Door sensing', sensing.join(''), {
      hint: 'Whether an opening came from inside or outside',
    }));
  }

  out.push(card('Sounds', `
    <div class="home-pair" style="gap:8px">
      ${btn('Welcome', 'press', { id: E.playWelcome }, { wide: true, sm: true })}
      ${btn('Denied', 'press', { id: E.playDenied }, { wide: true, sm: true })}
      ${btn('Challenge', 'press', { id: E.playChallenge }, { wide: true, sm: true })}
      ${btn('Doorbell', 'press', { id: E.playDoorbell }, { wide: true, sm: true })}
    </div>
    ${note('The alarm tone is not offered here. It loops from the alarm handler, and playing it out of context is indistinguishable from a real alarm.',
      'idle', 'mdi:volume-off')}
  `));

  out.push(card('Device', `
    <div class="chips">
      ${btn('Calibrate door rest', 'press', { id: E.calibrateRest }, { sm: true })}
      ${holdBtn('Hold: reboot', 'press', { id: E.portalRestart }, { sm: true, subtle: true, toneName: 'alarm' })}
      ${exists(hass, E.portalSafeRestart)
        ? holdBtn('Hold: safe mode', 'press', { id: E.portalSafeRestart }, { sm: true, subtle: true, toneName: 'alarm' })
        : ''}
    </div>
  `));
  return stack(out);
}

function viewDoorbell(m, hass) {
  const h = m.health;
  const lightOn = exists(hass, E.doorbellLight) && st(hass, E.doorbellLight) === 'on';
  return stack([
    pageHead('Doorbell'),
    devStage('doorbell', doorbellArt(m, hass, { label: 'Doorbell' }), {
      tone: h.doorbell.ok ? 'ok' : 'alarm',
      online: h.doorbell.ok,
      caption: h.doorbell.ok
        ? `Online · status light ${lightOn ? 'on' : 'off'}`
        : 'Not answering — nobody can be admitted from outside',
      stats: [
        exists(hass, E.doorbellWifi) && !dead(hass, E.doorbellWifi)
          ? { label: 'Signal', value: esc(rssiWord(st(hass, E.doorbellWifi))) } : null,
        exists(hass, E.doorbellUptime) && !dead(hass, E.doorbellUptime)
          ? { label: 'Uptime', value: esc(uptime(st(hass, E.doorbellUptime))) } : null,
        { label: 'Status light', value: lightOn ? 'On' : 'Off' },
      ],
    }),
    card('', [
      row('Status', String(st(hass, E.doorbellLink, 'No data')),
        pill(h.doorbell.ok ? 'Online' : 'Offline', h.doorbell.ok ? 'ok' : 'alarm', { led: true }),
        { act: 'moreinfo', arg: { id: E.doorbellOnline } }),
      exists(hass, E.doorbellWifi) ? row('Wi-Fi', rssiWord(st(hass, E.doorbellWifi)), `${esc(st(hass, E.doorbellWifi, '—'))} dBm`) : '',
      exists(hass, E.doorbellUptime) ? row('Uptime', '', esc(uptime(st(hass, E.doorbellUptime)))) : '',
      exists(hass, E.doorbellIp) ? row('IP address', '', `<span class="mono">${esc(st(hass, E.doorbellIp, '—'))}</span>`) : '',
      exists(hass, E.doorbellSsid) ? row('Network', '', esc(st(hass, E.doorbellSsid, '—'))) : '',
      exists(hass, E.doorbellLight)
        ? row('Status light', '', sw(E.doorbellLight, lightOn, 'ok', { label: 'Doorbell status light' }))
        : '',
    ].join('')),
    exists(hass, E.doorbellRestart) ? card('Device', `
      <div class="chips">
        ${holdBtn('Hold: reboot', 'press', { id: E.doorbellRestart }, { sm: true, subtle: true, toneName: 'alarm' })}
        ${exists(hass, E.doorbellSafeRestart)
          ? holdBtn('Hold: safe mode', 'press', { id: E.doorbellSafeRestart }, { sm: true, subtle: true, toneName: 'alarm' })
          : ''}
      </div>
    `) : '',
  ]);
}

/* The house-level page: delivery plumbing, plus a way in to each person's own
 * preferences. The settings themselves deliberately do NOT live here - this
 * screen is reached by whoever happens to open the panel, and a list of
 * everyone's switches on one admin page is exactly the global control this
 * feature exists to avoid. What it offers is discoverability: the summary and
 * a link through to the same per-person screen the key card opens. */
function viewNotifications(hass, m) {
  const registered = (m && m.slots ? m.slots : []).filter((s) => s.occupied);
  const visible = registered.filter((s) => canEditSlot(hass, s));
  const house = isHouseAdmin(hass);
  return stack([
    pageHead('Notifications'),
    card('Who gets what', visible.length
      ? visible.map((s) => navRow(s.short,
        s.hasNotify ? notifySummary(s) : 'No phone linked',
        { tab: 'more', page: 'personAlerts', slot: s.id },
        { icon: 'mdi:bell-cog-outline', toneName: s.hasNotify ? undefined : 'warn' })).join('')
      : empty(house ? 'No keys yet. Add one on Keys, People & Alerts.' : 'No key is linked to this account yet.', 'mdi:key-outline')),
    house ? card('', [
      row('Verbose notifications',
        isOn(hass, E.verbose)
          ? 'Every lamp verdict and every rejected card is pushed'
          : 'Only real events are pushed',
        sw(E.verbose, isOn(hass, E.verbose), 'info', { label: 'Verbose notifications' })),
      row('Delivery self-test',
        'Confirms the alert group actually reaches a phone. Allowed to fail loudly.',
        btn('Run', 'notifySelfTest', {}, { sm: true })),
      row('Silence from a phone',
        'The high-priority alarm push carries Disable Alarm. Silencing from this panel uses Reset.',
        pill('Push action', 'idle', { plain: true })),
    ].join('')) : '',
  ].filter(Boolean));
}

function viewInstall(m, hass, cfg, ui = {}) {
  const p = m.presence;
  const saved = (id) => ui.savedFlash === id;
  return stack([
    pageHead('Install'),
    note('Point these at your hardware. You should not need to edit the panel file. Entity ids are saved to Guardian helpers already in the package.',
      'idle', 'mdi:tune-vertical'),
    /* First card on the first screen a new household opens. Everything below
     * it is one setting; this is the only control that answers "am I done".
     * It is a re-check, never a write — see ACTIONS.setupCheck. */
    card('Setup check', [
      row('What is still missing',
        'Asks the backend for every remaining thing a fresh Home Assistant needs that YAML cannot provide — the File notify integration, a registered phone, a master PIN, a door camera. Changes nothing.',
        btn('Run', 'setupCheck', {}, { sm: true })),
      isOn(hass, E.setupComplete)
        ? row('First-boot defaults', 'Applied. Your own values are safe — this never runs again unless you clear the helper.',
          pill('Applied', 'ok'), { act: 'moreinfo', arg: { id: E.setupComplete } })
        : row('First-boot defaults',
          'Not applied yet. They are written two minutes after the first Home Assistant start following installation.',
          pill('Pending', 'idle', { plain: true }), { act: 'moreinfo', arg: { id: E.setupComplete } }),
    ].join('')),
    card('Door camera', `
      ${row('Camera entity', 'Live view and lamp samples use this when it names a live camera. Empty, none, or a leftover camera.tapo_c110 falls through to camera.door_camera only if that entity exists. Save the camera you actually have.', '', {})}
      ${textField(E.cameraEntity, m.camera.ambient, 'camera.door_camera', {
        mono: true, committed: m.camera.stored || m.camera.ambient, saved: saved(E.cameraEntity),
      })}
      ${m.camera.stored && m.camera.stored !== m.camera.ambient
        ? noteHtml(`Live view is using <span class="mono">${esc(m.camera.ambient)}</span>. The helper still holds <span class="mono">${esc(m.camera.stored)}</span> — tap Save to keep the door camera.`,
          'warn', 'mdi:content-save-outline')
        : ''}
      ${m.camera.ambientMissing ? note('That camera is not on this Home Assistant yet.', 'warn') : ''}
      ${row('Night-vision entity', 'Switched off during a light measurement. Frigate has none — if the Tapo integration still exposes night vision (switch.* or select.*), set it here. Leave blank to treat night-vision stills as dark.', '', {})}
      ${textField(E.cameraIrEntity, isBlank(m.camera.ir) ? '' : m.camera.ir, 'switch.your_camera_night_vision', { mono: true, saved: saved(E.cameraIrEntity) })}
    `),
    card('Frigate', `
      ${row('Camera key', 'Must match the camera name in your Frigate config, for example door_camera', '', {})}
      ${textField(E.frigateCamera, m.camera.frigateKey, 'door_camera', { mono: true, saved: saved(E.frigateCamera) })}
      ${m.camera.frigate.camera
        ? noteHtml(`Found a Frigate camera entity: <span class="mono">${esc(m.camera.frigate.camera)}</span>.`, 'ok')
        : note('No Frigate camera entity was found. Live video will use the door camera above. That is normal if Frigate talks to Home Assistant only over MQTT.',
          'idle')}
      ${cfg && cfg.frigatePath
        ? noteHtml(`Frigate sidebar path is set to <span class="mono">${esc(cfg.frigatePath)}</span>.`, 'idle')
        : (m.camera.panelPath
          ? noteHtml(`Frigate is in the sidebar as <span class="mono">${esc(m.camera.panelPath)}</span>.`, 'ok')
          : '')}
    `),
    card('Phones', `
      ${note('Optional. Phone presence decides the person-detected-while-away alert, so a missed key scan cannot silence it. Pick from trackers Home Assistant currently has, or type a comma-separated list and Save.',
        'idle', 'mdi:cellphone')}
      ${textField(E.presenceTrackers, p.trackersRaw, 'device_tracker.phone_one, device_tracker.phone_two', { mono: true, saved: saved(E.presenceTrackers) })}
      ${presenceTrackerIds(hass).length
        ? presenceTrackerIds(hass).map((id) => {
          const on = p.trackers.some((t) => t.id === id);
          const s = hass.states[id];
          const name = s && s.attributes && s.attributes.friendly_name ? s.attributes.friendly_name : id;
          const state = s ? s.state : 'missing';
          return row(name, id,
            `<button class="chip" data-act="togglePresence" data-arg="${arg({ id, on: !on })}" aria-pressed="${on}">${on ? 'Using' : 'Add'}</button>
             ${pill(state, state === 'home' ? 'ok' : 'idle', { plain: state !== 'home' })}`,
            { act: 'moreinfo', arg: { id } });
        }).join('')
        : empty('No device_tracker entities on this Home Assistant yet.')}
      ${p.trackers.length
        ? p.trackers.filter((t) => !t.exists).map((t) => row(t.name, t.id,
          pill('missing', 'alarm'), { act: 'moreinfo', arg: { id: t.id } })).join('')
        : ''}
    `),
    card('Lamp', `
      ${lampTargetSelect(hass)}
      ${m.lamp.entity && m.lamp.entity !== 'none'
        ? row('Resolved entity', 'Automations and this panel both use this light.',
          `<span class="mono">${esc(m.lamp.entity)}</span>`)
        : ''}
      ${m.lamp.missing ? note('That light is not on this Home Assistant. Pick a discovered light above, or wait for the options list to refresh.',
        'warn') : ''}
    `),
  ]);
}

/* The install card. Guardian's own answer to "did I copy everything, and did
 * the restart take", asked from the panel instead of from an SSH session.
 *
 * Every row is a file the household physically copied, so the remedy for a bad
 * row is always the same shape and always something they can act on: copy that
 * file, restart fully. Versions are shown rather than reduced to a tick,
 * because "scripts.yaml says 2.20.0, everything else says 2.21.0" tells them
 * which file to copy, and a tick does not. */
function installCard(m) {
  const i = m.install;
  if (!i.present) {
    return card('Installation', [
      note('No part of Guardian answers in Home Assistant. This panel is served from /config/www, which is why it still renders — but the helpers, templates and logic it drives are not loaded. Copy the packages/ files into /config/packages/, scripts.yaml and automations.yaml into /config, then restart Home Assistant fully.',
        'alarm', 'mdi:package-variant-remove'),
      row('This panel', 'www/guardian-ui/guardian-panel.js', pill(i.ui, 'ok')),
      row('Backend', 'sensor.guardian_version — not found', pill('Missing', 'alarm'),
        { toneName: 'alarm' }),
    ].join(''));
  }

  /* When the PANEL is the stale half, every one of these files is fine and
   * telling the household to copy it sends them to re-copy four correct files
   * and restart for nothing. Say which half is actually wrong.
   *
   * "Matches what Home Assistant asked for" was written for browser_behind,
   * where the backend is ahead of the panel and `requested` names the backend's
   * version. It is not a safe thing to say in general: in config_behind
   * `requested` is the OLD number, so a genuinely stale backend file also
   * "matches what Home Assistant asked for" while being exactly the file that
   * needs copying. Compare against `requested` and say so only when it is
   * actually true - the same mistake as the banner, one row further down. */
  const matchesRequested = (h) => !!i.requested && h.shows === i.requested;

  const rows = i.halves.map((h) => row(
    h.file,
    h.ok ? 'Matches this panel'
      : h.shows === 'missing' ? 'Not loaded — copy this file and restart fully'
        : matchesRequested(h)
          ? `Reports ${h.shows}, which matches what Home Assistant asked for — this file is fine`
          : `Reports ${h.shows}, this panel is ${i.ui} — copy this file and restart fully`,
    pill(h.shows === 'present' ? 'Present' : h.shows,
      (h.ok || matchesRequested(h)) ? 'ok' : 'alarm'),
    { toneName: (h.ok || matchesRequested(h)) ? '' : 'alarm' },
  )).join('');

  /* The two version directions differ in severity as well as in cure, and
   * flattening that was part of the same mistake. browser_behind is old logic
   * answering new questions, which is the fault this comparison exists for.
   * config_behind is a correct, fully deployed install whose cache-buster is one
   * release behind - worth fixing, because a browser that cached the old address
   * before the file was replaced keeps being served the old panel, but not the
   * red banner that made the household believe their alarm was broken. */
  const vTone = i.panelStale ? i.version.tone : 'ok';

  return card('Installation', [
    /* THREE CASES, NOT TWO, BECAUSE `ok` NO LONGER MEANS "NOTHING TO SAY".
     *
     * A stale ?v= stopped counting as a broken install in the forty-sixth
     * change - it is a correct, fully working deployment whose cache-buster has
     * not been bumped - so `i.ok` can now be true while there is still something
     * worth reporting. Reporting it HERE and not on the landing page is the
     * whole point: this is the screen somebody opens to ask "is my install
     * healthy", and the answer is "yes, and here is the one maintenance job
     * outstanding". It is not a NEEDS ATTENTION card on the home page saying
     * nothing is wrong in six sentences, which is what it was. */
    !i.ok ? (!i.rackReady
      ? note('The RFID slot rack is missing, so Guardian cannot look up any key and every alert is being skipped. This is not a problem with your keys or your phones.',
        'alarm', 'mdi:alert-decagram-outline')
      : i.version.state === 'browser_behind'
        /* Cause and remedy both come off the classified state. Nothing is
         * composed here, so there is exactly one place either can be wrong,
         * and no way to print a cure for a cause that was not established. */
        ? noteHtml(`Home Assistant asked your browser for panel ${esc(i.requested)} and got ${esc(i.ui)}. ${esc(i.version.cause)} <b>The rest of Guardian is fine — do not re-copy it.</b> ${esc(i.version.remedy)}`,
          vTone, 'mdi:alert-decagram-outline')
        : note('Guardian’s files did not all come from the same version. The panel and the logic underneath it can disagree about what a key or a phone link means, and the symptoms of that look like ordinary setup mistakes. Copy the files marked below and restart Home Assistant fully — packages and templates do not merge on a reload.',
          vTone, 'mdi:alert-decagram-outline'))
      : i.cacheKeyStale
        ? noteHtml(`<b>Guardian is deployed correctly and running ${esc(i.ui)}.</b> One maintenance job is outstanding: Home Assistant still asks for the panel by the ${esc(i.requested)} address. ${esc(i.version.cause)} ${esc(i.version.remedy)}`,
          'warn', 'mdi:wrench-outline')
        : '',
    row('This panel', i.panelStale
      ? `www/guardian-ui/guardian-panel.js — running ${i.ui}, Home Assistant asked for ${i.requested}`
      : 'www/guardian-ui/guardian-panel.js',
    pill(i.ui, vTone),
    { toneName: i.panelStale ? vTone : '' }),
    rows,
    row('RFID slot rack', i.rackReady
      ? 'sensor.guardian_rfid_slots is answering'
      : 'sensor.guardian_rfid_slots is missing — no key can be looked up',
    pill(i.rackReady ? 'Ready' : 'Missing', i.rackReady ? 'ok' : 'alarm'),
    { toneName: i.rackReady ? '' : 'alarm' }),
  ].join(''));
}

/* Per-key routing, in the same vocabulary script.guardian_notify_person uses to
 * decide. Computed from the same two facts the script reads - the slot's picked
 * target and the live notify domain - so this page and a real door event cannot
 * come to different conclusions. Occupied slots only: an empty slot with no
 * phone linked is not a fault, it is an empty slot. */
function routingCard(m, hass) {
  const live = notifyTargetIds(hass);
  const used = m.slots.filter((s) => s.occupied);
  if (!used.length) {
    return card('Alert routing', empty('No keys enrolled yet', 'mdi:card-account-details-outline'));
  }
  const rows = used.map((s) => {
    const who = s.name;
    if (!m.install.rackReady) {
      return row(who, 'Cannot be routed — Guardian is not fully installed',
        pill('Blocked', 'alarm'), { toneName: 'alarm' });
    }
    if (!isLinkedNotify(s.notifyTarget)) {
      return row(who, 'No phone linked — alerts about this key go to everyone',
        pill('Not linked', 'idle'));
    }
    const reachable = live.includes(s.notifyTarget);
    return row(who,
      reachable
        ? `Alerts go to ${notifyPhoneLabel(hass, s.notifyTarget)}`
        : `${notifyPhoneLabel(hass, s.notifyTarget)} is linked but Home Assistant cannot see it — open the companion app on that phone`,
      pill(reachable ? 'Reachable' : 'Unreachable', reachable ? 'ok' : 'warn'),
      { toneName: reachable ? '' : 'warn' });
  }).join('');

  return card('Alert routing', [
    live.length ? '' : note('Home Assistant can see no notify targets at all, so no alert can reach anyone. Install the Home Assistant companion app on at least one phone and sign in.',
      'alarm', 'mdi:cellphone-off'),
    rows,
    row('Phones Home Assistant can see', live.length
      ? live.map((id) => notifyPhoneLabel(hass, id)).join(', ')
      : 'None',
    pill(String(live.length), live.length ? 'ok' : 'alarm')),
  ].join(''));
}

function viewDiagnostics(m, hass) {
  return stack([
    pageHead('Diagnostics'),
    installCard(m),
    routingCard(m, hass),
    card('Faults', m.faults.length
      ? m.faults.map((f) => row(f.title, f.body, pill(f.token, 'warn'), { toneName: 'warn' })).join('')
      : row('All clear', 'Every subsystem Guardian watches is reporting',
        pill('Healthy', 'ok', { led: true }), { toneName: 'ok' })),
    card('Tests', [
      /* Both of these were Developer Tools rituals: a household had to know the
       * script existed, find it, and read its verdict out of a persistent
       * notification. A check nobody can find is a check nobody runs. */
      row('Backend self check',
        'Asks Home Assistant what it sees — versions, the slot rack, every phone link. Sends nothing.',
        btn('Run', 'selfCheck', {}, { sm: true })),
      row('Notification self-test',
        'Sends real alerts to prove routing end to end. Phones will buzz.',
        btn('Run', 'notifySelfTest', {}, { sm: true })),
      row('Occupancy pulse',
        'Runs the away-simulation lamp pulse once and restores the previous state.',
        btn('Run once', 'occupancyPulse', {}, { sm: true })),
      row('Ambient measurement',
        'Turns the bulb off briefly, measures the frame, and re-decides the lamp.',
        btn('Measure', 'sampleLamp', {}, { sm: true })),
      row('Master PIN scripts',
        'Setting or verifying a PIN takes the PIN as an argument, so it stays in Developer Tools.',
        pill('Developer Tools', 'idle', { plain: true })),
    ].join('')),
  ]);
}

function viewInternals(hass) {
  return stack([
    pageHead('Internals'),
    note('State-machine helpers, shown for diagnosis. They are not editable here. Tap a row to open Home Assistant’s own dialog.',
      'warn', 'mdi:eye-outline'),
    card('', INTERNALS.filter(([id]) => exists(hass, id)).map(([id, label]) =>
      row(label, `<span class="mono">${esc(resolve(hass, id))}</span>`,
        `<span class="mono">${esc(st(hass, id, '—'))}</span>`,
        { act: 'moreinfo', arg: { id }, subHtml: true })).join('')),
  ]);
}

function viewReset() {
  return stack([
    pageHead('Reset'),
    card('', `
      ${note('A reset clears the authentication state machine, every latch, a wedged alarm and every Guardian notification, then hands the lamp back to automatic control. It grants nothing. It is Home Assistant-side only by design.',
        'alarm', 'mdi:restore-alert')}
      <div style="display:flex;flex-direction:column;gap:10px;padding-top:8px;padding-bottom:24px">
        ${holdBtn('Hold to reset Guardian', 'reset', { restart: false }, { wide: true, toneName: 'alarm', icon: 'mdi:restore-alert' })}
        ${holdBtn('Hold to reset and reboot both devices', 'reset', { restart: true }, { wide: true, toneName: 'alarm', icon: 'mdi:restart-alert' })}
      </div>
    `, { cls: 'danger-zone' }),
  ]);
}

/* =============================================================================
 * 10. ACTIVITY TIMELINE
 *
 * Two sources, one feed.
 *
 *   PAST      Home Assistant's recorder.
 *   LIVE      The event bus, subscribed to while the panel is open.
 *
 * The forensic record of rejected cards (with hashes), door-direction verdicts
 * and some Frigate payloads is the JSONL data log. This panel does NOT read
 * it, and the log must NOT be relocated under /config/www (audit F-57).
 *
 * Frigate detections become live rows via guardian.person_detected (fired by
 * the existing Data Log automation). Occupancy binary sensors from a Frigate
 * integration, when present, are genuine recorder history.
 * ========================================================================== */

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'access', label: 'Access' },
  { id: 'door', label: 'Door' },
  { id: 'camera', label: 'Camera' },
  { id: 'presence', label: 'People' },
  { id: 'system', label: 'System' },
  { id: 'lamp', label: 'Lamp' },
];

function historyEntities(hass, m) {
  const ids = [
    E.display, E.doorContact, E.superSurveillance, E.elevated, E.entryChallenge,
    E.doorbellExitPin, E.mfaPending, E.enrollMode, E.pinChangeMode, E.alarmReason, E.lampResult,
    E.doorbellOnline, E.portalStatus, E.faults, E.doorbellButton,
  ];
  slotIds(hass).forEach((i) => ids.push(`input_select.rfid_${i}`));
  if (m && m.camera && m.camera.frigate.occupancy) ids.push(m.camera.frigate.occupancy);
  return ids.map((id) => resolve(hass, id)).filter((id) => hass.states[id]);
}

const DISPLAY_ROWS = {
  GRANTED: ['Access granted', 'A registered card opened a passage window', 'ok', 'mdi:check-decagram', 'access'],
  DENIED_CARD: ['Card not recognised', 'An unknown card was presented and rejected', 'warn', 'mdi:card-remove-outline', 'access'],
  DENIED: ['PIN rejected', 'A wrong master PIN was entered at the keypad', 'warn', 'mdi:dialpad', 'access'],
  STOLEN: ['Stolen card presented', 'A card flagged Stolen/Lost was scanned. No passage window was opened.', 'alarm', 'mdi:card-off-outline', 'access'],
  ALARM: ['Major alarm', '', 'alarm', 'mdi:alarm-light', 'system'],
  CLONE: ['Copied key rejected', 'A known card presented a stale counter. The original key is still valid.', 'alarm', 'mdi:card-off-outline', 'access'],
  UNSUPPORTED: ['Wrong card type', 'The reader could not identify this key. NTAG213/215/216 and MIFARE Classic 1K are supported.', 'warn', 'mdi:card-remove-outline', 'access'],
  HOLD: ['Hold the card', 'Keep the key on the coil and tap again. Re-enroll only after three HOLDs on the same key.', 'info', 'mdi:nfc', 'access'],
  ENROLL_PICK: ['Adding a key — pick who to replace', 'Every key is in use, so one has to be chosen first', 'info', 'mdi:card-plus-outline', 'access'],
};

const BOOL_ROWS = {
  [E.superSurveillance]: {
    on: ['Super surveillance armed', 'Cards now raise a PIN challenge', 'elev', 'mdi:shield-lock', 'system'],
    off: ['Super surveillance disarmed', 'Cards open a passage window without a PIN', 'idle', 'mdi:shield-off-outline', 'system'],
  },
  [E.elevated]: {
    on: ['Elevated mode began', 'A PIN is required to pass', 'elev', 'mdi:shield-alert', 'system'],
    off: ['Elevated mode ended', 'Any challenge that was open was cancelled, not alarmed', 'idle', 'mdi:shield-outline', 'system'],
  },
  [E.entryChallenge]: {
    on: ['Entry challenge started', 'The door opened with no completed passage window while elevated. Card and PIN are both required.', 'warn', 'mdi:shield-alert-outline', 'access'],
    off: ['Entry challenge cleared', 'Answered by a card and the master PIN, or ended another way', 'ok', 'mdi:shield-check-outline', 'access'],
  },
  [E.doorbellExitPin]: {
    on: ['Doorbell-exit PIN window opened', 'A card was scanned at the doorbell after leaving. The owner must confirm with the master PIN from their phone.', 'warn', 'mdi:cellphone-key', 'access'],
    off: ['Doorbell-exit PIN window closed', 'Confirmed from the phone or keypad, or ended another way', 'ok', 'mdi:cellphone-check', 'access'],
  },
  [E.mfaPending]: {
    on: ['PIN challenge opened', 'A card was scanned while elevated mode was in force', 'elev', 'mdi:dialpad', 'access'],
    off: ['PIN challenge closed', '', 'idle', 'mdi:dialpad', 'access'],
  },
  [E.enrollMode]: {
    on: ['Adding a key', 'Type an optional name, then present an unknown card at the doorbell or the interior portal', 'info', 'mdi:card-plus', 'access'],
    off: ['Stopped adding keys', '', 'idle', 'mdi:card-plus-outline', 'access'],
  },
  [E.pinChangeMode]: {
    on: ['PIN change session opened', 'The master PIN is typed on the portal keypad', 'elev', 'mdi:dialpad', 'access'],
    off: ['PIN change session ended', '', 'idle', 'mdi:dialpad', 'access'],
  },
  [E.doorbellOnline]: {
    on: ['Doorbell back online', '', 'ok', 'mdi:doorbell', 'system'],
    off: ['Doorbell offline', 'The exterior reader and the button are not responding', 'alarm', 'mdi:doorbell', 'system'],
  },
  [E.portalStatus]: {
    on: ['Portal back online', 'Door detection has resumed', 'ok', 'mdi:lan-connect', 'system'],
    off: ['Portal offline', 'Door openings are not being detected', 'alarm', 'mdi:lan-disconnect', 'system'],
  },
};

function normaliseHistory(raw) {
  const out = {};
  Object.keys(raw || {}).forEach((id) => {
    out[id] = (raw[id] || []).map((p) => ({
      state: p.s !== undefined ? p.s : p.state,
      ts: (p.lu !== undefined ? p.lu : p.lc !== undefined ? p.lc : Date.parse(p.last_changed) / 1000) * 1000,
    })).filter((p) => Number.isFinite(p.ts));
  });
  return out;
}

function interpretHistory(hass, hist, m) {
  const rows = [];
  const push = (ts, tone, icon, cat, title, sub) =>
    rows.push({ ts, tone, icon, cat, title, sub: sub || '', live: false });

  const get = (id) => hist[resolve(hass, id)] || [];
  const bad = (v) => !v || v === 'unknown' || v === 'unavailable';

  const reasons = get(E.alarmReason).filter((p) => !bad(p.state) && p.state !== 'none');
  const reasonAt = (ts) => {
    let best = '';
    for (const r of reasons) { if (r.ts <= ts + 4000) best = r.state; else break; }
    return best;
  };

  get(E.display).forEach((p, i, arr) => {
    if (i === 0 || p.state === arr[i - 1].state) return;
    const def = DISPLAY_ROWS[p.state];
    if (!def) return;
    const sub = p.state === 'ALARM' ? (reasonAt(p.ts) || def[1]) : def[1];
    push(p.ts, def[2], def[3], def[4], def[0], sub);
  });

  Object.keys(BOOL_ROWS).forEach((id) => {
    const map = BOOL_ROWS[id];
    get(id).forEach((p, i, arr) => {
      if (i === 0 || p.state === arr[i - 1].state) return;
      const def = map[p.state];
      if (!def) return;
      push(p.ts, def[2], def[3], def[4], def[0], def[1]);
    });
  });

  get(E.doorContact).forEach((p, i, arr) => {
    if (i === 0 || p.state === arr[i - 1].state || bad(p.state)) return;
    const open = p.state === 'on';
    push(p.ts, open ? 'pass' : 'idle', open ? 'mdi:door-open' : 'mdi:door-closed',
      'door', open ? 'Door opened' : 'Door closed', '');
  });

  if (exists(hass, E.doorbellButton)) {
    get(E.doorbellButton).forEach((p, i, arr) => {
      if (i === 0 || p.state === arr[i - 1].state || p.state !== 'on') return;
      push(p.ts, 'info', 'mdi:bell-ring', 'door', 'Doorbell pressed', '');
    });
  }

  const occ = m && m.camera && m.camera.frigate.occupancy;
  if (occ) {
    get(occ).forEach((p, i, arr) => {
      if (i === 0 || p.state === arr[i - 1].state || bad(p.state)) return;
      if (p.state === 'on') push(p.ts, 'warn', 'mdi:walk', 'camera', 'Person at the door', '');
      else if (p.state === 'off') push(p.ts, 'idle', 'mdi:walk', 'camera', 'Person left', '');
    });
  }

  buildSlots(hass).forEach((slot) => {
    get(slot.selEntity).forEach((p, i, arr) => {
      if (i === 0 || p.state === arr[i - 1].state || bad(p.state)) return;
      if (p.state === 'At home') push(p.ts, 'ok', 'mdi:home-import-outline', 'presence', `${slot.short} came home`, '');
      else if (p.state === 'Away') push(p.ts, 'idle', 'mdi:home-export-outline', 'presence', `${slot.short} left`, '');
      else push(p.ts, 'alarm', 'mdi:card-off-outline', 'presence', `${slot.short}'s key flagged ${p.state}`, '');
    });
  });

  get(E.lampResult).forEach((p, i, arr) => {
    if (i === 0 || p.state === arr[i - 1].state || bad(p.state) || p.state === 'none') return;
    const r = parseLampResult(p.state);
    if (!r) return;
    push(p.ts, r.failed ? 'alarm' : r.decision.startsWith('on') ? 'warn' : 'idle',
      r.failed ? 'mdi:lightbulb-alert-outline' : 'mdi:lightbulb-outline',
      'lamp', r.verdict, `${r.why}${r.luma ? ` · luma ${r.luma}` : ''}${r.sun ? ` · sun ${r.sun}°` : ''}`);
  });

  get(E.faults).forEach((p, i, arr) => {
    if (i === 0 || p.state === arr[i - 1].state) return;
    const now = String(p.state || '').split(',').map((s) => s.trim()).filter(Boolean);
    const was = String(arr[i - 1].state || '').split(',').map((s) => s.trim()).filter(Boolean);
    const added = now.filter((t) => !was.includes(t));
    const gone = was.filter((t) => !now.includes(t));
    if (added.length) push(p.ts, 'warn', 'mdi:alert-circle-outline', 'system',
      `Fault: ${added.map((t) => (FAULT_COPY[t] || [t])[0]).join(', ')}`, '');
    if (gone.length && !added.length) push(p.ts, 'ok', 'mdi:check-circle-outline', 'system',
      `Cleared: ${gone.map((t) => (FAULT_COPY[t] || [t])[0]).join(', ')}`, '');
  });

  return rows;
}

const LIVE_EVENTS = [
  ['guardian.unknown_card_scanned', () => ({
    tone: 'warn', icon: 'mdi:card-remove-outline', cat: 'access',
    title: 'Card not recognised',
    sub: 'The card matched no registered key.',
  })],
  ['guardian.clone_card_scanned', (d) => ({
    tone: 'alarm', icon: 'mdi:card-off-outline', cat: 'access',
    title: 'Copied key rejected',
    sub: d ? `${d.name || `Key ${d.slot}`} presented a stale counter. The original key still works.` : '',
  })],
  ['guardian.card_enrolled', (d) => ({
    tone: 'ok', icon: 'mdi:card-plus-outline', cat: 'access',
    title: d && d.name ? `${d.name}'s key added` : 'Key added',
    sub: d && d.source
      ? `Written at the ${d.source === 'doorbell' ? 'doorbell' : 'interior portal'}.`
      : '',
  })],
  ['guardian.stolen_card_scanned', (d) => ({
    tone: 'alarm', icon: 'mdi:card-off-outline', cat: 'access',
    title: 'Stolen card presented',
    sub: d && (d.name || d.slot)
      ? `${d.name || `Key ${d.slot}`}. No passage window was opened.`
      : 'No passage window was opened.',
  })],
  ['esphome.tamper_alert', (d) => ({
    tone: 'alarm', icon: 'mdi:shield-alert-outline', cat: 'security',
    title: d && d.reason === 'magnet_defeat'
      ? 'Portal tamper: magnet defeat'
      : d && d.reason === 'spoofed_contact'
        ? 'Portal tamper: spoofed contact'
        : 'Portal tamper',
    sub: d && d.reason === 'magnet_defeat'
      ? 'The door leaf rotated while the contact still read closed.'
      : d && d.reason === 'spoofed_contact'
        ? 'The door contact opened but the leaf never rotated.'
        : (d && d.reason ? String(d.reason) : ''),
  })],
  ['guardian.door_opened_from_inside', () => ({
    tone: 'pass', icon: 'mdi:arrow-right-bold-box-outline', cat: 'door',
    title: 'Door opened from inside', sub: '',
  })],
  ['guardian.door_opened_from_outside', () => ({
    tone: 'pass', icon: 'mdi:arrow-left-bold-box-outline', cat: 'door',
    title: 'Door opened from outside', sub: '',
  })],
  ['guardian.door_direction_unknown', () => ({
    tone: 'warn', icon: 'mdi:help-box-outline', cat: 'door',
    title: 'Door direction unresolved',
    sub: 'No passage window was open and the handle did not corroborate a verdict.',
  })],
  ['guardian.presence_corrected', (d) => ({
    tone: 'info', icon: 'mdi:account-sync-outline', cat: 'presence',
    title: 'Presence corrected',
    sub: d ? `${d.name || `Key ${d.slot}`} was "${d.from}", scanned at the ${d.source === 'doorbell' ? 'doorbell' : 'interior portal'}, now "${d.to}".` : '',
  })],
  ['guardian.entry_challenge_started', (d) => ({
    tone: 'warn', icon: 'mdi:shield-alert-outline', cat: 'access',
    title: 'Entry challenge started',
    sub: d ? `Opened from ${d.origin || 'an unresolved direction'}${d.house_empty === true || d.house_empty === 'True' ? ', house believed empty' : ''}.` : '',
  })],
  ['guardian.entry_challenge_cleared', (d) => ({
    tone: 'ok', icon: 'mdi:shield-check-outline', cat: 'access',
    title: 'Entry challenge cleared', sub: d && d.by ? `Answered by ${d.by}.` : '',
  })],
  ['guardian.doorbell_exit_pin_started', (d) => ({
    tone: 'warn', icon: 'mdi:cellphone-key', cat: 'access',
    title: 'Doorbell-exit PIN window opened',
    sub: d ? `Slot ${d.slot || '?'}${d.minutes ? ` · ${d.minutes}m` : ''}.` : '',
  })],
  ['guardian.doorbell_exit_pin_cleared', (d) => ({
    tone: 'ok', icon: 'mdi:cellphone-check', cat: 'access',
    title: 'Doorbell-exit PIN confirmed',
    sub: d && d.method ? `Via ${d.method}.` : '',
  })],
  ['guardian.major_alarm', (d) => ({
    tone: 'alarm', icon: 'mdi:alarm-light', cat: 'system',
    title: 'Major alarm', sub: (d && d.reason) || '',
  })],
  ['guardian.pin_change', (d) => ({
    tone: 'elev', icon: 'mdi:dialpad', cat: 'access',
    title: 'Master PIN change', sub: d && d.outcome ? `Outcome: ${d.outcome}.` : '',
  })],
  ['guardian.system_reset', () => ({
    tone: 'info', icon: 'mdi:restore-alert', cat: 'system',
    title: 'System reset', sub: 'All Guardian state was reset. No access was granted.',
  })],
  ['guardian.person_detected', (d) => ({
    tone: d && d.type === 'end' ? 'idle' : 'warn',
    icon: 'mdi:walk', cat: 'camera',
    title: d && d.type === 'end' ? 'Person left' : 'Person at the door',
    sub: d && d.camera ? `Frigate · ${d.camera}` : 'Frigate',
  })],
  ['esphome.rfid_scanned', (d) => ({
    tone: 'arm', icon: 'mdi:nfc-tap', cat: 'access',
    title: 'Card scanned',
    sub: d && d.source ? `At the ${d.source === 'doorbell' ? 'doorbell' : 'interior portal'} reader.` : '',
  })],
  ['esphome.doorbell_pressed', () => ({
    tone: 'info', icon: 'mdi:bell-ring', cat: 'door', title: 'Doorbell pressed', sub: '',
  })],
  ['esphome.door_opened', () => ({
    tone: 'pass', icon: 'mdi:door-open', cat: 'door', title: 'Door opened', sub: '',
  })],
  ['esphome.door_closed', (d) => ({
    tone: 'idle', icon: 'mdi:door-closed', cat: 'door', title: 'Door closed',
    sub: d && d.dwell_ms ? `Open for ${Math.round(Number(d.dwell_ms) / 1000)}s.` : '',
  })],
];

function viewActivity(m, hass, ui) {
  const offset = Math.max(0, Math.min(ACTIVITY_MAX_DAYS - 1, ui.activityDayOffset || 0));
  const dayStart = startOfLocalDay(Date.now(), offset);
  const dayKey = dayStart.toDateString();
  const rows = ui.timeline
    .filter((r) => ui.filter === 'all' || r.cat === ui.filter)
    .filter((r) => new Date(r.ts).toDateString() === dayKey)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 250);
  const leftover = ui.activityExpanded ? 0 : Math.max(0, rows.length - ACTIVITY_PAGE_SIZE);
  const shown = leftover ? rows.slice(0, ACTIVITY_PAGE_SIZE) : rows;

  const body = [];
  body.push(`<div class="activity-filters">
    ${CATEGORIES.map((c) => `<button data-act="filter" data-arg="${arg({ id: c.id })}"
      aria-pressed="${ui.filter === c.id}">${esc(c.label)}</button>`).join('')}
  </div>`);

  body.push(`<div class="activity-day">
    <button class="btn sm" data-act="activityDay" data-arg="${arg({ dir: 1 })}"
      aria-label="Older day" ${offset >= ACTIVITY_MAX_DAYS - 1 ? 'disabled' : ''}>‹</button>
    <div class="label">${esc(dayLabel(dayStart.getTime()))}</div>
    <button class="btn sm" data-act="activityDay" data-arg="${arg({ dir: -1 })}"
      aria-label="Newer day" ${offset <= 0 ? 'disabled' : ''}>›</button>
  </div>`);

  body.push(`<div class="chips" style="margin-bottom:12px">
    ${ui.historyState === 'loading' ? pill('Loading…', 'arm', { led: true }) : ''}
    ${ui.liveOk ? pill('Live', 'ok', { led: true }) : pill('Not subscribed', 'idle', { plain: true })}
  </div>`);

  if (ui.historyState === 'error') {
    body.push(note(`Could not read history: ${esc(ui.historyError || 'unknown error')}. Live events below still work.`,
      'warn', 'mdi:database-alert-outline'));
  }

  if (!shown.length) {
    const emptyCopy = ui.filter === 'camera'
      ? 'Person detections appear here while this panel is open. Historical Frigate clips live in Frigate. Occupancy history appears if Frigate has published a person sensor into Home Assistant.'
      : (ui.historyState === 'loading' ? 'Reading history…'
        : (offset === 0 ? 'Nothing today' : 'Nothing on this day'));
    body.push(empty(emptyCopy, ui.historyState === 'loading' ? 'mdi:progress-clock' : 'mdi:clock-outline'));
  } else {
    const parts = shown.map((r) => `<div class="ev" data-live="${r.live ? 1 : 0}" style="--tone:var(--g-${r.tone})">
        <span class="dot"><ha-icon icon="${esc(r.icon)}"></ha-icon></span>
        <div class="body"><b>${esc(r.title)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
        <span class="when">${esc(hhmm(r.ts))}</span>
      </div>`);
    body.push(`<div class="tl">${parts.join('')}</div>`);
  }

  const foot = [];
  if (leftover) {
    foot.push(`<div class="activity-more">${btn(`More (${leftover})`, 'activityMore', {}, {
      wide: true, icon: 'mdi:chevron-down',
    })}</div>`);
  }
  foot.push(note('Rejected cards, door-direction verdicts, presence corrections and Frigate MQTT detections are live only — they appear from the moment this panel is opened. Door, presence, alarms and lamp verdicts are genuine history. The complete forensic record stays on the Home Assistant host, not in the browser.',
    'idle', 'mdi:information-outline'));
  body.push(`<div class="activity-foot">${foot.join('')}</div>`);

  return body.join('');
}

/* =============================================================================
 * 11. THE PANEL ELEMENT
 *
 * Home Assistant assigns .hass on every state change. Three rules keep that
 * cheap and non-disruptive:
 *
 *   1. Render is rAF-debounced and compares HTML against the last write.
 *   2. A focused text field suspends the view rewrite until it is blurred.
 *      The status bar is never suspended.
 *   3. The countdown ticks at 1 Hz by writing two nodes directly.
 * ========================================================================== */

const TABS = [
  { id: 'home', label: 'Home', icon: ICON.home, title: 'Guardian' },
  { id: 'camera', label: 'Camera', icon: ICON.camera, title: 'Camera' },
  { id: 'activity', label: 'Activity', icon: ICON.activity, title: 'Activity' },
  { id: 'more', label: 'More', icon: ICON.more, title: 'More' },
];

/* Chrome is not a viewport media query. Home Assistant docks its sidebar from
 * ~870 px (home-assistant-main[narrow]), with its own hamburger. Guardian used
 * to keep phone chrome (second hamburger + bottom tabs) until 1100 px, which
 * is the iPad band. Remaining panel width alone cannot tell collapsed-from-
 * expanded: a collapsed sidebar at the dock threshold leaves ~807 px, an
 * expanded one on a 1080 px iPad leaves ~824 px.
 *
 *   overlay / narrow     → tabs + Guardian hamburger (opens HA)
 *   always_hidden        → hamburger; rail if the panel is wide
 *   docked + collapsed   → rail, no Guardian hamburger
 *   docked + expanded    → rail if panel ≥ 900 px (desktop), else tabs
 */
const HA_NARROW_PX = 870;
const RAIL_MIN_PANEL_PX = 900;
const HA_DOCK_GAP_PX = 48;
const HA_EXPANDED_GAP_PX = 100;

function haMainEl() {
  const ha = document.querySelector('home-assistant');
  if (ha && ha.shadowRoot) {
    const inner = ha.shadowRoot.querySelector('home-assistant-main');
    if (inner) return inner;
  }
  return document.querySelector('home-assistant-main');
}

function haIsLiveShell(main) {
  const ha = document.querySelector('home-assistant');
  if (!ha || !main) return false;
  if (ha.shadowRoot && ha.shadowRoot.contains(main)) return true;
  return typeof ha.contains === 'function' && ha.contains(main);
}

function haPanelInset(panel) {
  if (!panel || !panel.getBoundingClientRect) return 0;
  const r = panel.getBoundingClientRect();
  return Math.max(Math.round(r.left), Math.round(window.innerWidth - r.right));
}

function haFlag(el, name) {
  if (!el) return false;
  if (el[name] === true) return true;
  if (el[name] === false) return false;
  return el.hasAttribute(name);
}

function haSidebarExpanded(main) {
  if (!main) return false;
  if (haFlag(main, 'expanded')) return true;
  if (main.expanded === false) return false;
  const bar = (main.shadowRoot && main.shadowRoot.querySelector('ha-sidebar'))
    || main.querySelector('ha-sidebar, .fake-sidebar');
  if (!bar || !bar.getBoundingClientRect) return false;
  return bar.getBoundingClientRect().width > HA_EXPANDED_GAP_PX;
}

function resolveChrome(hass, panelWidth, panel) {
  const w = Number.isFinite(panelWidth) ? panelWidth : 0;
  const main = haMainEl();
  const alwaysHidden = !!(hass && hass.dockedSidebar === 'always_hidden');
  const live = haIsLiveShell(main);
  const inset = live ? haPanelInset(panel) : 0;
  const insetDocked = inset >= HA_DOCK_GAP_PX;

  if (!main) {
    if (w < HA_NARROW_PX) return { nav: 'tabs', menu: true };
    if (w >= RAIL_MIN_PANEL_PX) return { nav: 'rail', menu: false };
    return { nav: 'tabs', menu: false };
  }

  const narrow = haFlag(main, 'narrow');
  /* A docked HA sidebar already has a hamburger. Guardian must not draw a
   * second one. home-assistant-main lives in HA's shadow root, and some iPad
   * shells still report narrow while the sidebar is on screen — the inset
   * of this panel is the ground truth for "something is taking the left". */
  const docked = !alwaysHidden && (!narrow || insetDocked);

  if (!docked) {
    if (alwaysHidden) return { nav: w >= RAIL_MIN_PANEL_PX ? 'rail' : 'tabs', menu: true };
    return { nav: 'tabs', menu: true };
  }

  const expanded = haSidebarExpanded(main) || inset > HA_EXPANDED_GAP_PX;
  if (!expanded) return { nav: 'rail', menu: false };
  if (w >= RAIL_MIN_PANEL_PX) return { nav: 'rail', menu: false };
  return { nav: 'tabs', menu: false };
}

function initialRoute() {
  const tab = localStorage.getItem('guardian-ui.tab');
  if (tab && TABS.some((t) => t.id === tab)) return { tab, page: '' };
  const old = localStorage.getItem('guardian-ui.view');
  const mapped = { home: 'home', door: 'camera', activity: 'activity', access: 'more', lamp: 'more', system: 'more' };
  if (old && mapped[old]) return { tab: mapped[old], page: '' };
  return { tab: 'home', page: '' };
}

function navigateHa(path) {
  const url = path.startsWith('/') ? path : `/${path}`;
  history.pushState(null, '', url);
  window.dispatchEvent(new CustomEvent('location-changed', {
    bubbles: true, composed: true, detail: { replace: false },
  }));
}

function isFrigateClipItem(ch) {
  return !!(ch && ch.thumbnail && !ch.can_expand);
}

function frigateDirScore(ch) {
  const t = String((ch && ch.title) || '').toLowerCase();
  if (t.startsWith('clips')) return 0;
  if (t.startsWith('snapshots')) return 1;
  return 2;
}

function revokeThumbUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try { URL.revokeObjectURL(url); } catch (e) { /* already revoked */ }
  }
}

async function resolveFrigateThumb(hass, url) {
  if (!url) return '';
  if (!String(url).startsWith('/')) return url;
  if (!hass || typeof hass.fetchWithAuth !== 'function') return '';
  try {
    const res = await hass.fetchWithAuth(url);
    if (!res || !res.ok) return '';
    const blob = await res.blob();
    if (!blob || !blob.size) return '';
    return URL.createObjectURL(blob);
  } catch (e) {
    return '';
  }
}

class GuardianPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._cfg = { ...DEFAULTS };
    this._built = false;
    this._pending = false;
    this._lastStatus = '';
    this._lastView = '';
    this._lastCam = '';
    this._lastNav = '';
    this._enterSeq = 0;
    this._lastEnterSeq = 0;
    this._unsubs = [];
    const route = initialRoute();
    this._ui = {
      tab: route.tab,
      page: route.page,
      filter: 'all',
      activityDayOffset: 0,
      activityExpanded: false,
      cameraLive: true,
      camSource: 'ambient',
      camNonce: Date.now(),
      timeline: [],
      historyState: 'idle',
      historyError: '',
      historyKey: '',
      liveOk: false,
      sheet: null,
      lampTone: '',
      /* Which tuner drawing is live to drag. Empty is locked, the default; only
       * one kind at a time so three stacked portal tuners cannot all steal scroll. */
      tuneUnlocked: '',
      /* More -> Lamp's what-if. Panel memory only: no entity, no service, and
       * cleared whenever the page changes so a hypothesis can never be left
       * lying around looking like the current state. */
      lampWhatIf: false,
      probeLuma: null,
      probeSun: null,
      probeUnusable: false,
      savedFlash: '',
      /* Slot id whose last Alerts go to pick did not stick, so the card can say
       * so instead of showing a phone the backend never accepted. */
      notifyLinkError: '',
      /* Same idea for the Home Assistant account picker: a fire-and-forget
       * write left the select showing a person the helper never stored. */
      slotUserError: '',
      slotUserWant: '',
      slotUserLive: '',
      haUsers: [],
      haUserNotify: {},
      /* Whose notification preferences the personAlerts page is showing. Set
       * by the nav action that opens it. */
      alertsSlot: '',
      /* Slot + level the household just tapped, so the segmented control can
       * move before Home Assistant echoes the helper. Cleared when the write
       * confirms or fails. */
      pendingLevel: null,
      liveTextId: '',
      liveTextState: '',
      frigateClips: null,
      frigateMediaState: 'idle',
      exitPin: '',
      exitPinBusy: false,
      exitPinError: '',
    };
  }

  set panel(p) {
    if (p && p.config) this._cfg = { ...DEFAULTS, ...p.config };
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._subscribeLive();
      this._maybeLoadHistory();
    }
    this._maybeRefreshNotifyOptions();
    this._maybeRefreshLampOptions();
    this._maybeRefreshHaRoster();
    this._schedule();
  }
  get hass() { return this._hass; }

  _maybeRefreshNotifyOptions(force = false) {
    const hass = this._hass;
    if (!hass || (!force && !notifyOptionsStale(hass))) return;
    const now = Date.now();
    if (!force && this._notifyOptsAt && now - this._notifyOptsAt < 15000) return;
    this._notifyOptsAt = now;
    ACTIONS.script(hass, 'guardian_refresh_notify_target_options').catch(() => {});
  }

  /* Waits for an entity to actually read back the value we just wrote. Used by
   * the Alerts go to picker, the Home Assistant account picker, and the
   * notification-level tabs: all three can look accepted in the browser while
   * the helper is still empty. Reads hass.states[entityId] exactly — the same
   * id guardian_slot_write writes — so a suffix-matched UI helper cannot
   * report success or failure for the wrong entity. */
  _awaitState(entityId, want, ms = 5000) {
    const started = Date.now();
    const same = (got) => linkedHaUserId(got) === linkedHaUserId(want)
      || String(got) === String(want);
    return new Promise((done) => {
      const tick = () => {
        const s = this._hass && this._hass.states && this._hass.states[entityId];
        const got = s ? s.state : '';
        if (same(got)) { done(true); return; }
        if (Date.now() - started >= ms) { done(false); return; }
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  _maybeRefreshLampOptions() {
    const hass = this._hass;
    if (!hass || !lampOptionsStale(hass)) return;
    const now = Date.now();
    if (this._lampOptsAt && now - this._lampOptsAt < 15000) return;
    this._lampOptsAt = now;
    ACTIONS.script(hass, 'guardian_refresh_lamp_options').catch(() => {});
  }

  _maybeRefreshHaRoster() {
    const hass = this._hass;
    if (!hass || typeof hass.callWS !== 'function') return;
    if (!haUser(hass).isAdmin) return;
    const now = Date.now();
    if (this._rosterAt && now - this._rosterAt < 60000) return;
    this._rosterAt = now;
    hass.callWS({ type: 'config/auth/list' }).then(async (list) => {
      const people = (Array.isArray(list) ? list : []).filter((x) => x && x.id
        && x.is_active !== false && !x.system_generated);
      const me = haUser(hass);
      const admins = people.filter((x) => x.is_owner
        || (x.group_ids || []).includes('system-admin')
        || (me.isAdmin && x.id === me.id));
      const adminList = admins.map((x) => String(x.id));
      if (me.isAdmin && me.id && !adminList.includes(me.id)) adminList.push(me.id);
      const adminIds = (adminList.length ? adminList : people.map((x) => String(x.id))).join(',');
      const userIds = people.map((x) => String(x.id)).join(',');
      this._ui.haUsers = people.map((x) => ({
        id: String(x.id),
        name: String(x.name || x.id),
      }));
      try {
        await ACTIONS.refreshHaRoster(hass, adminIds, userIds);
      } catch (err) { /* roster write is best effort */ }
      const phones = {};
      try {
        const entries = await hass.callWS({ type: 'config_entries/get', domain: 'mobile_app' });
        (Array.isArray(entries) ? entries : []).forEach((ent) => {
          const uid = String((ent && ent.data && ent.data.user_id) || '');
          const title = String((ent && (ent.title || (ent.data && ent.data.device_name))) || '');
          if (!uid || !title) return;
          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          if (slug) phones[uid] = `mobile_app_${slug}`;
        });
      } catch (err) { /* Companion lookup is a hint, not a requirement */ }
      this._ui.haUserNotify = phones;
      this._schedule(true);
    }).catch(() => { /* older HA, or this login cannot list users */ });
  }

  connectedCallback() {
    this.style.display = 'block';
    this.style.height = '100%';
    this.style.minHeight = '0';
    this.style.overflow = 'hidden';
    const parent = this.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.style.height = '100%';
      parent.style.minHeight = '0';
      parent.style.overflow = 'hidden';
    }
    this._tick = setInterval(() => this._tickCountdown(), 1000);
    this._mq = window.matchMedia('(prefers-color-scheme: dark)');
    this._mqL = () => this._schedule(true);
    if (this._mq.addEventListener) this._mq.addEventListener('change', this._mqL);
    this._onResize = () => this._schedule(true);
    window.addEventListener('resize', this._onResize);
    this._onVis = () => {
      if (document.visibilityState === 'hidden') this._flushLiveText();
    };
    this._onPageHide = () => { this._flushLiveText(); };
    /* Losing the window mid-hold cancels it. pointerup and pointercancel cover
     * a finger lifting and the OS taking over a gesture, but neither is
     * guaranteed when focus is stolen outright — an incoming call, Alt-Tab, a
     * notification taking the pointer. Without this the timer survives the
     * user's attention leaving and fires into a window they are no longer
     * looking at. */
    this._onBlur = () => this._onHoldEnd();
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('blur', this._onBlur);
    this._watchChrome();
    this._schedule();
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    clearTimeout(this._liveTimer);
    clearTimeout(this._lightTimer);
    clearTimeout(this._enterTimer);
    clearTimeout(this._liveHintTimer);
    // _holdTimer was NOT in this list, and it is the one that fires a service
    // call. A press-and-hold arms an 1100 ms timer whose callback runs
    // this._act(...) against this._hass — which is not nulled here — so a panel
    // torn down mid-hold (sidebar navigation, a frontend reconnect, an
    // hass-more-info route change) still issued the action after the user had
    // navigated away. The reachable set includes
    // script.guardian_reset {restart_devices: true}, which reboots both ESP
    // devices, and guardian_clear_rfid_slot, which deletes a key.
    // _onHoldEnd() clears the timer and the element together.
    this._onHoldEnd();
    clearTimeout(this._numTimer);
    clearTimeout(this._savedTimer);
    if (this._mq && this._mq.removeEventListener) this._mq.removeEventListener('change', this._mqL);
    window.removeEventListener('resize', this._onResize);
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    if (this._onPageHide) window.removeEventListener('pagehide', this._onPageHide);
    if (this._onBlur) window.removeEventListener('blur', this._onBlur);
    this._unwatchChrome();
    this._unsubs.forEach((u) => { try { u(); } catch (e) { /* already gone */ } });
    this._unsubs = [];
    this._revokeFrigateThumbs();
  }

  _chromeNow() {
    return resolveChrome(this._hass, this.clientWidth, this);
  }

  _applyChrome(shell) {
    if (!shell) return;
    const chrome = this._chromeNow();
    const menu = chrome.menu ? '1' : '0';
    if (shell.dataset.nav !== chrome.nav) shell.dataset.nav = chrome.nav;
    if (shell.dataset.menu !== menu) shell.dataset.menu = menu;
  }

  _watchChrome() {
    if (this._ro) return;
    this._onChrome = () => {
      if (!this._built || !this.shadowRoot) {
        this._schedule(true);
        return;
      }
      const shell = this.shadowRoot.querySelector('[data-shell]');
      if (!shell) {
        this._schedule(true);
        return;
      }
      const next = this._chromeNow();
      if (shell.dataset.nav === next.nav && shell.dataset.menu === (next.menu ? '1' : '0')) return;
      this._schedule(true);
    };
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(this._onChrome);
      this._ro.observe(this);
    }
    const attachMo = () => {
      const main = haMainEl();
      if (!main) return false;
      if (this._moTarget === main) return true;
      if (this._mo) this._mo.disconnect();
      this._moTarget = main;
      this._mo = new MutationObserver(this._onChrome);
      this._mo.observe(main, { attributes: true, attributeFilter: ['narrow', 'expanded'] });
      return true;
    };
    if (!attachMo()) {
      this._moWait = setInterval(() => {
        if (attachMo()) {
          clearInterval(this._moWait);
          this._moWait = null;
          this._onChrome();
        }
      }, 250);
    }
  }

  _unwatchChrome() {
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this._mo) {
      this._mo.disconnect();
      this._mo = null;
    }
    this._moTarget = null;
    if (this._moWait) {
      clearInterval(this._moWait);
      this._moWait = null;
    }
    this._onChrome = null;
  }

  _subscribeLive() {
    const conn = this._hass && this._hass.connection;
    if (!conn || !conn.subscribeEvents) return;
    LIVE_EVENTS.forEach(([type, build]) => {
      try {
        const p = conn.subscribeEvents((ev) => {
          const r = build(ev && ev.data);
          if (!r) return;
          this._ui.timeline.push({ ...r, ts: Date.now(), live: true });
          if (this._ui.timeline.length > 400) this._ui.timeline.splice(0, this._ui.timeline.length - 400);
          if (type === 'guardian.card_enrolled') this._onCardEnrolled(ev && ev.data);
          if (this._ui.tab === 'activity' || type === 'guardian.card_enrolled') this._schedule(true);
        }, type);
        Promise.resolve(p).then((unsub) => {
          this._unsubs.push(unsub);
          if (!this._ui.liveOk) { this._ui.liveOk = true; this._schedule(true); }
        }).catch(() => { /* one dead event type must not kill the rest */ });
      } catch (e) { /* subscription unsupported */ }
    });
  }

  async _maybeLoadHistory() {
    const hass = this._hass;
    if (!hass || this._ui.tab !== 'activity') return;
    const key = `${ACTIVITY_MAX_DAYS}|${slotIds(hass).join(',')}`;
    const fresh = Date.now() - (this._ui.historyAt || 0) < 120000;
    if (this._ui.historyKey === key && this._ui.historyState !== 'idle'
        && (fresh || this._ui.historyState === 'loading')) return;
    this._ui.historyKey = key;
    this._ui.historyAt = Date.now();
    this._ui.historyState = 'loading';
    this._schedule(true);

    const end = new Date();
    const start = startOfLocalDay(end.getTime(), ACTIVITY_MAX_DAYS - 1);
    try {
      const m = buildModel(hass, this._cfg);
      const raw = await hass.callWS({
        type: 'history/history_during_period',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: historyEntities(hass, m),
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      const rows = interpretHistory(hass, normaliseHistory(raw), m);
      const live = this._ui.timeline.filter((r) => r.live);
      this._ui.timeline = rows.concat(live);
      this._ui.historyState = 'ready';
      this._ui.historyError = '';
    } catch (err) {
      this._ui.historyState = 'error';
      this._ui.historyError = (err && (err.message || err.error || err.code)) || String(err);
    }
    this._schedule(true);
  }

  _revokeFrigateThumbs() {
    (this._ui.frigateClips || []).forEach((c) => revokeThumbUrl(c && c.thumbnail));
  }

  async _maybeLoadFrigateMedia() {
    const hass = this._hass;
    if (!hass || this._ui.tab !== 'camera') return;
    if (this._ui.frigateMediaState === 'loading') return;
    const fresh = Date.now() - (this._ui.frigateMediaAt || 0) < 120000;
    if (this._ui.frigateMediaState === 'ready' && fresh) return;
    if (this._ui.frigateMediaState === 'none' && fresh) return;
    this._ui.frigateMediaState = 'loading';
    this._ui.frigateMediaAt = Date.now();
    const browse = (id) => hass.callWS({ type: 'media_source/browse_media', media_content_id: id });
    let resolved = [];
    try {
      const root = await browse('media-source://frigate');
      const kids = (root && root.children) || [];
      let raw = kids.filter(isFrigateClipItem);
      if (!raw.length) {
        const dirs = kids
          .filter((ch) => ch && (ch.can_expand || ch.media_class === 'directory'))
          .slice()
          .sort((a, b) => frigateDirScore(a) - frigateDirScore(b));
        for (const ch of dirs.slice(0, 4)) {
          try {
            raw = ((await browse(ch.media_content_id)).children || []).filter(isFrigateClipItem);
            if (raw.length) break;
          } catch (e) { /* ignore */ }
        }
      }
      raw = raw.slice(0, 8);
      resolved = await Promise.all(raw.map(async (ch) => ({
        title: ch.title || 'Clip',
        thumbnail: await resolveFrigateThumb(hass, ch.thumbnail || ''),
      })));
      this._revokeFrigateThumbs();
      this._ui.frigateClips = resolved;
      this._ui.frigateMediaState = resolved.length ? 'ready' : 'none';
    } catch (err) {
      resolved.forEach((c) => revokeThumbUrl(c && c.thumbnail));
      this._revokeFrigateThumbs();
      this._ui.frigateClips = null;
      this._ui.frigateMediaState = 'none';
    }
    this._schedule(true);
  }

  _watchCameraStream() {
    if (this._camStreamWatch || typeof customElements === 'undefined') return;
    this._camStreamWatch = true;
    if (customElements.get('ha-camera-stream')) return;
    customElements.whenDefined('ha-camera-stream').then(() => this._schedule(true));
  }

  _schedule(force = false) {
    if (force) this._lastView = '<force>';
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => { this._pending = false; this._render(); });
  }

  _scheme() {
    const h = this._hass;
    if (h && h.themes && typeof h.themes.darkMode === 'boolean') return h.themes.darkMode ? 'dark' : 'light';
    return this._mq && this._mq.matches ? 'dark' : 'light';
  }

  _build() {
    this.shadowRoot.innerHTML = `<style>${STYLES}</style>
      <div class="shell" data-shell data-nav="tabs" data-menu="1">
        <aside class="rail">
          <div class="brand">
            <ha-icon icon="mdi:shield-home" style="--mdc-icon-size:24px"></ha-icon>
            <div><b>Guardian</b><small>This house</small></div>
          </div>
          <nav data-nav="rail"></nav>
        </aside>
        <div class="main">
          <div class="topbar">
            <button class="iconbtn" data-act="toggleMenu" aria-label="Menu"><ha-icon icon="${ICON.menu}"></ha-icon></button>
            <button class="iconbtn" data-back hidden aria-label="Back"><ha-icon icon="${ICON.back}"></ha-icon></button>
            <div class="title" data-title>Guardian</div>
          </div>
          <div data-status></div>
          <div class="workspace">
            <div class="scroll" data-scroll>
              <div class="wrap">
                <div data-cam></div>
                <div data-view></div>
              </div>
            </div>
          </div>
          <nav class="tabs" data-nav="tabs"></nav>
        </div>
      </div>
      <div data-overlay></div>`;

    const sr = this.shadowRoot;
    sr.addEventListener('click', (e) => this._onClick(e));
    sr.addEventListener('change', (e) => this._onChange(e));
    sr.addEventListener('input', (e) => this._onInput(e));
    sr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.dataset && e.target.dataset.field) {
        e.target.blur();
        this._act('saveField', JSON.parse(e.target.dataset.arg || '{}'));
      }
      if (e.key === 'Escape') {
        if (this._ui.sheet) this._act('closeSheet', {});
        else if (this._ui.page) this._act('back', {});
      }
      this._onTuneKey(e);
    });
    sr.addEventListener('focusout', (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.live === '1') {
        this._flushLiveText().finally(() => this._schedule());
        return;
      }
      this._schedule();
    });
    sr.addEventListener('pointerdown', (e) => {
      this._onHoldStart(e);
      this._onWheelStart(e);
      this._onTuneStart(e);
    }, { passive: false });
    sr.addEventListener('pointermove', (e) => {
      this._onHoldMove(e);
      this._onWheelMove(e);
      this._onTuneMove(e);
    }, { passive: false });
    sr.addEventListener('pointerup', (e) => {
      this._onHoldEnd();
      this._onWheelEnd(e);
      this._onTuneEnd();
    }, true);
    sr.addEventListener('pointercancel', () => {
      this._onHoldEnd();
      this._onWheelEnd();
      this._onTuneEnd();
    }, true);
    sr.addEventListener('pointerleave', (e) => {
      if (!this._holdEl) return;
      if (e.target === this._holdEl && !this._holdEl.contains(e.relatedTarget)) this._onHoldEnd();
    }, true);
    sr.addEventListener('contextmenu', (e) => {
      if (e.composedPath().some((n) => n.dataset && n.dataset.hold)) e.preventDefault();
    });
    sr.addEventListener('selectstart', (e) => {
      if (e.composedPath().some((n) => n.dataset && n.dataset.hold)) e.preventDefault();
    });
    sr.querySelector('[data-back]').addEventListener('click', () => this._act('back', {}));
    /* Hamburger is data-act="toggleMenu" on the button, handled by _onClick.
     * Do not bind click to [data-menu]: that attribute is chrome state on
     * .shell (0|1), so querySelector('[data-menu]') matches the whole panel
     * and toggles Home Assistant's sidebar on every tap. */
    this._built = true;
  }

  _pageTitle() {
    if (this._ui.page && PAGE_META[this._ui.page]) return PAGE_META[this._ui.page].title;
    const tab = TABS.find((t) => t.id === this._ui.tab);
    return tab ? tab.title : 'Guardian';
  }

  _render() {
    const hass = this._hass;
    if (!hass) return;
    if (!this._built) this._build();

    const scheme = this._scheme();
    if (this.getAttribute('data-scheme') !== scheme) this.setAttribute('data-scheme', scheme);
    setTimeFormat(hass);
    let m;
    try {
      m = buildModel(hass, this._cfg);
    } catch (err) {
      this._applyChrome(this.shadowRoot.querySelector('[data-shell]'));
      this.shadowRoot.querySelector('[data-view]').innerHTML =
        note(`The panel could not read Guardian's state: ${esc(err && err.message)}. The system itself is unaffected.`,
          'alarm', 'mdi:alert-outline');
      return;
    }
    this._model = m;

    const sr = this.shadowRoot;
    const shell = sr.querySelector('[data-shell]');
    shell.dataset.tab = this._ui.tab;
    shell.dataset.page = this._ui.page || '';
    this._applyChrome(shell);
    if (!this._ui.lampTone) {
      this._ui.lampTone = (m.lamp.colorMode === 'color_temp' || m.lamp.colorMode === 'white') ? 'white' : 'color';
    }

    const navKey = `${this._ui.tab}|${this._ui.page}|${m.needsAttention}`;
    if (navKey !== this._lastNav) {
      this._lastNav = navKey;
      const railHtml = TABS.map((t) => `<button data-act="nav" data-arg='{"tab":"${t.id}","page":""}'
        ${t.id === this._ui.tab ? 'aria-current="page"' : ''}>
        <ha-icon icon="${t.icon}"></ha-icon>${esc(t.label)}</button>`).join('');
      const tabsHtml = TABS.map((t) => `<button data-act="nav" data-arg='{"tab":"${t.id}","page":""}'
        ${t.id === this._ui.tab ? 'aria-current="page"' : ''}>
        <ha-icon icon="${t.icon}"></ha-icon>${esc(t.label)}
        ${t.id === 'home' && m.needsAttention ? '<i class="dot"></i>' : ''}</button>`).join('');
      sr.querySelector('nav[data-nav="rail"]').innerHTML = railHtml;
      sr.querySelector('nav[data-nav="tabs"]').innerHTML = tabsHtml;
      sr.querySelector('[data-title]').textContent = this._pageTitle();
      sr.querySelector('[data-back]').hidden = !this._ui.page;
    }

    const focused = sr.activeElement;
    /* A focused tuner suspends the rewrite for the same reason a focused range
     * input does: arrow keys adjust it, and replacing the view under someone
     * mid-adjustment would throw their focus away on every keypress. focusout
     * schedules a render, so it catches up the moment they leave. */
    const typing = focused && ((focused.tagName === 'INPUT' && (focused.type === 'text' || focused.type === 'range'))
      || !!(focused.dataset && (focused.dataset.tune || focused.dataset.tunearg)));
    /* A live press-and-hold suspends the rewrite too, and for a stronger reason
     * than the two above. _render replaces [data-view]'s whole innerHTML, so a
     * state change arriving mid-hold destroyed the button node under the
     * finger. The timer kept running against the now-detached element and still
     * fired this._act(el.dataset.hold, ...) — the dataset survives on an
     * orphaned node — so the action went through. Visually the progress fill
     * vanished with it, which reads exactly like a cancelled hold: the user
     * let go believing nothing happened, and 1.1 s later both devices rebooted.
     * Holding the view still for at most 1100 ms is the cheaper half of that
     * trade. */
    const dragging = !!this._wheelEl || !!this._tuneEl || !!this._holdEl;

    if (m.security.key !== 'doorbellexit') {
      this._ui.exitPin = '';
      this._ui.exitPinBusy = false;
      this._ui.exitPinError = '';
    }

    const statusHtml = statusBar(m, this._ui, hass);
    if (statusHtml !== this._lastStatus) {
      this._lastStatus = statusHtml;
      sr.querySelector('[data-status]').innerHTML = statusHtml;
    }

    if (!typing && !dragging) {
      const showCam = this._ui.tab === 'camera';
      const camHtml = showCam ? camStage(m, hass, this._ui) : '';
      const camHost = sr.querySelector('[data-cam]');
      if (showCam) this._watchCameraStream();
      if (camHtml !== this._lastCam) {
        const oldCam = camHost.querySelector('[data-keep="cam"]');
        this._lastCam = camHtml;
        camHost.innerHTML = camHtml;
        const newCam = camHost.querySelector('[data-keep="cam"]');
        if (sameCamNode(oldCam, newCam)) newCam.replaceWith(oldCam);
      }
      bindCamPlayer(camHost, hass);

      let viewHtml = '';
      try {
        viewHtml = this._viewHtml(m, hass);
      } catch (err) {
        viewHtml = note(`This view failed to render: ${esc(err && err.message)}.`, 'alarm', 'mdi:alert-outline');
      }
      const host = sr.querySelector('[data-view]');
      const scroller = sr.querySelector('[data-scroll]');
      if (viewHtml !== this._lastView) {
        this._lastView = viewHtml;
        const top = scroller.scrollTop;
        host.innerHTML = viewHtml;
        scroller.scrollTop = top;
      }
      /* Entrance runs on navigation and nowhere else. _enterSeq is bumped by
       * nav / back only, so a state change - an alarm, a card scan, a lamp
       * verdict - never restages the page under whoever is reading it. */
      if (this._enterSeq !== this._lastEnterSeq) {
        this._lastEnterSeq = this._enterSeq;
        scroller.scrollTop = 0;
        host.classList.remove('entering');
        void host.offsetWidth;
        host.classList.add('entering');
        camHost.classList.remove('entering-cam');
        if (showCam) { void camHost.offsetWidth; camHost.classList.add('entering-cam'); }
        clearTimeout(this._enterTimer);
        this._enterTimer = setTimeout(() => {
          host.classList.remove('entering');
          camHost.classList.remove('entering-cam');
        }, 720);
      }
    }

    this._renderOverlay();
    this._tickCountdown();
  }

  _viewHtml(m, hass) {
    const tab = this._ui.tab;
    const page = this._ui.page;
    const house = isHouseAdmin(hass);
    if (!house && (page === 'install' || page === 'diagnostics' || page === 'reset'
        || page === 'internals' || page === 'security')) {
      return viewMoreIndex(m, hass);
    }
    if (tab === 'home') return viewHome(m, hass, this._ui);
    if (tab === 'camera') return page === 'doorSensors' ? viewDoorSensors(m, hass) : viewCameraBody(m, hass, this._ui);
    if (tab === 'activity') return viewActivity(m, hass, this._ui);
    if (tab === 'more') {
      if (!page) return viewMoreIndex(m, hass);
      if (page === 'keys') return viewKeys(m, hass, this._ui);
      if (page === 'personAlerts') return viewPersonAlerts(m, hass, this._ui);
      if (page === 'lamp') return viewLamp(m, hass, this._ui);
      if (page === 'security') return viewSecurity(m, hass, this._ui);
      if (page === 'devices') return viewDevices(m, hass);
      if (page === 'portal') return viewPortal(m, hass, this._ui);
      if (page === 'doorbell') return viewDoorbell(m, hass);
      if (page === 'notifications') return viewNotifications(hass, m);
      if (page === 'install') return viewInstall(m, hass, this._cfg, this._ui);
      if (page === 'diagnostics') return viewDiagnostics(m, hass);
      if (page === 'internals') return viewInternals(hass);
      if (page === 'reset') return viewReset();
      return viewMoreIndex(m, hass);
    }
    return viewHome(m, hass, this._ui);
  }

  _tickCountdown() {
    const sr = this.shadowRoot;
    if (!sr || !this._model) return;
    const el = sr.querySelector('[data-ring]');
    if (!el) return;
    const cd = buildCountdown(this._hass);
    if (!cd.active) { this._schedule(true); return; }
    const val = el.querySelector('[data-ring-val]');
    const prog = el.querySelector('[data-ring-prog]');
    if (val) val.textContent = clock(cd.remaining);
    if (prog) {
      const C = 2 * Math.PI * 42;
      prog.setAttribute('stroke-dashoffset', (C * (1 - cd.pct)).toFixed(2));
    }
  }

  /* A sheet is informational by default — one Close button. Give it a
   * `confirm: { label, act, arg, toneName }` and it becomes an "are you sure?"
   * instead: the named action plus Cancel, and nothing happens until the
   * confirm button is pressed. Informational sheets render exactly as before. */
  _renderOverlay() {
    const host = this.shadowRoot.querySelector('[data-overlay]');
    const s = this._ui.sheet;
    if (!s) { if (host.innerHTML) host.innerHTML = ''; return; }
    const tone = s.tone || 'warn';
    const c = s.confirm;
    /* tone, not solid: .btn.solid paints itself --g-accent and ignores --tone,
     * so a solid confirm would render a delete button in the friendly green. */
    const actions = c
      ? `${btn(c.label || 'Confirm', c.act, c.arg || {},
        { wide: true, tone: true, toneName: c.toneName || tone })}
         ${btn('Cancel', 'closeSheet', {}, { wide: true })}`
      : btn('Close', 'closeSheet', {}, { wide: true, tone: true, toneName: tone });
    host.innerHTML = `
      <div class="scrim" data-act="closeSheet" data-arg="{}"></div>
      <div class="sheet" style="--tone:var(--g-${tone})" role="dialog" aria-modal="true">
        <div class="grab"></div>
        <h3>${esc(s.title)}</h3>
        <p>${esc(s.body)}</p>
        ${actions}
      </div>`;
  }

  _onClick(e) {
    if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION')) return;
    const path = e.composedPath();
    const el = path.find((n) => n.dataset && n.dataset.act);
    if (!el) return;
    e.preventDefault();
    let a = {};
    try { a = JSON.parse(el.dataset.arg || '{}'); } catch (err) { a = {}; }
    this._act(el.dataset.act, a);
  }

  _onInput(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    if (el.dataset.slider === 'lampProbe') {
      let a = {};
      try { a = JSON.parse(el.dataset.arg || '{}'); } catch (err) { a = {}; }
      this._act('lampProbe', { ...a, value: parseFloat(el.value) });
      return;
    }
    if (el.dataset.slider) {
      const box = el.closest('.numctl');
      const n = box && box.querySelector('.n');
      if (n && el.dataset.arg && el.dataset.arg.includes('"kelvin"')) n.textContent = `${Math.round(el.value)}K`;
      else if (n) n.textContent = el.value;
      if (el.dataset.slider === 'setLight') {
        let a = {};
        try { a = JSON.parse(el.dataset.arg || '{}'); } catch (err) { a = {}; }
        const payload = { id: a.id };
        if (a.field === 'brightness') payload.brightness = parseFloat(el.value);
        if (a.field === 'kelvin') payload.kelvin = parseFloat(el.value);
        this._queueLight(payload);
      }
      return;
    }
    if (el.dataset.field) {
      const dirty = el.value !== (el.dataset.committed || '');
      el.dataset.dirty = dirty ? '1' : '0';
      const btn = el.closest('.savefield') && el.closest('.savefield').querySelector('[data-act="saveField"]');
      if (btn) {
        btn.disabled = !dirty;
        if (this._ui.savedFlash !== (JSON.parse(el.dataset.arg || '{}').id || '')) btn.textContent = 'Save';
      }
      if (el.dataset.live === '1') {
        let a = {};
        try { a = JSON.parse(el.dataset.arg || '{}'); } catch (err) { a = {}; }
        if (dirty) {
          if (a.id) {
            this._ui.liveTextId = a.id;
            this._ui.liveTextState = '';
            this._queueLiveText(a.id, el.value, el);
          }
        } else if (a.id) {
          this._setLiveHint(a.id, 'saved');
        }
      }
    }
  }

  _onChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    let a = {};
    try { a = JSON.parse(el.dataset.arg || '{}'); } catch (err) { a = {}; }
    if (el.dataset.slider === 'setLight') {
      const payload = { id: a.id };
      if (a.field === 'brightness') payload.brightness = parseFloat(el.value);
      if (a.field === 'kelvin') payload.kelvin = parseFloat(el.value);
      this._queueLight(payload);
      return;
    }
    if (el.dataset.slider) this._act(el.dataset.slider, { ...a, value: parseFloat(el.value) });
    else if (el.dataset.live === '1') {
      if (a.id) {
        this._livePending = { id: a.id, value: el.value, el };
        this._flushLiveText();
      }
    } else if (el.dataset.field) this._act(el.dataset.field, { ...a, value: el.value });
  }

  _onHoldStart(e) {
    if (e.button !== 0) return;
    const el = e.composedPath().find((n) => n.dataset && n.dataset.hold);
    if (!el) return;
    e.preventDefault();
    this._onHoldEnd();
    this._holdX = e.clientX;
    this._holdY = e.clientY;
    el.dataset.holding = '1';
    this._holdEl = el;
    if (el.setPointerCapture) {
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    this._holdTimer = setTimeout(() => {
      el.dataset.holding = '0';
      this._holdEl = null;
      if (navigator.vibrate) { try { navigator.vibrate(28); } catch (err) { /* no haptics */ } }
      let a = {};
      try { a = JSON.parse(el.dataset.arg || '{}'); } catch (err) { a = {}; }
      this._act(el.dataset.hold, a);
    }, DEFAULTS.holdMs);
  }

  _onHoldMove(e) {
    if (!this._holdEl) return;
    const dx = e.clientX - this._holdX;
    const dy = e.clientY - this._holdY;
    if ((dx * dx) + (dy * dy) > 100) this._onHoldEnd();
  }

  _onHoldEnd() {
    clearTimeout(this._holdTimer);
    if (this._holdEl) { this._holdEl.dataset.holding = '0'; this._holdEl = null; }
  }

  _onWheelStart(e) {
    const el = e.composedPath().find((n) => n.classList && n.classList.contains('wheel'));
    if (!el) return;
    e.preventDefault();
    this._wheelEl = el;
    if (el.setPointerCapture) {
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    this._applyWheel(el, e.clientX, e.clientY);
  }

  _onWheelMove(e) {
    if (!this._wheelEl) return;
    this._applyWheel(this._wheelEl, e.clientX, e.clientY);
  }

  _onWheelEnd() {
    this._wheelEl = null;
  }

  _applyWheel(el, clientX, clientY) {
    const L = this._model && this._model.lamp;
    if (!L || L.missing) return;
    const r = el.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const max = Math.max(1, r.width / 2);
    const sat = Math.max(8, Math.min(100, (dist / (max * 0.92)) * 100));
    let hue = Math.atan2(dy, dx) * 180 / Math.PI;
    if (hue < 0) hue += 360;
    const knob = el.querySelector('.knob');
    if (knob) knob.setAttribute('style', wheelKnobStyle([hue, sat]));
    this._queueLight({ id: L.entity, hs: [Math.round(hue), Math.round(sat)] });
  }

  /* --- Tuner drawings ------------------------------------------------------
   * Locked by default so a phone can scroll the page over them. Unlocking one
   * (only one at a time) arms on pointerdown — touch behaves like mouse
   * click-to-set. Same write path as the colour wheel: mutate the drawn nodes
   * in place, debounce through _queueNumber, flush on release. The view rewrite
   * is suspended for the duration by the _tuneEl arm of the `dragging` guard
   * in _render, which is why the optimistic paint below is not fighting a
   * re-render every frame. */

  _onTuneStart(e) {
    const path = e.composedPath();
    if (path.some((n) => n.classList && (n.classList.contains('tunesay')
      || n.classList.contains('tune-lock')))) return;
    const el = path.find((n) => n.dataset && n.dataset.tune);
    if (!el || el.dataset.unlocked !== '1') return;
    const svg = el.querySelector('svg');
    if (!svg || !path.includes(svg)) return;
    const pick = this._tunePick(el, e.clientX, e.clientY);
    this._tuneEl = el;
    this._tuneOwner = pick.owner;
    this._tuneArmed = false;
    this._armTune(e);
  }

  /* Which handle this gesture is for. A single-value tuner has one knob and
   * the container owns the write. The lamp's light-level band has one per
   * threshold; the knob nearest the finger owns it, so a tap on the axis
   * click-to-sets the closer end. */
  _tunePick(el, clientX, clientY) {
    const thumbs = Array.from(el.querySelectorAll('[data-thumb]'));
    const owners = thumbs.length ? thumbs : [el];
    let owner = owners[0];
    let best = Infinity;
    owners.forEach((o) => {
      const knob = o.querySelector('[data-knob]');
      if (!knob || typeof knob.getBoundingClientRect !== 'function') return;
      const r = knob.getBoundingClientRect();
      const dx = Math.max(r.left - clientX, 0, clientX - r.right);
      const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
      const d = (dx * dx) + (dy * dy);
      if (d < best) { best = d; owner = o; }
    });
    return { owner };
  }

  _armTune(e) {
    const el = this._tuneEl;
    if (!el || this._tuneArmed) return;
    this._tuneArmed = true;
    el.classList.add('tune--dragging');
    if (el.setPointerCapture) {
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    e.preventDefault();
    /* Focus the handle being dragged, so the keyboard picks up where the finger
     * left off and the render's "someone is adjusting this" guard sees it. */
    const f = this._tuneOwner && this._tuneOwner.focus ? this._tuneOwner : el;
    if (f.focus) { try { f.focus({ preventScroll: true }); } catch (err) { f.focus(); } }
    this._applyTune(el, e.clientX, e.clientY);
  }

  _abortTune() {
    if (!this._tuneEl) return;
    this._tuneEl.classList.remove('tune--dragging');
    this._tuneEl = null;
    this._tuneOwner = null;
    this._tuneArmed = false;
  }

  _onTuneMove(e) {
    if (!this._tuneEl || !this._tuneArmed) return;
    e.preventDefault();
    this._applyTune(this._tuneEl, e.clientX, e.clientY);
  }

  /* Releasing an armed drag lands the last position. An unarmed cancel must
   * not write — though once unlocked, pointerdown arms immediately. */
  _onTuneEnd() {
    if (!this._tuneEl) return;
    const armed = this._tuneArmed;
    this._abortTune();
    if (!armed) return;
    this._flushNumber();
    this._schedule();
  }

  /* The focused node carries its own entity and bounds, so this is the same
   * function whether it is the container of a single-value tuner or one thumb
   * of the lamp's two-value band. Locked drawings ignore the keyboard; the
   * stepper underneath is the precise path then. */
  _onTuneKey(e) {
    const el = e.composedPath().find((n) => n.dataset && n.dataset.tunearg);
    if (!el) return;
    const host = (el.closest && el.closest('[data-tune]')) || el;
    if (!host || host.dataset.unlocked !== '1') return;
    let a;
    try { a = JSON.parse(el.dataset.tunearg || '{}'); } catch (err) { return; }
    const cur = parseFloat(el.getAttribute('aria-valuenow'));
    if (!Number.isFinite(cur) || !Number.isFinite(a.min)) return;
    const jump = (a.step || 1) * (e.shiftKey ? 10 : 1);
    let v = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = cur + jump;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = cur - jump;
    else if (e.key === 'Home') v = a.min;
    else if (e.key === 'End') v = a.max;
    if (v === null) return;
    e.preventDefault();
    this._setTune(el, v, a);
    this._flushNumber();
  }

  /* Client pixels to the drawing's own units, under the default
   * preserveAspectRatio="xMidYMid meet": one scale factor, and the drawing
   * centred in whatever box CSS gave it. Written for the letterboxed case so a
   * later change to .tune svg's sizing cannot silently skew the drag. */
  _tuneUnits(el, clientX, clientY) {
    const svg = el.querySelector('svg');
    if (!svg || !svg.viewBox || !svg.viewBox.baseVal) return null;
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (!r.width || !r.height || !vb.width || !vb.height) return null;
    const k = Math.min(r.width / vb.width, r.height / vb.height);
    if (!k) return null;
    const ox = r.left + (r.width - vb.width * k) / 2;
    const oy = r.top + (r.height - vb.height * k) / 2;
    return { x: vb.x + (clientX - ox) / k, y: vb.y + (clientY - oy) / k };
  }

  _applyTune(el, clientX, clientY) {
    const owner = this._tuneOwner && el.contains(this._tuneOwner) ? this._tuneOwner : el;
    let a;
    try { a = JSON.parse(owner.dataset.tunearg || '{}'); } catch (err) { return; }
    const u = this._tuneUnits(el, clientX, clientY);
    if (!u || !Number.isFinite(a.min) || !Number.isFinite(a.max)) return;
    const kind = el.dataset.tune;
    let raw;
    if (kind === 'tilt') {
      /* The rose is the pivot, and the angle off it is the entity's own unit. */
      const geo = doorGeo(false);
      raw = Math.atan2(u.y - geo.hy, u.x - geo.hx) * 180 / Math.PI;
    } else if (kind === 'swing') {
      let deg = Math.atan2(u.y - SWING_ARC.cy, u.x - SWING_ARC.cx) * 180 / Math.PI;
      if (deg < 0) deg += 360;
      const f = (deg - SWING_ARC.a0) / (SWING_ARC.a1 - SWING_ARC.a0);
      raw = a.min + Math.max(0, Math.min(1, f)) * (a.max - a.min);
    } else if (kind === 'luma') {
      const { x0, x1, max } = LUMA_AXIS;
      raw = ((u.x - x0) / (x1 - x0)) * max;
    } else if (isHoursTune(kind)) {
      const { x0, x1, max } = HOUR_AXIS;
      raw = ((u.x - x0) / (x1 - x0)) * max;
    } else if (kind === 'rotate') {
      /* Counter-clockwise degrees, the entity's own unit, from a grip that
       * starts at the upper right. SVG angles run the other way and y is down,
       * hence the negation; the wrap stops a drag past zero from clamping to
       * 270 instead of coming back round to 0. */
      let deg = -((Math.atan2(u.y - ROT.cy, u.x - ROT.cx) * 180 / Math.PI) + 45);
      deg = ((deg % 360) + 360) % 360;
      if (deg > 315) deg -= 360;
      raw = deg;
    } else if (kind === 'mmclock') {
      const { x0, x1 } = MM_AXIS;
      raw = ((u.x - x0) / (x1 - x0)) * a.max;
    } else {
      const { x0, x1 } = LOOKBACK_AXIS;
      raw = ((x1 - u.x) / (x1 - x0)) * a.max;
    }
    this._setTune(owner, raw, a);
  }

  /* owner is the node carrying the entity: the tuner itself when it has one
   * value, or the thumb when it has two. The drawing is always repainted from
   * the container, because moving one thumb changes bands outside it. */
  _setTune(owner, raw, a) {
    const el = (owner.closest && owner.closest('[data-tune]')) || owner;
    const step = a.step || 1;
    let v = a.min + Math.round((raw - a.min) / step) * step;
    v = Math.max(a.min, Math.min(a.max, +v.toFixed(4)));
    if (parseFloat(owner.getAttribute('aria-valuenow')) === v) return;
    owner.setAttribute('aria-valuenow', v);
    owner.setAttribute('aria-valuetext', tuneFmt(el.dataset.tune, v));
    this._paintTune(el, v, a);
    this._queueNumber(a.act, a.id, v);
  }

  /* The bare stepper that writes the same entity as this drawing. Matched by
   * entity id rather than by position, because the light-level band has two. */
  _stepperFor(el, id) {
    const host = el.parentElement || el;
    return Array.from(host.querySelectorAll('.numctl')).find((n) => {
      const b = n.querySelector('[data-arg]');
      if (!b) return false;
      try { return JSON.parse(b.dataset.arg || '{}').id === id; } catch (err) { return false; }
    }) || null;
  }

  /* Move the drawn parts to match the number. Every node touched here is one the
   * matching ill*Tune() marked, so the optimistic paint and the next full render
   * cannot disagree about what the picture means. */
  _paintTune(el, v, a) {
    const q = (s) => el.querySelector(s);
    const set = (node, name, value) => { if (node) node.setAttribute(name, value); };
    const kind = el.dataset.tune;
    if (kind === 'tilt') {
      const geo = doorGeo(false);
      const t = v * Math.PI / 180;
      set(q('[data-lever]'), 'transform', `rotate(${v} ${geo.hx} ${geo.hy})`);
      set(q('[data-band]'), 'd', arcPath(geo.hx, geo.hy, 19, 0, v));
      const knob = q('[data-knob]');
      set(knob, 'cx', d2(geo.hx + 19 * Math.cos(t)));
      set(knob, 'cy', d2(geo.hy + 19 * Math.sin(t)));
    } else if (kind === 'swing') {
      const { cx, cy, r, a0, a1 } = SWING_ARC;
      const av = swingAngle(v, a.min, a.max);
      const t = av * Math.PI / 180;
      set(q('[data-band]'), 'd', arcPath(cx, cy, r, a0, av));
      set(q('[data-band2]'), 'd', arcPath(cx, cy, r, av, a1));
      const knob = q('[data-knob]');
      set(knob, 'cx', d2(cx + r * Math.cos(t)));
      set(knob, 'cy', d2(cy + r * Math.sin(t)));
      const derived = q('[data-tuneval2]');
      if (derived) derived.textContent = swingSweep(v);
    } else if (kind === 'luma') {
      this._paintLuma(el);
    } else if (isHoursTune(kind)) {
      this._paintHours(el);
    } else if (kind === 'rotate') {
      this._paintRotate(el, v);
    } else if (kind === 'mmclock') {
      const { x0, x1 } = MM_AXIS;
      const kx = mmX(v, a.max);
      [q('[data-band]'), q('[data-band2]')].forEach((n) => set(n, 'width', d2(kx - x0)));
      set(q('[data-knob]'), 'x', d2(kx - 3));
      set(q('[data-mmcap]'), 'x', d2(Math.min(Math.max(kx, x0 + 46), x1 - 46)));
    } else {
      const { x0, x1, y } = LOOKBACK_AXIS;
      const bx = x1 - (v / (a.max || 1)) * (x1 - x0);
      [q('[data-band]'), q('[data-band2]')].forEach((n) => {
        set(n, 'x', d2(bx));
        set(n, 'width', d2(x1 - bx));
      });
      const lever = lookbackLever(bx);
      set(q('[data-lever]'), 'transform', `translate(${d2(lever.x)} ${y - 1})`);
      set(q('[data-lever]'), 'opacity', lever.opacity);
      set(q('[data-knob]'), 'x', d2(bx - LOOKBACK_KNOB.half));
    }
    const readout = q('[data-tuneval]');
    if (readout) readout.textContent = tuneFmt(kind, v);
    /* The stepper underneath is the same number by another route; keep it honest
     * while the finger is down. Its next/previous arguments are rebuilt by the
     * render that follows the release. */
    const ctl = this._stepperFor(el, a.id);
    if (ctl) {
      const n = ctl.querySelector('.n');
      if (n) n.textContent = tuneFmt(kind, v);
    }
  }

  /* The light-level band. One thumb moved, but the lamp-on region, the gap, the
   * three zone labels and both numbers all depend on the pair, so the band is
   * rebuilt from whatever the two thumbs currently say. Every node touched here
   * is one illLumaTune() marked. */
  _paintLuma(el) {
    const q = (sel) => el.querySelector(sel);
    const set = (node, name, value) => { if (node) node.setAttribute(name, value); };
    const dq = q('[data-thumb="dark"]');
    const bq = q('[data-thumb="bright"]');
    if (!dq || !bq) return;
    const dv = parseFloat(dq.getAttribute('aria-valuenow'));
    const bv = parseFloat(bq.getAttribute('aria-valuenow'));
    if (!Number.isFinite(dv) || !Number.isFinite(bv)) return;
    const { x0, x1 } = LUMA_AXIS;
    const dx = lumaX(dv);
    const bx = lumaX(bv);
    const inv = dv >= bv;
    const lo = Math.min(dx, bx);
    const hi = Math.max(dx, bx);

    /* Crossed over, the lamp-on region disappears and the hatch takes the whole
     * axis, because then nothing on the axis decides anything. The namespace
     * idns('luma', 'tune') gives is deterministic, which is what makes naming
     * the two patterns here safe. */
    set(q('[data-band]'), 'width', d2(inv ? 0 : Math.max(0, dx - x0)));
    set(q('[data-band2]'), 'x', d2(inv ? x0 : lo));
    set(q('[data-band2]'), 'width', d2(inv ? x1 - x0 : hi - lo));
    set(q('[data-band2]'), 'fill', inv ? 'url(#g-luma-tune-bad)' : 'url(#g-luma-tune-hold)');
    set(q('[data-band3]'), 'x', d2(lo));
    set(q('[data-band3]'), 'width', d2(hi - lo));
    set(q('[data-band3]'), 'opacity', inv ? '0' : '.22');

    const moveThumb = (g, x) => {
      set(g.querySelector('[data-knob]'), 'x', d2(x - 2.2));
      set(g.querySelector('.halo'), 'x', d2(x - 5.4));
    };
    moveThumb(dq, dx);
    moveThumb(bq, bx);

    const [lxd, lxb] = lumaLabelXs(dx, bx);
    const head = (name, x, text) => {
      const n = el.querySelector(`[data-lumaval="${name}"]`);
      if (!n) return;
      n.setAttribute('x', d2(x));
      if (text != null) n.textContent = text;
    };
    head('capdark', lxd, null);
    head('capbright', lxb, null);
    head('dark', lxd, String(Math.round(dv)));
    head('bright', lxb, String(Math.round(bv)));

    const zone = (name, xa, xb) => {
      const n = el.querySelector(`[data-zone="${name}"]`);
      if (!n) return;
      const fits = !inv && (xb - xa) >= 40;
      n.setAttribute('opacity', fits ? '1' : '0');
      if (fits) n.setAttribute('x', d2((xa + xb) / 2));
    };
    zone('on', x0, dx);
    zone('hold', dx, bx);
    zone('off', bx, x1);
    const bad = q('[data-zone="inverted"]');
    if (bad) bad.setAttribute('opacity', inv ? '1' : '0');

    /* The sentence under the band and the answer two cards down are both
     * functions of the pair, so they move with it rather than waiting for the
     * render that follows the release. */
    const say = (name, text) => {
      const n = el.querySelector(`[data-sayval="${name}"]`);
      if (n) n.textContent = text;
    };
    say('dark', String(Math.round(dv)));
    say('bright', String(Math.round(bv)));
    say('gap', `${Math.round(bv - dv)}-point`);
    const sim = this.shadowRoot && this.shadowRoot.querySelector('[data-lampsim]');
    const bw = this.shadowRoot && this.shadowRoot.querySelector('[data-bandword]');
    if (bw && sim) {
      let live = null;
      try { live = JSON.parse(sim.dataset.sim || '{}').luma; } catch (err) { live = null; }
      bw.textContent = lumaBandClause(live, dv, bv);
    }
    this._paintLampVerdict();
  }

  /* The Super Surveillance hour window. One thumb moved, but both fills, both
   * numbers and the empty-window hatch depend on the pair. Same contract as
   * _paintLuma: every node is one illHoursTune() marked. */
  _paintHours(el) {
    const q = (sel) => el.querySelector(sel);
    const set = (node, name, value) => { if (node) node.setAttribute(name, value); };
    const sq = q('[data-thumb="start"]');
    const eq = q('[data-thumb="end"]');
    if (!sq || !eq) return;
    const sv = parseFloat(sq.getAttribute('aria-valuenow'));
    const ev = parseFloat(eq.getAttribute('aria-valuenow'));
    if (!Number.isFinite(sv) || !Number.isFinite(ev)) return;
    const { x0, x1 } = HOUR_AXIS;
    const sx = hourX(sv);
    const ex = hourX(ev);
    const wrap = sv > ev;
    const empty = sv === ev;
    const fmt = (v) => String(Math.round(v)).padStart(2, '0') + ':00';

    set(q('[data-band]'), 'x', d2(wrap ? sx : sx));
    set(q('[data-band]'), 'width', d2(empty ? 0 : (wrap ? Math.max(0, x1 - sx) : Math.max(0, ex - sx))));
    set(q('[data-band2]'), 'width', d2(wrap && !empty ? Math.max(0, ex - x0) : 0));
    set(q('[data-band3]'), 'opacity', empty ? '1' : '0');
    set(q('[data-band3]'), 'fill', empty ? 'url(#g-hours-tune-bad)' : 'url(#g-hours-tune-hold)');

    const moveThumb = (g, x) => {
      set(g.querySelector('[data-knob]'), 'x', d2(x - 2.2));
      set(g.querySelector('.halo'), 'x', d2(x - 5.4));
    };
    moveThumb(sq, sx);
    moveThumb(eq, ex);

    const [lxs, lxe] = hourLabelXs(sx, ex);
    const head = (name, x, text) => {
      const n = el.querySelector(`[data-hourval="${name}"]`);
      if (!n) return;
      n.setAttribute('x', d2(x));
      if (text != null) n.textContent = text;
    };
    head('start', lxs, fmt(sv));
    head('end', lxe, fmt(ev));
    const never = q('[data-zone="empty"]');
    if (never) never.setAttribute('opacity', empty ? '1' : '0');
  }

  /* Rotate. The frame changes shape because a quarter turn of a landscape still
   * is a portrait still, so the clip, the outline, the crop and the dimmed strip
   * all move with the scene inside them. */
  _paintRotate(el, v) {
    const set = (node, name, value) => { if (node) node.setAttribute(name, value); };
    const q = (sel) => el.querySelector(sel);
    const { cx, cy } = ROT;
    const f = rotFrame(v);
    const fx = cx - f.w / 2;
    const fy = cy - f.h / 2;
    set(q('[data-scene]'), 'transform', `translate(${cx} ${cy}) rotate(${d2(90 - v)})`);
    [q('[data-clip]'), q('[data-frame]')].forEach((n) => {
      set(n, 'x', d2(fx)); set(n, 'y', d2(fy));
      set(n, 'width', d2(f.w)); set(n, 'height', d2(f.h));
    });
    const dim = q('[data-dim]');
    set(dim, 'x', d2(fx)); set(dim, 'y', d2(fy));
    set(dim, 'width', d2(f.w)); set(dim, 'height', d2(f.h * 0.4));
    const crop = q('[data-crop]');
    set(crop, 'x', d2(fx)); set(crop, 'y', d2(fy + f.h * 0.4));
    set(crop, 'width', d2(f.w)); set(crop, 'height', d2(f.h * 0.6));
    const cap = q('[data-rotcap]');
    if (cap) {
      const t = cap.querySelectorAll('text');
      if (t[0]) t[0].setAttribute('y', d2(fy - 7));
      if (t[1]) t[1].setAttribute('y', d2(fy + f.h + 14));
    }
    const k = rotKnob(v);
    [q('[data-knob]'), q('[data-thumbg] .halo')].forEach((n) => {
      set(n, 'cx', d2(k[0])); set(n, 'cy', d2(k[1]));
    });
    const val = q('[data-rotval]');
    if (val) val.textContent = `${Math.round(v)}° CCW`;
  }

  _clearLampProbe() {
    this._ui.lampWhatIf = false;
    this._ui.probeLuma = null;
    this._ui.probeSun = null;
    this._ui.probeUnusable = false;
  }

  _clearTuneUnlock() {
    this._ui.tuneUnlocked = '';
    if (this._tuneEl) this._abortTune();
    const focused = this.shadowRoot && this.shadowRoot.activeElement;
    if (focused && focused.closest && focused.closest('[data-tune]')) {
      try { focused.blur(); } catch (err) { /* ignore */ }
    }
  }

  /* Ask the sampler's own tree again and repaint the answer, without waiting for
   * a full render. Two things suspend that render - a focused range input and a
   * finger on a tuner - and both are exactly when the answer needs to move.
   *
   * The real values come off [data-sim], written once by viewLamp. The two
   * thresholds are read from the thumbs instead, so dragging one of them changes
   * the verdict under your finger. Nothing here writes an entity. */
  _paintLampVerdict() {
    const sr = this.shadowRoot;
    if (!sr) return;
    const host = sr.querySelector('[data-lampsim]');
    if (!host) return;
    let sim;
    try { sim = JSON.parse(host.dataset.sim || '{}'); } catch (err) { return; }

    const thumb = (name, fallback) => {
      const n = sr.querySelector(`[data-thumb="${name}"]`);
      const v = n ? parseFloat(n.getAttribute('aria-valuenow')) : NaN;
      return Number.isFinite(v) ? v : fallback;
    };
    const dark = thumb('dark', sim.dark);
    const bright = thumb('bright', sim.bright);
    const effDark = sim.auto && sim.calReady ? sim.calDark : dark;
    const effBright = sim.auto && sim.calReady ? sim.calBright : bright;

    const whatif = !!this._ui.lampWhatIf;
    const pl = this._ui.probeLuma == null
      ? (sim.luma == null ? 45 : Math.round(sim.luma)) : this._ui.probeLuma;
    const ps = this._ui.probeSun == null
      ? (sim.sun == null ? -6 : Math.round(sim.sun)) : this._ui.probeSun;

    const dec = lampVerdict({
      auto: !!sim.auto,
      calReady: !!sim.calReady,
      dark: effDark,
      bright: effBright,
      lumaValid: whatif ? !this._ui.probeUnusable : !!sim.lumaValid,
      luma: whatif ? pl : (sim.luma == null ? 0 : sim.luma),
      sunOk: whatif ? true : !!sim.sunOk,
      sunElev: whatif ? ps : (sim.sun == null ? 0 : sim.sun),
    });
    const d = LAMP_DECISION[dec] || ['—', ''];
    const tone = dec.startsWith('on') ? 'warn' : dec === 'hold' ? 'idle' : 'ok';
    const word = sr.querySelector('[data-verdictword]');
    if (word) {
      word.textContent = d[0];
      word.dataset.tone = tone;
      word.style.color = `var(--g-${tone})`;
    }
    const why = sr.querySelector('[data-verdictwhy]');
    if (why) why.textContent = d[1];

    /* The hypothetical mark on each drawing. Absent unless it is being asked. */
    const lp = sr.querySelector('[data-lumaprobe]');
    if (lp) lp.innerHTML = whatif ? lumaMark(pl, 'var(--g-info)', true) : '';
    const sp = sr.querySelector('[data-sunprobe]');
    if (sp) sp.innerHTML = whatif ? sunDisc(ps, false) : '';
    const rl = sr.querySelector('[data-probeval="luma"]');
    if (rl) rl.textContent = String(pl);
    const rs = sr.querySelector('[data-probeval="sun"]');
    if (rs) rs.textContent = `${ps}°`;
  }

  _queueNumber(act, id, value) {
    if (this._numPending && this._numPending.id !== id) this._flushNumber();
    this._numPending = { act, id, value };
    clearTimeout(this._numTimer);
    this._numTimer = setTimeout(() => this._flushNumber(), 120);
  }

  _flushNumber() {
    clearTimeout(this._numTimer);
    const p = this._numPending;
    this._numPending = null;
    if (p) this._act(p.act, { id: p.id, value: p.value });
  }

  _setLiveHint(id, state) {
    this._ui.liveTextId = id || '';
    this._ui.liveTextState = state || '';
    clearTimeout(this._liveHintTimer);
    if (state === 'saved') {
      this._liveHintTimer = setTimeout(() => {
        if (this._ui.liveTextState === 'saved') {
          this._ui.liveTextState = '';
          this._schedule(true);
        }
      }, 2200);
    }
    const sr = this.shadowRoot;
    if (sr) {
      const hint = sr.querySelector('.savefield input[data-live="1"]')
        && sr.querySelector('.savefield input[data-live="1"]').closest('.savefield')
        && sr.querySelector('.savefield input[data-live="1"]').closest('.savefield').querySelector('[data-livehint]');
      if (hint) {
        hint.dataset.state = state || '';
        hint.textContent = state === 'saving' ? 'Saving…'
          : state === 'saved' ? 'Saved'
          : state === 'error' ? 'Not saved'
          : '';
      }
    }
    this._schedule(true);
  }

  _onCardEnrolled(_data) {
    const sr = this.shadowRoot;
    if (sr) {
      const focused = sr.activeElement;
      if (focused && focused.dataset && focused.dataset.live === '1') {
        try { focused.blur(); } catch (err) { /* ignore */ }
      }
    }
    this._livePending = null;
    clearTimeout(this._liveTimer);
    this._ui.liveTextId = '';
    this._ui.liveTextState = '';
    /* Force the Keys view to rebuild even if a field had suspended rewrites. */
    this._schedule(true);
  }

  _queueLiveText(id, value, el) {
    this._livePending = { id, value, el };
    clearTimeout(this._liveTimer);
    this._liveTimer = setTimeout(() => { this._flushLiveText(); }, 280);
  }

  async _flushLiveText() {
    clearTimeout(this._liveTimer);
    const p = this._livePending;
    if (!p || !this._hass || !p.id) return false;
    if (p.id === E.enrollPendingName && !isOn(this._hass, E.enrollMode)) {
      this._livePending = null;
      return false;
    }
    const el = p.el;
    const value = p.value == null ? '' : String(p.value);
    if (el && value === (el.dataset.committed || '')) {
      this._livePending = null;
      return true;
    }
    /* Clear only this snapshot. Keystrokes during await re-queue _livePending. */
    if (this._livePending === p) this._livePending = null;
    this._setLiveHint(p.id, 'saving');
    try {
      await ACTIONS.setText(this._hass, p.id, value);
      if (el) {
        if (el.value === value) {
          el.dataset.committed = value;
          el.dataset.dirty = '0';
          this._setLiveHint(p.id, 'saved');
        } else {
          el.dataset.dirty = '1';
          if (!this._livePending) this._queueLiveText(p.id, el.value, el);
        }
      } else {
        this._setLiveHint(p.id, 'saved');
      }
      return true;
    } catch (err) {
      this._setLiveHint(p.id, 'error');
      this._ui.sheet = {
        tone: 'alarm',
        title: 'Name did not save',
        body: `${(err && (err.message || err.error)) || String(err)}. Type the name again before presenting the card.`,
      };
      this._schedule(true);
      return false;
    }
  }

  _queueLight(payload) {
    this._lightPending = { ...(this._lightPending || {}), ...payload };
    clearTimeout(this._lightTimer);
    this._lightTimer = setTimeout(() => {
      const p = this._lightPending;
      this._lightPending = null;
      if (p) this._act('setLight', p);
    }, 90);
  }

  async _flushFields() {
    const hass = this._hass;
    const sr = this.shadowRoot;
    if (!hass || !sr) return;
    await this._flushLiveText();
    const fields = sr.querySelectorAll('input[data-field="setText"]');
    for (const el of fields) {
      if (el.dataset.live === '1') continue;
      const committed = el.dataset.committed || '';
      if (el.value === committed) continue;
      let a = {};
      try { a = JSON.parse(el.dataset.arg || '{}'); } catch (err) { continue; }
      if (!a.id) continue;
      await ACTIONS.setText(hass, a.id, el.value);
      el.dataset.committed = el.value;
      el.dataset.dirty = '0';
    }
  }

  async _act(name, a) {
    const hass = this._hass;
    if (!hass) return;
    try {
      switch (name) {
        case 'nav': {
          await this._flushFields();
          const wasActivity = this._ui.tab === 'activity';
          const moved = (a.tab && a.tab !== this._ui.tab) || (a.page || '') !== this._ui.page;
          if (a.tab) this._ui.tab = a.tab;
          this._ui.page = a.page || '';
          /* Which person a per-key page is about. Carried on the nav arg
           * because pages have no URL of their own here; kept when navigating
           * away so Back onto the same page still knows who it was showing. */
          if (a.slot != null) this._ui.alertsSlot = String(a.slot);
          if (moved) { this._enterSeq++; this._clearLampProbe(); this._clearTuneUnlock(); }
          localStorage.setItem('guardian-ui.tab', this._ui.tab);
          if (this._ui.tab === 'activity') {
            if (!wasActivity) {
              this._ui.activityDayOffset = 0;
              this._ui.activityExpanded = false;
              this._ui.historyState = 'idle';
            }
            this._maybeLoadHistory();
          }
          if (this._ui.tab === 'camera') this._maybeLoadFrigateMedia();
          this._schedule(true);
          return;
        }

        case 'back': {
          await this._flushFields();
          const meta = PAGE_META[this._ui.page];
          const next = meta && meta.parent ? meta.parent : '';
          if (next !== this._ui.page) { this._enterSeq++; this._clearLampProbe(); this._clearTuneUnlock(); }
          this._ui.page = next;
          this._schedule(true);
          return;
        }

        case 'toggleMenu':
          this.dispatchEvent(new CustomEvent('hass-toggle-menu', {
            bubbles: true,
            composed: true,
          }));
          return;

        case 'saveField': {
          let field = null;
          this.shadowRoot.querySelectorAll('input[data-field="setText"]').forEach((el) => {
            let parsed = {};
            try { parsed = JSON.parse(el.dataset.arg || '{}'); } catch (err) { parsed = {}; }
            if (parsed.id === a.id) field = el;
          });
          const value = field ? field.value : a.value;
          if (value == null) return;
          await ACTIONS.setText(hass, a.id, value);
          if (field) {
            field.dataset.committed = value;
            field.dataset.dirty = '0';
            const saveBtn = field.closest('.savefield') && field.closest('.savefield').querySelector('[data-act="saveField"]');
            if (saveBtn) {
              saveBtn.disabled = true;
              saveBtn.textContent = 'Saved';
              this._ui.savedFlash = a.id;
              clearTimeout(this._savedTimer);
              this._savedTimer = setTimeout(() => {
                this._ui.savedFlash = '';
                this._schedule(true);
              }, 1400);
            }
          }
          this._schedule(true);
          return;
        }

        case 'setNotifyLevel': {
          const slot = String(a.slot || rfidSlotFromEntity(a.id) || '');
          const entityId = a.id || `input_select.rfid_${slot}_notify_level`;
          const want = String(a.value || '');
          const owner = {
            id: slot,
            haUserId: linkedHaUserId(st(hass, `input_text.rfid_${slot}_ha_user_id`, '')),
          };
          if (!canEditNotifyPrefs(hass, owner)) {
            this._ui.pendingLevel = null;
            this._ui.sheet = {
              tone: 'warn',
              title: 'Those settings belong to someone else.',
              body: 'Guardian\'s own state is unchanged.',
            };
            break;
          }
          this._ui.pendingLevel = { slot, value: want };
          this._schedule(true);
          try {
            await ACTIONS.setNotifyLevel(hass, slot, want);
          } catch (err) {
            if (isAuthRefused(err)) {
              this._ui.pendingLevel = null;
              this._ui.sheet = {
                tone: 'warn',
                title: 'Those settings belong to someone else.',
                body: 'Guardian\'s own state is unchanged.',
              };
              break;
            }
          }
          await ACTIONS.persistNotifyLevel(hass, slot, want);
          const ok = await this._awaitState(entityId, want);
          this._ui.pendingLevel = null;
          if (!ok) {
            const liveEnt = this._hass && this._hass.states && this._hass.states[entityId];
            const live = liveEnt ? String(liveEnt.state) : '(missing)';
            this._ui.sheet = {
              tone: 'alarm',
              title: 'That did not go through',
              body: `${entityId} · wanted ${want} · live ${live}`,
            };
          }
          break;
        }

        case 'setNotifyCategory': {
          const slot = String(a.slot || rfidSlotFromEntity(a.id) || '');
          const entityId = a.id || `input_text.rfid_${slot}_notify_mute`;
          const owner = {
            id: slot,
            haUserId: linkedHaUserId(st(hass, `input_text.rfid_${slot}_ha_user_id`, '')),
          };
          if (!canEditNotifyPrefs(hass, owner)) {
            this._ui.sheet = {
              tone: 'warn',
              title: 'Those settings belong to someone else.',
              body: 'Guardian\'s own state is unchanged.',
            };
            break;
          }
          const want = notifyMuteCsv(hass, entityId, a.token, !!a.on);
          try {
            await ACTIONS.setNotifyCategory(hass, entityId, a.token, !!a.on);
          } catch (err) {
            if (isAuthRefused(err)) {
              this._ui.sheet = {
                tone: 'warn',
                title: 'Those settings belong to someone else.',
                body: 'Guardian\'s own state is unchanged.',
              };
              break;
            }
          }
          await ACTIONS.persistNotifyMute(hass, slot, want);
          const ok = await this._awaitState(entityId, want);
          if (!ok) {
            const liveEnt = this._hass && this._hass.states && this._hass.states[entityId];
            const live = liveEnt ? String(liveEnt.state) : '(missing)';
            this._ui.sheet = {
              tone: 'alarm',
              title: 'That did not go through',
              body: `${entityId} · wanted ${want === '' ? '(empty)' : want} · live ${live}`,
            };
          }
          break;
        }

        case 'lampTone':
          this._ui.lampTone = a.value === 'white' ? 'white' : 'color';
          this._schedule(true);
          return;

        /* Panel memory only: which tuner drawing may be dragged. Toggling the
         * same kind locks it; choosing another locks the previous. */
        case 'tuneLock': {
          const kind = a.kind || '';
          this._ui.tuneUnlocked = this._ui.tuneUnlocked === kind ? '' : kind;
          if (this._tuneEl) this._abortTune();
          const focused = this.shadowRoot && this.shadowRoot.activeElement;
          if (focused && focused.closest && focused.closest('[data-tune]')) {
            try { focused.blur(); } catch (err) { /* ignore */ }
          }
          this._schedule(true);
          return;
        }

        /* Both of these end in a return, before any callService. The what-if is
         * a question asked of a local function; it must not be able to write. */
        case 'lampWhatIf':
          this._ui.lampWhatIf = a.value === 'try';
          if (!this._ui.lampWhatIf) this._clearLampProbe();
          this._schedule(true);
          return;

        case 'lampProbe': {
          if (a.field === 'luma') this._ui.probeLuma = Math.round(a.value);
          else if (a.field === 'sun') this._ui.probeSun = Math.round(a.value);
          else if (a.field === 'valid') this._ui.probeUnusable = a.value === 'unusable';
          /* A focused range input suspends the view rewrite, exactly as a
           * focused tuner does, so the answer is repainted in place instead. */
          this._paintLampVerdict();
          this._schedule(true);
          return;
        }

        case 'lampPreset': {
          const data = {};
          if (a.hs) data.hs_color = a.hs;
          if (a.kelvin) data.color_temp_kelvin = a.kelvin;
          await ACTIONS.setLight(hass, a.id, data);
          if (a.hs) this._ui.lampTone = 'color';
          if (a.kelvin) this._ui.lampTone = 'white';
          break;
        }

        case 'setLight': {
          const data = {};
          if (a.brightness != null && Number.isFinite(a.brightness)) data.brightness = Math.round(a.brightness);
          if (a.hs) data.hs_color = a.hs;
          if (a.kelvin != null && Number.isFinite(a.kelvin)) data.color_temp_kelvin = Math.round(a.kelvin);
          if (!Object.keys(data).length) return;
          await ACTIONS.setLight(hass, a.id, data);
          if (this._wheelEl) return;
          break;
        }

        case 'moreinfo':
          this.dispatchEvent(new CustomEvent('hass-more-info', {
            detail: { entityId: resolve(hass, a.id) }, bubbles: true, composed: true,
          }));
          return;

        case 'filter':
          this._ui.filter = a.id;
          this._ui.activityExpanded = false;
          this._schedule(true);
          return;

        case 'activityDay': {
          const dir = Number(a.dir) || 0;
          const next = Math.max(0, Math.min(ACTIVITY_MAX_DAYS - 1, (this._ui.activityDayOffset || 0) + dir));
          if (next === (this._ui.activityDayOffset || 0)) return;
          this._ui.activityDayOffset = next;
          this._ui.activityExpanded = false;
          this._schedule(true);
          return;
        }

        case 'activityMore':
          this._ui.activityExpanded = true;
          this._schedule(true);
          return;

        case 'cameraLive':
          this._ui.cameraLive = !!a.on; this._ui.camNonce = Date.now(); this._schedule(true); return;

        case 'cameraRefresh':
          this._ui.camNonce = Date.now(); this._schedule(true); return;

        case 'camSource':
          this._ui.camSource = a.value === 'frigate' ? 'frigate' : 'ambient';
          this._ui.camNonce = Date.now();
          this._schedule(true); return;

        case 'openFrigate': {
          const path = this._model && this._model.camera.panelPath;
          if (!path) {
            this._ui.sheet = {
              tone: 'idle', title: 'Frigate is not in the sidebar',
              body: 'Open Frigate from Home Assistant’s sidebar, or set config.frigatePath on the Guardian panel_custom block.',
            };
            this._schedule(true);
            return;
          }
          navigateHa(path);
          return;
        }

        case 'exitPinDigit': {
          if (this._model && this._model.security.key !== 'doorbellexit') return;
          if (this._ui.exitPinBusy) return;
          const cur = String(this._ui.exitPin || '');
          if (a.key === 'back') this._ui.exitPin = cur.slice(0, -1);
          else if (/^[0-9]$/.test(a.key) && cur.length < 6) this._ui.exitPin = cur + a.key;
          this._ui.exitPinError = '';
          this._schedule(true);
          return;
        }

        case 'exitPinSubmit': {
          if (this._model && this._model.security.key !== 'doorbellexit') return;
          if (this._ui.exitPinBusy) return;
          const pin = String(this._ui.exitPin || '');
          if (!/^[0-9]{4,6}$/.test(pin)) {
            this._ui.exitPinError = 'Enter 4 to 6 digits.';
            this._schedule(true);
            return;
          }
          this._ui.exitPinBusy = true;
          this._ui.exitPinError = '';
          this._schedule(true);
          try {
            const raw = await ACTIONS.applyDoorbellExitPin(hass, pin);
            this._ui.exitPin = '';
            this._ui.exitPinBusy = false;
            const payload = (raw && raw.response) || raw || {};
            const nested = payload.guardian_apply_doorbell_exit_pin;
            const outcome = (nested && nested.outcome) || payload.outcome;
            if (outcome === 'rejected') this._ui.exitPinError = 'That PIN was not accepted.';
          } catch (err) {
            this._ui.exitPin = '';
            this._ui.exitPinBusy = false;
            this._ui.exitPinError = 'The PIN window is no longer open.';
          }
          this._schedule(true);
          return;
        }

        case 'closeSheet':
          this._ui.sheet = null; this._schedule(true); return;

        case 'toggle': {
          const id = resolve(hass, a.id);
          if (id === resolve(hass, E.enrollMode)) {
            if (a.on) {
              await this._flushLiveText();
            } else {
              /* Discard uncommitted typing; mode-off clears the helper anyway. */
              clearTimeout(this._liveTimer);
              this._livePending = null;
              this._ui.liveTextId = '';
              this._ui.liveTextState = '';
            }
            await ACTIONS.setHouseMode(hass, 'enrollment', !!a.on);
            break;
          }
          if (id === resolve(hass, E.pinChangeMode)) {
            await ACTIONS.setHouseMode(hass, 'pin_change', !!a.on);
            break;
          }
          if (id === resolve(hass, E.superSurveillance)) {
            await ACTIONS.setHouseMode(hass, 'super_surveillance', !!a.on);
            break;
          }
          const domain = id.split('.')[0];
          const service = a.on ? 'turn_on' : 'turn_off';
          await hass.callService(['light', 'switch'].includes(domain) ? domain : 'input_boolean',
            service, {}, { entity_id: id });
          break;
        }
        case 'setEnrollPolicy':
          await this._flushLiveText();
          await ACTIONS.toggleBoolean(hass, E.enrollVisitor, a.value === 'visitor');
          break;
        case 'setNumber': await ACTIONS.setNumber(hass, a.id, a.value); break;
        case 'setEntityNumber': await ACTIONS.setEntityNumber(hass, a.id, a.value); break;
        case 'setSelect': await ACTIONS.setSelect(hass, a.id, a.value); break;
        case 'setSlotPresence':
          await ACTIONS.slotWrite(hass, a.slot, 'presence', a.value);
          break;
        case 'setSlotPolicy':
          await ACTIONS.slotWrite(hass, a.slot, 'policy', a.value);
          break;
        case 'setSlotUser': {
          const want = linkedHaUserId(a.value);
          const entityId = `input_text.rfid_${a.slot}_ha_user_id`;
          try { await ACTIONS.slotWrite(hass, a.slot, 'ha_user_id', want); }
          catch (err) { /* old scripts stop on unknown op; persist below */ }
          await ACTIONS.persistHaUser(hass, a.slot, want);
          const ok = await this._awaitState(entityId, want);
          this._ui.slotUserError = ok ? '' : String(a.slot);
          if (!ok) {
            const liveEnt = this._hass && this._hass.states && this._hass.states[entityId];
            const live = liveEnt ? String(liveEnt.state) : '(missing)';
            this._ui.slotUserWant = want;
            this._ui.slotUserLive = live;
            this._ui.sheet = {
              tone: 'alarm',
              title: 'That did not go through',
              body: `${entityId} · wanted ${want === '' ? '(empty)' : want} · live ${live}`,
            };
          } else {
            this._ui.slotUserWant = '';
            this._ui.slotUserLive = '';
          }
          break;
        }
        case 'setNotifyTarget': {
          const want = String(a.value);
          let ok = true;
          try {
            await ACTIONS.slotWrite(hass, a.slot, 'notify_target', want);
          } catch (err) { ok = false; }
          if (ok) ok = await this._awaitState(a.id, want);
          this._ui.notifyLinkError = ok ? '' : String(a.slot);
          if (!ok) this._maybeRefreshNotifyOptions(true);
          break;
        }
        case 'togglePresence': {
          const avail = presenceTrackerIds(hass);
          const availSet = new Set(avail);
          if (!availSet.has(a.id)) break;
          const raw = String(st(hass, E.presenceTrackers, ''));
          const current = raw.split(',').map((s) => s.trim()).filter(Boolean)
            .filter((id) => !avail.length || availSet.has(id));
          const next = a.on
            ? [...new Set([...current, a.id])]
            : current.filter((id) => id !== a.id);
          await ACTIONS.setText(hass, E.presenceTrackers, next.join(','));
          this._ui.savedFlash = E.presenceTrackers;
          setTimeout(() => { this._ui.savedFlash = ''; this._schedule(true); }, 1200);
          break;
        }
        case 'setText': await ACTIONS.setText(hass, a.id, a.value); break;
        case 'press': await ACTIONS.press(hass, a.id); break;
        case 'pressInputButton': await ACTIONS.pressInputButton(hass, a.id); break;
        case 'timerStart':
          await this._flushLiveText();
          await ACTIONS.timerStart(hass, a.id);
          break;
        case 'clearSlot': await ACTIONS.clearSlot(hass, a.slot); break;
        case 'clearSsDays': await ACTIONS.clearBooleans(hass, a.ids); break;
        case 'sampleLamp': await ACTIONS.sampleLamp(hass); break;
        case 'retuneLamp': await ACTIONS.retuneLamp(hass); break;
        case 'occupancyPulse': await ACTIONS.occupancyPulse(hass); break;
        case 'notifyTest': {
          const raw = await ACTIONS.notifyTest(hass, a.slot);
          const payload = (raw && raw.response) || raw || {};
          const nested = payload.guardian_notify_test || payload;
          const decision = nested.decision;
          const to = String(nested.recipients || '').split(',')
            .map((s) => s.trim()).filter(Boolean)
            .map((id) => notifyPhoneLabel(hass, id)).join(', ');
          if (decision === 'person') {
            this._ui.sheet = {
              tone: 'ok',
              title: 'Test alert sent',
              body: `Guardian: test alert went to ${to || 'the linked phone'}. If it never arrives, the link is fine and the problem is on the device — companion notification permissions and battery optimisation.`,
            };
          } else if (decision) {
            /* Three different failures, three different people who can fix
             * them. "No phone linked" was once reported for all of them, which
             * is actively misleading when the picker plainly names a phone -
             * that wording is why a half-finished deploy looked like a setup
             * mistake and cost a full debugging pass.
             *
             * not_ready is not about this key at all: Guardian's own backend is
             * incomplete, so nothing could have been routed for any key. Say
             * that, and do not invite the household to go fiddle with a picker
             * that is already correct. */
            const picked = notifyPhoneLabel(hass, String(nested.target || ''));
            this._ui.sheet = nested.reason === 'not_ready'
              ? {
                tone: 'alarm',
                title: 'Guardian is not fully installed',
                body: 'The RFID slot rack is missing from Home Assistant, so no key can be looked up and no alert can be routed — nothing is wrong with this key or its phone. Open More → Diagnostics to see which files are missing.',
              }
              : nested.reason === 'not_registered'
                ? {
                  tone: 'warn',
                  title: 'That phone is not reachable',
                  body: `${picked} is linked to this key, but Home Assistant has no notify target by that name right now, so nothing was sent. Open the companion app on that phone so it re-registers, then try again.`,
                }
                : {
                  tone: 'warn',
                  title: 'Nothing was sent',
                  body: 'This key has no phone linked, so there was nothing to test. Pick one under Alerts go to and try again.',
                };
          } else if (!buildInstall(hass).ok) {
            /* No verdict came back AND the install is known to be incomplete.
             * A backend older than the panel returns a response this panel
             * cannot read, which is indistinguishable from a client that cannot
             * read responses at all - except that we already know the halves
             * disagree, so blame the thing we have evidence for rather than
             * telling the household to go look at their phone. */
            this._ui.sheet = {
              tone: 'alarm',
              title: 'Guardian is not fully installed',
              body: 'No verdict came back from the test. Guardian’s files on this Home Assistant are incomplete or from different versions, so the panel and the logic underneath it do not agree. Open More → Diagnostics.',
            };
          } else {
            /* No callWS on this client, so the test was sent but the verdict
             * could not be read back. Do not claim a phone was reached. */
            this._ui.sheet = {
              tone: 'info',
              title: 'Test alert sent',
              body: 'Check the phone selected under Alerts go to. This browser could not read back the delivery verdict.',
            };
          }
          break;
        }
        case 'createSsProgram': await ACTIONS.createSsProgram(hass); break;
        case 'askDeleteSsProgram':
          this._ui.sheet = {
            tone: 'alarm',
            title: `Delete ${a.label || 'this program'}?`,
            body: 'Its name, days and hours are erased and it disappears from this list. Super Surveillance still rises from the manual switch and from any other program.',
            confirm: { label: 'Delete', act: 'deleteSsProgram', arg: { id: a.id } },
          };
          break;
        case 'deleteSsProgram':
          this._ui.sheet = null;
          await ACTIONS.deleteSsProgram(hass, a.id);
          break;
        case 'selfCheck': {
          const raw = await ACTIONS.selfCheck(hass);
          const payload = (raw && raw.response) || raw || {};
          const r = payload.guardian_selfcheck || payload;
          if (!r || r.scripts === undefined) {
            /* Either this browser cannot read script responses, or the
             * scripts.yaml on this box predates guardian_selfcheck. Both mean
             * the same thing to the household - the backend could not answer -
             * and the second is itself the fault worth reporting. */
            this._ui.sheet = {
              tone: 'alarm', title: 'No answer from the backend',
              body: 'Home Assistant did not return a self-check. The most likely reason is that scripts.yaml on this install is older than this panel and has no self check to run. Copy scripts.yaml into /config and restart fully.',
            };
            break;
          }
          const links = Array.isArray(r.links) ? r.links : [];
          /* A key with no phone linked is a household's choice, not a fault -
           * alerts about it go to everyone, which is a supported way to run.
           * Reporting it as a problem is the same mistake this whole pass
           * exists to correct, one level up: it puts a red verdict on a
           * deliberate configuration and buries the failures that are real. */
          const broken = links.filter((l) => l.occupied
            && (l.state === 'not_ready' || l.state === 'not_registered'));
          const unlinked = links.filter((l) => l.occupied && l.state === 'not_selected');
          const shadowed = links.filter((l) => l.helper === 'missing');
          const agree = !!r.versions_agree;
          const lines = [
            `scripts.yaml ${r.scripts}, packages/guardian.yaml ${r.package_guardian}, packages/guardian_rfid.yaml ${r.package_rfid}, automations.yaml ${r.automations}. This panel is ${GUARDIAN_UI_VERSION}.`,
            `Slot rack ${r.rack_ready ? 'readable' : 'MISSING'}; ${r.target_count} phone${Number(r.target_count) === 1 ? '' : 's'} visible to Home Assistant.`,
            broken.length
              ? `Keys that cannot be alerted: ${broken.map((l) => `${l.name || 'slot ' + l.slot} (${l.state})`).join(', ')}.`
              : 'Every linked key can be alerted.',
            unlinked.length ? `No phone linked (alerts go to everyone): ${unlinked.map((l) => l.name || 'slot ' + l.slot).join(', ')}.` : '',
            shadowed.length ? `Missing helpers for slot ${shadowed.map((l) => l.slot).join(', ')} — a UI-created helper in .storage may be shadowing Guardian’s own.` : '',
          ].filter(Boolean);
          this._ui.sheet = {
            tone: agree && !broken.length ? 'ok' : 'warn',
            title: agree && !broken.length ? 'Guardian is healthy' : 'Guardian found problems',
            body: lines.join(' '),
          };
          break;
        }
        case 'setupCheck': {
          const raw = await ACTIONS.setupCheck(hass);
          const payload = (raw && raw.response) || raw || {};
          const r = payload.guardian_setup_wizard || payload;
          if (!r || r.blockers === undefined) {
            this._ui.sheet = {
              tone: 'alarm', title: 'No answer from the backend',
              body: 'Home Assistant did not return a setup check. The most likely reason is that scripts.yaml on this install is older than this panel and has no setup wizard to run. Copy scripts.yaml into /config and restart fully.',
            };
            break;
          }
          const list = (v) => (Array.isArray(v) ? v : []);
          const blockers = list(r.blockers);
          const warnings = list(r.warnings);
          const info = list(r.info);
          /* Blockers first and in full. This sheet is read by someone who has
           * just copied files onto a machine and wants to know what is left;
           * summarising the remedy away would send them back to the docs,
           * which is the exact burden this pass removes. Warnings and info
           * are counted rather than spelled out, because Home Assistant also
           * holds the whole list in the persistent notification the wizard
           * leaves, and that is the place to read it at length. */
          const lines = [
            blockers.length
              ? `${blockers.length} thing${blockers.length === 1 ? '' : 's'} still needed:`
              : 'Nothing is outstanding. Guardian has everything it needs.',
            ...blockers.map((b) => `• ${String(b).replace(/[*`]/g, '')}`),
            warnings.length ? `Waiting on hardware: ${warnings.length} item${warnings.length === 1 ? '' : 's'}.` : '',
            info.length ? `${info.length} note${info.length === 1 ? '' : 's'} worth knowing.` : '',
            (warnings.length || info.length)
              ? 'The full text is in the Guardian setup notification in Home Assistant.'
              : '',
          ].filter(Boolean);
          this._ui.sheet = {
            tone: blockers.length ? 'warn' : 'ok',
            title: blockers.length ? 'Setup is not finished' : 'Setup is complete',
            body: lines.join(' '),
          };
          break;
        }
        case 'notifySelfTest':
          await ACTIONS.notifySelfTest(hass);
          this._ui.sheet = {
            tone: 'ok', title: 'Self-test sent',
            body: 'Check both phones. If neither buzzed, the group is fine and the problem is on the device — companion notification permissions and battery optimisation. Home Assistant also leaves a persistent notification with the verdict.',
          };
          break;
        case 'reset': await ACTIONS.reset(hass, !!a.restart); break;

        default:
          return;
      }
      this._schedule(true);
    } catch (err) {
      this._ui.pendingLevel = null;
      this._ui.sheet = {
        tone: 'alarm',
        title: 'That did not go through',
        body: `${(err && (err.message || err.error)) || String(err)}. Guardian's own state is unchanged.`,
      };
      this._schedule(true);
    }
  }
}

if (!customElements.get('guardian-panel')) {
  customElements.define('guardian-panel', GuardianPanel);
}

console.info(
  `%c Guardian %c panel v${GUARDIAN_UI_VERSION} `,
  'background:#1F6B5A;color:#fff;font-weight:650;border-radius:3px 0 0 3px;padding:2px 6px',
  'background:#F2F2F7;color:#1C1C1E;font-weight:650;border-radius:0 3px 3px 0;padding:2px 6px'
);
