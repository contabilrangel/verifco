# Extensão Verifco (Chrome, Edge e Opera)

Extensão Manifest V3, em JavaScript puro, **sem etapa de build**. Ela faz duas coisas:

1. **Ações eCAC** — na aba “Ações eCAC” do cliente, o botão “Acessar” pede à extensão para abrir
   o serviço do eCAC (Carnê-Leão, Meu Imposto de Renda, CND, Fontes pagadoras) numa nova aba.
   A aba mostra um aviso discreto com o CPF do cliente (botão “Copiar CPF”) para o procurador
   trocar o perfil de acesso. Nada é preenchido nem clicado automaticamente no eCAC.
2. **Captura (experimental, desligada por padrão)** — quando habilitada no popup, roda os
   *leitores de página* (“parsers”) marcados e envia ao Verifco os registros interpretados
   (`POST /api/sync/ecac-records`).

> O HTML das páginas do eCAC não é público nem estável. Os parsers incluídos são **pontos de
> extensão vazios** (devolvem lista vazia). Implemente cada um lendo a página real, como
> explicado abaixo. A extensão nunca inventa dados.

### O que vem de onde

| Dado | Fonte hoje |
| --- | --- |
| Procuração eletrônica, caixa postal (indicador e lista, sem abrir o conteúdo), situação fiscal (SITFIS, com o PDF) e pagamento das quotas do DARF (receita 0211) | SERPRO Integra Contador, pela sincronização do eCAC na API (*Administração › Robô* ou aba eCAC do cliente), sem a extensão |
| Situação da declaração, malha, lote de restituição | Extensão (parser `meu-irpf-situacao`, **desligado**) ou lançamento manual na aba eCAC do cliente. O Integra Contador não informa esses dados |
| Extrato de rendimentos, status simplificado | Lançamento manual na aba eCAC do cliente (não há parser para essas páginas) |
| Mensagens da caixa postal | SERPRO (lista); a extensão tem o parser `caixa-postal`, **desligado** |
| CND (PDF) | Extensão (parser `certidao-cnd`, **desligado**) ou lançamento manual. O Integra Contador não emite CND de pessoa física; a certidão vigente aparece na leitura do relatório SITFIS |
| Pré-preenchida | Sincronizador (pasta de pré-preenchidas, `--pasta-pre`) ou envio manual na tela *Pré-preenchidas*. O Integra Contador não tem esse serviço e a extensão não tem leitor dessa página (veja o comentário em `content/parsers.js`) |

## Instalação (sem compactação)

1. Baixe o `.zip` na Central de downloads do Verifco (ou use esta pasta `apps/extension`) e
   descompacte numa pasta fixa.
2. Abra `chrome://extensions` (Edge: `edge://extensions`; Opera: `opera://extensions`).
3. Ligue o **Modo do desenvolvedor** e clique em **Carregar sem compactação**; escolha a pasta.
4. Clique no ícone da extensão e preencha:
   - **Endereço do Verifco (web)** — onde você abre o Verifco (ex.: `https://app.seuescritorio.com.br`
     ou, em desenvolvimento, `http://localhost:5106`);
   - **Endereço da API** — só se a API estiver em outro endereço;
   - **Token da extensão** — crie em *Administração › Robô*, escopo **Extensão** (`vfk_...`).
5. **Salvar** (o navegador pede permissão só para esses endereços) e **Testar conexão**.
6. Recarregue a página do Verifco. Na aba “Ações eCAC”, o selo “Extensão ativa” confirma a ponte.

Safari: ainda não disponível.

## Como funciona

| Arquivo | Papel |
| --- | --- |
| `manifest.json` | Permissões: `storage`, `scripting`; hosts do eCAC; hosts opcionais pedidos no popup. |
| `lib/config.js` | Endereços dos serviços do eCAC (`SERVICES`) e utilitários. **Ajuste aqui se a Receita mudar uma URL.** |
| `service-worker.js` | Abre as abas, guarda o contexto (serviço + CPF) no `chrome.storage.session`, chama a API com o token. |
| `content/bridge.js` | Roda nas páginas do Verifco. Recebe `postMessage` da página e responde. |
| `content/capture-core.js` | Registro de parsers e utilitários de leitura (`valueByLabel`, `moneyToCents`, `dateToIso`). |
| `content/parsers.js` | **Pontos de extensão**: parsers registrados, desligados. |
| `content/ecac.js` | Roda no eCAC: mostra o aviso e, se habilitado, executa os parsers e envia os registros. |
| `popup/` | Configuração (endereços, token, captura). O token fica só no `chrome.storage.local` deste navegador. |

