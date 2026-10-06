# Inventário da produção no Dokploy

Levantamento realizado em **06/10/2026**, entre 15h51 e 16h00 (America/Sao_Paulo),
na interface do Dokploy, com conferência do DNS e do código implantado. Este documento
registra a instalação existente; o procedimento de instalação está em [DOKPLOY.md](DOKPLOY.md).
Estados, IDs de containers e contagens são uma fotografia desse momento, não parâmetros
fixos. Senhas, URLs com credenciais, chaves e dados pessoais não fazem parte do inventário.

## Servidor, projeto e origem

| Item | Valor confirmado |
| --- | --- |
| Painel | [dokploy.llypedev.com.br](https://dokploy.llypedev.com.br) |
| Versão do Dokploy | `v0.30.8` |
| Servidor selecionado | `Dokploy Server` |
| IP público configurado e DNS | `163.176.238.103` |
| Projeto | `verifco` — `IYzXJY6swQ49cLyaqOii-` |
| Ambiente | `production` — `VUe9y0rnw6LA9UAnjIH5U` |
| Repositório | [contabilrangel/verifco](https://github.com/contabilrangel/verifco) |
| Branch de produção | `claude/laughing-brown-xsyey5` |
| Compose Path | `./compose.dokploy-managed.yml` |
| Último commit da aplicação implantado | [`e6366bcd6054be6fb6491a05083a72a7225e62f9`](https://github.com/contabilrangel/verifco/commit/e6366bcd6054be6fb6491a05083a72a7225e62f9) — merge do [PR #7](https://github.com/contabilrangel/verifco/pull/7) |
| Autodeploy | **Desativado**; um merge não dispara a implantação automaticamente |

[Abrir o ambiente de produção](https://dokploy.llypedev.com.br/dashboard/project/IYzXJY6swQ49cLyaqOii-/environment/VUe9y0rnw6LA9UAnjIH5U).
Aplicação e dois serviços PostgreSQL estão na mesma VM. Os bancos têm uma réplica
cada. Não há limites explícitos de CPU ou memória preenchidos nos serviços PostgreSQL.
A distribuição do sistema operacional e a capacidade de CPU, RAM e disco da VM não
foram confirmadas: o terminal do servidor falhou na autenticação SSH. Nenhuma chave
de acesso ou configuração do servidor foi alterada durante o levantamento.

## Serviços cadastrados

| Serviço | Tipo | ID no Dokploy | App Name / host interno |
| --- | --- | --- | --- |
| [Verifco completo](https://dokploy.llypedev.com.br/dashboard/project/IYzXJY6swQ49cLyaqOii-/environment/VUe9y0rnw6LA9UAnjIH5U/services/compose/_f78QCVFHuGI4fmw4TF_q) | Compose | `_f78QCVFHuGI4fmw4TF_q` | `verifco-verifco-completo-ifhctu` |
| [Verifco — escritórios](https://dokploy.llypedev.com.br/dashboard/project/IYzXJY6swQ49cLyaqOii-/environment/VUe9y0rnw6LA9UAnjIH5U/services/postgres/OS9E7zD_m45XITe__J1jn) | PostgreSQL | `OS9E7zD_m45XITe__J1jn` | `verifco-escritorios-5aedgd` |
| [Verifco — plataforma](https://dokploy.llypedev.com.br/dashboard/project/IYzXJY6swQ49cLyaqOii-/environment/VUe9y0rnw6LA9UAnjIH5U/services/postgres/cfNtxK9LaFe8y0kTzUl5H) | PostgreSQL | `cfNtxK9LaFe8y0kTzUl5H` | `verifco-plataforma-ojykto` |

O sufixo gerado pelo Dokploy faz parte do host real. Os nomes sem sufixo usados
como exemplos de criação em DOKPLOY.md não substituem estes hosts.

### Aplicação: três containers

| Componente | Nome do container | ID observado | Função e execução |
| --- | --- | --- | --- |
| `web` | `verifco-verifco-completo-ifhctu-web-1` | `cd66b64a9cf6` | React compilado e servido por `nginx:stable-alpine`, porta interna 80 |
| `api` | `verifco-verifco-completo-ifhctu-api-1` | `687a14f52e7e` | API em Node 22 / Bookworm slim, porta interna 3333 |
| `worker` | `verifco-verifco-completo-ifhctu-worker-1` | `c27206679bda` | Mesma imagem da API, com processamento da fila habilitado |

Os três estavam **running / healthy**. Os IDs mudam quando os containers são
recriados. API e worker montam o mesmo armazenamento de arquivos em `/app/storage`.
O worker espera a API ficar saudável; a API aplica as migrações antes de atender.
O Compose atual não contém serviços PostgreSQL. Extensão e sincronizador são
distribuídos pela API e instalados no computador do contador, sem containers próprios.

### Bancos independentes

| Propriedade | Escritórios | Plataforma |
| --- | --- | --- |
| Host interno | `verifco-escritorios-5aedgd` | `verifco-plataforma-ojykto` |
| Database | `verifco` | `verifco_platform` |
| Usuário SQL | `verifco` | `verifco_platform` |
| Porta interna | `5432` | `5432` |
| External Port | Vazio, sem porta publicada | Vazio, sem porta publicada |
| Imagem | `postgres:16-bookworm` | `postgres:16-bookworm` |
| Réplicas configuradas | `1` | `1` |
| Rede padrão | `dokploy-network`, Detach desativado | `dokploy-network`, Detach desativado |

O banco operacional guarda escritórios, colaboradores, clientes, declarações,
arquivos, integrações, fila e contratos vinculados ao escritório. O administrativo
guarda contas do proprietário/desenvolvedor, conexões de IA e chaves cifradas,
configuração global, auditoria e limites do login global. As chaves de IA são
administradas pelo proprietário do sistema.

Os escritórios compartilham tabelas no banco operacional. A separação usa `office_id`
e autorização na API; não há banco, schema ou tabela individual por escritório,
nem política RLS implementada no PostgreSQL. Usuários dos escritórios não recebem
acesso SQL aos bancos ou acesso direto ao volume de arquivos.

## Domínios, HTTPS e redes

Os registros A abaixo apontavam para `163.176.238.103`. Os três domínios da aplicação
estão cadastrados no Compose para **web**, porta **80**, caminho **/**, HTTPS e
certificado **Let's Encrypt**.

| Domínio | Entrada / público |
| --- | --- |
| [app.verifco.com.br](https://app.verifco.com.br) | Contadores; login `/entrar`, cadastro `/cadastro` |
| [ir.verifco.com.br](https://ir.verifco.com.br) | Contadores; mesmo aplicativo e banco operacional |
| [painel.verifco.com.br](https://painel.verifco.com.br) | Proprietário e desenvolvedores; raiz redirecionada para `/sistema` |
| `dokploy.llypedev.com.br` | Administração da infraestrutura; separado do painel de produto |

```mermaid
flowchart LR
  D["app / ir / painel.verifco.com.br"] --> T["Traefik · HTTPS"]
  T --> W["web · Nginx :80"]
  W -->|"/api/"| A["api :3333"]
  A --> E["PostgreSQL escritórios"]
  A --> P["PostgreSQL plataforma"]
  J["worker"] --> E
  J --> P
  A --> U["volume uploads"]
  J --> U
```

| Rede | Uso |
| --- | --- |
| `verifco-verifco-completo-ifhctu_backend` | Comunicação interna entre web, API e worker |
| `dokploy-network` | Rede externa existente no Docker, compartilhada por API, worker, bancos e roteamento do Dokploy |

O Dokploy conecta a web ao roteamento dos domínios. Nginx encaminha `/api/` para
`api:3333`; `TRUST_PROXY=2` representa Traefik e Nginx. O Compose não publica a
porta da API no host. As conexões SQL usam os nomes internos dos serviços, sem
`localhost` ou IP público. Endereços IP internos de containers podem mudar.
A rede compartilhada não fornece isolamento por escritório; esse controle ocorre
na API. A API verifica permissões mesmo que alguém use outro domínio de entrada.

## Volumes persistentes

Todos os cinco volumes foram encontrados em **Docker → Volumes**, com driver e
escopo `local`. O diretório no host segue `/var/lib/docker/volumes/<nome>/_data`.

| Nome real do volume | Montagem no container | Situação |
| --- | --- | --- |
| `verifco-escritorios-5aedgd-data` | `/var/lib/postgresql/data` | Banco dos escritórios em uso |
| `verifco-plataforma-ojykto-data` | `/var/lib/postgresql/data` | Banco da plataforma em uso |
| `verifco-verifco-completo-ifhctu_uploads` | `/app/storage` | Arquivos compartilhados pela API e worker, leitura e gravação |
| `verifco-verifco-completo-ifhctu_database` | Sem montagem no Compose atual | Volume do banco operacional anterior, preservado |
| `verifco-verifco-completo-ifhctu_platform-database` | Sem montagem no Compose atual | Volume administrativo anterior, preservado |

Os dois volumes antigos continuam declarados como reservas no Compose gerenciado.
Seus containers PostgreSQL anteriores foram retirados na implantação. Não apagar
esses volumes durante a validação da migração e não usar **Fresh Volumes** ou
**Rebuild Database** como procedimento de atualização.

Persistência na mesma VM não é backup independente. Os volumes antigos também não
contêm as gravações posteriores à troca, incluindo o proprietário criado no banco
gerenciado; não devem ser usados como recuperação atual sem reconciliar esses dados.

## Ambiente da aplicação

O modelo para esta instalação é [deploy/dokploy-managed.env.example](../deploy/dokploy-managed.env.example).
Os valores reais ficam no **Environment** do serviço Compose, fora do Git. As duas
URLs completas vêm de **Credentials → Internal Connection URL** dos respectivos bancos.
Estrutura ilustrativa, sem senhas reais:

```dotenv
APP_URL=https://app.verifco.com.br
CORS_ORIGINS=https://app.verifco.com.br,https://ir.verifco.com.br,https://painel.verifco.com.br
DATABASE_URL=postgres://verifco:SENHA_DO_BANCO@verifco-escritorios-5aedgd:5432/verifco
PLATFORM_DATABASE_URL=postgres://verifco_platform:OUTRA_SENHA@verifco-plataforma-ojykto:5432/verifco_platform
JWT_SECRET=VALOR_PROTEGIDO
ENCRYPTION_KEY=VALOR_PROTEGIDO
```

Não salvar este exemplo com placeholders no ambiente real. Se montar uma URL
manualmente, codificar caracteres reservados da senha na URL. Preferir copiar a
conexão interna fornecida pelo Dokploy. As senhas dos bancos são distintas; a
aplicação usa as URLs e não precisa de `POSTGRES_PASSWORD` ou
`PLATFORM_POSTGRES_PASSWORD` na variante gerenciada.

Preservar `JWT_SECRET` e `ENCRYPTION_KEY` existentes entre atualizações e guardar
cópias protegidas fora da VM. A chave de criptografia é necessária para ler as
credenciais cifradas já armazenadas. O Compose define `NODE_ENV=production`,
`HOST=0.0.0.0`, `PORT=3333`, `DB_SYNC=migrate`, `STORAGE_DIR=/app/storage`,
`TRUST_PROXY=2` e `JOB_CONCURRENCY=4`. `WEB_URL` e `API_URL` recebem `APP_URL`.
`RUN_WORKER=false` na API e `true` no worker. `SMTP_URL` e `SMTP_FROM` são opcionais;
não foi validado envio de e-mail durante este inventário.

## Verificação da implantação

Na conferência da implantação dos bancos gerenciados:

- Banco `verifco`: **46 tabelas públicas**; `offices` presente e `platform_users` ausente.
- Banco `verifco_platform`: **5 tabelas públicas**; `platform_users` presente e `offices` ausente.
- A API respondeu **200** em `/health`; o encaminhamento pela web respondeu **401**
  em `/api/platform/me` sem sessão, resultado esperado de uma rota autenticada.
- Foi confirmada **uma conta de proprietário ativa** no banco da plataforma, criada
  interativamente. Não recriar o primeiro proprietário durante atualizações.
- A página de entrada de `ir.verifco.com.br` foi acessada após a troca dos bancos.

Nesta rede de verificação, o FortiGuard bloqueou `app.verifco.com.br` e
`painel.verifco.com.br` como **Newly Observed Domain**. DNS e cadastro HTTPS desses
domínios foram conferidos, mas o login externo do proprietário não foi validado
nessa rede. O bloqueio não foi contornado. Estado de domínio e acesso devem ser
conferidos novamente em uma rede autorizada sem essa restrição.

## Backups e pendências reais

Na interface dos dois serviços PostgreSQL: **No backups configured**.
No Compose: **No volume backups** e **No scheduled tasks**. A tela de backups do
Compose também indicou ausência de destino S3 configurado. Portanto, não há backup
automático desses bancos ou do volume de arquivos configurado no Dokploy.

Antes de considerar concluída a recuperação de produção, falta:

1. Definir um destino de backup fora desta VM e cadastrar suas credenciais no Dokploy.
2. Configurar agenda e retenção para **os dois bancos** e para o volume **uploads**.
3. Guardar as chaves da aplicação de forma protegida fora da VM, separadas deste documento.
4. Testar restauração em ambiente separado, verificando contas, clientes, arquivos
   e leitura de credenciais cifradas; registrar data, resultado e tempo de recuperação.
5. Registrar capacidade e sistema operacional da VM quando houver acesso autorizado
   ao servidor e confirmar o primeiro login do proprietário em rede sem o bloqueio citado.

Este levantamento não criou agendas, destinos, credenciais nem alterou a produção.

## Atualização e recuperação

Para atualizar código, confira o commit no branch de produção, faça backup dos
dois bancos e dos arquivos, preserve as chaves e clique **Deploy** em **Verifco completo**.
Não é necessário reimplantar os bancos a cada atualização da aplicação. Aguarde
**web, API e worker** saudáveis e confira separadamente os dois serviços PostgreSQL.
Verifique `/health`, os três domínios, autenticação e separação dos dados.

Comandos administrativos pertencem ao terminal do container **api**, com Bash e
diretório `/app/apps/api`. O container **web** oferece `/bin/sh`, sem Bash, e não
tem o comando de criação do proprietário. O primeiro proprietário já existe nesta
instalação; a criação inicial documentada em DOKPLOY.md serve para instalações novas.

Para recuperar, use backups recentes de cada banco e dos arquivos, junto com as
chaves preservadas. Não trocar as URLs de plataforma e escritórios. Retornar ao
Compose antigo exige reconciliar todas as gravações posteriores à troca; manter
volumes antigos não substitui um plano de restauração. Atualize este inventário
após mudanças de domínio, host interno, serviço, rede, volume, política de backup
ou infraestrutura. Um PR só de documentação não exige Deploy.
