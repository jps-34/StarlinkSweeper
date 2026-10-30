#engine v8
#feature-id    StarlinkSweeper : JPS > StarlinkSweeper
#feature-info  Finds subframes crossed by satellite or aircraft trails, shows \
   each detection on a preview, and lets you quarantine (moved next to the \
   scanned folder) or erase the affected frames one by one. Nothing is deleted \
   without confirmation.

/*
 * StarlinkSweeper.js  v1.3.2
 * Copyright (c) 2026 Jacques Pouyaud.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under the GNU General Public License, version 3 or (at your
 * option) any later version, WITHOUT ANY WARRANTY; see LICENSE.
 * Code written by Claude (Anthropic),
 * under the direction of Jacques Pouyaud.
 * https://github.com/jps-34/StarlinkSweeper
 *
 * v1.3.2: Export CSV works again; Return in an edit box runs no button.
 * v1.3.1: masking finds trails crossing a corner; the log states the data really
 *   lost; deprecated names replaced.
 * v1.3.0: masking option for WBPP (StarlinkSweeper-WBPP.js): the frames are
 *   kept and only the pixels of their trails are left out of the integration.
 *   The detection core moves to StarlinkSweeperCore.js. Interface in English or
 *   French. The command-line Python version is removed from the repository.
 * v1.2.2: menu entry moved to Script > JPS (was Script > Utilities).
 * v1.2.1: licence changed to GPL-3.0-or-later (1.2.0 and earlier: MIT).
 * v1.2.0: runs on the V8 engine of PixInsight; parallel scan on threads
 *   (PixInsight 1.9.5), Threads setting; the Python option is removed from the
 *   dialog (the command-line version stays as a separate tool).
 * v1.1.5: the machine probe works with no folder selected (the command line
 *   refused it, so Detect failed right after a Reset).
 * v1.1.4: Reset button (PixInsight style, bottom left) that forgets every
 *   remembered setting; the scanner status shows the path of the command-line
 *   script in use and warns when its version differs from the script's.
 * v1.1.3: the quarantine folder is created NEXT TO the scanned folder
 *   (<folder>_trails, same sub-folders inside) instead of inside it, so that a
 *   stacking program importing the scanned folder never sees the quarantined
 *   frames. Quarantine folders are skipped by the scan.
 * v1.1.2: installation hints for the Python modules per system (apt, pip or a
 *   virtual environment); wording only.
 * v1.1.1: the dialog no longer depends on capturing the scanner's standard
 *   output: Python version and machine probe go through files, scan progress
 *   through a progress file; the detection reports why each candidate failed.
 * v1.1.0: parallel scan through the command-line version (starlinksweeper.py,
 *   installed with this script) when Python 3 with numpy, scipy and astropy is
 *   available: "Parallel scan with Python" option, Workers slider bounded by
 *   what the machine allows, results streamed into the list, previews built on
 *   demand. Built-in single-core scan otherwise.
 * v1.0.7: the window can be made narrower (wrapping labels, shortened file
 *   names, smaller minimum sizes); "Verbose log" option removed.
 * v1.0.6: one adjustable level only, "Red above". Frames and lines are listed
 *   from a fixed score of 20 up; weaker candidates are no longer drawn.
 * v1.0.5: "Red above" level: frames at or above it are shown in red and can be
 *   quarantined in one go ("Quarantine red"); red count in the summary and a
 *   "red" column in the CSV. Threshold, red level, options and last folder are
 *   remembered between sessions.
 * v1.0.4: the line under the preview is reset when a new scan starts and shows
 *   live counts (scanned, listed, skipped) whenever no frame is
 *   selected; the details of a selected frame follow the list refreshes.
 * v1.0.3: 1.0.1 and 1.0.2 stopped with an error right after the first frame
 *   (list refresh); fixed. Frame type read from the file keywords before
 *   loading, window keywords as fallback. Stop takes effect within a second
 *   or two (checked between the stages of the analysis, not only between
 *   frames) and the button gives feedback. "Verbose log" option: one console
 *   line per stage of each frame.
 * v1.0.1: only light frames are analysed; flats, darks and bias are recognised
 *   from their IMAGETYP (or FRAME / FRAMETYP) header and skipped ("Lights only"
 *   option, on by default). Frames without the keyword are scanned.
 * v1.0.0: first release.
 * ----------------------------------------------------------------------------
 * Point it at the folder tree of your light frames: every FITS / XISF light
 * frame is scanned for straight trails (satellites, Starlink trains, aircraft);
 * flats, darks and bias found in the tree are skipped from their header. The
 * suspect frames are listed with a score and a preview showing the detected
 * trail, so you can check each one and quarantine it (moved to a <folder>_trails
 * folder next to the scanned folder, reversible) or erase it (permanent,
 * confirmed one by one).
 *
 * Algorithm:
 *   1. bin x8 (mean), subtract a large-scale background, normalise to robust
 *      sigma units, clip to [-3, +3] so stars weigh little;
 *   2. coarse line projection (Radon by accumulation) at bin 16, every 0.25
 *      deg; broad structures along rho (nebulae, gradients) are removed, thin
 *      peaks are kept;
 *   3. each candidate is refined at bin 8 with 0.05 deg steps;
 *   4. continuity test: the line is cut into 24 segments, a trail must be
 *      present in at least 6 consecutive segments; the score is
 *      sqrt(run) * median(segment significance). A short line through a
 *      saturated star is a diffraction spike and is rejected.
 */

CoreApplication.ensureMinimumVersion( 1, 9, 4 );

