import { LoginForm } from "@/components/auth/LoginForm";
import { PageMeta } from "@/components/layout/PageMeta";

export function LoginPage() {
  return (
    <>
      <PageMeta
        title="Sign in | SendStack"
        description="Sign in to the SendStack workspace for CTN Slovakia."
        canonicalPath="/login/"
      />
      <LoginForm />
    </>
  );
}
