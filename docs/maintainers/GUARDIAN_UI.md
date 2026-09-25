# The Guardian control panel

A second, deliberately designed UI layer over the Guardian security system.
This document is the counterpart to `GUARDIAN_AUDIT.md` (what the system does)
and `DEPLOY.md` (how to ship it): it records what the panel is, why it is built
the way it is, and what may and may not be changed about it.

Deployment of the original panel is `DEPLOY.md`'s **eleventh pass**. The
household-app redesign (nested navigation, light-first chrome, Frigate as a
camera rather than a config row) is the **twelfth**. Layout, scroll, live-view
camera default and lamp colour controls are the **thirteenth**. Live view via
`ha-camera-stream` and the phone hamburger opening Home Assistant's sidebar
are the **twentieth**. The visual pass — refined palette and type, the motion
additions, and one hand-drawn illustration per physical device — is the
**twenty-first**. The device renders rebuilt from the STL geometry, and the
presentation layer around them — device cards, a hero with a stat strip, and a
live signal-path diagram — are the **twenty-fourth**. The two sensors that
actually watch the door — a reed switch on the frame, an MPU6050 on the lever —
drawn into the door diagram, are the **twenty-fifth**. The door's three
thresholds redrawn as controls you can grab — the lever, the swing gate and the
lookback window — are the **twenty-sixth**. The sentences under those three
controls rewritten in household language, and a phone scroll that can no longer
retune them by accident, are the **twenty-seventh**. The door lamp's own numbers
— the light level it switches at, which way the still is turned before it is
measured, and how long the lamp may disagree with the sky — drawn as the things
they decide, with the sampler's decision tree ported read-only so the page can
answer *why was it that*, are the **twenty-eighth**. Making Guardian the
Home Assistant landing page — system `default_panel: guardian`, without
turning it into a Lovelace dashboard — is the **twenty-ninth**. Driving the
four destinations from Home Assistant's sidebar state instead of a 1100 px
viewport cut — so an iPad no longer shows two hamburgers — is the
**thirtieth**. Locking each tuner until you unlock it to drag — so a phone
scroll cannot retune a setting, without the 12 px slop that made the drawings
feel dead — is the **thirty-first**. None of them changed an entity or a service call; §3's four
tabs and §5's rules are untouched. The entity classification the visual pass
produced — status vs. safe control vs. internal vs. never-exposed — is
`GUARDIAN_AUDIT.md` **§17**, because it is a fact about the system rather
than about the UI.

---

## 1. Why this exists

Every capability in Guardian was already reachable. It was reachable through
Home Assistant's auto-generated dashboard, which renders every helper as an
identical editable box in one flat alphabetical list.

That has two costs, and only the first is obvious.

The obvious one is that day-to-day use means hunting entity ids. "Is anybody
home" is a `sensor` two thirds of the way down; "am I armed" is an
`input_boolean` somewhere else; the countdown on a live challenge is not
rendered at all, because a `timer` shows as `active` and nothing more.

The second is worse. `input_number.guardian_dark_threshold` and
`input_text.pending_exit_slot` look the same on that screen. Changing the first
retunes the lamp. Changing the second desynchronises the passage state machine
from its timer — the failure shape that F-02, F-19, F-31 and F-36 all
describe, arrived at from a settings page instead of from a restart. Nothing in
the stock UI says which is which.

So the goal is not "a prettier dashboard". It is a surface where the safe
things are obvious, the frequent things are immediate, and the dangerous things
are present, honest, and hard to do by accident.

---

## 2. What it is

One ES module — `www/guardian-ui/guardian-panel.js` — registered as a Home
Assistant **custom panel** by a `panel_custom:` block in `configuration.yaml`.
It appears in the sidebar as **Guardian**, is the system landing page (opening
Home Assistant at `/` loads `/guardian`), and works identically in a browser
and in the companion app.

A second, tiny module — `www/guardian-ui/set-default-panel.js` — is loaded on
every page via `frontend.extra_module_url`. It is not part of the panel. It
exists because Settings → Dashboards cannot list a custom panel, so the house
default has to be written the same way that screen writes it: system frontend
data `core.default_panel`. The first admin session after deploy does that once.

**No HACS. No custom cards. No bundler, no build step, no dependencies, no
Python.** Copy the two files under `www/guardian-ui/`, keep the
`panel_custom:` and `extra_module_url` blocks, restart, then open Home
Assistant once as an administrator.

Home Assistant injects its own `hass` object into the element, which is what
makes this cheap rather than ambitious. The panel gets live state, authenticated
service calls, signed camera proxy URLs, recorder history and the event bus with
no token, no CORS, and no second authentication path to secure.

### Why not native Lovelace YAML

It cannot reach the bar. A countdown ring that sweeps, an alarm banner that
pulses, a roster with per-slot avatars, a timeline that merges recorder history
with live events — none of that is expressible in stock cards. And the
modularity requirement works against it: a four-slot rack in hand-written YAML
is four hand-written card blocks, and a fifth slot means editing the dashboard.

### Why not HACS custom cards

Mushroom, button-card and card-mod would get closer, at the cost of a
dependency surface this repository does not otherwise have: four community
repositories that must be installed before the dashboard renders at all, each
free to break on its own schedule. This system has no build pipeline and no
test suite. Adding four upstreams to the deploy path is the wrong trade.

### Why not a separate web app

It would need its own authentication against the Home Assistant API, its own
long-lived token stored somewhere, and its own CORS story — three new security
surfaces, for a project whose entire value is that its security surfaces are
few and documented.

### Why it does not appear under Settings → Dashboards

That screen lists Lovelace dashboards only: the built-in Home / Overview,
Lights, Security, Climate, Energy, Maintenance, and any user-created Lovelace
dashboard (a YAML or UI-controlled view). Guardian is a `panel_custom`, same
class of thing as Developer Tools, not a Lovelace dashboard. Home Assistant
has no row there for it, and wrapping the panel as a Lovelace card or iframe
so that it *would* appear would put Lovelace chrome around a UI that was
built specifically not to be Lovelace. Do not do that.

The landing page is a different switch. Since 2025.12, "Set as default" on
that screen writes `core.default_panel` to frontend system storage. That
value may be any registered panel `url_path`, including `guardian`. The
Dashboards UI simply refuses to offer custom panels as candidates.
`set-default-panel.js` is the equivalent write. After it has run, Guardian
sorts to the top of the sidebar the same way Overview did, and `/` loads
it. Overview, Lights, Settings, Frigate and the rest stay where they are.

A later "Set as default" on Overview is honoured: the module is one-shot
(`guardian_primary_applied`) and will not fight the user. A single person
who wants Overview can override the house default from their profile.

### Why a single file for the panel

Home Assistant serves `/config/www` as `/local` with long cache headers. One
file for the panel means one `?v=` on `module_url` busts the entire UI; a
module graph would leave stale sub-modules cached behind a fresh entry point,
which is the kind of bug that wastes an evening. It also matches the house
style — the YAML in this repo runs to two thousand lines a file with heavy
section banners, and the panel is organised the same way.

The landing-page helper is a second file on purpose. `extra_module_url` runs
on every Home Assistant page, including Settings. Loading seven thousand
lines of panel there would be waste; the helper is tens of lines and has its
own `?v=`, bumped in lockstep with `GUARDIAN_UI_VERSION`.

