// Turns an episode (steps + captured screens + narration) into a HyperFrames project.
// Usage: node engine/build.mjs <episode-slug|n> [...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { episodes, ROOT } from './common.mjs';
import { lines, voicePath } from './tts.mjs';

const W = 1920; const H = 1080;
// App window on the canvas. The captured screen (1280×800 CSS px) fills its inner area.
const WIN = { x: 96, y: 128, bar: 34, w: 1344, h: 840 };
const S = WIN.w / 1280;
const RAIL = { x: 1476, y: 128, w: 348 };
const VOICE_LEAD = 0.35;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r3 = (n) => Math.round(n * 1000) / 1000;
// Inline markup for hints: [⌘K] keycaps, **bold**, `code`.
const rich = (s) => esc(s).replace(/\[([^\]]+)\]/g, (_, k) => k.split('+').map((x) => `<kbd>${x}</kbd>`).join('')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');

function voice(text) {
  const mp3 = voicePath(text); const meta = mp3.replace(/\.mp3$/, '.json');
  if (!fs.existsSync(meta)) throw new Error(`no narration yet for: "${text.slice(0, 50)}…" (run engine/tts.mjs)`);
  return { file: mp3, ...JSON.parse(fs.readFileSync(meta, 'utf8')) };
}

function camera(step) {
  const boxes = step.events.map((e) => e.box).filter(Boolean);
  const z0 = step.zoom;
  if (z0 === false || z0 === 1 || !boxes.length) return { z: 1, tx: 0, ty: 0 };
  let x1 = Math.min(...boxes.map((b) => b.x)); let y1 = Math.min(...boxes.map((b) => b.y));
  let x2 = Math.max(...boxes.map((b) => b.x + b.w)); let y2 = Math.max(...boxes.map((b) => b.y + b.h));
  if (typeof z0 === 'object' && z0) { ({ x: x1, y: y1 } = z0); x2 = z0.x + z0.w; y2 = z0.y + z0.h; }
  const pad = 70; const uw = x2 - x1 + pad * 2; const uh = y2 - y1 + pad * 2;
  let z = typeof z0 === 'number' ? z0 : Math.min(1280 / uw, 800 / uh, 1.55);
  if (z < 1.12) return { z: 1, tx: 0, ty: 0 };
  const k = S * z; const cx = (x1 + x2) / 2; const cy = (y1 + y2) / 2;
  const tx = Math.min(0, Math.max(WIN.w - 1280 * k, WIN.w / 2 - cx * k));
  const ty = Math.min(0, Math.max(WIN.h - 800 * k, WIN.h / 2 - cy * k));
  return { z: r3(z), tx: r3(tx), ty: r3(ty) };
}
const mapBox = (b, cam) => { const k = S * cam.z; return { x: r3(cam.tx + b.x * k), y: r3(cam.ty + b.y * k), w: r3(b.w * k), h: r3(b.h * k) }; };

// Lays every step out in time: when it starts, when each action happens.
function plan(ep, manifest) {
  const intro = voice(ep.intro); const outro = voice(ep.outro);
  const introDur = r3(Math.max(intro.duration + 1.2, 5));
  let t = 0; const steps = [];
  ep.steps.forEach((def, i) => {
    const cap = manifest.steps[i]; if (!cap || cap.id !== def.id) throw new Error(`manifest out of date at step ${def.id}: re-run capture`);
    const v = voice(def.say); const n = cap.events.length;
    const vStart = t + VOICE_LEAD; let prev = t + 0.9; let wi = 0;
    const span = Math.max(v.duration - 0.6, n * 1.5);
    const acts = cap.events.map((ev, k) => {
      let a = null;
      if (ev.at) {
        const want = ev.at.toLowerCase();
        for (let j = wi; j < v.words.length; j++) if (v.words[j].w.toLowerCase().replace(/[^\w⌘]/g, '').startsWith(want)) { a = vStart + v.words[j].t; wi = j + 1; break; }
        if (a == null) console.warn(`  ${ep.slug}/${def.id}: word "${ev.at}" not found in narration`);
      }
      if (a == null) a = vStart + 0.3 + ((k + 0.5) * span) / n;
      const minGap = ev.kind === 'look' || ev.kind === 'hold' ? 0.9 : 1.15;
      a = Math.max(a, prev + (k === 0 ? 0.6 : minGap));
      prev = a + (ev.kind === 'type' ? 0.9 : 0);
      return r3(a);
    });
    const end = Math.max(vStart + v.duration + 0.55, prev + (n ? 1.3 : 0.8), t + 2.5);
    steps.push({ def, cap, v, vStart: r3(vStart), start: r3(t), end: r3(end), acts, cam: camera({ ...cap, zoom: def.zoom ?? cap.zoom }) });
    t = end;
  });
  const tutDur = r3(t);
  const outroDur = r3(Math.max(outro.duration + 1.8, 5));
  return { intro, outro, introDur, tutDur, outroDur, steps, total: r3(introDur + tutDur + outroDur) };
}

