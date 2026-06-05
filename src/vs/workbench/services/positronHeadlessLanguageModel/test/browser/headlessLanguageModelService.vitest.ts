/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference types="vitest/globals" />

import { AsyncIterableObject } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IEngineChatRequest, IHeadlessLanguageModelEngine, IModelDescriptor, IProviderMapping } from '../../../../../platform/positronHeadlessLanguageModel/common/engine.js';
import { createTestContainer } from '../../../../../test/vitest/positronTestContainer.js';
import { AuthenticationSession, IAuthenticationService } from '../../../authentication/common/authentication.js';
import { AbstractHeadlessLanguageModelService } from '../../browser/abstractHeadlessLanguageModelService.js';

// A test subclass that hands the facade a fake engine -- the provider-bridge boundary.
class TestHeadlessLanguageModelService extends AbstractHeadlessLanguageModelService {
	constructor(
		private readonly _fakeEngine: IHeadlessLanguageModelEngine | undefined,
		@IAuthenticationService authService: IAuthenticationService,
		@IConfigurationService configService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		super(authService, configService, logService);
	}
	protected createEngine(): IHeadlessLanguageModelEngine | undefined {
		return this._fakeEngine;
	}
}

function model(id: string, name: string, providerId: string, vendor = 'Acme'): IModelDescriptor {
	return { id, name, vendor, providerId };
}

// Stands in for the bridge's PROVIDER_MAP, served by the engine over IPC.
const TEST_MAPPINGS: IProviderMapping[] = [
	{ providerId: 'positai', authProviderId: 'posit-ai', scopes: ['positai'], credentialType: 'oauth', configKey: 'posit-ai' },
	{ providerId: 'anthropic', authProviderId: 'anthropic-api', scopes: [], credentialType: 'apikey', configKey: 'anthropic' },
	{ providerId: 'openai', authProviderId: 'openai-api', scopes: [], credentialType: 'apikey', configKey: 'openai' },
];

function fakeEngine(options: {
	models?: Record<string, IModelDescriptor[]>;
	mappings?: IProviderMapping[];
	stream?: (request: IEngineChatRequest) => AsyncIterable<string>;
} = {}): IHeadlessLanguageModelEngine {
	return {
		getProviderMappings: async () => options.mappings ?? TEST_MAPPINGS,
		listModels: async (providerId: string) => options.models?.[providerId] ?? [],
		streamChat: (request: IEngineChatRequest) =>
			options.stream ? options.stream(request) : AsyncIterableObject.fromArray(['ok']),
	};
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
	let text = '';
	for await (const chunk of stream) {
		text += chunk;
	}
	return text;
}

function session(authProviderId: string): AuthenticationSession {
	return { id: 's', accessToken: `tok-${authProviderId}`, account: { id: 'a', label: 'a' }, scopes: [] };
}

