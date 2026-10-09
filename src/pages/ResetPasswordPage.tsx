import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { PageMeta } from "@/components/layout/PageMeta";

export function ResetPasswordPage() {
  return (
    <>
      <PageMeta
        title="Choose new password | SendStack"
        description="Set a new password for your SendStack account."
        canonicalPath="/reset-password/"
      />
      <ResetPasswordForm />
    </>
  );
}
