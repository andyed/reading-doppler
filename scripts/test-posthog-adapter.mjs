import assert from 'node:assert/strict';
import { createPostHogAdapter } from '../src/index.js';

const captures = [];
const adapter = createPostHogAdapter({ capture: (...args) => captures.push(args) });
const originalNow = Date.now;
const originalDocument = globalThis.document;
let now = 1_000_000;
Date.now = () => now;
globalThis.document = { hidden: false };

function paragraph(id) {
  return {
    id, words: 20, expected_ms: 5_000, visible_ms: 2_000,
    absorption: 0.4, rd_any_ms: 2_000, rd_top_ms: 1_000,
    rd_mid_ms: 1_000, rd_bot_ms: 0, paragraph_index: id,
    paragraph_position_frac: id / 20,
  };
}

try {
  adapter.onFlush([paragraph(1)], { flush_number: 1 });
  assert.equal(captures.length, 1, 'first reached paragraph emits a checkpoint');
  now += 10_000;
  adapter.onFlush([paragraph(1)], { flush_number: 2 });
  assert.equal(captures.length, 1, 'cumulative dwell alone does not emit');
  adapter.onFlush([paragraph(1), paragraph(2)], { flush_number: 3 });
  assert.equal(captures.length, 1, 'new content waits for the rate limit');
  now += 120_000;
  globalThis.document.hidden = true;
  adapter.onFlush([paragraph(1), paragraph(2)], { flush_number: 4 });
  assert.equal(captures.length, 1, 'hidden page stays silent');
  globalThis.document.hidden = false;
  adapter.onFlush([paragraph(1), paragraph(2)], { flush_number: 5 });
  assert.equal(captures.length, 2, 'pending progress emits when visible');

  for (let id = 3; id <= 15; id++) {
    now += 120_000;
    adapter.onFlush([paragraph(id)], { flush_number: id + 3 });
  }
  assert.equal(captures.length, 15, 'long reads continue past twelve new-content checkpoints');
  adapter.onDestroy({ paragraphs_total: 15 });
  assert.equal(captures.at(-1)[0], 'reading_doppler_summary');
  assert.equal(captures.at(-1)[1].paragraphs_total, 15);
  console.log('PostHog adapter checkpoint policy and final summary passed');
} finally {
  Date.now = originalNow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
