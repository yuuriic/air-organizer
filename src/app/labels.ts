import { UNSIGNED_INVENTORY_MESSAGE, type IntegrityAssessment } from '../core/inventory-integrity.js';
import type { KeyUnavailable } from '../storage/integrity-key.js';
import type { CheckpointState } from '../core/checkpoint.js';
import type { Inventory, ResumeMode, TreeLimits, TreeResult } from '../types/inventory.js';

/** Textos de resultado compartilhados pela CLI e pelo aplicativo. Nunca contêm nomes, caminhos nem URLs. */

export const STATUS_LABEL: Record<CheckpointState, string> = { running: 'EXECUTANDO', complete: 'CONCLUÍDO', partial: 'PARCIAL', failed: 'INTERROMPIDO' };
export const MODE_LABEL: Record<ResumeMode, string> = { verified: 'VERIFICADA', fast: 'RÁPIDA (conteúdo interno não revalidado)' };
export const COMPLETENESS_LABEL = { complete: 'COMPLETA', partial: 'PARCIAL', failed: 'INTERROMPIDA' } as const;

export const ELIGIBILITY_LABEL = {
  'planning-eligible': 'ELEGÍVEL para planejamento: selo autenticado, leitura completa, revalidada, sem divergência e recente. Não autoriza movimentação; os achados continuam exigindo revisão humana.',
  exploratory: 'EXPLORATÓRIO: os achados servem para exploração e NÃO podem fundamentar planos operacionais.',
  rejected: 'RECUSADO: inventário inconsistente, adulterado ou ilegível; nenhum achado foi produzido.',
} as const;

const KEY_UNAVAILABLE_LABEL: Record<KeyUnavailable, string> = {
  missing: 'chave local ausente',
  invalid: 'chave local inválida ou em local não permitido',
  unreadable: 'chave local ilegível',
};

export function integrityLabel(report: { integrity: IntegrityAssessment }, key: KeyUnavailable | undefined): string {
  const i = report.integrity;
  if (i.status === 'authenticated') return 'AUTENTICADA: gravado por esta instalação e inalterado desde então (não quer dizer que o AIR ainda esteja igual).';
  if (i.status === 'unsigned') return `${UNSIGNED_INVENTORY_MESSAGE} Utilizável só para exploração.`;
  if (i.status === 'unverifiable') return `NÃO VERIFICÁVEL (${key ? KEY_UNAVAILABLE_LABEL[key] : 'chave local indisponível'}): utilizável só para exploração.`;
  return 'INVÁLIDA: selo não confere; o inventário é recusado.';
}

const REASON_LABEL: Record<string, string> = {
  'integrity-unsigned': 'Inventário sem selo de integridade.',
  'integrity-unverifiable': 'Selo não verificável: chave local indisponível.',
  'legacy-format': 'Inventário em formato antigo.',
  'status-partial': 'Leitura parcial.',
  'status-failed': 'Leitura interrompida.',
  aborted: 'Leitura interrompida por falha de navegação.',
  'fast-resume': 'Retomada RÁPIDA: conteúdo interno não revalidado.',
  'reused-folders': 'Há pastas reaproveitadas sem releitura.',
  'content-changed': 'Conteúdo divergente observado durante a leitura.',
  'not-eligible-for-planning': 'A própria leitura não se declarou elegível para planejamento.',
  stale: 'Inventário antigo demais.',
};

/** Motivo de elegibilidade legível; outros motivos (já em português e sem nomes) passam como estão. */
export const reasonLabel = (reason: string): string => REASON_LABEL[reason] ?? reason;

export const describeLimits = (l: TreeLimits) =>
  `profundidade ${l.maxDepth}, ${l.maxFolders} pasta(s), ${l.maxItems} itens, ${l.maxPagesPerFolder} página(s) por pasta`;

/** Cobertura da leitura de uma pasta. As mensagens dos problemas podem citar nomes e ficam só no inventário detalhado. */
export function coverageLines(inventory: Inventory): string[] {
  const c = inventory.coverage;
  const kinds = inventory.items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});
  return [
    `  Páginas lidas:      ${c.pagesRead}${c.expectedPages !== undefined ? ` de ~${c.expectedPages} (estimado)` : ''}`,
    `  Itens únicos:       ${c.uniqueItems} (observações: ${c.itemsObserved}, repetidas: ${c.repeatedObservations})`,
    `  Total da pasta:     ${c.reportedTotal ?? 'não identificado'} (título)`,
    `  Páginas não lidas:  ${c.unreadPages.length ? c.unreadPages.join(', ') : 'nenhuma conhecida'}`,
    `  Encerramento:       ${c.stopReason}`,
    `  Status:             ${c.complete ? 'COMPLETA' : 'PARCIAL'}`,
    ...c.issues.map((issue) => `  ! [${issue.kind}]${issue.pageNumber !== undefined ? ` página ${issue.pageNumber}` : ''}`),
    `  Tipos:              ${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(', ') || '-'}`,
  ];
}

