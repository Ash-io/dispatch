// Narration with ElevenLabs, one file per line, cached by text so re-runs cost nothing.
// Usage: node engine/tts.mjs [--dry] <episode-slug|n> [...]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { episodes, ROOT, REPO } from './common.mjs';

export const VOICE = process.env.VOICE_ID || 'reGkImJki7uJOve2F4A0'; // Ifeoma Odumodu, Nigerian English narrator
const MODEL = 'eleven_multilingual_v2';
const SETTINGS = { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 1.0 };

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const src = fs.readFileSync(path.join(REPO, 'launch-video/generate_voiceover.mjs'), 'utf8');
  const m = src.match(/sk_[0-9a-f]{48}/);
  if (!m) throw new Error('Set ELEVENLABS_API_KEY');
  return m[0];
}

export function lines(ep) {
  const out = [{ id: 'intro', text: ep.intro }];
  ep.steps.forEach((s) => out.push({ id: s.id, text: s.say }));
  out.push({ id: 'outro', text: ep.outro });
  return out.filter((l) => l.text);
}

export const hash = (text) => crypto.createHash('sha1').update(`${VOICE}|${MODEL}|${JSON.stringify(SETTINGS)}|${text}`).digest('hex').slice(0, 16);
export const voicePath = (text) => path.join(ROOT, 'voice', `${hash(text)}.mp3`);

async function speak(text) {
  const mp3 = voicePath(text); const meta = mp3.replace(/\.mp3$/, '.json');
  if (fs.existsSync(mp3) && fs.existsSync(meta)) return false;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  fs.writeFileSync(mp3, Buffer.from(d.audio_base64, 'base64'));
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3]).toString().trim());
  // Word start times, for syncing actions to what is said.
  const a = d.alignment; const words = []; let cur = null;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { cur = null; return; }
    if (!cur) { cur = { w: '', t: a.character_start_times_seconds[i] }; words.push(cur); }
    cur.w += ch; cur.e = a.character_end_times_seconds[i];
  });
  fs.writeFileSync(meta, JSON.stringify({ text, duration: dur, words }));
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2); const dry = args.includes('--dry');
  const want = args.filter((a) => a !== '--dry');
  const list = (await episodes()).filter((e) => !want.length || want.includes(e.slug) || want.some((w) => Number(w) === e.n));
  let total = 0; let todo = 0;
  for (const ep of list) {
    const ls = lines(ep); const chars = ls.reduce((n, l) => n + l.text.length, 0);
    const missing = ls.filter((l) => !fs.existsSync(voicePath(l.text)));
    total += chars; todo += missing.reduce((n, l) => n + l.text.length, 0);
    console.log(`${ep.slug}: ${chars} chars, ${missing.length}/${ls.length} lines to make`);
    if (!dry) for (const l of missing) { await speak(l.text); process.stdout.write('.'); }
    if (!dry && missing.length) process.stdout.write('\n');
  }
  console.log(`total ${total} chars, ${todo} not yet made${dry ? ' (dry run)' : ''}`);
}
