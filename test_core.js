// Smoke test for pnp_stand_core.js + pnp_tray_core.js:
//   node tools/pnp_stand/test_core.js [board.kicad_pcb] [out_dir] [corner board.kicad_pcb] [bom.csv]
// (+ pnp_openpnp_core.js: DigiKey order import and the OpenPnP project, on the corner board if it has placements)
// Checks the grid against the caliper readings, imports a board, auto-places it, writes STL + SCAD.
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./pnp_stand_core.js');
const jscad = require('./vendor/jscad-modeling.min.js');

function openEdgesOf(b) { // edges not shared by exactly two triangles (0 = closed mesh)
  const dv = new DataView(b), n = dv.getUint32(80, true), e = new Map();
  const K = (o) => [0, 1, 2].map((i) => dv.getFloat32(o + 4 * i, true).toFixed(4)).join();
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12, v = [K(o), K(o + 12), K(o + 24)];
    for (let i = 0; i < 3; i++) { const a = v[i], c = v[(i + 1) % 3], k = a < c ? a + '|' + c : c + '|' + a; e.set(k, (e.get(k) || 0) + 1); }
  }
  return [...e.values()].filter((c) => c !== 2).length;
}
const assert = (c, msg) => { if (!c) { console.error('FAIL: ' + msg); process.exitCode = 1; } else console.log('ok   ' + msg); };

const prof = S.PROFILES['v3.1'];
const m = S.buildMachine(prof);
const ko = S.parseKeepouts(m, prof.keepouts);
assert(m.nRows === 39 && m.nCols === 7, `grid 39 rows x 7 letters (got ${m.nRows} x ${m.nCols})`);
const H = (n) => S.findHole(m, n);
assert(H('c1').exists && H('e1').exists && !H('d1').exists && H('b2').exists, 'checkerboard: c1, e1, b2 are holes, d1 is not');
assert(Math.abs(Math.hypot(H('b2').x - H('c3').x, H('b2').y - H('c3').y) - 21.213) < 1e-3, 'diagonal neighbour 21.2 mm (caliper 21.08)');
assert(Math.abs(H('b2').x - H('b4').x) === 30, 'same letter two rows apart 30 mm (caliper 30.3)');
assert(Math.abs(H('G1').y - H('g1').y) === 30, 'upper G sits 30 mm from lower g across the seam');
assert(H('A1').y > H('G1').y, 'upper plate: A at the rear edge');
assert(ko.errors.length === 0 && ko.camera && ko.camera.x === 300, 'camera keep-out at row 20 (x = 300)');

