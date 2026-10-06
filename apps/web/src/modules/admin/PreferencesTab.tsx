import { useEffect, useState, type ReactNode } from 'react';
import { Save } from 'lucide-react';
import { DECLARATION_SUBSTATUS } from '@verifco/shared';
import { Alert, Button, Card, Input, Loading, MoneyInput, Select, Switch } from '../../ds';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { useYear } from '../../lib/year';
import { SettingLabel, useAuthedFileUrl, type OfficeData, type OfficeSettings } from './shared';

const HEX = /^#[0-9a-fA-F]{6}$/;

type BoolKey = { [K in keyof OfficeSettings]: OfficeSettings[K] extends boolean ? K : never }[keyof OfficeSettings];

/** Aba Preferências: comportamento do escritório agrupado por assunto, com uma única ação de salvar. */
export function PreferencesTab() {
  const office = useApi<OfficeData>(['office'], '/office');
  const { can, refresh } = useAuth();
  const readOnly = !can('settings.edit');
  const [form, setForm] = useState<OfficeSettings | null>(null);
  const logoUrl = useAuthedFileUrl(office.data?.logoFileId);

  useEffect(() => {
    if (office.data) setForm(office.data.settings);
  }, [office.data]);

  const save = useAction(() => api.put<OfficeSettings>('/office/settings', form), {
    success: 'Preferências salvas.',
    invalidate: [['office']],
    onSuccess: () => void refresh(),
  });

  if (office.isLoading || (office.data && !form)) return <Loading />;
  if (office.isError || !office.data || !form) return <Alert tone="danger" title="Não foi possível carregar as preferências.">Atualize a página para tentar de novo.</Alert>;

  const dirty = JSON.stringify(form) !== JSON.stringify(office.data.settings);
  const colorsOk = HEX.test(form.reportTitleColor) && HEX.test(form.reportSubtitleColor) && HEX.test(form.reportLineColor);
  const whatsappOk = form.whatsappServiceNumber === '' || /^[\d\s()+-]{10,30}$/.test(form.whatsappServiceNumber);
  const set = <K extends keyof OfficeSettings>(k: K, v: OfficeSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const toggle = (k: BoolKey, title: ReactNode, help?: ReactNode) => (
    <Switch key={k} label={<SettingLabel title={title} help={help} />} checked={form[k]} disabled={readOnly} onChange={(v) => set(k, v)} />
  );

  return (
    <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
      {readOnly && <Alert>Você pode consultar as preferências, mas só quem tem permissão de edição consegue alterá-las.</Alert>}

      <div className="adm-two">
        <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
          <Section title="Operação" description="Quem vê o quê dentro do escritório.">
            {toggle('restrictCustomersToResponsible', 'Cada contador vê apenas os clientes pelos quais é responsável', 'O dono da conta continua vendo todos os clientes.')}
          </Section>

          <Section title="Comunicação" description="Envios automáticos e contato exibido aos clientes.">
            {toggle('autoSendDarfEmail', 'Enviar a guia DARF por e-mail ao cliente automaticamente', 'Quando o PDF da guia da quota é anexado na etapa DARF do IRPF.')}
            {toggle('notifyMainEmailOnEcacChanges', 'Avisar o e-mail principal do escritório sobre mudanças no eCAC', 'Ex.: declaração em malha, nova mensagem na caixa postal.')}
            <Input
              label="WhatsApp de atendimento"
              placeholder="(11) 99999-0000"
              value={form.whatsappServiceNumber}
              disabled={readOnly}
              onChange={(e) => set('whatsappServiceNumber', e.target.value)}
              error={whatsappOk ? undefined : 'Informe DDD e número'}
              help="Usado na variável de contato por WhatsApp dos templates de e-mail."
              maxLength={30}
            />
          </Section>

          <Section title="Robô (eCAC)" description="Consultas feitas pelo robô em nome do escritório.">
            <p className="vf-text-sm">
              Com o SERPRO Integra Contador ativo (Administração › Integrações), o robô consulta os clientes ativos com procurador quando você pede e na sincronização automática, se ligada (diária ou semanal, também em Integrações): procuração eletrônica,
              mensagens da caixa postal, relatório de situação fiscal (a cada 30 dias) e pagamento das quotas do DARF perto do vencimento.
            </p>
            <p className="vf-text-xs vf-muted">
              Não estão disponíveis: emissão automática da CND de pessoa física (o SERPRO não oferece esse serviço; emita no site da Receita e lance na aba eCAC do
              cliente) e consulta para clientes sem procurador.
            </p>
          </Section>

          <Section title="Checklist" description="Como o checklist digital se comporta durante a declaração.">
            {toggle('checklistReadOnlyAfterStart', 'Deixar o checklist só para consulta depois que a declaração começar', 'O cliente continua vendo o que enviou, mas não altera mais.')}
            <Select
              label="Bloquear o checklist do cliente a partir do status"
              value={form.lockChecklistFromSubstatus ?? ''}
              disabled={readOnly}
              onChange={(e) => set('lockChecklistFromSubstatus', e.target.value || null)}
              placeholder="Não bloquear"
              options={Object.entries(DECLARATION_SUBSTATUS)
                .filter(([k]) => k !== 'not_started')
                .map(([value, label]) => ({ value, label }))}
              help="Quando a declaração chega a este status, o cliente não envia mais documentos."
            />
          </Section>
        </div>

        <div className="vf-stack" style={{ '--gap': '24px' } as React.CSSProperties}>
          <Section title="Relatórios e documentos" description="Recibos, documento de autorização e análise de caixa.">
            {toggle('receiptTwoCopies', 'Imprimir o recibo em duas vias')}
            {toggle('receiptShowDetails', 'Mostrar o detalhamento dos serviços no recibo')}
            {toggle('authorizationShowDetails', 'Mostrar o detalhamento no documento de autorização')}
            {toggle('allowAuthorizationWithoutBudget', 'Permitir enviar o documento de autorização sem orçamento')}
            <Select
              label="Despesas na análise de caixa (declaração simplificada)"
              value={form.cashAnalysisSimplifiedDiscount}
              disabled={readOnly}
              onChange={(e) => set('cashAnalysisSimplifiedDiscount', e.target.value as OfficeSettings['cashAnalysisSimplifiedDiscount'])}
              options={[
                { value: 'standard', label: 'Estimar pelo desconto simplificado (20%, com teto)' },
                { value: 'proportional', label: 'Considerar só os pagamentos informados' },
              ]}
              help="Define quanto do rendimento é tratado como gasto de vida na análise de caixa."
            />
          </Section>

          <Section title="Cores dos relatórios" description="Aplicadas aos PDFs gerados pelo escritório.">
            <div className="vf-grid" style={{ '--cols': 3 } as React.CSSProperties}>
              <ColorField label="Título" value={form.reportTitleColor} disabled={readOnly} onChange={(v) => set('reportTitleColor', v)} />
              <ColorField label="Subtítulo" value={form.reportSubtitleColor} disabled={readOnly} onChange={(v) => set('reportSubtitleColor', v)} />
              <ColorField label="Linhas" value={form.reportLineColor} disabled={readOnly} onChange={(v) => set('reportLineColor', v)} />
            </div>
            <ReportPreview settings={form} officeName={office.data.name} logoUrl={logoUrl} />
          </Section>

          <Section title="Radar de oportunidades" description="Critério da categoria Alto patrimônio.">
            <MoneyInput
              label="Patrimônio mínimo para Alto patrimônio"
              value={form.highNetWorthBaseCents}
              disabled={readOnly}
              onChange={(cents) => set('highNetWorthBaseCents', cents)}
              help="Clientes com bens e direitos declarados acima deste valor entram na oportunidade."
            />
          </Section>
        </div>
      </div>

      {!readOnly && (
        <div className={`adm-savebar${dirty ? ' adm-savebar--sticky' : ''}`}>
          <span className="vf-muted vf-grow">{dirty ? 'Há alterações não salvas.' : 'Tudo salvo.'}</span>
          {dirty && (
            <Button kind="tertiary" onClick={() => setForm(office.data!.settings)}>
              Descartar
            </Button>
          )}
          <Button icon={<Save />} disabled={!dirty || !colorsOk || !whatsappOk} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Salvar preferências
          </Button>
        </div>
      )}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <p className="adm-section-desc vf-text-xs">{description}</p>
      <div className="vf-stack">{children}</div>
    </Card>
  );
}

function ColorField({ label, value, disabled, onChange }: { label: string; value: string; disabled?: boolean; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const invalid = !HEX.test(text);
  return (
    <div className="vf-field">
      <span className="vf-field__label">{label}</span>
      <div className="adm-color">
        <input type="color" aria-label={`Cor do ${label.toLowerCase()}`} value={HEX.test(value) ? value : '#000000'} disabled={disabled} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        <Input
          aria-label={`Código da cor do ${label.toLowerCase()}`}
          value={text}
          disabled={disabled}
          maxLength={7}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            const v = e.target.value.trim();
            setText(v);
            if (HEX.test(v)) onChange(v.toUpperCase());
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
      </div>
      {invalid && <span className="vf-field__error">Use #RRGGBB</span>}
    </div>
  );
}

/** Miniatura de um relatório com as cores escolhidas. */
function ReportPreview({ settings, officeName, logoUrl }: { settings: OfficeSettings; officeName: string; logoUrl: string | null }) {
  const { year } = useYear();
  return (
    <div>
      <span className="vf-field__label">Prévia</span>
      <div className="adm-report-preview" style={{ '--line-color': settings.reportLineColor, marginTop: 4 } as React.CSSProperties} aria-label="Prévia das cores do relatório">
        <div className="adm-report-preview__head">
          <div>
            <div className="vf-text-md-bold" style={{ color: settings.reportTitleColor }}>
              Análise de caixa
            </div>
            <div className="vf-text-xs-bold" style={{ color: settings.reportSubtitleColor }}>
              Exercício {year} · ano-calendário {year - 1}
            </div>
          </div>
          {logoUrl ? <img src={logoUrl} alt="" /> : <span className="vf-text-xs vf-muted">{officeName}</span>}
        </div>
        <table>
          <tbody>
            <tr>
              <td>Rendimentos tributáveis líquidos</td>
              <td>R$ 182.400,00</td>
            </tr>
            <tr>
              <td>Rendimentos isentos</td>
              <td>R$ 24.950,00</td>
            </tr>
            <tr>
              <td>Aumento de bens</td>
              <td>R$ 96.000,00</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
