import type { SettingsView } from '../../app/controller.js';
import type { SettingField } from '../../app/settings.js';
import { byId, call, el, showMessage } from './dom.js';

const FIELDS: Array<{ key: SettingField; label: string; help: string; type: 'text' | 'number' }> = [
  { key: 'instanceUrl', label: 'URL inicial do AIR', help: 'HTTPS, sem credenciais. Vazio = abre em branco e você navega no Chrome.', type: 'text' },
  { key: 'profileDir', label: 'Diretório do perfil do Chrome dedicado', help: 'Caminho absoluto, fora do repositório e do perfil pessoal. Vazio = padrão.', type: 'text' },
  { key: 'checkpointDir', label: 'Diretório dos checkpoints', help: 'Caminho absoluto, fora do repositório. Vazio = padrão. Checkpoints de outro diretório deixam de aparecer.', type: 'text' },
  { key: 'maxPages', label: 'Limite de páginas por análise de pasta', help: 'Padrão: 500.', type: 'number' },
  { key: 'pageTimeoutMs', label: 'Tempo máximo por página (ms)', help: 'Padrão: 15000.', type: 'number' },
  { key: 'retentionDays', label: 'Retenção dos checkpoints (dias)', help: 'Padrão: 7.', type: 'number' },
  { key: 'inventoryMaxAgeDays', label: 'Idade máxima do inventário para planejamento (dias)', help: 'Padrão: 7.', type: 'number' },
];

function render(view: SettingsView): void {
  byId('settings-fields').replaceChildren(
    ...FIELDS.map(({ key, label, help, type }) => {
      const locked = view.locked.includes(key);
      const input = el('input', { id: `setting-${key}`, type, value: String(view.values[key] ?? ''), disabled: locked, autocomplete: 'off' });
      return el('label', { class: 'field' }, label, input, el('span', { class: 'field-note' }, locked ? 'Definido por variável de ambiente; tem precedência.' : help), el('span', { id: `setting-error-${key}`, class: 'field-error' }));
    }),
  );
  const problem = byId('settings-problem');
  problem.hidden = !view.problem;
  problem.textContent = view.problem ?? '';
  byId('path-profile').textContent = view.paths.chromeProfile;
  byId('path-checkpoints').textContent = view.paths.checkpoints;
  byId('path-output').textContent = view.paths.output;
  byId('path-settings').textContent = view.file;
}

export function initSettings(): void {
  byId('settings-save').addEventListener('click', async () => {
    const values: Record<string, string> = {};
    for (const { key } of FIELDS) {
      const input = byId<HTMLInputElement>(`setting-${key}`);
      byId(`setting-error-${key}`).textContent = '';
      if (!input.disabled) values[key] = input.value.trim();
    }
    const view = await call('saveSettings', values, (error) => {
      for (const [key, message] of Object.entries(error.fields ?? {})) {
        const node = document.getElementById(`setting-error-${key}`);
        if (node) node.textContent = message ?? '';
      }
      showMessage('error', error.message);
    });
    if (view) {
      render(view);
      showMessage('ok', 'Configurações salvas.');
    }
  });
  void call('getSettings').then((view) => view && render(view));
}
