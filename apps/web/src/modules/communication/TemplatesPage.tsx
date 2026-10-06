import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { Eye, Mail, Pencil, RotateCcw, Save } from 'lucide-react';
import { getTemplateDef, unknownVariables, type TemplateVariable } from '@verifco/shared';
import { Alert, Button, Card, ConfirmDialog, EmptyState, Input, Loading, Modal, Tag } from '../../ds';
import { PageHeader } from '../../app/Shell';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { useYear } from '../../lib/year';
import { RichEditor, type RichEditorHandle } from './RichEditor';
import './communication.css';

interface TemplateListItem {
  key: string;
  name: string;
  description: string;
  subject: string;
  customized: boolean;
  updatedAt: string | null;
  variables: number;
}

interface TemplateDetail {
  key: string;
  name: string;
  description: string;
  variables: TemplateVariable[];
  subject: string;
  body: string;
  customized: boolean;
  defaultSubject: string;
  defaultBody: string;
}

const crumbs = [{ label: 'Início', to: '/' }, { label: 'Comunicação' }, { label: 'Templates de e-mail' }];

export function TemplatesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useApi<TemplateListItem[]>(['email-templates'], '/email-templates');
  const canEdit = can('email_template.edit');
  return (
    <>
      <PageHeader title="Templates de e-mail" description="Textos usados nos envios aos clientes. Personalize o assunto e o conteúdo; as variáveis são trocadas pelos dados de cada cliente." crumbs={crumbs} />
      <Card flush>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          <EmptyState icon={<Mail />} title="Nenhum template disponível" />
        ) : (
          <div className="vf-table-wrap">
            <table className="vf-table">
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Assunto</th>
                  <th>Situação</th>
                  <th>Atualizado em</th>
                  <th className="actions">Opções</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((t) => (
                  <tr key={t.key}>
                    <td>
                      <div className="vf-stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                        <Link to={`/comunicacao/templates/${t.key}`} className="vf-text-sm-bold">
                          {t.name}
                        </Link>
                        <span className="vf-text-xs vf-muted">{t.description}</span>
                      </div>
                    </td>
                    <td className="vf-muted" style={{ maxWidth: 360 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.subject}>
                        {t.subject}
                      </span>
                    </td>
                    <td>{t.customized ? <Tag tone="primary">Personalizado</Tag> : <Tag>Padrão</Tag>}</td>
                    <td className="vf-muted">{t.updatedAt ? formatDateTime(t.updatedAt) : '—'}</td>
                    <td className="actions">
                      <Button size="sm" kind="secondary" icon={canEdit ? <Pencil /> : <Eye />} onClick={() => navigate(`/comunicacao/templates/${t.key}`)}>
                        {canEdit ? 'Editar' : 'Visualizar'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export function TemplateEditorPage() {
  const { key = '' } = useParams();
  const { can } = useAuth();
  const { year } = useYear();
  const canEdit = can('email_template.edit');
  const def = getTemplateDef(key);
  const q = useApi<TemplateDetail>(['email-templates', key], def ? `/email-templates/${key}` : null);
  const editor = useRef<RichEditorHandle>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState<{ subject: string; body: string; customized: boolean } | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; html: string; unknownVariables: string[] } | null>(null);
  const [lastField, setLastField] = useState<'subject' | 'body'>('body');
  const subjectRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (q.data && !base) {
      setSubject(q.data.subject);
      setBody(q.data.body);
      setBase({ subject: q.data.subject, body: q.data.body, customized: q.data.customized });
    }
  }, [q.data, base]);

  const dirty = Boolean(base && (subject !== base.subject || body !== base.body));
  const unknown = useMemo(() => (def ? unknownVariables(`${subject} ${body}`, def) : []), [def, subject, body]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  const save = useAction(() => api.put<{ subject: string; body: string; customized: boolean }>(`/email-templates/${key}`, { subject, body }), {
    success: 'Template salvo.',
    invalidate: [['email-templates']],
    onSuccess: (r) => {
      setSubject(r.subject);
      setBody(r.body);
      setBase({ subject: r.subject, body: r.body, customized: r.customized });
    },
  });
  const restore = useAction(() => api.del<{ subject: string; body: string; customized: boolean }>(`/email-templates/${key}`), {
    success: 'Modelo padrão restaurado.',
    invalidate: [['email-templates']],
    onSuccess: (r) => {
      setRestoreOpen(false);
      setSubject(r.subject);
      setBody(r.body);
      setBase({ subject: r.subject, body: r.body, customized: false });
    },
  });
  const runPreview = useAction(() => api.post<{ subject: string; html: string; unknownVariables: string[] }>(`/email-templates/${key}/preview`, { subject, body, year }), {
    onSuccess: (r) => setPreview(r),
  });

  const insertVar = (name: string) => {
    const token = `{{${name}}}`;
    if (lastField === 'subject' && subjectRef.current) {
      const el = subjectRef.current;
      const start = el.selectionStart ?? subject.length;
      const end = el.selectionEnd ?? start;
      setSubject(subject.slice(0, start) + token + subject.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    } else editor.current?.insertText(token);
  };

  if (!def) return <EmptyState title="Template não encontrado" action={<Link to="/comunicacao/templates">Voltar aos templates</Link>} />;
  if (q.isLoading || !base) return <Loading />;

  return (
    <>
      <PageHeader
        title={def.name}
        description={def.description}
        crumbs={[{ label: 'Início', to: '/' }, { label: 'Templates de e-mail', to: '/comunicacao/templates' }, { label: def.name }]}
        actions={
          <div className="vf-inline">
            {base.customized ? <Tag tone="primary">Personalizado</Tag> : <Tag>Padrão do sistema</Tag>}
            {dirty && <Tag tone="warning">Alterações não salvas</Tag>}
          </div>
        }
      />
      <div className="vf-two-col">
        <div className="vf-stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          {!canEdit && <Alert>Você pode consultar este template, mas não tem permissão para editá-lo.</Alert>}
          {unknown.length > 0 && (
            <Alert tone="warning" title="Variáveis desconhecidas">
              {unknown.map((u) => `{{${u}}}`).join(', ')} não pertence(m) a este template e será(ão) enviada(s) como texto. Use as variáveis da lista ao lado.
            </Alert>
          )}
          <Card>
            <div className="vf-stack">
              <Input
                label="Assunto do e-mail"
                value={subject}
                maxLength={300}
                disabled={!canEdit}
                onFocus={(e) => {
                  subjectRef.current = e.currentTarget;
                  setLastField('subject');
                }}
                onChange={(e) => setSubject(e.target.value)}
              />
              <div className="vf-field" onFocusCapture={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && setLastField('body')}>
                <span className="vf-field__label">Conteúdo do e-mail</span>
                <RichEditor ref={editor} value={body} onChange={setBody} disabled={!canEdit} />
              </div>
            </div>
          </Card>
          <div className="vf-inline vf-between">
            <div className="vf-inline">
              {canEdit && (
                <Button kind="tertiary" icon={<RotateCcw />} disabled={!base.customized && !dirty} onClick={() => setRestoreOpen(true)}>
                  Restaurar modelo padrão
                </Button>
              )}
            </div>
            <div className="vf-inline">
              <Button kind="secondary" icon={<Eye />} loading={runPreview.isPending} onClick={() => runPreview.mutate(undefined)}>
                Pré-visualizar
              </Button>
              {canEdit && (
                <>
                  {dirty && (
                    <Button
                      kind="tertiary"
                      onClick={() => {
                        setSubject(base.subject);
                        setBody(base.body);
                      }}
                    >
                      Descartar alterações
                    </Button>
                  )}
                  <Button icon={<Save />} disabled={!dirty || !subject.trim()} loading={save.isPending} onClick={() => save.mutate(undefined)}>
                    Salvar
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        <Card title="Variáveis disponíveis">
          <p className="vf-text-xs vf-muted" style={{ marginBottom: 12 }}>
            Clique para inserir no {lastField === 'subject' ? 'assunto' : 'conteúdo'}, na posição do cursor. No envio, cada variável vira o dado do cliente.
          </p>
          <div className="vf-vars">
            {def.variables.map((v) => (
              <button key={v.name} type="button" className="vf-var" disabled={!canEdit} onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v.name)}>
                <code>{`{{${v.name}}}`}</code>
                <span>{v.description}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={restoreOpen}
        title="Restaurar modelo padrão"
        message="O assunto e o conteúdo voltam ao texto padrão do Verifco. A personalização atual será perdida."
        confirmLabel="Restaurar"
        danger
        loading={restore.isPending}
        onConfirm={() => restore.mutate(undefined)}
        onClose={() => setRestoreOpen(false)}
      />
      <Modal open={preview !== null} title="Pré-visualização" width={760} onClose={() => setPreview(null)}>
        {preview && (
          <div className="vf-stack">
            <p className="vf-text-xs vf-muted">Com dados de exemplo. No envio, as variáveis recebem os dados de cada cliente.</p>
            {preview.unknownVariables.length > 0 && <Alert tone="warning">Variáveis desconhecidas aparecem entre chaves: {preview.unknownVariables.map((u) => `{{${u}}}`).join(', ')}.</Alert>}
            <MailPreview subject={preview.subject} html={preview.html} />
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        title="Sair sem salvar?"
        message="As alterações deste template serão perdidas."
        confirmLabel="Sair sem salvar"
        danger
        onConfirm={() => blocker.proceed?.()}
        onClose={() => blocker.reset?.()}
      />
    </>
  );
}

/** Mostra um e-mail como o cliente vê: assunto e corpo num iframe isolado (sem scripts). */
export function MailPreview({ subject, html, to }: { subject: string; html: string; to?: string | null }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#212429;margin:16px 20px;}img{max-width:100%;}a{color:#3468e6;}</style></head><body>${html}</body></html>`;
  return (
    <div className="vf-mail-preview">
      <div className="vf-mail-preview__head">
        {to && <span className="vf-text-xs vf-muted">Para: {to}</span>}
        <span className="vf-text-sm-bold">{subject || '(sem assunto)'}</span>
      </div>
      <iframe className="vf-mail-preview__frame" title="Conteúdo do e-mail" sandbox="" srcDoc={doc} />
    </div>
  );
}
