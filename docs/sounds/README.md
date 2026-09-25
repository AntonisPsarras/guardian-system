# DFPlayer sound card

The portal siren and chirps are MP3 files on a microSD card in the DFPlayer
Mini. They are **not in this repository**. You have to supply five tracks
you have the right to use.

The serial link carries playback commands only. The card is wired to the
DFPlayer, not to the ESP32. Changing a sound means opening the portal.

## Card layout

Format the card FAT32. Put the files in a folder named `MP3` at the root,
using these four-digit names. Firmware calls `play_mp3` (command 0x12) by
that number. Copying files into the card root in a random order and using
plain `play` is how an earlier card played the alarm as a chime.

| File on the card | Firmware `play_mp3` | What it is |
|---|---|---|
| `/MP3/0001.mp3` | file 1 | Doorbell |
| `/MP3/0002.mp3` | file 2 | Access denied |
| `/MP3/0003.mp3` | file 3 | MFA / PIN challenge |
| `/MP3/0004.mp3` | file 4 | **Alarm.** Networked siren and the offline local siren. |
| `/MP3/0005.mp3` | file 5 | Welcome / granted |

As of 2.30.0 the firmware sets volume to **30** (module maximum) on boot.
If the alarm is still too quiet after a reflash, the speaker and the housing
are the remaining variables.

Track 4 is what [`INSTALL.md`](../../INSTALL.md) §9 and `DEPLOY.md` steps
275–282 mean by “file 4”. The offline local siren compiles and has not been
heard on hardware. Do not treat a missing or silent track 4 as a working
alarm.

Soldering and the microSD slot: [`documentation/interior-portal/`](../documentation/interior-portal/) §8.
