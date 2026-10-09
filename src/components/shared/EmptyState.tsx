import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center",
        className,
      )}
    >
      {Icon ? (
        <div
          className="mb-4 flex size-11 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm"
          aria-hidden={true}
        >
          <Icon className="size-5 stroke-[1.75]" />
        </div>
      ) : null}
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
