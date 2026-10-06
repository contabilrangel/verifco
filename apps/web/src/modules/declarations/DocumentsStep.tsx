import { useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Eye, File as FileIcon, FileArchive, FileImage, FileSpreadsheet, FileText, FolderOpen, Trash2 } from 'lucide-react';
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LIST, documentCategoryLabel, documentOriginLabel } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, DropFile, EmptyState, IconButton, Loading, Select, Tag, useToast, type Tone } from '../../ds';
import { api, errorMessage, isViewableType } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { declarationKey, formatBytes } from './data';
import './declarations.css';

interface DocumentRow {
  id: string;
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  category: string;
  uploadedBy: string;
  processingStatus: string;
  exerciseYear: number | null;
  createdAt: string;
}

const CATEGORY_OPTIONS = DOCUMENT_CATEGORY_LIST.map((value) => ({ value, label: DOCUMENT_CATEGORIES[value] }));
const ORIGIN_TONE: Record<string, Tone> = { office: 'primary', customer: 'highlight', sync: 'neutral' };

const iconFor = (mime: string, name: string) => {
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return <FileText />;
  if (mime.startsWith('image/')) return <FileImage />;
  if (/sheet|excel|csv/.test(mime) || /\.(xlsx?|csv)$/i.test(name)) return <FileSpreadsheet />;
  if (/zip|compressed/.test(mime) || /\.zip$/i.test(name)) return <FileArchive />;
  return <FileIcon />;
};

/** Etapa "Documentos": arquivos do cliente no exercício. */
export function DocumentsStep() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [category, setCategory] = useState('other');
  const [uploading, setUploading] = useState(false);
  const [remove, setRemove] = useState<DocumentRow | null>(null);
  const [zipping, setZipping] = useState(false);
  const q = useApi<DocumentRow[]>(['documents', customer.id, year], `/customers/${customer.id}/documents?year=${year}`);
  const canEdit = can('declaration.edit');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['documents', customer.id] });

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const saved = await api.upload<DocumentRow[]>(`/customers/${customer.id}/documents?year=${year}`, files, { category });
      toast.success(`${saved.length} arquivo(s) enviado(s).`);
      refresh();
      void qc.invalidateQueries({ queryKey: declarationKey(customer.id, year) });
    } catch (err) {
      toast.error(errorMessage(err, 'Não foi possível enviar os arquivos.'));
    } finally {
      setUploading(false);
    }
  };
  const changeCategory = useAction((v: { id: string; category: string }) => api.patch(`/documents/${v.id}`, { category: v.category }), { success: 'Categoria atualizada.', onSuccess: refresh });
  const del = useAction((d: DocumentRow) => api.del(`/documents/${d.id}`), { success: 'Arquivo excluído.', onSuccess: () => (setRemove(null), refresh()) });
  const zip = async () => {
    setZipping(true);
    try {
      await api.download('/documents/zip', `documentos-${year}.zip`, { customerIds: [customer.id], year });
    } catch (err) {
      toast.error(errorMessage(err, 'Não foi possível gerar o .zip.'));
    } finally {
      setZipping(false);
    }
  };

  const rows = q.data ?? [];
  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as CSSProperties}>
      {canEdit && (
        <Card
          title="Enviar arquivos"
          actions={
            <span className="vf-inline" style={{ flexWrap: 'nowrap' }}>
              <label className="vf-field__label" htmlFor="doc-category">
                Categoria
              </label>
              <Select id="doc-category" value={category} onChange={(e) => setCategory(e.target.value)} options={CATEGORY_OPTIONS} style={{ minWidth: 260 }} />
            </span>
          }
        >
          <div className="vf-stack">
            <DropFile multiple onFiles={(f) => void upload(f)} disabled={uploading} title={uploading ? 'Enviando...' : "Arraste os arquivos ou clique em 'Selecionar'"} hint="PDF, imagens, planilhas e outros arquivos até 25 MB cada, até 20 por vez." />
          </div>
        </Card>
      )}

      <Card
        flush
        title={`Arquivos do exercício ${year}`}
        actions={
          can('customer.download_documents') &&
          rows.length > 0 && (
            <Button kind="secondary" icon={<Download />} loading={zipping} onClick={() => void zip()}>
              Baixar todos (.zip)
            </Button>
          )
        }
      >
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <div style={{ padding: 24 }}>
            <Alert tone="danger">Não foi possível carregar os arquivos.</Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<FolderOpen />} title="Nenhum arquivo neste exercício" description="Arquivos enviados pelo escritório, pelo cliente no checklist ou pela sincronização aparecem aqui." />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Arquivo</th>
                  <th>Categoria</th>
                  <th>Origem</th>
                  <th className="num">Tamanho</th>
                  <th>Enviado em</th>
                  <th className="actions" aria-label="Ações" />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className="vf-file-cell" title={d.filename}>
                        {iconFor(d.mimeType, d.filename)}
                        <span>{d.filename}</span>
                      </span>
                    </td>
                    <td>
                      {canEdit ? (
                        <Select
                          aria-label={`Categoria de ${d.filename}`}
                          value={d.category}
                          onChange={(e) => changeCategory.mutate({ id: d.id, category: e.target.value })}
                          options={d.category in DOCUMENT_CATEGORIES ? CATEGORY_OPTIONS : [{ value: d.category, label: documentCategoryLabel(d.category) }, ...CATEGORY_OPTIONS]}
                          style={{ minWidth: 200 }}
                        />
                      ) : (
                        documentCategoryLabel(d.category)
                      )}
                    </td>
                    <td>
                      <Tag tone={ORIGIN_TONE[d.uploadedBy] ?? 'neutral'}>{documentOriginLabel(d.uploadedBy)}</Tag>
                    </td>
                    <td className="num">{formatBytes(d.size)}</td>
                    <td>{formatDateTime(d.createdAt)}</td>
                    <td className="actions">
                      {isViewableType(d.mimeType) && (
                        <IconButton label="Visualizar" onClick={() => void api.open(`/documents/${d.id}/file?inline=1`)}>
                          <Eye />
                        </IconButton>
                      )}
                      <IconButton label="Baixar" onClick={() => void api.download(`/documents/${d.id}/file`, d.filename)}>
                        <Download />
                      </IconButton>
                      {canEdit && (
                        <IconButton label="Excluir" onClick={() => setRemove(d)}>
                          <Trash2 />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(remove)}
        danger
        title="Excluir arquivo"
        message={remove ? `O arquivo “${remove.filename}” será apagado definitivamente.` : ''}
        confirmLabel="Excluir"
        loading={del.isPending}
        onConfirm={() => remove && del.mutate(remove)}
        onClose={() => setRemove(null)}
      />
    </div>
  );
}
