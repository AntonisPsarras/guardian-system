# Hardware

Start here if you are printing, fabricating, or assembling. GPIO, secrets, and
the Home Assistant copy live in [`INSTALL.md`](../INSTALL.md).

| Page | What it is |
|---|---|
| [`documentation/`](documentation/) | Step-by-step assembly with photographs for the portal, the doorbell, and the lamp+camera. Each device folder also has a printable PDF. |
| [`bom.md`](bom.md) | One-page parts checklist (modules and passives). Not a pick-and-place file. |
| [`sounds/README.md`](sounds/README.md) | DFPlayer track names. The MP3s are not in this tree. |
| [`../PCBs/README.md`](../PCBs/README.md) | KiCad 10 projects and Gerber+drill zips for the two custom boards. |
| [`../3D-Models/README.md`](../3D-Models/README.md) | Print files: three `.3mf` profiles on MakerWorld / Printables. This tree does not ship STLs. |

| Device | Assembly | PDF | Print | PCB / Gerbers |
|---|---|---|---|---|
| [Interior portal](documentation/interior-portal/) | Keypad, display, speaker, RFID, reed, handle IMU | [PDF](documentation/interior-portal/Interior-Portal-Documentation.pdf) | `Internal-Portal-Final.3mf` | [`PCBs/Interior-Portal/`](../PCBs/Interior-Portal/) · [Gerber zip](../PCBs/Interior-Portal/Interior-Portal-Gerbers.zip) |
| [Doorbell](documentation/doorbell/) | Outdoor RFID reader and button | [PDF](documentation/doorbell/Doorbell-Documentation.pdf) | `Doorbell-Final.3mf` | [`PCBs/Doorbell/`](../PCBs/Doorbell/) · [Gerber zip](../PCBs/Doorbell/Doorbell-Gerbers.zip) |
| [Door lamp and camera](documentation/door-lamp-camera/) | Commercial bulb + camera in a printed lantern | [PDF](documentation/door-lamp-camera/Door-Lamp-Camera-Documentation.pdf) | `Lamp-Final.3mf` | None, on purpose |

Firmware is the pin authority. After the housing is closed, flash from
[`INSTALL.md`](../INSTALL.md) §7.

Assembly photographs stay in `documentation/`. Source photography of one
install is not in this public tree.
