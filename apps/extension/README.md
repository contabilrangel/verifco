# Extensão Verifco (Chrome, Edge e Opera)

Extensão Manifest V3, em JavaScript puro, **sem etapa de build**. Versão 0.2.0.

Ela liga o navegador ao Verifco do escritório. **Não lê o eCAC sozinha**: o HTML das páginas da
Receita não é público nem estável, então a extensão não tem leitores de página. O que ela faz é
levar ao Verifco, com um clique seu, o que você está vendo ou baixou.

## O que ela faz

1. **Abre o serviço do eCAC a partir do Verifco.** Na aba “Ações eCAC” do cliente, o botão
   “Acessar” abre o serviço (Carnê-Leão, Meu Imposto de Renda, CND, Fontes pagadoras) numa nova
   aba. Nas páginas da Receita aparece um aviso com o serviço pedido e o CPF do cliente, com os
   botões **Copiar CPF** e **Registrar página**. O aviso vale por 30 minutos e acompanha a
   navegação dentro do eCAC. Nada é preenchido nem clicado no eCAC.
2. **Enviar arquivo** (popup › Arquivo). Escolha ou arraste um ou mais arquivos (até 25 MB cada),
   informe o exercício e a categoria, e eles vão para os documentos do cliente. Marque
   “É a pré-preenchida” para mandar o arquivo para a tela *Pré-preenchidas*.
3. **Registrar esta página** (popup › Página). Envia o título, o endereço e o texto da aba: o
   trecho selecionado ou, sem seleção, o texto visível (até 8.000 caracteres). Você pode editar o
   título e o texto antes de enviar e anexar a imagem da tela (PNG). Fica na aba eCAC do cliente,
   como registro “Outro”.
4. **Situação da declaração e CND** (popup › Situação). Dois formulários curtos: exercício,
   situação e nº do recibo; situação da CND, validade e código de controle. Atualizam a situação
   do cliente no Verifco, como um lançamento manual.
5. **Menu do botão direito.**
   - *Enviar seleção ao Verifco*: o texto selecionado vira um registro do cliente.
   - *Enviar este link/arquivo ao Verifco* (em links e imagens) e *Enviar este PDF ao Verifco*
     (em abas cujo endereço termina em `.pdf`): a extensão baixa o arquivo com a sua sessão do
     navegador e manda para os documentos do cliente. Se o site não deixar baixar, ela avisa:
     baixe o arquivo e use “Enviar arquivo”.
6. **Últimos envios** (popup › Envios). Os 30 últimos envios deste navegador, com hora, cliente,
   o que foi enviado e se deu certo. O ícone mostra **✓** ou **!** depois de cada envio, até você
   abrir o popup.

### Qual cliente recebe o envio

O popup mostra o cliente em uso no topo. Vale o mais recente entre:

- o cliente que você escolheu na busca do popup (nome ou CPF); e
- o CPF do último “Acessar” feito no Verifco (por 30 minutos).

A escolha dura até fechar o navegador. Sem cliente, nada é enviado: o menu do botão direito pede
para você escolher um no popup (a seleção fica guardada e o popup termina o envio).
O botão “Registrar página” do aviso usa sempre o CPF mostrado no próprio aviso.

### O que a extensão **não** faz

- Não lê situação, malha, restituição, mensagens nem certidões das páginas do eCAC. Esses dados
  chegam ao Verifco pelo SERPRO Integra Contador (*Meu escritório › Robô*), pelo sincronizador, pelos
  formulários acima ou por lançamento manual.
- Não preenche, não clica e não navega no eCAC.
- Não envia nada em segundo plano.

## Instalação

1. Baixe o `.zip` na **Central de downloads** do Verifco e descompacte numa pasta fixa (se a pasta
   for apagada ou movida, a extensão para de funcionar). Quem tem o código pode usar direto a
   pasta `apps/extension`.
2. Abra `chrome://extensions` (Edge: `edge://extensions`; Opera: `opera://extensions`).
3. Ligue o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha **a pasta que contém o arquivo
   `manifest.json`** (não a pasta de cima).
5. Clique no ícone do Verifco (fixe-o pelo ícone de quebra-cabeça) e abra **Configuração**:
   - **Endereço do Verifco (web)**: onde você abre o Verifco (ex.: `https://app.seuescritorio.com.br`;
     em desenvolvimento, `http://localhost:5106`);
   - **Endereço da API**: só se a API estiver em outro endereço;
   - **Token da extensão**: crie em *Meu escritório › Robô*, escopo **Extensão** (`vfk_...`).
