const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;

/** Formats a whole-turn duration for the compact turn metadata row. */
export function formatTurnDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  if (durationMs < MILLISECONDS_PER_SECOND) {
    return '<1 sec';
  }

  const totalSeconds = Math.floor(durationMs / MILLISECONDS_PER_SECOND);
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds.toLocaleString()} sec`;
  }

  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return seconds === 0
    ? `${minutes.toLocaleString()} min`
    : `${minutes.toLocaleString()} min ${seconds} sec`;
}
