// The AI's part: short pieces of text, each tied to the facts it rests on.
// Everything it returns is checked; anything that fails twice becomes a
// visible gap for a person to fill, never a guess on the published page.

export const BANNED = [
  'allows you to', 'allow you to', 'enables you to', 'enable you to', 'lets you', 'seamless', 'seamlessly', 'robust', 'leverage', 'leverages',
  'comprehensive', 'powerful', 'easily', 'simply', 'this endpoint', 'this api endpoint', 'utilize', 'utilizes', 'in order to', 'facilitate',
  'effortless', 'cutting-edge', 'state-of-the-art', 'streamline', 'delve', 'unlock', 'game-changer', 'plethora', 'myriad', 'a wide range of',
  "it's important to note", 'it is important to note', 'please note', 'note that', 'designed to', 'serves as', 'responsible for',
];
const HEDGES = /\b(may|might|probably|likely|presumably|possibly|perhaps|typically|usually|generally|appears to|seems to)\b/i;
const LIMITS = { summary: 60, field: 25, param: 25, error: 30, step: 35, overview: 70 };

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { target: { type: 'string' }, text: { type: 'string' }, factIds: { type: 'array', items: { type: 'string' } } },
        required: ['target', 'text', 'factIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export function systemPrompt(styleSample = '') {
  const style = styleSample.trim() ? `\n\nMatch the tone and sentence style of this sample from documentation the team likes. Use none of its facts:\n"""\n${styleSample.trim().slice(0, 2000)}\n"""` : '';
  return `You write reference documentation for an HTTP API. You get FACTS (id → text) observed from the team's real requests, responses and tests, and TARGETS (id → what to write). For each target, return the text and the ids of the facts it rests on.

Rules:
- Use only what the cited facts say. When they don't support a useful sentence, return an empty text for that target. An empty text is better than a guess.
- Every number, status code, field name, parameter name and value you mention must appear in a fact you cite. Write field, parameter and header names in backticks.
- Say plainly what the thing is or does. Describe a field or parameter by what its value is, for example "Total price in the smallest currency unit, such as cents." Don't start with "This field" or "This parameter".
- Never use these words or phrases: ${BANNED.map((b) => `"${b}"`).join(', ')}. No marketing language. No hedging words such as "may", "might", "likely", "typically" or "usually": if the facts aren't certain, leave the text empty.
- No exclamation marks, questions or emojis.
- Length: a summary is at most two sentences. A field or parameter description is one sentence of at most 25 words. An error fix is one sentence of at most 30 words that says what the caller should change. A quickstart step is one sentence.
- Don't start several summaries the same way.${style}`;
}

