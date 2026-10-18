#!/usr/bin/env python3
"""
StarlinkSweeper CLI - batch detection of satellite / aircraft trails in astro
subframes (same algorithm as the StarlinkSweeper PixInsight script).

Per frame (FITS or uncompressed XISF):
  1. bin (mean) and subtract a large-scale background (coarse median, 2 passes),
  2. normalise to robust sigma units, clip to [-3, +3] so stars weigh little,
  3. coarse line projection (Radon by accumulation) at bin 16, every 0.25 deg,
     remove broad structures along rho (nebulae, gradients), keep narrow peaks,
  4. refine each candidate at bin 8, 0.05 deg steps,
  5. continuity test: the line is cut into 12 segments; a trail must be present
     in at least 3 consecutive segments (rejects arcs of nebula, spikes, chance
     alignments). Score = significance over that run, in robust sigma.

Only light frames are analysed: flats, darks and bias are recognised from
their IMAGETYP (or FRAME / FRAMETYP) header and skipped, unless --all-types is
given; frames without the keyword are scanned. A frame is flagged when its
score is above --threshold. Nothing is deleted: --move only moves flagged
frames into a sub-folder.

Author: Jacques Pouyaud, with Claude. License: MIT.
"""
import argparse
import csv
import os
import re
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from scipy import ndimage as nd

VERSION = "1.1.0"
EXTS = (".fit", ".fits", ".fts", ".xisf")
COARSE_BIN, FINE_BIN = 16, 8
COARSE_STEP, FINE_STEP, FINE_HALF = 0.25, 0.05, 0.6
N_SEG, MIN_RUN, SEG_MIN_SIG = 24, 6, 1.5
SPIKE_MAX_RUN = 18                 # a line through a saturated star is a spike unless it runs longer
MAX_CAND = 8
FLOOR = 4.0                        # internal detection floor; the user threshold only filters


# --------------------------------------------------------------------------- I/O
TYPE_KEYWORDS = ("IMAGETYP", "FRAME", "FRAMETYP")


def frame_type(value):
    """Normalised frame type from an IMAGETYP-like keyword value:
    'light', 'flat', 'dark', 'bias', 'other', or None when empty."""
    v = str(value).strip().strip("'\"").strip().lower()
    if not v:
        return None
    if "light" in v:
        return "light"
    if "flat" in v:
        return "flat"
    if "dark" in v:
        return "dark"
    if "bias" in v or "offset" in v:
        return "bias"
    return "other"


def xisf_header(path):
    with open(path, "rb") as f:
        if f.read(8) != b"XISF0100":
            raise ValueError("not an XISF 1.0 file")
        hlen = int.from_bytes(f.read(4), "little")
        f.read(4)
        return f.read(hlen).decode("utf-8", "replace")


def read_frame_type(path):
    """Frame type from the header keywords IMAGETYP, FRAME or FRAMETYP (None if absent)."""
    if path.lower().endswith(".xisf"):
        hdr = xisf_header(path)
        for k in TYPE_KEYWORDS:
            m = re.search(r'<FITSKeyword\s+name="%s"\s+value="([^"]*)"' % k, hdr)
            if m:
                t = frame_type(m.group(1).replace("&apos;", "'"))
                if t:
                    return t
        return None
    from astropy.io import fits
    with fits.open(path, memmap=True) as hdul:
        for hdu in hdul:
            for k in TYPE_KEYWORDS:
                if k in hdu.header:
                    t = frame_type(hdu.header[k])
                    if t:
                        return t
    return None


