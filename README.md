# AIR Organizer

Ferramenta local e supervisionada para auxiliar implantadores na organização documental do AIR (Printer do Brasil). Funciona com qualquer instância, cliente, cidade ou setor: é **multiambiente e multissetor**, e nenhum identificador de instância, cliente, setor ou pasta está fixo no código.

**Estágio atual: POC-01E, estritamente somente leitura.** A ferramenta lê a listagem exibida pela interface oficial do AIR, percorre a paginação (inclusive páginas escondidas por reticências), entra em subpastas por cliques verificados (inclusive em profundidade, com limites), grava checkpoints para retomar leituras interrompidas, aponta suspeitas de duplicidade por nome e exporta relatórios. Ela não move, cria, exclui, edita nem renomeia nada. Planejamento (POC-02) e movimentação (POC-03) **não estão implementados**.

Veja [ARCHITECTURE.md](ARCHITECTURE.md) para os princípios, as decisões registradas e o plano de entregas.

## Requisitos

- Windows 11, Node.js 20+ (validado com 24.19), npm
- Google Chrome instalado (validado com 156)

## Instalação

```powershell
npm install
```

O Playwright usa o Chrome já instalado (`channel: 'chrome'`). Não é necessário baixar navegadores.

## Uso

```powershell
npm start
npm start -- --url https://air.exemplo.test/air/     # ou: $env:AIR_ORGANIZER_URL = 'https://air.exemplo.test/air/'
```

A URL da instância é informada pelo usuário (argumento `--url`, variável `AIR_ORGANIZER_URL` ou prompt); nenhuma instância é fixa no código. Só HTTPS, sem credenciais, e é registrada sem query string. Os exemplos usam o domínio reservado `.test`; não grave domínios reais em arquivos versionados.

```text
1. Verificar conexão com AIR
2. Analisar pasta atual
3. Analisar uma subpasta       (ida e volta, com confirmação; sem recursão)
4. Exibir possíveis duplicidades
5. Exportar inventário
6. Analisar árvore             (recursivo controlado, com limites e checkpoint)
7. Retomar análise de árvore  (só aparece com checkpoint válido)
0. Sair
```

1. Na primeira operação, a ferramenta abre um **Chrome separado com perfil dedicado** em `%LOCALAPPDATA%\air-organizer\chrome-profile`, fora do repositório. As janelas do Chrome que você já usa não são tocadas.
2. Faça **login manualmente** nesse Chrome e navegue até a pasta que deseja analisar. A ferramenta nunca lê, copia nem exporta cookies, tokens ou senhas.
3. **Opção 1** mostra o que foi identificado: se origem, URL, pasta e breadcrumb foram identificados (e por qual fonte), colunas, linhas, total exibido e o controle de paginação. Os **valores** (domínio, nomes, caminhos) não são exibidos: confira no Chrome dedicado.
4. **Opção 2** pede que você informe o cliente e o setor como aparecem no AIR, mostra o status do escopo e só lê depois da sua confirmação. Ela percorre todas as páginas da pasta atual, sem entrar em subpastas. As pendências aparecem só pelo tipo e pela página.
5. **Opção 3** lê a pasta atual, lista as subpastas **visíveis** na página (só linhas com ícone de pasta), pede que você escolha e confirme uma, abre-a pela interface, confirma a identidade, lê todas as páginas dela e volta à pasta anterior, confirmando o retorno. Qualquer divergência interrompe a operação. **É a única opção que exibe nomes sem confirmação adicional**, porque a escolha depende deles.
6. **Opção 4** lista as suspeitas de duplicidade por referência (D1, D2…), confiança, regras e número de itens. Os nomes só aparecem se você confirmar.
7. **Opção 5** grava sempre `output/<instância>/<setor>/<execução>/inventory-diagnostic.json`, **sem dados identificáveis**. O `inventory.json`, com nomes, caminhos e URLs, só é gravado se você confirmar explicitamente (mesma política da opção 6).
8. **Opção 6** lê a pasta exibida e seus descendentes em profundidade (DFS), dentro de limites que você confirma: `maxDepth`, `maxFolders`, `maxItems` e `maxPagesPerFolder`. Os padrões são conservadores (1 / 5 / 100 / 2). Ao atingir um limite, a leitura para e fica **parcial**, e os limites nunca são aumentados automaticamente. O console mostra só referências (F1, F2…), contagens, status e motivos. É gravado o `tree-diagnostic.json`, também sem dados identificáveis. O `tree-inventory.json`, com nomes e caminhos, só é gravado se você confirmar explicitamente no fim. Durante a leitura, o console mostra o progresso (`[executando] pastas · itens · páginas · pendências`), e o resultado sai como CONCLUÍDO, PARCIAL ou INTERROMPIDO, com os limites utilizados e as pendências. A cada passo é gravado um **checkpoint** (ver abaixo).
9. **Opção 7** só aparece quando existe checkpoint válido. Ela retoma uma execução a partir da **mesma pasta inicial**, que você abre manualmente no Chrome dedicado (nenhuma URL é montada). Instância, cliente, setor e pasta inicial precisam coincidir com os gravados; senão, a retomada é recusada com o motivo. Você escolhe o **modo**: VERIFICADO (padrão) ou RÁPIDO (ver "Modos de retomada").

