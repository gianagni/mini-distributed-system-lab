// Exponential backoff dengan full jitter.
// delay = random(0 .. min(cap, base * 2^(attempt-1)))
// Jitter menyebar retry dari banyak job supaya tidak serempak (mencegah retry storm).

export function backoffDelay(attempt, { baseMs, capMs }, random = Math.random) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt harus integer >= 1');
  }
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * (ceiling + 1));
}
