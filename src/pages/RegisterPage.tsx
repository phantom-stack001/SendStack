import { RegisterForm } from "@/components/auth/RegisterForm";
import { PageMeta } from "@/components/layout/PageMeta";

export function RegisterPage() {
  return (
    <>
      <PageMeta
        title="Create account | SendStack"
        description="Create a SendStack account for CTN Slovakia."
        canonicalPath="/register/"
      />
      <RegisterForm />
    </>
  );
}
