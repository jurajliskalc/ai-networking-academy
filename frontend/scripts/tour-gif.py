"""Assembles the frames written by `node scripts/screenshots.mjs --tour` into the animations in docs/screenshots/.

Each directory test-results/tour-frames/<name>/ becomes docs/screenshots/<name>.gif.
Usage: npm run tour-gif (after `npm run build`). Needs Python 3 with Pillow (`pip install pillow`).
"""
import glob
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, "..", "test-results", "tour-frames")
OUT = os.path.join(HERE, "..", "..", "docs", "screenshots")
# Milliseconds per frame: (first, middle, last). The incident frames carry a caption to read.
TIMING = {
    "incident-tour": (3500, 4000, 6000),
    "tour-ecmp": (3000, 3000, 3500),
    "tour-allreduce": (1600, 1300, 2600),
    "tour-stack": (2800, 2800, 2800),
}

names = sorted(d for d in os.listdir(FRAMES) if os.path.isdir(os.path.join(FRAMES, d))) if os.path.isdir(FRAMES) else []
if not names:
    sys.exit("no frames in test-results/tour-frames: run `node scripts/screenshots.mjs --tour` first")
for name in names:
    images = [Image.open(f).convert("RGB") for f in sorted(glob.glob(os.path.join(FRAMES, name, "*.png")))]
    if len(images) < 2:
        sys.exit(f"{name}: an animation needs at least two frames")
    # Frames of one animation can differ in height by a line; pad them onto one canvas in the page colour.
    width, height = max(i.width for i in images), max(i.height for i in images)
    frames = []
    for image in images:
        canvas = Image.new("RGB", (width, height), image.getpixel((2, 2)))
        canvas.paste(image, (0, 0))
        # The UI uses few colours, so 128 without dithering keeps text crisp and the file small.
        frames.append(canvas.quantize(colors=128, dither=Image.Dither.NONE))
    first, middle, last = TIMING.get(name, (2500, 2500, 2500))
    durations = [first] + [middle] * (len(frames) - 2) + [last]
    out = os.path.join(OUT, f"{name}.gif")
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
    print(f"docs/screenshots/{name}.gif: {len(frames)} frames, {width}x{height}, {os.path.getsize(out) / 1024:.0f} KB")
