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

```bash
pnpm test        # testes
pnpm typecheck   # tipagem
```

## Documentação

- [Arquitetura e convenções](docs/ARQUITETURA.md)
- [Mapeamento funcional](docs/mapeamento-conferir.md) e [levantamento das telas](docs/especificacao-levantamento.md)
- Marca: `brand/` (logo, símbolo, ícone e o gerador `gerar-logo.mjs`)
