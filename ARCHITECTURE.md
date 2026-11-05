# AIR Organizer — Arquitetura de Software

> **Status:** arquitetura v1.8 (App Base v0.1, motor POC-03A, prévia POC-03B/A e revisão humana POC-03B/B, sem escrita no AIR) · **Data:** 05/11/2026\
> **Objetivo:** reduzir o trabalho manual de análise, consolidação e organização de pastas no AIR, começando por uma ferramenta pequena, funcional, segura e reutilizável entre clientes, cidades, setores e implantadores.  
> **Versão oficial:** este arquivo, no repositório (`air-organizer/ARCHITECTURE.md`). Cópias fora do repositório não são mantidas e não devem ser usadas como referência.  
> **Dados:** todos os exemplos deste documento são fictícios. Nenhum nome real de cliente, município, setor, pasta ou pessoa deve ser registrado aqui.

## 1. Visão e princípios

O AIR Organizer é uma automação **externa e supervisionada**, executada localmente no Google Chrome, para inspecionar a hierarquia de pastas em diferentes instâncias, municípios, clientes e setores do AIR, detectar possíveis duplicidades, propor consolidações e, em uma fase posterior, realizar **movimentações explicitamente aprovadas** usando a interface oficial do produto.

**Princípios não negociáveis:**

1. **Funcionalidade antes de sofisticação:** entregar valor com um aplicativo desktop local e relatórios locais, sem dashboard avançado, backend próprio, qualquer banco de dados ou agentes de IA no MVP.
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
- Confirmado na operação: o AIR permite pastas cujos nomes diferem só por caixa ou acento, inclusive em níveis diferentes da hierarquia. Nomes e caminhos não bastam como identificadores técnicos.

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
9. **Aplicativo desktop local (Electron) como interface oficial** de operação (§5.2, ADR-017). A CLI permanece como alternativa.

### Fora do MVP

- Interface web independente e extensão Chrome.
- Instalador, assinatura e atualização automática do aplicativo: a v0.1 roda com `npm run app`, e o empacotamento fica para quando houver distribuição a outros implantadores.
- **Qualquer banco de dados (local ou remoto)**, servidor, sincronização central, integração de API privada.
- Cadastro de usuários do Organizer: a identidade e as permissões permanecem no AIR.
- Download, leitura do conteúdo dos PDFs, OCR ou comparação binária de arquivos.
- Deduplicação automática de documentos ou exclusão de pastas vazias.
- Classificação com IA externa ou decisões irreversíveis autônomas.
- Execução simultânea em vários setores ou várias sessões.

## 4. Stack e execução

- **Runtime:** Node.js 22.12 ou superior (exigência do Electron para instalar).
- **Linguagem:** TypeScript em modo `strict`.
- **Automação:** Playwright para Chrome/Chromium.
- **Interface oficial:** aplicativo desktop com Electron e interface em TypeScript puro, HTML e CSS, sem framework (§5.2). `esbuild` compila processo principal, preload e janela.
- **CLI:** alternativa em linha de comando sobre a mesma camada de operações.
- **Sem banco de dados:** nenhum PostgreSQL, SQLite, Supabase ou backend próprio no MVP. Processar em memória; usar apenas arquivos JSON/JSONL locais mínimos para inventários opcionais, checkpoints e auditoria, com escrita atômica. Esses arquivos guardam **metadados operacionais**, nunca documentos.
- **Testes:** runner de testes TypeScript (por exemplo, Vitest) e fixtures HTML sintéticas.
- **Ambiente:** Windows 11 + VS Code; execução local. WSL é opcional, desde que a conexão com o Chrome seja validada.

**Sessão autenticada:** utilizar somente um perfil/sessão de navegador explicitamente autorizado e compatível com a automação. Não copiar cookies, não extrair tokens e não habilitar depuração remota em perfis pessoais ou compartilhados sem avaliação de segurança. Se for necessário conectar a um Chrome já aberto, validar previamente o método e seu isolamento; não presumir que o Playwright consegue controlar qualquer aba existente.

## 5. Arquitetura lógica

```text
Aplicativo desktop (interface oficial)      CLI (alternativa)
      │ IPC restrito (§5.2)                       │
      └───────────────┬───────────────────────────┘
                      ▼
Orquestrador de execução (src/app)
      ├──────────────► Context Resolver (instância, cliente, setor, raiz)
      ├──────────────► Safety Gate (escopo, permissões, aprovações)
      │
      ├──► Scanner ──────► AIR Reader + Navigator ──► UI AIR / Chrome
      │         │
      │         └──► Inventário + checkpoints
      │
      ├──► Duplicate Analyzer ──► candidatos / evidências
      │
      ├──► Planejamento estrutural ──► propostas de revisão, sem origem nem destino (§9.1)
      ├──► Planejamento de movimentações ──► propostas com origem, destino e dependências (§9.3)
      │
      └──► Executor (POC-03, não implementado) ─► AIR Mover ─► UI AIR / Chrome
                    │
                    └──────────► Verificador + auditoria
```

**Regra de dependência:** `core` e `safety` não dependem de Playwright. O módulo `air` implementa adaptadores de UI e pode mudar sem reescrever o algoritmo de análise. `app` não depende do Electron; só `desktop` depende.

### 5.1 Estrutura de diretórios

**Implementada (App Base v0.1):**

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
│   │   ├── inventory-integrity.ts # selo HMAC do tree-inventory.json: selar e verificar (POC-02B.1)
│   │   ├── organization-planner.ts # propostas de revisão determinísticas, não executáveis (POC-02B.2)
│   │   ├── movement-planner.ts # propostas de movimentação com origem e destino, não executáveis (POC-03A)
│   │   ├── movement-decisions.ts # decisões humanas: regras, assinatura e validação, sem efeito no AIR (POC-03B)
│   │   └── duplicates.ts      # normalização e suspeitas de duplicidade
│   ├── safety/
│   │   └── scope-validator.ts # ações permitidas, escopo, URLs, caminhos de saída
│   ├── storage/
│   │   ├── export.ts          # relatórios diagnósticos e inventários JSON (escrita atômica)
│   │   ├── checkpoints.ts     # checkpoints locais: chave HMAC, escrita atômica, trava, retenção
│   │   ├── inventory-files.ts # inventários exportados, relatórios estruturais e planos em output/
│   │   ├── decision-files.ts  # histórico local de decisões humanas, fora do repositório (POC-03B)
│   │   └── integrity-key.ts   # subchaves HKDF dos selos, derivadas da chave local (POC-02B.1)
│   ├── app/                   # orquestração sem interface, usada pelo aplicativo e pela CLI
│   │   ├── controller.ts      # operações do aplicativo: uma por vez, visões sem nomes, erros seguros
│   │   ├── tree-run.ts        # leitura recursiva com checkpoint, exportação e execuções retomáveis
│   │   ├── folder-operations.ts # conexão e leitura de uma pasta
│   │   ├── local-analysis.ts  # diagnóstico e planejamento sobre inventário gravado
│   │   ├── movement-review.ts # seleção por identificadores opacos, prévia sem nomes e pedidos de decisão (POC-03B)
│   │   ├── connection.ts      # sessão única do Chrome dedicado
│   │   ├── settings.ts        # settings.json local, validado e sem segredos
│   │   ├── validation.ts      # validação das entradas vindas da janela
│   │   ├── labels.ts          # textos de resultado compartilhados
│   │   └── runtime.ts         # parâmetros operacionais
│   ├── desktop/
│   │   ├── main.ts            # ponto de entrada do Electron
│   │   ├── shell.ts           # janela, bloqueios de segurança e registro do IPC
│   │   ├── preload.ts         # ponte mínima entre janela e processo principal
│   │   ├── ipc-contract.ts    # lista fixa de operações e validação da origem
│   │   └── ui/                # telas (HTML, CSS e TypeScript, sem acesso a Node)
│   ├── cli/
│   │   ├── index.ts           # menu interativo
│   │   └── args.ts            # --url / AIR_ORGANIZER_URL
│   └── types/
│       └── inventory.ts       # contratos
├── scripts/                   # compilação e inicialização do aplicativo
├── tests/
│   ├── fixtures/              # HTML sintético
│   ├── unit/
│   └── integration/           # Chrome sobre as fixtures; aplicativo e CLI reais, só no Windows
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
| `core/planner.ts` | POC-02 | nome previsto para o DAG de operações e o dry-run; essa função foi implementada em `core/movement-planner.ts` (§9.3), e este módulo não será criado. Não confundir com `core/organization-planner.ts` (§9.1), que tem outra responsabilidade |
| `safety/audit.ts`, `safety/approvals.ts` | POC-02/03 | eventos, reconciliação, aprovação humana |
| `air/mover.ts` | POC-03 | movimentação supervisionada; **desabilitada** até autorização |

