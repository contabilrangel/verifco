#!/usr/bin/env bash
# Restauração de um backup feito por backup.sh: baixa, confere o sha256 de cada parte contra o
# manifesto, decifra com a identidade age e restaura nos destinos indicados.
# Roteiro completo (VM nova, chaves, conferências): docs/RESTAURACAO.md.
set -Eeuo pipefail

SELF=$(readlink -f "${BASH_SOURCE[0]}")
BACKUP_LOG_PREFIX='[verifco-restore]'
# shellcheck source=deploy/backup-lib.sh
source "$(dirname "$SELF")/backup-lib.sh"

usage() {
  cat << 'EOF'
Uso:
  restore.sh --list                      lista os backups completos do destino configurado
  restore.sh --check BACKUP              baixa, confere os sha256, decifra e valida, sem restaurar
  restore.sh [opções] BACKUP             restaura

BACKUP é um identificador (ex.: 20261111T060000Z), "latest" (o mais novo) ou o caminho de uma
pasta já baixada, com manifest.json e as partes.

Origem (as mesmas variáveis do backup): BACKUP_S3_* ou BACKUP_LOCAL_DIR. Com as duas definidas,
vale o bucket; --source local escolhe a pasta.
Decifragem: BACKUP_AGE_IDENTITY_FILE, o arquivo com a chave privada age.

Destinos da restauração (só o que estiver definido é restaurado):
  TARGET_DATABASE_URL            banco dos escritórios, já criado e vazio
  TARGET_PLATFORM_DATABASE_URL   banco da plataforma, já criado e vazio
  TARGET_STORAGE_DIR             pasta que recebe os arquivos (o volume uploads novo)

Opções:
  --force                        aceita destino que já tem dados: os objetos do backup são
                                 recriados (pg_restore --clean) e os arquivos, sobrescritos
  --i-know-this-is-production    aceita destino igual a DATABASE_URL, PLATFORM_DATABASE_URL ou
                                 à pasta de arquivos em uso
  --source s3|local              origem, quando as duas estão configuradas
EOF
}

MODE=restore
FORCE=0
PRODUCTION_OK=0
SOURCE=''
BACKUP_ARG=''
WORK=''
BACKUP_DIED=0
ERR_LINE=''

on_exit() {
  local code=$?
  if [[ -n $WORK && -d $WORK ]]; then rm -rf "$WORK"; fi
  if ((code != 0 && !BACKUP_DIED)); then log "ERRO: interrompido (código $code${ERR_LINE:+, linha $ERR_LINE})"; fi
}

# ---------------------------------------------------------------------------------------------
# Origem
# ---------------------------------------------------------------------------------------------

