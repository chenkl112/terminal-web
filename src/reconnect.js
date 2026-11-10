export function reconnectDelay(attempt, code) {
  // Opening the transport is not a stable connection. In particular, a 1013
  // after a large snapshot must not restart a one-second reconnect loop.
  return Math.min((code === 1013 ? 3000 : 1000) * 2 ** Math.min(attempt, 5), 30000);
}
