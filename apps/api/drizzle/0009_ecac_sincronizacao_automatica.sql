-- Custom SQL migration file, put your code below! --
-- A sincronização automática do eCAC pelo SERPRO passa a ser configurável (desligada, diária ou
-- semanal), com padrão desligada nas integrações novas: cada consulta é cobrada pelo SERPRO. Até
-- aqui, todo SERPRO ativo sincronizava todo dia; para não mudar nada sem aviso, as integrações já
-- ativas ficam com "diária" gravada na configuração (e um registro na auditoria do escritório).
INSERT INTO "audit_logs" ("office_id", "action", "entity", "entity_id", "data")
SELECT "office_id", 'integration.update', 'integration', "id"::text,
  jsonb_build_object('provider', 'serpro', 'changedConfig', jsonb_build_array('autoSync'), 'autoSync', jsonb_build_object('from', NULL, 'to', 'daily'), 'migration', true)
FROM "integrations" WHERE "provider" = 'serpro' AND "enabled" = true AND NOT ("public_config" ? 'autoSync');
--> statement-breakpoint
UPDATE "integrations" SET "public_config" = "public_config" || '{"autoSync":"daily"}'::jsonb
WHERE "provider" = 'serpro' AND "enabled" = true AND NOT ("public_config" ? 'autoSync');
