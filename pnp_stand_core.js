/* pnp_stand_core.js: geometry, KiCad import, stand assignment, auto-placement and STL/SCAD export
 * for PCB stands bolted to Opulo LumenPnP staging plates.
 *
 * Runs in the browser (pnp_stand.html) and in Node (test_core.js). No DOM access here.
 *
 * Coordinate systems
 *   Machine: mm, X along the plate length (row numbers), Y across the plates (letters), Y up = toward the rear.
 *   PCB:     mm, (u, v) from the board's bounding-box lower-left, v up (KiCad's y is flipped on import).
 *
 * Staging plate grid (from the plates and Alethea Flowers' OpenSCAD recreation of the plate):
 *   600 x 120 mm plate, 15 mm pitch both ways, first row/column 15 mm in from the edge, so 39 rows x 7 letters.
 *   Holes form a checkerboard: a hole exists where (letter index + row) is odd (A1 counts as 0 + 1).
 *   Calipers on the machine: 30.3 mm along a letter column (2 rows), 21.1 mm diagonal (15*sqrt2 = 21.2).
 */
(function (root) {
  'use strict';

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  // ------------------------------------------------------------------ machine profiles
  const PROFILES = {
    'v3.1': {
      label: 'LumenPnP v3 / v3.1 (bottom camera in the plate)',
      plate: { length: 600, width: 120, pitch: 15, edge: 15, holeD: 3.4, gap: 0, screwInset: 10, screwKeepD: 11 },
      row1: 'left',
      plates: [
        { name: 'Lower (front)', lower: true, prefix: '', aAt: 'front' },
        { name: 'Upper (rear)', lower: false, prefix: '', aAt: 'rear' },
      ],
      keepouts:
        '# Bottom camera hole + ring light (plate centre = row 20, letter D).\n' +
        '# Move this to the plate the camera is in on your machine (d20 = lower, D20 = upper).\n' +
        'camera d20 52\n' +
        '# Datum board / nozzle tips etc.: add a rect between two holes, e.g.\n' +
        '# rect d16 g19\n',
    },
    'v4': {
      label: 'LumenPnP v4 (camera moved off the plate)',
      plate: { length: 600, width: 120, pitch: 15, edge: 15, holeD: 3.4, gap: 0, screwInset: 10, screwKeepD: 11 },
      row1: 'left',
      plates: [
        { name: 'Lower (front)', lower: true, prefix: '', aAt: 'front' },
        { name: 'Upper (rear)', lower: false, prefix: '', aAt: 'rear' },
      ],
      keepouts:
        '# v4: the bottom camera sits beside the plates, so no camera hole here.\n' +
        '# Add anything bolted to the plates (datum board, nozzle holder, strip feeders):\n' +
        '# rect d16 g19\n',
    },
  };

  // ------------------------------------------------------------------ small math helpers
  const hyp = (x, y) => Math.sqrt(x * x + y * y);
  const dist = (a, b) => hyp(a.x - b.x, a.y - b.y);

  function distPointSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return hyp(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function segsIntersect(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    return o1 !== o2 && o3 !== o4 && o1 !== 0 && o3 !== 0;
  }
  function distSegSeg(a, b, c, d) {
    if (segsIntersect(a, b, c, d)) return 0;
    return Math.min(distPointSeg(a, c, d), distPointSeg(b, c, d), distPointSeg(c, a, b), distPointSeg(d, a, b));
  }
  function pointInRect(p, r) { return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1; }
  function distPointRect(p, r) {
    const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1), dy = Math.max(r.y0 - p.y, 0, p.y - r.y1);
    return hyp(dx, dy);
  }
  function distSegRect(a, b, r) {
    if (pointInRect(a, r) || pointInRect(b, r)) return 0;
    const c = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
    let m = Infinity;
    for (let i = 0; i < 4; i++) m = Math.min(m, distSegSeg(a, b, c[i], c[(i + 1) % 4]));
    return m;
  }
  function rectsOverlap(a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }
  function pointInTri(p, a, b, c) {
    const s = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  }

  // ------------------------------------------------------------------ plates and grid
  /** cfg: { plate:{length,width,pitch,edge,holeD,gap,screwInset,screwKeepD}, row1:'left'|'right', plates:[{name,lower,prefix,aAt}] } */
  function buildMachine(cfg) {
    const P = cfg.plate;
    const nRows = Math.round((P.length - 2 * P.edge) / P.pitch) + 1;
    const nCols = Math.round((P.width - 2 * P.edge) / P.pitch) + 1;
    const plates = [];
    const holes = [];            // every grid position (exists=false for the empty checkerboard squares)
    const byName = new Map();
    const screws = [];
    cfg.plates.forEach((pl, p) => {
      const y0 = p * (P.width + P.gap);
      plates.push({ index: p, name: pl.name, x0: 0, x1: P.length, y0, y1: y0 + P.width, cfg: pl });
      for (let k = 1; k <= nRows; k++) {
        const x = cfg.row1 === 'right' ? P.length - P.edge - (k - 1) * P.pitch : P.edge + (k - 1) * P.pitch;
        for (let i = 0; i < nCols; i++) {
          const y = pl.aAt === 'rear' ? y0 + P.width - P.edge - i * P.pitch : y0 + P.edge + i * P.pitch;
          const L = LETTERS[i];
          const name = (pl.prefix || '') + (pl.lower ? L.toLowerCase() : L) + k;
          const h = { name, x, y, plate: p, i, k, exists: (i + k) % 2 === 1 };
          holes.push(h);
          if (!byName.has(name)) byName.set(name, h);
        }
      }
      const s = P.screwInset;
      for (const [sx, sy] of [[s, s], [P.length - s, s], [P.length - s, P.width - s], [s, P.width - s]])
        screws.push({ type: 'circle', x: sx, y: y0 + sy, r: P.screwKeepD / 2, label: 'plate screw' });
    });
    const extent = { x0: 0, y0: 0, x1: P.length, y1: plates.length ? plates[plates.length - 1].y1 : 0 };
    const index = new Map(); // spatial hash of existing holes, cell = pitch
    for (const h of holes) if (h.exists) {
      const key = Math.round(h.x / P.pitch) + ',' + Math.round(h.y / P.pitch);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(h);
    }
    return { cfg, P, nRows, nCols, plates, holes, byName, screws, extent, index };
  }

  /** existing holes within r of (x,y) */
  function holesNear(m, x, y, r) {
    const P = m.P, out = [];
    const c0 = Math.floor((x - r) / P.pitch), c1 = Math.ceil((x + r) / P.pitch);
    const d0 = Math.floor((y - r) / P.pitch), d1 = Math.ceil((y + r) / P.pitch);
    for (let a = c0; a <= c1; a++) for (let b = d0; b <= d1; b++) {
      const l = m.index.get(a + ',' + b);
      if (l) for (const h of l) if (hyp(h.x - x, h.y - y) <= r) out.push(h);
    }
    return out;
  }

  function findHole(m, name) {
    name = String(name).trim();
    if (m.byName.has(name)) return m.byName.get(name);
    return null;
  }

  /**
   * Keep-out / block list. One entry per line, '#' starts a comment.
   *   camera <hole> <dia>          circle keep-out, also the "near camera" target for auto-placement
   *   circle <hole> <dia>          circle keep-out centred on a grid position
   *   rect <hole> <hole> [margin]  rectangle spanning two grid positions, grown by margin (default 7.5 = half pitch)
   *   block <hole> [<hole> ...]    holes that can't take a bolt (screws, strip-feeder holders, ...)
   *   circle@ <x> <y> <dia>        same, machine mm
   *   rect@ <x0> <y0> <x1> <y1>
   */
  function parseKeepouts(m, text) {
    const zones = [], blocked = new Set(), errors = [];
    let camera = null;
    const H = (n, ln) => { const h = findHole(m, n); if (!h) errors.push(`line ${ln}: unknown hole "${n}"`); return h; };
    String(text || '').split(/\r?\n/).forEach((raw, idx) => {
      const ln = idx + 1;
      const line = raw.replace(/#.*/, '').trim();
      if (!line) return;
      const t = line.split(/[\s,]+/);
      const kw = t[0].toLowerCase();
      const num = (s) => { const v = parseFloat(s); if (!isFinite(v)) errors.push(`line ${ln}: bad number "${s}"`); return v; };
      if (kw === 'camera' || kw === 'circle') {
        const h = H(t[1], ln); if (!h) return;
        const z = { type: 'circle', x: h.x, y: h.y, r: num(t[2]) / 2, label: kw === 'camera' ? 'camera' : t[1] };
        zones.push(z); if (kw === 'camera') camera = z;
      } else if (kw === 'rect') {
        const a = H(t[1], ln), b = H(t[2], ln); if (!a || !b) return;
        const g = t[3] !== undefined ? num(t[3]) : m.P.pitch / 2;
        zones.push({ type: 'rect', x0: Math.min(a.x, b.x) - g, y0: Math.min(a.y, b.y) - g, x1: Math.max(a.x, b.x) + g, y1: Math.max(a.y, b.y) + g, label: t[1] + '-' + t[2] });
      } else if (kw === 'block') {
        for (const n of t.slice(1)) { const h = H(n, ln); if (h) blocked.add(h.name); }
      } else if (kw === 'circle@') {
        zones.push({ type: 'circle', x: num(t[1]), y: num(t[2]), r: num(t[3]) / 2, label: 'zone' });
      } else if (kw === 'rect@') {
        const [x0, y0, x1, y1] = t.slice(1, 5).map(num);
        zones.push({ type: 'rect', x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), label: 'zone' });
      } else errors.push(`line ${ln}: unknown keyword "${t[0]}"`);
    });
    return { zones, blocked, camera, errors };
  }

  // ------------------------------------------------------------------ KiCad import
  function parseSexpr(text) {
    const stack = [[]];
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 40) { const a = []; stack[stack.length - 1].push(a); stack.push(a); i++; }       // (
      else if (c === 41) { stack.pop(); i++; }                                                       // )
      else if (c === 34) {                                                                           // "
        let j = i + 1, s = '';
        while (j < n && text.charCodeAt(j) !== 34) {
          if (text.charCodeAt(j) === 92) { s += text[j + 1]; j += 2; } else { s += text[j]; j++; }
        }
        stack[stack.length - 1].push(s); i = j + 1;
      } else if (c <= 32) i++;
      else {
        let j = i;
        while (j < n) { const d = text.charCodeAt(j); if (d <= 32 || d === 40 || d === 41) break; j++; }
        stack[stack.length - 1].push(text.slice(i, j)); i = j;
      }
    }
    return stack[0][0];
  }
  const kids = (node, head) => node.filter((x) => Array.isArray(x) && x[0] === head);
  const kid = (node, head) => node.find((x) => Array.isArray(x) && x[0] === head);
  const xy = (node) => (node ? { x: parseFloat(node[1]), y: parseFloat(node[2]) } : null);

  function arcPoints(s, mpt, e, segs) {
    // circle through three points, sampled from s through m to e
    const ax = s.x, ay = s.y, bx = mpt.x, by = mpt.y, cx = e.x, cy = e.y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return [s, e];
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r = hyp(ax - ux, ay - uy);
    const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
    const norm = (a) => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
    let sweep = norm(a1 - a0);
    if (norm(am - a0) > sweep) sweep = sweep - 2 * Math.PI; // goes the other way round
    const out = [];
    for (let k = 0; k <= segs; k++) { const a = a0 + (sweep * k) / segs; out.push({ x: ux + r * Math.cos(a), y: uy + r * Math.sin(a) }); }
    return out;
  }

  /** Graphic item on Edge.Cuts → polyline (array of {x,y}) in the given transform */
  function edgeShape(node, T) {
    const head = node[0].replace(/^(gr|fp)_/, '');
    const P = (k) => T(xy(kid(node, k)));
    if (head === 'line') return [P('start'), P('end')];
    if (head === 'rect') {
      const a = xy(kid(node, 'start')), b = xy(kid(node, 'end'));
      return [T(a), T({ x: b.x, y: a.y }), T(b), T({ x: a.x, y: b.y }), T(a)];
    }
    if (head === 'arc') {
      const s = xy(kid(node, 'start')), mid = xy(kid(node, 'mid')), e = xy(kid(node, 'end'));
      if (mid) return arcPoints(s, mid, e, 24).map(T);
      // KiCad 5 arcs: (start = centre) (end = start point) (angle)
      const ang = parseFloat((kid(node, 'angle') || [0, 90])[1]) * Math.PI / 180, r = hyp(e.x - s.x, e.y - s.y);
      const a0 = Math.atan2(e.y - s.y, e.x - s.x), out = [];
      for (let k = 0; k <= 24; k++) { const a = a0 + (ang * k) / 24; out.push(T({ x: s.x + r * Math.cos(a), y: s.y + r * Math.sin(a) })); }
      return out;
    }
    if (head === 'circle') {
      const c = xy(kid(node, 'center')), e = xy(kid(node, 'end')), r = hyp(e.x - c.x, e.y - c.y), out = [];
      for (let k = 0; k <= 48; k++) { const a = (2 * Math.PI * k) / 48; out.push(T({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })); }
      return out;
    }
    if (head === 'poly') {
      const pts = kid(node, 'pts');
      const l = pts ? kids(pts, 'xy').map(xy).map(T) : [];
      if (l.length) l.push(l[0]);
      return l;
    }
    if (head === 'curve') {
      const pts = kid(node, 'pts');
      return pts ? kids(pts, 'xy').map(xy).map(T) : [];
    }
    return null;
  }
  const isEdge = (node) => { const l = kid(node, 'layer'); return l && l[1] === 'Edge.Cuts'; };

  /** Parse a .kicad_pcb text into a PCB model; minDrill filters out vias-in-pads / mouse bites. */
  function importKicadPcb(text, name, opts) {
    const minDrill = (opts && opts.minDrill) || 1.0;
    const tree = parseSexpr(text);
    if (!tree || tree[0] !== 'kicad_pcb') throw new Error('not a .kicad_pcb file');
    const I = (p) => p;
    const polylines = [];
    const holes = [];
    const parts = [];  // every footprint, for the OpenPnP board file (positions in KiCad coordinates for now)
    const skipped = new Map(); // "what Ø" → count, for the import report
    const skip = (what, d) => { const k = `${what} Ø${d.toFixed(2)}`; skipped.set(k, (skipped.get(k) || 0) + 1); };
    let vias = 0;
    for (const node of tree) {
      if (Array.isArray(node) && node[0] === 'via') vias++;
      if (!Array.isArray(node)) continue;
      if (/^gr_(line|arc|rect|circle|poly|curve)$/.test(node[0]) && isEdge(node)) {
        const s = edgeShape(node, I); if (s && s.length) polylines.push(s);
      }
      if (node[0] === 'footprint' || node[0] === 'module') {
        const fpName = typeof node[1] === 'string' ? node[1] : '';
        const at = kid(node, 'at');
        const fx = parseFloat(at[1]), fy = parseFloat(at[2]), fr = (parseFloat(at[3]) || 0) * Math.PI / 180;
        const c = Math.cos(fr), s = Math.sin(fr);
        const T = (p) => ({ x: fx + p.x * c + p.y * s, y: fy - p.x * s + p.y * c });
        let ref = '', value = '', mpn = '', mfr = '';
        for (const pr of kids(node, 'property')) {
          if (pr[1] === 'Reference') ref = pr[2]; if (pr[1] === 'Value') value = pr[2];
          if (pr[1] === 'MPN') mpn = pr[2]; if (pr[1] === 'Manufacturer') mfr = pr[2];
        }
        for (const ft of kids(node, 'fp_text')) { if (ft[1] === 'reference') ref = ft[2]; if (ft[1] === 'value') value = ft[2]; }
        {
          const attr = kid(node, 'attr') || [], lay = kid(node, 'layer');
          const has = (w) => attr.includes(w) || !!kid(node, w);
          parts.push({ ref, value, mpn, mfr, footprint: fpName, x: fx, y: fy, rot: parseFloat(at[3]) || 0, side: lay && lay[1] === 'B.Cu' ? 'Bottom' : 'Top',
            smd: attr.includes('smd'), tht: attr.includes('through_hole'), boardOnly: has('board_only'), excludePos: has('exclude_from_pos_files'), dnp: has('dnp') });
        }
        for (const g of node) {
          if (!Array.isArray(g)) continue;
          if (/^fp_(line|arc|rect|circle|poly|curve)$/.test(g[0]) && isEdge(g)) {
            const sh = edgeShape(g, T); if (sh && sh.length) polylines.push(sh);
          }
          if (g[0] === 'pad') {
            const type = g[2];
            const dr = kid(g, 'drill');
            if (!dr) continue;
            const nums = dr.slice(1).filter((t) => typeof t === 'string' && /^[-\d.]+$/.test(t)).map(parseFloat);
            if (!nums.length) continue;
            const d = Math.min(...nums);
            const mountish = /mount|hole|tooling/i.test(fpName) || /^(H|MH|TH|MTG)\d+$/i.test(ref);
            const what = type === 'np_thru_hole' ? 'NPTH' : 'plated pad';
            if (d < minDrill) { skip(what + ' under the min', d); continue; }
            if (!(type === 'np_thru_hole' || (type === 'thru_hole' && mountish))) { skip('plated pad, not a mounting-hole footprint,', d); continue; }
            const p = T(xy(kid(g, 'at')));
            holes.push({ ref: ref || '', x: p.x, y: p.y, d, fpName, mountish, np: type === 'np_thru_hole' });
          }
        }
      }
    }
    if (!polylines.length) throw new Error('no Edge.Cuts outline found; enter the board size by hand');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of polylines) for (const p of l) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const U = (p) => ({ u: +(p.x - minX).toFixed(4), v: +(maxY - p.y).toFixed(4) });
    // de-duplicate holes at the same spot (e.g. MountingHole_Pad with a centre pad)
    const uniq = [];
    for (const h of holes) if (!uniq.some((q) => Math.abs(q.x - h.x) < 0.05 && Math.abs(q.y - h.y) < 0.05)) uniq.push(h);
    const anyMountish = uniq.some((h) => h.mountish);
    let n = 0;
    const outHoles = uniq.map((h) => ({
      ref: h.ref || 'TH' + (++n), ...U(h), d: h.d,
      use: anyMountish ? h.mountish : h.np,
      note: h.fpName || (h.np ? 'NPTH' : ''),
    }));
    const setup = kid(tree, 'setup');
    const aux = setup ? xy(kid(setup, 'aux_axis_origin')) : null;
    const report = [`${outHoles.length} hole(s) ≥ Ø${minDrill} kept.`];
    if (skipped.size) report.push('Skipped: ' + [...skipped].map(([k, n]) => `${n} × ${k}`).join(', ') + '.');
    if (vias) report.push(`${vias} vias ignored.`);
    return {
      name: name || 'board',
      W: +(maxX - minX).toFixed(4), H: +(maxY - minY).toFixed(4),
      outline: polylines.map((l) => l.map(U)),
      holes: outHoles,
      // u/v from the board's lower-left (bbox), v up, like the holes; rot as KiCad shows it (= the .pos file)
      parts: parts.map((q) => ({ ...q, ...U(q), x: undefined, y: undefined })),
      mode: outHoles.some((h) => h.use) ? 'holes' : 'corners',
      corners: [true, true, true, true],
      report: report.join(' '),
      thickness: (() => { const g = kid(tree, 'general'), t = g && kid(g, 'thickness'); return t ? parseFloat(t[1]) : null; })(),
      origins: { bboxLL: { u: 0, v: 0 }, page: U({ x: 0, y: 0 }), aux: aux && (aux.x || aux.y) ? U(aux) : null },
    };
  }

  function rectPcb(W, H, holes, name) {
    return {
      name: name || 'board', W, H,
      outline: [[{ u: 0, v: 0 }, { u: W, v: 0 }, { u: W, v: H }, { u: 0, v: H }, { u: 0, v: 0 }]],
      holes: holes || [], mode: 'holes', corners: [true, true, true, true], report: '',
      origins: { bboxLL: { u: 0, v: 0 }, page: null, aux: null },
    };
  }

  // ------------------------------------------------------------------ placement transform
  /**
   * place: {cx, cy, rot, flip} with rot in degrees (multiples of 90). flip = bottom side up (second pass of a
   * double-sided board): the board is turned over about its v axis, so u mirrors before the rotation.
   */
  function toMachine(pcb, place, u, v) {
    const a = (place.rot * Math.PI) / 180, c = Math.round(Math.cos(a) * 1e9) / 1e9, s = Math.round(Math.sin(a) * 1e9) / 1e9;
    const dx = (place.flip ? pcb.W - u : u) - pcb.W / 2, dy = v - pcb.H / 2;
    return { x: place.cx + dx * c - dy * s, y: place.cy + dx * s + dy * c };
  }
  function pcbRect(pcb, place) {
    const q = ((place.rot % 180) + 180) % 180 === 90;
    const w = q ? pcb.H : pcb.W, h = q ? pcb.W : pcb.H;
    return { x0: place.cx - w / 2, x1: place.cx + w / 2, y0: place.cy - h / 2, y1: place.cy + h / 2 };
  }

  // ------------------------------------------------------------------ stand parameters
  const DEFAULT_STAND = {
    height: 10,        // plate top to PCB bottom, mm. 10 = used on the LumenPnP (2 boards): body 8 + step-up 2
    wall: 2.0,         // material around holes / pockets
    boltD: 3.6,        // M3 clearance (measured screw 2.89; 3.4 printed tight)
    pocket: 'hex',     // 'hex' nut trap at the top, 'round' counterbore for a screw head, 'none'
    nutAF: 5.34,       // nut across flats as measured (pocketClr is added)
    headD: 5.5,        // M3 socket head
    nutH: 4.0,         // nut height as measured; the stand pocket and the tray caps must take it
    pocketClr: 0.3,
    pocketFloor: 1.93, // plastic left under the nut / screw head; the pocket fills the body above it
    bolts: 2,          // 1 = can swing about its bolt; 2 = second bolt locks the angle
    iface: 'pin',      // 'pin' printed locating pin, 'hole' blind hole (dowel / screw / heat-set insert)
    pinClr: 0.25,      // pin = PCB hole - 2*clr (0.15 printed tight)
    pcbThick: 1.6,     // board thickness (read from the .kicad_pcb); sets the pin length and the corner wall height
    pinAbove: 0.3,     // pin tip above the board's top face (negative = stops inside the hole)
    ifaceHoleD: 0,     // 'hole' mode diameter, 0 = PCB hole diameter
    ifaceHoleDepth: 6,
    padMin: 3.5,       // min radius of the support pad under the PCB hole
    maxArm: 26,        // max distance PCB hole → bolt
    maxPair: 31,       // max distance between the two bolts of one stand
    underPenalty: 4,   // cost added for a bolt hidden under the PCB
    standGap: 1.0,     // min gap between two stands
    stepH: 2.0,        // step-up: body top sits this far below the PCB; only a boss (or the corner pad) reaches it. 0 = flat
    bossD: 0,          // boss under the pin / blind hole, 0 = auto (fixing + 2 x 1.4 mm, min 4.5)
    label: true,       // engrave the stand number (1 = board lower-left, counting anticlockwise) into the top
    labelH: 4.5,
    labelDepth: 0.6,
    cornerPad: 6,      // corner mode: square support under the board corner
    cornerGap: 0.2,    // corner mode: board edge to wall clearance
    cornerWall: 1.6,   // corner mode: L-wall thickness
    lipBelow: 0.4,     // corner mode: wall top this far below the board's top face
    underClear: 0,     // tallest part on the board's down-facing side (2nd pass of a double-sided board), 0 = none
  };

  /**
   * Bolt presets for the stand / tray-cap bolts: clearance hole (printed, so ~0.2-0.6 over nominal), nut across flats
   * and height (ISO 4032), socket head diameter (ISO 4762). The pocket clearance is added on top. "M3 measured" = our nuts.
   */
  const BOLT_PRESETS = {
    m3measured: { label: 'M3 (our nuts, measured)', boltD: 3.6, nutAF: 5.34, nutH: 4.0, headD: 5.5 },
    m3: { label: 'M3 ISO', boltD: 3.6, nutAF: 5.5, nutH: 2.4, headD: 5.5 },
    m2: { label: 'M2 ISO', boltD: 2.4, nutAF: 4.0, nutH: 1.6, headD: 3.8 },
    m25: { label: 'M2.5 ISO', boltD: 3.0, nutAF: 5.0, nutH: 2.0, headD: 4.5 },
    m4: { label: 'M4 ISO', boltD: 4.6, nutAF: 7.0, nutH: 3.2, headD: 7.0 },
  };

  /**
   * Stand settings with the derived values filled in: pinLen, cornerLip from the board thickness; stepH raised to
   * clear parts under the board; height raised if the step-up no longer leaves 2.5 mm of body. notes says what moved.
   */
  function effectiveStand(sp) {
    const e = { ...DEFAULT_STAND, ...sp };
    const notes = [];
    e.pinLen = Math.max(0.6, e.pcbThick + e.pinAbove);
    e.cornerLip = Math.max(0.4, e.pcbThick - e.lipBelow);
    if (e.underClear > 0 && e.stepH < e.underClear + 0.5) {
      e.stepH = e.underClear + 0.5;
      notes.push(`step-up raised to ${e.stepH.toFixed(1)} mm to clear ${e.underClear} mm parts under the board`);
    }
    if (e.stepH > 0 && e.height < e.stepH + 2.5) {
      e.height = e.stepH + 2.5;
      notes.push(`height raised to ${e.height.toFixed(1)} mm to keep 2.5 mm of body under the step-up`);
    }
    if (e.pocket === 'hex' && e.nutH > 0) {
      const room = bodyTop(e) - e.pocketFloor;
      if (room < e.nutH - 1e-6) notes.push(`the ${e.nutH} mm nut sticks out ${(e.nutH - room).toFixed(2)} mm above the stand body: lower the floor under the nut, the step-up, or use a thinner nut`);
    }
    e.notes = notes;
    return e;
  }

  function derived(sp, d, kind) {
    const pocketR = sp.pocket === 'hex' ? (sp.nutAF + sp.pocketClr) / Math.sqrt(3)
      : sp.pocket === 'round' ? (sp.headD + sp.pocketClr) / 2 : sp.boltD / 2;
    const boltPadR = Math.max(pocketR, sp.boltD / 2) + sp.wall;
    if (kind === 'corner') {
      const reach = sp.cornerPad + sp.cornerGap + sp.cornerWall;
      return { pocketR, boltPadR, pinR: 0, ifaceR: 0, bossR: 0, pcbPadR: reach * 0.75, dmin: pocketR + sp.cornerGap + sp.cornerWall + 1.5 };
    }
    const pinR = Math.max(0.4, d / 2 - sp.pinClr);
    const ifaceR = sp.iface === 'pin' ? pinR : (sp.ifaceHoleD || d) / 2;
    const bossR = sp.bossD > 0 ? Math.max(sp.bossD / 2, ifaceR + 0.8) : Math.max(ifaceR + 1.4, 2.25);
    const pcbPadR = Math.max(ifaceR + sp.wall, sp.padMin, sp.stepH > 0 ? bossR + 0.8 : 0);
    const dmin = pocketR + (sp.stepH > 0 ? bossR : ifaceR) + Math.max(1.0, sp.wall * 0.6);
    return { pocketR, boltPadR, pinR, ifaceR, bossR, pcbPadR, dmin };
  }

  // ------------------------------------------------------------------ mounts (holes or board corners)
  const CORNERS = [
    { ref: 'C1', at: (W, H) => [0, 0], inw: [1, 1], name: 'lower-left' },
    { ref: 'C2', at: (W, H) => [W, 0], inw: [-1, 1], name: 'lower-right' },
    { ref: 'C3', at: (W, H) => [W, H], inw: [-1, -1], name: 'upper-right' },
    { ref: 'C4', at: (W, H) => [0, H], inw: [1, -1], name: 'upper-left' },
  ];
  /** The points the stands fix to, in board coords: ticked holes, or the bounding-box corners in corner mode. */
  function mountsOf(pcb) {
    if (pcb.mode === 'corners') {
      const on = pcb.corners || [true, true, true, true];
      return CORNERS.filter((c, i) => on[i]).map((c) => { const [u, v] = c.at(pcb.W, pcb.H); return { ref: c.ref, u, v, d: 0, kind: 'corner', inw: c.inw }; });
    }
    return pcb.holes.filter((h) => h.use).map((h) => ({ ...h, kind: 'hole' }));
  }
  /** Stand number: 1 nearest the board's lower-left, counting anticlockwise (board frame, so rotation doesn't change it). */
  function numberMounts(pcb, mounts) {
    // start at the mount nearest the lower-left corner, then anticlockwise about the board centre
    // (a fixed 225 deg start wrapped a lower-left hole on a wide board to the end)
    const ang = (h) => Math.atan2(h.v - pcb.H / 2, h.u - pcb.W / 2);
    const first = mounts.reduce((b, h) => (Math.hypot(h.u, h.v) < Math.hypot(b.u, b.v) ? h : b), mounts[0]);
    const key = (h) => { let a = ang(h) - (first ? ang(first) : 0); while (a < 0) a += 2 * Math.PI; return h === first ? -1 : a % (2 * Math.PI); };
    const order = mounts.map((h, i) => i).sort((a, b) => key(mounts[a]) - key(mounts[b]));
    order.forEach((i, n) => { mounts[i].num = n + 1; });
    return mounts;
  }
  function rotVec(rot, x, y) {
    const a = (rot * Math.PI) / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
    return [x * c - y * s, x * s + y * c];
  }
  /** Corner stand pieces in machine coords: support square under the board, two L-wall bars outside its edges. */
  function cornerParts(C, inw, sp) {
    const [sx, sy] = inw, s = sp.cornerPad, g = sp.cornerGap, t = sp.cornerWall;
    const R = (xa, ya, xb, yb) => ({ x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: Math.min(ya, yb), y1: Math.max(ya, yb) });
    return {
      support: R(C.x, C.y, C.x + sx * s, C.y + sy * s),
      walls: [
        R(C.x - sx * (g + t), C.y - sy * (g + t), C.x + sx * s, C.y - sy * g),   // along the edge parallel to X
        R(C.x - sx * (g + t), C.y - sy * (g + t), C.x - sx * g, C.y + sy * s),   // along the edge parallel to Y
      ],
    };
  }
  const rectPts = (r) => [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];

  function hullPts(pts) {
    pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  /** 2D outline of a stand's body (machine coords), convex */
  function standOutline(st) {
    const pts = [];
    const circ = (c, r) => { for (let k = 0; k < 48; k++) { const a = (k / 48) * 2 * Math.PI; pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }); } };
    st.bolts.forEach((b) => circ(b, st.D.boltPadR));
    if (st.kind === 'corner') { pts.push(...rectPts(st.parts.support)); st.parts.walls.forEach((w) => pts.push(...rectPts(w))); }
    else circ(st.anchor, st.D.pcbPadR);
    return hullPts(pts);
  }

  // ------------------------------------------------------------------ stand assignment
  function holeOk(m, ko, h) { return h.exists && !ko.blocked.has(h.name); }

  function skeleton(st) {
    const pts = [st.pin, ...st.bolts];
    const segs = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) segs.push([pts[i], pts[j]]);
    if (pts.length === 1) segs.push([pts[0], pts[0]]);
    return { pts, segs };
  }
  function standDist(a, b) {
    let m = Infinity;
    for (const s of a.skel.segs) for (const t of b.skel.segs) m = Math.min(m, distSegSeg(s[0], s[1], t[0], t[1]));
    if (a.skel.pts.length === 3 && b.skel.pts.some((p) => pointInTri(p, ...a.skel.pts))) m = 0;
    if (b.skel.pts.length === 3 && a.skel.pts.some((p) => pointInTri(p, ...b.skel.pts))) m = 0;
    return m;
  }
  function standHitsZones(st, zones) {
    for (const z of zones) for (const [a, b] of st.skel.segs) {
      const R = st.R;
      if (z.type === 'circle' ? distPointSeg(z, a, b) < z.r + R : distSegRect(a, b, z) < R) return z;
    }
    return null;
  }

  /**
   * Candidate stands for one mount. mt: { M:{x,y} machine point, d, kind:'hole'|'corner', inwM:[sx,sy] (corner, machine frame) }
   */
  function candidatesFor(m, ko, sp, mt, rect, zones) {
    const { M, d, kind } = mt;
    const D = derived(sp, d, kind);
    let parts = null, centre = { x: M.x, y: M.y };
    if (kind === 'corner') {
      parts = cornerParts(M, mt.inwM, sp);
      const half = sp.cornerPad / 2 - (sp.cornerGap + sp.cornerWall) / 2;
      centre = { x: M.x + mt.inwM[0] * half, y: M.y + mt.inwM[1] * half };
    }
    let near = holesNear(m, M.x, M.y, sp.maxArm).filter((h) => holeOk(m, ko, h) && dist(h, M) >= D.dmin);
    if (parts) near = near.filter((h) => [parts.support, ...parts.walls].every((r) => distPointRect(h, r) >= D.pocketR + 0.6));
    const under = (h) => (rect && h.x > rect.x0 - D.pocketR && h.x < rect.x1 + D.pocketR && h.y > rect.y0 - D.pocketR && h.y < rect.y1 + D.pocketR) ? 1 : 0;
    const out = [];
    const mk = (bolts, cost) => {
      const st = { kind, anchor: { x: M.x, y: M.y }, pin: centre, parts, inwM: mt.inwM, bolts, d, D, R: Math.max(D.boltPadR, D.pcbPadR), cost };
      st.skel = skeleton(st);
      if (zones && standHitsZones(st, zones)) return;
      st.under = bolts.filter((b) => under(b)).length;
      st.cost += st.under * sp.underPenalty;
      out.push(st);
    };
    if (sp.bolts >= 2) {
      for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
        const a = near[i], b = near[j], ab = dist(a, b);
        if (ab > sp.maxPair) continue;
        // fixing must not sit on the line between the bolts' pockets either
        if (distPointSeg(M, a, b) < 0.5) continue;
        mk([a, b].sort((p, q) => dist(p, M) - dist(q, M)), (dist(a, M) + dist(b, M) + ab) / 2);
      }
    } else for (const h of near) mk([h], dist(h, M));
    out.sort((a, b) => a.cost - b.cost);
    return out;
  }

  /**
   * Full evaluation of a placement: PCB fits, avoids zones, and every used hole gets a stand
   * (distinct bolts, no two stands touching). Small DFS over each hole's best few candidates.
   */
  function mountMachine(pcb, place, h) {
    return { M: toMachine(pcb, place, h.u, h.v), d: h.d, kind: h.kind, inwM: h.inw ? rotVec(place.rot, place.flip ? -h.inw[0] : h.inw[0], h.inw[1]) : null };
  }

  function evaluate(m, ko, pcb, place, sp, opts) {
    const maxCand = (opts && opts.maxCand) || 6;
    const problems = [];
    const rect = pcbRect(pcb, place);
    const zones = ko.zones.concat(m.screws);
    const ex = m.extent;
    if (rect.x0 < ex.x0 || rect.x1 > ex.x1 || rect.y0 < ex.y0 || rect.y1 > ex.y1) problems.push('PCB hangs off the plates');
    for (const z of ko.zones) {
      const hit = z.type === 'circle' ? distPointRect(z, rect) < z.r : rectsOverlap(z, rect);
      if (hit) problems.push(`PCB over keep-out "${z.label}"`);
    }
    const mounts = numberMounts(pcb, mountsOf(pcb));
    if (!mounts.length) problems.push(pcb.mode === 'corners' ? 'no corners ticked' : 'no PCB holes ticked as mounts');
    const lists = mounts.map((h) => {
      const mt = mountMachine(pcb, place, h);
      return { h, M: mt.M, cands: candidatesFor(m, ko, sp, mt, rect, zones).slice(0, maxCand) };
    });
    lists.forEach((l) => { if (!l.cands.length) problems.push(`${l.h.num} (${l.h.ref}): no free grid hole within ${sp.maxArm} mm`); });
    const order = lists.map((l, i) => i).sort((a, b) => lists[a].cands.length - lists[b].cands.length);
    let best = null, bestCost = Infinity, nodes = 0;
    const chosen = new Array(lists.length);
    const used = new Set();
    function rec(depth, cost) {
      if (cost >= bestCost || ++nodes > 30000) return;
      if (depth === order.length) { bestCost = cost; best = chosen.slice(); return; }
      const li = order[depth];
      const l = lists[li];
      if (!l.cands.length) { chosen[li] = null; rec(depth + 1, cost + 1000); return; }
      for (const c of l.cands) {
        if (c.bolts.some((b) => used.has(b.name))) continue;
        let clash = false;
        for (let k = 0; k < depth; k++) {
          const o = chosen[order[k]];
          if (o && standDist(c, o) < c.R + o.R + sp.standGap) { clash = true; break; }
        }
        if (clash) continue;
        chosen[li] = c; c.bolts.forEach((b) => used.add(b.name));
        rec(depth + 1, cost + c.cost);
        c.bolts.forEach((b) => used.delete(b.name));
      }
    }
    rec(0, 0);
    const stands = [];
    if (best) {
      best.forEach((c, i) => { if (c) stands.push({ ...c, ref: lists[i].h.ref, num: lists[i].h.num, hole: lists[i].h }); });
      stands.sort((a, b) => a.num - b.num);
    } else if (lists.length) problems.push('stands collide; try 1 bolt per stand, a longer max arm or another spot');
    if (best && best.some((c) => !c)) { /* problems already listed per hole */ }
    const ok = !problems.length && !!best && best.every(Boolean);
    return { ok, cost: ok ? bestCost : Infinity, stands, problems, rect };
  }

  /**
   * Auto-placement. Scores every position on a raster with a cheap per-hole cost field,
   * then runs the full evaluation on the best few.
   * opts: { rotations:[0,90,180,270], prefer:'here'|'camera'|'front-left'|'any', from:{x,y}, step, radius }
   */
  function autoPlace(m, ko, pcb, sp, opts) {
    const rots = opts.rotations && opts.rotations.length ? opts.rotations : [0, 90, 180, 270];
    const step = opts.step || 1;
    const zones = ko.zones.concat(m.screws);
    const mounts = mountsOf(pcb);
    if (!mounts.length) return { best: null, tried: 0, reason: 'nothing to fix the board by (tick holes or corners)' };
    const target = opts.prefer === 'camera' && ko.camera ? { x: ko.camera.x, y: ko.camera.y }
      : opts.prefer === 'front-left' ? { x: 0, y: 0 }
      : opts.prefer === 'here' && opts.from ? opts.from : null;
    const prefW = opts.prefer === 'any' ? 0.002 : 0.08;
    // cost field: best single-stand cost at a point (ignores collisions and the under-PCB penalty)
    const cache = new Map();
    const fieldCost = (mt) => {
      const key = Math.round(mt.M.x * 2) + ',' + Math.round(mt.M.y * 2) + ',' + mt.d + ',' + (mt.inwM || '');
      let v = cache.get(key);
      if (v === undefined) {
        const c = candidatesFor(m, ko, sp, mt, null, zones);
        v = c.length ? c[0].cost : Infinity;
        cache.set(key, v);
      }
      return v;
    };
    const ex = m.extent;
    const scored = [];
    let tried = 0;
    for (const rot of rots) {
      const place0 = { cx: 0, cy: 0, rot };
      const r0 = pcbRect(pcb, place0);
      const hw = (r0.x1 - r0.x0) / 2, hh = (r0.y1 - r0.y0) / 2;
      let xa = ex.x0 + hw, xb = ex.x1 - hw, ya = ex.y0 + hh, yb = ex.y1 - hh;
      if (opts.prefer === 'here' && opts.from && opts.radius) {
        xa = Math.max(xa, opts.from.x - opts.radius); xb = Math.min(xb, opts.from.x + opts.radius);
        ya = Math.max(ya, opts.from.y - opts.radius); yb = Math.min(yb, opts.from.y + opts.radius);
      }
      for (let cx = xa; cx <= xb + 1e-9; cx += step) for (let cy = ya; cy <= yb + 1e-9; cy += step) {
        tried++;
        const place = { cx, cy, rot, flip: !!opts.flip };
        const rect = { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
        let bad = false;
        for (const z of ko.zones) if (z.type === 'circle' ? distPointRect(z, rect) < z.r : rectsOverlap(z, rect)) { bad = true; break; }
        if (bad) continue;
        let s = 0;
        for (const h of mounts) { s += fieldCost(mountMachine(pcb, place, h)); if (s === Infinity) break; }
        if (s === Infinity) continue;
        if (target) s += prefW * hyp(cx - target.x, cy - target.y);
        scored.push({ s, place });
      }
    }
    scored.sort((a, b) => a.s - b.s);
    let best = null;
    for (const c of scored.slice(0, opts.topK || 60)) {
      const r = evaluate(m, ko, pcb, c.place, sp);
      if (!r.ok) continue;
      const total = r.cost + (target ? prefW * hyp(c.place.cx - target.x, c.place.cy - target.y) : 0);
      if (!best || total < best.total) best = { total, place: c.place, result: r };
    }
    return { best, tried, reason: best ? '' : 'no position fits; relax the stand settings or the keep-outs' };
  }

  // ------------------------------------------------------------------ geometry (JSCAD) and export
  /** Top of the stand body; with a step-up only the boss / corner pad reaches sp.height */
  const bodyTop = (sp) => (sp.stepH > 0 ? Math.max(sp.height - sp.stepH, 2.5) : sp.height);
  /** nut / head pocket depth: everything above the floor, but always at least 0.5 mm of pocket */
  const pocketDepthOf = (sp) => Math.max(0.5, bodyTop(sp) - sp.pocketFloor);

  /**
   * Where the number goes: centred on the longest flat side face of the body, reading from outside.
   * (The top is too crowded on two-bolt stands: pockets at the ends, boss in the middle.)
   * Returns { x, y, ang (deg, text baseline direction), size } in machine coords, or null.
   */
  function labelFace(st, sp) {
    const poly = standOutline(st); // convex, anticlockwise → outward normal is to the right of a→b
    let best = null;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], len = dist(a, b);
      if (!best || len > best.len) best = { a, b, len };
    }
    const Hb = bodyTop(sp);
    const size = Math.min(sp.labelH, Hb - 2.4, best.len - 2);
    if (size < 2.2) return null;
    return { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2, ang: (Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x) * 180) / Math.PI, size };
  }

  /** Stand solid in stand-local coordinates (origin = first bolt). jscad = @jscad/modeling */
  function standSolid(st, sp, jscad) {
    const { cylinder, cylinderElliptic, polygon } = jscad.primitives;
    const { extrudeLinear } = jscad.extrusions;
    const { subtract, union } = jscad.booleans;
    const { translate, rotateX, rotateZ } = jscad.transforms;
    const D = st.D, H = sp.height, Hb = bodyTop(sp), o = st.bolts[0];
    // The solid is built in a frame turned so the label face lies along X, and turned back once at the end with no
    // booleans after it. Cutting the digits into an angled face leaves µm cracks that slicers report as open edges.
    const f = sp.label && st.num ? labelFace(st, sp) : null;
    const ang = f ? (f.ang * Math.PI) / 180 : 0, ca = Math.cos(-ang), sa = Math.sin(-ang);
    const L = (p) => { const x = p.x - o.x, y = p.y - o.y; return [x * ca - y * sa, x * sa + y * ca]; };
    const box = (r, z0, z1) => translate([0, 0, z0], extrudeLinear({ height: z1 - z0 },
      polygon({ points: [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }].map(L) })));
    const outline = polygon({ points: standOutline(st).map(L) });
    const solids = [extrudeLinear({ height: Hb }, outline)];
    const cut = [];
    if (st.kind === 'corner') {
      solids.push(box(st.parts.support, Hb - 0.01, H));
      for (const w of st.parts.walls) solids.push(box(w, 0, H + sp.cornerLip));
      // relief in the wall's inside corner so a sharp board corner seats
      const [sx, sy] = st.inwM, g = sp.cornerGap;
      const c = L({ x: st.anchor.x - sx * g, y: st.anchor.y - sy * g });
      cut.push(cylinder({ center: [c[0], c[1], H + sp.cornerLip / 2], height: sp.cornerLip + 1.2, radius: 0.8, segments: 24 }));
    } else if (sp.stepH > 0) {
      const a = L(st.anchor);
      solids.push(cylinder({ center: [a[0], a[1], (Hb - 0.01 + H) / 2], height: H - Hb + 0.01, radius: D.bossR, segments: 40 }));
    }
    let body = union(...solids);
    for (const b of st.bolts) {
      const c = L(b);
      cut.push(cylinder({ center: [c[0], c[1], H / 2], height: H + 4, radius: sp.boltD / 2, segments: 32 }));
      if (sp.pocket !== 'none') {
        const dep = pocketDepthOf(sp);
        // turned by -ang so the hex keeps the same orientation on the plate as before
        cut.push(translate([c[0], c[1], Hb - dep + (dep + 1) / 2], rotateZ(-ang, cylinder({ height: dep + 1, radius: D.pocketR, segments: sp.pocket === 'hex' ? 6 : 40 }))));
      }
    }
    const a = L(st.anchor);
    if (st.kind !== 'corner' && sp.iface === 'hole') {
      const dep = Math.min(sp.ifaceHoleDepth, H - 0.8);
      cut.push(cylinder({ center: [a[0], a[1], H - dep + (dep + 1) / 2], height: dep + 1, radius: D.ifaceR, segments: 32 }));
    }
    if (f) {
      // text in XY, extruded z ∈ [-depth, 0.05]; rotateX 90° stands it up with the depth pointing into the body (+y),
      // which in this frame is the face's inward direction; centred on the face at half the body height
      const t = translate([0, 0, -sp.labelDepth], extrudeLinear({ height: sp.labelDepth + 0.05 }, digits(String(st.num), f.size, [0, 0], jscad)));
      const c = L(f);
      cut.push(translate([c[0], c[1], Hb / 2], rotateX(Math.PI / 2, t)));
    }
    body = subtract(body, ...cut);
    if (st.kind !== 'corner' && sp.iface === 'pin') {
      const ch = Math.min(0.4, D.pinR * 0.4), shaft = sp.pinLen - ch;
      const p1 = cylinder({ center: [a[0], a[1], H - 0.2 + (shaft + 0.2) / 2], height: shaft + 0.2, radius: D.pinR, segments: 32 });
      const p2 = cylinderElliptic({ center: [a[0], a[1], H + shaft + ch / 2], height: ch, startRadius: [D.pinR, D.pinR], endRadius: [D.pinR - ch, D.pinR - ch], segments: 32 });
      body = union(body, p1, p2);
    }
    return ang ? rotateZ(ang, body) : body;
  }

  /**
   * Seven-segment number as a 2D shape, height `size`, centred on c. Built from rectangles: the stroke font's
   * self-overlapping strokes (6, 8, 9) gave pinched outlines that left open edges in the engraved STL.
   */
  const SEG7 = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g' };
  function digits(str, size, c, jscad) {
    const h = size, w = Math.max(0.6, size * 0.18), cw = size * 0.56, gap = size * 0.22;
    const chars = String(str).split('').filter((ch) => SEG7[ch]);
    const total = chars.length * cw + Math.max(0, chars.length - 1) * gap;
    const rects = [];
    chars.forEach((ch, i) => {
      const x0 = c[0] - total / 2 + i * (cw + gap), y0 = c[1] - h / 2, xm = x0 + cw, ym = y0 + h, yc = y0 + h / 2;
      const R = (ax, ay, bx, by) => rects.push(jscad.primitives.rectangle({ center: [(ax + bx) / 2, (ay + by) / 2], size: [bx - ax, by - ay] }));
      for (const s of SEG7[ch]) {
        if (s === 'a') R(x0, ym - w, xm, ym);
        if (s === 'g') R(x0, yc - w / 2, xm, yc + w / 2);
        if (s === 'd') R(x0, y0, xm, y0 + w);
        if (s === 'f') R(x0, yc - w / 2, x0 + w, ym);
        if (s === 'b') R(xm - w, yc - w / 2, xm, ym);
        if (s === 'e') R(x0, y0, x0 + w, yc + w / 2);
        if (s === 'c') R(xm - w, y0, xm, yc + w / 2);
      }
    });
    if (!rects.length) return jscad.primitives.rectangle({ size: [w, w], center: c });
    return rects.length > 1 ? jscad.booleans.union(...rects) : rects[0];
  }

  /** All stands laid out in a row for printing → array of geom3 */
  function printLayout(stands, sp, jscad) {
    const { translate } = jscad.transforms;
    const { measureBoundingBox } = jscad.measurements;
    const out = [];
    let x = 0;
    for (const st of stands) {
      const g = standSolid(st, sp, jscad);
      const bb = measureBoundingBox(g);
      out.push(translate([x - bb[0][0], -bb[0][1], 0], g));
      x += bb[1][0] - bb[0][0] + 6;
    }
    return out;
  }

  /** Close T-junctions in a triangle soup of one solid. The CSG booleans leave a vertex of one face lying on another
   *  face's edge; slicers see that edge as open. Each triangle with vertices on its edges is re-fanned from its centroid
   *  through those vertices, so every edge is shared by exactly two triangles. */
  function fixTjunctions(tris) {
    // weld: vertices within 1 µm become one (rotations leave copies that differ in the last digits)
    const W = 1e-3, pts = [];
    tris.forEach((t, i) => t.forEach((p, k) => pts.push({ p, i, k })));
    pts.sort((a, b) => a.p[0] - b.p[0]);
    const rep = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i].p;
      let r = p;
      for (let j = i - 1; j >= 0 && p[0] - pts[j].p[0] <= W; j--) {
        const s = pts[j].p;
        if (Math.abs(s[1] - p[1]) <= W && Math.abs(s[2] - p[2]) <= W) { r = rep[j]; break; }
      }
      rep.push(r);
    }
    const welded = tris.map((t) => t.slice());
    pts.forEach((x, n) => { welded[x.i][x.k] = rep[n]; });
    tris = welded.filter((t) => t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]);
    const vset = new Set();
    for (const t of tris) for (const p of t) vset.add(p);
    const V = [...vset].sort((a, b) => a[0] - b[0]);
    const xs = V.map((p) => p[0]);
    const lower = (x) => { let lo = 0, hi = xs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; } return lo; };
    const EPS = 2e-4;
    const onEdge = (a, b) => { // vertices strictly inside segment a-b, ordered from a
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (L2 < 1e-12) return [];
      const out = [];
      for (let i = lower(Math.min(a[0], b[0]) - EPS); i < V.length && V[i][0] <= Math.max(a[0], b[0]) + EPS; i++) {
        const p = V[i], w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
        const s = (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / L2;
        if (s * s * L2 < EPS * EPS || (1 - s) * (1 - s) * L2 < EPS * EPS || s < 0 || s > 1) continue;
        const e = [w[0] - s * d[0], w[1] - s * d[1], w[2] - s * d[2]];
        if (e[0] * e[0] + e[1] * e[1] + e[2] * e[2] < EPS * EPS) out.push([s, p]);
      }
      return out.sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    };
    const out = [];
    for (const t of tris) {
      const ring = [];
      let split = false;
      for (let i = 0; i < 3; i++) {
        ring.push(t[i]);
        const mid = onEdge(t[i], t[(i + 1) % 3]);
        if (mid.length) { split = true; ring.push(...mid); }
      }
      if (!split) { out.push(t); continue; }
      const c = [0, 1, 2].map((k) => (t[0][k] + t[1][k] + t[2][k]) / 3);
      for (let i = 0; i < ring.length; i++) out.push([c, ring[i], ring[(i + 1) % ring.length]]);
    }
    return out;
  }

  /** Binary STL from geom3 list (each geom is one solid, repaired separately) */
  function stlBinary(geoms, jscad) {
    const tris = [];
    for (const g of geoms) {
      const own = [];
      for (const poly of jscad.geometries.geom3.toPolygons(g)) {
        const v = poly.vertices;
        for (let i = 1; i + 1 < v.length; i++) own.push([v[0], v[i], v[i + 1]]);
      }
      tris.push(...fixTjunctions(own));
    }
    const buf = new ArrayBuffer(84 + tris.length * 50);
    const dv = new DataView(buf);
    const hdr = 'pnp_stand.html LumenPnP stands';
    for (let i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i));
    dv.setUint32(80, tris.length, true);
    let o = 84;
    for (const [a, b, c] of tris) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const f of [nx, ny, nz, ...a, ...b, ...c]) { dv.setFloat32(o, f, true); o += 4; }
      dv.setUint16(o, 0, true); o += 2;
    }
    return buf;
  }

  /** Uncompressed (store) .zip of [{ name, data: Uint8Array }]; names may contain '/' for a folder */
  function zipStore(files) {
    const crcTab = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTab[n] = c >>> 0; }
    const crc32 = (d) => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = crcTab[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const enc = (s) => { const b = []; for (const ch of unescape(encodeURIComponent(s))) b.push(ch.charCodeAt(0)); return Uint8Array.from(b); };
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc(f.name), d = f.data, crc = crc32(d);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, d);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + d.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  /** Editable OpenSCAD source for the same stands */
  function scadSource(stands, sp, meta) {
    const f = (x) => (+x).toFixed(3);
    const Hb = bodyTop(sp);
    const lines = [];
    lines.push('// LumenPnP PCB stands, generated by pnp_stand (LumenPnP-PCB-Stand-and-Discrete-Tray-Generator)');
    if (meta) lines.push('// ' + meta);
    lines.push('// Stand numbers: 1 = nearest the board\'s lower-left corner (KiCad top view), counting anticlockwise.');
    lines.push(`H = ${f(sp.height)};        // plate top to PCB bottom`);
    lines.push(`Hb = ${f(Hb)};       // body top (step-up: only the boss / corner pad reaches H)`);
    lines.push(`bolt_d = ${f(sp.boltD)};`);
    lines.push(`pocket_depth = ${f(pocketDepthOf(sp))};   // body top - floor under nut (${f(sp.pocketFloor)})`);
    lines.push(`pin_len = ${f(sp.pinLen)};`);
    lines.push(`lip = ${f(sp.cornerLip)};       // corner wall above H`);
    lines.push(`label_depth = ${f(sp.labelDepth)};`);
    lines.push('$fn = 48;', '');
    stands.forEach((st, i) => {
      const n = st.num || i + 1;
      const o = st.bolts[0];
      const P = (p) => `${f(p.x - o.x)}, ${f(p.y - o.y)}`;
      const sq = (r, z0, z1) => `translate([${P({ x: r.x0, y: r.y0 })}, ${z0}]) cube([${f(r.x1 - r.x0)}, ${f(r.y1 - r.y0)}, ${z1}]);`;
      const D = st.D;
      lines.push(`// Stand ${n}: ${st.kind === 'corner' ? 'board corner' : 'PCB hole'} ${st.ref}${st.d ? ` (d ${f(st.d)})` : ''} -> bolts ${st.bolts.map((b) => b.name).join(' + ')}`);
      lines.push(`module stand_${n}() {`);
      lines.push('  difference() {');
      lines.push('    union() {');
      lines.push('      linear_extrude(Hb) hull() {');
      for (const b of st.bolts) lines.push(`        translate([${P(b)}]) circle(r = ${f(D.boltPadR)});`);
      if (st.kind === 'corner') {
        for (const r of [st.parts.support, ...st.parts.walls]) lines.push(`        translate([${P({ x: r.x0, y: r.y0 })}]) square([${f(r.x1 - r.x0)}, ${f(r.y1 - r.y0)}]);`);
      } else lines.push(`        translate([${P(st.anchor)}]) circle(r = ${f(D.pcbPadR)});`);
      lines.push('      }');
      if (st.kind === 'corner') {
        lines.push('      ' + sq(st.parts.support, 'Hb - 0.01', 'H - Hb + 0.01'));
        for (const w of st.parts.walls) lines.push('      ' + sq(w, 0, 'H + lip'));
      } else {
        if (sp.stepH > 0) lines.push(`      translate([${P(st.anchor)}, Hb - 0.01]) cylinder(r = ${f(D.bossR)}, h = H - Hb + 0.01);   // step-up boss`);
        if (sp.iface === 'pin') {
          const ch = Math.min(0.4, D.pinR * 0.4);
          lines.push(`      translate([${P(st.anchor)}, H - 0.2]) cylinder(r = ${f(D.pinR)}, h = pin_len - ${f(ch)} + 0.2);`);
          lines.push(`      translate([${P(st.anchor)}, H + pin_len - ${f(ch)}]) cylinder(r1 = ${f(D.pinR)}, r2 = ${f(D.pinR - ch)}, h = ${f(ch)});`);
        }
      }
      lines.push('    }');
      for (const b of st.bolts) {
        lines.push(`    translate([${P(b)}, -1]) cylinder(d = bolt_d, h = H + 4);`);
        if (sp.pocket !== 'none')
          lines.push(`    translate([${P(b)}, Hb - pocket_depth]) cylinder(r = ${f(D.pocketR)}, h = pocket_depth + 1${sp.pocket === 'hex' ? ', $fn = 6' : ''});`);
      }
      if (st.kind === 'corner') {
        const [sx, sy] = st.inwM;
        lines.push(`    translate([${P({ x: st.anchor.x - sx * sp.cornerGap, y: st.anchor.y - sy * sp.cornerGap })}, H - 0.1]) cylinder(r = 0.8, h = lip + 1);   // corner relief`);
      } else if (sp.iface === 'hole') {
        const dep = Math.min(sp.ifaceHoleDepth, sp.height - 0.8);
        lines.push(`    translate([${P(st.anchor)}, H - ${f(dep)}]) cylinder(r = ${f(D.ifaceR)}, h = ${f(dep + 1)});`);
      }
      if (sp.label) {
        const lf = labelFace(st, sp);
        if (lf) lines.push(`    translate([${P(lf)}, Hb / 2]) rotate([0, 0, ${f(lf.ang)}]) rotate([90, 0, 0]) translate([0, 0, -label_depth]) linear_extrude(label_depth + 0.05) text("${n}", size = ${f(lf.size)}, halign = "center", valign = "center", font = "Liberation Sans:style=Bold");   // number on the side`);
      }
      lines.push('  }', '}', '');
    });
    lines.push('// print layout');
    let x = 0;
    stands.forEach((st, i) => {
      const n = st.num || i + 1;
      const pts = standOutline(st), o = st.bolts[0];
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      lines.push(`translate([${f(x - (Math.min(...xs) - o.x))}, ${f(-(Math.min(...ys) - o.y))}, 0]) stand_${n}();`);
      x += Math.max(...xs) - Math.min(...xs) + 6;
    });
    return lines.join('\n') + '\n';
  }

  /** Board origin in machine coordinates for OpenPnP, given one measured reference hole. */
  function boardOrigin(m, pcb, place, origin, ref) {
    if (!origin) return null;
    const p = toMachine(pcb, place, origin.u, origin.v);
    if (!ref || !ref.hole) return { plateX: p.x, plateY: p.y };
    const h = findHole(m, ref.hole);
    if (!h) return { plateX: p.x, plateY: p.y, error: 'unknown reference hole' };
    const sx = ref.flipX ? -1 : 1, sy = ref.flipY ? -1 : 1;
    return { plateX: p.x, plateY: p.y, x: ref.x + sx * (p.x - h.x), y: ref.y + sy * (p.y - h.y) };
  }

  const VERSION = 5; // bump when the page needs something new from the core (the page checks it)
  const api = {
    VERSION,
    LETTERS, PROFILES, DEFAULT_STAND, BOLT_PRESETS, effectiveStand, buildMachine, holesNear, findHole, parseKeepouts,
    parseSexpr, importKicadPcb, rectPcb, toMachine, pcbRect, derived, candidatesFor, evaluate,
    autoPlace, standSolid, printLayout, stlBinary, zipStore, scadSource, boardOrigin,
    CORNERS, mountsOf, numberMounts, cornerParts, standOutline, hullPts, labelFace, bodyTop, pocketDepthOf, digits, fixTjunctions,
    _: { distPointSeg, distSegSeg, distSegRect, distPointRect, rectsOverlap, pointInRect },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PnpStand = api;
})(typeof window !== 'undefined' ? window : globalThis);
