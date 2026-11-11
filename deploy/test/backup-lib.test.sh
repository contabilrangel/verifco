#!/usr/bin/env bash
# Testes das funções puras de deploy/backup-lib.sh (retenção, agenda, URLs, mascaramento).
# Só precisa de bash e coreutils:  bash deploy/test/backup-lib.test.sh
set -euo pipefail

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=deploy/backup-lib.sh
source "$HERE/../backup-lib.sh"

PASSED=0
FAILED=0

eq() {
  local label=$1 expected=$2 actual=$3
  if [[ $expected == "$actual" ]]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FALHOU: %s\n  esperado: %q\n  obtido:   %q\n' "$label" "$expected" "$actual"
  fi
}

at() { date -u -d "$1" +%s; }
lines() { printf '%s\n' "$@"; }
# junta a saída em uma linha, para comparar listas
flat() { tr '\n' ' ' | sed 's/ $//'; }

# --- identificadores ---------------------------------------------------------------------------
eq 'id a partir do instante' 20261111T060000Z "$(new_backup_id "$(at '2026-11-11 06:00:00')")"
eq 'instante a partir do id' "$(at '2026-11-11 06:00:00')" "$(backup_id_epoch 20261111T060000Z)"
for bad in '' latest 2026-11-11 20261311T000000Z 20261111T060000 '20261111T060000Z/' '../20261111T060000Z'; do
  if valid_backup_id "$bad"; then eq "id inválido recusado: '$bad'" recusado aceito; else eq "id inválido recusado: '$bad'" recusado recusado; fi
done

# --- retenção ----------------------------------------------------------------------------------
NOW=$(at '2026-11-11 12:00:00')
daily() { # daily N → N backups diários, do mais novo (hoje) para trás
  local i
  for ((i = 0; i < $1; i++)); do new_backup_id "$((NOW - 9 * 3600 - i * 86400))"; done
}

eq 'nada a apagar dentro do prazo' '' "$(daily 30 | retention_select "$NOW" 30 7 | flat)"
eq '45 diários, 30 dias: apaga os 15 mais velhos' 15 "$(daily 45 | retention_select "$NOW" 30 7 | wc -l)"
eq 'o mais novo dos apagados tem mais de 30 dias' "$(new_backup_id "$((NOW - 9 * 3600 - 30 * 86400))")" "$(daily 45 | retention_select "$NOW" 30 7 | sort | tail -n 1)"
eq 'a ordem da listagem não importa' 15 "$(daily 45 | sort | retention_select "$NOW" 30 7 | wc -l)"

old=(20260101T030000Z 20260102T030000Z 20260103T030000Z 20260104T030000Z)
eq 'backup parado: os MANTER_MIN mais novos ficam, mesmo vencidos' '20260101T030000Z' "$(lines "${old[@]}" | retention_select "$NOW" 30 3 | flat)"
eq 'menos backups que MANTER_MIN: não apaga nenhum' '' "$(lines "${old[@]}" | retention_select "$NOW" 30 7 | flat)"
eq 'DIAS=0 desliga a limpeza' '' "$(lines "${old[@]}" | retention_select "$NOW" 0 1 | flat)"
eq 'lista vazia' '' "$(printf '' | retention_select "$NOW" 30 7 | flat)"
eq 'nomes fora do padrão nunca são apagados nem contados' '20260101T030000Z' \
  "$(lines "${old[@]}" outra-pasta '' 99999999T999999Z | retention_select "$NOW" 30 3 | flat)"
eq 'ids repetidos contam uma vez' '20260101T030000Z' "$(lines "${old[@]}" "${old[@]}" | retention_select "$NOW" 30 3 | flat)"
eq 'um dia a mais que o prazo apaga; um a menos, não' '20261011T115959Z' \
  "$(lines 20261111T030000Z 20261012T120001Z 20261011T115959Z | retention_select "$NOW" 30 1 | flat)"

# --- envios incompletos ------------------------------------------------------------------------
eq 'incompleto recente fica (pode estar em andamento)' '20261110T110000Z' \
  "$(lines 20261111T030000Z 20261110T130000Z 20261110T110000Z lixo | stale_incomplete_select "$NOW" 24 | flat)"