def read_xisf(path):
    """Minimal reader for monolithic, uncompressed XISF images (first image)."""
    hdr = xisf_header(path)
    m = re.search(r"<Image\b[^>]*>", hdr)
    if not m:
        raise ValueError("no <Image> element")
    attr = dict(re.findall(r'(\w+)="([^"]*)"', m.group(0)))
    if "compression" in attr:
        raise ValueError("compressed XISF not supported (save uncompressed, or FITS)")
    geom = [int(v) for v in attr["geometry"].split(":")]
    w, h = geom[0], geom[1]
    fmt = {"Float32": "<f4", "Float64": "<f8", "UInt16": "<u2",
           "UInt8": "u1", "UInt32": "<u4"}[attr.get("sampleFormat", "Float32")]
    loc = attr["location"].split(":")
    if loc[0] != "attachment":
        raise ValueError("only attached XISF data blocks are supported")
    data = np.fromfile(path, dtype=fmt, count=w * h, offset=int(loc[1]))
    return data.reshape(h, w)                      # native dtype: the binning does the conversion


def read_fits(path):
    from astropy.io import fits
    with fits.open(path, memmap=False) as hdul:
        for hdu in hdul:
            if hdu.data is not None and hdu.data.ndim >= 2:
                d = hdu.data
                if d.ndim == 3:
                    d = d[0]
                return d                            # native dtype: the binning does the conversion
    raise ValueError("no 2-D image HDU")


def read_image(path):
    return read_xisf(path) if path.lower().endswith(".xisf") else read_fits(path)


def frame_pixels(path):
    """Number of pixels of the first image, from the header only (0 if unknown)."""
    try:
        if path.lower().endswith(".xisf"):
            m = re.search(r'<Image\b[^>]*geometry="(\d+):(\d+)', xisf_header(path))
            return int(m.group(1)) * int(m.group(2)) if m else 0
        from astropy.io import fits
        with fits.open(path, memmap=True) as hdul:
            for hdu in hdul:
                h = hdu.header
                if h.get("NAXIS", 0) >= 2:
                    return int(h["NAXIS1"]) * int(h["NAXIS2"])
    except Exception:
        pass
    return 0


def available_memory():
    """Available physical memory in bytes, or None when it cannot be determined."""
    try:
        import psutil
        return psutil.virtual_memory().available
    except Exception:
        pass
    try:
        with open("/proc/meminfo") as f:                       # Linux
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    try:                                                       # Windows
        import ctypes
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        st = MEMORYSTATUSEX(); st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return int(st.ullAvailPhys)
    except Exception:
        pass
    try:                                                       # macOS / other Unix
        import subprocess
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
        page = int(re.search(r"page size of (\d+)", out).group(1))
        free = sum(int(re.search(r"%s:\s+(\d+)" % k, out).group(1)) for k in ("Pages free", "Pages inactive"))
        return free * page
    except Exception:
        return None


