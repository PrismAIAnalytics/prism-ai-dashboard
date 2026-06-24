// services/businessDay.js — Eastern business-day helpers (T-124 / PRISM-715)
//
// The firm operates in America/New_York and the orchestrator (which runs on
// Michele's ET machine) keys every daily artifact — morning briefs, daily logs —
// to its ET calendar date. Production runs on Railway in UTC, so the old
// `new Date().toISOString().slice(0,10)` computed "today" in UTC and, in the
// ~8 PM-midnight ET window (00:00-04:00 UTC), already rolled to tomorrow — so
// today's ET-dated brief was only found as "yesterday" and got the stale banner.
//
// NOTE: setting TZ=America/New_York on Railway does NOT fix this — toISOString()
// is always UTC regardless of process TZ. The fix has to be in code.
//
// Use businessToday() everywhere "today" means the business day. Reserve raw
// `new Date().toISOString()` for instant timestamps (created_at/updated_at/as_of)
// and for the internal UTC-keyed snapshot/report series, which stays UTC.

const BUSINESS_TZ = 'America/New_York';

// 'YYYY-MM-DD' for the business day (Eastern) of the given instant (default now).
// en-CA formats as ISO (YYYY-MM-DD), so no reordering is needed.
function businessToday(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ }).format(at);
}

// 'YYYY-MM-DD' for the business day `days` before today (Eastern). Pure calendar
// arithmetic on the ET date string — DST-safe (never crosses a TZ boundary in
// the math, unlike subtracting 86_400_000 ms from a UTC instant).
function businessDayMinus(days, at = new Date()) {
  const [y, m, d] = businessToday(at).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

module.exports = { businessToday, businessDayMinus, BUSINESS_TZ };