var TITLE = "StarlinkSweeper";
var VERSION = "1.3.2";
var SCRIPT_DIR = File.extractDrive(#__FILE__) + File.extractDirectory(#__FILE__);
var EVENT_SCRIPT = SCRIPT_DIR + "/StarlinkSweeper-WBPP.js";   // masking option, run by WBPP

// Parameters, detection core, file reading and parallel scan: StarlinkSweeperCore.js
#include "StarlinkSweeperCore.js"

var LIST_THRESHOLD = 20.0;   // fixed: frames and lines are listed from this score up
var DEFAULT_ALERT = 60.0;    // adjustable: frames at or above this score are shown in red
var SETTINGS_KEY = "StarlinkSweeper";
var EXTENSIONS   = [".fit", ".fits", ".fts", ".xisf", ".FIT", ".FITS", ".FTS", ".XISF"];
var QUARANTINE_SUFFIX = "_trails";   // quarantine folder: <parent of the scanned folder>/<scanned folder name>_trails

// ----------------------------------------------------- folders and quarantine
function normalizedDir(path) {
   path = String(path).replace(/\\/g, "/");
   while (path.length > 1 && path.charAt(path.length - 1) == "/") path = path.substring(0, path.length - 1);
   return path;
}

function inQuarantine(path) {
   // true when any folder on the path is a quarantine folder (name ending with _trails)
   var parts = normalizedDir(path).split("/");
   for (var i = 0; i < parts.length - 1; ++i)
      if (parts[i].length > QUARANTINE_SUFFIX.length - 1 && parts[i].substring(parts[i].length - QUARANTINE_SUFFIX.length) == QUARANTINE_SUFFIX)
         return true;
   return false;
}

function quarantineRoot(scanFolder) {
   // The quarantine lives NEXT TO the scanned folder, not inside it, so that a
   // stacking program importing the scanned folder recursively never sees it:
   // scanning /a/b/lights puts the frames under /a/b/lights_trails/<same sub-path>.
   var root = normalizedDir(scanFolder);
   var parent = File.extractDirectory(root), name = File.extractName(root) + File.extractExtension(root);
   if (!parent.length || parent == root) return (root == "/" ? "" : root) + "/" + QUARANTINE_SUFFIX;
   if (!name.length) name = "lights";
   return parent + "/" + name + QUARANTINE_SUFFIX;
}

function makeDirs(path) {
   // creates the folder and its missing parents
   path = normalizedDir(path);
   if (File.directoryExists(path)) return;
   var parent = File.extractDirectory(path);
   if (parent.length && parent != path && !File.directoryExists(parent)) makeDirs(parent);
   File.createDirectory(path);
}

function listFrames(dir, recursive) {
   var files = [];
   for (var i = 0; i < EXTENSIONS.length; ++i) {
      var found = File.searchDirectory(dir + "/*" + EXTENSIONS[i], recursive);
      for (var k = 0; k < found.length; ++k)
         if (!inQuarantine(found[k]) && files.indexOf(found[k]) < 0) files.push(found[k]);
   }
   files.sort();
   return files;
}

function moveFile(src, dst) {
   if (typeof File.move == "function") File.move(src, dst);
   else { File.copyFile(dst, src); File.remove(src); }   // copyFile(target, source)
}

function csvEscape(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

function shortName(path, maxLength) {
   // File name shortened in the middle so that labels never force the window width.
   var n = File.extractNameAndExtension(path);
   if (n.length <= maxLength) return n;
   var keep = Math.floor((maxLength - 3) / 2);
   return n.substring(0, keep) + "..." + n.substring(n.length - keep);
}

function readSetting(key, type, fallback) {
   var v = Settings.read(SETTINGS_KEY + "/" + key, type);
   return Settings.lastReadOK ? v : fallback;
}

function writeSetting(key, type, value) {
   try { Settings.write(SETTINGS_KEY + "/" + key, type, value); } catch (e) { /* settings are a convenience */ }
}

// the last four belong to the Python option of 1.1.x: removed by Reset as well (not the language)
var SETTING_KEYS = ["alert", "folder", "recursive", "lightsOnly", "threads", "external", "pythonPath", "cliPath", "workers"];

// ----------------------------------------------------------------- language
// Interface in English or French: the choice is remembered (setting
// StarlinkSweeper/language); otherwise the language of the system. The console
// and the CSV report stay in English.
var LANG = "en";

function detectLanguage() {
   var saved = readSetting("language", DataType.String, "");
   if (saved == "fr" || saved == "en") return saved;
   var names = ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"];
   for (var i = 0; i < names.length; ++i) {
      try {
         var v = "";
         if (typeof System !== "undefined" && System.getEnvironmentVariable)
            v = System.getEnvironmentVariable(names[i]);
         else if (typeof getEnvironmentVariable === "function")
            v = getEnvironmentVariable(names[i]);
         if (v && v.length > 0 && v != "C" && v != "POSIX") return v.toLowerCase().indexOf("fr") == 0 ? "fr" : "en";
      } catch (e) { }
   }
   return "en";
}

function L(fr, en) { return LANG == "fr" ? fr : en; }

function num(x, digits) {
   // Number with the decimal separator of the interface language.
   var s = x.toFixed(digits);
   return LANG == "fr" ? s.replace(".", ",") : s;
}

function statusText(s) {
   // Status of a frame as shown in the list (stored in English).
   if (LANG != "fr") return s;
   return { quarantined: "en quarantaine", erased: "effacée", error: "erreur", skipped: "ignorée" }[s] || s;
}

function removeSettings() {
   for (var i = 0; i < SETTING_KEYS.length; ++i)
      try { Settings.remove(SETTINGS_KEY + "/" + SETTING_KEYS[i]); } catch (e) { }
}

// ------------------------------------------------------------------- dialog
class SweeperDialog extends Dialog {
constructor() {
   super();
   // Return must validate the edit boxes, not run a button of the dialog.
   this.autoDefaultButton = false;
   var self = this;

   this.results = [];          // all analysed frames
   this.threshold = LIST_THRESHOLD;
   this.alert = readSetting("alert", DataType.Double, DEFAULT_ALERT);
   this.folder = readSetting("folder", DataType.String, "");
   if (this.folder.length && !File.directoryExists(this.folder)) this.folder = "";
   this.threads = readSetting("threads", DataType.Int32, 0);          // 0 = automatic
   this.stopRequested = false;
   this.scanning = false;
   this.bitmap = null;         // preview of the current frame
   this.bitmapIndex = -1;

   this.windowTitle = TITLE + " " + VERSION;
   this.userResizable = true;

   // ---- folder
   this.folderLabel = new Label(this);
   this.folderLabel.text = L("Dossier des brutes :", "Lights folder:");
   this.folderLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
   this.folderEdit = new Edit(this);
   this.folderEdit.readOnly = true;
   this.folderEdit.text = this.folder;
   this.folderEdit.toolTip = L("Dossier racine des brutes de lumière à analyser (FITS / XISF).",
                               "Root folder of the light frames to scan (FITS / XISF).");
   this.folderEdit.setMinWidth(this.logicalPixelsToPhysical(200));
   this.folderButton = new ToolButton(this);
   this.folderButton.icon = this.scaledResource(":/icons/select-file.png");
   this.folderButton.setScaledFixedSize(20, 20);
   this.folderButton.toolTip = L("Choisir le dossier", "Choose the folder");
   this.folderButton.onClick = function () {
      var gdd = new GetDirectoryDialog;
      gdd.caption = L("StarlinkSweeper : choisir le dossier des brutes", "StarlinkSweeper: select the lights folder");
      if (self.folder.length) gdd.initialPath = self.folder;
      if (gdd.execute()) { self.folder = gdd.directoryPath || gdd.directory; self.folderEdit.text = self.folder; }
   };
   this.recursiveCheck = new CheckBox(this);
   this.recursiveCheck.text = L("Sous-dossiers compris", "Include sub-folders");
   this.recursiveCheck.toolTip = L("<p>Analyser aussi les sous-dossiers. Les dossiers de quarantaine (noms finissant par "
      + QUARANTINE_SUFFIX + ") sont ignorés.</p>",
      "<p>Scan the sub-folders too. Quarantine folders (names ending with " + QUARANTINE_SUFFIX + ") are skipped.</p>");
   this.recursiveCheck.checked = readSetting("recursive", DataType.Boolean, true);
   this.lightsOnlyCheck = new CheckBox(this);
   this.lightsOnlyCheck.text = L("Lumières seulement", "Lights only");
   this.lightsOnlyCheck.checked = readSetting("lightsOnly", DataType.Boolean, true);
   this.lightsOnlyCheck.toolTip = L("<p>Ignorer les brutes dont l'en-tête (IMAGETYP, FRAME ou FRAMETYP) indique flat, "
      + "dark ou bias : on peut analyser tel quel le dossier d'une nuit entière. Les brutes sans ce mot-clé sont analysées.</p>",
      "<p>Skip the frames whose header (IMAGETYP, FRAME or FRAMETYP) says flat, dark "
      + "or bias, so a whole night's folder can be scanned. Frames without the keyword are scanned.</p>");

   var folderSizer = new HorizontalSizer;
   folderSizer.spacing = 4;
   folderSizer.add(this.folderLabel);
   folderSizer.add(this.folderEdit, 100);
   folderSizer.add(this.folderButton);
   folderSizer.addSpacing(8);
   folderSizer.add(this.recursiveCheck);
   folderSizer.addSpacing(8);
   folderSizer.add(this.lightsOnlyCheck);

   // ---- red level + scan
   this.alertControl = new NumericControl(this);
   this.alertControl.label.text = L("Rouge dès :", "Red above:");
   this.alertControl.setRange(4, 300);
   this.alertControl.slider.setRange(0, 592);
   this.alertControl.setPrecision(1);
   this.alertControl.setValue(this.alert);
   this.alertControl.toolTip = L("<p>Les brutes dont la meilleure traînée atteint ce score sont affichées en rouge : "
      + "des traînées aussi fortes ne sont jamais une fausse alerte, on peut donc les mettre en quarantaine d'un coup "
      + "avec <b>Quarantaine rouges</b>.</p><p>Les brutes sont listées à partir d'un score de " + format("%.0f", LIST_THRESHOLD)
      + " ; celles entre ce niveau et cette valeur méritent un coup d'œil à l'aperçu. Changer la valeur recolore la "
      + "liste sans relancer l'analyse.</p><p>Ce réglage ne concerne que la liste de cette fenêtre : le masquage dans "
      + "WBPP ne l'utilise pas.</p>",
      "<p>Frames whose best trail scores at or above this value are shown in red: "
      + "trails that strong are never a false alarm, so they can be quarantined in one go with "
      + "<b>Quarantine red</b>.</p><p>Frames are listed from a score of " + format("%.0f", LIST_THRESHOLD)
      + " up; those between that level and this value deserve a look at the preview. "
      + "Changing the value re-colours the list without re-scanning.</p><p>This setting is only for the list of "
      + "this window: the masking in WBPP does not use it.</p>");
   this.alertControl.onValueUpdated = function (v) { self.alert = v; self.rebuildList(); };

   this.scanButton = new PushButton(this);
   this.scanButton.text = L("Analyser", "Scan");
   this.scanButton.onClick = function () { self.scan(); };
   this.stopButton = new PushButton(this);
   this.stopButton.text = L("Arrêter", "Stop");
   this.stopButton.enabled = false;
   this.stopButton.onClick = function () {
      self.stopRequested = true;
      self.stopButton.enabled = false;
      self.progressLabel.text = L("Arrêt en cours...", "Stopping...");
   };

   // ---- interface language: the window reopens in the chosen language, results kept
   this.langLabel = new Label(this);
   this.langLabel.text = "Langue / Language :";
   this.langLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
   this.langCombo = new ComboBox(this);
   this.langCombo.addItem("English");
   this.langCombo.addItem("Français");
   this.langCombo.currentItem = LANG == "fr" ? 1 : 0;
   this.langCombo.toolTip = L("<p>Langue de l'interface. La fenêtre se rouvre dans la langue choisie, avec les "
      + "résultats de l'analyse.</p>", "<p>Interface language. The window reopens in the chosen language, with the "
      + "results of the scan.</p>");
   this.langCombo.onItemSelected = function (idx) {
      var nl = idx == 1 ? "fr" : "en";
      if (nl == LANG) return;
      if (self.scanning) { self.langCombo.currentItem = LANG == "fr" ? 1 : 0; return; }
      writeSetting("language", DataType.String, nl);
      LANG = nl;
      self.saveSettings();
      self.storeState();
      self.relaunch = true;
      self.ok();
   };

   var scanSizer = new HorizontalSizer;
   scanSizer.spacing = 6;
   scanSizer.add(this.alertControl, 100);
   scanSizer.addSpacing(8);
   scanSizer.add(this.scanButton);
   scanSizer.add(this.stopButton);
   scanSizer.addSpacing(12);
   scanSizer.add(this.langLabel);
   scanSizer.add(this.langCombo);

   // ---- scanner: frames analysed in parallel on threads (PixInsight 1.9.5)
   this.threadsLabel = new Label(this);
   this.threadsLabel.text = L("Threads :", "Threads:");
   this.threadsLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
   this.threadsSpin = new SpinBox(this);
   this.threadsSpin.setRange(0, 256);
   this.threadsSpin.minimumValueText = "Auto";
   this.threadsSpin.value = this.threads;
   this.threadsSpin.toolTip = L("<p>Brutes analysées en même temps, une par thread. <b>Auto</b> (par défaut) : autant "
      + "que de processeurs permis dans les préférences de PixInsight, moins si la mémoire disponible manque (chaque "
      + "thread garde une brute en mémoire). <b>1</b> : une brute à la fois. Les scores sont les mêmes dans tous les "
      + "cas.</p><p>Demande PixInsight 1.9.5 ; avant, l'analyse se fait une brute à la fois. Le masquage dans WBPP "
      + "utilise aussi ce réglage.</p>",
      "<p>Frames analysed at the same time, one per thread. <b>Auto</b> (default): as many as "
      + "the processors allowed in the PixInsight preferences, fewer when the available memory is short (each "
      + "thread holds one frame). <b>1</b>: one frame at a time. The scores are the same either way.</p>"
      + "<p>Needs PixInsight 1.9.5; with earlier versions the scan runs one frame at a time. The masking in WBPP "
      + "uses this setting too.</p>");
   this.threadsSpin.onValueUpdated = function (v) { self.threads = v; self.updateScannerUi(); };
   this.scannerStatus = new Label(this);
   this.scannerStatus.text = " ";
   this.scannerStatus.wordWrapping = true;
   this.scannerStatus.useRichText = true;

   var threadsRow = new HorizontalSizer;
   threadsRow.spacing = 6;
   threadsRow.add(this.threadsLabel);
   threadsRow.add(this.threadsSpin);
   threadsRow.addSpacing(8);
   threadsRow.add(this.scannerStatus, 100);
   this.scannerBox = new GroupBox(this);
   this.scannerBox.title = L("Analyse", "Scanner");
   this.scannerBox.sizer = new VerticalSizer;
   this.scannerBox.sizer.margin = 6;
   this.scannerBox.sizer.add(threadsRow);

   this.progressLabel = new Label(this);
   this.progressLabel.text = L("Choisir un dossier puis cliquer sur Analyser.", "Select a folder and press Scan.");
   this.progressLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   this.progressLabel.wordWrapping = true;

   // ---- results list
   this.tree = new TreeBox(this);
   this.tree.numberOfColumns = 6;
   this.tree.setHeaderText(0, "Score");
   this.tree.setHeaderText(1, L("Lignes", "Lines"));
   this.tree.setHeaderText(2, "Angle");
   this.tree.setHeaderText(3, L("Longueur", "Length"));
   this.tree.setHeaderText(4, L("État", "Status"));
   this.tree.setHeaderText(5, L("Fichier", "File"));
   this.tree.rootDecoration = false;
   this.tree.alternateRowColor = true;
   this.tree.multipleSelection = false;
   this.tree.setMinSize(this.logicalPixelsToPhysical(420), this.logicalPixelsToPhysical(200));
   this.tree.toolTip = L("<p>Brutes dont la meilleure traînée a un score de " + format("%.0f", LIST_THRESHOLD)
      + " ou plus, la plus forte en premier ; en rouge à partir du niveau <i>Rouge dès</i>. Cliquer sur une brute pour "
      + "voir la traînée détectée sur l'aperçu.</p>",
      "<p>Frames whose best trail scores " + format("%.0f", LIST_THRESHOLD) + " or more, strongest first; "
      + "in red from the <i>Red above</i> level. Click a frame to see the detected trail on the preview.</p>");
   this.tree.onCurrentNodeUpdated = function (node) { self.showPreview(node ? node.resultIndex : -1); };
   this.tree.onNodeDoubleClicked = function (node) { self.openInPixInsight(node.resultIndex); };

   // ---- actions
   this.quarantineButton = new PushButton(this);
   this.quarantineButton.text = L("Quarantaine", "Quarantine");
   this.quarantineButton.toolTip = L("<p>Sortir la brute choisie du dossier analysé, vers un dossier <b>&lt;dossier&gt;"
      + QUARANTINE_SUFFIX + "</b> créé à côté (mêmes sous-dossiers à l'intérieur), pour qu'un logiciel d'empilement "
      + "qui importe le dossier analysé ne la voie plus. Réversible : la remettre à la main si besoin.</p>",
      "<p>Move the selected frame out of the scanned folder, into a <b>&lt;folder&gt;"
      + QUARANTINE_SUFFIX + "</b> folder created next to it (same sub-folders inside), so that a stacking program "
      + "importing the scanned folder never sees it again. Reversible: move it back by hand if needed.</p>");
   this.quarantineButton.onClick = function () { self.actOnCurrent("quarantine"); };
   this.quarantineAllButton = new PushButton(this);
   this.quarantineAllButton.text = L("Quarantaine de toute la liste", "Quarantine all listed");
   this.quarantineAllButton.toolTip = L("<p>Mettre en quarantaine toutes les brutes de la liste (score "
      + format("%.0f", LIST_THRESHOLD) + " ou plus), dans le dossier de quarantaine à côté du dossier analysé.</p>",
      "<p>Move every listed frame (score " + format("%.0f", LIST_THRESHOLD)
      + " or more) to the quarantine folder next to the scanned folder.</p>");
   this.quarantineAllButton.onClick = function () { self.quarantineAll(false); };
   this.quarantineRedButton = new PushButton(this);
   this.quarantineRedButton.text = L("Quarantaine rouges", "Quarantine red");
   this.quarantineRedButton.toolTip = L("<p>Mettre en quarantaine toutes les brutes en rouge (score au moins égal à la "
      + "valeur <i>Rouge dès</i>), dans le dossier de quarantaine à côté du dossier analysé.</p>",
      "<p>Move every frame shown in red (score at or above the <i>Red above</i> value) "
      + "to the quarantine folder next to the scanned folder.</p>");
   this.quarantineRedButton.onClick = function () { self.quarantineAll(true); };
   this.eraseButton = new PushButton(this);
   this.eraseButton.text = L("Effacer", "Erase");
   this.eraseButton.icon = this.scaledResource(":/icons/delete.png");
   this.eraseButton.toolTip = L("<p><b>Supprimer définitivement</b> la brute choisie. Une confirmation est demandée à "
      + "chaque fois.</p>", "<p><b>Permanently delete</b> the selected frame. A confirmation is asked every time.</p>");
   this.eraseButton.onClick = function () { self.actOnCurrent("erase"); };
   this.openButton = new PushButton(this);
   this.openButton.text = L("Ouvrir", "Open");
   this.openButton.toolTip = L("<p>Ouvrir la brute choisie dans PixInsight en pleine résolution (un double-clic fait "
      + "de même).</p>", "<p>Open the selected frame in PixInsight at full resolution (double-click does the same).</p>");
   this.openButton.onClick = function () { var n = self.tree.currentNode; if (n) self.openInPixInsight(n.resultIndex); };
   this.csvButton = new PushButton(this);
   this.csvButton.text = L("Exporter CSV", "Export CSV");
   this.csvButton.toolTip = L("<p>Écrire un rapport CSV avec le score de chaque brute analysée (en anglais).</p>",
                              "<p>Write a CSV report with the score of every scanned frame.</p>");
   this.csvButton.onClick = function () { self.exportCSV(); };
   this.closeButton = new PushButton(this);
   this.closeButton.text = L("Fermer", "Close");
   this.closeButton.onClick = function () { self.saveSettings(); self.ok(); };
   this.resetButton = new ToolButton(this);
   this.resetButton.icon = this.scaledResource(":/process-interface/reset.png");
   this.resetButton.setScaledFixedSize(24, 24);
   this.resetButton.toolTip = L("<p>Réinitialiser : remettre chaque réglage à sa valeur par défaut et oublier ceux "
      + "mémorisés (niveau rouge, options, threads, dernier dossier). Les résultats de l'analyse en cours sont gardés, "
      + "la langue aussi.</p>", "<p>Reset: put every setting back to its default and forget the remembered ones "
      + "(red level, options, threads, last folder). The results of the current scan are kept, and the language.</p>");
   this.resetButton.onClick = function () { self.resetSettings(); };

   var actionSizer = new HorizontalSizer;
   actionSizer.spacing = 6;
   actionSizer.add(this.resetButton);
   actionSizer.addSpacing(4);
   actionSizer.add(this.quarantineButton);
   actionSizer.add(this.quarantineAllButton);
   actionSizer.add(this.quarantineRedButton);
   actionSizer.add(this.eraseButton);
   actionSizer.add(this.openButton);
   actionSizer.addStretch();
   actionSizer.add(this.csvButton);
   actionSizer.add(this.closeButton);

   // ---- preview
   this.preview = new Control(this);
   this.preview.setMinSize(this.logicalPixelsToPhysical(480), this.logicalPixelsToPhysical(320));
   this.preview.toolTip = L("<p>Vue réduite, fond soustrait et étirée de la brute choisie. Les traînées détectées "
      + "sont tracées en rouge sur leur étendue détectée.</p>", "<p>Binned, background-subtracted and stretched view of "
      + "the selected frame. The detected trails are drawn in red over their detected extent.</p>");
   this.preview.onPaint = function () {
      var g = new Graphics(this);
      g.fillRect(this.boundsRect, new Brush(0xFF1E1E1E));
      if (self.bitmap) {
         var bw = self.bitmap.width, bh = self.bitmap.height;
         var sc = Math.min(this.width / bw, this.height / bh);
         var dw = Math.floor(bw * sc), dh = Math.floor(bh * sc);
         var x0 = Math.floor((this.width - dw) / 2), y0 = Math.floor((this.height - dh) / 2);
         g.drawScaledBitmap(new Rect(x0, y0, x0 + dw, y0 + dh), self.bitmap);
      } else {
         g.pen = new Pen(0xFF9A9A9A);
         g.drawTextRect(this.boundsRect, L("Choisir une brute dans la liste pour voir la traînée détectée",
                                           "Select a frame in the list to see the detected trail"),
                        TextAlignment.Center | TextAlignment.VertCenter);
      }
      g.end();
   };
   this.previewInfo = new Label(this);
   this.previewInfo.text = L("Aucune analyse pour l'instant.", "No scan yet.");
   this.previewInfo.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   this.previewInfo.useRichText = true;
   this.previewInfo.wordWrapping = true;

   // ---- masking option: WBPP keeps the frames, only the trails are left out
   var wbppTip = L("<p><b>Le masquage est une nette amélioration sur la quarantaine.</b> Une brute en quarantaine est "
      + "perdue en entier, et le rapport signal sur bruit du master baisse d'autant. Avec le masquage, la brute est "
      + "gardée et seuls les pixels de ses traînées sont écartés de l'intégration (en général 0,1 à 2 % de la brute) : "
      + "le rapport signal sur bruit est presque intact. Sur un jeu de test, la quarantaine augmentait le bruit des "
      + "masters de 2 à 8 %, le masquage de rien de mesurable, et la trace des traînées disparaissait du master.</p>"
      + "<p><b>Pour l'instant, uniquement avec une intégration WBPP.</b> Dans WBPP, onglet <i>Pipeline</i>, cocher "
      + "<i>Event Script</i> et choisir le fichier affiché ici, puis lancer WBPP avec toutes les brutes, sans "
      + "quarantaine.</p>"
      + "<p>Juste après l'alignement, chaque brute de lumière alignée est analysée dans toutes les directions ; chaque "
      + "traînée trouvée (chaque satellite d'un train Starlink à part) est masquée avec ses ailes, les pixels masqués "
      + "passent à 0 dans la brute alignée et l'intégration de WBPP les rejette. Les brutes d'origine ne sont jamais "
      + "touchées ; seules les brutes alignées du dossier de sortie de WBPP sont modifiées.</p>"
      + "<p><b>Espace disque :</b> en plus des fichiers de WBPP, un masque compressé par brute masquée (environ "
      + "0,1 Mo pour 61 Mpx) et une carte de couverture par groupe (environ 1 Mo), dans "
      + "<i>&lt;sortie WBPP&gt;/StarlinkSweeper/</i>, avec le journal et les rapports CSV.</p>"
      + "<p><b>Un seul script d'événement par passage de WBPP :</b> celui-ci ou celui de ClarkeMask, pas les deux.</p>",
      "<p><b>Masking is a clear improvement over quarantine.</b> A quarantined frame is lost entirely, and the "
      + "signal-to-noise ratio of the master drops accordingly. With masking, the frame is kept and only the pixels "
      + "of its trails are left out of the integration (usually 0.1 to 2 % of the frame): the signal-to-noise ratio "
      + "is almost untouched. On a test set, quarantine raised the noise of the masters by 2 to 8 %, masking by "
      + "nothing measurable, and the trace of the trails was gone from the master.</p>"
      + "<p><b>For now, only with a WBPP integration.</b> In WBPP, <i>Pipeline</i> tab, tick <i>Event Script</i> "
      + "and select the file shown here, then run WBPP with all your frames, nothing quarantined.</p>"
      + "<p>Right after registration, every registered light frame is scanned in every direction; each trail found "
      + "(each member of a Starlink train separately) is masked with its wings, the masked pixels are set to 0 in "
      + "the registered frame and WBPP's integration rejects them. The source frames are never touched; only the "
      + "registered frames of the WBPP output folder are modified.</p>"
      + "<p><b>Disk space:</b> besides WBPP's own files, one compressed mask file per masked frame (about 0.1 MB "
      + "for 61 Mpx) and one coverage map per group (about 1 MB), in <i>&lt;WBPP output&gt;/StarlinkSweeper/</i>, "
      + "with the log and CSV reports.</p>"
      + "<p><b>One event script per WBPP run:</b> this one or ClarkeMask's, not both.</p>");
   this.wbppLabel = new Label(this);
   this.wbppLabel.useRichText = true;
   this.wbppLabel.wordWrapping = true;
   this.wbppLabel.text = L("<b>Mieux que la quarantaine :</b> les brutes traversées par une traînée sont gardées et "
      + "seule la traînée est masquée, donc le rapport signal sur bruit du master est presque intact (une brute en "
      + "quarantaine est perdue en entier). <b>Pour l'instant uniquement avec une intégration WBPP</b> : dans WBPP, "
      + "<i>Pipeline &gt; Event Script</i>, choisir ce fichier, puis lancer WBPP avec toutes les brutes. Peu d'espace "
      + "disque (environ 0,1 Mo par brute masquée). Pas en même temps que le script d'événement de ClarkeMask.",
      "<b>Better than quarantine:</b> the frames crossed by a trail are kept and only the trail is masked, so the "
      + "signal-to-noise ratio of the master is almost untouched (a quarantined frame is lost entirely). <b>For now "
      + "only with a WBPP integration</b>: in WBPP, <i>Pipeline &gt; Event Script</i>, select this file, then run "
      + "WBPP with all your frames. Little disk space (about 0.1 MB per masked frame). Not together with "
      + "ClarkeMask's event script.");
   this.wbppLabel.toolTip = wbppTip;
   this.wbppEdit = new Edit(this);
   this.wbppEdit.readOnly = true;
   this.wbppEdit.text = EVENT_SCRIPT;
   this.wbppEdit.toolTip = wbppTip;
   this.wbppBox = new GroupBox(this);
   this.wbppBox.title = L("Masquage dans WBPP (recommandé)", "Masking in WBPP (recommended)");
   this.wbppBox.sizer = new VerticalSizer;
   this.wbppBox.sizer.margin = 6;
   this.wbppBox.sizer.spacing = 4;
   this.wbppBox.sizer.add(this.wbppLabel);
   this.wbppBox.sizer.add(this.wbppEdit);

   // ---- layout
   var leftSizer = new VerticalSizer;
   leftSizer.spacing = 6;
   leftSizer.add(folderSizer);
   leftSizer.add(scanSizer);
   leftSizer.add(this.scannerBox);
   leftSizer.add(this.progressLabel);
   leftSizer.add(this.tree, 100);
   leftSizer.add(actionSizer);

   var rightSizer = new VerticalSizer;
   rightSizer.spacing = 6;
   rightSizer.add(this.preview, 100);
   rightSizer.add(this.previewInfo);
   rightSizer.add(this.wbppBox);

   this.sizer = new HorizontalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 10;
   this.sizer.add(leftSizer, 45);
   this.sizer.add(rightSizer, 55);
   this.adjustToContents();
   this.updateScannerUi();
   this.restoreState();
}
updateScannerUi() {
   if (typeof Thread == "undefined") {
      this.threadsSpin.enabled = false;
      this.scannerStatus.text = L("PixInsight avant 1.9.5 : une brute à la fois.", "PixInsight before 1.9.5: one frame at a time.");
      return;
   }
   this.scannerStatus.text = this.threads == 1 ? L("Une brute à la fois.", "One frame at a time.")
      : this.threads > 1 ? format(L("Jusqu'à %d brutes à la fois.", "Up to %d frames at a time."), this.threads)
      : format(L("Jusqu'à %d brutes à la fois (processeurs permis), moins si la mémoire manque.",
                 "Up to %d frames at a time (processors allowed), fewer when memory is short."), Thread.numberOfProcessors);
}

// ---- state kept when the window reopens in another language
storeState() {
   var cur = this.tree.currentNode;
   SweeperDialog.state = { results: this.results, progress: this.progressText || "",
                           current: cur ? cur.resultIndex : -1 };
}

restoreState() {
   var s = SweeperDialog.state;
   SweeperDialog.state = null;
   if (!s) return;
   this.results = s.results;
   this.progressText = s.progress;
   if (s.progress) this.progressLabel.text = s.progress;
   this.rebuildList();
   for (var n = 0; n < this.tree.numberOfChildren; ++n)
      if (this.tree.child(n).resultIndex == s.current) { this.tree.currentNode = this.tree.child(n); break; }
   var cur = this.tree.currentNode;
   this.showPreview(cur ? cur.resultIndex : -1);
}

scan() {
   var self = this;
   if (this.scanning) return;
   if (!this.folder.length || !File.directoryExists(this.folder)) {
      new MessageBox(L("Choisir d'abord le dossier des brutes de lumière.", "Please select the folder of your light frames first."),
                     TITLE, StdIcon.Warning, StdButton.Ok).execute();
      return;
   }
   writeSetting("folder", DataType.String, this.folder);
   var files = listFrames(this.folder, this.recursiveCheck.checked);
   if (files.length == 0) {
      new MessageBox(L("Aucun fichier FITS / XISF dans\n", "No FITS / XISF file found in\n") + this.folder, TITLE,
                     StdIcon.Warning, StdButton.Ok).execute();
      return;
   }
   this.results = [];
   this.tree.clear();
   this.scanning = true; this.stopRequested = false;
   this.setBitmap(null, -1);
   this.previewInfo.text = this.summaryText();
   this.scanButton.enabled = false; this.stopButton.enabled = true;
   console.show();
   console.abortEnabled = true;
   var threads = scanThreads(files, this.threads);
   console.writeln("<end><cbr><b>" + TITLE + " " + VERSION + "</b>: " + files.length + " frames in " + this.folder
                   + (threads > 1 ? ", " + threads + " at a time" : ""));
   var t0 = Date.now(), flagged = 0, skipped = 0, scanned = 0, done = 0, lightsOnly = this.lightsOnlyCheck.checked;
   this.progressLabel.text = format(L("Analyse de %d brutes...", "Scanning %d frames..."), files.length);
   var stopped = scanFiles(files, lightsOnly, threads, function (k, res) {
      ++done;
      var name = File.extractNameAndExtension(files[k]);
      if (res.error) {
         console.criticalln(format("[%d/%d] %s: %s", done, files.length, files[k], res.error));
         self.results.push({ file: files[k], score: -1, lines: [], error: res.error, status: "error", preview: null });
      } else if (res.skipped) {
         ++skipped;
         self.results.push(res);
         console.writeln(format("[%d/%d] %s  skipped (%s)", done, files.length, name, res.skipped.toUpperCase()));
      } else {
         res.status = "";
         self.results.push(res);
         ++scanned;
         var tag = res.score >= self.threshold ? format("TRAIL x%d", self.shownLines(res).length) : "ok";
         if (res.score >= self.threshold) ++flagged;
         console.writeln(format("[%d/%d] %s  score %.1f  %.1fs  %s", done, files.length, name, res.score, res.seconds, tag));
      }
      self.progressLabel.text = format(L("Analyse %d / %d  (%d listées, %d ignorées)  %s", "Scanning %d / %d  (%d listed, %d skipped)  %s"),
                                       done, files.length, flagged, skipped, shortName(files[k], 48));
      self.rebuildList();
      CoreApplication.processEvents();
   }, function () { return self.stopRequested || console.abortRequested; });
   if (stopped) console.warningln("Scan stopped by user after " + this.results.length + " of " + files.length + " frames");
   // results arrive in any order with threads: back to the order of the files
   var current = this.tree.currentNode ? this.results[this.tree.currentNode.resultIndex].file : null;
   this.results.sort(function (a, b) { return a.file < b.file ? -1 : (a.file > b.file ? 1 : 0); });
   this.tree.clear();
   this.rebuildList();
   for (var n = 0; current && n < this.tree.numberOfChildren; ++n)
      if (this.results[this.tree.child(n).resultIndex].file == current) { this.tree.currentNode = this.tree.child(n); break; }
   this.scanning = false;
   this.scanButton.enabled = true; this.stopButton.enabled = false;
   var cur = this.tree.currentNode;
   this.showPreview(cur ? cur.resultIndex : -1);
   var seconds = (Date.now() - t0) / 1000;
   this.progressText = format(L("%s%d brutes analysées en %.0f s, %d listées (score %.0f ou plus), %d ignorées (pas des lumières).",
                                "%s%d frames scanned in %.0f s, %d listed (score %.0f or more), %d skipped as non-light."),
                              stopped ? L("Arrêté. ", "Stopped. ") : "", scanned, seconds, flagged, this.threshold, skipped);
   this.progressLabel.text = this.progressText;
   console.writeln(format("%s%d frames scanned in %.0f s, %d listed (score %.0f or more), %d skipped as non-light.",
                          stopped ? "Stopped. " : "", scanned, seconds, flagged, this.threshold, skipped));
}

saveSettings() {
   writeSetting("alert", DataType.Double, this.alert);
   writeSetting("recursive", DataType.Boolean, this.recursiveCheck.checked);
   writeSetting("lightsOnly", DataType.Boolean, this.lightsOnlyCheck.checked);
   writeSetting("threads", DataType.Int32, this.threads);
   if (this.folder.length) writeSetting("folder", DataType.String, this.folder);
}

resetSettings() {
   removeSettings();
   this.alert = DEFAULT_ALERT;
   this.alertControl.setValue(this.alert);
   this.recursiveCheck.checked = true;
   this.lightsOnlyCheck.checked = true;
   this.threads = 0;
   this.threadsSpin.value = 0;
   this.updateScannerUi();
   this.rebuildList();
   console.writeln(TITLE + ": settings reset to defaults.");
}

rebuildList() {
   var current = this.tree.currentNode ? this.tree.currentNode.resultIndex : -1;
   this.tree.clear();
   var order = [];
   for (var i = 0; i < this.results.length; ++i) {
      var r0 = this.results[i];
      if (r0.status == "skipped") continue;
      if (r0.score >= this.threshold || r0.status == "error") order.push(i);
   }
   var self = this;
   order.sort(function (a, b) { return self.results[b].score - self.results[a].score; });
   var again = null;
   for (var k = 0; k < order.length; ++k) {
      var r = this.results[order[k]], node = new TreeBoxNode(this.tree);
      node.resultIndex = order[k];
      if (r.status == "error") {
         node.setText(0, statusText("error")); node.setText(4, statusText("error")); node.setText(5, File.extractNameAndExtension(r.file));
         node.setToolTip(5, r.error);
         continue;
      }
      var shown = this.shownLines(r), best = shown.length ? shown[0] : null;
      node.setText(0, num(r.score, 1));
      node.setText(1, String(shown.length));
      node.setText(2, best ? num(best.angle, 1) + "°" : "");
      node.setText(3, best ? format("%d%%", Math.round(100 * best.run / N_SEG)) : "");
      node.setText(4, statusText(r.status));
      node.setText(5, File.extractNameAndExtension(r.file));
      node.setToolTip(5, r.file);
      for (var c = 0; c < 4; ++c) node.setAlignment(c, TextAlignment.Right);
      if (r.score >= this.alert) {
         for (var c3 = 0; c3 < 6; ++c3) {
            try { node.setTextColor(c3, 0xFFD02020); } catch (e) { }
         }
         if (!r.status.length) node.setToolTip(0, L("Score " + num(r.score, 1) + " : au moins le niveau rouge " + num(this.alert, 1),
                                                    "Score " + num(r.score, 1) + ": at or above the red level " + num(this.alert, 1)));
      }
      if (order[k] == current) again = node;
   }
   for (var c2 = 0; c2 < 6; ++c2) this.tree.adjustColumnWidthToContents(c2);
   if (again) { this.tree.currentNode = again; this.showPreview(again.resultIndex); }
   else this.showPreview(-1);
}

buildBitmap(r) {
   var w = r.pw, h = r.ph, bmp = new Bitmap(w, h), p = r.preview;
   for (var y = 0; y < h; ++y)
      for (var x = 0; x < w; ++x) {
         var v = p[y * w + x];
         bmp.setPixel(x, y, 0xFF000000 | (v << 16) | (v << 8) | v);
      }
   var g = new Graphics(bmp);
   g.antialiasing = true;
   g.pen = new Pen(0xFFFF4040, 2);
   var shown = this.shownLines(r);
   for (var i = 0; i < shown.length; ++i) {
      var ln = shown[i];
      g.drawLine(ln.x0 / FINE_BIN, ln.y0 / FINE_BIN, ln.x1 / FINE_BIN, ln.y1 / FINE_BIN);
   }
   g.end();
   return bmp;
}

setBitmap(bmp, index) {
   this.bitmap = bmp; this.bitmapIndex = index; this.bitmapThreshold = this.threshold;
   this.preview.update();
}

shownLines(r) {
   // Lines are kept down to the internal floor; only those at or above the
   // listing level are shown.
   var out = [];
   for (var i = 0; i < r.lines.length; ++i) if (r.lines[i].score >= this.threshold) out.push(r.lines[i]);
   return out;
}

summaryText() {
   // What the info line shows when no frame is selected: live counts.
   var scanned = 0, above = 0, red = 0, skipped = 0, errors = 0, done = 0;
   for (var i = 0; i < this.results.length; ++i) {
      var r = this.results[i];
      if (r.status == "skipped") { ++skipped; continue; }
      if (r.status == "error") { ++errors; continue; }
      ++scanned;
      if (r.score >= this.threshold) ++above;
      if (r.score >= this.alert) ++red;
      if (r.status == "quarantined" || r.status == "erased") ++done;
   }
   if (!this.results.length) return this.scanning ? L("Analyse en cours...", "Scanning...") : L("Aucune analyse pour l'instant.", "No scan yet.");
   var s1 = scanned > 1 ? "s" : "", s2 = above > 1 ? "s" : "";
   var t = LANG == "fr"
      ? format("%d brute%s analysée%s, <b>%d listée%s</b> (score %.0f ou plus)", scanned, s1, s1, above, s2, this.threshold)
      : format("%d frame%s scanned, <b>%d listed</b> (score %.0f or more)", scanned, s1, above, this.threshold);
   if (red) t += L(", <font color=\"#d02020\"><b>" + red + " à " + num(this.alert, 1) + " ou plus</b></font>",
                   ", <font color=\"#d02020\"><b>" + red + " at or above " + num(this.alert, 1) + "</b></font>");
   if (skipped) t += L(", " + skipped + " ignorée(s) (pas des lumières)", ", " + skipped + " skipped as non-light");
   if (errors) t += L(", " + errors + " en erreur", ", " + errors + " in error");
   if (done) t += L(", " + done + " en quarantaine ou effacée(s)", ", " + done + " quarantined or erased");
   t += this.scanning ? L(" (analyse en cours)", " (scan in progress)")
                      : L(". Choisir une brute pour voir ses traînées.", ". Select a frame to see its trails.");
   return t;
}

showPreview(index) {
   if (index < 0 || index >= this.results.length || !this.results[index].preview) {
      this.setBitmap(null, -1); this.previewInfo.text = this.summaryText(); return;
   }
   var r = this.results[index];
   if (this.bitmapIndex != index || this.bitmapThreshold != this.threshold) this.setBitmap(this.buildBitmap(r), index);
   var info = "<b>" + File.extractNameAndExtension(r.file) + "</b> &nbsp; score " + num(r.score, 1)
      + (r.score >= this.alert ? " <font color=\"#d02020\"><b>" + L("(au moins le niveau rouge " + num(this.alert, 1) + ")",
                                                                    "(at or above the red level " + num(this.alert, 1) + ")")
                                 + "</b></font>" : "")
      + " &nbsp; " + r.width + "x" + r.height;
   var shown = this.shownLines(r);
   for (var i = 0; i < shown.length; ++i) {
      var ln = shown[i];
      info += "<br>" + format(L("ligne %d : score %s, angle %s°, %d%% du champ, de (%d, %d) à (%d, %d)",
                                "line %d: score %s, angle %s°, %d%% of the frame, from (%d, %d) to (%d, %d)"),
                              i + 1, num(ln.score, 1), num(ln.angle, 2), Math.round(100 * ln.run / N_SEG), ln.x0, ln.y0, ln.x1, ln.y1);
   }
   if (r.status.length) info += "<br><i>" + statusText(r.status) + "</i>";
   this.previewInfo.text = info;
}

actOnCurrent(action) {
   var node = this.tree.currentNode;
   if (!node) return;
   var r = this.results[node.resultIndex];
   if (r.status == "quarantined" || r.status == "erased") {
      new MessageBox(L("Cette brute est déjà " + statusText(r.status) + ".", "This frame has already been " + r.status + "."),
                     TITLE, StdIcon.Information, StdButton.Ok).execute();
      return;
   }
   if (!File.exists(r.file)) {
      new MessageBox(L("Fichier introuvable :\n", "File not found:\n") + r.file, TITLE, StdIcon.Error, StdButton.Ok).execute();
      return;
   }
   if (action == "erase") {
      var answer = new MessageBox(L("Supprimer définitivement cette brute ?\n\n" + r.file + "\n\nC'est irréversible.",
                                    "Permanently delete this frame?\n\n" + r.file + "\n\nThis cannot be undone."),
                                  TITLE, StdIcon.Warning, StdButton.Yes, StdButton.No).execute();
      if (answer != StdButton.Yes) return;
      File.remove(r.file);
      r.status = "erased";
      console.writeln("Erased " + r.file);
   } else {
      this.quarantine(r);
   }
   this.rebuildList();
   this.showPreview(node.resultIndex);
}

quarantine(r) {
   // Moves the frame to <quarantine root>/<its sub-path under the scanned folder>,
   // the quarantine root being next to the scanned folder (see quarantineRoot).
   var root = normalizedDir(this.folder), qroot = quarantineRoot(root);
   var file = normalizedDir(r.file);
   var rel = (file.indexOf(root + "/") == 0) ? file.substring(root.length) : "/" + File.extractNameAndExtension(file);
   var dst = qroot + rel;
   makeDirs(File.extractDirectory(dst));
   if (File.exists(dst)) throw new Error("Already exists: " + dst);
   moveFile(r.file, dst);
   r.status = "quarantined";
   r.movedTo = dst;
   console.writeln("Moved " + r.file + " -> " + dst);
}

quarantineAll(redOnly) {
   var todo = [], level = redOnly ? Math.max(this.alert, this.threshold) : this.threshold;
   for (var i = 0; i < this.results.length; ++i) {
      var r = this.results[i];
      if (r.status == "" && r.score >= level && File.exists(r.file)) todo.push(r);
   }
   if (!todo.length) return;
   var answer = new MessageBox(L(format("Déplacer %d brute(s)%s vers\n%s ?", todo.length, redOnly ? " rouge(s)" : "",
                                        quarantineRoot(this.folder)),
                                 format("Move %d %sframe(s) to\n%s ?", todo.length, redOnly ? "red " : "", quarantineRoot(this.folder))),
                               TITLE, StdIcon.Question, StdButton.Yes, StdButton.No).execute();
   if (answer != StdButton.Yes) return;
   for (var k = 0; k < todo.length; ++k) {
      try { this.quarantine(todo[k]); }
      catch (e) { console.criticalln(e.message); }
   }
   this.rebuildList();
}

openInPixInsight(index) {
   if (index < 0 || index >= this.results.length) return;
   var r = this.results[index], path = r.movedTo || r.file;
   if (!File.exists(path)) {
      new MessageBox(L("Fichier introuvable :\n", "File not found:\n") + path, TITLE, StdIcon.Error, StdButton.Ok).execute();
      return;
   }
   var windows = ImageWindow.open(path);
   if (windows.length) { windows[0].show(); windows[0].zoomToFit(); }
}

exportCSV() {
   if (!this.results.length) return;
   var sfd = new SaveFileDialog;
   sfd.caption = L("StarlinkSweeper : enregistrer le rapport CSV", "StarlinkSweeper: save CSV report");
   sfd.filters = [[L("Fichiers CSV", "CSV files"), "*.csv"]];
   sfd.initialPath = this.folder + "/StarlinkSweeper_report.csv";
   if (!sfd.execute()) return;
   var text = "file,flagged,red,score,coarse_peak,n_lines,status,lines(score@angle:x0,y0-x1,y1),error\n";
   for (var i = 0; i < this.results.length; ++i) {
      var r = this.results[i];
      if (r.status == "error") { text += csvEscape(r.file) + ",,,,,,error,," + csvEscape(r.error) + "\n"; continue; }
      if (r.status == "skipped") { text += csvEscape(r.file) + ",,,,,,skipped: " + r.skipped + ",,\n"; continue; }
      var desc = [], shown = this.shownLines(r);
      for (var k = 0; k < shown.length; ++k) {
         var ln = shown[k];
         desc.push(format("%.1f@%.2f:%d,%d-%d,%d", ln.score, ln.angle, ln.x0, ln.y0, ln.x1, ln.y1));
      }
      text += csvEscape(r.file) + "," + (r.score >= this.threshold ? 1 : 0) + "," + (r.score >= this.alert ? 1 : 0) + ","
            + format("%.1f", r.score) + ","
            + format("%.1f", r.coarse) + "," + shown.length + "," + r.status + "," + csvEscape(desc.join(" | ")) + ",\n";
   }
   var reportPath = sfd.filePath || sfd.fileName;
   File.writeTextFile(reportPath, text);
   console.writeln("Report written to " + reportPath);
}

}

SweeperDialog.state = null;   // results kept when the window reopens in another language

// --------------------------------------------------------------------- main
function main() {
   LANG = detectLanguage();
   console.hide();
   for (;;) {
      var dialog = new SweeperDialog();
      dialog.execute();
      if (!dialog.relaunch) break;
   }
}

if (typeof STARLINKSWEEPER_NO_MAIN === "undefined")
   main();