describe('HeadlessLanguageModelService', () => {
	// Describe-level so the stub captures stable references (builder rule).
	const sessionsChange = new Emitter<{ providerId: string; label: string; event: { added: readonly AuthenticationSession[]; removed: readonly AuthenticationSession[]; changed: readonly AuthenticationSession[] } }>();
	const createSession = vi.fn();
	const getSessions = vi.fn(async (id: string): Promise<AuthenticationSession[]> => {
		// Simulates getSessions timing out / throwing for a provider that errors.
		if (throwingAuthProviders.has(id)) {
			throw new Error(`Timed out waiting for authentication provider '${id}' to register.`);
		}
		return signedInAuthProviders.has(id) ? [session(id)] : [];
	});
	// Registered auth backends (independent of whether a session exists); the
	// facade only queries getSessions for these.
	const getProviderIds = vi.fn((): string[] => [...registeredAuthProviders]);

	// Mutable knobs the stubs read at call time; reset per test.
	let signedInAuthProviders: Set<string>;
	let registeredAuthProviders: Set<string>;
	let throwingAuthProviders: Set<string>;
	let configValues: Map<string, unknown>;

	beforeEach(() => {
		signedInAuthProviders = new Set();
		registeredAuthProviders = new Set(TEST_MAPPINGS.map(mapping => mapping.authProviderId));
		throwingAuthProviders = new Set();
		configValues = new Map();
	});

	const ctx = createTestContainer()
		.stub(ILogService, new NullLogService())
		.stub(IAuthenticationService, { getSessions, createSession, getProviderIds, onDidChangeSessions: sessionsChange.event })
		.stub(IConfigurationService, { getValue: (key: string) => configValues.get(key) })
		.build();

	function createService(engine: IHeadlessLanguageModelEngine | undefined): TestHeadlessLanguageModelService {
		return ctx.disposables.add(ctx.instantiationService.createInstance(TestHeadlessLanguageModelService, engine));
	}

	describe('availability (R5)', () => {
		it('reports no-providers-configured when no engine is reachable', async () => {
			const service = createService(undefined);
			const result = await service.streamText({ systemPrompt: 's', messages: [] });
			expect(result).toEqual({ available: false, reason: 'no-providers-configured' });
		});

		it('reports sign-in-required when no provider has a session', async () => {
			const service = createService(fakeEngine({ models: { anthropic: [model('haiku-1', 'Haiku', 'anthropic')] } }));
			const result = await service.streamText({ systemPrompt: 's', messages: [] });
			expect(result).toEqual({ available: false, reason: 'sign-in-required' });
		});

		it('reports no-model-matched when a pinned exact id is gone (the only no-match path)', async () => {
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({ models: { anthropic: [model('haiku-1', 'Haiku', 'anthropic')] } }));
			const result = await service.streamText({ systemPrompt: 's', messages: [], model: { id: 'nope' } });
			expect(result).toEqual({ available: false, reason: 'no-model-matched' });
		});
	});

	describe('model selection (R2)', () => {
		it('default tier resolves via the fast/cheap patterns', async () => {
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({ models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic')] } }));
			const result = await service.streamText({ systemPrompt: 's', messages: [] });
			expect(result.available && result.model.id).toBe('claude-haiku');
		});

		it('an exact id resolves precisely', async () => {
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({
				models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic'), model('claude-sonnet', 'Claude Sonnet', 'anthropic')] },
			}));
			const result = await service.streamText({ systemPrompt: 's', messages: [], model: { id: 'claude-sonnet' } });
			expect(result.available && result.model.id).toBe('claude-sonnet');
		});

		it('patterns are tried in order until one matches', async () => {
			signedInAuthProviders.add('openai-api');
			const service = createService(fakeEngine({ models: { openai: [model('gpt-5-mini', 'GPT-5 Mini', 'openai')] } }));
			const result = await service.streamText({ systemPrompt: 's', messages: [], model: { patterns: ['nope', 'mini'] } });
			expect(result.available && result.model.id).toBe('gpt-5-mini');
		});
	});

	describe('no-match fallback (D2)', () => {
		it('a tier selection falls back to the highest-priority model when its patterns match nothing', async () => {
			signedInAuthProviders.add('openai-api');
			// The default fast/cheap patterns (haiku/mini/flash/gemma) match neither id nor name.
			const service = createService(fakeEngine({ models: { openai: [model('gpt-5', 'GPT-5', 'openai')] } }));
			const result = await service.streamText({ systemPrompt: 's', messages: [] });
			expect(result.available && result.model.id).toBe('gpt-5');
		});

		it('a pattern selection falls back to the highest-priority model, respecting provider priority', async () => {
			signedInAuthProviders.add('posit-ai');
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({
				models: {
					anthropic: [model('claude-x', 'Claude X', 'anthropic')],
					positai: [model('posit-x', 'Posit X', 'positai')],
				},
			}));
			const result = await service.streamText({ systemPrompt: 's', messages: [], model: { patterns: ['no-such-model'] } });
			// positai (gateway) outranks anthropic, so the fallback lands on its model.
			expect(result.available && result.model.id).toBe('posit-x');
		});

		it('the fast/cheap tier reads its configured patterns', async () => {
			signedInAuthProviders.add('anthropic-api');
			configValues.set('languageModels.fastCheap', ['sonnet']);
			const service = createService(fakeEngine({
				models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic'), model('claude-sonnet', 'Claude Sonnet', 'anthropic')] },
			}));
			// The default tier now prefers 'sonnet' from the setting, not the built-in 'haiku'.
			const result = await service.streamText({ systemPrompt: 's', messages: [] });
			expect(result.available && result.model.id).toBe('claude-sonnet');
		});
	});

	describe('provider priority (R3)', () => {
		it('prefers the Posit gateway over a direct vendor for the same intent', async () => {
			signedInAuthProviders.add('posit-ai');
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({
				models: {
					anthropic: [model('haiku-direct', 'Haiku (direct)', 'anthropic')],
					positai: [model('haiku-posit', 'Haiku (Posit)', 'positai')],
				},
			}));
			const result = await service.streamText({ systemPrompt: 's', messages: [], model: { patterns: ['haiku'] } });
			expect(result.available && result.model.id).toBe('haiku-posit');
		});
	});

	describe('streaming (R1)', () => {
		it('streams the engine text deltas through the public result', async () => {
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({
				models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic')] },
				stream: () => AsyncIterableObject.fromArray(['Hello, ', 'world']),
			}));
			const result = await service.streamText({ systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }] });
			expect(result.available).toBe(true);
			if (result.available) {
				expect(await collect(result.text)).toBe('Hello, world');
			}
		});
	});

	describe('non-interruption (R6)', () => {
		it('never creates a session (no sign-in prompt)', async () => {
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({ models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic')] } }));
			await service.streamText({ systemPrompt: 's', messages: [] });
			await service.getAvailableModels();
			expect(createSession).not.toHaveBeenCalled();
		});
	});

	describe('discovery (R8)', () => {
		it('exposes available models with vendor grouping but hides provider identity', async () => {
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({ models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic', 'Anthropic')] } }));
			const models = await service.getAvailableModels();
			expect(models).toEqual([{ id: 'claude-haiku', name: 'Claude Haiku', vendor: 'Anthropic' }]);
			expect(models[0]).not.toHaveProperty('providerId');
		});

		it('fires onDidChangeAvailableModels only when a mapped provider changes', async () => {
			const service = createService(fakeEngine());
			// Provider mappings load from the engine asynchronously; wait for them
			// so the change-event filter is populated before we fire.
			await service.getAvailableModels();
			const fired = vi.fn();
			ctx.disposables.add(service.onDidChangeAvailableModels(fired));

			sessionsChange.fire({ providerId: 'anthropic-api', label: 'a', event: { added: [], removed: [], changed: [] } });
			expect(fired).toHaveBeenCalledTimes(1);

			sessionsChange.fire({ providerId: 'some-unrelated-provider', label: 'b', event: { added: [], removed: [], changed: [] } });
			expect(fired).toHaveBeenCalledTimes(1);
		});
	});

	describe('resilience', () => {
		it('does not query providers whose auth backend is not registered', async () => {
			// Only anthropic-api is registered; posit-ai / openai-api would time
			// out if queried (the deepseek-api regression).
			signedInAuthProviders.add('anthropic-api');
			registeredAuthProviders = new Set(['anthropic-api']);
			const service = createService(fakeEngine({ models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic')] } }));
			const result = await service.streamText({ systemPrompt: 's', messages: [] });
			expect(result.available).toBe(true);
			const queried = getSessions.mock.calls.map(call => call[0]);
			expect(queried).not.toContain('posit-ai');
			expect(queried).not.toContain('openai-api');
		});

		it('one provider erroring does not abort the credential sweep', async () => {
			signedInAuthProviders.add('anthropic-api');
			throwingAuthProviders.add('openai-api'); // e.g. an activation timeout
			const service = createService(fakeEngine({ models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic')] } }));
			const result = await service.streamText({ systemPrompt: 's', messages: [] });
			expect(result.available && result.model.id).toBe('claude-haiku');
		});
	});

	describe('credentials (R10)', () => {
		it('re-resolves credentials for each request even when the model list is cached', async () => {
			signedInAuthProviders.add('anthropic-api');
			const service = createService(fakeEngine({ models: { anthropic: [model('claude-haiku', 'Claude Haiku', 'anthropic')] } }));
			await service.getAvailableModels();
			const afterListing = getSessions.mock.calls.length;
			const result = await service.streamText({ systemPrompt: 's', messages: [] });
			expect(result.available).toBe(true);
			// The stream request resolved credentials again, beyond the listing pass.
			expect(getSessions.mock.calls.length).toBeGreaterThan(afterListing);
		});
	});
});
