"""Generate the Android launcher, adaptive and splash art from the shipped icon.

One source: `apps/desktop/build/icon.png`, the mark every desktop package ships.
Nothing here redraws the mark; it is cropped, scaled and composited so the phone
carries the same identity as the window the reader already installed.

Run from the repo root:  python scripts/android-brand-assets.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "apps/desktop/build/icon.png"
RES = ROOT / "apps/mobile/android/app/src/main/res"

RESAMPLE = getattr(Image, "Resampling", Image).LANCZOS
INK = (11, 11, 12, 255)
PAPER = (255, 255, 255, 255)

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def plate(size: int) -> Image.Image:
    """The shipped icon, scaled to `size`, keeping its own plate and edge."""
    icon = Image.open(SRC).convert("RGBA")
    return icon.resize((size, size), RESAMPLE)


def rounded_plate(size: int) -> Image.Image:
    """A launcher icon: the mark on a white plate with the product's hairline."""
    img = plate(size)
    # The shipped 512 px icon already carries its plate; the phone only needs the
    # same asset at the launcher size.
    return img


def round_icon(size: int) -> Image.Image:
    """The same plate, masked to the circle a round launcher asks for."""
    img = plate(size * 4)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.size[0] - 1, img.size[1] - 1), fill=255)
    img.putalpha(mask)
    return img.resize((size, size), RESAMPLE)


def adaptive_foreground(size: int) -> Image.Image:
    """108 dp canvas, mark inside the 66 dp safe zone, plate edge cut away.

    The mask crops roughly the outer sixth of an adaptive icon, so keeping the
    shipped plate's hairline here would put a black ring inside every launcher
    shape. The inset removes it; the white background layer fills the rest.
    """
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * 0.60)
    art = plate(inner)
    # Clip the outer 3.5% of the plate — that is the hairline and nothing else.
    clip = int(inner * 0.035)
    art = art.crop((clip, clip, inner - clip, inner - clip))
    art = art.resize((inner, inner), RESAMPLE)
    canvas.alpha_composite(art, ((size - inner) // 2, (size - inner) // 2))
    return canvas


def splash(width: int, height: int) -> Image.Image:
    """White field, the mark, and the product name under it."""
    img = Image.new("RGBA", (width, height), PAPER)
    side = int(min(width, height) * 0.26)
    mark = plate(side)
    img.alpha_composite(mark, ((width - side) // 2, int(height * 0.40) - side // 2))

    text = "QianNing Agent"
    size_px = max(18, int(min(width, height) * 0.045))
    font = None
    for candidate in ("seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"):
        try:
            font = ImageFont.truetype(candidate, size_px)
            break
        except OSError:
            continue
    draw = ImageDraw.Draw(img)
    box = draw.textbbox((0, 0), text, font=font) if font else (0, 0, 0, 0)
    draw.text(
        ((width - (box[2] - box[0])) // 2, int(height * 0.40) + side // 2 + int(size_px * 0.9)),
        text,
        fill=(60, 60, 64, 255) if font else INK,
        font=font,
    )
    return img


def phone_mark() -> None:
    """The mark the first-run screen shows, at a size a phone screen needs."""
    target = ROOT / "apps/mobile/src/assets"
    target.mkdir(parents=True, exist_ok=True)
    plate(256).save(target / "brand-mark.png")


def main() -> None:
    phone_mark()
    for name, scale in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        folder.mkdir(parents=True, exist_ok=True)
        rounded_plate(int(48 * scale)).save(folder / "ic_launcher.png")
        round_icon(int(48 * scale)).save(folder / "ic_launcher_round.png")
        adaptive_foreground(int(108 * scale)).save(folder / "ic_launcher_foreground.png")

    for folder in RES.glob("drawable*"):
        target = folder / "splash.png"
        if not target.exists():
            continue
        with Image.open(target) as existing:
            width, height = existing.size
        splash(width, height).save(target)
        print("splash", target.relative_to(RES), width, height)


if __name__ == "__main__":
    main()
