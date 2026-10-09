const SENT_NAMES = new Set(["sent", "sent items", "sent messages", "sent mail"]);

export type SentMailboxCandidate = {
  path: string;
  name: string;
  specialUse?: string | null;
  selectable?: boolean;
};

export function findSentMailbox<T extends SentMailboxCandidate>(mailboxes: T[]): T | null {
  const flagged = mailboxes.find((box) => box.specialUse === "\\Sent" && box.selectable !== false);
  if (flagged) {
    return flagged;
  }
  return (
    mailboxes.find((box) => {
      if (box.selectable === false) {
        return false;
      }
      const name = box.name.trim().toLowerCase();
      const path = box.path.trim().toLowerCase();
      return SENT_NAMES.has(name) || SENT_NAMES.has(path);
    }) ?? null
  );
}
