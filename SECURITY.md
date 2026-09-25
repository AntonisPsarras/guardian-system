# Security

Guardian is a burglar-alarm configuration published **as is, without
warranty**. Read [README.md](README.md) § Security model and
[INSTALL.md](INSTALL.md) §10 before you treat it as an alarm.

## Reporting a problem

Open a GitHub issue if the report contains **no** live credential.

Do **not** put any of the following in an issue, pull request, or
screenshot:

- Wi-Fi SSID or password
- ESPHome API / OTA / encryption keys
- `guardian_rfid_mac_key` or any card master key
- A camera RTSP URL, MQTT password, or Home Assistant token
- A live PIN, card UID, or card hash
- A dump of `esphome/secrets.yaml` or `frigate/config.yml`

Describe the class of issue (for example “the offline siren does not
start when Home Assistant is unreachable”) and the firmware / config
version from the panel footer.

If you have a credential-shaped finding, rotate the affected secret on
your install first, then describe the *class* of leak without the value.

## What this tree treats as a secret

| Surface | Where it lives | In git? |
|---|---|---|
| Wi-Fi, device keys, card master key | `esphome/secrets.yaml` | No. Generate with `tools/guardian-gen-secrets.py`. |
| Camera RTSP and MQTT | Frigate add-on environment / `frigate/config.yml` | No. Only `frigate/config.yml.example` is tracked. |
| Master PIN | Home Assistant helper, unsalted SHA-256 | Not in this tree. Treat it as a door second factor, not a secret that survives a backup. |

The card master key is compiled into both firmwares in **cleartext flash**
until you opt into flash encryption. That procedure is
[INSTALL.md](INSTALL.md) § Flash encryption. It is a one-time USB
provision and an irreversible eFuse burn. The shipped YAML does not
enable it: a first encrypted flash over OTA would brick the board.

## What this tree does not claim

- The siren is not proven without Wi-Fi and Home Assistant until you
  flash current firmware and hear it (see README).
- A Home Assistant login is the outer authorization boundary. Guardian
  scripts refuse another person’s key once a second account is rostered;
  Developer Tools can still call services.
- MIFARE Classic is clonable. Use NTAG21x.

Do not port-forward Home Assistant. Remote access is [INSTALL.md](INSTALL.md)
§10.
