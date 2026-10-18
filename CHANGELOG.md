# Changelog

## 1.0.1 (2026-10-18)
* Only light frames are analysed: flats, darks and bias are recognised from their `IMAGETYP`
  (or `FRAME` / `FRAMETYP`) header and skipped, in the script (*Lights only* option, on by default)
  and in the command-line version (`--all-types` to scan everything). Frames without the keyword
  are scanned. Skipped frames are listed in the CSV report.

## 1.0.0 (2026-10-18)
* First release. PixInsight script (`scripts/StarlinkSweeper.js`): folder scan, list of the frames
  crossed by trails with score, angle and extent, preview with the detected trails, quarantine to a
  `_trails` sub-folder, confirmed erase, open at full resolution, threshold re-filtering, CSV
  export.
* Command-line version (`python/starlinksweeper.py`) with the same algorithm and scores: parallel
  scan, CSV report, PNG previews, optional move of the flagged frames, list of flagged names.
* Detector: binned Radon-type line projection with removal of broad structures, fine angular
  refinement, continuity test over 24 segments with local baselines, diffraction-spike rejection
  through saturated stars.
* PixInsight update repository served from `docs/` (unsigned for now).
