# Produção no Dokploy

Crie um serviço **Docker Compose** no projeto Verifco. Configure o GitHub/Git com
`contabilrangel/verifco`, branch principal `claude/laughing-brown-xsyey5` e caminho
`./compose.dokploy.yml`. A stack contém web (Nginx), API, worker e PostgreSQL.

Os quatro serviços não publicam portas no host. Adicione o domínio no Dokploy para
o serviço **web**, porta **80**, com HTTPS e Let's Encrypt. A web encaminha `/api/`
à API pela rede interna; `TRUST_PROXY=2` representa Nginx e Traefik. Confira em
**Preview Compose** que a web mantém sua rede `backend` além da rede de roteamento.

## Ambiente

Preencha no Dokploy as variáveis de `deploy/dokploy.env.example`:

- `APP_URL`: URL pública com HTTPS, sem barra final; usada também em links enviados.
- `POSTGRES_PASSWORD`: senha exclusiva, gerada com 32 bytes em hexadecimal, para
  evitar caracteres especiais na URL de conexão.
- `JWT_SECRET`: 32 bytes aleatórios em base64.
- `ENCRYPTION_KEY`: outros 32 bytes aleatórios em base64; preserve a chave entre
  atualizações, pois protege as credenciais já armazenadas.
- `SMTP_URL` e `SMTP_FROM`: opcionais para e-mails padrão. Os escritórios também
  podem configurar seu próprio SMTP.

Não coloque os valores reais no Git. Banco e arquivos ficam nos volumes persistentes
`database` e `uploads`. **Fresh Volumes** apaga os dados; não use para atualizações.
Preserve cópias externas dos dois volumes e da chave de criptografia.

## Implantação e primeiro acesso

1. Crie o registro DNS do domínio apontando para o servidor do Dokploy.
2. Salve o ambiente e o domínio, confira o Compose e clique **Deploy**.
3. Confirme que os quatro serviços estão saudáveis. A API aplica as migrações antes
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

O CI constrói as duas imagens, sobe a stack com PostgreSQL e valores exclusivos
de teste, confere a web, a navegação `/sistema` e o encaminhamento autenticado da
API, e encerra os containers. A implantação real ainda depende de DNS e ambiente.