Configuração opcional: [.env.example](.env.example). Os valores são lidos de variáveis de ambiente.

## Privacidade e LGPD

Nomes de pastas e arquivos do AIR costumam conter **dados pessoais e sensíveis** (nomes de pessoas, documentos de identificação, dados de saúde). Por isso:

- **Saída padrão sem dados identificáveis.** Console e relatórios diagnósticos trazem só status, contagens, referências (F1, D1…) e tipos de pendência. Os caminhos de arquivos gravados aparecem como `output/*/*/<execução>/<arquivo>`, porque os dois primeiros segmentos derivam do domínio e do setor.
- **Exportação identificável só mediante confirmação explícita** (opções 5 e 6), e somente se permitida pelas políticas da organização.
- **Erros** aparecem só pelo tipo, porque o texto pode citar pastas ou URLs. A exceção é a opção 3, que já exibe nomes. Para depuração local, `AIR_ORGANIZER_VERBOSE_ERRORS=1` mostra o texto completo. Não compartilhe essa saída.
- **Checkpoints são pseudonimizados**, mas continuam sendo dados pessoais para a LGPD (a chave local permite reidentificar). Ver "Checkpoint e retomada".
- **`output/` nunca é versionada** (ver [.gitignore](.gitignore)). Ela pode conter inventários identificáveis gravados com confirmação, inclusive por versões anteriores. Proteja o diretório, defina retenção e descarte conforme a política da organização. A ferramenta não apaga nada sozinha.
- **Não envie** inventários, logs ou capturas de tela a serviços externos, incluindo assistentes de IA, sem autorização.
- **Testes e documentação usam apenas dados sintéticos** (domínio `.test`, nomes fictícios). Não copie nomes reais de clientes, setores, pastas ou pessoas para o repositório.

## O que a POC-01 garante

- **Cliques só de navegação**, cada um verificado antes e depois:
  - **Abrir subpasta:** clique na célula do **nome** de uma linha com ícone de pasta, nome único na página e sem controles na célula. No AIR, clicar numa linha de **arquivo** abre um visualizador **editável**, então linhas que não são comprovadamente pasta nunca são clicadas. Depois do clique, a ferramenta exige URL nova, título igual ao nome, breadcrumb compatível com o caminho do pai + nome e "Caminho" das linhas = caminho do pai + "/nome". Se um diálogo abrir, a operação é interrompida.
  - **Voltar:** pelo link do pai no breadcrumb (navega pelo ID da pasta). Se o pai estiver colapsado no menu "More" (3º nível em diante), o menu **não** é aberto: a ferramenta usa a seta "voltar" do cabeçalho. Nos dois casos, URL, título, total, caminho e breadcrumb precisam ser iguais aos observados antes de sair.
  - **Nenhuma URL interna é construída.** Toda navegação é por clique na interface; a URL só é lida, para confirmar a identidade.
