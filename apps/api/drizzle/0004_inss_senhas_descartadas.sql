-- Custom SQL migration file, put your code below! --
-- COB-7: o Verifco não tem integração com o INSS, então as senhas gov.br importadas em "Login INSS em
-- lote" não tinham uso. Avisa no sino os escritórios que tinham senhas, descarta as senhas e retira a
-- permissão da planilha das funções (a importação e a permissão saíram do sistema).
INSERT INTO "notifications" ("office_id", "title", "body", "link")
SELECT DISTINCT "office_id",
  'Senhas do INSS descartadas',
  'O Verifco não tem integração com o INSS. Por segurança (LGPD), as senhas gov.br do INSS importadas em lote foram apagadas e a importação "Login INSS em lote" foi retirada. Nada mais muda nos clientes.',
  '/clientes'
FROM "customers" WHERE "inss_password_enc" IS NOT NULL;
--> statement-breakpoint
UPDATE "customers" SET "inss_password_enc" = NULL WHERE "inss_password_enc" IS NOT NULL;
--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'worksheet.inss' WHERE "permissions" ? 'worksheet.inss';
