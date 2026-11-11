#!/usr/bin/env bash
# Funções comuns de backup.sh e restore.sh. Carregado com `source`; sozinho não executa nada.
# As funções puras (retenção, agenda, URLs, mascaramento) têm testes em deploy/test/.
# shellcheck shell=bash

BACKUP_LOG_PREFIX=${BACKUP_LOG_PREFIX:-[verifco-backup]}
# Valores que nunca podem aparecer na saída (senhas dos bancos, chave secreta do bucket).
BACKUP_SECRETS=()
# Nome do remoto do rclone, definido só por variáveis de ambiente (nenhum arquivo com credenciais).
BACKUP_RCLONE_REMOTE=verifcobackup

log() { printf '%s %s %s\n' "$BACKUP_LOG_PREFIX" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; }
warn() { log "AVISO: $*"; }
die() {
  BACKUP_DIED=1
  log "ERRO: $*"
  exit 1
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" > /dev/null 2>&1 || die "comando '$cmd' não encontrado (use a imagem de deploy/backup.Dockerfile)"
  done
}

is_on() {
  case "${1,,}" in
    1 | true | sim | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

# int_setting DESTINO NOME PADRÃO MÍNIMO MÁXIMO: valida o inteiro da variável de ambiente NOME e
# grava em DESTINO (sem subshell, para o erro encerrar o script com uma mensagem só).
int_setting() {
  local _out=$1 _name=$2 _default=$3 _min=$4 _max=$5 _raw
  _raw=${!_name:-$_default}
  [[ $_raw =~ ^[0-9]+$ ]] || die "$_name deve ser um número inteiro entre $_min e $_max"
  _raw=$((10#$_raw))
  ((_raw >= _min && _raw <= _max)) || die "$_name deve ficar entre $_min e $_max"
  printf -v "$_out" '%s' "$_raw"
}

human_size() {
  awk -v b="$1" 'BEGIN {
    split("B KiB MiB GiB TiB", unit, " "); i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    if (i == 1) printf "%d %s\n", b, unit[i]; else printf "%.1f %s\n", b, unit[i]
  }'
}

sha256_of() { sha256sum -- "$1" | cut -d ' ' -f 1; }
size_of() { stat -c %s -- "$1"; }

# ---------------------------------------------------------------------------------------------
# Saída sem segredos
# ---------------------------------------------------------------------------------------------

# add_secret VALOR: registra um valor para o mascaramento (curtos demais mutilariam a saída).
add_secret() {
  if [[ ${#1} -ge 4 ]]; then BACKUP_SECRETS+=("$1"); fi
}

# Filtro: troca os segredos registrados e as credenciais de qualquer URL (esquema://usuario:senha@).
redact() {
  local line secret
  while IFS= read -r line || [[ -n $line ]]; do
    for secret in ${BACKUP_SECRETS[@]+"${BACKUP_SECRETS[@]}"}; do
      line=${line//"$secret"/[oculto]}
    done
    printf '%s\n' "$line"
  done | sed -E 's#([A-Za-z][A-Za-z0-9+.-]*://)[^[:space:]/@]+@#\1[oculto]@#g'
}

# show_err ARQUIVO: repassa o stderr capturado de um comando externo, já mascarado.
show_err() {
  if [[ -s $1 ]]; then redact < "$1" >&2; fi
}

# ---------------------------------------------------------------------------------------------
# Conexões PostgreSQL (mesmo formato de DATABASE_URL usado pela API)
# ---------------------------------------------------------------------------------------------

# Decodifica %XX: senhas com caracteres reservados chegam codificadas na URL.
urldecode() {
  local s=${1//\\/\\\\}
  printf '%b' "${s//%/\\x}"
}

# pg_parse_url URL → PGU_USER, PGU_PASSWORD, PGU_HOST, PGU_PORT, PGU_DBNAME e PGU_ENV (parâmetros
# da URL convertidos em variáveis do libpq). Devolve 1, com o motivo em PGU_ERROR, se não entender.
# A URL nunca vai para a linha de comando dos clientes: senha em argv aparece em `ps`/`docker top`.
pg_parse_url() {
  local url=$1 re user password host port dbname query pair key value
  local -a pairs=()
  PGU_USER='' PGU_PASSWORD='' PGU_HOST='' PGU_PORT='' PGU_DBNAME='' PGU_ERROR=''
  PGU_ENV=()
  re='^[Pp][Oo][Ss][Tt][Gg][Rr][Ee][Ss]([Qq][Ll])?://(([^:@/?#]*)(:([^@/?#]*))?@)?(\[[0-9A-Fa-f:.]+\]|[^]:/?#@[]*)(:([0-9]+))?(/([^/?#]*))?(\?([^#]*))?$'
  if [[ ! $url =~ $re ]]; then
    PGU_ERROR='use postgres://usuario:senha@host:porta/banco (senha com caracteres especiais codificada em %XX)'
    return 1
  fi
  user=${BASH_REMATCH[3]} password=${BASH_REMATCH[5]} host=${BASH_REMATCH[6]}
  port=${BASH_REMATCH[8]} dbname=${BASH_REMATCH[10]} query=${BASH_REMATCH[12]}
  host=${host#[}
  host=${host%]}
  PGU_USER=$(urldecode "$user")
  PGU_PASSWORD=$(urldecode "$password")
  PGU_HOST=${host,,}
  PGU_PORT=${port:-5432}
  PGU_DBNAME=$(urldecode "$dbname")
  # como no libpq: sem nome de banco, vale o nome do usuário
  if [[ -z $PGU_DBNAME ]]; then PGU_DBNAME=$PGU_USER; fi
  if [[ -z $PGU_DBNAME ]]; then
    PGU_ERROR='a URL não informa o banco'
    return 1
  fi
  if [[ -n $query ]]; then IFS='&' read -r -a pairs <<< "$query"; fi
  for pair in ${pairs[@]+"${pairs[@]}"}; do
    [[ -n $pair ]] || continue
    key=${pair%%=*}
    value=''
    if [[ $pair == *=* ]]; then value=$(urldecode "${pair#*=}"); fi
    case "$key" in
      sslmode) PGU_ENV+=("PGSSLMODE=$value") ;;
      sslrootcert) PGU_ENV+=("PGSSLROOTCERT=$value") ;;
      sslcert) PGU_ENV+=("PGSSLCERT=$value") ;;
      sslkey) PGU_ENV+=("PGSSLKEY=$value") ;;
      connect_timeout) PGU_ENV+=("PGCONNECT_TIMEOUT=$value") ;;
      application_name) PGU_ENV+=("PGAPPNAME=$value") ;;
      options) PGU_ENV+=("PGOPTIONS=$value") ;;
      channel_binding) PGU_ENV+=("PGCHANNELBINDING=$value") ;;
      target_session_attrs) PGU_ENV+=("PGTARGETSESSIONATTRS=$value") ;;
      # forma do driver do Node (`pg`), que a API aceita
      ssl) if is_on "$value"; then PGU_ENV+=("PGSSLMODE=require"); fi ;;
      host | port | user | dbname | database | password)
        PGU_ERROR='informe host, porta, usuário e banco diretamente na URL, não em parâmetros'
        return 1
        ;;
      *)
        PGU_ERROR="parâmetro '$key' da URL não é suportado pelo backup"
        return 1
        ;;
    esac
  done
  return 0
}

