/**
 * ReadingDoppler v0.2.0
 * Paragraph-level reading time tracker with viewport-band decomposition.
 * https://github.com/andyed/reading-doppler
 */
(function(global) {
  "use strict";

/**
 * Viewport-band decomposition — pure helpers.
 *
 * Ported from approach-retreat/src/approach-retreat.js (classifyAoiInViewport
 * + computeViewportBandsPure) with paragraph-domain naming. Same math, same
 * piecewise-constant semantics, same parity-test discipline.
 *
 * The library emits raw band ms only — `rd_any_ms`, `rd_top_ms`,
 * `rd_mid_ms`, `rd_bot_ms` per paragraph. It does not score, weight, or
 * normalize bands against `expected_ms`. Consumers apply per-paragraph-
 * position interaction weights downstream. See
 * docs/validation/viewport-bands.md for the calibration posture and the
 * approach-retreat AdSERP calibration that this port descends from.
 *
 * Band definitions (with `third = scr_h / 3`):
 *   top  iff 0        <= center_vp_y < third
 *   mid  iff third    <= center_vp_y < 2*third
 *   bot  iff 2*third  <= center_vp_y <= scr_h
 *   off  otherwise (includes tall-paragraph case where the paragraph
 *                   intersects viewport but its center sits outside
 *                   [0, scr_h])
 *
 * `any_ms` accumulates for any viewport intersection (strict
 * `min(p_bot, vp_bot) > max(p_top, vp_top)` — touching edges do not count),
 * including the off-band case. This is the tall-paragraph fix.
 */

/**
 * Classify a paragraph at a given scroll position into top / mid / bot / off.
 * Uses the paragraph's page-space top/bot and the current viewport thirds.
 *
 * Strict `>` on the intersection test — a paragraph whose bottom edge is
 * exactly at vpTop (or whose top is exactly at vpBot) is not intersecting.
 * Matches the Python reference `viewport_ms_for_trial` in attentional-
 * foraging/scripts/viewport_time_calibration.py.
 *
 * @param {number} paragraphPageTop   — paragraph top in page coordinates (px)
 * @param {number} paragraphPageBot   — paragraph bottom in page coordinates (px)
 * @param {number} scrollY            — current scrollY (px)
 * @param {number} scrH               — viewport height (px)
 * @returns {{ intersecting: boolean, band: 'top' | 'mid' | 'bot' | 'off' }}
 */
function classifyParagraphInViewport(paragraphPageTop, paragraphPageBot, scrollY, scrH) {
  const vpTop = scrollY;
  const vpBot = scrollY + scrH;
  const intersecting =
    Math.min(paragraphPageBot, vpBot) > Math.max(paragraphPageTop, vpTop);
  if (!intersecting) return { intersecting: false, band: 'off' };

  const centerVpY = (paragraphPageTop + paragraphPageBot) / 2 - scrollY;
  const third = scrH / 3;
  let band = 'off';
  if (centerVpY >= 0 && centerVpY < third) band = 'top';
  else if (centerVpY >= third && centerVpY < 2 * third) band = 'mid';
  else if (centerVpY >= 2 * third && centerVpY <= scrH) band = 'bot';
  return { intersecting, band };
}

/**
 * Batch computation of per-paragraph viewport-band dwell totals from a
 * scroll timeline. Pure helper, parity-tested against the Python reference
 * lifted from `viewport_ms_for_trial` in
 * attentional-foraging/scripts/viewport_time_calibration.py.
 *
 * Piecewise-constant semantics: the interval `[timeline[i].t, timeline[i+1].t]`
 * is attributed using the scroll position at `timeline[i]` (i.e. the
 * *start* of the interval), matching Python's `(t0, y0), (t1, _) in zip(...)`.
 *
 * Zero-duration or negative intervals are skipped.
 *
 * Input shape keeps `position` as the paragraph identifier so fixture JSON
 * stays structurally identical to approach-retreat's. Consumers pass
 * `paragraph_index` (0-based DOM order) as `position`.
 *
 * @param {Array<{t: number, scrollY: number}>} timeline — must be sorted by t.
 * @param {Array<{position: number, page_top: number, page_bot: number}>} paragraphs
 * @param {number} scrH — viewport height (assumed constant across the
 *   timeline; if the page resizes, callers should segment the timeline by
 *   basis and aggregate segment totals).
 * @returns {Array<{position, any_ms, top_ms, mid_ms, bot_ms}>} sorted by position.
 */
function computeViewportBandsPure(timeline, paragraphs, scrH) {
  const out = paragraphs.map((p) => ({
    position: p.position,
    any_ms: 0,
    top_ms: 0,
    mid_ms: 0,
    bot_ms: 0,
  }));
  for (let i = 0; i < timeline.length - 1; i++) {
    const dt = timeline[i + 1].t - timeline[i].t;
    if (dt <= 0) continue;
    const scrollY = timeline[i].scrollY;
    for (let j = 0; j < paragraphs.length; j++) {
      const p = paragraphs[j];
      const { intersecting, band } =
        classifyParagraphInViewport(p.page_top, p.page_bot, scrollY, scrH);
      if (!intersecting) continue;
      out[j].any_ms += dt;
      if (band === 'top') out[j].top_ms += dt;
      else if (band === 'mid') out[j].mid_ms += dt;
      else if (band === 'bot') out[j].bot_ms += dt;
    }
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}


/**
 * ReadingDoppler — paragraph-level reading time tracker with viewport-band
 * decomposition. The "Doppler" motif: as a reader scrolls, each paragraph
 * shifts through the viewport's top/mid/bot thirds, and the ms accumulated
 * in each band is a frequency-shift-like signature of how the eye dwells
 * relative to the motion. The library records those per-band totals as
 * `rd_top_ms`, `rd_mid_ms`, `rd_bot_ms`, and the any-intersection total
 * `rd_any_ms` (the RD prefix is preserved from the pre-rename contract).
 *
 * Measures how long each content block is visible in the viewport,
 * compares to expected read time (word count / WPM), and reports
 * an absorption ratio per paragraph.
 *
 * absorption = visible_ms / expected_ms
 *   0   = skipped (never entered viewport or scrolled past instantly)
 *   0.5 = skimmed (saw it half as long as a normal reader would)
 *   1.0 = read at normal pace (~238 WPM, Brysbaert 2019)
 *   >1  = studied, re-read, or lingered
 *
 * v0.2 adds viewport-band decomposition: per-paragraph cumulative ms in
 * top / mid / bot / any thirds of the viewport. Raw ms only — no scoring,
 * no rank weighting, no length normalization baked in. Consumers apply
 * per-paragraph-position interaction weights downstream. See
 * docs/validation/viewport-bands.md for the posture and the
 * approach-retreat AdSERP calibration this port descends from.
 *
 * Usage:
 *   const rd = new ReadingDoppler({ onFlush: (paragraphs) => console.log(paragraphs) });
 *   rd.observe(document.querySelector('.prose'));
 *   // later:
 *   rd.destroy();
 */



const DEFAULT_WPM = 238; // Brysbaert (2019) silent reading average
const VISIBILITY_THRESHOLD = 0.5; // 50% of paragraph must be visible for absorption
const FLUSH_INTERVAL_MS = 10_000; // report every 10s
const MIN_VISIBLE_MS = 500; // ignore sub-500ms flickers
const VIEWPORT_BAND_SCHEMA = 'reading-doppler-vpbands-v1';

class ReadingDoppler {
  constructor(options = {}) {
    this._wpm = options.wpm || DEFAULT_WPM;
    this._onFlush = options.onFlush || (() => {});
    this._flushInterval = options.flushInterval || FLUSH_INTERVAL_MS;
    this._selector = options.selector || 'p, li, blockquote, h1, h2, h3, h4, h5, h6, figcaption';
    this._contentAttr = options.contentAttr || null; // optional data-rd-id for stable paragraph IDs
    this._trackViewportBands = options.trackViewportBands !== false;
    this._trackViewportReflow = options.trackViewportReflow !== false;

    // State: Map<element, { id, tag, words, expected_ms, visible_ms, enter_ts, visible, paragraph_index }>
    this._tracked = new Map();
    this._paragraphsTotal = 0;
    this._observer = null;
    this._timer = null;
    this._pageVisible = true;
    this._flushCount = 0;

    // Viewport-band state. `_viewportBandTimes` is Map<element, rec> where rec
    // carries accumulated ms + the pending-interval state (piecewise-constant
    // attribution: the closing interval is credited to the band current at its
    // start). Mirrors approach-retreat's `_viewportBandTimes` (A-set only).
    this._viewportBandTimes = new Map();
    this._paragraphPageYCenter = new Map();
    this._paragraphHalfHeight = new Map();
    this._scrollY = typeof window !== 'undefined' ? (window.scrollY || 0) : 0;
    this._viewportHAtLoad = typeof window !== 'undefined' ? window.innerHeight : 0;
    this._vbRafId = null;
    this._resizeObserver = null;

    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._onResize = this._onResize.bind(this);
    this._runViewportSnapshotRaf = this._runViewportSnapshotRaf.bind(this);

    document.addEventListener('visibilitychange', this._onVisibilityChange);

    if (this._trackViewportBands && typeof window !== 'undefined') {
      window.addEventListener('scroll', this._onScroll, { passive: true });
      window.addEventListener('resize', this._onResize, { passive: true });
      if (
        this._trackViewportReflow &&
        typeof ResizeObserver !== 'undefined' &&
        typeof document !== 'undefined' &&
        document.documentElement
      ) {
        this._resizeObserver = new ResizeObserver(() => {
          // Reflow invalidates cached page-Y centers + half-heights. Clear
          // both so the next snapshot picks up fresh geometry, then schedule
          // a snapshot so the pending interval closes under the old basis
          // before the new one starts.
          this._paragraphPageYCenter.clear();
          this._paragraphHalfHeight.clear();
          this._scheduleViewportSnapshot();
        });
        this._resizeObserver.observe(document.documentElement);
      }
    }

    this._startFlushing();
  }

  /**
   * Observe all matching elements within a container.
   * Call multiple times for multiple containers.
   */
  observe(container) {
    if (!container) return;

    if (!this._observer) {
      this._observer = new IntersectionObserver(
        (entries) => this._handleIntersections(entries),
        { threshold: VISIBILITY_THRESHOLD }
      );
    }

    const elements = container.querySelectorAll(this._selector);
    elements.forEach((el) => {
      if (this._tracked.has(el)) return; // already observed
      // Build a stable paragraph ID from position + first words
      const text = el.textContent.trim();
      const words = text.split(/\s+/).filter(w => w.length > 0);
      const wordCount = words.length;
      if (wordCount === 0) return; // skip empty elements

      const paragraph_index = this._paragraphsTotal;
      this._paragraphsTotal += 1;
      const id = this._paragraphId(el, paragraph_index, words);
      const expected_ms = (wordCount / this._wpm) * 60_000;

      this._tracked.set(el, {
        id,
        tag: el.tagName.toLowerCase(),
        words: wordCount,
        expected_ms,
        visible_ms: 0,
        enter_ts: null,
        visible: false,
        paragraph_index,
      });

      this._observer.observe(el);
    });

    // Seed pass — establish lastSnapshotT + currentBand for every newly-
    // observed paragraph so the first real snapshot has a well-defined
    // "previous" band to attribute its interval to. Seeds all paragraphs
    // (not just new ones) — the per-rec first-sight check handles uniformity.
    if (this._trackViewportBands) {
      this._updateViewportBands(this._now(), /* seed */ true);
    }
  }

  /**
   * Re-scan a container for newly-inserted paragraphs (e.g. dynamic content
   * or infinite scroll). Idempotent: already-observed elements are skipped.
   */
  refresh(container) {
    this.observe(container);
  }

  /**
   * Generate a stable paragraph ID.
   * Prefers data-rd-id attribute, falls back to index + first 4 words.
   */
  _paragraphId(el, index, words) {
    if (this._contentAttr && el.dataset[this._contentAttr]) {
      return el.dataset[this._contentAttr];
    }
    const slug = words.slice(0, 4).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return `p${index}-${slug}`;
  }

  _handleIntersections(entries) {
    const now = this._now();

    for (const entry of entries) {
      const state = this._tracked.get(entry.target);
      if (!state) continue;

      if (entry.isIntersecting && !state.visible) {
        // Entered viewport
        state.visible = true;
        state.enter_ts = now;
      } else if (!entry.isIntersecting && state.visible) {
        // Left viewport — accumulate time
        this._accumulateTime(state, now);
        state.visible = false;
        state.enter_ts = null;
      }
    }
  }

  _accumulateTime(state, now) {
    if (state.enter_ts !== null && this._pageVisible) {
      const elapsed = now - state.enter_ts;
      state.visible_ms += elapsed;
    }
  }

  _onVisibilityChange() {
    const now = this._now();
    if (document.hidden) {
      // Close pending band intervals before flipping the flag so the hidden
      // window is not attributed to any band.
      if (this._trackViewportBands && this._pageVisible) {
        this._updateViewportBands(now);
      }
      // Page hidden — freeze all timers
      this._pageVisible = false;
      for (const state of this._tracked.values()) {
        if (state.visible) {
          this._accumulateTime(state, now);
          state.enter_ts = null;
        }
      }
    } else {
      // Page visible again — restart timers for visible elements
      this._pageVisible = true;
      for (const state of this._tracked.values()) {
        if (state.visible) {
          state.enter_ts = now;
        }
      }
      // Seed bands so the hidden interval is not retroactively credited.
      if (this._trackViewportBands) {
        this._updateViewportBands(now, /* seed */ true);
      }
    }
  }

  _onScroll() {
    if (typeof window === 'undefined') return;
    this._scrollY = window.scrollY;
    this._scheduleViewportSnapshot();
  }

  _onResize() {
    if (typeof window === 'undefined') return;
    // Layout may have reflowed. Clear cached geometry so the next snapshot
    // picks up fresh page-space centers and half-heights.
    this._paragraphPageYCenter.clear();
    this._paragraphHalfHeight.clear();
    this._scheduleViewportSnapshot();
  }

  /**
   * rAF-throttled scroll/resize/reflow handler for band snapshots. Multiple
   * scroll events within one frame coalesce into a single snapshot — enough
   * resolution since band boundaries are scr_h/3, much coarser than per-event
   * scroll deltas.
   */
  _scheduleViewportSnapshot() {
    if (this._vbRafId != null) return;
    if (typeof requestAnimationFrame === 'undefined') {
      // No rAF (tests, unusual hosts). Fall back to sync snapshot — still
      // correct, just not coalesced.
      this._updateViewportBands(this._now());
      return;
    }
    this._vbRafId = requestAnimationFrame(this._runViewportSnapshotRaf);
  }

  _runViewportSnapshotRaf() {
    this._vbRafId = null;
    this._updateViewportBands(this._now());
  }

  /**
   * Update per-paragraph viewport-band accumulators.
   *
   * Semantics mirror `computeViewportBandsPure` (pure helper, parity-tested
   * against the Python reference `viewport_ms_for_trial` in
   * attentional-foraging/scripts/viewport_time_calibration.py):
   *
   *   For each tracked paragraph, close the interval (lastSnapshotT, now)
   *   using the band that was current *at the start* of the interval
   *   (piecewise-constant attribution), then record the new band +
   *   intersection state for the next interval.
   *
   * When `seed` is true, skip the accumulation step — used at init and on
   * visibility resume so the first real interval is well-defined.
   * Paragraphs encountered for the first time are always seeded.
   *
   * Band definitions (with third = scr_h / 3):
   *   top  iff 0        <= center_vp_y < third
   *   mid  iff third    <= center_vp_y < 2*third
   *   bot  iff 2*third  <= center_vp_y <= scr_h
   *   off  otherwise (includes tall-paragraph case where the paragraph
   *                   intersects viewport but its center sits outside
   *                   [0, scr_h])
   *
   * `any_ms` accumulates on any strict intersection, including off-band.
   */
  _updateViewportBands(now, seed = false) {
    if (!this._trackViewportBands) return;
    if (!this._pageVisible) return;
    if (typeof window === 'undefined') return;
    const scrH = window.innerHeight;
    if (!scrH || scrH <= 0) return;
    const scrollY = this._scrollY;

    for (const el of this._tracked.keys()) {
      // Geometry cache — invalidated on resize and by ResizeObserver on
      // documentElement. First lookup per (paragraph × basis) pays the
      // getBoundingClientRect cost; subsequent snapshots use the Map.
      let pageYCenter = this._paragraphPageYCenter.get(el);
      let halfH = this._paragraphHalfHeight.get(el);
      if (pageYCenter === undefined || halfH === undefined) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // not laid out yet
        pageYCenter = rect.top + rect.height / 2 + scrollY;
        halfH = rect.height / 2;
        this._paragraphPageYCenter.set(el, pageYCenter);
        this._paragraphHalfHeight.set(el, halfH);
      }

      const pTop = pageYCenter - halfH;
      const pBot = pageYCenter + halfH;
      const { intersecting, band } = classifyParagraphInViewport(pTop, pBot, scrollY, scrH);

      let rec = this._viewportBandTimes.get(el);
      if (!rec) {
        // First sight: seed the record. No accumulation this pass.
        this._viewportBandTimes.set(el, {
          any_ms: 0,
          top_ms: 0,
          mid_ms: 0,
          bot_ms: 0,
          lastSnapshotT: now,
          currentBand: band,
          lastIntersecting: intersecting,
        });
        continue;
      }

      if (!seed) {
        const dt = now - rec.lastSnapshotT;
        if (dt > 0) {
          if (rec.lastIntersecting) rec.any_ms += dt;
          if (rec.currentBand === 'top') rec.top_ms += dt;
          else if (rec.currentBand === 'mid') rec.mid_ms += dt;
          else if (rec.currentBand === 'bot') rec.bot_ms += dt;
        }
      }
      rec.lastSnapshotT = now;
      rec.currentBand = band;
      rec.lastIntersecting = intersecting;
    }
  }

  _startFlushing() {
    this._timer = setInterval(() => this.flush(), this._flushInterval);
  }

  _now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  _bandFieldsFor(el) {
    const rec = this._viewportBandTimes.get(el);
    if (!rec) {
      return { rd_any_ms: 0, rd_top_ms: 0, rd_mid_ms: 0, rd_bot_ms: 0 };
    }
    return {
      rd_any_ms: Math.round(rec.any_ms),
      rd_top_ms: Math.round(rec.top_ms),
      rd_mid_ms: Math.round(rec.mid_ms),
      rd_bot_ms: Math.round(rec.bot_ms),
    };
  }

  /**
   * Flush current reading state. Reports all paragraphs with meaningful
   * visible time (>500ms). Does not reset — accumulates across flushes
   * so the final flush has total time.
   */
  flush() {
    const now = this._now();
    this._flushCount++;

    // Snapshot current visible elements without resetting their timers
    for (const state of this._tracked.values()) {
      if (state.visible && state.enter_ts !== null && this._pageVisible) {
        const elapsed = now - state.enter_ts;
        state.visible_ms += elapsed;
        state.enter_ts = now; // reset the window, keep tracking
      }
    }

    // Close pending band intervals so emitted totals are fresh to `now`.
    if (this._trackViewportBands) {
      this._updateViewportBands(now);
    }

    const total = this._paragraphsTotal || 1;
    const paragraphs = [];
    for (const [el, state] of this._tracked.entries()) {
      if (state.visible_ms < MIN_VISIBLE_MS) continue;

      const bands = this._bandFieldsFor(el);
      paragraphs.push({
        id: state.id,
        tag: state.tag,
        words: state.words,
        expected_ms: Math.round(state.expected_ms),
        visible_ms: Math.round(state.visible_ms),
        absorption: parseFloat((state.visible_ms / state.expected_ms).toFixed(2)),
        paragraph_index: state.paragraph_index,
        paragraph_position_frac: parseFloat((state.paragraph_index / total).toFixed(3)),
        ...bands,
      });
    }

    if (paragraphs.length > 0) {
      this._onFlush(paragraphs, { flush_number: this._flushCount });
    }
  }

  /**
   * Get current snapshot without triggering onFlush callback.
   */
  snapshot() {
    const now = this._now();
    if (this._trackViewportBands) {
      this._updateViewportBands(now);
    }
    const total = this._paragraphsTotal || 1;
    const paragraphs = [];

    for (const [el, state] of this._tracked.entries()) {
      let totalMs = state.visible_ms;
      if (state.visible && state.enter_ts !== null && this._pageVisible) {
        totalMs += now - state.enter_ts;
      }
      if (totalMs < MIN_VISIBLE_MS) continue;

      const bands = this._bandFieldsFor(el);
      paragraphs.push({
        id: state.id,
        tag: state.tag,
        words: state.words,
        expected_ms: Math.round(state.expected_ms),
        visible_ms: Math.round(totalMs),
        absorption: parseFloat((totalMs / state.expected_ms).toFixed(2)),
        paragraph_index: state.paragraph_index,
        paragraph_position_frac: parseFloat((state.paragraph_index / total).toFixed(3)),
        ...bands,
      });
    }
    return paragraphs;
  }

  /**
   * Summary stats for the entire observed content. Includes viewport-band
   * basis disclosure fields per the AR-calibration pattern: downstream
   * analyses wanting basis-stable bands should filter on sessions where
   * `rd_viewport_band_basis_px` === `rd_viewport_h`.
   */
  summary() {
    const snap = this.snapshot();
    if (snap.length === 0) return null;

    const totalWords = snap.reduce((s, p) => s + p.words, 0);
    const totalExpected = snap.reduce((s, p) => s + p.expected_ms, 0);
    const totalVisible = snap.reduce((s, p) => s + p.visible_ms, 0);
    const read = snap.filter(p => p.absorption >= 0.5);
    const studied = snap.filter(p => p.absorption >= 1.5);
    const skimmed = snap.filter(p => p.absorption > 0 && p.absorption < 0.5);

    const basisPx = typeof window !== 'undefined' ? window.innerHeight : 0;

    return {
      paragraphs_total: this._tracked.size,
      paragraphs_seen: snap.length,
      paragraphs_read: read.length,
      paragraphs_studied: studied.length,
      paragraphs_skimmed: skimmed.length,
      total_words: totalWords,
      total_expected_ms: Math.round(totalExpected),
      total_visible_ms: Math.round(totalVisible),
      overall_absorption: parseFloat((totalVisible / totalExpected).toFixed(2)),
      avg_absorption: parseFloat((snap.reduce((s, p) => s + p.absorption, 0) / snap.length).toFixed(2)),
      rd_viewport_band_basis_px: basisPx,
      rd_viewport_h: this._viewportHAtLoad,
      rd_viewport_band_schema: VIEWPORT_BAND_SCHEMA,
    };
  }

  /**
   * Final flush + cleanup. Call on page unload or navigation.
   */
  destroy() {
    this.flush();
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._vbRafId != null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this._vbRafId);
      this._vbRafId = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', this._onScroll);
      window.removeEventListener('resize', this._onResize);
    }
    this._tracked.clear();
    this._viewportBandTimes.clear();
    this._paragraphPageYCenter.clear();
    this._paragraphHalfHeight.clear();
  }
}

