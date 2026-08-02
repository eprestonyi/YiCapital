#!/usr/bin/env python3
"""Deterministically render YiCapital social and browser identity assets.

The approved mark is a frozen nonlinear pendulum: square nodes, a bone-white
structure, one solid blue terminal mass, and one open blue arc.  All geometry
is drawn directly with Pillow so the raster outputs do not depend on an SVG
renderer, browser, network resource, or random seed.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFilter, ImageFont


SOCIAL_SIZE = (1200, 630)
INK = (3, 7, 14, 255)
INK_SOFT = (7, 14, 26, 255)
BONE = (245, 242, 234, 255)
BONE_MUTED = (178, 188, 204, 255)
BLUE = (117, 167, 255, 255)
BLUE_SOFT = (68, 124, 220, 255)
GRID = (38, 62, 91, 74)

BOLD_FONT = Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")
REGULAR_FONT = Path("/System/Library/Fonts/Supplemental/Arial.ttf")


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    if not path.exists():
        raise FileNotFoundError(f"Required brand font is missing: {path}")
    return ImageFont.truetype(str(path), size)


def _lerp(a: int, b: int, ratio: float) -> int:
    return round(a + (b - a) * ratio)


def background() -> Image.Image:
    """Build the shared dark card surface without any stochastic texture."""
    image = Image.new("RGBA", SOCIAL_SIZE, INK)
    draw = ImageDraw.Draw(image)
    top = (3, 8, 16)
    bottom = (7, 13, 23)
    for y in range(SOCIAL_SIZE[1]):
        ratio = y / (SOCIAL_SIZE[1] - 1)
        draw.line(
            (0, y, SOCIAL_SIZE[0], y),
            fill=tuple(_lerp(a, b, ratio) for a, b in zip(top, bottom)) + (255,),
        )

    glow = Image.new("RGBA", SOCIAL_SIZE, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((780, 65, 1305, 590), fill=(48, 105, 214, 62))
    glow = glow.filter(ImageFilter.GaussianBlur(115))
    image.alpha_composite(glow)

    grid = Image.new("RGBA", SOCIAL_SIZE, (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    for x in range(0, SOCIAL_SIZE[0] + 1, 60):
        grid_draw.line((x, 0, x, SOCIAL_SIZE[1]), fill=GRID, width=1)
    for y in range(30, SOCIAL_SIZE[1] + 1, 60):
        grid_draw.line((0, y, SOCIAL_SIZE[0], y), fill=GRID, width=1)
    fade = Image.new("L", SOCIAL_SIZE, 0)
    fade_draw = ImageDraw.Draw(fade)
    for x in range(SOCIAL_SIZE[0]):
        opacity = max(0, min(255, round((x - 610) / 390 * 150)))
        fade_draw.line((x, 0, x, SOCIAL_SIZE[1]), fill=opacity)
    grid.putalpha(Image.composite(grid.getchannel("A"), Image.new("L", SOCIAL_SIZE), fade))
    image.alpha_composite(grid)
    return image


def cubic_points(
    start: tuple[float, float],
    control_a: tuple[float, float],
    control_b: tuple[float, float],
    end: tuple[float, float],
    steps: int = 42,
) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for index in range(steps + 1):
        t = index / steps
        inverse = 1 - t
        x = (
            inverse**3 * start[0]
            + 3 * inverse**2 * t * control_a[0]
            + 3 * inverse * t**2 * control_b[0]
            + t**3 * end[0]
        )
        y = (
            inverse**3 * start[1]
            + 3 * inverse**2 * t * control_a[1]
            + 3 * inverse * t**2 * control_b[1]
            + t**3 * end[1]
        )
        points.append((x, y))
    return points


def draw_symbol(
    image: Image.Image,
    x: float,
    y: float,
    height: float,
    *,
    structure: tuple[int, int, int, int] = BONE,
    accent: tuple[int, int, int, int] = BLUE,
    arc_width: float = 4.5,
    glow: bool = True,
) -> float:
    """Draw the canonical 124 x 134 pendulum geometry and return its width."""
    scale = height / 134

    def point(raw: tuple[float, float]) -> tuple[float, float]:
        return (x + (raw[0] - 4) * scale, y + (raw[1] - 3) * scale)

    first = cubic_points((42, 114), (67, 132), (101, 121), (116, 94))
    second = cubic_points((116, 94), (130, 69), (124, 46), (105, 31))
    arc = [point(item) for item in first + second[1:]]
    stroke = max(1, round(arc_width * scale))

    if glow and height >= 42:
        glow_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
        ImageDraw.Draw(glow_layer).line(
            arc,
            fill=(accent[0], accent[1], accent[2], 90),
            width=stroke + max(3, round(8 * scale)),
            joint="curve",
        )
        image.alpha_composite(glow_layer.filter(ImageFilter.GaussianBlur(max(2, round(5 * scale)))))

    draw = ImageDraw.Draw(image)
    draw.line(arc, fill=accent, width=stroke, joint="curve")

    rectangles = [
        ((16, 12), (32, 28), structure),
        ((86, 40), (104, 58), structure),
        ((30, 102), (54, 126), accent),
    ]
    for start, end, color in rectangles:
        p1 = point(start)
        p2 = point(end)
        draw.rectangle((round(p1[0]), round(p1[1]), round(p2[0]), round(p2[1])), fill=color)

    for polygon in [
        [(36, 25), (40, 17), (83, 39), (79, 47)],
        [(83, 64), (89, 72), (50, 103), (44, 95)],
    ]:
        draw.polygon([point(item) for item in polygon], fill=structure)

    return 124 * scale


def draw_lockup(
    image: Image.Image,
    x: int,
    y: int,
    *,
    symbol_height: int = 72,
    wordmark_size: int = 52,
) -> None:
    width = draw_symbol(image, x, y, symbol_height)
    wordmark = font(BOLD_FONT, wordmark_size)
    draw = ImageDraw.Draw(image)
    bounds = draw.textbbox((0, 0), "YiCapital", font=wordmark)
    text_height = bounds[3] - bounds[1]
    text_y = y + (symbol_height - text_height) / 2 - bounds[1]
    draw.text((round(x + width + 18), round(text_y)), "YiCapital", font=wordmark, fill=BONE)


def draw_rule(image: Image.Image, x: int, y: int, width: int) -> None:
    draw = ImageDraw.Draw(image)
    draw.line((x, y, x + width, y), fill=BLUE, width=3)


def render_entry_card() -> Image.Image:
    image = background()
    draw_lockup(image, 68, 48, symbol_height=68, wordmark_size=48)
    draw = ImageDraw.Draw(image)
    draw.text((70, 220), "Be Like Us,", font=font(BOLD_FONT, 69), fill=BONE)
    draw.text((70, 294), "Not Them", font=font(BOLD_FONT, 69), fill=BLUE)
    draw.text(
        (72, 389),
        "In investing, only the few profit.",
        font=font(REGULAR_FONT, 28),
        fill=BONE_MUTED,
    )
    draw_rule(image, 72, 474, 300)
    draw.text(
        (72, 493),
        "TRAILING RECORD  /  HK  /  US  /  A",
        font=font(BOLD_FONT, 14),
        fill=(139, 158, 185, 255),
    )
    draw_symbol(image, 770, 140, 390, arc_width=4.8, glow=True)
    return image


def render_terminal_card() -> Image.Image:
    image = background()
    draw_lockup(image, 68, 48, symbol_height=68, wordmark_size=48)
    draw = ImageDraw.Draw(image)
    draw.text((70, 195), "TERMINAL", font=font(BOLD_FONT, 64), fill=BONE)
    draw.text((70, 267), "/ ATLAS", font=font(REGULAR_FONT, 48), fill=BLUE)
    draw.text(
        (72, 348),
        "Cross-asset market and research workbench.",
        font=font(REGULAR_FONT, 25),
        fill=BONE_MUTED,
    )
    draw_rule(image, 72, 427, 300)
    draw.text(
        (72, 448),
        "MARKETS  /  PORTFOLIOS  /  RESEARCH  /  SYSTEMS",
        font=font(BOLD_FONT, 13),
        fill=(139, 158, 185, 255),
    )

    panel = (690, 150, 1132, 530)
    draw.rounded_rectangle(panel, radius=10, fill=(5, 12, 22, 218), outline=(54, 84, 122, 220), width=2)
    for row in range(5):
        top = 184 + row * 60
        draw.rectangle((724, top, 748, top + 24), fill=BLUE if row == 4 else (60, 82, 112, 255))
        draw.line((770, top + 5, 1064 - row * 18, top + 5), fill=(112, 132, 160, 255), width=5)
        draw.line((770, top + 19, 1016 + row * 10, top + 19), fill=(39, 70, 110, 255), width=4)
    draw_symbol(image, 935, 350, 146, arc_width=6.2, glow=True)
    return image


def render_generic_card() -> Image.Image:
    image = background()
    draw_symbol(image, 748, 112, 430, arc_width=4.8, glow=True)
    draw = ImageDraw.Draw(image)
    draw.text((72, 190), "YiCapital", font=font(BOLD_FONT, 84), fill=BONE)
    draw_rule(image, 74, 304, 314)
    draw.text(
        (74, 331),
        "Independent research.",
        font=font(BOLD_FONT, 34),
        fill=BONE,
    )
    draw.text(
        (74, 380),
        "Open-source portfolios.",
        font=font(REGULAR_FONT, 31),
        fill=BONE_MUTED,
    )
    draw.text(
        (75, 486),
        "DETERMINISTIC  /  NONLINEAR",
        font=font(BOLD_FONT, 14),
        fill=BLUE,
    )
    return image


def render_icon(size: int) -> Image.Image:
    """Render an opaque, size-aware square icon for Apple and browser use."""
    supersample = 4
    canvas = size * supersample
    image = Image.new("RGBA", (canvas, canvas), INK)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, canvas - 1, canvas - 1), outline=(24, 41, 62, 255), width=max(1, size // 28) * supersample)
    padding = max(1, round(size * 0.08)) * supersample
    draw_symbol(
        image,
        padding,
        padding,
        canvas - 2 * padding,
        arc_width=8.5,
        glow=size >= 64,
    )
    return image.resize((size, size), Image.Resampling.LANCZOS).convert("RGB")


def save_png(image: Image.Image, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output, "PNG", optimize=True, compress_level=9)


def render_all(output_dir: Path) -> Iterable[Path]:
    outputs = {
        output_dir / "og-entry.png": render_entry_card(),
        output_dir / "terminal-og.png": render_terminal_card(),
        output_dir / "og.png": render_generic_card(),
        output_dir / "apple-touch-icon.png": render_icon(180),
    }
    for path, image in outputs.items():
        save_png(image, path)
        yield path

    favicon = output_dir / "favicon.ico"
    render_icon(256).save(
        favicon,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    yield favicon


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Directory for all generated identity assets (default: repository root)",
    )
    args = parser.parse_args()
    for output in render_all(args.output_dir.resolve()):
        print(output)


if __name__ == "__main__":
    main()
