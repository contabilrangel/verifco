# Imagem do serviço opcional de backup (perfil `backup` dos dois Composes). Uso: docs/RESTAURACAO.md.
# Contexto de build: a pasta deploy/.
#
# Base: a mesma imagem dos bancos. O pg_dump precisa ser da versão do servidor ou mais novo, e o
# pg_restore de uma versão principal mais nova gera comandos que o servidor 16 recusa; com a mesma
# imagem os dois lados andam juntos. Ao subir a versão do PostgreSQL, suba aqui também.
ARG POSTGRES_MAJOR=16
FROM postgres:${POSTGRES_MAJOR}-bookworm

# age: cifragem com chave pública (a VM não guarda nada capaz de abrir os backups).
# rclone: envio para qualquer serviço compatível com S3 e para pasta local, com os mesmos comandos.
# Usuário com o mesmo UID do `node` da API (1000): lê tudo o que ela grava no volume uploads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends age rclone jq ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 verifco \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash verifco \
    && mkdir -p /opt/verifco-backup /var/lib/verifco-backup /backups \
    && chown verifco:verifco /var/lib/verifco-backup /backups

COPY backup-lib.sh backup.sh restore.sh /opt/verifco-backup/
RUN chmod 0755 /opt/verifco-backup/backup.sh /opt/verifco-backup/restore.sh \
    && ln -s /opt/verifco-backup/backup.sh /usr/local/bin/backup.sh \
    && ln -s /opt/verifco-backup/restore.sh /usr/local/bin/restore.sh

ENV TZ=America/Sao_Paulo \
    BACKUP_STATE_DIR=/var/lib/verifco-backup

USER verifco
WORKDIR /home/verifco
# a imagem base inicia um servidor PostgreSQL; aqui só os clientes são usados
ENTRYPOINT []
CMD ["backup.sh", "loop"]
