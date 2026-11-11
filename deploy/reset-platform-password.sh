#!/usr/bin/env bash
# Redefine a senha de uma conta da plataforma (painel /sistema) quando não há como entrar para
# trocá-la pelo painel. Rode no container da API, em um terminal interativo:
#
#   docker compose exec api bash /app/deploy/reset-platform-password.sh
#   (Dokploy: Docker Terminal, container api, Bash, e então  bash /app/deploy/reset-platform-password.sh)
#
# Opções:
#   --reset-2fa    desliga a verificação em duas etapas da conta (aparelho perdido)
#   --reactivate   reativa a conta, se estiver desativada
#
# E-mail e senha nova são digitados na hora: não ficam no Git, no ambiente do serviço nem no
# histórico do shell. As sessões abertas da conta são encerradas. Em automação, defina
# PLATFORM_USER_EMAIL e PLATFORM_USER_PASSWORD antes de chamar (o que já vier definido não é
# perguntado); as opções equivalem a PLATFORM_USER_RESET_2FA=true e PLATFORM_USER_REACTIVATE=true.
set -euo pipefail

API_DIR=${VERIFCO_API_DIR:-/app/apps/api}
SCRIPT=src/db/platform-reset-password.ts
MIN_PASSWORD=12

fail() {
  printf 'Erro: %s\n' "$*" >&2
  exit 1
}

# o container roda como `node`, sem o pnpm do build: o script é chamado direto pelo node
[[ -d $API_DIR ]] || fail "não encontrei $API_DIR. Rode este comando dentro do container da API."
[[ -f $API_DIR/$SCRIPT ]] || fail "esta versão da API não tem $SCRIPT. Atualize a aplicação (Deploy) e tente de novo."
command -v node > /dev/null 2>&1 || fail "node não encontrado. Rode este comando dentro do container da API."

interactive() { [[ -t 0 ]]; }

reset_2fa=${PLATFORM_USER_RESET_2FA:-}
reactivate=${PLATFORM_USER_REACTIVATE:-}
for option in "$@"; do
  case "$option" in
    --reset-2fa) reset_2fa=true ;;
    --reactivate) reactivate=true ;;
    *) fail "opção desconhecida: $option (use --reset-2fa e/ou --reactivate)." ;;
  esac
done

email=${PLATFORM_USER_EMAIL:-}
password=${PLATFORM_USER_PASSWORD:-}

if [[ -z $email ]]; then
  interactive || fail "defina PLATFORM_USER_EMAIL ou rode em um terminal interativo (docker compose exec, sem -T)."
  read -r -p 'E-mail da conta: ' email
fi
[[ $email == ?*@?*.?* ]] || fail "e-mail inválido."

if [[ -z $password ]]; then
  interactive || fail "defina PLATFORM_USER_PASSWORD ou rode em um terminal interativo."
  for attempt in 1 2 3; do
    IFS= read -r -s -p "Senha nova (mínimo $MIN_PASSWORD caracteres): " password
    printf '\n' >&2
    if ((${#password} < MIN_PASSWORD)); then
      printf 'A senha precisa ter ao menos %s caracteres.\n' "$MIN_PASSWORD" >&2
      password=''
      continue
    fi
    IFS= read -r -s -p 'Repita a senha nova: ' confirmation
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
PLATFORM_USER_EMAIL=$email PLATFORM_USER_PASSWORD=$password \
  PLATFORM_USER_RESET_2FA=$reset_2fa PLATFORM_USER_REACTIVATE=$reactivate \
  node --import tsx "$SCRIPT"
