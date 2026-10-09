import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useState } from "react";

import { EditorToolbar } from "@/components/composer/EditorToolbar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { EMPTY_TIPTAP_DOC, type TiptapDoc } from "@/lib/email-content";
import { composerExtensions } from "@/lib/tiptap-extensions";
import { cn } from "@/lib/utils";

type RichTextEditorProps = {
  content: TiptapDoc;
  onChange: (doc: TiptapDoc) => void;
  className?: string;
};

export function RichTextEditor({ content, onChange, className }: RichTextEditorProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const editor = useEditor({
    extensions: composerExtensions,
    content: content ?? EMPTY_TIPTAP_DOC,
    editorProps: {
      attributes: {
        class:
          "tiptap-editor prose prose-sm sm:prose-base max-w-none min-h-[280px] px-4 py-3 focus:outline-none [&_a]:text-primary [&_a]:underline",
        "aria-label": "Email body",
      },
    },
    onUpdate: ({ editor: current }) => {
      onChange(current.getJSON() as TiptapDoc);
    },
  });

  useEffect(() => {
    if (!editor) return;
    const currentJson = JSON.stringify(editor.getJSON());
    const nextJson = JSON.stringify(content ?? EMPTY_TIPTAP_DOC);
    if (currentJson !== nextJson) {
      editor.commands.setContent(content ?? EMPTY_TIPTAP_DOC, { emitUpdate: false });
    }
  }, [content, editor]);

  const openLinkDialog = () => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    setLinkUrl(previous ?? "https://");
    setLinkOpen(true);
  };

  const applyLink = () => {
    if (!editor) return;
    const trimmed = linkUrl.trim();
    if (!trimmed) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setLinkOpen(false);
      return;
    }
    const withProtocol =
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("mailto:")
        ? trimmed
        : `https://${trimmed}`;
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: withProtocol })
      .run();
    setLinkOpen(false);
  };

  return (
    <div className={cn("rounded-lg border border-border bg-background shadow-xs", className)}>
      <EditorToolbar editor={editor} onLinkClick={openLinkDialog} />
      <div className="rounded-b-lg border-t border-border">
        <EditorContent editor={editor} />
      </div>

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert link</DialogTitle>
            <DialogDescription>
              Use http, https, or mailto links. Links open in a new tab in the preview.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="composer-link-url">URL</Label>
            <Input
              id="composer-link-url"
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              placeholder="https://example.com"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLinkOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={applyLink}>Apply link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