def probe(inputs):
    """Machine capacity for a front-end: JSON on stdout."""
    import json
    sample = None
    for p in inputs:
        if os.path.isdir(p):
            for root, _, names in os.walk(p):
                for n in sorted(names):
                    if n.lower().endswith(EXTS):
                        sample = os.path.join(root, n)
                        break
                if sample:
                    break
        elif p.lower().endswith(EXTS) and os.path.exists(p):
            sample = p
        if sample:
            break
    cpus = os.cpu_count() or 1
    px = frame_pixels(sample) if sample else 0
    per_worker = 100e6 + 5.0 * (px or 60e6)
    avail = available_memory()
    by_mem = max(1, int(avail * 0.75 // per_worker)) if avail else cpus
    suggested = max(1, min(max(1, cpus - 1), by_mem))
    maximum = max(1, min(cpus, by_mem))
    print(json.dumps({"version": VERSION, "cpus": cpus, "available_gb": round(avail / 1e9, 2) if avail else None,
                      "frame_mpx": round((px or 0) / 1e6, 1), "per_worker_gb": round(per_worker / 1e9, 2),
                      "suggested_workers": suggested, "max_workers": maximum}), flush=True)


def auto_jobs(sample_path):
    """Worker count fitted to the machine: one core left to the user, and the
    available memory divided by the measured footprint of one worker (about
    100 MB plus 5 bytes per pixel of the frame). Returns (jobs, explanation)."""
    cpus = os.cpu_count() or 1
    by_cpu = max(1, cpus - 1)
    px = frame_pixels(sample_path)
    per_worker = 100e6 + 5.0 * (px or 60e6)
    avail = available_memory()
    if avail is None:
        return by_cpu, "%d workers (%d CPUs, memory unknown, ~%.1f GB per worker)" % (by_cpu, cpus, per_worker / 1e9)
    by_mem = max(1, int(avail * 0.75 // per_worker))
    jobs = max(1, min(by_cpu, by_mem))
    limit = "CPU" if by_cpu <= by_mem else "memory"
    return jobs, "%d workers (%d CPUs, %.1f GB available, ~%.2f GB per worker for %d Mpx frames, limited by %s)" % (
        jobs, cpus, avail / 1e9, per_worker / 1e9, round((px or 60e6) / 1e6), limit)


# ---------------------------------------------------------------------- analysis
def bin_mean(a, b):
    """Mean binning b x b, float32 result, no full-size float copy of the input."""
    h, w = a.shape
    a = a[: h // b * b, : w // b * b]
    return a.reshape(h // b, b, w // b, b).mean(axis=(1, 3), dtype=np.float32)


def robust_sigma(a):
    med = np.median(a)
    s = 1.4826 * np.median(np.abs(a - med))
    return med, (s if np.isfinite(s) and s > 0 else (np.std(a) or 1.0))


def background(s, coarse=4, size=15):
    """Large-scale background of the binned image s: median on a coarser grid,
    second pass with bright pixels replaced (limits the halo around trails)."""
    c = bin_mean(s, coarse)
    bg = nd.median_filter(c, size=size, mode="nearest")
    _, sig = robust_sigma(c - bg)
    c2 = np.where(c - bg > 2.0 * sig, bg, c)
    bg = nd.median_filter(c2, size=size, mode="nearest")
    # cell-centred bilinear upsampling (grid_mode), then pad to the binned size
    bg = nd.zoom(bg, coarse, order=1, grid_mode=True, mode="nearest")
    out = np.empty(s.shape, np.float32)
    h, w = min(bg.shape[0], s.shape[0]), min(bg.shape[1], s.shape[1])
    out[:h, :w] = bg[:h, :w]
    out[h:, :] = out[h - 1:h, :]
    out[:, w:] = out[:, w - 1:w]
    return out


def normalise(s, margin, star_sum=4000.0):
    """Background-subtracted image in robust sigma units, clipped to [-3, 3];
    the validity mask (frame margins excluded); the positions of saturated
    stars, used to reject diffraction spikes. A star is a 3x3 block whose
    summed excess exceeds star_sum (in binned sigma): a hot pixel, even at
    65535, stays well below that, a saturated star disk is far above."""
    r = s - background(s)
    med, sig = robust_sigma(r)
    zu = (r - med) / sig
    z = np.clip(zu, -3.0, 3.0).astype(np.float32)
    valid = np.ones(z.shape, bool)
    if margin > 0:
        valid[:margin, :] = valid[-margin:, :] = False
        valid[:, :margin] = valid[:, -margin:] = False
    blk = nd.uniform_filter(zu, size=3) * 9.0
    peaks = (blk > star_sum) & (blk == nd.maximum_filter(blk, size=7)) & valid
    ys, xs = np.nonzero(peaks)
    stars = np.column_stack([xs - s.shape[1] / 2.0, ys - s.shape[0] / 2.0]) if len(xs) else np.zeros((0, 2))
    return z, valid, stars


class Projector:
    """Line sums of z along every direction (Radon transform by accumulation).
    Line: x*cos(t) + y*sin(t) = rho, with x, y centred on the image."""

    def __init__(self, z, valid):
        h, w = z.shape
        yy, xx = np.nonzero(valid)
        self.x = (xx - w / 2.0).astype(np.float32)
        self.y = (yy - h / 2.0).astype(np.float32)
        self.v = z[valid].astype(np.float32)
        self.shape = z.shape
        self.half = int(np.ceil(np.hypot(h, w) / 2)) + 1
        self.nrho = 2 * self.half + 1

    def project(self, thetas_deg):
        R = np.zeros((self.nrho, len(thetas_deg)), np.float32)
        N = np.zeros_like(R)
        for j, t in enumerate(np.deg2rad(thetas_deg)):
            idx = np.rint(self.x * np.cos(t) + self.y * np.sin(t)).astype(np.int32) + self.half
            R[:, j] = np.bincount(idx, weights=self.v, minlength=self.nrho)
            N[:, j] = np.bincount(idx, minlength=self.nrho)
        return R, N

    def significance(self, thetas_deg, minlen):
        R, N = self.project(thetas_deg)
        ok = N >= minlen
        Z = np.where(ok, R / np.sqrt(np.maximum(N, 1.0)), 0.0)
        # broad structures (nebulae, gradients, clouds) are wide along rho:
        # subtract a low percentile over a long rho window, thin lines survive
        Z = Z - nd.percentile_filter(Z, 30, size=(61, 1), mode="nearest")
        _, s = robust_sigma(Z[ok])
        return np.where(ok, Z / s, 0.0)

    def segments(self, theta_deg, rho, n_seg=N_SEG, halfwidth=1.0):
        """Per-segment significance along one line, in units of the robust
        per-pixel sigma of z."""
        t = np.deg2rad(theta_deg)
        d = self.x * np.cos(t) + self.y * np.sin(t) - rho
        ad = np.abs(d)
        m = ad <= halfwidth                       # the line band
        w = (ad >= 3.0) & (ad <= 8.0)             # parallel side bands = local baseline
        if m.sum() < 10 or w.sum() < 10:
            return np.zeros(n_seg), np.zeros(n_seg, int), (0.0, 1.0)
        sel = m | w
        u = -self.x[sel] * np.sin(t) + self.y[sel] * np.cos(t)
        umin, umax = float(u.min()), float(u.max())
        k = np.clip(((u - umin) / (umax - umin + 1e-6) * n_seg).astype(int), 0, n_seg - 1)
        inb = m[sel]
        bsum = np.bincount(k[inb], weights=self.v[sel][inb], minlength=n_seg)
        bn = np.bincount(k[inb], minlength=n_seg)
        wsum = np.bincount(k[~inb], weights=self.v[sel][~inb], minlength=n_seg)
        wn = np.bincount(k[~inb], minlength=n_seg)
        wmean = wsum / np.maximum(wn, 1)
        _, s = robust_sigma(self.v)
        excess = bsum - bn * wmean
        err = s * np.sqrt(np.maximum(bn, 1) * (1.0 + bn / np.maximum(wn, 1)))
        return np.where(bn > 0, excess / err, 0.0), bn, (umin, umax)


def continuity(seg_sig, min_sig=SEG_MIN_SIG, min_run=MIN_RUN):
    """Best run of consecutive significant segments -> (score, run, start).
    One isolated weak (but non-negative) segment inside a run is tolerated. The score is
    sqrt(run) * MEDIAN of the segment significances over the run, so a few
    bright crossings (nebula chord, spike, star) cannot carry the line alone."""
    n = len(seg_sig)
    good = seg_sig >= min_sig
    best = (0.0, 0, 0)
    i = 0
    while i < n:
        if not good[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and (good[j + 1] or (j + 2 < n and good[j + 2] and seg_sig[j + 1] >= 0)):
            j += 1
        run = j - i + 1
        sc = float(np.sqrt(run) * np.median(seg_sig[i:j + 1]))
        if run >= min_run and sc > best[0]:
            best = (sc, run, i)
        i = j + 1
    return best


def on_bright_star(theta_deg, rho, run, start, stars, n_seg, extent, maxdist=2.5):
    """True when a very bright star sits on the line inside the run: a short
    bright line through a saturated star is a diffraction spike, not a trail."""
    if len(stars) == 0:
        return False
    t = np.deg2rad(theta_deg)
    d = stars[:, 0] * np.cos(t) + stars[:, 1] * np.sin(t) - rho
    u = -stars[:, 0] * np.sin(t) + stars[:, 1] * np.cos(t)
    umin, umax = extent
    k = (u - umin) / (umax - umin + 1e-6) * n_seg
    return bool(np.any((np.abs(d) <= maxdist) & (k >= start - 1) & (k <= start + run + 1)))


def endpoints(theta_deg, rho, u0, u1, shape, binning):
    """Full-resolution endpoints of the detected run: points at along-line
    coordinates u0 and u1 (u = -x sin t + y cos t, x and y centred)."""
    h, w = shape
    t = np.deg2rad(theta_deg)
    cx, cy = w / 2.0, h / 2.0
    pts = []
    for u in (u0, u1):
        pts.append((cx + rho * np.cos(t) - u * np.sin(t), cy + rho * np.sin(t) + u * np.cos(t)))
    f = lambda v: int(round(v * binning))
    return f(pts[0][0]), f(pts[0][1]), f(pts[1][0]), f(pts[1][1])


def analyse(path, threshold=20.0, max_lines=5):
    t0 = time.time()
    img = read_image(path)
    H, W = img.shape
    s8 = bin_mean(img, FINE_BIN)
    del img
    z8, v8, stars = normalise(s8, margin=12)
    z16, v16 = bin_mean(z8, 2), bin_mean(v8.astype(np.float32), 2) > 0.99

    # ---- coarse scan
    P16 = Projector(z16, v16)
    thetas = np.arange(0.0, 180.0, COARSE_STEP)
    S = P16.significance(thetas, minlen=0.15 * min(z16.shape))
    cand = []
    for k in np.argsort(S.ravel())[::-1][:3000]:
        i, j = np.unravel_index(k, S.shape)
        if S[i, j] < FLOOR:
            break
        if any(abs(i - a) < 6 and min(abs(j - b), len(thetas) - abs(j - b)) < 6 for a, b in cand):
            continue
        cand.append((i, j))
        if len(cand) >= MAX_CAND:
            break
    coarse_best = float(S.max())

    # ---- fine refinement + continuity test
    P8 = Projector(z8, v8)
    minlen8 = 0.15 * min(z8.shape)
    lines = []
    for i, j in cand:
        th = thetas[j] + np.arange(-FINE_HALF, FINE_HALF + 1e-9, FINE_STEP)
        Sf = P8.significance(th % 180.0, minlen8)
        rho_c = 2 * (i - P16.half)                     # bin16 rho -> bin8 rho
        lo = max(0, rho_c + P8.half - 14)
        hi = min(Sf.shape[0], rho_c + P8.half + 15)
        sub = Sf[lo:hi]
        for _ in range(4):                               # up to 4 lines per candidate band
            a, b = np.unravel_index(np.argmax(sub), sub.shape)
            peak = float(sub[a, b])
            if peak < FLOOR:
                break
            theta, rho = float((th[b]) % 180.0), (lo + a) - P8.half
            seg, n, extent = P8.segments(theta, rho)
            score, run, start = continuity(seg)
            spike = run <= SPIKE_MAX_RUN and on_bright_star(theta, rho, run, start, stars, N_SEG, extent)
            u0 = extent[0] + (extent[1] - extent[0]) * start / N_SEG
            u1 = extent[0] + (extent[1] - extent[0]) * (start + run) / N_SEG
            lines.append(dict(score=round(0.0 if spike else score, 1), peak=round(peak, 1),
                              angle=round(theta, 2), rho=int(rho), run=int(run), spike=bool(spike),
                              u0=float(u0), u1=float(u1), seg=np.round(seg, 1).tolist()))
            sub = sub.copy()
            sub[max(0, a - 2):a + 3, :] = 0

    lines.sort(key=lambda d: -d["score"])
    kept = []
    for ln in lines:
        if ln["score"] < threshold:
            continue
        if any(abs(ln["rho"] - k["rho"]) < 4 and abs(ln["angle"] - k["angle"]) < 0.5 for k in kept):
            continue
        ln["x0"], ln["y0"], ln["x1"], ln["y1"] = endpoints(ln["angle"], ln["rho"], ln["u0"], ln["u1"],
                                                           z8.shape, FINE_BIN)
        kept.append(ln)
        if len(kept) >= max_lines:
            break

    score = kept[0]["score"] if kept else (max((l["score"] for l in lines), default=0.0))
    out = dict(file=path, width=W, height=H, score=round(float(score), 1), coarse=round(coarse_best, 1),
               flagged=bool(kept), n_lines=len(kept), lines=kept, candidates=lines, n_stars=len(stars),
               seconds=round(time.time() - t0, 1))
    return out, z8


# ---------------------------------------------------------------------- outputs
def save_preview(z, res, outdir):
    from PIL import Image, ImageDraw
    v = np.clip((z + 2.0) / 5.0, 0, 1)
    im = Image.fromarray((v * 255).astype(np.uint8)).convert("RGB")
    d = ImageDraw.Draw(im)
    for ln in res["lines"]:
        d.line([(ln["x0"] / FINE_BIN, ln["y0"] / FINE_BIN), (ln["x1"] / FINE_BIN, ln["y1"] / FINE_BIN)],
               fill=(255, 40, 40), width=1)
    d.text((8, 8), "%s  score %.1f" % (os.path.basename(res["file"]), res["score"]), fill=(255, 255, 0))
    im.save(os.path.join(outdir, os.path.splitext(os.path.basename(res["file"]))[0] + "_trail.png"))


def worker(args):
    path, threshold, preview_dir, preview_all, lights_only = args
    try:
        if lights_only:
            t = read_frame_type(path)
            if t is not None and t != "light":
                return {"file": path, "skipped": t}
        res, z = analyse(path, threshold=threshold)
        if preview_dir and (res["flagged"] or preview_all):
            save_preview(z, res, preview_dir)
        return res
    except Exception as e:
        return {"file": path, "error": str(e)}


def main():
    ap = argparse.ArgumentParser(description="Flag subframes that contain satellite / aircraft trails.")
    ap.add_argument("inputs", nargs="+", help="files or folders (FITS / uncompressed XISF)")
    ap.add_argument("-r", "--recursive", action="store_true", help="scan sub-folders")
    ap.add_argument("-t", "--threshold", type=float, default=20.0,
                    help="continuity score (robust sigma) from which a frame is flagged [20, the listing level of the PixInsight script]")
    ap.add_argument("-j", "--jobs", default="auto",
                    help="parallel processes; 'auto' (default) fits the CPU count and the available memory")
    ap.add_argument("-o", "--csv", default="starlinksweeper_report.csv", help="CSV report path")
    ap.add_argument("--preview", metavar="DIR", help="PNG of each flagged frame with the lines drawn")
    ap.add_argument("--preview-all", action="store_true", help="PNG for every frame, not only flagged")
    ap.add_argument("--move", metavar="DIR", help="move flagged frames into DIR (never deletes)")
    ap.add_argument("--list", metavar="FILE", help="write flagged file names, one per line")
    ap.add_argument("--all-types", action="store_true",
                    help="scan every frame; by default flats, darks and bias (IMAGETYP header) are skipped")
    ap.add_argument("--json-lines", action="store_true",
                    help="also print one '#JSON {...}' line per frame, for front-ends")
    ap.add_argument("--probe", action="store_true",
                    help="print the machine capacity as JSON (cpus, memory, suggested and maximum workers) and exit")
    a = ap.parse_args()
    if a.probe:
        probe(a.inputs)
        return

    files = []
    for p in a.inputs:
        if os.path.isdir(p):
            walker = os.walk(p) if a.recursive else [(p, [], os.listdir(p))]
            for root, _, names in walker:
                files += [os.path.join(root, n) for n in sorted(names) if n.lower().endswith(EXTS)]
        elif p.lower().endswith(EXTS):
            files.append(p)
    if a.move:
        mv = os.path.abspath(a.move)
        files = [f for f in files if not os.path.abspath(f).startswith(mv + os.sep)]
    if not files:
        sys.exit("no FITS/XISF files found")
    if a.preview:
        os.makedirs(a.preview, exist_ok=True)
    if str(a.jobs).lower() in ("auto", "0"):
        jobs, why = auto_jobs(files[0])
    else:
        jobs, why = max(1, int(a.jobs)), "%s workers (requested)" % a.jobs
    a.jobs = jobs

    print("StarlinkSweeper %s: %d frames, threshold %.1f" % (VERSION, len(files), a.threshold), flush=True)
    print("Workers: " + why, flush=True)
    jobs = [(f, a.threshold, a.preview, a.preview_all, not a.all_types) for f in files]
    results, t0 = [], time.time()
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        for k, res in enumerate(ex.map(worker, jobs), 1):
            results.append(res)
            name = os.path.basename(res["file"])
            if "error" in res:
                print("[%d/%d] %s  ERROR %s" % (k, len(files), name, res["error"]), flush=True)
            elif "skipped" in res:
                print("[%d/%d] %-58s skipped (%s)" % (k, len(files), name[:58], res["skipped"].upper()), flush=True)
            else:
                tag = "TRAIL x%d" % res["n_lines"] if res["flagged"] else "ok"
                print("[%d/%d] %-58s score %6.1f (peak %5.1f) %5.1fs  %s"
                      % (k, len(files), name[:58], res["score"], res["coarse"], res["seconds"], tag), flush=True)
            if a.json_lines:
                import json
                if "error" in res:
                    rec = {"file": res["file"], "status": "error", "error": res["error"]}
                elif "skipped" in res:
                    rec = {"file": res["file"], "status": "skipped", "skipped": res["skipped"]}
                else:
                    rec = {"file": res["file"], "status": "", "score": res["score"], "coarse": res["coarse"],
                           "width": res["width"], "height": res["height"], "seconds": res["seconds"],
                           "lines": [{"score": l["score"], "angle": l["angle"], "run": l["run"],
                                      "x0": l["x0"], "y0": l["y0"], "x1": l["x1"], "y1": l["y1"]} for l in res["lines"]]}
                print("#JSON " + json.dumps(rec), flush=True)

    with open(a.csv, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["file", "flagged", "score", "coarse_peak", "n_lines", "width", "height",
                     "lines(score@angle/segments:x0,y0-x1,y1)", "status"])
        for r in results:
            if "error" in r:
                wr.writerow([r["file"], "", "", "", "", "", "", "", "error: " + r["error"]])
                continue
            if "skipped" in r:
                wr.writerow([r["file"], "", "", "", "", "", "", "", "skipped: " + r["skipped"]])
                continue
            desc = " | ".join("%.1f@%.2f/%d:%d,%d-%d,%d" % (l["score"], l["angle"], l["run"], l["x0"], l["y0"], l["x1"], l["y1"])
                              for l in r["lines"])
            wr.writerow([r["file"], int(r["flagged"]), r["score"], r["coarse"], r["n_lines"], r["width"], r["height"], desc, ""])

    flagged = [r["file"] for r in results if r.get("flagged")]
    scores = [r["score"] for r in results if "score" in r]
    skipped = sum(1 for r in results if "skipped" in r)
    if scores:
        print("\nScores: median %.1f, min %.1f, max %.1f" % (np.median(scores), min(scores), max(scores)))
    print("%d / %d frames flagged (%d skipped as non-light), %.0f s total. Report: %s"
          % (len(flagged), len(scores), skipped, time.time() - t0, a.csv))
    if a.list:
        with open(a.list, "w") as f:
            f.write("\n".join(os.path.basename(x) for x in flagged) + ("\n" if flagged else ""))
    if a.move and flagged:
        os.makedirs(a.move, exist_ok=True)
        for x in flagged:
            shutil.move(x, os.path.join(a.move, os.path.basename(x)))
        print("Moved %d frames to %s" % (len(flagged), a.move))


if __name__ == "__main__":
    main()
