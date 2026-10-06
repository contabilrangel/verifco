-- Custom SQL migration file, put your code below! --
-- links do checklist já enviados antes da validade (0002) continuam valendo por 30 dias a partir desta versão
UPDATE "checklists" SET "access_expires_at" = now() + interval '30 days' WHERE "access_expires_at" IS NULL;