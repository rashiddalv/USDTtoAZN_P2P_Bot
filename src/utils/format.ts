export function formatNumber(value: number, maxFractionDigits = 2): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFractionDigits }).format(value);
}

export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'n/a';
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDateTime(date: Date | null, timeZone: string): string {
  if (!date) return 'never';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const NBSP = ' ';

/** Integer with non-breaking thin groups: 1 500, 470 359. Never wraps mid-number on phones. */
export function formatInt(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Compact amount for narrow screens: 250, 1.2k, 470k, 1.3M. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZeros((value / 1_000_000).toFixed(1))}M`;
  if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
  if (abs >= 1_000) return `${trimZeros((value / 1000).toFixed(1))}k`;
  return trimZeros(value.toFixed(abs >= 100 ? 0 : 1));
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Whole percent: 86%, 97%. */
export function formatPercentShort(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'n/a';
  return `${Math.round(ratio * 100)}%`;
}

/** "09.09 20:57" — enough for a chat message. */
export function formatShortDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(',', '');
}

/**
 * Binance payment names are long ("Kapital Bank Instant", "M10 - Instant").
 * Drop the marketing suffixes so several methods fit on one phone line.
 */
export function shortPaymentName(name: string): string {
  return name
    .replace(/\s*[-–]\s*instant$/i, '')
    .replace(/\s+instant$/i, '')
    .replace(/\s+bank$/i, '')
    .trim();
}

export function formatPaymentMethods(methods: string[], max = 3): string {
  const short = [...new Set(methods.map(shortPaymentName).filter((s) => s.length > 0))];
  if (short.length === 0) return 'n/a';
  const shown = short.slice(0, max).join(', ');
  return short.length > max ? `${shown} +${short.length - max}` : shown;
}
