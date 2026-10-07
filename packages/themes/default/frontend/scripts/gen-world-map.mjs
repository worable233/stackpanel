// Regenerates the embedded world-map path in `src/region-map.tsx`.
//
// Source: Natural Earth 1:110m land, distributed as TopoJSON by the `world-atlas`
// package (public domain). We bake a simplified Equirectangular outline into the
// theme bundle so the region section needs no tile server, API key, or network
// access at runtime — the theme ships its own map.
//
// This is a maintenance script, not part of the build. Run it from the theme
// frontend directory when the map geometry needs refreshing:
//
//   node scripts/gen-world-map.mjs
//
// It rewrites the `WORLD_LAND_PATH` constant in `src/region-map.tsx` in place.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json';
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'src', 'region-map.tsx');

// viewBox and projection must match `region-map.tsx`.
const VIEW_W = 1000;
const VIEW_H = 500;
const LAT_MIN = -58;
const LAT_MAX = 84;
const MIN_DIST = 3; // px between retained points
const MIN_AREA = 16; // px^2, drops tiny islands and specks

const topo = await (await fetch(SOURCE)).json();
const { scale, translate } = topo.transform;

const project = ([lon, lat]) => {
  const clamped = Math.max(LAT_MIN, Math.min(LAT_MAX, lat));
  return [((lon + 180) / 360) * VIEW_W, ((LAT_MAX - clamped) / (LAT_MAX - LAT_MIN)) * VIEW_H];
};

const arcs = topo.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  const out = [];
  for (const [dx, dy] of arc) {
    x += dx;
    y += dy;
    const point = project([x * scale[0] + translate[0], y * scale[1] + translate[1]]);
    const last = out[out.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= MIN_DIST) out.push(point);
  }
  return out;
});

function ringFromArcIndices(indices) {
  const points = [];
  for (const index of indices) {
    const arc = index < 0 ? arcs[~index].slice().reverse() : arcs[index];
    for (let i = points.length === 0 ? 0 : 1; i < arc.length; i += 1) points.push(arc[i]);
  }
  return points;
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(area / 2);
}

const polygons = topo.objects.land.geometries.flatMap((geometry) =>
  geometry.type === 'MultiPolygon' ? geometry.arcs : [geometry.arcs],
);

const paths = [];
for (const polygon of polygons) {
  for (const ring of polygon) {
    const raw = ringFromArcIndices(ring);
    if (raw.length < 4) continue;
    // Drop Antarctica: its latitudinally-clamped points pile up on the bottom
    // edge (y ~= VIEW_H), which would render as a flat band. The reference map
    // omits the continent, so we do too.
    const bottomPoints = raw.filter((point) => point[1] >= VIEW_H - 2).length;
    if (bottomPoints >= 3) continue;
    // Split at the antimeridian. A ring that wraps across ±180° produces a
    // horizontal jump of half the viewBox width; drawing it as one path smears
    // a line across the whole map. Break the ring into segments instead.
    const segments = [];
    let current = [raw[0]];
    for (let i = 1; i < raw.length; i += 1) {
      if (Math.abs(raw[i][0] - raw[i - 1][0]) > VIEW_W / 2) {
        segments.push(current);
        current = [raw[i]];
      } else {
        current.push(raw[i]);
      }
    }
    segments.push(current);
    for (const segment of segments) {
      if (segment.length < 4 || ringArea(segment) < MIN_AREA) continue;
      let d = `M${segment[0][0].toFixed(0)} ${segment[0][1].toFixed(0)}`;
      for (let i = 1; i < segment.length; i += 1) {
        d += `L${segment[i][0].toFixed(0)} ${segment[i][1].toFixed(0)}`;
      }
      paths.push(`${d}Z`);
    }
  }
}

const worldPath = paths.join('');
const file = readFileSync(target, 'utf8');
const next = file.replace(
  /const WORLD_LAND_PATH\s*=\s*'[\s\S]*?';/,
  `const WORLD_LAND_PATH =\n  '${worldPath}';`,
);
if (next === file) throw new Error(`Could not find WORLD_LAND_PATH in ${target}`);
writeFileSync(target, next);
console.log(`Updated ${target}: ${paths.length} paths, ${worldPath.length} chars`);
