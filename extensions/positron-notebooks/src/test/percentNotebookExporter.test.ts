/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { exportPercentScript } from '../percentNotebookExporter.js';

function mockCell(text: string, languageId: string, kind: 'code' | 'markup') {
	return {
		kind: kind === 'code' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
		document: {
			getText: () => text,
			languageId,
		},
	} as vscode.NotebookCell;
}

function mockNotebook(cells: ReturnType<typeof mockCell>[]) {
	return {
		getCells: () => cells,
	} as vscode.NotebookDocument;
}

suite('percentNotebookExporter', () => {
	let disposables: vscode.Disposable[] = [];

	teardown(() => {
		disposables.forEach(d => d.dispose());
		disposables = [];
		sinon.restore();
	});

	test('code cell', () => {
		const actual = exportPercentScript(mockNotebook([
			mockCell('print("Hello, world!")', 'python', 'code'),
		]));
		assert.strictEqual(actual, `# %%
print("Hello, world!")
`);
	});

	test('markdown cell', () => {
		const actual = exportPercentScript(mockNotebook([
			mockCell('# Heading\n\nContent', 'markdown', 'markup'),
		]));
		assert.strictEqual(actual, `# %% [markdown]
# # Heading
#
# Content
`);
	});

	test('raw cell', () => {
		const actual = exportPercentScript(mockNotebook([
			mockCell('---\ntitle: My Title\n---', 'raw', 'code'),
		]));
		assert.strictEqual(actual, `# %% [raw]
# ---
# title: My Title
# ---
`);
	});

	test('multiple cells of different types', () => {
		const actual = exportPercentScript(mockNotebook([
			mockCell('---\ntitle: My Title\n---', 'raw', 'code'),
			mockCell('# Heading\n\nContent', 'markdown', 'markup'),
			mockCell('print("Hello, world!")', 'python', 'code'),
		]));
		assert.strictEqual(actual, `# %% [raw]
# ---
# title: My Title
# ---

# %% [markdown]
# # Heading
#
# Content

# %%
print("Hello, world!")
`);
	});
});
