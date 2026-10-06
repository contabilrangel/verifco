/**
 * Conteúdo da página de Ajuda. Edite aqui as perguntas e o contato do suporte.
 * O e-mail pode ser trocado sem alterar código com a variável VITE_SUPPORT_EMAIL.
 */
export const SUPPORT = {
  email: (import.meta.env.VITE_SUPPORT_EMAIL as string | undefined) || 'suporte@verifco.com.br',
  hours: 'Segunda a sexta, das 8h às 18h (horário de Brasília)',
  responseTime: 'Respondemos em até 1 dia útil.',
};

export interface HelpSection {
  id: string;
  title: string;
  faqs: { q: string; a: string }[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'primeiros-passos',
    title: 'Primeiros passos',
    faqs: [
      { q: 'Por onde começo?', a: 'Cadastre o logo e os dados do escritório em Administração › Empresa, convide a equipe em Colaboradores e importe a carteira em Clientes › Novos clientes em lote.' },
      { q: 'O que é o ano-exercício da barra superior?', a: 'É o ano de entrega da declaração (o exercício 2026 corresponde ao ano-calendário 2025). Ele vale para todas as telas, filtros e relatórios.' },
      { q: 'Como favorito uma tela?', a: 'Clique na estrela ao lado do título da página. Os favoritos ficam salvos no seu usuário.' },
    ],
  },
  {
    id: 'clientes',
    title: 'Clientes',
    faqs: [
      { q: 'Como encontro um cliente?', a: 'Use a busca da barra superior (nome, CPF ou e-mail) e tecle Enter, ou a lista de Clientes com filtros por grupo, responsável, procuração e status da declaração.' },
      { q: 'Posso alterar vários clientes de uma vez?', a: 'Sim. Na lista de Clientes, selecione os clientes e use o menu Ações para mudar status, responsável, grupos, procurador, exportar para Excel ou enviar a mala direta.' },
      { q: 'Um colaborador pode ver só os clientes dele?', a: 'Sim. Em Administração › Preferências, ative a restrição de visibilidade por responsável. O dono do escritório continua vendo todos.' },
    ],
  },
  {
    id: 'irpf',
    title: 'Declaração IRPF',
    faqs: [
      { q: 'Quais são as etapas da declaração?', a: 'Na aba IRPF do cliente: orçamento, declaração, documentação (checklist), DARF, relatórios, pendências e holding. O status de cada declaração aparece no Kanban.' },
      { q: 'Como peço documentos que faltam?', a: 'Na etapa Pendências do cliente, cadastre cada documento com a data limite e envie a lista por e-mail ou WhatsApp. O relatório Documentos faltantes mostra todas as pendências da carteira.' },
      { q: 'O que é o kit pós-declaração?', a: 'Um PDF para o cliente com o resumo da declaração transmitida, as quotas do DARF ou a restituição, a evolução do patrimônio e lembretes para o próximo ano. Baixe na etapa Relatórios ou envie em lote pela mala direta.' },
    ],
  },
  {
    id: 'relatorios',
    title: 'Relatórios',
    faqs: [
      { q: 'Quais relatórios posso gerar para um cliente?', a: 'Na etapa Relatórios da aba IRPF: análise de caixa, detalhes do caixa, histórico patrimonial e do caixa (últimos 5 exercícios), aviso de malha fina, planejamento tributário e bens e direitos, em PDF ou Excel.' },
      { q: 'Por que o relatório diz que a declaração não tem linhas?', a: 'Os relatórios usam as linhas cadastradas da declaração (rendimentos, pagamentos, bens, dívidas). Importe ou cadastre a declaração do exercício antes de gerar.' },
      { q: 'Para que servem os "Outros gastos"?', a: 'Gastos que não aparecem na declaração, como juros, cartão de crédito e perdas de capital, entram na análise de caixa como aplicações do ano e deixam o saldo mais próximo da realidade.' },
      { q: 'Quando posso exibir os dados do cônjuge?', a: 'Quando o cônjuge está como dependente (relação cônjuge) e também é cliente do escritório com declaração no mesmo exercício. Os relatórios passam a mostrar os dois e o consolidado do casal.' },
      { q: 'O que mostram os relatórios gerais?', a: 'Em Relatórios: resultados (imposto a pagar e a restituir da carteira), documentos faltantes por cliente e restituições com a data dos lotes. Todos podem ser baixados em Excel.' },
    ],
  },
  {
    id: 'comunicacao',
    title: 'Comunicação',
    faqs: [
      { q: 'Como personalizo os e-mails?', a: 'Em Comunicação › Templates de e-mail, edite o assunto e o conteúdo. Clique nas variáveis para inserir dados do cliente, como {{CLIENTE}}. Use Pré-visualizar para conferir e Restaurar modelo padrão para desfazer.' },
      {
        q: 'Como envio uma mala direta?',
        a: 'Em Comunicação › Mala direta, escolha o tipo, os destinatários (por filtros ou pela seleção feita na lista de clientes) e o canal. A revisão mostra quantos clientes não têm e-mail ou celular antes de enviar. O envio vai para a fila e a própria tela mostra o andamento (também em “Malas diretas recentes”). No checklist digital, cada cliente recebe um link e um código próprios (o checklist é criado se ainda não existir); no orçamento, vai o link de aprovação online e o orçamento passa a “Enviado”.',
      },
      { q: 'O mesmo envio pode sair duas vezes?', a: 'Não. Cada envio tem uma identificação única; se a tela for confirmada duas vezes, o sistema reconhece a repetição e não duplica.' },
      { q: 'Como sei se o e-mail chegou?', a: 'Em Comunicação › E-mails enviados você vê a situação de cada envio e o conteúdo enviado. Envios que falharam podem ser reenviados.' },
    ],
  },
  {
    id: 'financeiro',
    title: 'Financeiro',
    faqs: [
      { q: 'Quando o faturamento é criado?', a: 'Quando o orçamento é aprovado (pelo escritório ou pelo cliente no link de aprovação). Cada orçamento gera o faturamento uma única vez.' },
      { q: 'Posso cobrar pelo Asaas ou Omie?', a: 'Sim. Configure a integração em Administração › Integrações e escolha o método de pagamento correspondente no orçamento.' },
    ],
  },
  {
    id: 'ecac',
    title: 'eCAC e procurações',
    faqs: [
      { q: 'Por que preciso de procuração?', a: 'Com a procuração eletrônica válida, o Verifco acompanha a situação da declaração, as quotas do DARF, a caixa postal e a CND do cliente no eCAC.' },
      { q: 'Como o cliente cadastra a procuração?', a: 'Envie o template Tutorial de procuração (PF) ao cliente. Ele cadastra a procuração no eCAC com a conta gov.br nível prata ou ouro.' },
    ],
  },
  {
    id: 'acesso',
    title: 'Acesso e segurança',
    faqs: [
      { q: 'Como controlo o que cada colaborador faz?', a: 'Em Administração › Funções, crie perfis e marque as permissões de cada área. O servidor confere a permissão em todas as ações.' },
      { q: 'As senhas do eCAC ficam seguras?', a: 'Senhas e certificados ficam cifrados no banco e nunca são exibidos de volta na tela.' },
    ],
  },
];
