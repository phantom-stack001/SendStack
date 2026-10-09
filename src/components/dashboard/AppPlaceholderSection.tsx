import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type AppPlaceholderSectionProps = {
  title: string;
  description: string;
  emptyMessage: string;
};

export function AppPlaceholderSection({
  title,
  description,
  emptyMessage,
}: AppPlaceholderSectionProps) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Coming in a future phase</CardTitle>
          <CardDescription>This screen is a UI placeholder only.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </CardContent>
      </Card>
    </div>
  );
}
