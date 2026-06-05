/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types="vitest/globals" />

import { AsyncIterableObject } from '../../../../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../../../base/common/event.js';
import { IHeadlessLanguageModelService, IStreamTextRequest, StreamTextResult } from '../../../../../../../services/positronHeadlessLanguageModel/common/headlessLanguageModelService.js';
import {
	IGhostCellSnapshot,
	buildGhostCellContext,
	generateGhostCellSuggestion,
	intentFromSetting,
	parseGhostCellSuggestion,
} from '../../ghostCellSuggestion.js';

const VALID_XML = '<suggestion><explanation>Inspect it</explanation><code>df.head()</code></suggestion>';

function fakeService(...results: StreamTextResult[]): IHeadlessLanguageModelService {
	let index = 0;
	return {
		_serviceBrand: undefined,
		streamText: async () => results[Math.min(index++, results.length - 1)],
		getAvailableModels: async () => [],
		onDidChangeAvailableModels: Event.None,
	};
}

function requestWith(model?: IStreamTextRequest['model']): IStreamTextRequest {
	return { systemPrompt: 's', messages: [{ role: 'user', content: 'c' }], model };
}

const noop = () => { };

describe('intentFromSetting (R2)', () => {
	it('maps an unset or empty value to the default fast/cheap tier', () => {
		expect(intentFromSetting(undefined)).toEqual({ tier: 'fast-cheap' });
		expect(intentFromSetting([])).toEqual({ tier: 'fast-cheap' });
	});

	it('maps a single pinned id to an exact id selection', () => {
		expect(intentFromSetting(['claude-haiku'])).toEqual({ id: 'claude-haiku' });
	});

	it('maps multiple entries to ordered patterns', () => {
		expect(intentFromSetting(['haiku', 'mini'])).toEqual({ patterns: ['haiku', 'mini'] });
	});
});

describe('parseGhostCellSuggestion', () => {
	it('parses explanation and code from the streamed XML', async () => {
		const onProgress = vi.fn();
		const result = await parseGhostCellSuggestion(AsyncIterableObject.fromArray([VALID_XML]), onProgress, CancellationToken.None);
		expect(result).toEqual({ code: 'df.head()', explanation: 'Inspect it' });
		expect(onProgress).toHaveBeenCalled();
	});

	it('streams partial code across chunk boundaries', async () => {
		const onProgress = vi.fn();
		const chunks = ['<explanation>Hi</explanation><code>df.', 'head()</code>'];
		const result = await parseGhostCellSuggestion(AsyncIterableObject.fromArray(chunks), onProgress, CancellationToken.None);
		expect(result?.code).toBe('df.head()');
		// A partial code update was reported before the closing tag arrived.
		expect(onProgress.mock.calls.some(([partial]) => partial.code === 'df.')).toBe(true);
	});

	it('returns undefined when no code is produced (benign empty)', async () => {
		const result = await parseGhostCellSuggestion(AsyncIterableObject.fromArray(['<explanation>nothing useful</explanation>']), noop, CancellationToken.None);
		expect(result).toBeUndefined();
	});

	it('keeps code that contains angle-bracket operators intact', async () => {
		const xml = '<suggestion><explanation>Guard</explanation><code>if x < 5:\n    pass</code></suggestion>';
		const result = await parseGhostCellSuggestion(AsyncIterableObject.fromArray([xml]), noop, CancellationToken.None);
		expect(result?.code).toBe('if x < 5:\n    pass');
	});

	it('parses XML wrapped in a markdown code fence', async () => {
		const fenced = '```xml\n' + VALID_XML + '\n```';
		const result = await parseGhostCellSuggestion(AsyncIterableObject.fromArray([fenced]), noop, CancellationToken.None);
		expect(result).toEqual({ code: 'df.head()', explanation: 'Inspect it' });
	});

	it('drops prose surrounding a fenced suggestion', async () => {
		const wrapped = 'Here is the next step:\n\n```xml\n' + VALID_XML + '\n```\n\nLet me know if that helps.';
		const result = await parseGhostCellSuggestion(AsyncIterableObject.fromArray([wrapped]), noop, CancellationToken.None);
		expect(result).toEqual({ code: 'df.head()', explanation: 'Inspect it' });
	});

	it('tolerates attributes on the code tag', async () => {
		const xml = '<suggestion><explanation>Inspect</explanation><code language="python">df.head()</code></suggestion>';
		const result = await parseGhostCellSuggestion(AsyncIterableObject.fromArray([xml]), noop, CancellationToken.None);
		expect(result?.code).toBe('df.head()');
	});
});