// Rail rows: a collapsed height per step, plus its hint's height when open (estimated from text length).
function railLayout(ep) {
  const plain = (t) => String(t || '').replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]/g, (_, k) => k.split('+').map(() => 'WWW').join(''));
  const lines = (t, per) => { let n = 0; for (const para of plain(t).split('\n')) { let cur = 0; n++; for (const w of para.split(/\s+/)) { if (cur && cur + w.length + 1 > per) { n++; cur = w.length; } else cur += (cur ? 1 : 0) + w.length; } } return n; };
  const base = ep.steps.map((s) => 30 + Math.max(36, lines(s.title, 22) * 28) + 10);
  const hint = ep.steps.map((s) => (s.hint ? lines(s.hint, 25) * 26 + 10 : 0));
  const ys = ep.steps.map((_, a) => { let y = 0; return ep.steps.map((__, i) => { const v = y; y += base[i] + (i === a ? hint[i] : 0); return v; }); });
  const total = Math.max(...ep.steps.map((_, a) => base.reduce((x, b) => x + b, 0) + hint[a]));
  return { base, hint, ys, total };
}

const CSS_BASE = `
  --bg:#0d0f11; --panel:#15181b; --panel2:#1b1f23; --line:rgba(255,255,255,.09); --ink:#eef1f3; --muted:#8e98a3; --accent:#7fd6a4; --accent-ink:#0b2417; --warn:#f5c26b;`;

function introHtml(ep, P) {
  const items = ep.steps.map((s, i) => `<li id="in-item-${i}" class="clip" data-start="${r3(1.4 + i * 0.22)}" data-duration="${r3(P.introDur - 1.4 - i * 0.22)}"><span class="in-num">${i + 1}</span><span class="in-txt">${esc(s.title)}</span></li>`).join('\n      ');
  const tw = ep.steps.map((s, i) => `tl.fromTo('#in-item-${i} .in-txt, #in-item-${i} .in-num', {opacity:0, x:-18}, {opacity:1, x:0, duration:.45, ease:'power3.out', stagger:.04}, ${r3(1.4 + i * 0.22)});`).join('\n    ');
  return `<template>
  <style>
    #intro { position:absolute; inset:0; ${CSS_BASE} background:var(--bg); color:var(--ink); font-family:Inter, sans-serif; overflow:hidden; }
    #intro .in-glow { position:absolute; left:-200px; top:-260px; width:1200px; height:1200px; border-radius:50%; background:radial-gradient(circle, rgba(127,214,164,.16), rgba(127,214,164,0) 62%); }
    #intro .in-left { position:absolute; left:192px; top:250px; width:860px; }
    #intro .in-icon { width:96px; height:96px; border-radius:22px; display:block; margin-bottom:40px; }
    #intro .in-kicker span { display:inline-block; }
    #intro .in-kicker { font-size:22px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); margin-bottom:22px; }
    #intro .in-title span { display:inline-block; }
    #intro .in-title { font-size:78px; line-height:1.04; font-weight:900; letter-spacing:-.025em; margin:0 0 28px; }
    #intro .in-sum { font-size:30px; line-height:1.4; color:var(--muted); max-width:820px; }
    #intro .in-list { position:absolute; left:1150px; top:300px; width:580px; list-style:none; margin:0; padding:0; }
    #intro .in-list-h { position:absolute; left:1150px; top:250px; font-size:20px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
    #intro .in-list li { display:flex; align-items:center; gap:20px; height:74px; border-bottom:1px solid var(--line); font-size:28px; font-weight:700; }
    #intro .in-num { width:44px; height:44px; flex:none; border-radius:50%; border:2px solid var(--accent); color:var(--accent); display:flex; align-items:center; justify-content:center; font-size:20px; }
  </style>
  <div id="intro" data-composition-id="intro" data-width="${W}" data-height="${H}">
    <div class="in-glow"></div>
    <div class="in-left">
      <img id="in-icon" class="in-icon clip" src="assets/icon.svg" data-start="0" data-duration="${P.introDur}" alt="">
      <div id="in-kicker" class="in-kicker clip" data-start="0" data-duration="${P.introDur}"><span>${esc(ep.kicker || 'Dispatch how-to')} · ${String(ep.n).padStart(2, '0')}</span></div>
      <h1 id="in-title" class="in-title clip" data-start="0" data-duration="${P.introDur}"><span>${esc(ep.title)}</span></h1>
      <p id="in-sum" class="in-sum clip" data-start="0.6" data-duration="${r3(P.introDur - 0.6)}"><span>${esc(ep.summary)}</span></p>
    </div>
    <div id="in-list-h" class="in-list-h clip" data-start="1.2" data-duration="${r3(P.introDur - 1.2)}"><span>In this video</span></div>
    <ul class="in-list">
      ${items}
    </ul>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#in-icon', {scale:.94}, {scale:1, duration:.6, ease:'power3.out'}, 0);
    tl.fromTo('#intro .in-glow', {x:0, y:0}, {x:160, y:90, duration:${P.introDur}, ease:'none'}, 0);
    tl.fromTo('#intro .in-left', {x:0}, {x:-14, duration:${P.introDur}, ease:'none'}, 0);
    tl.fromTo('#in-kicker span', {y:8}, {y:0, duration:.5, ease:'power3.out'}, 0);
    tl.fromTo('#in-title span', {y:16}, {y:0, duration:.7, ease:'expo.out'}, 0);
    tl.fromTo('#in-sum span', {opacity:0, y:16}, {opacity:1, y:0, duration:.6, ease:'power3.out'}, .6);
    tl.fromTo('#in-list-h span', {opacity:0}, {opacity:1, duration:.4}, 1.2);
    ${tw}
    tl.to('#intro .in-left, #intro .in-list, #intro .in-list-h', {opacity:0, duration:.35, ease:'power2.in'}, ${r3(P.introDur - 0.4)});
    window.__timelines["intro"] = tl;
  </script>
</template>
`;
}

