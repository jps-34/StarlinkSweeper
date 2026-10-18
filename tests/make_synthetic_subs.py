#!/usr/bin/env python3
"""Synthetic full-frame (62 Mpx) Ha subs as uint16 FITS, for StarlinkSweeper validation.

usage: python3 make_synthetic_subs.py <output folder>
Writes 13 frames: clean sky, cloud, gradient, bright filaments, diffraction
spikes, and trails of various brightness (bright, Starlink train, faint, very
faint, aircraft, short). Takes a few minutes and ~1.6 GB of disk.
"""
import sys, os
import numpy as np
from astropy.io import fits

H, W = 6388, 9576
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(1)
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
BG, SIG = 1200.0, 12.0

# Static sky: stars + curved nebula filaments (same in every frame, small dither).
star_x = rng.uniform(0, W, 4000); star_y = rng.uniform(0, H, 4000)
star_f = 10 ** rng.uniform(1.5, 4.8, 4000)          # peak ADU
neb = np.zeros((H, W), np.float32)
for _ in range(120):                                # arcs of circles
    cx, cy = rng.uniform(2500, 7000), rng.uniform(1500, 4800)
    rad = rng.uniform(200, 1500); a0 = rng.uniform(0, 2*np.pi); da = rng.uniform(0.5, 2.5)
    t = np.linspace(a0, a0 + da, int(rad * da))
    px = (cx + rad*np.cos(t)).astype(int); py = (cy + rad*np.sin(t)).astype(int)
    ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
    np.add.at(neb, (py[ok], px[ok]), rng.uniform(5, 40))
from scipy import ndimage as nd
neb = nd.gaussian_filter(neb, 3) * 9

def stars(dx, dy):
    img = np.zeros((H, W), np.float32)
    s = 1.0
    for x, y, f in zip(star_x + dx, star_y + dy, star_f):
        x0, y0 = int(x), int(y)
        if not (8 <= x0 < W-8 and 8 <= y0 < H-8): continue
        sy, sx = slice(y0-8, y0+9), slice(x0-8, x0+9)
        img[sy, sx] += f * np.exp(-((xx[sy, sx]-x)**2 + (yy[sy, sx]-y)**2) / (2*s*s))
    return img

def trail(img, x0, y0, x1, y1, peak, fwhm=2.5, frac=(0, 1)):
    L = np.hypot(x1-x0, y1-y0); ux, uy = (x1-x0)/L, (y1-y0)/L
    d = np.abs((xx-x0)*uy - (yy-y0)*ux)              # distance to line
    t = (xx-x0)*ux + (yy-y0)*uy
    m = (t >= frac[0]*L) & (t <= frac[1]*L)
    s = fwhm / 2.355
    img += np.where(m, peak*np.exp(-d*d/(2*s*s)), 0).astype(np.float32)

cases = ["clean0", "clean1", "clean2", "clean_cloud", "clean_gradient", "bright_filaments",
         "star_spikes", "sat_bright", "starlink_train_5sig", "sat_faint_1p5sig",
         "sat_vfaint_0p7sig", "aircraft", "sat_short_30pct"]
for k, name in enumerate(cases):
    dx, dy = rng.uniform(-15, 15, 2)
    img = BG + (neb if name == "bright_filaments" else 0.15 * neb) + stars(dx, dy)
    if name == "star_spikes":                           # RC/Newton: 4 spikes, 700 px, on 3 bright stars
        for sx_, sy_ in ((2200, 1500), (7000, 4800), (4800, 3100)):
            img += 60000*np.exp(-((xx-sx_)**2 + (yy-sy_)**2)/(2*6.0**2)).astype(np.float32)
            for ang in (45, 135):
                a = np.deg2rad(ang); L = 700
                trail(img, sx_-L*np.cos(a), sy_-L*np.sin(a), sx_+L*np.cos(a), sy_+L*np.sin(a), 400, fwhm=3)
    img += (xx/W*60 + yy/H*30).astype(np.float32)   # mild gradient
    if name == "clean_gradient":
        img += (xx/W*400).astype(np.float32)
    if name == "clean_cloud":
        img += 150*np.exp(-((xx-3000)**2 + (yy-4000)**2)/(2*1200**2)).astype(np.float32)
    if name == "sat_bright":
        trail(img, -100, 900, W+100, 5200, 2500)
    if name == "starlink_train_5sig":
        off = np.cumsum(rng.uniform(12, 45, 10))
        for o in off:
            trail(img, 6000 + o, -50, -50 + o, 6200, 5*SIG)
    if name == "sat_faint_1p5sig":
        trail(img, 2000, -50, 8000, H+50, 1.5*SIG)
    if name == "sat_vfaint_0p7sig":
        trail(img, -50, 300, W+50, 3500, 0.7*SIG)
    if name == "aircraft":
        trail(img, 500, H, 9000, 0, 300); trail(img, 530, H, 9030, 0, 300)
        for t in np.linspace(0, 1, 40):
            trail(img, 500+8500*t, H-H*t, 501+8500*t, H-H*t-1, 3000, fwhm=4)
    if name == "sat_short_30pct":
        trail(img, -50, 5000, W+50, 2000, 8*SIG, frac=(0.55, 0.85))
    img = img + rng.normal(0, SIG, img.shape).astype(np.float32)
    hot = rng.integers(0, H*W, 30000); img.ravel()[hot] = 65000
    img = np.clip(img, 0, 65535).astype(np.uint16)
    fits.PrimaryHDU(img).writeto(os.path.join(out, "%02d_%s.fits" % (k, name)), overwrite=True)
    print("wrote", name, flush=True)
