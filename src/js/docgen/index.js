// The documentation pipeline, start to finish: gather → scrub → facts → write
// → build → final secret scan. Runs in the desktop app; nothing leaves the
// device until the author publishes (the AI provider sees the facts, which are
// already scrubbed).

import { createScrubber, findSecrets } from './scrub.js';
import { gatherEndpoints, chainSteps } from './gather.js';
import { buildFacts, structure, diffStructure } from './facts.js';
import { writeAll, plan } from './write.js';
import { buildSite, OMIT, BLANK } from './build.js';

export { OMIT, BLANK };

/**
 * opts:
 *   collection, history, useHistory, collectionUid
 *   known: values that must never appear (vault, current values)
 *   verified: { itemId: { env, date, ok } }
 *   ask(system, prompt, schema) → parsed JSON, or null to skip AI writing
 *   styleSample, pinned: { target: text | OMIT }
 *   site: { name, logoDataUrl }, theme, baseUrl, description
 *   previous: { structure, history: [{ version, published_at, changelog }] }
 *   version: the number this will be published as
 */
export async function generateDocs(opts) {
  const progress = opts.onProgress || (() => {});
  progress({ step: 'gather' });
  const scrub = createScrubber({ known: opts.known || [] });
  const endpoints = gatherEndpoints(opts.collection, { scrub, history: opts.history || [], useHistory: !!opts.useHistory, collectionUid: opts.collectionUid });
  if (!endpoints.length) throw new Error('This collection has no requests to document.');
  progress({ step: 'facts' });
  const sheet = buildFacts(endpoints, { quickstart: chainSteps(opts.collection), verified: opts.verified || {} });
  const pinned = opts.pinned || {};
  let written = { texts: {}, gaps: [] };
  if (opts.ask) written = await writeAll(sheet, { ask: opts.ask, styleSample: opts.styleSample || '', pinned, onProgress: progress });
  // Without AI, everything it would have written is a gap for the author.
  else written.gaps = plan(sheet, { pinned }).flatMap((j) => j.targets).map((t) => ({ target: t.target, label: t.label, reason: 'AI writing was off' }));
  progress({ step: 'build' });
  const now = new Date().toISOString();
  const changelog = diffStructure(opts.previous?.structure, structure(sheet));
  const common = { site: opts.site, theme: opts.theme, baseUrl: opts.baseUrl, description: opts.description, version: opts.version, generatedAt: now, changelog, history: opts.previous?.history || [] };

  /** Builds again with edits or a new theme from the review screen, without asking the AI again. */
  const assemble = (edits, theme = opts.theme) => {
    const texts = { ...written.texts };
    for (const [target, text] of Object.entries(edits)) texts[target] = { text, ai: false };
    const files = buildSite(sheet, texts, { ...common, theme });
    const previewFiles = buildSite(sheet, texts, { ...common, theme, preview: true });
    return {
      sheet,
      texts,
      files,
      previewFiles,
      gaps: written.gaps.filter((g) => !(g.target in edits)),
      scrubbed: scrub.log,
      secretHits: findSecrets(files, scrub),
      changelog,
      stats: { endpoints: sheet.endpoints.length, groups: sheet.groups.length, aiSentences: Object.values(texts).filter((t) => t.ai).length, facts: sheet.facts.size },
      theme,
      rebuild: (more) => assemble({ ...edits, ...more }, theme),
      retheme: (next) => assemble(edits, next),
    };
  };
  return assemble(pinned);
}
