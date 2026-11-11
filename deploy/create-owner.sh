#!/usr/bin/env bash
# Cria o primeiro proprietário da plataforma (painel /sistema). Rode no container da API, em um
# terminal interativo:
#
#   docker compose exec api bash /app/deploy/create-owner.sh
#   (Dokploy: Docker Terminal, container api, Bash, e então  bash /app/deploy/create-owner.sh)
#
# Nome, e-mail e senha são digitados na hora: não ficam no Git, no ambiente do serviço nem no
# histórico do shell. O comando recusa quando já existe uma conta da plataforma; as próximas são
# criadas no painel, em Equipe do sistema. Em automação, defina PLATFORM_OWNER_NAME,
# PLATFORM_OWNER_EMAIL e PLATFORM_OWNER_PASSWORD antes de chamar: o que já vier definido não é
# perguntado.
set -euo pipefail

API_DIR=${VERIFCO_API_DIR:-/app/apps/api}
SCRIPT=src/db/platform-owner.ts
MIN_PASSWORD=12

fail() {
  printf 'Erro: %s\n' "$*" >&2
  exit 1
}

# o container roda como `node`, sem o pnpm do build: o script é chamado direto pelo node
[[ -f $API_DIR/$SCRIPT ]] || fail "não encontrei $API_DIR/$SCRIPT. Rode este comando dentro do container da API."
command -v node > /dev/null 2>&1 || fail "node não encontrado. Rode este comando dentro do container da API."

interactive() { [[ -t 0 ]]; }

name=${PLATFORM_OWNER_NAME:-}
email=${PLATFORM_OWNER_EMAIL:-}
password=${PLATFORM_OWNER_PASSWORD:-}

if [[ -z $name ]]; then
  interactive || fail "defina PLATFORM_OWNER_NAME ou rode em um terminal interativo (docker compose exec, sem -T)."
  read -r -p 'Nome: ' name
fi
[[ -n $name ]] || fail "o nome não pode ficar vazio."

if [[ -z $email ]]; then
  interactive || fail "defina PLATFORM_OWNER_EMAIL ou rode em um terminal interativo."
  read -r -p 'E-mail: ' email
fi
[[ $email == ?*@?*.?* ]] || fail "e-mail inválido."

if [[ -z $password ]]; then
  interactive || fail "defina PLATFORM_OWNER_PASSWORD ou rode em um terminal interativo."
  for attempt in 1 2 3; do
    IFS= read -r -s -p "Senha (mínimo $MIN_PASSWORD caracteres): " password
    printf '\n' >&2
    if ((${#password} < MIN_PASSWORD)); then
      printf 'A senha precisa ter ao menos %s caracteres.\n' "$MIN_PASSWORD" >&2
      password=''
      continue
    fi
    IFS= read -r -s -p 'Repita a senha: ' confirmation
    printf '\n' >&2
    if [[ $password == "$confirmation" ]]; then break; fi
    printf 'As senhas não conferem.\n' >&2
    password=''
  done
  unset confirmation attempt
  [[ -n $password ]] || fail "senha não definida depois de três tentativas."
fi
((${#password} >= MIN_PASSWORD)) || fail "a senha precisa ter ao menos $MIN_PASSWORD caracteres."

cd "$API_DIR"
# os valores valem só para este processo: nada é exportado para o terminal
PLATFORM_OWNER_NAME=$name PLATFORM_OWNER_EMAIL=$email PLATFORM_OWNER_PASSWORD=$password \
  node --import tsx "$SCRIPT"
