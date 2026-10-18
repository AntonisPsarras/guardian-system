# Print files

This folder does **not** ship meshes. Print files live on MakerWorld,
Printables, and Thingiverse as separate models in the collection
[Guardian System](https://makerworld.com/en/collections/36079462-guardian-system)
(MakerWorld) /
[Guardian System](https://www.printables.com/@AntoniJuveni_3576373/collections/3780824)
(Printables, account `@AntoniJuveni_3576373`). The project handle is
`AntonisPsarras`. Assembly photographs stay in this repository.

Each listing should carry two downloads:

- The Bambu Studio profile (`.3mf`), PETG, supports already in the
  meshes — print as supplied.
- A generic STL zip for PrusaSlicer / Orca / Cura
  (`Lamp-Final-stl.zip`, `Internal-Portal-Final-stl.zip`,
  `Doorbell-Final-stl.zip`). Export from the `.3mf`: open it, select
  all objects, File → Export → STL. One zip per device. Do not
  strip the supports in the slicer to “save time.”

Do not commit those zips here unless you are changing that rule on
purpose. Upload the zip on Printables and Thingiverse next to the
`.3mf`.

| Device | Profile to download | MakerWorld | Printables | What is in it |
|---|---|---|---|---|
| Door lantern + camera housing | `Lamp-Final.3mf` | [listing](https://makerworld.com/en/models/3347455-guardian-door-lamp-housing-tapo-c110-lantern) | [listing](https://www.printables.com/model/1853736-guardian-door-lantern-tapo-c110-camera-l530e-hidde) | Tapo-sized lantern. Start here. |
| Interior portal (keypad, display, speaker, wall plate, reed, IMU) | `Internal-Portal-Final.3mf` | [listing](https://makerworld.com/en/models/3347482-guardian-interior-portal-keypad-and-display) | [listing](https://www.printables.com/model/1853748-guardian-interior-portal-esp32-s3-keypad-rfid-disp) | Exploded portal set |
| Doorbell | `Doorbell-Final.3mf` | [listing](https://makerworld.com/en/models/3347498-guardian-outdoor-doorbell-housing-esp32-c6) | [listing](https://www.printables.com/model/1853742-guardian-outdoor-doorbell-housing-esp32-c6) | Outdoor reader and button |

Print files and CAD for Guardian System are MIT, same as the software
tree. Do not upload superseded monoliths. Do not use installed-door
shots as covers. Do not enroll MakerWorld Exclusive — that would hide
Printables.

Assembly instructions (photographs, steps, and printable PDFs):

- [Interior portal](../docs/documentation/interior-portal/) · [PDF](../docs/documentation/interior-portal/Interior-Portal-Documentation.pdf)
- [Doorbell](../docs/documentation/doorbell/) · [PDF](../docs/documentation/doorbell/Doorbell-Documentation.pdf)
- [Door lamp + camera](../docs/documentation/door-lamp-camera/) · [PDF](../docs/documentation/door-lamp-camera/Door-Lamp-Camera-Documentation.pdf)

Index of print + PCB + flash: [`docs/README.md`](../docs/README.md).

Gerbers to send a fab (portal and doorbell; the lamp has none): [`PCBs/README.md`](../PCBs/README.md).

There is no lamp PCB to print around. The lamp is a commercial bulb in this housing; the camera is a commercial unit whose lens sits in the same print.
