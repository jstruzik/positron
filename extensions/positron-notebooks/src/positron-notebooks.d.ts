/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface NotebookExporter {
	label: string;
	supportedLanguageId?: string;
	fileExtension: string;
	export(notebook: vscode.NotebookDocument): Promise<unknown>;
}

export interface PositronNotebooksExtension {
	registerNotebookExporter(exporter: NotebookExporter): vscode.Disposable;
}
