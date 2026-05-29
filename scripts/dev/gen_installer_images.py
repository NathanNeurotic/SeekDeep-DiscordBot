"""Generate WiX + NSIS installer images with text-safe zones.

WiX UI text colors are dark (near-black) on a near-white default. Our prior
images filled the entire frame with the dark SeekDeep mascot, so the title
text became invisible against a dark background.

Layout (per WiX UI v3 / v4 spec — Mondo / Mondo2 themes):
  wix-banner.bmp   493 x 58   title at top-LEFT  -> white zone LEFT,  brand RIGHT
  wix-dialog.bmp   493 x 312  title at top-RIGHT -> brand zone LEFT,  white RIGHT
  nsis-header.bmp  150 x 57   NSIS top banner    -> brand LEFT, blank RIGHT
  nsis-sidebar.bmp 164 x 314  NSIS welcome side  -> full brand panel (sidebar only)

Run from repo root:  .venv/Scripts/python.exe scripts/dev/gen_installer_images.py
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT      = Path(__file__).resolve().parent.parent.parent  # scripts/dev/ -> repo root (DEAD-1 move)
SRC_ICON  = ROOT / "src-tauri" / "icons" / "icon.png"
OUT_DIR   = ROOT / "src-tauri" / "installer"

DARK   = (15, 17, 21)       # SeekDeep panel near-black
ACCENT = (29, 35, 48)       # SeekDeep gutter
WHITE  = (255, 255, 255)    # WiX default panel — keep text-safe zones here


def _save_bmp24(im: Image.Image, dest: Path) -> None:
    """WiX requires 24-bit BMP, no alpha. RGBA -> RGB on white background."""
    if im.mode == "RGBA":
        bg = Image.new("RGB", im.size, WHITE)
        bg.paste(im, mask=im.split()[3])
        im = bg
    elif im.mode != "RGB":
        im = im.convert("RGB")
    im.save(dest, "BMP")


def _scaled_mascot(target_h: int) -> Image.Image:
    """Mascot scaled to target_h while preserving aspect ratio. Returns RGBA."""
    icon = Image.open(SRC_ICON).convert("RGBA")
    ratio = target_h / icon.height
    new_w = int(icon.width * ratio)
    return icon.resize((new_w, target_h), Image.LANCZOS)


def make_wix_banner() -> None:
    """493 x 58 — white text-safe zone on LEFT, dark brand on RIGHT.

    WiX banner title is drawn at approx (15, 6); subtitle at (25, 23).
    The subtitle on dialogs like 'Destination Folder' can run ~75 chars,
    extending past x=395. Brand zone must stay narrow so the subtitle
    isn't visually crowded. Reserving left 398 px for text, right 95 px
    for brand. (Earlier 150 px brand zone clipped the 'another.' tail
    of the destination-folder subtitle — user reported in 2026-05-27.)"""
    W, H = 493, 58
    canvas = Image.new("RGB", (W, H), WHITE)
    # Right-side brand panel: dark strip with a small mascot.
    brand_w = 95
    brand = Image.new("RGB", (brand_w, H), DARK)
    canvas.paste(brand, (W - brand_w, 0))
    # Mascot inside the dark zone (32px tall, centered vertically)
    mascot = _scaled_mascot(target_h=H - 12)  # 46px tall
    # Composite mascot onto a dark backplate so alpha edges don't pick up white
    mascot_bg = Image.new("RGBA", mascot.size, DARK + (255,))
    mascot_bg.paste(mascot, (0, 0), mascot)
    mascot_rgb = mascot_bg.convert("RGB")
    canvas.paste(mascot_rgb, (W - brand_w + (brand_w - mascot_rgb.width) // 2, (H - mascot_rgb.height) // 2))
    # Soft divider between white text zone and dark brand zone.
    draw = ImageDraw.Draw(canvas)
    draw.line([(W - brand_w, 0), (W - brand_w, H)], fill=ACCENT, width=1)
    _save_bmp24(canvas, OUT_DIR / "wix-banner.bmp")
    print(f"wrote {OUT_DIR / 'wix-banner.bmp'}  ({W}x{H})")


def make_wix_dialog() -> None:
    """493 x 312 — dark brand panel on LEFT, white text-safe zone on RIGHT.

    WiX welcome/exit dialog title at approx (165, 15); body text below (165, 80).
    Reserving left 165 px for brand, right 328 px for text."""
    W, H = 493, 312
    canvas = Image.new("RGB", (W, H), WHITE)
    brand_w = 165
    brand = Image.new("RGB", (brand_w, H), DARK)
    canvas.paste(brand, (0, 0))
    # Large mascot centered in the brand panel
    mascot = _scaled_mascot(target_h=int(H * 0.55))
    if mascot.width > brand_w - 16:
        # Shrink if too wide for the panel
        ratio = (brand_w - 16) / mascot.width
        mascot = mascot.resize((brand_w - 16, int(mascot.height * ratio)), Image.LANCZOS)
    mascot_bg = Image.new("RGBA", mascot.size, DARK + (255,))
    mascot_bg.paste(mascot, (0, 0), mascot)
    mascot_rgb = mascot_bg.convert("RGB")
    canvas.paste(mascot_rgb,
                 ((brand_w - mascot_rgb.width) // 2,
                  (H - mascot_rgb.height) // 2))
    # Divider between brand and text zone.
    ImageDraw.Draw(canvas).line([(brand_w, 0), (brand_w, H)], fill=ACCENT, width=1)
    _save_bmp24(canvas, OUT_DIR / "wix-dialog.bmp")
    print(f"wrote {OUT_DIR / 'wix-dialog.bmp'}  ({W}x{H})")


def make_nsis_header() -> None:
    """150 x 57 — NSIS top header. Mascot LEFT, blank RIGHT."""
    W, H = 150, 57
    canvas = Image.new("RGB", (W, H), WHITE)
    brand_w = 70
    canvas.paste(Image.new("RGB", (brand_w, H), DARK), (0, 0))
    mascot = _scaled_mascot(target_h=H - 8)
    if mascot.width > brand_w - 8:
        ratio = (brand_w - 8) / mascot.width
        mascot = mascot.resize((brand_w - 8, int(mascot.height * ratio)), Image.LANCZOS)
    mascot_bg = Image.new("RGBA", mascot.size, DARK + (255,))
    mascot_bg.paste(mascot, (0, 0), mascot)
    canvas.paste(mascot_bg.convert("RGB"),
                 ((brand_w - mascot_bg.width) // 2, (H - mascot_bg.height) // 2))
    ImageDraw.Draw(canvas).line([(brand_w, 0), (brand_w, H)], fill=ACCENT, width=1)
    _save_bmp24(canvas, OUT_DIR / "nsis-header.bmp")
    print(f"wrote {OUT_DIR / 'nsis-header.bmp'}  ({W}x{H})")


def make_nsis_sidebar() -> None:
    """164 x 314 — NSIS welcome/finish sidebar. Full brand panel (no text on top)."""
    W, H = 164, 314
    canvas = Image.new("RGB", (W, H), DARK)
    mascot = _scaled_mascot(target_h=int(H * 0.55))
    if mascot.width > W - 16:
        ratio = (W - 16) / mascot.width
        mascot = mascot.resize((W - 16, int(mascot.height * ratio)), Image.LANCZOS)
    mascot_bg = Image.new("RGBA", mascot.size, DARK + (255,))
    mascot_bg.paste(mascot, (0, 0), mascot)
    canvas.paste(mascot_bg.convert("RGB"),
                 ((W - mascot_bg.width) // 2, (H - mascot_bg.height) // 2))
    _save_bmp24(canvas, OUT_DIR / "nsis-sidebar.bmp")
    print(f"wrote {OUT_DIR / 'nsis-sidebar.bmp'}  ({W}x{H})")


if __name__ == "__main__":
    if not SRC_ICON.is_file():
        print(f"ERROR: source icon not found at {SRC_ICON}", file=sys.stderr)
        sys.exit(1)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    make_wix_banner()
    make_wix_dialog()
    make_nsis_header()
    make_nsis_sidebar()
    print("done. re-run `cargo tauri build` or rebuild via CI.")
