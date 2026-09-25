# Door lamp and camera

**Guardian System** — Tapo C110 and L530E in a printed lantern.

*This is an in-depth documentation of the Guardian System Door Lamp and Camera device.*

**Download PDF:** [Door-Lamp-Camera-Documentation.pdf](Door-Lamp-Camera-Documentation.pdf)

![Assembled and installed Door Lamp and Camera module.](images/01.jpg)

*Assembled and installed Door Lamp and Camera module.*

# 1. Module Overview

The Door Lamp and Camera module is the outward-facing part of the Guardian System. It watches the entrance and lights it, and it replaces an ordinary wall lantern next to the door.

Unlike the Doorbell and Interior Portal modules, this device contains no custom electronics and no PCB. It houses two off-the-shelf TP-Link Tapo devices — a Tapo C110 Wi-Fi camera and a Tapo L530E smart light bulb — inside a set of 3D-printed parts shaped like a conventional lantern, so the camera is not obvious at a glance. Both devices are brought into Home Assistant over the local network, which means the finished module runs without depending on the TP-Link cloud.

|   |
| --- |
| **3D-printing requirement:** Print `Lamp-Final.3mf` from MakerWorld or Printables (see [`3D-Models/README.md`](../../../3D-Models/README.md)), in PETG. Supports are already part of the models. |

|   |
| --- |
| **Mains electricity warning:** The light bulb side of this module is wired to mains voltage. Switch off the circuit at the consumer unit before touching any wiring, verify that it is dead, and follow the electrical regulations that apply where you live. If you are not confident doing fixed wiring, have this part done by a qualified electrician. |

## Document workflow

1. Set up the camera and the bulb in the Tapo app and create the local camera account.
2. Prepare the camera by removing its stock housing.
3. Print, and optionally paint, the housing parts.
4. Assemble the camera housing and install it into the main housing.
5. Fit the lamp holder and bulb, then mount the housing on the wall.
6. Close the housing with the light panels and the top cover.

# 2. Device Reference

This module has no schematic, so this section takes the place of the PCB reference used by the other Guardian System modules. The two devices below are what the printed housing is designed around; anything you substitute has to match them dimensionally and support local control.

| **Property** | **Tapo C110 (camera)** | **Tapo L530E (bulb)** |
| --- | --- | --- |
| Role in the module | Entrance video, motion and person detection | Entrance lighting and visual status indication |
| Wireless | 2.4 GHz Wi-Fi (802.11 b/g/n) only | 2.4 GHz Wi-Fi only |
| Key specification | 2K 3MP (2304 × 1296) at 15 fps, H.264; 129.4° diagonal field of view; 850 nm infrared night vision to about 9 m | E27 fitting, 806 lm (60 W equivalent), 2500–6500 K, colour, dimmable from 1 % to 100 % |
| Power | Supplied 9 V DC, 0.6 A adapter through the barrel socket on the camera body | Mains, through the E27 lamp holder |
| Local interfaces | RTSP on port 554 and ONVIF Profile S on port 2020 | Local API used by the Home Assistant TP-Link integration |
| Size of the bare device | 67.6 × 54.6 × 98.9 mm including the stock housing, which is removed for this build | Standard A60 bulb envelope |
| Rated environment | 0 °C to 40 °C, indoor use, no IP weather rating | Indoor / dry location |

|   |
| --- |
| **Weather exposure:** The C110 is an indoor camera with no IP rating, and the printed housing is not sealed. Mount this module only under a porch, soffit or other overhang where it is shielded from direct rain, and keep in mind the 0–40 °C rated range when deciding where it goes. In the original build the module sits under a covered entrance, as shown in the photographs. |

# 3. Hardware Needed

| **Quantity** | **Component** | **Purpose / note** |
| --- | --- | --- |
| 1 | TP-Link Tapo C110 camera | The camera electronics are transplanted into the printed camera housing; the stock plastics are discarded. |
| 1 | TP-Link Tapo L530E light bulb | Or any other light bulb with the same dimensions. |
| 1 | E27 lamp holder with a cable tail | Any holder that fits the printed cylinder. See the lamp-holder fit note below. |
| As needed | M3 threaded inserts (5.7 × 4.6 mm) | Two in the camera housing half that carries the lens hole, plus one in each M3-sized hole on the top of the main housing. Count the holes in your printed parts and fit an insert in each. |
| As needed | M3 screws | To match the threaded inserts: two for the camera housing and four for the top cover. |
| 4 | Wall screws or nails | For the four mounting holes inside the main housing. |
| 1 | 9 V DC power supply for the camera | The adapter supplied with the C110. Its cable is routed inside the housing to the camera. |
| — | Soldering iron, screwdrivers, double-sided tape | The soldering iron is only used to melt the threaded inserts into the printed parts. |
| Optional | Spray paint or acrylic paint | For the black finish shown in the photographs. Do not paint the white window panels. |

