#!/usr/bin/env python3
"""
Summarises two runs of tests/run_scan_pi.js (an older and a newer version of
the detection), frame by frame, for a review by eye.

  python3 -I tests/summarize_scans.py <old.jsonl> <new.jsonl> [level]

For every frame with a line at or above the level (15 by default, the
candidate level of the masking) in either run, or with lines dropped by the
profile test: the best scores, the lines kept (score@angle/rho, run, cross
profile) and the lines dropped with the reason ("edge" or "wide"). Frames that
change between listed and clean are marked. compare_scans.py remains the exact,
field by field comparison.
"""
import json
import sys


def load(path):
    out = {}
    for line in open(path, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        if "run" in r:
            print("%s: %s, %.1f s" % (path, r["run"], r["seconds"]))
            continue
        out[r.get("file", "?")] = r
    return out


def fmt(L):
    return "%.1f@%.2f/%d run %d" % (L.get("raw", L["score"]), L["angle"], L["rho"], L["run"])


old, new = load(sys.argv[1]), load(sys.argv[2])
level = float(sys.argv[3]) if len(sys.argv) > 3 else 15.0
to_clean = to_listed = 0
for name in sorted(set(old) | set(new)):
    o, n = old.get(name, {}), new.get(name, {})
    ol = [L for L in o.get("lines", []) if L["score"] >= level]
    nl = [L for L in n.get("lines", []) if L["score"] >= level]
    rej = n.get("rejected", [])
    if not ol and not nl and not rej:
        continue
    mark = ""
    if bool(ol) != bool(nl):
        mark = "   <== listed -> clean" if ol else "   <== clean -> listed"
        to_clean += bool(ol)
        to_listed += bool(nl)
    print("%-32s old %6.1f (%d)  new %6.1f (%d)%s"
          % (name, o.get("score", -1), len(ol), n.get("score", -1), len(nl), mark))
    for L in nl:
        print("      kept     %s  profile %s" % (fmt(L), L.get("profile")))
    for L in rej:
        print("      dropped  %-4s %s  profile %s" % (L.get("reject"), fmt(L), L.get("profile")))
print("frames with a line >= %g: old %d, new %d; listed -> clean %d, clean -> listed %d"
      % (level, sum(1 for r in old.values() if r.get("score", -1) >= level),
         sum(1 for r in new.values() if r.get("score", -1) >= level), to_clean, to_listed))
