import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { PageMeta } from "@/components/layout/PageMeta";

export function ForgotPasswordPage() {
  return (
    <>
      <PageMeta
        title="Reset password | SendStack"
        description="Reset your SendStack account password."
        canonicalPath="/forgot-password/"
      />
      <ForgotPasswordForm />
    </>
  );
}
