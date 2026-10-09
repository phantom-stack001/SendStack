import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  description?: string;
  notice?: string;
  className?: string;
};

export function PageHeader({ title, description, notice, className }: PageHeaderProps) {
  return (
    <header className={cn("space-y-1", className)}>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? <p className="text-sm text-muted-foreground md:text-base">{description}</p> : null}
      {notice ? (
        <p className="text-xs text-muted-foreground" role="note">{notice}</p>
      ) : null}
    </header>
  );
}