### 5.2 Aplicativo desktop (App Base v0.1, implementado)

O aplicativo Electron é a **interface oficial** (ADR-017). Ele não reescreve o backend: o processo principal do Electron é um processo Node.js e importa os módulos existentes. A automação continua no **Chrome dedicado**, um processo separado controlado pelo Playwright, e a janela do Electron nunca abre o AIR.

| Camada | Responsabilidade | Não faz |
|---|---|---|
| `desktop/ui` | Telas, confirmações e exibição | Acessar Node, arquivos, rede ou o AIR |
| `desktop/preload.ts` | Expor `window.airOrganizer` com as operações do contrato | Expor `ipcRenderer` ou canais genéricos |
| `desktop/shell.ts` | Janela, bloqueios de segurança, registro do IPC, encerramento | Regra de negócio |
| `app/` | Sequência das operações, estado da sessão, visões sem nomes | Depender do Electron |
| `air`, `core`, `safety`, `storage` | Regras existentes, sem mudança de critério | Conhecer a interface |

**Comunicação segura por IPC:**

- **Janela isolada:** `contextIsolation` e `sandbox` ligados, `nodeIntegration` e `webviewTag` desligados, sem menu, com CSP `default-src 'none'` e scripts e estilos só do próprio aplicativo.
- **Sem saída:** a sessão da janela cancela requisições fora dos arquivos do aplicativo e nega permissões; navegação, redirecionamento e novas janelas são bloqueados.
- **Contrato fixo:** `ipc-contract.ts` lista as operações, cada uma em um canal `api:<operação>`, e nenhuma escreve no AIR. Eventos do processo principal chegam por um único canal (`app:event`).
- **Origem validada:** cada chamada confere se vem da página principal do próprio aplicativo. Outra origem é recusada.
- **Entrada não confiável:** tudo o que vem da janela é validado no processo principal (`app/validation.ts`, `app/settings.ts`). A janela indica inventários, execuções e subpastas por **identificador**: caminhos de arquivo nunca vêm dela.
- **Saída mínima:** por padrão, a janela recebe só visões sem nomes, caminhos nem URLs. Os nomes exigem confirmação e operação própria. Erros chegam como código e mensagem seguros, porque o texto original pode citar pastas ou URLs.
- **Texto como dado:** a interface usa só `textContent` e elementos criados por código, sem `innerHTML`.

**Regras de operação:** uma operação por vez; uma instância do aplicativo e um contexto do Chrome; o Chrome só fica "Aberto" depois da navegação inicial; com várias abas, a escolha é explícita e guarda a aba, não a posição. Ações só ficam habilitadas quando podem executar de verdade. Configurações ficam em `settings.json` no perfil do usuário, só com parâmetros que a CLI já suporta por variável de ambiente, que continua tendo precedência.

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

**Implementado (aplicativo e CLI):** pasta atual, uma subpasta com ida e volta e árvore a partir da pasta exibida, com limites. Uma leitura ampla é a árvore a partir da pasta mais alta desejada, com limites informados pelo operador.

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
3. Não abrir: arquivos, itens de tipo desconhecido, **homônimos exatos** (subpastas irmãs com o mesmo nome lido), itens com "Caminho" de outro ramo, nem nada além de `maxDepth` e `maxFolders`. Nomes que diferem só por caixa, acento ou pontuação **não** são ambíguos e são abertos: título, breadcrumb e "Caminho" da pasta aberta são comparados exatamente com a linha clicada (§7.5.1).
4. Recusa **antes** do clique registra a pendência e segue com as irmãs. Falha **depois** de um clique (`navigation-lost`, `return-failed`) interrompe a execução inteira, sem novos cliques, e marca o restante como `run-aborted`.
5. Cada pasta tem `status` (filhos diretos) e `subtreeStatus` (ela e todos os descendentes). A execução só é `complete` se a pasta inicial tiver `subtreeStatus = complete`. Ciclos e visitas repetidas são detectados pela chave da pasta na execução.

#### 7.5.1 Homônimos exatos

**Causa da recusa.** Antes do clique, nada na linha distingue duas irmãs com o mesmo nome. Não há ID verificado nas linhas (§2.1). Depois do clique, título, breadcrumb e "Caminho" são iguais para as duas. Só a **URL** da pasta aberta (`/air/my-air/<id>`, observada na POC-01C) as diferencia.

**Modo `homonyms: 'identify-by-url'`** (implementado e testado só em simulação e fixture; **desligado por padrão e não habilitado no aplicativo nem na CLI**):

- A linha (página + índice) é só **localizador temporário**. Antes do clique: página reposicionada idêntica à lida (assinatura), nome, tipo e célula conferidos, e a página precisa ter **exatamente** as linhas com esse nome lidas antes (`expectedSameNameRows`). Sem essa contagem, por exemplo na opção 3, qualquer homônimo é recusado.
- Depois do clique: identidade como em qualquer subpasta (URL nova, título, breadcrumb, "Caminho"). A **identidade persistente é a URL**: duas linhas que levam à mesma pasta geram a pendência `homonym`, e o inventário fica parcial. O grupo só fica completo se cada linha levar a uma pasta diferente, todas filhas do mesmo pai com o mesmo nome.
- Volta ao pai, `content-changed` e mudança de ordem antes do clique continuam valendo.
- Na retomada, o registro do checkpoint de um homônimo só é associado **depois** do clique, pela URL. A retomada RÁPIDA nunca reaproveita homônimos.
- Homônimos com linhas **idênticas** em páginas diferentes continuam recusados: são indistinguíveis de uma repetição da paginação (`read-incomplete`).

**Decisão: modo desativado, sem investigação adicional nesta fase.** A sonda experimental no AIR real não encontrou um par de homônimos exatos compatível, então a estabilidade da URL como identidade da pasta segue **sem comprovação**. Sem ela, se o AIR abrisse a irmã errada, uma URL instável esconderia o erro. Habilitar o modo na CLI exigiria nova evidência e nova decisão; até lá, vale o bloqueio conservador.

#### 7.5.2 Identidade x caminho da pasta exibida

Três informações distintas, nunca tratadas como equivalentes:

1. **Identidade da pasta exibida:** URL identificada e título "Nome (N)" igual ao último item do breadcrumb. Na navegação, também a verificação do clique ou da volta. Não depende da coluna "Caminho".
2. **Caminho da pasta exibida** (`FolderContext.path`, com a origem em `pathEvidence`):
   - `uniform`: todas as linhas com o mesmo "Caminho";
   - `expected`: conhecido por navegação verificada, ou seja, o pai na abertura e a própria pasta na volta;
   - `breadcrumb`: cadeia do breadcrumb não colapsado ou, na raiz, o título;
   - `inferred`: só para a pasta exibida **sem caminho esperado e com breadcrumb colapsado**, isto é, a pasta inicial do 3º nível em diante. É o **único** valor de "Caminho" das linhas, não vazio e bem formado, cujo último segmento é **igual** ao título e que é compatível com o breadcrumb (mesma raiz, mesma pasta atual, pelo menos um nível oculto). Zero ou vários candidatos dão `path-divergent` (recusa). Não há escolha por maioria, posição, ordem nem URL.
3. **"Caminho" de cada linha:** pode apontar para outro ramo. Essas linhas são contadas em `pathAnomalies`, **nunca são abertas** (`location-mismatch`) e deixam a pasta parcial.

