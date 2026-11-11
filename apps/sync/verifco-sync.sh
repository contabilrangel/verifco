#!/bin/sh
# Sincronizador Verifco — atalho para Linux e macOS.
# Confere o Node.js (22 ou mais novo), instala as dependências na primeira execução e roda a
# linha de comando (src/cli.ts) com o Node deste computador.
# Uso: sh verifco-sync.sh <comando> [opções]     (ex.: sh verifco-sync.sh configurar)
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado. Instale o Node.js 22 ou mais novo (https://nodejs.org) e tente de novo." >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "O sincronizador precisa do Node.js 22 ou mais novo (instalado: $(node --version)). Atualize em https://nodejs.org" >&2
  exit 1
fi
if [ ! -f "$DIR/node_modules/tsx/dist/cli.mjs" ]; then
  echo "Instalando as dependências do sincronizador (só na primeira execução)..."
  if ! (cd "$DIR" && npm install --omit=dev --no-audit --no-fund); then
    echo "Não foi possível instalar as dependências. Confira a internet e rode \"npm install --omit=dev\" na pasta $DIR" >&2
    exit 1
  fi
fi
exec node "$DIR/node_modules/tsx/dist/cli.mjs" "$DIR/src/cli.ts" "$@"
