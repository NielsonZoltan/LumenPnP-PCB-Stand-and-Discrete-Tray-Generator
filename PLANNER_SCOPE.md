# Scope: LumenPnP job planner (pnp_stand rev 2)

Status: proposal, 2026-11-04. Update 2026-11-06: the BOM import and cut-tape trays (parts of phases 1, 2 and 4) are
built as section 6 of `pnp_stand.html` (`pnp_tray_core.js`); strip feeders, Photon slots and the OpenPnP export are not.

## Goal

Go from a board to a ready-to-calibrate LumenPnP job in one tool:

1. read the BOM and placement list,
2. choose per line how the part is fed (Photon feeder, strip feeder, tray, hand-placed, skip),
3. lay out the stands, strip feeders and trays on the staging plates (auto-suggested, drag to adjust),
4. export an OpenPnP **starter** config and a printed setup sheet.

The exported coordinates are ballparks from the plate grid. Every feeder still needs a quick teach on the machine
(reference holes, first tray pocket, pick Z). The point is to skip typing 30 parts, packages and feeders by hand, and to
know before the job that everything fits on the plates.

## Same tool or a new one

**Recommendation: rev 2 of `pnp_stand`, as a second tab ("Stands | Job").** Both tabs share the plate model, grid
names, keep-outs, the drag-and-drop view and the reference-hole calibration that `pnp_stand_core.js` already has. Stands
become one object type in the layout, next to strip feeders and trays, so the two can't collide. The planner logic goes
in a new `pnp_plan_core.js` (Node-testable like the stand core). A separate tool would duplicate all of that and drift.

## Inputs

| Input | Source | Notes |
|---|---|---|
| Placements | `kicad-cli pcb export pos --format csv --units mm` (ref, value, footprint, x, y, rot, side) | Or read the .kicad_pcb the stand tab already parses, which avoids a second export. |
| BOM fields | KiCad BOM CSV (`kicad-cli sch export bom`) with Manufacturer/MPN fields | Joined to placements by ref. |
| Reel grouping | One feed line per normalised (value, footprint) | Done in JS (`pnp_tray_core.js`). |
| Part heights | Footprint / 3D model height if available, else a package table | Needed for parts.xml and the nozzle tip. |

## Feed methods (per BOM line)

| Method | Planner object | Default rule (editable) |
|---|---|---|
| Photon feeder | Slot on the front/rear rail (not on the plates) | 8 mm tape and qty ≥ N (user threshold), while slots are free |
| Strip feeder | Lane in an Opulo strip feeder bolted to the plates | Tape width from the package table; also short cut tapes |
| Tray | Tray on the plates, rows × cols pockets | Trays, tubes and QFNs/QFPs bigger than 7 mm, or as chosen |
| Hand place | Listed on the sheet only | THT, odd parts, qty 1 if the user says so |
| Skip | – | DNP, board-only (castellations, fiducials), other side |

Per line the planner shows qty, tape width and pitch, and how many fit per lane (usable strip length / pitch). It warns
when one lane won't hold the qty × boards in the job.

## Strip feeder geometry (measured)

The Opulo FreeCAD files are in [src/FDM](https://github.com/opulo-inc/lumenpnp/tree/main/src/FDM) (`*-strip-feeder.FCStd`,
plus `adj-strip-feeder-left/right`, not measured yet). I measured the solids with FreeCADCmd:

| Feeder | Footprint X × Y × Z (mm) | Lanes | Lane width | Lane pitch |
|---|---|---|---|---|
| 8 mm | 40.4 × 120 × 12 | 3 | 8.2 | 15 |
| 12 mm | 44.4 × 120 × 12 | 3 | 12.2 | 15 |
| 16 mm | 44.4 × 120 × 12 | 2 | 16.2 | 26 |
| 24 mm | 26.4 × 120 × 12 | 1 | 24.2 | – |
| 32 mm | 34.4 × 120 × 12 | 1 | 32.2 | – |

- **Length 120 mm = one plate's width.** Each feeder spans a plate from front edge to rear edge, with the lanes running
  across the plate (letter direction). It's positioned by its row along the plate.
