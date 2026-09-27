export function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Fixed-decimal display of a live reading; '---' when there is no data. */
export function fmt(value, digits = 0) {
  return isNum(value) ? value.toFixed(digits) : '---';
}

/** Thousands-separated integer display of a live reading; '---' when there is no data. */
export function fmtInt(value) {
  return isNum(value) ? Math.round(value).toLocaleString() : '---';
}

export function kgPerSecToLitresPerHour(kgPerSec) {
  return isNum(kgPerSec) ? (kgPerSec * 3600) / 0.72 : null;
}

export function humanize(snake) {
  return String(snake || '').replace(/_/g, ' ').toUpperCase();
}