# source_root: define ROOT (onde os backups estão) a partir do ambiente e de --source.
source_root() {
  local dest
  require_cmd rclone
  store_setup
  ROOT=''
  for dest in ${BACKUP_DESTS[@]+"${BACKUP_DESTS[@]}"}; do
    if [[ -z $SOURCE || ${dest%%|*} == "$SOURCE" ]]; then
      ROOT=${dest#*|}
      SOURCE=${dest%%|*}
      break
    fi
  done
  [[ -n $ROOT ]] || die "origem dos backups não configurada: defina BACKUP_S3_BUCKET (e as credenciais) ou BACKUP_LOCAL_DIR, ou informe a pasta de um backup já baixado"
}

list_ids() {
  local _out=$1 _kind=$2 _ids
  if ! _ids=$(store_ids "$ROOT" "$_kind"); then die "não foi possível listar os backups da origem $SOURCE"; fi
  printf -v "$_out" '%s' "$_ids"
}

cmd_list() {
  local complete all id manifest incomplete
  source_root
  list_ids complete complete
  list_ids all all
  if [[ -z $complete ]]; then
    log "nenhum backup completo na origem $SOURCE"
  else
    printf '%-18s %-21s %-10s %-9s %s\n' ID 'CRIADO EM (UTC)' TAMANHO CIFRAGEM COMMIT
    while IFS= read -r id; do
      if manifest=$(store_manifest "$ROOT" "$id"); then
        jq -r '[.id, .created_at, ([.parts[].bytes] | add | tostring), .encryption, (.app_commit // "-")] | @tsv' <<< "$manifest" |
          while IFS=$'\t' read -r mid created bytes encryption commit; do
            printf '%-18s %-21s %-10s %-9s %s\n' "$mid" "$created" "$(human_size "$bytes")" "$encryption" "${commit:0:12}"
          done
      else
        printf '%-18s %s\n' "$id" '(manifesto ilegível)'
      fi
    done <<< "$complete"
  fi
  incomplete=$(comm -23 <(printf '%s\n' "$all") <(printf '%s\n' "$complete") | tr '\n' ' ')
  if [[ -n ${incomplete// /} ]]; then warn "envios incompletos (sem manifesto), ignorados: $incomplete"; fi
}

# fetch_backup: define BACKUP_DIR com manifest.json e as partes (pasta informada ou download).
fetch_backup() {
  local id=$BACKUP_ARG complete
  if [[ -d $id ]]; then
    [[ -f $id/manifest.json ]] || die "a pasta informada não tem manifest.json"
    BACKUP_DIR=$(readlink -f "$id")
    log "usando a pasta local do backup"
    return
  fi
  source_root
  if [[ $id == latest ]]; then
    list_ids complete complete
    id=$(tail -n 1 <<< "$complete")
    [[ -n $id ]] || die "nenhum backup completo na origem $SOURCE"
  fi
  valid_backup_id "$id" || die "backup não reconhecido: informe um identificador como 20261111T060000Z, latest ou uma pasta"
  BACKUP_DIR=$WORK/download
  mkdir "$BACKUP_DIR"
  log "baixando o backup $id da origem $SOURCE"
  if ! store_download "$ROOT" "$id" "$BACKUP_DIR"; then
    show_err "$BACKUP_WORK/rclone.err"
    die "download do backup $id falhou"
  fi
  [[ -f $BACKUP_DIR/manifest.json ]] || die "backup $id não encontrado ou incompleto (sem manifest.json)"
}

# ---------------------------------------------------------------------------------------------
# Manifesto, integridade e decifragem
# ---------------------------------------------------------------------------------------------

# part_field NOME CAMPO → valor do campo da parte no manifesto (vazio se a parte não existe).
part_field() { jq -r --arg name "$1" --arg field "$2" '.parts[] | select(.name == $name) | .[$field] // empty' "$BACKUP_DIR/manifest.json"; }

verify_manifest() {
  local manifest=$BACKUP_DIR/manifest.json name file bytes sha
  jq -e '.format == 1 and (.id | type == "string") and (.parts | type == "array" and length > 0)
         and all(.parts[]; (.name | type == "string") and (.file | type == "string")
                           and (.bytes | type == "number") and (.sha256 | type == "string"))' \
    "$manifest" > /dev/null 2>&1 || die "manifest.json inválido ou de um formato que este script não conhece"
  MANIFEST_ID=$(jq -r '.id' "$manifest")
  MANIFEST_ENCRYPTION=$(jq -r '.encryption' "$manifest")
  log "backup $MANIFEST_ID de $(jq -r '.created_at' "$manifest"), commit $(jq -r '.app_commit // "não informado"' "$manifest"), cifragem $MANIFEST_ENCRYPTION"
  while IFS=$'\t' read -r name file bytes sha; do
    [[ $file =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "nome de arquivo inválido no manifesto (parte $name)"
    [[ -f $BACKUP_DIR/$file ]] || die "parte $name ausente: $file"
    [[ $(size_of "$BACKUP_DIR/$file") == "$bytes" ]] || die "parte $name com tamanho diferente do manifesto: backup corrompido ou incompleto"
    [[ $(sha256_of "$BACKUP_DIR/$file") == "$sha" ]] || die "parte $name com sha256 diferente do manifesto: backup corrompido"
    log "parte $name: sha256 confere ($(human_size "$bytes"))"
  done < <(jq -r '.parts[] | [.name, .file, (.bytes | tostring), .sha256] | @tsv' "$manifest")

  case "$MANIFEST_ENCRYPTION" in
    age)
      require_cmd age
      [[ -n ${BACKUP_AGE_IDENTITY_FILE:-} ]] || die "backup cifrado: defina BACKUP_AGE_IDENTITY_FILE com o arquivo da chave privada age"
      [[ -f $BACKUP_AGE_IDENTITY_FILE && -r $BACKUP_AGE_IDENTITY_FILE ]] || die "BACKUP_AGE_IDENTITY_FILE não é um arquivo legível pelo usuário $(id -u) (confira o caminho montado no container)"
      # chave errada aparece aqui, com a mensagem certa, antes de qualquer restauração: o age
      # só entrega o primeiro bloco depois de abrir o cabeçalho com a identidade
      while IFS= read -r file; do
        if [[ $(part_stream "$file" 2> "$WORK/age.err" | head -c 64 | wc -c) -eq 0 ]]; then decrypt_failed "$file"; fi
      done < <(jq -r '.parts[].file' "$manifest")
      ;;
    none) warn "este backup não está cifrado" ;;
    *) die "cifragem desconhecida no manifesto: $MANIFEST_ENCRYPTION" ;;
  esac
}

# part_stream ARQUIVO: conteúdo em claro no stdout, sem gravar a versão decifrada em disco.
part_stream() {
  if [[ $MANIFEST_ENCRYPTION == age ]]; then
    age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" "$BACKUP_DIR/$1"
  else
    cat "$BACKUP_DIR/$1"
  fi
}

decrypt_failed() {
  show_err "$WORK/age.err"
  die "não foi possível decifrar $1: confira se BACKUP_AGE_IDENTITY_FILE é a chave privada do par usado no backup"
}

# check_dump NOME TABELA: decifra o dump inteiro e faz o pg_restore convertê-lo em SQL (lê todos
# os blocos de dados), contando as tabelas e procurando a que identifica o banco.
check_dump() {
  local name=$1 marker=$2 file tables found
  local -a st
  file=$(part_field "$name" file)
  [[ -n $file ]] || die "o backup não tem a parte $name"
  set +e
  part_stream "$file" 2> "$WORK/age.err" | pg_restore --file=- 2> "$WORK/pg_restore.err" |
    awk -v marker="CREATE TABLE public.$marker (" '
      /^CREATE TABLE / { tables++ }
      index($0, marker) == 1 { found = 1 }
      END { print tables + 0, found + 0 }' > "$WORK/tables.out"
  st=("${PIPESTATUS[@]}")
  set -e
  if ((st[1] != 0)); then
    show_err "$WORK/age.err"
    show_err "$WORK/pg_restore.err"
    die "o dump da parte $name não é um arquivo válido do pg_dump"
  fi
  ((st[0] == 0)) || decrypt_failed "a parte $name"
  read -r tables found < "$WORK/tables.out"
  ((found == 1)) || die "o dump da parte $name não contém a tabela $marker (dump de outro banco ou vazio)"
  log "parte $name: dump íntegro (tabelas: $tables; $marker presente)"
}

check_storage() {
  local file entries
  local -a st
  file=$(part_field storage file)
  if [[ -z $file ]]; then
    warn "este backup não inclui os arquivos (parte storage)"
    return
  fi
  set +e
  part_stream "$file" 2> "$WORK/age.err" | tar --list --gzip --file=- 2> "$WORK/tar.err" | wc -l > "$WORK/entries.out"
  st=("${PIPESTATUS[@]}")
  set -e
  if ((st[1] != 0)); then
    show_err "$WORK/age.err"
    show_err "$WORK/tar.err"
    die "o arquivo da parte storage não é um tar.gz válido"
  fi
  ((st[0] == 0)) || decrypt_failed "a parte storage"
  read -r entries < "$WORK/entries.out"
  log "parte storage: tar íntegro (entradas: $entries; arquivos no momento do backup: $(part_field storage files))"
}

# ---------------------------------------------------------------------------------------------
# Restauração
# ---------------------------------------------------------------------------------------------

# Conta o que já existe no banco de destino: relações de qualquer schema do usuário e schemas extras.
EMPTY_SQL="select (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                    where n.nspname <> 'information_schema' and n.nspname !~ '^pg_')
                + (select count(*) from pg_catalog.pg_namespace
                    where nspname not in ('public', 'information_schema') and nspname !~ '^pg_')"

# guard_targets: valida os destinos antes de tocar em qualquer um deles.
guard_targets() {
  local var prod target_id prod_id office_id='' platform_id='' storage current
  for var in TARGET_DATABASE_URL TARGET_PLATFORM_DATABASE_URL; do
    [[ -n ${!var:-} ]] || continue
    pg_parse_url "${!var}" || die "$var inválida: $PGU_ERROR"
    add_secret "$PGU_PASSWORD"
    target_id=$(pg_identity "${!var}")
    if [[ $var == TARGET_DATABASE_URL ]]; then office_id=$target_id; else platform_id=$target_id; fi
    for prod in DATABASE_URL PLATFORM_DATABASE_URL; do
      [[ -n ${!prod:-} ]] || continue
      prod_id=$(pg_identity "${!prod}") || continue
      if [[ $target_id == "$prod_id" ]] && ((!PRODUCTION_OK)); then
        die "$var aponta para o mesmo banco de $prod, o banco em uso. Restaure em bancos novos; para sobrescrever a produção de propósito, repita com --i-know-this-is-production"
      fi
    done
  done
  if [[ -n $office_id && $office_id == "$platform_id" ]]; then
    die "TARGET_DATABASE_URL e TARGET_PLATFORM_DATABASE_URL apontam para o mesmo banco"
  fi
  if [[ -n ${TARGET_STORAGE_DIR:-} ]]; then
    [[ $TARGET_STORAGE_DIR == /* ]] || die "TARGET_STORAGE_DIR deve ser um caminho absoluto"
    storage=$(readlink -m "$TARGET_STORAGE_DIR")
    for current in "${BACKUP_STORAGE_DIR:-/app/storage}" "${STORAGE_DIR:-}"; do
      [[ -n $current ]] || continue
      if [[ $storage == "$(readlink -m "$current")" ]] && ((!PRODUCTION_OK)); then
        die "TARGET_STORAGE_DIR é a pasta de arquivos em uso ($current). Restaure em outra pasta; para sobrescrever a produção de propósito, repita com --i-know-this-is-production"
      fi
    done
  fi
  if [[ -z ${TARGET_DATABASE_URL:-}${TARGET_PLATFORM_DATABASE_URL:-}${TARGET_STORAGE_DIR:-} ]]; then
    die "nada a restaurar: defina TARGET_DATABASE_URL, TARGET_PLATFORM_DATABASE_URL e/ou TARGET_STORAGE_DIR"
  fi
}

# preflight_dump NOME RÓTULO URL: antes de restaurar qualquer coisa, confere que a parte existe,
# que o banco de destino responde e que está vazio (ou que --force foi dado).
declare -A EXISTING=()
preflight_dump() {
  local name=$1 label=$2 url=$3 count
  [[ -n $(part_field "$name" file) ]] || die "o backup não tem a parte $name"
  if ! count=$(with_pg "$url" psql -X -w -At -v ON_ERROR_STOP=1 -c "$EMPTY_SQL" 2> "$WORK/psql.err"); then
    show_err "$WORK/psql.err"
    die "não foi possível conectar ao banco de destino ($label); ele precisa existir antes da restauração"
  fi
  [[ $count =~ ^[0-9]+$ ]] || die "resposta inesperada do banco de destino ($label)"
  if ((count > 0)); then
    ((FORCE)) || die "o banco de destino ($label) não está vazio ($count objetos). Use um banco novo, ou --force para recriar os objetos do backup por cima"
    warn "banco de destino ($label) não está vazio: --force recria os objetos do backup"
  fi
  EXISTING[$name]=$count
}

preflight_storage() {
  local dir=$TARGET_STORAGE_DIR
  [[ -n $(part_field storage file) ]] || die "o backup não tem a parte storage (arquivos); retire TARGET_STORAGE_DIR para restaurar só os bancos"
  mkdir -p "$dir" 2> /dev/null || die "não foi possível criar TARGET_STORAGE_DIR"
  [[ -w $dir ]] || die "TARGET_STORAGE_DIR sem permissão de escrita para o usuário $(id -u) (em um volume novo, rode a restauração como root: --user 0:0)"
  if [[ -n $(ls -A "$dir") ]]; then
    ((FORCE)) || die "TARGET_STORAGE_DIR não está vazia. Use uma pasta ou volume novo, ou --force para extrair por cima"
    warn "TARGET_STORAGE_DIR não está vazia: --force extrai por cima e mantém o que não está no backup"
  fi
}

restore_dump() {
  local name=$1 label=$2 url=$3 marker=$4 file found tables rows
  local -a st args=(--no-owner --no-acl --exit-on-error --single-transaction)
  file=$(part_field "$name" file)
  if ((EXISTING[$name] > 0)); then args+=(--clean --if-exists); fi
  pg_parse_url "$url"
  log "restaurando o banco $label"
  set +e
  # uma transação só: ou o banco inteiro é restaurado, ou o destino fica como estava
  part_stream "$file" 2> "$WORK/age.err" | with_pg "$url" pg_restore --no-password "${args[@]}" --dbname="$PGU_DBNAME" 2> "$WORK/pg_restore.err"
  st=("${PIPESTATUS[@]}")
  set -e
  # o pg_restore primeiro: quando ele para no meio, o age também acusa erro (canal fechado)
  if ((st[1] != 0)); then
    show_err "$WORK/pg_restore.err"
    die "pg_restore do banco $label falhou (código ${st[1]}); nada foi gravado no destino"
  fi
  ((st[0] == 0)) || decrypt_failed "a parte $name"
  found=$(with_pg "$url" psql -X -w -At -c "select to_regclass('public.$marker') is not null" 2> /dev/null) || found=''
  [[ $found == t ]] || die "banco $label restaurado, mas sem a tabela $marker: confira se as URLs de destino não estão trocadas"
  tables=$(with_pg "$url" psql -X -w -At -c "select count(*) from information_schema.tables where table_schema = 'public'" 2> /dev/null) || tables='?'
  rows=$(with_pg "$url" psql -X -w -At -c "select count(*) from public.$marker" 2> /dev/null) || rows='?'
  SUMMARY+=" $name=tabelas:$tables,$marker:$rows"
  log "banco $label restaurado (tabelas públicas: $tables; registros em $marker: $rows)"
}

restore_storage() {
  local dir=$TARGET_STORAGE_DIR file count expected
  local -a st
  file=$(part_field storage file)
  log "restaurando os arquivos"
  set +e
  part_stream "$file" 2> "$WORK/age.err" | tar --extract --gzip --numeric-owner --file=- --directory="$dir" 2> "$WORK/tar.err"
  st=("${PIPESTATUS[@]}")
  set -e
  if ((st[1] != 0)); then
    show_err "$WORK/tar.err"
    die "extração dos arquivos falhou (código ${st[1]})"
  fi
  ((st[0] == 0)) || decrypt_failed "a parte storage"
  count=$( (find "$dir" -type f 2> /dev/null || true) | wc -l)
  expected=$(part_field storage files)
  SUMMARY+=" storage=arquivos:$count"
  log "arquivos restaurados: $count (no momento do backup: ${expected:-?})"
}

cmd_check() {
  fetch_backup
  verify_manifest
  require_cmd pg_restore tar gzip
  check_dump database offices
  check_dump platform platform_users
  check_storage
  printf '%s OK verificado id=%s (sha256, decifragem e estrutura das partes)\n' "$BACKUP_LOG_PREFIX" "$MANIFEST_ID"
}

cmd_restore() {
  local skipped=''
  require_cmd psql pg_restore tar gzip
  guard_targets
  fetch_backup
  verify_manifest
  SUMMARY=''
  # todas as conferências antes da primeira gravação: destino recusado não deixa restauração pela metade
  if [[ -n ${TARGET_DATABASE_URL:-} ]]; then preflight_dump database escritórios "$TARGET_DATABASE_URL"; fi
  if [[ -n ${TARGET_PLATFORM_DATABASE_URL:-} ]]; then preflight_dump platform plataforma "$TARGET_PLATFORM_DATABASE_URL"; fi
  if [[ -n ${TARGET_STORAGE_DIR:-} ]]; then preflight_storage; fi
  if [[ -n ${TARGET_DATABASE_URL:-} ]]; then restore_dump database escritórios "$TARGET_DATABASE_URL" offices; else skipped+=' escritórios'; fi
  if [[ -n ${TARGET_PLATFORM_DATABASE_URL:-} ]]; then restore_dump platform plataforma "$TARGET_PLATFORM_DATABASE_URL" platform_users; else skipped+=' plataforma'; fi
  if [[ -n ${TARGET_STORAGE_DIR:-} ]]; then restore_storage; else skipped+=' arquivos'; fi
  if [[ -n $skipped ]]; then warn "NÃO restaurado (destino não informado):$skipped"; fi
  printf '%s OK restaurado id=%s%s\n' "$BACKUP_LOG_PREFIX" "$MANIFEST_ID" "$SUMMARY"
}

# ---------------------------------------------------------------------------------------------

while (($# > 0)); do
  case "$1" in
    --list) MODE=list ;;
    --check) MODE=check ;;
    --force) FORCE=1 ;;
    --i-know-this-is-production) PRODUCTION_OK=1 ;;
    --source)
      shift
      SOURCE=${1:-}
      [[ $SOURCE == s3 || $SOURCE == local ]] || die "--source deve ser s3 ou local"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "opção desconhecida: $1 (veja restore.sh --help)" ;;
    *)
      [[ -z $BACKUP_ARG ]] || die "informe um único backup"
      BACKUP_ARG=$1
      ;;
  esac
  shift
done

if [[ $MODE != list && -z $BACKUP_ARG ]]; then
  usage >&2
  exit 64
fi

trap on_exit EXIT
trap 'ERR_LINE=$LINENO' ERR
require_cmd jq sha256sum comm
WORK=$(mktemp -d "${BACKUP_WORK_DIR:-/tmp}/verifco-restore.XXXXXX")
BACKUP_WORK=$WORK

case "$MODE" in
  list) cmd_list ;;
  check) cmd_check ;;
  restore) cmd_restore ;;
esac
