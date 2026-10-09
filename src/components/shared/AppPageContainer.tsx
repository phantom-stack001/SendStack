import { cn } from "@/lib/utils";

type AppPageContainerProps = React.ComponentProps<"div">;

export function AppPageContainer({ className, ...props }: AppPageContainerProps) {
  return (
    <div
      className={cn("mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6", className)}
      {...props}
    />
  );
}
