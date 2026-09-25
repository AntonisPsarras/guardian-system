#!/usr/bin/env python3
# Guardian ambient-light probe. Invoked by Home Assistant command_line / shell_command
# as `python3 /config/guardian/guardian-luminance.py` so a Windows CRLF copy cannot
# break BusyBox ash. The thin guardian-luminance.sh wrapper execs this file.
#
# Usage:
#   guardian-luminance.py <path-to-jpeg> [max-age-seconds]
#   guardian-luminance.py --retune
#   guardian-luminance.py --write-run <mode> <sun> <rotate> <ir>
#
# Measure mode prints a single luma value in the range 0.0-255.0 to stdout and
# exits 0. On any failure it prints NOTHING and exits non-zero, so the
# command_line sensor's availability template marks the reading unavailable
# rather than letting the caller act on a confident wrong number.
#
# Which statistic is printed depends on /config/guardian/luma-run.env:
#
#   Manual (default, missing file, or any error reading it): the 25th
#   percentile of ITU-R 601-2 luma over the BOTTOM 60% of the frame AFTER
#   rotate= (counter-clockwise degrees, default 90).
#
#   Auto, with a ready profile: pixel p25 over the learned relevant-tile mask
#   (also after rotate=). Auto without a ready profile, or if the mask cannot
#   be applied: the same manual statistic.
#
#   ir=0 (night-vision entity not configured) AND sun is not daytime
#   (missing, or elevation <= 10): a near-greyscale or magenta night-vision
#   frame is reported as dark (capped at 12) and is not appended to
#   luma-samples.jsonl. The cap does not run when sun elevation is > 10, so an
#   underexposed noon still cannot look like night-vision (luma=12.0 +
#   off_sun_override).
#
# Implemented with Python + Pillow rather than ImageMagick: both ship inside
# the Home Assistant core container. Do not test this from the SSH add-on;
# that container has no python3.

import base64
import json
import os
import sys
import time

try:
    from PIL import Image
except ImportError:
    Image = None

DIR = os.environ.get("GUARDIAN_LUMA_DIR", "/config/guardian")
GRID_W = 16
GRID_H = 9
GRID = GRID_W * GRID_H
NIGHT_SUN = -6.0
DAY_SUN = 10.0
MIN_NIGHT = 8
MIN_DAY = 8
MIN_SPAN_S = 3 * 3600
MIN_TILES = 16
MIN_DELTA = 20.0
NIGHT_BRIGHT = 70.0
DAY_DARK = 35.0
MIN_TYP_GAP = 30.0
MIN_BAND = 25.0
RETUNE_EVERY_S = 12 * 3600
MAX_AGE_S = 14 * 86400
MAX_SAMPLES = 2500


def atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        if not text.endswith("\n"):
            f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def write_cal(ready, dark=0, bright=0, n_day=0, n_night=0, tiles=0):
    payload = {
        "ready": 1 if ready else 0,
        "dark": round(float(dark), 1),
        "bright": round(float(bright), 1),
        "n_day": int(n_day),
        "n_night": int(n_night),
        "tiles": int(tiles),
    }
    os.makedirs(DIR, exist_ok=True)
    atomic_write(
        os.path.join(DIR, "luma-cal.txt"),
        json.dumps(payload, separators=(",", ":")),
    )


