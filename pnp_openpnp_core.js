/*
 * pnp_openpnp_core.js: OpenPnP starter project from the stand + tray planner (no DOM; Node-testable).
 *
 * Writes, for OpenPnP 2.4 (checked against the 2.4 install: samples/EAT001 board/job format, default machine.xml strip
 * feeders):
 *   <board>.board.xml   placements from the .kicad_pcb (origin = board lower-left, like the stand tool), fiducials
 *   <board>.job.xml     one board location from the stand placement (side, rotation, X/Y via the reference hole)
 *   parts.xml / packages.xml   one part per BOM line (value + footprint, as the trays), body size, height, nozzle tip
 *   feeders.xml         one ReferenceStripFeeder per tray section, ids PLAN-<line>, reference/last hole ballparks
 *   merge_into_openpnp.py   adds / replaces those parts, packages and PLAN- feeders in ~/.openpnp2 (with a backup)
 *   README.txt
 * Every coordinate is a ballpark from the plate grid: teach the feeders, board location and Z on the machine.
 */
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const S = node ? require('./pnp_stand_core.js') : root.PnpStand;
  const TR = node ? require('./pnp_tray_core.js') : root.PnpTray;
  const VERSION = 3;

  // OpenPnP 2.4 default ReferenceStripFeeder vision pipeline (copied from its default machine.xml)
  const STRIP_PIPELINE = "<pipeline>\n               <stages>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.ImageCapture\" name=\"original\" enabled=\"true\" default-light=\"true\" settle-option=\"Settle\" count=\"1\"/>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.BlurMedian\" name=\"cleanup-original\" enabled=\"true\" kernel-size=\"5\"/>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.ConvertColor\" name=\"gray\" enabled=\"true\" conversion=\"Bgr2Gray\"/>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.DetectEdgesCanny\" name=\"find-edges\" enabled=\"true\" threshold-1=\"5.0\" threshold-2=\"15.0\"/>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.BlurGaussian\" name=\"predetect-1\" enabled=\"true\" kernel-size=\"5\" property-name=\"BlurGaussian\"/>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.BlurMedian\" name=\"predetect-2\" enabled=\"false\" kernel-size=\"7\"/>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.DetectFixedCirclesHough\" name=\"results\" enabled=\"true\" dp=\"1.0\" param-1=\"25.0\" param-2=\"20.0\"/>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.ImageRecall\" name=\"recalled\" enabled=\"true\" image-stage-name=\"original\"/>\n                  <cv-stage class=\"org.openpnp.vision.pipeline.stages.DrawCircles\" name=\"display\" enabled=\"true\" circles-stage-name=\"results\" thickness=\"1\">\n                     <color r=\"255\" g=\"0\" b=\"0\" a=\"255\"/>\n                  </cv-stage>\n               </stages>\n            </pipeline>";

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const n3 = (x) => (+x).toFixed(3);

  // ------------------------------------------------------------------ packages: body size, height, nozzle tip
  /**
   * Ballparks by footprint name. tip: Opulo's set (N045 N08 N14 N24 N40 N75); a package lists the tip it should use.
   * height = part height above the board (OpenPnP uses it for the place Z); check the datasheets marked guess.
   */
  function packageInfo(fp, value) {
    const f = String(fp);
    const P = (w, h, height, tip, guess) => ({ w, h, height, tip, guess: !!guess });
    const chip = { '0201': [0.6, 0.3], '0402': [1.0, 0.5], '0603': [1.6, 0.8], '0805': [2.0, 1.25], '1206': [3.2, 1.6], '1210': [3.2, 2.5], '1008': [2.5, 2.0] };
    const m = f.match(/^(R|C|L|LED|D|Fuse)_(0201|0402|0603|0805|1206|1210|1008)_/);
    if (m) {
      const [w, h] = chip[m[2]], kind = m[1];
      // caps get thick with value: 0805 10-22 uF is 1.25 mm, resistors are thin
      const height = kind === 'R' ? { '0201': 0.23, '0402': 0.35, '0603': 0.45, '0805': 0.5, '1206': 0.55 }[m[2]] || 0.6
        : kind === 'L' && m[2] === '1008' ? 1.2 : { '0201': 0.3, '0402': 0.5, '0603': 0.8, '0805': 1.25, '1206': 1.6, '1210': 2.5 }[m[2]] || 1.0;
      const tip = m[2] === '0201' || m[2] === '0402' ? 'N045' : m[2] === '0603' || m[2] === '0805' ? 'N08' : 'N14';
      return P(w, h, height, tip, kind === 'L');
    }
    if (/D_SMA\b|D_SMA_|D_SMA$/.test(f)) return P(4.3, 2.6, 2.3, 'N14');
    if (/D_SMB/.test(f)) return P(4.6, 3.6, 2.3, 'N24');
    if (/SOT-23-6|SOT-23-5|SOT-23\b|SOT-23_/.test(f)) return P(2.9, 1.6, 1.1, 'N08');
    if (/SOT-583|SOT-563/.test(f)) return P(2.1, 1.6, 0.6, 'N08');
    if (/SW_SPST_PTS810|PTS810/.test(f)) return P(4.2, 3.2, 2.5, 'N14', true);
    if (/Samtec_FTR-110/.test(f)) return P(13.7, 5.1, 3.5, 'N24', true);
    if (/QFP-176_24x24|PTP0176/.test(f)) return P(24, 24, 1.6, 'N75');
    const b = f.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/);
    if (b) {
      const w = +b[1], h = +b[2], big = Math.max(w, h);
      const height = /Oscillator|Crystal/.test(f) ? 1.0 : /QFP/.test(f) ? 1.6 : 0.8;
      return P(w, h, height, big <= 2.5 ? 'N08' : big <= 5 ? 'N14' : big <= 10 ? 'N24' : big <= 20 ? 'N40' : 'N75', true);
    }
    return P(2, 2, 1.0, 'N14', true);
  }

  /** OpenPnP id for a BOM line: footprint without the metric suffix + value, e.g. "C_0402-100nF", "SOT-23-6-SRV05-4ATCT" */
  function partIdOf(line) {
    const fp = String(line.footprint).replace(/_\d{4}Metric$/, '').replace(/[^\w.+-]+/g, '_');
    const v = String(line.value).split(' / ')[0].split(/\s+/)[0].replace(/[^\w.+-]+/g, '_');
    return `${fp}-${v}`;
  }
  const pkgIdOf = (fp) => String(fp).replace(/[^\w.+-]+/g, '_');
  const isFid = (p) => /fiducial/i.test(p.footprint) || /^FID\d*$/i.test(p.ref);

  /**
   * Which placements go in the board file and as what. Fiducials are kept even when the footprint is
   * "exclude from position files" (they are on MONK). Everything else follows KiCad's pos rules.
   */
  function boardPlacements(pcb, lines, notInTray) {
    const byRef = new Map();
    for (const l of lines || []) for (const r of l.refs) byRef.set(r, l);
    const out = [];
    for (const p of pcb.parts || []) {
      if (!p.ref || p.ref.startsWith('#')) continue;
      if (isFid(p)) { out.push({ p, type: 'Fiducial', partId: 'FIDUCIAL-1mm' }); continue; }
      if (p.excludePos || p.boardOnly || p.dnp || !p.smd) continue;
      const l = byRef.get(p.ref);
      const line = l || { footprint: p.footprint.split(':').pop(), value: p.value, refs: [p.ref], use: false };
      const type = l && l.use ? 'Place' : notInTray === 'place' ? 'Place' : 'Ignore';
      out.push({ p, line, type, partId: partIdOf(line), inBom: !!l });
    }
    return out;
  }

  // ------------------------------------------------------------------ XML writers
  function boardXml(name, pls) {
    const rows = pls.map(({ p, type, partId }) =>
      `      <placement version="1.1" id="${esc(p.ref)}" side="${p.side}" part-id="${esc(partId)}" type="${type}">\n` +
      `         <location units="Millimeters" x="${n3(p.u)}" y="${n3(p.v)}" z="0.0" rotation="${n3(p.rot)}"/>\n      </placement>`);
    return `<openpnp-board name="${esc(name)}.board.xml">\n   <outline units="Millimeters"/>\n   <fiducials/>\n   <placements>\n${rows.join('\n')}\n   </placements>\n</openpnp-board>\n`;
  }

  function jobXml(name, loc) {
    return `<openpnp-job>\n   <board-locations>\n      <board-location side="${loc.side}" board-file="${esc(name)}.board.xml">\n` +
      `         <location units="Millimeters" x="${n3(loc.x)}" y="${n3(loc.y)}" z="${n3(loc.z)}" rotation="${n3(loc.rot)}"/>\n` +
      `      </board-location>\n   </board-locations>\n</openpnp-job>\n`;
  }

  function partsXml(parts) {
    return '<openpnp-parts>\n' + parts.map((q) =>
      `   <part id="${esc(q.id)}" name="${esc(q.name)}" height-units="Millimeters" height="${q.height}" package-id="${esc(q.pkg)}" speed="1.0" pick-retry-count="0"/>`).join('\n') + '\n</openpnp-parts>\n';
  }

  function packagesXml(pkgs) {
    return '<openpnp-packages>\n' + pkgs.map((k) =>
      `   <package version="1.1" id="${esc(k.id)}" description="${esc(k.desc)}" pick-vacuum-level="0.0" place-blow-off-level="0.0">\n` +
      `      <footprint units="Millimeters" body-width="${k.w}" body-height="${k.h}" outer-dimension="0.0" inner-dimension="0.0" pad-count="0" pad-pitch="0.0" pad-across="0.0" pad-roundness="0.0"${k.fid ? '>\n         <pad name="1" x="0.0" y="0.0" width="1.0" height="1.0" rotation="0.0" roundness="100.0"/>\n      </footprint>' : '/>'}\n` +
      `      <compatible-nozzle-tip-ids class="java.util.ArrayList">${k.tip ? `\n         <string>${k.tip}</string>\n      ` : ''}</compatible-nozzle-tip-ids>\n   </package>`).join('\n') + '\n</openpnp-packages>\n';
  }

  /** ReferenceStripFeeder for one tray section (machine coordinates) */
  function stripFeederXml(f) {
    return `         <feeder class="org.openpnp.machine.reference.feeder.ReferenceStripFeeder" version="1.1" id="${esc(f.id)}" name="${esc(f.name)}" enabled="true" part-id="${esc(f.partId)}" feed-retry-count="3" pick-retry-count="0" tape-type="${f.tapeType}" standard-eia-481="true" vision-enabled="true" feed-count="0" max-feed-count="0">\n` +
      `            <location units="Millimeters" x="0.0" y="0.0" z="${n3(f.z)}" rotation="${n3(f.rot)}"/>\n` +
      `            <reference-hole-location units="Millimeters" x="${n3(f.ref.x)}" y="${n3(f.ref.y)}" z="${n3(f.z)}" rotation="0.0"/>\n` +
      `            <last-hole-location units="Millimeters" x="${n3(f.last.x)}" y="${n3(f.last.y)}" z="${n3(f.z)}" rotation="0.0"/>\n` +
      `            <part-pitch value="${f.pitch}" units="Millimeters"/>\n            <tape-width value="${f.tapeW}" units="Millimeters"/>\n` +
      `            ${STRIP_PIPELINE}\n` +
      // only fields OpenPnP 2023-04-05 (0aa4ae8, the LumenPnP host) also has: no feed-options, extrapolation-distance,
      // parallax-* (later additions; all optional, defaults are the same)
      `         </feeder>`;
  }

  /**
   * ReferenceTrayFeeder for one section in an Opulo printed tray feeder: 1 x n parts from the first pick location,
   * stepping by offset. Same fields as the LumenPnP host's own tray feeders (OpenPnP 2023-04-05), minus the legacy
   * retry-count.
   */
  function trayFeederXml(f) {
    return `         <feeder class="org.openpnp.machine.reference.feeder.ReferenceTrayFeeder" version="1.1" id="${esc(f.id)}" name="${esc(f.name)}" enabled="true" part-id="${esc(f.partId)}" feed-retry-count="3" pick-retry-count="0" tray-count-x="1" tray-count-y="${f.n}" feed-count="0">\n` +
      `            <location units="Millimeters" x="${n3(f.first.x)}" y="${n3(f.first.y)}" z="${n3(f.z)}" rotation="${n3(f.rot)}"/>\n` +
      `            <offsets units="Millimeters" x="${n3(f.offset.x)}" y="${n3(f.offset.y)}" z="0.0" rotation="0.0"/>\n` +
      `         </feeder>`;
  }

  // ------------------------------------------------------------------ project
  /**
   * opts: { m, pcb, place, sp (effective stand), lines (tray BOM lines or null), trays ({pk, pl} or null),
   *         opulo ({op: opuloPack result, pl: placeOpulo result} or null; used instead of trays), tp,
   *         ref: {hole, x, y, flipX, flipY} (plate -> machine; without it coordinates stay in the plate frame),
   *         plateZ (machine Z of the plate top), notInTray: 'ignore' | 'place' }
   * Returns { name, files: [{name, text}], notes: [string] }
   */
  function project(o) {
    const notes = [];
    const name = String(o.pcb.name || 'board').replace(/[^\w.-]+/g, '_');
    const m = o.m, h = o.ref && o.ref.hole ? S.findHole(m, o.ref.hole) : null;
    const sx = o.ref && o.ref.flipX ? -1 : 1, syy = o.ref && o.ref.flipY ? -1 : 1;
    const toMachine = (p) => (h ? { x: o.ref.x + sx * (p.x - h.x), y: o.ref.y + syy * (p.y - h.y) } : { x: p.x, y: p.y });
    if (!h) notes.push('No reference hole set (section 5, "OpenPnP board location"): X/Y are in the plate frame (row-1 / front corner = 0,0), not machine coordinates.');
    const plateZ = +o.plateZ || 0;

    // placements + parts
    const pls = boardPlacements(o.pcb, o.lines, o.notInTray);
    if (!pls.some((q) => q.type !== 'Fiducial')) notes.push('No placements: open the .kicad_pcb (a plain rectangle has no parts).');
    const fids = pls.filter((q) => q.type === 'Fiducial');
    if (fids.length < 2) notes.push(`${fids.length} fiducial(s) found; OpenPnP needs 2+ for board fiducial check.`);
    const parts = new Map(), pkgs = new Map();
    for (const q of pls) {
      if (q.type === 'Fiducial') {
        pkgs.set('FIDUCIAL-1mm', { id: 'FIDUCIAL-1mm', desc: '1 mm copper dot (Fiducial_1mm_Mask2mm)', w: 1, h: 1, tip: '', fid: true });
        parts.set('FIDUCIAL-1mm', { id: 'FIDUCIAL-1mm', name: 'Fiducial 1 mm', height: 0, pkg: 'FIDUCIAL-1mm' });
        continue;
      }
      const fp = q.line.footprint, info = packageInfo(fp, q.line.value), pkg = pkgIdOf(fp);
      if (!pkgs.has(pkg)) pkgs.set(pkg, { id: pkg, desc: fp + (info.guess ? ' (size guessed: check)' : ''), w: info.w, h: info.h, tip: info.tip });
      if (!parts.has(q.partId)) parts.set(q.partId, { id: q.partId, name: [q.line.value, q.line.mpn].filter(Boolean).join(' '), height: info.height, pkg, guess: info.guess });
    }
    const noBom = pls.filter((q) => q.type !== 'Fiducial' && !q.inBom).map((q) => q.p.ref);
    if (o.lines && noBom.length) notes.push(`Not in the loaded BOM (so set to Ignore): ${noBom.join(' ')}`);

    // board location: board lower-left (bbox) on the plates -> machine
    const origin = S.toMachine(o.pcb, o.place, 0, 0);
    const bl = toMachine(origin);
    const boardZ = plateZ + o.sp.height + (o.pcb.thickness || o.sp.pcbThick);
    const loc = { side: o.place.flip ? 'Bottom' : 'Top', x: bl.x, y: bl.y, z: boardZ, rot: o.place.rot };
    if (o.place.flip) notes.push('Bottom side up: OpenPnP mirrors bottom placements itself; check the board location on the machine (not verified).');
    if (o.pcb.parts && o.pcb.parts.some((p) => p.side === 'Bottom' && p.smd && !p.excludePos)) notes.push('The board has bottom-side parts: their rotation convention is not verified against OpenPnP.');

    // strip feeders, one per tray section
    const feeders = [];
    if (o.trays && o.trays.pk) {
      o.trays.pk.trays.forEach((t, i) => {
        const pl = o.trays.pl[i];
        if (!pl || !pl.ok) { notes.push(`Tray ${t.num} is not placed: no feeders written for it.`); return; }
        for (const r of TR.sectionCoords(t, pl, o.tp)) {
          const l = o.lines.find((x) => x.id === r.id);
          const sec = t.lanes.flatMap((ln) => ln.sections).find((s) => s.id === r.id);
          // sprocket holes every 4 mm along the lane; first one ~2 mm in from the start of the tape, last ~2 mm before the end
          const x0 = pl.rect.x0 + sec.aTape + 2, x1 = pl.rect.x0 + sec.a1 - 2;
          feeders.push({ id: `PLAN-${r.id}`, name: `T${t.num}L${r.lane} #${r.id} ${l.value.split(' / ')[0]}`.slice(0, 60), partId: partIdOf(l),
            tapeType: l.carrier === 'paper' ? 'WhitePaper' : 'BlackPlastic', tapeW: l.tapeW, pitch: l.pitch, z: plateZ + r.z, rot: 0,
            ref: toMachine({ x: x0, y: r.sprocketY }), last: toMachine({ x: Math.max(x0 + 4, x1), y: r.sprocketY }) });
          partFor(l);
        }
      });
    }
    // Opulo printed tray feeders: one OpenPnP ReferenceTrayFeeder per section, as in Opulo's own setup guide
    // (a line split over 2+ channels: PLAN-<line>-<k>). Offsets follow the flip toggles of the reference hole.
    if (o.opulo && o.opulo.op) {
      o.opulo.op.feeders.forEach((f, i) => {
        const pl = o.opulo.pl[i];
        if (!pl || !pl.ok) { notes.push(`Opulo feeder O${f.num} is not placed: no feeders written for it.`); return; }
        for (const c of TR.opuloCoords(f, pl, o.tp)) {
          const s = c.sec, l = s.line;
          feeders.push({ kind: 'tray', id: s.of > 1 ? `PLAN-${s.id}-${s.k}` : `PLAN-${s.id}`, name: `O${f.num}C${c.channel} #${s.id} ${l.value.split(' / ')[0]}${s.refill ? ' +' + s.refill + ' refill' : ''}`.slice(0, 60), partId: partIdOf(l),
            n: c.n, z: plateZ + c.z, rot: 0, first: toMachine(c.first), offset: { x: sx * c.offset.x, y: syy * c.offset.y } });
          partFor(l);
        }
      });
      const refills = o.opulo.op.sections.filter((x) => x.refill).map((x) => `#${x.id} (${x.count} in the channel, ${x.refill} more to slide in)`);
      if (refills.length) notes.push(`Refill as they run out, then reset the feeder's feed count to 0: ${refills.join(', ')}`);
      notes.push('Opulo tray feeders: the pick locations are ballparks from the plan (channels 15 mm apart about the feeder centre). For each PLAN- feeder: position the camera on the first part, capture, set Z and the part rotation, Apply.');
    }
    function partFor(l) { // fed line with no placement on this board (e.g. ordered spare part)
      if (parts.has(partIdOf(l))) return;
      const info = packageInfo(l.footprint, l.value), pkg = pkgIdOf(l.footprint);
      if (!pkgs.has(pkg)) pkgs.set(pkg, { id: pkg, desc: l.footprint, w: info.w, h: info.h, tip: info.tip });
      parts.set(partIdOf(l), { id: partIdOf(l), name: l.value, height: info.height, pkg });
    }
    const guessed = [...parts.values()].filter((q) => q.guess).map((q) => q.id);
    if (guessed.length) notes.push(`Part height / body size guessed (check the datasheet): ${guessed.join(', ')}`);

    const counts = { place: pls.filter((q) => q.type === 'Place').length, ignore: pls.filter((q) => q.type === 'Ignore').length, fid: fids.length };
    const readme = readmeText(name, counts, loc, feeders, notes, !!h, plateZ, o);
    const files = [
      { name: `${name}.board.xml`, text: boardXml(name, pls) },
      { name: `${name}.job.xml`, text: jobXml(name, loc) },
      { name: 'parts.xml', text: partsXml([...parts.values()]) },
      { name: 'packages.xml', text: packagesXml([...pkgs.values()]) },
      { name: 'feeders.xml', text: '<feeders>\n' + feeders.map((f) => (f.kind === 'tray' ? trayFeederXml(f) : stripFeederXml(f))).join('\n') + '\n</feeders>\n' },
      { name: 'merge_into_openpnp.py', text: MERGE_PY },
      { name: 'README.txt', text: readme },
    ];
    return { name, files, notes, counts, loc, feeders };
  }

  function readmeText(name, c, loc, feeders, notes, machineFrame, plateZ, o) {
    return [
      `OpenPnP starter for ${name} (generated by MONK tools/pnp_stand, for OpenPnP 2.4).`,
      `Everything here is a ballpark from the plate grid: teach it on the machine.`,
      ``,
      `Contents`,
      `  ${name}.board.xml   ${c.place} placements to place, ${c.ignore} set to Ignore (hand place / not in a tray), ${c.fid} fiducials.`,
      `                      Origin = board lower-left corner (KiCad top view), X right, Y up.`,
      `  ${name}.job.xml     one board location: ${loc.side} side, X ${loc.x.toFixed(2)} Y ${loc.y.toFixed(2)} Z ${loc.z.toFixed(2)} rotation ${loc.rot}.`,
      `                      ${machineFrame ? 'Machine coordinates via the reference hole.' : 'PLATE FRAME (no reference hole was set), not machine coordinates.'}`,
      `                      Z = plate top (${plateZ}) + stand height + board thickness. Add a second board in the Job tab for a 2-board run.`,
      `  parts.xml           parts to merge (id = footprint-value, one per BOM line, same as the tray sections).`,
      `  packages.xml        packages to merge (body size, nozzle tip by name from Opulo's set N045 N08 N14 N24 N40 N75;`,
      `                      the merge turns the names into this machine's nozzle tip ids).`,
      `  feeders.xml         ${feeders.length} feeder(s), ids PLAN-<line>: a ReferenceStripFeeder per section of our trays, or a ReferenceTrayFeeder per section in an Opulo feeder (PLAN-<line>-<k> when a line is split over k channels).`,
      ``,
      `Merge (OpenPnP must be CLOSED: it rewrites its config when it exits)`,
      `  python merge_into_openpnp.py            -> ~/.openpnp2 (backup made first: *.bak-<time>)`,
      `  python merge_into_openpnp.py <config dir>`,
      `  python merge_into_openpnp.py --undo      -> put back the files from the newest backup`,
      `  It adds these parts and packages by id (one the machine already has is kept, unless an earlier run added it or`,
      `  --replace-existing is given), and replaces every feeder whose id starts with PLAN-.`,
      `  Nothing else in machine.xml is touched. Run it again after re-exporting.`,
      `Then: File > Open Job > ${name}.job.xml.`,
      ``,
      `On the machine`,
      `  1. Board: Job tab, select the board, jog to a fiducial and use "set location" / run the fiducial check.`,
      `  2. Strip feeders: Feeders tab, each PLAN- feeder, "Auto Setup" from the first sprocket holes; check part Z`,
      `     (set to the tape surface: tray top - recess + film) and the part rotation in the tape.`,
      `  3. Parts: check heights marked as guesses, nozzle tips, then pick/place one of each.`,
      notes.length ? `\nNotes\n${notes.map((n) => '  - ' + n).join('\n')}` : '',
      ``,
    ].join('\n');
  }

  const MERGE_PY = String.raw`"""Merge the generated parts, packages and PLAN- strip feeders into an OpenPnP config (OpenPnP must be closed).

    python merge_into_openpnp.py [config dir]      (default: ~/.openpnp2)
    python merge_into_openpnp.py --undo [config dir]   undo the last run (again: the run before it, ...)
    python merge_into_openpnp.py --replace-existing     also overwrite parts / packages the machine already had

Parts and packages are added by id. One that already exists in the config is left alone (the machine's own, tuned
there), unless an earlier run of this script added it (listed in pnp_stand_ids.txt in the config dir) or
--replace-existing is given. Every feeder with an id starting with PLAN- is replaced by the ones in feeders.xml.
A copy of each file is saved as <file>.bak-<time> first. Nothing else is changed.
"""
import re, shutil, sys, time
from pathlib import Path

here = Path(__file__).resolve().parent
args = [a for a in sys.argv[1:] if not a.startswith("--")]
do_undo = "--undo" in sys.argv[1:]
cfg = Path(args[0]) if args else Path.home() / ".openpnp2"
stamp = time.strftime("%Y%m%d-%H%M%S")


def backup(p):
    shutil.copy2(p, p.with_name(p.name + ".bak-" + stamp))


MANIFEST = cfg / "pnp_stand_ids.txt"  # "<tag> <id>" per line: what this script added, so only those get replaced later
replace_existing = "--replace-existing" in sys.argv[1:]


def load_manifest():
    return set(MANIFEST.read_text(encoding="utf-8").splitlines()) if MANIFEST.exists() else set()


def tip_ids():
    # nozzle tip name -> id from this machine's machine.xml: packages list compatible tips by id (NT1, TIP16b1a...),
    # which differ per machine, so the generated files carry the names (N045, N08, ...) and they're resolved here
    m = cfg / "machine.xml"
    if not m.exists():
        return {}
    out = {}
    for tag in re.findall(r"<nozzle-tip\s[^>]*>", m.read_text(encoding="utf-8")):
        i, n = re.search(r'(?<=\s)id="([^"]*)"', tag), re.search(r'(?<=\s)name="([^"]*)"', tag)
        if i:
            out[i.group(1)] = i.group(1)
            if n:
                out.setdefault(n.group(1), i.group(1))
    return out


def resolve_tips(item, tips, missing):
    def one(m):
        name = m.group(1)
        if name in tips:
            return "<string>%s</string>" % tips[name]
        missing.add(name)
        return ""  # unknown on this machine: left out (set it in the Packages tab)
    return re.sub(r"<string>([^<]*)</string>", one, item)


def merge_lib(fname, tag, root, mine):
    new = (here / fname).read_text(encoding="utf-8")
    items = re.findall(r"(<%s\s[^>]*?(?:/>|>[\s\S]*?</%s>))" % (tag, tag), new)
    if tag == "package":
        tips, missing = tip_ids(), set()
        items = [resolve_tips(it, tips, missing) for it in items]
        if missing:
            print("  nozzle tip(s) not on this machine, left unticked: %s" % ", ".join(sorted(missing)))
    dst = cfg / fname
    text = dst.read_text(encoding="utf-8") if dst.exists() else "<%s>\n</%s>\n" % (root, root)
    if dst.exists():
        backup(dst)
    text = text.replace("<%s/>" % root, "<%s>\n</%s>" % (root, root))
    added, updated, kept = 0, 0, []
    for it in items:
        pid = re.search(r'(?<=\s)id="([^"]*)"', it).group(1)
        # (?<=\s)id= : the attribute id, not part-id / package-id; works with id first or later in the tag
        pat = r"\s*<%s\s[^>]*?(?<=\s)id=\"%s\"[^>]*?(?:/>|>[\s\S]*?</%s>)" % (tag, re.escape(pid), tag)
        if re.search(pat, text):
            if "%s %s" % (tag, pid) not in mine and not replace_existing:
                kept.append(pid)  # the machine's own entry (tuned there): leave it alone
                continue
            text = re.sub(pat, "", text)
            updated += 1
        else:
            added += 1
        mine.add("%s %s" % (tag, pid))
        text = text.replace("</%s>" % root, "   %s\n</%s>" % (it, root), 1)
    dst.write_text(text, encoding="utf-8")
    print("%s: %d %s(s) added, %d updated (added by an earlier run)" % (dst, added, tag, updated))
    if kept:
        print("  kept the machine's own %s(s), not replaced: %s" % (tag, ", ".join(kept)))


def merge_feeders():
    dst = cfg / "machine.xml"
    if not dst.exists():
        print("no machine.xml in %s: feeders not merged" % cfg)
        return
    new = (here / "feeders.xml").read_text(encoding="utf-8")
    items = re.findall(r"(<feeder\s[\s\S]*?</feeder>)", new)
    text = dst.read_text(encoding="utf-8")
    backup(dst)
    text, n_old = re.subn(r"\s*<feeder\s[^>]*?(?<=\s)id=\"PLAN-[^\"]*\"[\s\S]*?</feeder>", "", text)
    if "<feeders/>" in text:
        text = text.replace("<feeders/>", "<feeders>\n      </feeders>", 1)
    block = "".join("\n         " + it.strip() for it in items)
    text = re.sub(r"(\n\s*)</feeders>", lambda m: block + m.group(1) + "</feeders>", text, count=1)
    dst.write_text(text, encoding="utf-8")
    print("%s: removed %d old PLAN- feeder(s), added %d" % (dst, n_old, len(items)))


def undo():
    # restore the newest backup set (all files of one run share the same stamp)
    baks = sorted(cfg.glob("*.bak-*"), key=lambda p: p.name.rsplit(".bak-", 1)[1])
    if not baks:
        sys.exit("no *.bak-<time> files in %s: nothing to undo" % cfg)
    last = baks[-1].name.rsplit(".bak-", 1)[1]
    for b in baks:
        if b.name.endswith(".bak-" + last):
            shutil.copy2(b, cfg / b.name.rsplit(".bak-", 1)[0])
            # used up: renamed (kept), so the next --undo steps back one more run
            b.rename(b.with_name(b.name.replace(".bak-", ".undone-")))
            print("restored %s from %s" % (b.name.rsplit(".bak-", 1)[0], b.name))
    print("Undone one run (backup kept as *.undone-%s). Run --undo again to go back further. Start OpenPnP." % last)


if __name__ == "__main__":
    if not cfg.is_dir():
        sys.exit("config dir not found: %s" % cfg)
    if do_undo:
        undo()
        sys.exit(0)
    mine = load_manifest()
    # the id list is backed up too (empty if this is the first run), so --undo forgets what it added
    MANIFEST.with_name(MANIFEST.name + ".bak-" + stamp).write_text("\n".join(sorted(mine)), encoding="utf-8")
    merge_lib("parts.xml", "part", "openpnp-parts", mine)
    merge_lib("packages.xml", "package", "openpnp-packages", mine)
    merge_feeders()
    MANIFEST.write_text("\n".join(sorted(mine)), encoding="utf-8")
    print("Done. Start OpenPnP and open the .job.xml.")
`;

  const api = { VERSION, packageInfo, partIdOf, boardPlacements, boardXml, jobXml, partsXml, packagesXml, stripFeederXml, trayFeederXml, project, MERGE_PY };
  if (node) module.exports = api;
  else root.PnpOpenPnP = api;
})(typeof window !== 'undefined' ? window : globalThis);
