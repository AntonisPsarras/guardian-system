# MakerWorld / Printables listing copy

Paste-ready fields for three models in the collection **Guardian System**.
Each upload is the Bambu `.3mf` plus the matching assembly PDF.

Firmware GPIO, Gerber zips, and the Home Assistant tree are **not** inside
the `.3mf`. Name them as part of Guardian System.

**Intended listing URLs** (still draft or private until you publish
them — unauthenticated visits 404). Author page that *is* public:
[AntoniJuvenikal on Printables](https://www.printables.com/@AntoniJuveni_3576373).

| Device | MakerWorld | Printables |
|---|---|---|
| Door lamp | [listing](https://makerworld.com/en/models/3347455-guardian-door-lamp-housing-tapo-c110-lantern) | [listing](https://www.printables.com/model/1853736-guardian-door-lantern-tapo-c110-camera-l530e-hidde) |
| Interior portal | [listing](https://makerworld.com/en/models/3347482-guardian-interior-portal-keypad-and-display) | [listing](https://www.printables.com/model/1853748-guardian-interior-portal-esp32-s3-keypad-rfid-disp) |
| Doorbell | [listing](https://makerworld.com/en/models/3347498-guardian-outdoor-doorbell-housing-esp32-c6) | [listing](https://www.printables.com/model/1853742-guardian-outdoor-doorbell-housing-esp32-c6) |
| Collection | [Guardian System](https://makerworld.com/en/collections/36079462-guardian-system) | [Guardian System](https://www.printables.com/@AntoniJuveni_3576373/collections/3780824) |

## Shared rules (all six uploads)


| Field              | Value                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Collection         | Guardian System                                                                           |
| Files              | One Bambu profile + matching assembly PDF (converted from the docx)                       |
| Print              | PETG as supplied. Supports are already in the meshes. Do not “optimize” the profile away. |
| Remix              | Housing remix OK. Software and GPIO stay with Guardian System.                            |
| MakerWorld license | Standard Digital File License (or CC-BY), plus the MIT line below                         |
| Printables license | MIT                                                                                       |


**License line (MakerWorld description):** Print files and CAD for Guardian System; the software tree is MIT. This listing is the print profile and assembly PDF.

**Do not upload:** installed-door shots, `DEPLOY.md`, or
`GUARDIAN_AUDIT.md`.

**Do not claim:** certified security, an alarm that works without Wi-Fi,
pick-and-place / JLCPCB SMT, a weatherproof camera, or that the PDF is a
Home Assistant install guide.

**Covers (bench only):**

- Portal: [`../documentation/interior-portal/images/23.jpg`](../documentation/interior-portal/images/23.jpg)
- Doorbell: [`../documentation/doorbell/images/09.jpg`](../documentation/doorbell/images/09.jpg)
- Lamp: [`../documentation/door-lamp-camera/images/01.jpg`](../documentation/door-lamp-camera/images/01.jpg)

**MakerWorld “model introduction” / Printables “summary”:** use the
Summary for that model.

**First ~200 characters:** keep the Search snippet exact. That is the
search excerpt. Do not open with “DIY burglar alarm.”

---



## Door lamp + camera — `Lamp-Final.3mf`

- MakerWorld: https://makerworld.com/en/models/3347455-guardian-door-lamp-housing-tapo-c110-lantern
- Printables: https://www.printables.com/model/1853736-guardian-door-lantern-tapo-c110-camera-l530e-hidde

### Title (both sites)

Guardian door lantern — Tapo C110 camera + L530E hidden in PETG

### Category

- Printables: Household
- MakerWorld: Household → Lighting or Gadgets



### Tags

`enclosure` `lamp` `tapo` `homeassistant` `petg`

Add `camera` or `lantern` if a sixth slot exists.

### Search snippet (keep this opening)

A porch lantern that is not only a lantern. Printed PETG housing for a stripped Tapo C110 and an E27 Tapo L530E — local video and colour light, no custom PCB.

### Summary

Print-ready lantern for a commercial Tapo camera and smart bulb. The lens sits in the housing; the windows stay unpainted so the light still reads as a lamp. Assembly PDF included.

### Full description

A porch lantern that is not only a lantern. Printed PETG housing for a stripped Tapo C110 and an E27 Tapo L530E — local video and colour light, no custom PCB.

A wall lantern that watches the door without advertising a camera. From the pavement it is a hex lantern with three lit panels. From the inside of the house it is the Guardian System door lamp: entrance video, person detection, and a colour bulb that Home Assistant can use as both porch light and status.

This profile is the outward-facing housing from **Guardian System** — a Home Assistant setup with RFID at two doors, a keypad-and-display interior portal, presence per key, a camera-driven lamp, and alerting to phones. The other two prints in this collection are the Interior Portal and the Doorbell. This listing is only the lantern.

There is **no custom PCB**. The print is sized around two off-the-shelf TP-Link Tapo devices. Home Assistant talks to both on the LAN after you provision them in the Tapo app. A TP-Link account is only for first setup (Wi-Fi and the camera’s local RTSP/ONVIF account). Control and recording stay on your network. You can block the camera’s WAN access at the router if you want; lift that block if you ever need a Tapo firmware update.

**What sits in the housing**


| Device                                | Role                                      | Notes that matter for the print                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TP-Link Tapo C110                     | Entrance video, motion / person detection | 2K 3MP, 129.4° diagonal, 850 nm IR to about 9 m. 2.4 GHz Wi-Fi only. Stock plastics come off; keep the rectangular lens bezel and IR window — the printed camera shell is built around them. Unplug the built-in speaker. Leave the microSD slot empty; clips live in Home Assistant / Frigate. |
| TP-Link Tapo L530E (or same-size A60) | Light and optional status colour          | E27, 806 lm class, 2500–6500 K, colour, 1–100% dim. Official TP-Link integration in Home Assistant, LAN control.                                                                                                                                                                                |


**In this profile** (`Lamp-Final.3mf`)

Main-Housing, Top-Cover, Top-Screw-Cover, Camera-Housing1, Camera-Housing2, Camera-Lock, Light-Cover-3x.

Print **as supplied, PETG**. Supports are already part of the models — do not strip them in the slicer to “save time.” The original build used white PETG so the three window panels stay translucent while the shell hides cable work. Paint the body if you want the black lantern in the photographs. **Do not paint the white windows** (paint kills the glow) and **keep paint out of the camera slide channel** or the camera housing will not go in.

M3 threaded inserts (5.7 × 4.6 mm in the original build): two in the camera half that has the lens hole, plus one in every M3 hole on the top of the main housing. Four M3 screws hold the top cover; two hold the camera halves. Four wall screws or nails go through holes *inside* the main housing, which is why the light panels and top stay off until the lantern is on the wall.

**Also in this upload:** the assembly PDF — photographs and order of work from Tapo setup on the bench, through stripping the C110, printing and optional paint, camera transplant, lamp-holder wiring, wall mount, then the three panels and top cover.

**What you still buy**

- Tapo C110 and its 9 V DC 0.6 A adapter
- Tapo L530E or any A60-class E27 that fits
- E27 lamp holder with a **cable tail**, not a wall-plug holder. The part that sits in the printed cylinder must be **under 37 mm** outside
- M3 inserts and matching screws; four wall fasteners
- Soldering iron only for melting inserts

**Power and mains.** The bulb is mains through the holder. Isolate the circuit at the consumer unit, prove it dead, and follow the rules where you live. If you are not confident with fixed wiring, have that part done by a qualified electrician. The camera needs its own 9 V run inside the same housing. The original install replaced a dumb wall lantern so both supplies could come from that point — plan both cables before you close the top.

**Weather.** The C110 is an indoor camera (0–40 °C, no IP rating). The print is not sealed. Mount under a porch, soffit, or other overhang, out of direct rain. That is how the original sits.

**Bring-up order (do this before you screw the lantern shut)**

1. Add camera and bulb to the Tapo app on **2.4 GHz** Wi-Fi. Combined SSIDs often fail here.
2. In the camera’s advanced settings, create a **camera account** (not your TP-Link login). That username and password unlock RTSP 554 and ONVIF Profile S on 2020.
3. Open the stream on the bench: `rtsp://user:pass@CAMERA-IP:554/stream1` (full) or `/stream2` (substream). If this fails, do not close the housing.
4. DHCP reservations for both devices. Home Assistant addresses them by IP.
5. Optional: disable the C110 status LED so the lantern does not blink like a webcam.
6. Optional: WAN-block the camera. Local RTSP, ONVIF, and Home Assistant keep working.
7. The C110 only serves a couple of simultaneous streams. Point Home Assistant (and Frigate) at it; view everything through HA.

Guardian’s lamp logic uses measured ambient luminance from the camera, with a sun-elevation fallback and an auto-calibration path. Person detection is Frigate over MQTT, not the Tapo cloud. The colour bulb can double as a status lamp. Turn off automatic Tapo firmware updates once it works — vendor updates have broken local auth before.

**Siblings in this collection:** Interior Portal (ESP32-S3 keypad, RFID, display, reed, handle IMU) and Doorbell (XIAO ESP32-C6 outdoor RFID + button). Print files and CAD sit with Guardian System; the software tree is MIT. This listing is the print profile and assembly PDF. Opening the camera voids its warranty.

**This is not** a weatherproof security product, a TP-Link accessory, or a sealed “smart lantern kit.” Substitutes have to match the C110 / A60 envelope and still speak locally.

---



## Interior portal — `Internal-Portal-Final.3mf`

- MakerWorld: https://makerworld.com/en/models/3347482-guardian-interior-portal-keypad-and-display
- Printables: https://www.printables.com/model/1853748-guardian-interior-portal-esp32-s3-keypad-rfid-disp

### Title (both sites)

Guardian interior portal — ESP32-S3 keypad, RFID, display, door IMU

### Category

Electronics / Cases (or Gadgets)

### Tags

`enclosure` `rfid` `esphome` `esp32` `homeassistant`

### Search snippet (keep this opening)

Wall portal for a custom ESP32-S3 board: 4×3 keypad, 240×135 IPS, RC522, speaker, reed contact, and a handle-mounted MPU6050. PETG profile; Gerbers and firmware come with the full system.

### Summary

Interior door station in PETG: main body, wall plate, keypad and display frames, speaker grille, cosmetic screw cap, reed pair, IMU clip. Hand-soldered proto PCB, not a store-bought reader. Assembly PDF included.

### Full description

Wall portal for a custom ESP32-S3 board: 4×3 keypad, 240×135 IPS, RC522, speaker, reed contact, and a handle-mounted MPU6050. PETG profile; Gerbers and firmware come with the full system.

The inside of the door is where Guardian actually decides.

This PETG set is the **Interior Portal** from **Guardian System**: a Home Assistant tree plus two ESP32 devices. Every card scan — here or at the outdoor doorbell — goes through one decision path. A valid tap opens a timed passage window; a door that opens inside it is intentional, outside it is not. Direction is classified from the lever IMU first, reader intent second, confirmed door swing third. Cloned cards are caught with a rolling counter on NTAG21x. Elevated mode can ask for card *and* master PIN before a siren, instead of waking the house for a forgotten scan.

This listing is the printed portal: keypad, 240×135 status display, RFID, spoken prompts and siren through a DFPlayer, a reed on the leaf, and an IMU that clips onto the handle so a lever twitch is not the same event as the door moving. It is designed around a **hand-soldered custom PCB** and an **ESP32-S3 DevKit**. Firmware is built for **8 MB flash / octal PSRAM**. A 32 MB Waveshare module still runs that build; do not change the firmware flash size to 32 MB if the chip is 8 MB.

There is **no pick-and-place / CPL**. Send the Guardian Interior Portal Gerbers to a proto fab, or hand-solder from the KiCad project. GPIO comes from ESPHome (`portal-unit.yaml`), not from silkscreen connector numbers.

**In this profile** (`Internal-Portal-Final.3mf`)

Main-Body, Wall-Mounting, Display-Cover, Display-Housing, Keyboard-Housing, Speaker-Housing, Top-Screw-Cover, Door-Sensor-Housing1, Door-Sensor-Housing2, MPU-6050-Housing, MPU-6050-Housing-Cover.

There is **no separate Top-Cover**. The cosmetic cap that hides the front screws is **Top-Screw-Cover**. Print **as supplied, PETG**. Supports are already in the models.

**Also in this upload:** the assembly PDF — PCB populate order, keypad pin table, display and speaker frames, RFID in the body, wall-plate sequence, reed and IMU, DFPlayer track names.

**What you still buy**


| Qty      | Part                                          | Notes                                                                                                                 |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1        | ESP32-S3 DevKit                               | 8 MB flash / octal PSRAM in firmware. USB-C toward the keypad header.                                                 |
| 1        | MFRC522 (RC522)                               | 13.56 MHz. Use NTAG21x; Classic is clonable.                                                                          |
| 1        | MPU6050 / GY-521                              | Clips on the lever. May need CAD tweaks for your handle.                                                              |
| 1        | DFPlayer Mini + FAT32 microSD + small speaker | Card is wired to the DFPlayer, not the ESP32. Changing a sound means opening the portal.                              |
| 1        | 4×3 matrix keypad                             | 7-pin harness. Firmware rows GPIO4 / 7 / 6 / 5, columns GPIO1 / 2 / 15.                                               |
| 1        | 1.14" 240×135 ST7789 IPS (SPI)                | Status UI.                                                                                                            |
| 1        | Reed switch + magnet                          | Frame half and leaf half in this same profile.                                                                        |
| 3 + 2    | 220 Ω and 1 kΩ axial THT                      | Plus 1000 µF 10 V radial, polarised, `+` marked on the board.                                                         |
| ~20      | M3 inserts 5.7 × 4.6 mm                       | Main body and wall plate.                                                                                             |
| —        | Headers                                       | 2× 1×22 female (ESP32), 4×1 male (keypad), 3× 1×2, 3× 1×4, 2× 1×8 female (DFPlayer), 2.54 mm. Or solder modules down. |
| 1        | 5 V supply                                    | Sized for S3 + DFPlayer + display.                                                                                    |
| optional | 5 mm RGB, common anode                        | Status / bring-up.                                                                                                    |


**Build order that actually works**

1. Solder headers, resistors, and the capacitor (polarity). DFPlayer SD slot toward the capacitor; ESP32 USB-C toward the keypad header.
2. Speaker: two wires through the printed grille, tape the driver in.
3. Display: the printed top panel goes on *before* the module is screwed into its shell; reuse the module’s standoff screws.
4. Keypad: solder from the **back**. Slide it in the printed frame so pins emerge for the harness. Optional M2 screws to stop it walking.
5. If keys read wrong after a flash, the harness is swapped — do not edit firmware to match a miswired cable.
6. Melt inserts in the main body and wall plate. RFID screws to the side inserts. Reed and IMU cables leave through their holes; MPU 3V3 is the top pin on that header. Reed orientation does not matter.
7. Mount the wall plate first (screws or tape). Screw the body to the plate, *then* screw the PCB down. Add keypad, display, and speaker modules. Friction or tape holds Top-Screw-Cover.

**Fit.** Most of the set fits a typical door. The MPU housing and reed pair are the parts that may need a CAD tweak for your hardware. This listing is the print profile; there are no STEP sources here.

**Sound card (FAT32, folder** `MP3` **at the root, four-digit names)**


| File            | What it is                        |
| --------------- | --------------------------------- |
| `/MP3/0001.mp3` | Doorbell                          |
| `/MP3/0002.mp3` | Access denied                     |
| `/MP3/0003.mp3` | MFA / PIN challenge               |
| `/MP3/0004.mp3` | Alarm (networked and local siren) |
| `/MP3/0005.mp3` | Welcome / granted                 |


Firmware uses `play_mp3` by filename. Dumping files in the card root and using plain `play` is how an earlier card played the alarm as a chime. Volume is set to 30 (module max) on boot. MP3s are not in this upload.

**Siblings in this collection:** Doorbell (second RFID, outside, XIAO ESP32-C6) and Door lantern (Tapo C110 + L530E, no PCB). GPIO, Gerbers, and Home Assistant logic live with Guardian System, not inside the `.3mf`. Print files and CAD; the software tree is MIT.

**This is not** a finished commercial alarm, a pick-and-place board, or a reader you flash with random ESPHome YAML. The portal’s local siren is firmware on this hardware; treat Wi-Fi and power as part of the design, not as optional extras.

---



## Doorbell — `Doorbell-Final.3mf`

- MakerWorld: https://makerworld.com/en/models/3347498-guardian-outdoor-doorbell-housing-esp32-c6
- Printables: https://www.printables.com/model/1853742-guardian-outdoor-doorbell-housing-esp32-c6

### Title (both sites)

Guardian doorbell — XIAO ESP32-C6 outdoor RFID reader and button

### Category

Electronics / Cases (or Outdoor / Household)

### Tags

`doorbell` `rfid` `esphome` `esp32` `enclosure`

### Search snippet (keep this opening)

Outdoor reader so a key works from the street: Seeed XIAO ESP32-C6, RC522, 12 mm button, in a PETG body that sits in a 54 mm wall opening.

### Summary

Exterior RFID + doorbell button in PETG: main housing, rear mount, button plate, top cover, retainer set. Same cards as the Interior Portal, different board. Assembly PDF included.

### Full description

Outdoor reader so a key works from the street: Seeed XIAO ESP32-C6, RC522, 12 mm button, in a PETG body that sits in a 54 mm wall opening.

A doorbell that is also the other half of the lock.

This is the **exterior Guardian reader** from **Guardian System**. Tap a key outside without walking to the interior portal, or press the 12 mm button and the house hears it (the portal’s DFPlayer plays the doorbell track). Same decision path as the indoor reader: one script classifies the card, reconciles presence, and picks a verdict. Same NTAG21x keys; Classic is still a bad idea.

The board is a **Seeed Studio XIAO ESP32-C6** plus **RC522**, optional RGB status LED, and a custom through-hole PCB. Hand-solder. Send the Guardian Doorbell Gerbers to a proto fab, or work from the KiCad project. GPIO is firmware (`doorbell-unit.yaml`): I²C 22/23, button GPIO21, RGB GPIO0–2 — not the connector pin numbers on the silk.

**In this profile** (`Doorbell-Final.3mf`)

Main-Housing, Top-Cover, Wall-Mounting, Button-Panel, Cover-Holders-8x.

Print **as supplied, PETG**. Supports are already in the models.

**Wall opening (measure before you cut)**

- Hole at least **54 mm diameter** — that is the cut in the wall face.
- Cavity behind the face **no deeper than 45 mm**, or the module screws will not reach the rear mount.
- Diameter is the hole. Depth is how far the box goes back. They are not two diameters.

**Also in this upload:** the assembly PDF — inserts from the large rear opening (do not try to iron them through the front holes), cables before the PCB seats, button plate early, RFID on the inner insert, LED seated *lightly*, rear mount first, top cover last.

**What you still buy**


| Qty      | Part                        | Notes                                                                                                                              |
| -------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Seeed Studio XIAO ESP32-C6  | USB-C toward the RFID header. Silk shows orientation. Solder down or use headers.                                                  |
| 1        | MFRC522 (RC522)             | Same family as the portal.                                                                                                         |
| 1        | 12 mm momentary push button | Red in the original build. Orientation on the connector does not matter.                                                           |
| 3        | 220 Ω axial THT             | RGB LED.                                                                                                                           |
| 1        | 10 kΩ axial THT             | R4, button. Firmware also enables the internal pull-up. Match the silkscreen; older notes that said 1 kΩ were prototype leftovers. |
| 15+      | M3 inserts 5.7 × 4.6 mm     | Body, cone, rear mount.                                                                                                            |
| —        | Headers                     | 2× 1×7, 2× 1×4, 2× 1×2 female, 2.54 mm — or solder the XIAO.                                                                       |
| 1        | 5 V supply                  | Marked `5V` / `G`. Polarity matters.                                                                                               |
| optional | 5 mm RGB, common anode      | Connection status. Do not push it fully in or it fouls the top cover.                                                              |


**Build order that actually works**

1. Melt four inserts in the cone from the **large rear opening**, not down through the front.
2. Connect power and harnesses *before* the PCB goes in — especially 5 V. Fixing power later means sliding the board out and back.
3. Screw the 12 mm button to the rectangular printed plate while it is still free.
4. Seat the PCB with power pins toward the edge so the cable can leave through the screw openings. Start screws; do not cinch them if pins stand proud. At least two screws; you may not use every hole.
5. Route cables forward. RFID on the single insert farther inside.
6. LED in the circular hole on the bottom (as in the PDF), seated lightly.
7. Screw the button plate onto its inserts.
8. **Do not** put the top cover on yet.

**Wall mount, then cover.** Inserts in the unused printed rear part (bottom holes; middle holes are the wall fasteners). Rear part behind the opening, insert holes on the underside. Module into the hole with the cover off; long screwdriver, M3 through the rear of the module. Then the top cover: pill-shaped opening aligned with the circular opening; small rectangular retainers into the side openings. To service later, push those retainers inward and the cover comes off.

The outdoor unit holds card material in flash until you opt into ESP32 flash encryption. That burn is irreversible and a first OTA flash without the USB/eFuse procedure will brick the board. Follow the Guardian flash-encryption path (USB, key backup, then OTA) if you care about someone unscrewing this reader. Rotating the card master key bricks every enrolled tag. That is a software procedure, not something this print changes.

**Siblings in this collection:** Interior Portal (the decision box — keypad, display, siren, reed, IMU) and Door lantern (Tapo camera + bulb, no PCB). Firmware and Gerbers live with Guardian System. Print files and CAD; the software tree is MIT.

**This is not** a weather-sealed commercial doorbell, a Ring/Nest replacement, or a standalone access-control product. The print is a housing for a proto board. Mount it where you would mount any outdoor PETG part that is not IP-rated.

---



## Platform extras


| Field            | MakerWorld                                                | Printables                                  |
| ---------------- | --------------------------------------------------------- | ------------------------------------------- |
| Collection       | Guardian System                                           | Guardian System                             |
| License dropdown | Standard Digital File (or CC-BY) + MIT line               | MIT                                         |
| Print profile    | Upload the `.3mf` as the Bambu profile                    | Same file; say “Bambu Studio profile, PETG” |
| BOM / parts      | Tables in the body                                        | Same; markdown tables render well           |
| Remix            | Housing remix OK; software/GPIO stay with Guardian System | Same under MIT                              |
| First 200 chars  | Search snippet — no “DIY burglar alarm”                   | Same                                        |


This file is a paste sheet. Do not create MakerWorld or Printables accounts from this tree.