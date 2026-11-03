# AIR Organizer — Arquitetura de Software

> **Status:** arquitetura v1.3 (POC-01E implementada, somente leitura) · **Data:** 03/11/2026  
> **Objetivo:** reduzir o trabalho manual de análise, consolidação e organização de pastas no AIR, começando por uma ferramenta pequena, funcional, segura e reutilizável entre clientes, cidades, setores e implantadores.  
> **Versão oficial:** este arquivo, no repositório (`air-organizer/ARCHITECTURE.md`). Cópias fora do repositório não são mantidas e não devem ser usadas como referência.  
> **Dados:** todos os exemplos deste documento são fictícios. Nenhum nome real de cliente, município, setor, pasta ou pessoa deve ser registrado aqui.

## 1. Visão e princípios

O AIR Organizer é uma automação **externa e supervisionada**, executada localmente no Google Chrome, para inspecionar a hierarquia de pastas em diferentes instâncias, municípios, clientes e setores do AIR, detectar possíveis duplicidades, propor consolidações e, em uma fase posterior, realizar **movimentações explicitamente aprovadas** usando a interface oficial do produto.

**Princípios não negociáveis:**

1. **Funcionalidade antes de sofisticação:** entregar valor com CLI e relatórios locais, sem dashboard, backend próprio, qualquer banco de dados ou agentes de IA no MVP.
2. **Somente interface autorizada:** usar Playwright para interagir com o frontend, sem endpoints privados, chamadas diretas ao backend, engenharia reversa de autenticação ou bypass de permissões.
3. **Leitura primeiro:** nenhuma operação de escrita nas fases de inspeção e diagnóstico.
4. **Humano no controle:** nenhum movimento sem plano revisado, aprovação explícita e escopo autorizado.
5. **Segurança por padrão:** impedir movimentações entre setores, destinos inesperados, movimentação circular e alterações fora do plano.
6. **Retomada e rastreabilidade:** cada leitura e operação tem checkpoint, resultado e evidência suficiente para reconciliação.
7. **Reutilização multiambiente:** não fixar cliente, município, domínio, setor ou pasta no código; cada execução possui escopo isolado.
8. **Sem banco de dados no MVP:** inventários e planos em memória; arquivos JSON/JSONL locais opcionais apenas para progresso, auditoria e exportação.
9. **Não expor documentos:** não baixar conteúdo, não enviar metadados sensíveis para serviços externos e não registrar tokens, cookies ou conteúdo documental em logs.

## 2. Contexto operacional e abrangência

- **Produto-alvo:** AIR (Printer do Brasil), acessado pelo Google Chrome, em **qualquer instância/cliente/cidade compatível** com os fluxos de UI validados.
- **Usuários-alvo:** diferentes analistas/implantadores, cada um executando a ferramenta localmente com sua própria sessão autorizada e permissões existentes no AIR.
- **Ferramenta multiambiente e multissetor:** uma única base de código atende qualquer instância, cliente/município e setor compatíveis. Nenhum deles é constante de negócio; todos são contexto de execução informado ou confirmado pelo operador.
- **Escopo por execução:** uma instância AIR, um cliente/organização, um setor e uma raiz de análise; a ferramenta não presume que um setor ou uma pasta de um ambiente exista em outro.
- **Validação:** as POCs foram validadas em uma instância real autorizada. Os nomes do cliente, dos setores e das pastas usados nessa validação **não são registrados** no repositório. Testes e documentação usam apenas dados sintéticos.
- **Sem SaaS ou cadastro paralelo:** suporte a múltiplos implantadores significa distribuição da mesma ferramenta local, não um serviço central multiusuário.
- Setores reais podem ter da ordem de dezenas de milhares de pastas e centenas de milhares de arquivos. Esse é contexto operacional para dimensionamento, **não** uma contagem verificada pela automação.
- A interface permite selecionar itens e utilizar a ação nativa **Itens selecionados → Mover para**.
- Há relato de seleção inconsistente após movimentar lotes paginados; o estado visual de seleção **não é prova** de seleção efetiva.
- Movimentar uma pasta pode transportar todo seu conteúdo, mas não se deve presumir fusão automática de subpastas homônimas.
- A ferramenta deve trabalhar sem download e reenvio de arquivos.

### 2.1 Evidências observadas na interface (estrutura, sem dados)

Nas leituras somente leitura das POC-01A a 01D, a listagem de pastas expôs:

- Tabela HTML com uma coluna de ícone de tipo sem cabeçalho, seguida de **Nome**, **Descrição**, **Caminho**, **Data criação** e **Status**.
- Botões de seleção com `aria-label="Select row"` e seleção geral `aria-label="Select all"`.
- Contador textual `X de N linhas(s) selecionadas`, em que **N conta só as linhas da página exibida** (ver §7.4), e controle de registros por página (30 ou 50, conforme a sessão).
- Título `<h2>Nome da pasta (N)</h2>`, em que N é o total de **filhos diretos** da pasta.
- Paginador só com ícones (`[«][‹][1][2]…[N][›][»]`); a URL não muda ao paginar.
- Breadcrumb ausente na raiz, `raiz / atual` no 2º nível e intermediários colapsados num menu "More" do 3º nível em diante.
- Filtro de tipo ("Todos" | "Arquivos" | "Pastas") e busca acima da tabela.
- Nomes que diferem só por caixa, acento ou pontuação, um padrão que motiva a análise de duplicidades. Exemplos **fictícios** desse padrão: `PLANETAS`/`Planetas`, `ORBITAS`/`ÓRBITAS`. Um par como `Catalogo`/`Catalogo-2031` exige avaliação semântica; não é duplicidade automática.

**Não verificado ainda:** identificadores estáveis dos itens, comportamento do modal de destino, conclusão assíncrona de movimentos, persistência de seleção e cobertura de setores inteiros. Ver também README, "Limitações conhecidas".

## 3. Escopo do MVP

### Incluído

1. Análise dirigida de uma pasta selecionada e seus descendentes.
2. Varredura completa de um setor, com progresso, checkpoints e retomada.
3. Inventário de pastas/arquivos com metadados disponíveis na UI.
4. Detecção de nomes normalizados iguais e similaridade configurável; análise de hierarquias conflitantes.
5. Relatório de cobertura, incertezas e erros; exportação JSON e resumo Markdown/CSV opcional.
6. Escolha de pasta principal e geração de plano de movimentação em **dry-run**.
7. Em fase posterior: movimentação em pequenos lotes, supervisionada, com verificação pós-operação.
8. Descoberta e confirmação do ambiente, cliente e setor em cada execução, sem identificadores hardcoded.

### Fora do MVP

- Interface web própria, extensão Chrome, aplicativo desktop empacotado.
- **Qualquer banco de dados (local ou remoto)**, servidor, sincronização central, integração de API privada.
- Cadastro de usuários do Organizer: a identidade e as permissões permanecem no AIR.
- Download, leitura do conteúdo dos PDFs, OCR ou comparação binária de arquivos.
- Deduplicação automática de documentos ou exclusão de pastas vazias.
- Classificação com IA externa ou decisões irreversíveis autônomas.
- Execução simultânea em vários setores ou várias sessões.

## 4. Stack e execução