const file = process.argv[2];
const outDir = process.argv[3] || path.join(require('os').tmpdir(), 'pnp_stand_test');
let pcb;
if (file) {
  pcb = S.importKicadPcb(fs.readFileSync(file, 'utf8'), path.basename(file));
  console.log(`board ${pcb.name}: ${pcb.W} x ${pcb.H} mm, holes:`, pcb.holes.map((h) => `${h.ref}@(${h.u},${h.v}) d${h.d}${h.use ? ' *' : ''}`).join('  '));
} else {
  pcb = S.rectPcb(80, 60, [
    { ref: 'H1', u: 4, v: 4, d: 3.2, use: true }, { ref: 'H2', u: 76, v: 4, d: 3.2, use: true },
    { ref: 'H3', u: 76, v: 56, d: 3.2, use: true }, { ref: 'H4', u: 4, v: 56, d: 3.2, use: true }]);
}
const sp = S.effectiveStand({ ...S.DEFAULT_STAND, pcbThick: pcb.thickness || 1.6 });
if (file) assert(pcb.thickness > 0, `board thickness read from the file (${pcb.thickness} mm)`);
assert(Math.abs(sp.pinLen - (sp.pcbThick + sp.pinAbove)) < 1e-9, `pin length = thickness + ${sp.pinAbove} (${sp.pinLen.toFixed(2)} mm)`);
{ // second pass of a double-sided board: 4 mm parts under it
  const e = S.effectiveStand({ ...S.DEFAULT_STAND, underClear: 4, height: 5 });
  assert(e.stepH === 4.5 && e.height === 7 && e.notes.length === 2, 'under-board clearance raises step-up to 4.5 and height to 7');
  // flip mirrors u: a hole at the lower-left lands at the lower-right when bottom side up
  const pl = { cx: 100, cy: 60, rot: 0 };
  const a = S.toMachine(pcb, pl, 0, 0), b = S.toMachine(pcb, { ...pl, flip: true }, 0, 0);
  assert(Math.abs(b.x - (a.x + pcb.W)) < 1e-9 && b.y === a.y, 'flip mirrors the board about its vertical axis');
}
const t0 = Date.now();
const res = S.autoPlace(m, ko, pcb, sp, { prefer: 'camera', rotations: [0, 90, 180, 270], step: 1 });
console.log(`autoPlace: tried ${res.tried} positions in ${Date.now() - t0} ms`);
assert(!!res.best, 'auto-place found a position ' + (res.reason || ''));
if (res.best) {
  const { place, result } = res.best;
  console.log(`  centre (${place.cx.toFixed(1)}, ${place.cy.toFixed(1)}) rot ${place.rot}, cost ${result.cost.toFixed(1)}`);
  for (const st of result.stands) console.log(`  ${st.ref}: bolts ${st.bolts.map((b) => b.name).join(' + ')}, under PCB ${st.under}`);
  const used = result.stands.flatMap((s) => s.bolts.map((b) => b.name));
  assert(new Set(used).size === used.length, 'no grid hole used twice');
  assert(!S.evaluate(m, ko, pcb, { cx: 300, cy: 60, rot: 0 }, sp).ok, 'placement over the camera is rejected');
  const geoms = S.printLayout(result.stands, sp, jscad);
  const buf = S.stlBinary(geoms, jscad);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'stands.stl'), Buffer.from(buf));
  fs.writeFileSync(path.join(outDir, 'stands.scad'), S.scadSource(result.stands, sp, pcb.name));
  const bb = jscad.measurements.measureBoundingBox(geoms[0]);
  const vol = jscad.measurements.measureVolume(geoms[0]);
  console.log(`  S1 bbox ${bb[0].map((v) => v.toFixed(1))} .. ${bb[1].map((v) => v.toFixed(1))}, volume ${vol.toFixed(0)} mm^3, STL ${buf.byteLength} bytes`);
  assert(Math.abs(bb[1][2] - (sp.height + sp.pinLen)) < 0.01, 'stand height + pin length');
  assert(vol > 0, 'solid has positive volume');
  assert(result.stands.map((s) => s.num).join() === result.stands.map((s, i) => i + 1).join(), 'stands numbered 1..n');
  assert(result.stands.every((s) => S.labelFace(s, sp)), 'every stand has room for its number');
  { // floor under the nut: probe straight down the first bolt axis, off the bolt hole but inside the hex pocket
    const st = result.stands[0], g = S.standSolid(st, sp, jscad), D = S.derived(sp, st.d);
    const r = (sp.boltD / 2 + D.pocketR * 0.8) / 2; // between the bolt hole and the pocket wall
    const polys = jscad.geometries.geom3.toPolygons(g);
    let topOfFloor = -Infinity; // highest horizontal face (normal up) under the probe point (r, 0), below the body top
    for (const p of polys) {
      const v = p.vertices, n = jscad.maths.vec3.normalize([0, 0, 0], jscad.maths.vec3.cross([0, 0, 0], jscad.maths.vec3.subtract([0, 0, 0], v[1], v[0]), jscad.maths.vec3.subtract([0, 0, 0], v[2], v[0])));
      if (n[2] < 0.999) continue;
      let inside = false; // 2D point-in-polygon at (r, 0)
      for (let i = 0, j = v.length - 1; i < v.length; j = i++) if ((v[i][1] > 0) !== (v[j][1] > 0) && r < ((v[j][0] - v[i][0]) * (0 - v[i][1])) / (v[j][1] - v[i][1]) + v[i][0]) inside = !inside;
      if (inside && v[0][2] < S.bodyTop(sp) - 0.01) topOfFloor = Math.max(topOfFloor, v[0][2]);
    }
    assert(Math.abs(topOfFloor - sp.pocketFloor) < 0.01, `plastic under the nut = ${topOfFloor.toFixed(2)} mm (set ${sp.pocketFloor})`);
  }
  // each stand on its own is a closed mesh (every edge shared by exactly 2 triangles), so the slicer needs no repair
  const perStand = result.stands.map((st) => S.stlBinary(S.printLayout([st], sp, jscad), jscad));
  const open = perStand.map(openEdgesOf);
  assert(open.every((c) => c === 0), `every stand STL is closed (open edges per stand: ${open.join(', ')})`);
  const zip = S.zipStore(perStand.map((b, i) => ({ name: `stands/${result.stands[i].num}_${result.stands[i].ref}.stl`, data: new Uint8Array(b) })));
  fs.writeFileSync(path.join(outDir, 'stands.zip'), Buffer.from(zip));
  assert(new DataView(zip.buffer).getUint32(zip.length - 22, true) === 0x06054b50 && zip.length > perStand.reduce((a, b) => a + b.byteLength, 0), 'zip written with one STL per stand');
  // number 1 must be the hole nearest the board's lower-left, whatever the rotation
  const ll = pcb.holes.filter((h) => h.use).sort((a, b) => (a.u + a.v) - (b.u + b.v))[0];
  for (const rot of [0, 90, 180, 270]) {
    const r = S.evaluate(m, ko, pcb, { ...place, rot }, sp);
    if (r.stands.length) assert(r.stands[0].ref === ll.ref, `rot ${rot}: stand 1 is ${ll.ref} (lower-left)`);
  }
}

