import { h, s } from './dom.js';
import { time, date, dateTime, pct, ms } from './format.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

 
export function sparkline(points, { width = 200, height = 30, max = 40 } = {}) {
  const data = points.slice(-max);
  const svg = s('svg', { class: 'spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Recent check results' });
  if (!data.length) return svg;
  const lats = data.filter((p) => p.ok && p.latencyMs != null).map((p) => p.latencyMs).sort((a, b) => a - b);
  const top = Math.max(50, lats[Math.floor(lats.length * 0.95)] ?? 100);
  const gap = 2, bw = Math.max(2, (width - gap * (max - 1)) / max);
  const offset = (max - data.length) * (bw + gap);
  data.forEach((p, i) => {
    const bh = !p.ok ? height : p.latencyMs == null ? height * 0.35 : Math.max(4, Math.min(1, p.latencyMs / top) * height);
    const fill = p.maintenance ? 'var(--blue)' : p.ok ? 'var(--green)' : 'var(--red)';
    svg.append(s('rect', { x: offset + i * (bw + gap), y: height - bh, width: bw, height: bh, rx: 1.5, fill, opacity: p.ok ? 0.85 : 1 },
      s('title', `${dateTime(p.ts)} — ${p.ok ? ms(p.latencyMs) : 'failed'}`)));
  });
  return svg;
}

 
export function uptimeStrip(days) {
  const cell = (d) => {
    let cls = '';
    if (d.uptime != null) cls = d.uptime >= 99.9 ? 'g' : d.uptime >= 98 ? 'y' : 'r';
    return h('span', { class: cls, title: `${date(d.day)} — ${d.uptime == null ? 'no data' : pct(d.uptime)}${d.checks ? ` (${d.checks} checks)` : ''}` });
  };
  return h('div', h('div.uptime-strip', days.map(cell)), h('div.strip-labels', h('span', `${days.length} days ago`), h('span', 'Today')));
}





export function latencyChart(series, { height = 240 } = {}) {
  const root = h('div.chart');
  const tip = h('div.tooltip.hidden');
  root.append(tip);
  const W = 900, H = height, m = { l: 46, r: 12, t: 12, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const pts = series.points;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', height: H });
  root.prepend(svg);
  svg.style.height = `${H}px`;

  const withData = pts.filter((p) => p.avg != null);
  if (!pts.length || !withData.length) {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: 'var(--faint)', 'font-size': 14 }, 'No data in this range yet'));
    return root;
  }
  const yMaxRaw = Math.max(...pts.map((p) => p.max ?? p.avg ?? 0), 1);
  const yMax = niceCeil(yMaxRaw * 1.08);
  const x = (ts) => m.l + ((ts - series.from) / (series.to - series.from)) * iw;
  const y = (v) => m.t + ih - (v / yMax) * ih;

   
  const g = s('g', { class: 'grid' }), ax = s('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i, yy = y(v);
    g.append(s('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy }));
    ax.append(s('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, `${Math.round(v)}${i === 4 ? 'ms' : ''}`));
  }
   
  const span = series.to - series.from;
  const fmt = span <= 36 * 3600_000 ? time : date;
  for (let i = 0; i <= 5; i++) {
    const ts = series.from + (span / 5) * i;
    ax.append(s('text', { x: x(ts), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === 5 ? 'end' : 'middle' }, fmt(ts)));
  }
  svg.append(g, ax);

   
  const half = Math.max(2, (series.bucketMs / span) * iw / 2);
  for (const p of pts) {
    if (p.uptime != null && p.uptime < 100) {
      svg.append(s('rect', { x: x(p.ts) - half, y: m.t, width: half * 2, height: ih, fill: 'var(--red)', opacity: p.uptime < 50 ? 0.28 : 0.14 }));
    }
  }

   
  const gapLimit = series.bucketMs * 2.5;
  const segments = [];
  let seg = [];
  for (const p of pts) {
    if (p.avg == null) { if (seg.length) segments.push(seg); seg = []; continue; }
    if (seg.length && p.ts - seg[seg.length - 1].ts > gapLimit) { segments.push(seg); seg = []; }
    seg.push(p);
  }
  if (seg.length) segments.push(seg);
  for (const sg of segments) {
    if (sg.length > 1 && sg.some((p) => p.min != null && p.max != null && p.max !== p.min)) {
      const top = sg.map((p) => `${x(p.ts)},${y(p.max ?? p.avg)}`);
      const bot = sg.map((p) => `${x(p.ts)},${y(p.min ?? p.avg)}`).reverse();
      svg.append(s('polygon', { points: [...top, ...bot].join(' '), fill: 'var(--accent)', opacity: 0.12 }));
    }
    const line = sg.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.avg).toFixed(1)}`).join('');
    if (sg.length > 1) svg.append(s('path', { d: `${line}L${x(sg.at(-1).ts)},${y(0)}L${x(sg[0].ts)},${y(0)}Z`, fill: 'var(--accent)', opacity: 0.1 }));
    svg.append(s('path', { d: line, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    if (sg.length === 1) svg.append(s('circle', { cx: x(sg[0].ts), cy: y(sg[0].avg), r: 3, fill: 'var(--accent)' }));
  }

   
  const cross = s('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--muted)', 'stroke-dasharray': '3 3', opacity: 0 });
  const dotEl = s('circle', { r: 4, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
  svg.append(cross, dotEl);
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = null, bd = Infinity;
    for (const p of pts) { const d = Math.abs(x(p.ts) - px); if (d < bd) { bd = d; best = p; } }
    if (!best || bd > 40) return hide();
    cross.setAttribute('x1', x(best.ts)); cross.setAttribute('x2', x(best.ts)); cross.setAttribute('opacity', 1);
    if (best.avg != null) { dotEl.setAttribute('cx', x(best.ts)); dotEl.setAttribute('cy', y(best.avg)); dotEl.setAttribute('opacity', 1); } else dotEl.setAttribute('opacity', 0);
    tip.replaceChildren(
      h('div.t', dateTime(best.ts)),
      h('div', 'avg ', h('b', ms(best.avg)), best.min != null && best.max != null && best.min !== best.max ? h('span.muted', `  (${best.min}–${best.max})`) : null),
      h('div.muted', `uptime ${pct(best.uptime)} · ${best.checks} check${best.checks === 1 ? '' : 's'}`));
    tip.classList.remove('hidden');
    tip.style.left = `${Math.min(Math.max(x(best.ts) / W * rect.width, 70), rect.width - 70)}px`;
    tip.style.top = `${(best.avg != null ? y(best.avg) : m.t + ih / 2) / H * rect.height}px`;
  });
  const hide = () => { tip.classList.add('hidden'); cross.setAttribute('opacity', 0); dotEl.setAttribute('opacity', 0); };
  svg.addEventListener('mouseleave', hide);
  return root;
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const f of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (f * p >= v) return f * p;
  return v;
}
