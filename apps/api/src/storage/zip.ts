import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import type { FileService, FileRow } from './index';

/**
 * Teto da soma dos arquivos num .zip montado na hora para download (documentos, pacotes de
 * conferência, pré-preenchidas). A memória não depende mais do tamanho (o .zip sai em stream),
 * mas o download fica preso à requisição e ao navegador: acima disso, peça menos clientes.
 */
export const MAX_ZIP_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/** Nome da lista de arquivos que não estavam mais no armazenamento (ficaram fora do .zip). */
export const MISSING_FILES_NAME = 'ARQUIVOS-NAO-ENCONTRADOS.txt';

export interface ZipEntryOptions {
  /** Comprime a entrada (DEFLATE). Desligue para conteúdo já comprimido (ex.: .zip dentro de .zip). */
  compress?: boolean;
  /** Data de modificação gravada na entrada (padrão: agora). */
  mtime?: Date;
}

/** Caminho aceito no .zip: sem "", "." nem ".." nas pastas e sem ":" (o yazl recusa; e protege quem extrai). */
const entryPath = (name: string) =>
  name
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => (s === '' || s === '.' || s === '..' ? '_' : s.replace(/:/g, '_')))
    .join('/');

/**
 * .zip gerado em stream (yazl, com ZIP64 automático acima de 4 GB ou de 65.535 entradas).
 * As entradas entram uma de cada vez: `addStream` só volta depois que o conteúdo foi todo lido
 * para o .zip, que por sua vez só anda no ritmo de quem consome o `output` (disco ou resposta
 * HTTP). A memória fica limitada a alguns pedaços do arquivo atual, qualquer que seja o total.
 * Se o consumidor desistir (download cancelado) ou uma entrada falhar, o `output` termina com
 * erro, o arquivo em leitura é fechado e as próximas chamadas falham.
 */
export class ZipWriter {
  readonly output: Readable;
  private zip = new ZipFile();
  private current: Readable | null = null;
  private error: Error | null = null;

  constructor(private defaults: ZipEntryOptions = {}) {
    this.output = this.zip.outputStream as Readable;
    this.zip.on('error', (err: Error) => this.fail(err));
    this.output.on('error', (err) => this.fail(err));
    this.output.on('close', () => {
      if (!this.output.readableEnded) this.fail(new Error('A geração do .zip foi interrompida.'));
    });
  }

  /** Erro que interrompeu o .zip, se houve. */
  get failure() {
    return this.error;
  }

  private options(opts: ZipEntryOptions) {
    const o = { ...this.defaults, ...opts };
    return { compress: o.compress ?? true, ...(o.mtime ? { mtime: o.mtime } : {}) };
  }

  private fail(err: Error) {
    if (this.error) return;
    this.error = err;
    this.current?.destroy(err);
    if (!this.output.destroyed) this.output.destroy(err);
  }

  /** Acrescenta uma entrada lida de um stream e espera o conteúdo ir todo para o .zip. */
  async addStream(name: string, source: Readable, opts: ZipEntryOptions = {}) {
    if (this.error) {
      source.destroy();
      throw this.error;
    }
    // o yazl não escuta erro da origem: sem isto, um erro de leitura derrubaria o processo
    source.on('error', (err) => this.fail(err));
    this.current = source;
    try {
      this.zip.addReadStream(source, entryPath(name), this.options(opts));
      await finished(source);
    } catch (err) {
      source.destroy();
      throw this.error ?? err;
    } finally {
      this.current = null;
    }
    if (this.error) throw this.error;
  }

  /** Entrada pequena já em memória (LEIAME, manifesto, listas). */
  addBuffer(name: string, data: Buffer | string, opts: ZipEntryOptions = {}) {
    if (this.error) throw this.error;
    this.zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), entryPath(name), this.options(opts));
  }

  /** Fecha o .zip (diretório central); o `output` termina logo depois. */
  end() {
    if (this.error) throw this.error;
    this.zip.end();
  }

  /** Interrompe a geração: o `output` termina com o erro (a resposta é cortada, a gravação desfeita). */
  abort(err: Error) {
    this.fail(err);
  }
}

/** Arquivo gravado que entra num .zip de download, com o caminho dentro dele. */
export interface StoredZipEntry {
  path: string;
  file: Pick<FileRow, 'storageKey'> & { createdAt?: Date | null };
}

/**
 * .zip de arquivos gravados, montado enquanto é baixado (entregue com `sendStoredFile`). Valide
 * tudo antes (permissão, escopo, limite de tamanho) e chame por último: depois que a resposta
 * começa, um erro só corta o download. Arquivo que não existe mais no armazenamento fica de fora
 * e é listado em ARQUIVOS-NAO-ENCONTRADOS.txt dentro do próprio .zip.
 */
export function zipStoredFiles(files: FileService, entries: StoredZipEntry[], opts: Pick<ZipEntryOptions, 'compress'> = {}): Readable {
  const zip = new ZipWriter(opts);
  const run = async () => {
    const missing: string[] = [];
    for (const e of entries) {
      let source: Readable;
      try {
        source = await files.stream(e.file);
      } catch {
        missing.push(e.path);
        continue;
      }
      await zip.addStream(e.path, source, { mtime: e.file.createdAt ?? undefined });
    }
    if (missing.length) {
      zip.addBuffer(MISSING_FILES_NAME, `Estes arquivos não foram encontrados no armazenamento do Verifco e ficaram fora do .zip:\r\n${missing.map((p) => `- ${p}`).join('\r\n')}\r\n`);
    }
    zip.end();
  };
  run().catch((err: Error) => zip.abort(err));
  return zip.output;
}
