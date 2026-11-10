// Printable placement map + loading list (pnp_stand "Print sheet" and sheet.html in Export everything).
//
// sheetDocument(model) -> a standalone HTML page (letter landscape): page 1 the plates seen from above, front at the
// bottom, cropped to what's used, with the board, stands and their bolt holes, every tray / feeder with its bolt holes and
// each cut strip where it goes; page 2+ the loading list (per holder: lane / channel, start, cut length, line, value,
// refs, qty, tape) with tick boxes, the stands, hand-placed parts and what to do next.
// The page builds the model from its own state (pnp_stand.html, sheetModel()); everything here is plate coordinates
// in mm, Y up, and plain data, so it runs in Node for the tests.
(function (root) {
'use strict';
const VERSION = 1;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PAL = ['#cfe3f7', '#fde2c4', '#d4efd4', '#f6d0dc', '#e3d9f5', '#fbf0b8', '#cdeeee', '#ead9c8', '#dfe8c2', '#f3d6c6'];
const colorOf = (id) => PAL[((parseInt(id, 10) || String(id).length) - 1 + PAL.length * 10) % PAL.length];
const f2 = (v) => (+v).toFixed(2).replace(/\.?0+$/, '');
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * model: {
 *   title, subtitle, date,
 *   plates: [{x0,y0,x1,y1,name,lower,aAt}], holes: [{x,y,name,exists,blocked,i,k,plate}], pitch, holeD,
 *   zones: [{type:'circle',x,y,r,label} | {type:'rect',x0,y0,x1,y1,label}],
 *   board: { name, outline: [[{x,y},...]], rect, label, fids: [{name,x,y}] } | null,
 *   stands: [{num, ref, outline:[{x,y}], bolts:[{name,x,y}], pin:{x,y}}],
 *   holders: [{ id:'O1', title:'O1 · 8 mm', rect, ok, why, bolts:[{name,x,y}],
 *               lanes:[{name:'C1', rect}], strips:[{line, label, rect, vertical, firstAt:{x,y,dir:'up'|'down'|'left'|'right'}|null}],
 *               head, rows:[{lane, at, cut, line, value, sub, refs, qty, tape, note}] }],
 *   standRows: [{num, bolts, where, ref}], hand: [{line, value, refs}], steps: [html], legendNote, laneWord
 * }
 */
function sheetDocument(m) {
  const svg = mapSvg(m);
  const holders = m.holders || [];
  const anyAt = holders.some((h) => h.rows.some((r) => r.at !== '' && r.at != null));
  const table = (h) => `<section class="ft"><h3><span class="tag">${esc(h.id)}</span> ${h.head}</h3><table>
<thead><tr><th class="ck"></th><th>${esc(m.laneWord || 'Lane')}</th>${anyAt ? '<th>@ mm</th>' : ''}<th>Cut</th><th>Line</th><th>Value</th><th>Refs</th><th>Qty</th><th>Tape</th></tr></thead><tbody>` +
    h.rows.map((r) => `<tr><td class="ck">☐</td><td class="nw">${esc(r.lane)}</td>${anyAt ? `<td>${esc(r.at)}</td>` : ''}<td>${esc(r.cut)}</td><td class="nw"><span class="sw" style="background:${colorOf(r.line)}"></span>#${esc(r.line)}</td><td>${esc(r.value)}<div class="mpn">${esc(r.sub || '')}${r.note ? `${r.sub ? ' · ' : ''}<span class="note">${esc(r.note)}</span>` : ''}</div></td><td class="refs">${esc(r.refs)}</td><td>${esc(r.qty)}</td><td class="nw">${esc(r.tape)}</td></tr>`).join('') +
    `</tbody></table></section>`;
  // two columns, holders split by row count so the columns come out about even
  const weight = (h) => h.rows.length + 3, total = holders.reduce((a, h) => a + weight(h), 0) + 12;
  const left = [], right = [];
  let acc = 0;
  for (const h of holders) { (acc + weight(h) / 2 <= total / 2 ? left : right).push(h); acc += weight(h); }
  const standT = (m.standRows || []).length ? `<div class="box"><h3>Stands${m.standNote ? ` <small>(${esc(m.standNote)})</small>` : ''}</h3><table><thead><tr><th class="ck"></th><th>Stand</th><th>Bolt holes</th><th>Where</th><th>Board hole</th></tr></thead><tbody>` +
    m.standRows.map((s) => `<tr><td class="ck">☐</td><td>${esc(s.num)}</td><td><b>${esc(s.bolts)}</b></td><td>${esc(s.where)}</td><td>${esc(s.ref)}</td></tr>`).join('') + '</tbody></table></div>' : '';
  const handT = (m.hand || []).length ? `<div class="box"><h3>Hand place <small>(not in a ${esc(m.holderWord || 'holder')})</small></h3><table><thead><tr><th class="ck"></th><th>Line</th><th>Value</th><th>Refs</th></tr></thead><tbody>` +
    m.hand.map((r) => `<tr><td class="ck">☐</td><td>#${esc(r.line)}</td><td>${esc(r.value)}</td><td class="refs">${esc(r.refs)}</td></tr>`).join('') + '</tbody></table></div>' : '';
  const stepsT = (m.steps || []).length ? `<div class="box"><h3>Then</h3><ol class="steps">${m.steps.map((s) => `<li>${s}</li>`).join('')}</ol></div>` : '';
  const problems = holders.filter((h) => !h.ok).map((h) => `${h.id}: ${h.why || 'not placed'}`);
  const list = holders.length || standT ? `<div class="page">
<header><h1>Loading list</h1><span class="meta">${anyAt ? '@ mm = where the strip starts, from the first end of the channel · ' : ''}Cut = strip length (mm) · tick as you go</span></header>
<div class="cols"><div>${left.map(table).join('')}</div><div>${right.map(table).join('')}${standT}${handT}${stepsT}</div></div></div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}</title>
<style>${CSS}</style></head><body>
<div class="page">
<header><h1>${esc(m.title)}</h1><span class="meta">${esc(m.subtitle || '')}${m.date ? ' · ' + esc(m.date) : ''}</span></header>
${problems.length ? `<div class="warn">✗ ${problems.map(esc).join(' · ')}</div>` : ''}
<div class="map">${svg}</div>
<div class="legend"><span><i style="background:var(--bolt)"></i>${esc(m.holderWord || 'holder')} bolt hole</span><span><i style="background:var(--stand)"></i>stand bolt holes (stand number in the dot)</span>${m.legendNote ? `<span>${m.legendNote}</span>` : ''}<span>bands = cut strips, labelled #line value ×qty</span></div>
</div>
${list}
</body></html>`;
}

/** label for a strip that fits its band: font size from the band's length and width */
function stripText(st) {
  const r = st.rect, len = st.vertical ? r.y1 - r.y0 : r.x1 - r.x0, w = st.vertical ? r.x1 - r.x0 : r.y1 - r.y0;
  const fz = Math.max(0.8, Math.min(3, w * 0.42, (len - 2.5) / (Math.max(st.label.length, 4) * 0.6)));
  const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
  return { fz, cx, cy };
}

function mapSvg(m) {
  const P = m.pitch || 15;
  // crop: X to what's used (plus a pitch and a half), Y to the plates it touches
  const boxes = [];
  if (m.board) boxes.push(m.board.rect);
  for (const s of m.stands || []) for (const b of s.bolts) boxes.push({ x0: b.x, x1: b.x, y0: b.y, y1: b.y });
  for (const h of m.holders || []) if (h.rect) boxes.push(h.rect);
  const ex = { x0: Math.min(...m.plates.map((p) => p.x0)), x1: Math.max(...m.plates.map((p) => p.x1)), y0: Math.min(...m.plates.map((p) => p.y0)), y1: Math.max(...m.plates.map((p) => p.y1)) };
  let X0 = ex.x0, X1 = ex.x1;
  if (boxes.length) {
    X0 = Math.max(ex.x0, Math.floor((Math.min(...boxes.map((b) => b.x0)) - 1.5 * P) / P) * P);
    X1 = Math.min(ex.x1, Math.ceil((Math.max(...boxes.map((b) => b.x1)) + 1.5 * P) / P) * P);
  }
  const used = boxes.length ? m.plates.filter((p) => boxes.some((b) => b.y1 > p.y0 + 0.5 && b.y0 < p.y1 - 0.5)) : m.plates;
  const plates = used.length ? used : m.plates;
  const Y0 = Math.min(...plates.map((p) => p.y0)), Y1 = Math.max(...plates.map((p) => p.y1));
  const sy = (y) => Y1 - y; // SVG y down, rear of the machine at the top
  const inX = (x) => x >= X0 - 1e-6 && x <= X1 + 1e-6;
  const pl = (o) => o.map((q, i) => (i ? 'L' : 'M') + f2(q.x) + ' ' + f2(sy(q.y))).join('') + 'Z';
  let s = '';
  for (const p of plates) {
    s += `<rect x="${f2(Math.max(p.x0, X0))}" y="${f2(sy(p.y1))}" width="${f2(Math.min(p.x1, X1) - Math.max(p.x0, X0))}" height="${f2(p.y1 - p.y0)}" class="plate"/>`;
    s += `<text x="${f2(X1 - 2)}" y="${f2(sy(p.y1) + 4)}" class="pname" text-anchor="end">${esc(p.name)}</text>`;
  }
  // zones (camera etc.) inside the crop
  let zoneText = '';
  for (const z of m.zones || []) {
    const zb = z.type === 'circle' ? { x0: z.x - z.r, x1: z.x + z.r, y0: z.y - z.r, y1: z.y + z.r } : z;
    if (!overlap(zb, { x0: X0, x1: X1, y0: Y0, y1: Y1 })) continue;
    if (z.type === 'circle') s += `<circle cx="${f2(z.x)}" cy="${f2(sy(z.y))}" r="${f2(z.r)}" class="zone"/>`;
    else s += `<rect x="${f2(z.x0)}" y="${f2(sy(z.y1))}" width="${f2(z.x1 - z.x0)}" height="${f2(z.y1 - z.y0)}" class="zone"/>`;
    const zx = z.type === 'circle' ? z.x : (z.x0 + z.x1) / 2, zy = z.type === 'circle' ? z.y : (z.y0 + z.y1) / 2;
    zoneText += `<text x="${f2(zx)}" y="${f2(sy(zy) + 1)}" class="zonet">${esc(z.label || '')}</text>`; // after the holes, so none cuts it
  }
  // row numbers outside the plates, letters at the left
  const holes = (m.holes || []).filter((h) => plates.some((p) => h.y >= p.y0 && h.y <= p.y1));
  const rowsX = new Map();
  for (const h of holes) if (inX(h.x) && h.x > X0 + 3 && h.x < X1 - 3) rowsX.set(h.k, h.x);
  for (const [k, x] of rowsX) s += `<text x="${f2(x)}" y="${f2(sy(Y0) + 4.5)}" class="rown">${k}</text><text x="${f2(x)}" y="${f2(sy(Y1) - 1.5)}" class="rown">${k}</text>`;
  const letters = new Map();
  for (const h of holes) { const L = h.name.replace(/\d+$/, ''); if (!letters.has(L)) letters.set(L, h.y); }
  for (const [L, y] of letters) s += `<text x="${f2(X0 - 1.2)}" y="${f2(sy(y) + 1.1)}" class="lett">${esc(L)}</text>`;
  const r0 = (m.holeD || 3.4) / 2;
  for (const h of holes) if (h.exists && inX(h.x) && h.x > X0 + 2 && h.x < X1 - 2) s += `<circle cx="${f2(h.x)}" cy="${f2(sy(h.y))}" r="${f2(r0)}" class="${h.blocked ? 'hole off' : 'hole'}"/>`;

  s += zoneText;
  // holders: body, lanes, strips, label outside where there's room
  const solid = [...(m.holders || []).filter((h) => h.rect).map((h) => h.rect), ...(m.board ? [m.board.rect] : [])];
  const bolts = [];
  for (const h of m.holders || []) {
    if (!h.rect) continue;
    const r = h.rect;
    s += `<rect x="${f2(r.x0)}" y="${f2(sy(r.y1))}" width="${f2(r.x1 - r.x0)}" height="${f2(r.y1 - r.y0)}" rx="1.2" class="${h.ok ? 'holder' : 'holder bad'}"/>`;
    for (const l of h.lanes || []) {
      const q = l.rect;
      s += `<rect x="${f2(q.x0)}" y="${f2(sy(q.y1))}" width="${f2(q.x1 - q.x0)}" height="${f2(q.y1 - q.y0)}" class="lane"/>`;
      if (l.name) {
        const vert = q.y1 - q.y0 > q.x1 - q.x0;
        s += vert ? `<text x="${f2((q.x0 + q.x1) / 2)}" y="${f2(sy(q.y0) - 0.6)}" class="chn">${esc(l.name)}</text>`
          : `<text x="${f2(q.x1 - 0.6)}" y="${f2(sy((q.y0 + q.y1) / 2) + 0.8)}" class="chn" text-anchor="end">${esc(l.name)}</text>`;
      }
    }
    for (const st of h.strips || []) {
      const q = st.rect;
      s += `<rect x="${f2(q.x0)}" y="${f2(sy(q.y1))}" width="${f2(q.x1 - q.x0)}" height="${f2(q.y1 - q.y0)}" fill="${colorOf(st.line)}" class="strip"/>`;
      const t = stripText(st);
      s += st.vertical ? `<text transform="translate(${f2(t.cx + t.fz * 0.35)},${f2(sy(t.cy))}) rotate(-90)" class="stripl" style="font-size:${t.fz.toFixed(2)}px">${esc(st.label)}</text>`
        : `<text x="${f2(t.cx)}" y="${f2(sy(t.cy) + t.fz * 0.35)}" class="stripl" style="font-size:${t.fz.toFixed(2)}px">${esc(st.label)}</text>`;
      if (st.firstAt) {
        const a = st.firstAt, x = a.x, y = sy(a.y), d = 1.7;
        const tri = { up: [[x - 1.5, y], [x + 1.5, y], [x, y - d]], down: [[x - 1.5, y], [x + 1.5, y], [x, y + d]], left: [[x, y - 1.5], [x, y + 1.5], [x - d, y]], right: [[x, y - 1.5], [x, y + 1.5], [x + d, y]] }[a.dir || 'up'];
        s += `<path d="M${tri.map((p) => f2(p[0]) + ' ' + f2(p[1])).join('L')}Z" class="arrow"/>`;
      }
    }
    // label: above, else below, else inside at the top
    const lh = 6, cx = (r.x0 + r.x1) / 2;
    const above = { x0: r.x0, x1: r.x1, y0: r.y1 + 0.5, y1: r.y1 + lh }, below = { x0: r.x0, x1: r.x1, y0: r.y0 - lh, y1: r.y0 - 0.5 };
    const free = (b) => !solid.some((o) => o !== r && overlap(o, b));
    let ly;
    if (free(above) && r.y1 + lh <= Y1 + 8) ly = sy(r.y1) - (r.y1 > Y1 - 3 ? 5 : 1.6); // clear of the row numbers at the plate edge
    else if (free(below) && r.y0 - lh >= Y0 - 12) ly = sy(r.y0) + (r.y0 < Y0 + 3 ? 9.5 : 5);
    else ly = sy(r.y1) + 4.5;
    s += `<text x="${f2(cx)}" y="${f2(ly)}" class="hname">${esc(h.title || h.id)}</text>`;
    for (const b of h.bolts || []) bolts.push({ ...b, cls: 'bolt' });
  }

  // board, fiducials, stands
  if (m.board) {
    const b = m.board, r = b.rect;
    s += `<rect x="${f2(r.x0)}" y="${f2(sy(r.y1))}" width="${f2(r.x1 - r.x0)}" height="${f2(r.y1 - r.y0)}" class="board"/>`;
    if (b.outline && b.outline.length) s += b.outline.map((o) => `<path d="${o.map((q, i) => (i ? 'L' : 'M') + f2(q.x) + ' ' + f2(sy(q.y))).join('')}" class="bedge"/>`).join('');
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2, fz = Math.max(2.4, Math.min(4.5, (r.x1 - r.x0) / 14));
    s += `<text x="${f2(cx)}" y="${f2(sy(cy) - fz * 0.4)}" class="bname" style="font-size:${fz.toFixed(2)}px">${esc(b.name)}</text>`;
    if (b.label) s += `<text x="${f2(cx)}" y="${f2(sy(cy) + fz * 0.8)}" class="bsub" style="font-size:${(fz * 0.6).toFixed(2)}px">${esc(b.label)}</text>`;
    for (const f of b.fids || []) {
      const right = f.x > cx;
      s += `<circle cx="${f2(f.x)}" cy="${f2(sy(f.y))}" r="1.3" class="fid"/><text x="${f2(f.x + (right ? -2 : 2))}" y="${f2(sy(f.y) + 0.8)}" class="fidt" text-anchor="${right ? 'end' : 'start'}">${esc(f.name)}</text>`;
    }
  }
  for (const st of m.stands || []) {
    if (st.outline && st.outline.length) s += `<path d="${pl(st.outline)}" class="standb"/>`;
    const bs = st.bolts;
    if (bs.length > 1) s += `<path d="${bs.map((b, i) => (i ? 'L' : 'M') + f2(b.x) + ' ' + f2(sy(b.y))).join('')}" class="standl"/>`;
    const c = st.pin || { x: bs.reduce((a, b) => a + b.x, 0) / bs.length, y: bs.reduce((a, b) => a + b.y, 0) / bs.length };
    s += `<circle cx="${f2(c.x)}" cy="${f2(sy(c.y))}" r="3" class="standc"/><text x="${f2(c.x)}" y="${f2(sy(c.y) + 1.15)}" class="standn">${esc(st.num)}</text>`;
    for (const b of bs) bolts.push({ ...b, cls: 'boltS' });
  }
  for (const b of bolts) {
    s += `<circle cx="${f2(b.x)}" cy="${f2(sy(b.y))}" r="2.5" class="${b.cls}"/>`;
    s += `<text x="${f2(b.x + 3)}" y="${f2(sy(b.y) - 2.2)}" class="${b.cls}t">${esc(b.name)}</text>`;
  }
  s += `<text x="${f2((X0 + X1) / 2)}" y="${f2(sy(Y0) + 15.5)}" class="front">▼  FRONT of the machine  ▼</text>`;
  const vb = [X0 - 7, -10, X1 - X0 + 9, Y1 - Y0 + 28];
  return `<svg viewBox="${vb.map(f2).join(' ')}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Plates with board, stands, holders and their bolt holes">${s}</svg>`;
}

const CSS = `
@page { size: letter landscape; margin: 8mm; }
:root { --ink:#1b1f24; --muted:#5b6470; --line:#c9cfd6; --bolt:#d1342f; --stand:#1f5fbf; }
* { box-sizing: border-box; }
html, body { background: #fff; }
body { margin: 0; padding: 16px; color: var(--ink); font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print { body { padding: 0; } }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 4px 16px; flex-wrap: wrap; border-bottom: 2px solid var(--ink); padding-bottom: 3px; margin-bottom: 6px; }
h1 { font-size: 17px; margin: 0; } h3 { font-size: 12px; margin: 0 0 2px; font-weight: 600; }
header .meta { color: var(--muted); font-size: 10.5px; }
.page { break-after: page; } .page:last-child { break-after: auto; }
.warn { color: #b3261e; font-weight: 600; margin: 2px 0 4px; }
.map svg { width: 100%; height: auto; max-height: 170mm; display: block; }
.legend { display: flex; gap: 4px 18px; flex-wrap: wrap; font-size: 10.5px; color: var(--muted); margin-top: 2px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: -1px; margin-right: 4px; }
.plate { fill: #f4f5f7; stroke: #9aa3ad; stroke-width: .4; }
.pname { font-size: 3px; fill: #7b8490; }
.rown { font-size: 2.6px; fill: #7b8490; text-anchor: middle; }
.lett { font-size: 3px; fill: #5b6470; text-anchor: end; font-weight: 600; }
.hole { fill: #fff; stroke: #a8b0ba; stroke-width: .35; } .hole.off { stroke: #e3a3a0; stroke-dasharray: .6 .5; }
.zone { fill: #fff3f2; stroke: #d1342f; stroke-width: .4; stroke-dasharray: 1.5 1; } .zonet { font-size: 3px; fill: #b0302b; text-anchor: middle; paint-order: stroke; stroke: #fff3f2; stroke-width: .8; }
.holder { fill: #e6e9ed; stroke: #3d4550; stroke-width: .5; } .holder.bad { stroke: #d1342f; stroke-width: 1; }
.lane { fill: #fff; stroke: #b4bbc4; stroke-width: .25; }
.strip { stroke: #3d4550; stroke-width: .3; }
.stripl { fill: #111; text-anchor: middle; font-weight: 600; }
.chn { font-size: 2.3px; fill: #3d4550; text-anchor: middle; font-weight: 600; }
.arrow { fill: #3d4550; }
.hname { font-size: 4.2px; font-weight: 700; text-anchor: middle; fill: #111; }
.board { fill: #e3f1e0; stroke: none; } .bedge { fill: none; stroke: #2f7d32; stroke-width: .5; }
.bname { font-weight: 700; text-anchor: middle; fill: #1f5a22; } .bsub { text-anchor: middle; fill: #2f6d32; }
.fid { fill: #fff; stroke: #1f5a22; stroke-width: .4; } .fidt { font-size: 2.2px; fill: #1f5a22; }
.standb { fill: rgba(31,95,191,.12); stroke: var(--stand); stroke-width: .3; }
.standl { fill: none; stroke: var(--stand); stroke-width: .8; } .standc { fill: var(--stand); } .standn { font-size: 3.3px; font-weight: 700; fill: #fff; text-anchor: middle; }
.bolt { fill: var(--bolt); stroke: #fff; stroke-width: .5; } .boltS { fill: var(--stand); stroke: #fff; stroke-width: .5; }
.boltt { font-size: 3.1px; font-weight: 700; fill: var(--bolt); paint-order: stroke; stroke: #fff; stroke-width: .8; }
.boltSt { font-size: 3px; font-weight: 700; fill: var(--stand); paint-order: stroke; stroke: #fff; stroke-width: .8; }
.front { font-size: 3.4px; text-anchor: middle; fill: #5b6470; letter-spacing: .3px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; }
@media (max-width: 800px) { .cols { grid-template-columns: 1fr; } .map { overflow-x: auto; } .map svg { min-width: 760px; } }
table { width: 100%; border-collapse: collapse; font-size: 10px; }
th, td { border-bottom: 1px solid var(--line); padding: 1.5px 4px; text-align: left; vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: 9.5px; border-bottom: 1px solid var(--ink); }
td.ck, th.ck { width: 14px; padding-right: 0; font-size: 12px; line-height: 1.1; }
.nw { white-space: nowrap; }
.mpn { color: var(--muted); font-size: 9px; } .refs { font-size: 9px; } .note { color: #8a4b00; }
.sw { display: inline-block; width: 9px; height: 9px; border: 1px solid #3d4550; margin-right: 3px; vertical-align: -1px; }
.ft { break-inside: avoid; margin-bottom: 7px; }
.tag { display: inline-block; background: var(--ink); color: #fff; border-radius: 3px; padding: 0 5px; font-weight: 700; }
.steps { margin: 0; padding-left: 16px; font-size: 10px; } .steps li { margin: 1px 0; }
.box { border: 1px solid var(--line); border-radius: 4px; padding: 5px 7px; break-inside: avoid; margin-bottom: 6px; }
small { color: var(--muted); font-weight: 400; }
code { font-size: 9.5px; }
`;

const api = { VERSION, sheetDocument, colorOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.PnpSheet = api;
})(typeof window !== 'undefined' ? window : globalThis);
