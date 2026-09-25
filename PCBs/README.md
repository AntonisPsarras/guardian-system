# PCBs

Two through-hole boards live here. Send a fab the Gerber zip for the board you
want made; solder the modules yourself. There is no lamp PCB — that housing
takes a commercial bulb and a commercial camera.

Firmware is the pin authority. The schematics use generic connectors and
auto-named nets, not GPIO labels. Derive the pinout from
[`esphome/portal-unit.yaml`](../esphome/portal-unit.yaml) and
[`esphome/doorbell-unit.yaml`](../esphome/doorbell-unit.yaml), or from the table
in [`INSTALL.md`](../INSTALL.md) §1.

Assembly photographs and soldering order:
[`docs/documentation/interior-portal/`](../docs/documentation/interior-portal/)
and [`docs/documentation/doorbell/`](../docs/documentation/doorbell/).

## What to send a fab

Each zip is a complete 2-layer Gerber + drill set: copper, soldermask, paste,
silkscreen, edge cuts, plated and non-plated drill, and the job file.

| Board | KiCad project | Send this zip |
|---|---|---|
| Interior portal (ESP32-S3) | [`Interior-Portal/`](Interior-Portal/) | [`Interior-Portal/Interior-Portal-Gerbers.zip`](Interior-Portal/Interior-Portal-Gerbers.zip) |
| Doorbell (XIAO ESP32-C6) | [`Doorbell/`](Doorbell/) | [`Doorbell/Doorbell-Gerbers.zip`](Doorbell/Doorbell-Gerbers.zip) |
| Door lamp + camera | — | None. Commercial parts in a printed housing. |

Designed in **KiCad 10.0**. These are **THT proto boards**, not an SMT
assembly job. There is no pick-and-place / CPL file, and none is needed:
a board house fabricates the bare PCB; you populate headers, resistors,
and the polarised capacitor by hand.

**Upload the zip. Do not request SMT / JLCPCB assembly.**

### Fab card

| | Interior portal | Doorbell |
|---|---|---|
| Outline | 50.8 × 124.5 mm | 48.3 × 35.6 mm |
| Layers | 2 | 2 |
| Thickness | 1.6 mm | 1.6 mm |
| Copper | 1 oz | 1 oz |
| Finish | HASL | HASL |
| Soldermask / silk | green / white (fab default is fine) | green / white |
| Schematic (no KiCad needed) | [`Interior-Portal-schematic.pdf`](Interior-Portal/Interior-Portal-schematic.pdf) | [`Doorbell-schematic.pdf`](Doorbell/Doorbell-schematic.pdf) |
| Assembly photos | [interior-portal](../docs/documentation/interior-portal/images/03.png) | [doorbell](../docs/documentation/doorbell/images/03.png) |

Boards, prints, and firmware in this repository are [MIT](../LICENSE).

## Interior portal BOM (placed passives)

Values match the KiCad instances and the silkscreen.

| Qty | Ref | Value | Footprint | Notes |
|---|---|---|---|---|
| 3 | R1–R3 | 220 Ω | Axial THT (DIN0207) | Status LED |
| 2 | R4–R5 | 1 kΩ | Axial THT (DIN0207) | |
| 1 | C1 | 1000 µF 10 V | Radial D10.0 mm, P5.00 mm | Polarised. Match the `+` mark on the board. |

Plus: ESP32-S3 DevKit (firmware `flash_size: 8MB`), MFRC522, MPU6050, DFPlayer
Mini, 4×3 keypad, 240×135 ST7789 IPS, reed switch, speaker, headers as in the
assembly doc.

## Doorbell BOM (placed passives)

| Qty | Ref | Value | Footprint | Notes |
|---|---|---|---|---|
| 3 | R1–R3 | 220 Ω | Axial THT (DIN0207) | Optional RGB LED |
| 1 | R4 | 10 kΩ | Axial THT (DIN0207) | Push button. Firmware also enables the ESP32 internal pull-up, so the button still works with no external resistor. |

Plus: Seeed Studio XIAO ESP32-C6, MFRC522, 12 mm momentary button, optional
common-anode 5 mm RGB LED, headers as in the assembly doc.

The RFID header is labelled **RFID1**.

## What is still not in these files

- No GPIO names on the nets (`Net-(XIAO_LEFT1-Pin_1)`, not `SDA`).
- Unused MCU pads are unconnected on purpose.
- No IPC-2581, ODB++, or CPL — those are for SMT / contract manufacturing.
