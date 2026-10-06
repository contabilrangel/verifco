-- Custom SQL migration file, put your code below! --
-- COB-7: o Verifco não consulta o INSS, então a senha gov.br guardada para isso é apagada (LGPD,
-- princípio da necessidade). Os escritórios que tinham senhas recebem um aviso no sino (com o link
-- para a nota na tela de importações) e um registro na auditoria; a permissão da planilha sai das funções.
INSERT INTO "notifications" ("office_id", "title", "body", "link")
SELECT "office_id", 'Senhas do INSS apagadas',
  'O Verifco não consulta o INSS (extrato CNIS ou informe de rendimentos), por isso deixou de pedir a senha gov.br para o INSS e apagou ' || count(*) || ' senha(s) guardada(s) dos clientes. O login e a senha do eCAC continuam guardados.',
  '/importacoes/inss'
FROM "customers" WHERE "inss_password_enc" IS NOT NULL GROUP BY "office_id";
--> statement-breakpoint
INSERT INTO "audit_logs" ("office_id", "action", "entity", "entity_id", "data")
SELECT "office_id", 'inss_password.purge', 'office', "office_id"::text, jsonb_build_object('customers', count(*))
FROM "customers" WHERE "inss_password_enc" IS NOT NULL GROUP BY "office_id";
--> statement-breakpoint
UPDATE "customers" SET "inss_password_enc" = NULL WHERE "inss_password_enc" IS NOT NULL;
--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'worksheet.inss' WHERE "permissions" @> '["worksheet.inss"]'::jsonb;
