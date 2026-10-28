#!/usr/bin/env python3
"""
Compares two runs of tests/run_mask_pi.js (for instance serial and threaded).

  python3 -I tests/compare_mask_runs.py <run_a> <run_b>

frames.csv must be identical except for the timing column, trails.csv identical,
and every <frame>_mask.xisf must hold the same pixels (the files themselves differ
by their creation time). Exit code 1 on any difference. Needs numpy.
"""
import csv, glob, os, re, sys, zlib

import numpy as np


def mask_pixels(path):
    with open(path, "rb") as f:
        head = f.read(16)
        xml = f.read(int.from_bytes(head[8:12], "little")).decode("utf-8")
        img = re.search(r"<Image\b[^>]*>", xml).group(0)
        attr = dict(re.findall(r'(\w+)="([^"]*)"', img))
        pos, size = (int(v) for v in attr["location"].split(":")[1:3])
        f.seek(pos)
        raw = f.read(size)
    comp = attr.get("compression")
    if comp:
        codec = comp.split(":")[0]
        if not codec.startswith("zlib"):
            sys.exit("unsupported compression " + comp)
        raw = zlib.decompress(raw)
        if codec.endswith("+sh"):   # byte shuffling: 1 byte per sample for UInt8, nothing to undo
            item = int(comp.split(":")[2]) if comp.count(":") >= 2 else 1
            if item > 1:
                raw = np.frombuffer(raw, np.uint8).reshape(item, -1).T.tobytes()
    return np.frombuffer(raw, np.uint8)


def rows(path, drop_last):
    out = list(csv.reader(open(path)))
    return [r[:-1] for r in out] if drop_last else out


a, b = sys.argv[1], sys.argv[2]
bad = 0
if rows(os.path.join(a, "frames.csv"), True) != rows(os.path.join(b, "frames.csv"), True):
    print("frames.csv differ"); bad += 1
if rows(os.path.join(a, "trails.csv"), False) != rows(os.path.join(b, "trails.csv"), False):
    print("trails.csv differ"); bad += 1
ma = sorted(os.path.basename(p) for p in glob.glob(os.path.join(a, "*_mask.xisf")))
mb = sorted(os.path.basename(p) for p in glob.glob(os.path.join(b, "*_mask.xisf")))
if ma != mb:
    print("different sets of mask files"); bad += 1
same = 0
for n in sorted(set(ma) & set(mb)):
    if np.array_equal(mask_pixels(os.path.join(a, n)), mask_pixels(os.path.join(b, n))):
        same += 1
    else:
        print("mask pixels differ:", n); bad += 1
print("%d masks with identical pixels, %d difference(s)" % (same, bad))
sys.exit(1 if bad else 0)
