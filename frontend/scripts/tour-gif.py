"""Assembles the frames written by `node scripts/screenshots.mjs --tour` into the README's animated walkthrough.

Usage: npm run tour-gif (after `npm run build`). Needs Python 3 with Pillow (`pip install pillow`).
"""
import glob
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, "..", "test-results", "tour-frames")
OUT = os.path.join(HERE, "..", "..", "docs", "screenshots", "incident-tour.gif")
FIRST_MS, STEP_MS, LAST_MS = 3500, 4000, 6000

files = sorted(glob.glob(os.path.join(FRAMES, "*.png")))
if len(files) < 2:
    sys.exit("no frames in test-results/tour-frames: run `node scripts/screenshots.mjs --tour` first")
# The UI uses few colours, so 128 without dithering keeps text crisp and the file small.
frames = [Image.open(f).convert("RGB").quantize(colors=128, dither=Image.Dither.NONE) for f in files]
durations = [FIRST_MS] + [STEP_MS] * (len(frames) - 2) + [LAST_MS]
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
print(f"docs/screenshots/incident-tour.gif: {len(frames)} frames, {os.path.getsize(OUT) / 1024:.0f} KB")
