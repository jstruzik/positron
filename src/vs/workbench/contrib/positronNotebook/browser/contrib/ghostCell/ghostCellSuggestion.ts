/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { hasKey } from '../../../../../../base/common/types.js';
import { StreamingTagLexer } from '../../../../../common/positron/streamingTagLexer.js';
import {
	FastCheap,
	IHeadlessLanguageModelService,
	IStreamTextRequest,
	ModelSelection,
	UnavailableReason,
} from '../../../../../services/positronHeadlessLanguageModel/common/headlessLanguageModelService.js';

/**
 * The ghost-cell consumer. The headless LM service does not own prompts,
 * context, or parsing (PRD non-goal); this module builds the prompt and
 * context, drives the service's stream, parses the XML response, and maps the
 * outcome to the visible-vs-silent behavior the controller renders.
 */

/** System prompt preserved from the existing ghost-cell feature. */
export const GHOST_CELL_SYSTEM_PROMPT = `You are an AI assistant suggesting the next cell for a data science notebook in Positron. Your task is to analyze the just-executed cell and its output to suggest a single, focused next step.

## Guidelines

1. **Single Responsibility**: Each suggestion should do ONE thing. If you're tempted to chain multiple operations, pick the most valuable one.
2. **Be Actionable**: The suggested code should run immediately without modification
3. **Be Obvious**: Suggest the natural, low-friction next step - not a multi-step analysis pipeline
4. **Be Contextual**: Base your suggestion on what the user just executed and its results
5. **Use Available Variables**: When session variables are provided, reference actual variable names in your suggestion rather than guessing.

## Role Distinction

Ghost cell suggestions are for **quick, obvious next steps** that don't require discussion. Complex multi-step analyses, exploratory workflows, or anything that would benefit from user input belongs in the chat pane instead.

**Good for ghost cells:**
- A single inspection command (\`df.head()\`, \`df.describe()\`)
- One refinement to existing code
- A quick diagnostic after an error

**Too complex for ghost cells (use chat instead):**
- Multi-step data cleaning pipelines
- Comprehensive EDA workflows
- Building and evaluating models together

## Output Format

You MUST return only valid XML in the output, and nothing else. Use the following structure:

\`\`\`xml
<suggestion>
<explanation>Brief description of what this code does and why it's a logical next step (1-2 sentences)</explanation>
<code>
# Comment explaining the suggestion
your_code_here()
</code>
</suggestion>
\`\`\`

Remember: Return ONLY valid XML. Do not include any explanatory text, markdown formatting, or additional commentary outside the XML tags.`;

/** A snapshot of one notebook cell, gathered by the controller from the notebook. */
export interface IGhostCellSnapshot {
	readonly source: string;
	readonly language: string;
	readonly isCode: boolean;
	/** Combined text outputs (already extracted and truncated). */
	readonly outputs: string;
	readonly hasError: boolean;
}

/** A partial suggestion delivered while the response streams in. */
export interface IGhostCellPartial {
	readonly code?: string;
	readonly explanation?: string;
}

/** A runtime session variable, gathered by the controller from the variables service. */
export interface IGhostCellVariable {
	readonly name: string;
	readonly type: string;
}

/**
 * The result of a generation attempt, mapped to the controller's visible-vs-
 * silent behavior:
 * - `ready`: show the suggestion.
 * - `empty`: the model had nothing useful to add -- stay silent (PRD).
 * - `unavailable` / `error`: show the generic visible failure; log the cause.
 */
export type GhostCellOutcome =
	| { readonly kind: 'ready'; readonly code: string; readonly explanation: string; readonly language: string; readonly modelName: string; readonly usedFallback: boolean }
	| { readonly kind: 'empty' }
	| { readonly kind: 'unavailable'; readonly reason: UnavailableReason }
	| { readonly kind: 'error'; readonly message: string };

/** Map the consumer's stored model setting to a service model selection (R2). */
export function intentFromSetting(userValue: readonly string[] | undefined): ModelSelection {
	if (!userValue || userValue.length === 0) {
		return FastCheap;
	}
	if (userValue.length === 1) {
		return { id: userValue[0] };
	}
	return { patterns: userValue };
}

/**
 * Build the context message sent to the model: the same structure the existing
 * ghost-cell feature used (notebook context, the executed cell, its output, a
 * few previous cells, and the runtime session variables when available).
 */
export function buildGhostCellContext(
	cells: readonly IGhostCellSnapshot[],
	executedIndex: number,
	variables?: readonly IGhostCellVariable[],
	maxVariables: number = 20,
): string {
	const executed = cells[executedIndex];
	const parts: string[] = [];

	parts.push('## Notebook Context');
	parts.push(`- Language: ${executed.language}`);
	parts.push(`- Cell position: ${executedIndex + 1} of ${cells.length}`);
	parts.push(`- Status: ${executed.hasError ? 'Cell execution produced an error' : 'Cell executed successfully'}`);
	parts.push('');

	parts.push(`## Just Executed Cell (Cell ${executedIndex + 1})`);
	parts.push('```' + executed.language);
	parts.push(executed.source);
	parts.push('```');
	parts.push('');

	if (executed.outputs) {
		parts.push('## Cell Output');
		parts.push('```');
		parts.push(executed.outputs);
		parts.push('```');
		parts.push('');
	}

	const previousCount = Math.min(3, executedIndex);
	if (previousCount > 0) {
		parts.push(`## Previous Context (last ${previousCount} cells)`);
		for (let i = executedIndex - previousCount; i < executedIndex; i++) {
			const cell = cells[i];
			if (cell.isCode) {
				const truncated = cell.source.length > 200 ? cell.source.substring(0, 200) + '...' : cell.source;
				parts.push(`Cell ${i + 1}:`);
				parts.push('```' + cell.language);
				parts.push(truncated);
				parts.push('```');
			}
		}
	}

	const variablesBlock = variables ? selectAndFormatVariables(variables, maxVariables) : '';
	if (variablesBlock) {
		parts.push('');
		parts.push('## Session Variables');
		parts.push('Variables currently defined in the runtime (name|type):');
		parts.push('```');
		parts.push(variablesBlock);
		parts.push('```');
	}

	parts.push('');
	parts.push('Based on this context, suggest the most logical next cell for the user to execute.');

	return parts.join('\n');
}