6. **Salvar** (o navegador pede permissão só para esses endereços) e **Testar conexão**. O nome do
   escritório aparece no topo do popup.
7. Recarregue a página do Verifco. Na aba “Ações eCAC”, o selo “Extensão ativa” confirma a ligação.

**Atualizar:** quando o popup avisar que há versão nova, baixe o `.zip` de novo, substitua os
arquivos da pasta e clique em recarregar (seta circular) no cartão da extensão em
`chrome://extensions`. A configuração é mantida.

Safari e Firefox: não disponível.

## Privacidade

**Só há envio quando você clica** em um botão de envio do popup, em “Registrar página” no aviso
ou em um item do menu do botão direito. Sem clique, a extensão não lê nem envia página nenhuma.

| Ação | O que vai para o Verifco do seu escritório |
| --- | --- |
| Enviar arquivo | O arquivo, o CPF do cliente, o exercício e a categoria |
| Registrar página / Enviar seleção | Título, endereço da página, o texto selecionado ou o texto visível (até 8.000 caracteres) e, se marcado, a imagem da parte visível da aba |
| Situação da declaração / CND | O CPF e os campos do formulário |
| Enviar link/arquivo | O arquivo baixado, o CPF e o endereço da página de origem |
| Buscar cliente | O texto digitado na busca |
| Qualquer chamada | O token e a versão da extensão (`X-Verifco-Client: extension/0.2.0 (chrome)`) |

- Os dados vão **somente** para o endereço do Verifco configurado, pela API `/api/sync/*`.
  Nenhum outro servidor recebe nada.
- “Registrar página” lê a aba inteira, inclusive os quadros internos (o eCAC abre os serviços
  dentro de um quadro). Confira o texto na aba “Página” antes de enviar; dá para apagar trechos.
- O texto oculto pela página não é enviado, nem o que está digitado em campos de formulário
  (senhas, por exemplo). A imagem da tela, quando anexada, mostra o que estiver visível na aba.
- **Neste navegador ficam guardados:** os endereços e o token (`chrome.storage.local`, sem
  criptografia: use um perfil do navegador só seu); os últimos 30 envios, com o nome do cliente e o
  CPF **mascarado** (`***.982.247-**`); e, só até fechar o navegador, o cliente em uso e o CPF do
  último “Acessar”.
- Para apagar tudo, remova a extensão. Para invalidar o token, revogue-o em *Meu escritório › Robô*.

### Permissões pedidas

| Permissão | Para quê |
| --- | --- |
| `storage` | Configuração, cliente em uso e últimos envios |
| `activeTab` | Ler a aba atual e tirar a imagem da tela **depois** de você clicar na extensão ou no menu |
| `scripting` | Executar a leitura da aba e ligar a extensão ao endereço do Verifco configurado |
| `contextMenus` | Os itens do menu do botão direito |
| `notifications` | Avisar o resultado dos envios feitos pelo menu |
| `https://*.receita.fazenda.gov.br/*`, `https://*.receitafederal.gov.br/*` | Mostrar o aviso com o CPF, ler os quadros do eCAC em “Registrar página” e baixar links desses sites |
| Endereço do Verifco (opcional, pedido ao salvar) | Falar com a API do seu escritório |

`https://*.gov.br/receitafederal/*` ficou de fora de propósito: como permissão de site o navegador
ignora o caminho, e a extensão passaria a ter acesso a todo `gov.br`. Nessas páginas (e em
qualquer outro site) o popup e o menu do botão direito funcionam pelo `activeTab`.

## Limites conhecidos

- **Popup fecha ao perder o foco.** Em alguns sistemas, arrastar um arquivo de outra janela fecha
  o popup. Use **Abrir em janela** (aba Arquivo): a mesma tela abre numa janela que não fecha.
- **Imagem da tela pelo aviso.** O navegador só libera a imagem depois de um clique no ícone da
  extensão naquela aba. Pelo botão do aviso normalmente vai só o texto; para mandar a imagem, use o
  popup › Página.
- **PDF aberto na aba e páginas internas do navegador** não podem ser lidos como página. Para PDF,
  use o menu do botão direito ou baixe e use “Enviar arquivo”.
- **Links que dependem de clique** (`javascript:`, downloads gerados na hora) não podem ser
  baixados pela extensão: baixe o arquivo e use “Enviar arquivo”.
