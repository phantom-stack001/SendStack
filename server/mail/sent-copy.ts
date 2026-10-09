import type { MailLock } from "./lock.js";

export type SentAppendResult = "appended" | "already_present" | "failed";

/**
 * Search and append happen inside the same lock.
 * A second caller waits, then sees the first copy instead of appending again.
 * This does not collapse a message that also exists in another folder.
 */
export async function appendIfMessageMissing(options: {
  lock: MailLock;
  exists: () => Promise<boolean>;
  append: () => Promise<boolean>;
}): Promise<SentAppendResult> {
  return options.lock(async () => {
    if (await options.exists()) {
      return "already_present";
    }
    const appended = await options.append();
    return appended ? "appended" : "failed";
  });
}

export function isSameFolderDuplicate(
  left: { folder: string; messageId: string },
  right: { folder: string; messageId: string },
) {
  return left.folder === right.folder && left.messageId === right.messageId;
}

export function isCrossFolderCopy(
  left: { folder: string; messageId: string },
  right: { folder: string; messageId: string },
) {
  return left.messageId === right.messageId && left.folder !== right.folder;
}