- **Runtime:** Node.js LTS.
- **Linguagem:** TypeScript em modo `strict`.
- **Automação:** Playwright para Chrome/Chromium.
- **CLI:** interface de linha de comando simples; dependências mínimas.
- **Sem banco de dados:** nenhum PostgreSQL, SQLite, Supabase ou backend próprio no MVP. Processar em memória; usar apenas arquivos JSON/JSONL locais mínimos para inventários opcionais, checkpoints e auditoria, com escrita atômica. Esses arquivos guardam **metadados operacionais**, nunca documentos.
- **Testes:** runner de testes TypeScript (por exemplo, Vitest) e fixtures HTML sintéticas.
- **Ambiente:** Windows 11 + VS Code; execução local. WSL é opcional, desde que a conexão com o Chrome seja validada.

**Sessão autenticada:** utilizar somente um perfil/sessão de navegador explicitamente autorizado e compatível com a automação. Não copiar cookies, não extrair tokens e não habilitar depuração remota em perfis pessoais ou compartilhados sem avaliação de segurança. Se for necessário conectar a um Chrome já aberto, validar previamente o método e seu isolamento; não presumir que o Playwright consegue controlar qualquer aba existente.

## 5. Arquitetura lógica

```text
CLI / comandos
      │
      ▼
Orquestrador de execução
      ├──────────────► Context Resolver (instância, cliente, setor, raiz)
      ├──────────────► Safety Gate (escopo, permissões, aprovações)
      │
      ├──► Scanner ──────► AIR Reader + Navigator ──► UI AIR / Chrome
      │         │
      │         └──► Inventário + checkpoints
      │
      ├──► Duplicate Analyzer ──► candidatos / evidências
      │
      ├──► Planner ─────────────► plano de movimentação / dry-run
      │
      └──► Executor ────────────► AIR Mover ─────────► UI AIR / Chrome
                    │
                    └──────────► Verificador + auditoria
```

**Regra de dependência:** `core` e `safety` não dependem de Playwright. O módulo `air` implementa adaptadores de UI e pode mudar sem reescrever o algoritmo de análise.

### 5.1 Estrutura de diretórios

**Implementada (POC-01D):**

```text
air-organizer/
├── src/
│   ├── air/
│   │   ├── reader.ts          # extração da listagem (DOM, somente leitura)
│   │   ├── navigator.ts       # ambiente, breadcrumb e paginação verificada
│   │   ├── folders.ts         # abrir UMA subpasta e voltar ao pai, com verificação de identidade
│   │   ├── tree-navigator.ts  # adaptador da leitura recursiva (implementa TreeNavigator)
│   │   └── session.ts         # Chrome com perfil dedicado, fora do repositório
│   ├── core/
│   │   ├── scanner.ts         # paginação e cobertura de uma pasta
│   │   ├── tree-scanner.ts    # leitura recursiva DFS com limites, status por subárvore e retomada
│   │   ├── checkpoint.ts      # modelo puro do checkpoint: pseudônimos, integridade, validação
│   │   ├── records.ts         # parsing das linhas e classificação de tipo
│   │   ├── structural-diagnostics.ts # diagnóstico estrutural determinístico (POC-02A)
│   │   └── duplicates.ts      # normalização e suspeitas de duplicidade
│   ├── safety/
│   │   └── scope-validator.ts # ações permitidas, escopo, URLs, caminhos de saída
│   ├── storage/
│   │   ├── export.ts          # relatórios diagnósticos e inventários JSON (escrita atômica)
│   │   ├── checkpoints.ts     # checkpoints locais: chave HMAC, escrita atômica, trava, retenção
│   │   └── inventory-files.ts # inventários exportados e relatórios estruturais em output/
│   ├── cli/
│   │   ├── index.ts           # menu interativo
│   │   └── args.ts            # --url / AIR_ORGANIZER_URL
│   └── types/
│       └── inventory.ts       # contratos
├── tests/
│   ├── fixtures/              # HTML sintético
│   ├── unit/
│   └── integration/           # Chrome headless sobre as fixtures
├── output/                    # ignorado pelo Git
├── .env.example               # apenas parâmetros não sensíveis
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
└── ARCHITECTURE.md
```

**Planejada (ainda não existe):**

| Módulo | Fase | Função |
|---|---|---|
| `air/context.ts`, `core/context.ts` | POC-01/02 | descoberta e confirmação de cliente/setor pela UI (hoje informados pelo operador) |
| `air/selectors.ts` | POC-02 | seletores centralizados (hoje estão em `reader.ts`, `navigator.ts` e `folders.ts`) |
| `core/planner.ts` | POC-02 | DAG de operações e dry-run |
| `safety/audit.ts`, `safety/approvals.ts` | POC-02/03 | eventos, reconciliação, aprovação humana |
| `air/mover.ts` | POC-03 | movimentação supervisionada; **desabilitada** até autorização |

## 6. Modelo de dados mínimo

> Os tipos abaixo são o **modelo alvo**. Os contratos implementados hoje estão em `src/types/inventory.ts` (`AirEnvironment`, `AirItem`, `CoverageReport`, `TreeResult`…).

O **contexto de execução** é definido antes do scanner e validado novamente antes de qualquer operação. Nenhum identificador de cliente, cidade, setor ou pasta deve ser codificado como constante. A URL por si só não comprova o cliente; se a UI não expuser identificadores estáveis, registrar o contexto como não confirmado e bloquear escritas.

```ts
type ExecutionContext = {
  runId: string;
  instanceOrigin: string;       // origem validada do AIR, sem tokens/query strings
  clientKey: string;            // ID da UI, se disponível; senão chave local validada
  sectorKey: string;            // setor selecionado explicitamente
  rootFolderKey: string;        // ID estável ou caminho verificado
  mode: 'folder' | 'sector';
  readOnly: boolean;            // true obrigatório na POC-01 e POC-02
  operatorLabel?: string;       // opcional, sem credenciais
};


type ItemKind = 'folder' | 'file';

type AirItem = {
  id?: string;                 // somente se ID estável for observado na UI
  kind: ItemKind;
  name: string;
  parentPath: string;
  fullPath: string;
  createdAt?: string;
  sizeBytes?: number;
  sectorKey: string;
  instanceOrigin: string;
  clientKey: string;
  sourcePage: number;
  observedAt: string;
  identityConfidence: 'stable-id' | 'path-and-metadata' | 'ambiguous';
};

type ScanCheckpoint = {
  runId: string;
  instanceOrigin: string;
  clientKey: string;
  sectorKey: string;
  rootPath: string;
  pendingFolderPaths: string[];
  completedFolderPaths: string[];
  observedItemCount: number;
  partial: boolean;
  lastUpdatedAt: string;
};

type DuplicateCandidate = {
  candidateId: string;
  itemPaths: string[];
  reason: 'normalized-name' | 'similar-name' | 'hierarchy-conflict';
  confidence: 'high' | 'medium' | 'low';
  requiresHumanReview: true;
};

type MoveOperation = {
  operationId: string;
  sourcePath: string;
  destinationFolderPath: string;
  sectorKey: string;
  instanceOrigin: string;
  clientKey: string;
  dependsOn: string[];
  expectedSourceFingerprint: string;
  status: 'planned' | 'approved' | 'in-progress' | 'verified' | 'uncertain' | 'failed';
};
```

IDs sintéticos locais **não substituem** identidade real do AIR. Quando não houver identificador confiável, operações de escrita exigem revalidação reforçada e bloqueio em caso de ambiguidade.