O caminho `inferred` **não é prova de identidade**. Na abertura de uma subpasta dele, o "Caminho" precisa conferir, mas não entra nas evidências mínimas: URL, título e breadcrumb têm de bastar. Na retomada, a pasta inicial precisa ter o mesmo caminho inferido. Se ele mudar ou ficar ambíguo, a retomada é recusada antes de qualquer clique.

**Dívida técnica:** um caminho `uniform` é aceito sem conferir a coerência com título e breadcrumb. Isso foi mantido para não criar recusas sem evidência. Se a página 1 de uma pasta só tiver linhas de outro ramo com o mesmo "Caminho", esse valor seria tomado como o caminho da pasta.

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
- **VERIFICADO** (`verified`, padrão no aplicativo e na CLI): nada é reaproveitado. Toda pasta do escopo é reaberta e relida desde a página 1, sem presumir que a linha do pai reflete mudanças internas. O checkpoint dá continuidade (mesma execução, sessões registradas) e **comparação**: cada pasta relida é `unchanged`, `changed` (total ou assinatura de alguma página em comum diferente) ou `new` (sem registro, ou registrada mas nunca aberta), e subpastas registradas ausentes da listagem relida, quando ela está completa, contam como `removed`. O custo é o de uma leitura nova.
- Nos dois modos valem os mesmos limites (por execução) e as mesmas regras de completude. `eligibleForPlanning = status complete e nenhuma pasta reaproveitada`. **Nenhum modo promete consistência transacional:** o AIR pode mudar durante a própria leitura.

#### 7.7.1 Parada controlada (App Base v0.1)

`scanTree` e `scanListing` recebem um `AbortSignal` opcional. O sinal é conferido em dois pontos: entre páginas de uma pasta e imediatamente antes de abrir uma subpasta. Depois dele, nenhuma página nova é lida e nenhuma subpasta é aberta, e a pilha volta normalmente aos pais, com as verificações de sempre.

- A pasta interrompida fica `partial` (`read-incomplete`, com as páginas restantes em `unreadPages`) e as subpastas não abertas ficam `run-aborted`. Os dois motivos são retomáveis: a retomada não os ignora.
- O resultado leva `stopped: true` e status `partial`, logo nunca é elegível para planejamento. Se tudo já tinha sido lido quando o sinal chegou, o resultado é completo e sem `stopped`.
- Falha ao voltar depois da parada continua sendo `return-failed`, e não parada limpa.
- **Fechar o Chrome não é o mecanismo normal de interrupção.** Só existe como recuperação, depois de pedir a parada, para uma leitura que não termina. Encerramento abrupto do processo deixa o último checkpoint íntegro, e a trava órfã é substituída.

### 7.8 Reposicionamento em paginadores com reticências (POC-01E)

Com muitas páginas, o AIR real mostra a primeira, a atual ± 1 e a última, com reticências em cada lacuna: `[«][‹][1][2][...][50][›][»]` na página 1 e `[«][‹][1][...][3][4][5][...][50][›][»]` na página 4 (observado na POC-01E). Para voltar à página *k* de uma subpasta (o AIR reabre o pai na página 1), `goToPageNumber`:

1. não faz nada se a listagem exibida já é a registrada (a assinatura inclui o indicador de página);
2. a cada passo lê a página ativa (botão numérico destacado no paginador único) e os números visíveis. Clica em *k*, se estiver visível; senão, no maior número visível abaixo de *k* (quando isso aproxima); senão, em "próxima";
3. depois de cada clique, exige a página ativa esperada, uma listagem diferente da anterior e estável;
4. na página *k*, exige a assinatura registrada na leitura;
5. interrompe (recusa antes de abrir a subpasta, sem sair do pai) em: página ativa não identificada, controle ausente ou ambíguo, conteúdo repetido com outro número (loop), página não confirmada, conteúdo divergente ou mais de *k* + 1 passos.

Controles usados: só os já validados no AIR real (botão numérico dentro do paginador e "próxima" pelo ícone). Com a janela "atual ± 1" do AIR real, cada clique numérico desloca a janela e os números bastam; "próxima" fica para paginadores sem vizinhas. Reticências (`<span>`) nunca são candidatas. **Campo "Ir":** existe no AIR real (`<input type="number" placeholder="Página" min="1" max="<última>">` + botão "Ir"), mas **não é usado**: digitar num campo é uma ação nova fora da allowlist e exige aprovação arquitetural específica. O custo é de até *k* cliques, sempre com *k* ≤ páginas lidas ≤ `maxPagesPerFolder`. Validado no AIR real com saltos entre páginas já lidas da mesma pasta (inclusive para páginas ocultas pelas reticências).

**Achado da validação real (POC-01E), já resolvido (a hipótese abaixo foi refutada; ver "Causa confirmada" mais adiante nesta seção):** a volta de uma subpasta do 3º nível **depois de paginá-la** falhou (`return-failed`, com falha fechada). Hipótese: trocar de página cria entrada no histórico, e o "voltar" do cabeçalho (`history.back()`, usado quando o pai está colapsado no breadcrumb) retorna à página anterior da própria subpasta. Correções possíveis, a decidir após diagnóstico só de leitura (`history.length` antes e depois de "próxima"): (a) voltar à página 1 da subpasta antes de usar o "voltar" — só resolve se o histórico for empilhado por página; (b) usar o "voltar" repetidamente, conferindo a pasta a cada passo — exige limite e verificação rigorosos; (c) não paginar subpastas do 3º nível em diante até haver um mecanismo de volta seguro.

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

A consolidação deve comparar descendentes antes de mover uma pasta inteira. Se duas pastas têm subpastas homônimas, o planejamento de movimentações (§9.3) cria operações dependentes para consolidar o conteúdo primeiro; não presume merge automático no AIR.

### 8.4 Motor de diagnóstico estrutural (POC-02A, implementado)

`core/structural-diagnostics.ts` é um motor **determinístico e puro** (sem navegador, sistema de arquivos ou rede). A entrada é um inventário recursivo exportado (`tree-inventory.json`, identificável, gravado só com confirmação); a saída são achados para **revisão humana**. Mesmo inventário + mesma data de avaliação = mesmo relatório, independente da ordem das pastas no arquivo. Nenhum achado recomenda renomear, mover ou mesclar.

**Validação antes das regras (falha segura).** Referências únicas, uma única pasta inicial, pais existentes, profundidade coerente, contagens iguais à listagem, cada subpasta pareada com a linha correspondente do pai (nome) e caminho coerente com o do pai. Qualquer divergência = inventário **recusado**, sem achados.

**Elegibilidade (reutiliza a leitura, não recalcula):**

| Estado | Quando |
|---|---|
| `planning-eligible` | selo de integridade autenticado (§8.5), `verification.eligibleForPlanning` verdadeiro (completa, revalidada, sem `content-changed`) e inventário com até 7 dias (`AIR_ORGANIZER_INVENTORY_MAX_AGE_DAYS`) |
| `exploratory` | consistente, mas com qualquer motivo: `integrity-unsigned` (sem selo), `integrity-unverifiable` (sem chave local), `status-partial`, `status-failed`, `aborted`, `fast-resume`, `reused-folders`, `content-changed`, `not-eligible-for-planning`, `stale`, `legacy-format` (exportação anterior à POC-01E) |
| `rejected` | inconsistente, ilegível, sem nomes (`tree-diagnostic.json`) ou com selo inválido (§8.5) |

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

### 8.5 Integridade e procedência dos inventários (POC-02B.1, implementado)

Problema (R3 da auditoria da POC-02A): um `tree-inventory.json` editado de forma **estruturalmente coerente** (por exemplo, `finishedAt` "rejuvenescido" ou `eligibleForPlanning` forjado junto com os status) passava pela validação e podia parecer elegível.

**Selo.** Ao gravar o inventário detalhado (opções 6/7), a CLI acrescenta o campo `integrity`, sem mudar `schemaVersion` (2) nem os demais campos:

| Campo | Valor |
|---|---|
| `format` / `version` | `air-organizer/tree-inventory-seal` / `1` |
| `algorithm` / `keyDerivation` | `HMAC-SHA256` / `HKDF-SHA256` |
| `canonicalization` / `coverage` | `canonical-json-v1` / `document-except-integrity` |
| `keyId` | identificador público da subchave (16 hex, derivado; não revela a chave) |
| `sealedAt` | quando o selo foi gravado (não antes de `finishedAt`) |
| `mac` | HMAC-SHA256 (64 hex) |

- **Chave.** Reaproveita a chave-mestra local dos checkpoints (`checkpoint.key`, perfil do usuário, fora do repositório, ADR-010). Os inventários usam só uma **subchave derivada por HKDF-SHA256** (`info = tree-inventory-seal/v1`), e os checkpoints continuam usando a chave-mestra. Os propósitos ficam separados criptograficamente, com um único segredo a proteger. Nenhuma chave, subchave ou código aparece em console, log ou relatório.
- **Mensagem autenticada.** Domínio `air-organizer/tree-inventory-seal/v1`, seguido do JSON canônico (`canonicalJson`, chaves ordenadas) de `{ seal: cabeçalho sem mac, document: documento sem integrity }`, calculado sobre o documento **como gravado** (após o round-trip JSON). O selo cobre tudo: nomes, caminhos, URLs, referências, contagens, status, `verification`, `navigation`, `resume`, `abort`, limites, datas e ambiente. Reordenar propriedades ou reformatar o arquivo não invalida o selo; mudar qualquer valor ou a ordem de um array, sim.
- **Gravação (opções 6/7).** O autenticador vem do `CheckpointStore` da execução (`inventoryAuthenticator`), derivado da mesma chave que ele carregou ao abrir e usa nos checkpoints. A exportação não relê nem recria a chave: se `checkpoint.key` for apagada ou trocada durante a leitura, o inventário continua selado com a chave da execução e nenhuma chave nova é criada em silêncio. A chave em si não sai do store.
- **Snapshot.** `sealInventory` calcula o HMAC sobre o documento já serializado e lido de volta (round-trip JSON) e devolve esse mesmo objeto com o selo, sem referências ao `TreeResult`: o conteúdo autenticado é exatamente o gravado, mesmo que o original mude depois.
- **Verificação (opção 8).** A opção 8 nunca cria a chave. A comparação de `keyId` e `mac` usa tempo constante (`timingSafeEqual`).

**Ordem da avaliação:** (1) estrutura; (2) integridade; (3) completude e retomada VERIFICADA; (4) idade; (5) coerência entre metadados e conteúdo, já parte de (1).

| Integridade | Quando | Efeito |
|---|---|---|
| `authenticated` | selo válido com a chave local | pode ser elegível, se (3) e (4) também permitirem |
| `unsigned` | sem `integrity`: exportação anterior à POC-02B.1 **ou selo removido** (indistinguíveis); conteúdo não autenticado. A opção 8 exibe "SEM SELO: inventário legado ou selo removido; conteúdo não autenticado." | só exploratório (`integrity-unsigned`); nunca promovido. Remover o selo de um arquivo adulterado o rebaixa de recusado para exploratório, nunca para elegível |
| `unverifiable` | selo presente, chave local ausente, ilegível ou malformada | só exploratório (`integrity-unverifiable`) |
| `invalid` | selo malformado, de outra versão/algoritmo, com campo extra, anterior a `finishedAt`, de outra chave ou com código divergente | **recusado**, sem achados |

**Limites do que o selo prova.** Ele prova só que o arquivo foi gravado por esta instalação (com esta chave) e não mudou desde então. **Não prova que o AIR ainda esteja igual**: idade, completude e retomada continuam valendo, e um inventário autenticado pode ser exploratório. O selo **não concede autorização** de planejamento operacional nem de movimentação.

**Compatibilidade.** Inventários antigos continuam legíveis e só exploratórios. Não há selagem retroativa: um arquivo lido do disco nunca é selado (a procedência dele não pode ser atestada sem uma nova leitura autorizada); para obter um inventário elegível, faça uma nova leitura (opção 6 ou retomada VERIFICADA). Recriar a chave local invalida os selos anteriores (recusados por `key-mismatch`). Se a chave for apagada durante uma execução, a próxima abertura do store cria outra; os inventários e checkpoints dessa execução passam a ser recusados (`key-mismatch`/digest), nunca aceitos com outra chave. Checkpoints, navegação e `tree-diagnostic.json` não mudam. O relatório estrutural passa a `schemaVersion: 2`, com `integrity` e `completeness`.

## 9. Planejamento e dry-run

Há **dois planejamentos, com responsabilidades distintas**. Nenhum substitui o outro, e os dois continuam ativos:

| | Planejamento estrutural (§9.1, POC-02B.2) | Planejamento de movimentações (§9.3, POC-03A) |
|---|---|---|
| Módulo | `core/organization-planner.ts` | `core/movement-planner.ts` |
| Pergunta | O que nesta estrutura merece revisão? | Dadas a origem e o destino escolhidos, quais operações seriam necessárias, em que ordem, e o que impede cada uma? |
| Entrada | inventário | inventário e seleções explícitas do operador |
| Saída | propostas de revisão ligadas a achados, sem origem nem destino | propostas de operação, com origem, destino, dependências, conflitos e bloqueios |
| Interface e gravação | tela Planejamento, opção 9 da CLI; grava os relatórios | sem interface; só em memória |

O que eles compartilham é a **elegibilidade**: o de movimentações reaproveita a validação do estrutural (selo, estrutura, completude e idade). Ele não consome as propostas do estrutural, e uma proposta de revisão não vira operação sozinha: a escolha de origem e destino é do operador. Nenhum dos dois é executável.

As regras e o dry-run descritos a seguir orientam o planejamento de movimentações.

Entrada: inventário completo ou explicitamente parcial, pasta principal selecionada, candidatos aprovados e limites de execução.

Saída: lista ordenada de `MoveOperation`, dependências, conflitos, estimativa de itens afetados quando verificável e bloqueios.

Regras:

1. Nunca mover a pasta raiz do setor.
2. Nunca mover pasta para ela mesma ou para descendente.
3. Origem e destino devem pertencer ao mesmo setor autorizado.
4. Pasta de destino deve ser explicitamente escolhida e reconfirmada.
5. Não misturar movimentações de setores diferentes.
6. Não criar pastas implicitamente.
7. Se destino já contém homônimo, interromper e exigir plano de conflito (subpastas correspondentes: ver §9.2).
8. Não produzir plano executável quando a identidade de origem/destino for ambígua.
9. Plano deve ser revisável sem efetuar qualquer escrita.

**Dry-run é o comportamento padrão**, inclusive quando o usuário solicita um plano.

> As regras acima valem para a POC-03. A POC-02B.2 (§9.1) **não** gera operações; a POC-03A (§9.3) gera propostas, nunca executáveis.

### 9.1 Motor de planejamento determinístico (POC-02B.2, implementado)

`core/organization-planner.ts`, motor puro (sem navegador, rede, processos nem sistema de arquivos), tela Planejamento do aplicativo e opção 9 da CLI. Transforma um `tree-inventory.json` **autenticado e elegível** em **propostas de revisão** para uma pessoa avaliar. Nenhuma proposta é executável, e nenhuma autoriza mover, excluir, mesclar ou renomear nada no AIR.

**Revalidação na geração.** O plano não confia em relatório nem em flag gravados. Na hora da geração ele (1) roda `analyzeStructure` de novo, o que confere estrutura, selo (§8.5) e idade, e (2) aplica uma checagem própria da completude a partir das **pastas** (`planningBasisProblems`): status geral e de cada pasta/subárvore `complete`, nenhuma reaproveitada, sem pendências, sem `content-changed`, sem `abort`, sem limite atingido, retomada só VERIFICADA. Qualquer dúvida = **plano recusado, sem propostas**: sem selo, não verificável, selo inválido, FAST, parcial, expirado ou inconsistente. A exploração continua no Diagnóstico (opção 8 na CLI).

**Consequência importante:** irmãs que diferem só por caixa, acento ou pontuação são lidas (§7.5.1) e podem gerar propostas de "nomes equivalentes". Irmãs com nome **exatamente** igual não são abertas no aplicativo nem na CLI: o inventário fica parcial e o plano é recusado, enquanto o modo `identify-by-url` estiver desativado (§7.5.1, §15).

