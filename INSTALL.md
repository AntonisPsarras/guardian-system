# Installing Guardian

**This is the day-one guide.** It is the only document you need to read to get
from a fresh Home Assistant to a working Guardian System.

`DEPLOY.md` is the *upgrade* changelog — release notes written pass-by-pass,
explaining why each fix exists and how to verify it on a system that is already
running. It is not an install guide and reading it as one will send you looking
for helpers that no longer exist. Come back to it when you upgrade.

Guardian is not an add-on and not a HACS integration. It is a set of files that
go into `/config`, plus firmware for two ESP32 boards.

**Read this before you treat it as an alarm that will save you.** 2.32.5 is
*ready with documented caveats*, not ready. The caveats are:

- **The siren without Wi-Fi is written, compiled, unflashed and unheard.** Until
  you have flashed the portal and stood in front of the door while Home Assistant
  was unreachable and actually heard file 4, treat this system as having **no
  alarm if the network is down.** Cutting power to the portal still silences it:
  offline authority is RAM-only.
- **KiCad is in the tree; Gerber+drill zips are too.** Print files are the
  three `.3mf` profiles on MakerWorld / Printables. Send
  `PCBs/*/…-Gerbers.zip` to a proto fab. There is no pick-and-place / CPL
  file: these are through-hole boards you populate by hand. The lamp has no
  PCB (commercial bulb + camera). See §1.
- **The card master key lives in cleartext flash on the outdoor unit until you
  follow § Flash encryption.** Flash encryption and secure boot are **not**
  enabled in the shipped YAML. That burn is irreversible; a first encrypted
  flash over OTA would brick the board. Unscrewing the doorbell still yields
  the key that mints a credential for any UID.
- **Rotating that key bricks every enrolled card**, both NTAG and Classic, with
  no un-protect path. NTAG21x is the recommended medium; MIFARE Classic is
  clonable and the rolling counter flags whichever copy taps *second*.
- **This public tree is a fresh seed.** Early private commits contained a
  household LAN address and a camera RTSP URL. They are not in this history.
- **Preflight is static.** It does not fire an alarm or tap a card. After
  install you still run Home Assistant *Check configuration* and the numbered
  verify steps. One Home Assistant account is still full control until you add
  a second user and link a key (§ A second Home Assistant user). Tamper
  detection needs a **portal reflash**, then the three checks in §9 steps 15–17.

## Contents