// Re-export the pure helper so consumers who have their own scroll timeline
// (e.g. batch post-hoc computation in Node) can compute bands without the
// runtime accumulator.
{ computeViewportBandsPure, classifyParagraphInViewport };

/**
 * PostHog adapter — flattens paragraph data into PostHog events.
 *
 * Fires two event types:
 *   'reading_doppler_flush' — periodic with per-paragraph detail + bands
 *   'reading_doppler_summary' — on destroy with overall stats + basis disclosure
 */
function createPostHogAdapter(posthog = window.posthog, options = {}) {
  const eventPrefix = options.eventPrefix || 'reading_doppler';

  return {
    onFlush(paragraphs, meta) {
      // Send summary-level event (not per-paragraph, to avoid event volume explosion)
      const totalVisible = paragraphs.reduce((s, p) => s + p.visible_ms, 0);
      const totalExpected = paragraphs.reduce((s, p) => s + p.expected_ms, 0);
      const avgAbsorption = paragraphs.reduce((s, p) => s + p.absorption, 0) / paragraphs.length;

      // Per-paragraph band detail, included as a compact array. Empty when
      // bands are disabled or no paragraph has accumulated any-ms.
      const paragraphs_banded = paragraphs
        .filter(p => (p.rd_any_ms || 0) > 0)
        .map(p => ({
          id: p.id,
          paragraph_index: p.paragraph_index,
          paragraph_position_frac: p.paragraph_position_frac,
          rd_any_ms: p.rd_any_ms,
          rd_top_ms: p.rd_top_ms,
          rd_mid_ms: p.rd_mid_ms,
          rd_bot_ms: p.rd_bot_ms,
        }));

      posthog.capture(`${eventPrefix}_flush`, {
        flush_number: meta.flush_number,
        paragraphs_seen: paragraphs.length,
        total_visible_ms: Math.round(totalVisible),
        total_expected_ms: Math.round(totalExpected),
        avg_absorption: parseFloat(avgAbsorption.toFixed(2)),
        // Top 3 most-absorbed paragraphs (for copywriter signal)
        top_absorbed: paragraphs
          .sort((a, b) => b.absorption - a.absorption)
          .slice(0, 3)
          .map(p => ({ id: p.id, words: p.words, absorption: p.absorption })),
        // Most-skipped paragraphs (absorption < 0.3)
        skipped: paragraphs
          .filter(p => p.absorption < 0.3)
          .map(p => ({ id: p.id, words: p.words, absorption: p.absorption })),
        paragraphs_banded,
      });
    },

    onDestroy(summary) {
      if (!summary) return;
      posthog.capture(`${eventPrefix}_summary`, summary);
    }
  };
}


  global.ReadingDopplerLib = {
    ReadingDoppler,
    createPostHogAdapter,
    computeViewportBandsPure,
    classifyParagraphInViewport,
  };
})(typeof window !== 'undefined' ? window : globalThis);