### Protocolo com a página do Verifco

A página envia para a própria janela:

```js
window.postMessage({ type: 'VERIFCO_OPEN_ECAC', service: 'carne_leao', cpf: '52998224725', requestId }, location.origin);
window.postMessage({ type: 'VERIFCO_PING', requestId }, location.origin);
```

A extensão responde `{ type: 'VERIFCO_EXTENSION_ACK', requestId, ok, version, error? }`. Sem resposta
em 1,5 s, o Verifco mostra como instalar. Serviços: `carne_leao`, `meu_irpf`, `cnd`, `fontes_pagadoras`.

A ponte é injetada em `http://localhost/*`, `http://127.0.0.1/*` e `https://*.verifco.com.br/*`
(manifest) e, por registro dinâmico, no endereço informado no popup.

## Escrevendo um parser

Em `content/parsers.js`:

```js
VerifcoCapture.register({
  id: 'meu-irpf-situacao',
  description: 'Meu Imposto de Renda — situação da declaração',
  matches: [/^https:\/\/www3\.cav\.receita\.fazenda\.gov\.br\/extratodirpf\//],
  parse(doc, ctx) {
    const status = ctx.helpers.valueByLabel(doc, 'Situação'); // leia o HTML real da página
    if (!status) return [];
    return [{ kind: 'declaration', cpf: ctx.cpf, year: 2026, externalId: '<nº do recibo>', data: { status: 'processing' } }];
  },
});
```

- `ctx.cpf` é o CPF do cliente quando a aba foi aberta pelo Verifco (ou `null`).
- Registros fora do formato são descartados. Use `externalId` estável para não duplicar.
- Habilite a captura no popup e marque o parser para testá-lo. Abra o console da aba para ver avisos.

### Formato dos registros (`POST /api/sync/ecac-records`)

```json
{ "records": [ { "kind": "cnd", "cpf": "52998224725", "year": 2026, "externalId": "opcional",
                 "data": { "status": "success" },
                 "file": { "filename": "cnd.pdf", "mimeType": "application/pdf", "base64": "..." } } ] }
```

| `kind` | Campos de `data` reconhecidos | Efeito no Verifco |
| --- | --- | --- |
| `declaration` | `status` (`unknown`, `waiting`, `processing`, `fine_mesh`, `refund_lot`, `processed`, `pending_issues`), `type`, `isRectification`, `taxation` (`complete`/`simplified`), `receiptNumber` | Painel “Declarações processadas”; atualiza a situação eCAC da declaração do ano |
| `income_statement` | `issuedAt` (AAAA-MM-DD), `description` | Painel “Extrato de rendimentos” |
| `darf` | `valueCents`, `dueDate`, `quotaNumber`, `status` (`open`/`paid`/`overdue`), `barcode` | Cria a guia em “Acompanhamento DARF” |
| `cnd` | `status` (`success`, `invalid_cpf`, `cpf_not_found`, `pending_issues`), `issuedAt`, `validUntil` | Situação da CND do cliente |
| `simplified_status` / `fiscal_situation` | `situation`, `message`, `pendencies` (lista de textos) | Painel “Status simplificado” |
| `mailbox_message` | `subject`, `receivedAt`, `read` | Conta as mensagens não lidas da caixa postal |
| `procuration` | `status` (`valid`, `expired`, `invalid`...), `expiresAt`, `govbrLevel` (`bronze`/`silver`/`gold`) | Situação e validade da procuração |
| `other` | livre | Só registro |

Cada item tem resultado próprio na resposta (`results[i].ok`/`error`); um CPF desconhecido não derruba o lote.
O token precisa ser do escopo **Extensão**.
