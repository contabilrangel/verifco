import { useState, type CSSProperties } from 'react';
import { Copy, Download, Eye, FileArchive, KeyRound, ListChecks, Lock, Mail, MessageCircle, MoreHorizontal, Send, Trash2, Unlock } from 'lucide-react';
import { Alert, Button, Card, Checkbox, ConfirmDialog, IconButton, Input, Loading, Menu, MenuItem, Modal, Progress, Tag, useToast } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDate, formatDateTime, formatPhone } from '../../lib/format';
import { useYear } from '../../lib/year';
import { useCustomer } from '../customers/customerContext';
import { OfficeSections } from './OfficeSections';
import type { OfficeChecklistResponse } from './types';

/** Etapa "Documentação" da aba IRPF: checklist digital e checklist em PDF. */
export function DocumentationStep() {
  const { customer } = useCustomer();
  const { year } = useYear();
  const { can } = useAuth();
  const key = ['checklist', customer.id, year];
  const q = useApi<OfficeChecklistResponse>(key, `/customers/${customer.id}/checklist?year=${year}`);
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Alert tone="danger">Não foi possível carregar a documentação deste exercício.</Alert>;
  const data = q.data;
  const canDigital = can('checklist_digital.view');
  const canPdf = can('checklist_pdf.view', 'checklist_pdf.download', 'checklist_pdf.send');
  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as CSSProperties}>
      <div className="vf-grid" style={{ '--cols': canDigital && canPdf ? 3 : 1, alignItems: 'start' } as CSSProperties}>
        {canDigital && (
          <div className={canPdf ? 'vf-span-2' : undefined} style={{ minWidth: 0 }}>
            <DigitalCard data={data} queryKey={key} />
          </div>
        )}
        {canPdf && <PdfCard data={data} />}
      </div>
      {canDigital && data.checklist && <OfficeSections data={data} queryKey={key} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function DigitalCard({ data, queryKey }: { data: OfficeChecklistResponse; queryKey: unknown[] }) {
  const { customer } = useCustomer();
  const { can } = useAuth();
  const c = data.checklist;
  const [sendOpen, setSendOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | 'regenerate' | 'delete'>(null);
  const [result, setResult] = useState<{ link: string; code: string; channels: string[] } | null>(null);

  const create = useAction(() => api.post(`/customers/${customer.id}/checklist`, { year: data.exerciseYear }), {
    success: 'Checklist criado.',
    invalidate: [queryKey],
  });
  const access = useAction((channels: string[]) => api.post<{ link: string; code: string; channels: string[] }>(`/checklists/${c!.id}/access`, { channels }), {
    invalidate: [queryKey],
    onSuccess: (r) => {
      setSendOpen(false);
      setConfirm(null);
      setResult(r);
    },
  });
  const lock = useAction((locked: boolean) => api.put(`/checklists/${c!.id}/lock`, { locked }), {
    success: (r) => ((r as { locked: boolean }).locked ? 'Checklist bloqueado para o cliente.' : 'Checklist liberado para o cliente.'),
    invalidate: [queryKey],
  });
  const remove = useAction(() => api.del(`/checklists/${c!.id}`), {
    success: 'Checklist excluído.',
    invalidate: [queryKey],
    onSuccess: () => setConfirm(null),
  });
  const zip = useAction(() => api.download(`/checklists/${c!.id}/zip`, `checklist-${data.exerciseYear}.zip`));

  const prev = data.previous;
  if (!c) {
    return (
      <Card title="Checklist digital" actions={<Tag>Não criado</Tag>}>
        <div className="vf-stack">
          <p className="vf-muted">O cliente recebe um link, entra com CPF e código, confirma os itens e envia os documentos por seção. Você acompanha tudo por aqui.</p>
          <Alert tone="warning" title={`Usa os dados da declaração de ${prev.exerciseYear}`}>
            O checklist é montado com os dados do ano anterior no momento da criação. Atualize esses dados antes de criar: mudanças feitas depois não entram no checklist.
          </Alert>
          <p className="vf-text-sm">
            {prev.hasDeclaration && prev.items > 0
              ? `Encontramos ${prev.items} linha(s) na declaração de ${prev.exerciseYear} (dependentes, rendimentos, pagamentos, bens, dívidas e atividade rural).`
              : `Não há dados da declaração de ${prev.exerciseYear}. O checklist terá a lista padrão de documentos.`}
          </p>
          {can('checklist_digital.create') && (
            <div>
              <Button icon={<ListChecks />} loading={create.isPending} onClick={() => create.mutate(undefined)}>
                Criar checklist digital
              </Button>
            </div>
          )}
        </div>
      </Card>
    );
  }

  const sectionsDone = c.sections.filter((s) => s.status !== 'open').length;
  const locked = data.declaration?.checklistLocked ?? false;
  return (
    <Card
      title="Checklist digital"
      actions={
        <>
          {c.finishedAt ? <Tag tone="success">Finalizado pelo cliente</Tag> : c.sentAt ? <Tag tone="primary">Enviado</Tag> : <Tag tone="warning">Ainda não enviado</Tag>}
          {(can('checklist_digital.send') || can('checklist_digital.edit') || can('checklist_digital.create')) && (
            <Menu
              trigger={(toggle) => (
                <IconButton label="Mais ações" onClick={toggle}>
                  <MoreHorizontal />
                </IconButton>
              )}
            >
              {(close) => (
                <>
                  {can('checklist_digital.send') && (
                    <MenuItem icon={<KeyRound />} onClick={() => (close(), setConfirm('regenerate'))}>
                      Gerar novo link e código
                    </MenuItem>
                  )}
                  {can('checklist_digital.edit') && (
                    <MenuItem icon={locked ? <Unlock /> : <Lock />} onClick={() => (close(), lock.mutate(!locked))}>
                      {locked ? 'Liberar para o cliente' : 'Bloquear para o cliente'}
                    </MenuItem>
                  )}
                  {can('checklist_digital.create') && (
                    <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setConfirm('delete'))}>
                      Excluir checklist
                    </MenuItem>
                  )}
                </>
              )}
            </Menu>
          )}
        </>
      }
    >
      <div className="vf-stack">
        <div className="vf-stack" style={{ '--gap': '8px' } as CSSProperties}>
          <div className="vf-inline vf-between">
            <span className="vf-text-sm-bold">
              {c.progress.resolved} de {c.progress.total} itens resolvidos
            </span>
            <span className="vf-muted vf-text-sm">
              {sectionsDone} de {c.sections.length} seções finalizadas · {c.filesCount} arquivo(s)
            </span>
          </div>
          <Progress value={c.progress.percent} />
        </div>
        <div className="ck-meta">
          <span>Criado em {formatDate(c.createdAt)} com {c.fromPreviousYear} item(ns) da declaração de {prev.exerciseYear}</span>
          <span>{c.sentAt ? `Acesso enviado em ${formatDateTime(c.sentAt)}` : 'Acesso ainda não enviado'}</span>
          <span>{c.lastCustomerAccessAt ? `Último acesso do cliente: ${formatDateTime(c.lastCustomerAccessAt)}` : 'O cliente ainda não acessou'}</span>
          {c.finishedAt && <span>Finalizado pelo cliente em {formatDateTime(c.finishedAt)}</span>}
        </div>
        <p className="vf-muted vf-text-xs">Os itens foram montados com os dados do ano anterior no momento da criação; mudanças posteriores nesses dados não entram aqui.</p>
        {data.lock.readOnly && (
          <Alert tone="warning" title="Só consulta para o cliente">
            {data.lock.reason}
          </Alert>
        )}
        <div className="vf-inline">
          {can('checklist_digital.send') && (
            <Button icon={<Send />} onClick={() => setSendOpen(true)} disabled={!data.contact.email && !data.contact.mobile} title={!data.contact.email && !data.contact.mobile ? 'Cadastre e-mail ou celular do cliente' : undefined}>
              Enviar acesso ao cliente
            </Button>
          )}
          {can('checklist_digital.download') && (
            <Button kind="secondary" icon={<FileArchive />} loading={zip.isPending} disabled={!c.filesCount} onClick={() => zip.mutate(undefined)}>
              Baixar arquivos (.zip)
            </Button>
          )}
        </div>
      </div>

      <SendAccessModal open={sendOpen} contact={data.contact} loading={access.isPending} onClose={() => setSendOpen(false)} onSend={(channels) => access.mutate(channels)} />
      <ConfirmDialog
        open={confirm === 'regenerate'}
        title="Gerar novo link e código?"
        message="O link e o código enviados antes deixam de funcionar. Você verá os novos dados para repassar ao cliente."
        confirmLabel="Gerar"
        loading={access.isPending}
        onConfirm={() => access.mutate([])}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        danger
        title="Excluir o checklist?"
        message="As seções, os itens e as respostas do cliente serão apagados e o link deixa de funcionar. Os arquivos já enviados continuam guardados nos documentos do cliente."
        confirmLabel="Excluir"
        loading={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
        onClose={() => setConfirm(null)}
      />
      <AccessResultModal result={result} onClose={() => setResult(null)} />
    </Card>
  );
}

function SendAccessModal({
  open,
  contact,
  loading,
  onClose,
  onSend,
}: {
  open: boolean;
  contact: OfficeChecklistResponse['contact'];
  loading: boolean;
  onClose: () => void;
  onSend: (channels: string[]) => void;
}) {
  const [email, setEmail] = useState(true);
  const [whatsapp, setWhatsapp] = useState(true);
  const channels = [email && contact.email ? 'email' : null, whatsapp && contact.mobile ? 'whatsapp' : null].filter(Boolean) as string[];
  return (
    <Modal
      open={open}
      title="Enviar acesso ao checklist"
      onClose={onClose}
      width={500}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button icon={<Send />} loading={loading} disabled={!channels.length} onClick={() => onSend(channels)}>
            Enviar
          </Button>
        </>
      }
    >
      <div className="vf-stack">
        <p className="vf-muted">O cliente recebe o link do checklist e o código para entrar com o CPF.</p>
        <div className="vf-stack" style={{ '--gap': '12px' } as CSSProperties}>
          <Checkbox
            label={
              <span className="vf-inline" style={{ '--gap': '6px' } as CSSProperties}>
                <Mail size={16} /> E-mail <span className="vf-muted">· {contact.email ?? 'sem e-mail cadastrado'}</span>
              </span>
            }
            checked={email && Boolean(contact.email)}
            disabled={!contact.email}
            onChange={(e) => setEmail(e.target.checked)}
          />
          <Checkbox
            label={
              <span className="vf-inline" style={{ '--gap': '6px' } as CSSProperties}>
                <MessageCircle size={16} /> WhatsApp <span className="vf-muted">· {contact.mobile ? formatPhone(contact.mobile) : 'sem celular cadastrado'}</span>
              </span>
            }
            checked={whatsapp && Boolean(contact.mobile)}
            disabled={!contact.mobile}
            onChange={(e) => setWhatsapp(e.target.checked)}
          />
        </div>
        <Alert tone="warning">Um novo link e um novo código serão gerados. Os enviados antes deixam de funcionar.</Alert>
      </div>
    </Modal>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="ck-copy">
      <Input label={label} value={value} readOnly onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
      <Button
        kind="secondary"
        icon={<Copy />}
        onClick={() =>
          navigator.clipboard
            .writeText(value)
            .then(() => toast.success('Copiado.'))
            .catch(() => toast.error('Não foi possível copiar. Selecione e copie manualmente.'))
        }
      >
        Copiar
      </Button>
    </div>
  );
}

