# ReadingDoppler

Paragraph-level reading tracker. Measures absorption + viewport-band dwell, not just visibility.

**The motif:** as a reader scrolls, each paragraph shifts through the viewport's top/mid/bot thirds. The ms accumulated in each band is a Doppler-like signature of attention — cumulative top-band dwell is "reading"; cumulative bot-band dwell is "scrolling past." Raw ms only; no composite scoring baked in. Consumers apply per-paragraph-position interaction weights downstream.

Ported band math from [approach-retreat](https://github.com/andyed/approach-retreat) — same strict-intersection semantics, same piecewise-constant attribution, same parity-test discipline. Field prefix is `rd_*` (originally "reading depth" — kept through the rename for schema continuity).

## Architecture

- `src/index.js` — ESM source: `ReadingDoppler` class + `createPostHogAdapter`
- `src/viewport-bands.js` — pure helpers `classifyParagraphInViewport` + `computeViewportBandsPure`, ported from approach-retreat
- `dist/reading-doppler.js` — IIFE build for `<script>` tag usage (exposes `window.ReadingDopplerLib`)
- `build.js` — wraps ESM → IIFE (no bundler)
- `scripts/test_viewport_bands_parity.{js,py}` — JS↔Python parity test for the pure band helper
- `scripts/brand.py` — visual identity generator (favicons, wordmark, social header, brand mark)
- `fixtures/` — parity test inputs + committed `expected_js_viewport_bands.json`
- `docs/validation/viewport-bands.md` — band calibration posture + caveats (empirical section pending corpus)
- `assets/brand/` — generated brand pack (family-coherent with approach-retreat / clicksense)
- `test/index.html` — visual test page with debug panel

## Core Concept

IntersectionObserver tracks paragraph visibility (50% threshold). Each paragraph's dwell time is compared to expected read time (word count / 238 WPM) to produce an **absorption ratio**:

| Absorption | Interpretation |
|-----------|----------------|
| 0 | Never seen |
| < 0.3 | Skipped |
| 0.3 - 0.7 | Skimmed |
| 0.7 - 1.3 | Read normally |
| > 1.5 | Studied / re-read |

## Viewport-band decomposition

In addition to `visible_ms` and `absorption`, v0.2 emits per-paragraph cumulative ms in four bands based on the paragraph center's viewport-y position:

- `rd_top_ms` — center in top third of viewport
- `rd_mid_ms` — center in middle third
- `rd_bot_ms` — center in bottom third
- `rd_any_ms` — any viewport intersection (includes tall-paragraph / off-center case)

Plus `paragraph_index` and `paragraph_position_frac` for crossing position × band downstream.

Raw ms only — no scoring, no position weighting, no length normalization. AR's AdSERP calibration found top-of-viewport dwell ~9× more discriminative than bottom (`vt_top = +1.83`, `vt_bot = +0.21`). Reading-content calibration pending; see `docs/validation/viewport-bands.md`.

Session summaries include `rd_viewport_band_basis_px` (current viewport-h at summary) + `rd_viewport_h` (at construction) so downstream analyses can filter sessions where the basis shifted mid-read. Schema: `reading-doppler-vpbands-v1`.

## Integration

First consumer: SciprogFi (`~/Documents/dev/sciprogfi-web/`). PostHog adapter sends:
- `reading_doppler_flush` — new-paragraph checkpoints, at most one every two minutes, with top-absorbed, skipped, and `paragraphs_banded` array
- `reading_doppler_summary` — on page exit with overall stats + basis disclosure

## Commands

```bash
node build.js             # build IIFE to dist/
npm run test:parity       # JS + Python parity check on band math
python3 scripts/brand.py  # regenerate brand assets
npx serve test            # visual test page
```
