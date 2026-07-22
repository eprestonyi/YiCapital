#!/usr/bin/env python3
"""Render the canonical YiCapital social card from a text-free background."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


CANVAS = (1731, 909)
WHITE = "#FFFFFF"
GRADIENT_START = (110, 154, 244)
GRADIENT_END = (181, 75, 250)
BOLD_FONT = Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")
REGULAR_FONT = Path("/System/Library/Fonts/Supplemental/Arial.ttf")


def scaled_font(path: Path, size: int, scale: float) -> ImageFont.FreeTypeFont:
    if not path.exists():
        raise FileNotFoundError(f"Required brand font is missing: {path}")
    return ImageFont.truetype(str(path), round(size * scale))


def draw_wordmark(image: Image.Image, x: int, y: int, scale: float) -> None:
    """Draw one bold, unbroken YiCapital wordmark with the locked colors."""
    font = scaled_font(BOLD_FONT, 120, scale)
    base = ImageDraw.Draw(image)
    base.text((x, y), "Yi", font=font, fill=WHITE)

    capital_x = round(x + base.textlength("Yi", font=font))
    capital_width = max(1, round(base.textlength("Capital", font=font)))
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).text((capital_x, y), "Capital", font=font, fill=255)

    gradient = Image.new("RGBA", image.size, (0, 0, 0, 0))
    gradient_draw = ImageDraw.Draw(gradient)
    for offset in range(capital_width):
        ratio = offset / max(1, capital_width - 1)
        color = tuple(
            round(start + (end - start) * ratio)
            for start, end in zip(GRADIENT_START, GRADIENT_END)
        )
        gradient_draw.line(
            (capital_x + offset, 0, capital_x + offset, image.height),
            fill=(*color, 255),
        )
    gradient.putalpha(mask)
    image.alpha_composite(gradient)


def render(background: Path, output: Path) -> None:
    image = Image.open(background).convert("RGBA")
    if image.size != CANVAS:
        image = image.resize(CANVAS, Image.Resampling.LANCZOS)

    scale = image.width / CANVAS[0]
    draw_wordmark(image, round(90 * scale), round(342 * scale), scale)

    tagline_font = scaled_font(REGULAR_FONT, 35, scale)
    ImageDraw.Draw(image).text(
        (round(94 * scale), round(500 * scale)),
        "Key to Extraordinary Research and Opensource Portfolio",
        font=tagline_font,
        fill=(224, 231, 242, 255),
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output, "PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--background", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    render(args.background, args.output)


if __name__ == "__main__":
    main()