function AccessResultModal({ result, onClose }: { result: { link: string; code: string; channels: string[] } | null; onClose: () => void }) {
  const where = result?.channels.map((c) => (c === 'email' ? 'e-mail' : 'WhatsApp')).join(' e ');
  return (
    <Modal open={Boolean(result)} title={result?.channels.length ? 'Acesso enviado' : 'Novo acesso gerado'} onClose={onClose} width={560} footer={<Button onClick={onClose}>Fechar</Button>}>
      {result && (
        <div className="vf-stack">
          <Alert tone="success">{result.channels.length ? `Enviamos o link e o código por ${where}.` : 'Repasse o link e o código ao cliente.'}</Alert>
          <CopyField label="Link do checklist" value={result.link} />
          <CopyField label="Código de acesso" value={result.code} />
          <p className="vf-muted vf-text-xs">Por segurança, o código não fica salvo no Verifco: ele só aparece agora. Se precisar, gere outro.</p>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function PdfCard({ data }: { data: OfficeChecklistResponse }) {
  const { customer } = useCustomer();
  const { can } = useAuth();
  const [channel, setChannel] = useState<null | 'email' | 'whatsapp'>(null);
  const year = data.exerciseYear;
  const view = useAction(() => api.open(`/customers/${customer.id}/checklist-pdf?year=${year}&inline=1`));
  const download = useAction(() => api.download(`/customers/${customer.id}/checklist-pdf?year=${year}`, `checklist-irpf-${year}.pdf`));
  const send = useAction((ch: 'email' | 'whatsapp') => api.post(`/customers/${customer.id}/checklist-pdf/send`, { year, channel: ch }), {
    success: 'Checklist em PDF enviado.',
    onSuccess: () => setChannel(null),
  });
  const { email, mobile } = data.contact;
  return (
    <Card title="Checklist em PDF">
      <div className="vf-stack">
        <p className="vf-muted">
          Lista de documentos para o cliente separar, por seção. Usa os itens do checklist digital ou, se ele ainda não existir, os dados da declaração de {data.previous.exerciseYear}.
        </p>
        <div className="vf-inline">
          {can('checklist_pdf.view') && (
            <Button kind="secondary" size="sm" icon={<Eye />} loading={view.isPending} onClick={() => view.mutate(undefined)}>
              Visualizar
            </Button>
          )}
          {can('checklist_pdf.download') && (
            <Button kind="secondary" size="sm" icon={<Download />} loading={download.isPending} onClick={() => download.mutate(undefined)}>
              Baixar
            </Button>
          )}
        </div>
        {can('checklist_pdf.send') && (
          <div className="vf-inline">
            <Button size="sm" icon={<Mail />} disabled={!email} title={!email ? 'Cadastre o e-mail do cliente' : undefined} onClick={() => setChannel('email')}>
              Enviar por e-mail
            </Button>
            <Button size="sm" icon={<MessageCircle />} disabled={!mobile} title={!mobile ? 'Cadastre o celular do cliente' : undefined} onClick={() => setChannel('whatsapp')}>
              Enviar por WhatsApp
            </Button>
          </div>
        )}
        {can('checklist_pdf.send') && (!email || !mobile) && (
          <p className="vf-muted vf-text-xs">{!email && !mobile ? 'Cadastre e-mail ou celular na aba Identificação para enviar.' : !email ? 'Sem e-mail cadastrado.' : 'Sem celular cadastrado.'}</p>
        )}
      </div>
      <ConfirmDialog
        open={channel !== null}
        title={channel === 'email' ? 'Enviar o PDF por e-mail?' : 'Enviar o PDF por WhatsApp?'}
        message={channel === 'email' ? `O checklist em PDF vai anexo para ${email}.` : `O checklist em PDF vai para o WhatsApp ${formatPhone(mobile)}.`}
        confirmLabel="Enviar"
        loading={send.isPending}
        onConfirm={() => channel && send.mutate(channel)}
        onClose={() => setChannel(null)}
      />
    </Card>
  );
}
