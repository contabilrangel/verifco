/**
 * .zip montado em fluxo, para downloads e backup de qualquer tamanho sem carregar os arquivos
 * na memória.
 *
 * Usa o `yazl` (uma dependência só, `buffer-crc32`): escreve o .zip à medida que lê cada entrada,
 * com ZIP64 automático (arquivos ou .zip acima de 4 GB, mais de 65.535 entradas). O JSZip, usado
 * antes, monta tudo na memória (`generateAsync`) e não grava ZIP64; o `generateNodeStream` dele
 * continua guardando o conteúdo de todas as entradas até o fim. O `archiver` faria o mesmo que o
 * yazl, mas traz uma árvore de dependências bem maior (glob, lazystream, tar-stream, zip-stream...).
 *
 * Os arquivos gravados entram um de cada vez (um só aberto por vez): cada um é aberto antes de ir
 * para o .zip, e o que sumiu do armazenamento fica de fora e é listado em `missing`.
 */
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import type { AppContext } from '../context';
import type { FileRow } from '../storage';
import { HttpError } from '../lib/errors';

/** Teto dos .zip montados numa requisição (documentos, pré-preenchidas, pacotes de conferência). */
export const ZIP_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

/** Recusa (413) um .zip de download acima do teto, antes de começar a enviar. */
export function assertZipSize(totalBytes: number, hint = 'Selecione menos clientes.') {
  if (totalBytes > ZIP_DOWNLOAD_MAX_BYTES) {
    throw new HttpError(413, `Os arquivos somam ${Math.ceil(totalBytes / (1024 * 1024)).toLocaleString('pt-BR')} MB e passam do limite de 1 GB por download. ${hint}`);
  }
}

export class ZipStream {
  private zip = new ZipFile();
  /** Conteúdo do .zip; entregue com `reply.send(output)` ou grave com `files.saveStream`. */
  readonly output: Readable;
  /** Arquivos gravados que não foram encontrados no armazenamento (ficaram de fora). */
  readonly missing: string[] = [];
  private closed: Promise<never>;
  private mtime = new Date();

  constructor() {
    this.output = this.zip.outputStream as unknown as Readable;
    this.zip.on('error', (err: Error) => this.output.destroy(err));
    // o erro chega a quem consome (download ou gravação); sem ouvinte ainda, não derruba o processo
    this.output.on('error', () => undefined);
    // quem lê o .zip desistiu (download cancelado) ou deu erro: para de produzir
    this.closed = new Promise<never>((_, reject) => {
      this.output.once('close', () => reject(new Error('A geração do .zip foi interrompida.')));
    });
    this.closed.catch(() => undefined);
  }

  /** Entrada pequena montada na memória (LEIA-ME, manifesto). */
  addBuffer(path: string, data: Buffer | string) {
    this.zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), path, { mtime: this.mtime });
  }

  /** Entrada lida de um fluxo; só retorna quando o fluxo foi todo consumido (mantém um aberto por vez). */
  async addStream(path: string, stream: Readable) {
    this.zip.addReadStream(stream, path, { mtime: this.mtime });
    try {
      await Promise.race([finished(stream), this.closed]);
    } catch (err) {
      stream.destroy();
      throw err;
    }
  }

  /** Arquivo gravado (linha de `files` já lida); se sumiu do armazenamento, fica de fora e entra em `missing`. */
  async addStoredFile(ctx: AppContext, row: Pick<FileRow, 'storageKey'>, path: string): Promise<boolean> {
    return this.addOpened(path, () => ctx.files.openRow(row));
  }

  /** Arquivo gravado do escritório, pelo id; se não existe mais, fica de fora e entra em `missing`. */
  async addFile(ctx: AppContext, officeId: string, fileId: string, path: string): Promise<boolean> {
    return this.addOpened(path, async () => (await ctx.files.open(officeId, fileId)).stream);
  }

  private async addOpened(path: string, open: () => Promise<Readable>): Promise<boolean> {
    let stream: Readable;
    try {
      stream = await open();
    } catch {
      this.missing.push(path);
      return false;
    }
    await this.addStream(path, stream);
    return true;
  }

  /** Fecha o .zip (com a lista dos arquivos não encontrados, se houver). */
  end(missingNote?: string) {
    if (this.missing.length && missingNote) {
      this.addBuffer('ARQUIVOS-NAO-ENCONTRADOS.txt', `${missingNote}\r\n\r\n${this.missing.join('\r\n')}\r\n`);
    }
    this.zip.end();
  }

  /** Interrompe a geração com erro (o download é cortado; o backup falha e é refeito). */
  abort(err: unknown) {
    this.output.destroy(err instanceof Error ? err : new Error(String(err)));
  }

  /**
   * Roda o produtor em segundo plano (ele acrescenta as entradas e chama `end`), para entregar o
   * `output` já: os arquivos são lidos à medida que o cliente baixa.
   */
  produce(producer: (zip: ZipStream) => Promise<void>, onError?: (err: unknown) => void): Readable {
    producer(this).catch((err) => {
      onError?.(err);
      this.abort(err);
    });
    return this.output;
  }
}

/** Nome de entrada único dentro do .zip (acrescenta " (2)", " (3)"... antes da extensão). */
export function uniqueZipPath(used: Set<string>, folder: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const prefix = folder ? `${folder}/` : '';
  let path = `${prefix}${name}`;
  for (let n = 2; used.has(path.toLowerCase()); n++) path = `${prefix}${stem} (${n})${ext}`;
  used.add(path.toLowerCase());
  return path;
}
