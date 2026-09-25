# Parts checklist

One page for a stranger ordering parts. Values match [`PCBs/README.md`](../PCBs/README.md) and [`INSTALL.md`](../INSTALL.md) §1. This is **not** a pick-and-place / CPL file and not a DigiKey cart. The Greek shop links are what the original build used; search the generic name at any supplier.

Print files: `Lamp-Final.3mf`, `Internal-Portal-Final.3mf`, `Doorbell-Final.3mf` on MakerWorld / Printables ([`3D-Models/README.md`](../3D-Models/README.md)). Assembly photographs: [`documentation/`](documentation/). Sound card (no MP3s in this tree): [`sounds/README.md`](sounds/README.md).

There is no lamp PCB. Substitutes must fit the printed housing.

## Interior portal

| Qty | What | Search for / notes | Original-build link |
|---|---|---|---|
| 1 | ESP32-S3 DevKit, 8 MB flash, octal PSRAM | Firmware `flash_size: 8MB`. A 32 MB Waveshare module still runs that build; do not change firmware to 32 MB if the chip is 8 MB. | [grobotronics Waveshare ESP32-S3](https://grobotronics.com/waveshare-esp32-s3-32mb.html) |
| 1 | MFRC522 RFID module | RC522, 13.56 MHz, I²C or the cable that matches the header | [grobotronics RC522](https://grobotronics.com/acebott-easy-plug-rfid-rc522-module.html) |
| 1 | MPU6050 IMU | GY-521 | [grobotronics MPU6050](https://grobotronics.com/gy-521-mpu6050-3-axis-gyroscope-and-accelerometer-imu.html) |
| 1 | DFPlayer Mini | microSD slot on the module | [grobotronics DFPlayer](https://grobotronics.com/dfplayer-a-mini-mp3-player.html) |
| 1 | microSD card, FAT32 | Holds `/MP3/0001.mp3`–`0005.mp3`. Not sold as a kit. | — |
| 1 | Small speaker | Two-wire, fits the printed speaker housing | — |
| 1 | 4×3 matrix keypad | 7-pin harness; firmware rows GPIO4/7/6/5, columns GPIO1/2/15 | — |
| 1 | 240×135 ST7789V IPS, SPI | 1.14" class | [grobotronics 240×135 IPS](https://grobotronics.com/display-1.14-240x135-ips-spi-interface.html) |
| 1 | Reed switch and magnet | Door contact | [grobotronics reed](https://grobotronics.com/magnetic-reed-switch.html) |
| 3 | 220 Ω axial THT (R1–R3) | DIN0207. Status LED. | any |
| 2 | 1 kΩ axial THT (R4–R5) | DIN0207 | any |
| 1 | 1000 µF 10 V radial (C1) | D10.0 mm, P5.00 mm. Polarised. Match `+` on the board. | any |
| 1 optional | 5 mm RGB LED, common anode | Troubleshooting | [grobotronics RGB](https://grobotronics.com/led-diffused-5mm-rgb-common-anode.html) |
| ~20 | M3 threaded inserts | 5.7 × 4.6 mm in the original build | [grobotronics M3 inserts](https://grobotronics.com/threaded-insert-m3-5-7x4-6mm.html) |
| — | Headers | 2× 1×22 female (ESP32); 1× 4×1 male (keypad); 3× 1×2 male; 3× 1×4 male; 2× 1×8 female (DFPlayer). 2.54 mm. | any |
| 1 | 5 V supply for the portal | Sized for ESP32-S3 + DFPlayer + display. Not specified beyond 5 V. | — |

PCB: send [`PCBs/Interior-Portal/Interior-Portal-Gerbers.zip`](../PCBs/Interior-Portal/Interior-Portal-Gerbers.zip) to a proto fab. Hand-solder.

## Doorbell

| Qty | What | Search for / notes | Original-build link |
|---|---|---|---|
| 1 | Seeed Studio XIAO ESP32-C6 | USB-C toward the RFID header | [grobotronics XIAO C6](https://grobotronics.com/seeed-studio-xiao-esp32-c6.html) |
| 1 | MFRC522 RFID module | Same family as the portal | [grobotronics RC522](https://grobotronics.com/acebott-easy-plug-rfid-rc522-module.html) |
| 1 | 12 mm momentary push button | Red in the original build | [grobotronics 12 mm](https://grobotronics.com/push-button-momentary-12mm-red.html) |
| 3 | 220 Ω axial THT (R1–R3) | Optional RGB LED | any |
| 1 | 10 kΩ axial THT (R4) | Button. Firmware also enables the internal pull-up. | any |
| 1 optional | 5 mm RGB LED, common anode | Status | [grobotronics RGB](https://grobotronics.com/led-diffused-5mm-rgb-common-anode.html) |
| 15+ | M3 threaded inserts | Same size as the portal | [grobotronics M3 inserts](https://grobotronics.com/threaded-insert-m3-5-7x4-6mm.html) |
| — | Headers | 2× 1×7 female, 2× 1×4 female, 2× 1×2 female, or solder the XIAO down. 2.54 mm. | any |
| 1 | 5 V supply | Marked `5V` / `G` on the board. Polarity matters. | — |

PCB: send [`PCBs/Doorbell/Doorbell-Gerbers.zip`](../PCBs/Doorbell/Doorbell-Gerbers.zip). Wall opening at least 54 mm diameter, cavity no deeper than 45 mm.

## Door lamp and camera

No PCB. The print is sized around these two commercial parts; anything else has to match them.

| Qty | What | Search for / notes | Original-build link |
|---|---|---|---|
| 1 | TP-Link Tapo C110 | Indoor camera. Stock housing is discarded. Local RTSP / ONVIF. | vendor |
| 1 | TP-Link Tapo L530E or same-size A60 | E27, colour, local HA integration | vendor |
| 1 | E27 lamp holder with a cable tail | Body outside diameter under 37 mm. Not a wall-plug holder. | any |
| 1 | 9 V DC 0.6 A adapter | The C110 supply | comes with the camera |
| — | M3 inserts and screws | Count the holes in the printed parts | [grobotronics M3 inserts](https://grobotronics.com/threaded-insert-m3-5-7x4-6mm.html) |
| 4 | Wall screws | Inside the main housing | any |

Mains on the bulb side. If you are not confident with fixed wiring, have that part done by a qualified electrician. The C110 is indoor-rated; mount under a porch or soffit.

## What this list does not include

- A CPL / centroid file. These are through-hole proto boards.
- MP3 files for the DFPlayer.
- A KiCad-exported CSV. Open the projects in [`PCBs/`](../PCBs/) if you need one.
- GPIO names. Firmware is the pin authority ([`INSTALL.md`](../INSTALL.md) §1).