/**
 * Rank a variable by how useful it is likely to be in a suggestion: tabular data
 * first, then collections, then scalars, then everything else. Used to keep the
 * most relevant variables when the list is capped.
 */
function getVariablePriority(type: string): number {
	const t = type.toLowerCase();

	const tableTypes = ['dataframe', 'data.frame', 'tibble', 'series', 'matrix', 'array', 'ndarray'];
	if (tableTypes.some(tt => t.includes(tt))) {
		return 1;
	}

	const collectionTypes = ['list', 'dict', 'set', 'tuple', 'vector', 'environment'];
	if (collectionTypes.some(ct => t.includes(ct))) {
		return 2;
	}

	const scalarTypes = ['int', 'float', 'str', 'bool', 'numeric', 'character', 'logical', 'complex', 'double'];
	if (scalarTypes.some(st => t.includes(st))) {
		return 3;
	}

	return 4;
}

/** Sort variables by priority, cap at `maxCount`, and format as `name|type` lines. */
function selectAndFormatVariables(variables: readonly IGhostCellVariable[], maxCount: number): string {
	if (variables.length === 0) {
		return '';
	}
	const sorted = [...variables].sort((a, b) => getVariablePriority(a.type) - getVariablePriority(b.type));
	return sorted.slice(0, maxCount).map(v => `${v.name}|${v.type}`).join('\n');
}

/**
 * Generate a ghost-cell suggestion through the headless LM service, parsing the
 * streamed XML and reporting partials. Returns a {@link GhostCellOutcome}.
 *
 * Implements consumer-side fallback (the service has no fallback concept): if a
 * pinned exact model is not available, retry with the default tier and flag it.
 */
export async function generateGhostCellSuggestion(
	service: IHeadlessLanguageModelService,
	request: IStreamTextRequest,
	language: string,
	token: CancellationToken,
	onProgress: (partial: IGhostCellPartial) => void,
): Promise<GhostCellOutcome> {
	let result = await service.streamText({ ...request, cancellationToken: token });

	// A pinned model that is not available falls back to the default tier.
	let usedFallback = false;
	if (!result.available && result.reason === 'no-model-matched' && request.model && hasKey(request.model, { id: true })) {
		usedFallback = true;
		result = await service.streamText({ ...request, model: FastCheap, cancellationToken: token });
	}

	if (!result.available) {
		return { kind: 'unavailable', reason: result.reason };
	}

	try {
		const suggestion = await parseGhostCellSuggestion(result.text, onProgress, token);
		if (!suggestion) {
			return { kind: 'empty' };
		}
		return {
			kind: 'ready',
			code: suggestion.code,
			explanation: suggestion.explanation || 'Suggested next step',
			language,
			modelName: result.model.name,
			usedFallback,
		};
	} catch (error) {
		return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Parse the streamed XML suggestion, reporting partial explanation/code as it
 * arrives. Returns the suggestion, or `undefined` if no code was produced (a
 * benign empty response). Throws if the stream itself fails.
 *
 * Drives the shared {@link StreamingTagLexer} over the `<suggestion>` schema's
 * `explanation` and `code` fields. Text outside a recognized field -- markdown
 * fences or prose around the XML -- is dropped because no field is active, and
 * a stray `<` inside code arrives as separate text chunks that concatenate
 * losslessly. Attributes on the tags (e.g. `<code language="python">`) are
 * tolerated and ignored; `language` is caller-supplied, never read from the XML.
 *
 * Code streams partial on each text chunk inside `<code>`; explanation emits
 * once it closes. Each emit is a combined `{ explanation, code }` snapshot of
 * the running values.
 */
export async function parseGhostCellSuggestion(
	text: AsyncIterable<string>,
	onProgress: (partial: IGhostCellPartial) => void,
	token: CancellationToken,
): Promise<{ code: string; explanation: string } | undefined> {
	let explanation = '';
	let code = '';
	let currentField: 'explanation' | 'code' | null = null;
	let currentFieldContent = '';

	const emitProgress = () => onProgress({ explanation: explanation || undefined, code: code || undefined });

	const lexer = new StreamingTagLexer({
		tagNames: ['suggestion', 'explanation', 'code'],
		contentHandler: chunk => {
			if (chunk.type === 'tag') {
				if (chunk.name === 'explanation' || chunk.name === 'code') {
					if (chunk.kind === 'open') {
						currentField = chunk.name;
						currentFieldContent = '';
					} else if (chunk.kind === 'close' && currentField) {
						if (currentField === 'explanation') {
							explanation = currentFieldContent.trim();
						} else if (currentField === 'code') {
							code = currentFieldContent.trim();
						}
						emitProgress();
						currentField = null;
						currentFieldContent = '';
					}
				}
			} else if (currentField) {
				currentFieldContent += chunk.text;
				if (currentField === 'code') {
					code = currentFieldContent.trim();
					emitProgress();
				}
			}
		},
	});

	for await (const chunk of text) {
		if (token.isCancellationRequested) {
			return undefined;
		}
		await lexer.process(chunk);
	}
	await lexer.flush();

	if (!code.trim()) {
		return undefined;
	}
	return { code: code.trim(), explanation: explanation.trim() };
}