- **Próxima página:** no AIR real o botão só tem ícone (ChevronRight do Radix, sem texto nem `aria-label`) e só é aceito dentro do paginador numérico; ícones iguais em outros lugares (carrossel de recentes) são descartados. Com rótulo textual, ele passa por uma allowlist, e a [blocklist](src/safety/scope-validator.ts) recusa qualquer termo de mover, excluir, selecionar, baixar etc. Um botão ambíguo interrompe a leitura.
- **Escopo fixo:** se a origem, a URL da pasta, a pasta atual, o setor ou o breadcrumb mudar durante a leitura, ela é interrompida.
- **Completude:** só é `complete` com total do título = itens lidos, contador de cada página = linhas lidas, sem repetições e **sem filtro**: tipo "Todos" e busca vazia. Total da página ("X de N linhas(s)"), total da pasta (título, filhos **diretos**) e descendentes são grandezas diferentes.
- **Tipo:** só pelo ícone da coluna de tipo (`lucide-folder` → pasta; `<img alt="<tipo> icon">` → arquivo). Qualquer outra coisa é `unknown`. Nem a extensão do nome nem os ícones de outras colunas decidem o tipo.
- **Paginação verificada:** depois de cada avanço, a ferramenta espera a listagem mudar e se estabilizar. Loops, páginas inalteradas, timeouts e limite de páginas encerram a leitura. Em todos os casos o relatório indica o que **não** foi lido.
- **Identidade:** um nome igual nunca é tratado como o mesmo item. As observações são deduplicadas por uma assinatura com todos os metadados da linha. Nenhum ID é atribuído enquanto um atributo não for validado manualmente como estável.
- **Duplicidades** são sempre `suspected-duplicate`: nomes equivalentes após normalização de caixa, acento, espaços e pontuação. Elas nunca indicam conteúdo igual.
- **Valores não identificados** aparecem como `not-identified` com o motivo. A ferramenta não inventa cliente, setor ou pasta.
- **URLs** são registradas sem query string nem fragmento. Só HTTPS é aceito.

## Testes

```powershell
npm test         # unitários + integração em fixture HTML (Chrome headless)
npm run typecheck
```

Os testes de integração usam uma fixture HTML **sintética** em [tests/fixtures/](tests/fixtures/), servida em uma origem HTTPS fictícia (`air.fixture.test`) via `page.route`. Nenhuma requisição sai da máquina. A fixture contém botões "Mover para", "Excluir" e de seleção, e os testes verificam que nenhum deles é clicado. Todos os nomes de pastas, setores e pessoas nos testes são fictícios. Eles preservam só as características técnicas necessárias: diferenças de caixa e acento, formas Unicode compostas e decompostas, homônimos e hierarquias de vários níveis.

## Estrutura

```text
src/
├── air/        reader.ts (extração do DOM), navigator.ts (ambiente + paginação), folders.ts (subpasta: abrir/voltar), tree-navigator.ts (adaptador da leitura recursiva), session.ts (Chrome dedicado)
├── core/       scanner.ts (paginação/cobertura), tree-scanner.ts (leitura recursiva DFS e retomada), checkpoint.ts (modelo do checkpoint), records.ts (parsing), duplicates.ts (normalização)
├── safety/     scope-validator.ts (ações permitidas, escopo, URLs, caminhos)
├── storage/    export.ts (relatórios diagnósticos e inventários JSON, escrita atômica), checkpoints.ts (checkpoints locais: chave, trava, retenção)
├── cli/        index.ts, args.ts
└── types/      inventory.ts
```

`core` e `safety` não dependem do Playwright (ARCHITECTURE.md §5). A estrutura planejada para as próximas fases está em ARCHITECTURE.md §5.1.

## Validação no AIR real (POC-01B, 29/10/2026)

Executada em uma instância real, na raiz "Meu Air" (37 pastas, 2 páginas de 30), somente leitura. Resultado: 2 páginas lidas, 37/37 itens, `complete: true`, inventário idêntico ao exibido (nomes, caminho, data e ordem). Confirmado:

- **Total da pasta** = número no título `<h2>Nome da pasta (N)</h2>`.
- **"X de N linhas(s) selecionadas" conta só a página** (N = 30 na página 1 e 7 na página 2), **não** a pasta. Ele passou a ser usado só como verificação de integridade da página.
- **Na raiz não existe breadcrumb** (nas subpastas existe; ver POC-01C). A pasta atual vem do título (`source: page-heading`). O escopo é fixado por origem + URL da pasta + título.
- **Paginação:** `[«][‹][1][2][›][»]`, só ícones. A página ativa é o número com `bg-primary`. Na última página, "›" fica `disabled`. A URL não muda ao paginar.
- **Pasta:** ícone `lucide-folder`. As linhas não têm atributo de ID. A URL da pasta contém um identificador (`/air/my-air/<ULID>`), ainda não usado.

Antes da correção, essa pasta era reportada como **completa com 30 de 37 itens**: o contador da página era lido como total e o paginador sem rótulo não era encontrado. Existe um teste de regressão para esse caso.

