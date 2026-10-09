import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3001),
  /** console = log links in dev; smtp = send via SMTP_*; disabled = no outbound mail */
  AUTH_EMAIL_DELIVERY: z.enum(["console", "smtp", "disabled"]).default("console"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().optional(),
});

export type ServerEnv = z.infer<typeof envSchema>;

export function loadEnv(): ServerEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid server environment: ${message}`);
  }
  return parsed.data;
}