|   |
| --- |
| **Lamp-holder fit requirement:** The part of the lamp holder that sits inside the cylindrical element of the housing must have an external dimension smaller than 37 mm. The holder must terminate in a cable, not in a plug intended for a wall socket. |

|   |
| --- |
| **Powering the module:** You will have to work out the best way to route the cables and to supply power to both devices for your own installation. In the original build the existing "dumb" wall lamp was removed and this module was fitted in its place, which made it possible to power both the lamp and the camera from that same point. The bulb runs on mains through the lamp holder; the camera needs its own 9 V DC supply, so plan for both before you close up the housing. |

## Components Used in the Original Build

The following link points to the local Greek technology shop used for the original build:

- M3 threaded inserts: https://grobotronics.com/threaded-insert-m3-5-7x4-6mm.html

Manufacturer pages for the two premade devices, for specifications and firmware information:

- Tapo C110 camera: https://www.tapo.com/en/product/smart-camera/tapo-c110/
- Tapo L530E light bulb: https://www.tapo.com/en/product/smart-light-bulb/tapo-l530e/

# 4. Camera and Bulb Setup (Do This First)

Complete this section before you start printing. Both devices are far easier to configure while they are still assembled and sitting on a desk than after they are screwed inside a housing on a wall.

|   |
| --- |
| **Why the cloud is involved at all:** The Tapo app is the only supported way to provision these devices onto your Wi-Fi and to create the camera account, so a TP-Link account is needed at this stage. This is only temporary: the end result is fully local and does not depend on external infrastructure. |

|   |   |
| :---: | --- |
| **1** | **Add both devices in the Tapo app**<br>Power up the camera and screw the bulb into any convenient lamp, then add each of them to the Tapo app and connect them to your 2.4 GHz Wi-Fi network. Neither device supports 5 GHz, so if your router advertises one combined network name, make sure the 2.4 GHz band is reachable during setup. |

|   |   |
| :---: | --- |
| **2** | **Create the camera account**<br>In the Tapo app, open the camera, go into its advanced settings and create a camera account. This is a separate local username and password, not your TP-Link login, and it is what unlocks RTSP and ONVIF on the camera.<br>Make sure you remember these credentials, because they will be used while setting up the camera in Home Assistant. |

|   |   |
| :---: | --- |
| **3** | **Verify the video stream before you build**<br>Note the camera's local IP address in the app, then open its stream in a player such as VLC to confirm the credentials work:<br>rtsp://username:password@CAMERA-IP:554/stream1  — full resolution<br>rtsp://username:password@CAMERA-IP:554/stream2  — lower resolution substream<br>If the stream does not open, the camera account details are almost always the cause. Fixing this now saves dismantling the housing later. |

|   |   |
| :---: | --- |
| **4** | **Give the camera and the bulb fixed addresses**<br>Create DHCP reservations in your router for both devices. Home Assistant addresses them by IP, so an address that changes after a router reboot will silently break the integration. |

|   |   |
| :---: | --- |
| **5** | **Block the camera from the internet (optional)**<br>You can block the IP address of the camera through your router dashboard to make sure it never touches the cloud. Local RTSP, ONVIF and Home Assistant keep working, because they all stay on your LAN.<br>Be aware of the trade-offs: remote viewing through the Tapo app and over-the-air firmware updates will no longer work, and you will need to lift the block temporarily if you ever want to update the camera. |

|   |   |
| :---: | --- |
| **6** | **Disable the status LED (optional)**<br>The camera's indicator LED can be switched off in the Tapo app for improved stealthiness, which matters here because the lens sits in a lantern that is not supposed to look like a camera. |

|   |
| --- |
| **Stream limit:** The C110 serves a limited number of simultaneous video streams — in practice two. If Home Assistant, a viewer app and a recorder all pull from the camera at once, some of them will fail to connect. Point Home Assistant at the camera and let everything else view it through Home Assistant. |

# 5. Preparing the Camera Electronics

With the camera configured, the next step is to strip it down so the electronics can be installed into the custom 3D-printed housing.

|   |   |
| :---: | --- |
| **1** | **Remove the stock housing**<br>Unplug the camera first. Then remove the housing of the camera in order to install it into the custom 3D printed one. You can watch a tutorial for this, and it is an easy process. |