## Validação no AIR real (POC-01C, 29/10/2026)

Somente leitura. Foram usadas pastas escolhidas pelo usuário. Nomes de itens não foram exibidos durante a validação nem registrados aqui.

| Cenário | Resultado |
|---|---|
| Raiz → pasta do 2º nível e volta | identidade por URL, título, breadcrumb e caminho; 2/2 itens, completa; volta pelo **link do pai** com listagem idêntica |
| Pasta do 2º nível → subpasta do 3º nível e volta | breadcrumb colapsado `Meu Air / … / atual` aceito contra o caminho; 1/1 item, completa; volta pela **seta do cabeçalho**, verificada |
| Pasta com 27 PDFs | 27/27 `file` (`icon:img:pdf icon`), completa |

Evidências:

- **Tipo.** Pasta = `<svg class="lucide-folder">` (41 linhas, todas `type: "digital"` no AIR). Arquivo = `<img alt="pdf icon">` (27 linhas, todas `type: "file"`). O filtro "Todos" tem as opções `all`/`file` ("Arquivos")/`digital` ("Pastas").
- **Caminho.** A coluna "Caminho" é o caminho completo da pasta **exibida** e é igual em todas as linhas.
- **Título.** "Nome (N)" conta só os **filhos diretos**. A pasta do 2º nível com título "(2)" tem mais de 2 descendentes.
- **Breadcrumb.** Não aparece na raiz. No 2º nível mostra `raiz / atual`. Do 3º nível em diante, os intermediários colapsam num botão de menu "More".
- **Linhas.** Não têm atributo de ID no DOM. O ID do item só aparece na URL depois de abrir a pasta.
- **Bug corrigido.** Arquivos sem ícone reconhecido eram classificados pelos ícones da coluna Status (`file-search`, `file-check`). Com coluna de tipo presente, isso não acontece mais.
- **Falha fechada observada.** Antes do suporte ao breadcrumb colapsado, a abertura no 3º nível foi interrompida por identidade não confirmada, como projetado.

## Checkpoint e retomada (POC-01E)

**Onde fica.** `%LOCALAPPDATA%\air-organizer\checkpoints\<instância>\<setor>\<pasta inicial>\<execução>\checkpoint.json`, no perfil do usuário e fora do repositório (configurável por `AIR_ORGANIZER_CHECKPOINT_DIR`, nunca dentro do repositório). Os três primeiros níveis são pseudônimos, não nomes.

**O que guarda (minimização).** Só pseudônimos HMAC-SHA256 da URL, do nome, do caminho, da linha no pai e de cada página lida; contagens; status; motivos de pendência; limites; e datas. **Não guarda** nomes, caminhos, URLs, mensagens, itens, cookies, tokens nem conteúdo de documentos. A chave HMAC fica em `%LOCALAPPDATA%\air-organizer\checkpoint.key`, separada dos checkpoints. Quem tem só o checkpoint não consegue confirmar um nome por tentativa.

**Consistência.** Cada gravação é atômica (arquivo temporário + rename) e leva um HMAC do documento. Arquivo truncado, editado ou gravado com outra chave é recusado. Uma trava impede duas sessões na mesma execução; a trava de um processo encerrado é substituída.

**Retenção.** `AIR_ORGANIZER_CHECKPOINT_RETENTION_DAYS` (padrão 7 dias). Fora do prazo, o checkpoint não é retomado, porque a estrutura pode ter mudado, e a CLI oferece excluí-lo, com confirmação. Execuções concluídas não são oferecidas para retomada.

**Como a retomada funciona.**

1. Antes de qualquer clique: checkpoint íntegro e dentro do prazo, mesma instância, cliente e setor, e a pasta exibida precisa ser a pasta inicial gravada (URL, título e caminho).
2. A mesma DFS é refeita a partir da pasta inicial. Uma subpasta **não é reaberta** quando a subárvore dela está *assentada* no checkpoint (lida, sem pendência que valha repetir) **e** a linha dela na listagem do pai, relida agora, é **idêntica** à registrada (nome, caminho, datas, status, descrição). Todas as outras pastas são relidas desde a página 1, sem duplicar itens.
3. Pendências de limite, de leitura e de navegação (`max-*`, `read-incomplete`, `read-error`, `open-refused`, `navigation-lost`, `return-failed`, `run-aborted`) são tentadas de novo. Pendências do próprio conteúdo (homônimo, "Caminho" de outro ramo, tipo desconhecido, ciclo, visita repetida) são mantidas: repetir daria o mesmo resultado.
4. **Os limites valem para a execução inteira**, incluindo o que foi reaproveitado. Com os mesmos limites que pararam a leitura, ela continua parcial: para avançar, aumente-os explicitamente. Eles nunca são aumentados automaticamente.
5. A execução só fica **completa** se o que faltava for de fato lido nesta sessão, sem limite atingido e com a subárvore inteira completa. Uma execução parcial nunca vira completa só por ter sido retomada.

