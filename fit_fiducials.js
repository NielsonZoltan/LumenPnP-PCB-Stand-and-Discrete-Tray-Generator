// Moves an exported OpenPnP project (pnp_stand section 7) onto the machine from fiducials taught there.
//
//   node tools/pnp_stand/fit_fiducials.js <project dir> <out dir> FIDP1=x,y FIDP2=x,y FIDP3=x,y [--machine] [--z 16] [--fid-part ID]
//
//   FIDPn=x,y     where the fiducial really is: by default the X/Y shown in OpenPnP's Placements table after you jogged
//                 the camera onto it and edited the placement (board-local, relative to the job's board location);
//                 with --machine, the machine X/Y read off the DRO. Two fiducials minimum, three recommended.
//   --z 16        board top Z measured on the machine (job location Z); feeder Z moves by the same amount.
//   --fid-part ID part id to use for the fiducials (e.g. one already in that machine's parts.xml).
//
// Fits one rotation + shift (no scale) through the fiducials and applies it to every placement (X, Y, rotation) and to
// every strip feeder hole, so board, job and feeders all come out in machine coordinates. The job's board location is
// kept: the correction lives in the placements, so the job you already have open keeps working once the board is reloaded.
// Prints the residual per fiducial: more than ~0.2 mm means a fiducial was taught on the wrong mark.
'use strict';

/** least-squares rotation + shift taking points P onto Q (2D, no scale) */
function fitRigid(P, Q) {
  if (P.length < 2) throw new Error('need at least 2 fiducials');
  const mean = (A) => [A.reduce((s, a) => s + a[0], 0) / A.length, A.reduce((s, a) => s + a[1], 0) / A.length];
  const pc = mean(P), qc = mean(Q);
  let sxx = 0, sxy = 0;
  P.forEach((p, i) => {
    const a = [p[0] - pc[0], p[1] - pc[1]], b = [Q[i][0] - qc[0], Q[i][1] - qc[1]];
    sxx += a[0] * b[0] + a[1] * b[1]; sxy += a[0] * b[1] - a[1] * b[0];
  });
  const th = Math.atan2(sxy, sxx), c = Math.cos(th), s = Math.sin(th);
  const t = [qc[0] - (c * pc[0] - s * pc[1]), qc[1] - (s * pc[0] + c * pc[1])];
  const map = (p) => [c * p[0] - s * p[1] + t[0], s * p[0] + c * p[1] + t[1]];
  return { deg: (th * 180) / Math.PI, t, map, residuals: P.map((p, i) => Math.hypot(map(p)[0] - Q[i][0], map(p)[1] - Q[i][1])) };
}

