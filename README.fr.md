# StarlinkSweeper

## MISE À JOUR 1.3.0 : masquage qui préserve le SNR

> **Tes brutes traversées par une traînée n'ont plus à partir à la poubelle.** Avec WBPP, un
> nouveau script d'événement garde les brutes traversées par une traînée de satellite et masque
> seulement les pixels de la traînée, ailes comprises. Le reste de la brute entre toujours dans
> l'intégration, donc le rapport signal sur bruit du master est presque intact, alors que la
> quarantaine perd la brute en entier. C'est une grosse amélioration par rapport à la quarantaine,
> accessible pour l'instant uniquement via une intégration WBPP : voir
> [Masquage dans WBPP](#masquage-dans-wbpp-garder-les-brutes).

**Un script PixInsight qui trouve les brutes traversées par des traînées de satellites, pour les
écarter de l'intégration.** Tu le pointes sur le dossier de tes brutes, tu lances le scan, tu
vérifies chaque brute suspecte sur un aperçu avec la traînée tracée en rouge, puis tu la mets en
quarantaine ou tu l'effaces. **Avec WBPP, tu peux aussi garder ces brutes** : un script d'événement
masque seulement les pixels de leurs traînées (voir *Masquage dans WBPP*).

*Balaie les traînées que la constellation d'un certain milliardaire laisse sur tes brutes.*

*English version: [README.md](README.md)*

![Train Starlink détecté sur une brute bande étroite](docs/example_starlink_train.png)

*Un train Starlink sur une vraie brute bande étroite. Binnée, fond soustrait, étirée ; les traînées
détectées sont tracées en rouge.*

## Pourquoi

Le rejet par sigma-clipping (Astro Pixel Processor, ImageIntegration de PixInsight, Siril...)
supprime le **cœur** d'une traînée de satellite, mais pas ses **ailes** : à quelques pixels du
centre, la traînée n'est que légèrement au-dessus du bruit de la brute, sous n'importe quel kappa
raisonnable. Quand il n'y a pas assez de brutes pour les noyer, ces ailes subsistent dans le master
sous la forme d'une bande rectiligne faible, invisible sur les données linéaires, flagrante dès
qu'on étire fort. Le score qualité du logiciel de prétraitement ne la voit pas non plus : une
traînée ne change ni le nombre d'étoiles, ni la FWHM, ni la rondeur, donc la brute est gardée.

Quand on n'a pas assez de brutes, la meilleure solution est de virer la brute contaminée de
l'intégration. StarlinkSweeper la trouve. Avec WBPP, on n'a même plus à sacrifier la brute :
l'option de masquage la garde et n'écarte que les pixels de la traînée, ailes comprises.

## Ce qu'il fait

1. **Scan.** Chaque brute (light) FITS / XISF du dossier choisi (sous-dossiers compris) est
   binnée, son fond soustrait, puis parcourue à la recherche de lignes droites dans toutes les
   directions. Les flats, darks et bias présents dans l'arborescence sont reconnus à leur en-tête
   et ignorés : le dossier d'une nuit entière se scanne tel quel. Compter quelques secondes par
   brute de 60 Mpx et par processeur : avec PixInsight 1.9.5, les brutes sont analysées en
   parallèle (voir *Scan parallèle*).
2. **Liste.** Les brutes dont la meilleure traînée atteint un score de 20 sont listées, la plus
   forte en premier, avec l'angle de la traînée et la fraction du champ qu'elle couvre ; à partir du
   niveau réglable *Red above*, elles passent en rouge. Un train Starlink apparaît comme plusieurs
   lignes parallèles au même angle.
3. **Vérification.** Un clic sur une brute l'affiche dans l'aperçu, les traînées détectées tracées
   en rouge sur leur étendue détectée ; un double-clic ouvre la brute en pleine résolution dans
   PixInsight.
4. **Action.** **Quarantine** sort la brute du dossier scanné, vers un dossier `<dossier>_trails`
   créé à côté de lui avec les mêmes sous-dossiers (scanner `.../Target/S1` les range sous
   `.../Target/S1_trails/...`), pour qu'un logiciel d'empilement qui importe le dossier scanné en
   récursif ne les revoie jamais ; réversible à la main. **Erase** supprime la brute
   définitivement, après une confirmation à chaque fois. **Quarantine red** déplace toutes les
   brutes affichées en rouge (score au niveau *Red above* ou au-dessus), **Quarantine all listed**
   toute la liste. **Export CSV** écrit le score de toutes les brutes scannées.

Le curseur *Red above* recolore la liste sans relancer le scan. Les brutes elles-mêmes ne sont
jamais modifiées ; les dossiers de quarantaine (noms finissant par `_trails`) ne sont jamais
scannés.

## Prérequis

| Fichier | PixInsight |
|---|---|
| `scripts/StarlinkSweeper.js` + `scripts/StarlinkSweeperCore.js` (boîte : scan, quarantaine) | 1.9.4 et suivants (1.9.5 pour le scan parallèle) |
| `scripts/StarlinkSweeper-WBPP.js` + `StarlinkSweeperCore.js`, `StarlinkSweeperMaskCore.js`, `StarlinkSweeperMaskEngine.js` (masquage dans WBPP) | 1.9.4 et suivants, WBPP avec scripts d'événement (testé avec WBPP 3.1.2 dans PixInsight 1.9.5 ; la détection parallèle demande 1.9.5) |

Entrée : brutes FITS ou XISF, mono ou CFA (lues brutes), calibrées ou non.

## Installation

### Depuis le dépôt de mises à jour PixInsight (recommandé)

1. *Resources > Updates > Manage Repositories*, ajouter
   `https://jps-34.github.io/StarlinkSweeper/`
2. *Resources > Updates > Check for Updates*, puis redémarrer PixInsight.
3. Le script apparaît dans *Script > JPS > StarlinkSweeper* (*Script > Utilities* jusqu'à la 1.2.1).

Tant que le dépôt n'est pas signé, PixInsight ne l'accepte qu'avec la préférence de sécurité
*Allow unsigned update repositories* activée.

### Manuelle

Télécharger **tous les fichiers de `scripts/`** dans le même dossier (la boîte inclut
`StarlinkSweeperCore.js`, le script d'événement de WBPP charge les trois autres), puis soit exécuter
`StarlinkSweeper.js` avec *Script > Execute Script
File*, soit ajouter son dossier avec *Script > Feature Scripts > Add* pour qu'il apparaisse dans le
menu *Script > JPS*.

## Prise en main

1. **Lights folder** : choisir le dossier racine des brutes (un filtre, une cible ou toute la
   nuit, peu importe). *Include sub-folders* est coché par défaut. La quarantaine sera créée à
   côté de ce dossier.
2. **Scan**. La progression s'affiche dans la boîte et dans la console ; **Stop** interrompt
   proprement.
3. Parcourir la liste : cliquer sur une brute, regarder l'aperçu, puis **Quarantine** ou
   **Erase**.
4. Relancer l'intégration sans les brutes en quarantaine.

À lancer avant l'intégration, sur les brutes calibrées ou non. Si un master montre déjà une bande
rectiligne faible après étirement, scanner les brutes qui l'ont produit : la brute contaminée
ressort loin au-dessus des autres.

## Langue

L'interface est en français ou en anglais : liste **Langue / Language**, à côté du bouton
*Analyser*. Le choix est mémorisé ; par défaut, la langue du système. La fenêtre se rouvre dans la
langue choisie et garde les résultats de l'analyse. La console et le rapport CSV restent en anglais.

Ce README cite les libellés de l'interface anglaise. En français : *Lights folder* = *Dossier des
brutes*, *Include sub-folders* = *Sous-dossiers compris*, *Lights only* = *Lumières seulement*, *Red
above* = *Rouge dès*, *Scan* = *Analyser*, *Stop* = *Arrêter*, *Scanner* = *Analyse*, *Quarantine* =
*Quarantaine*, *Quarantine all listed* = *Quarantaine de toute la liste*, *Quarantine red* =
*Quarantaine rouges*, *Erase* = *Effacer*, *Open* = *Ouvrir*, *Export CSV* = *Exporter CSV*, *Masking
in WBPP* = *Masquage dans WBPP*.

## Scan parallèle

Avec PixInsight 1.9.5 et suivants, les brutes sont analysées en parallèle dans PixInsight, une par
thread, et les résultats arrivent dans la liste au fil de l'eau ; les scores sont les mêmes qu'une
brute à la fois. **Threads**, dans le cadre *Scanner* : **Auto** (par défaut) utilise autant de
threads que de processeurs permis dans les préférences de PixInsight, moins si la mémoire disponible
manque (chaque thread garde une brute en mémoire) ; **1** analyse une brute à la fois. Avec
PixInsight 1.9.4, le scan se fait une brute à la fois. Rien à installer.

## Masquage dans WBPP (garder les brutes)

Au lieu d'écarter une brute, WBPP peut la garder et n'écarter que les pixels de ses traînées.
**C'est la méthode recommandée quand on empile avec WBPP** : une brute en quarantaine est perdue en
entier et le rapport signal sur bruit du master baisse d'autant, alors qu'une brute masquée garde tout
sauf ses traînées (en général 0,1 à 2 % de la brute) : le rapport signal sur bruit est presque intact
(mesures ci-dessous). Pour l'instant, cela demande une intégration WBPP ; la quarantaine reste pour
tout autre logiciel d'empilement.

1. Dans WBPP, onglet *Pipeline*, cocher **Event Script** et choisir `StarlinkSweeper-WBPP.js` dans
   le dossier de StarlinkSweeper (le cadre *Masking in WBPP* de la boîte affiche son chemin).
2. Lancer WBPP comme d'habitude, sur toutes les brutes : **ne pas** mettre en quarantaine les
   brutes empilées de cette façon.

Juste après l'alignement, chaque brute de lumière alignée est scannée dans toutes les directions.
Chaque traînée trouvée est masquée, ailes comprises, chaque satellite d'un train Starlink à part ;
les pixels masqués passent à 0 dans la brute alignée, et l'intégration de WBPP les rejette (rejet
par plage à 0, réglage par défaut des lumières). Chaque pixel est intégré à partir des brutes
propres à cet endroit ; la brute garde tout le reste. La normalisation locale travaille ensuite sur
les brutes masquées. Les brutes d'origine ne sont jamais touchées : seules les brutes alignées du dossier de
sortie de WBPP sont modifiées.

Dans `<sortie WBPP>/StarlinkSweeper/` : le journal `StarlinkSweeper.log`, et pour chaque groupe de
brutes un `<brute>_mask.xisf` compressé par brute masquée, `coverage.xisf` (part des brutes gardée
en chaque pixel), `coverage.csv`, `frames.csv` (score, traînées et part masquée de chaque brute) et
`trails.csv` (angle, longueur et largeur de chaque traînée masquée).

**Espace disque.** En plus des fichiers de WBPP : environ 0,1 Mo par brute masquée de 61 Mpx et
environ 1 Mo par groupe (carte de couverture et rapports). Sur un jeu bande étroite de 76 brutes,
0,5 à 0,85 Mo par filtre.

**Un seul script d'événement par passage de WBPP** : celui de StarlinkSweeper ou celui de
ClarkeMask, pas les deux.

Mesuré sur un jeu bande étroite brut (non calibré) de 76 brutes de 61 Mpx (H, S, O ; 300 s), WBPP
3.1.2 avec normalisation locale : 9 brutes masquées, dont un train Starlink de sept traînées
parallèles masqué sur 2,1 % de sa brute et 8 traînées isolées sur 0,1 à 0,2 % des leurs ; environ
20 s par groupe de 23 à 27 brutes sur 28 processeurs. Dans les masters intégrés par WBPP avec
toutes les brutes, les traînées laissaient une trace rectiligne faible le long de leur trajet (0,1 à
0,2 σ du bruit du master par pixel, le genre de bande qu'un étirement fort révèle) ; avec le
masquage, la trace disparaît (au niveau du bruit, comme avec des masques tracés à la main deux à
trois fois plus larges) et le bruit des masters est inchangé. Deux traînées faibles que le scan de
quarantaine des brutes non alignées avait manquées ont été trouvées et masquées.

Sur un champ de galaxie riche en étoiles (109 brutes de luminance brutes de 61 Mpx, 150 s) : 53
brutes masquées, chacune traversée par une vraie traînée (vérifié par un scan indépendant des
brutes non alignées et sur des recadrages en pleine résolution), aucun faux positif trouvé ; en
médiane 0,2 % d'une brute masqué, au plus 0,9 % ; 82 s pour les 109 brutes sur 28 processeurs,
6,75 Mo de masques et de rapports.

## Réglages

| Réglage | Signification |
|---|---|
| **Lights folder** | Dossier racine à scanner. Fichiers FITS (`.fit`, `.fits`, `.fts`) et XISF, quelle que soit la casse. |
| **Include sub-folders** | Scan récursif (coché par défaut). Les dossiers de quarantaine (noms finissant par `_trails`) sont ignorés. |
| **Lights only** | Coché par défaut : les fichiers dont l'en-tête `IMAGETYP` (ou `FRAME`, `FRAMETYP`) indique flat, dark ou bias sont ignorés et notés comme tels dans le rapport CSV. Les fichiers sans ce mot-clé sont scannés. Décocher pour tout scanner. |
| **Red above** | Les brutes dont la meilleure traînée atteint ce score sont affichées en rouge : une traînée aussi forte n'est jamais une fausse alerte, **Quarantine red** les déplace toutes d'un coup. Les brutes entre le niveau de liste et cette valeur méritent un coup d'œil à l'aperçu. Le changer recolore la liste sans relancer le scan. |
| **Threads** | Brutes analysées en même temps ; voir *Scan parallèle*. |

Brutes et lignes sont listées à partir d'un score fixe de 20. Le score est une significativité en
unités du bruit de la brute elle-même (voir *Comment ça marche*), donc ce niveau ne dépend ni du
temps de pose, ni du gain, ni de la caméra : une brute propre reste loin dessous, une traînée
visible arrive plusieurs fois au-dessus. Niveau rouge, options, threads et dernier dossier sont
mémorisés d'une session à l'autre ; le bouton **Reset** (en bas à gauche, à la manière
de PixInsight) les oublie tous et rétablit les valeurs par défaut.

Quel que soit le niveau, regarder l'aperçu avant d'effacer.

## Comment ça marche, en bref

1. La brute est binnée 8×8 (moyenne). Un fond à grande échelle (médiane sur une grille plus
   grossière, deux passes) est soustrait ; le résultat est exprimé en σ robuste et écrêté à ±3 σ
   pour que les étoiles et les pixels chauds pèsent peu.
2. Une projection de lignes de type Radon est calculée tous les 0,25° au bin 16. Le long de chaque
   direction, les structures larges (nébuleuses, gradients, nuages) sont retirées par un percentile
   bas glissant, seules les lignes fines subsistent. La carte est normalisée par son propre σ
   robuste.
3. Chaque ligne candidate est affinée au bin 8 par pas de 0,05°.
4. Test de continuité : la ligne est découpée en 24 segments, chacun comparé à sa propre ligne de
   base locale (bandes parallèles de part et d'autre). Une traînée doit être présente sur au moins
   6 segments consécutifs ; le score vaut √run × médiane(significativité des segments), si bien que
   quelques croisements brillants (corde de nébuleuse, étoile) ne peuvent pas porter une ligne à
   eux seuls. Une ligne courte passant par une étoile saturée est une aigrette de diffraction et
   est rejetée.
5. Jusqu'à 5 lignes sont rapportées par brute. Le score de la brute est celui de sa meilleure
   ligne.

Validé sur un jeu synthétique plein format (ciel propre, nuage, fort gradient, filaments
brillants, aigrettes, traînées de très faibles à saturées, train de satellites, avion, traînée ne
couvrant qu'une partie du champ ; `tests/make_synthetic_subs.py`) et sur de vraies brutes : toutes
les traînées sont détectées et les brutes propres restent largement sous le niveau de liste ; seul
le cas limite des filaments brillants s'en approche.

**Masquage (script d'événement de WBPP).** Sur chaque brute alignée, le scan ci-dessus tourne sur
la moyenne des canaux, en laissant de côté les blocs des bords d'alignement (pixels à 0), dont les
bords seraient pris pour des lignes, et en gardant toutes les lignes. Les lignes candidates ont un
score de 15 ou plus (la liste de la boîte commence à 20 : masquer quelques pixels coûte peu, une
traînée oubliée coûte une bande dans le master). Le long de chaque direction trouvée, le détecteur
de traînées de ClarkeMask (`StarlinkSweeperMaskCore.js`, une copie de son cœur) travaille sur la
moyenne 2x2 de la brute : il redresse la brute selon la direction, trouve chaque traînée fine
(chaque satellite d'un train à part, une légère courbure admise : les longues traînées en orbite basse
ne sont pas parfaitement droites), mesure jusqu'où elle dépasse le bruit (jusqu'à 0,5 σ par pixel de
chaque côté : les ailes) et où elle s'arrête, et trace le masque en pleine résolution, élargi de
4 px de chaque côté et allongé de 16 px à chaque bout. Seules les traînées à moins de 120 px d'une
ligne candidate sont masquées.

### Limites

* Les traînées très faibles (sous environ 0,5 σ par pixel dans la brute) ne sont pas détectées ;
  elles ne laissent rien de mesurable dans un master non plus.
* Des filaments de nébuleuse longs, brillants et très rectilignes peuvent s'approcher du niveau de
  liste. L'aperçu sert à ça.
* Les traînées plus courtes qu'un quart du champ sont ignorées par construction.
* Masquage : une traînée doit couvrir environ un quart du champ pour être trouvée (comme pour le
  scan) ; une traînée qui pâlit par endroits peut être masquée en morceaux, avec de courts
  intervalles non masqués. Non testé avec l'intégration drizzle. La référence de normalisation
  locale construite par WBPP à partir des brutes masquées n'a pas été vérifiée à part (les masters,
  si).

## Licence

Copyright (c) 2026 Jacques Pouyaud. Publié sous
[licence publique générale GNU, version 3 ou ultérieure](LICENSE) (GPL-3.0-or-later) : il peut être
utilisé, étudié, partagé et modifié ; toute œuvre distribuée qui intègre ce code doit être publiée
sous la même licence, avec son code source. Les versions jusqu'à 1.2.0 ont été publiées sous licence
MIT, qui reste valable pour les copies de ces versions.

**Demande de crédit.** En cas de reprise de la méthode ou du code de StarlinkSweeper, dans un
script, une application ou un tutoriel, merci de le citer par son nom avec un lien vers ce dépôt.
C'est une demande, pas une condition de la licence ; quand le code lui-même est repris, la GPL
impose déjà de conserver la mention de copyright.

Rapports de bugs et suggestions bienvenus via les issues GitHub.

## Crédits

*Code écrit par Claude (Anthropic), sous la direction de Jacques Pouyaud, qui a défini le besoin,
l'a testé sur ses propres données et validé les résultats.*
