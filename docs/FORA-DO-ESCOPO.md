# O que ficou de fora

Registro do que **não** foi feito na rodada "o que falta estar operacional", encerrada em
11/11/2026 (commits `e504583` a `cf1788a`). Serve para ninguém redescobrir estas lacunas do zero:
cada item diz o que existe hoje, por que ficou de fora e o que seria preciso para fazer.

A rodada começou com uma auditoria do sistema contra a especificação
([levantamento das telas](especificacao-levantamento.md) e
[mapeamento funcional](mapeamento-conferir.md)). O que a auditoria apontou e foi feito está no
histórico de commits e em [ARQUITETURA.md](ARQUITETURA.md); o resto está aqui, em quatro grupos:

1. [Limites decididos](#1-limites-decididos): não é para fazer, ou não dá para fazer com segurança.
2. [Funções que não entraram](#2-funções-que-não-entraram): fazem sentido, ficaram para depois.
3. [Feito, mas sem validação real](#3-feito-mas-sem-validação-real): funciona nos testes, falta
   provar com o serviço ou o equipamento de verdade.
4. [Pontas soltas](#4-pontas-soltas): detalhes conhecidos dentro do que foi entregue.

Ao resolver um item, apague-o daqui (ou mova para o commit que o resolve).

## 1. Limites decididos

| Item | Situação hoje | Por que ficou de fora | O que mudaria a decisão |
| --- | --- | --- | --- |
| **Ler os arquivos do programa IRPF** (.DEC e os XML da declaração) | Os arquivos ficam guardados na pasta do cliente; o recibo (.REC) marca a declaração como transmitida. O sincronizador lê só o começo do arquivo, para conferir o CPF. | O formato não é publicado. Dá para tentar a leitura (o programa guarda a declaração em XML e traz o mapa dos registros do .DEC), mas sem arquivos reais para validar o resultado seria um chute apresentado como dado. | Um conjunto de arquivos reais (com autorização dos titulares) para escrever o leitor contra eles e conferir campo a campo. |
| **Gerar .DBK** para importar no programa IRPF | Não existe. A elaboração exporta um pacote de conferência (.zip) para digitação. | O .DBK tem dígitos de controle exatos e só se prova certo restaurando no programa oficial. Um arquivo errado pode corromper a declaração do cliente. | Primeiro o leitor de .DEC validado; depois, teste de restauração no programa oficial a cada exercício. |
| **Extensão lendo as páginas do eCAC sozinha** | A extensão abre o serviço do eCAC, e a pessoa envia o arquivo baixado, registra a página (texto e imagem) ou lança a situação que conferiu na tela. O leitor automático que existia nunca funcionou e foi removido. | Nada público descreve o HTML do eCAC, e ele só aparece numa sessão autenticada. | HTML capturado de uma sessão real de cada serviço (com autorização), para escrever e testar os leitores. |
| **Importar dados do INSS** | Removido. O Verifco não guarda mais a senha gov.br para o INSS. | Exigiria guardar a senha gov.br do cliente e esbarra na verificação em duas etapas do gov.br. | Uma integração oficial com procuração (como o SERPRO faz para a Receita). |
| **Consulta simplificada sem procurador** e **CND automática** (preferências do robô) | As duas chaves existem em `services/settings.ts`, e a tela de Preferências as mostra como "não disponível". | O SERPRO Integra Contador não consulta quem não outorgou procuração nem emite CND de pessoa física. | O SERPRO passar a oferecer os serviços. Se a decisão for desistir, remover as duas chaves e o aviso da tela. |

## 2. Funções que não entraram

| Item | Situação hoje | O que seria preciso |
| --- | --- | --- |
| **Compra ou troca de plano pelo próprio escritório** | Contratos são criados pelo proprietário em `/sistema › Planos e contratos`. `Meu escritório › Contratos` orienta a falar com o suporte. O plano limita declarações e libera o backup; não há matriz de funções por plano. | Assinatura no nível da plataforma (por exemplo, Asaas), a tabela de planos com o que cada um libera e a renovação automática do contrato. |
| **Notificações com o Verifco fechado** | O sino e os avisos do navegador só chegam com uma aba aberta (`lib/deviceNotifications.ts` diz isso). | Service worker e Web Push (chaves VAPID), com a inscrição de cada navegador guardada no servidor. |
| **Aplicativo do portal do cliente** (iOS/Android) | O portal é web. Entraram o manifesto e os ícones, então ele pode ser instalado na tela inicial; não há funcionamento offline nem push. | O service worker do item acima; depois, se fizer sentido, os empacotamentos para as lojas. |
| **Agendar o envio de relatórios e do kit** | A mala direta ganhou data e hora de envio. O envio de relatórios e do kit pela etapa Relatórios é imediato. | Levar o `runAt` da mala direta para `POST /declarations/:id/kit/send` e para o envio de relatórios. |
| **Copiloto Financeiro no portal do cliente** | Só o escritório usa (aba Copiloto do cliente). | Rotas do portal para clientes inscritos e a tela correspondente. Confiança baixa na especificação: a referência estava atrás de pagamento. |
| **Fichas da declaração sem dados próprios** (identificação, endereço na declaração, doações a partidos) | Ocupação, conta para restituição e doações eleitorais não existem em `declarations/fichas.tsx`. | Campos por declaração. Pouco impacto enquanto não houver exportação para o programa IRPF. |
| **"Buscador de informes"** | Não existe, e a documentação de referência não explica o que é. | Entender a função na referência antes de qualquer coisa. |
| **Sincronizador como instalador e extensão na loja** | O sincronizador é um programa Node 22 com assistente de configuração e instalação como tarefa agendada no Windows. A extensão é carregada "sem compactação"; o botão da loja segue desabilitado. | Executável único com instalador por sistema operacional; publicação na Chrome Web Store (conta de desenvolvedor, revisão do Google). |
| **Exportar os dados de um escritório pelo painel do sistema** | O painel suspende e exclui. A cópia dos dados é o backup que o próprio escritório gera em Backup. | Uma rota do sistema que dispare o `backup.generate` de um escritório e entregue o .zip ao proprietário. |
| **Exigir verificação em duas etapas** | Cada pessoa ativa a sua; o escritório vê quem ativou, mas não obriga. | Uma preferência do escritório ("exigir duas etapas") conferida no login, com prazo para quem ainda não ativou. |
| **Bloquear o uso até confirmar o e-mail** | A confirmação é um aviso com "enviar de novo"; quem já tinha conta foi considerado confirmado. | Decidir a regra (por exemplo, bloquear envios a clientes) e aplicá-la no `requireUser`. |
| **Lista de notificações paginada** | `GET /notifications` devolve as 50 mais recentes; a página Notificações avisa que as antigas não aparecem. | `page`, `pageSize`, filtro de não lidas e total na rota. |
| **Ações em massa sobre "todos os resultados"** | As rotas em massa de clientes recebem ids (máximo 2000) e a mala direta recebe os ids no endereço (máximo 200). Só a exportação vai por filtros. | As rotas aceitarem os mesmos filtros da lista, em vez de ids. |

Dois caminhos da API continuam sem tela que os chame: `POST /finance/price-tables/:id/simulate` e
`GET /deliveries/options`.

## 3. Feito, mas sem validação real

Tudo abaixo passa nos testes com respostas simuladas. A primeira ativação com credenciais reais
deve ser acompanhada de perto.

| Onde | O que nunca foi exercitado de verdade |
| --- | --- |
| **Asaas** | `GET`, `PUT` e `DELETE /payments/{id}`, `receiveInCash`, `undoReceivedInCash` e os eventos novos do webhook (recebimento desfeito, contestação). |
| **Omie** | `AlterarContaReceber`, `ExcluirContaReceber`, `LancarRecebimento` e `CancelarRecebimento`. São as chamadas mais incertas: o desfazer depende de a consulta devolver o `codigo_baixa` dentro de `recebimento`. |
| **SERPRO** | A forma da resposta quando o cliente não tem procuração (lista vazia ou sem sistemas). |
| **Banco Central** | A consulta da série 4390 (Selic mensal). Sem rede, vale a tabela fixa do código. |
| **Meta (WhatsApp Cloud API)** | Download de mídia: resposta de `GET /{media-id}`, host do arquivo e cabeçalhos exigidos. |
| **Evolution API** | Base64 da mídia no webhook, `getBase64FromMediaMessage`, o evento `messages.update` e a conexão (`/instance/connect`, `fetchInstances`). Não se sabe se a chave da instância pode chamar `fetchInstances`; se não puder, a tela mostra "conectada" sem o número. |
| **Armazenamento S3** | A assinatura confere com os exemplos da AWS, mas nenhum arquivo foi gravado num bucket real (AWS, R2, B2 ou MinIO). |
| **Backup do servidor** | O CI faz backup cifrado e restauração com destino em pasta local. O destino S3 (rclone) e o repasse de `COMPOSE_PROFILES` pelo Dokploy não foram conferidos. |
| **Sincronizador no Windows** | `verifco-sync.cmd`, o lançador oculto, `schtasks`, o ajuste por PowerShell e a pasta Inicializar nunca rodaram em Windows. A conferência do CPF no cabeçalho do arquivo assume a posição 21, que é uma suposição sobre um formato não publicado; se estiver errada, os arquivos renomeados vão para a caixa de entrada em vez de irem para o cliente errado. |
| **Extensão** | Rodou no Chrome sem janela contra uma API simulada. O clique no ícone da barra (leitura da aba e captura de tela), o arrastar-e-soltar, o item de PDF do menu de contexto, o aviso de permissão e os navegadores Edge e Opera não foram exercitados. |
| **E-mail** | Envio de anexos grandes (kit com até 20 MB) por um provedor real. |

## 4. Pontas soltas

Detalhes conhecidos dentro do que foi entregue. Nenhum impede o uso.

**Cobrança**

- A chamada ao provedor e a gravação no Verifco não são atômicas: se a gravação falhar depois de
  o provedor aceitar, só a conciliação (a cada 6 horas) corrige.
- Cancelar um orçamento aprovado não devolve a declaração à etapa anterior.
- A prévia do plano de quotas em `DarfStep.tsx` usa só a tabela fixa da Selic; a lista, os e-mails,
  o portal e o kit usam a do Banco Central.

**Lembretes**

- Os avisos usam janela de dias: a primeira rodada depois da implantação avisa de tudo que venceu
  na última semana, de uma vez.
- "Procurador do escritório" no tutorial de procuração é o único cadastrado ou, havendo vários, o
  da integração SERPRO. Não existe um campo "procurador padrão".

**Mensagens e WhatsApp**

- A notificação do sino de mensagem nova ainda leva à aba do cliente, e abrir a conversa pela
  caixa de mensagens não marca essa notificação como lida.
- O item "Mensagens" do menu está em `Shell.tsx`, fora de `nav.ts` (que não tem suporte a selo
  numérico); por isso ele não conta em `visibleNav` nem em `firstNavPath`.
- Os limites de anexo (5 arquivos, 10 MB) estão repetidos em `messages/attachments.ts` e em
  `checklist/Chat.tsx`; o lugar certo é `packages/shared`.
- Áudio recebido fica guardado como anexo para baixar; o chat não tem tocador.
- Vídeo, figurinha e áudio em aac/amr recebidos não são guardados (a mensagem diz o motivo).
- A opção "Webhook by Events" da Evolution muda o endereço chamado e daria 404; a tela orienta a
  deixá-la desligada.
- Se o job de mídia cair entre gravar o arquivo e atualizar a mensagem, a nova tentativa grava
  outro arquivo e o primeiro fica sem dono.

**Robô**

- O sincronizador não impede duas execuções ao mesmo tempo (a API não duplica os arquivos, então
  é inofensivo).
- O lançador oculto do Windows usa VBScript, que a Microsoft está descontinuando.
- A aba "Situação" da extensão é mais alta que os 600 px do popup do Chrome e rola.

**Relatórios**

- O relatório de pensão alimentícia usa a permissão do planejamento tributário
  (`report.tax_planning`); não tem permissão própria.
- O texto do relatório cita a Lei 9.250/1995, art. 8º, II, "f" e § 3º, escritos de memória: confira
  antes de usar como referência para o cliente.
- O relatório não distingue pensão judicial de acordo informal por código: a parte não dedutível é
  o que estiver no campo "Parcela não dedutível / reembolsada" da linha.
- No kit, a "declaração exportada" (o pacote de conferência) não vem marcada para anexar; vêm
  marcados o recibo, o .DEC mais recente e os DARFs em aberto.

**Dados e segurança**

- Não há varredura de arquivos sem dono no armazenamento. Se o processo cair logo depois de
  eliminar um cliente, podem sobrar linhas de arquivo sem referência.
- O código de duas etapas não é marcado como usado: o mesmo código vale de novo dentro da janela
  de cerca de um minuto.
- A consulta da senha do eCAC é limitada a 30 por pessoa por hora e fica na auditoria, mas não
  pede a senha de quem consulta.

**Código**

- `checklist/types.ts` ainda tem o tipo `OfficeMessage` sem uso e `PortalMessage` sem `attachments`
  (o tipo foi estendido dentro de `Portal.tsx`).
- `OfficeSettings` em `admin/shared.tsx` não tem as chaves de lembrete; `PreferencesTab.tsx`
  estende o tipo localmente.
- As opções dos jobs novos (lembretes, conciliação, retenção, mídia) estão no `register` de cada
  módulo, não em `jobs/policies.ts`.
- A entrada `ai` do catálogo de integrações (`packages/shared/src/integrations.ts`) descreve a
  chave de IA por escritório, que não existe mais; a tela já a esconde.
