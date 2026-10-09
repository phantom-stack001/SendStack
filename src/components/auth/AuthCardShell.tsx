import { Link } from "react-router-dom";

import { Card, CardContent } from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";
import { AuthMarketingPanel } from "@/components/auth/AuthMarketingPanel";
import { cn } from "@/lib/utils";

type AuthCardShellProps = {
  children: React.ReactNode;
  className?: string;
};

export function AuthCardShell({ children, className }: AuthCardShellProps) {
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <Card className="overflow-hidden p-0">
        <CardContent className="grid p-0 md:grid-cols-2">
          <div className="p-6 md:p-8">{children}</div>
          <AuthMarketingPanel />
        </CardContent>
      </Card>
      <FieldDescription className="px-6 text-center">
        By continuing, you agree to our{" "}
        <Link to="/terms/" className="underline-offset-2 hover:underline">Terms of Service</Link>{" "}
        and{" "}
        <Link to="/privacy/" className="underline-offset-2 hover:underline">Privacy Policy</Link>.
      </FieldDescription>
    </div>
  );
}
