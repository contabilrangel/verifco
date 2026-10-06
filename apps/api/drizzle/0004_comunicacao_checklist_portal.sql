ALTER TABLE "backlogs" ADD COLUMN "source_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "backlogs_source_uq" ON "backlogs" USING btree ("declaration_id","source_key");