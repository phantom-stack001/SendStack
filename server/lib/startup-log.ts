const startedAt = Date.now();

const URL_IN_TEXT = /(?:postgres(?:ql)?:\/\/|rediss?:\/\/)\S+/gi;

export function logStartup(stage: string) {
  console.info(`[startup] ${stage} +${Date.now() - startedAt}ms`);
}

/** Error text safe for logs: no database URLs, Redis URLs, or credential-shaped text. */
export function safeErrorLabel(error: unknown) {
  if (!(error instanceof Error)) return "Error";
  const message = error.message.replace(URL_IN_TEXT, "[url]").replace(/\s+/g, " ").trim();
  if (/password|secret|token|api[_-]?key|@/i.test(message)) return error.name;
  const compact = message.slice(0, 160);
  return compact ? `${error.name}: ${compact}` : error.name;
}

export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = work.catch((error: unknown) => {
    console.error(`[health] ${label}`, safeErrorLabel(error));
    return fallback;
  });
  try {
    return await Promise.race([
      guarded,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.error(`[health] ${label} timed out`);
          resolve(fallback);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
