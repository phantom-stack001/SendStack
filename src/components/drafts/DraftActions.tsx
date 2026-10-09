import { Link } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

type DraftActionsProps = {
  draftId: string;
  onDelete: () => void;
};

export function DraftActions({ draftId, onDelete }: DraftActionsProps) {
  return (
    <div className="flex items-center justify-start gap-1 md:justify-end">
      <Button variant="ghost" size="icon" className="size-11 md:size-8" asChild>
        <Link to={`/app/compose/${draftId}/`} aria-label="Open draft">
          <Pencil />
        </Link>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 md:size-8"
        onClick={onDelete}
        aria-label="Delete draft"
      >
        <Trash2 />
      </Button>
    </div>
  );
}
