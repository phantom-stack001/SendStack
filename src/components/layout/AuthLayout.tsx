import { Link, Outlet } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export function AuthLayout() {
  return (
    <div className="flex min-h-svh flex-col bg-muted">
      <div className="flex justify-center px-4 pt-[max(1.5rem,env(safe-area-inset-top))] md:px-10">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to CTN Slovakia
        </Link>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center p-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] md:p-10">
        <div className="w-full max-w-sm md:max-w-3xl">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
