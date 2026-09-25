# Hardware assembly

Print the parts, fabricate or hand-solder the two boards, then flash. This
folder is the step-by-step with photographs. Hardware index:
[`docs/README.md`](../README.md). GPIO, secrets, and the Home Assistant copy
live in [`INSTALL.md`](../../INSTALL.md).

| Device | Assembly | PDF | Print | PCB / Gerbers |
|---|---|---|---|---|
| [Interior portal](interior-portal/) | Keypad, display, speaker, RFID, reed, handle IMU | [PDF](interior-portal/Interior-Portal-Documentation.pdf) | `Internal-Portal-Final.3mf` on MakerWorld / Printables | [`PCBs/Interior-Portal/`](../../PCBs/Interior-Portal/) · [Gerber zip](../../PCBs/Interior-Portal/Interior-Portal-Gerbers.zip) |
| [Doorbell](doorbell/) | Outdoor RFID reader and button | [PDF](doorbell/Doorbell-Documentation.pdf) | `Doorbell-Final.3mf` on MakerWorld / Printables | [`PCBs/Doorbell/`](../../PCBs/Doorbell/) · [Gerber zip](../../PCBs/Doorbell/Doorbell-Gerbers.zip) |
| [Door lamp and camera](door-lamp-camera/) | Commercial bulb + camera in a printed lantern | [PDF](door-lamp-camera/Door-Lamp-Camera-Documentation.pdf) | `Lamp-Final.3mf` on MakerWorld / Printables | None, on purpose |

**Firmware is the pin authority.** The KiCad nets are auto-named off generic
connectors. After the housing is closed, flash from
[`INSTALL.md`](../../INSTALL.md) §7 using [`esphome/portal-unit.yaml`](../../esphome/portal-unit.yaml)
and [`esphome/doorbell-unit.yaml`](../../esphome/doorbell-unit.yaml).

What to send a board house, and the valued passives: [`PCBs/README.md`](../../PCBs/README.md).
One-page parts checklist: [`../bom.md`](../bom.md).
DFPlayer tracks (no MP3s in the tree): [`../sounds/README.md`](../sounds/README.md).
Print settings: [`3D-Models/README.md`](../../3D-Models/README.md).

Listing cover photographs — bench shots, not the installed door:

- Portal: [`interior-portal/images/23.jpg`](interior-portal/images/23.jpg)
- Doorbell: [`doorbell/images/09.jpg`](doorbell/images/09.jpg)
- Lamp: [`door-lamp-camera/images/01.jpg`](door-lamp-camera/images/01.jpg)

Do not use installed-door or in-progress soldering shots as listing covers.
