# Produção no Dokploy

Crie um serviço **Docker Compose** no projeto Verifco. Configure o GitHub/Git com
`contabilrangel/verifco`, branch principal `claude/laughing-brown-xsyey5`.

O [inventário da produção](INVENTARIO-DOKPLOY.md) registra os IDs, hosts internos,
domínios, redes, volumes e pendências reais conferidos em 06/10/2026. Este guia
descreve como instalar; o inventário identifica o que já está instalado.

## Bancos como serviços do Dokploy (instalação atual)

Em **Create Service → Database → PostgreSQL**, crie dois serviços no mesmo
ambiente e servidor da aplicação, com senhas diferentes:

| Serviço | App Name | Database Name | Database User | Imagem |
| --- | --- | --- | --- | --- |
| Verifco — escritórios | `verifco-escritorios` | `verifco` | `verifco` | `postgres:16-bookworm` |
| Verifco — plataforma | `verifco-plataforma` | `verifco_platform` | `verifco_platform` | `postgres:16-bookworm` |

Os App Names acima são exemplos para criação. Use nas conexões os nomes finais
gerados pelo Dokploy, incluindo o sufixo, conforme o inventário e **Credentials**.

Implante os dois bancos e espere ficarem prontos **antes** de implantar a aplicação.
Em **Credentials**, copie a **Internal Connection URL** do primeiro para
`DATABASE_URL` e a do segundo para `PLATFORM_DATABASE_URL`. Não use o IP público
da VM nem `localhost` nessas URLs. Não configure uma porta externa para os bancos.
O Dokploy fornece as conexões e os recursos de backup em cada serviço; backups
agendados ainda precisam de um destino e de uma política de retenção.

Na aplicação **Verifco completo**, use o caminho
`./compose.dokploy-managed.yml` e o modelo de ambiente
`deploy/dokploy-managed.env.example`. O Compose contém apenas **web, API e worker**.
API e worker participam de `dokploy-network` para acessar os bancos gerenciados,
além de `backend` para comunicação com a web. A rede externa deve existir no servidor
do Dokploy; confira o resultado em **Preview Compose**. Os bancos permanecem em
serviços independentes e não reiniciam durante uma atualização da aplicação.

### Troca dos bancos que já estão em execução

Criar os serviços novos **não transfere os dados**. Antes de mudar as URLs ou o
caminho do Compose:

1. Preserve `JWT_SECRET`, `ENCRYPTION_KEY`, o volume `uploads` e as URLs antigas
   fora do Git. Confirme que os novos bancos estão vazios e prontos para receber dados.
2. Interrompa temporariamente API e worker para impedir novas gravações. Faça um
   dump de cada banco antigo com `pg_dump` do PostgreSQL 16 e guarde uma cópia protegida.
3. Restaure cada dump no destino correspondente, sem reaproveitar proprietários ou
   permissões SQL antigos (`--no-owner --no-acl`). Confira as tabelas, registros e
   histórico de migrações dos dois destinos. Não restaure o banco operacional no
   administrativo. Se houver falha, mantenha as URLs antigas e retome os serviços antigos.
4. Salve as duas URLs internas novas, altere o Compose Path para a variante gerenciada
   e implante. Confira saúde da API, worker, web e acesso às contas existentes.
5. Mantenha os volumes `database` e `platform-database` antigos até concluir a
   verificação e o período de recuperação. A variante gerenciada mantém as declarações
   desses volumes, mas não os monta. Não use **Fresh Volumes** e não apague os bancos
   antigos automaticamente. Para voltar, restaure o caminho e as URLs anteriores;
   se houve novas gravações depois da troca, planeje a cópia delas antes de voltar.