### Alterações durante a análise (ADR-013)

**O AIR pode mudar enquanto a ferramenta lê**: outras pessoas movem, criam ou renomeiam itens. O inventário **não é uma fotografia transacional**; cada pasta reflete o momento em que foi lida. Por isso, ao voltar de uma subpasta para o pai, a ferramenta separa duas perguntas:

1. **É a mesma pasta? (identidade)** URL e título sempre; breadcrumb quando exibido; "Caminho" quando os dois lados o exibem. Divergência ou ambiguidade = `identity-mismatch`: a execução para imediatamente, sem novos cliques (falha fechada).
2. **Ela mudou? (conteúdo)** Total do título e listagem da mesma página. Divergência = `content-changed`. A volta é aceita e:
   - a pasta e os ancestrais deixam de ser completos, e a execução fica parcial e **não elegível para planejamento**;
   - as subpastas ainda não abertas dessa pasta **não são abertas** (seria clicar a partir de uma listagem desatualizada) e ficam pendentes (`content-changed`);
   - a pasta **não é relida automaticamente** na mesma sessão (sem loop). A retomada (opção 7) a relê, e a retomada rápida nunca reaproveita a subárvore afetada.

`content-changed` registra uma divergência **observada**, não a sua causa. A ferramenta não afirma que houve alteração concorrente. Falhas em que não se consegue confirmar onde se está (prazo, controle ausente) aparecem como `navigation-failed`. O console mostra as três contagens, sem nomes.

### Modos de retomada

Os dois modos usam a mesma DFS e as mesmas regras de identidade, limites e completude. A diferença é só se subárvores já concluídas podem ser reaproveitadas sem reabrir.

| | **VERIFICADO** (padrão) | **RÁPIDO** |
|---|---|---|
| Subpastas concluídas no checkpoint | reabertas e relidas desde a página 1 | não reabertas, se a linha delas no pai for idêntica |
| Conteúdo interno | revalidado: páginas, registros, contagens e pendências | **não revalidado**: mudanças dentro delas não são detectadas |
| Comparação com o checkpoint | cada pasta relida sai como inalterada, alterada ou nova; subpastas que sumiram são contadas como removidas | idem, só para as pastas relidas |
| Custo | o de uma leitura nova (o checkpoint dá continuidade e comparação, não economia) | só o que estava pendente |
| Base para planejar movimentações | sim, se o resultado for **completo** | **nunca** (`eligibleForPlanning: false`), mesmo completo |

O resultado e o relatório diagnóstico trazem `verification.contentRevalidated` e `verification.eligibleForPlanning`. A CLI nunca apresenta o modo rápido como equivalente ao verificado. **Nenhum modo garante consistência transacional:** o AIR pode mudar durante a própria leitura. Como o checkpoint não guarda nomes, no inventário detalhado de uma retomada rápida as pastas reaproveitadas aparecem só com contagens.

## Validação no AIR real (POC-01E, 03/11/2026)

Somente leitura, saída só diagnóstica, pastas escolhidas e abertas pelo usuário. Nenhum nome foi exibido nem exportado.

**Paginador** (pasta de 1494 itens, 50 páginas de 30; nenhuma subpasta aberta):

- **Página ativa:** botão numérico com `bg-primary`, único, sempre visível. Sem `aria-current`.
- **Números exibidos:** a primeira, a atual ± 1 e a última, com `<span>...</span>` em cada lacuna. Página 1: `[1][2][...][50]`; página 4: `[1][...][3][4][5][...][50]`. Antes, a fixture mostrava "1, 2, atual, última"; foi corrigida.
- **Campo "Ir":** existe. É um `<input type="number" placeholder="Página" min="1" max="<última>">` com botão "Ir". **Não foi preenchido nem usado.** Ele exige aprovação arquitetural (digitação em campo).
- **Leitura sequencial:** 4 páginas, 120 itens, página ativa conferida em cada uma (1 a 4).
- **Saltos verificados:** 4→3, 3→1, 1→4 (oculta a partir da 1), 4→2 (oculta a partir da 4) e 2→1. Todos confirmados, com 1 a 3 cliques numéricos.