|   |   |
| :---: | --- |
| **2** | **Unplug the built-in speaker**<br>The only part of the electronics you have to change is to unplug the built-in speaker, which will not be used in the Guardian System. |

|   |   |
| :---: | --- |
| **3** | **Leave the microSD slot empty**<br>You do not need to plug in an SD card, as clip and recording management will be handled in Home Assistant. There you will have to choose your preferred storage method. |

|   |   |
| :---: | --- |
| **4** | **Keep the lens bezel**<br>Do not remove the rectangular part that surrounds the lens and carries the LED. That part is used in the system and is what the printed camera housing is built around. |

|   |
| --- |
| **Handle with care:** Opening the camera will void its warranty. Work on a non-conductive surface, hold the board by its edges, and keep the ribbon connector for the lens assembly seated — it is the easiest thing to disturb while the housing comes apart. |

# 6. Printing and Painting

Now that the electronics are ready, the next step is printing the housing parts. You do not need to change any element of the 3D files; they are fully optimized for the best printing and results.

|   |
| --- |
| **Prototype note:** Ignore defects and broken parts visible on the housing images in this document. They were taken with older prototyping models. The models you have been provided with are the final and optimized versions. |

|   |   |
| :---: | --- |
| **1** | **Print the parts as supplied**<br>The original build used white PETG. It achieves acceptable transparency through the window panels while still covering any cable work on the inside. |

|   |   |
| :---: | --- |
| **2** | **Paint the parts (optional)**<br>You are free to paint all the models, and this was done for the build shown here. Do not paint the white windows: paint affects the ability of light to pass through to the other side.<br>Keep paint out of the channel the camera housing slides into. A build-up of paint there can make the camera housing impossible to slide in. |

# 7. Camera Housing Assembly

After the prints are done, and the painting if you chose to do that, the first step is to assemble the 3D-printed camera housing.

|   |   |
| :---: | --- |
| **1** | **Install the threaded inserts**<br>Place M3 threaded inserts into the holes on the side of the camera housing that carries the circular lens hole. These inserts are what lock the two halves, top and bottom, together.<br>Set each insert into its hole, touch it with the tip of a soldering iron and let it sink in slowly under its own weight, keeping it square to the surface. |

|   |   |
| :---: | --- |
| **2** | **Seat the camera**<br>With the stock camera housing removed, place the camera onto the part that has the threaded inserts, making sure that the power port aligns with the hole on the side of the housing. |

|   |   |
| :---: | --- |
| **3** | **Close the camera housing**<br>Place the other 3D-printed part over the camera and screw the two halves together onto the inserts. |

|   |   |
| :---: | --- |
| **4** | **Install the camera housing into the main housing**<br>Slide the camera housing into the main housing part, then from the internal side place the circular part into the hole to lock the camera in place.<br>Make sure you do not get any paint into the area the camera slides through, because that can make the slide impossible. |

|   |   |
| :---: | --- |
| **5** | **Route the camera power cable**<br>From the internal side, route the camera's 9 V power cable so that it can reach the camera's power port. Leave a little slack: the cable has to survive the housing being lifted onto the wall later. |

# 8. Main Housing and Lamp Assembly

|   |   |
| :---: | --- |
| **1** | **Install the remaining threaded inserts**<br>On the main housing, melt M3 threaded inserts into the holes on the top. These take the four screws that hold the top cover down at the end of the build. |

|   |   |
| :---: | --- |
| **2** | **Wire and fit the lamp holder**<br>With the circuit switched off at the consumer unit, connect the lamp holder's cable to your mains supply and screw the bulb into the holder.<br>Then place the holder into the cylindrical structure on the inside of the main housing. There is no pressure fitting here: the lamp just sits in place, and no extra securing is needed. |

![Inside of the main housing: the lamp holder mounted at the top, the camera cable routed in from the left, and the three white light panels seated in their slots. The panels are shown fitted here for clarity; in the build order they go in last, after the housing is on the wall.](images/02.jpg)

*Inside of the main housing: the lamp holder mounted at the top, the camera cable routed in from the left, and the three white light panels seated in their slots. The panels are shown fitted here for clarity; in the build order they go in last, after the housing is on the wall.*

![The same view with the bulb screwed into the holder, ready for the housing to be mounted.](images/03.jpg)

*The same view with the bulb screwed into the holder, ready for the housing to be mounted.*

|   |
| --- |
| **Leave the covers off for now:** Do not fit the white panels or the top cover yet. The four wall-mounting holes are reached from inside the housing, so the housing has to stay open until it is fixed to the wall. |

# 9. Wall Mounting

