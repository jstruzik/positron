/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { NotebookExporter, PositronNotebooksExtension } from './positron-notebooks.js';

export class PositronNotebooksExtensionImpl implements PositronNotebooksExtension {
	private _notebookExporters: NotebookExporter[] = [];

	get notebookExporters(): NotebookExporter[] {
		return this._notebookExporters;
	}

	registerNotebookExporter(exporter: NotebookExporter): vscode.Disposable {
		this._notebookExporters.push(exporter);
		return {
			dispose: () => {
				const index = this._notebookExporters.indexOf(exporter);
				if (index !== -1) {
					this._notebookExporters.splice(index, 1);
				}
			}
		};
	}
}