### 6.1 Isolamento multiambiente sem banco de dados

- A cada início, identificar a **origem AIR** e solicitar/confirmar **cliente, setor e raiz** a partir da interface. Nunca selecionar automaticamente o último setor usado para operações de escrita.
- Criar `runId` único e namespace local derivado de chaves normalizadas/hasheadas da instância, cliente e setor; nunca misturar checkpoints, inventários, planos ou auditorias de contextos diferentes.
- A retomada exige correspondência de **instância + cliente + setor + raiz + versão do esquema**; divergência invalida a retomada automática.
- O operador pode ter permissões amplas, mas a ferramenta trabalha em um único setor por execução e verifica o escopo antes de cada lote.
- Não persistir senha, token, cookie, perfil de navegador ou conteúdo dos documentos. Não sincronizar os JSON/JSONL automaticamente com nuvem, Git ou serviços de IA.
- Metadados locais também podem ser sensíveis: minimizar, proteger e eliminar conforme a política da organização.
- Um futuro serviço central, colaboração entre implantadores ou banco de dados requer **nova decisão arquitetural**; não é dependência desta versão.

### 6.2 Contexto obrigatório de execução

```ts
type ExecutionContext = {
  runId: string;
  instanceOrigin: string;       // origem HTTPS validada, sem tokens/query string
  instanceKey: string;          // identificador local estável, se verificável
  clientKey: string;            // cliente/município confirmado pelo usuário
  sectorKey: string;            // setor confirmado no AIR
  sectorRootPath: string;
  scanRootPath: string;          // pasta escolhida ou raiz do setor
  mode: 'folder' | 'sector';
  readOnly: boolean;            // true em POC-01/02
};
```

- Descobrir o contexto pela interface e **pedir confirmação do implantador** antes de varrer; nunca inferir cliente apenas de uma pasta recente.
- Se a interface não expuser identificador estável de cliente/setor, usar contexto composto verificado (origem, breadcrumbs e caminho) e **bloquear escrita quando houver ambiguidade**.
- A sessão AIR é a única fonte de autenticação/autorização. Não guardar senha, cookie, token ou perfil de navegador no repositório.
- A execução é sequencial por setor. Mudança de origem, cliente ou setor durante a execução interrompe a automação e invalida aprovações anteriores.
- Checkpoints de um contexto **não podem ser retomados** em outro contexto, mesmo que nomes de pastas coincidam.

### 6.3 Política de dados e armazenamento

- **Nenhum banco de dados no MVP**, nem SQLite, nem Supabase, nem PostgreSQL.
- Não armazenar PDFs, anexos, conteúdo de arquivos ou cópias de documentos.
- Inventário e análise em memória sempre que possível; para grandes setores, usar processamento incremental com JSONL local apenas quando necessário.
- Checkpoints e auditoria local são arquivos operacionais, não um repositório documental. Metadados também podem ser sensíveis: minimizar campos, proteger diretório, definir retenção e permitir descarte seguro conforme política da empresa.
- Saídas locais organizadas por `instanceKey/clientKey/sectorKey/runId` com nomes sanitizados e identificadores locais; impedir colisões, travessia de diretórios e escrita fora de `output/`.
- **Multiimplantador não significa SaaS:** cada operador executa sua própria cópia local. Sincronização, colaboração e histórico centralizado ficam fora do escopo.

## 7. Scanner: leitura completa e confiável

### 7.1 Algoritmo

1. Confirmar origem/URL AIR, cliente, setor, breadcrumb e raiz de execução; vincular cada item ao `ExecutionContext`.
2. Capturar a primeira página e identificar total/paginação.
3. Ler cada linha como `AirItem`, preservando nome original, caminho e metadados disponíveis.
4. Avançar página por página, aguardando mudança verificável no conteúdo, não apenas clique concluído.
5. Deduplicar **observações** por identidade confiável ou assinatura contextual, sem descartar homônimos legítimos.
6. Registrar cobertura: páginas esperadas/lidas, itens observados, erros, repetições e lacunas.
7. Para cada subpasta, navegar pela interface, confirmar a identidade e repetir em profundidade (DFS, §7.5).
8. Salvar checkpoint a cada passo e permitir retomada segura após falha (§7.7; leitura recursiva).
9. Marcar a execução como **parcial** se houver página inacessível, divergência de contagem ou navegação não confirmada.

### 7.2 Modos

**Implementado (CLI interativa):** pasta atual (opção 2), uma subpasta com ida e volta (opção 3) e árvore a partir da pasta exibida, com limites (opção 6).

**Planejado:**

- **Dirigido:** `scan --folder <caminho>`; inclui todos os descendentes acessíveis.
- **Setor:** `scan --sector <identificador>`; parte da raiz do setor e percorre a hierarquia.

O scanner **não seleciona itens, não abre menus de ações e não altera dados**.

### 7.3 Escala

- Evitar manter snapshots DOM inteiros em memória.
- Persistir itens incrementalmente em JSONL e checkpoints compactos.
- Limitar taxa de navegação; respeitar carregamentos e falhas transitórias.
- Não assumir que contagens exibidas pelo AIR equivalem ao número de linhas diretamente visíveis.
- Relatar tempo, cobertura e pontos não inspecionados antes de usar resultados para planejar movimentos.

### 7.4 Contagens: página, pasta e descendentes

São três grandezas diferentes e nunca intercambiáveis:

- **Contador "X de N linhas(s) selecionadas":** N é o número de linhas da **página exibida**, não da pasta (POC-01B: N = 30 na página 1 e 7 na página 2 de uma pasta com 37 itens). Ele é usado **só** como verificação de integridade da página: N precisa ser igual às linhas lidas.
- **Total da pasta:** o N do título "Nome (N)", com os **filhos diretos**. A leitura só é `complete` quando os itens únicos lidos são iguais a ele.
- **Descendentes:** não são exibidos pelo AIR; só a leitura recursiva os conta, e apenas dentro dos limites.

Ler o contador da página como total foi o defeito que fez uma pasta de 37 itens ser reportada como completa com 30. Há teste de regressão.

### 7.5 Navegação recursiva em profundidade (DFS)

A leitura recursiva (`core/tree-scanner.ts`) é uma **DFS** sobre a interface `TreeNavigator`, sem Playwright em `core`:

1. Ler todas as páginas da pasta exibida (dentro de `maxPagesPerFolder` e do saldo de `maxItems`).
2. Para cada subpasta elegível, na ordem exibida: reposicionar o pai na página da subpasta (clique no número da página, com conteúdo idêntico ao lido), abrir por clique, confirmar a identidade, ler recursivamente e **voltar ao pai imediato**, confirmando o retorno.
3. Não abrir: arquivos, itens de tipo desconhecido, homônimos (após normalização), itens com "Caminho" de outro ramo, nem nada além de `maxDepth` e `maxFolders`.
4. Recusa **antes** do clique registra a pendência e segue com as irmãs. Falha **depois** de um clique (`navigation-lost`, `return-failed`) interrompe a execução inteira, sem novos cliques, e marca o restante como `run-aborted`.
5. Cada pasta tem `status` (filhos diretos) e `subtreeStatus` (ela e todos os descendentes). A execução só é `complete` se a pasta inicial tiver `subtreeStatus = complete`. Ciclos e visitas repetidas são detectados pela chave da pasta na execução.

