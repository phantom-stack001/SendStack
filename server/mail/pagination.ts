export function messagePageRange(total: number, page: number, limit: number) {
  if (total <= 0 || page < 1 || limit < 1) {
    return null;
  }
  const end = total - (page - 1) * limit;
  if (end < 1) {
    return null;
  }
  const start = Math.max(1, end - limit + 1);
  return { start, end };
}
