ALTER TABLE "files" ALTER COLUMN "size" SET DATA TYPE bigint;--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_token_uq" ON "budgets" USING btree ("approval_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "checklists_token_uq" ON "checklists" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "darfs_decl_idx" ON "darfs" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "deliveries_customer_idx" ON "deliveries" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_decl_idx" ON "documents" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "documents_checklist_item_idx" ON "documents" USING btree ("checklist_item_id");--> statement-breakpoint
CREATE INDEX "installments_office_receipt_idx" ON "installments" USING btree ("office_id","receipt_number");--> statement-breakpoint
CREATE INDEX "integrations_webhook_token_idx" ON "integrations" USING btree ("webhook_token");--> statement-breakpoint
CREATE INDEX "jobs_office_type_status_idx" ON "jobs" USING btree ("office_id","type","status");--> statement-breakpoint
CREATE INDEX "password_resets_token_idx" ON "password_resets" USING btree ("token_hash");