// Pure leaf extracted from index.js (no Discord/Client/shared state).
// Parse duration strings like "7d", "30 days", "2w", "1 month", "24h" -> ms.
export function seekdeepParseCleanDuration(input = '') {
  const t = String(input || '').toLowerCase().trim();
  const m = t.match(/^(\d+)\s*(h(?:ours?)?|d(?:ays?)?|w(?:eeks?)?|m(?:onths?)?)$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (!n || n <= 0) return 0;
  const unit = m[2][0];
  if (unit === 'h') return n * 3600000;
  if (unit === 'd') return n * 86400000;
  if (unit === 'w') return n * 7 * 86400000;
  if (unit === 'm') return n * 30 * 86400000;
  return 0;
}
