#!/usr/bin/env bash
# Executado apenas na stack descartável de CI (job containers), nunca no Dokploy de produção.
# Exercita o serviço opcional de backup (perfil `backup`) com a imagem e as redes reais:
#   backup   backup avulso cifrado no volume local, com um par de chaves age gerado na hora
#   check    restore.sh --list e --check (download, sha256 e decifragem, sem restaurar)
#   restore  restauração em dois bancos novos e em uma pasta, com conferência do resultado
# O procedimento de produção está em docs/RESTAURACAO.md.
set -euo pipefail

# a chave privada descartável fica no volume de estado do próprio serviço (nada no runner)
KEY=/var/lib/verifco-backup/ci-age.key
PROBE=ci-backup-probe.txt

backup_run() { docker compose --profile backup run --rm --no-deps -T "$@"; }
fail() {
  echo "$*" >&2
  exit 1
}

case "${1:-}" in
  backup)
    backup_run backup age-keygen -o "$KEY"
    recipient=$(backup_run backup age-keygen -y "$KEY" | tr -d '\r\n')
    [[ $recipient == age1* ]] || fail 'Chave pública age não gerada'
    # arquivo conhecido no volume uploads, para conferir a restauração dos arquivos
    docker compose exec -T api sh -c "echo verifco-ci > /app/storage/$PROBE"

    echo '--- sem chave pública o backup precisa recusar (o erro abaixo é esperado)'
    if backup_run -e BACKUP_LOCAL_DIR=/backups backup backup.sh now; then
      fail 'O backup rodou sem chave de cifragem'
    fi
    echo '--- backup cifrado'
    summary=$(backup_run -e BACKUP_LOCAL_DIR=/backups -e BACKUP_AGE_RECIPIENT="$recipient" -e APP_COMMIT="${GITHUB_SHA:-}" \
      backup backup.sh now)
    echo "$summary"
    grep -q ' OK id=.* partes=3 .* cifragem=age ' <<< "$summary" || fail 'Resumo do backup inesperado'
    backup_run backup backup.sh health
    ;;

  check)
    backup_run -e BACKUP_LOCAL_DIR=/backups backup restore.sh --list
    backup_run -e BACKUP_LOCAL_DIR=/backups -e BACKUP_AGE_IDENTITY_FILE="$KEY" backup restore.sh --check latest
    ;;

  restore)
    office_target="postgres://verifco:${POSTGRES_PASSWORD}@postgres:5432/verifco_restore_ci"
    platform_target="postgres://verifco_platform:${PLATFORM_POSTGRES_PASSWORD}@postgres-platform:5432/verifco_platform_restore_ci"
    office_sql() { docker compose exec -T postgres psql -X -U verifco -d "$1" -At -c "$2" | tr -d '\r'; }
    platform_sql() { docker compose exec -T postgres-platform psql -X -U verifco_platform -d "$1" -At -c "$2" | tr -d '\r'; }
    tables="select count(*) from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')"

    echo '--- destino igual ao banco em uso precisa ser recusado (o erro abaixo é esperado)'
    if backup_run -e BACKUP_LOCAL_DIR=/backups -e BACKUP_AGE_IDENTITY_FILE="$KEY" \
      -e TARGET_DATABASE_URL="$DATABASE_URL" backup restore.sh latest; then
      fail 'A restauração aceitou o banco em uso como destino'
    fi

    echo '--- restauração em bancos novos'
    docker compose exec -T postgres createdb -U verifco verifco_restore_ci
    docker compose exec -T postgres-platform createdb -U verifco_platform verifco_platform_restore_ci
    backup_run -e BACKUP_LOCAL_DIR=/backups -e BACKUP_AGE_IDENTITY_FILE="$KEY" \
      -e TARGET_DATABASE_URL="$office_target" -e TARGET_PLATFORM_DATABASE_URL="$platform_target" \
      -e TARGET_STORAGE_DIR=/tmp/verifco-restore \
      backup bash -c "restore.sh latest && grep -qx verifco-ci /tmp/verifco-restore/$PROBE"

    [[ $(office_sql verifco_restore_ci "select to_regclass('public.offices') is not null and to_regclass('public.platform_users') is null") == t ]] ||
      fail 'Banco dos escritórios restaurado sem offices ou com tabelas da plataforma'
    [[ $(platform_sql verifco_platform_restore_ci "select to_regclass('public.platform_users') is not null and to_regclass('public.offices') is null") == t ]] ||
      fail 'Banco da plataforma restaurado sem platform_users ou com tabelas dos escritórios'
    [[ $(office_sql verifco_restore_ci "$tables") == "$(office_sql verifco "$tables")" ]] ||
      fail 'Banco dos escritórios restaurado com número de tabelas diferente do original'
    [[ $(platform_sql verifco_platform_restore_ci "$tables") == "$(platform_sql verifco_platform "$tables")" ]] ||
      fail 'Banco da plataforma restaurado com número de tabelas diferente do original'
    [[ $(platform_sql verifco_platform_restore_ci 'select count(*) from platform_users') == "$(platform_sql verifco_platform 'select count(*) from platform_users')" ]] ||
      fail 'Contas da plataforma restauradas em número diferente do original'

    echo '--- segunda restauração no mesmo destino precisa ser recusada sem --force (o erro abaixo é esperado)'
    if backup_run -e BACKUP_LOCAL_DIR=/backups -e BACKUP_AGE_IDENTITY_FILE="$KEY" \
      -e TARGET_DATABASE_URL="$office_target" backup restore.sh latest; then
      fail 'A restauração aceitou um banco de destino com dados sem --force'
    fi
    echo 'Backup restaurado e conferido em bancos novos'
    ;;

  *) fail 'Uso: backup-restore.sh backup|check|restore' ;;
esac