**Por que DFS e não BFS:** na DFS o caminho de navegação é a própria pilha. Cada pasta é aberta uma vez e cada volta vai para o pai imediato, então o histórico do navegador fica coerente com a pilha, o que é necessário porque, do 3º nível em diante, a volta usa o "voltar" do cabeçalho do AIR. Uma BFS exigiria saltos entre ramos, ou seja, URLs construídas ou longas sequências de cliques, o que §7.6 proíbe.

### 7.6 Navegação somente pela interface

- Toda navegação é um **clique na interface**: nome de uma subpasta comprovadamente pasta, link do pai no breadcrumb, "voltar" do cabeçalho, próxima página ou número da página. Cada clique é verificado antes (alvo, rótulo, allowlist/blocklist) e depois (URL nova, título, breadcrumb, "Caminho", listagem).
- **Nenhuma URL interna é construída ou digitada** pela ferramenta, nem a partir de IDs observados. A URL é só **lida** (sem query string) como evidência de identidade e chave da pasta na execução. O único `goto` é a URL inicial informada pelo operador.
- Menus ("More", "⋮"), seleção, estrela, compartilhar e linhas de arquivo nunca são clicados. Um diálogo aberto interrompe a operação.

### 7.7 Checkpoint e retomada (POC-01E)

**Objetivo:** continuar uma leitura recursiva interrompida (limite, perda de navegação, processo encerrado) sem recomeçar do zero, **sem presumir** que o AIR continuou igual.

**Armazenamento** (`storage/checkpoints.ts`): JSON local, sem banco de dados, em `%LOCALAPPDATA%\air-organizer\checkpoints\<instância>\<setor>\<pasta inicial>\<execução>\checkpoint.json`, fora do repositório (configurável, mas recusado dentro dele).

- **Escrita atômica:** temporário + `rename`, com novas tentativas para travas transitórias do Windows. Gravação depois de cada pasta lida, de cada filho decidido e no fim. Se uma gravação falhar, a leitura continua e o arquivo anterior continua íntegro; a CLI avisa.
- **Integridade:** HMAC do documento canônico. Arquivo truncado, editado ou de outra chave é recusado.
- **Trava por execução:** arquivo com o PID. Uma trava viva recusa a retomada; a de processo encerrado é substituída.
- **Retenção:** padrão 7 dias. Fora do prazo, não é retomado, e a exclusão é oferecida com confirmação. Concluídos não são retomáveis.

**Minimização e proteção.** O checkpoint guarda só pseudônimos HMAC-SHA256 (128 bits) com separação de domínio (URL, nome, caminho, linha no pai, assinatura de página, instância, cliente, setor), além de contagens, status, motivos, limites e datas. Nunca guarda nomes, caminhos, URLs, mensagens, itens, cookies, tokens ou conteúdo. A chave fica em outro arquivo do perfil (`checkpoint.key`): sem ela, o checkpoint não permite confirmar um nome por tentativa. Para a LGPD, isso é **pseudonimização, não anonimização**: com a chave, os dados são reidentificáveis e seguem sendo dados pessoais.

**Consequência da minimização:** o checkpoint reconhece pastas, linhas e páginas, mas não basta para *abrir* uma pasta, que exige o nome visível. Por isso a unidade de reaproveitamento é a **subárvore**, nunca a página.

**Algoritmo de retomada:**

1. **Antes de qualquer clique:** checkpoint íntegro e no prazo; mesma instância, cliente e setor (pseudônimos); a pasta exibida, aberta manualmente pelo operador, é a pasta inicial gravada (URL, título e caminho). Qualquer divergência = `ResumeRejectedError` com código e motivo sem nomes.
2. A mesma DFS (§7.5) é refeita a partir da pasta inicial. Toda pasta em que se entra é **relida desde a página 1**; os itens são deduplicados como numa leitura nova.
3. Para cada subpasta elegível, o registro do checkpoint é localizado pelo pai e pelo pseudônimo do nome (homônimos nunca têm registro utilizável). A subpasta é **reaproveitada sem clique** só se: (a) a linha dela, relida agora, tem o mesmo pseudônimo da linha gravada (todos os metadados); (b) a subárvore está **assentada**, isto é, lida e sem pendência retomável; (c) a subárvore cabe no `maxDepth` atual.
4. Se a URL de uma pasta reaberta difere da gravada para aquele nome, o registro é descartado para a subárvore dela.
5. Pendências **retomáveis**: `max-*`, `read-incomplete`, `read-error`, `open-refused`, `navigation-lost`, `return-failed`, `run-aborted`. Pendências do conteúdo (`homonym`, `location-mismatch`, `unknown-items`, `cycle`, `repeated-visit`) são mantidas com o status registrado.
6. **Limites valem para a execução inteira** (pastas e itens reaproveitados contam). Nunca são aumentados automaticamente: o operador confirma os limites a cada sessão.

**Completude:** inalterada (§7.4/§7.5), com uma regra a mais: `complete` exige também nenhum limite atingido na sessão. As pastas reaproveitadas entram com o status gravado, então uma parcial continua parcial. O resultado registra `resume.reusedFolders` e a data mais antiga reaproveitada.

**Modos de retomada (decisão da POC-01E):** a mesma DFS serve aos dois; o modo só decide se o passo 3 (reaproveitamento) é permitido.

- **RÁPIDO** (`fast`): reaproveita subárvores assentadas pela linha no pai. O conteúdo interno não é revalidado. O resultado traz `verification.contentRevalidated = false` e **nunca** é elegível para planejamento (`eligibleForPlanning = false`), mesmo completo.
- **VERIFICADO** (`verified`, padrão na CLI): nada é reaproveitado. Toda pasta do escopo é reaberta e relida desde a página 1, sem presumir que a linha do pai reflete mudanças internas. O checkpoint dá continuidade (mesma execução, sessões registradas) e **comparação**: cada pasta relida é `unchanged`, `changed` (total ou assinatura de alguma página em comum diferente) ou `new` (sem registro, ou registrada mas nunca aberta), e subpastas registradas ausentes da listagem relida, quando ela está completa, contam como `removed`. O custo é o de uma leitura nova.
- Nos dois modos valem os mesmos limites (por execução) e as mesmas regras de completude. `eligibleForPlanning = status complete e nenhuma pasta reaproveitada`. **Nenhum modo promete consistência transacional:** o AIR pode mudar durante a própria leitura.

### 7.8 Reposicionamento em paginadores com reticências (POC-01E)

Com muitas páginas, o AIR real mostra a primeira, a atual ± 1 e a última, com reticências em cada lacuna: `[«][‹][1][2][...][50][›][»]` na página 1 e `[«][‹][1][...][3][4][5][...][50][›][»]` na página 4 (observado na POC-01E). Para voltar à página *k* de uma subpasta (o AIR reabre o pai na página 1), `goToPageNumber`:

1. não faz nada se a listagem exibida já é a registrada (a assinatura inclui o indicador de página);
2. a cada passo lê a página ativa (botão numérico destacado no paginador único) e os números visíveis. Clica em *k*, se estiver visível; senão, no maior número visível abaixo de *k* (quando isso aproxima); senão, em "próxima";
3. depois de cada clique, exige a página ativa esperada, uma listagem diferente da anterior e estável;
4. na página *k*, exige a assinatura registrada na leitura;
5. interrompe (recusa antes de abrir a subpasta, sem sair do pai) em: página ativa não identificada, controle ausente ou ambíguo, conteúdo repetido com outro número (loop), página não confirmada, conteúdo divergente ou mais de *k* + 1 passos.

