CREATE TABLE "reminder_marks" (
	"office_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"office_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"original_path" text,
	"reason" text NOT NULL,
	"cpf" text,
	"exercise_year" integer,
	"sha256" text NOT NULL,
	"token_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"document_id" uuid,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_indices" (
	"code" text NOT NULL,
	"period" text NOT NULL,
	"value" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "client_version" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "client_platform" text;--> statement-breakpoint
ALTER TABLE "installments" ADD COLUMN "external_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "installments" ADD COLUMN "charge_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "installments" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "installments" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_recovery_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_email_token_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pending_email_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reminder_marks" ADD CONSTRAINT "reminder_marks_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_inbox" ADD CONSTRAINT "sync_inbox_office_id_offices_id_fk" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_inbox" ADD CONSTRAINT "sync_inbox_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_marks_office_key_uq" ON "reminder_marks" USING btree ("office_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_inbox_office_hash_uq" ON "sync_inbox" USING btree ("office_id","sha256");--> statement-breakpoint
CREATE INDEX "sync_inbox_office_status_idx" ON "sync_inbox" USING btree ("office_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_indices_code_period_uq" ON "tax_indices" USING btree ("code","period");