/** Resumo de uma leitura recursiva, sem dados identificáveis. `resumeHint` diz onde retomar. */
export function treeSummaryLines(result: TreeResult, limits: TreeLimits, checkpointFailures: number, resumeHint: string): string[] {
  const lines: string[] = [];
  const t = result.totals;
  lines.push(`  Pastas analisadas: ${t.foldersRead}; com pendência na subárvore: ${t.foldersPending}`);
  lines.push(`  Itens: ${t.items} (pastas ${t.folders}, arquivos ${t.files}, desconhecidos ${t.unknown}); páginas lidas: ${t.pagesRead}`);
  lines.push(`  Limites utilizados: ${describeLimits(limits)}`);
  if (result.stopped) lines.push('  Interrompida a seu pedido: o que não foi lido ficou pendente, e a leitura NÃO conta como completa.');
  if (result.limitsReached.length) lines.push(`  Limites atingidos: ${result.limitsReached.join(', ')}`);
  const pendingReasons = [...new Set(result.folders.flatMap((f) => f.reasons))];
  if (pendingReasons.length) lines.push(`  Pendências: ${pendingReasons.join(', ')}`);
  if (result.resume) {
    const r = result.resume;
    lines.push(`  Modo de retomada: ${MODE_LABEL[r.mode]}`);
    lines.push(`  Comparação com o checkpoint (pastas relidas agora): ${r.unchanged} inalterada(s), ${r.changed} alterada(s), ${r.new} nova(s), ${r.removed} removida(s)`);
    if (r.reusedFolders > 0) {
      lines.push(`  Reaproveitadas SEM revalidar o conteúdo: ${r.reusedFolders} pasta(s), observadas a partir de ${r.oldestReusedObservation ?? '?'}.`);
      lines.push('    (só a linha delas no pai foi conferida; mudanças DENTRO delas desde então não são detectadas)');
    }
  }
  const nv = result.navigation;
  lines.push(`  Diagnósticos de navegação: content-changed ${nv.contentChanged} · identity-mismatch ${nv.identityMismatch} · navigation-failed ${nv.navigationFailed}`);
  if (nv.contentChanged > 0) {
    lines.push('    content-changed: ao voltar, a identidade da pasta foi confirmada, mas o total ou a listagem divergiu do lido antes.');
    lines.push('    É uma divergência OBSERVADA, não a sua causa. A pasta e os ancestrais não ficam completos; subpastas ainda não abertas ficaram pendentes.');
  }
  // Nunca apresentar o modo rápido como equivalente ao verificado.
  lines.push(
    result.verification.eligibleForPlanning
      ? '  Verificação: todo o conteúdo contado foi lido nesta sessão; resultado completo, utilizável como base para planejamento (POC-02).'
      : result.verification.contentRevalidated
        ? '  Verificação: conteúdo lido nesta sessão, mas o resultado não está completo; NÃO serve como base para planejamento.'
        : '  Verificação: NÃO REVALIDADO. Há pastas reaproveitadas sem releitura; NÃO usar como inventário atualizado e verificado para planejar movimentações. Use a retomada VERIFICADA.',
  );
  lines.push('  (Nenhum modo garante consistência transacional: o AIR pode ter mudado durante a própria leitura.)');
  if (result.abort) {
    lines.push(`  !! Interrompida em ${result.abort.atRef} (${result.abort.reason}). Nenhum clique foi feito depois disso.`);
    const d = result.abort.diagnostic;
    if (d) {
      const c = d.checks;
      const conds = c?.conditions ? Object.entries(c.conditions).map(([k, v]) => `${k}=${v ? 'sim' : 'NÃO'}`).join(', ') : 'nenhuma leitura completa';
      const fails = c ? Object.entries(c.readFailures).map(([k, n]) => `${k}×${n}`).join(', ') || 'nenhuma' : '-';
      lines.push(`     Verificação que falhou: ${d.category ?? 'navigation-failed'} / ${d.code}${c ? `; ${c.observations} leitura(s); condições na última: ${conds}; leituras com falha: ${fails}; instável: ${c.unstable}` : ''}`);
    }
    lines.push('     Verifique no Chrome qual pasta está exibida antes de continuar.');
  }
  lines.push(
    checkpointFailures > 0
      ? `  Checkpoint: ${checkpointFailures} gravação(ões) falharam; o arquivo guarda o último estado gravado com sucesso.`
      : result.status === 'complete'
        ? '  Checkpoint: execução concluída; não será oferecida para retomada.'
        : `  Checkpoint gravado: ${resumeHint} retoma esta execução a partir da mesma pasta inicial.`,
  );
  return lines;
}
