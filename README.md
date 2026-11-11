<p align="center"><img src="brand/verifco-logo.svg" alt="Verifco" height="56"></p>

# Verifco

Gestão de IRPF para escritórios contábeis: clientes, procurações, documentos, checklist
digital, Kanban das declarações, orçamentos e cobrança, comunicação com o cliente,
relatórios e análises (caixa, patrimônio, IRPFM, holding), assistentes de IA e integrações
(Asaas, Omie, WhatsApp, e-mail, eCAC).

## Como rodar

Requisitos: Node 22+ e pnpm 10.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # opcional: ajuste as variáveis
pnpm dev
```

- Web: http://localhost:5173 (crie a conta do escritório em "Criar conta")
- API: http://localhost:3333/api

Sem PostgreSQL configurado, a API usa um banco embutido (PGlite) em `apps/api/.data/`.

Para explorar com dados de exemplo (clientes, declarações de 3 anos, orçamentos, DARFs,
checklist, mensagens, Radar):

```bash
pnpm db:seed     # cria o escritório de demonstração: demo@verifco.dev / verifco-demo-123
```

```bash
pnpm test        # testes
pnpm typecheck   # tipagem
```

## O que roda sozinho

Com a API no ar (e `RUN_WORKER` ligado em pelo menos uma instância), o Verifco cuida de:

- lembretes diários ao cliente (DARF e honorários) e à equipe (procuração, certificado, cobranças
  vencidas, contrato), às 8h de Brasília;
- emissão, envio e conciliação das cobranças no Asaas ou no Omie;
- sincronização do eCAC pelo SERPRO, quando configurada;
- atualização semanal da Selic (juros do DARF) e limpeza diária do que venceu o prazo de guarda.

Em produção, acompanhe por `GET /ready`, pelo painel `/sistema › Operação` e pelos logs; o backup
do servidor e o roteiro de restauração estão em [docs/RESTAURACAO.md](docs/RESTAURACAO.md).

## Documentação

- [Arquitetura e convenções](docs/ARQUITETURA.md)
- [Mapeamento funcional](docs/mapeamento-conferir.md) e [levantamento das telas](docs/especificacao-levantamento.md)
- Marca: `brand/` (logo, símbolo, ícone e o gerador `gerar-logo.mjs`)
- Produção: [Implantação completa no Dokploy](docs/DOKPLOY.md) e [backup e restauração](docs/RESTAURACAO.md)
- Instalação existente: [Inventário da produção e pendências](docs/INVENTARIO-DOKPLOY.md)

## Administração do sistema e IA

O painel do proprietário e desenvolvedor fica em `/sistema`, com contas separadas do
painel do contador. Conexões e chaves de IA são gerenciadas globalmente pelo proprietário.
Consulte [Administração global e inteligência artificial](docs/PLATAFORMA-IA.md) para
criar o primeiro acesso e configurar os serviços. No mesmo painel ficam a fila de tarefas, o
teste do e-mail do sistema, a suspensão e a exclusão de escritórios, o cadastro aberto ou fechado
e os termos de uso.

## Limites conhecidos

- O Verifco não lê nem gera os arquivos do programa IRPF (.DEC, .DBK): eles ficam guardados na
  pasta do cliente e o recibo (.REC) marca a declaração como transmitida.
- A extensão do navegador não lê as páginas do eCAC sozinha; ela envia o que a pessoa escolhe.
- As integrações com Asaas, Omie, SERPRO, Meta, Evolution API e Banco Central são cobertas por
  testes com respostas simuladas; a primeira ativação com credenciais reais deve ser acompanhada.
- Contratos e planos são criados pelo proprietário do sistema; não há compra pelo próprio
  escritório.
