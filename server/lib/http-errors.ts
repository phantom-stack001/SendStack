import type { z } from "zod";

export function validationError(error: z.ZodError) {
  return {
    error: "Invalid input",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}
