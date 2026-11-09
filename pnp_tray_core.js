/*
 * pnp_tray_core.js: cut-tape trays for the LumenPnP staging plates (no DOM; Node-testable).
 *
 * BOM CSV -> one line per reel (same grouping as tools/bom_reels.py, series rule MS-07) -> one section of cut tape per
 * line. A section is a label block (engraved line number) followed by a channel the tape strip lies in. Sections of
 * the same tape width can share a lane end to end; lanes sit side by side in a tray. Each tray has an end cap at both
 * ends, centred on a grid row, with M3 bolts into the plate holes under it (nut on top, like the stands).
 *
 * Tray frame: a = along the lanes (machine +X), c = across (machine +Y), z up from the plate top. Lane sprocket holes
 * are on the low-c (front) side of each lane.
 *
 * Needs pnp_stand_core.js (grid, keep-outs, digits(), STL/zip writers): window.PnpStand or require().
 */
(function (root) {
  'use strict';
  const S = typeof module !== 'undefined' && module.exports ? require('./pnp_stand_core.js') : root.PnpStand;
  const { distPointRect, rectsOverlap, distSegRect } = S._;

  const VERSION = 4;

  // ------------------------------------------------------------------ tray parameters
  const DEFAULT_TRAY = {
    boards: 1,          // boards per run
    spares: 2,          // extra parts per line (cut tape is never exact)
    leader: 1,          // empty pockets at the start of each strip
    endClr: 1.5,        // slack at the end of each section, mm
    minSection: 16,     // shortest section (tape region), mm: room to handle the strip and for 3+ sprocket holes
    chClr: 0.3,         // channel = tape width + this
    rib: 1.6,           // wall between lanes
    sideWall: 2.0,      // outer wall along the tray
    base: 1.2,          // plastic under the deepest pocket relief
    recessPaper: 1.0,   // paper tape: channel floor this far below the tray top
    recessEmb: 0.6,     // embossed tape: shoulder (carrier film) this far below the top
    groove: 2.6,        // embossed tape: relief for the pockets, below the shoulder
    labelBlock: 4.0,    // solid block at the start of each section, carries the engraved line number
    labelH: 3.0,
    labelDepth: 0.5,
    maxTrayW: 90,       // widest tray (across the lanes)
    laneLen: 0,         // channel length between the caps; 0 = choose the one using the least plate area
    series: true,       // several sections may share one lane end to end
    gap: 2.0,           // clearance to stands, board, keep-outs and other trays
    holder: 'tray',     // 'tray' = our printed cut-tape trays, 'opulo' = Opulo LumenPnP printed tray feeders
    opTypes: '8:3:40:15 12:3:56.2:15 16:2:48:20 24:1:36 32:1:44', // Opulo feeder per tape width: W:channels:width across[:channel pitch]
    opHave: '',         // feeders you own per width, '8:10 12:2' (empty = no limit)
    opGap: 5,           // gap between two sections in one channel, mm
    opRefill: false,    // a line longer than a channel: false = split over channels, true = one channel, slide more in as it runs out
    opLen: 120,         // Opulo feeder length (all widths)
    opUsable: 116,      // channel length that can hold parts (Opulo: 125 mm strip in the 120 mm feeder, 30 parts at 4 mm; guess)
    opOrient: 90,       // 90 = channels run front to back across the plate (bolts like A15 + G15), 180 = along the rows
    opZ: 9.0,           // pick Z above the plate top. Host: tray feeders at Z 14.0-14.9 with the board top at 16.0 (8.6 + 1.6 above the plate): ~9 (teach it)
  };

  // ------------------------------------------------------------------ BOM
  /** Minimal RFC 4180 CSV parser -> array of rows (arrays of strings) */
  function parseCsv(text) {
    const rows = [];
    let row = [], f = '', q = false;
    text = String(text).replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = '';
        if (row.some((c) => c !== '')) rows.push(row);
        row = [];
      } else f += ch;
    }
    row.push(f);
    if (row.some((c) => c !== '')) rows.push(row);
    return rows;
  }

  const MULT = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, R: 1, r: 1, k: 1e3, K: 1e3, M: 1e6, '': 1 };
  /** Same normalisation as bom_reels.value_key: 100nF = 0.1uF, 4k7 = 4.7k; voltage / dielectric words dropped */
  function valueKey(kind, value) {
    const v = String(value).split('(')[0].trim();
    if ('RCL'.includes(kind) && kind) {
      const m = v.match(/^(\d+(?:\.\d+)?)\s*([pnuµmRrkKM]?)(\d*)/);
      if (m) return String(Number((parseFloat(m[1] + (m[3] ? '.' + m[3] : '')) * MULT[m[2]]).toPrecision(6))); // 100 * 1e-9 != 0.1 * 1e-6
    }
    return v ? v.split(/\s+/)[0] : v;
  }
  const refKind = (ref) => { const m = String(ref).match(/^#?([A-Z]+)/); const k = m ? m[1] : ''; return ['R', 'C', 'L'].includes(k) ? k : '*'; };
  const splitRefs = (s) => String(s).split(/[,\s]+/).filter(Boolean);

  /**
   * KiCad BOM CSV (Designator/Refs/Reference, Value, Footprint, Qty, Manufacturer, MPN, DNP) -> reel lines.
   * Lines are numbered 1..n in BOM order; that number is engraved on the section.
   */
  function parseBom(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('empty CSV');
    const hdr = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => hdr.findIndex((h) => names.includes(h));
    const iRef = col('designator', 'refs', 'reference', 'references', 'ref'), iVal = col('value', 'val');
    const iFp = col('footprint', 'package'), iQty = col('qty', 'quantity'), iMpn = col('mpn', 'manufacturer part number');
    const iMfr = col('manufacturer', 'mfr'), iDnp = col('dnp', 'do not populate');
    if (iRef < 0 || iVal < 0 || iFp < 0) throw new Error('need Designator/Refs, Value and Footprint columns (found: ' + rows[0].join(', ') + ')');
    const groups = new Map(), skipped = [];
    for (const r of rows.slice(1)) {
      const refs = splitRefs(r[iRef]);
      if (!refs.length) continue;
      const value = (r[iVal] || '').trim(), fpFull = (r[iFp] || '').trim();
      const dnp = iDnp >= 0 && /^(1|y|yes|true|dnp|x)$/i.test((r[iDnp] || '').trim());
      if (dnp || /\bDNP\b/i.test(value)) { skipped.push(refs.join(',') + ' (DNP)'); continue; }
      if (!fpFull || /Castellated|MountingHole|Fiducial|TestPoint/i.test(fpFull)) { skipped.push(refs.join(',') + ' (board only)'); continue; }
      const kind = refKind(refs[0]);
      const fp = fpFull.split(':').pop();
      const key = kind + '|' + valueKey(kind, value) + '|' + fp;
      const qty = iQty >= 0 && isFinite(parseFloat(r[iQty])) ? parseFloat(r[iQty]) : refs.length;
      if (!groups.has(key)) groups.set(key, { refs: [], values: [], footprint: fp, qty: 0, mpn: [], mfr: [] });
      const g = groups.get(key);
      g.refs.push(...refs); g.qty += qty;
      if (!g.values.includes(value)) g.values.push(value);
      const mpn = iMpn >= 0 ? (r[iMpn] || '').trim() : '';
      if (mpn && !g.mpn.includes(mpn)) g.mpn.push(mpn);
      const mfr = iMfr >= 0 ? (r[iMfr] || '').trim() : '';
      if (mfr && !g.mfr.includes(mfr)) g.mfr.push(mfr);
    }
    const lines = [...groups.values()].map((g, i) => {
      const t = tapeFor(g.footprint);
      return { id: i + 1, refs: g.refs, value: g.values.join(' / '), footprint: g.footprint, qty: g.qty, mpn: g.mpn.join(' / '), mfr: g.mfr.join(' / '),
        use: t.use, tapeW: t.tapeW, pitch: t.pitch, carrier: t.carrier, tapeNote: t.note };
    });
    return { lines, skipped };
  }

  /** BOM lines straight from the board's footprints (SMD, not DNP / board-only / excluded from pos), same grouping */
  function linesFromParts(parts) {
    const q = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    const rows = ['"Designator","Value","Footprint","Qty","Manufacturer","MPN","DNP"'];
    for (const p of parts || []) {
      if (!p.ref || p.ref.startsWith('#') || !p.smd || p.excludePos || p.boardOnly || p.dnp) continue;
      rows.push([p.ref, p.value, p.footprint, 1, p.mfr, p.mpn, ''].map(q).join(','));
    }
    return parseBom(rows.join('\n'));
  }

  const isDigiKeyOrder = (text) => /DigiKey Part #/.test(String(text).split(/\r?\n/, 1)[0]);
  /**
   * DigiKey order CSV -> the board's lines with Qty = quantity ordered (trays hold everything ordered: use boards = 1,
   * spares = 0). Each order line is matched to a board line by MPN, else by value + package from the description.
   * Board lines with no order line are left out of the trays. Returns { lines, skipped, report: [string], unmatched }.
   */
  function applyOrder(boardLines, orderText) {
    const rows = parseCsv(orderText), H = rows[0].map((h) => h.trim()), c = (n) => H.indexOf(n);
    const iMpn = c('Manufacturer Part Number'), iDesc = c('Description'), iQty = c('Quantity'), iMfr = c('Manufacturer');
    if (iMpn < 0 || iQty < 0) throw new Error('not a DigiKey order CSV (need Manufacturer Part Number and Quantity)');
    const lines = boardLines.map((l) => ({ ...l, qty: 0, use: false, ordered: false }));
    const norm = (s) => String(s).replace(/\s+/g, '').toUpperCase();
    const pkgOf = (d) => (d.match(/\b(0201|0402|0603|0805|1206|1210|1008)\b/) || [])[1];
    const valOf = (d) => {
      let m = d.match(/^CAP\S* (?:CER )?(\d+(?:\.\d+)?)\s*([PNU])F/i) || d.match(/\b(\d+(?:\.\d+)?)([PNU])F\b/i);
      if (m && /^CAP/i.test(d)) return { kind: 'C', key: valueKey('C', m[1] + m[2].toLowerCase() + 'F') };
      m = d.match(/^RES (\d+(?:\.\d+)?)([KM]?) OHM/i);
      if (m) return { kind: 'R', key: valueKey('R', m[1] + (m[2] || 'R')) };
      return null;
    };
    const report = [], unmatched = [];
    for (const r of rows.slice(1)) {
      const mpn = (r[iMpn] || '').trim(), qty = parseFloat(r[iQty]);
      if (!mpn || !isFinite(qty)) continue; // subtotal rows
      const desc = iDesc >= 0 ? r[iDesc] || '' : '';
      let l = lines.find((x) => !x.ordered && x.mpn && x.mpn.split(' / ').some((y) => norm(y) === norm(mpn))), how = 'MPN';
      const v = valOf(desc), pkg = pkgOf(desc);
      if (!l && v) { l = lines.find((x) => !x.ordered && refKind(x.refs[0]) === v.kind && valueKey(v.kind, x.value.split(' / ')[0]) === v.key && (!pkg || x.footprint.includes('_' + pkg + '_'))); how = 'value + package'; }
      if (!l) { unmatched.push(`${mpn} (${desc})`); continue; }
      const sub = l.mpn && !l.mpn.split(' / ').some((y) => norm(y) === norm(mpn)) ? `; substitution for ${l.mpn}` : '';
      Object.assign(l, { qty, use: tapeFor(l.footprint).use, ordered: true, orderMpn: mpn, mfr: iMfr >= 0 ? r[iMfr] : l.mfr, mpn: mpn });
      report.push(`#${l.id} ${l.value.split(' / ')[0]}: ${qty} ordered (${mpn}, by ${how}${sub})`);
    }
    const missing = lines.filter((l) => !l.ordered).map((l) => `#${l.id} ${l.value}`);
    return { lines, skipped: [], report, unmatched, missing };
  }

  // ------------------------------------------------------------------ tape defaults (EIA-481 typical; check the datasheet)
  /** footprint name -> { tapeW, pitch, carrier: 'paper'|'embossed', use, note } */
  function tapeFor(fp) {
    const f = String(fp);
    const T = (tapeW, pitch, carrier, note, use = true) => ({ tapeW, pitch, carrier, note: note || '', use });
    if (/QFP|BGA|LGA|PLCC/i.test(f)) return T(24, 16, 'embossed', 'usually a JEDEC tray, not tape', false);
    if (/^(R|C|L)_0201_/.test(f)) return T(8, 2, 'paper');
    if (/^(R|C|L|LED|D|Fuse)_0402_/.test(f)) return T(8, 2, 'paper');
    if (/^(R|C|L|Fuse)_0603_/.test(f)) return T(8, 4, 'paper');
    if (/^LED_0603_/.test(f)) return T(8, 4, 'embossed');
    if (/^R_(0805|1206)_/.test(f)) return T(8, 4, 'paper');
    if (/^(C|L|LED|D|Fuse)_(0805|1206|1210|1008|1812)_/.test(f)) return T(8, 4, 'embossed', /^C_/.test(f) ? 'paper if the cap is ≤ 0.85 mm thick' : '');
    if (/SOD-(123|323|523|923)/.test(f)) return T(8, 4, 'embossed');
    if (/D_SMA\b|D_SMA_|D_SMA$/.test(f)) return T(12, 4, 'embossed');
    if (/D_SMB/.test(f)) return T(12, 8, 'embossed');
    if (/D_SMC/.test(f)) return T(16, 8, 'embossed');
    if (/SOT-(23|323|353|363|523|553|563|583|723|883)|SC-70|SC-88/.test(f)) return T(8, 4, 'embossed');
    if (/SOT-(89|223)|TO-252|DPAK/.test(f)) return T(12, 8, 'embossed');
    if (/SOIC-8|SO-8|MSOP|VSSOP|TSSOP-(8|10)\b/.test(f)) return T(12, 8, 'embossed');
    if (/SOIC-(14|16)|TSSOP|SSOP/.test(f)) return T(16, 8, 'embossed');
    if (/PTS810/.test(f)) return T(12, 8, 'embossed', 'guess: check the C&K tape drawing');
    if (/Samtec|Conn|Connector|FTR|TFM|Header/i.test(f)) return T(24, 16, 'embossed', 'guess: connectors vary, check the datasheet');
    // body size from the footprint name (QFN/SON/DFN/crystals/oscillators): "..._3.2x2.5mm..."
    const m = f.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/);
    if (m) {
      const big = Math.max(+m[1], +m[2]);
      if (big <= 3.3) return T(8, 4, 'embossed', 'from body size');
      if (big <= 5.5) return T(12, 8, 'embossed', 'from body size');
      if (big <= 7.5) return T(16, 12, 'embossed', 'from body size');
      return T(24, 16, 'embossed', 'from body size');
    }
    return T(8, 4, 'embossed', 'unknown package: guessed 8 mm / 4 mm');
  }
  /** EIA-481: pocket centre line from the tape's sprocket edge (sprocket row at 1.75 + F) */
  const pocketFromEdge = (W) => 1.75 + ({ 8: 3.5, 12: 5.5, 16: 7.5, 24: 11.5, 32: 14.2, 44: 20.2 }[W] || (W / 2 - 0.25));

  // ------------------------------------------------------------------ sections, lanes, trays
  /** Parts in the section and its tape length (without the label block) */
  function sectionOf(line, tp) {
    const count = Math.ceil(line.qty * tp.boards) + tp.spares;
    const tape = Math.max(tp.minSection, (count + tp.leader) * line.pitch + tp.endClr);
    return { id: line.id, line, count, tape, unit: tp.labelBlock + tape, tapeW: line.tapeW, chW: line.tapeW + tp.chClr,
      recess: line.carrier === 'paper' ? tp.recessPaper : tp.recessEmb, groove: line.carrier === 'paper' ? 0 : tp.groove };
  }

  /** Cap size from the bolt pocket (same nut / head settings as the stands) */
  function capOf(sp, tp) {
    const pocketR = sp.pocket === 'hex' ? (sp.nutAF + sp.pocketClr) / Math.sqrt(3) : sp.pocket === 'round' ? (sp.headD + sp.pocketClr) / 2 : sp.boltD / 2;
    return { pocketR, capW: Math.max(10, 2 * (pocketR + sp.wall)), boltMargin: pocketR + 1.0 };
  }

  /** first-fit decreasing: items {size}, capacity -> bins [[item...]] */
  function ffd(items, size, cap) {
    const bins = [];
    for (const it of items.slice().sort((a, b) => size(b) - size(a))) {
      const b = bins.find((x) => x.used + size(it) <= cap + 1e-9);
      if (b) { b.items.push(it); b.used += size(it); } else bins.push({ items: [it], used: size(it) });
    }
    return bins;
  }

  /** Lane width in a tray including the rib after it; tray width = 2*sideWall - rib + sum */
  const trayWidth = (lanes, tp) => 2 * tp.sideWall + lanes.reduce((a, l) => a + l.chW, 0) + Math.max(0, lanes.length - 1) * tp.rib;

  /**
   * Pack the used lines into trays. Returns { trays, sections, Lc, problems }.
   * Lc (channel length between the caps) is k*pitch - capW so both caps sit on grid rows.
   */
  function pack(lines, tp, sp, m) {
    const P = m.P, { capW } = capOf(sp, tp);
    const sections = lines.filter((l) => l.use).map((l) => sectionOf(l, tp));
    const problems = [];
    if (!sections.length) return { trays: [], sections, problems: ['no lines ticked for trays'], tp };
    const maxRows = m.nRows - 1;
    const kOf = (len) => Math.ceil((len + capW) / P.pitch - 1e-9);
    const longest = Math.max(...sections.map((s) => s.unit));
    const kMin = kOf(longest);
    if (kMin > maxRows) problems.push(`a section is ${longest.toFixed(0)} mm long: longer than the plates allow; split it or lower the board count`);
    const innerW = tp.maxTrayW - 2 * tp.sideWall + tp.rib; // each lane takes chW + rib
    const wide = sections.filter((s) => s.chW + tp.rib > innerW + 1e-9);
    if (wide.length) problems.push(`tape too wide for the max tray width: line ${wide.map((s) => s.id).join(', ')}`);

    const build = (k) => { // all trays share Lc = k*pitch - capW
      const Lc = k * P.pitch - capW;
      let lanes = [];
      if (tp.series) {
        const byW = new Map();
        for (const s of sections) { if (!byW.has(s.tapeW)) byW.set(s.tapeW, []); byW.get(s.tapeW).push(s); }
        for (const [, list] of byW) for (const b of ffd(list, (s) => s.unit, Lc)) lanes.push(laneOf(b.items, tp));
      } else lanes = sections.map((s) => laneOf([s], tp));
      const trays = ffd(lanes, (l) => l.chW + tp.rib, innerW).map((b, i) => trayOf(b.items, Lc, k, tp, sp, i));
      return trays;
    };
    const areaOf = (trays) => trays.reduce((a, t) => a + t.L * t.W, 0) + trays.length * 200; // small cost per extra tray
    const cands = []; // every layout tried, for plan() to fall back on when the smallest doesn't fit on the plates
    let best = null;
    if (tp.laneLen > 0) best = build(Math.max(kMin, kOf(tp.laneLen)));
    else if (!tp.series) {
      // one section per lane: trays grouped by length (longest first), each tray as short as its longest lane
      const lanes = sections.map((s) => laneOf([s], tp)).sort((a, b) => b.used - a.used);
      const trays = [];
      for (const l of lanes) {
        let t = trays.find((x) => x.w + l.chW + tp.rib <= innerW + 1e-9);
        if (!t) { t = { lanes: [], w: 0, k: kOf(l.used) }; trays.push(t); }
        t.lanes.push(l); t.w += l.chW + tp.rib;
      }
      best = trays.map((t, i) => trayOf(t.lanes, t.k * P.pitch - capW, t.k, tp, sp, i));
    } else {
      let bestArea = Infinity;
      for (let k = kMin; k <= maxRows; k++) {
        const trays = build(k), area = areaOf(trays);
        cands.push({ trays, area });
        if (area < bestArea - 1e-6) { bestArea = area; best = trays; }
      }
    }
    if (best && !cands.length) cands.push({ trays: best, area: areaOf(best) });
    cands.sort((a, b) => a.area - b.area);
    return { trays: best || [], sections, problems, tp, cands };
  }

  /**
   * Pack and place. Tries the smallest layout first; if a tray finds no spot, the next layouts by area, then the same
   * with narrower trays (2/3 and 1/2 of the max width), until every tray fits. Returns { pk, pl, tried }.
   */
  function plan(lines, tp, sp, m, ko, obst, target, maxTries) {
    const widths = [...new Set([tp.maxTrayW, Math.round(tp.maxTrayW * 2 / 3), Math.round(tp.maxTrayW / 2)].filter((w) => w >= 25))];
    let best = null, tried = 0;
    const limit = maxTries || 24;
    for (const w of widths) {
      const pk = pack(lines, { ...tp, maxTrayW: w }, sp, m);
      if (!pk.trays.length) return { pk, pl: [], tried };
      for (const c of pk.cands.slice(0, Math.ceil(limit / widths.length))) {
        tried++;
        const pl = placeTrays(m, ko, c.trays, obst, tp, sp, target);
        const fails = pl.filter((p) => !p || !p.ok).length;
        const r = { pk: { ...pk, trays: c.trays, maxTrayW: w }, pl, fails, area: c.area };
        if (!best || fails < best.fails || (fails === best.fails && c.area < best.area)) best = r;
        if (!fails) return { ...r, tried };
      }
    }
    return { ...best, tried };
  }

  function laneOf(secs, tp) {
    const sorted = secs.slice().sort((a, b) => a.id - b.id);
    return { sections: sorted, tapeW: sorted[0].tapeW, chW: Math.max(...sorted.map((s) => s.chW)), used: sorted.reduce((a, s) => a + s.unit, 0) };
  }

  /** Tray geometry in its own frame: lanes at c offsets, sections at a offsets, heights */
  function trayOf(lanes, Lc, k, tp, sp, index) {
    const { capW } = capOf(sp, tp);
    // own copies: pack() tries several lane lengths on the same sections, and the offsets below are per tray
    lanes = lanes.map((l) => ({ ...l, sections: l.sections.map((s) => ({ ...s })) })).sort((a, b) => b.tapeW - a.tapeW || a.sections[0].id - b.sections[0].id);
    let c = tp.sideWall;
    const depth = Math.max(...lanes.flatMap((l) => l.sections.map((s) => s.recess + s.groove)));
    const T = tp.base + depth;                                  // tray top
    const Tc = Math.max(T, sp.pocketFloor + (sp.nutH != null ? sp.nutH : tp.nutH || 4)); // cap top (room for the nut; nut height is a stand setting)
    for (const l of lanes) {
      l.c0 = c; l.c1 = c + l.chW; c = l.c1 + tp.rib;
      let a = capW;
      for (const s of l.sections) { s.a0 = a; s.aTape = a + tp.labelBlock; s.a1 = a + s.unit; a = s.a1; }
    }
    const W = trayWidth(lanes, tp);
    return { index, num: index + 1, lanes, Lc, k, capW, L: Lc + 2 * capW, W, T, Tc };
  }

  // ------------------------------------------------------------------ placement on the plates
  /** Distinct row X positions, ascending */
  function rowXs(m) {
    if (!m._rowXs) m._rowXs = [...new Set(m.holes.map((h) => +h.x.toFixed(4)))].sort((a, b) => a - b);
    return m._rowXs;
  }
  /** existing holes at one row x, sorted by y (cached on the machine) */
  function rowHoles(m, x) {
    if (!m._rowHoles) {
      m._rowHoles = new Map();
      for (const h of m.holes) if (h.exists) {
        const k = h.x.toFixed(4);
        if (!m._rowHoles.has(k)) m._rowHoles.set(k, []);
        m._rowHoles.get(k).push(h);
      }
      for (const l of m._rowHoles.values()) l.sort((a, b) => a.y - b.y);
    }
    return m._rowHoles.get((+x).toFixed(4)) || [];
  }

  /** Bolts available in a cap at row x, for a tray spanning y0..y1: the outermost free holes (max 2) */
  function capBolts(m, ko, x, y0, y1, margin) {
    const hs = rowHoles(m, x).filter((h) => !ko.blocked.has(h.name) && h.y >= y0 + margin && h.y <= y1 - margin);
    return hs.length > 2 ? [hs[0], hs[hs.length - 1]] : hs;
  }

  /** Check one tray position: j = row index (ascending X) of cap A, y0 = tray low edge. Returns {ok, rect, bolts, why} */
  function tryTray(m, ko, tray, j, y0, obst, tp, sp) {
    const xs = rowXs(m), { capW, boltMargin } = capOf(sp, tp);
    if (j < 0 || j + tray.k >= xs.length) return { ok: false, why: 'off the plates' };
    const xA = xs[j], xB = xs[j + tray.k];
    const rect = { x0: xA - capW / 2, x1: xB + capW / 2, y0, y1: y0 + tray.W };
    const ex = m.extent;
    if (rect.x0 < ex.x0 || rect.x1 > ex.x1 || rect.y0 < ex.y0 || rect.y1 > ex.y1) return { ok: false, rect, why: 'off the plates' };
    if (m.P.gap > 0.5 && !m.plates.some((p) => rect.y0 >= p.y0 && rect.y1 <= p.y1)) return { ok: false, rect, why: 'across the gap between plates' };
    const bA = capBolts(m, ko, xA, rect.y0, rect.y1, boltMargin), bB = capBolts(m, ko, xB, rect.y0, rect.y1, boltMargin);
    if (!bA.length || !bB.length) return { ok: false, rect, why: 'no free grid hole under a cap' };
    const why = blockedWhy(m, ko, rect, obst, tp.gap);
    if (why) return { ok: false, rect, why };
    return { ok: true, rect, bolts: [...bA, ...bB], j, y0, xA, xB };
  }

  /** Why a rect on the plates collides (keep-outs, plate screws, obstacles within gap), or '' if it's free */
  function blockedWhy(m, ko, rect, obst, g) {
    for (const z of ko.zones.concat(m.screws)) {
      const hit = z.type === 'circle' ? distPointRect(z, rect) < z.r + g : rectsOverlap({ x0: z.x0 - g, y0: z.y0 - g, x1: z.x1 + g, y1: z.y1 + g }, rect);
      if (hit) return `over ${z.label}`;
    }
    for (const r of obst.rects) if (rectsOverlap({ x0: r.x0 - g, y0: r.y0 - g, x1: r.x1 + g, y1: r.y1 + g }, rect)) return `over ${r.label}`;
    for (const poly of obst.polys) for (let i = 0; i < poly.pts.length; i++) {
      if (distSegRect(poly.pts[i], poly.pts[(i + 1) % poly.pts.length], rect) < g) return `over ${poly.label}`;
    }
    return '';
  }

  /**
   * Place trays one by one (largest first), nearest the target point. obst = { rects:[{x0..y1,label}], polys:[{pts,label}] }
   * fixed: { [trayNum]: {j, y0} } keeps user-moved trays where they are.
   */
  function placeTrays(m, ko, trays, obst, tp, sp, target, fixed) {
    const out = new Array(trays.length).fill(null);
    const placed = { rects: obst.rects.slice(), polys: obst.polys };
    const xs = rowXs(m), ex = m.extent;
    const order = trays.map((t, i) => i).sort((a, b) => trays[b].L * trays[b].W - trays[a].L * trays[a].W);
    // user-fixed first, so the others go around them
    for (const i of order) {
      const f = fixed && fixed[trays[i].num];
      if (!f) continue;
      const r = tryTray(m, ko, trays[i], f.j, f.y0, placed, tp, sp);
      out[i] = { ...r, fixed: true, j: f.j, y0: f.y0 };
      if (r.rect) placed.rects.push({ ...r.rect, label: 'tray ' + trays[i].num });
    }
    for (const i of order) {
      if (out[i]) continue;
      const t = trays[i];
      let best = null;
      for (let j = 0; j + t.k < xs.length; j++) {
        for (let y0 = ex.y0; y0 + t.W <= ex.y1 + 1e-9; y0 += 1) {
          const r = tryTray(m, ko, t, j, y0, placed, tp, sp);
          if (!r.ok) continue;
          const cx = (r.rect.x0 + r.rect.x1) / 2, cy = (r.rect.y0 + r.rect.y1) / 2;
          const cost = Math.hypot(cx - target.x, cy - target.y) + 0.05 * (r.rect.x1 - r.rect.x0);
          if (!best || cost < best.cost) best = { ...r, cost };
        }
      }
      out[i] = best || { ok: false, why: 'no free spot on the plates' };
      if (best) placed.rects.push({ ...best.rect, label: 'tray ' + t.num });
    }
    return out;
  }

  /**
   * Per-section ballparks for the setup sheet / OpenPnP: first part centre on the plates (machine mm, plate frame),
   * tape surface height, feed direction. To be taught on the machine.
   */
  function sectionCoords(tray, pos, tp) {
    const rows = [];
    for (const l of tray.lanes) for (const s of l.sections) {
      const W = s.tapeW, cSprocketEdge = l.c0 + tp.chClr / 2;
      const firstPart = s.aTape + (tp.leader + 0.5) * s.line.pitch;
      const surface = tray.T - s.recess + (s.line.carrier === 'paper' ? 0.8 : 0.3);
      rows.push({
        id: s.id, tray: tray.num, lane: tray.lanes.indexOf(l) + 1, count: s.count, tape: s.tape,
        x: pos ? pos.rect.x0 + firstPart : null, y: pos ? pos.rect.y0 + cSprocketEdge + pocketFromEdge(W) : null,
        sprocketY: pos ? pos.rect.y0 + cSprocketEdge + 1.75 : null, z: surface,
        xEnd: pos ? pos.rect.x0 + s.a1 : null,
      });
    }
    return rows;
  }

  // ------------------------------------------------------------------ Opulo LumenPnP printed tray feeders
  // opulo.io sells them as "LumenPnP Strip Feeder"; Opulo's docs set them up in OpenPnP as ReferenceTrayFeeders (pick
  // location + per-part offset + count, no sprocket vision), so cut tape can start anywhere in a channel.
  // 8 and 12 mm hold 3 channels, 16 mm 2, 24 / 32 mm 1; all 120 mm long; two M3 screws into grid holes (e.g. A15 + G15).
  // Width across: 8 mm 40, 12 mm 56.2 (Opulo's FreeCAD, src/FDM/*-strip-feeder.FCStd); channel pitch 15 mm (the CAD's
  // 3 x 15 mm channel pattern; the LumenPnP host's own tray feeders sit 14.9 mm apart). 16 / 24 / 32 mm are guesses.
  // The base has a 15 mm hole grid, so any plate holes under it can take the screws.

  /** "8:3:40:15 12:3:56.2:15 ..." -> { 8: {tapeW, strips (channels), across, pitch}, ... }; pitch 0 / missing = across / channels */
  function opuloTypes(text) {
    const out = {};
    for (const tok of String(text || '').split(/[\s,;]+/)) {
      const m = tok.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/);
      if (m) out[+m[1]] = { tapeW: +m[1], strips: +m[2], across: +m[3], pitch: m[4] && +m[4] > 0 ? +m[4] : +m[3] / +m[2] };
    }
    return out;
  }
  /** "8:10 12:2" -> { 8: 10, 12: 2 } feeders you own per tape width */
  function opuloHave(text) {
    const out = {};
    for (const tok of String(text || '').split(/[\s,;]+/)) { const m = tok.match(/^(\d+):(\d+)$/); if (m) out[+m[1]] = +m[2]; }
    return out;
  }

  /**
   * Same length rule as our trays: a section per ticked line, (parts + empty pockets) x pitch + slack (min shortest
   * section); parts = qty x boards + spares. A line longer than a channel is split over channels. Sections of one tape
   * width go end to end in channels (first-fit decreasing, tp.opGap between them), channels fill feeders of that width.
   * Returns { feeders: [{num, tapeW, type, channels:[{sections:[{id, line, k, of, count, tape, a0, a1}], used}], len, across}],
   *           sections, counts, need, have, problems }
   */
  function opuloPack(lines, tp) {
    const partsIn = (c) => c.sections.reduce((a, s) => a + s.count + (s.refill || 0), 0);
    const types = opuloTypes(tp.opTypes), have = opuloHave(tp.opHave), problems = [], secs = [], counts = {};
    const usable = Math.min(tp.opUsable, tp.opLen);
    for (const l of lines.filter((x) => x.use)) {
      const s0 = sectionOf(l, tp);
      counts[l.id] = s0.count;
      const t = types[l.tapeW];
      if (!t) { problems.push(`#${l.id} ${l.value.split(' / ')[0]}: no Opulo feeder type for ${l.tapeW} mm tape (add one to the feeder types)`); continue; }
      const cap = Math.max(1, Math.floor((usable - tp.endClr) / l.pitch) - tp.leader); // parts in one full channel
      if (tp.opRefill && s0.count > cap) {
        // one full channel; the rest is slid in as parts run out (reset the feeder count each time)
        secs.push({ id: l.id, line: l, k: 1, of: 1, count: cap, cap, total: s0.count, refill: s0.count - cap, tapeW: l.tapeW, tape: usable });
        continue;
      }
      const n = Math.max(1, Math.ceil(s0.count / cap));
      for (let k = 0; k < n; k++) {
        const count = Math.min(cap, s0.count - k * cap);
        secs.push({ id: l.id, line: l, k: k + 1, of: n, count, cap, tapeW: l.tapeW, tape: Math.min(usable, Math.max(tp.minSection, (count + tp.leader) * l.pitch + tp.endClr)) });
      }
    }
    const feeders = [];
    for (const W of [...new Set(secs.map((s) => s.tapeW))].sort((a, b) => a - b)) {
      const t = types[W];
      // a gap after every section; the channel takes usable + one gap so the last section needs none
      // TODO(pack) FFD can leave a near-empty channel (MONK panel: one 8 mm channel holds only a 16 mm section) that
      //   costs a whole feeder; try a few orderings / a small search when the channel count is one over a multiple of 3.
      const bins = ffd(secs.filter((s) => s.tapeW === W), (s) => s.tape + tp.opGap, usable + tp.opGap);
      const channels = bins.map((b) => {
        const sections = b.items.slice().sort((x, y) => x.id - y.id || x.k - y.k);
        let a = 0;
        for (const s of sections) { s.a0 = a; s.a1 = a + s.tape; a = s.a1 + tp.opGap; }
        return { sections, used: a - tp.opGap };
      }).sort((x, y) => partsIn(y) - partsIn(x) || x.sections[0].id - y.sections[0].id); // busiest channels share the first feeders
      for (let i = 0; i < channels.length; i += t.strips) feeders.push({ tapeW: W, type: t, channels: channels.slice(i, i + t.strips), len: tp.opLen, across: t.across, usable });
    }
    // busiest feeder first: placeOpulo places in this order, so it gets the spot nearest the bottom camera
    feeders.forEach((f) => { f.parts = f.channels.reduce((a, c) => a + partsIn(c), 0); });
    feeders.sort((a, b) => b.parts - a.parts || a.tapeW - b.tapeW);
    feeders.forEach((f, i) => { f.index = i; f.num = i + 1; f.channels.forEach((c, k) => { c.num = k + 1; c.sections.forEach((s) => { s.feeder = f.num; s.channel = k + 1; }); }); });
    const need = {};
    for (const f of feeders) need[f.tapeW] = (need[f.tapeW] || 0) + 1;
    for (const W of Object.keys(need)) if (have[W] && need[W] > have[W]) problems.push(`needs ${need[W]} × ${W} mm feeders, you have ${have[W]}`);
    return { opulo: true, feeders, sections: secs, counts, need, have, types, problems, tp };
  }

  /** Footprint of one feeder on the plates: dx along the rows (X), dy across (Y) */
  const opuloDims = (f, tp) => (+tp.opOrient === 180 ? { dx: f.len, dy: f.across } : { dx: f.across, dy: f.len });

  /** One feeder position: centre on row j, low edge y0. Two free grid holes under it, as far apart as possible. */
  function tryOpulo(m, ko, f, j, y0, obst, tp) {
    const xs = rowXs(m);
    if (j < 0 || j >= xs.length) return { ok: false, why: 'off the plates' };
    const { dx, dy } = opuloDims(f, tp), xc = xs[j];
    const rect = { x0: xc - dx / 2, x1: xc + dx / 2, y0, y1: y0 + dy };
    const ex = m.extent;
    if (rect.x0 < ex.x0 - 1e-6 || rect.x1 > ex.x1 + 1e-6 || rect.y0 < ex.y0 - 1e-6 || rect.y1 > ex.y1 + 1e-6) return { ok: false, rect, why: 'off the plates' };
    // always on one plate: its two screws go into one plate (A15 + G15 style), never across the seam
    if (!m.plates.some((p) => rect.y0 >= p.y0 - 1e-6 && rect.y1 <= p.y1 + 1e-6)) return { ok: false, rect, why: 'across two plates' };
    const why = blockedWhy(m, ko, rect, obst, tp.gap);
    if (why) return { ok: false, rect, why };
    // other feeders: only no overlap (ends meet at the plate seam, as in Opulo's own two-plate layout)
    for (const r of obst.feeders || []) if (rectsOverlap({ x0: r.x0 + 0.01, y0: r.y0 + 0.01, x1: r.x1 - 0.01, y1: r.y1 - 0.01 }, rect)) return { ok: false, rect, why: 'over ' + r.label };
    const mg = 5; // screw head clear of the feeder's ends and sides
    const hs = m.holes.filter((h) => h.exists && !ko.blocked.has(h.name) && h.x >= rect.x0 + mg && h.x <= rect.x1 - mg && h.y >= rect.y0 + mg && h.y <= rect.y1 - mg);
    let best = null;
    for (let a = 0; a < hs.length; a++) for (let b = a + 1; b < hs.length; b++) {
      const d = Math.hypot(hs[a].x - hs[b].x, hs[a].y - hs[b].y);
      // far apart, and on the feeder's centre line when possible (Opulo's own: A15 + G15 for a feeder on row 15)
      const score = d - 2 * (Math.abs(hs[a].x - xc) + Math.abs(hs[b].x - xc)) / m.P.pitch;
      if (d >= 30 && (!best || score > best.score)) best = { score, bolts: [hs[a], hs[b]] };
    }
    if (!best) return { ok: false, rect, why: 'no two free grid holes under it' };
    return { ok: true, rect, bolts: best.bolts, j, y0, xc };
  }

  /** Place feeders one by one nearest the target; fixed: { [num]: {j, y0} } keeps user-moved feeders where they are */
  function placeOpulo(m, ko, feeders, obst, tp, target, fixed) {
    // every pick goes feeder -> bottom camera -> board; camera -> board is the same for all parts, so the time that
    // depends on the layout is feeder -> camera: aim at the camera (else the target), busiest feeder placed first
    const aim = ko.camera ? { x: ko.camera.x, y: ko.camera.y } : target;
    const out = new Array(feeders.length).fill(null);
    const placed = { rects: obst.rects.slice(), polys: obst.polys, feeders: [] };
    const xs = rowXs(m), ex = m.extent;
    for (const f of feeders) {
      const fx = fixed && fixed[f.num];
      if (!fx) continue;
      const r = tryOpulo(m, ko, f, fx.j, fx.y0, placed, tp);
      out[f.index] = { ...r, fixed: true, j: fx.j, y0: fx.y0 };
      if (r.rect) placed.feeders.push({ ...r.rect, label: 'feeder O' + f.num });
    }
    for (const f of feeders) {
      if (out[f.index]) continue;
      const { dy } = opuloDims(f, tp);
      let best = null;
      for (let j = 0; j < xs.length; j++) {
        for (let y0 = ex.y0; y0 + dy <= ex.y1 + 1e-9; y0 += 1) {
          const r = tryOpulo(m, ko, f, j, y0, placed, tp);
          if (!r.ok) continue;
          const cy = (r.rect.y0 + r.rect.y1) / 2;
          const cost = Math.hypot(r.xc - aim.x, cy - aim.y);
          if (!best || cost < best.cost) best = { ...r, cost };
        }
      }
      out[f.index] = best || { ok: false, why: 'no free spot on the plates' };
      if (best) placed.feeders.push({ ...best.rect, label: 'feeder O' + f.num });
    }
    return out;
  }

  /**
   * Where each section's channel runs on the plates (plate frame), and the tray-feeder numbers for OpenPnP.
   * Channels at the type's pitch about the feeder centre line. 90 deg: channels run along Y, first part at the back,
   * the next ones toward the front (offset -pitch in Y, as the LumenPnP host's own tray feeders). 180 deg: along X, first
   * part at the left, offset +pitch in X. first = the first part (after the empty pockets); the pocket's offset from the
   * channel centre line is not modelled (teach it). Returns [{sec, channel, first:{x,y}, offset:{x,y}, n, lane:{a0,a1 in mm on the plates}, c, z}]
   */
  function opuloCoords(f, pos, tp) {
    const n = f.type.strips, rows = [], r = pos.rect, along180 = +tp.opOrient === 180;
    const end = (f.len - f.usable) / 2; // unusable length at each end of a channel
    f.channels.forEach((ch, i) => {
      const off = (i - (n - 1) / 2) * f.type.pitch;
      const c = along180 ? (r.y0 + r.y1) / 2 + off : (r.x0 + r.x1) / 2 + off;
      for (const s of ch.sections) {
        const p = s.line.pitch, firstA = s.a0 + (tp.leader + 0.5) * p;
        const row = { sec: s, channel: i + 1, n: s.count, z: tp.opZ, c };
        if (along180) Object.assign(row, { first: { x: r.x0 + end + firstA, y: c }, offset: { x: p, y: 0 }, lane: { a0: r.x0 + end + s.a0, a1: r.x0 + end + s.a1 } });
        else Object.assign(row, { first: { x: c, y: r.y1 - end - firstA }, offset: { x: 0, y: -p }, lane: { a0: r.y1 - end - s.a1, a1: r.y1 - end - s.a0 } });
        rows.push(row);
      }
    });
    return rows;
  }

  /** Feeder / channel / section table as CSV */
  function opuloCsv(lines, op, placements) {
    const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const hdr = ['feeder', 'tape W', 'channel', 'line', 'value', 'footprint', 'refs', 'mpn', 'section k of n', 'parts', 'cut length mm', 'starts at mm', 'pitch', 'carrier', 'bolts', 'first part X', 'first part Y', 'note'];
    const out = [];
    for (const f of op.feeders) {
      const p = placements && placements[f.index];
      const co = p && p.ok ? opuloCoords(f, p, op.tp) : [];
      for (const ch of f.channels) for (const s of ch.sections) {
        const l = s.line, c = co.find((x) => x.sec === s);
        out.push([`O${f.num}`, f.tapeW, ch.num, l.id, l.value, l.footprint, l.refs.join(' '), l.mpn, `${s.k}/${s.of}`, s.count, s.tape.toFixed(0), s.a0.toFixed(0), l.pitch, l.carrier,
          p && p.ok ? p.bolts.map((b) => b.name).join(' + ') : 'not placed', c ? c.first.x.toFixed(1) : '', c ? c.first.y.toFixed(1) : '', [s.refill ? `refill: ${s.refill} more` : '', l.tapeNote].filter(Boolean).join('; ')].map(esc).join(','));
      }
    }
    for (const l of lines.filter((x) => !x.use)) out.push(['', l.tapeW, '', l.id, l.value, l.footprint, l.refs.join(' '), l.mpn, '', '', '', '', l.pitch, l.carrier, 'hand place / not in a feeder', '', '', l.tapeNote].map(esc).join(','));
    return hdr.join(',') + '\n' + out.join('\n') + '\n';
  }

  // ------------------------------------------------------------------ solid
  /** Tray solid in its own frame (origin = tray low corner on the plate). bolts: machine holes, rect: tray rect */
  function traySolid(tray, pos, tp, sp, jscad) {
    const { cuboid, cylinder } = jscad.primitives;
    const { extrudeLinear } = jscad.extrusions;
    const { subtract, union } = jscad.booleans;
    const { translate } = jscad.transforms;
    const box = (a0, a1, c0, c1, z0, z1) => cuboid({ center: [(a0 + a1) / 2, (c0 + c1) / 2, (z0 + z1) / 2], size: [a1 - a0, c1 - c0, z1 - z0] });
    const { L, W, T, Tc, capW } = tray;
    const parts = [box(0, L, 0, W, 0, T)];
    if (Tc > T + 1e-6) { parts.push(box(0, capW, 0, W, T - 0.01, Tc)); parts.push(box(L - capW, L, 0, W, T - 0.01, Tc)); }
    let body = parts.length > 1 ? union(...parts) : parts[0];
    const cut = [];
    for (const l of tray.lanes) for (const s of l.sections) {
      // channel for the tape, from the label block to the end of the section (the rest of the lane stays solid)
      cut.push(box(s.aTape, s.a1, l.c0, l.c1, T - s.recess, T + 1));
      if (s.groove > 0) {
        const g0 = l.c0 + tp.chClr / 2 + 3.1, g1 = l.c1 - tp.chClr / 2 - 0.6; // keep the sprocket strip and the far edge supported
        if (g1 - g0 > 1) cut.push(box(s.aTape, s.a1, g0, g1, T - s.recess - s.groove, T + 1));
      }
      // line number on the label block, reading along +c (across the lane)
      const size = Math.min(tp.labelH, tp.labelBlock - 1.0);
      const txt = extrudeLinear({ height: tp.labelDepth + 0.05 }, S.digits(String(s.id), size, [0, 0], jscad));
      // exact quarter turn (x, y) -> (-y, x): rotateZ(pi/2) leaves 1e-17 noise that cracks the engraving
      const quarter = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      cut.push(translate([(s.a0 + s.aTape) / 2, (l.c0 + l.c1) / 2, T - tp.labelDepth], jscad.transforms.transform(quarter, txt)));
    }
    if (pos && pos.bolts) for (const b of pos.bolts) {
      const a = b.x - pos.rect.x0, c = b.y - pos.rect.y0;
      cut.push(cylinder({ center: [a, c, Tc / 2], height: Tc + 2, radius: sp.boltD / 2, segments: 32 }));
      if (sp.pocket !== 'none') {
        const r = capOf(sp, tp).pocketR, dep = Math.max(0.5, Tc - sp.pocketFloor);
        cut.push(cylinder({ center: [a, c, Tc - dep + (dep + 1) / 2], height: dep + 1, radius: r, segments: sp.pocket === 'hex' ? 6 : 40 }));
      }
    }
    return subtract(body, ...cut);
  }

  /** Sections table as CSV */
  function sectionsCsv(lines, pk, placements) {
    const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const coords = new Map();
    pk.trays.forEach((t, i) => sectionCoords(t, placements && placements[i] && placements[i].ok ? placements[i] : null, pk.tp || DEFAULT_TRAY).forEach((r) => coords.set(r.id, r)));
    const hdr = ['line', 'value', 'footprint', 'refs', 'mpn', 'qty/board', 'parts in section', 'tape W', 'pitch', 'carrier', 'tape length mm', 'tray', 'lane', 'first part X', 'first part Y', 'tape surface Z', 'note'];
    const rows = lines.map((l) => {
      const s = pk.sections.find((x) => x.id === l.id), c = coords.get(l.id);
      return [l.id, l.value, l.footprint, l.refs.join(' '), l.mpn, l.qty, s ? s.count : '', l.tapeW, l.pitch, l.carrier, s ? s.tape.toFixed(1) : '',
        c ? c.tray : l.use ? '' : 'not in a tray', c ? c.lane : '', c && c.x != null ? c.x.toFixed(1) : '', c && c.y != null ? c.y.toFixed(1) : '', c ? c.z.toFixed(1) : '', l.tapeNote].map(esc).join(',');
    });
    return hdr.join(',') + '\n' + rows.join('\n') + '\n';
  }

  const api = { VERSION, DEFAULT_TRAY, parseCsv, parseBom, linesFromParts, isDigiKeyOrder, applyOrder, valueKey, tapeFor, pocketFromEdge, sectionOf, capOf, pack, plan, rowXs, rowHoles, capBolts, tryTray, placeTrays, sectionCoords, traySolid, sectionsCsv,
    blockedWhy, opuloTypes, opuloHave, opuloPack, opuloDims, tryOpulo, placeOpulo, opuloCoords, opuloCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PnpTray = api;
})(typeof window !== 'undefined' ? window : globalThis);
