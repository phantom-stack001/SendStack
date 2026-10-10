import { EMPTY_TIPTAP_DOC, type TiptapDoc } from "@/lib/email-content";

export type ComposerFormState = {
  senderName: string;
  senderEmail: string;
  subject: string;
  contentJson: TiptapDoc;
  to: string[];
  cc: string[];
  bcc: string[];
};

export function buildFormStateFromDraft(draft: {
  senderName: string;
  senderEmail: string;
  subject: string;
  contentJson: TiptapDoc | null;
}): ComposerFormState {
  return {
    senderName: draft.senderName,
    senderEmail: draft.senderEmail,
    subject: draft.subject,
    contentJson: (draft.contentJson as TiptapDoc) ?? { ...EMPTY_TIPTAP_DOC },
    to: [],
    cc: [],
    bcc: [],
  };
}

export const emptyComposerFormState: ComposerFormState = {
  senderName: "",
  senderEmail: "",
  subject: "",
  contentJson: { ...EMPTY_TIPTAP_DOC },
  to: [],
  cc: [],
  bcc: [],
};
