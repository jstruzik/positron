/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../base/common/types.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AuthenticationSession, IAuthenticationService } from '../../authentication/common/authentication.js';
import {
	FAST_CHEAP_DEFAULT_PATTERNS,
	TIER_SETTING_KEYS,
} from '../common/headlessLanguageModelConfiguration.js';
import { ICredentials, IHeadlessLanguageModelEngine, IModelDescriptor, IProviderMapping } from '../../../../platform/positronHeadlessLanguageModel/common/engine.js';
import {
	FastCheap,
	IAvailableModel,
	IHeadlessLanguageModelService,
	IStreamTextRequest,
	ModelSelection,
	StreamTextResult,
} from '../common/headlessLanguageModelService.js';
import { byPriority, selectModel } from '../common/headlessLanguageModelSelection.js';

interface IResolvedState {
	readonly models: readonly IModelDescriptor[];
	readonly anyCredential: boolean;
}

/**
 * All of the headless-LM policy: model selection (R2), provider priority (R3),
 * typed availability (R5), read-only credential resolution (R6/R10), model-list
 * caching, and change notification (R8). It is environment-agnostic and depends
 * only on two external boundaries -- the auth source and the engine port --
 * which are exactly what the interface tests fake.
 *
 * Subclasses supply the engine via {@link createEngine}; everything else lives
 * here. The concrete subclasses (and their service registrations) live in
 * sibling files so importing this base never registers a service.
 */