function tutorialHtml(ep, P) {
  const D = P.tutDur;
  const imgs = []; const over = []; const tw = []; const railTw = [];
  const rl = railLayout(ep);
  let z = 1;
  // Cursor starts parked lower right of the window.
  let cur = { x: WIN.w * 0.72, y: WIN.h * 0.8 };
  tw.push(`tl.set('#cursor', {x:${cur.x}, y:${cur.y}, opacity:0}, 0);`);
  const pointer = P.steps.some((st) => st.cap.events.some((e) => e.box && ['click', 'type', 'hover'].includes(e.kind)));
  if (pointer) tw.push(`tl.to('#cursor', {opacity:1, duration:.3}, .6);`);
  P.steps.forEach((st, si) => {
    const { cap, acts, cam } = st;
    // Camera.
    tw.push(`tl.to('#stage', {x:${cam.tx}, y:${cam.ty}, scale:${r3(S * cam.z)}, duration:${si === 0 ? 0.01 : 0.75}, ease:'power3.inOut'}, ${si === 0 ? 0 : st.start});`);
    // Screens: each event's "before" image, then the step's final image.
    const shows = [];
    cap.events.forEach((ev, k) => {
      const a = acts[k];
      if (ev.kind === 'type' && ev.frames?.length) {
        shows.push({ img: ev.img, t: k === 0 ? st.start : null });
        const n = ev.frames.length + 1;
        ev.frames.forEach((f, j) => shows.push({ img: f, t: a + (0.8 * (j + 1)) / n }));
      } else shows.push({ img: ev.img, t: k === 0 ? st.start : null });
      const nextT = ev.kind === 'type' ? a + 0.8 : ev.kind === 'look' || ev.kind === 'hover' ? a + 0.05 : a + 0.1;
      shows.push({ swapAt: nextT });
    });
    // Resolve: a sequence of [img, from]; "swapAt" marks when the next image takes over.
    const seq = []; let pending = st.start;
    for (const s of shows) {
      if (s.swapAt != null) { pending = s.swapAt; continue; }
      seq.push({ img: s.img, from: s.t ?? pending });
    }
    seq.push({ img: cap.final, from: pending });
    seq.forEach((s, j) => {
      const from = Math.max(s.from, j ? seq[j - 1].from : st.start);
      const to = j + 1 < seq.length ? Math.max(seq[j + 1].from, from) : st.end;
      if (to - from < 0.034) return;
      const id = `sh-${si}-${j}`;
      imgs.push(`<img id="${id}" class="clip shot" src="assets/shots/${s.img}" data-start="${r3(from)}" data-duration="${r3(to - from)}" data-track-index="1" alt="">`);
    });
    // Pointer, rings, labels, keys.
    cap.events.forEach((ev, k) => {
      const a = acts[k]; const id = `ev-${si}-${k}`;
      const b = ev.box ? mapBox(ev.box, cam) : null;
      if (b && (ev.kind === 'click' || ev.kind === 'type' || ev.kind === 'hover')) {
        const tx = r3(b.x + Math.min(b.w * 0.5, 60)); const ty = r3(b.y + b.h * 0.55);
        const travel = Math.min(0.75, Math.max(0.35, Math.hypot(tx - cur.x, ty - cur.y) / 1400));
        tw.push(`tl.to('#cursor', {x:${tx}, y:${ty}, duration:${r3(travel)}, ease:'power2.inOut'}, ${r3(a - travel - 0.08)});`);
        cur = { x: tx, y: ty };
        if (ev.kind !== 'hover') {
          tw.push(`tl.to('#cursor-img', {scale:.82, duration:.08, ease:'power2.out'}, ${r3(a - 0.04)}); tl.to('#cursor-img', {scale:1, duration:.18, ease:'power2.out'}, ${r3(a + 0.06)});`);
          over.push(`<div id="${id}-rip" class="clip rip" data-start="${r3(a - 0.02)}" data-duration="0.6" data-track-index="3" style="left:${tx - 30}px; top:${ty - 30}px"><i></i></div>`);
          tw.push(`tl.fromTo('#${id}-rip i', {scale:.2, opacity:.9}, {scale:1.4, opacity:0, duration:.55, ease:'expo.out'}, ${r3(a - 0.02)});`);
        }
      }
      if (b && ev.kind !== 'hold') {
        const isLook = ev.kind === 'look';
        const from = r3(a - (isLook ? 0.15 : 0.55));
        const until = isLook ? Math.min(st.end - 0.05, (acts[k + 1] ?? st.end) - 0.1, a + 2.6) : a + 0.45 + (ev.kind === 'type' ? 0.8 : 0);
        const dur = r3(Math.max(0.4, until - from));
        const pad = 6;
        over.push(`<div id="${id}-ring" class="clip ring${isLook ? ' look' : ''}" data-start="${from}" data-duration="${dur}" data-track-index="2" style="left:${r3(b.x - pad)}px; top:${r3(b.y - pad)}px; width:${r3(b.w + pad * 2)}px; height:${r3(b.h + pad * 2)}px"><i></i></div>`);
        tw.push(`tl.fromTo('#${id}-ring i', {opacity:0, scale:1.08}, {opacity:1, scale:1, duration:.3, ease:'power3.out'}, ${from});`);
        tw.push(`tl.to('#${id}-ring i', {opacity:0, duration:.2, ease:'power2.in'}, ${r3(from + dur - 0.22)});`);
        if (ev.label) {
          const above = b.y > 70; const cx = b.x + b.w / 2;
          const style = above ? `left:${r3(cx)}px; top:${r3(b.y - pad - 14)}px` : `left:${r3(cx)}px; top:${r3(b.y + b.h + pad + 14)}px`;
          over.push(`<div id="${id}-lab" class="clip lab ${above ? 'up' : 'down'}" data-start="${from}" data-duration="${dur}" data-track-index="2" style="${style}"><span>${rich(ev.label)}</span></div>`);
          tw.push(`tl.fromTo('#${id}-lab span', {opacity:0, y:${above ? 8 : -8}}, {opacity:1, y:0, duration:.32, ease:'power3.out'}, ${r3(from + 0.05)});`);
          tw.push(`tl.to('#${id}-lab span', {opacity:0, duration:.2}, ${r3(from + dur - 0.22)});`);
        }
      }
      if (ev.kind === 'key') {
        const from = r3(a - 0.35); const dur = 1.5;
        over.push(`<div id="${id}-key" class="clip keys" data-start="${from}" data-duration="${dur}" data-track-index="4"><span>${String(ev.keys).split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join('<em>+</em>')}${ev.label ? `<small>${esc(ev.label)}</small>` : ''}</span></div>`);
        tw.push(`tl.fromTo('#${id}-key span', {opacity:0, y:20, scale:.96}, {opacity:1, y:0, scale:1, duration:.3, ease:'back.out(1.6)'}, ${from});`);
        tw.push(`tl.to('#${id}-key span', {opacity:0, y:10, duration:.25, ease:'power2.in'}, ${r3(from + dur - 0.27)});`);
      }
    });
    // Rail: this step becomes current (its hint opens, the others slide), the previous one is ticked off.
    const T = r3(st.start + 0.05);
    rl.ys[si].forEach((y, i) => railTw.push(`tl.to('#rs-${i}', {y:${y}, duration:${si === 0 ? 0.01 : 0.45}, ease:'power3.inOut'}, ${si === 0 ? 0 : T});`));
    railTw.push(`tl.to('#rs-${si}', {opacity:1, duration:.35, ease:'power2.out'}, ${T});`);
    railTw.push(`tl.to('#rs-${si} .rs-bg', {opacity:1, duration:.35, ease:'power2.out'}, ${T});`);
    railTw.push(`tl.fromTo('#rs-${si} .rs-hint', {opacity:0, clipPath:'inset(0 100% 0 0)'}, {opacity:1, clipPath:'inset(0 0% 0 0)', duration:.9, ease:'power2.out'}, ${r3(st.start + 0.3)});`);
    railTw.push(`tl.to('#rail-bar i', {scaleX:${r3((si + 1) / P.steps.length)}, duration:.5, ease:'power3.out'}, ${T});`);
    railTw.push(`tl.set('#rail-count', {textContent:'${si + 1} / ${P.steps.length}'}, ${T});`);
    if (si > 0) {
      railTw.push(`tl.to('#rs-${si - 1}', {opacity:.72, duration:.35}, ${T});`);
      railTw.push(`tl.to('#rs-${si - 1} .rs-bg, #rs-${si - 1} .rs-hint', {opacity:0, duration:.3}, ${T});`);
      railTw.push(`tl.fromTo('#rs-${si - 1} .rs-check', {scale:0, opacity:0}, {scale:1, opacity:1, duration:.35, ease:'back.out(2)'}, ${T});`);
    }
    z = cam.z;
  });
  const last = P.steps.length - 1;
  railTw.push(`tl.to('#rs-${last} .rs-bg', {opacity:0, duration:.3}, ${r3(D - 0.6)});`);
  railTw.push(`tl.fromTo('#rs-${last} .rs-check', {scale:0, opacity:0}, {scale:1, opacity:1, duration:.35, ease:'back.out(2)'}, ${r3(D - 0.6)});`);

  const rail = ep.steps.map((s, i) => `
      <div id="rs-${i}" class="rs" style="height:${r3(rl.base[i] + rl.hint[i])}px"><div class="rs-bg"></div>
        <div class="rs-num"><span>${i + 1}</span><b class="rs-check">✓</b></div>
        <div class="rs-body"><div class="rs-title">${rich(s.title)}</div><div class="rs-hint">${rich(s.hint || '')}</div></div>
      </div>`).join('');

  return `<template>
  <style>
    #tutorial { position:absolute; inset:0; ${CSS_BASE} background:var(--bg); color:var(--ink); font-family:Inter, sans-serif; overflow:hidden; }
    #tutorial .glow { position:absolute; left:300px; top:200px; width:1300px; height:900px; border-radius:50%; background:radial-gradient(closest-side, rgba(127,214,164,.10), rgba(127,214,164,0)); }
    #tutorial .hdr { position:absolute; left:${WIN.x}px; top:46px; width:${RAIL.x + RAIL.w - WIN.x}px; }
    #tutorial .hdr-k { font-size:16px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); }
    #tutorial .hdr-t { font-size:36px; font-weight:900; letter-spacing:-.015em; margin-top:8px; white-space:nowrap; }
    #tutorial .win { position:absolute; left:${WIN.x}px; top:${WIN.y}px; width:${WIN.w}px; height:${WIN.h + WIN.bar}px; border-radius:14px; background:#1e2125; box-shadow:0 30px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.1); overflow:hidden; }
    #tutorial .bar { height:${WIN.bar}px; display:flex; align-items:center; gap:8px; padding:0 14px; background:#24272b; border-bottom:1px solid rgba(0,0,0,.4); }
    #tutorial .bar i { width:12px; height:12px; border-radius:50%; background:#ff5f57; display:block; }
    #tutorial .bar i:nth-child(2) { background:#febc2e; } #tutorial .bar i:nth-child(3) { background:#28c840; }
    #tutorial .bar span { margin-left:auto; margin-right:auto; font-size:13px; color:#9aa3ad; font-weight:700; transform:translateX(-30px); }
    #tutorial .inner { position:absolute; left:0; top:${WIN.bar}px; width:${WIN.w}px; height:${WIN.h}px; overflow:hidden; }
    #tutorial #stage { position:absolute; left:0; top:0; width:1280px; height:800px; transform-origin:0 0; }
    #tutorial .shot { position:absolute; left:0; top:0; width:1280px; height:800px; }
    #tutorial .ov { position:absolute; inset:0; }
    #tutorial .ring { position:absolute; }
    #tutorial .ring i { position:absolute; inset:0; border-radius:10px; border:3px solid var(--accent); box-shadow:0 0 0 4px rgba(127,214,164,.22), 0 0 24px rgba(127,214,164,.45); display:block; }
    #tutorial .ring.look i { border-color:var(--warn); box-shadow:0 0 0 4px rgba(245,194,107,.22), 0 0 0 4000px rgba(5,7,9,.42); }
    #tutorial .lab { position:absolute; width:0; height:0; }
    #tutorial .lab span { position:absolute; left:0; white-space:nowrap; transform:translateX(-50%); background:var(--accent); color:var(--accent-ink); font-weight:700; font-size:19px; padding:8px 14px; border-radius:9px; box-shadow:0 8px 24px rgba(0,0,0,.4); }
    #tutorial .lab.up span { bottom:0; } #tutorial .lab.down span { top:0; }
    #tutorial .lab kbd, #tutorial .keys kbd, #tutorial .rs kbd { font-family:Inter, sans-serif; font-weight:700; }
    #tutorial .lab kbd { background:rgba(0,0,0,.14); border-radius:5px; padding:1px 6px; margin:0 2px; }
    #tutorial .rip { position:absolute; width:60px; height:60px; }
    #tutorial .rip i { position:absolute; inset:0; border-radius:50%; border:3px solid #fff; display:block; }
    #tutorial #cursor { position:absolute; left:0; top:0; width:30px; height:30px; z-index:20; }
    #tutorial #cursor-img { width:30px; height:30px; display:block; transform-origin:4px 3px; filter:drop-shadow(0 3px 6px rgba(0,0,0,.5)); }
    #tutorial .keys { position:absolute; left:0; right:0; bottom:46px; height:90px; text-align:center; z-index:15; }
    #tutorial .keys span { display:inline-flex; align-items:center; gap:10px; background:rgba(16,18,21,.92); border:1px solid rgba(255,255,255,.14); border-radius:18px; padding:14px 22px; box-shadow:0 18px 50px rgba(0,0,0,.5); }
    #tutorial .keys kbd { min-width:58px; height:58px; padding:0 14px; display:inline-flex; align-items:center; justify-content:center; font-size:28px; color:var(--ink); background:linear-gradient(#2c3137, #22262b); border:1px solid rgba(255,255,255,.18); border-bottom-width:4px; border-radius:11px; }
    #tutorial .keys em { font-style:normal; color:var(--muted); font-size:24px; }
    #tutorial .keys small { margin-left:10px; font-size:20px; color:var(--muted); font-weight:700; }
    #tutorial .rail { position:absolute; left:${RAIL.x}px; top:${RAIL.y}px; width:${RAIL.w}px; }
    #tutorial .rail-h { display:flex; justify-content:space-between; align-items:baseline; font-size:15px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
    #tutorial #rail-count { letter-spacing:.04em; color:var(--ink); }
    #tutorial #rail-bar { height:4px; border-radius:2px; background:rgba(255,255,255,.08); margin:12px 0 18px; overflow:hidden; }
    #tutorial #rail-bar i { display:block; height:100%; background:var(--accent); transform-origin:0 0; }
    #tutorial .rs { position:absolute; left:0; top:0; width:${RAIL.w}px; display:flex; gap:16px; padding:14px 16px 16px 14px; opacity:.6; }
    #tutorial .rs-list { position:relative; height:${rl.total}px; }
    #tutorial .rs-bg { position:absolute; inset:0; border-radius:14px; background:var(--panel2); box-shadow:inset 0 0 0 1px rgba(127,214,164,.35); opacity:0; }
    #tutorial .rs-num { position:relative; width:36px; height:36px; flex:none; border-radius:50%; border:2px solid var(--accent); color:var(--accent); font-weight:700; font-size:17px; display:flex; align-items:center; justify-content:center; }
    #tutorial .rs-check { position:absolute; inset:-2px; border-radius:50%; background:var(--accent); color:var(--accent-ink); display:flex; align-items:center; justify-content:center; font-size:19px; opacity:0; }
    #tutorial .rs-body { position:relative; min-width:0; flex:1; overflow-wrap:anywhere; }
    #tutorial .rs-title { font-size:22px; font-weight:700; line-height:28px; padding-top:4px; }
    #tutorial .rs-hint { font-size:18px; line-height:26px; color:#c6ced6; margin-top:7px; opacity:0; }
    #tutorial .rs-hint kbd { display:inline-block; min-width:24px; padding:1px 7px; margin:0 2px; text-align:center; font-size:15px; color:var(--ink); background:#2a2f35; border:1px solid rgba(255,255,255,.16); border-bottom-width:2px; border-radius:6px; }
    #tutorial .rs-hint code, #tutorial .rs-title code { font-family:'JetBrains Mono', monospace; font-size:.88em; color:var(--accent); background:rgba(127,214,164,.08); padding:1px 5px; border-radius:5px; }
    #tutorial .rs-hint b { color:var(--ink); }
  </style>
  <div id="tutorial" data-composition-id="tutorial" data-width="${W}" data-height="${H}">
    <div class="glow"></div>
    <div class="hdr"><div class="hdr-k">${esc(ep.kicker || 'Dispatch how-to')} · ${String(ep.n).padStart(2, '0')}</div><div class="hdr-t">${esc(ep.title)}</div></div>
    <div class="win">
      <div class="bar"><i></i><i></i><i></i><span>${esc(ep.window || 'Dispatch')}</span></div>
      <div class="inner" data-layout-allow-overflow>
        <div id="stage">
          ${imgs.join('\n          ')}
        </div>
        <div class="ov" data-layout-allow-overlap>
          ${over.join('\n          ')}
          <div id="cursor"><svg id="cursor-img" viewBox="0 0 24 24"><path d="M4 2.5v17.2l4.6-4.3 2.9 6.6 3-1.3-2.9-6.5H18L4 2.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
        </div>
      </div>
    </div>
    <div class="rail" data-layout-allow-overlap>
      <div class="rail-h"><span>Steps</span><span id="rail-count">1 / ${ep.steps.length}</span></div>
      <div id="rail-bar"><i></i></div>
      <div class="rs-list">${rail}
      </div>
    </div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.set('#rail-bar i', {scaleX:0}, 0);
    tl.fromTo('#tutorial .win', {opacity:0, y:24}, {opacity:1, y:0, duration:.6, ease:'expo.out'}, 0);
    tl.fromTo('#tutorial .hdr, #tutorial .rail', {opacity:0}, {opacity:1, duration:.5, ease:'power2.out'}, .1);
    ${tw.join('\n    ')}
    ${railTw.join('\n    ')}
    tl.to('#tutorial .win, #tutorial .rail, #tutorial .hdr', {opacity:0, duration:.35, ease:'power2.in'}, ${r3(D - 0.36)});
    window.__timelines["tutorial"] = tl;
  </script>
</template>
`;
}