# pg_identity URL → "host:porta/banco" normalizado, para comparar destinos sem expor credenciais
# (mesma ideia de assertSeparateDatabases em apps/api/src/config.ts).
pg_identity() {
  local host
  pg_parse_url "$1" || return 1
  host=${PGU_HOST%.}
  case "$host" in
    localhost | 127.0.0.1 | ::1 | '') host=loopback ;;
  esac
  printf '%s:%s/%s\n' "$host" "$PGU_PORT" "$PGU_DBNAME"
}

# with_pg URL COMANDO...: roda o comando com a conexão nas variáveis PG* do libpq.
with_pg() {
  local url=$1 kv
  shift
  (
    pg_parse_url "$url" || exit 64
    unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSSLMODE PGOPTIONS
    export PGPORT=$PGU_PORT PGDATABASE=$PGU_DBNAME
    export PGCONNECT_TIMEOUT=${BACKUP_PG_CONNECT_TIMEOUT:-15} PGAPPNAME=verifco-backup
    if [[ -n $PGU_HOST ]]; then export PGHOST=$PGU_HOST; fi
    if [[ -n $PGU_USER ]]; then export PGUSER=$PGU_USER; fi
    if [[ -n $PGU_PASSWORD ]]; then export PGPASSWORD=$PGU_PASSWORD; fi
    for kv in ${PGU_ENV[@]+"${PGU_ENV[@]}"}; do export "${kv?}"; done
    "$@"
  )
}

# ---------------------------------------------------------------------------------------------
# Identificadores, retenção e agenda (funções puras)
# ---------------------------------------------------------------------------------------------

# Um backup é uma pasta AAAAMMDDTHHMMSSZ (UTC): a ordem alfabética é a cronológica.
new_backup_id() { date -u -d "@$1" +%Y%m%dT%H%M%SZ; }

# backup_id_epoch ID → segundos desde 1970; devolve 1 se o nome não for de um backup.
backup_id_epoch() {
  local re='^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$'
  [[ $1 =~ $re ]] || return 1
  date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s 2> /dev/null
}