export abstract class AbstractHeadlessLanguageModelService extends Disposable implements IHeadlessLanguageModelService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAvailableModels = this._register(new Emitter<void>());
	readonly onDidChangeAvailableModels: Event<void> = this._onDidChangeAvailableModels.event;

	private _engine: IHeadlessLanguageModelEngine | undefined;
	private _engineCreated = false;
	/** Provider -> auth mappings, fetched once from the engine (the bridge owns them). */
	private _mappings: Promise<readonly IProviderMapping[]> | undefined;
	/** Synchronous snapshot of the loaded mappings, for config-key derivation in event handlers; set once mappings load. */
	private _loadedMappings: readonly IProviderMapping[] | undefined;
	/** Auth provider ids we care about, for filtering session-change events; set once mappings load. */
	private _mappedAuthProviderIds: ReadonlySet<string> | undefined;
	/** Cached model listing; invalidated on auth change. Credentials are never cached. */
	private _state: Promise<IResolvedState> | undefined;

	constructor(
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@ILogService protected readonly _logService: ILogService,
	) {
		super();
		// The available-model set follows sign-in / sign-out (R8). The mappings
		// load lazily on first use (not here -- a subclass's createEngine depends
		// on parameter-properties not yet assigned during super()). Until they
		// load there is no cached state to invalidate, so an early change is
		// safely ignored by the filter.
		this._register(this._authService.onDidChangeSessions(e => {
			if (this._mappedAuthProviderIds?.has(e.providerId)) {
				this._invalidate();
			}
		}));

		// Availability also depends on per-provider config the credential shaping
		// reads (base URLs, custom headers, AWS region, Snowflake host/account).
		// A change to any of those keys can flip a provider's availability or the
		// listed models, so the cached state must be dropped. Same guard as
		// above: if mappings have not loaded there is no state to invalidate.
		this._register(this._configService.onDidChangeConfiguration(e => {
			if (this.affectsCredentialConfig(e)) {
				this._invalidate();
			}
		}));

		// A mapped auth provider registering (e.g. the user signs into a provider
		// whose backend was not registered at the first lookup) or unregistering
		// changes which providers the sweep queries. Drop the cached state so the
		// next listing reflects the new provider set.
		this._register(this._authService.onDidRegisterAuthenticationProvider(provider => {
			if (this._mappedAuthProviderIds?.has(provider.id)) {
				this._invalidate();
			}
		}));
		this._register(this._authService.onDidUnregisterAuthenticationProvider(provider => {
			if (this._mappedAuthProviderIds?.has(provider.id)) {
				this._invalidate();
			}
		}));
	}

	/** Drop the cached model listing and notify pickers (R8). */
	private _invalidate(): void {
		this._state = undefined;
		this._onDidChangeAvailableModels.fire();
	}

	/**
	 * Whether a config change touches any key the credential shaping reads for a
	 * loaded mapping: each apikey mapping's `authentication.<configKey>.baseUrl` /
	 * `.customHeaders`, plus the fixed `authentication.aws.credentials` and
	 * `authentication.snowflake.credentials` namespaces. Returns false until
	 * mappings load (nothing cached to invalidate yet).
	 */
	private affectsCredentialConfig(e: IConfigurationChangeEvent): boolean {
		const mappings = this._loadedMappings;
		if (!mappings) {
			return false;
		}
		if (e.affectsConfiguration('authentication.aws.credentials')
			|| e.affectsConfiguration('authentication.snowflake.credentials')) {
			return true;
		}
		return mappings.some(mapping =>
			e.affectsConfiguration(`authentication.${mapping.configKey}.baseUrl`)
			|| e.affectsConfiguration(`authentication.${mapping.configKey}.customHeaders`));
	}

	/** Create the engine for this environment, or `undefined` if none is reachable. */
	protected abstract createEngine(): IHeadlessLanguageModelEngine | undefined;

	private getEngine(): IHeadlessLanguageModelEngine | undefined {
		if (!this._engineCreated) {
			this._engineCreated = true;
			this._engine = this.createEngine();
		}
		return this._engine;
	}

	async streamText(params: IStreamTextRequest): Promise<StreamTextResult> {
		const engine = this.getEngine();
		if (!engine) {
			return { available: false, reason: 'no-providers-configured' };
		}

		// The availability pre-check (listing state + fresh credential resolution)
		// can fail transiently (IPC/bridge startup). Surface that as a distinct,
		// retryable reason rather than throwing -- the service's contract is that
		// only the returned `text` iterable throws mid-stream. The streamChat call
		// below returns its iterable synchronously, so it stays outside this guard
		// and its mid-flight failures still surface through `text`.
		let chosen: IModelDescriptor | undefined;
		let credentials: ICredentials | undefined;
		try {
			const state = await this.resolveState();
			if (!state.anyCredential) {
				return { available: false, reason: 'sign-in-required' };
			}

			const selection = params.model ?? FastCheap;
			chosen = selectModel(state.models, selection, this.tierPatterns(selection));
			if (!chosen) {
				return { available: false, reason: 'no-model-matched' };
			}

			// Resolve credentials freshly for the chosen provider so short-lived
			// tokens stay valid (R10). The token may have lapsed since listing.
			credentials = await this.resolveCredentialFor(chosen.providerId);
		} catch (error) {
			this._logService.warn(`[headless-lm] Availability check failed: ${error}`);
			return { available: false, reason: 'temporarily-unavailable' };
		}

		if (!credentials) {
			return { available: false, reason: 'sign-in-required' };
		}

		const text = engine.streamChat({
			providerId: chosen.providerId,
			modelId: chosen.id,
			credentials,
			systemPrompt: params.systemPrompt,
			messages: params.messages,
			maxOutputTokens: params.maxOutputTokens,
		}, params.cancellationToken ?? CancellationToken.None);

		return { available: true, model: { id: chosen.id, name: chosen.name }, text };
	}

	async getAvailableModels(): Promise<readonly IAvailableModel[]> {
		// A transient failure yields an empty list (the list API has no reason
		// slot); resolveState() self-heals so the next call can recover.
		let state: IResolvedState;
		try {
			state = await this.resolveState();
		} catch (error) {
			this._logService.warn(`[headless-lm] Listing available models failed: ${error}`);
			return [];
		}
		return state.models.map(model => ({ id: model.id, name: model.name, vendor: model.vendor }));
	}

	private resolveState(): Promise<IResolvedState> {
		if (!this._state) {
			// Self-heal: a rejected computeState() must not be cached, or a
			// transient failure would break the service until window reload.
			this._state = this.computeState().catch(error => {
				this._state = undefined;
				throw error;
			});
		}
		return this._state;
	}

	private async computeState(): Promise<IResolvedState> {
		const engine = this.getEngine();
		if (!engine) {
			return { models: [], anyCredential: false };
		}

		const mappings = await this.providerMappings();

		// Only query providers whose auth backend is actually registered. Calling
		// getSessions for an unregistered provider would fire its activation event
		// and time out waiting for it to register (e.g. 'deepseek-api' when the
		// user has no DeepSeek auth) -- both slow and, uncaught, fatal to the whole
		// sweep. The user's real sign-ins are registered, so this loses nothing.
		const registered = new Set(this._authService.getProviderIds());
		const relevant = mappings.filter(mapping => registered.has(mapping.authProviderId));

		// Read-only credential lookup across every registered mapped provider (R6/R10).
		const credentialed = (await Promise.all(relevant.map(async mapping => {
			const credentials = await this.resolveCredential(mapping);
			return credentials ? { providerId: mapping.providerId, credentials } : undefined;
		}))).filter((entry): entry is { providerId: string; credentials: ICredentials } => !!entry);

		// List models for each credentialed provider, tolerating per-provider
		// listing failures so one bad provider does not blank the picker.
		const listed = await Promise.all(credentialed.map(async ({ providerId, credentials }) => {
			try {
				return await engine.listModels(providerId, credentials);
			} catch (error) {
				this._logService.warn(`[headless-lm] Listing models for ${providerId} failed: ${error}`);
				return [] as IModelDescriptor[];
			}
		}));

		return { models: dedupeById(byPriority(listed.flat())), anyCredential: credentialed.length > 0 };
	}

	/**
	 * The preference patterns for a tier selection, read from the tier's setting
	 * (R14) with the built-in default as fallback. Only a tier selection consults
	 * this; an id or pattern selection carries its own target.
	 */
	private tierPatterns(selection: ModelSelection): readonly string[] {
		if (hasKey(selection, { tier: true })) {
			const configured = this._configService.getValue<string[]>(TIER_SETTING_KEYS[selection.tier]);
			if (configured && configured.length > 0) {
				return configured;
			}
		}
		return FAST_CHEAP_DEFAULT_PATTERNS;
	}

	/** Fetch the provider mappings from the engine once; the bridge owns them. */
	private providerMappings(): Promise<readonly IProviderMapping[]> {
		if (!this._mappings) {
			const engine = this.getEngine();
			this._mappings = (engine ? engine.getProviderMappings() : Promise.resolve([]))
				.then(mappings => {
					this._loadedMappings = mappings;
					this._mappedAuthProviderIds = new Set(mappings.map(mapping => mapping.authProviderId));
					return mappings;
				})
				// Self-heal: a rejected fetch must not be memoized forever, or a
				// transient IPC/bridge-startup failure would break the service
				// until window reload. Clear the field so the next call refetches.
				.catch(error => {
					this._mappings = undefined;
					this._loadedMappings = undefined;
					throw error;
				});
		}
		return this._mappings;
	}

	/** Resolve credentials for a provider id, looking up its mapping first. */
	private async resolveCredentialFor(providerId: string): Promise<ICredentials | undefined> {
		const mapping = (await this.providerMappings()).find(m => m.providerId === providerId);
		return mapping ? this.resolveCredential(mapping) : undefined;
	}

	/**
	 * Resolve a provider's credentials from the workbench auth service, mirroring
	 * the provider bridge's PositronCredentialProvider -- but sourced from
	 * IAuthenticationService, since the bridge's own resolver is
	 * `vscode.authentication`-bound and the headless path deliberately stays off
	 * the extension host. Strictly read-only -- it never creates a session, so a
	 * background feature can never trigger a sign-in prompt (R6).
	 */
	private async resolveCredential(mapping: IProviderMapping): Promise<ICredentials | undefined> {
		const accessToken = await this.readAccessToken(mapping);
		if (!accessToken) {
			return undefined;
		}
		return this.toCredentials(mapping, accessToken);
	}

	/** Silent session lookup with scope fallback, matching the bridge's resolver. */
	private async readAccessToken(mapping: IProviderMapping): Promise<string | undefined> {
		let sessions = await this.tryGetSessions(mapping.authProviderId, [...mapping.scopes]);
		if (sessions.length === 0 && mapping.fallbackScopes) {
			for (const fallback of mapping.fallbackScopes) {
				sessions = await this.tryGetSessions(mapping.authProviderId, [...fallback]);
				if (sessions.length > 0) {
					break;
				}
			}
		}
		return sessions[0]?.accessToken;
	}

	/**
	 * Session lookup that never throws -- mirrors the bridge's tryGetSession. A
	 * provider that errors (or whose activation times out despite being listed as
	 * registered) yields no session rather than aborting the credential sweep.
	 */
	private async tryGetSessions(authProviderId: string, scopes: string[]): Promise<readonly AuthenticationSession[]> {
		try {
			return await this._authService.getSessions(authProviderId, scopes);
		} catch (error) {
			this._logService.trace(`[headless-lm] No session for ${authProviderId}: ${error}`);
			return [];
		}
	}

	/**
	 * Shape a session token into provider credentials, mirroring the bridge.
	 *
	 * SYNC POINTER: this is a near-line-by-line mirror of the bridge's
	 * `getMappedCredentials` (`ai-provider-bridge/src/positron/auth.ts:66-201`)
	 * and must be kept in sync with it. The bridge's own resolver is
	 * `vscode.authentication`-bound and cannot load in the renderer/shared
	 * process, so this copy reads from `IAuthenticationService` instead. The
	 * fixed config namespaces below (`authentication.aws.credentials`,
	 * `authentication.snowflake.credentials`) are intentional: they match where
	 * the assistant already stores those credentials, so they are not derived
	 * from `mapping.configKey`.
	 */
	private toCredentials(mapping: IProviderMapping, accessToken: string): ICredentials | undefined {
		switch (mapping.credentialType) {
			case 'oauth':
				return { type: 'oauth', accessToken };
			case 'google-cloud': {
				const parsed = parseJson<{ token?: string; project?: string; location?: string }>(accessToken);
				if (!parsed?.token || !parsed.project || !parsed.location) {
					return undefined;
				}
				return { type: 'google-cloud', project: parsed.project, location: parsed.location, accessToken: parsed.token };
			}
			case 'aws-credentials': {
				const parsed = parseJson<{ accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }>(accessToken);
				if (!parsed?.accessKeyId || !parsed.secretAccessKey) {
					return undefined;
				}
				// The renderer has no process env, so region comes from settings (R15).
				const awsConfig = this._configService.getValue<{ AWS_REGION?: string }>('authentication.aws.credentials');
				return {
					type: 'aws-credentials',
					region: awsConfig?.AWS_REGION || 'us-east-1',
					accessKeyId: parsed.accessKeyId,
					secretAccessKey: parsed.secretAccessKey,
					sessionToken: parsed.sessionToken,
				};
			}
			case 'apikey': {
				const customHeaders = this._configService.getValue<Record<string, string>>(`authentication.${mapping.configKey}.customHeaders`);
				return {
					type: 'apikey',
					apiKey: accessToken,
					baseUrl: this.apiKeyBaseUrl(mapping),
					customHeaders: customHeaders && Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
				};
			}
		}
	}

	/** Base URL for an apikey provider: Snowflake builds its own; others read settings (R15). */
	private apiKeyBaseUrl(mapping: IProviderMapping): string | undefined {
		if (mapping.providerId === 'snowflake-cortex') {
			const cfg = this._configService.getValue<{ SNOWFLAKE_HOST?: string; SNOWFLAKE_ACCOUNT?: string }>('authentication.snowflake.credentials');
			if (cfg?.SNOWFLAKE_HOST) {
				return `https://${cfg.SNOWFLAKE_HOST}/api/v2/cortex/v1`;
			}
			if (cfg?.SNOWFLAKE_ACCOUNT) {
				return `https://${cfg.SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1`;
			}
			return undefined;
		}
		return this._configService.getValue<string>(`authentication.${mapping.configKey}.baseUrl`) || undefined;
	}
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function dedupeById(orderedModels: readonly IModelDescriptor[]): IModelDescriptor[] {
	const seen = new Set<string>();
	const result: IModelDescriptor[] = [];
	for (const model of orderedModels) {
		if (!seen.has(model.id)) {
			seen.add(model.id);
			result.push(model);
		}
	}
	return result;
}
