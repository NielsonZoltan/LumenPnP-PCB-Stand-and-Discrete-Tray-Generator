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

  const VERSION = 2;

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
    nutH: 4.0,          // nut height: caps are at least floor-under-nut + this tall
    maxTrayW: 90,       // widest tray (across the lanes)
    laneLen: 0,         // channel length between the caps; 0 = choose the one using the least plate area
    series: true,       // several sections may share one lane end to end
    gap: 2.0,           // clearance to stands, board, keep-outs and other trays
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
    const Tc = Math.max(T, sp.pocketFloor + tp.nutH);           // cap top (room for the nut)
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
    const g = tp.gap;
    for (const z of ko.zones.concat(m.screws)) {
      const hit = z.type === 'circle' ? distPointRect(z, rect) < z.r + g : rectsOverlap({ x0: z.x0 - g, y0: z.y0 - g, x1: z.x1 + g, y1: z.y1 + g }, rect);
      if (hit) return { ok: false, rect, why: `over ${z.label}` };
    }
    for (const r of obst.rects) if (rectsOverlap({ x0: r.x0 - g, y0: r.y0 - g, x1: r.x1 + g, y1: r.y1 + g }, rect)) return { ok: false, rect, why: `over ${r.label}` };
    for (const poly of obst.polys) for (let i = 0; i < poly.pts.length; i++) {
      if (distSegRect(poly.pts[i], poly.pts[(i + 1) % poly.pts.length], rect) < g) return { ok: false, rect, why: `over ${poly.label}` };
    }
    return { ok: true, rect, bolts: [...bA, ...bB], j, y0, xA, xB };
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

  const api = { VERSION, DEFAULT_TRAY, parseCsv, parseBom, linesFromParts, isDigiKeyOrder, applyOrder, valueKey, tapeFor, pocketFromEdge, sectionOf, capOf, pack, plan, rowXs, rowHoles, capBolts, tryTray, placeTrays, sectionCoords, traySolid, sectionsCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PnpTray = api;
})(typeof window !== 'undefined' ? window : globalThis);