Controles usados: só os já validados no AIR real (botão numérico dentro do paginador e "próxima" pelo ícone). Com a janela "atual ± 1" do AIR real, cada clique numérico desloca a janela e os números bastam; "próxima" fica para paginadores sem vizinhas. Reticências (`<span>`) nunca são candidatas. **Campo "Ir":** existe no AIR real (`<input type="number" placeholder="Página" min="1" max="<última>">` + botão "Ir"), mas **não é usado**: digitar num campo é uma ação nova fora da allowlist e exige aprovação arquitetural específica. O custo é de até *k* cliques, sempre com *k* ≤ páginas lidas ≤ `maxPagesPerFolder`. Validado no AIR real com saltos entre páginas já lidas da mesma pasta (inclusive para páginas ocultas pelas reticências).

**Achado da validação real (POC-01E), em aberto:** a volta de uma subpasta do 3º nível **depois de paginá-la** falhou (`return-failed`, com falha fechada). Hipótese: trocar de página cria entrada no histórico, e o "voltar" do cabeçalho (`history.back()`, usado quando o pai está colapsado no breadcrumb) retorna à página anterior da própria subpasta. Correções possíveis, a decidir após diagnóstico só de leitura (`history.length` antes e depois de "próxima"): (a) voltar à página 1 da subpasta antes de usar o "voltar" — só resolve se o histórico for empilhado por página; (b) usar o "voltar" repetidamente, conferindo a pasta a cada passo — exige limite e verificação rigorosos; (c) não paginar subpastas do 3º nível em diante até haver um mecanismo de volta seguro.

**Diagnóstico de identidade (POC-01E).** Toda espera por uma pasta depois de um clique avalia condições **nomeadas** (abrir: `urlChanged`, `titleMatches`; voltar: `urlIsParent`, `titleIsParent`). No tempo esgotado, o erro traz um código e `checks`: o resultado de cada condição na última leitura, as leituras que falharam por código (`heading-breadcrumb-mismatch`, `path-divergent`, `title-missing`, …) e as leituras aceitas mas instáveis. Tudo sem nomes, caminhos nem URLs. Isso vai para `abort.diagnostic` no resultado, no relatório diagnóstico e na CLI. Cada causa possível tem assinatura própria, testada em fixture: clique sem navegação (`urlChanged=false`); carregamento lento ou pasta errada (`urlChanged=true`, `titleMatches=false`); título ou breadcrumb divergentes (`heading-breadcrumb-mismatch`); "Caminho" divergente (`path-divergent`) ou diferente do esperado (`path-mismatch`). O prazo não foi aumentado: a causa precisa ser identificada antes.

**Segunda tentativa de diagnóstico real (inconclusiva):** a pasta inicial lida tinha 11 filhos (as etapas B1/B2 usaram uma de 14). O clique na 1ª subpasta terminou em `NavigationLostError` por tempo esgotado, ainda sem o detalhamento acima, e nenhum clique foi feito depois. O roteiro deixou o navegador aberto sem notificar; foi corrigido (encerramento em `finally`, timeout global, código de saída, navegador sempre fechado). A causa do `return-failed` continua **hipótese**.

**Diagnóstico final (POC-01E, 03/11/2026).** A pasta inicial foi confirmada contra os pseudônimos do checkpoint (instância, URL, título, caminho); a subpasta paginada da B2, também. Abertura confirmada. Paginação 1→2: `history.length` **não muda** e a URL é estável; abrir a pasta soma 1. O "voltar" do cabeçalho chegou ao **pai** (URL e título), sem mudar `history.length`, compatível com `history.back()`. A recusa foi `restored-mismatch`, na conferência final. **A hipótese do histórico está refutada.** O total da pasta inicial caiu de 14 (B1) para 11 e depois para 8 ao longo da manhã: o pai foi **alterado durante a leitura** (provavelmente pastas movidas para fora), e a ferramenta recusou a volta, como projetado. No 3º nível, o único link do breadcrumb não tem `href`; o pai fica no menu "More"; não há link para o pai na página; a seta não é link nem botão. A conferência agora informa cada campo (`url`, `title`, `total`, `path`, `breadcrumb`) sem valores, para confirmar qual divergiu.

**Decisão (ADR-013, aprovada):** na volta, **identidade** (URL, título, breadcrumb e "Caminho" quando ambos exibem) é conferida antes de **conteúdo** (total e listagem da mesma página ativa). Identidade divergente = `identity-mismatch`, falha fechada. Identidade confirmada com conteúdo divergente = volta aceita, pendência `content-changed` na pasta (retomável), status `partial` propagado aos ancestrais, subpastas não abertas ficam pendentes (nenhum clique a partir da listagem antiga), sem releitura automática na sessão; filhos de pasta `content-changed` nunca são reaproveitados na retomada rápida; `eligibleForPlanning` exige zero `content-changed`. `TreeResult.navigation` conta `contentChanged`, `identityMismatch` e `navigationFailed` separadamente. **O inventário não é uma fotografia transacional:** o AIR pode mudar durante a análise, e `content-changed` registra a divergência observada, não a sua causa.

**Causa confirmada do achado da volta (POC-01E):** O AIR **mantém a página corrente ao voltar**. Numa pasta estável, confirmada pelo checkpoint, o pai estava antes na página 1, com 8 linhas e total 8. Depois de abrir uma subpasta, ir à página 2 e voltar uma vez, ele apareceu **sem página ativa, com 0 linhas e total 8**. Correção: antes de voltar, a subpasta é reposicionada na página em que foi aberta (página ativa e listagem conferidas). Depois da volta, o pai precisa estar na página em que foi lido e exibir linhas quando o total indica itens. Senão, a volta é recusada (`page-mismatch` ou `empty-listing`, categoria `navigation-failed`) e a execução para sem novos cliques. Uma listagem incomparável nunca é aceita como volta válida.

O scanner passou a conferir a página ativa a cada página lida (`page-mismatch`): leitura que não começa na página 1 ou "próxima" que pula páginas tornam a leitura parcial.

## 8. Análise de duplicidades

### 8.1 Normalização

Para comparação **apenas**, aplicar: trim, normalização Unicode, remoção opcional de diacríticos, case folding, padronização de espaços e separadores. Preservar sempre o nome original.

Exemplos (fictícios): `ORBITAS` e `ÓRBITAS` tornam-se equivalentes; `PLANETAS` e `Planetas` também. `Catalogo` e `Catalogo-2031` permanecem distintos e apenas podem receber indicação de revisão.

### 8.2 Classificação

- **Alta confiança:** mesmo nome normalizado, mesmo setor e mesmo contexto de comparação.
- **Média:** variações ortográficas, singular/plural ou nomes muito próximos.
- **Baixa:** similaridade parcial ou semântica, nunca mesclagem automática.

Nomes de arquivos iguais **não provam** conteúdo igual. Sem hash ou metadados suficientes, apenas sinalizar para revisão. Não excluir documentos.

### 8.3 Conflitos de hierarquia

A consolidação deve comparar descendentes antes de mover uma pasta inteira. Se duas pastas têm subpastas homônimas, o planner cria operações dependentes para consolidar o conteúdo primeiro; não presume merge automático no AIR.