valid_backup_id() { backup_id_epoch "$1" > /dev/null; }

# retention_select AGORA DIAS MANTER_MIN (ids completos no stdin, um por linha) → ids a apagar.
# Apaga o que passou de DIAS, mas os MANTER_MIN mais novos ficam sempre, por mais velhos que
# sejam: se o backup parar de rodar, a limpeza não consome as últimas cópias. DIAS=0 não apaga
# nada (retenção por regra de ciclo de vida do próprio bucket). Nomes fora do padrão são ignorados.
retention_select() {
  local now=$1 days=$2 keep=$3 cutoff id epoch kept=0
  if ((days <= 0)); then return 0; fi
  cutoff=$((now - days * 86400))
  while IFS= read -r id; do
    epoch=$(backup_id_epoch "$id") || continue
    kept=$((kept + 1))
    if ((kept > keep && epoch < cutoff)); then printf '%s\n' "$id"; fi
  done < <(sort -r -u)
  return 0
}

# stale_incomplete_select AGORA HORAS (ids sem manifesto no stdin) → ids a apagar.
# Envio interrompido não tem manifest.json; só é apagado depois de HORAS, para nunca remover um
# envio que ainda está em andamento.
stale_incomplete_select() {
  local now=$1 hours=$2 id epoch
  while IFS= read -r id; do
    epoch=$(backup_id_epoch "$id") || continue
    if ((epoch < now - hours * 3600)); then printf '%s\n' "$id"; fi
  done
  return 0
}

# next_run_epoch AGORA HORA → instante da próxima HORA:00 no fuso de TZ, sempre depois de AGORA.
next_run_epoch() {
  local now=$1 hour day target noon
  hour=$(printf '%02d' "$((10#$2))")
  day=$(date -d "@$now" +%F)
  target=$(date -d "$day $hour:00:00" +%s 2> /dev/null) || target=0
  if ((target <= now)); then
    noon=$(date -d "$day 12:00:00" +%s)
    day=$(date -d "@$((noon + 86400))" +%F)
    target=$(date -d "$day $hour:00:00" +%s 2> /dev/null) || target=$((now + 86400))
  fi
  printf '%s\n' "$target"
}

# ---------------------------------------------------------------------------------------------
# Cifragem (age)
# ---------------------------------------------------------------------------------------------