**CLI, opções 6 e 7** (pasta de 2º nível com 14 filhos; limites: profundidade 2, 5 pastas, 150 itens, 2 páginas por pasta):

| Etapa | Resultado |
|---|---|
| Opção 6, processo encerrado à força depois da 3ª pasta | checkpoint `running` íntegro, 16 pastas registradas, só pseudônimos e códigos; trava órfã deixada no disco |
| Menu seguinte | opção 7 oferecida (1 checkpoint válido; trava órfã reconhecida) |
| Opção 7, modo RÁPIDO, mesmos limites | modo exibido; pasta inicial e F3 relidas (2 inalteradas); F2 **reaproveitada sem reabrir**; resultado rotulado "NÃO REVALIDADO" |
| **Achado** | ao voltar de F3 (3º nível, **2 páginas lidas**) para a pasta inicial: `return-failed`. A execução foi interrompida sem novos cliques (falha fechada), e o checkpoint segue íntegro e retomável |
| Opção 7, modo VERIFICADO | **não executada**: a validação foi interrompida no comportamento inesperado, como determinado |

**Diagnóstico do achado (concluído):** a hipótese do histórico foi **refutada**: paginar não cria entrada no histórico, e o "voltar" leva ao pai. **Causa confirmada:** O AIR **mantém a página corrente ao voltar**. Numa pasta estável, confirmada pelo checkpoint, o pai estava antes na página 1, com 8 linhas e total 8. Depois de abrir uma subpasta, ir à página 2 e voltar uma vez, ele apareceu **sem página ativa, com 0 linhas e total 8**. Correção: antes de voltar, a subpasta é reposicionada na página em que foi aberta (página ativa e listagem conferidas). Depois da volta, o pai precisa estar na página em que foi lido e exibir linhas quando o total indica itens. Senão, a volta é recusada (`page-mismatch` ou `empty-listing`, categoria `navigation-failed`) e a execução para sem novos cliques. Uma listagem incomparável nunca é aceita como volta válida.

## Leitura recursiva (POC-01D, 29/10/2026)

**Algoritmo: DFS.** Sem montar URLs, cada deslocamento é um clique verificado: abrir uma subpasta ou voltar ao pai. Na DFS o caminho de navegação é a própria pilha, então cada pasta é aberta uma vez e cada volta é para o pai imediato. Isso mantém o histórico do navegador coerente com a pilha, o que importa porque a volta a partir do 3º nível usa a seta "voltar" do AIR. A recursão fica em `core` (sem Playwright), atrás da interface `TreeNavigator`.

**Status.** Cada pasta tem um `status` próprio (a leitura dos filhos diretos) e um `subtreeStatus` (ela e todos os descendentes): `complete`, `partial`, `failed` ou `skipped`. A execução só é `complete` se a pasta inicial tiver `subtreeStatus = complete`.

**Motivos de pendência:**
- `max-depth`, `max-folders`, `max-items`, `max-pages`: limite atingido;
- `unknown-items`: item de tipo desconhecido, que pode ser uma pasta;
- `homonym`: nome normalizado repetido na pasta; nada é clicado;
- `location-mismatch`: item com "Caminho" de outro ramo; não é aberto;
- `open-refused`: recusa antes do clique;
- `cycle`, `repeated-visit`: ciclo ou pasta já visitada;
- `navigation-lost`, `return-failed`: falha **depois** de um clique, que interrompe a execução inteira sem novos cliques;
- `run-aborted`: o restante da fila depois de uma interrupção.

**Reposicionamento.** Antes de abrir uma subpasta que está em outra página do pai, a ferramenta volta a essa página e exige que o conteúdo seja idêntico ao lido antes. Desde a POC-01E, isso funciona também com páginas escondidas pelas reticências: ela clica no número visível mais próximo abaixo da página e repete, confirmando a página ativa e a mudança da listagem a cada clique. No AIR real o paginador mostra a atual e as vizinhas (`[1][...][3][4][5][...][50]`), então os números bastam; "próxima" fica como alternativa para paginadores sem vizinhas. As reticências nunca são clicadas, e o campo "Ir" não é usado (ver Limitações). Loop, página ativa não identificada, conteúdo diferente ou excesso de passos interrompem a abertura (falha fechada). O scanner também passou a conferir a página ativa: ler a partir de uma página diferente da 1, ou um "próxima" que pule páginas, torna a leitura parcial (`page-mismatch`).

