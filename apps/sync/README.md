# Sincronizador Verifco

Programa de linha de comando (Node.js + TypeScript via `tsx`, sem outras dependências) que roda no
computador onde o **programa IRPF** é usado. Ele observa as pastas do programa e envia ao Verifco:

- os arquivos das declarações — `.DEC` (declaração), `.REC` (recibo de entrega), `.DBK` (cópia de
  segurança) — e também `.XML` e `.PDF` encontrados nessas pastas → `POST /api/sync/files`;
- os arquivos das pré-preenchidas, se você indicar uma pasta para elas → `POST /api/sync/prefilled`;
- o que não pôde ser vinculado a um cliente → caixa de entrada do escritório, `POST /api/sync/inbox`.

Cada arquivo é vinculado ao **cliente pelo CPF** e ao **exercício**, lidos do nome do arquivo (e,
como apoio, do início do conteúdo e da pasta `IRPF<ano>` — veja
[Como o CPF e o ano são identificados](#como-o-cpf-e-o-ano-são-identificados)).

## O que acontece com cada arquivo no Verifco

| Arquivo | No Verifco |
| --- | --- |
| `.DEC` (declaração) | Documento do cliente no exercício (origem “sincronizador”) e **arquivo de origem da declaração** do ano. |
| `.REC` (recibo de entrega) | Documento “recibo” da declaração; marca a declaração como **transmitida** (veja abaixo). |
| `.DBK` (cópia de segurança) | Documento do cliente; vira o arquivo de origem da declaração só se ainda não houver um `.DEC`. |
| `.XML`, `.PDF` | Documento do cliente no exercício. |
| Qualquer um, numa pasta de pré-preenchidas | Pré-preenchida do cliente no exercício. |
| Não identificado, CPF divergente ou cliente não cadastrado | **Caixa de entrada** do escritório, para alguém conferir e vincular. |

Sobre o recibo (`.REC`):

- a **data da transmissão** é o dia (em Brasília) da data de modificação do `.REC`, que o programa
  grava ao transmitir. Uma data já informada no Verifco (no resumo da declaração ou vinda do eCAC)
  não é trocada. Datas no futuro ou anteriores ao ano-exercício são desconsideradas e vale o dia do
  recebimento;
- um recibo com `RETIF` no nome (ex.: `...-2026-2025-RETIF.REC`) marca a declaração como
  **retificadora**; um recibo original não desmarca;
- o recibo fica guardado como documento da declaração e o resumo da declaração mostra o link para
  baixá-lo. O número do recibo continua vindo do eCAC ou da digitação no resumo.

O mesmo conteúdo nunca é gravado duas vezes: o sincronizador controla o que já enviou e a API
reconhece o arquivo repetido.

## Requisitos

- Node.js 22 ou mais novo (<https://nodejs.org>, versão LTS).
- Um token do tipo **Sincronizador**, criado no Verifco em *Meu escritório › Robô* (`vfk_...`).
- Acesso à internet na primeira execução, para baixar a única dependência (`tsx`).

## Instalação no Windows, passo a passo

1. **Instale o Node.js**: baixe o instalador LTS em <https://nodejs.org> e avance até o fim
   (as opções padrão servem).
2. **Baixe o sincronizador** na *Central de downloads* do Verifco e **descompacte** numa pasta
   fixa, por exemplo `C:\Verifco\sincronizador` (a pasta não pode ser apagada nem movida depois).
3. Abra o **Prompt de Comando** nessa pasta: no Explorador de Arquivos, entre na pasta, clique na
   barra de endereço, digite `cmd` e tecle Enter. (No PowerShell, escreva `.\verifco-sync` no
   lugar de `verifco-sync`.)
4. **Configure**:

   ```bat
   verifco-sync configurar
   ```

   Na primeira vez o atalho instala as dependências sozinho (`npm install --omit=dev`). Depois o
   assistente pergunta o endereço do Verifco (o mesmo que você abre no navegador), o token (o que
   você digita ou cola não aparece na tela) e as pastas, e testa a conexão.
5. **Envie o que já existe** (opcional, para ver funcionando):

   ```bat
   verifco-sync varrer
   ```

6. **Deixe iniciando com o Windows**:

   ```bat
   verifco-sync instalar
   ```

   Cria a tarefa agendada “Verifco Sincronizador” (ao fazer logon), que roda sem abrir janela, e já
   inicia o sincronizador em segundo plano. Pode fechar o Prompt de Comando.

Para acompanhar: `verifco-sync status` ou o arquivo `%APPDATA%\VerifcoSync\sync.log`.

### Linux e macOS

```bash
# descompacte numa pasta fixa e, dentro dela:
sh verifco-sync.sh configurar
sh verifco-sync.sh varrer
sh verifco-sync.sh instalar    # mostra o serviço (systemd) ou o LaunchAgent a criar; nada é gravado no sistema
```

Nos exemplos deste arquivo, troque `verifco-sync` por `sh verifco-sync.sh`.

### Sem os atalhos

Os atalhos `verifco-sync.cmd` e `verifco-sync.sh` só conferem o Node, instalam as dependências na
primeira vez e chamam `src/cli.ts`. Dá no mesmo rodar `npm install --omit=dev` uma vez e usar
`npm run <comando> -- <opções>` (ex.: `npm run config -- --pasta "D:\Declaracoes"`, `npm start`).

## Comandos

| Comando | O que faz |
| --- | --- |
| `verifco-sync configurar` | Assistente: endereço, token, pastas e teste de conexão |
| `verifco-sync config <opções>` | Grava opções (tabela abaixo) e mostra a configuração |
| `verifco-sync pastas` | Lista as pastas consideradas e se existem |
| `verifco-sync testar` | Confere endereço, token e versão |
| `verifco-sync varrer` | Envia o que houver de novo e termina |
| `verifco-sync iniciar` | Varre e continua observando (Ctrl+C encerra). É o comando padrão |
| `verifco-sync status` | Configuração, últimos envios e aviso de versão nova |
| `verifco-sync instalar` | Windows: inicia junto com o logon, sem janela. Linux/macOS: mostra como |
| `verifco-sync desinstalar` | Desfaz o `instalar` |
| `verifco-sync versao` | Mostra a versão instalada |

Opções do `config`:

| Opção | O que faz |
| --- | --- |
| `--url <endereço>` | Endereço do Verifco (o do navegador ou o da API) |
| `--token <vfk_...>` | Token do tipo Sincronizador |
| `--pasta "<caminho>"` | Observa mais uma pasta (repita para várias) |
| `--pasta-pre "<caminho>"` | Pasta das pré-preenchidas (os arquivos dela vão para as pré-preenchidas) |
| `--remover-pasta "<caminho>"` | Deixa de observar a pasta |
| `--sem-pastas-padrao` / `--com-pastas-padrao` | Desliga/liga as pastas padrão do programa IRPF |
| `--varredura <min>` | Minutos entre as varreduras completas (padrão 15; `0` desliga) |
| `--sem-caixa-de-entrada` / `--com-caixa-de-entrada` | Desliga/liga o envio à caixa de entrada do escritório |
| `--espera <ms>` | Espera depois da última alteração de um arquivo antes de enviar (padrão 2000) |

`--varredura` e `--sem-caixa-de-entrada` também valem direto no `iniciar` e no `varrer`, só para
aquela execução (ex.: `verifco-sync iniciar --varredura 5`).

## Pastas observadas

Por padrão, as pastas do programa IRPF do **ano atual e do anterior** — só as que existirem:

| Sistema | Candidatas |
| --- | --- |
| Windows | `C:\Arquivos de Programas RFB\IRPF<ano>` e `%USERPROFILE%\ProgramasRFB\IRPF<ano>` |
| macOS e Linux | `~/ProgramasRFB/IRPF<ano>` |

São pontos de partida comuns, não uma garantia: a pasta de instalação pode ter sido escolhida na
instalação do programa. Confira no programa IRPF onde ele grava as declarações e as cópias de
segurança (o caminho aparece ao gravar ou transmitir) e inclua com `--pasta`. Subpastas entram.
A cada 10 minutos o sincronizador procura de novo pastas que passaram a existir (ex.: o programa do
novo exercício instalado depois).

## Como o CPF e o ano são identificados

**1. Pelo nome do arquivo** (sempre a primeira fonte). Padrão do programa IRPF:

```
<CPF de 11 dígitos>-IRPF-[letra-]<ano-exercício>[-<ano-calendário>][-ORIGI|-RETIF].<extensão>
ex.: 52998224725-IRPF-A-2026-2025-ORIGI.DEC
```

Também vale um nome que **comece com o CPF** (com ou sem pontuação) seguido de espaço, `-` ou `_`,
por exemplo `529.982.247-25 informe banco 2026.pdf`. O CPF precisa ter dígitos verificadores válidos.

**2. Pelo início do conteúdo**, só como apoio e conferência. O layout dos arquivos do programa IRPF
**não é publicado oficialmente**; por isso o sincronizador lê apenas os primeiros 300 bytes e só
considera o que encontra quando a primeira linha começa com `IRPF`, quatro espaços, o
ano-exercício e o ano-calendário (que tem de ser o exercício menos 1). Nesse caso:

- o **ano** do cabeçalho vale quando o nome não traz o ano (antes da pasta `IRPF<ano>`);
- um **CPF** do cabeçalho só é aceito com dígitos verificadores válidos e apenas para confirmar o
  CPF do nome ou, se o nome não tem CPF (arquivo renomeado), quando está na posição esperada e é o
  único CPF possível em toda a primeira linha;
- se o nome traz um CPF e o cabeçalho traz **outro**, o arquivo **não é enviado a nenhum cliente**:
  vai para a caixa de entrada e a divergência fica no log.

Arquivos sem esse cabeçalho (PDF, XML, outros formatos) seguem só pelo nome e pela pasta.

**3. Pela pasta**: sem ano no nome nem no cabeçalho, vale a pasta `IRPF<ano>` mais próxima do arquivo.

A regra do nome é a mesma de `packages/shared/src/ecac.ts`, repetida pela API ao receber o arquivo.

## Caixa de entrada do escritório

O que o sincronizador não consegue entregar a um cliente não fica mais só no log deste computador:
vai para a caixa de entrada do Verifco, onde o escritório vê o arquivo, o caminho original e o motivo.

| Situação | Motivo enviado |
| --- | --- |
| `.DEC`, `.REC` ou `.DBK` sem CPF ou sem ano reconhecíveis | `sem_cpf` |
| Arquivo com CPF no nome, mas sem ano identificável | `sem_cpf` (com o CPF) |
| Qualquer arquivo não identificado numa pasta de pré-preenchidas | `sem_cpf` |
| CPF do nome diferente do CPF do conteúdo | `sem_cpf` (sem CPF) |
| CPF de cliente que ainda não está cadastrado | `cliente_nao_cadastrado` (com CPF e ano) |

- Cada conteúdo vai **uma vez só** para a caixa de entrada.
- `.PDF` e `.XML` sem CPF no nome, fora de uma pasta de pré-preenchidas, **não** vão: as pastas do
  programa IRPF trazem muitos arquivos do próprio programa (ajuda, tabelas). Eles aparecem no log
  como “ignorado”.
- Cliente não cadastrado: além da caixa de entrada, o envio ao cliente é tentado de novo sozinho
  (15 min, 30 min, 1 h, depois a cada 2 h). Basta cadastrar o cliente.
- Servidor do Verifco em versão anterior, sem a caixa de entrada: esses arquivos ficam só no log,
  como antes, e o sincronizador volta a tentar depois da próxima conferência de versão (a cada 6 h).
- Para desligar: `verifco-sync config --sem-caixa-de-entrada`.

## Funcionamento contínuo (`iniciar`)

- **Sem rede ao ligar o computador**: o sincronizador não desiste. Tenta conectar de novo em 5 s,
  10 s, 20 s… até uma tentativa a cada 5 minutos, para sempre.
- **Observação das pastas**: cada arquivo novo ou alterado é enviado alguns segundos depois da
  última gravação. Se o observador de uma pasta falhar (unidade de rede que caiu, pasta renomeada),
  ele é armado de novo sozinho (30 s, 1 min… até 5 min) e a pasta é varrida ao voltar.
- **Varredura periódica**: a cada 15 minutos (`--varredura`) todas as pastas são conferidas de
  novo, para pegar o que o observador perdeu e o que passou a poder ser enviado.
- **Novas tentativas**: erro de conexão ou do servidor → 1 min, 2, 4, 8, depois a cada 15 min.
  Arquivo recusado pela API ou cliente não cadastrado → 15 min, 30 min, 1 h, depois a cada 2 h.
  Um arquivo regravado com outro conteúdo é tentado na hora.
- **Token recusado** (revogado ou de outro escopo): é o único erro definitivo; o sincronizador
  encerra com a orientação para gerar outro token.

## Pasta de dados, controle de envios e log

Na pasta de dados (`%APPDATA%\VerifcoSync` no Windows, `~/.verifco-sync` no macOS/Linux, ou
`VERIFCO_SYNC_HOME`):

- `config.json` — configuração (o token fica aqui; o arquivo é gravado só para o seu usuário);
- `state.json` — o que já foi enviado, por **hash SHA-256 do conteúdo + destino** (documentos do
  cliente, pré-preenchidas ou caixa de entrada). Arquivo alterado = hash novo = novo envio; o mesmo
  arquivo copiado depois para a pasta das pré-preenchidas é enviado também para lá. O arquivo da
  versão 0.2 (só o hash) é convertido sozinho na primeira execução;
- `sync.log` — tudo o que foi enviado, ignorado ou falhou. Ao passar de 5 MB vira `sync.log.1`
  (ficam os três anteriores: `.1`, `.2` e `.3`).

## Iniciar com o computador

**Windows** — `verifco-sync instalar`:

- grava `verifco-sync-oculto.vbs` na pasta de dados (ele chama o `verifco-sync.cmd iniciar` sem
  abrir janela) e cria a tarefa agendada com
  `schtasks /Create /SC ONLOGON /TN "Verifco Sincronizador" /TR "wscript.exe ...vbs" /F`;
- se o Windows não deixar criar a tarefa (em alguns computadores o disparador de logon exige o
  Prompt de Comando aberto como administrador), o mesmo `.vbs` é copiado para a pasta
  *Inicializar* do seu usuário, com o mesmo efeito;
- tenta desmarcar, na tarefa, “iniciar somente se o computador estiver ligado à rede elétrica”
  (padrão do Windows que impede o início em notebooks na bateria);
- `verifco-sync desinstalar` remove a tarefa, o atalho e o `.vbs`. O sincronizador que já estiver
  rodando segue até você sair do Windows.

Rode `instalar` de novo se mover a pasta do sincronizador.

**Linux** — `sh verifco-sync.sh instalar` mostra o serviço de usuário a gravar em
`~/.config/systemd/user/verifco-sync.service`; ative com
`systemctl --user daemon-reload && systemctl --user enable --now verifco-sync`.

**macOS** — `sh verifco-sync.sh instalar` mostra o LaunchAgent a gravar em
`~/Library/LaunchAgents/br.com.verifco.sync.plist`; ative com `launchctl load <arquivo>`.

## Atualização

O sincronizador informa a própria versão ao Verifco em todo pedido e avisa quando há versão nova:
no `testar`, no `status`, ao `iniciar` e, com ele rodando, uma vez por dia no `sync.log`. Se a
versão instalada **não for mais aceita**, o aviso diz isso com todas as letras — atualize logo,
porque os envios podem estar sendo recusados.

Para atualizar:

1. baixe o pacote novo na **Central de downloads** do Verifco;
2. descompacte **por cima** da pasta atual, substituindo os arquivos (a configuração e o controle
   de envios ficam na pasta de dados, fora dela);
3. confira com `verifco-sync versao` e `verifco-sync testar`;
4. reinicie o sincronizador: saia e entre de novo no Windows (ou encerre “Node.js” no Gerenciador
   de Tarefas e rode `verifco-sync instalar`).

Se o pacote novo pedir dependências diferentes, apague a pasta `node_modules` antes do passo 3: o
atalho instala tudo de novo.

## Solução de problemas

| Sintoma | O que fazer |
| --- | --- |
| `Node.js nao encontrado` | Instale o Node.js 22+ e abra um Prompt de Comando **novo** (o antigo não enxerga a instalação). |
| `Nao foi possivel instalar as dependencias` | Confira a internet (ou o proxy da rede) e rode `npm install --omit=dev` na pasta do sincronizador. |
| `Sem conexão com ...` | Confira o endereço (`verifco-sync config --url ...`) e se o Verifco abre no navegador deste computador. O `iniciar` continua tentando sozinho. |
| `Token recusado` | O token foi revogado ou não é do tipo Sincronizador. Crie outro em *Meu escritório › Robô* e rode `verifco-sync config --token vfk_...`. |
| `Nenhuma pasta existe neste computador` | Descubra onde o programa IRPF grava e inclua: `verifco-sync config --pasta "<caminho>"`. |
| `...: ignorado (CPF não identificado no nome do arquivo)` | PDF/XML sem CPF no nome. Renomeie começando pelo CPF (ex.: `52998224725 informe 2026.pdf`). |
| `Cliente com CPF/CNPJ ... não encontrado` | Cadastre o cliente no Verifco; o arquivo já está na caixa de entrada e o envio se repete sozinho. |
| `o CPF do nome (...) é diferente do CPF do conteúdo (...)` | O arquivo foi renomeado com o CPF de outra pessoa. Ele está na caixa de entrada; confira e vincule ao cliente certo no Verifco. |
| `Este Verifco ainda não tem a caixa de entrada` | O servidor está numa versão anterior; nada a fazer neste computador. |
| O sincronizador não inicia com o Windows | Rode `verifco-sync instalar` de novo e veja a mensagem. Em notebook, confira no Agendador de Tarefas › Verifco Sincronizador › Condições se “ligado à rede elétrica” está desmarcado. Veja o fim do `sync.log`. |
| Quero ver se está rodando | Gerenciador de Tarefas › Detalhes › `node.exe`, ou as últimas linhas do `sync.log`. |
| Rodou duas vezes ao mesmo tempo | Não há dano (a API reconhece o repetido), mas encerre uma das duas. |
| Recomeçar do zero | Apague `state.json` na pasta de dados: tudo é conferido de novo e a API descarta o que já tem. |

## Versões

A versão está no `package.json`. A API continua aceitando as versões anteriores enquanto o aviso de
“não é mais aceita” não aparecer.

- **0.3.0**
  - atalhos `verifco-sync.cmd` / `verifco-sync.sh`, assistente `configurar`, `instalar` /
    `desinstalar` (tarefa de logon no Windows, sem janela);
  - ao iniciar sem rede, insiste até conectar; varredura periódica (`--varredura`); novas tentativas
    com espera crescente, inclusive para cliente não cadastrado e arquivo recusado; o observador de
    pastas é rearmado depois de um erro;
  - caixa de entrada do escritório para o que não foi identificado ou é de cliente não cadastrado
    (`--sem-caixa-de-entrada` desliga);
  - leitura conservadora do início do conteúdo para confirmar o CPF e achar o ano;
  - controle de envios por conteúdo + destino (o mesmo arquivo pode ir também para as
    pré-preenchidas); `state.json` antigo é convertido sozinho;
  - envia a versão em `X-Verifco-Client` e avisa quando há atualização; `sync.log` com rotação.
- **0.2.0** — envia a data de modificação do arquivo (`modificadoEm`); no `.REC`, ela vira a data
  da transmissão da declaração.
- **0.1.0** — primeira versão.

## Desenvolvimento

```bash
npm test          # node:test via tsx — todos os arquivos de test/
npm run typecheck # precisa das dependências de desenvolvimento (npm install, sem --omit=dev)
```

O pacote é distribuído como um .zip desta pasta e funciona sozinho, fora do monorepo: a única
dependência de execução é o `tsx`, e nada é importado de outros pacotes do repositório.

API usada, sempre com `Authorization: Bearer vfk_...` e `X-Verifco-Client: sync/<versão> (<sistema>)`:

- `GET /api/sync/whoami` — escritório, token e, em servidores novos,
  `client: { latest, minSupported, updateAvailable, unsupported }`;
- `POST /api/sync/files` — multipart: `file`, `cpf`, `ano`, `tipo`, `caminho`, `modificadoEm` (data
  de modificação do arquivo em ISO 8601);
- `POST /api/sync/prefilled` — multipart: `file`, `cpf`, `ano`, `caminho`;
- `POST /api/sync/inbox` — multipart: `file`, `caminho`, `motivo` (`sem_cpf` |
  `cliente_nao_cadastrado`) e, quando conhecidos, `cpf` e `ano`; responde `{ id, duplicate }`.
  Servidores anteriores respondem 404/405.