**Proposta** (`PlanProposal`), em quatro partes separadas:

| Parte | Conteúdo |
|---|---|
| `observed` | diagnóstico observado: achados (`findingIds`, `rules`), certeza da detecção, medidas, pastas F*n* com contagens |
| `proposal` | proposta de revisão: resumo, justificativa e perguntas ao revisor (sem nomes) |
| `futureAction` | possível ação futura, só com evidência suficiente: `consolidation-review` ou `name-standardization-review`, sempre `executable: false`, `authorizesChanges: false`, com pré-condições e **sem origem nem destino** |
| `blockers` / `risks` | impedimentos e riscos |

Mais: `id` estável (`P-` + SHA-256 de versão, **identidade do inventário autenticado**, tipo e achados; não depende de `now`), `status: pending-review` e `confidence` (`high`/`medium`/`low` com o critério em `basis`). `confidence` mede só a **força da evidência estrutural**: não é probabilidade, não diz que há um problema e nunca autoriza nada. A identidade do inventário (`source.inventoryId`) é um hash, com separação de domínio, do código do selo: liga o plano ao arquivo autenticado sem expor o código.

**Regras** (uma proposta por achado do §8.4):

| Achado | Proposta | Possível ação futura |
|---|---|---|
| `DUP-SIBLING-*` | `review-equivalent-names` | `consolidation-review` só com todas as irmãs lidas, listagem do pai completa e setor identificado; a pasta principal é escolha explícita do revisor |
| `NAME-VARIANTS` | `review-standardization` se uma grafia tiver **maioria estrita**; senão `review-naming-inconsistency` | `name-standardization-review`: a grafia predominante é só **hipótese**, não regra oficial |
| `NAME-SPACING` | `review-standardization` | `name-standardization-review` (nome sem espaços extras, como hipótese) |
| `HIER-NESTED-SAME-NAME`, `HIER-EQUIVALENT-CHILDREN` | `review-divergent-hierarchy` | nenhuma: origem e destino não são determináveis; nada é criado, movido ou mesclado |

Mesmo nome nunca é tratado como conteúdo equivalente (impedimento explícito em toda proposta de nomes equivalentes e de hierarquia). Não há proposta de exclusão, fusão automática ou movimentação entre setores: o plano cobre um inventário (um setor), e setor não identificado bloqueia toda ação futura.

**Saída** (`air-organizer/organization-plan`, `schemaVersion: 1`): `executable: false`, `authorizesChanges: false`, `authenticated: false`, avisos, `source`, `validation` (integridade, completude, elegibilidade recalculada, problemas da checagem própria, motivos), `observed`, `summary` e `proposals`. **Não há** lista de operações, comandos, URLs, seletores nem destinos (testado). Gravação: `organization-plan.json` (sem nomes, caminhos, grafias nem `runId`) sempre; `organization-plan-detailed.json` (identificável) só com confirmação; os dois ao lado do inventário em `output/` (ignorado pelo Git, e também por `organization-plan*.json`). Plano recusado não é gravado.

**O plano não é autenticado nesta etapa.** Um arquivo de plano pode ser editado sem detecção e **não pode** servir de fonte confiável para uma execução futura: qualquer etapa posterior deve gerar o plano de novo a partir de um inventário autenticado e recente, e revalidar no AIR.

### 9.2 Regras operacionais confirmadas (orientam a POC-03; a parte de planejamento está na POC-03A, §9.3)

Confirmadas na operação. Valem para o desenho futuro: **não há** executor, comparação documental nem classificação inteligente nesta etapa. Exemplos fictícios.

- O operador organiza por estrutura, nomes e contexto, **sem comparar o conteúdo interno dos arquivos**. O planejamento não deve depender dessa comparação.
- Variações de caixa e acento (`ORBITAS`, `Orbitas`, `ÓRBITAS`) podem representar a mesma categoria, mas **exigem confirmação**.
- Arquivos soltos vão para a pasta centralizada escolhida pelo operador. Subpastas existentes preservam sua hierarquia.
- Quando origem e destino têm a subpasta correspondente (ex.: `2025`), a consolidação aproveita a de destino, em vez de criar outra. Isso refina a regra 7 do §9 só para esse caso; conflitos de nomes e identidades ambíguas continuam exigindo intervenção humana.
- Um nome como `PROCESSO_00000_2031.pdf` pode gerar **sugestão** de classificação (Processo / 2031), conforme a estrutura existente. Nome de arquivo nunca prova igualdade documental (§8.2).
- As pastas de origem permanecem: sem exclusão automática.

### 9.3 Motor de movimentações supervisionadas (POC-03A, implementado; prévia na tela em §9.4)

`core/movement-planner.ts`, motor puro (sem navegador, rede nem sistema de arquivos), acessível por `planInventoryMovements` em `app/local-analysis.ts`. Não há opção da CLI, e nada é gravado. Aplica as regras do §9 e do §9.2 às **seleções explícitas do operador** e devolve propostas revisáveis. Não há executor: nenhuma proposta é executável, e não existe tipo de operação para excluir, substituir, renomear ou criar.

**Entrada.** Um inventário e as seleções: `file` (arquivo → pasta), `folder` (pasta → para dentro de uma pasta) e `folder-contents` (conteúdo de uma pasta → pasta escolhida, é a confirmação do operador quando os nomes diferem). O motor não escolhe origem nem destino. Os seletores usam o **caminho exato**; `ref` (F*n*) só confere, porque muda entre leituras e nunca desempata homônimos.

**Pasta vazia.** Sem linhas, a leitura não tem coluna "Caminho" (§7.5.2) e grava a subpasta sem `path`. `deriveEmptyFolderPaths` calcula o caminho em memória, a partir de uma pasta que **existe** no inventário, exigindo: nome utilizável; pasta vazia, com leitura completa; URL observada exclusiva; pai com caminho, leitura completa e sem homônimos no caminho; linha de mesmo nome no pai, que confirme o caminho do pai; nenhum item irmão com nome igual ou equivalente; e nenhuma outra pasta com o mesmo caminho. Um caminho construído nunca prova que a pasta existe. A identidade traz `pathProvenance: 'derived-from-parent'` (nos demais casos, `observed`), e a proposta traz um alerta para reconfirmar a pasta. Qualquer condição não atendida bloqueia, com o motivo (`insufficient-data` ou `ambiguous-*`). Isso não altera o inventário, o selo nem os critérios de integridade e completude.

**Elegibilidade.** A mesma do planejamento estrutural (§9.1, reutiliza `planOrganization`): selo, estrutura, completude pelas pastas e idade conferidos de novo. Inventário recusado = plano sem propostas. Um plano cobre **um inventário**, portanto um setor; origem e destino precisam estar nele.

**Operações** (`MovementProposal`):

| Tipo | Quando | Efeito proposto |
|---|---|---|
| `move-file` | arquivo selecionado ou arquivo de uma consolidação | leva o arquivo para a pasta de destino |
| `move-folder` | pasta sem homônima no destino | leva a pasta inteira, preservando a hierarquia interna |
| `consolidate-folder` | pasta com homônima **exata e única** no destino, ou `folder-contents` | **agrupamento lógico**, sem efeito próprio: registra o par e deriva as operações do conteúdo, recursivamente. A pasta de destino é reaproveitada e a de origem permanece, mesmo vazia |

**Estados.** `generated` (saída de `generateMovementProposals`, antes das verificações entre operações), `blocked` e `ready-for-review` (resultado de `assessMovementProposals`; é o que um plano contém). `review` é sempre `pending`, e `executable`/`authorizesChanges` são sempre `false`.

**Consolidação não libera operações.** Agrupar não aprova nada: `group.authorizesOperations` é sempre `false`, cada operação derivada tem estado e revisão próprios, e uma filha bloqueada nunca entra em `safeOrder`. `group.status` mostra a situação do agrupamento, em todos os níveis, e lista as operações em `readyOperations` e `blockedOperations`:

| `group.status` | Situação | Estado da consolidação |
|---|---|---|
| `all-ready` | todas as operações aptas | `ready-for-review` |
| `partially-blocked` | há operações aptas e bloqueadas; os itens bloqueados permanecem na origem | `ready-for-review`, com alerta. Só vale para as aptas |
| `fully-blocked` | nenhuma operação apta, ou impedimento da própria consolidação | `blocked` (`no-ready-operations`, se o impedimento vier só das filhas) |
| `empty` | a origem não tem o que consolidar | `ready-for-review`, com alerta |

**Bloqueios e conflitos** (uma proposta com qualquer um deles fica `blocked`, e as mensagens não têm nomes):

| Situação | Código |
|---|---|
| Destino ou origem fora do inventário (nada é criado implicitamente) | `destination-not-found`, `source-not-found` |
| Homônimos no caminho, em qualquer nível, ou nome repetido na pasta de origem | `ambiguous-source`, `ambiguous-destination` |
| `ref` divergente, URL repetida, linha de outro ramo, assinatura repetida, pasta selecionada como arquivo | `identity-inconsistent` |
| Falta nome, caminho, URL ou linha no pai; item de tipo desconhecido; seleção malformada | `insufficient-data`, `unknown-item`, `invalid-selection` |
| Pasta inicial, para si mesma ou descendente, já no destino, consolidação em que uma pasta contém a outra | `root-move`, `move-into-self`, `already-at-destination`, `overlapping-consolidation` |
| Mesmo nome no destino (**nunca presume o mesmo conteúdo**) ou nome equivalente após normalização (§8.1, pontuação inclusive) | `name-conflict`, `equivalent-name-conflict` |
| `2025` para dentro de `2025`, criaria nível repetido | `nested-same-name` |
| A mesma origem em duas operações, ou dois itens de nomes equivalentes indo ao mesmo destino | `source-claimed-twice`, `destination-collision` |
| Setor não identificado, ciclo de dependências, dependência bloqueada, consolidação sem operação apta | `sector-not-identified`, `dependency-cycle`, `dependency-blocked`, `no-ready-operations` |

**Dependências e ordem.** A consolidação vem antes das operações derivadas dela. Quando uma pasta inteira é movida, tudo o que retira algo dela ou leva algo para ela vem **antes**, para que os caminhos conferidos sejam os do inventário. Um destino precisa existir no inventário: nenhuma operação depende de outra para "criar" o destino. Bloqueio se propaga a quem depende. Uma filha bloqueada não bloqueia as irmãs: o restante continua revisável, e a consolidação de cima informa a situação em `group`. `safeOrder` é a ordem topológica (desempate estável) só das propostas aptas; é ordem de revisão, não roteiro de execução.

**Determinismo.** As seleções são postas em ordem canônica. Mesmo inventário + mesmas seleções, em qualquer ordem, + mesmo `now` = mesmo plano, byte a byte. O `id` (`M-` + SHA-256 de versão, inventário autenticado, tipo, origem e destino) não depende de `now`.

**Saída** (`air-organizer/movement-plan`, `schemaVersion: 1`): `dryRun: true`, `executable: false`, `authorizesChanges: false`, `authenticated: false`, avisos, `source`, `validation`, `summary` (com itens envolvidos e não envolvidos), `safeOrder` e `proposals`. `redactMovementPlan` retira nomes, caminhos, seleções, assinaturas e `runId`. **O plano não é autenticado:** vale a mesma restrição do §9.1 para qualquer etapa posterior.

### 9.4 Seleção e prévia na tela Planejamento (POC-03B, Incremento A)

`app/movement-review.ts` e `desktop/ui/movements.ts` ligam o motor do §9.3 à tela. **Nada é executado nem gravado**, e não há operação de escrita no AIR: a API continua sem nada que mova, crie, renomeie ou exclua.

**Fluxo.** O operador escolhe o inventário no seletor existente e pede a análise (`inspectInventory`), que mostra identificação, data, modo de leitura, completude, integridade, elegibilidade e contagens. O critério é o do planejamento (reutiliza `planOrganization`), sem outra implementação. Inventário inelegível pode ser consultado, mas não abre a seleção nem gera propostas. No elegível, o operador escolhe origem e destino em seletores hierárquicos e, para uma pasta, **o que fazer com ela** (levar a pasta ou consolidar o conteúdo): nada é presumido. `previewProposals` chama `planInventoryMovements`, que relê e revalida o inventário.

**Privacidade: nomes e caminhos ficam ocultos por padrão.**

- Até a revelação, a janela recebe só identificadores opacos (F*n* para pastas, A*n* para arquivos) e rótulos neutros. As visões têm uma lista fechada de campos, sem nomes, caminhos, assinaturas nem a seleção.
- Nomes ficam no processo principal e saem só por `revealSelectionNames`, depois de ação e confirmação do operador. Ficam em memória; a preferência não é persistida.
- Ocultar descarta os nomes na janela e redesenha seletores e prévias. Eles só entram como texto de elementos, nunca em atributos, títulos ou rótulos de acessibilidade.

**Estado da tela.** Trocar de inventário descarta seleções, nomes e prévia. Mudar origem, destino ou modo invalida a prévia, e trocar a origem também limpa o modo. Resposta de um pedido anterior é descartada, inclusive erro. O resumo traz total, prontas, bloqueadas, consolidações (por `group.status`) e categorias de conflito e de bloqueio.

**Apresentação da prévia.** Um quadro no topo mostra a seleção que gerou a prévia (inventário, origem, destino e modo). Proposta bloqueada tem borda e etiqueta de alerta, com símbolo e texto, além da cor, e nunca aparece como "Pendente de revisão"; consolidação parcial tem destaque próprio. Com qualquer bloqueio, o resumo usa aparência de atenção. Os motivos vêm dos códigos do motor, agrupados em conflitos, bloqueios de segurança, dependências não satisfeitas e outros (`blockingReasonLines`); sem motivo informado, a tela diz isso, em vez de afirmar que não há bloqueios. A ordem segura mostra posição, tipo, origem e destino, com o identificador como referência, na ordem calculada pelo motor.

**IPC.** As três operações entram na allowlist (`API_METHODS`), passam pela conferência de origem existente e validam o payload em tempo de execução: identificadores só no formato opaco, campos desconhecidos recusados e o valor recebido nunca repetido em mensagens. A árvore tem teto (`MAX_SELECTION_NODES`). O rótulo do inventário mascara a pasta de execução fora do formato gerado pela ferramenta (`inventoryLabel`), porque uma pasta renomeada à mão pode conter nomes.

**Seleção.** A janela envia só identificadores, nunca caminhos digitados. Identificadores valem para o inventário analisado: outro inventário, ou um arquivo que mudou depois da análise (comparado pela identidade do selo), é recusado até nova análise. A tela e `selectionFrom` antecipam erros evidentes (mesma pasta, descendente, arquivo como destino, pasta inicial como origem, identidade ambígua ou sem caminho comprovável, sinalizadas e não selecionáveis). Pasta vazia com caminho derivado é selecionável e sinalizada. A avaliação final é sempre do motor.

**Limites deste incremento.** Uma seleção por prévia, aprovada para esta etapa, sem seleção múltipla. As decisões do revisor estão no §9.5. As propostas continuam sem validação com seleções reais definidas pelo operador (§13).

### 9.5 Revisão humana e histórico local (POC-03B, Incremento B)

`core/movement-decisions.ts` (regras, sem arquivos nem rede), `storage/decision-files.ts` (arquivos) e a tela do §9.4. **Uma decisão só registra a revisão do operador.** Não executa, não autoriza e não altera a proposta: `executable: false`, `authorizesChanges: false` e `group.authorizesOperations: false` continuam obrigatórios, e plano ou proposta que digam o contrário são recusados como erro de contrato. Não existe caminho no código que leve de uma decisão a uma operação no AIR.

**Regras.**

