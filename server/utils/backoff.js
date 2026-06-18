export function getExponentialBackoffDelaySeconds({
  attempt = 0,
  baseDelaySeconds = 10,
  minDelaySeconds = 0,
  maxDelaySeconds = 120
} = {}) {
  const normalizedAttempt = Math.max(0, Number(attempt) || 0);
  const normalizedBase = Math.max(1, Number(baseDelaySeconds) || 1);
  const normalizedMin = Math.max(0, Number(minDelaySeconds) || 0);
  const normalizedMax = Math.max(normalizedMin || 1, Number(maxDelaySeconds) || 120);
  const exponentialDelay = normalizedBase * (2 ** normalizedAttempt);
  return Math.min(normalizedMax, Math.max(normalizedMin, exponentialDelay));
}
