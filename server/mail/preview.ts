export function previewFromPart(part: Buffer | undefined) {
  if (!part || part.length === 0) {
    return null;
  }
  let raw = part.toString("utf8").replaceAll("\u0000", "");
  const bodyStart = raw.search(/<body[\s>]/i);
  if (bodyStart >= 0) {
    raw = raw.slice(bodyStart);
  }
  const text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/<[^>]*$/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, " ")
    .replace(/&gt;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /[<>]/.test(text)) {
    return null;
  }
  const printable = [...text].filter((char) => {
    const code = char.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || code >= 32;
  }).length;
  if (printable / text.length < 0.85) {
    return null;
  }
  return text.slice(0, 140);
}
