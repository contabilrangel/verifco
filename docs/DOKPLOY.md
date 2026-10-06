# Produção no Dokploy

Crie um serviço **Docker Compose** no projeto Verifco. Configure o GitHub/Git com
`contabilrangel/verifco`, branch principal `claude/laughing-brown-xsyey5` e caminho
`./compose.dokploy.yml`. A stack contém web (Nginx), API, worker e dois PostgreSQL na mesma VM.

Os cinco serviços não publicam portas no host. Adicione o domínio no Dokploy para
o serviço **web**, porta **80**, com HTTPS e Let's Encrypt. A web encaminha `/api/`
à API pela rede interna; `TRUST_PROXY=2` representa Nginx e Traefik. Confira em
**Preview Compose** que a web mantém sua rede `backend` além da rede de roteamento.

Nesta instalação, cadastre os três domínios para o serviço `web`, porta `80`:
`app.verifco.com.br` e `ir.verifco.com.br` abrem o painel do contador;
`painel.verifco.com.br` redireciona a raiz para `/sistema`. A separação de contas e
permissões é aplicada pela API, independentemente do domínio de acesso.

## Ambiente

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
3. Confirme que os cinco serviços estão saudáveis. A API aplica as migrações dos dois bancos antes
   de aceitar conexões; o worker espera a API para evitar migrações simultâneas.
4. No terminal do container `api`, crie o proprietário sem guardar a senha no Git
   nem no ambiente permanente. Digite os valores de forma interativa:

```sh
read -r -p 'Nome: ' PLATFORM_OWNER_NAME
read -r -p 'E-mail: ' PLATFORM_OWNER_EMAIL
read -r -s -p 'Senha (mínimo 12 caracteres): ' PLATFORM_OWNER_PASSWORD
printf '\n'
export PLATFORM_OWNER_NAME PLATFORM_OWNER_EMAIL PLATFORM_OWNER_PASSWORD
pnpm platform:owner
unset PLATFORM_OWNER_NAME PLATFORM_OWNER_EMAIL PLATFORM_OWNER_PASSWORD
```

Use Bash para esse comando (`bash` no terminal). O proprietário acessa `/sistema`;
os contadores acessam `/entrar` e criam os escritórios em `/cadastro`. Nenhuma conta
de demonstração é criada automaticamente. Configure as chaves reais de IA no
painel do proprietário em `/sistema/ia`.

A extensão e o sincronizador acompanham a imagem da API para os downloads. São
instalados no navegador/computador do contador, onde ficam eCAC e arquivos IRPF;
não precisam de serviços extras no servidor.

## Verificação automatizada

O CI constrói as duas imagens, sobe a stack com os dois PostgreSQL e valores exclusivos
de teste, confere a web, a navegação `/sistema` e o encaminhamento autenticado da
API, verifica que as tabelas operacionais e administrativas estão em bancos
diferentes e encerra os containers. A implantação real ainda depende de DNS e ambiente.
