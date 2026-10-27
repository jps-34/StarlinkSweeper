#!/usr/bin/env python3
"""
Compares two runs of tests/run_scan_pi.js (JSON lines, one per frame).

  python3 -I tests/compare_scans.py <run_a.jsonl> <run_b.jsonl>

Every field of every frame is compared exactly (the timing is ignored); the
differing fields are listed per frame. Exit code 1 on any difference.
"""
import json
import sys


def load(path):
    out = {}
    for line in open(path, encoding="utf-8"):
        if line.strip():
            r = json.loads(line)
            if "run" in r:                 # timing line of the whole run
                print("%s: %s, %.1f s" % (path, r["run"], r["seconds"]))
                continue
            r.pop("seconds", None)
            out[r.get("file", "?")] = r
    return out


def walk(x, y, path, notes):
    if isinstance(x, dict) and isinstance(y, dict):
        for k in sorted(set(x) | set(y)):
            walk(x.get(k), y.get(k), path + "." + k, notes)
    elif isinstance(x, list) and isinstance(y, list):
        if len(x) != len(y):
            notes.append("%s: %d / %d items" % (path, len(x), len(y)))
            return
        for i, (u, v) in enumerate(zip(x, y)):
            walk(u, v, "%s[%d]" % (path, i), notes)
    elif x != y:
        notes.append("%s: %r / %r" % (path, x, y))


a, b = load(sys.argv[1]), load(sys.argv[2])
bad = 0
for name in sorted(set(a) | set(b)):
    notes = []
    if name not in a or name not in b:
        notes.append("present in one run only")
    else:
        walk(a[name], b[name], "", notes)
    if notes:
        bad += 1
        print(name + ": " + "; ".join(notes[:5]))
listed = lambda run: sum(1 for r in run.values() if r.get("score", -1) >= 20)
print("%d frames, %d identical, %d different; listed (score >= 20): %d / %d"
      % (len(set(a) | set(b)), len(set(a) | set(b)) - bad, bad, listed(a), listed(b)))
sys.exit(1 if bad else 0)
