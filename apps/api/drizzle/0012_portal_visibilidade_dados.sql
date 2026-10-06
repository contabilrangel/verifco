-- Custom SQL migration file, put your code below! --
-- A visibilidade no portal do cliente sai da categoria (documents.category = 'shared_with_customer',
-- gravada ao compartilhar) e passa para a coluna própria shared_with_customer. Os documentos já
-- compartilhados continuam no portal: a coluna fica marcada só nos enviados pelo escritório (os
-- únicos que o portal mostrava com essa categoria) e a categoria vira 'other' ("Outros").
-- A conversão é irreversível: ao compartilhar, a categoria anterior (ex.: DARF, recibo) foi
-- sobrescrita e não ficou guardada, então não há como recuperá-la; o escritório pode corrigir a
-- categoria na etapa Documentos do IRPF sem tirar o arquivo do portal.
-- Idempotente: depois da conversão nenhuma linha tem mais a categoria 'shared_with_customer'.
UPDATE "documents" SET "shared_with_customer" = ("uploaded_by" = 'office'), "category" = 'other'
WHERE "category" = 'shared_with_customer';