function outroHtml(ep, P, next) {
  const items = ep.steps.map((s, i) => `<li id="out-item-${i}" class="clip" data-start="${r3(0.7 + i * 0.16)}" data-duration="${r3(P.outroDur - 0.7 - i * 0.16)}"><b>✓</b><span>${rich(s.title)}</span></li>`).join('\n      ');
  const tw = ep.steps.map((s, i) => `tl.fromTo('#out-item-${i} b, #out-item-${i} span', {opacity:0, x:-14}, {opacity:1, x:0, duration:.4, ease:'power3.out', stagger:.05}, ${r3(0.7 + i * 0.16)});`).join('\n    ');
  return `<template>
  <style>
    #outro { position:absolute; inset:0; ${CSS_BASE} background:var(--bg); color:var(--ink); font-family:Inter, sans-serif; overflow:hidden; }
    #outro .o-glow { position:absolute; right:-300px; bottom:-400px; width:1300px; height:1300px; border-radius:50%; background:radial-gradient(circle, rgba(127,214,164,.15), rgba(127,214,164,0) 62%); }
    #outro .o-left { position:absolute; left:192px; top:240px; width:760px; }
    #outro .o-k { font-size:22px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); }
    #outro .o-t { font-size:84px; font-weight:900; letter-spacing:-.03em; margin:18px 0 26px; }
    #outro .o-next { font-size:28px; color:var(--muted); line-height:1.45; }
    #outro .o-next b { color:var(--ink); }
    #outro .o-url { position:absolute; left:192px; top:820px; display:flex; align-items:center; gap:18px; font-size:28px; font-weight:700; }
    #outro .o-url img { width:56px; height:56px; border-radius:13px; }
    #outro ul { position:absolute; left:1060px; top:250px; width:680px; list-style:none; margin:0; padding:0; }
    #outro li { display:flex; gap:18px; align-items:center; font-size:27px; font-weight:700; padding:16px 0; border-bottom:1px solid var(--line); }
    #outro li b { width:40px; height:40px; flex:none; border-radius:50%; background:var(--accent); color:var(--accent-ink); display:flex; align-items:center; justify-content:center; font-size:21px; }
    #outro code { font-family:'JetBrains Mono', monospace; font-size:.85em; color:var(--accent); }
    #outro kbd { font-family:Inter, sans-serif; }
  </style>
  <div id="outro" data-composition-id="outro" data-width="${W}" data-height="${H}">
    <div class="o-glow"></div>
    <div class="o-left">
      <div id="o-k" class="o-k clip" data-start="0.1" data-duration="${r3(P.outroDur - 0.1)}"><span>${esc(ep.kicker || 'Dispatch how-to')} · ${String(ep.n).padStart(2, '0')}</span></div>
      <div id="o-t" class="o-t clip" data-start="0.2" data-duration="${r3(P.outroDur - 0.2)}"><span>${esc(ep.doneTitle || "That's it.")}</span></div>
      ${next ? `<div id="o-next" class="o-next clip" data-start="1.2" data-duration="${r3(P.outroDur - 1.2)}"><span>Next up: <b>${esc(next.title)}</b></span></div>` : ''}
    </div>
    <div id="o-url" class="o-url clip" data-start="1.0" data-duration="${r3(P.outroDur - 1.0)}"><img src="assets/icon.svg" alt=""><span>dispatch.ashlabs.xyz</span></div>
    <ul>
      ${items}
    </ul>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#o-k span', {opacity:0, y:12}, {opacity:1, y:0, duration:.5, ease:'power3.out'}, .1);
    tl.fromTo('#o-t span', {opacity:0, y:26}, {opacity:1, y:0, duration:.7, ease:'expo.out'}, .2);
    ${next ? `tl.fromTo('#o-next span', {opacity:0}, {opacity:1, duration:.5}, 1.2);` : ''}
    tl.fromTo('#o-url img, #o-url span', {opacity:0, y:10}, {opacity:1, y:0, duration:.5, ease:'power3.out', stagger:.08}, 1.0);
    ${tw}
    window.__timelines["outro"] = tl;
  </script>
</template>
`;
}

