/* ============================================================
   Prism AI — Chart Theme
   ------------------------------------------------------------
   Brand palette + Chart.js global defaults registration helper.
   This module is loaded by every dashboard page that uses
   Chart.js, but is INERT until a page calls
   registerPrismChartDefaults(Chart). T-031 ships the file
   linked; T-032 wires the call into each chart-bearing page.

   Usage:
     <script type="module">
       import {
         PRISM_CHART_PALETTE,
         PRISM_STATUS_COLORS,
         registerPrismChartDefaults,
       } from '/styles/chart-theme.js';
       registerPrismChartDefaults(Chart);
       new Chart(ctx, { data: { datasets: [{ data, backgroundColor: PRISM_CHART_PALETTE }] } });
     </script>
   ============================================================ */

/** Lead-gold brand palette for categorical / multi-series charts. */
export const PRISM_CHART_PALETTE = Object.freeze([
  // T-099: blue-family fills lightened so they read on the cool-navy
  // card surface (--shell #294781). Brand blue/royal/navy at full
  // saturation sat at ~1–2:1 against the lighter card and vanished.
  // These are chart-fill tints, NOT brand primitives — the locked
  // brand hexes still live in tokens.css :root and are used for accents.
  '#C8A45A', // gold (lead series — the brand signature)
  '#6E8FD8', // light blue (was brand blue #4A6DB5 — too dark on card)
  '#BDC9DD', // sky
  '#5577C0', // mid royal (was brand royal #3A5998 — blended into card)
  '#A8883A', // gold-dark
  '#5189BF', // logo gradient stop
  '#7A85C4', // soft periwinkle
  '#8E9FDB', // light periwinkle (was navy #17135C — invisible on card)
]);

/** Status colors for semantic chart sections (donuts, gauges, heatmaps). */
export const PRISM_STATUS_COLORS = Object.freeze({
  success: '#4FB48A',
  warning: '#C8A45A',
  danger:  '#D96A6A',
  info:    '#4A6DB5',
  neutral: '#BDC9DD',
  dim:     'rgba(189, 201, 221, 0.35)',
});

/** Brand colors keyed by drift-status / automation-status (replaces the
 *  per-page driftColors / automationColors maps in index.html). */
export const PRISM_DRIFT_COLORS = Object.freeze({
  built_in:        PRISM_STATUS_COLORS.success,
  limited:         PRISM_STATUS_COLORS.warning,
  audit_log_only:  '#9C8FE0',
  none:            PRISM_STATUS_COLORS.danger,
  immutable:       PRISM_STATUS_COLORS.info,
});

export const PRISM_AUTOMATION_COLORS = Object.freeze({
  full:          PRISM_STATUS_COLORS.success,
  partial:       PRISM_STATUS_COLORS.warning,
  manual_heavy:  PRISM_STATUS_COLORS.danger,
});

/** Lifecycle spectrum (T-078) — colors for the 5-state Mission Control view.
 *  Order matches the workflow: Idea → Handoff → Pending → Active → Shipped.
 *  Mirrors the --lifecycle-* tokens in tokens.css so chart segments and CSS
 *  accents stay in lockstep. */
export const PRISM_LIFECYCLE_COLORS = Object.freeze({
  idea:    '#E8A33C', // amber  — raw light
  handoff: '#E07A3C', // orange — warming
  pending: PRISM_CHART_PALETTE[1], // brand blue — parked
  active:  PRISM_STATUS_COLORS.success, // green — in motion
  shipped: '#8A6AD9', // violet — refracted complete
});

/** Ordered list of lifecycle state slugs in workflow order. Use this when
 *  building dataset arrays for the Lifecycle Distribution doughnut + the
 *  Pipeline-by-State stacked bar so the visual ordering of the spectrum is
 *  consistent across surfaces. */
export const PRISM_LIFECYCLE_ORDER = Object.freeze([
  'idea', 'handoff', 'pending', 'active', 'shipped',
]);

/** rgba helper for chart fills with consistent alpha. */
export function withAlpha(hex, alpha = 0.6) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Register brand-aligned Chart.js global defaults. Idempotent — safe to call
 *  multiple times. Accepts the Chart constructor from the page's
 *  Chart.js CDN script. */
export function registerPrismChartDefaults(Chart) {
  if (!Chart || !Chart.defaults) return;

  // Read live tokens from the themed body so dashboard and prefers-color-scheme
  // tweaks flow through to charts. Fall back to known brand hex if the body
  // is not yet themed (legacy pages during T-031).
  const css = typeof window !== 'undefined' && document.body
    ? getComputedStyle(document.body)
    : null;
  const tokens = name => (css && css.getPropertyValue(name).trim()) || '';

  Chart.defaults.color = tokens('--text-muted') || '#BDC9DD';
  Chart.defaults.borderColor = tokens('--border') || 'rgba(189, 201, 221, 0.12)';
  Chart.defaults.font.family = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.font.weight = '500';

  if (Chart.defaults.plugins) {
    if (Chart.defaults.plugins.legend) {
      Chart.defaults.plugins.legend.labels = {
        ...Chart.defaults.plugins.legend.labels,
        color: tokens('--text-muted') || '#BDC9DD',
        usePointStyle: true,
        boxWidth: 8,
        boxHeight: 8,
        padding: 16,
      };
    }
    if (Chart.defaults.plugins.tooltip) {
      Chart.defaults.plugins.tooltip = {
        ...Chart.defaults.plugins.tooltip,
        backgroundColor: tokens('--core') || '#1E195A',
        titleColor: '#FFFFFF',
        bodyColor: tokens('--sky') || '#BDC9DD',
        borderColor: tokens('--border-strong') || 'rgba(189, 201, 221, 0.22)',
        borderWidth: 1,
        padding: 12,
        cornerRadius: 8,
        displayColors: true,
        boxPadding: 6,
      };
    }
  }

  // Grid + axis defaults
  if (Chart.defaults.scale) {
    Chart.defaults.scale.grid = {
      ...Chart.defaults.scale.grid,
      color: tokens('--border') || 'rgba(189, 201, 221, 0.08)',
      drawBorder: false,
    };
    Chart.defaults.scale.ticks = {
      ...Chart.defaults.scale.ticks,
      color: tokens('--text-dim') || 'rgba(189, 201, 221, 0.55)',
    };
  }
}

/** Returns a dataset-ready palette array of length `n`, cycling the brand
 *  palette and inserting alpha for fill charts. */
export function brandSeries(n, alpha = 1) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const base = PRISM_CHART_PALETTE[i % PRISM_CHART_PALETTE.length];
    out.push(alpha < 1 ? withAlpha(base, alpha) : base);
  }
  return out;
}
