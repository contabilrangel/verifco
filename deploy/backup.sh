#!/usr/bin/env bash
# Backup do Verifco: os dois bancos PostgreSQL e os arquivos enviados (volume uploads), cifrados
# com age antes de sair da máquina e gravados em um bucket compatível com S3 e/ou em uma pasta.
# Procedimento completo, chaves e restauração: docs/RESTAURACAO.md.
set -Eeuo pipefail

SELF=$(readlink -f "${BASH_SOURCE[0]}")
# shellcheck source=deploy/backup-lib.sh
source "$(dirname "$SELF")/backup-lib.sh"

STATE_DIR=${BACKUP_STATE_DIR:-/var/lib/verifco-backup}

usage() {
  cat << 'EOF'
Uso: backup.sh now | loop | health

  now     faz um backup agora e sai (código 0 = enviado e conferido)
  loop    fica rodando: um backup por dia às BACKUP_SCHEDULE_HOUR horas (padrão 03, fuso de TZ),
          com nova tentativa a cada BACKUP_RETRY_MINUTES (padrão 60) enquanto falhar
  health  código 0 se o último backup concluído tem menos de BACKUP_MAX_AGE_HOURS (padrão 36)

Origem (as mesmas variáveis da API):
  DATABASE_URL, PLATFORM_DATABASE_URL   os dois bancos PostgreSQL
  BACKUP_STORAGE_DIR                    pasta dos arquivos (padrão /app/storage, montada só leitura)
  BACKUP_INCLUDE_STORAGE                false deixa os arquivos de fora (STORAGE_DRIVER=s3)

Cifragem:
  BACKUP_AGE_RECIPIENT                  chave pública age (age1...); várias separadas por vírgula
  BACKUP_ENCRYPTION                     age (padrão) ou off (grava sem cifrar; não recomendado)

Destino (ao menos um):
  BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_PREFIX (padrão verifco),
  BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_FORCE_PATH_STYLE (padrão true)
  BACKUP_LOCAL_DIR                      pasta local ou montada (testes e primeira configuração)

Retenção:
  BACKUP_RETENTION_DAYS                 apaga backups mais velhos que isto (padrão 30; 0 não apaga)
  BACKUP_KEEP_MIN                       mantém sempre os mais novos (padrão 7)

Outros: BACKUP_ON_START (auto|always|never), BACKUP_WORK_DIR (padrão /tmp), APP_COMMIT, TZ.
EOF
}

# ---------------------------------------------------------------------------------------------
# Estado: último sucesso (healthcheck) e trava contra execuções simultâneas
# ---------------------------------------------------------------------------------------------

state_writable() {
  mkdir -p "$STATE_DIR" 2> /dev/null && [[ -w $STATE_DIR ]]
}