- **Aprovar:** só proposta em `ready-for-review`, conforme o motor. Bloqueada não pode. Consolidação `partially-blocked` também não: só cada operação apta, individualmente.
- **Consolidação e operações são decididas de forma independente.** Aprovar uma consolidação não aprova as operações dela. Aprovar uma operação não aprova a consolidação. Uma consolidação rejeitada pode ter operações individualmente aprovadas, e isso não autoriza execução. A tela diz isso no resumo e nos cartões. **Uma etapa futura de execução deverá definir e validar a consistência entre agrupamentos e operações antes de qualquer movimentação;** essa política não existe nesta etapa.
- **Rejeitar:** sempre possível, inclusive em proposta bloqueada. A justificativa é opcional, com até 500 caracteres.
- **Mudar de ideia:** uma nova decisão acrescenta um registro, e a última prevalece. Não há como apagar pela tela.

**Quem decide é o motor, a cada pedido.** A janela envia só a seleção, o identificador da proposta, a decisão e a justificativa, com campos desconhecidos recusados. `decideProposal` refaz o plano a partir do inventário revalidado e procura a proposta nele; `createDecisionRecord` é o único caminho para criar um registro e aplica a regra de aprovação. Manipular a janela ou chamar o IPC diretamente não muda o resultado.

**Identidade e invalidação.** Cada decisão guarda `proposalId` e `signature`: HMAC do conteúdo completo da proposta, do inventário autenticado e da versão do planejamento, com subchave própria derivada da chave local (HKDF). HMAC em vez de hash puro para o arquivo sozinho não permitir confirmar nomes por tentativa. A cada prévia, `reconcileDecisions` confere o histórico contra o plano atual:

- assinatura diferente = decisão invalidada (`content-changed`), de aprovação ou de rejeição, e a proposta volta a pendente, com aviso;
- aprovação de proposta que o motor não considera apta agora = invalidada (`not-approvable`), mesmo com assinatura válida. O estado do motor sempre prevalece.

Decisões não passam de um inventário a outro: o arquivo, os registros, o identificador da proposta e a assinatura dependem do inventário autenticado. Uma nova leitura gera outro inventário e começa sem decisões.

**Persistência.** Um JSON por inventário em `%LOCALAPPDATA%\air-organizer\decisions\<inventário>.json`, fora do repositório e de `output/`, com escrita atômica. Registro: `inventoryId`, `proposalId`, `signature`, `decision`, `decidedAt`, `justification` (opcional), `planning` (`format`, `schemaVersion`, `plannerVersion`, `engineVersion`), `executable: false` e `authorizesChanges: false`. O documento tem selo HMAC. Sem credenciais, nomes nem caminhos; o único texto livre é a justificativa.

**Validação ao carregar.** Formato estrito e selo. Qualquer divergência, inclusive JSON corrompido, HMAC inválido ou edição manual, invalida o arquivo inteiro: nenhuma decisão é aproveitada. Falha de leitura do disco não é tratada como arquivo inválido.

**Histórico inválido.** O arquivo é preservado, a tela avisa e novas aprovações e rejeições ficam bloqueadas no processo principal, só para o inventário afetado. Um novo histórico só começa por `resetDecisionHistory`, com confirmação em diálogo nativo do **processo principal**: por isso uma chamada direta ao IPC só leva à pergunta e não a dispensa, e campos como `confirmed` são recusados. Confirmado, o arquivo é copiado para `<inventário>.invalido-<instante>-<aleatório>.bak`, sem substituir cópias anteriores, e o histórico recomeça válido e vazio, sem importar nada. Cancelado, nada muda. Histórico válido ou ausente não pode ser reiniciado, e inventário sem histórico decide normalmente, sem confirmação.

**Privacidade.** As visões não trazem a justificativa, porque ela pode conter nomes digitados pelo operador: mostram só que existe. O texto sai por `revealDecisionNotes`, junto com a revelação de nomes, e é descartado ao ocultar. Decisões não são exportadas.

**Limites.** O selo protege contra edição sem a chave local, não contra quem tem acesso à chave no mesmo perfil do Windows. Não há identificação de quem decidiu, tela de histórico nem retenção automática; a tela mostra só a contagem de registros por proposta. Aprovações ainda não foram exercitadas com seleções reais (§13). Uma execução futura precisará de contrato próprio e nova revalidação no AIR: uma aprovação registrada aqui não é autorização para ela.

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
- Aplicativo: janela isolada, IPC restrito e `settings.json` sem segredos (§5.2).
- Repositório público: testes, fixtures, comentários e documentação usam **somente dados sintéticos** (domínio `.test`, nomes fictícios). O `.gitignore` cobre saídas, documentos, capturas, perfis de navegador, credenciais, traces e temporários.

### 11.1 Política de exportação e de logs (implementada)

Nomes de pastas e arquivos podem conter dados pessoais e sensíveis. Por isso há dois níveis de saída:

| Saída | Conteúdo | Quando |
|---|---|---|
| Console padrão | status, contagens, referências (F1, D1…), tipos de pendência; caminhos de saída como `output/*/*/<runId>/<arquivo>` | sempre |
| `inventory-diagnostic.json` (opção 5), `tree-diagnostic.json` (opções 6 e 7) | o mesmo, com `identifiable: false`; sem nomes, caminhos, URLs, cliente, setor nem mensagens | sempre que se exporta |
| `checkpoint.json` (opções 6 e 7) | pseudônimos HMAC, contagens, status, motivos, limites e datas (§7.7); fora do repositório, com retenção | a cada passo da leitura recursiva |
| `inventory.json` (opção 5), `tree-inventory.json` (opção 6) | inventário identificável, com `identifiable: true` na leitura recursiva; o `tree-inventory.json` leva o selo HMAC `integrity` (§8.5), sem chave | **somente após confirmação explícita** do operador, a cada exportação |

- Valores do ambiente (domínio, URL, pasta, breadcrumb, cliente, setor) aparecem no console só como "identificado/não identificado" e fonte.
- Mensagens de erro e de pendência podem citar nomes. No console aparecem só pelo tipo. A exceção é a opção 3, cuja finalidade é escolher uma subpasta pelo nome. `AIR_ORGANIZER_VERBOSE_ERRORS=1` é um opt-in local de diagnóstico e pode expor nomes de pastas, caminhos e URLs; a saída não deve ser compartilhada.
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
- **POC-02B.2 (entregue):** propostas de revisão determinísticas e não executáveis (§9.1). Ainda sem escolha de pasta principal nem dry-run com destinos.
- Distinguir similaridade de nomes de duplicidade documental comprovada.
- Exigir escolha explícita da pasta principal.
- Impedir planos com ciclo, setor divergente ou destino ambíguo.
- Gerar plano revisável e **não executar movimentos**.

### App Base v0.1 (entregue)

**Objetivo:** tornar as funcionalidades existentes operáveis por uma interface gráfica mínima, sem mudar critérios nem reescrever o backend.

Entregue: janela Electron com IPC restrito (§5.2); conexão pelo Chrome dedicado; leitura direcionada e recursiva com progresso real; parada controlada e retomada (§7.7.1); diagnóstico; planejamento não executável; configurações locais. Validado manualmente pelo operador no Windows, no AIR real: conexão, leitura direcionada, leitura recursiva, interrupção e retomada. Diagnóstico e Planejamento também foram executados com inventários reais, conforme os arquivos gravados localmente, sem validação completa das propostas. O modo de retomada usado não está registrado.

### POC-03 — Movimentação supervisionada

**POC-03A (motor de propostas, §9.3): concluída com validação SINTÉTICA, em 05/11/2026.** Sem acesso ao AIR, sem executor e sem interface. **As propostas não foram validadas com dados reais:** não existem seleções reais de origem e destino, e o motor não foi executado sobre inventários reais. Medição local no fechamento: 2 de 3 inventários reais elegíveis para planejamento (o terceiro, parcial). O número vale para essa data, porque a elegibilidade expira com a idade do inventário. Origem e destino precisam ser **revalidados no AIR antes de qualquer execução futura**. Os critérios abaixo são da execução, ainda não implementada.

**POC-03B, Incremento A (seleção e prévia na tela, §9.4):** só leitura, sem executor. Validada com dados sintéticos.

