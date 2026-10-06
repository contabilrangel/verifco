import { useEffect, useState } from 'react';
import { ImageIcon, Save, Trash2, Upload } from 'lucide-react';
import { isValidCpfCnpj, isValidEmail } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, DropFile, Input, Loading, useToast } from '../../ds';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatCpfCnpj, formatPhone } from '../../lib/format';
import { useAuthedFileUrl, type OfficeData } from './shared';

const EMPTY = { name: '', cpfCnpj: '', email: '', phone: '', website: '', city: '', state: '' };
type Form = typeof EMPTY;

const toForm = (o: OfficeData): Form => ({
  name: o.name,
  cpfCnpj: formatCpfCnpj(o.cpfCnpj),
  email: o.email ?? '',
  phone: formatPhone(o.phone),
  website: o.website ?? '',
  city: o.city ?? '',
  state: o.state ?? '',
});

const LOGO_TYPES = ['image/png', 'image/jpeg'];
const LOGO_MAX = 2 * 1024 * 1024;

/** Aba Empresa: dados cadastrais do escritório e logo usado nos relatórios e PDFs. */
export function OfficeTab() {
  const office = useApi<OfficeData>(['office'], '/office');
  const { refresh } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState<Form>(EMPTY);
  const [uploading, setUploading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const logoUrl = useAuthedFileUrl(office.data?.logoFileId);

  useEffect(() => {
    if (office.data) setForm(toForm(office.data));
  }, [office.data]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const errors = {
    name: form.name.trim().length < 2 ? 'Informe o nome do escritório' : undefined,
    cpfCnpj: form.cpfCnpj && !isValidCpfCnpj(form.cpfCnpj) ? 'CPF/CNPJ inválido' : undefined,
    email: form.email && !isValidEmail(form.email) ? 'E-mail inválido' : undefined,
    state: form.state && !/^[A-Za-z]{2}$/.test(form.state) ? 'Use a sigla (ex.: SP)' : undefined,
  };
  const valid = !Object.values(errors).some(Boolean);
  const dirty = office.data ? JSON.stringify(toForm(office.data)) !== JSON.stringify(form) : false;

  const save = useAction(() => api.put<OfficeData>('/office', form), {
    success: 'Dados do escritório salvos.',
    invalidate: [['office']],
    onSuccess: () => void refresh(),
  });
  const removeLogo = useAction(() => api.del('/office/logo'), {
    success: 'Logo removido.',
    invalidate: [['office']],
    onSuccess: () => {
      setConfirmRemove(false);
      void refresh();
    },
  });

  const sendLogo = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return toast.error('Use uma imagem PNG ou JPG.');
    if (file.size > LOGO_MAX) return toast.error('A imagem deve ter até 2 MB.');
    setUploading(true);
    try {
      await api.upload('/office/logo', file);
      toast.success('Logo atualizado.');
      await office.refetch();
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e, 'Não foi possível enviar o logo.'));
    } finally {
      setUploading(false);
    }
  };

  if (office.isLoading) return <Loading />;
  if (office.isError || !office.data) return <Alert tone="danger" title="Não foi possível carregar os dados do escritório.">Atualize a página para tentar de novo.</Alert>;

  return (
    <div className="adm-split">
      <Card title="Informações do escritório">
        <div className="vf-grid" style={{ '--cols': 2 } as React.CSSProperties}>
          <Input label="Nome do escritório" required value={form.name} onChange={set('name')} error={errors.name} span="full" maxLength={200} />
          <Input label="CPF ou CNPJ" value={form.cpfCnpj} onChange={set('cpfCnpj')} error={errors.cpfCnpj} inputMode="numeric" />
          <Input label="E-mail principal" type="email" value={form.email} onChange={set('email')} error={errors.email} help="Recebe avisos do eCAC quando a preferência estiver ligada." />
          <Input label="Telefone" value={form.phone} onChange={set('phone')} inputMode="tel" />
          <Input label="Site" inputMode="url" placeholder="www.seuescritorio.com.br" value={form.website} onChange={set('website')} />
          <Input label="Cidade" value={form.city} onChange={set('city')} />
          <Input label="UF" value={form.state} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value.toUpperCase() }))} error={errors.state} maxLength={2} />
        </div>
        <div className="vf-inline vf-end" style={{ marginTop: 24 }}>
          {dirty && (
            <Button kind="tertiary" onClick={() => setForm(toForm(office.data!))}>
              Descartar alterações
            </Button>
          )}
          <Button icon={<Save />} disabled={!valid || !dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar
          </Button>
        </div>
      </Card>

      <Card title="Logo">
        <div className="vf-stack">
          <div className="adm-logo" aria-live="polite">
            {office.data.logoFileId && logoUrl ? (
              <img src={logoUrl} alt={`Logo de ${office.data.name}`} />
            ) : (
              <div className="adm-logo__empty">
                <ImageIcon />
                <span className="vf-text-xs">{office.data.logoFileId ? 'Carregando prévia...' : 'Nenhum logo enviado'}</span>
              </div>
            )}
          </div>
          <span className="vf-text-xs vf-muted">Aparece no cabeçalho dos relatórios, recibos e PDFs enviados aos clientes. Prefira fundo transparente.</span>
          <DropFile
            onFiles={sendLogo}
            accept={LOGO_TYPES.join(',')}
            disabled={uploading}
            title={uploading ? 'Enviando...' : office.data.logoFileId ? 'Arraste uma nova imagem para trocar' : 'Arraste a imagem do logo'}
            hint="PNG ou JPG, até 2 MB"
          />
          {office.data.logoFileId && (
            <Button kind="tertiary" icon={<Trash2 />} onClick={() => setConfirmRemove(true)}>
              Remover logo
            </Button>
          )}
          {uploading && (
            <span className="vf-inline vf-muted vf-text-xs">
              <Upload size={14} /> Enviando imagem...
            </span>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={confirmRemove}
        danger
        title="Remover logo"
        message="Os próximos relatórios e PDFs sairão sem o logo do escritório."
        confirmLabel="Remover"
        loading={removeLogo.isPending}
        onConfirm={() => removeLogo.mutate(undefined)}
        onClose={() => setConfirmRemove(false)}
      />
    </div>
  );
}