### 8.4 Motor de diagnóstico estrutural (POC-02A, implementado)

`core/structural-diagnostics.ts` é um motor **determinístico e puro** (sem navegador, sistema de arquivos ou rede). A entrada é um inventário recursivo exportado (`tree-inventory.json`, identificável, gravado só com confirmação); a saída são achados para **revisão humana**. Mesmo inventário + mesma data de avaliação = mesmo relatório, independente da ordem das pastas no arquivo. Nenhum achado recomenda renomear, mover ou mesclar.

**Validação antes das regras (falha segura).** Referências únicas, uma única pasta inicial, pais existentes, profundidade coerente, contagens iguais à listagem, cada subpasta pareada com a linha correspondente do pai (nome) e caminho coerente com o do pai. Qualquer divergência = inventário **recusado**, sem achados.

**Elegibilidade (reutiliza a leitura, não recalcula):**

| Estado | Quando |
|---|---|
| `planning-eligible` | `verification.eligibleForPlanning` verdadeiro (completa, revalidada, sem `content-changed`) e inventário com até 7 dias (`AIR_ORGANIZER_INVENTORY_MAX_AGE_DAYS`) |
| `exploratory` | consistente, mas com qualquer motivo: `status-partial`, `status-failed`, `aborted`, `fast-resume`, `reused-folders`, `content-changed`, `not-eligible-for-planning`, `stale`, `legacy-format` (exportação anterior à POC-01E) |
| `rejected` | inconsistente, ilegível ou sem nomes (`tree-diagnostic.json`) |

Só `planning-eligible` poderá fundamentar planos operacionais (POC-02B). Achados exploratórios servem só para exploração.

**Regras iniciais (cada achado registra a regra, a certeza e as regras de normalização aplicadas):**

| Categoria | Regra | O que detecta | Certeza |
|---|---|---|---|
| Possível duplicidade | `DUP-SIBLING-EXACT` | pastas irmãs com nomes idênticos | `exact` |
| | `DUP-SIBLING-NORMALIZED` | pastas irmãs equivalentes por caixa, acento, espaço ou pontuação | `normalized` (+ `matchedBy`) |
| Nomenclatura | `NAME-VARIANTS` | o mesmo nome grafado de formas diferentes (caixa, acento, espaços) em **pais diferentes** | `normalized` |
| | `NAME-SPACING` | espaço no início, no fim ou repetido | `exact` |
| Hierarquia | `HIER-NESTED-SAME-NAME` | subpasta com o mesmo nome da pasta que a contém | `exact`/`normalized` |
| | `HIER-EQUIVALENT-CHILDREN` | pastas equivalentes em pais diferentes, ambas com listagem completa, com pelo menos 2 subpastas em comum e sobreposição (Jaccard) de pelo menos 50%, mas não idênticas | `structural` |

"Certeza" é da **detecção**, sem probabilidades: textos idênticos, equivalentes pelas regras listadas ou padrão estrutural dentro dos limiares. Decisões conservadoras: duplicidade só entre irmãs (o mesmo nome em pais diferentes pode ser legítimo, como anos); grafias diferentes dentro de um único pai já são o achado de irmãs; hierarquia só com listagens completas; estruturas com pouco em comum não geram achado; nomes de arquivos não são comparados.

**Privacidade.** O relatório completo é identificável e fica em `output/` (`structural-diagnostics-detailed.json`, só com confirmação). O padrão (console e `structural-diagnostics.json`) é redigido: referências da execução (F1…), regras, certeza, contagens e limitações, sem nomes, caminhos nem grafias. CLI: opção 8, sem navegador.

## 9. Planejador e dry-run

Entrada: inventário completo ou explicitamente parcial, pasta principal selecionada, candidatos aprovados e limites de execução.

Saída: lista ordenada de `MoveOperation`, dependências, conflitos, estimativa de itens afetados quando verificável e bloqueios.

Regras:

1. Nunca mover a pasta raiz do setor.
2. Nunca mover pasta para ela mesma ou para descendente.
3. Origem e destino devem pertencer ao mesmo setor autorizado.
4. Pasta de destino deve ser explicitamente escolhida e reconfirmada.
5. Não misturar movimentações de setores diferentes.
6. Não criar pastas implicitamente.
7. Se destino já contém homônimo, interromper e exigir plano de conflito.
8. Não produzir plano executável quando a identidade de origem/destino for ambígua.
9. Plano deve ser revisável sem efetuar qualquer escrita.

**Dry-run é o comportamento padrão**, inclusive quando o usuário solicita um plano.

## 10. Executor supervisionado (somente POC-03)

A implementação do `AIR Mover` fica **desabilitada** até a validação do scanner, do planner e da autorização de automação no ambiente correspondente.

### Protocolo por operação

1. Validar autorização, origem da instância, cliente, setor, pasta principal e aprovação do plano; bloquear se qualquer dimensão do contexto divergir.
2. Reabrir origem na UI e confirmar identidade/fingerprint e breadcrumb.
3. Confirmar ausência de mudanças relevantes desde o inventário.
4. Selecionar **explicitamente** o item; verificar seleção efetiva pelo contador e contexto, sem confiar em seleção visual herdada da página anterior.
5. Abrir `Itens selecionados → Mover para` e confirmar o destino real no seletor nativo.
6. Exibir resumo e obter confirmação humana para o lote aprovado.
7. Executar um lote pequeno; aguardar resultado ou estado terminal observável.
8. Verificar desaparecimento da origem **e presença no destino**, com identidade e hierarquia coerentes.
9. Registrar `verified`, `failed` ou `uncertain`. Em resultado incerto, **parar**; não repetir automaticamente uma ação possivelmente concluída.
10. Reconciliar a listagem e limpar/revalidar a seleção antes do próximo lote.

**Não automatizar exclusão**, inclusive de pastas que pareçam vazias após consolidação.

### 10.1 Falhas e idempotência

- Recarregamento ou timeout após clique de movimentação gera estado `uncertain`, nunca retry cego.
- Reconciliar origem e destino antes de decidir qualquer nova tentativa.
- Se o AIR apresentar erro ou processamento prolongado, pausar e registrar evidências não sensíveis.
- Mudança de setor, breadcrumb inesperado, seleção incoerente, contagem divergente ou destino ambíguo são condições de **fail closed**.
- Um botão de parada deve impedir novas ações após a operação atual; nenhuma execução autônoma em massa.
- Reversão automática não faz parte do MVP; registrar informações necessárias para correção manual supervisionada.

## 11. Segurança, privacidade e conformidade

- Obter autorização organizacional antes de executar automação externa, especialmente em produção.
- Vincular toda execução e aprovação a origem HTTPS, cliente, setor e pasta raiz; nunca usar um destino de outra instância/setor.
- Não persistir credenciais; não compartilhar perfis Chrome ou sessões entre implantadores.
- Respeitar permissões e políticas internas; não contornar controles do AIR.
- Não exportar conteúdos documentais, cookies, senhas, tokens, dados pessoais desnecessários ou capturas contendo informações sensíveis.
- Logs locais com acesso restrito; `output/`, perfis e segredos fora do Git.
- Relatórios devem conter metadados mínimos necessários (ver §11.1).
- Nenhum envio a serviços de IA de dados internos sem aprovação expressa.
- Adotar retenção e descarte conforme política da organização (LGPD: finalidade, necessidade e segurança). A ferramenta não apaga saídas antigas sozinha.
- Repositório público: testes, fixtures, comentários e documentação usam **somente dados sintéticos** (domínio `.test`, nomes fictícios). O `.gitignore` cobre saídas, documentos, capturas, perfis de navegador, credenciais, traces e temporários.

