/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken as BridgeCancellationToken, Logger, ModelInfo, ProviderCredentials, ProviderId, ProviderRegistry } from 'ai-provider-bridge';
import type { ModelMessage } from 'ai';
import { AsyncIterableObject } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { ILogService } from '../../log/common/log.js';
import { ICredentials, IEngineChatRequest, IHeadlessLanguageModelEngine, IModelDescriptor, IProviderMapping } from '../common/engine.js';

/**
 * Auth-provider ids whose user-facing config namespace differs from the id.
 * Mirrors the provider bridge's CONFIG_KEY_OVERRIDES so the facade reads the
 * same `authentication.<configKey>.*` settings the assistant extension does.
 */
const CONFIG_KEY_OVERRIDES: Record<string, string> = {
	'anthropic-api': 'anthropic',
	'ms-foundry': 'foundry',
	'snowflake-cortex': 'snowflake',
};

/**
 * The Node-side egress engine: the one place that touches the provider bridge
 * and the network. It is intentionally thin -- it holds no policy. Selection,
 * priority, credentials, and availability all live in the workbench facade;
 * this just lists models and streams text for an already-chosen provider/model,
 * and adapts the service-owned port types to the bridge.
 *
 * Runs in the shared process (desktop) or the remote server (Remote SSH / web)
 * and is reached over an IPC channel.
 */
export class HeadlessLanguageModelEngine implements IHeadlessLanguageModelEngine {

	private readonly _logger: Logger;
	private _registry: Promise<ProviderRegistry> | undefined;

	constructor(logService: ILogService) {
		this._logger = {
			info: (m: string, ...a: unknown[]) => logService.info(m, ...a),
			warn: (m: string, ...a: unknown[]) => logService.warn(m, ...a),
			error: (m: string, ...a: unknown[]) => logService.error(m, ...a),
			debug: (m: string, ...a: unknown[]) => logService.debug(m, ...a),
			trace: (m: string, ...a: unknown[]) => logService.trace(m, ...a),
		};
	}

	async getProviderMappings(): Promise<IProviderMapping[]> {
		// The bridge owns the provider -> auth mapping; forward it as plain data
		// so the renderer never has to import the bridge or duplicate the map.
		const { PROVIDER_MAP, MAPPED_PROVIDER_IDS } = await import('ai-provider-bridge');
		return MAPPED_PROVIDER_IDS.flatMap((providerId: ProviderId) => {
			const mapping = PROVIDER_MAP[providerId];
			if (!mapping) {
				return [];
			}
			return [{
				providerId,
				authProviderId: mapping.authProviderId,
				scopes: mapping.scopes,
				fallbackScopes: mapping.fallbackScopes,
				credentialType: mapping.credentialType,
				configKey: CONFIG_KEY_OVERRIDES[mapping.authProviderId] ?? mapping.authProviderId,
			}];
		});
	}

	async listModels(providerId: string, credentials: ICredentials): Promise<IModelDescriptor[]> {
		const registry = await this.registry();
		const models = await registry.getModelsForProvider(providerId, credentials as ProviderCredentials);
		return models.map((model: ModelInfo) => ({ id: model.id, name: model.name, vendor: model.vendor, providerId }));
	}

	streamChat(request: IEngineChatRequest, token: CancellationToken): AsyncIterable<string> {
		return new AsyncIterableObject<string>(async (emitter) => {
			const registry = await this.registry();
			const client = registry.getClientForProvider(request.providerId, request.credentials as ProviderCredentials);
			if (!client) {
				throw new Error(`No client for provider ${request.providerId}`);
			}

			const messages: ModelMessage[] = request.messages.map(message =>
				message.role === 'user'
					? { role: 'user', content: message.content }
					: { role: 'assistant', content: message.content });

			const stream = await client.chat({
				model: request.modelId,
				messages,
				systemPrompt: request.systemPrompt,
				maxOutputTokens: request.maxOutputTokens,
				// A VS Code CancellationToken is structurally a bridge token.
				cancellationToken: token as unknown as BridgeCancellationToken,
			});

			for await (const part of stream) {
				if (token.isCancellationRequested) {
					break;
				}
				if (part.type === 'text-delta') {
					emitter.emitOne(part.text);
				}
			}
		});
	}

	private registry(): Promise<ProviderRegistry> {
		if (!this._registry) {
			this._registry = this.createRegistry();
		}
		return this._registry;
	}

	private async createRegistry(): Promise<ProviderRegistry> {
		// Deferred so the bridge and its heavy AI-SDK dependencies load only on
		// first use rather than synchronously at startup.
		const { ProviderRegistry, POSIT_AI_DEFAULTS } = await import('ai-provider-bridge');
		const {
			registerPositAiProvider,
			registerAnthropicProvider,
			registerOpenAIProvider,
			registerGeminiProvider,
			registerGoogleVertexProvider,
			registerOpenAICompatibleProvider,
			registerBedrockProvider,
			registerFoundryProvider,
			registerSnowflakeCortexProvider,
			registerCopilotProvider,
			registerDeepSeekProvider,
		} = await import('ai-provider-bridge/providers');
		const registry = new ProviderRegistry(this._logger);
		// Register every provider the bridge has an auth mapping for (its
		// MAPPED_PROVIDER_IDS), so any provider a user is signed into through
		// Positron is reachable -- mirroring the assistant extension's registry,
		// which is what `vscode.lm` resolves today (so switching to this service
		// expands reach, never contracts it). The Posit AI gateway is the
		// first-party path the priority policy prefers (R3). Local providers
		// (Ollama, LM Studio) use a separate endpoint-based credential path the
		// headless service does not implement, so they are intentionally omitted.
		registerPositAiProvider(registry, POSIT_AI_DEFAULTS.baseUrl, 'Positron/headless', this._logger);
		registerAnthropicProvider(registry, this._logger);
		registerOpenAIProvider(registry, this._logger);
		registerGeminiProvider(registry, this._logger);
		registerGoogleVertexProvider(registry, this._logger);
		registerOpenAICompatibleProvider(registry, this._logger);
		registerBedrockProvider(registry, this._logger);
		registerFoundryProvider(registry, this._logger);
		registerSnowflakeCortexProvider(registry, this._logger);
		registerCopilotProvider(registry, this._logger);
		registerDeepSeekProvider(registry, this._logger);
		return registry;
	}
}