// corner mode: a board with no mounting holes (or forced)
const cornerFile = process.argv[4];
const cpcb = cornerFile ? S.importKicadPcb(fs.readFileSync(cornerFile, 'utf8'), path.basename(cornerFile)) : { ...S.rectPcb(50.8, 50.8, []), mode: 'corners' };
console.log(`corner board ${cpcb.name}: ${cpcb.W} x ${cpcb.H}, mode ${cpcb.mode}. ${cpcb.report || ''}`);
assert(cpcb.mode === 'corners', 'board without mounting holes switches to corner mode');
const cres = S.autoPlace(m, ko, cpcb, sp, { prefer: 'camera', step: 1 });
assert(!!cres.best && cres.best.result.stands.length === 4, 'corner mode: 4 corner stands placed');
if (cres.best) {
  const st = cres.best.result.stands;
  st.forEach((s) => console.log(`  ${s.num} ${s.ref}: bolts ${s.bolts.map((b) => b.name).join(' + ')}`));
  const geoms = S.printLayout(st, sp, jscad);
  const bb = jscad.measurements.measureBoundingBox(geoms[0]);
  assert(Math.abs(bb[1][2] - (sp.height + sp.cornerLip)) < 0.01, 'corner stand: wall top = height + lip');
  fs.writeFileSync(path.join(outDir, 'corner_stands.stl'), Buffer.from(S.stlBinary(geoms, jscad)));
  fs.writeFileSync(path.join(outDir, 'corner_stands.scad'), S.scadSource(st, sp, cpcb.name));
  const fl = S.evaluate(m, ko, cpcb, { ...cres.best.place, flip: true }, sp);
  assert(fl.ok && fl.stands.length === 4, 'corner mode, bottom side up: 4 stands still fit');
}

