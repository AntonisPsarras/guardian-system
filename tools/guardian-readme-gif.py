"""Build docs/documentation/readme-loop.gif from the three product stills.

    python tools/guardian-readme-gif.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "documentation"
FRAMES = [
    DOC / "door-lamp-camera" / "images" / "readme.jpg",
    DOC / "interior-portal" / "images" / "readme.jpg",
    DOC / "doorbell" / "images" / "readme.jpg",
]
OUT = DOC / "readme-loop.gif"
WIDTH = 960


def fit(im: Image.Image) -> Image.Image:
    im = im.convert("RGB")
    h = max(1, int(im.height * (WIDTH / im.width)))
    return im.resize((WIDTH, h), Image.Resampling.LANCZOS)


def main() -> None:
    fitted = [fit(Image.open(p)) for p in FRAMES]
    height = max(im.height for im in fitted)
    frames = []
    for im in fitted:
        canvas = Image.new("RGB", (WIDTH, height), (24, 24, 24))
        canvas.paste(im, (0, (height - im.height) // 2))
        frames.append(canvas)
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=1400,
        loop=0,
        optimize=True,
    )
    print(f"{OUT} {OUT.stat().st_size} bytes {frames[0].size}")


if __name__ == "__main__":
    main()
