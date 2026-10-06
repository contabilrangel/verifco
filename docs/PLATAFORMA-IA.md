# Administração global e inteligência artificial

O painel em `/sistema` é exclusivo do proprietário e da equipe de desenvolvimento do
Verifco. O painel do contador mantém seus próprios usuários, permissões e dados do
escritório; sua área de configurações se chama **Meu escritório**.

## Acesso e responsabilidades

- Contas da plataforma estão em `platform_users`, sem vínculo com escritórios.
- O proprietário administra escritórios, contratos, conexões de IA e contas do sistema.
- O desenvolvedor consulta escritórios, contratos, indicadores operacionais e auditoria.
  Ele não consulta nem altera conexões e chaves de IA ou contas administrativas.
- Os tokens têm tipos distintos e a sessão global dura uma hora. Tokens do contador e
  do portal do cliente não autenticam rotas globais. Tokens globais não autenticam
  rotas do escritório. O navegador guarda as sessões em chaves diferentes.
- Desativar uma conta ou sair revoga seus tokens. O próprio proprietário não pode
  desativar a própria conta; operações concorrentes preservam um proprietário ativo.
- Login possui limites por IP e por e-mail. Alterações globais têm auditoria separada
  sem senhas, chaves ou conteúdo de documentos.

### Criar o primeiro proprietário

Não existe cadastro público nem senha administrativa padrão. No servidor, defina
`PLATFORM_OWNER_NAME`, `PLATFORM_OWNER_EMAIL` e `PLATFORM_OWNER_PASSWORD` (mínimo 12
caracteres), juntamente com a configuração real do banco e da aplicação, e execute:

```sh
pnpm --filter @verifco/api platform:owner
```

Esse comando aplica as migrações e cria a primeira conta, com senha protegida por bcrypt.
Ele recusa execução quando já existe uma conta da plataforma. As próximas contas são
criadas pelo proprietário em **Equipe do sistema**. As credenciais da prévia local
são exclusivas do banco de demonstração e não são criadas em instalações normais.

## Conexões de IA

Há 13 opções: Claude/Anthropic, OpenAI, Gemini, DeepSeek, Mistral, Groq, Grok/xAI,
OpenRouter, Together AI, Fireworks AI, Cerebras, Ollama e outra API compatível com
Chat Completions. Podem ser criadas várias conexões, inclusive modelos diferentes
do mesmo serviço. O nome exato do modelo deve ser copiado do fornecedor.

O proprietário salva a chave e o modelo, pode testar uma resposta mínima e escolhe
a conexão padrão. **Testar resposta** faz uma chamada de geração e pode consumir
créditos. O teste registra resultado e data; não confirma as capacidades de todos os
modelos ou formatos de anexo.

As chaves ficam cifradas no servidor, em `platform_ai_connections`. O navegador
recebe apenas a indicação de chave configurada. Campo vazio mantém a chave salva.
Os assistentes e a elaboração de declarações resolvem a escolha global a cada pedido.
Conexões desativadas ou indisponíveis falham com uma mensagem clara; não há troca
automática de serviço. A conexão padrão não pode ser excluída antes de outra escolha.

Instalações existentes ainda podem usar `ANTHROPIC_API_KEY` e `AI_MODEL` do ambiente
quando não há conexão padrão selecionada. Chaves antigas de IA dos escritórios
permanecem cifradas, mas não são utilizadas nem expostas pela API de integrações.

### Anexos e modelos locais

- Claude, OpenAI e Gemini recebem PDF pelo formato nativo de cada API. O modelo
  escolhido precisa aceitar esse formato.
- Imagens exigem um modelo com visão e a opção **Este modelo aceita imagens**.
- APIs compatíveis recebem texto e imagens em base64; PDFs não são aceitos nesse
  adaptador. Nenhum anexo incompatível é descartado silenciosamente.
- OpenAI usa Responses com `store: false`; Gemini usa GenerateContent e ignora
  partes de raciocínio privado na resposta. Serviços compatíveis usam Chat Completions.
- Respostas vazias, recusadas ou truncadas pelo limite de tokens não são aceitas como
  respostas completas. Erros remotos não devolvem conteúdo arbitrário do fornecedor.
- Ollama usa apenas `http://127.0.0.1:11434/v1` no servidor do Verifco. É necessário
  instalar Ollama e baixar o modelo nesse servidor.
- Endereços personalizados exigem HTTPS público, sem credenciais, query ou fragmento.
  A conexão confere DNS/IP, bloqueia rede interna e não segue redirecionamentos.

## Administração dos escritórios

O painel global permite consultar e editar os dados básicos dos escritórios, criar
e editar contratos, definir plano, exercício, vigência, limite de declarações e
direito a backup. Esses são os mesmos contratos que as regras existentes de acesso,
limites e backup utilizam. O painel não cria cobranças nem assina contratos comerciais.
As consultas de escritórios e contratos são paginadas; a busca de escritórios ocorre
no servidor. Datas de vigência e auditoria seguem o horário de Brasília.

## Verificação

Testes cobrem separação dos tokens, permissões dos perfis, revogação, credenciais
cifradas, ausência de segredos nas respostas e auditoria, contratos vistos pelo
contador, paginação, configuração global entre escritórios, chaves legadas ignoradas,
URLs bloqueadas, protocolos e anexos de IA. As chamadas externas são simuladas nos
testes: validar uma conta real exige a chave e o modelo contratados no fornecedor.
Migração `0006_plataforma_ia` gerada pelo Drizzle; o bootstrap da prévia aplicou-a
sobre a base existente.

## Referências oficiais dos adaptadores

- [OpenAI: Responses](https://developers.openai.com/api/reference/typescript/resources/responses)
  e [arquivos de entrada](https://developers.openai.com/api/docs/guides/file-inputs).
- [Anthropic: Messages](https://docs.claude.com/en/api/messages).
- [Gemini: GenerateContent](https://ai.google.dev/api/generate-content?hl=en).
- [DeepSeek: Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/).
- [Mistral: API](https://docs.mistral.ai/api).
- [Groq: compatibilidade](https://console.groq.com/docs/openai).
- [xAI: API](https://docs.x.ai/developers/rest-api-reference).
- [OpenRouter: início rápido](https://openrouter.ai/docs/quickstart).
- [Together: compatibilidade](https://docs.together.ai/docs/inference/openai-compatibility).
- [Fireworks: compatibilidade](https://docs.fireworks.ai/tools-sdks/openai-compatibility).
- [Cerebras: compatibilidade](https://inference-docs.cerebras.ai/resources/openai).
- [Ollama: compatibilidade](https://docs.ollama.com/api/openai-compatibility).