// ---------------------------------------------------------------- cut-tape trays
const T = require('./pnp_tray_core.js');
const bomFile = process.argv[5];
const bomCsv = bomFile ? fs.readFileSync(bomFile, 'utf8') : [
  '"Designator","Value","Footprint","Qty","DNP"',
  '"C1,C2,C3","100nF X7R","Capacitor_SMD:C_0402_1005Metric","3",""',
  '"C4","0.1uF 16V","Capacitor_SMD:C_0402_1005Metric","1",""', // same reel as 100nF (MS-07 normalisation)
  '"R1,R2","4k7","Resistor_SMD:R_0402_1005Metric","2",""',
  '"R3","4.7k","Resistor_SMD:R_0402_1005Metric","1",""',
  '"U1","LM","Package_TO_SOT_SMD:SOT-23-5","1",""',
  '"D1","SMAJ","Diode_SMD:D_SMA","1",""',
  '"U2","MCU","Package_QFP:LQFP-64_10x10mm_P0.5mm","1",""',
  '"R9","DNP","Resistor_SMD:R_0402_1005Metric","1","DNP"',
].join('\n');
const bom = T.parseBom(bomCsv);
console.log(`trays: ${bom.lines.length} BOM lines${bomFile ? ' from ' + path.basename(bomFile) : ' (built-in sample)'}, skipped ${bom.skipped.length}`);
if (!bomFile) {
  assert(bom.lines.length === 5, `grouping: 100nF = 0.1uF, 4k7 = 4.7k, DNP dropped (5 lines, got ${bom.lines.length})`);
  assert(bom.lines.find((l) => /QFP/.test(l.footprint)).use === false, 'QFP left out of the trays by default (JEDEC tray)');
}
{
  const tsp = S.effectiveStand({});
  const res = S.autoPlace(m, ko, pcb, tsp, { prefer: 'camera', rotations: [0], step: 1 }).best.result;
  const obst = { rects: [{ ...res.rect, label: 'board' }], polys: res.stands.map((st) => ({ pts: S.standOutline(st), label: 'stand ' + st.num })) };
  for (const boards of [1, 3]) {
    const tp = { ...T.DEFAULT_TRAY, boards };
    const target = { x: (res.rect.x0 + res.rect.x1) / 2, y: (res.rect.y0 + res.rect.y1) / 2 };
    const t0 = Date.now(), planned = T.plan(bom.lines, tp, tsp, m, ko, obst, target), pk = planned.pk;
    console.log(`  ${boards} board(s): ${pk.trays.length} tray(s) after ${planned.tried} layout(s), ${Date.now() - t0} ms`);
    const secs = pk.trays.flatMap((t) => t.lanes.flatMap((l) => l.sections.map((s) => ({ t, l, s }))));
    assert(secs.length === bom.lines.filter((l) => l.use).length, `${boards} board(s): every tray line has one section (${secs.length})`);
    assert(secs.every(({ t, s }) => s.a0 >= t.capW - 1e-6 && s.a1 <= t.capW + t.Lc + 1e-6), `${boards} board(s): sections inside their lanes`);
    assert(secs.every(({ s }) => s.count === Math.ceil(s.line.qty * boards) + tp.spares && s.tape >= (s.count + tp.leader) * s.line.pitch - 1e-9), `${boards} board(s): section holds qty x boards + spares`);
    assert(pk.trays.every((t) => t.W <= tp.maxTrayW + 1e-6 && Math.abs(((t.Lc + t.capW) / m.P.pitch) % 1) < 1e-9), `${boards} board(s): trays within max width, caps on grid rows`);
    const pl = planned.pl;
    assert(pl.every((p) => p && p.ok), `${boards} board(s): ${pk.trays.length} tray(s) placed (${pl.map((p) => p.ok ? p.bolts.map((b) => b.name).join('+') : p.why).join(' | ')})`);
    const bolts = pl.flatMap((p) => (p.bolts || []).map((b) => b.name)).concat(res.stands.flatMap((s) => s.bolts.map((b) => b.name)));
    assert(new Set(bolts).size === bolts.length, `${boards} board(s): trays and stands use different grid holes`);
    if (boards === 1) {
      const files = pk.trays.map((t, i) => ({ name: `trays/tray${t.num}.stl`, data: new Uint8Array(S.stlBinary([T.traySolid(t, pl[i], tp, tsp, jscad)], jscad)) }));
      const open = files.map((f) => openEdgesOf(f.data.buffer));
      assert(open.every((c) => c === 0), `tray STLs are closed (open edges: ${open.join(', ')})`);
      files.push({ name: 'trays/sections.csv', data: new TextEncoder().encode(T.sectionsCsv(bom.lines, pk, pl)) });
      fs.writeFileSync(path.join(outDir, 'trays.zip'), Buffer.from(S.zipStore(files)));
      const g = T.traySolid(pk.trays[0], pl[0], tp, tsp, jscad), bb = jscad.measurements.measureBoundingBox(g);
      assert(Math.abs(bb[1][2] - pk.trays[0].Tc) < 0.01 && Math.abs(bb[1][0] - bb[0][0] - pk.trays[0].L) < 0.01, `tray 1 solid ${pk.trays[0].L.toFixed(1)} x ${pk.trays[0].W.toFixed(1)} x ${pk.trays[0].Tc.toFixed(2)} mm`);
    }
  }
}

