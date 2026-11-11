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
      { q: 'Por onde começo?', a: 'Cadastre o logo e os dados do escritório em Meu escritório › Empresa, convide a equipe em Colaboradores e importe a carteira em Clientes › Novos clientes em lote.' },
      { q: 'O que é o ano-exercício da barra superior?', a: 'É o ano de entrega da declaração (o exercício 2026 corresponde ao ano-calendário 2025). Ele vale para todas as telas, filtros e relatórios.' },
      { q: 'Como favorito uma tela?', a: 'Clique na estrela ao lado do título da página. Os favoritos ficam salvos no seu usuário e aparecem no topo do menu lateral. Na lista de Clientes, o favorito guarda a busca, os filtros e a ordem.' },
    ],
  },
  {
    id: 'clientes',
    title: 'Clientes',
    faqs: [
      { q: 'Como encontro um cliente?', a: 'Digite o nome, o CPF ou o e-mail na busca da barra superior: os primeiros clientes aparecem enquanto você digita e Enter abre a lista completa. Na lista de Clientes há filtros por grupo, responsável, procuração e status da declaração, e a ordem por nome, cadastro ou atualização.' },
      { q: 'Posso alterar vários clientes de uma vez?', a: 'Sim. Na lista de Clientes, selecione os clientes e use o menu Ações para mudar status, responsável, grupos, procurador, exportar para Excel ou enviar a mala direta. Depois de marcar a página inteira, “Selecionar todos os resultados” estende a seleção a todos os clientes da busca e dos filtros (as ações em massa aceitam até 2.000 clientes por vez).' },
      { q: 'Um colaborador pode ver só os clientes dele?', a: 'Sim. Em Meu escritório › Preferências, ative a restrição de visibilidade por responsável. O dono do escritório continua vendo todos.' },
    ],
  },
  {
    id: 'irpf',
    title: 'Declaração IRPF',
    faqs: [
      { q: 'Quais são as etapas da declaração?', a: 'Na aba IRPF do cliente: orçamento, declaração, documentação (checklist), DARF, relatórios, documentos faltantes, documentos e holding. O status de cada declaração aparece no Kanban.' },
      { q: 'Como peço documentos que faltam?', a: 'Na etapa Documentos faltantes do cliente, cadastre cada documento com a data limite e envie a lista por e-mail ou WhatsApp. O relatório Documentos faltantes mostra o que falta em toda a carteira.' },
      {
        q: 'O Verifco lê os arquivos do programa IRPF?',
        a: 'Não. Os arquivos .DEC, .REC e .DBK enviados pelo sincronizador ficam guardados nos documentos do cliente, e o recibo (.REC) marca a declaração como transmitida. Nada é lido de dentro deles: as linhas da declaração são cadastradas na etapa Declaração ou validadas em Elaboração.',
      },
      { q: 'O que é o kit pós-declaração?', a: 'Um PDF para o cliente com o resumo da declaração transmitida, as quotas do DARF ou a restituição, a evolução do patrimônio e lembretes para o próximo ano. Baixe na etapa Relatórios ou envie dali ao cliente: no envio por e-mail você escolhe documentos da declaração para irem anexados (recibo de entrega, cópia da declaração, guias DARF em aberto), até 20 MB no total. Pela mala direta o kit vai em lote, só com o resumo.' },
      { q: 'Existe relatório de pensão alimentícia?', a: 'Sim, na etapa Relatórios do cliente: por alimentando, a pensão paga no ano, a parte dedutível e as despesas médicas e de instrução pagas por decisão judicial, com o lembrete das regras. Ele sai das linhas de pensão lançadas na declaração.' },
      { q: 'Posso colar um template de outro sistema?', a: 'Pode. Além das variáveis do Verifco, o texto aceita {{CUSTOMER_NAME}} e {{Cliente}} (nome do cliente) e {{FORMULARY_URL}} (link), e o nome de qualquer variável em minúsculas ou com acento. Uma variável que o Verifco não conhece aparece destacada ao salvar, em vez de ir vazia para o cliente.' },
    ],
  },
  {
    id: 'relatorios',
    title: 'Relatórios',
    faqs: [
      { q: 'Quais relatórios posso gerar para um cliente?', a: 'Na etapa Relatórios da aba IRPF: análise de caixa, detalhes do caixa, histórico patrimonial e do caixa (últimos 5 exercícios), aviso de malha fina, planejamento tributário e bens e direitos, em PDF ou Excel.' },
      { q: 'Por que o relatório diz que a declaração não tem linhas?', a: 'Os relatórios usam as linhas cadastradas da declaração (rendimentos, pagamentos, bens, dívidas). Cadastre as linhas na etapa Declaração do cliente, ou valide em Elaboração as linhas que a IA leu dos documentos, antes de gerar.' },
      { q: 'Para que servem os "Outros gastos"?', a: 'Gastos que não aparecem na declaração, como juros, cartão de crédito e perdas de capital, entram na análise de caixa como aplicações do ano e deixam o saldo mais próximo da realidade.' },
      { q: 'Quando posso exibir os dados do cônjuge?', a: 'Quando o cônjuge está como dependente (relação cônjuge) e também é cliente do escritório com declaração no mesmo exercício. Os relatórios passam a mostrar os dois e o consolidado do casal.' },
      { q: 'O que mostram os relatórios gerais?', a: 'Em Relatórios: faturamento, resultados (imposto a pagar e a restituir da carteira), documentos faltantes por cliente e restituições com a data dos lotes. A tela mostra 50 linhas por página; “Imprimir” e o Excel saem com o relatório inteiro.' },
    ],
  },
  {
    id: 'comunicacao',
    title: 'Comunicação',
    faqs: [
      { q: 'Como personalizo os e-mails?', a: 'Em Comunicação › Templates de e-mail, edite o assunto e o conteúdo. Clique nas variáveis para inserir dados do cliente, como {{CLIENTE}}. Use Pré-visualizar para conferir e Restaurar modelo padrão para desfazer.' },
      { q: 'Como envio uma mala direta?', a: 'Em Comunicação › Mala direta, escolha o tipo, os destinatários (por filtros ou pela seleção feita na lista de clientes) e o canal. A revisão mostra quantos clientes não têm e-mail ou celular antes de enviar. Depois de confirmar, os envios são preparados em segundo plano e a tela mostra o andamento. Em “Malas diretas recentes”, na primeira etapa, abra uma mala direta para ver quantos envios estão na fila, saíram ou falharam em cada canal e quais clientes tiveram falha, com o motivo. Cada mala direta vai para até 5.000 clientes; acima disso, a revisão avisa quantos ficam de fora.' },
      { q: 'O mesmo envio pode sair duas vezes?', a: 'Não. Cada envio tem uma identificação única; se a tela for confirmada duas vezes, o sistema reconhece a repetição e não duplica.' },
      { q: 'Como sei se o e-mail chegou?', a: 'Em Comunicação › E-mails enviados você vê a situação de cada envio e o conteúdo enviado. Envios que falharam podem ser reenviados.' },
    ],
  },
  {
    id: 'financeiro',
    title: 'Financeiro',
    faqs: [
      { q: 'Quando o faturamento é criado?', a: 'Quando o orçamento é aprovado (pelo escritório ou pelo cliente no link de aprovação). Cada orçamento gera o faturamento uma única vez.' },
      { q: 'Posso cobrar pelo Asaas ou Omie?', a: 'Sim. Configure a integração em Meu escritório › Integrações e escolha o método de pagamento correspondente no orçamento.' },
    ],
  },
  {
    id: 'ecac',
    title: 'eCAC e procurações',
    faqs: [
      {
        q: 'Por que preciso de procuração?',
        a: 'Com a procuração eletrônica válida e o SERPRO Integra Contador ativo, o robô acompanha todo dia a procuração, a caixa postal, a situação fiscal e o pagamento das quotas do DARF do cliente. A situação da declaração (malha, lote de restituição) e a CND não vêm pelo SERPRO: lance-as na aba eCAC do cliente.',
      },
      { q: 'Como o cliente cadastra a procuração?', a: 'Envie o template Tutorial de procuração (PF) ao cliente. Ele cadastra a procuração no eCAC com a conta gov.br nível prata ou ouro.' },
    ],
  },
  {
    id: 'portal',
    title: 'Portal do cliente',
    faqs: [
      { q: 'O que o cliente vê no portal?', a: 'O andamento da declaração, o que o escritório precisa dele (documentos do checklist), os orçamentos para aprovar, os documentos que o escritório compartilhou (declaração, recibo, DARF) e as mensagens trocadas com o escritório.' },
      { q: 'Como libero o acesso?', a: 'Na aba Identificação do cliente, use “Gerar acesso ao portal do cliente”: ele recebe por e-mail o código de acesso e entra com o CPF e o código. É preciso ter o e-mail cadastrado. No mesmo lugar dá para reenviar ou revogar o acesso.' },
    ],
  },
  {
    id: 'elaboracao',
    title: 'Elaboração e pré-preenchidas',
    faqs: [
      { q: 'O que a Elaboração faz?', a: 'A IA lê os documentos do cliente (PDF ou imagem) e propõe as linhas da declaração, comparando com as já lançadas. Em “Conferir” você aceita ou recusa as linhas em conflito e “Validar” aplica as aceitas. A exportação gera um pacote .zip de conferência (linhas em CSV/JSON e os documentos usados) para digitar no programa IRPF: não é um arquivo do programa.' },
      { q: 'Como funcionam as Pré-preenchidas?', a: 'A tela guarda os arquivos das pré-preenchidas do exercício, que chegam pelo sincronizador ou por envio manual. O procurador baixa o arquivo no eCAC; no Verifco você baixa um por vez, só os novos ou todos em um .zip, e inicia a declaração no programa IRPF a partir dele.' },
    ],
  },
  {
    id: 'oportunidades',
    title: 'Radar e assistentes',
    faqs: [
      { q: 'O que é o Radar de oportunidades?', a: 'Em Início › Radar de oportunidades, o Verifco aponta clientes com sinais de serviços adicionais nas declarações do exercício (alto patrimônio, criptoativos, renda variável, atividade rural, carnê-leão, abertura de empresa, IRPFM e holding). “Atualizar dados” refaz a análise; em cada cartão você vê os clientes, marca o andamento e abre uma campanha de mala direta.' },
      { q: 'O que são os Assistentes de IA?', a: 'Na aba IA do cliente há três especialistas em conversa (IR, Malha Fina, com minuta de defesa administrativa, e Ganho de Capital) e o Assessor Financeiro, que analisa até 10 documentos do cliente. As respostas são apoio ao trabalho: revise fatos, valores e fundamentação antes de usar.' },
      { q: 'O que é o Copiloto Financeiro?', a: 'Uma aba do cliente com receitas e despesas por mês, orçamento por categoria, vencimentos, seguros, bens e contas no exterior, documentos, a projeção do IRPFM e uma conversa com IA sobre esses dados. O cliente precisa ser habilitado em Meu escritório › Copiloto Financeiro; o limite de clientes vem do contrato.' },
      { q: 'Para que serve o Livro Caixa?', a: 'Na aba Livro Caixa do cliente, baixe os modelos de planilha, converta a planilha preenchida em lançamentos, revise os lançamentos por mês e exporte o arquivo para importar no Carnê-Leão Web (Escrituração › Importar Escrituração).' },
    ],
  },
  {
    id: 'acesso',
    title: 'Acesso e segurança',
    faqs: [
      { q: 'Como controlo o que cada colaborador faz?', a: 'Em Meu escritório › Funções, crie perfis e marque as permissões de cada área. O servidor confere a permissão em todas as ações.' },
      { q: 'As senhas do eCAC ficam seguras?', a: 'Senhas e certificados ficam cifrados no banco e nunca são exibidos de volta na tela.' },
      { q: 'Como faço backup dos dados do escritório?', a: 'Em Backup (para quem tem a permissão), “Gerar backup” monta em segundo plano um arquivo .zip com os dados e os arquivos do escritório para guardar fora do Verifco. O arquivo contém dados pessoais e fiscais dos clientes: guarde em local seguro e com acesso restrito.' },
      { q: 'Por que voltei para a tela de login?', a: 'A sessão vale por 12 horas e também termina quando o acesso é revogado. A tela de login avisa que a sessão expirou; ao entrar de novo, o Verifco volta para a página em que você estava.' },
      { q: 'O que é o modo de consulta?', a: 'Quando o contrato do escritório vence, um aviso aparece no topo das páginas e o Verifco passa a só consultar: dá para ver e exportar os dados, mas não para cadastrar nem alterar, até a renovação. Os contratos ficam em Meu escritório › Contratos.' },
    ],
  },
];