const words = (t) => t.trim().split(/\s+/).filter(Boolean).length;
const sentences = (t) => t.trim().split(/(?<=[.!?])\s+(?=[A-Z`"(])/).filter(Boolean).length;

/** Problems with one written item; an empty list means it can be used. */
export function lint(item, { kind, facts, allowed }) {
  const problems = [];
  const text = (item.text || '').trim();
  if (!text) return ['left empty'];
  const ids = Array.isArray(item.factIds) ? item.factIds : [];
  if (!ids.length) problems.push('cites no facts');
  const missing = ids.filter((id) => !facts.has(id));
  if (missing.length) problems.push(`cites facts that don't exist: ${missing.slice(0, 3).join(', ')}`);
  const foreign = ids.filter((id) => facts.has(id) && allowed && !allowed.has(id));
  if (foreign.length) problems.push(`cites facts from another page: ${foreign.slice(0, 3).join(', ')}`);
  const lower = text.toLowerCase();
  const banned = BANNED.filter((b) => lower.includes(b));
  if (banned.length) problems.push(`uses banned wording: ${banned.map((b) => `"${b}"`).join(', ')}`);
  const hedge = HEDGES.exec(text);
  if (hedge) problems.push(`hedges with "${hedge[0]}"`);
  if (/[!?]/.test(text)) problems.push('uses ! or ?');
  if (/\p{Extended_Pictographic}/u.test(text)) problems.push('uses an emoji');
  const limit = LIMITS[kind] || 40;
  if (words(text) > limit) problems.push(`is ${words(text)} words; the limit is ${limit}`);
  if ((kind === 'field' || kind === 'param' || kind === 'error' || kind === 'step') && sentences(text) > 1) problems.push('should be one sentence');
  if ((kind === 'summary' || kind === 'overview') && sentences(text) > 2) problems.push('should be at most two sentences');
  // Grounding: specifics must come from the cited facts.
  const cited = ids.filter((id) => facts.has(id)).map((id) => facts.get(id).text).join('\n');
  const citedLower = cited.toLowerCase();
  for (const m of text.matchAll(/`([^`]+)`/g)) if (!citedLower.includes(m[1].toLowerCase())) problems.push(`mentions \`${m[1]}\`, which isn't in the cited facts`);
  const stripped = text.replace(/`[^`]*`/g, ' ');
  for (const m of stripped.matchAll(/\b\d+(?:\.\d+)?\b/g)) if (!cited.includes(m[0])) problems.push(`mentions ${m[0]}, which isn't in the cited facts`);
  for (const m of stripped.matchAll(/\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)) if (!citedLower.includes(m[0].toLowerCase())) problems.push(`mentions ${m[0]}, which isn't in the cited facts`);
  return [...new Set(problems)];
}

/** Summaries in one section that start with the same two words: all but the first are flagged. */
export function repeatedOpenings(items) {
  const seen = new Map();
  const flagged = new Set();
  for (const it of items) {
    const start = (it.text || '').trim().toLowerCase().split(/\s+/).slice(0, 2).join(' ');
    if (!start) continue;
    const n = (seen.get(start) || 0) + 1;
    seen.set(start, n);
    if (n > 1) flagged.add(it.target);
  }
  return flagged;
}

const label = (sheet, ep) => `${ep.group} → ${ep.name}`;

/**
 * The writing jobs for a fact sheet: one per group plus one for the overview
 * page. Each job lists its targets and the facts it may cite. Targets that
 * already have human text (or a pinned edit) are left out.
 */
export function plan(sheet, { pinned = {} } = {}) {
  const jobs = [];
  const want = (list, target, kind, what, labelText, factIds) => { if (!(target in pinned)) list.push({ target, kind, what, label: labelText, factIds }); };
  for (const g of sheet.groups) {
    const targets = [];
    const eps = g.endpoints.map((k) => sheet.endpoints.find((e) => e.key === k));
    if (!g.description) want(targets, `group.${g.slug}`, 'summary', `Two sentences at most introducing the "${g.name}" requests as a whole.`, `${g.name}: introduction`, [g.fact, ...eps.map((e) => e.facts.route)]);
    for (const ep of eps) {
      const base = `ep.${ep.key}`;
      const own = [...ep.params.map((p) => p.fact), ...ep.requestFields.map((f) => f.fact), ...ep.responses.flatMap((r) => [r.fact, ...r.fields.map((f) => f.fact)]), ...ep.tests.map((t) => t.fact), ...Object.values(ep.facts)];
      if (!ep.description) want(targets, `${base}.summary`, 'summary', `What "${ep.name}" (${ep.method} ${ep.displayPath}) does, in at most two sentences.`, `${label(sheet, ep)}: summary`, own);
      for (const p of ep.params) if (!p.description) want(targets, `${base}.param.${p.in}.${p.name}`, 'param', `What the ${p.in} parameter \`${p.name}\` is.`, `${label(sheet, ep)}: ${p.in} parameter \`${p.name}\``, own);
      for (const f of ep.requestFields.slice(0, 25)) if (!f.description) want(targets, `${base}.body.${f.path}`, 'field', `What the request body field \`${f.path}\` is.`, `${label(sheet, ep)}: request field \`${f.path}\``, own);
      const ok = ep.responses.find((r) => r.code < 400);
      if (ok) for (const f of ok.fields.slice(0, 30)) want(targets, `${base}.resp.${ok.code}.${f.path}`, 'field', `What the response field \`${f.path}\` is.`, `${label(sheet, ep)}: response field \`${f.path}\``, own);
    }
    if (targets.length) {
      // Keep each call a manageable size.
      for (let i = 0; i < targets.length; i += 60) {
        const slice = targets.slice(i, i + 60);
        jobs.push({ name: g.name, targets: slice, allowed: new Set(slice.flatMap((t) => t.factIds)) });
      }
    }
  }
  const overview = [];
  want(overview, 'overview', 'overview', 'Two sentences at most saying what this API covers, from the groups of requests.', 'Home page introduction', sheet.groups.map((g) => g.fact));
  sheet.quickstart.forEach((s, i) => want(overview, `qs.${i}`, 'step', `One sentence for quickstart step ${i + 1}: what this call gives you and why the next calls need it.`, `Quickstart step ${i + 1}`, [s.fact]));
  for (const e of sheet.errors) want(overview, `err.${e.code}`, 'error', `What a caller should check or change when they get ${e.code}.`, `Errors: ${e.code}`, [e.fact]);
  if (overview.length) jobs.push({ name: 'Home page', targets: overview, allowed: new Set(overview.flatMap((t) => t.factIds)) });
  return jobs;
}

function promptFor(job, facts, retry) {
  const factLines = [...job.allowed].filter((id) => facts.has(id)).map((id) => `${id}: ${facts.get(id).text}`);
  const targetLines = job.targets.map((t) => `${t.target}: ${t.what}${retry?.[t.target] ? ` (Your last answer was rejected because it ${retry[t.target].join('; ')}. Fix that or leave it empty.)` : ''}`);
  return `FACTS\n${factLines.join('\n')}\n\nTARGETS\n${targetLines.join('\n')}\n\nReturn one item per target, using the target id exactly.`;
}

/**
 * Runs the jobs with `ask(system, prompt, schema)` → parsed JSON. Returns
 * { texts: { target: { text, factIds, ai: true } }, gaps: [{ target, label, reason }] }.
 */
export async function writeAll(sheet, { ask, styleSample = '', pinned = {}, onProgress = () => {} }) {
  const jobs = plan(sheet, { pinned });
  const texts = {};
  const gaps = [];
  const system = systemPrompt(styleSample);
  let done = 0;
  for (const job of jobs) {
    onProgress({ step: 'write', job: job.name, done, total: jobs.length });
    let pending = job.targets;
    let retry = null;
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      const sub = { ...job, targets: pending };
      let answer;
      try { answer = await ask(system, promptFor(sub, sheet.facts, retry), OUTPUT_SCHEMA); } catch (e) {
        if (attempt === 1) { for (const t of pending) gaps.push({ target: t.target, label: t.label, reason: `The model didn't answer: ${e?.message || e}` }); pending = []; break; }
        retry = Object.fromEntries(pending.map((t) => [t.target, ['came back unreadable']]));
        continue;
      }
      const byTarget = new Map((answer?.items || []).map((it) => [it.target, it]));
      const results = pending.map((t) => ({ t, item: byTarget.get(t.target) || { target: t.target, text: '', factIds: [] } }));
      const openings = repeatedOpenings(results.filter((r) => r.t.kind === 'summary').map((r) => r.item));
      const failed = [];
      for (const { t, item } of results) {
        const problems = lint(item, { kind: t.kind, facts: sheet.facts, allowed: job.allowed });
        if (openings.has(t.target)) problems.push('starts the same way as other summaries on this page');
        if (!problems.length) texts[t.target] = { text: item.text.trim(), factIds: item.factIds, ai: true };
        else failed.push({ t, problems });
      }
      retry = Object.fromEntries(failed.map((f) => [f.t.target, f.problems]));
      pending = failed.map((f) => f.t);
      if (attempt === 1) for (const f of failed) gaps.push({ target: f.t.target, label: f.t.label, reason: f.problems.includes('left empty') ? 'Not enough evidence to describe this' : `Rejected: ${f.problems.join('; ')}` });
    }
    done += 1;
  }
  onProgress({ step: 'write', done, total: jobs.length });
  return { texts, gaps };
}
