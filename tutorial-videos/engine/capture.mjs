// Drives the real Dispatch UI (browser build or the server admin panel) and records,
// per step, the screen states and the boxes of what the viewer should look at.
// Usage: node engine/capture.mjs <episode-slug> [...more]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { episodes, ROOT, VIEW } from './common.mjs';

const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;

class Recorder {
  constructor(page, dir) {
    this.page = page; this.dir = dir; this.n = 0; this.steps = []; this.cur = null;
  }
  async snap() {
    const file = `s${String(++this.n).padStart(3, '0')}.jpg`;
    await this.page.waitForTimeout(120);
    await this.page.screenshot({ path: path.join(this.dir, file), type: 'jpeg', quality: 90 });
    return file;
  }
  async box(target) {
    if (!target) return null;
    if (typeof target === 'object' && 'x' in target) return target;
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  }
  begin(step) { this.cur = { id: step.id, events: [], zoom: step.zoom ?? 'auto', final: null }; this.steps.push(this.cur); }
  async push(ev) { ev.img = await this.snap(); this.cur.events.push(ev); return ev; }
  // Visible actions. Each records the screen *before* the action.
  async click(target, o = {}) {
    const ev = await this.push({ kind: 'click', box: await this.box(target), label: o.label, at: o.at });
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    if (o.dbl) await loc.dblclick(); else await loc.click(o.clickOpts);
    await this.page.waitForTimeout(o.wait ?? 450);
    return ev;
  }
  async hover(target, o = {}) {
    const ev = await this.push({ kind: 'hover', box: await this.box(target), label: o.label, at: o.at });
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.hover(); await this.page.waitForTimeout(o.wait ?? 350);
    return ev;
  }
  async type(target, text, o = {}) {
    const box = await this.box(target);
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    const ev = await this.push({ kind: 'type', box, label: o.label, text: o.show ?? text, at: o.at, frames: [] });
    await loc.click(o.clickOpts); if (o.clear !== false) await loc.press('ControlOrMeta+a').catch(() => {});
    const parts = o.frames ?? 4;
    for (let i = 1; i <= parts; i++) {
      const upto = Math.round((text.length * i) / parts);
      const prev = Math.round((text.length * (i - 1)) / parts);
      await this.page.keyboard.type(text.slice(prev, upto), { delay: 0 });
      if (i < parts) ev.frames.push(await this.snap());
    }
    if (o.enter) await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(o.wait ?? 400);
    return ev;
  }
  // Paste-like fill (for long values: code, JSON). Shown as one swap.
  async fill(target, text, o = {}) {
    const box = await this.box(target);
    const ev = await this.push({ kind: 'type', box, label: o.label, text: o.show ?? '', at: o.at, frames: [] });
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.fill(text); await this.page.waitForTimeout(o.wait ?? 400);
    return ev;
  }
  async press(keys, o = {}) {
    const ev = await this.push({ kind: 'key', box: o.target ? await this.box(o.target) : null, keys: o.show ?? keys, label: o.label, at: o.at });
    await this.page.keyboard.press(keys); await this.page.waitForTimeout(o.wait ?? 450);
    return ev;
  }
  async look(target, o = {}) {
    return this.push({ kind: 'look', box: await this.box(target), label: o.label, at: o.at });
  }
  // A screen state with no pointer (e.g. let a result land).
  async hold(o = {}) { if (o.wait) await this.page.waitForTimeout(o.wait); return this.push({ kind: 'hold', box: null, at: o.at }); }
  // Invisible setup between events.
  async quietly(fn) { await fn(this.page); }
  async end() { this.cur.final = await this.snap(); }
}

async function run(ep) {
  const dir = path.join(ROOT, 'shots', ep.slug);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--font-render-hinting=none'] });
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-GB' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const rec = new Recorder(page, dir);
  const env = await ep.setup?.(page, ctx) ;
  for (const step of ep.steps) {
    rec.begin(step);
    try { await step.run(rec, page, env); }
    catch (e) { await page.screenshot({ path: path.join(dir, `FAILED-${step.id}.png`) }); throw new Error(`${ep.slug}/${step.id}: ${e.message}`); }
    await rec.end();
  }
  await ep.teardown?.(env);
  await browser.close();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ view: VIEW, steps: rec.steps }, null, 1));
  console.log(`captured ${ep.slug}: ${rec.steps.length} steps, ${rec.n} frames${errs.length ? `, page errors: ${errs.join(' | ')}` : ''}`);
}

const want = process.argv.slice(2);
const list = (await episodes()).filter((e) => !want.length || want.includes(e.slug) || want.some((w) => Number(w) === e.n));
for (const ep of list) await run(ep);