def pack_mask(bits):
    out = bytearray((len(bits) + 7) // 8)
    for i, bit in enumerate(bits):
        if bit:
            out[i // 8] |= 1 << (i % 8)
    return base64.b64encode(bytes(out)).decode("ascii")


def unpack_mask(s, n=GRID):
    raw = base64.b64decode(s.encode("ascii"))
    bits = []
    for i in range(n):
        if i // 8 >= len(raw):
            bits.append(False)
        else:
            bits.append(bool(raw[i // 8] & (1 << (i % 8))))
    return bits


def median(vals):
    s = sorted(vals)
    n = len(s)
    if n == 0:
        return None
    mid = n // 2
    if n % 2:
        return float(s[mid])
    return (s[mid - 1] + s[mid]) / 2.0


def percentile_of(vals, p):
    s = sorted(vals)
    if not s:
        return None
    if len(s) == 1:
        return float(s[0])
    idx = int(round((len(s) - 1) * p))
    idx = min(max(idx, 0), len(s) - 1)
    return float(s[idx])


def p25_of(vals):
    s = sorted(vals)
    if not s:
        return None
    need = len(s) * 0.25
    cum = 0
    out = s[0]
    for v in s:
        cum += 1
        if cum >= need:
            out = v
            break
    return float(out)


def load_profile():
    path = os.path.join(DIR, "luma-profile.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            p = json.load(f)
        if isinstance(p, dict):
            return p
    except Exception:
        pass
    return None


def load_samples():
    path = os.path.join(DIR, "luma-samples.jsonl")
    now = time.time()
    cutoff = now - MAX_AGE_S
    rows = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                try:
                    t = float(obj.get("t", 0))
                    sun = float(obj.get("s"))
                    raw = base64.b64decode(obj.get("g", ""))
                except Exception:
                    continue
                if t < cutoff or len(raw) != GRID:
                    continue
                rows.append({"t": t, "s": sun, "tiles": list(raw)})
    except OSError:
        return []
    if len(rows) > MAX_SAMPLES:
        rows = rows[-MAX_SAMPLES:]
    return rows


def rewrite_samples(rows):
    path = os.path.join(DIR, "luma-samples.jsonl")
    lines = []
    for row in rows:
        rec = {
            "t": int(row["t"]),
            "s": round(float(row["s"]), 2),
            "g": base64.b64encode(bytes(row["tiles"])).decode("ascii"),
        }
        lines.append(json.dumps(rec, separators=(",", ":")))
    atomic_write(path, "\n".join(lines) + ("\n" if lines else ""))


def cal_from_profile(profile):
    write_cal(
        bool(profile.get("ready")),
        profile.get("dark", 0),
        profile.get("bright", 0),
        profile.get("n_day", 0),
        profile.get("n_night", 0),
        profile.get("n_tiles", 0),
    )


def thresholds(night_stats, day_stats):
    night_typ = median(night_stats)
    day_typ = median(day_stats)
    night_p90 = percentile_of(night_stats, 0.90)
    day_p10 = percentile_of(day_stats, 0.10)
    if None in (night_typ, day_typ, night_p90, day_p10):
        return None
    span = day_typ - night_typ
    if span < MIN_TYP_GAP:
        return None
    dark = night_p90 + max(8.0, 0.15 * span)
    bright = day_p10 - max(8.0, 0.10 * span)
    dark = max(dark, night_typ + 5.0)
    bright = min(bright, day_typ - 5.0)
    if bright - dark < MIN_BAND:
        mid = (dark + bright) / 2.0
        dark = mid - (MIN_BAND / 2.0)
        bright = dark + MIN_BAND
        dark = max(dark, night_p90 + 5.0)
        if bright - dark < MIN_BAND:
            bright = dark + MIN_BAND
        bright = min(bright, 255.0)
    dark = min(max(dark, 0.0), 254.0)
    bright = min(max(bright, dark + 1.0), 255.0)
    if bright - dark < MIN_BAND and bright < 255.0:
        bright = min(255.0, dark + MIN_BAND)
    if dark >= bright:
        return None
    return {
        "dark": round(dark, 1),
        "bright": round(bright, 1),
        "night_typ": round(night_typ, 1),
        "day_typ": round(day_typ, 1),
    }


def do_retune():
    now = time.time()
    profile = load_profile()
    if (
        profile
        and profile.get("ready")
        and (now - float(profile.get("updated", 0))) < RETUNE_EVERY_S
    ):
        cal_from_profile(profile)
        return

    rows = load_samples()
    rewrite_samples(rows)
    night = [r for r in rows if r["s"] < NIGHT_SUN]
    day = [r for r in rows if r["s"] > DAY_SUN]
    n_night = len(night)
    n_day = len(day)

    def span_ok(group):
        if len(group) < 2:
            return False
        ts = [r["t"] for r in group]
        return (max(ts) - min(ts)) >= MIN_SPAN_S

    if n_night < MIN_NIGHT or n_day < MIN_DAY or not span_ok(night) or not span_ok(day):
        sys.stderr.write(
            "luma-retune: not ready n_day=%s n_night=%s\n" % (n_day, n_night)
        )
        if profile and profile.get("ready"):
            cal_from_profile(profile)
        else:
            write_cal(False, n_day=n_day, n_night=n_night)
        return

    night_med = []
    day_med = []
    for i in range(GRID):
        nv = [r["tiles"][i] for r in night]
        dv = [r["tiles"][i] for r in day]
        night_med.append(median(nv))
        day_med.append(median(dv))

    mask = []
    for i in range(GRID):
        nm = night_med[i]
        dm = day_med[i]
        ignore = (
            nm is None
            or dm is None
            or nm >= NIGHT_BRIGHT
            or dm <= DAY_DARK
            or (dm - nm) < MIN_DELTA
        )
        mask.append(not ignore)
    n_tiles = sum(1 for b in mask if b)
    if n_tiles < MIN_TILES:
        sys.stderr.write("luma-retune: mask too small tiles=%s\n" % n_tiles)
        if profile and profile.get("ready"):
            cal_from_profile(profile)
        else:
            write_cal(False, n_day=n_day, n_night=n_night, tiles=n_tiles)
        return

    night_stats = []
    for r in night:
        vals = [r["tiles"][i] for i, bit in enumerate(mask) if bit]
        stat = p25_of(vals)
        if stat is not None:
            night_stats.append(stat)
    day_stats = []
    for r in day:
        vals = [r["tiles"][i] for i, bit in enumerate(mask) if bit]
        stat = p25_of(vals)
        if stat is not None:
            day_stats.append(stat)
    band = thresholds(night_stats, day_stats)
    if band is None:
        sys.stderr.write("luma-retune: thresholds failed sanity\n")
        if profile and profile.get("ready"):
            cal_from_profile(profile)
        else:
            write_cal(False, n_day=n_day, n_night=n_night, tiles=n_tiles)
        return

    new_profile = {
        "v": 1,
        "ready": True,
        "updated": int(now),
        "grid": [GRID_W, GRID_H],
        "mask": pack_mask(mask),
        "stat": "p25",
        "dark": band["dark"],
        "bright": band["bright"],
        "night_typ": band["night_typ"],
        "day_typ": band["day_typ"],
        "n_day": n_day,
        "n_night": n_night,
        "n_tiles": n_tiles,
    }
    os.makedirs(DIR, exist_ok=True)
    atomic_write(
        os.path.join(DIR, "luma-profile.json"),
        json.dumps(new_profile, separators=(",", ":")),
    )
    cal_from_profile(new_profile)
    sys.stderr.write(
        "luma-retune: ready dark=%s bright=%s tiles=%s n_day=%s n_night=%s\n"
        % (band["dark"], band["bright"], n_tiles, n_day, n_night)
    )


def retune_main():
    try:
        do_retune()
    except Exception as exc:
        sys.stderr.write("luma-retune: %s\n" % exc)
        try:
            write_cal(False)
        except Exception:
            pass
    return 0


def percentile_from_hist(hist, count, p=0.25):
    if count <= 0 or not hist:
        return None
    need = count * p
    cum = 0
    percentile = 0
    for value, n in enumerate(hist):
        cum += n
        if cum >= need:
            percentile = value
            break
    return round(float(percentile), 1)


# MANUAL PATH — this-home geometry. Auto-calibrate must not change this.
# After rotate=, bottom 60% (y >= 0.40), 25th percentile of ITU-R 601-2 luma.
# Matches the seventh-pass C110 landing / RFID crop that excludes the
# downstairs window on an upright still.
def luma_manual(grey):
    width, height = grey.size
    y0 = int(height * 0.40)
    if width <= 0 or height <= 0 or y0 >= height:
        return None
    roi = grey.crop((0, y0, width, height))
    hist = roi.histogram()[:256]
    count = roi.size[0] * roi.size[1]
    return percentile_from_hist(hist, count, 0.25)


def tile_box(width, height, tx, ty):
    x0 = (tx * width) // GRID_W
    x1 = ((tx + 1) * width) // GRID_W
    y0 = (ty * height) // GRID_H
    y1 = ((ty + 1) * height) // GRID_H
    return x0, y0, x1, y1


def tile_means(grey):
    width, height = grey.size
    if width < GRID_W or height < GRID_H:
        return None
    means = []
    for ty in range(GRID_H):
        for tx in range(GRID_W):
            x0, y0, x1, y1 = tile_box(width, height, tx, ty)
            if x1 <= x0 or y1 <= y0:
                means.append(0)
                continue
            cell = grey.crop((x0, y0, x1, y1))
            hist = cell.histogram()[:256]
            count = cell.size[0] * cell.size[1]
            if count <= 0:
                means.append(0)
            else:
                total = sum(v * n for v, n in enumerate(hist))
                means.append(int(round(total / count)))
    return means


def apply_rotate(im, deg):
    deg = int(deg) % 360
    if deg == 90:
        return im.transpose(Image.ROTATE_90)
    if deg == 180:
        return im.transpose(Image.ROTATE_180)
    if deg == 270:
        return im.transpose(Image.ROTATE_270)
    return im


def is_ir_like(rgb):
    # Night-vision / IR: near-greyscale, or a magenta/purple cast (Tapo color
    # night). Daytime marble can be fairly low-chroma; keep the greyscale cut
    # tight so a noon landing is not capped dark. Magenta night stills are
    # caught even when chroma is high. The luma=12 cap itself is skipped when
    # luma-run.env sun elevation is daytime, so an underexposed noon still
    # cannot look like night-vision.
    width, height = rgb.size
    if width <= 0 or height <= 0:
        return False
    small = rgb.resize((max(1, width // 4), max(1, height // 4)))
    sw, sh = small.size
    pix = small.load()
    n = sw * sh
    if n <= 0:
        return False
    chroma_sum = 0
    r_sum = g_sum = b_sum = 0
    for y in range(sh):
        for x in range(sw):
            r, g, b = pix[x, y][:3]
            mx = r if r >= g else g
            if b > mx:
                mx = b
            mn = r if r <= g else g
            if b < mn:
                mn = b
            chroma_sum += mx - mn
            r_sum += r
            g_sum += g
            b_sum += b
    chroma = chroma_sum / float(n)
    r_m = r_sum / float(n)
    g_m = g_sum / float(n)
    b_m = b_sum / float(n)
    magenta = (r_m > g_m + 8.0) and (b_m > g_m + 8.0)
    return chroma < 12.0 or magenta


def luma_auto(grey, mask_bits):
    width, height = grey.size
    if width < GRID_W or height < GRID_H:
        return None
    hist = [0] * 256
    count = 0
    for i, bit in enumerate(mask_bits):
        if not bit:
            continue
        tx = i % GRID_W
        ty = i // GRID_W
        x0, y0, x1, y1 = tile_box(width, height, tx, ty)
        if x1 <= x0 or y1 <= y0:
            continue
        cell = grey.crop((x0, y0, x1, y1))
        ch = cell.histogram()[:256]
        for value, n in enumerate(ch):
            hist[value] += n
        count += cell.size[0] * cell.size[1]
    return percentile_from_hist(hist, count, 0.25)


def read_run(require=False):
    """Read luma-run.env, and say whether it was actually there.

    Returns (mode, sun, rotate, ir_configured, present).

    `present` exists because its absence is invisible otherwise, and that is
    exactly how the previous bug survived for the whole life of the feature.
    The old shape swallowed a missing file with `except OSError: pass` and
    returned the same defaults it returns for a file that says
    mode=manual/rotate=90 - so "the writer never ran" and "the writer ran and
    wrote these values" were indistinguishable, in a house where 90 happens to
    be the correct rotation.

    The write side is a shell_command carrying continue_on_error, so if it fails
    - a missing python3 on PATH, a read-only /config, anything - the failure is
    swallowed there too. Two swallowed failures in series is how a feature stays
    inert without a single line of evidence anywhere. This return value is the
    evidence.
    """
    mode = "manual"
    sun = None
    rotate = 90
    ir_configured = False
    present = False
    path_run = os.path.join(DIR, "luma-run.env")
    try:
        with open(path_run, "r", encoding="utf-8") as f:
            present = True
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip().lower()
                val = val.strip()
                if key == "mode":
                    low = val.lower()
                    if low in ("auto", "auto-calibrate"):
                        mode = "auto"
                    else:
                        mode = "manual"
                elif key == "sun":
                    try:
                        sun = float(val)
                    except ValueError:
                        sun = None
                elif key == "rotate":
                    try:
                        rotate = int(round(float(val))) % 360
                        if rotate not in (0, 90, 180, 270):
                            rotate = 90
                    except ValueError:
                        rotate = 90
                elif key == "ir":
                    ir_configured = val.strip() in ("1", "true", "yes", "on")
    except OSError:
        present = False
    if require and not present:
        # Loud, once per measurement, on stderr - which the command_line sensor
        # surfaces in the Home Assistant log. A feature that has quietly not run
        # since it shipped is the failure this whole pass is about.
        sys.stderr.write(
            "guardian-luminance: %s is missing. shell_command."
            "guardian_luma_write_run did not run or could not write - check that "
            "python3 resolves inside the Home Assistant container and that "
            "/config/guardian is writable. Auto-calibrate, the rotate helper, the "
            "IR-frame rejection and the sun term are ALL inert until it does.\n"
            % path_run
        )
    return mode, sun, rotate, ir_configured, present


def load_ready_profile():
    path_p = os.path.join(DIR, "luma-profile.json")
    try:
        with open(path_p, "r", encoding="utf-8") as f:
            profile = json.load(f)
        if not isinstance(profile, dict) or not profile.get("ready"):
            return None
        grid = profile.get("grid") or [GRID_W, GRID_H]
        if list(grid) != [GRID_W, GRID_H]:
            return None
        mask = unpack_mask(profile["mask"])
        if sum(1 for b in mask if b) < 1:
            return None
        return profile, mask
    except Exception:
        return None


def append_sample(grey, sun):
    if sun is None:
        return
    means = tile_means(grey)
    if not means or len(means) != GRID:
        return
    os.makedirs(DIR, exist_ok=True)
    rec = {
        "t": int(time.time()),
        "s": round(float(sun), 2),
        "g": base64.b64encode(bytes(min(255, max(0, int(m))) for m in means)).decode(
            "ascii"
        ),
    }
    with open(os.path.join(DIR, "luma-samples.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")


def run_measure(path, max_age):
    if Image is None:
        sys.exit(10)
    # Reject a stale frame: a failed snapshot leaves the previous image in place.
    try:
        age = time.time() - os.path.getmtime(path)
    except OSError:
        sys.exit(11)
    if max_age > 0 and age > max_age:
        sys.exit(3)

    try:
        with Image.open(path) as im:
            # draft() lets the JPEG decoder downscale during decode via DCT scaling.
            # Far cheaper than decoding full resolution then resizing - this runs on
            # a Raspberry Pi 5 inside a 15s command_timeout. RGB so rotate + the
            # IR-like chroma test still have colour; "L" too early would drop both.
            im.draft("RGB", (320, 180))
            rgb = im.convert("RGB")
            rgb.load()
    except Exception:
        sys.exit(12)

    # require=True: a missing luma-run.env is reported on stderr, which the
    # command_line sensor puts in the Home Assistant log. The flag itself is not
    # needed here - every value already fell back to its default - so it is
    # named to say that the non-use is deliberate. Surfacing it on More ->
    # Diagnostics would need a sensor of its own and is left on the list.
    mode, sun, rotate, ir_configured, _run_present = read_run(require=True)
    try:
        rgb = apply_rotate(rgb, rotate)
    except Exception:
        sys.exit(12)

    ir_like = False
    try:
        ir_like = is_ir_like(rgb)
    except Exception:
        ir_like = False

    try:
        grey = rgb.convert("L")
        grey.load()
    except Exception:
        sys.exit(12)

    manual = luma_manual(grey)
    if manual is None:
        sys.exit(13)

    value = manual
    if mode == "auto":
        loaded = load_ready_profile()
        if loaded is not None:
            _profile, mask = loaded
            auto_val = luma_auto(grey, mask)
            if auto_val is not None:
                value = auto_val

    # Unconfigured IR at night: a night-vision still must not read as daylight.
    # Cap below the Manual dark threshold (45) and skip jsonl so Auto-calibrate
    # does not learn IR-flooded tiles. Skip the cap when the sun is well up —
    # an underexposed noon still is greyscale enough to trip is_ir_like and
    # would otherwise print 12.0 and fire off_sun_override.
    daytime = sun is not None and sun > DAY_SUN
    apply_ir_cap = ir_like and not ir_configured and not daytime
    if apply_ir_cap:
        value = min(float(value), 12.0)

    print(round(float(value), 1))
    sys.stdout.flush()
    if not apply_ir_cap:
        try:
            append_sample(grey, sun)
        except Exception:
            pass
    return 0


def write_run_main(argv):
    """Write luma-run.env from four positional values. See --write-run below."""
    vals = (list(argv[2:]) + ["", "", "", ""])[:4]
    mode, sun, rotate, ir = (v.strip() for v in vals)
    text = "mode=%s\nsun=%s\nrotate=%s\nir=%s\n" % (mode, sun, rotate, ir)
    try:
        atomic_write(os.path.join(DIR, "luma-run.env"), text)
    except OSError:
        return 1
    return 0


def main(argv=None):
    argv = list(sys.argv if argv is None else argv)
    if len(argv) >= 2 and argv[1] == "--retune":
        return retune_main()
    # THE SHELL REDIRECT THAT USED TO DO THIS NEVER RAN, for the whole life of
    # the feature. shell_command.guardian_luma_write_run was
    # "printf ... '{{ ... }}' > /config/guardian/luma-run.env", and Home
    # Assistant runs a shell_command containing templates through
    # create_subprocess_exec (shell=False) precisely so a rendered value cannot
    # inject shell syntax. With no shell there is no redirection: ">" and the
    # path were passed to printf as two more ARGUMENTS, printf reused its format
    # string for them, the text went to stdout, and the file was never written.
    # printf exited 0, so nothing anywhere reported a failure.
    #
    # read_run() then fell back to mode=manual, sun=None, rotate=90, ir=False on
    # every single measurement - which means Auto-calibrate,
    # input_number.guardian_luma_rotate, the IR-frame rejection and the probe's
    # own sun term have all been inert since they shipped. It went unnoticed
    # because this house's correct rotate is 90 and 90 is also the fallback.
    #
    # Writing the file from here keeps the templates as ARGUMENTS, which is the
    # shape create_subprocess_exec is happy with and the shape that is safe.
    if len(argv) >= 2 and argv[1] == "--write-run":
        return write_run_main(argv)
    # Not /config/www: that tree is served as /local with no authentication, so
    # a front-door frame written there is readable by anything on the LAN or the
    # tailnet. This path is not web-served. Callers pass it explicitly anyway.
    img = argv[1] if len(argv) > 1 else "/config/guardian/ambient.jpg"
    try:
        max_age = float(argv[2]) if len(argv) > 2 else 60.0
    except ValueError:
        return 2
    if not os.path.isfile(img):
        return 1
    if os.path.getsize(img) <= 0:
        return 2
    return run_measure(img, max_age)


if __name__ == "__main__":
    sys.exit(main())