- [The short version](#the-short-version)
- [1. Before you start](#1-before-you-start)
- [2. Secrets and credentials](#2-secrets-and-credentials)
- [3. Put the files in place](#3-put-the-files-in-place)
- [4. Check before you restart](#4-check-before-you-restart)
- [5. Run the setup wizard](#5-run-the-setup-wizard)
- [6. Finish what the wizard named](#6-finish-what-the-wizard-named)
- [7. Flash and adopt the devices](#7-flash-and-adopt-the-devices)
- [8. Frigate](#8-frigate)
- [9. Verify](#9-verify)
- [10. What leaves your network](#10-what-leaves-your-network)
- [11. Afterwards](#11-afterwards)

## The short version

Four commands and one restart. Each is explained in full below; if nothing goes
wrong you do not need the rest of this document until §6.

```bash
python tools/guardian-gen-secrets.py
```
```bash
sh tools/guardian-install.sh --config-dir /config
```
```bash
sh tools/guardian-install.sh --apply --config-dir /config
```

Then restart Home Assistant, wait two minutes, and read the **Guardian setup**
notification it leaves — `script.guardian_setup_wizard` runs itself and lists
everything still outstanding, by entity id. That list is §6.

The third command is the second one with `--apply`; running the dry form first
is worth the ten seconds, because it is the only chance to see what it will
touch before it touches it. Neither form overwrites a `configuration.yaml` you
already have — it prints the block to merge instead.

Three things stay manual no matter what, and §1 says why: the Frigate add-on,
flashing the two boards, and the handful of Home Assistant config flows that
have no YAML equivalent.

---

## 1. Before you start

Three things stay manual by design. Guardian does not attempt to automate any
of them and nothing below will do them for you:

1. **Installing and configuring the Frigate add-on** — cameras, zones,
   recording and detection are yours to set up. Guardian only consumes what
   Frigate publishes.
2. **Flashing the ESPHome firmware and wiring the hardware** — the readers,
   sensors, relays, lamp and doorbell.
3. **Copying this repo's files onto the Home Assistant instance** — Samba, SSH,
   the File Editor add-on, `git clone`, however you prefer.

Everything else is either automatic or reduced to one guided step.

### What must already exist

| | Why |
|---|---|
| Home Assistant, any recent release, with `/config` writable | Guardian is loose YAML in `/config`. |
| **Home Assistant Companion app**, installed and signed in on at least one phone | The only source of `notify.*` targets. Guardian cannot raise an alarm to anybody without one. Also supplies `device_tracker.*` for the optional phone-presence feature. |
| An **MQTT broker** (the Mosquitto add-on is the usual choice) and the **MQTT integration** configured against it | Frigate's person detection reaches Guardian over MQTT, not over the Frigate integration. Only needed if you want that alert. |
| A **camera** entity for the door | Live view, and every lamp luminance sample. Frigate provides one, or a native camera integration does. |
| **ESPHome**, to build and flash the two devices | See §7. |

You do **not** need HACS. Guardian's UI is a `panel_custom` served from
`/config/www` — there is no custom card to install and no Lovelace resource to
register.

### The hardware: print, optional PCB, then flash

Three devices sit on the door. Two of them have custom PCBs in this repository;
the lamp does not. KiCad schematic, board, and **Gerber+drill zips** are here.
There is **no pick-and-place / CPL file** — these are THT proto boards; a fab
makes the bare PCB and you solder the modules. An assembler who already has the
parts can also open the KiCad projects and hand-solder without the zip. The
firmware GPIO map below is still the authority, because the schematics use
generic connectors and auto-named nets, not `SDA` / `GPIO21` labels.

The CAD (3MF print profiles and KiCad) is MIT-licensed with the rest of this
repository. Meshes are not in this tree; download the profile for each device.

#### 1. Print the three `.3mf` profiles

Print as supplied, in PETG. Supports are already part of the models. Profiles
are on MakerWorld and Printables (collection **Guardian System**). Listing
URLs are in the README **Print files** table. Profile names and print notes:
[`3D-Models/README.md`](3D-Models/README.md). Step-by-step assembly photographs
and printable PDFs are in [`docs/documentation/`](docs/documentation/).

| Print | Profile | Parts inside |
|---|---|---|
| Interior portal | `Internal-Portal-Final.3mf` | Main-Body, Wall-Mounting, Display-Cover, Display-Housing, Keyboard-Housing, Speaker-Housing, Top-Screw-Cover, Door-Sensor-Housing1, Door-Sensor-Housing2, MPU-6050-Housing, MPU-6050-Housing-Cover. There is no portal Top-Cover. |
| Door reed | same portal profile | Door-Sensor-Housing1 (frame), Door-Sensor-Housing2 (leaf) |
| Handle IMU | same portal profile | MPU-6050-Housing, MPU-6050-Housing-Cover |
| Doorbell | `Doorbell-Final.3mf` | Main-Housing, Top-Cover, Wall-Mounting, Button-Panel, Cover-Holders-8x |
| Door lamp + camera | `Lamp-Final.3mf` | Main-Housing, Top-Cover, Top-Screw-Cover, Camera-Housing1, Camera-Housing2, Camera-Lock, Light-Cover-3x |

There is **no PCB for the lamp**. It is a commercial bulb (this house uses a
Tapo) in a printed housing, with a commercial camera whose lens sits in the
same print. Verify the camera's RTSP stream on the bench before you close that
housing — see below.

#### 2. Optional: PCBs, Gerbers for a proto fab

| Project | What it is |
|---|---|
| [`PCBs/Interior-Portal/`](PCBs/Interior-Portal/) | KiCad 10 schematic + board for the interior portal (ESP32-S3). Send [`Interior-Portal-Gerbers.zip`](PCBs/Interior-Portal/Interior-Portal-Gerbers.zip) to a fab. |
| [`PCBs/Doorbell/`](PCBs/Doorbell/) | KiCad 10 schematic + board for the doorbell (XIAO ESP32-C6). Send [`Doorbell-Gerbers.zip`](PCBs/Doorbell/Doorbell-Gerbers.zip) to a fab. |
| Door lamp | **No KiCad project, on purpose.** Commercial bulb + camera. |

Valued passives and the zip layer list: [`PCBs/README.md`](PCBs/README.md).
Soldering order with photographs: [`docs/documentation/`](docs/documentation/).

What is still missing, and why this is not a JLCPCB SMT job:

- No CPL / pick-and-place, no fab notes beyond `PCBs/README.md`. Hand-solder.
- Symbols are generic connectors (`XIAO_LEFT1` / `XIAO_RIGHT1`, `ESP_Left1` /
  `ESP_Right1`), not MCU symbols with GPIO names. Nets are auto-named
  `Net-(XIAO_LEFT1-Pin_1)`, not `SDA`.
- Several MCU pads are unconnected, which is expected for unused pins and is
  not by itself a defect.

Placed resistor and capacitor **values are in KiCad and on the silkscreen**:
doorbell R1–R3 220 Ω (LED), R4 10 kΩ (button); portal R1–R3 220 Ω, R4–R5 1 kΩ,
C1 1000 µF 10 V polarised.

What *was* traced against firmware, from the board file, without inventing a
silkscreen map: on the doorbell, `XIAO_LEFT1` pad 4 shares the button net,
pads 5 and 6 share the RFID header, and pads 1–3 are the RGB LED nets. That
lines up with firmware GPIO21 / GPIO22 / GPIO23 / GPIO0–2 **if** that header
is the XIAO's D0–D6 row (5V/GND/3V3 sit on `XIAO_RIGHT1`, which matches).
The portal board was not reverse-mapped pin-by-pin from KiCad text; use the
GPIO table.

#### 3. GPIO map (firmware is authoritative)

| Portal (ESP32-S3) | Pin | | Doorbell (XIAO ESP32-C6) | Pin |
|---|---|---|---|---|
| I²C SDA / SCL (MFRC522, MPU6050) | GPIO8 / GPIO9 | | I²C SDA / SCL (MFRC522) | GPIO22 / GPIO23 |
| Display SPI CLK / MOSI | GPIO12 / GPIO11 | | Push button | GPIO21 |
| Display CS / DC / RESET | GPIO10 / GPIO14 / GPIO21 | | RGB LED R / G / B | GPIO0 / GPIO1 / GPIO2 |
| DFPlayer UART TX / RX | GPIO17 / GPIO18 | | | |
| Reed switch (door contact) | GPIO42 | | | |
| Keypad rows | GPIO4, 7, 6, 5 | | | |
| Keypad columns | GPIO1, 2, 15 | | | |
| RGB status LED | GPIO39, 40, 41 | | | |

If you are running the Home Assistant half against hardware you have built
yourself, derive the pinout from `esphome/portal-unit.yaml` and
`esphome/doorbell-unit.yaml`, not from connector pin numbers in KiCad.

#### Parts

The one-page checklist is [`docs/bom.md`](docs/bom.md). Sound-card filenames
(no MP3s in this tree): [`docs/sounds/README.md`](docs/sounds/README.md).

Portal: an ESP32-S3 (8 MB flash, octal PSRAM), an MFRC522 RFID module, an
MPU6050 IMU, a DFPlayer Mini with a microSD card, a small speaker, a 4×3 matrix
keypad, a 240×135 ST7789V display, a reed switch and magnet, 1 K and 220 Ω
resistors, and a polarised capacitor.

Doorbell: a Seeed Studio XIAO ESP32-C6, an RC522 RFID module, a momentary 12 mm
push button, three 220 Ω resistors for the optional RGB LED, a 10 kΩ resistor
for the button, and M3 threaded inserts.

#### Two things the board still leaves open

- **The doorbell button resistor is 10 kΩ** (KiCad R4, silkscreen `10K Ohm`).
  Firmware also enables the ESP32's internal pull-up, so the button works with
  either 10 kΩ or 1 kΩ and also with no external resistor at all. Solder 10 kΩ
  so the board matches the silkscreen.
- **The DFPlayer volume is set to 30 on boot** (the module maximum) as of
  2.30.0. Earlier firmware left it at whatever the module powered up at. Needs
  a portal reflash. If the siren is still too quiet after that, the speaker and
  the housing are the remaining variables, not a missing `set_volume`.

#### Do this before you close the lamp housing

Create the camera's local account and **verify its RTSP stream in VLC while the
camera is still on the bench** — `rtsp://user:password@CAMERA-IP:554/stream1`
for full resolution, `/stream2` for the substream. A camera account that does
not work is by far the most common cause of a dead stream, and finding out
afterwards means dismantling the housing. (This is a separate local account on
the camera, not the vendor's cloud login; it is what enables RTSP and ONVIF.)

#### The sound files

The DFPlayer's microSD card holds numbered tracks and **cannot be updated over
the network** — the serial link carries playback commands only, and the card is
wired to the DFPlayer's decoder rather than to the ESP32. Changing a sound means
opening the portal. Track layout (`/MP3/0001.mp3` … `0005.mp3`, track 4 is the
alarm) is section 8 of
[`docs/documentation/interior-portal/`](docs/documentation/interior-portal/).

---

## 2. Secrets and credentials

Guardian has three credential surfaces and they live in three different places.
Two of them are files you create; none of them are committed.

| What | Where it lives | How to create it |
|---|---|---|
| Wi-Fi, per-device OTA / AP / API encryption keys, the device LAN addresses, and `guardian_rfid_mac_key` | `esphome/secrets.yaml` | **`python tools/guardian-gen-secrets.py`.** See below. |
| Camera RTSP user / password / host, and MQTT broker credentials | `frigate/config.yml`, which you create from `frigate/config.yml.example` — **in practice, typed in directly**. See the warning below. | The example ships with `{FRIGATE_RTSP_USER}`-style placeholders. On a Home Assistant OS add-on install these usually do not expand and you will have to hardcode the real values. `frigate/config.yml` is gitignored; the `.example` is the tracked one. |
| The master PIN | Nowhere, in plaintext | Only its SHA-256 is stored, in `input_text.portal_pin_hash`. Set it with `script.guardian_set_pin` (§6). Never type a hash in by hand. |

### Generate the ESPHome secrets, do not hand-copy them

```bash
python tools/guardian-gen-secrets.py
```

It asks for the four things it cannot know — your Wi-Fi SSID and password, your
router's address, and the two addresses the devices will live at — and generates
everything else with Python's `secrets` module: two *different* API encryption
keys, three OTA/AP passwords, and the 64-hex card master key. It refuses to
overwrite an existing `secrets.yaml` without `--force`.

**Copying `esphome/secrets.yaml.example` by hand is no longer the documented
path, and the reason is worth knowing.** That template used to ship
`guardian_rfid_mac_key` as 64 zeros. Sixty-four zeros are sixty-four valid hex
characters, so ESPHome accepted them and *the build succeeded*. Anyone who
copied the template and filled in the fields that obviously demanded filling —
Wi-Fi, addresses — ended up with a completely working system whose entire card
scheme was keyed on a value published in this repository. Every card credential
derives from that key: the NTAG21x password, and the MIFARE Classic sector keys
that replace the factory `FFFFFFFFFFFF` on first use.

The template value is now deliberately not hex, so leaving it in place fails the
build, and `validate_master_key` additionally rejects any single repeated byte.
But the real fix is not asking a person to invent seven secrets by hand.

`guardian_rfid_mac_key` still deserves its own warning once generated: **back it
up outside the repository, and do not rotate it casually.** Rotating locks
already-upgraded MIFARE Classic cards with a key nothing on the new install can
derive — that is stronger than "re-enroll them". Keep the old value if you ever
do. NTAG21x cards are recoverable either way. Use the same file for both devices.

**Guardian's Home Assistant configuration references no `!secret` keys at all.**
There is nothing to put in `/config/secrets.yaml` for Guardian's sake. The root
`secrets.yaml.example` in this repo exists only to say so, so that looking for
one is not a dead end.

### The Frigate placeholders probably will not work — plan for that

Start by copying the template — **edit the copy, never the `.example`**:

```bash
cp frigate/config.yml.example frigate/config.yml
```

`frigate/config.yml.example` uses Frigate's environment-variable substitution
(`{FRIGATE_RTSP_USER}` and friends). Frigate expands a placeholder only when
that variable is present in its own container environment, and **the Home
Assistant OS add-on gives you no supported place to set one.** On that install —
which is most installs — substitution silently does not happen.

There is no error saying so. The literal text `{FRIGATE_RTSP_USER}` is handed to
ffmpeg as the username, authentication fails, and what you see is an
authentication error in the log or *"No frames have been received"* in Frigate's
Debug view. If the URL Frigate printed still contains the placeholder verbatim,
that is this problem.

**The fix is to type the real values into the go2rtc URLs at the bottom of
`frigate/config.yml`:**

```yaml
go2rtc:
  streams:
    door_camera_1:
      - rtsp://myuser:mypassword@192.168.0.99/stream1
    door_camera_2:
      - rtsp://myuser:mypassword@192.168.0.99/stream2
```

Do the same in the `mqtt:` block. **Give the broker credentials — do not run it
anonymously.** A Mosquitto with `allow_anonymous true` lets any device on your
LAN publish to `homeassistant/#` and create arbitrary entities inside Home
Assistant, as well as forge the `frigate/events` messages Guardian's
person-detection automations listen to. Set `allow_anonymous false` and create
one account for Frigate and one for Home Assistant.

Do not leave empty placeholders behind — Frigate will try to use a leftover
`{...}` as a literal username.

This is the normal working configuration and it is fine, provided you take two
precautions:

1. **Put the credentials in `frigate/config.yml`, never in the `.example`.**
   `frigate/config.yml` is gitignored; `frigate/config.yml.example` is tracked,
   so anything typed into *that* file gets committed and stays in git history
   until the history is rewritten. (This used to be one tracked file, with a note
   telling you to gitignore it before editing — a footgun that fires once and is
   then permanent. Splitting the two is what actually fixes it. If you installed
   an earlier version and edited the tracked file, check your history now.)
2. **Use a dedicated camera account** with a password used nowhere else. Most
   cameras support creating one. A hardcoded throwaway credential is a far
   smaller exposure than a hardcoded reused one.

The placeholders are kept as the shipped default because they are the safer
shape where they *do* work — a Docker or Compose install, where you control the
environment directly. They are not kept because they are reliable under the
add-on.

---

## 3. Put the files in place

```bash
sh tools/guardian-install.sh --config-dir /config
```

Run it on the Home Assistant host with this repo checked out (Samba, SSH, the
File Editor add-on, `git clone` — however you got the files there). It is POSIX
`sh`, because the Home Assistant OS SSH add-on is BusyBox `ash`, not bash.

**It is a dry run by default** and prints exactly what it would do. Add
`--apply` when the output looks right:

```bash
sh tools/guardian-install.sh --apply --config-dir /config
```

`/config` is the default, so `--config-dir` is only needed if yours is elsewhere.

What it does:

- creates `packages/`, `themes/`, `guardian/` and **`www/guardian-ui/`** —
  that last one is the one people get wrong. Home Assistant serves `/config/www`
  as `/local`; put the panel anywhere else and it 404s;
- copies the nine runtime files, and **only** those. Not `preview.html`, not
  `docs/`, not `3D-Models/`, not the `.md` files;
- normalises `guardian-luminance.sh` to LF on the way in, because a CRLF copy
  fails under BusyBox `ash` with a message naming the interpreter rather than
  the file;
- **never overwrites a `configuration.yaml` it did not write.** If you already
  have one, it stops and prints the exact block to merge. That is the one step
  in this install that can destroy work;
- then runs preflight (§4) and prints the punch list of things no script can do.

It opens no port, changes no authentication setting, writes no credential and
makes no network call. There is no shortcut in it that trades a security
property for a faster install.

Two things it deliberately leaves to you: `esphome/` (copy it wherever your
ESPHome dashboard reads from, keeping `components/guardian_rfid/` next to the
device YAML) and the Frigate config (§8).

### Placing the files by hand instead

The installer is a convenience, not a requirement. The mapping is:

| Repo | Destination |
|---|---|
| `configuration.yaml` | `/config/configuration.yaml` |
| `automations.yaml` | `/config/automations.yaml` |
| `scripts.yaml` | `/config/scripts.yaml` |
| `scenes.yaml` | `/config/scenes.yaml` — an empty `[]`, but the `!include` needs the file to exist |
| `packages/` | `/config/packages/` — both files |
| `themes/` | `/config/themes/` — create it even if empty; `!include_dir_merge_named` needs the directory |
| `www/guardian-ui/guardian-panel.js` | `/config/www/guardian-ui/guardian-panel.js` — **create the directory**. `/config/www` is what Home Assistant serves as `/local`; anywhere else and the panel 404s. Not `/config/guardian-ui/`. |
| `www/guardian-ui/set-default-panel.js` | `/config/www/guardian-ui/set-default-panel.js` |
| `guardian/guardian-luminance.py` | `/config/guardian/guardian-luminance.py` |
| `guardian/guardian-luminance.sh` | `/config/guardian/guardian-luminance.sh` — **LF line endings**. A CRLF copy breaks BusyBox `ash`. Home Assistant does not actually run this; it is a thin wrapper. |
| `esphome/` | `/config/esphome/` — including `components/guardian_rfid/`, which must sit next to the device YAML |
| `frigate/config.yml.example` | copy to the Frigate add-on's config directory as `config.yml` — **read §8 first**, it needs an `mqtt:` block that was redacted from this repo |

Copy the two `www/guardian-ui/` files **by name, not the directory**.
`www/guardian-ui/preview.html` is a design harness, not part of the running
system, and `/config/www` is served with **no authentication at all** — anything
placed there is readable by every device on the LAN and every tailnet peer,
without a login and without a log line. Nothing that is not the running panel
belongs in that tree. (Earlier revisions of this document said to copy the whole
directory, and preview.html additionally fetched a stylesheet from a public CDN.
Both are fixed; if you installed an earlier version, delete
`/config/www/guardian-ui/preview.html`.)

Do not copy `docs/`, `3D-Models/`, `screenshots/`, or the `.md` files. They are
reference material, not runtime.

### If `/config/configuration.yaml` already has content

Do **not** overwrite it. `tools/guardian-install.sh` detects this case, refuses,
and prints the block below with the version string filled in from the release you
are actually installing. Merge it into your own file — it is the entirety of what
Guardian adds:

```yaml
# Not optional, and easy to skip because Guardian "works" without it. Home
# Assistant's defaults are ip_ban_enabled: false and login_attempts_threshold:
# -1 — unlimited password guesses, at full speed, against the one credential
# standing in front of disarming the house and reading the door camera.
http:
  ip_ban_enabled: true
  login_attempts_threshold: 5

# input_text.portal_pin_hash is an unsalted single-round SHA-256 of 4-6 digits,
# which is reversible in milliseconds. Recorded, it lands in the database and
# therefore in every backup you ever take — and backups travel to a NAS, a USB
# stick, a cloud sync. The card ids are the same shape of problem.
recorder:
  exclude:
    entities:
      - input_text.portal_pin_hash
    entity_globs:
      - input_text.rfid_*_card_id

frontend:
  themes: !include_dir_merge_named themes
  extra_module_url:
    - /local/guardian-ui/set-default-panel.js?v=2.32.5

automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml

panel_custom:
  - name: guardian-panel
    sidebar_title: Guardian
    sidebar_icon: mdi:shield-home
    url_path: guardian
    module_url: /local/guardian-ui/guardian-panel.js?v=2.32.5
    require_admin: false
    config:
      camera: camera.door_camera
      historyHours: 24

homeassistant:
  packages: !include_dir_named packages
  allowlist_external_dirs:
    - /config
```

Four things to watch when merging:

- **Do not drop `http:` or `recorder:`.** They are security settings, not
  preferences, and nothing visibly breaks without them — which is exactly why
  they are the two blocks most likely to be skipped. If you already have either
  key, merge into it rather than declaring it twice.
- **`homeassistant:` may already exist** in your file. Merge the keys into it;
  do not declare the block twice.
- **`allowlist_external_dirs` is duplicated on purpose** — it is also declared
  inside `packages/guardian.yaml`. Setting it from *inside* a package has been
  unreliable to merge across Home Assistant versions when `configuration.yaml`
  already defines `homeassistant:` directly. Declaring it in both places
  guarantees it takes effect.
- **Already using `packages:`?** Point `!include_dir_named` at your existing
  packages directory and put Guardian's two files in it, rather than adding a
  second `packages:` key.

If your automations or scripts are UI-managed, they already live in
`automations.yaml` / `scripts.yaml` and Guardian's copies will replace them.
Merge the file contents, do not swap the files.

### Version consistency

Guardian ships as loose files that nothing forces to arrive together, and a
half-copied install is the normal way this system breaks. Every half declares
its version, and the panel compares them. In this release they all read
**2.32.5**:

`packages/guardian.yaml` · `packages/guardian_rfid.yaml` · `scripts.yaml`
(the alias of `script.guardian_version_marker`) · `automations.yaml` (the alias
of the "Guardian - Automations Version" automation) · `configuration.yaml`
(both `?v=` query strings) · `guardian-panel.js` (`GUARDIAN_UI_VERSION`).

`automations.yaml` joined that list in 2.24.0. Until then it was checked only
for *presence* — does one Guardian automation exist — which a stale copy answers
yes to just as readily as a current one. That made the largest runtime file, the
one holding the alarm handler and every watchdog, the only half whose
disagreement nothing could see.

Copy them all. If they disagree, Guardian says so on More → Diagnostics rather
than misbehaving quietly — but that is *after* the restart, on a running system,
and only if somebody looks. `tools/guardian-preflight.py` is the same check
beforehand, and the installer runs it for you.

> **Copy `guardian-panel.js` on every release, even when its contents did not
> change.** Most releases change nothing in the panel but its version literal,
> so it is the file that looks like it does not need copying — and it is the one
> that produces the version banner nine times out of ten. See
> *Diagnostics says the versions disagree* below.

### Diagnostics says the versions disagree

The banner reads *"Guardian's files did not all come from the same version."*
There are two causes, they need **different fixes**, and the one people try
first — restarting Home Assistant — only fixes one of them.

**Look at which row is red.**

**If `This panel` is red** and says *Home Assistant asked for X, running Y*:
the backend is fine. Do **not** re-copy the YAML files, and do **not** restart —
the server has no way to drop a module a browser is already holding. Restarting,
seeing the banner again, and concluding the warning is broken is how a correct
alarm gets learned as noise.

**First, open Guardian on a second device — a phone, or another browser.**
That one question splits the remaining two causes:

*Correct on the other device* → the file on disk is fine and **only this browser**
is holding an old copy. See *A poisoned cache buster* below; clearing the cache is
the entire fix.

*Wrong everywhere* → `guardian-panel.js` genuinely was not copied to
`/config/www/guardian-ui/`. Copy it, then clear the cache.

#### A poisoned cache buster

The `?v=` in `configuration.yaml` is what makes a browser fetch a new panel, and
**it only works once per value.** If any browser requests
`guardian-panel.js?v=2.32.5` while the file on disk is still the old one, Home
Assistant serves old bytes under the new URL with a month-long `Cache-Control`,
and that browser now has the wrong content cached against the *new* address. The
cache buster has been spent on stale content, so nothing short of clearing the
cache will move it. Every other device is fine, because they only ever asked for
that URL after the file was correct — which is exactly why this shows up on one
machine and not the others.

To clear it, in escalating order:

1. `Ctrl-Shift-Delete` → *Cached images and files* → clear. Blunt and reliable.
2. Or DevTools (`F12`) → **Application** → *Clear site data*, which also drops
   the service worker.
3. Or DevTools → **Network** → tick *Disable cache*, then reload with DevTools
   left open.

A plain `Ctrl-Shift-R` is often **not** enough here: the panel is a dynamically
imported ES module, and a hard reload does not reliably bypass the cache for
modules fetched after the initial page load. In the mobile app the equivalent is
Settings → Companion → *Reset frontend cache*.

To confirm what your browser actually holds, open the module directly:

```
http://<your-ha>:8123/local/guardian-ui/guardian-panel.js?v=2.32.5
```

and look at the `GUARDIAN_UI_VERSION` line near the top.

#### Preventing it: copy first, restart second

**Copy every file — the panel included — before restarting Home Assistant.** The
restart is what publishes the new `?v=` to every browser, so any browser that
loads the page between the restart and the file copy burns its one cache buster
on the old file. Copying first closes that window. `tools/guardian-install.sh`
already does it in this order; the trap is the manual path, where the panel is
the easy file to copy last because its contents did not change.

**If one of the backend rows is red** (`packages/…`, `scripts.yaml`,
`automations.yaml`): that file is genuinely stale on disk. Copy it and **restart
fully** — packages and templates do not merge on a YAML reload.

**Check it from the host instead of the UI**, which is faster and does not
depend on the browser at all:

```bash
python3 tools/guardian-preflight.py --config-dir /config
```

That reads the deployed files and names the ones that disagree. It is the same
check the panel does, before the restart rather than after it, and
`tools/guardian-install.sh --apply` runs it for you automatically.

---

## 4. Check before you restart

```bash
python tools/guardian-preflight.py --config-dir /config
```

`tools/guardian-install.sh` already ran this; run it directly after any manual
edit. It is the repo's only automated check, needs nothing but Python and
PyYAML, makes no network call and reads no secret value. Every failure names the
file, what it found, and what to do.

It catches, in order of how often each one actually happens:

- **a half-copied install** — the version literals disagreeing;
- YAML that does not parse, in any of the nine files (`!include`, `!secret` and
  ESPHome's `!lambda` are all understood);
- `guardian-luminance.sh` copied with CRLF endings;
- a `script.guardian_*` referenced somewhere but never defined, and duplicate
  automation ids — both of which Home Assistant swallows silently;
- `esphome/secrets.yaml` still holding template values, or a card master key
  that is a single repeated byte;
- any external URL under `www/guardian-ui/`, which is served without
  authentication and must never reach off-box.

Then Developer Tools → YAML → **Check configuration** for the things only a
running Home Assistant can see. Then **restart Home Assistant** — Settings →
System → top-right → Restart Home Assistant.

**It must be a full restart, not a reload.** Two things in Guardian are only
read at startup:

- `packages/` is merged at startup only, so every helper, timer and template
  entity Guardian needs comes into existence on this restart and on no reload.
- `panel_custom`'s `module_url` (and `frontend.extra_module_url`) are read at
  startup, so the Guardian panel does not appear in the sidebar until then.

After the restart, Guardian is in the sidebar. The first time an administrator
loads Home Assistant, `set-default-panel.js` makes Guardian the landing page —
once, and never again, so a later "Set as default" on Overview is respected.

---

## 5. Run the setup wizard

Two minutes after that restart, Guardian runs
`script.guardian_setup_wizard` by itself and leaves a **persistent
notification** titled *Guardian setup*. Read it — it is the punch list for the
rest of this install.

You can run it again at any time, from either:

- **Guardian → More → Install → Setup check → Run**, or
- Developer Tools → **Actions** → `script.guardian_setup_wizard`.

Running it from the panel is always a re-check: it reports and writes nothing.

### What it does once

On its first run it applies the recommended first-boot values for the helpers
that deliberately carry no YAML `initial:`. That omission is correct — `initial:`
is applied on every Home Assistant start and *skips* `restore_state`, which is
how enrolled card hashes were once wiped on every restart — but it means a
genuinely first boot falls back to each helper's minimum, silently:

| Helper | Without the wizard | Wizard writes |
|---|---|---|
| `input_number.guardian_dark_threshold` | 0 | **45** |
| `input_number.guardian_bright_threshold` | 0 | **90** |
| `input_number.guardian_entry_challenge_seconds` | 10 | **30** |
| `input_number.guardian_empty_house_grace_seconds` | 5 | **10** — until this runs, an elevated empty-house challenge is only five seconds |
| `input_number.guardian_doorbell_exit_pin_minutes` | 2 | **10** |
| `input_number.guardian_lamp_mismatch_max_minutes` | 10 | **30** |
| `input_text.guardian_frigate_camera_name` | unset | **door_camera**, if unset |
| `input_text.guardian_camera_entity` | unset | your camera, **only if you have exactly one** |

It then sets `input_boolean.guardian_setup_complete` and never writes again, so
anything you change afterwards is yours to keep. To deliberately re-apply the
defaults, turn that helper off and run the wizard with `force: true`.

Two values it will **not** guess:

- **`input_number.guardian_luma_rotate`** stays at 0 (no rotation), which is
  correct for an upright camera. **If you built the Door Lamp and Camera module,
  set it to 90**: the camera sits on its side in that housing and its picture
  comes out landscape with the floor on the left. The same applies to any other
  camera mounted on its side. A wrong rotation measures the wrong part of the
  room and the lamp logic will be confidently wrong.

  Note that 0 is what the helper actually starts at, but 90 is what
  `guardian-luminance.py` and `scripts.yaml` fall back to when the helper cannot
  be read at all — they were written for the sideways door lamp mount. Whichever
  your camera is, set this helper explicitly rather than relying on either.
- **The master PIN.** See §6.

### What it reports

Every line names the exact entity, integration or script involved, and the
value or menu path it wants. Nothing in it is a generic error. The three
sections are:

- **Still needed** — Guardian cannot do its job until these are done. §6 walks
  through them.
- **Waiting on hardware** — true until you flash the devices in §7, and clears
  itself.
- **Worth knowing** — decisions still open to you, not defects.

---

## 6. Finish what the wizard named

These are the steps Home Assistant offers no way to automate: each is a config
flow, an app install, or a credential. Do the ones the wizard listed, then run
it again until the list is empty.

### The File notify integration

Guardian writes one JSON line per door, scan, challenge and alarm event to
`/config/guardian_data_log.jsonl` through `notify.guardian_data_log`. This
cannot be provisioned by YAML — the File platform is config-entry only.

Settings → Devices & Services → **Add Integration** → **File** → **Notify**.
Set the file to `/config/guardian_data_log.jsonl`, and leave **Timestamp
OFF** — a timestamp prefix on each line breaks JSONL parsing, and every payload
already carries its own `timestamp` field. Name it so the entity id comes out as
`notify.guardian_data_log`.

Without it Guardian still works; it just keeps no record. Every call site sets
`continue_on_error`, so the absence costs you the log and nothing else.

### A phone

Install the Home Assistant Companion app and sign in to this instance. Each
registered device appears as a `notify.*` entity, which
`sensor.guardian_notify_targets_available` picks up immediately.

Then link a phone to a key: **Guardian → Keys → (a key) → Alerts go to**. Until
at least one key has a phone, alerts fan out to every registered device, which
works but is noisy.

### What each person hears (optional)

Once a key has a phone, that person can choose what reaches it:
**Guardian → More → Keys, People & Alerts → (their key) → Notifications**.

The setting is per key, not per household. Two people in the same house hold
completely independent preferences. Storage is still those two helpers
(`input_select.rfid_N_notify_level` and `input_text.rfid_N_notify_mute`).
Permission is the mapping on `input_text.rfid_N_ha_user_id`: once a second
Home Assistant account exists, a non-admin can edit only the key linked to
their login. Developer Tools `input_text.set_value` is still Home Assistant's
model and is not this gate — hand out administrator rights on that basis.

A **level** sets the floor:

| Level | Sends |
|---|---|
| Everything | Every tagged alert, including lamp results and routine card scans |
| **Important** | The default. Everything that matters, without the routine chatter |
| Urgent only | Alarms, unauthorised openings, a person at the door while everyone is out |
| Off | Nothing, except the non-maskable three below |

Six **category switches** override it — *My key*, *Security & alarms*,
*Doors & access*, *Who's home*, *Camera & doorbell*, *System health*. Switch
one off and it stops arriving at any level. *My key* is the one that makes
"quiet, but tell me when my own card is used" possible: while it is on, events
about that person's own key come through even at **Urgent only**.

New keys start at **Important** with all six on, so a fresh install behaves as
it always has minus the routine chatter, with nothing to configure. Deleting a
key resets both helpers — preferences describe a person, not a slot position.

**A major alarm, a stolen-card scan, and portal tamper always come through**,
even at Off with every category muted. All three carry `nonmaskable: true` at
their call sites. A second account cannot mute the house alarm. This is
deliberate: a settings screen on a burglar alarm that can quietly disable the
burglar alarm is a trap, and the person who set Off six months ago will not
remember doing it. **Send test alert** ignores the settings too, so it keeps
proving the phone link rather than the preferences.

### A second Home Assistant user (optional)

One account is still the whole install. Nothing here is required until you
actually add a second person to Home Assistant.

When you do:

1. Settings → People → **Add person**, give them a login. They do **not** need
   to be an administrator to use Keys and Notifications.
2. Open Guardian **once as an administrator**. The panel refreshes
   `input_text.guardian_ha_admin_ids` and `input_text.guardian_ha_user_ids`
   from Home Assistant's user list. Until that happens, Guardian stays in
   single-account mode (any login may manage every key).
3. On **Keys**, pick their Home Assistant account on their key card. One
   person, one key; empty slots stay administrator-only to edit.
4. If they have the Companion app, the picker prefers their
   `notify.mobile_app_*` for **Alerts go to**. Confirm it. That is still a
   slot setting, not a per-HA-user preference.

They can rename their key and change their own notification level, categories,
and phone. They cannot enroll into other slots, delete keys, change the master
PIN, reset the system, edit Super Surveillance programs, or mute someone
else's alerts. Alarms, stolen cards, and tamper still ignore Off.

### The master PIN

Developer Tools → **Actions** → `script.guardian_set_pin`, enter 4–6 digits.
Then `script.guardian_verify_pin` with the same PIN — it must report *PIN
matches*.

On a fresh install there is no PIN yet, so the `current_pin` field is left
empty. **Afterwards it is required:** changing an existing PIN through this
action means supplying the one being replaced. Changing it at the interior
keypad does not — that flow asks for the old PIN on the keypad itself before it
ever reaches the script. The gate exists because Home Assistant has no
per-action permissions: without it, any account that can sign in, and any leaked
long-lived token, could replace the master PIN silently.

**Never fill `input_text.portal_pin_hash` by hand.** Windows tooling
(`Get-FileHash`, `certutil`) emits uppercase hex — 64 characters, so it looks
right, passes every sanity check, and can never match. `echo 1234 | sha256sum`
hashes a trailing newline and fails the same way. The script hashes with exactly
the expression the verifier uses, which is the entire point of it existing.

### The door camera

Set `input_text.guardian_camera_entity` on **Guardian → More → Install** (type
the entity id, then Save) to the camera pointing at your door. The wizard has
already done this if you have exactly one camera; with several, which one points
at the door is your call.

Optionally set the night-vision entity beside it. Guardian switches it off for
the duration of a light measurement — a camera flooding a dark scene with IR
reads bright, and the lamp then switches *off* the darker it gets. Leave it
blank and Guardian treats a possible night-vision frame as dark instead.

### Frigate person detection

See §8. This one cannot be verified from inside Home Assistant, so the wizard
always lists it as something to confirm rather than pretending to check it.

---

## 7. Flash and adopt the devices

Out of scope for this document by design — see the ESPHome dashboard, and
[`docs/documentation/`](docs/documentation/) for the hardware assembly. Two
things about the Home Assistant side:

**Order matters. Restart Home Assistant first, then flash.** The portal imports
Home Assistant entities and renders blank lines until they exist, so flashing
before §4 gives you a screen that looks broken and is not.

**Do not rename the devices or their entities in Home Assistant.** The
automations address the portal by its exact entity ids —
`binary_sensor.guardian_interior_portal_door_contact` and its siblings, derived
from `friendly_name: Guardian Interior Portal` in `esphome/portal-unit.yaml`.
Unlike the doorbell, which Guardian resolves by suffix through
`sensor.guardian_doorbell_entities` precisely because Home Assistant once
renamed it, the portal has no such indirection. A rename will silently detach
door detection. The setup wizard checks five representative portal entities and
names any it cannot find.

Flash the portal first, then the doorbell. Re-run the setup wizard afterwards —
the "waiting on hardware" section should be empty.

The portal firmware pulls Roboto from Google Fonts **at compile time**
(`gfonts://Roboto` in `esphome/portal-unit.yaml`). The first build needs
network access for that fetch. It is not a runtime call and nothing on the
device talks to Google after flash.

### Flash encryption (opt-in, USB then eFuse)

Skipped by default, on purpose. Enabling flash encryption or secure boot is a
**one-time serial + eFuse** operation. Default-on would brick every device that
is only ever flashed over OTA, and on the XIAO ESP32-C6 it can kill USB Serial
JTAG. The outdoor master key therefore stays in cleartext until you complete
this section.

Do this only if you understand that **eFuses cannot be un-burned**.

1. **Flash both boards over USB first**, with the shipped YAML (encryption
   still commented out). Confirm OTA, RFID, and logs work. Do not start from an
   OTA-only device you cannot reach with a cable.
2. **Back up the encryption key material** ESPHome / ESP-IDF writes during the
   first encrypted build (`flash_encryption_key.bin` or the equivalent in the
   PlatformIO build dir). Store it off the Home Assistant box. Lose it and the
   chip is a brick.
3. On the **portal** (`esphome/portal-unit.yaml`): change
   `board_build.flash_mode` from `qio` to `dio` *before* the first encrypted
   image. Encrypted QIO will not boot. Uncomment the `sdkconfig_options` block
   (development-mode flash encryption only). Leave secure boot commented.
4. On the **doorbell** (`esphome/doorbell-unit.yaml`): uncomment the same
   development-mode block. The C6 logs over `USB_SERIAL_JTAG`; a
   download-disable eFuse can end USB recovery. Do not enable secure boot
   here until encryption has been proven on *this* board.
5. Compile, then **flash the first encrypted image over USB**, not OTA. Watch
   the serial log through the eFuse burn. After that, OTA of further encrypted
   builds is the normal path.
6. Secure boot is a **separate** irreversible eFuse. Enable it only after
   development-mode encryption has survived a USB reflash and an OTA on that
   exact board.

Release-mode encryption (no USB reflash after the burn) is not the documented
path. There is no key-rotation recovery tool in this tree.

Until you finish this, unscrewing the doorbell still yields
`guardian_rfid_mac_key`. That key **stays in both firmwares** even after
encryption — encryption protects the flash against a dump, it does not remove
the outdoor reader.

---

## 8. Frigate

Guardian consumes Frigate over **MQTT**, not through the Frigate integration.
The automation `Guardian: Frigate Person Detected While Away` triggers on the
`frigate/events` topic.

`frigate/config.yml` in this repo has its `mqtt:` block **commented out** — it
carries broker credentials and was redacted before publishing. On a fresh copy
Frigate therefore publishes nothing and person detection never fires. Uncomment
that block, point it at the same broker your Home Assistant MQTT integration
uses, and restart Frigate.

**Credentials in that block, and in the camera URLs, almost certainly need to be
typed in rather than left as `{PLACEHOLDER}`** — see §2, "The Frigate
placeholders probably will not work". If Frigate cannot reach the broker or the
camera and the log still shows a `{...}` in the string, that is what happened.

Keep `topic_prefix: frigate`. An MQTT trigger topic is not templatable in Home
Assistant, so unlike the camera name it cannot be read from a helper — changing
the prefix means editing both automations.

The camera key in `frigate/config.yml` (`door_camera` as shipped) must match
`input_text.guardian_frigate_camera_name`. A mismatch is a silent false
negative: the message arrives, the condition never matches, and nothing anywhere
reports it. This is exactly how person detection was dead on the author's own
install for months.

---

## 9. Verify

Work down this list. It is the shortest path to knowing the system is real, and
most of it comes from `DEPLOY.md`'s own verification steps.

0. **Preflight is clean.** `python tools/guardian-preflight.py --config-dir
   /config` exits 0. This is the only step that does not need a running system,
   so it is the cheapest place to find a half-copied install.
1. **Nothing is outstanding.** Run the setup wizard once more. The persistent
   notification says *Guardian is ready*.
2. **Every file agrees.** Guardian → More → **Diagnostics** → Installation:
   every row reads `2.32.5`, `automations.yaml` included — it reports a version
   now, not `present`. The panel footer says `2.32.5` too. If it does not,
   your browser cached the old panel — the `?v=` in `configuration.yaml` is what
   busts that, so confirm you copied `configuration.yaml`.
3. **The backend answers.** Diagnostics → Tests → **Backend self check** → Run.
   It names every version, confirms the slot rack is readable, and counts the
   phones Home Assistant can see. It sends nothing; no phone should buzz.
4. **A phone actually buzzes.** Diagnostics → Tests → **Notification
   self-test** → Run. A "passed" verdict with no buzz means routing is fine and
   the problem is on the device — check the companion app's notification
   permissions and battery optimisation.
5. **The PIN is accepted.** `script.guardian_verify_pin` reports *PIN matches*.
6. **A card enrolls.** Guardian → Keys → **Add a key**, present a card at the
   portal reader. It lands in a slot, and the key appears with a name you can
   set. Press `#` on the portal keypad to end the session.
7. **A scan opens a passage window.** Present that card. The portal shows
   GRANTED, `timer.guardian_entry_window` and `timer.guardian_exit_window` go
   active for 20 seconds, and opening the door inside that window is treated as
   intentional.
8. **The lamp measures.** Run `script.guardian_sample_ambient_light` by hand.
   `input_text.guardian_lamp_last_result` fills in with something like
   `22:20 luma=31.4 sun=-12.3 on_camera manual`. A `FAILED` verdict names its
   own reason.
9. **The fault list is empty.** `sensor.guardian_faults` reads blank. Before you
   flash the devices it legitimately shows `DOORBELL`, and it may show `CAMERA`
   until §6 — a missing entity is reported as a fault on purpose, because a
   missing entity is a real deployment problem.

### Prove the alarm, not just the plumbing

Steps 1–9 prove the system is assembled. These prove it *does its job*, and
none of them can be checked from a config file. Do them once, at install, and
again after any change to the alarm path.

10. **A stolen card sounds the alarm.** Guardian → Keys → mark a spare key
    stolen, then present it at the portal. Expected, all four: the siren starts
    within about three seconds (it repeats on a 3s cadence), the portal shows
    ALARM with a reason, the lamp goes red, and a push arrives.
11. **…even on a muted phone.** Before repeating step 10, set that key's
    notification level to **Off** and switch every category off
    (§6, *What each person hears*). The alarm push must still arrive. It carries
    `nonmaskable: true`, and a settings screen that can silence the burglar alarm
    would be a trap. If it does *not* arrive, that is a serious regression —
    check the `nonmaskable` flag survived to the call site.
12. **The alarm survives a missing lamp.** Set `input_select.guardian_lamp_target`
    to `none` and fire step 10 again. Siren and push must be unaffected; only the
    red lamp is missing. The lamp step is guarded precisely so it can never take
    the alarm down with it.
13. **A disconnected sensor alerts rather than going quiet.** Pull the interior
    portal's power. Within five minutes the portal offline watchdog raises an
    alert. Silence here is the failure — a security system must fail closed.
14. **It still works with the internet unplugged.** Disconnect the WAN (not the
    LAN) at the router and repeat steps 10 and 7. The siren, the lamp, the
    portal, the RFID reader and the door logic are all local and must be
    unaffected. **Push notifications will not arrive** — that is expected and is
    the subject of §10. Everything else working is the point of the test.
15. **Magnet defeat is a tamper.** After the **portal** reflash, hold the reed
    closed (a second magnet, or cheat the contact) and move the leaf or handle
    so the swing integrator runs. Expected: portal ALARM, looping siren,
    non-maskable push, reason *Portal tamper: magnet defeat*. A slam-shut must
    **not** do this.
16. **A spoofed contact is a tamper.** Open the reed without rotating the leaf
    (lift the magnet, door still shut). After about 600 ms: ALARM, reason
    *Portal tamper: spoofed contact*. If the IMU is unhealthy this path is
    skipped on purpose.
17. **A normal open is not a tamper.** Open from inside and from outside the
    usual way. Neither must raise tamper. Then mute the other person's key to
    Off (if you added a second account) and fire step 10 again: the house
    alarm must still reach the linked phone.

If step 1 keeps listing something you believe you have done, trust the wizard
over the appearance of the panel. It asks the backend; the panel renders the
browser's view of it, and the two can genuinely disagree — a UI-created helper
left in `.storage` can shadow a YAML one under a slightly different object id.

---

## 10. What leaves your network

Guardian is a local system and its own code is genuinely local: no HTTP client,
no external hostname, no telemetry, no crash reporter, no update checker, no
third-party SDK, in any of the YAML, the Python probe or the ESPHome firmware.
Both boards take their clock from the Home Assistant API rather than an internet
time server, so they keep working with the WAN unplugged.

That is not the same as *nothing leaves*. Three channels do, and you should
choose them deliberately rather than discover them.

### 1. Every alarm notification — unavoidable

`notify.mobile_app_*` is the Home Assistant Companion app, and a push to a
locked phone physically cannot be delivered without going through Apple's or
Google's push service. Home Assistant relays through its own push proxy to
reach them.

**What that carries:** the alert title and body. For an alarm that includes the
reason string, and for a card event the person's name from the key slot — so
*"the key holder was scanned at the door"* leaves your network. It is the only Guardian
data path that does, and it is the price of a phone that buzzes when the house
is being broken into.

There is no local-only substitute that wakes a locked phone. What you can do:

- **Turn the volume down per person** rather than off — §6, *What each person
  hears*. Fewer categories means less leaves.
- **Accept it, knowingly.** The siren, the lamp, the portal and the door logic
  are all local and keep working with the WAN unplugged (verify §9 step 14).
  Only the push stops.

### 2. Home Assistant's own cloud and analytics

`configuration.yaml` begins with `default_config:`, which loads Home Assistant's
`cloud` (Nabu Casa) and `analytics` integrations along with everything else.
Neither is Guardian's, and neither sends Guardian's data — but both are running
on the box that holds your door camera.

- **Analytics** — Settings → System → General → **Analytics**. Turn off what you
  do not want sent. It is aggregate installation statistics, not events.
- **Nabu Casa cloud** — only active if you have signed in to a subscription.
  Settings → Home Assistant Cloud shows whether you have.

Guardian deliberately does **not** strip these from `default_config:`. Doing so
would break Nabu Casa remote access and cloud TTS for anyone using them, and
would not make alerting local-only anyway, since push still goes through
Apple/Google either way. The honest position is to name the channel and let you
switch it off in the UI, which is what this section is for.

### 3. The camera, RTSP, and MQTT — local, and should stay that way

These do **not** leave the network, by design, and it is worth knowing how so
you do not accidentally change it:

- Frigate pulls RTSP from `127.0.0.1:8554` through go2rtc. The camera password
  never leaves the Home Assistant box.
- The panel's live view uses signed `camera_proxy` URLs, which are
  authenticated.
- The lamp's ambient still is written to `/config/guardian`, which is **not**
  web-served. It must never be moved to `/config/www`, which is served as
  `/local` with no authentication at all.
- MQTT is your broker on your LAN. Authenticate it (§8) — an anonymous broker
  lets any device on the Wi-Fi publish to `homeassistant/#` and create entities
  inside Home Assistant.

### Remote access: do not port-forward

**Do not forward port 8123 from your router.** That puts the login page for your
door camera, your alarm disarm and your master PIN on the public internet, where
it will be found by scanners within hours.

If you want Guardian from outside the house, use **Tailscale** or a VPN. The
traffic is then encrypted end to end by WireGuard and the port stays closed.
Note that every tailnet peer can reach port 8123 directly, so the Home Assistant
login is still the only gate — which is why `http:` with `ip_ban_enabled` and
`login_attempts_threshold: 5` is not optional (§3). Interface-level restriction,
if you want it, belongs at the OS firewall rather than in `server_host`; setting
that would break the Companion app and every browser on the LAN.

TLS is deliberately not configured. Remote access is already encrypted by
WireGuard, the remaining plaintext is visible only to something already on your
LAN, and a self-signed certificate would break the Companion app while training
everyone to click through warnings. If you want it anyway, `tailscale cert` is
the version worth doing.

---

## 11. Afterwards

- **[`DEPLOY.md`](DEPLOY.md)** — the release-by-release changelog and the
  manual test plan. Read the new pass sections when you upgrade, not before.
- **[`docs/maintainers/`](docs/maintainers/)** — audit, panel design, and
  contributor onboarding. The place to start if you intend to change
  behaviour.

Adding and removing keys, linking phones, creating Super Surveillance programs
and picking the lamp are all done from the Guardian panel. None of them is a
YAML edit, and none needs another restart.