|   |   |
| :---: | --- |
| **1** | **Position the housing**<br>After the lamp and camera are in place, it is time to place the whole device on the wall; the rest is done afterwards. Position the housing where you want it, keeping the camera's view of the doorway in mind, and check that it is under cover. |

|   |   |
| :---: | --- |
| **2** | **Fix it to the wall**<br>Secure the housing through the four holes on the inside, using screws or nails to suit your wall. |

|   |   |
| :---: | --- |
| **3** | **Finish the cable work**<br>Route and tidy the mains cable to the lamp holder and the 9 V cable to the camera, then restore power and confirm that both devices come back online in the Tapo app or in Home Assistant before you close the housing. |

# 10. Final Assembly

|   |   |
| :---: | --- |
| **1** | **Fit the light panels**<br>Slide the three white covers on the front into place in their slots. |

|   |   |
| :---: | --- |
| **2** | **Fit the top cover**<br>Close the top with the top cover, aligning it with the threaded inserts on the top of the main housing. |

|   |   |
| :---: | --- |
| **3** | **Secure everything**<br>Screw in the four screws to secure the top cover and, with it, the rest of the assembly. The module is now closed and finished. |

![The top cover fitted and held down by its four M3 screws.](images/04.jpg)

*The top cover fitted and held down by its four M3 screws.*

![Finished housing seen from the front, with the painted shell, the three white panels and the top cover in place.](images/05.jpg)

*Finished housing seen from the front, with the painted shell, the three white panels and the top cover in place.*

|   |
| --- |
| **Assembly complete:** With the camera transplanted, the lamp holder and bulb fitted, the housing mounted and the covers screwed down, the Door Lamp and Camera module is finished. What remains is bringing both devices into Home Assistant. |

# 11. Home Assistant Integration

The mechanical build is finished, but the module only becomes part of the Guardian System once both devices are talking to Home Assistant on the local network. Day-one wiring of entities, Frigate, and the lamp helper is [`INSTALL.md`](../../../INSTALL.md) (camera / Frigate in §2 and §6; lamp discovery on the panel). This section is an outline of the route used in the original build, not a second install guide.

Guardian itself does **not** need HACS. The panel is a `panel_custom` served from `/config/www`.

## The camera

- The C110 exposes RTSP on port 554 and ONVIF Profile S on port 2020, both authenticated with the camera account created in section 4.
- Home Assistant's built-in ONVIF or generic camera integrations will pull the stream directly from the RTSP URL you already tested.
- A community integration, Tapo: Cameras Control, is also widely used for these cameras and adds motion events and device controls on top of the plain stream. It is **optional**, installed through HACS if you want it. Guardian's person-detection path is Frigate over MQTT, documented in [`INSTALL.md`](../../../INSTALL.md) — you do not need HACS for that.
- Recording and clip management happen on the Home Assistant side, which is why no microSD card is fitted in the camera. Choose your preferred storage method there.

## The bulb

- The L530E is supported by the official TP-Link Smart Home integration in Home Assistant, which controls it over the LAN.
- On current firmware the integration asks for your TP-Link account credentials during setup. These are used to authenticate against the bulb; the control traffic itself still stays local.
- Because the bulb is a full colour light, it can double as a status indicator for the Guardian System rather than being only a porch light.

|   |
| --- |
| **Firmware updates:** TP-Link firmware updates occasionally change how these devices authenticate and can temporarily break local integrations. If you want a system that stays predictable, turn off automatic firmware updates in the Tapo app for both devices once everything works. |

# 12. Troubleshooting

| **Symptom** | **What to check** |
| --- | --- |
| The RTSP stream will not open | The camera account credentials are being used, not the TP-Link app login. Try the substream (/stream2) as well, and confirm the camera is on the same network segment as Home Assistant. |
| The camera disappears after a router reboot | Its IP address has changed. Add a DHCP reservation so it always comes back on the same address. |
| The stream connects, then drops when something else opens it | The camera only serves a small number of simultaneous streams. Let Home Assistant be the single consumer and view everything through it. |
| The bulb shows as unavailable in Home Assistant | Re-enter the TP-Link credentials in the integration. This is the usual symptom after a firmware update or a credential change. |
| Nothing responds after blocking the camera at the router | Confirm the block only covers internet (WAN) access and not local traffic. Home Assistant needs to reach the camera on the LAN. |
| The light panels look uneven or dim | Check that they were not painted and that they are fully seated in their slots. |
| The camera housing will not slide in | Paint build-up in the channel. Clean the channel out and, if necessary, take the paint back down to the printed surface. |

![Completed Door Lamp and Camera module, installed above the entrance.](images/01.jpg)

*Completed Door Lamp and Camera module, installed above the entrance.*
