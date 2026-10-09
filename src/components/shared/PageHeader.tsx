import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  description?: string;
  notice?: string;
  className?: string;
  actions?: React.ReactNode;
};

export function PageHeader({ title, description, notice, className, actions }: PageHeaderProps) {
  return (
    <header className={cn("flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight wrap-break-word text-foreground sm:text-2xl">{title}</h1>
        {description ? <p className="text-sm wrap-break-word text-muted-foreground md:text-base">{description}</p> : null}
        {notice ? (
          <p className="text-xs wrap-break-word text-muted-foreground" role="note">{notice}</p>
        ) : null}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