# --- agenda ------------------------------------------------------------------------------------
export TZ=America/Sao_Paulo
eq 'antes das 03h locais: hoje' '2026-11-11 03:00' "$(date -d "@$(next_run_epoch "$(at '2026-11-11 05:59:59')" 03)" '+%F %H:%M')"
eq 'às 03h em ponto: amanhã' '2026-11-12 03:00' "$(date -d "@$(next_run_epoch "$(at '2026-11-11 06:00:00')" 3)" '+%F %H:%M')"
eq 'à tarde: amanhã' '2026-11-12 03:00' "$(date -d "@$(next_run_epoch "$(at '2026-11-11 18:30:00')" 3)" '+%F %H:%M')"
eq 'virada de mês' '2026-12-01 23:00' "$(date -d "@$(next_run_epoch "$(at '2026-12-01 02:30:00')" 23)" '+%F %H:%M')"
eq 'hora 08 e 09 não são lidas como octal' '2026-11-11 09:00' "$(date -d "@$(next_run_epoch "$(at '2026-11-11 06:00:00')" 09)" '+%F %H:%M')"
unset TZ

# --- URLs de conexão ---------------------------------------------------------------------------
pg_parse_url 'postgres://verifco:p%40ss%2Fw%3Ard%25@Postgres.Interno:6543/verifco?sslmode=require&connect_timeout=5'
eq 'usuário' verifco "$PGU_USER"
eq 'senha decodificada' 'p@ss/w:rd%' "$PGU_PASSWORD"
eq 'host em minúsculas' postgres.interno "$PGU_HOST"
eq 'porta' 6543 "$PGU_PORT"
eq 'banco' verifco "$PGU_DBNAME"
eq 'parâmetros viram variáveis do libpq' 'PGSSLMODE=require PGCONNECT_TIMEOUT=5' "${PGU_ENV[*]}"
pg_parse_url 'postgresql://app@[::1]'
eq 'IPv6 sem colchetes' '::1' "$PGU_HOST"
eq 'porta padrão' 5432 "$PGU_PORT"
eq 'sem banco vale o usuário' app "$PGU_DBNAME"
eq 'sem senha' '' "$PGU_PASSWORD"
pg_parse_url 'postgres://u:senha\com\barra@h/db'
eq 'barra invertida preservada' 'senha\com\barra' "$PGU_PASSWORD"
for bad in 'mysql://u:p@h/db' 'postgres://u:p@h/db?schema=x' 'postgres://u:p@h/db?host=outro' 'pglite:.data/pglite' ''; do
  if pg_parse_url "$bad"; then eq "URL recusada: $bad" recusada aceita; else eq "URL recusada: $bad" recusada recusada; fi
done
eq 'identidade ignora credenciais e caixa' "$(pg_identity 'postgres://a:1@DB.Interno:5432/verifco')" "$(pg_identity 'postgresql://b:2@db.interno/verifco')"
eq 'localhost e 127.0.0.1 são o mesmo host' "$(pg_identity 'postgres://a@localhost/x')" "$(pg_identity 'postgres://a@127.0.0.1:5432/x')"
if [[ $(pg_identity 'postgres://a@h/verifco') != "$(pg_identity 'postgres://a@h/verifco_platform')" ]]; then eq 'bancos diferentes' sim sim; else eq 'bancos diferentes' sim nao; fi
if [[ $(pg_identity 'postgres://a@h:5432/x') != "$(pg_identity 'postgres://a@h:5433/x')" ]]; then eq 'portas diferentes' sim sim; else eq 'portas diferentes' sim nao; fi

# --- mascaramento ------------------------------------------------------------------------------
add_secret 'chave-secreta-do-bucket'
add_secret 'abc'
eq 'segredo registrado e credenciais de URL somem' \
  'falha em postgres://[oculto]@db:5432/verifco usando [oculto] e https://[oculto]@s3.exemplo.com/x abc' \
  "$(echo 'falha em postgres://verifco:senha@db:5432/verifco usando chave-secreta-do-bucket e https://id:chave@s3.exemplo.com/x abc' | redact)"
eq 'linha sem quebra final não se perde' 'ultima linha' "$(printf 'ultima linha' | redact)"

# --- diversos ----------------------------------------------------------------------------------
eq 'tamanho em bytes' '0 B' "$(human_size 0)"
eq 'tamanho em MiB' '1.5 MiB' "$(human_size 1572864)"
int_setting value TESTE_INEXISTENTE 030 0 100
eq 'inteiro com zero à esquerda' 30 "$value"
if (TESTE_HORA=24 int_setting value TESTE_HORA 3 0 23) 2> /dev/null; then eq 'fora do intervalo recusado' recusado aceito; else eq 'fora do intervalo recusado' recusado recusado; fi
if (TESTE_HORA=3h int_setting value TESTE_HORA 3 0 23) 2> /dev/null; then eq 'não numérico recusado' recusado aceito; else eq 'não numérico recusado' recusado recusado; fi

printf '%s testes passaram, %s falharam\n' "$PASSED" "$FAILED"
((FAILED == 0))
