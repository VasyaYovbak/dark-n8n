import type { OpenAIClient } from '@langchain/openai';

export type BuiltInTools = {
	webSearch?: {
		searchContextSize?: 'low' | 'medium' | 'high';
		allowedDomains?: string;
		country?: string;
		city?: string;
		region?: string;
	};
	fileSearch?: {
		vectorStoreIds?: string;
		filters?: string;
		maxResults?: number;
	};
	codeInterpreter?: boolean;
};

export type ModelOptions = {
	baseURL?: string;
	frequencyPenalty?: number;
	maxTokens?: number;
	responseFormat?: 'text' | 'json_object';
	presencePenalty?: number;
	temperature?: number;
	reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
	reasoning?: {
		reasoningOptions?: ReasoningOptions;
	};
	timeout?: number;
	maxRetries?: number;
	topP?: number;
	conversationId?: string;
	metadata?: string;
	promptCacheKey?: string;
	safetyIdentifier?: string;
	serviceTier?: 'auto' | 'flex' | 'default' | 'priority';
	topLogprobs?: number;
	textFormat?: {
		textOptions?: TextOptions;
	};
	promptConfig?: {
		promptOptions?: PromptOptions;
	};
};

export type PromptOptions = {
	promptId?: string;
	version?: string;
	variables?: string;
};

export type ReasoningSummary = 'none' | 'auto' | 'concise' | 'detailed';

export type ReasoningOptions = {
	effort?: 'minimal' | 'low' | 'medium' | 'high';
	summary?: ReasoningSummary;
};

export type TextOptions = {
	type?: 'text' | 'json_schema' | 'json_object';
	verbosity?: 'low' | 'medium' | 'high';
	name?: string;
	schema?: string;
	description?: string;
	strict?: boolean;
};
export type ChatResponseRequest = OpenAIClient.Responses.ResponseCreateParamsNonStreaming & {
	conversation?: { id: string } | string;
	top_logprobs?: number;
};
