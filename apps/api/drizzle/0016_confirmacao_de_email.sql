ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
-- Quem já tinha conta antes desta versão não é cobrado de confirmar o e-mail: vale o cadastro.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