// ---------------------------------------------------------------- DigiKey order + OpenPnP project
const O = require('./pnp_openpnp_core.js');
{
  // a board with parts: the corner board if it was a real file (MONK has placements + fiducials), else the holes board
  const board = (cpcb.parts && cpcb.parts.length ? cpcb : pcb);
  if (!board.parts || !board.parts.length) console.log('skip OpenPnP checks: no .kicad_pcb with placements given');
  else {
    const fromBoard = T.linesFromParts(board.parts);
    const smd = board.parts.filter((p) => p.smd && !p.excludePos && !p.boardOnly && !p.dnp && !/^#/.test(p.ref));
    assert(fromBoard.lines.reduce((a, l) => a + l.qty, 0) === smd.length, `board ${board.name}: lines from footprints cover all ${smd.length} SMD placements`);
    // a small DigiKey order: first line by MPN (if the board has MPNs), plus a made-up unmatched part
    const withMpn = fromBoard.lines.find((l) => l.mpn);
    const order = ['Index,DigiKey Part #,Manufacturer Part Number,Manufacturer,Description,Customer Reference,Quantity,Backorder,Unit Price,Extended Price']
      .concat(withMpn ? [`1,X-ND,${withMpn.mpn.split(' / ')[0]},Acme,THING,,7,0,$1,$7`] : [])
      .concat(['2,Y-ND,NOPE-123,Acme,MYSTERY PART,,3,0,$1,$3', ',,,,,,,,Subtotal,$10']).join('\n');
    assert(T.isDigiKeyOrder(order) && !T.isDigiKeyOrder(bomCsv), 'DigiKey order CSV recognised (and a KiCad BOM is not)');
    const ord = T.applyOrder(fromBoard.lines, order);
    if (withMpn) assert(ord.lines.find((l) => l.id === withMpn.id).qty === 7, 'order: qty taken from the order line matched by MPN');
    assert(ord.unmatched.length === 1 && /NOPE-123/.test(ord.unmatched[0]), 'order: unknown part reported as not matched');

    const tsp = S.effectiveStand({ pcbThick: board.thickness || 1.6 });
    const ap = S.autoPlace(m, ko, board, tsp, { prefer: 'camera', step: 1 });
    const res = ap.best.result;
    const lines = fromBoard.lines;
    const tp = { ...T.DEFAULT_TRAY };
    const obst = { rects: [{ ...res.rect, label: 'board' }], polys: res.stands.map((st) => ({ pts: S.standOutline(st), label: 'stand ' + st.num })) };
    const planned = T.plan(lines, tp, tsp, m, ko, obst, { x: ap.best.place.cx, y: ap.best.place.cy });
    const ref = { hole: 'b2', x: 100, y: 50, flipX: false, flipY: false };
    const prj = O.project({ m, pcb: board, place: ap.best.place, sp: tsp, lines, trays: { pk: planned.pk, pl: planned.pl }, tp, ref, plateZ: -20, notInTray: 'ignore' });
    const file = (n) => prj.files.find((f) => f.name === n || f.name.endsWith(n)).text;
    const placements = (file('.board.xml').match(/<placement /g) || []).length;
    const fids = board.parts.filter((p) => /fiducial/i.test(p.footprint)).length;
    assert(placements === smd.length + fids, `OpenPnP board: ${placements} placements = ${smd.length} SMD + ${fids} fiducial(s)`);
    const partIds = new Set([...file('parts.xml').matchAll(/<part id="([^"]+)"/g)].map((x) => x[1]));
    const pkgIds = new Set([...file('packages.xml').matchAll(/<package version="1.1" id="([^"]+)"/g)].map((x) => x[1]));
    const used = [...file('.board.xml').matchAll(/part-id="([^"]+)"/g)].map((x) => x[1]).concat([...file('feeders.xml').matchAll(/part-id="([^"]+)"/g)].map((x) => x[1]));
    assert(used.every((id) => partIds.has(id)), 'OpenPnP: every placement / feeder part-id is in parts.xml');
    assert([...file('parts.xml').matchAll(/package-id="([^"]+)"/g)].every((x) => pkgIds.has(x[1])), 'OpenPnP: every part has its package');
    assert((file('feeders.xml').match(/<feeder /g) || []).length === planned.pk.sections.length, `OpenPnP: one strip feeder per tray section (${planned.pk.sections.length})`);
    // board location: board lower-left via the reference hole b2 -> (100, 50)
    const h = S.findHole(m, 'b2'), o0 = S.toMachine(board, ap.best.place, 0, 0);
    assert(Math.abs(prj.loc.x - (100 + o0.x - h.x)) < 1e-9 && Math.abs(prj.loc.y - (50 + o0.y - h.y)) < 1e-9, 'OpenPnP job: board location through the reference hole');
    assert(Math.abs(prj.loc.z - (-20 + tsp.height + (board.thickness || tsp.pcbThick))) < 1e-9, `OpenPnP job: board Z = plate Z + stand + board (${prj.loc.z.toFixed(2)})`);
    const balanced = (x) => ['openpnp-board', 'placements', 'openpnp-parts', 'openpnp-packages', 'feeders', 'feeder', 'package', 'pipeline'].every((t) =>
      (x.match(new RegExp('<' + t + '[\\s>]', 'g')) || []).length === (x.match(new RegExp('</' + t + '>', 'g')) || []).length);
    assert(prj.files.filter((f) => f.name.endsWith('.xml')).every((f) => balanced(f.text)), 'OpenPnP XML: open / close tags balance');
    fs.mkdirSync(path.join(outDir, 'openpnp'), { recursive: true });
    for (const f of prj.files) fs.writeFileSync(path.join(outDir, 'openpnp', f.name), f.text);
  }
}
