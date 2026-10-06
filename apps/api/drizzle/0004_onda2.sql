ALTER TABLE "files" ALTER COLUMN "size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "declarations" ADD COLUMN "elaboration_counts" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lock_token" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_id_jobs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_approval_token_uq" ON "budgets" USING btree ("approval_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "checklists_access_token_uq" ON "checklists" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "darfs_declaration_idx" ON "darfs" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "deliveries_customer_idx" ON "deliveries" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_declaration_idx" ON "documents" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "documents_checklist_item_idx" ON "documents" USING btree ("checklist_item_id");--> statement-breakpoint
CREATE INDEX "installments_office_receipt_idx" ON "installments" USING btree ("office_id","receipt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_webhook_token_uq" ON "integrations" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "jobs_parent_idx" ON "jobs" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" USING btree ("office_id","type") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_office_external_uq" ON "messages" USING btree ("office_id","external_id") WHERE "messages"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "password_resets_token_idx" ON "password_resets" USING btree ("token_hash");