# last_success_age AGORA → idade em segundos do último backup concluído; devolve 1 se não houver.
last_success_age() {
  local now=$1 epoch rest
  [[ -r $STATE_DIR/last-success ]] || return 1
  read -r epoch rest < "$STATE_DIR/last-success" || true
  [[ ${epoch:-} =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$((now - epoch))"
}

cmd_health() {
  local max now age
  int_setting max BACKUP_MAX_AGE_HOURS 36 1 8760
  now=$(date +%s)
  if ! age=$(last_success_age "$now"); then
    echo "nenhum backup concluído ainda"
    exit 1
  fi
  if ((age > max * 3600)); then
    echo "último backup concluído há $((age / 3600)) h (limite: $max h)"
    exit 1
  fi
  echo "último backup concluído há $((age / 3600)) h"
}

# ---------------------------------------------------------------------------------------------
# Um backup
# ---------------------------------------------------------------------------------------------

WORK=''
STARTED=0
BACKUP_DIED=0
ERR_LINE=''

on_exit() {
  local code=$?
  if [[ -n $WORK && -d $WORK ]]; then rm -rf "$WORK"; fi
  if ((code == 0 || code == 3)); then return; fi
  if ((!BACKUP_DIED)); then log "ERRO: backup interrompido (código $code${ERR_LINE:+, linha $ERR_LINE})"; fi
  if state_writable; then date +%s > "$STATE_DIR/last-failure" 2> /dev/null || true; fi
  log "backup NÃO concluído"
}

# store_must DESCRIÇÃO COMANDO...: operação obrigatória no destino.
store_must() {
  local what=$1
  shift
  if ! "$@"; then
    show_err "$BACKUP_WORK/rclone.err"
    die "$what falhou"
  fi
}

load_settings() {
  local office_id platform_id
  [[ -n ${DATABASE_URL:-} ]] || die "defina DATABASE_URL (a mesma da API)"
  [[ -n ${PLATFORM_DATABASE_URL:-} ]] || die "defina PLATFORM_DATABASE_URL (a mesma da API)"
  pg_parse_url "$DATABASE_URL" || die "DATABASE_URL inválida: $PGU_ERROR"
  add_secret "$PGU_PASSWORD"
  pg_parse_url "$PLATFORM_DATABASE_URL" || die "PLATFORM_DATABASE_URL inválida: $PGU_ERROR"
  add_secret "$PGU_PASSWORD"
  office_id=$(pg_identity "$DATABASE_URL")
  platform_id=$(pg_identity "$PLATFORM_DATABASE_URL")
  [[ $office_id != "$platform_id" ]] || die "DATABASE_URL e PLATFORM_DATABASE_URL apontam para o mesmo banco"

  int_setting RETENTION_DAYS BACKUP_RETENTION_DAYS 30 0 36500
  int_setting KEEP_MIN BACKUP_KEEP_MIN 7 1 10000

  STORAGE_DIR_PATH=${BACKUP_STORAGE_DIR:-/app/storage}
  INCLUDE_STORAGE=1
  if [[ -n ${BACKUP_INCLUDE_STORAGE:-} ]] && ! is_on "$BACKUP_INCLUDE_STORAGE"; then INCLUDE_STORAGE=0; fi
  if ((INCLUDE_STORAGE)) && [[ ! -d $STORAGE_DIR_PATH || ! -r $STORAGE_DIR_PATH ]]; then
    die "pasta de arquivos $STORAGE_DIR_PATH não encontrada ou sem leitura (monte o volume uploads ou use BACKUP_INCLUDE_STORAGE=false)"
  fi

  case "${BACKUP_ENCRYPTION:-age}" in
    age)
      ENCRYPT=1
      require_cmd age
      age_setup_recipients
      ;;
    off)
      ENCRYPT=0
      warn "BACKUP_ENCRYPTION=off: o backup será gravado SEM cifragem, com certificados e documentos fiscais em claro"
      ;;
    *) die "BACKUP_ENCRYPTION deve ser 'age' ou 'off'" ;;
  esac

  store_setup
  ((${#BACKUP_DESTS[@]} > 0)) || die "nenhum destino configurado: defina BACKUP_S3_BUCKET (e as credenciais) ou BACKUP_LOCAL_DIR"
}

# server_version DESTINO NOME URL: grava em DESTINO a versão do servidor; falha cedo, com mensagem
# clara, se não conectar.
server_version() {
  local _out=$1 _name=$2 _url=$3 _version
  if ! _version=$(with_pg "$_url" psql -X -w -At -v ON_ERROR_STOP=1 -c 'show server_version' 2> "$WORK/psql.err"); then
    show_err "$WORK/psql.err"
    die "não foi possível conectar ao banco $_name"
  fi
  printf -v "$_out" '%s' "$_version"
}

# marker_check NOME URL TABELA: avisa se o banco não tem a tabela que o identifica (URLs trocadas
# ou banco ainda sem migrações). Só aviso: o backup nunca deixa de copiar o que existe.
marker_check() {
  local name=$1 url=$2 table=$3 found
  found=$(with_pg "$url" psql -X -w -At -c "select to_regclass('public.$table') is not null" 2> /dev/null) || found=''
  if [[ $found != t ]]; then warn "o banco $name não tem a tabela $table: confira se as URLs não estão trocadas"; fi
}

add_part() {
  local name=$1 file=$2 extra=${3:-'{}'}
  PARTS=$(jq -c --arg name "$name" --arg file "$file" --arg sha "$(sha256_of "$STAGE/$file")" \
    --argjson bytes "$(size_of "$STAGE/$file")" --argjson extra "$extra" \
    '. + [{name: $name, file: $file, bytes: $bytes, sha256: $sha} + $extra]' <<< "$PARTS")
}

dump_database() {
  local name=$1 url=$2 file=$3
  local -a st
  log "banco $name: pg_dump"
  : > "$WORK/age.err"
  set +e
  if ((ENCRYPT)); then
    with_pg "$url" pg_dump --no-password --format=custom 2> "$WORK/pg_dump.err" | age "${BACKUP_AGE_ARGS[@]}" -o "$STAGE/$file" 2> "$WORK/age.err"
    st=("${PIPESTATUS[@]}")
  else
    with_pg "$url" pg_dump --no-password --format=custom --file="$STAGE/$file" 2> "$WORK/pg_dump.err"
    st=("$?" 0)
  fi
  set -e
  show_err "$WORK/pg_dump.err"
  show_err "$WORK/age.err"
  ((st[0] == 0)) || die "pg_dump do banco $name falhou (código ${st[0]})"
  ((st[1] == 0)) || die "cifragem do dump do banco $name falhou (código ${st[1]})"
}

archive_storage() {
  local file=$1
  local -a st
  log "arquivos: tar de $STORAGE_DIR_PATH"
  : > "$WORK/age.err"
  set +e
  if ((ENCRYPT)); then
    tar --create --gzip --numeric-owner --directory="$STORAGE_DIR_PATH" --file=- . 2> "$WORK/tar.err" | age "${BACKUP_AGE_ARGS[@]}" -o "$STAGE/$file" 2> "$WORK/age.err"
    st=("${PIPESTATUS[@]}")
  else
    tar --create --gzip --numeric-owner --directory="$STORAGE_DIR_PATH" --file="$STAGE/$file" . 2> "$WORK/tar.err"
    st=("$?" 0)
  fi
  set -e
  show_err "$WORK/tar.err"
  show_err "$WORK/age.err"
  # 1 = algum arquivo mudou durante a leitura (a API continua gravando): a cópia vale, com aviso
  if ((st[0] == 1)); then
    warn "arquivos mudaram durante a cópia; os gravados depois do início entram no próximo backup"
  elif ((st[0] != 0)); then
    die "tar dos arquivos falhou (código ${st[0]})"
  fi
  ((st[1] == 0)) || die "cifragem dos arquivos falhou (código ${st[1]})"
}

# prune RAIZ: aplica a retenção em um destino. Devolve 1 se algo não pôde ser listado ou apagado.
prune() {
  local root=$1 complete all id failed=0
  complete=$(store_ids "$root" complete) || return 1
  all=$(store_ids "$root" all) || return 1
  while IFS= read -r id; do
    [[ -n $id ]] || continue
    if store_delete "$root" "$id"; then
      REMOVED=$((REMOVED + 1))
      log "retenção: backup $id removido"
    else
      show_err "$BACKUP_WORK/rclone.err"
      failed=1
    fi
  done < <(
    retention_select "$NOW" "$RETENTION_DAYS" "$KEEP_MIN" <<< "$complete"
    comm -23 <(printf '%s\n' "$all") <(printf '%s\n' "$complete") | stale_incomplete_select "$NOW" 24
  )
  return "$failed"
}

cmd_now() {
  local dest kind root suffix='' total=0 file office_version platform_version entries prune_failed=0 dests=''
  trap on_exit EXIT
  trap 'ERR_LINE=$LINENO' ERR

  require_cmd pg_dump psql tar gzip sha256sum jq rclone flock comm
  load_settings

  WORK=$(mktemp -d "${BACKUP_WORK_DIR:-/tmp}/verifco-backup.XXXXXX")
  BACKUP_WORK=$WORK
  STAGE=$WORK/stage
  mkdir "$STAGE"

  if state_writable; then
    exec 9> "$STATE_DIR/lock"
    flock -n 9 || die "já existe um backup em andamento"
  else
    warn "$STATE_DIR sem escrita: o resultado não será registrado para o healthcheck"
  fi

  NOW=$(date +%s)
  STARTED=$NOW
  ID=$(new_backup_id "$NOW")
  PARTS='[]'
  REMOVED=0
  if ((ENCRYPT)); then suffix=.age; fi
  log "backup $ID iniciado"

  server_version office_version escritórios "$DATABASE_URL"
  server_version platform_version plataforma "$PLATFORM_DATABASE_URL"
  marker_check escritórios "$DATABASE_URL" offices
  marker_check plataforma "$PLATFORM_DATABASE_URL" platform_users

  # Bancos antes dos arquivos: tudo o que os dumps citam já está no disco quando o tar começa.
  file=database.dump$suffix
  dump_database escritórios "$DATABASE_URL" "$file"
  add_part database "$file" "$(jq -n -c --arg v "$office_version" '{server_version: $v}')"

  file=platform.dump$suffix
  dump_database plataforma "$PLATFORM_DATABASE_URL" "$file"
  add_part platform "$file" "$(jq -n -c --arg v "$platform_version" '{server_version: $v}')"

  if ((INCLUDE_STORAGE)); then
    file=storage.tar.gz$suffix
    entries=$( (find "$STORAGE_DIR_PATH" -type f 2> /dev/null || true) | wc -l)
    archive_storage "$file"
    add_part storage "$file" "$(jq -n -c --argjson n "$entries" '{files: $n}')"
  else
    warn "arquivos fora deste backup (BACKUP_INCLUDE_STORAGE=false)"
  fi

  total=$(jq '[.[].bytes] | add' <<< "$PARTS")
  jq -n --arg id "$ID" --arg created "$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ)" \
    --arg commit "${APP_COMMIT:-}" --arg encryption "$( ((ENCRYPT)) && echo age || echo none)" \
    --arg pg_dump "$(pg_dump --version | awk '{print $3}')" --argjson parts "$PARTS" \
    '{format: 1, id: $id, created_at: $created, app_commit: (if $commit == "" then null else $commit end),
      encryption: $encryption, pg_dump_version: $pg_dump, parts: $parts}' > "$STAGE/manifest.json"

  for dest in "${BACKUP_DESTS[@]}"; do
    kind=${dest%%|*}
    root=${dest#*|}
    log "enviando para o destino $kind"
    if [[ $kind == local ]]; then mkdir -p "$root" || die "não foi possível criar BACKUP_LOCAL_DIR"; fi
    store_must "envio para o destino $kind" store_upload "$STAGE" "$root" "$ID"
    dests+="${dests:+,}$kind"
  done

  # O backup já está guardado e conferido: registra antes da limpeza.
  if state_writable; then
    printf '%s %s\n' "$(date +%s)" "$ID" > "$STATE_DIR/last-success"
    rm -f "$STATE_DIR/last-failure"
  fi

  for dest in "${BACKUP_DESTS[@]}"; do
    prune "${dest#*|}" || prune_failed=1
  done

  printf '%s OK id=%s partes=%s tamanho="%s" cifragem=%s destinos=%s removidos=%s duracao=%ss\n' \
    "$BACKUP_LOG_PREFIX" "$ID" "$(jq 'length' <<< "$PARTS")" "$(human_size "$total")" \
    "$( ((ENCRYPT)) && echo age || echo nenhuma)" "$dests" "$REMOVED" "$(($(date +%s) - STARTED))"

  if ((prune_failed)); then
    log "ERRO: o backup $ID foi enviado, mas a limpeza dos antigos falhou (confira a permissão de exclusão no destino ou use BACKUP_RETENTION_DAYS=0 com regra de ciclo de vida no bucket)"
    exit 3
  fi
}

# ---------------------------------------------------------------------------------------------
# Modo agendado (processo principal do container)
# ---------------------------------------------------------------------------------------------

CHILD=0
CHILD_IS_GROUP=0

on_stop() {
  log "parada solicitada"
  if ((CHILD > 0 && CHILD_IS_GROUP)); then
    kill -TERM -- "-$CHILD" 2> /dev/null || true
  elif ((CHILD > 0)); then
    kill "$CHILD" 2> /dev/null || true
  fi
  exit 0
}

# Espera interrompível: o `wait` devolve o controle na hora em que chega um sinal.
sleep_for() {
  sleep "$1" &
  CHILD=$!
  wait "$CHILD" || true
  CHILD=0
}

run_backup() {
  local code=0
  # sessão própria: na parada, o sinal alcança também o pg_dump, tar, age ou rclone em andamento
  setsid bash "$SELF" now &
  CHILD=$!
  CHILD_IS_GROUP=1
  wait "$CHILD" || code=$?
  CHILD=0
  CHILD_IS_GROUP=0
  # 3 = enviado, só a limpeza falhou: não adianta repetir o backup inteiro
  ((code == 0 || code == 3))
}

cmd_loop() {
  local hour retry pending=0 now target age remaining
  int_setting hour BACKUP_SCHEDULE_HOUR 3 0 23
  int_setting retry BACKUP_RETRY_MINUTES 60 1 1440
  require_cmd setsid
  trap on_stop TERM INT
  log "modo agendado: todos os dias às $(printf '%02d' "$hour"):00 (TZ=${TZ:-UTC})"

  case "${BACKUP_ON_START:-auto}" in
    always) pending=1 ;;
    never) pending=0 ;;
    auto)
      # primeira subida, ou container parado por mais de um dia: não espera a próxima madrugada
      if ! age=$(last_success_age "$(date +%s)") || ((age > 86400)); then pending=1; fi
      ;;
    *) die "BACKUP_ON_START deve ser auto, always ou never" ;;
  esac

  while true; do
    if ((pending)); then
      if run_backup; then
        pending=0
      else
        log "nova tentativa em $retry min"
        sleep_for "$((retry * 60))"
        continue
      fi
    fi
    now=$(date +%s)
    target=$(next_run_epoch "$now" "$hour")
    log "próximo backup: $(date -d "@$target" '+%Y-%m-%d %H:%M %Z')"
    while now=$(date +%s) && ((now < target)); do
      remaining=$((target - now))
      sleep_for "$((remaining < 600 ? remaining : 600))"
    done
    pending=1
  done
}

case "${1:-}" in
  now) cmd_now ;;
  loop) cmd_loop ;;
  health) cmd_health ;;
  -h | --help | help) usage ;;
  *)
    usage >&2
    exit 64
    ;;
esac
