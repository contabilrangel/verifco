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

## Documentação

- [Arquitetura e convenções](docs/ARQUITETURA.md)
- [Mapeamento funcional](docs/mapeamento-conferir.md) e [levantamento das telas](docs/especificacao-levantamento.md)
- Marca: `brand/` (logo, símbolo, ícone e o gerador `gerar-logo.mjs`)
- Produção: [Implantação completa no Dokploy](docs/DOKPLOY.md)
- Instalação existente: [Inventário da produção e pendências](docs/INVENTARIO-DOKPLOY.md)

## Administração do sistema e IA

O painel do proprietário e desenvolvedor fica em `/sistema`, com contas separadas do
painel do contador. Conexões e chaves de IA são gerenciadas globalmente pelo proprietário.
Consulte [Administração global e inteligência artificial](docs/PLATAFORMA-IA.md) para
criar o primeiro acesso e configurar os serviços.
