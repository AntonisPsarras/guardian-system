# Print files

This folder does **not** ship meshes. Print files are three Bambu Studio
profiles (`.3mf`). Print as supplied, in PETG. Supports are already part
of the models.

| Device | Profile to download | What is in it |
|---|---|---|
| Interior portal (keypad, display, speaker, wall plate, reed, IMU) | `Internal-Portal-Final.3mf` | Exploded portal set |
| Doorbell | `Doorbell-Final.3mf` | Outdoor reader and button |
| Door lamp + camera housing | `Lamp-Final.3mf` | Tapo-sized lantern |

They are posted (or being posted) on MakerWorld and Printables as the
collection **Guardian System**. The Printables author page is
[AntoniJuvenikal](https://www.printables.com/@AntoniJuveni_3576373).
Intended per-model URLs live in
[`docs/maintainers/print-listings.md`](../docs/maintainers/print-listings.md)
— those listings are still draft or private until you publish them, so
this README does not treat them as live.

Print files and CAD for Guardian System are MIT, same as the software
tree. Do not upload superseded monoliths. Do not use installed-door
shots as covers.

Assembly instructions (photographs, steps, and printable PDFs):

- [Interior portal](../docs/documentation/interior-portal/) · [PDF](../docs/documentation/interior-portal/Interior-Portal-Documentation.pdf)
- [Doorbell](../docs/documentation/doorbell/) · [PDF](../docs/documentation/doorbell/Doorbell-Documentation.pdf)
- [Door lamp + camera](../docs/documentation/door-lamp-camera/) · [PDF](../docs/documentation/door-lamp-camera/Door-Lamp-Camera-Documentation.pdf)

Index of print + PCB + flash: [`docs/README.md`](../docs/README.md).

Gerbers to send a fab (portal and doorbell; the lamp has none): [`PCBs/README.md`](../PCBs/README.md).

There is no lamp PCB to print around. The lamp is a commercial bulb in this housing; the camera is a commercial unit whose lens sits in the same print.
