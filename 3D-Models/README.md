# Print files

This folder does **not** ship meshes. Print files are three Bambu Studio
profiles (`.3mf`), posted on MakerWorld and Printables as separate models in
the collection [Guardian System](https://makerworld.com/en/collections/36079462-guardian-system)
(MakerWorld) / [Guardian System](https://www.printables.com/@AntoniJuveni_3576373/collections/3780824)
(Printables). Assembly photographs stay in this repository.

Print as supplied, in PETG. Supports are already part of the models.

| Device | Profile to download | MakerWorld | Printables | What is in it |
|---|---|---|---|---|
| Interior portal (keypad, display, speaker, wall plate, reed, IMU) | `Internal-Portal-Final.3mf` | [listing](https://makerworld.com/en/models/3347482-guardian-interior-portal-keypad-and-display) | [listing](https://www.printables.com/model/1853748-guardian-interior-portal-esp32-s3-keypad-rfid-disp) | Exploded portal set |
| Doorbell | `Doorbell-Final.3mf` | [listing](https://makerworld.com/en/models/3347498-guardian-outdoor-doorbell-housing-esp32-c6) | [listing](https://www.printables.com/model/1853742-guardian-outdoor-doorbell-housing-esp32-c6) | Outdoor reader and button |
| Door lamp + camera housing | `Lamp-Final.3mf` | [listing](https://makerworld.com/en/models/3347455-guardian-door-lamp-housing-tapo-c110-lantern) | [listing](https://www.printables.com/model/1853736-guardian-door-lantern-tapo-c110-camera-l530e-hidde) | Tapo-sized lantern |

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
