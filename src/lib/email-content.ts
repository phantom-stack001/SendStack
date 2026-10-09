export const EMPTY_TIPTAP_DOC = {
  type: "doc",
  content: [{ type: "paragraph" }],
} as const;

export type TiptapDoc = Record<string, unknown>;

export function isValidSenderEmail(value: string) {
  if (!value.trim()) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function draftDisplaySubject(subject: string) {
  const trimmed = subject.trim();
  return trimmed || "Untitled draft";
}
