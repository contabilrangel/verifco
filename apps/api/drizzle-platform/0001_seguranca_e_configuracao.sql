ALTER TABLE "platform_settings" ADD COLUMN "signup_enabled" boolean;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "trial_days" integer;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "trial_declaration_limit" integer;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "support_email" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "terms_url" text;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "privacy_url" text;--> statement-breakpoint
ALTER TABLE "platform_users" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "platform_users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_users" ADD COLUMN "totp_recovery_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_users" ADD COLUMN "last_login_at" timestamp with time zone;