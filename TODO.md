# Reading Doppler — TODO

## Demo (gh-pages)

- [ ] **Cursor-plot-style band visualization** — the current debug panel is table-only. AR's cursor plots are sexier (spatial, immediate). For RD: a per-paragraph strip visualization where each tracked paragraph gets a horizontal mini-timeline of which band its center was in over time. Rendered live in the debug panel. Could reuse the same stripe-indicator DOM the dominant-band CSS rule already targets, but drive it from an actual time-series instead of a single dominant-band classification. See `approach-retreat/site/js/ar-init.js` for the overlay pattern.
- [ ] **Embed Scrutinizer foveated.svg infographic inline in one reading** — probably best as a figure inside the AI-existential-threat answer set where the peripheral-vision tie-in is thematic. The library only instruments HTML text, not SVG text, so the SVG is visual context (the surrounding paragraph + caption get instrumented). Thematic bonus: demonstrates the peripheral-color claim while the library is measuring reading behavior on it.
- [ ] **More readings** — current picker has 4 AR Q&A + Constitution. Worth adding: a short technical explainer, a piece of narrative fiction, something very short (to test the zero-paragraph-read edge case). Keep AR's editorial variety (technical / nostalgic / personal / scientific).

## Library / Calibration

- [ ] **Pull demo data from PostHog** — `reading_doppler_flush` + `reading_doppler_summary` events now flow from `demo/` with `content_id` + `content_kind` tags. Aggregate per `content_id` × `paragraph_index` to characterize reading patterns across AR Q&A answers and the Constitution. First real calibration data for the viewport-band coefficients. Script belongs alongside the sciprogfi polars analysis.
- [ ] **Empirical section of `docs/validation/viewport-bands.md`** — fill in TBDs once demo data plus sciprogfi data aggregate to a reasonable N. AR's AdSERP calibration table is the template: bootstrap LOSO coefficients with CIs across positions.

## Integration

- [ ] **sciprogfi schema version check** — when the `rd_viewport_band_schema` constant ever bumps (from `reading-doppler-vpbands-v1`), sciprogfi analytics.js needs to tolerate the old version until the full dataset is re-ingested. Add a compatibility note before bumping.
