-- Preserve identidades, configurações, credenciais cifradas e auditoria antes de retirar as tabelas públicas.
CREATE SCHEMA "legacy_platform";
--> statement-breakpoint
CREATE TABLE "legacy_platform"."platform_users" (LIKE "public"."platform_users" INCLUDING ALL);
--> statement-breakpoint
INSERT INTO "legacy_platform"."platform_users" SELECT * FROM "public"."platform_users";
--> statement-breakpoint
CREATE TABLE "legacy_platform"."platform_ai_connections" (LIKE "public"."platform_ai_connections" INCLUDING ALL);
--> statement-breakpoint
INSERT INTO "legacy_platform"."platform_ai_connections" SELECT * FROM "public"."platform_ai_connections";
--> statement-breakpoint
CREATE TABLE "legacy_platform"."platform_settings" (LIKE "public"."platform_settings" INCLUDING ALL);
--> statement-breakpoint
INSERT INTO "legacy_platform"."platform_settings" SELECT * FROM "public"."platform_settings";
--> statement-breakpoint
CREATE TABLE "legacy_platform"."platform_audit_logs" (LIKE "public"."platform_audit_logs" INCLUDING ALL);
--> statement-breakpoint
INSERT INTO "legacy_platform"."platform_audit_logs" SELECT * FROM "public"."platform_audit_logs";
