-- Custom SQL migration file, put your code below! --
-- Envios entregues antes desta versão perderam o conteúdo real (código, link, variáveis do modelo
-- do WhatsApp) sem deixar marca no job: se a Meta depois avisasse falha, o reenvio mandava o texto
-- mascarado. Marca esses jobs como os novos (sealedDropped), e o reenvio passa a ser recusado.
-- Só jobs sem o conteúdo cifrado ('sealed'); os ainda pendentes continuam com ele.
-- Idempotente: a marca já presente é mantida.
UPDATE "jobs" SET "payload" = "payload" || '{"sealedDropped":true}'::jsonb
WHERE "type" = 'delivery.send'
  AND NOT ("payload" ? 'sealed')
  AND NOT ("payload" ? 'sealedDropped')
  AND EXISTS (
    SELECT 1 FROM "deliveries" d
    WHERE d."id"::text = "jobs"."idempotency_key"
      AND (
        (d."channel" = 'whatsapp' AND d."template_key" IS NOT NULL)
        OR position('••••••' in d."body") > 0
        OR position('••••••' in coalesce(d."subject", '')) > 0
      )
  );