const normDeg = (a) => { a = (((a + 180) % 360) + 360) % 360 - 180; return Math.abs(a + 180) < 1e-9 ? 180 : a; };
const PL_RE = /(<placement version="1.1" id="([^"]+)"[^>]*>\s*<location [^>]*x=")([-\d.]+)(" y=")([-\d.]+)("[^>]*rotation=")([-\d.]+)(")/g;

/**
 * files: { name: text } of the exported project. taught: { FIDP1: [x, y], ... }.
 * opts: { machine: bool (taught values are machine X/Y), z: measured board Z, fidPart: id }
 * returns { files (changed ones), fit, job: {board, x, y, z} }
 */
function fitProject(files, taught, opts = {}) {
  const jobName = Object.keys(files).find((n) => n.endsWith('.job.xml'));
  if (!jobName) throw new Error('no .job.xml in the project');
  let job = files[jobName];
  const bl = job.match(/board-file="([^"]+)"[\s\S]*?<location [^>]*x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)" rotation="([-\d.]+)"/);
  if (!bl) throw new Error('no board location in ' + jobName);
  const [boardName, B] = [bl[1], { x: +bl[2], y: +bl[3], z: +bl[4], rot: +bl[5] }];
  if (Math.abs(B.rot) > 1e-6) throw new Error('board location rotation must be 0 (set it to 0, the fit carries the rotation)');
  if ((job.match(/<board-location /g) || []).length !== 1) throw new Error('one board location expected in ' + jobName);
  let board = files[boardName];
  if (!board) throw new Error('board file ' + boardName + ' not in the project');

  const src = {};
  for (const m of board.matchAll(PL_RE)) src[m[2]] = [+m[3], +m[5]];
  const ids = Object.keys(taught);
  ids.forEach((id) => { if (!src[id]) throw new Error('fiducial ' + id + ' not in ' + boardName); });
  const local = (q) => (opts.machine ? [q[0] - B.x, q[1] - B.y] : q);
  const Q = ids.map((id) => local(taught[id]));
  const fit = fitRigid(ids.map((id) => src[id]), Q);
  fit.ids = ids;

  const taughtLocal = Object.fromEntries(ids.map((id, i) => [id, Q[i]]));
  board = board.replace(PL_RE, (all, a, id, x, b, y, c, r, d) => {
    const m = taughtLocal[id] || fit.map([+x, +y]);
    return `${a}${m[0].toFixed(3)}${b}${m[1].toFixed(3)}${c}${normDeg(+r + fit.deg).toFixed(3)}${d}`;
  });
  if (opts.fidPart) board = board.replace(/<placement ([^>]*)part-id="[^"]*"([^>]*type="Fiducial")/g, `<placement $1part-id="${opts.fidPart}"$2`);

  const z = opts.z == null ? B.z : +opts.z, dz = z - B.z;
  job = job.replace(/(<location [^>]*z=")[-\d.]+/, (all, a) => a + z.toFixed(3));
  const out = { [boardName]: board, [jobName]: job };
  if (files['feeders.xml']) {
    // feeder holes are in the same frame as the board location: M = B + map(P - B)
    const c = Math.cos((fit.deg * Math.PI) / 180), s = Math.sin((fit.deg * Math.PI) / 180);
    // tray feeders (Opulo printed trays): pick location through the fit, the per-part offset turned by the fit's angle
    const tray = (block) => block
      .replace(/<location units="Millimeters" x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)" rotation="([-\d.]+)"/, (all, x, y, fz, r) => {
        const m = fit.map([+x - B.x, +y - B.y]);
        return `<location units="Millimeters" x="${(B.x + m[0]).toFixed(3)}" y="${(B.y + m[1]).toFixed(3)}" z="${(+fz + dz).toFixed(3)}" rotation="${normDeg(+r + fit.deg).toFixed(3)}"`;
      })
      .replace(/<offsets units="Millimeters" x="([-\d.]+)" y="([-\d.]+)"/, (all, x, y) => `<offsets units="Millimeters" x="${(c * x - s * y).toFixed(3)}" y="${(s * x + c * y).toFixed(3)}"`);
    out['feeders.xml'] = files['feeders.xml']
      .replace(/<feeder class="org\.openpnp\.machine\.reference\.feeder\.ReferenceTrayFeeder"[\s\S]*?<\/feeder>/g, tray)
      // strip feeders: holes are in the same frame as the board location: M = B + map(P - B)
      .replace(/<(reference-hole-location|last-hole-location) units="Millimeters" x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)"/g, (all, tag, x, y, fz) => {
        const m = fit.map([+x - B.x, +y - B.y]);
        return `<${tag} units="Millimeters" x="${(B.x + m[0]).toFixed(3)}" y="${(B.y + m[1]).toFixed(3)}" z="${(+fz + dz).toFixed(3)}"`;
      })
      .replace(/(<feeder class="org\.openpnp\.machine\.reference\.feeder\.ReferenceStripFeeder"[^>]*>\s*<location units="Millimeters" x="[-\d.]+" y="[-\d.]+" z=")([-\d.]+)/g, (all, a, fz) => a + (+fz + dz).toFixed(3));
  }
  return { files: out, fit, job: { board: boardName, x: B.x, y: B.y, z } };
}

module.exports = { fitRigid, fitProject };

if (require.main === module) {
  const fs = require('fs'), path = require('path');
  const args = process.argv.slice(2), pos = [], taught = {}, opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--machine') opts.machine = true;
    else if (a === '--z') opts.z = +args[++i];
    else if (a === '--fid-part') opts.fidPart = args[++i];
    else if (/^[^=]+=[-\d.]+,[-\d.]+$/.test(a)) { const [id, v] = a.split('='); taught[id] = v.split(',').map(Number); }
    else pos.push(a);
  }
  if (pos.length !== 2 || Object.keys(taught).length < 2) {
    console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 14).join('\n'));
    process.exit(2);
  }
  const [inDir, outDir] = pos;
  const files = Object.fromEntries(fs.readdirSync(inDir).filter((f) => /\.(xml)$/.test(f)).map((f) => [f, fs.readFileSync(path.join(inDir, f), 'utf8')]));
  const r = fitProject(files, taught, opts);
  console.log(`rotation ${r.fit.deg.toFixed(3)} deg, shift ${r.fit.t[0].toFixed(3)}, ${r.fit.t[1].toFixed(3)} mm (board frame); board Z ${r.job.z.toFixed(3)}`);
  r.fit.ids.forEach((id, i) => console.log(`  ${id} residual ${r.fit.residuals[i].toFixed(3)} mm${r.fit.residuals[i] > 0.2 ? '  <- check this one' : ''}`));
  fs.mkdirSync(outDir, { recursive: true });
  // everything else (parts, packages, merge script, README) is copied unchanged
  for (const f of fs.readdirSync(inDir)) {
    const p = path.join(inDir, f);
    if (!fs.statSync(p).isFile()) continue;
    fs.writeFileSync(path.join(outDir, f), r.files[f] != null ? r.files[f] : fs.readFileSync(p));
  }
  console.log('written to', outDir, '| changed:', Object.keys(r.files).join(', '));
}
