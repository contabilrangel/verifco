# Sincronizador Verifco

Programa de linha de comando (Node.js + TypeScript via `tsx`, sem outras dependências) que roda no
computador onde o **programa IRPF** é usado. Ele observa as pastas do programa e envia ao Verifco:

- os arquivos das declarações — `.DEC` (declaração), `.REC` (recibo de entrega), `.DBK` (cópia de
  segurança) — e também `.XML` e `.PDF` encontrados nessas pastas → `POST /api/sync/files`;
- os arquivos das pré-preenchidas, se você indicar uma pasta para elas → `POST /api/sync/prefilled`.

Cada arquivo é vinculado ao **cliente pelo CPF** e ao **exercício**, ambos lidos do nome do arquivo
(e, se preciso, da pasta `IRPF<ano>`). No Verifco, o arquivo vira um documento do cliente
(origem “sincronizador”); o `.DEC` passa a ser o arquivo de origem da declaração do ano.

> O conteúdo dos arquivos do programa IRPF **não é lido**: o layout deles não é público. O
> sincronizador só usa o nome, a pasta e o hash do conteúdo.

## Requisitos

- Node.js 22 ou mais novo (<https://nodejs.org>).
- Um token do tipo **Sincronizador**, criado em *Administração › Robô* no Verifco (`vfk_...`).

## Instalação

```bash
# 1. descompacte o .zip da Central de downloads numa pasta fixa e entre nela
npm install

# 2. conecte ao Verifco (endereço onde você abre o Verifco, ou o da API)
npm run config -- --url https://app.seuescritorio.com.br --token vfk_xxxxxxxx
npm run testar

# 3. confira as pastas observadas
npm run pastas

# 4. inicie (varredura inicial + observação contínua)
npm start
```

Comandos:

| Comando | O que faz |
| --- | --- |
| `npm run config -- --url <endereço> --token <vfk_...>` | Grava endereço e token |
| `npm run config -- --pasta "<caminho>"` | Observa mais uma pasta (repita para várias) |
| `npm run config -- --remover-pasta "<caminho>"` | Deixa de observar a pasta |
| `npm run config -- --pasta-pre "<caminho>"` | Pasta das pré-preenchidas (arquivos vão para as pré-preenchidas) |
| `npm run config -- --sem-pastas-padrao` / `--com-pastas-padrao` | Liga/desliga as pastas padrão do programa |
| `npm run pastas` | Lista as pastas consideradas e se existem |
| `npm run testar` | Confere endereço e token |
| `npm run varrer` | Envia o que houver de novo e termina |
| `npm start` | Varre e continua observando (Ctrl+C encerra) |
| `npm run status` | Configuração e últimos envios |

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

Padrão de nomes aceito (o usado pelo programa IRPF nas declarações e recibos):

```
<CPF de 11 dígitos>-IRPF-[letra-]<ano-exercício>[-<ano-calendário>][-ORIGI|-RETIF].<extensão>
ex.: 52998224725-IRPF-A-2026-2025-ORIGI.DEC
```

Também vale um nome que **comece com o CPF** (com ou sem pontuação) seguido de espaço, `-` ou `_`,
por exemplo `529.982.247-25 informe banco 2026.pdf`. O CPF precisa ter dígitos verificadores válidos.

- Ano: o primeiro ano do padrão (exercício); senão, um ano de 4 dígitos depois do CPF; senão, a
  pasta `IRPF<ano>` mais próxima do arquivo.
- Arquivos sem CPF ou sem ano reconhecíveis são **ignorados** e aparecem no log com o motivo.
- CPF de cliente não cadastrado no escritório: aviso no log; o arquivo é tentado de novo na próxima
  varredura (depois de você cadastrar o cliente).

A mesma regra está em `packages/shared/src/ecac.ts` e é repetida pela API ao receber o arquivo.

## Controle de envios e log

Na pasta de dados (`%APPDATA%\VerifcoSync` no Windows, `~/.verifco-sync` no macOS/Linux, ou
`VERIFCO_SYNC_HOME`):

- `config.json` — configuração (o token fica aqui; o arquivo é gravado só para o seu usuário);
- `state.json` — hash SHA-256 de cada conteúdo já enviado. Arquivo alterado = hash novo = novo envio;
  a API também recusa conteúdo repetido;
- `sync.log` — tudo o que foi enviado, ignorado ou falhou.

Erros de conexão ou do servidor são tentados de novo a cada minuto. Token recusado (revogado ou de
outro escopo) encerra o sincronizador com a orientação para gerar outro.

## Iniciar com o computador

- **Windows** — Agendador de Tarefas › Criar tarefa › Disparador “Ao fazer logon” › Ação: programa
  `cmd.exe`, argumentos `/c npm start`, “Iniciar em” = pasta do sincronizador.
- **macOS** — LaunchAgent em `~/Library/LaunchAgents/br.com.verifco.sync.plist` com
  `ProgramArguments` = `/usr/local/bin/npm`, `start` e `WorkingDirectory` = pasta do sincronizador
  (`launchctl load` para ativar).
- **Linux** — serviço de usuário do systemd:

  ```ini
  # ~/.config/systemd/user/verifco-sync.service
  [Service]
  WorkingDirectory=%h/verifco-sincronizador
  ExecStart=/usr/bin/npm start
  Restart=on-failure
  [Install]
  WantedBy=default.target
  ```

  `systemctl --user enable --now verifco-sync`.

## Desenvolvimento

```bash
npm test          # testes do identificador de CPF/ano (node:test via tsx)
npm run typecheck
```

API usada: `GET /api/sync/whoami`, `POST /api/sync/files` (multipart: `file`, `cpf`, `ano`, `tipo`,
`caminho`) e `POST /api/sync/prefilled` (multipart: `file`, `cpf`, `ano`), sempre com
`Authorization: Bearer vfk_...`.