Consulte as [conexões de bancos no Dokploy](https://docs.dokploy.com/docs/core/databases/connection)
e a [rede do Compose](https://docs.dokploy.com/docs/core/docker-compose/domains).

## Alternativa: bancos dentro do Compose

O caminho `./compose.dokploy.yml` mantém web (Nginx), API, worker e dois PostgreSQL
na mesma VM, com volumes independentes. Use esse caminho somente para a instalação
com os bancos no próprio Compose. O ambiente dessa alternativa está detalhado abaixo.

Os cinco serviços não publicam portas no host. Adicione o domínio no Dokploy para
o serviço **web**, porta **80**, com HTTPS e Let's Encrypt. A web encaminha `/api/`
à API pela rede interna; `TRUST_PROXY=2` representa Nginx e Traefik. Confira em
**Preview Compose** que a web mantém sua rede `backend` além da rede de roteamento.

## Domínios (ambas as variantes)

Cadastre os três domínios para o serviço `web`, porta `80`:
`app.verifco.com.br` e `ir.verifco.com.br` abrem o painel do contador;
`painel.verifco.com.br` redireciona a raiz para `/sistema`. A separação de contas e
permissões é aplicada pela API, independentemente do domínio de acesso.

A web (Nginx) envia em todas as respostas, inclusive as da API, os cabeçalhos de
segurança de `deploy/nginx-security-headers.conf`: HSTS de um ano (sem
`includeSubDomains`), `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy` e
`Permissions-Policy`. As páginas recebem também uma CSP que impede a abertura do
sistema dentro de frames de outros sites. Mudanças nesses cabeçalhos exigem **Deploy**.

## Ambiente da alternativa com bancos no Compose

Preencha no Dokploy as variáveis de `deploy/dokploy.env.example`:

- `APP_URL`: URL pública com HTTPS, sem barra final; usada também em links enviados.
- `CORS_ORIGINS`: os três endereços públicos, separados por vírgula; se omitida, usa `APP_URL`.
- `DATABASE_URL`: conexão completa do banco dos escritórios, por exemplo
  `postgres://verifco:SENHA@postgres:5432/verifco`.
- `PLATFORM_DATABASE_URL`: conexão completa de outro banco exclusivo da administração,
  por exemplo `postgres://verifco_platform:OUTRA_SENHA@postgres-platform:5432/verifco_platform`.
- `POSTGRES_PASSWORD` e `PLATFORM_POSTGRES_PASSWORD`: senhas distintas para inicializar
  os dois containers PostgreSQL. Devem coincidir com as respectivas URLs; gere cada
  uma com 32 bytes em hexadecimal para evitar escapes. A aplicação recebe as URLs
  completas; as senhas avulsas servem apenas aos containers PostgreSQL.
- `JWT_SECRET`: 32 bytes aleatórios em base64.
- `ENCRYPTION_KEY`: outros 32 bytes aleatórios em base64; preserve a chave entre
  atualizações, pois protege as credenciais já armazenadas.
- `SMTP_URL` e `SMTP_FROM`: opcionais para e-mails padrão. Os escritórios também
  podem configurar seu próprio SMTP.

Não coloque os valores reais no Git. Banco e arquivos ficam nos volumes persistentes
`database`, `platform-database` e `uploads`. **Fresh Volumes** apaga os dados; não use para atualizações.
Preserve cópias externas dos três volumes e da chave de criptografia.

## Separação dos dados

- **Banco da plataforma:** proprietários e desenvolvedores, hashes de senha,
  conexões e chaves de IA cifradas, configuração global, auditoria administrativa
  e limites de tentativas do login global.
- **Banco dos escritórios:** escritórios, colaboradores, clientes, declarações,
  arquivos, fila e integrações operacionais. Os contratos vinculados ao escritório
  ficam aqui para cadastro e cotas serem verificados na mesma transação. O painel
  global os administra pela API, com auditoria no banco da plataforma.
- **Isolamento entre escritórios:** tabelas compartilhadas com `office_id` e
  autorização por escritório na API; nenhum schema ou tabela nova por escritório.
  Isso mantém migrações uniformes e consultas por cliente previsíveis. Essa
  separação é lógica, aplicada pela API, não RLS do PostgreSQL. Não entregue a
  conexão SQL ou acesso aos arquivos aos usuários dos escritórios.

Usar a mesma instância PostgreSQL com databases diferentes também funciona.
Trocar só o usuário ou o `search_path` no mesmo database é recusado. A API confere
as tabelas do destino antes de migrar para detectar URLs com aliases apontando
para o banco errado. Usuários SQL e senhas de cada banco devem ser exclusivos.

Para usar bancos existentes, remova os serviços `postgres` e `postgres-platform`
e suas dependências do Compose em uma configuração própria, mantenha os volumes
antigos e configure as duas URLs reais. Se os bancos estiverem em serviços
separados do Dokploy, a API e o worker precisam compartilhar a rede interna com
eles ([conexões de bancos no Dokploy](https://docs.dokploy.com/docs/core/databases/connection)).
Não use `localhost` para conectar a outro container.

### Atualização de uma instalação existente

Faça backup antes de atualizar e mantenha a mesma `ENCRYPTION_KEY`. As migrações
operacionais preservam as quatro tabelas administrativas antigas em
`legacy_platform` antes de remover as cópias públicas. A primeira inicialização
transfere IDs, hashes, chaves cifradas, configuração e auditoria para o banco
administrativo vazio, em uma única transação. Uma marca de conclusão evita
reimportar valores antigos após novas alterações. Se ambos os lados já tiverem
administração, a inicialização para sem sobrescrever dados.

A cópia antiga permanece em `legacy_platform` para recuperação e contém dados
sensíveis: restrinja o acesso e inclua-a no backup protegido. O sistema não a
consulta durante a operação normal. Planeje sua remoção após validar a transferência
conforme a política de retenção; ela não é apagada automaticamente.

Em uma instalação nova, as cópias legadas estão vazias. Crie o proprietário apenas
depois de a API estar saudável; o comando usa exclusivamente `PLATFORM_DATABASE_URL`.
Não troque `POSTGRES_PASSWORD` em volumes já inicializados: a imagem PostgreSQL
só aplica essas variáveis na primeira criação. Uma troca posterior deve ser feita
no próprio banco e refletida na URL correspondente.

## Implantação e primeiro acesso

1. Crie o registro DNS do domínio apontando para o servidor do Dokploy.
2. Salve o ambiente e o domínio, confira o Compose e clique **Deploy**.
3. Na instalação gerenciada, confirme web, API e worker saudáveis no Compose e os
   dois PostgreSQL prontos em seus serviços independentes. Na alternativa com bancos
   no Compose, confira os cinco componentes no próprio Compose. A API aplica as migrações dos dois bancos antes
   de aceitar conexões; o worker espera a API para evitar migrações simultâneas.
4. No terminal do container `api`, crie o proprietário sem guardar a senha no Git
   nem no ambiente permanente. Digite os valores de forma interativa:

```sh
cd /app/apps/api
read -r -p 'Nome: ' PLATFORM_OWNER_NAME
read -r -p 'E-mail: ' PLATFORM_OWNER_EMAIL
read -r -s -p 'Senha (mínimo 12 caracteres): ' PLATFORM_OWNER_PASSWORD
printf '\n'
export PLATFORM_OWNER_NAME PLATFORM_OWNER_EMAIL PLATFORM_OWNER_PASSWORD
pnpm platform:owner
unset PLATFORM_OWNER_NAME PLATFORM_OWNER_EMAIL PLATFORM_OWNER_PASSWORD
```

Selecione o container **api** no Docker Terminal, não `web`, e use Bash para esse
comando. A imagem `web` é Nginx/Alpine e oferece
`/bin/sh`, sem Bash; ela não contém o comando de criação do proprietário.
O proprietário acessa `/sistema`;
os contadores acessam `/entrar` e criam os escritórios em `/cadastro`. Nenhuma conta
de demonstração é criada automaticamente. Configure as chaves reais de IA no
painel do proprietário em `/sistema/ia`.

A extensão e o sincronizador acompanham a imagem da API para os downloads. São
instalados no navegador/computador do contador, onde ficam eCAC e arquivos IRPF;
não precisam de serviços extras no servidor.

## Verificação automatizada

O CI valida as duas variantes: bancos dentro do Compose e bancos independentes na
rede externa `dokploy-network`. Constrói as imagens e usa valores exclusivos de
teste, confere a web, a navegação `/sistema`, os cabeçalhos de segurança e o
encaminhamento autenticado da API, verifica que as tabelas operacionais e administrativas estão em bancos
diferentes e encerra os containers. A implantação real ainda depende de DNS e ambiente.
