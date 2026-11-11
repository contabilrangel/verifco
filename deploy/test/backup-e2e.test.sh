#!/usr/bin/env bash
# Teste de ponta a ponta de backup.sh e restore.sh, sem Docker: sobe um PostgreSQL descartável,
# faz o backup cifrado em uma pasta, confere, restaura em bancos novos e exercita as recusas.
#
#   bash deploy/test/backup-e2e.test.sh
#
# Precisa de initdb/pg_ctl/pg_dump/psql (PostgreSQL 16+), age, jq e de um usuário comum (o
# PostgreSQL não inicia como root; em um container: `unshare -U --map-user=1000 --map-group=1000`).
# Sem o rclone instalado, usa o dublê deploy/test/fake-rclone. O CI roda o mesmo fluxo com as
# imagens reais (job containers de .github/workflows/ci.yml).
set -euo pipefail

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
DEPLOY=$(dirname "$HERE")

skip() {
  echo "PULADO: $*"
  exit 0
}

if ! command -v initdb > /dev/null 2>&1; then
  for bindir in /usr/lib/postgresql/*/bin; do
    if [[ -x $bindir/initdb ]]; then PATH=$bindir:$PATH; fi
  done
fi
for cmd in initdb pg_ctl pg_dump pg_restore psql createdb age age-keygen jq flock; do
  command -v "$cmd" > /dev/null 2>&1 || skip "comando '$cmd' não encontrado"
done
[[ $(id -u) != 0 ]] || skip "rode como usuário comum (o PostgreSQL não inicia como root)"

T=$(mktemp -d "${TMPDIR:-/tmp}/verifco-backup-e2e.XXXXXX")
cleanup() {
  local code=$?
  if [[ -f $T/pg/postmaster.pid ]]; then pg_ctl -D "$T/pg" -m immediate stop > /dev/null 2>&1 || true; fi
  if ((code != 0)); then
    echo "--- saída do último comando ---"
    cat "$T/out" 2> /dev/null || true
  fi
  rm -rf "$T"
}
trap cleanup EXIT

if ! command -v rclone > /dev/null 2>&1; then
  mkdir "$T/bin"
  ln -s "$HERE/fake-rclone" "$T/bin/rclone"
  PATH=$T/bin:$PATH
  echo "rclone não instalado: usando o dublê deploy/test/fake-rclone"
fi

PASSED=0
ok() {
  PASSED=$((PASSED + 1))
  echo "ok - $*"
}
fail() {
  echo "FALHOU - $*"
  exit 1
}
# run CÓDIGO_ESPERADO COMANDO...: saída (stdout e stderr) em $T/out
run() {
  local expected=$1 code=0
  shift
  "$@" > "$T/out" 2>&1 || code=$?
  [[ $code == "$expected" ]] || fail "esperava código $expected e veio $code: $*"
}
has() { grep -q -- "$1" "$T/out" || fail "saída sem '$1'"; }
sql() { PGPASSWORD=$PASSWORD psql -X -At -h 127.0.0.1 -p "$PORT" -U verifco -d "$1" -v ON_ERROR_STOP=1 -c "$2"; }

# --- PostgreSQL descartável, com senha que exige codificação na URL ----------------------------
PASSWORD='s3nh@/com:especiais'
ENCODED='s3nh%40%2Fcom%3Aespeciais'
PORT=$((20000 + RANDOM % 20000))
printf '%s\n' "$PASSWORD" > "$T/pwfile"
initdb -D "$T/pg" -U verifco --auth=scram-sha-256 --pwfile="$T/pwfile" > /dev/null
pg_ctl -D "$T/pg" -w -l "$T/pg.log" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start > /dev/null
url() { printf 'postgres://verifco:%s@127.0.0.1:%s/%s' "$ENCODED" "$PORT" "$1"; }
for db in verifco verifco_platform restore_office restore_platform; do
  PGPASSWORD=$PASSWORD createdb -h 127.0.0.1 -p "$PORT" -U verifco "$db"
done
sql verifco "create table offices (id serial primary key, name text not null);
             insert into offices (name) values ('Escritório A'), ('Escritório B'), ('Escritório C');
             create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text);
             insert into drizzle.__drizzle_migrations (hash) values ('0001');" > /dev/null
sql verifco_platform "create table platform_users (id serial primary key, email text not null);
                      insert into platform_users (email) values ('dono@exemplo.invalid');" > /dev/null

mkdir -p "$T/storage/escritorio 1/declarações" "$T/dest" "$T/state"
echo 'conteúdo do recibo' > "$T/storage/escritorio 1/declarações/recibo 2026.pdf"
head -c 200000 /dev/urandom > "$T/storage/certificado.pfx"

age-keygen -o "$T/age.key" 2> /dev/null
RECIPIENT=$(age-keygen -y "$T/age.key")
age-keygen -o "$T/outra.key" 2> /dev/null

export DATABASE_URL PLATFORM_DATABASE_URL
DATABASE_URL=$(url verifco)
PLATFORM_DATABASE_URL=$(url verifco_platform)
export BACKUP_STORAGE_DIR=$T/storage BACKUP_LOCAL_DIR=$T/dest BACKUP_STATE_DIR=$T/state BACKUP_WORK_DIR=$T
export APP_COMMIT=0123456789abcdef TZ=America/Sao_Paulo
no_secrets() { ! grep -q -e "$PASSWORD" -e "$ENCODED" -e 'AGE-SECRET-KEY' "$T/out" || fail "a saída expôs um segredo"; }

# --- backup ------------------------------------------------------------------------------------
run 1 bash "$DEPLOY/backup.sh" now
has 'BACKUP_AGE_RECIPIENT'
ok 'recusa rodar sem chave de cifragem'
[[ -z $(ls "$T/dest") ]] || fail 'gravou algo sem cifragem'

run 1 env BACKUP_AGE_RECIPIENT="$(grep AGE-SECRET-KEY "$T/age.key")" bash "$DEPLOY/backup.sh" now
has 'chave PRIVADA'
no_secrets
ok 'recusa a chave privada no lugar da pública, sem repeti-la na saída'

run 1 bash "$DEPLOY/backup.sh" health
ok 'health falha antes do primeiro backup'

export BACKUP_AGE_RECIPIENT=$RECIPIENT
run 0 bash "$DEPLOY/backup.sh" now
has ' OK id='
has 'partes=3'
no_secrets
ID=$(ls "$T/dest")
[[ $ID =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "pasta inesperada no destino: $ID"
[[ $(ls "$T/dest/$ID" | sort | tr '\n' ' ') == 'database.dump.age manifest.json platform.dump.age storage.tar.gz.age ' ]] || fail 'partes inesperadas'
jq -e --arg id "$ID" '.id == $id and .app_commit == "0123456789abcdef" and .encryption == "age" and (.parts | length) == 3 and (.parts[2].files == 2)' "$T/dest/$ID/manifest.json" > /dev/null || fail 'manifesto inesperado'
head -c 30 "$T/dest/$ID/database.dump.age" | grep -q 'age-encryption.org' || fail 'dump não está cifrado'
[[ -z $(find "$T" -maxdepth 1 -name 'verifco-backup.*') ]] || fail 'pasta de trabalho não foi removida'
ok "backup cifrado gravado e conferido ($ID)"

run 0 bash "$DEPLOY/backup.sh" health
ok 'health passa depois do backup'
echo "$(($(date +%s) - 37 * 3600)) $ID" > "$T/state/last-success"
run 1 bash "$DEPLOY/backup.sh" health
has '37 h'
ok 'health falha com o último sucesso há mais de 36 h'

# --- conferência -------------------------------------------------------------------------------
export BACKUP_AGE_IDENTITY_FILE=$T/age.key
run 0 bash "$DEPLOY/restore.sh" --list
has "$ID"
ok 'restore.sh --list'

run 0 bash "$DEPLOY/restore.sh" --check latest
has 'offices presente'
has 'platform_users presente'
has 'tar íntegro'
no_secrets
ok 'restore.sh --check latest'

run 1 env BACKUP_AGE_IDENTITY_FILE="$T/outra.key" bash "$DEPLOY/restore.sh" --check "$ID"
has 'decifrar'
ok '--check falha com a chave privada errada'

cp -r "$T/dest/$ID" "$T/adulterado"
printf 'x' >> "$T/adulterado/platform.dump.age"
run 1 bash "$DEPLOY/restore.sh" --check "$T/adulterado"
has 'diferente do manifesto'
ok '--check falha com uma parte adulterada (pasta local)'

# --- restauração -------------------------------------------------------------------------------
export TARGET_DATABASE_URL TARGET_PLATFORM_DATABASE_URL TARGET_STORAGE_DIR=$T/restored
TARGET_DATABASE_URL=$(url restore_office)
TARGET_PLATFORM_DATABASE_URL=$(url restore_platform)

run 1 env TARGET_DATABASE_URL="postgresql://verifco:$ENCODED@localhost:$PORT/verifco" bash "$DEPLOY/restore.sh" "$ID"
has 'i-know-this-is-production'
ok 'recusa destino igual ao banco em uso'
run 1 env TARGET_STORAGE_DIR="$T/storage" bash "$DEPLOY/restore.sh" "$ID"
has 'i-know-this-is-production'
ok 'recusa destino igual à pasta de arquivos em uso'
run 1 env TARGET_PLATFORM_DATABASE_URL="$TARGET_DATABASE_URL" bash "$DEPLOY/restore.sh" "$ID"
ok 'recusa os dois destinos no mesmo banco'

run 0 bash "$DEPLOY/restore.sh" "$ID"
has ' OK restaurado'
no_secrets
[[ $(sql restore_office 'select count(*) from offices') == 3 ]] || fail 'escritórios não restaurados'
[[ $(sql restore_office 'select hash from drizzle.__drizzle_migrations') == 0001 ]] || fail 'schema drizzle não restaurado'
[[ $(sql restore_platform 'select email from platform_users') == dono@exemplo.invalid ]] || fail 'plataforma não restaurada'
[[ $(sql restore_office "select to_regclass('public.platform_users') is null") == t ]] || fail 'bancos misturados'
diff -r "$T/storage" "$T/restored" > /dev/null || fail 'arquivos restaurados diferem dos originais'
ok 'restauração dos dois bancos e dos arquivos'

run 1 bash "$DEPLOY/restore.sh" "$ID"
has 'não está vazio'
ok 'recusa banco de destino com dados sem --force'

sql restore_office "delete from offices where name = 'Escritório B'; create table sobra (id int)" > /dev/null
run 0 bash "$DEPLOY/restore.sh" --force "$ID"
[[ $(sql restore_office 'select count(*) from offices') == 3 ]] || fail '--force não recriou os dados'
ok 'restaura por cima com --force'

# --- variações do backup -----------------------------------------------------------------------
run 0 env BACKUP_ENCRYPTION=off BACKUP_LOCAL_DIR="$T/claro" BACKUP_INCLUDE_STORAGE=false bash "$DEPLOY/backup.sh" now
has 'SEM cifragem'
has 'partes=2'
run 0 env BACKUP_LOCAL_DIR="$T/claro" BACKUP_AGE_IDENTITY_FILE= bash "$DEPLOY/restore.sh" --check latest
ok 'BACKUP_ENCRYPTION=off explícito e backup sem os arquivos'

run 1 env DATABASE_URL="postgres://verifco:senha-errada@127.0.0.1:$PORT/verifco" bash "$DEPLOY/backup.sh" now
has 'não foi possível conectar ao banco escritórios'
has 'NÃO concluído'
! grep -q 'senha-errada' "$T/out" || fail 'a saída expôs a senha'
[[ -z $(find "$T/dest" -mindepth 1 -maxdepth 1 -newer "$T/state/last-success") ]] || fail 'falha deixou um backup parcial'
ok 'falha de conexão: código 1, mensagem clara, nada gravado'

run 1 env PLATFORM_DATABASE_URL="$DATABASE_URL" bash "$DEPLOY/backup.sh" now
ok 'recusa as duas URLs no mesmo banco'

# retenção: três backups antigos completos, um incompleto antigo e uma pasta alheia
for old in 20250101T030000Z 20250102T030000Z 20250103T030000Z; do cp -r "$T/dest/$ID" "$T/dest/$old"; done
mkdir "$T/dest/20250104T030000Z" "$T/dest/nao-e-backup"
touch "$T/dest/20250104T030000Z/database.dump.age"
sleep 1
run 0 env BACKUP_RETENTION_DAYS=30 BACKUP_KEEP_MIN=3 bash "$DEPLOY/backup.sh" now
has 'removidos=3'
for kept in 20250103T030000Z "$ID" nao-e-backup; do [[ -d $T/dest/$kept ]] || fail "a retenção apagou $kept"; done
for gone in 20250101T030000Z 20250102T030000Z 20250104T030000Z; do [[ ! -e $T/dest/$gone ]] || fail "a retenção manteve $gone"; done
[[ $(ls "$T/dest" | wc -l) == 4 ]] || fail "retenção inesperada: $(ls "$T/dest" | tr '\n' ' ')"
ok 'retenção: apaga vencidos e incompletos antigos, mantém o mínimo e o que não é backup'

# --- modo agendado -----------------------------------------------------------------------------
rm -f "$T/state/last-success"
sleep 1
BACKUP_ON_START=auto bash "$DEPLOY/backup.sh" loop > "$T/loop.out" 2>&1 &
LOOP=$!
for _ in $(seq 1 100); do
  if grep -q 'próximo backup' "$T/loop.out"; then break; fi
  sleep 0.2
done
grep -q ' OK id=' "$T/loop.out" || fail "o modo agendado não fez o backup inicial: $(cat "$T/loop.out")"
grep -q 'próximo backup: ....-..-.. 03:00' "$T/loop.out" || fail 'agenda inesperada'
[[ -f $T/state/last-success ]] || fail 'sem registro do último sucesso'
kill -TERM "$LOOP"
code=0
wait "$LOOP" || code=$?
[[ $code == 0 ]] || fail "o modo agendado saiu com código $code ao receber TERM"
ok 'modo agendado: backup inicial, próxima execução às 03h e parada limpa com TERM'

echo "$PASSED verificações de ponta a ponta passaram"
