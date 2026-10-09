import { Link, Outlet } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export function AuthLayout() {
  return (
    <div className="flex min-h-svh flex-col bg-muted">
      <div className="flex justify-center px-6 pt-6 md:px-10">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to CTN Slovakia
        </Link>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center p-6 pb-10 md:p-10">
        <div className="w-full max-w-sm md:max-w-3xl">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