- **Bolt pockets on the 15 mm grid in both directions** (Ø6 + Ø8.3 counterbores, 9 positions along Y including both
  ends), so a feeder can sit at any row. It snaps to the grid the same way the stands do.
- **Height:** the body runs from Z 3 to 15 in the model (plate top = 3). The tape-guide lip is at Z 12.2–13, so the tape
  top is roughly 9–10 mm above the plate. That's a ballpark for pick Z only, to be taught on the machine.

## Layout planner

- Objects: board (+ its stands), strip feeders (type picks width/lanes), trays (W × H, pocket grid), keep-outs, and a
  list of Photon slots shown beside the plates.
- **Auto-arrange:** place feeders in rows next to the board, nearest first by placements × distance (bottom camera
  included for parts that need bottom vision). Respect keep-outs, stands, the camera and the datum board.
  Then drag to adjust, with a collision check like the stands have.
- Lanes are numbered (e.g. `F3-L2` = feeder 3, lane 2). The sheet says which tape goes in which lane and in which
  direction (sprocket side).

## Outputs

1. **OpenPnP starter, as merge snippets, never a whole machine.xml.** The machine's calibrated machine.xml (cameras,
   nozzles, axes) must not be overwritten.
   - `packages.xml` / `parts.xml`: one part per feed line (`value-footprint` id), with package, height and a suggested
     nozzle tip (from Opulo's set: N045, N08, N14, N24, N40, N75).
   - Feeders: `ReferenceStripFeeder` (reference + last hole from the lane geometry, tape width, part pitch, feed
     direction), `ReferenceTrayFeeder` (first pocket, rows/cols, pitch), and a Photon slot → part table.
   - Board/placements from the pos file, side and board location from the stand tab.
   - Either a snippet file to paste in, or (better) read the user's machine.xml, add or replace only the generated
     feeders (tagged by id prefix `PLAN-`) and write a copy.
2. **Setup sheet** (print): plate map, lane/tray/slot assignments, hand-place list, stand numbers.
3. **Job file** (JSON) to reload and edit.

## What we know about the OpenPnP side

- Opulo's shipped config ([openpnp/machine.xml](https://github.com/opulo-inc/lumenpnp/tree/main/openpnp)) has **no strip
  or tray feeders**. It only has Photon feeder slots (`PhotonFeederSlots`, per-address locations) and three
  `ReferenceSlotAutoFeeder` slots. Its default board location is Z 5.0, and the top and bottom cameras are named
  "Top" and "Bottom".
- The OpenPnP wiki documents ReferenceStripFeeder only at the UI level (reference/second hole, direction, pipeline,
  pick Z, extrapolation distance) and gives no XML attribute names.

**Biggest risk:** the exact XML for ReferenceStripFeeder / ReferenceTrayFeeder differs between OpenPnP versions.
Before building the export:

1. note the OpenPnP version on our machine;
2. make one strip feeder and one tray feeder by hand in the GUI and save;
3. copy those elements as the export templates, and use OpenPnP's source (`@Attribute` fields) for anything else.

## Phases

| Phase | Content | Effort (rough) |
|---|---|---|
| 1 | Pos + BOM import, reel grouping, feed-method table with defaults, capacity warnings, CSV/JSON out | 1 session |
| 2 | Layout tab: strip feeders and trays as grid-snapped objects, auto-arrange, collision with stands, setup sheet | 1–2 sessions |
| 3 | OpenPnP export from the hand-made templates (step above), machine.xml merge, board placements | 1 session + a machine test |
| 4 (optional) | Parametric tray / cut-tape holder STLs on the same grid, reusing the stand solid pipeline (JSCAD) | 1 session |

## Open questions

- OpenPnP version on the machine, and how many Photon feeders / rail slots we have.
- Do we plan double-sided jobs as two jobs (one per side, as the stand tab does now) or one job with two passes?
- Tray designs: Opulo's repo has none in src/FDM. Should phase 4 make our own (it fits the stand pipeline well)?
- Should feed defaults also read the MPN list (`series_mpn.csv`) for tape widths and pitches where the package table
  guesses wrong?