- **Valores dentro de campos de formulário** não entram no texto de “Registrar página”. Se o dado
  que importa está num campo, anexe a imagem da tela ou selecione e copie o trecho para o texto.
- O anexo de “Registrar página” tem limite de cerca de 10 MB; telas muito grandes vão em JPEG.

## Para quem desenvolve

| Arquivo | Papel |
| --- | --- |
| `manifest.json` | Permissões e scripts. |
| `service-worker.js` | Abre as abas do eCAC, guarda o contexto, menu de contexto, botão do aviso. |
| `lib/config.js` | Endereços dos serviços do eCAC (`SERVICES`), chaves de armazenamento e limites. **Ajuste aqui se a Receita mudar uma URL.** |
| `lib/format.js` | Funções puras: CPF, datas, textos, nomes de arquivo, cliente em uso, histórico. |
| `lib/statuses.js` | Cópia das situações e categorias de `packages/shared` (a extensão não tem build). |
| `lib/api.js` | Cliente de `/api/sync/*` (token e `X-Verifco-Client` em toda chamada). |
| `lib/capture.js` | Leitura genérica da aba e imagem da tela. |
| `lib/actions.js` | Os envios (arquivo, página, situação, CND), usados pelo popup e pelo service worker. |
| `lib/store.js` | Leitura e gravação no `chrome.storage` e selo do ícone. |
| `content/bridge.js` | Roda nas páginas do Verifco: recebe `postMessage` da página e responde. |
| `content/ecac.js` | Roda nas páginas da Receita: o aviso com o CPF. |
| `popup/` | A tela da extensão. |
| `test/` | Testes das funções puras e do pacote. |

### Testes

Sem dependências; usa o executor de testes do Node (22 ou mais novo). A extensão não é um pacote
do workspace (não tem `package.json`), então rode direto:

```sh
cd apps/extension && node --test
# ou, da raiz do repositório:
node --test "apps/extension/test/*.test.mjs"
```

Os testes cobrem `lib/format.js`, `lib/api.js` (com um `fetch` de teste), `lib/capture.js`,
`lib/actions.js` e o pacote: `manifest.json` válido, todo arquivo citado existe, todo `.js` passa
em `node --check` e `lib/statuses.js` bate com `packages/shared`.

### API usada

Base: endereço configurado + `/api`. Cabeçalhos: `Authorization: Bearer <token>` e
`X-Verifco-Client: extension/<versão> (chrome)`. O token precisa ser do escopo **Extensão**.

| Chamada | Uso |
| --- | --- |
| `GET /sync/whoami` | Testar conexão; `client.updateAvailable`/`unsupported` geram o aviso de versão |
| `GET /sync/customers?q=&limit=20` | Busca de cliente (em servidor antigo, que devolve a lista inteira, o filtro é feito na extensão) |
| `POST /sync/documents` (multipart) | `file`, `cpf`, `ano`, `categoria`, `origem`, `titulo` |
| `POST /sync/prefilled` (multipart) | `file`, `cpf`, `ano` |
| `POST /sync/ecac-records` (JSON) | Registros `other` (página/seleção: `data.title`, `data.text`, `data.url`), `declaration` (`year`, `data.status`, `data.receiptNumber`) e `cnd` (`data.status`, `data.validUntil`, `data.code`) |

Erros vêm como `{ "error": "mensagem" }` e são mostrados como chegam.

### Protocolo com a página do Verifco

A página envia para a própria janela:

```js
window.postMessage({ type: 'VERIFCO_OPEN_ECAC', service: 'carne_leao', cpf: '52998224725', requestId }, location.origin);
window.postMessage({ type: 'VERIFCO_PING', requestId }, location.origin);
```

A extensão responde `{ type: 'VERIFCO_EXTENSION_ACK', requestId, ok, version, error? }`. Sem resposta
em 1,5 s, o Verifco mostra como instalar. Serviços: `carne_leao`, `meu_irpf`, `cnd`, `fontes_pagadoras`.

A ponte é injetada em `http://localhost/*`, `http://127.0.0.1/*` e `https://*.verifco.com.br/*`
(manifest) e, por registro dinâmico, no endereço informado na Configuração.

### Navegação dentro do eCAC

Um content script roda num “mundo isolado”: trocar `history.pushState`/`replaceState` nele não
enxerga as chamadas da página. Por isso o aviso usa a Navigation API (`currententrychange`), que
avisa dessas mudanças sem mexer em nada da página, além de `hashchange`, `popstate` e de um
observador que recoloca o aviso se a página o remover.