---

## 3. Information architecture

Four peer destinations, ranked by how often a household member needs them.
Keys, lamp thresholds, firmware numbers and reset are not deleted; they are
nested. A compact status bar sits above every screen, so the live security
state is still zero taps away without cloning a large hero onto every view.

| Surface | Reached by | Holds |
|---|---|---|
| **Status bar** | always visible | Live security sentence, countdown when a timer is running, arm/disarm or silence. Alarm and challenge are louder; idle is quiet. |
| **Home** | tab 1 | Faults, door-camera peek (still only), who is home (each key’s name and state), door, super surveillance, schedule summary (honest about several programs), lamp on/off, health cells |
| **Camera** | tab 2 | Live / still stage (HA `ha-camera-stream` for live, snapshot for still; ambient camera, Frigate if discovered), doorbell including the status light, person detection, door contact; sensors one tap deeper |
| **Activity** | tab 3 | Merged recorder history and live event stream, filterable, including a Camera category |
| **More** | tab 4, then drill-in | Nested: Keys & PIN (and, one level under each key, that person's Notification preferences), Lamp, Security (the Super Surveillance programs the household has created, not one window and not a fixed four), Devices (portal / doorbell), Notifications, Install, Diagnostics, Internals, Reset |

On a phone the top bar has a menu button that opens Home Assistant's sidebar
(Overview, Settings, other panels) and a Back control whenever a nested page
is open. Guardian's four destinations stay in the bottom tabs. Chrome is not
a viewport cut at 1100 px: it follows whether HA's sidebar is an overlay, a
collapsed icon rail, or expanded, and how much width that leaves the panel.
There is only ever one hamburger. More is always a single column — the
section list, then the chosen page — never a second sidebar.

Reset is its own last page, press-and-hold only, never adjacent to chime or
lamp. YAML, script names and entity ids belong in Install / Internals /
Diagnostics, not on Home.

### The priority order the status bar encodes

The panel does not invent a ranking.
`sensor.guardian_portal_countdown_ends` already ranks the six timers — entry
challenge, MFA, entry, exit, PIN change, enrollment — because the portal display
needed exactly that. The status bar reads those sensors for the ring and
applies the same order for its wording:

1. **Alarm** — `portal_display_state == ALARM`, with the reason from
   `input_text.guardian_alarm_reason`
2. **Entry challenge** — with its origin (inside / outside / unresolved)
3. **PIN challenge** — with the source reader, the person’s name, and attempts
   left
4. **PIN change session** — current step
5. **Adding a key** — whose name is being written, resident/visitor, and who
   would be replaced if the rack is full
6. **Passage open** — direction
7. **Elevated** — distinguishing the manual switch from Super Surveillance programs (one named window, or several)
8. **Idle**

---

## 4. Design system

Light is the product default (`:host`). Dark is `[data-scheme="dark"]`, a
dimmed home app, not a near-black console. The panel follows
`hass.themes.darkMode` and falls back to the OS preference.

Surfaces are grouped inset lists: a warm paper canvas (`#F3F2EF` / `#16171A`),
white / `#1F2126` groups on a hairline border, 12–16 px radii, no glow, no
radial hero wash, no glass. Elevation in light is one tight shadow; in dark it
is the surface lifting off the canvas, never a shadow. One accent (`#1F6B5A` /
a dimmed peer) for selected tabs, primary buttons and switches. Status colour
is a dot, a word, or a 3 px leading edge — not a wash behind half the screen.
The one exception is the alarm bar, where the colour *is* the message.
**Live is not alarm.**

The twenty-first pass moved the canvas off iOS grey and pulled the dark scheme up
off black, and it separated the four cool tones. `arm`, `elev`, `pass` and
`info` had drifted to within a few degrees of each other — "a passage is open"
and "a key is being added" rendered as the same teal, which defeats the point
of having one tone per state. They are now four distinguishable hues at one
chroma. The eight meanings below did not change.

### Status colour language

One tone is chosen per state, in the model, and everything downstream reads it.
A challenge is the same colour in the status bar, on Home and in the activity
row, with no second opinion anywhere in the file.

| Tone | Means |
|---|---|
| `ok` | Secure, healthy, at home, granted |
| `arm` | Super surveillance engaged, nothing pending |
| `elev` | Elevated mode in force, PIN sessions |
| `pass` | A passage window is open — someone is authorised to move |
| `info` | Adding a key and other operator-driven sessions |
| `warn` | A challenge is counting down, a fault, a card rejected |
| `alarm` | Full alarm, and every destructive control |
| `idle` | Off, away, nothing happening, no data |

Typography is the system UI font, sentence case, on a fixed ramp — 26 px page
title, 19 px status headline, 15 px body, and a 10.5 px uppercase micro label
with wide tracking for eyebrows and group headers. There is no webfont: a
`<link>` to a font host would be the network dependency §2 exists to avoid.
Monospace is reserved for entity ids on Install and Internals. Numbers that
tick are tabular.

### Device renders

There are **three physical devices, not four.** The security camera has no
housing of its own — its lens and IR sensor are set into the door lamp's bottom
band — so the lamp drawing *is* the camera drawing, and the Camera tab shows the
same drawing under a tighter `viewBox` rather than a fourth object.

#### Geometry comes from the mesh, not from a photograph

Every envelope below was measured off the old monolith STLs (those files
are no longer in this tree) and only then checked against
`docs/reference-images/`. The current print set is the three `.3mf` profiles
on MakerWorld / Printables; these drawings were not re-measured from those
parts. This is the twenty-fourth pass's central correction.
The twenty-first pass traced the lamp from `lamp-1.jpg`, a three-quarter shot in
which the top face is visible and the top edge is foreshortened; the result was
a pentagon that narrowed at both ends. The mesh says the object is a hexagonal
lantern, and that its front elevation is a rectangle:

| | Mesh (mm) | What it fixes |
|---|---|---|
| Interior portal | 73 × 182.75 × 57.5 | arrangement was right, rendering was flat |
| Doorbell | 86 × 95 × 73.9 | drew the module with its cover off, and its wall cone |
| Door lamp | 254 × 192 × 89 | was a pentagon |
| Reed switch, frame half | 20.25 × 41.25 × 29.25 | was one unnamed box on the jamb |
| Reed switch, leaf half | 20.25 × 35.25 × 11.5 | was not drawn |
| Handle sensor | 28 × 17 × 42 | was not drawn |

The lamp's plan section — `(2,0) (252,0) (252,42) (249,47) (174,86) (171,87)
(84,87) (81,87) (6,48) (2,44)` — gives a flat back, two short side walls, two
shoulders turned **27.5°**, and a 93-wide front face, which projects square-on
to vertical bands of 5.5 / 75 / 93 / 75 / 5.5. Horizontally the STL panel plates
sit at Y 67–185 of 192: a 7 mm top rail, three 86 × 118 frosted panels, and a
67 mm skirt with the lens set into it.

The STLs are the printed housings only. The speaker, the 1.14″ 240×135 IPS
display, the keypad, the frosted panels and the lens are bought parts, are not in
the mesh, and come from the photographs and `INSTALL.md` §1. That is also why
these are drawn rather than rendered from the mesh: a mesh render would show
three empty holes.

**Draw the device as mounted, not as assembled.** The photographs are a build
log, so most of them are of parts on a bench with covers off. `image9.jpg` shows
the doorbell's button plate, its four M3 screws and the bare 12 mm red switch —
and none of that is visible once the unit is on the wall, because the cover goes
on last and the cover *is* the button. The finished doorbell is two plain slabs
of translucent white PETG with a bell mark centred on the front. Likewise the
portal: the 5 mm RGB status LED is optional in the build document, this unit was
printed without one, and so nothing is drawn above its speaker.

#### House style

One key light, upper left at ~35°, in all three: every face gradient runs that
way, every specular sits on that side, every contact shadow falls to the lower
right. Each face carries a three-stop form gradient (lit / body / terminator), a
rim on the shadow side, and ambient occlusion in every seam and recess. Materials
are specific — printed PETG with its layer lines, gloss black paint, frosted
acrylic, chrome, coated glass.

The objects stay **upright and square to the viewer**; form comes from shading,
not from turning the object. The one liberty is the lamp's `dEdge`: six units
(3%) of foreshortening on its outer edges, because those edges are 40 mm further
away than the front face and without it the lantern reads as a flat window. It
is symmetric, it preserves the measured proportions, and it is the opposite of
the three-quarter photo the pentagon came from.

**Gradients and `<pattern>` yes, `<filter>` no.** Filter regions are the
expensive part and Home draws four of these at once; the only blur is still a
CSS `filter`.

#### The door diagram, and the two sensors that are not one

Door sensing is a fourth *cell* on Home and still not a fourth device: a reed
switch at the top of the frame and an MPU6050 clamped to the lever, both wired
into the portal. Until the twenty-fifth pass the diagram carried one unnamed box
on the latch jamb with a status LED on it, which is not a thing this door has.

Two corrections arrived with them. The leaf pivoted on its **left** edge with the
swing arc on the right — the mirror of this door, which the photographs show
hinged right and levered left, seen from inside. That is not pedantry: a reed at
the hinge corner never separates, so the top-left corner is only the right place
for one once the free edge is on the left. And both halves carry the same
3.5 × 16.7 slot half a millimetre under their rim — capsule in one, magnet in the
other — so the **gap** between them is the entire mechanism. The leaf half is
therefore drawn riding the leaf's own top edge: a unit and a half of gap closed,
thirteen open. The tone mark that used to sit on the jamb box now hangs at the
frame half's sensing face, bridging the two halves while they are together and
left holding nothing once the leaf carries its magnet away.

Scale is this drawing's declared liberty, as `dEdge` is the lamp's. At the leaf's
own scale the reed halves are two units across and the handle sensor is
1.5 × 2.3 — sub-pixel even at full size. Both housings, and the handle furniture
they clamp to, are drawn at **2.5×** that: one factor for all of them, every
proportion within and between the parts held to the mesh. `illDoor()` is the one
*diagram* among the four renders rather than a scale drawing of an object, which
is what makes that affordable there and nowhere else.

These are also the first housings that are not white PETG — the reed's two halves
are printed black, the MPU6050's is light grey — so `layerLines()` now takes a
colour, because on a black housing the photographed lines are ridges catching
light rather than shadow. The reed capsule in its window, the two fixings and the
white twin-core leaving for the trunking above the head are photograph work, not
mesh, exactly as the lamp's frosted panels and lens are.

The diagram is drawn at 74 px on Home and, since this pass, at full size on
**Camera → The door → Sensors** — the only place the detail is visible at all.
Both assemblies are `.fine` / `.dtl` / `.tex`, so the thumbnail keeps the door and
drops the hardware, and the three stat tiles under the full-size one are the
three rows below it rather than a fourth reading.

#### A setting drawn as the thing it sets

The twenty-sixth pass is the door's three thresholds — handle tilt, swing rate
and handle lookback — which decide whether an opening is read as coming from
inside or from outside, and which the panel had been showing as a stepper and a
slider each. "12 degrees of handle tilt" and "2500 ms of lookback" are not
guessable from a number, and the drawing that explains them was on a different
page.

So `illDoor()` was split into its parts — `doorGeo()` plus `doorLeaf`,
`doorHandle`, `doorSwingArc`, the two reed halves and the gap — and three tuners
on **More → Devices → Interior portal** compose the same parts rather than a
second drawing of the same door. The split is a pure refactor: `illDoor` renders
byte-identically for all sixteen states at both sizes, which is the check worth
re-running if any of those parts is touched again.

- **Handle tilt** is the identity case, and the reason this is worth doing at
  all. The drawing already turns the lever with `rotate(deg, rose)`, and that
  `deg` *is* the entity's unit. Drag the lever; a ghost stays at rest so the
  angle reads as a difference, and the live tilt sits on the same arc as a needle.
- **Swing rate** does not pretend position on the arc is how far the door has
  opened — a rate is not an angle. The arc is relabelled as a rate axis and
  carries the firmware's actual two-sided gate: **still**, where a lever press is
  allowed to register, and **moving**, where it is discarded as swing error. The
  toned band is the one that grows with the number, so dragging towards "more"
  fills more track. The sentence converts the rate into a time a person has —
  how long a right-angle swing would take at exactly that rate.
- **Handle lookback** is the one the door's geometry genuinely cannot carry: a
  window in milliseconds has no representation in a plan view of a door. It gets
  a time axis instead, in the same materials, with the reed gap's own tone mark
  standing at t = 0. The shading under 400 ms is not decoration — the firmware
  holds `handle_depressed` that long after the lever returns, so below it the
  window buys nothing. **No event trail is drawn**, because there is no event
  history to draw: `lever_onset_ms_before_open` lives only in a transient
  `esphome.door_opened` event and is never stored, and inventing a "typical
  opening" would be fiction on a tuning screen.

`tuneStage()` joins the component list in §6. Three rules hold it to the rest of
the panel:

1. **The picture is an addition, not a gate.** Every tuner keeps a `numberCtl`
   stepper under it (`opts.bare` drops only the range input), so there is always
   a precise, keyboard-reachable, screen-reader-correct path to the same number.
   Arrow keys, Home and End work on the picture itself, which carries
   `role="slider"` and its `aria-value*`.
2. **The write path is unchanged.** A drag resolves to the same
   `setNumber` / `setEntityNumber` action the slider called, debounced through
   `_queueNumber` exactly as the colour wheel's is through `_queueLight`, and
   flushed on release so the last position always lands. No entity, no service
   and no automation was added.
3. **Bounds are the entity's own**, read from its HA attributes. The fallbacks
   are the firmware's real limits rather than a generic 0–100, so a missing
   attribute degrades to a correct gauge instead of a nonsense one. `preview.html`
   had been stubbing all three ranges wrong; it now matches
   `esphome/portal-unit.yaml`.

The twenty-seventh pass does not change what the pictures are. It changes the
words under them, and when a finger is allowed to move the number.

The titles stay — Handle tilt threshold, Swing rate threshold, Handle lookback —
because those are the entity names a technician already knows. The sentences
under them no longer talk like firmware. *Leaf*, *reed*, *IMU*, *swing error*,
*off its rest* and *bought by this setting* are gone; each control still says
the one thing a household member needs: whether an opening is counted as coming
from inside. The card hint is that sentence once, so it does not have to be
repeated three times.

A vertical phone scroll over those pictures used to both block the scroll and
jump the setting, because `.tune` claimed every gesture (`touch-action: none`)
and `_onTuneStart` wrote a value on pointerdown. The twenty-seventh pass made
touch wait for a drag past 12 px and abort a mostly-vertical first move. The
**thirty-first** pass replaces that slop: each tuner carries a lock (locked by
default). A locked drawing does not claim the gesture at all; an unlocked one
arms on pointerdown the way the mouse already did, with no 12 px wait and no
vertical abort. Only one drawing is unlocked at a time. Leaving the page locks
them again. An unarmed tap or a scroll over a locked drawing does not
`_queueNumber`. The stepper underneath is still the precise path, locked or not.

These are controls rather than renders, so they carry the one thing a device
drawing may not: chrome. Axis labels and readouts are `--g-faint` / `--g-text`,
because there it is the panel talking rather than the door. The door inside them
keeps the render rule unchanged — `--ill-*` material, `--tone` for status, and
nothing else.

#### The lamp's numbers

The twenty-eighth pass is **More → Lamp**, which ended in three cards of bare
numbers. "Dark below 45" does not tell a household member whether their own
doorway is dark enough for the lamp to come on. "42.3°" does not say whether
that is dusk or noon. "30m" does not say when the sun will overrule a stuck
camera. Those are also the first three things a technician wants at 22:00 when
the lamp is wrong, and until this pass the only way to get them was Developer
Tools.

Unlike the door's three, two of the lamp's are not independent.
`guardian_dark_threshold` and `guardian_bright_threshold` are one hysteresis
band, and **the gap between them is the setting** — it is what stops the lamp
flickering. Drawing them as two sliders that never mentioned each other was the
thing that made them unreadable, so they became one instrument.

- **The light level band** is a luma axis from 0 to 255 with two thumbs. The bar
  under it is a brightness ramp, black at 0 and frost at 255: that mapping is the
  identity, the same argument that made the handle lever legitimate. It is not a
  metaphor for brightness, it *is* brightness. The region where the lamp comes on
  is painted in `--lampc`, the lamp's own light — the one place in the panel
  where that colour is the literal subject. The gap is hatched and labelled *no
  change*. Both handles carry a heading, because "45 … 90" with no headings is
  anonymous, and crossed over it is worse than anonymous.
- **Rotate still** is the crop, drawn. The sampler turns the JPEG
  counter-clockwise and *then* keeps the bottom 60 %, so the only question the
  setting answers is whether the doorway ends up inside that crop. The frame
  itself changes shape with the value, because a quarter turn of a landscape
  still is a portrait still. At 90 the floor is inside the box; at 0 the
  stair-void window is, and the floor is not — which is exactly the fault F-57
  was about, visible without reading F-57.
- **The sky** is a protractor: a horizon, an arc ramped from day down to night,
  the sun standing at its real elevation with a line back to the pivot so the
  angle reads as an angle. It has no handle, because `sun.sun` is status.
- **The sun-mismatch clock** is the one lone scalar duration in the panel that
  earns a drawing, against §6's rule. A bare minute count would not; this one is
  not bare. `guardian_lamp_mismatch_since` means the axis can carry how long the
  disagreement has *already* run against the point where it fires, so "how long
  until Guardian steps in" is readable at a glance. When the clock is not
  running the elapsed bar is simply absent.

**Measurement mode is categorical, so what is drawn is ownership, not a third
slider.** Manual uses the two numbers below it; Auto-calibrate with a ready
profile uses the pair it learned and leaves those two untouched; Auto-calibrate
that is still learning uses **neither**, and the camera is not consulted at all
until the profile passes. Three small meters show `n_night` / `n_day` / `tiles`
against the gates that are exposed as attributes, and say in words that those
are necessary rather than sufficient — the calibrator also wants the samples
spread over hours and a big enough day/night gap, and neither is an attribute.

**`lampVerdict()` is the sampler's decision tree, ported read-only.** It mirrors
the `decision:` variable in `scripts.yaml` → `guardian_sample_ambient_light`,
writes nothing, calls nothing, and cannot start a sample. The YAML is the
authority: if the two ever disagree, the YAML is right and the port is the bug.
A card asks it a question and prints the answer in the household sentence from
the existing `LAMP_DECISION` map. In **Now** the question is the real reading
and the real sky, so dragging a threshold moves the answer under your finger. In
**Try a reading** it is two numbers held in `this._ui` and nowhere else, and both
drawings above grow a second, dashed mark so a hypothesis always looks like one.
The card resets to Now on navigation, for the same reason.

**Porting the tree turned up a threshold nobody had written down.** `off_camera`
carries `not (sun_elev < -3)` — `scripts.yaml:1936` — and every document
describes only −6 and +10: `DEPLOY.md`'s seventh pass, audit F-38 and F-55 alike.
It means a *bright* reading with the sun between −6° and −3° is neither an
override nor an accepted "bright"; it falls through to `hold`. The sky arc
carries a hairline there and the card says it in a sentence, because a drawing
of the tree that stopped at −6/+10 would be a drawing of the documentation
rather than of the system.

What was refused:

- **No photograph.** The rotate frame is a schematic and reads as one. There is
  no snapshot for the panel to overlay, and a drawn doorway presented as the
  real crop would be a lie on a tuning screen.
- **No sample trail.** `luma-samples.jsonl` is not reachable from the panel and
  nothing else stores a history, so the band carries one mark: the live
  luminance if it is numeric, otherwise the `luma=` of the last decision, and
  the sentence says which of the two it is. `sensor.guardian_camera_luminance`
  is unavailable between samples by design, so the fallback is the normal case.
  A "typical dusk" curve would be fiction.
- **No ghost of the learned pair on the band.** It was drawn for one revision
  and taken out. In Auto-calibrate the learned numbers are what decide, and a
  faint mark beside a solid one says the opposite: it makes the pair in force
  look like an afterthought and the parked pair look live. Which pair is in
  charge is a sentence, and it is said as one.
- **No simulated clock.** The what-if does not fake an elapsed mismatch. That
  depends on wall-clock history, and inventing it is the same class of fiction as
  a sample trail. It names the sun-expected state instead, which is the part the
  tree actually computes.
- **No new helper, sensor, service or automation.** The gates the calibrator
  checks but does not publish are described in words rather than invented.

Two rules from the twenty-sixth pass needed extending rather than repeating.
`role="slider"` carries exactly one value, so a two-thumb tuner is a
`role="group"` whose thumbs are each an SVG node with `tabindex`, its own
`data-tunearg`, its own bounds and its own `aria-value*` — focusable and
arrow-keyable where they sit. And `_paintTune` used to find the stepper by
position (`nextElementSibling`); with two steppers under one drawing it now
matches by entity id.

The tone is still the model's to pick. An inverted band — `dark >= bright`, where
the sampler refuses every camera branch — is a fault, so the whole instrument
goes to the alarm tone through `toneName`, the lamp-on region empties, and the
hatch takes the entire axis under the words *nothing here decides anything*.
No status colour is baked into a path.

`preview.html` gains fourteen lamp scenes as a debug gallery — night dark, day
bright, the gap at night and by day, the sun override, the −3 dead zone, the
clock running and the clock having fired, Auto learning and Auto ready, inverted
thresholds, rotate 0, sampling live, and nothing measured yet. Each is a state
the sampler can really be in, so every verdict the page prints can be checked
against the tree by hand.

#### Ids are namespaced, not avoided

The previous rule was "no `id`s at all", because the same drawing can appear
twice on one screen. `idns(kind, size)` derives a namespace instead
(`g-portal-sm-body`), which is deterministic — no counter that changes between
renders — and safe by construction: the panel is a shadow-DOM element that swaps
a single `[data-view]` host, so one view is in the DOM at a time and no drawing
repeats at the same size within it. `scratchpad/idcheck.mjs`-style verification
covers the worst case (every drawing at both sizes in one document: 92 ids, no
duplicates, no unresolved references).

#### Colour discipline, unchanged

A drawing knows exactly two colours it did not choose: `--tone`, the status tone
the model already picked, and `--lampc`, the lamp's own light, read from the same
`light.*` attributes the colour wheel writes — so the drawing and the control
cannot disagree. Everything else is `--ill-*`, which is *material*, not state.
Gradient **stops are tokens**, so dark mode inverts with the scheme. No status
colour is baked into a path.

The portal's screen carries the live status sentence, because that is what the
real screen at the door is showing; it is white type on a tone-tinted backlight,
which is what the hardware does. The Home rack renders the same drawings small
by dropping the layers that would be sub-pixel at 74 px — `.fine`, `.dtl`,
`.tex`, `.spec` — and keeping the form gradients, which is what makes a thumbnail
still read as an object rather than as a second, simpler copy.

### Device presentation

Renders alone were still pictures dropped into cards. Three components carry
them, all of them presentation over state the model already builds — no entity,
service call or automation was added:

- **`DEVICE`** — one registry of what the devices are called, which mdi icon
  stands for each, their role eyebrow ("Inside the door", "Above the door") and
  their page. The Home rack, the gallery, the flow diagram and every nav row read
  from it, so a device cannot be named or iconed two ways.
- **`deviceCard()`** — the render placed on a lit well with its own contact
  shadow, then eyebrow / name / live sentence / chips, on a 3 px tone edge.
  Tapping it opens the device page.
- **`sysFlow()`** — the signal path, in two rows: **getting in**
  (doorbell → portal → door) and **watching** (camera → Guardian → lamp). A link
  lights only while it is carrying something — a press, an open passage, a person
  in view, a lamp verdict — which is the only reason drawing it is worth
  anything. It never wraps: a chain that wraps stops being a chain.

`devStage()` gained a floor and a three-tile stat strip (signal / uptime / the
one live signal that device has), so a device page answers "is it alive, how
well, and what is it doing" before the first row of controls.

**More → Devices** is now the gallery: the flow, then three cards — portal,
doorbell, and door lamp & camera, which was reachable at More → Lamp but had
never been listed as a device. Home keeps its four health cells, the same
entities and the same tap-through to more-info, restyled to the same language.

### Motion

Motion is used where it carries information, and lightly where it confirms a
tap: the countdown ring sweeps at 1 Hz, the alarm status bar may pulse slowly,
press-and-hold buttons fill as they confirm, and buttons / nav rows / switches
shift colour (and scale slightly) on press. Cosmetic idle pulse and glow are
gone. `prefers-reduced-motion` disables all of it.

The twenty-first pass added four more, all declared in one keyframes block near
the top of the stylesheet so "does this panel move more than it did?" is
answerable by reading one place:

- **Entrance stagger** on the view, and the tab bar's sliding indicator. The
  stagger fires on **navigation only** — `_enterSeq` is bumped by `nav` and
  `back` and by nothing else, so an alarm arriving does not restage the page
  under whoever is reading it.
- **A status LED heartbeat** on a device drawing, and only when that device has
  something pending. An idle LED is steady. The twenty-fourth pass removed the
  portal's LED — this build was printed without the optional one — so this now
  applies to the door diagram, where the twenty-fifth pass moved it off the
  anonymous jamb box and onto the reed's gap, the one dimension that actually
  changes. The portal expresses a pending state through its drawn screen, which
  is what the real screen at the door is doing anyway.
- **A detection ping** at the lens: two rings that expand and stop. The element
  exists in the markup only while a person is in view, so it plays on arrival
  and never loops in the background — and it is a ring in the warn tone, not a
  full-screen wash, because live is not alarm.
- **A doorbell chime tilt**, two iterations, while the button is pressed.

Nothing animates merely because it is on screen.

### Layout

Phone / HA overlay (`home-assistant-main[narrow]`): top bar (HA sidebar menu,
plus Back when nested), compact status, scrolling body, four bottom tabs.
The host fills the Home Assistant panel and only the inner scroller moves;
the tab bar stays on screen. Safe-area padding is on every chrome surface,
including nested headers and the hold-to-reset region above the tab bar.
Below 520 px of *panel* width the status bar stacks the ring above the
sentence, so a four-word title is never squeezed beside it.

HA sidebar always hidden: Guardian's hamburger stays (it is the only way to
open Overview / Settings). The four destinations use the left rail when the
panel is at least 900 px wide, otherwise the bottom tabs.

Docked HA sidebar, collapsed to icons: left rail, no Guardian hamburger.
HA's own menu button is enough.

Docked HA sidebar, expanded: left rail when the remaining panel is at least
900 px (typical desktop). Bottom tabs and no Guardian hamburger when it is
tighter than that (iPad-class, split view, a small browser window). Nested
pages show an in-content Back whenever the top bar is hidden.

Content column is ~720 px (camera may use more). Groups, health cells and
the key-slot grid follow panel width via container queries, not the
viewport, so an expanded HA sidebar does not leave two cramped columns.

There is no CSS multi-column deck. Groups stack in DOM order. Health cells
and the key-slot grid are ordinary CSS grids.

---

## 5. The rules this file lives under

These are not conventions. They are enforced by the structure of the code, and
`GUARDIAN_AUDIT.md` §17.4 records the assertions that check them.

### Security boundaries: what these rules are, and what they are not

Read this before the rest of the section, because it changes what they mean.

Everything below is **blast-radius discipline**, not authorization. The rules
bound what *this file* can do — no PIN field, no credential rendered, no write
to a slot hash, no `guardian.major_alarm`, press-and-hold in front of anything
destructive — and they hold. What they do not do is stop the person holding the
panel from doing those things by another route.

**Guardian's outer authorization boundary is the Home Assistant login.** The
panel is `require_admin: false` on purpose, so a household member who is not an
administrator can use Keys and Notifications. Home Assistant still has **no
general per-service ACL**. Anyone with an account can still reach Developer
Tools and write `input_text.portal_pin_hash` or fire `guardian.major_alarm` —
none of which this panel will do for them. Handing out administrator remains
the outer gate.

On top of that login, Guardian now **binds RFID slots to Home Assistant user
ids** (`input_text.rfid_N_ha_user_id`) and enforces the mapping on the mutation
scripts, using `context.user_id`. Empty roster helpers
(`input_text.guardian_ha_admin_ids` / `guardian_ha_user_ids`) are
single-account mode: today's behaviour, zero extra setup. A second account
cannot edit someone else's key name, notify prefs, or mute, and cannot arm
enrollment, PIN-change, reset, or Super Surveillance programs. Device and
automation callers (`context.user_id` empty) stay allowed — that check is never
in front of an alarm.

HTML sinks in this file are a blast-radius rule of the same kind. `note(text)`
always runs `esc()`. Trusted markup (static `<b>`, already-escaped entity ids)
goes through `noteHtml`. `row(title, sub, right)` escapes `title` and `sub`;
`right` stays HTML because that is where switches and pills live. Pass
`{ subHtml: true }` only when `sub` is already composed from `esc()` pieces.
`card()` escapes `opts.hint`. A key display name in `note()` used to be stored
XSS in this landing page; that is why the default is escape, not convention.

So the honest statement of the model is:

* **One Home Assistant account is still full control**, until you add a second
  user and an administrator opens Guardian once (roster refresh) and links a
  key. A lodger with a login and no linked key cannot edit assigned keys from
  this panel or from `script.guardian_*`; they can still write helpers from
  Developer Tools, which is Home Assistant's model.
* The press-and-hold on a destructive control is protection against a **stray
  tap**, which is a real hazard and the one it was designed for. It is not
  protection against a person who means it.
* The per-slot notification settings (§ *Notification preferences*) are still
  **storage** on the slot. **Permission** is now the `ha_user_id` mapping:
  Notifications rows and writes are only for slots that person may edit.
* The value of the rules below is that the **blast radius of this file is
  auditable by reading one function** — `ACTIONS` lists every service call the
  UI can make. Slot notify/name/stolen/enrollment writes go through
  `script.guardian_slot_write` and `script.guardian_set_house_mode` so
  Developer Tools `script.guardian_*` is refused too. Direct helper writes are
  still HA.

None of this is a defect in the panel. It is a property of running a household
security system on Home Assistant's account model, and it is written down here
because a reader who mistook the care below for a complete permission system
would give out logins they should not.

### It contains no business logic

The panel reads entity state and calls existing services. That is the whole
contract. It makes no decision about when to alarm, what elevated mode means,
which slot to enroll into, or how the lamp should behave. Every one of those
lives in `automations.yaml`, `scripts.yaml` and `packages/*.yaml` and is
reproduced here only as *presentation* of state the system already publishes.

No automation or script was added *only* for the panel's benefit. Person names
(`input_text.rfid_N_name` and the enrollment session helper
`input_text.guardian_enroll_pending_name`) live in `packages/guardian_rfid.yaml`
because occupancy, notifications, the Keys page and the interior portal all
need the same label. `sensor.guardian_presence_roster` and
`sensor.guardian_rfid_key_labels` exist so the portal display can draw names
without assembling strings on the ESP32. Where something could not be displayed
cleanly, that is written down (§7 below and audit F-57) rather than papered
over with a new entity.

### No PIN, ever

`input_boolean.guardian_pin_change_mode` is armed here as a **mode and nothing
else**. The current and new PIN are still typed on the portal keypad, exactly as
the tenth pass designed. There is no `<input>` anywhere in the file that could
accept a PIN, and no call site for `script.guardian_set_pin` or
`guardian_verify_pin` — those take a PIN as an argument and stay in Developer
Tools, where that is visible for what it is.

### No card_id or hash, ever

`input_text.rfid_N_card_id` is read for **length and hex shape only** — 16
lowercase hex characters means occupied, the same rule
`packages/guardian_rfid.yaml` uses. `input_text.portal_pin_hash` is still
length-64. The values are never rendered.

### Internals are read-only

Class C entities from audit §17.1 — the pending slots, the display state and
sequence, the challenge origin, the fail counters, the lamp's internal marks —
appear under More → Internals as read-only rows. Tapping one opens Home
Assistant's own more-info dialog. The escape hatch is deliberate: the claim is
"not here", not "nowhere".

### Destructive actions are press-and-hold

Reset, silencing an alarm, removing a card, flagging a card Stolen/Lost and
rebooting either device all require a deliberate press-and-hold. The fill
animation *is* the confirmation; releasing early cancels.

Two visual weights, deliberately. The alarm status bar and the reset page use
the loud red variant, because there the colour *is* the message. The per-slot and
per-device controls use `subtle`, which keeps the coloured fill but drops the
coloured resting state: a row of occupied key cards each carrying two full-red
buttons turns the key rack into a wall of alarm for controls that are merely
occasional. The hold is what gates them, not the paint.

One exception, and it is a different gesture rather than a weaker one:
**Delete program** on More → Security opens a confirmation sheet ("Delete
&lt;name&gt;?", Delete / Cancel) instead of a hold. A hold is the right shape
for a control whose danger is a stray tap on a phone in a pocket; it is the
wrong shape when the thing being deleted has a *name*, and the user needs to
read that name back before agreeing. So `_ui.sheet` grew an optional
`confirm: { label, act, arg }` — with it the sheet renders that action plus
Cancel, without it the informational single-Close sheet is byte-identical.
The confirm button uses `tone`, never `solid`: `.btn.solid` paints itself
`--g-accent` and ignores `--tone`, so a solid confirm would render a delete
button in the friendly green.

`script.guardian_reset` is Home Assistant-side only by design — a wall-panel
button would hand "cancel the live challenge" to whoever is standing at the
door. This panel is Home Assistant-side, so it may offer it, but it does not
make it one stray tap away either.

### The data log stays where it is

The Activity view does not read `/config/guardian_data_log.jsonl`, and the log
must not be relocated under `/config/www` to make it readable. `/local` is
served **without authentication**. See audit F-57.

---

## 6. How it stays maintainable

### Entity ids live in one place

A single registry block near the top of the file holds every entity id the panel
uses. Nothing below that block hard-codes one. A rename is a one-line change.

### Entities resolve by suffix when the id drifts

`resolve()` tries the canonical id, then declared aliases, then a longest-tail
suffix match within the same domain.

That exists because it already happened: Home Assistant renamed the doorbell's
entities to an `eisodos_` prefix, and the live config now carries two different
prefixes for entities on the same device (`binary_sensor.eisodos_smart_doorbell_doorbell_link`
alongside `sensor.smart_doorbell_doorbell_wifi_signal`). Every id on that device
still *ends* in `smart_doorbell_doorbell_<thing>`, whatever gets bolted on the
front, so suffix matching survives the next rename too.

### The rack is read at runtime

Slots come from `sensor.guardian_rfid_slots`, looped exactly as every script and
automation in this system loops it. The RFID package pre-declares slots 1–9
(the keypad cap). The panel shows **people**, not empty rack indexes: Home and
Keys list occupied keys, labelled from `input_text.rfid_N_name` (falling back
to `Key N`). **Add a key** turns enrollment on; **Hold: delete this key** runs
`script.guardian_clear_rfid_slot`. That is how keys are added and removed —
not a YAML edit, and not a hidden “enrollment mode” toggle.

Each occupied key's **Alerts go to** selector carries a **Send test alert**
button, disabled while the selector reads none. It calls
`script.guardian_notify_test`, which wraps `guardian_notify_person` — the
panel never builds a `notify.*` target itself, and the closed-set check stays
where it already was. The sheet afterwards reports the script's own verdict
rather than assuming delivery, and reports *which* failure: a key with no
phone picked and a key whose picked phone is no longer registered are two
different problems, and calling both "no phone linked" sent a household
looking for a setup mistake that was not there.

Picking a phone goes through `setNotifyTarget`, not the generic `setSelect`.
It waits for the select to actually read back the value: `select_option`
rejects an option that is not in the list, and a fire-and-forget write left
the browser showing a phone Home Assistant had never accepted — with the
re-render skipped, because the view HTML had not changed. Picking **Not
linked** also clears `input_text.rfid_N_notify_saved`, since the persist
automation deliberately ignores every fall to `none` (that is how Home
Assistant fail-safes a select whose phone vanished, and mirroring it destroyed
the only copy a restart could restore from).

Below **Alerts go to**, each key card carries a **Notifications** row into that
person's own preferences page (`personAlerts`, whose `parent` is `keys`, so
Back returns to the card rather than the More index). Which person it is
travels on the nav arg and lands in `_ui.alertsSlot`; there is no URL for a
nested page here, and inventing one for this screen alone would have been the
odd case out.

The screen edits those two helpers through `script.guardian_slot_write`, and
nothing global. A person here *is* still a key slot — preferences hang off the
same slot as their name and their phone — and the panel now also reads
`hass.user`. Two people in one household hold independent settings, and one
person's choices never move another person's.

Storage is still per-slot. Permission is the mapping: `viewPersonAlerts`
refuses a slot the logged-in user may not edit, non-admins do not see Hold:
stolen / delete / reset, and the scripts fail closed on the write. Direct
`input_select.select_option` from Developer Tools is still Home Assistant's
model. See **Security boundaries**.

The level control is `seg`, but the six category switches are `sw` with an
`act` override, because they are not booleans: they are members of one
comma-separated helper. `setNotifyCategory` therefore re-reads the live helper
at the moment of the tap rather than trusting the value the row was rendered
with — two quick taps against a stale snapshot would have the second write undo
the first, which reads as a switch that will not stay off. It also writes only
tokens the panel knows, in a fixed order, so a hand-edited helper is normalised
rather than preserved.

Two pieces of copy on that screen are load-bearing and should not be softened.
The first states that alarms, stolen cards, and tamper always come through even
at **Off** — that is enforced in `scripts.yaml` by an explicit `nonmaskable`
field at those call sites (tamper via `guardian.major_alarm`), and a screen that
let someone believe otherwise would be worse than no screen. The second is that
**Send test alert** ignores
every setting on the page; a test that a muted category silently ate would look
exactly like a broken phone link.

The house-level **Notifications** page keeps the delivery plumbing and gains a
*Who gets what* list linking to each person's page. The settings themselves are
deliberately not duplicated there: that page is opened by whoever happens to
have the panel, and a grid of everyone's switches on one screen is precisely
the global control this feature replaced.

The key card itself is group chrome with a tone edge, a header band carrying
the avatar, the name and the state pill, a body of **labelled** fields, and one
action grid at the foot where **Send test alert** and **Hold: stolen** share a
row at equal height. The card is its own CSS container, so that pair collapses
to one column on the *card's* width — the panel-level query cannot see it once
the rack goes two-up at 620 px.

Super Surveillance programs follow the same rule one level further. The rack
is `sensor.guardian_ss_programs` (capacity, still four); what the panel
**lists** is `sensor.guardian_ss_programs_created`, and `buildSsPrograms`
iterates only that — which is why `ssNowLine`, `ssHomeSummary` and the Home
pill needed no change to stop counting programs nobody made. **Create
Program** runs `script.guardian_create_ss_program`, **Delete program** runs
`script.guardian_delete_ss_program`. The panel does not decide which position
is free and does not write `_created` itself; both are the script's job, for
the same reason enrollment is.

### Adding a control

1. Add its entity id to the registry block (`const E = { … }`).
2. Render it in a view with the existing components: `row`, `navRow`, `pill`,
   `btn`, `holdBtn`, `sw`, `seg`, `numberCtl`, `tuneStage`, `illStage`,
   `textField`, `card`, `note`. A number whose meaning is physical — an angle, a
   rate, a window — may be worth a `tuneStage`; a lone scalar duration is not,
   and a plain `numberCtl` is the honest answer there. The one exception so far
   is the lamp's sun-mismatch clock, which earns a drawing only because the
   panel also knows *when the disagreement started* and can therefore show
   elapsed against the bound rather than a prettier minute slider.
   Two numbers that are really one setting — the lamp's dark and bright
   thresholds, whose gap is the thing being chosen — take one `tuneStage` with
   two thumbs, not two tuners: pass `null` for the entity and give each thumb
   its own `data-tunearg` via `tuneThumb`-style markup, because `role="slider"`
   carries one value and the container becomes a `role="group"`.
   A drawing that is status rather than a setting — the sky, because `sun.sun`
   is not writable — goes on an `illStage`, which is the same materials and
   padding without a gesture or a cursor.
3. If it needs a service the panel does not already call, add one entry to
   `ACTIONS` and one `case` to `_act`. Those two lists are the panel's entire
   blast radius, and keeping them exhaustive is what makes that auditable by
   reading a single function. A control that only changes what the panel is
   *showing* — `lampTone`, and the lamp page's `lampWhatIf` / `lampProbe` —
   adds a `case` that mutates `this._ui`, calls `_schedule(true)` and returns
   before any `callService`. That early return is the whole guarantee.

If the new thing is internal state, add it to `INTERNALS` instead — that renders
it read-only, which is almost always the right answer.

### Rendering rules

Home Assistant assigns `.hass` on every state change — several times a second in
a busy house. Three rules keep that cheap and non-disruptive:

1. Render is `requestAnimationFrame`-debounced and compares the produced HTML
   against the last write. Identical output is never written to the DOM.
2. A focused text field suspends the view rewrite until it is blurred, so a
   state change elsewhere cannot eat what someone is typing. The status bar is
   never suspended — that is where an alarm would appear.
3. The countdown ticks at 1 Hz by writing two nodes directly, never by
   re-rendering. A running camera stream (`ha-camera-stream`, falling back
   to MJPEG) and the scroll position both survive a live challenge.

### Cache

`/config/www` is served as `/local` with long cache headers. Bump
`GUARDIAN_UI_VERSION` in the panel **and** both `?v=` query strings in
`configuration.yaml` (`module_url` and `extra_module_url`) in the same
commit. If an update does not appear, that is almost always why.

### Checking a change without a Home Assistant

This repo has no test suite and cannot be run locally — but the panel is the one
piece of it that *can* be exercised offline, because `hass` is a plain object.
Two techniques, both worth reaching for before deploying a change:

**Import the module in Node** with `HTMLElement`, `customElements`,
`localStorage` and `requestAnimationFrame` stubbed, append an `export` of the
view functions, and call them against a hand-built `hass` — a `states` map of
`{entity_id, state, attributes, last_changed}` objects. Every view is a pure
function of `(model, hass)` (and `ui` where the camera or timeline needs it), so this catches exceptions, missing entities, and
`undefined` / `NaN` leaking into rendered copy. Worth asserting the security
invariants there too: no 64-character hex in any output, no `type="password"`,
no `data-act="reset"` (only `data-hold="reset"`).

**Render it in a browser.** Serve `www/guardian-ui/preview.html` from that
directory (it stubs `hass` and `<ha-icon>`). Phone / iPad / landscape /
desktop / wide frames, a fake HA sidebar (overlay, collapsed, expanded),
light and dark, and a few house states are on the toolbar. Live camera, MQTT
and service calls still need a real Home Assistant.

It must be **served**, not opened by double-clicking. The harness reaches the
panel through `import('./guardian-panel.js?v=…')`, and a browser refuses a
module import from a `file://` origin, so opening the file directly gives a
blank stage and one CORS line in the console rather than an error on the page.
Any static server in that directory will do:

```
python -m http.server 8777
```

Neither replaces `DEPLOY.md`'s live verification steps. They just make it cheap
to be wrong in private first.

---

## 7. Known limits, stated rather than hidden

**Historical rejected cards, door-direction verdicts, presence corrections and
Frigate MQTT detections are live-only.** They are fired as `guardian.*` /
`esphome.*` events, not entity states, so the recorder has nothing to replay.
The panel subscribes to them while it is open; rows for those categories start
when the panel is opened. Everything that *is* an entity state — door
open/close, presence, alarms with their reason, challenges, sessions, lamp
verdicts, faults, connectivity, and a Frigate person-occupancy binary sensor
when the integration has published one — is genuine history. Full reasoning,
and why the obvious fix (moving the JSONL log under `/config/www`) is wrong,
is audit F-57.

The eleventh-pass Activity copy claimed Frigate rows arrived as live
`guardian.*` events. They did not: `LIVE_EVENTS` had no Frigate type, and the
Data Log automation wrote JSONL without firing a HA event (audit F-58). The
twelfth pass fires `guardian.person_detected` `{ camera, type, label }` from
that existing automation so non-admins can see detections while the panel is
open. If Frigate is still not publishing MQTT, the Camera tab says so rather
than pretending a camera key is a video feed.

**Frigate live video is discovered, not assumed.** The large preview uses
`input_text.guardian_camera_entity` when it names a live camera. If that helper
is empty, `none`, or still the old default `camera.tapo_c110`, and
`camera.door_camera` exists, live view uses `camera.door_camera`. Lamp
measurements keep reading the helper as stored until Save. Fallback:
`panel_custom.config.camera` (now `camera.door_camera`) when that entity
exists. A leftover Tapo id is a migration sentinel, not a requirement.
If a Frigate camera / occupancy / person-image entity exists for
`input_text.guardian_frigate_camera_name`, the Camera tab can switch to it.
Clips are shown only when `media_source://frigate` browses successfully.
Otherwise the panel offers a sidebar deep-link when `hass.panels` (or
`config.frigatePath`) names Frigate, and tells the truth when none of that
exists.

**Lamp colour is a manual override.** More → Lamp exposes brightness, a hue
wheel, white temperature and presets via `light.turn_on`. Ambient sampling
still owns on/off. Automations and scripts consume
`sensor.guardian_lamp_entity` (closed-set discovery of `light.*`, persisted
through `input_select.guardian_lamp_target` / `input_text.guardian_lamp_saved`).
More → Install is the picker. `config.lamp` is only a panel fallback.

**Add a key / delete a key are named buttons.** More → Keys & PIN: **Add a
key** turns enrollment on; the session card is titled **Adding a key**,
with a live name field and **Cancel**. Status and the session card both say
name (optional) first, then present the card; once a name is saved, status
shifts to **Present the card**. Off Keys & PIN, status offers **Name the
key** and **Cancel**; on Keys & PIN the form’s **Cancel** is the exit (no
redundant Keys / Cancel in the status bar). The name is flushed to
`input_text.guardian_enroll_pending_name` on debounce, blur, and when the
page is hidden (phone lock / app switch), and the field shows Saving… /
Saved rather than claiming persistence without a write. Each registered
key has **Hold: delete this key**. The Home shortcut reads “Add or delete
keys”. Enrollment mode is still the mechanism; it is no longer the label.

**Enrollment slot targeting and the next-key name write class C session
helpers.** These are the documented exceptions, argued in audit §17.1 and §24.
The panel writes `input_text.guardian_enrollment_slot` and
`input_text.guardian_enroll_pending_name` only while enrollment mode is on, and
does not restart `timer.guardian_enrollment_window` as a side effect the way
the keypad path does — that is an explicit "Keep open" button instead.
`process_rfid_scan` copies a non-empty pending name onto the new (or
re-tapped) key and only clears pending after that write reads back.

**`sensor.guardian_camera_luminance` reads `unavailable` almost always.** That
is correct and documented in `packages/guardian.yaml`: it only produces a
reading during an active sample. The panel labels it as such rather than
reporting a fault, which is the same mistake the `LUMA` fault clause made before
F-40. Since the twenty-eighth pass the light-level band falls back to the
`luma=` of the last decision when the sensor has nothing, and names which of the
two it is showing; with neither, it draws no mark at all rather than a zero.

---

## 8. File map

| Path | Role |
|---|---|
| `www/guardian-ui/guardian-panel.js` | The panel. Deploys to `/config/www/guardian-ui/`. |
| `www/guardian-ui/set-default-panel.js` | One-shot admin write of system `default_panel: guardian`. Loaded on every page via `frontend.extra_module_url`. |
| `configuration.yaml` | `panel_custom:` block registering the panel; `frontend.extra_module_url` loading the landing-page helper. |
| `GUARDIAN_UI.md` | This document. Not deployed. |
| `GUARDIAN_AUDIT.md` §17 | Entity classification, F-57. |
| `GUARDIAN_AUDIT.md` §18 | Twelfth pass, F-58. |
| `DEPLOY.md` eleventh pass | Original panel deploy, verification 64–73. |
| `DEPLOY.md` twelfth pass | Redesign deploy, verification 74–84. |
| `DEPLOY.md` thirteenth pass | Scroll, mobile menu, camera default, lamp colour, verification 85+. |
| `DEPLOY.md` nineteenth pass | RFID names, UI add/delete, portal KEYS roster, verification 117+. |
| `DEPLOY.md` twentieth pass | `ha-camera-stream` live view, HA sidebar hamburger, verification 127+. |
| `DEPLOY.md` twenty-ninth pass | System default landing page, verification 159+. |
| `DEPLOY.md` thirtieth pass | HA-aware nav chrome (one hamburger, rail vs tabs), verification 165+. |

Internal layout of `guardian-panel.js`, in order:

| § | Contents |
|---|---|
| 1 | Version and configuration defaults |
| 2 | Entity registry, aliases, the read-only internals list |
| 3 | Entity resolver and state accessors |
| 4 | Design tokens and the stylesheet |
| 5 | Formatting helpers |
| 6 | Model — `hass` states in, one plain object out |
| 7 | Actions — every service call the panel can make |
| 8 | Markup helpers and shared components |
| 8b | Device illustrations, and the four functions that map model to drawing |
| 9 | Views |
| 10 | Activity timeline: recorder history and the live event bus |
| 11 | The panel element: render loop, event delegation, action dispatch |
