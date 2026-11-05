'use strict';

// The Laws view in the Explorer: every law and every uncovered function, grouped by status with the failing ones on top,
// each with its file and the time of its last run. A click reveals the law (or the function). `vscode` is passed in.

const { ageText } = require('./live-status.js');
const { inputsText, oneLine } = require('./format.js');

/** Groups, in the order shown: the ones that need a person first. */
const GROUPS = [
  ['failed', 'Failing'],
  ['open', 'Open'],
  ['tampered', 'Tampered'],
  ['error', 'Cannot run'],
  ['uncovered', 'Uncovered functions'],
  ['bounded', 'Bounded'],
  ['tested', 'Tested'],
  ['proved', 'Proved'],
];

/**
 * @param {object[] | null} records
 * @param {{ranAt: Map<string, number>, now: number, paramsOf: (file: string, name: string) => string[]}} o
 * @returns {{id: string, status: string, label: string, children: {id: string, status: string, name: string, file: string, line: number, description: string, tooltip: string}[]}[]}
 */
function buildTree(records, { ranAt, now, paramsOf }) {
  const by = new Map();
  for (const r of records ?? []) {
    if (!by.has(r.status)) by.set(r.status, []);
    by.get(r.status).push(r);
  }
  const known = new Set(GROUPS.map(([s]) => s));
  const order = [...GROUPS, ...[...by.keys()].filter((s) => !known.has(s)).map((s) => [s, s])];
  const out = [];
  for (const [status, title] of order) {
    const list = by.get(status);
    if (list === undefined || list.length === 0) continue;
    const children = [...list]
      .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
      .map((r) => {
        const at = ranAt.get(`${r.file}::${r.name}`);
        const inputs = inputsText(r.counterexample, paramsOf(r.file, r.name));
        const detail = inputs !== undefined ? `counterexample ${inputs}` : oneLine(r.message ?? '');
        return {
          id: `${status}:${r.file}::${r.name}`,
          status,
          name: r.name,
          file: r.file,
          line: r.line,
          description: `${r.file}${at === undefined ? '' : ` · ${ageText(now - at)}`}`,
          tooltip: [`${r.name}: ${status}`, detail].filter((s) => s !== '').join('\n'),
        };
      });
    out.push({ id: `group:${status}`, status, label: `${title} (${children.length})`, children });
  }
  return out;
}

const ICONS = {
  failed: ['error', 'testing.iconFailed'],
  open: ['warning', 'list.warningForeground'],
  tampered: ['warning', 'list.warningForeground'],
  error: ['error', 'testing.iconErrored'],
  uncovered: ['circle-outline', 'descriptionForeground'],
  proved: ['pass', 'testing.iconPassed'],
  bounded: ['pass', 'testing.iconPassed'],
  tested: ['pass', 'testing.iconPassed'],
};

/**
 * @param {typeof import('vscode')} vscode
 * @param {{
 *   records: () => object[] | null, ranAt: () => Map<string, number>, now: () => number,
 *   paramsOf: (file: string, name: string) => string[],
 * }} host
 */
function createLawsTree(vscode, host) {
  const changed = new vscode.EventEmitter();
  const tree = () => buildTree(host.records(), { ranAt: host.ranAt(), now: host.now(), paramsOf: host.paramsOf });
  const icon = (status) => {
    const [id, colour] = ICONS[status] ?? ['circle-outline', 'descriptionForeground'];
    return new vscode.ThemeIcon(id, new vscode.ThemeColor(colour));
  };
  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem(node) {
      if (node.children !== undefined) {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.iconPath = icon(node.status);
        item.contextValue = 'tslawsGroup';
        return item;
      }
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.iconPath = icon(node.status);
      item.contextValue = node.status === 'uncovered' ? 'tslawsFunction' : 'tslawsLaw';
      item.command =
        node.status === 'uncovered'
          ? {
              title: 'Go to the function',
              command: 'tslaws.openFunction',
              arguments: [node.file, node.name, node.line],
            }
          : { title: 'Go to the law', command: 'tslaws.openLaw', arguments: [node.file, node.name] };
      return item;
    },
    getChildren(node) {
      return node === undefined ? tree() : (node.children ?? []);
    },
  };
  const view = vscode.window.createTreeView('tslawsLaws', { treeDataProvider: provider, showCollapseAll: true });
  return {
    provider,
    view,
    refresh: () => changed.fire(undefined),
    /** Text for the view's description line, e.g. `1 failing`. */
    setSummary(text) {
      view.description = text;
    },
    disposables: [changed, view],
  };
}

module.exports = { createLawsTree, buildTree, GROUPS };
