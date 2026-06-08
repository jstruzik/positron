/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PositronNotebooksExtensionImpl } from './api.js';
import { PythonPercentNotebookExporter, RPercentNotebookExporter } from './percentNotebookExporter.js';
import { Command } from './types.js';

export function registerNotebookExport(api: PositronNotebooksExtensionImpl): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	const outputChannel = vscode.window.createOutputChannel('Notebook Export', { log: true });
	outputChannel.info('Activating notebook export');
	disposables.push(outputChannel);

	disposables.push(
		vscode.commands.registerCommand(Command.ExportNotebook, runWithNotebook(async (notebook) => {
			if (!notebook) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('No active notebook to export.')
				);
				return;
			}

			const notebookLanguage = getNotebookLanguage(notebook);
			const items: NotebookExporterQuickPickItem[] = [];
			for (const exporter of api.notebookExporters) {
				if (!exporter.supportedLanguageId ||
					!notebookLanguage ||
					exporter.supportedLanguageId === notebookLanguage) {
					items.push({
						label: exporter.label,
						description: `(${exporter.fileExtension})`,
						iconPath: vscode.ThemeIcon.File,
						resourceUri: vscode.Uri.file(`.${exporter.fileExtension}`),
						export: async () => {
							await exporter.export(notebook);
						}
					});
				} else {
					outputChannel.debug(
						`Skipping exporter ${exporter.label} ` +
						`for notebook ${notebook.uri.toString()} ` +
						`due to unsupported language. ` +
						`Exporter supports ${exporter.supportedLanguageId}, ` +
						`notebook language is ${notebookLanguage ?? 'unknown'}.`
					);
				}
			}
			items.sort((a, b) => a.label.localeCompare(b.label));
			const item = await vscode.window.showQuickPick(items);
			await item?.export();
		}))
	)

	// Register builtin percent exporters for Python and R.
	disposables.push(api.registerNotebookExporter(new PythonPercentNotebookExporter()));
	disposables.push(api.registerNotebookExporter(new RPercentNotebookExporter()));

	outputChannel.info('Activated notebook export');

	return disposables;
}



/**
 * Run a command callback with an optional resource argument.
 * @param run The callback to run.
 * @returns A command callback that can be registered with {@link vscode.commands.registerCommand}.
 */
function runWithResource<T>(
	run: (resource: vscode.Uri | undefined) => Promise<T>,
): () => Promise<T> {
	return (...args: unknown[]) => {
		let resource: vscode.Uri | undefined;
		if (args[0] instanceof vscode.Uri) {
			resource = args[0];
		}
		return run(resource);
	};
}

/**
 * Run a command callback with an optional notebook argument,
 * defaulting to the active notebook.
 * @param run The callback to run.
 * @returns A command callback that can be registered with {@link vscode.commands.registerCommand}.
 */
function runWithNotebook<T>(
	run: (notebook: vscode.NotebookDocument | undefined) => Promise<T>,
): () => Promise<T | undefined> {
	return runWithResource(async (resource) => {
		let notebook: vscode.NotebookDocument | undefined;
		if (resource) {
			const resourceStr = resource.toString();
			notebook = vscode.workspace.notebookDocuments.find(doc => doc.uri.toString() === resourceStr);
		} else {
			notebook = vscode.window.activeNotebookEditor?.notebook;
		}
		return await run(notebook);
	});
}

function getNotebookLanguage(notebook: vscode.NotebookDocument): string | undefined {
	// First try the notebook metadata.
	// eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
	const metadata = notebook.metadata?.metadata as any;
	const languageId = metadata?.language_info?.name ?? metadata?.kernelspec?.language;
	if (languageId &&
		languageId !== 'raw' &&
		languageId !== 'plaintext'
	) {
		return languageId;
	}

	// Fall back to the first cell's language, if available.
	for (const cell of notebook.getCells()) {
		if (cell.kind === vscode.NotebookCellKind.Code &&
			cell.document.languageId !== 'raw' &&
			cell.document.languageId !== 'plaintext') {
			return cell.document.languageId;
		}
	}

	// Could not determine the notebook's language.
	return undefined;
}

interface NotebookExporterQuickPickItem extends vscode.QuickPickItem {
	export: () => Promise<void>;
}