**POC-03B, Incremento B (revisão humana e histórico local, §9.5):** grava só decisões locais, sem executor e sem escrita no AIR. Validada com dados sintéticos.

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
- **Aplicativo e CLI reais (só no Windows):** janela, IPC, Chrome dedicado, interrupções e menu da CLI sobre fixtures sintéticas, com perfil, chave e saídas temporários. O aplicativo de teste tem outro ponto de entrada; não há atalho de teste no código de produção. **Limite de carga e temporização:** os testes do Electron dependem de prazos (30 s por espera, 120 s por teste). Passam na suíte em condição normal, mas, com a CPU saturada de forma contínua, os fluxos de parar e fechar estouram esses prazos. A falha pode se propagar (`Hook timed out`, `EBUSY`) e deixar processos e pastas `air-organizer-desktop-*` no diretório temporário. Essa falha indica falta de folga do ambiente, não por si só um defeito do aplicativo.
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
| Caminho `uniform` aceito sem conferir título e breadcrumb (dívida técnica, §7.5.2) | Mantido; avaliar com evidência do AIR real antes de exigir a coerência |
| Irmãs com nome exatamente igual não são abertas (aplicativo e CLI) | Inventário com elas fica parcial e o plano é recusado (§9.1). Modo `identify-by-url` implementado, mas desativado: estabilidade da URL sem comprovação no AIR real (§7.5.1) |
| Plano de organização editado depois de gravado | Plano não é autenticado nem executável; qualquer etapa futura gera o plano de novo a partir de inventário autenticado e recente (ADR-016) |
| Critério rígido deixa inventários reais fora do planejamento | Homônimos exatos e itens de outro ramo tornam a leitura parcial e o plano é recusado. Medir a frequência no uso real antes da POC-03; a exploração continua no Diagnóstico |
| `output/` relativo à pasta de execução | Sem efeito com `npm run app`; precisa de local fixo antes de um instalador |
| Testes do aplicativo só no Windows | O CI (Ubuntu) os ignora; rodar `npm test` no Windows antes de integrar |
| Navegação inicial acima do prazo por página | Por desenho, o Chrome abre com a aba em branco e um aviso, e a verificação pede para navegar manualmente. Nos testes do aplicativo, o prazo da fixture é o padrão (15 s), porque 5 s estourava sob carga |
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
- **ADR-015 — Selo de integridade dos inventários (POC-02B.1):** o `tree-inventory.json` é selado na gravação com HMAC-SHA256, usando uma subchave HKDF-SHA256 derivada da chave local dos checkpoints (propósitos separados, um único segredo), sobre o JSON canônico do documento inteiro e do cabeçalho. A subchave vem da chave que o `CheckpointStore` carregou para a execução (sem reler nem recriar a chave na exportação), e o selo é calculado sobre um snapshot independente, o mesmo que é gravado. Só inventário `authenticated` pode ser `planning-eligible`; sem selo (legado ou selo removido, indistinguíveis) ou sem chave = exploratório; selo inválido = recusado. Sem selagem retroativa e sem serviços externos. Integridade autenticada não significa conteúdo atual e não autoriza movimentação (§8.5).
- **ADR-016 — Planejamento determinístico não executável (POC-02B.2):** propostas de revisão geradas por um motor puro sobre o inventário, revalidando selo, estrutura, completude (pelas pastas) e idade no momento da geração; inelegível = recusa sem propostas. IDs incorporam a identidade do inventário autenticado. `confidence` é força de evidência, nunca autorização. Possível ação futura só como hipótese não executável, sem origem/destino; nenhum formato de comandos. O plano não é autenticado e não serve de fonte para execução sem nova leitura e revalidação (§9.1).
- **ADR-017 — Aplicativo desktop Electron como interface oficial (App Base v0.1):** a interface oficial passa a ser um aplicativo desktop local, e não uma interface web independente nem uma extensão Chrome; a CLI permanece como alternativa e para a limpeza de checkpoints expirados. Electron foi escolhido em vez de Tauri porque o processo principal roda os módulos Node.js e o Playwright existentes, sem reescrita, sem sidecar e sem uma segunda linguagem. O custo aceito é um instalador maior e mais um Chromium em memória. A orquestração saiu da CLI para `src/app`, sem depender do Electron, e as duas interfaces a compartilham. A janela não acessa Node e só fala com o processo principal por uma lista fixa de operações (§5.2). A parada usa `AbortSignal`, com alteração mínima no scanner, e fechar o Chrome fica só como recuperação (§7.7.1). A limpeza de checkpoints fica fora da interface. Critérios de elegibilidade e regras de segurança não mudaram, e nada escreve no AIR.
- **ADR-018 — Propostas de movimentação sobre seleções explícitas (POC-03A):** motor puro, com a elegibilidade do ADR-016, que deriva operações só das seleções do operador. Um inventário por plano: origem e destino no mesmo setor. Correspondência automática só por nome **exato e único**; variação de grafia exige consolidação explícita. Conflito ou dúvida bloqueia a operação, nunca escolhe. Destino precisa existir no inventário. Nenhum tipo de operação exclui, substitui, renomeia ou cria, e nenhuma proposta é executável. A consolidação é um agrupamento lógico, que não libera as operações derivadas, e a pasta de origem permanece. O plano não é autenticado (§9.3). Complementa o planejamento estrutural do ADR-016, sem substituí-lo: os dois têm responsabilidades distintas (§9).

- **ADR-019 — Prévia de movimentações com nomes ocultos (POC-03B, Incremento A):** a tela Planejamento seleciona origem e destino por identificadores opacos, e nomes e caminhos ficam no processo principal até a revelação explícita e confirmada, sem persistir a preferência. Ocultar remove os nomes de seletores, prévias e mensagens. Identificadores valem só para o inventário analisado. A elegibilidade é a do ADR-016, e a avaliação é a do motor do ADR-018. Nada é executado nem gravado (§9.4).

- **ADR-020 — Decisões humanas locais, sem efeito de autorização (POC-03B, Incremento B):** aprovar ou rejeitar registra só a revisão, em JSON local por inventário, fora do repositório, com selo e assinatura HMAC de subchave própria. O processo principal refaz o plano a cada decisão, e o estado do motor prevalece sobre qualquer registro. Decisão vale para o conteúdo exato da proposta e é invalidada se ele mudar. Arquivo inválido é ignorado por inteiro, bloqueia novas decisões e só é substituído depois de confirmação no processo principal, com cópia de recuperação. Consolidação e operações são decididas de forma independente, e a consistência entre elas fica para a etapa de execução. Justificativas ficam ocultas junto com os nomes (§9.5).

## 18. Próxima ação concreta

**Situação:** a App Base v0.1 está entregue (§5.2, ADR-017), estritamente somente leitura, sobre a POC-01 (leitura e retomada, §7), a POC-02A (diagnóstico, §8.4), a POC-02B.1 (selo, §8.5) e a POC-02B.2 (planejamento não executável, §9.1). A POC-03A (§9.3) e os Incrementos A e B da POC-03B (§9.4, §9.5) foram concluídos com validação sintética, sem validação real das propostas (§13). O achado do `return-failed` após paginar está diagnosticado e corrigido (§7.8).

Pendências de validação no AIR real: cada modo de retomada isoladamente e abertura de subpasta em página oculta (README, "Limitações conhecidas"). Decidir sobre o campo "Ir" continua em aberto.

**Próxima etapa:** validar as propostas e a revisão com seleções reais definidas pelo operador, em memória, sobre um inventário elegível que cubra origem e destino. Depois, a execução da POC-03, seguindo as regras do §9 e do §9.2 e os pré-requisitos da seção POC-03 (§13). Antes, medir com que frequência inventários reais ficam elegíveis para planejamento (§15). `homonyms: 'identify-by-url'` continua desativado, sem nova investigação (§7.5.1). Não implementar nem habilitar `mover.ts` sem a autorização correspondente.

---

**Critério de portabilidade:** executar a mesma POC em dois setores ou ambientes autorizados sem modificar o código-fonte, alterando apenas o contexto de execução.

**Critério de sucesso do projeto:** minutos de trabalho manual economizados com organização confiável e auditável — não quantidade de funcionalidades desenvolvidas.
