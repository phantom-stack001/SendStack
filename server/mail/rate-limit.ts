export const DIRECT_SEND_LIMITS = {
  maxRecipients: 3,
  minIntervalMs: 60_000,
  maxPerHour: 5,
  hourMs: 60 * 60 * 1000,
} as const;

export function assessDirectSendRateLimit(attempts: { createdAt: Date }[], now: Date) {
  const hourAgo = now.getTime() - DIRECT_SEND_LIMITS.hourMs;
  const recent = attempts.filter((attempt) => attempt.createdAt.getTime() >= hourAgo);
  if (recent.length >= DIRECT_SEND_LIMITS.maxPerHour) {
    return {
      allowed: false as const,
      message: "Individual sending is limited to 5 messages per hour.",
    };
  }
  const latest = recent.reduce<number | null>((current, attempt) => {
    const time = attempt.createdAt.getTime();
    return current === null || time > current ? time : current;
  }, null);
  if (latest !== null && now.getTime() - latest < DIRECT_SEND_LIMITS.minIntervalMs) {
    return {
      allowed: false as const,
      message: "Wait a minute before sending another email.",
    };
  }
  return { allowed: true as const };
}

export const TEST_SEND_LIMITS = {
  minIntervalMs: 60_000,
  maxPerHour: 3,
  hourMs: 60 * 60 * 1000,
  stalePendingMs: 2 * 60 * 1000,
} as const;

export function assessTestSendRateLimit(attempts: { createdAt: Date }[], now: Date) {
  const hourAgo = now.getTime() - TEST_SEND_LIMITS.hourMs;
  const recent = attempts.filter((attempt) => attempt.createdAt.getTime() >= hourAgo);
  if (recent.length >= TEST_SEND_LIMITS.maxPerHour) {
    return {
      allowed: false as const,
      message: "Test sending is limited to 3 messages per hour.",
    };
  }

  const latest = recent.reduce<number | null>((current, attempt) => {
    const time = attempt.createdAt.getTime();
    return current === null || time > current ? time : current;
  }, null);
  if (latest !== null && now.getTime() - latest < TEST_SEND_LIMITS.minIntervalMs) {
    return {
      allowed: false as const,
      message: "Wait a minute before sending another test message.",
    };
  }

  return { allowed: true as const };
}