describe('generateGhostCellSuggestion (failure-to-UX mapping)', () => {
	it('maps an unavailable result to a typed unavailable outcome', async () => {
		const service = fakeService({ available: false, reason: 'sign-in-required' });
		const outcome = await generateGhostCellSuggestion(service, requestWith(), 'python', CancellationToken.None, noop);
		expect(outcome).toEqual({ kind: 'unavailable', reason: 'sign-in-required' });
	});

	it('maps a streamed suggestion to a ready outcome with the model name', async () => {
		const service = fakeService({ available: true, model: { id: 'm', name: 'Haiku' }, text: AsyncIterableObject.fromArray([VALID_XML]) });
		const outcome = await generateGhostCellSuggestion(service, requestWith(), 'python', CancellationToken.None, noop);
		expect(outcome).toEqual({ kind: 'ready', code: 'df.head()', explanation: 'Inspect it', language: 'python', modelName: 'Haiku', usedFallback: false });
	});

	it('maps a benign empty response to a silent empty outcome', async () => {
		const service = fakeService({ available: true, model: { id: 'm', name: 'Haiku' }, text: AsyncIterableObject.fromArray(['<explanation>nothing</explanation>']) });
		const outcome = await generateGhostCellSuggestion(service, requestWith(), 'python', CancellationToken.None, noop);
		expect(outcome).toEqual({ kind: 'empty' });
	});

	it('maps a mid-stream failure to an error outcome', async () => {
		const throwing: AsyncIterable<string> = {
			[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('provider unreachable')) }),
		};
		const service = fakeService({ available: true, model: { id: 'm', name: 'Haiku' }, text: throwing });
		const outcome = await generateGhostCellSuggestion(service, requestWith(), 'python', CancellationToken.None, noop);
		expect(outcome).toEqual({ kind: 'error', message: 'provider unreachable' });
	});

	it('falls back from a pinned model to the default tier, flagging it', async () => {
		const service = fakeService(
			{ available: false, reason: 'no-model-matched' },
			{ available: true, model: { id: 'd', name: 'Default' }, text: AsyncIterableObject.fromArray([VALID_XML]) },
		);
		const outcome = await generateGhostCellSuggestion(service, requestWith({ id: 'pinned' }), 'python', CancellationToken.None, noop);
		expect(outcome).toEqual({ kind: 'ready', code: 'df.head()', explanation: 'Inspect it', language: 'python', modelName: 'Default', usedFallback: true });
	});
});

describe('buildGhostCellContext', () => {
	it('includes the executed cell, its output, and prior cells', () => {
		const cells: IGhostCellSnapshot[] = [
			{ source: 'import pandas as pd', language: 'python', isCode: true, outputs: '', hasError: false },
			{ source: 'df = pd.read_csv("x.csv")', language: 'python', isCode: true, outputs: 'loaded', hasError: false },
		];
		const context = buildGhostCellContext(cells, 1);
		expect(context).toContain('## Just Executed Cell (Cell 2)');
		expect(context).toContain('df = pd.read_csv("x.csv")');
		expect(context).toContain('## Cell Output');
		expect(context).toContain('loaded');
		expect(context).toContain('## Previous Context');
		expect(context).toContain('import pandas as pd');
	});

	const oneCell: IGhostCellSnapshot[] = [
		{ source: 'df = load()', language: 'python', isCode: true, outputs: '', hasError: false },
	];

	it('renders session variables, prioritized and capped at maxVariables', () => {
		const variables = [
			{ name: 'n', type: 'int' },          // priority 3
			{ name: 'df', type: 'DataFrame' },    // priority 1
			{ name: 'items', type: 'list' },      // priority 2
		];
		const context = buildGhostCellContext(oneCell, 0, variables, 2);
		expect(context).toContain('## Session Variables');
		// DataFrame and list outrank the scalar; the cap of 2 drops the int.
		expect(context).toContain('df|DataFrame');
		expect(context).toContain('items|list');
		expect(context).not.toContain('n|int');
	});

	it('omits the session variables block when none are provided', () => {
		expect(buildGhostCellContext(oneCell, 0)).not.toContain('## Session Variables');
	});
});
