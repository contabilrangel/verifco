# Backup e restauração

Este guia descreve o backup automático dos dois bancos PostgreSQL e dos arquivos enviados
(volume `uploads`), como ativá-lo no Dokploy e como restaurar tudo em uma VM nova. O que já
está instalado em produção está no [inventário](INVENTARIO-DOKPLOY.md); a instalação da
aplicação, em [DOKPLOY.md](DOKPLOY.md).

O repositório entrega a ferramenta. Ela **só protege a produção depois** que o operador
cria o bucket, gera o par de chaves, ativa o perfil `backup` e faz um ensaio de restauração
com resultado registrado.

## Arquitetura

```mermaid
flowchart LR
  E["PostgreSQL escritórios"] -->|pg_dump -Fc| B["backup"]
  P["PostgreSQL plataforma"] -->|pg_dump -Fc| B
  U["volume uploads (só leitura)"] -->|tar.gz| B
  B -->|"age (chave pública)"| C["partes cifradas + manifest.json"]
  C -->|rclone| S["bucket S3 fora da VM"]
  K["chave privada age, fora da VM"] -.->|só na restauração| R["restore.sh"]
  S --> R
```

O serviço `backup` existe nos dois Composes sob o perfil `backup`; sem o perfil ele não é
criado e nada muda na implantação. A imagem (`deploy/backup.Dockerfile`) parte da mesma
`postgres:16-bookworm` dos bancos, para o `pg_dump` e o `pg_restore` terem a versão do
servidor, e acrescenta `age`, `rclone` e os scripts `deploy/backup.sh` e `deploy/restore.sh`.

| Item | Como funciona |
| --- | --- |
| Agenda | Todos os dias às `BACKUP_SCHEDULE_HOUR` (padrão 03h, `America/Sao_Paulo`). Na primeira subida, ou se o último backup concluído tem mais de 24 h, roda na hora. Falhou: tenta de novo a cada 60 min |
| Bancos | `pg_dump -Fc` de `DATABASE_URL` e `PLATFORM_DATABASE_URL`, as mesmas variáveis da aplicação. Cada dump é uma fotografia consistente do banco, feita com a aplicação no ar |
| Arquivos | `tar.gz` de `/app/storage`, montado só para leitura, feito depois dos dumps: o que os bancos citam já está no disco. **Com `STORAGE_DRIVER=s3` os arquivos não estão nesse volume, e sim no bucket da aplicação (`S3_BUCKET`): o backup cobre só os bancos.** Nesse caso ative o versionamento do bucket (e, se possível, a replicação para outra região ou serviço), porque é ele que protege os arquivos; na restauração, aponte a aplicação para o mesmo bucket |
| Cifragem | Cada parte é cifrada com `age` para a chave pública `BACKUP_AGE_RECIPIENT` antes de sair do container. A VM nunca guarda a chave privada. Sem chave pública o backup **recusa rodar**; `BACKUP_ENCRYPTION=off` grava em claro e só deve ser usado em testes |
| Destino | Bucket compatível com S3 (`BACKUP_S3_*`) e/ou pasta local (`BACKUP_LOCAL_DIR`). As partes sobem primeiro e o manifesto por último; pasta sem manifesto é envio incompleto e nunca conta como backup |
| Manifesto | `manifest.json`, em claro: identificador, data, commit (`APP_COMMIT`, se informado), versão do `pg_dump` e, de cada parte, tamanho e sha256 |
| Retenção | Apaga do destino os backups com mais de `BACKUP_RETENTION_DAYS` (30), mantendo sempre os `BACKUP_KEEP_MIN` (7) mais novos, mesmo vencidos. Envios incompletos saem depois de 24 h. Só toca em pastas com nome de backup |
| Saúde | O container fica `unhealthy` quando o último backup concluído tem mais de 36 h. O registro fica no volume `backup-state` e sobrevive a novos deploys |

Um backup é uma pasta `AAAAMMDDTHHMMSSZ` (horário UTC) dentro de `BACKUP_S3_PREFIX`:

```text
verifco/20261111T060000Z/
  database.dump.age      banco dos escritórios
  platform.dump.age      banco da plataforma
  storage.tar.gz.age     arquivos do volume uploads
  manifest.json          tamanhos e sha256 das partes
```

