/**
 * ReadingDepth v0.1.0
 * Paragraph-level reading time tracker.
 * https://github.com/andyed/reading-depth
 */
(function(global) {
  "use strict";

/**
 * ReadingDepth — paragraph-level reading time tracker
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
 * Usage:
 *   const rd = new ReadingDepth({ onFlush: (paragraphs) => console.log(paragraphs) });
 *   rd.observe(document.querySelector('.prose'));
 *   // later:
 *   rd.destroy();
 */

const DEFAULT_WPM = 238; // Brysbaert (2019) silent reading average
const VISIBILITY_THRESHOLD = 0.5; // 50% of paragraph must be visible
const FLUSH_INTERVAL_MS = 10_000; // report every 10s
const MIN_VISIBLE_MS = 500; // ignore sub-500ms flickers

class ReadingDepth {
  constructor(options = {}) {
    this._wpm = options.wpm || DEFAULT_WPM;
    this._onFlush = options.onFlush || (() => {});
    this._flushInterval = options.flushInterval || FLUSH_INTERVAL_MS;
    this._selector = options.selector || 'p, li, blockquote, h1, h2, h3, h4, h5, h6, figcaption';
    this._contentAttr = options.contentAttr || null; // optional data-rd-id for stable paragraph IDs

    // State: Map<element, { id, words, expected_ms, visible_ms, enter_ts, flushed }>
    this._tracked = new Map();
    this._observer = null;
    this._timer = null;
    this._pageVisible = true;
    this._flushCount = 0;

    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this._onVisibilityChange);

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
    elements.forEach((el, i) => {
      // Build a stable paragraph ID from position + first words
      const text = el.textContent.trim();
      const words = text.split(/\s+/).filter(w => w.length > 0);
      const wordCount = words.length;
      if (wordCount === 0) return; // skip empty elements

      const id = this._paragraphId(el, i, words);
      const expected_ms = (wordCount / this._wpm) * 60_000;

      this._tracked.set(el, {
        id,
        tag: el.tagName.toLowerCase(),
        words: wordCount,
        expected_ms,
        visible_ms: 0,
        enter_ts: null,
        visible: false,
      });

      this._observer.observe(el);
    });
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
    const now = performance.now();

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
    const now = performance.now();
    if (document.hidden) {
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
    }
  }

  _startFlushing() {
    this._timer = setInterval(() => this.flush(), this._flushInterval);
  }

  /**
   * Flush current reading state. Reports all paragraphs with meaningful
   * visible time (>500ms). Does not reset — accumulates across flushes
   * so the final flush has total time.
   */
  flush() {
    const now = performance.now();
    this._flushCount++;

    // Snapshot current visible elements without resetting their timers
    for (const state of this._tracked.values()) {
      if (state.visible && state.enter_ts !== null && this._pageVisible) {
        const elapsed = now - state.enter_ts;
        state.visible_ms += elapsed;
        state.enter_ts = now; // reset the window, keep tracking
      }
    }

    const paragraphs = [];
    for (const state of this._tracked.values()) {
      if (state.visible_ms < MIN_VISIBLE_MS) continue;

      paragraphs.push({
        id: state.id,
        tag: state.tag,
        words: state.words,
        expected_ms: Math.round(state.expected_ms),
        visible_ms: Math.round(state.visible_ms),
        absorption: parseFloat((state.visible_ms / state.expected_ms).toFixed(2)),
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
    const now = performance.now();
    const paragraphs = [];

    for (const state of this._tracked.values()) {
      let total = state.visible_ms;
      if (state.visible && state.enter_ts !== null && this._pageVisible) {
        total += now - state.enter_ts;
      }
      if (total < MIN_VISIBLE_MS) continue;

      paragraphs.push({
        id: state.id,
        tag: state.tag,
        words: state.words,
        expected_ms: Math.round(state.expected_ms),
        visible_ms: Math.round(total),
        absorption: parseFloat((total / state.expected_ms).toFixed(2)),
      });
    }
    return paragraphs;
  }

  /**
   * Summary stats for the entire observed content.
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
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this._tracked.clear();
  }
}

/**
 * PostHog adapter — flattens paragraph data into PostHog events.
 *
 * Fires two event types:
 *   'reading_depth_flush' — periodic with per-paragraph detail
 *   'reading_depth_summary' — on destroy with overall stats
 */
function createPostHogAdapter(posthog = window.posthog, options = {}) {
  const eventPrefix = options.eventPrefix || 'reading_depth';

  return {
    onFlush(paragraphs, meta) {
      // Send summary-level event (not per-paragraph, to avoid event volume explosion)
      const totalVisible = paragraphs.reduce((s, p) => s + p.visible_ms, 0);
      const totalExpected = paragraphs.reduce((s, p) => s + p.expected_ms, 0);
      const avgAbsorption = paragraphs.reduce((s, p) => s + p.absorption, 0) / paragraphs.length;

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
      });
    },

    onDestroy(summary) {
      if (!summary) return;
      posthog.capture(`${eventPrefix}_summary`, summary);
    }
  };
}


  global.ReadingDepthLib = {
    ReadingDepth,
    createPostHogAdapter,
  };
})(typeof window !== 'undefined' ? window : globalThis);
