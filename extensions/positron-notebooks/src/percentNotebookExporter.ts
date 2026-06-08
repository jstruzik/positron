/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { NotebookExporter } from './positron-notebooks.js';

abstract class PercentNotebookExporter implements Partial<NotebookExporter> {
	abstract supportedLanguageId: string;

	async export(notebook: vscode.NotebookDocument): Promise<void> {
		const content = exportPercentScript(notebook);
		const doc = await vscode.workspace.openTextDocument({
			content,
			language: this.supportedLanguageId
		});
		await vscode.window.showTextDocument(doc);
	}
}

export class RPercentNotebookExporter extends PercentNotebookExporter implements NotebookExporter {
	label = 'R';
	supportedLanguageId = 'r';
	fileExtension = '.R';
}

export class PythonPercentNotebookExporter extends PercentNotebookExporter implements NotebookExporter {
	label = 'Python';
	supportedLanguageId = 'python';
	fileExtension = '.py';
}

function commentLines(text: string): string {
	return text
		.split('\n')
		.map((line) => (line.length > 0 ? `# ${line}` : '#'))
		.join('\n');
}

export function exportPercentScript(notebook: vscode.NotebookDocument): string {
	const parts: string[] = [];
	for (const cell of notebook.getCells()) {
		const text = cell.document.getText();
		if (cell.kind === vscode.NotebookCellKind.Markup) {
			const commented = commentLines(text);
			parts.push(`# %% [markdown]\n${commented}`);
		} else if (
			cell.kind === vscode.NotebookCellKind.Code &&
			cell.document.languageId === 'raw'
		) {
			const commented = commentLines(text);
			parts.push(`# %% [raw]\n${commented}`);
		} else {
			parts.push(`# %%\n${text}`);
		}
	}

	return parts.join('\n\n') + '\n';
}