### 11.1 Política de exportação e de logs (implementada)

Nomes de pastas e arquivos podem conter dados pessoais e sensíveis. Por isso há dois níveis de saída:

| Saída | Conteúdo | Quando |
|---|---|---|
| Console padrão | status, contagens, referências (F1, D1…), tipos de pendência; caminhos de saída como `output/*/*/<runId>/<arquivo>` | sempre |
| `inventory-diagnostic.json` (opção 5), `tree-diagnostic.json` (opções 6 e 7) | o mesmo, com `identifiable: false`; sem nomes, caminhos, URLs, cliente, setor nem mensagens | sempre que se exporta |
| `checkpoint.json` (opções 6 e 7) | pseudônimos HMAC, contagens, status, motivos, limites e datas (§7.7); fora do repositório, com retenção | a cada passo da leitura recursiva |
| `inventory.json` (opção 5), `tree-inventory.json` (opção 6) | inventário identificável, com `identifiable: true` na leitura recursiva | **somente após confirmação explícita** do operador, a cada exportação |

- Valores do ambiente (domínio, URL, pasta, breadcrumb, cliente, setor) aparecem no console só como "identificado/não identificado" e fonte.
- Mensagens de erro e de pendência podem citar nomes. No console aparecem só pelo tipo. A exceção é a opção 3, cuja finalidade é escolher uma subpasta pelo nome. `AIR_ORGANIZER_VERBOSE_ERRORS=1` é um opt-in local de depuração.
- Suspeitas de duplicidade (opção 4) aparecem por referência, confiança e regras. Os nomes exigem confirmação.
- Os diretórios em `output/` derivam do domínio e do setor (slug + hash). Eles ficam só no disco local, fora do Git, e não são exibidos no console.

## 12. Observabilidade e auditoria

Cada execução recebe `runId`, data, origem da instância, cliente, setor, raiz, modo, versão do código e status. Cada operação gera eventos: `discovered`, `candidate`, `planned`, `approved`, `started`, `verified`, `uncertain`, `failed`.

Relatório final:

- Pastas visitadas, páginas lidas, itens observados e duração.
- Cobertura estimada e lacunas de leitura.
- Candidatos a duplicidade e justificativas.
- Planos propostos e operações bloqueadas.
- Para POC-03: operações aprovadas, verificadas, incertas e falhas.

Evitar logar conteúdo de documentos, HTML integral, credenciais e URLs com parâmetros sensíveis.

## 13. Plano de entregas

### POC-01 — Leitor confiável (prioridade imediata)

**Objetivo:** gerar inventário em JSON/JSONL de uma pasta pequena e, depois, de suas subpastas, sem escrita.

Critérios de aceite e situação:

| Critério | Situação |
|---|---|
| Identificar página, breadcrumb e tabela corretamente | ✅ POC-01A/01B/01C |
| Extrair todas as linhas de uma pasta pequena, conferidas com o exibido | ✅ POC-01B (37/37, 2 páginas) |
| Registrar nome, tipo, caminho e metadados disponíveis | ✅ (tipo pelo ícone, POC-01C) |
| Navegar e validar paginação sem omissões ou repetições indevidas | ✅ POC-01B; reticências na POC-01D |
| Escanear uma pasta selecionada e seus descendentes | ✅ parcial: DFS com limites (POC-01D); setor inteiro não validado |
| Exportar inventário e relatório de cobertura | ✅ diagnóstico sem nomes por padrão; identificável com confirmação |
| Setor identificado pela UI | ❌ informado pelo operador |
| Retomar de checkpoint sem refazer o trabalho | ✅ POC-01E, por subárvore assentada (§7.7); não validado no AIR real |
| **Zero operações de escrita** | ✅ |

**Sub-etapas entregues:**

- **POC-01A:** leitura da listagem atual, ambiente sem query string, exportação JSON.
- **POC-01B:** paginação real só com ícones; total pelo título; contador "X de N" como contagem da página (§7.4).
- **POC-01C:** abrir uma subpasta e voltar, com identidade verificada; tipo pelo ícone da coluna de tipo; breadcrumb colapsado; filtro e busca tornam a leitura parcial.
- **POC-01D:** leitura recursiva DFS com limites, status por subárvore, reposicionamento por número de página, itens com "Caminho" de outro ramo, paginador com reticências e saída padrão sem dados identificáveis.
- **POC-01E:** checkpoint local pseudonimizado e retomada (§7.7); reposicionamento para páginas escondidas pelas reticências e conferência da página ativa (§7.8); progresso e status (executando, parcial, concluído, interrompido) na CLI.

### POC-02 — Diagnóstico e plano

**Objetivo:** detectar nomes semelhantes, comparar hierarquias e gerar dry-run.

Critérios de aceite:

- Detectar nomes equivalentes por caixa, acento e pontuação (exemplos fictícios: `PLANETAS`/`Planetas`, `ORBITAS`/`ÓRBITAS`) na mesma estrutura. A normalização e as suspeitas já existem desde a POC-01.
- **POC-02A (entregue):** motor de diagnóstico estrutural (§8.4): duplicidade entre irmãs, nomenclatura inconsistente e hierarquia divergente, com elegibilidade herdada da leitura.
- Distinguir similaridade de nomes de duplicidade documental comprovada.
- Exigir escolha explícita da pasta principal.
- Impedir planos com ciclo, setor divergente ou destino ambíguo.
- Gerar plano revisável e **não executar movimentos**.

### POC-03 — Movimentação supervisionada

**Pré-requisitos:** autorização da organização e ambiente de teste/homologação preferencialmente, ou cenário de produção explicitamente autorizado; POC-01 e POC-02 aprovadas.

Critérios de aceite:

- Executar apenas lote pequeno previamente aprovado.
- Confirmar seleção real, setor e destino antes da ação.
- Verificar origem e destino depois da movimentação.
- Pausar em qualquer incerteza, sem retry cego.
- Produzir trilha de auditoria e relatório de reconciliação.
- Não criar, excluir ou renomear nada.

## 14. Estratégia de testes

- **Unitários:** normalização, comparação de nomes, detecção de ciclos, escopo de setor, ordenação de dependências, checkpoint.
- **Integração local:** fixtures HTML sintéticas para tabelas, paginação, seleção e mudança de conteúdo.
- **Read-only real:** Chrome em sessão autorizada, pasta pequena, nenhuma ação de escrita.
- **Movimentação:** somente em cenário aprovado, com dados de teste e conferência humana.
- **Regressão:** fixtures do bug de seleção entre páginas; testes devem falhar se o executor confiar apenas no estado visual.

## 15. Riscos e decisões em aberto