Senhas, URLs de conexão e chaves nunca são impressas: a saída dos clientes passa por um
filtro e as conexões vão para o `pg_dump` por variáveis de ambiente, não pela linha de comando.

## Preparação, uma única vez

### 1. Par de chaves age

Gere o par **fora da VM**, no computador do responsável, com o
[age](https://github.com/FiloSottile/age) instalado (`apt install age`, `brew install age`
ou os binários da página do projeto):

```sh
age-keygen -o verifco-backup.key
# Public key: age1...   <- este valor vai para BACKUP_AGE_RECIPIENT
```

- A **chave pública** (`age1...`) vai para o ambiente do Dokploy. Ela só cifra; quem a
  conhece não abre nenhum backup.
- O **arquivo `verifco-backup.key`** é a chave privada. Guarde em um cofre de senhas da
  empresa e em uma segunda cópia desconectada (mídia cifrada ou impressão em local
  seguro), acessível a pelo menos duas pessoas. Nunca na VM, no ambiente do Dokploy, no
  Git, em e-mail ou no mesmo bucket dos backups.
- **Sem a chave privada os backups não podem ser abertos por ninguém.** Antes de confiar
  nela, faça o `restore.sh --check` da seção [Conferir sem restaurar](#conferir-sem-restaurar).
- Duas chaves públicas separadas por vírgula em `BACKUP_AGE_RECIPIENT` cifram para dois
  pares; qualquer uma das privadas abre (titular e contingência).
- Chave privada perdida: gere outro par e troque `BACKUP_AGE_RECIPIENT`; os backups
  antigos ficam irrecuperáveis. Chave privada exposta: gere outro par, troque a variável e
  apague do bucket os backups cifrados para a chave antiga depois que houver novos.

Guarde no mesmo cofre, separados deste documento, os outros itens sem os quais a
restauração não funciona:

- `ENCRYPTION_KEY` da aplicação. Os dumps trazem as credenciais das integrações cifradas
  com ela; com outra chave, o banco restaura e esses segredos ficam ilegíveis.
- `JWT_SECRET` e uma cópia do **Environment** do serviço Compose no Dokploy.
- As credenciais do bucket de backup.

### 2. Bucket

Lista de conferência para o bucket, em qualquer serviço compatível com S3:

- [ ] Fora desta VM e, de preferência, em outro provedor ou outra conta.
- [ ] Privado, sem acesso público nem listagem anônima.
- [ ] Região compatível com a política de dados do escritório (LGPD); o conteúdo já chega cifrado.
- [ ] Chave de acesso exclusiva do backup, restrita a este bucket: listar, ler, gravar e
      apagar. Não reutilize a chave de `STORAGE_DRIVER=s3` nem a de outro sistema.
- [ ] Versionamento ou bloqueio de objetos (object lock), se o serviço oferecer: protege
      contra exclusão por quem obtiver a chave da VM. Com bloqueio, use
      `BACKUP_RETENTION_DAYS=0` e deixe a retenção com uma regra de ciclo de vida do bucket.
- [ ] Regra de ciclo de vida para abortar envios multipart incompletos.
- [ ] Endpoint, região, nome do bucket e prefixo anotados no inventário (sem as chaves).

### 3. Ambiente no Dokploy

No **Environment** do serviço Compose (vale para `compose.dokploy-managed.yml` e para
`compose.dokploy.yml`; os modelos comentados estão em `deploy/dokploy-managed.env.example`
e `deploy/dokploy.env.example`):

```dotenv
COMPOSE_PROFILES=backup
BACKUP_AGE_RECIPIENT=age1...
BACKUP_S3_ENDPOINT=https://ENDPOINT_DO_SERVICO
BACKUP_S3_REGION=REGIAO
BACKUP_S3_BUCKET=NOME_DO_BUCKET
BACKUP_S3_PREFIX=verifco
BACKUP_S3_ACCESS_KEY_ID=VALOR_PROTEGIDO
BACKUP_S3_SECRET_ACCESS_KEY=VALOR_PROTEGIDO
```

| Variável | Padrão | Uso |
| --- | --- | --- |
| `COMPOSE_PROFILES` | vazio | `backup` cria o serviço. Retirar a variável e fazer Deploy remove o container; os backups já enviados continuam no bucket |
| `BACKUP_AGE_RECIPIENT` | — | Chave pública age; obrigatória |
| `BACKUP_ENCRYPTION` | `age` | `off` grava sem cifrar. Não use em produção |
| `BACKUP_S3_ENDPOINT` | vazio | Endereço do serviço; vazio usa a AWS |
| `BACKUP_S3_REGION` | vazio | Região exigida pelo serviço (`auto` no Cloudflare R2) |
| `BACKUP_S3_BUCKET` | — | Só o nome do bucket |
| `BACKUP_S3_PREFIX` | `verifco` | Pasta dentro do bucket |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | — | Chave exclusiva do backup |
| `BACKUP_S3_FORCE_PATH_STYLE` | `true` | `false` para serviços que exigem `bucket.endpoint` |
| `BACKUP_LOCAL_DIR` | vazio | `/backups` grava no volume `backup-local`, **na mesma VM**: serve para a primeira configuração e para testes, não como proteção. Pode ser usado junto com o bucket |
| `BACKUP_RETENTION_DAYS` | `30` | `0` não apaga nada |
| `BACKUP_KEEP_MIN` | `7` | Quantos backups mais novos nunca são apagados |
| `BACKUP_SCHEDULE_HOUR` | `03` | Hora do backup diário, de 0 a 23 |
| `BACKUP_TZ` | `America/Sao_Paulo` | Fuso da agenda |
| `BACKUP_INCLUDE_STORAGE` | `true` | `false` deixa o volume `uploads` de fora (com `STORAGE_DRIVER=s3`) |
| `APP_COMMIT` | vazio | Commit implantado, gravado no manifesto |

Não confunda com `RETENTION_BACKUPS_DAYS`, da aplicação: esse é o prazo de download dos
`.zip` de backup que cada escritório gera pelo sistema.

Salve e clique **Deploy**. O `docker compose` lê `COMPOSE_PROFILES` do ambiente gravado
pelo Dokploy e passa a criar o container `backup`. Na variante gerenciada ele entra na
`dokploy-network`, onde estão os bancos; na variante com bancos no Compose, na rede
`backend`. Em ambas monta o volume `uploads` só para leitura.

> A ativação pelo `COMPOSE_PROFILES` foi conferida com o `docker compose`, não na
> instalação real do Dokploy. Depois do Deploy, confirme em **Preview Compose** e na lista
> de containers que o `backup` existe. Se não existir, a sua versão do Dokploy não repassa
> essa variável ao `docker compose`: acrescente `--profile backup` ao comando do Compose,
> se o serviço permitir personalizá-lo, e registre no inventário como foi ativado.

### 4. Primeiro backup

O container faz o primeiro backup assim que sobe. Nos logs do `backup`, a linha final de
um backup concluído é:

```text
[verifco-backup] OK id=20261111T060000Z partes=3 tamanho="1.2 GiB" cifragem=age destinos=s3 removidos=0 duracao=95s
```

Qualquer falha termina com `ERRO:` e o motivo, e o container tenta de novo em 60 minutos.
No **Docker Terminal** do container `backup`:

```sh
restore.sh --list     # backups completos no destino
backup.sh health      # idade do último backup concluído
backup.sh now         # backup avulso, por exemplo antes de um Deploy
```

Em seguida, faça a conferência com a chave privada, fora da VM, e o
[ensaio de restauração](#ensaio-de-restauração). Atualize o inventário com o destino, a
agenda e a data do primeiro backup conferido.

Espaço em disco: durante o backup, as partes cifradas ficam em `/tmp` do container até o
envio terminar. Reserve na VM pelo menos o tamanho de um backup completo.

## Conferir sem restaurar

`restore.sh --check` baixa o backup, confere tamanho e sha256 de cada parte contra o
manifesto, decifra tudo, valida os dois dumps com o `pg_restore` (lendo todos os dados) e
lista o `tar` dos arquivos. Não grava em banco nenhum. Precisa da chave privada; por
isso roda em uma máquina de confiança com Docker, **não na VM de produção**:

```sh
git clone https://github.com/contabilrangel/verifco.git && cd verifco
docker build -t verifco-backup -f deploy/backup.Dockerfile deploy

# restauracao.env e a chave privada em pasta temporária na memória; apague ao terminar
cat > /dev/shm/restauracao.env << 'EOF'
BACKUP_S3_ENDPOINT=https://ENDPOINT_DO_SERVICO
BACKUP_S3_REGION=REGIAO
BACKUP_S3_BUCKET=NOME_DO_BUCKET
BACKUP_S3_PREFIX=verifco
BACKUP_S3_ACCESS_KEY_ID=VALOR_PROTEGIDO
BACKUP_S3_SECRET_ACCESS_KEY=VALOR_PROTEGIDO
BACKUP_AGE_IDENTITY_FILE=/run/verifco/age.key
EOF

docker run --rm --user 0:0 --env-file /dev/shm/restauracao.env \
  -v /dev/shm/verifco-backup.key:/run/verifco/age.key:ro \
  verifco-backup restore.sh --check latest
```

`latest` é o backup completo mais novo; no lugar dele vale um identificador de
`restore.sh --list` ou o caminho de uma pasta já baixada (com `manifest.json` e as
partes), que dispensa as variáveis do bucket. O resultado esperado termina com
`OK verificado id=...`. Use `--user 0:0` nos comandos de restauração: o usuário padrão da
imagem (UID 1000) pode não ter leitura da chave nem escrita em um volume novo.

## Roteiro de restauração

Cenário: a VM foi perdida ou os dados foram corrompidos, e a aplicação volta em uma VM
nova a partir do backup. Perde-se o que foi gravado depois do backup escolhido. Anote a
hora de início: o tempo total é o que o ensaio mede.

Regra central: os bancos são restaurados **vazios**, antes de a aplicação gravar neles.
Restaurar por cima de um banco que a aplicação já migrou deixaria o histórico de migrações
do backup junto com tabelas mais novas, e a API falharia ao iniciar.

**Tenha em mãos:** a chave privada age; as credenciais do bucket; `ENCRYPTION_KEY`,
`JWT_SECRET` e a cópia do Environment; acesso ao repositório e ao DNS.

1. **VM e Dokploy.** Instale o Dokploy em uma VM nova. Não aponte o DNS ainda.
2. **Instalação vazia.** Siga [DOKPLOY.md](DOKPLOY.md) até a aplicação ficar saudável: os
   dois bancos (serviços do Dokploy na variante gerenciada), o serviço Compose com o
   Environment guardado e as duas URLs internas **novas**. Use a `ENCRYPTION_KEY`
   original. **Não** crie o proprietário e **não** ative o perfil `backup` ainda. Este
   passo valida a infraestrutura e cria o volume `uploads`.
3. **Pare a aplicação.** Pare o serviço Compose no Dokploy (ou `docker stop` nos
   containers `api`, `worker` e `web`). Os bancos continuam no ar.
4. **Esvazie os dois bancos**, que agora têm só as tabelas recém-criadas. No terminal de
   cada container PostgreSQL:

   ```sh
   # banco dos escritórios
   dropdb -U verifco --force verifco && createdb -U verifco verifco
   # banco da plataforma
   dropdb -U verifco_platform --force verifco_platform && createdb -U verifco_platform verifco_platform
   ```

5. **Chave e imagem na VM.** Por SSH, clone o repositório, construa a imagem e coloque a
   chave privada e o arquivo de variáveis em `/dev/shm` (memória, não disco):

   ```sh
   git clone https://github.com/contabilrangel/verifco.git && cd verifco
   docker build -t verifco-backup -f deploy/backup.Dockerfile deploy
   ```

   Ao `restauracao.env` da seção anterior, acrescente os destinos. As URLs são as mesmas
   `DATABASE_URL` e `PLATFORM_DATABASE_URL` novas do Environment:

   ```dotenv
   TARGET_DATABASE_URL=postgres://verifco:SENHA@HOST_INTERNO_ESCRITORIOS:5432/verifco
   TARGET_PLATFORM_DATABASE_URL=postgres://verifco_platform:OUTRA_SENHA@HOST_INTERNO_PLATAFORMA:5432/verifco_platform
   TARGET_STORAGE_DIR=/restore/storage
   ```

6. **Restaure.** Escolha o backup com `restore.sh --list` (mesmo comando do `--check`) e rode:

   ```sh
   docker run --rm --user 0:0 --network dokploy-network \
     --env-file /dev/shm/restauracao.env \
     -v /dev/shm/verifco-backup.key:/run/verifco/age.key:ro \
     -v APP_NAME_uploads:/restore/storage \
     verifco-backup restore.sh 20261111T060000Z
   ```

   - `APP_NAME_uploads` é o volume da instalação nova (`docker volume ls`), por exemplo
     `verifco-verifco-completo-xxxxxx_uploads`.
   - Na variante com bancos no Compose, a rede é `APP_NAME_backend` e os hosts das URLs
     são `postgres` e `postgres-platform`.
   - O script confere os sha256, recusa banco de destino com dados e restaura cada banco
     em uma transação: se falhar, o destino fica como estava. Como root, os arquivos
     voltam com o dono original (UID 1000, o usuário da API).
   - Se o volume `uploads` não estiver vazio, a restauração para antes de gravar. Confira
     o conteúdo e repita com `--force`, que extrai por cima; os bancos devem estar vazios.
   - Só o que tem destino definido é restaurado; o resumo final avisa o que ficou de fora.

   O resultado esperado termina com `OK restaurado id=...`, com o número de tabelas e de
   registros de `offices` e `platform_users`.
7. **Apague a chave da VM.** `rm /dev/shm/verifco-backup.key /dev/shm/restauracao.env`.
8. **Deploy.** Clique **Deploy** no serviço Compose. A API aplica as migrações mais novas
   que o backup, se houver, e o worker retoma a fila como estava no momento do backup.
9. **Conferências.**
   - API e worker saudáveis; `GET /ready` responde 200 com `database` e `platform` verdadeiros.
   - Banco dos escritórios com `offices` e sem `platform_users`; banco da plataforma, o inverso.
   - Login de um contador em `/entrar` e do proprietário em `/sistema`, com as senhas de antes.
   - Abrir um cliente e baixar um documento antigo (prova que os arquivos voltaram).
   - Abrir **Integrações** de um escritório e testar uma conexão (prova que a
     `ENCRYPTION_KEY` lê as credenciais cifradas).
10. **Domínios.** Cadastre os três domínios, aponte o DNS e confira o HTTPS.
11. **Backups de novo.** Ative o perfil `backup` na instalação nova (seção
    [Ambiente no Dokploy](#3-ambiente-no-dokploy)) e confira o primeiro backup.
12. **Registro.** Atualize o [inventário](INVENTARIO-DOKPLOY.md) com os novos IDs, hosts,
    volumes e a data da restauração.

Restaurar **por cima da produção em uso** (voltar a um backup na mesma instalação) segue
os passos 3 a 9. Se o comando for dado pelo serviço do Compose, que já tem `DATABASE_URL`
no ambiente, o script recusa destinos iguais aos bancos em uso; `--i-know-this-is-production`
libera, e `--force` continua necessário se o banco não foi esvaziado.

## Ensaio de restauração

Um backup só vale depois de restaurado. Faça o ensaio logo após ativar o backup, depois
de mudanças grandes de infraestrutura e ao menos a cada seis meses.

O ensaio roda o roteiro em uma máquina descartável com Docker, fora da produção, com o
`compose.dokploy.yml` (bancos dentro do Compose) e sem o Dokploy:

```sh
git clone https://github.com/contabilrangel/verifco.git && cd verifco
cp deploy/dokploy.env.example ensaio.env
# ensaio.env: APP_URL=http://localhost:8080, CORS_ORIGINS=http://localhost:8080, TRUST_PROXY=1,
# senhas novas para os dois bancos (e as mesmas nas duas URLs), JWT_SECRET novo, SMTP_URL vazio
# e a ENCRYPTION_KEY de produção
ensaio() { docker compose -p verifco-ensaio --env-file ensaio.env -f compose.dokploy.yml -f deploy/compose.ensaio.yml "$@"; }

ensaio up -d --build --wait api web          # passo 2: instalação vazia, SEM o worker
ensaio stop api web                          # passo 3
ensaio exec postgres sh -c 'dropdb -U verifco --force verifco && createdb -U verifco verifco'
ensaio exec postgres-platform sh -c 'dropdb -U verifco_platform --force verifco_platform && createdb -U verifco_platform verifco_platform'
# passos 5 e 6: rede verifco-ensaio_backend, volume verifco-ensaio_uploads,
# hosts postgres e postgres-platform nas URLs de destino
ensaio up -d --wait api web                  # passo 8
```

A aplicação fica em `http://localhost:8080`. No fim: `ensaio down -v`, e apague
`ensaio.env`, a chave e as imagens da máquina.

**Não suba o `worker` no ensaio.** O banco restaurado traz a fila real, com e-mails,
WhatsApp, cobranças e sincronizações pendentes, e as credenciais das integrações voltam a
funcionar com a `ENCRYPTION_KEY`: o worker enviaria mensagens e cobranças verdadeiras.
Pelo mesmo motivo, não dispare envios pela interface durante o ensaio, e trate a máquina
como produção enquanto os dados estiverem nela (LGPD).

Lista do ensaio:

- [ ] Backup escolhido com `restore.sh --list` e conferido com `restore.sh --check`.
- [ ] Bancos restaurados em bancos vazios, sem `--force`.
- [ ] Arquivos restaurados; contagem igual à do manifesto.
- [ ] API saudável (`/ready` 200) depois da restauração.
- [ ] Login de contador e do proprietário da plataforma.
- [ ] Cliente, declaração e documento antigo abertos; download de um arquivo.
- [ ] Credencial cifrada de uma integração lida (teste de conexão).
- [ ] Ambiente do ensaio destruído e chave privada apagada da máquina.

Registre cada ensaio (no inventário ou no controle interno do escritório):

| Campo | Valor |
| --- | --- |
| Data do ensaio | |
| Responsável | |
| Identificador do backup (`id`) | |
| Data e commit do backup (manifesto) | |
| Idade do backup no início (perda máxima de dados) | |
| Tamanho total do backup | |
| Tempo de download e conferência | |
| Tempo total até o login funcionar (tempo de recuperação) | |
| Resultado (aprovado, aprovado com ressalvas, reprovado) | |
| Problemas encontrados e correções | |
| Próximo ensaio previsto | |

## O que não está coberto

- **Dados entre um backup e outro.** São fotografias diárias, sem recuperação a um
  instante qualquer (PITR). A perda máxima é o intervalo desde o último backup concluído:
  até um dia em operação normal, mais se houver falhas seguidas.
- **Alertas.** O healthcheck só muda o estado do container para `unhealthy`. Ninguém é
  avisado; é preciso olhar o Dokploy ou criar um monitoramento externo.
- **Chaves e configuração.** A chave privada age, `ENCRYPTION_KEY`, `JWT_SECRET`, o
  Environment e a configuração do próprio Dokploy (projetos, domínios, certificados) não
  estão no backup. Os certificados são reemitidos pelo Let's Encrypt.
- **Arquivos com `STORAGE_DRIVER=s3`.** Nesse modo os arquivos ficam no bucket da
  aplicação, que o backup não copia; proteja-o com versionamento ou replicação.
- **Volumes antigos.** `database` e `platform-database`, reservas da migração para os
  bancos gerenciados, não entram no backup.
- **Sincronia exata entre bancos e arquivos.** Os dois dumps e o `tar` são feitos em
  sequência, com a aplicação no ar. Um arquivo apagado ou gravado durante o backup pode
  divergir do banco por segundos.
- **Sistemas externos.** Asaas, Omie, WhatsApp e e-CAC não voltam no tempo. Depois de uma
  restauração, tarefas que estavam pendentes na fila no momento do backup são executadas
  de novo, e o que foi feito depois dele não está no banco.
- **Autenticidade.** O sha256 do manifesto detecta corrupção, não adulteração: quem puder
  gravar no bucket pode trocar um backup inteiro. A proteção é a chave de acesso restrita
  e o versionamento ou bloqueio de objetos.
- **Computadores dos contadores.** Extensão, sincronizador e arquivos locais do IRPF.
- **Backups nativos do Dokploy.** Continuam disponíveis nos serviços PostgreSQL e no
  Compose, independentes deste serviço, e não são descritos aqui.

## Verificação automatizada

- `bash deploy/test/backup-lib.test.sh`: retenção, agenda, URLs de conexão e mascaramento
  de segredos, só com Bash.
- `bash deploy/test/backup-e2e.test.sh`: backup, conferência, restauração e recusas contra
  um PostgreSQL descartável, sem Docker (exige `initdb`, `age` e `jq`; sem `rclone`
  instalado usa um dublê local).
- CI, job `containers`: constrói a imagem, faz um backup cifrado no volume local com uma
  chave gerada na hora, roda `restore.sh --check` e, na variante com bancos no Compose,
  restaura em dois bancos novos e confere as tabelas e os arquivos.

O envio para um bucket S3 real e a ativação do perfil no Dokploy **não** são exercitados
automaticamente: valem o primeiro backup conferido e o ensaio.