### Validação real

A instância contém dados sensíveis. Por isso a execução foi feita só com saída diagnóstica: nenhum nome foi exibido nem exportado.

| | |
|---|---|
| Pasta inicial | 2º nível, cerca de mil itens, dezenas de páginas de 30 |
| Limites aprovados | `maxDepth=2, maxFolders=6, maxItems=150, maxPagesPerFolder=2` |
| Resultado | **parcial**, sem interrupções: 3 pastas lidas, 150 itens (146 arquivos, 4 pastas) |
| Pendências | 2 subpastas não abertas (`max-items` e `location-mismatch`) |
| Navegação | 2 aberturas e 2 voltas verificadas; reposicionamento pela página "1" a partir da página 2 do pai; o navegador terminou na pasta inicial, página 1 |

Achados reais que viraram correção e teste de regressão:

- **"Caminho" de outro ramo.** Pastas reais listam itens cujo "Caminho" (e o `fullLocation` interno) aponta para outro ramo. Não são atalhos (`linked: false`). Encontrado em 2 de 2 pastas grandes examinadas. Esses itens não são abertos, e a pasta é confirmada pelas demais linhas. Para a pasta inicial, o caminho esperado vem do breadcrumb **não colapsado** (2º nível) ou do título (raiz). No 3º nível em diante, sem unanimidade, a leitura não começa.
- **Paginador com reticências.** Com muitas páginas, o paginador fica `[«][‹][1][2]<span>...</span>[N][›][»]`. O `<span>` fazia o paginador não ser reconhecido, e o "próxima" era recusado.

## Limitações conhecidas

Ainda **não validado** no AIR real:

- outros tipos de arquivo além de PDF (aceitos pelo padrão `<img alt="<tipo> icon">`, sem observação real);
- subpasta com **mais de uma página** (validada só em fixture; a paginação foi validada na raiz na POC-01B);
- descida ao 2º nível de recursão, porque o orçamento de itens acabou antes;
- volta ao pai com conteúdo do pai alterado durante a leitura: tratada pelo ADR-013 (`content-changed`), validada em fixture; validação real na seção "Validação no AIR real (POC-01E)";
- reposicionamento para página oculta **ao abrir uma subpasta** (validado na mesma pasta, por saltos entre páginas lidas, mas não antes de uma abertura real);
- retomada VERIFICADA no AIR real (validada só em fixture e simulação);
- o campo "Ir" (existe, mas não é usado sem aprovação). Sem ele, alcançar a página *k* custa até *k* cliques numéricos, sempre dentro de `maxPagesPerFolder`;
- homônimos na mesma página (a abertura é recusada; não há alternativa ainda);
- estabilidade do ID da URL como identificador de pasta;
- execução da opção 6 pela CLI interativa (a validação usou as mesmas funções por script).

Outras limitações:

- "Registros por página" variou entre sessões (30 e 50). A ferramenta não depende desse valor.
- O contador "X de N linhas(s) selecionadas" representa **só a página exibida**. Ele nunca é usado como total da pasta.
- Cliente e setor não têm seletor validado na UI: são informados pelo operador e não são confirmados pela ferramenta.
- A retomada relê desde a página 1 toda pasta em que entra (o checkpoint não guarda os nomes necessários para abrir pastas a partir de uma página intermediária).
- Na retomada RÁPIDA, mudanças dentro de subárvores reaproveitadas não são detectadas, e o resultado nunca é elegível para planejamento. Use a VERIFICADA.
- A retomada VERIFICADA custa o mesmo que uma leitura nova.
- A opção 2 lida a partir de uma página diferente da 1 fica parcial (`page-mismatch`): volte à página 1 antes de analisar.
- Os nomes dos diretórios em `output/` derivam do domínio e do setor (com hash). Eles ficam só no disco local e não são exibidos no console.
- Os títulos das abas são exibidos quando há mais de uma aba aberta no Chrome dedicado, para que você escolha a do AIR.
