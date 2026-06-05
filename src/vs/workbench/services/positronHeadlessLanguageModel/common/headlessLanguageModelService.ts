/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILanguageModelMessage } from '../../../../platform/positronHeadlessLanguageModel/common/engine.js';

export type { ILanguageModelMessage };

/**
 * The headless language model service: one reusable seam any Positron feature
 * can use to stream text from a model, pick a model by intent, and degrade
 * gracefully when none is available -- entirely Positron-side, with no
 * dependency on the assistant extension or `vscode.lm`.
 *
 * The whole surface is the three members below. Provider identities, the
 * provider-priority policy, credentials, the HTTP egress, the process boundary
 * (desktop / Remote SSH / web), streaming/cancellation plumbing, and caching are
 * all implementation secrets.
 */
export interface IHeadlessLanguageModelService {
	readonly _serviceBrand: undefined;

	/**
	 * Stream a text completion.
	 *
	 * Resolves to either a text stream or a typed reason it cannot proceed
	 * (R5); consumers branch on the result rather than catching exceptions for
	 * expected states. Never triggers a sign-in prompt (R6).
	 *
	 * @param params The system prompt, message history, optional model selection,
	 *   and optional cancellation token (R4).
	 */
	streamText(params: IStreamTextRequest): Promise<StreamTextResult>;

	/**
	 * The models currently available, with the grouping information a picker
	 * needs (R8). Provider *identity* stays hidden; only a display vendor is
	 * exposed.
	 */
	getAvailableModels(): Promise<readonly IAvailableModel[]>;

	/**
	 * Fires when the available-model set changes -- for example after a sign-in
	 * or sign-out -- so a picker can stay current (R8).
	 */
	readonly onDidChangeAvailableModels: Event<void>;
}

export const IHeadlessLanguageModelService =
	createDecorator<IHeadlessLanguageModelService>('headlessLanguageModelService');

/** A request for a streamed text completion. */
export interface IStreamTextRequest {
	/** The system prompt. The service does not own prompts; the consumer builds this. */
	readonly systemPrompt: string;
	/** The message history to send, oldest first. */
	readonly messages: readonly ILanguageModelMessage[];
	/** Which model to use; defaults to the fast/cheap tier when omitted (R2). */
	readonly model?: ModelSelection;
	/** Optional cap on the number of tokens generated. */
	readonly maxOutputTokens?: number;
	/** Cancelling stops the stream promptly and releases resources (R4). */
	readonly cancellationToken?: CancellationToken;
}

/** The named model tiers a consumer can ask for. */
export type ModelTier = 'fast-cheap';

/**
 * How a consumer expresses which model it wants, without referencing providers
 * or credentials (R2): a named tier, an exact id, or preference patterns.
 */
export type ModelSelection =
	/** A named tier, resolved against the tier's configured preference patterns. */
	| { readonly tier: ModelTier }
	/** An exact model id, e.g. one a user pinned from a picker. */
	| { readonly id: string }
	/** Preference patterns (e.g. `haiku`, `mini`), tried in order until one matches. */
	| { readonly patterns: readonly string[] };

/** The default fast/cheap tier, used when no preference is given. */
export const FastCheap: ModelSelection = { tier: 'fast-cheap' };

/** The result of {@link IHeadlessLanguageModelService.streamText}. */
export type StreamTextResult =
	| {
		readonly available: true;
		/** The model that was resolved for this request. */
		readonly model: IResolvedModel;
		/** The response text, streamed incrementally (R1). Throws if the stream fails mid-flight. */
		readonly text: AsyncIterable<string>;
	}
	| {
		readonly available: false;
		/** The typed reason the request cannot proceed (R5). */
		readonly reason: UnavailableReason;
	};

/**
 * The defined, typed reasons a request cannot proceed (R5).
 *
 * - `no-providers-configured`: nothing in this environment can serve a model.
 * - `sign-in-required`: a provider could work, but no session exists. The
 *   actionable hint case (R7) -- the consumer can surface "sign in to enable ...".
 * - `no-model-matched`: signed in, but the requested intent matched no available model.
 */
export type UnavailableReason =
	| 'no-providers-configured'
	| 'sign-in-required'
	| 'no-model-matched';

/** The model resolved for a request. */
export interface IResolvedModel {
	/** The exact model id (suitable for pinning via an `{ id }` {@link ModelSelection}). */
	readonly id: string;
	/** A human-readable display name. */
	readonly name: string;
}

/** An available model, as surfaced for a picker (R8). */
export interface IAvailableModel {
	/** The exact model id (what a picker pins, via an `{ id }` {@link ModelSelection}). */
	readonly id: string;
	/** A human-readable display name. */
	readonly name: string;
	/** The display vendor, for grouping in a picker (e.g. "Anthropic", "OpenAI"). */
	readonly vendor: string;
}