function music(dur, out) {
  const src = path.join(ROOT, 'shared', 'music-main.mp3');
  // Loop the bed with a crossfade until it covers the film, then fade in and out.
  const len = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).toString());
  const loops = Math.ceil(dur / (len - 4)) ;
  const inputs = []; for (let i = 0; i < loops; i++) inputs.push('-i', src);
  let filter = ''; let last = '[0:a]';
  for (let i = 1; i < loops; i++) { filter += `${last}[${i}:a]acrossfade=d=4:c1=tri:c2=tri[x${i}];`; last = `[x${i}]`; }
  filter += `${last}atrim=0:${dur},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, dur - 3)}:d=3[out]`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-b:a', '160k', out]);
}

export async function build(ep, all) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'shots', ep.slug, 'manifest.json'), 'utf8'));
  const P = plan(ep, manifest);
  const dir = path.join(ROOT, 'build', ep.slug);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ['compositions', 'assets/shots', 'assets/voice', 'assets/sfx']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  // Assets.
  const used = new Set();
  manifest.steps.forEach((s) => { s.events.forEach((e) => { used.add(e.img); (e.frames || []).forEach((f) => used.add(f)); }); used.add(s.final); });
  for (const f of used) fs.copyFileSync(path.join(ROOT, 'shots', ep.slug, f), path.join(dir, 'assets/shots', f));
  fs.copyFileSync(path.join(ROOT, 'shared', 'app-icon.svg'), path.join(dir, 'assets/icon.svg'));
  fs.copyFileSync(path.join(ROOT, 'shared', 'gsap.min.js'), path.join(dir, 'assets/gsap.min.js'));
  for (const f of fs.readdirSync(path.join(ROOT, 'shared', 'sfx'))) fs.copyFileSync(path.join(ROOT, 'shared', 'sfx', f), path.join(dir, 'assets/sfx', f));
  music(P.total, path.join(dir, 'assets', 'music.mp3'));

  const idx = all.findIndex((e) => e.slug === ep.slug); const next = all[idx + 1];
  fs.writeFileSync(path.join(dir, 'compositions', 'intro.html'), introHtml(ep, P));
  fs.writeFileSync(path.join(dir, 'compositions', 'tutorial.html'), tutorialHtml(ep, P));
  fs.writeFileSync(path.join(dir, 'compositions', 'outro.html'), outroHtml(ep, P, next));

  // Audio: narration per line, clicks/keys/typing on the actions they belong to.
  const audio = []; const T0 = P.introDur;
  const addVoice = (id, v, at) => { const f = path.basename(v.file); fs.copyFileSync(v.file, path.join(dir, 'assets/voice', f)); audio.push(`<audio id="vo-${id}" class="clip" src="assets/voice/${f}" data-start="${r3(at)}" data-duration="${r3(v.duration)}" data-track-index="10" data-volume="1"></audio>`); };
  addVoice('intro', P.intro, 0.5);
  P.steps.forEach((st, i) => {
    addVoice(`s${i}`, st.v, T0 + st.vStart);
    st.cap.events.forEach((ev, k) => {
      const a = T0 + st.acts[k];
      if (ev.kind === 'click') audio.push(`<audio id="fx-${i}-${k}" class="clip" src="assets/sfx/${k % 2 ? 'click-soft' : 'click'}.mp3" data-start="${r3(a - 0.01)}" data-duration="0.4" data-track-index="12" data-volume="0.35"></audio>`);
      if (ev.kind === 'key') audio.push(`<audio id="fx-${i}-${k}" class="clip" src="assets/sfx/key-press.mp3" data-start="${r3(a - 0.01)}" data-duration="0.4" data-track-index="12" data-volume="0.4"></audio>`);
      if (ev.kind === 'type') audio.push(`<audio id="fx-${i}-${k}" class="clip" src="assets/sfx/typing.mp3" data-start="${r3(a)}" data-duration="0.85" data-track-index="12" data-volume="0.22" data-fade-out="0.2"></audio>`);
    });
  });
  addVoice('outro', P.outro, T0 + P.tutDur + 0.4);
  audio.push(`<audio id="fx-in" class="clip" src="assets/sfx/whoosh-short.mp3" data-start="${r3(T0 - 0.25)}" data-duration="0.57" data-track-index="12" data-volume="0.25"></audio>`);
  audio.push(`<audio id="music" class="clip" src="assets/music.mp3" data-start="0" data-duration="${P.total}" data-track-index="11" data-volume="0.13"></audio>`);

  const host = (id, start, dur) => `<div id="${id}" class="clip scene-host" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${r3(start)}" data-duration="${r3(dur)}" data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}"></div>`;
  const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${esc(ep.title)} · Dispatch how-to</title>
    <script src="assets/gsap.min.js"></script>
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      html, body { width:${W}px; height:${H}px; overflow:hidden; background:#0d0f11; }
      #root { position:relative; width:100%; height:100%; overflow:hidden; }
      .scene-host { position:absolute; inset:0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${P.total}" data-width="${W}" data-height="${H}">
      ${host('intro', 0, P.introDur)}
      ${host('tutorial', T0, P.tutDur)}
      ${host('outro', T0 + P.tutDur, P.outroDur)}
      ${audio.join('\n      ')}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(dir, 'index.html'), index);
  fs.writeFileSync(path.join(dir, 'hyperframes.json'), JSON.stringify({ $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json', paths: { blocks: 'compositions', assets: 'assets' }, authoringSkill: 'hyperframes' }, null, 2));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: ep.slug, name: ep.title }, null, 2));
  console.log(`built ${ep.slug}: ${P.total.toFixed(1)} s (${P.steps.length} steps)`);
  return P;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = await episodes(); const want = process.argv.slice(2);
  for (const ep of all.filter((e) => !want.length || want.includes(e.slug) || want.some((w) => Number(w) === e.n))) await build(ep, all);
}