# age_setup_recipients: valida BACKUP_AGE_RECIPIENT e monta BACKUP_AGE_ARGS (-r chave ...).
# Aceita mais de uma chave pública, separadas por vírgula (ex.: titular e contingência).
age_setup_recipients() {
  local -a list=()
  local item
  BACKUP_AGE_ARGS=()
  IFS=',' read -r -a list <<< "${BACKUP_AGE_RECIPIENT:-}"
  for item in ${list[@]+"${list[@]}"}; do
    item=${item#"${item%%[![:space:]]*}"}
    item=${item%"${item##*[![:space:]]}"}
    [[ -n $item ]] || continue
    if [[ $item == AGE-SECRET-KEY-* ]]; then
      die "BACKUP_AGE_RECIPIENT recebeu uma chave PRIVADA. Use a chave pública (age1...); a privada fica fora da VM e, se foi salva no ambiente, considere-a exposta e gere outro par"
    fi
    BACKUP_AGE_ARGS+=(-r "$item")
  done
  if ((${#BACKUP_AGE_ARGS[@]} == 0)); then
    die "defina BACKUP_AGE_RECIPIENT com a chave pública age (age1...). O backup contém certificados e documentos fiscais e não roda sem cifragem; BACKUP_ENCRYPTION=off assume esse risco de forma explícita"
  fi
  if ! age "${BACKUP_AGE_ARGS[@]}" -o /dev/null < /dev/null 2> /dev/null; then
    die "BACKUP_AGE_RECIPIENT não é uma chave pública age válida (esperado: age1...)"
  fi
}

# ---------------------------------------------------------------------------------------------
# Destinos (rclone)
#
# Por que rclone e não aws-cli: um binário só, sem Python; fala com qualquer serviço compatível
# com S3 (AWS, R2, B2, Wasabi, MinIO, Oracle) com a mesma configuração; e o destino local
# (BACKUP_LOCAL_DIR) usa exatamente os mesmos comandos, então o CI exercita o caminho de produção.
# ---------------------------------------------------------------------------------------------

# store_setup: lê o ambiente e monta BACKUP_DESTS=("s3|remoto:bucket/prefixo" "local|/pasta").
store_setup() {
  local prefix remote
  BACKUP_DESTS=()
  if [[ -n ${BACKUP_S3_BUCKET:-} ]]; then
    if [[ -z ${BACKUP_S3_ACCESS_KEY_ID:-} || -z ${BACKUP_S3_SECRET_ACCESS_KEY:-} ]]; then
      die "BACKUP_S3_BUCKET exige BACKUP_S3_ACCESS_KEY_ID e BACKUP_S3_SECRET_ACCESS_KEY"
    fi
    if [[ ! $BACKUP_S3_BUCKET =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
      die "BACKUP_S3_BUCKET deve ser só o nome do bucket (o caminho vai em BACKUP_S3_PREFIX)"
    fi
    add_secret "$BACKUP_S3_SECRET_ACCESS_KEY"
    export RCLONE_CONFIG_VERIFCOBACKUP_TYPE=s3
    export RCLONE_CONFIG_VERIFCOBACKUP_ENV_AUTH=false
    export RCLONE_CONFIG_VERIFCOBACKUP_ACCESS_KEY_ID=$BACKUP_S3_ACCESS_KEY_ID
    export RCLONE_CONFIG_VERIFCOBACKUP_SECRET_ACCESS_KEY=$BACKUP_S3_SECRET_ACCESS_KEY
    # chaves restritas ao prefixo não podem criar nem consultar o bucket: ele já existe
    export RCLONE_CONFIG_VERIFCOBACKUP_NO_CHECK_BUCKET=true
    if [[ -n ${BACKUP_S3_ENDPOINT:-} ]]; then
      export RCLONE_CONFIG_VERIFCOBACKUP_PROVIDER=${BACKUP_S3_PROVIDER:-Other}
      export RCLONE_CONFIG_VERIFCOBACKUP_ENDPOINT=$BACKUP_S3_ENDPOINT
      export RCLONE_CONFIG_VERIFCOBACKUP_FORCE_PATH_STYLE=${BACKUP_S3_FORCE_PATH_STYLE:-true}
    else
      export RCLONE_CONFIG_VERIFCOBACKUP_PROVIDER=${BACKUP_S3_PROVIDER:-AWS}
    fi
    if [[ -n ${BACKUP_S3_REGION:-} ]]; then export RCLONE_CONFIG_VERIFCOBACKUP_REGION=$BACKUP_S3_REGION; fi
    prefix=${BACKUP_S3_PREFIX:-verifco}
    prefix=${prefix#/}
    prefix=${prefix%/}
    remote="$BACKUP_RCLONE_REMOTE:$BACKUP_S3_BUCKET"
    if [[ -n $prefix ]]; then remote="$remote/$prefix"; fi
    BACKUP_DESTS+=("s3|$remote")
  fi
  if [[ -n ${BACKUP_LOCAL_DIR:-} ]]; then
    [[ $BACKUP_LOCAL_DIR == /* ]] || die "BACKUP_LOCAL_DIR deve ser um caminho absoluto"
    BACKUP_DESTS+=("local|${BACKUP_LOCAL_DIR%/}")
  fi
  return 0
}

# rclone_run ARGS...: roda o rclone com um arquivo de configuração vazio (o remoto vem do ambiente)
# e guarda o stderr em $BACKUP_WORK/rclone.err para ser mostrado mascarado por quem chamou.
rclone_run() {
  : >> "$BACKUP_WORK/rclone.conf"
  rclone --config "$BACKUP_WORK/rclone.conf" "$@" 2> "$BACKUP_WORK/rclone.err"
}

# store_ids RAIZ complete|all → ids (ordem crescente) com manifest.json, ou todas as pastas de backup.
store_ids() {
  local root=$1 kind=$2 out status=0
  if [[ $kind == complete ]]; then
    out=$(rclone_run lsf -R --files-only --include '/*/manifest.json' "$root") || status=$?
  else
    out=$(rclone_run lsf --dirs-only "$root") || status=$?
  fi
  # 3 = pasta ou prefixo inexistente: ainda não há backups
  if ((status == 3)); then return 0; fi
  if ((status != 0)); then
    show_err "$BACKUP_WORK/rclone.err"
    return 1
  fi
  printf '%s\n' "$out" | sed -n -E 's#^([0-9]{8}T[0-9]{6}Z)/(manifest\.json)?$#\1#p' | sort -u
}

# store_upload ESTÁGIO RAIZ ID: as partes primeiro e o manifesto por último (pasta sem manifesto é
# envio incompleto e nunca conta como backup); depois confere nomes e tamanhos no destino.
store_upload() {
  local stage=$1 root=$2 id=$3
  rclone_run copy --exclude manifest.json "$stage" "$root/$id" || return 1
  rclone_run copy "$stage/manifest.json" "$root/$id" || return 1
  rclone_run check --one-way --size-only "$stage" "$root/$id" || return 1
}

store_download() { rclone_run copy "$1/$2" "$3"; }
store_delete() { rclone_run purge "$1/$2"; }
store_manifest() { rclone_run cat "$1/$2/manifest.json"; }
