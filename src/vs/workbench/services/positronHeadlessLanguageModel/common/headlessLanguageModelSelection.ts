/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';
import { IModelDescriptor } from '../../../../platform/positronHeadlessLanguageModel/common/engine.js';
import { ModelSelection } from './headlessLanguageModelService.js';

/**
 * The fixed provider-priority policy (R3): Posit's own gateway first, then
 * direct-to-vendor APIs, then aggregators / compatibility endpoints. Lower is
 * preferred.
 */
function providerTier(providerId: string): number {
	switch (providerId) {
		case 'positai':
			return 0; // Posit's own gateway -- the first-party path.
		case 'anthropic':
		case 'openai':
		case 'gemini':
		case 'bedrock':
		case 'google-vertex':
		case 'deepseek':
		case 'snowflake-cortex':
		case 'ms-foundry':
			return 1; // direct-to-vendor
		default:
			return 2; // aggregators / compatibility / local (openrouter, openai-compatible, copilot, ollama, lmstudio)
	}
}

/**
 * Order models by the priority policy. Stable for equal tiers, so the order a
 * provider listed its models in is preserved within a tier.
 */
export function byPriority(models: readonly IModelDescriptor[]): IModelDescriptor[] {
	return models
		.map((model, index) => ({ model, index }))
		.sort((a, b) => (providerTier(a.model.providerId) - providerTier(b.model.providerId)) || (a.index - b.index))
		.map(entry => entry.model);
}

/**
 * Resolve a model selection (R2) against the available models, applying the
 * provider-priority policy (R3).
 *
 * An exact id returns precisely that model, or `undefined` if it is gone -- a
 * pinned model must not silently become a different one. A tier or pattern
 * selection, being best-effort, falls back to the highest-priority available
 * model when nothing matches (D2), so a background feature always lands a model
 * if any exists.
 *
 * `tierPatterns` is the configurable fast/cheap tier (R14), used when the
 * selection names a tier.
 */
export function selectModel(
	available: readonly IModelDescriptor[],
	selection: ModelSelection,
	tierPatterns: readonly string[],
): IModelDescriptor | undefined {
	const ordered = byPriority(available);
	if (hasKey(selection, { id: true })) {
		return ordered.find(model => model.id === selection.id); // exact: no fallback
	}
	const patterns = hasKey(selection, { patterns: true }) ? selection.patterns : tierPatterns;
	return matchPatterns(ordered, patterns) ?? ordered[0]; // tier/patterns: fall back to top-priority
}

/**
 * Try each pattern in order until one matches an available model (R2). For a
 * given pattern an exact id match wins over a substring match, so a pinned id
 * passed as a pattern resolves precisely. Matching is case-insensitive across
 * the model id and display name.
 */
function matchPatterns(ordered: readonly IModelDescriptor[], patterns: readonly string[]): IModelDescriptor | undefined {
	for (const pattern of patterns) {
		const needle = pattern.toLowerCase();
		const exact = ordered.find(model => model.id.toLowerCase() === needle);
		if (exact) {
			return exact;
		}
		const partial = ordered.find(model =>
			model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
		if (partial) {
			return partial;
		}
	}
	return undefined;
}