| Risco / hipótese | Mitigação / validação |
|---|---|
| UI muda seletores ou layout | Adaptador `air/selectors.ts`, seletores semânticos e testes de regressão |
| Itens homônimos sem IDs estáveis | Exigir contexto completo e bloquear escrita ambígua |
| Paginação inconsistente | Conferir mudança de página, contagens e cobertura |
| Seleção herdada após movimento | Revalidar seleção efetiva em cada lote |
| Movimento assíncrono ou timeout | Reconciliação antes de qualquer retry |
| Cliente ou setor incorreto por permissão ampla | Safety Gate com origem, cliente, setor e raiz imutáveis por execução |
| Nomes iguais em municípios distintos | Namespace de saída e checkpoints por instância/cliente/setor/runId |
| Scan longo / grande volume | Checkpoint por passo e retomada por subárvore (§7.7) |
| Pastas homônimas não mesclam | Planejamento recursivo e resolução explícita de conflitos |
| Controle de Chrome existente | Validar conexão segura e isolada; não presumir acesso automático |
| Restrições de política da empresa | Confirmar autorização antes de automatizar produção |

## 16. Convenções de trabalho com agentes

- **ChatGPT:** arquiteto — decisões, especificações, decomposição, critérios de aceite e revisão de riscos.
- **Claude:** executor — implementar etapas delimitadas, rodar testes e reportar evidências.
- **Usuário:** validar comportamento real do AIR, aprovar planos, executar commits assinados e push.
- O agente executor **não** deve fazer commit, push, alterar branches protegidas nem executar movimentos no AIR sem autorização específica para a etapa.
- Cada entrega deve informar arquivos alterados, comandos de teste, resultados, limitações e próximo passo.
- Não expandir escopo com dashboard, banco de dados ou IA antes de o fluxo operacional básico estar validado.

## 17. Decisões arquiteturais registradas (ADR)

- **ADR-001 — Multiambiente e multissetor, local-first:** o produto suporta diferentes instâncias AIR, clientes/cidades, setores e implantadores. Nenhum ambiente de validação é constante de negócio nem é citado no repositório.
- **ADR-002 — Sem banco de dados no MVP:** dados operacionais em memória e JSON/JSONL locais mínimos; documentos permanecem exclusivamente no AIR.
- **ADR-003 — Isolamento obrigatório:** toda leitura, plano e movimentação é vinculada a instância, cliente, setor e raiz validados. Nenhuma movimentação entre setores/clientes.
- **ADR-004 — Evolução progressiva:** POC-01 somente leitura; POC-02 análise/dry-run; POC-03 movimentação supervisionada apenas após autorização e testes.
- **ADR-005 — Contagens (POC-01B):** o total da pasta vem do título "Nome (N)" (filhos diretos). O contador "X de N linhas(s) selecionadas" conta só a página e serve só como verificação de integridade da página. O próximo do paginador é reconhecido pelo ícone apenas dentro de um paginador numérico.
- **ADR-006 — Identidade e tipo (POC-01C):** o tipo vem só do ícone da coluna de tipo (allowlist); qualquer outra coisa é `unknown` e nunca é clicada. A abertura de subpasta é confirmada por URL nova, título, breadcrumb (aceitando o colapso "…") e "Caminho". A volta usa o link do pai no breadcrumb ou, com o pai colapsado, o "voltar" do cabeçalho, sempre verificada. Filtro diferente de "Todos" ou busca preenchida tornam a leitura parcial.
- **ADR-007 — Leitura recursiva DFS com limites (POC-01D):** DFS sobre `TreeNavigator` (§7.5), limites `maxDepth`/`maxFolders`/`maxItems`/`maxPagesPerFolder` confirmados pelo operador e nunca aumentados automaticamente, `status` e `subtreeStatus` por pasta, falha fechada após qualquer clique incerto. Itens com "Caminho" de outro ramo não são abertos.
- **ADR-008 — Navegação só pela interface (POC-01C/01D):** nenhuma URL interna é construída; a URL é só evidência (§7.6).
- **ADR-009 — Exportação identificável mediante confirmação (POC-01D, estendida à opção 5):** saída padrão sem dados identificáveis; inventários com nomes, caminhos e URLs só com confirmação explícita a cada exportação (§11.1).
- **ADR-010 — Checkpoint pseudonimizado fora do repositório (POC-01E):** JSON local por instância/setor/pasta inicial/execução, HMAC com chave local separada, integridade, trava, escrita atômica e retenção (§7.7). Sem nomes, URLs nem itens.
- **ADR-011 — Retomada em dois modos (POC-01E):** pastas em que se entra são relidas desde a página 1. No modo RÁPIDO, subárvores assentadas com a linha no pai idêntica são reaproveitadas, e o resultado é marcado como não revalidado, nunca elegível para planejamento. No modo VERIFICADO (padrão), tudo é relido e comparado com o checkpoint. Limites cumulativos por execução; parcial nunca vira completa só por retomada; sem promessa de consistência transacional (§7.7).
- **ADR-012 — Reposicionamento só com controles validados (POC-01E):** número visível (e "próxima" como alternativa), passo a passo, com página ativa e listagem confirmadas; reticências nunca clicadas. O campo "Ir" existe no AIR real, mas fica fora até haver aprovação específica para digitação em campo (§7.8).
- **ADR-013 — Identidade de navegação x consistência de conteúdo (POC-01E):** na volta ao pai, identidade divergente interrompe (`identity-mismatch`); identidade confirmada com total ou listagem divergentes é aceita como `content-changed`, que invalida a completude da pasta e dos ancestrais, impede cliques a partir da listagem antiga, não gera releitura em loop, impede reaproveitamento na retomada e impede a elegibilidade para planejamento. Diagnósticos separados e sem dados identificáveis. O inventário não é uma fotografia transacional (§7.8).
- **ADR-014 — Diagnóstico estrutural determinístico e desacoplado (POC-02A):** motor puro sobre o inventário exportado, sem navegador, rede ou banco de dados; valida a consistência antes das regras (inconsistência = recusado, sem achados); herda a elegibilidade da leitura (só `planning-eligible` fundamenta planos); regras conservadoras e nomeadas, certeza sem probabilidades, revisão humana obrigatória, sem sugestões de renomear/mover/mesclar; saída padrão redigida (§8.4).

## 18. Próxima ação concreta

**Situação:** a POC-02A está entregue (§8.4, ADR-014). O diagnóstico estrutural roda localmente sobre o `tree-inventory.json` exportado, sem navegador nem acesso ao AIR. Ele produz só achados para revisão humana e nenhum plano operacional.

Pendências da leitura (POC-01E), ainda abertas antes de abrir PR para uso operacional: (1) diagnosticar, só por leitura, o achado do `return-failed` (§7.8): `history.length` antes e depois de trocar de página numa subpasta; (2) decidir e implementar a correção da volta do 3º nível após paginação; (3) validar no AIR real a retomada VERIFICADA e a abertura de subpasta em página oculta. Depois: decidir sobre o campo "Ir".

Próxima etapa, POC-02B: confirmação de setor pela UI e dry-run de consolidação, fundamentados só em inventários `planning-eligible`. Antes dela, avaliar um selo de integridade para o `tree-inventory.json`, como o HMAC dos checkpoints: hoje, um arquivo editado de forma coerente seria aceito como elegível. Não implementar nem habilitar `mover.ts` nessas etapas.

---

**Critério de portabilidade:** executar a mesma POC em dois setores ou ambientes autorizados sem modificar o código-fonte, alterando apenas o contexto de execução.

**Critério de sucesso do projeto:** minutos de trabalho manual economizados com organização confiável e auditável — não quantidade de funcionalidades desenvolvidas.
