import { makeResolverFromLegacyOptions } from '@n8n/vm2';
import { JavaScriptSandbox } from 'n8n-nodes-base/dist/nodes/Code/JavaScriptSandbox';
import { getSandboxContext } from 'n8n-nodes-base/dist/nodes/Code/Sandbox';
import { NodeOperationError } from 'n8n-workflow';
import type { IExecuteFunctions, ISupplyDataFunctions } from 'n8n-workflow';

const { NODE_FUNCTION_ALLOW_BUILTIN: builtIn, NODE_FUNCTION_ALLOW_EXTERNAL: external } =
	process.env;

const langchainModules = ['langchain', '@langchain/*'];
export const vmResolver = makeResolverFromLegacyOptions({
	external: {
		modules: external ? [...langchainModules, ...external.split(',')] : [...langchainModules],
		transitive: false,
	},
	resolve(moduleName, parentDirname) {
		if (moduleName.match(/^langchain\//) ?? moduleName.match(/^@langchain\//)) {
			return require.resolve(`@n8n/n8n-nodes-langchain/node_modules/${moduleName}.cjs`, {
				paths: [parentDirname],
			});
		}
		return;
	},
	builtin: builtIn?.split(',') ?? [],
});

// Default callback codes
export const defaultCallbacks = {
	beforeLLM: `// Modify parameters before LLM call
// Global index under itemIndex
// Global execution Context under executionContext
// Example for sendChunk :
// await this.executionContext.sendChunk('item', this.itemIndex,  {"data":"Hi?"});
// Available variables: input, systemMessage, tools, memory, options
// Return modified parameters object
const input = this.input;
const systemMessage = this.systemMessage;
const tools = this.tools;
const memory = this.memory;
const options = this.options;


return {
	input,
	systemMessage,
	tools,
	memory,
	options
};`,
	afterLLM: `// Process LLM response
// Global index under itemIndex
// Global execution Context under executionContext
// Example for sendChunk :
// await this.executionContext.sendChunk('item', this.itemIndex,  {"data":"Hi?"});
// Available variables: response, originalInput, tools, memory
// Return modified response
const response = this.response;
const originalInput = this.originalInput;
const tools = this.tools;
const memory = this.memory;


return response;`,
	beforeTool: `// Modify tool input parameters
// Global index under itemIndex
// Global execution Context under executionContext
// Example for sendChunk :
// await this.executionContext.sendChunk('item', this.itemIndex,  {"data":"Hi?"});
// Available variables: toolName, toolInput, allTools
// Return modified toolInput
toolName = this.toolName
toolInput = this.toolInput
allTools = this.allTools

return toolInput;`,
	afterTool: `// Process tool response
// Global index under itemIndex
// Global execution Context under executionContext
// Example for sendChunk :
// await this.executionContext.sendChunk('item', this.itemIndex,  {"data":"Hi?"});
// Available variables: toolName, toolInput, toolOutput, allTools
// Return modified toolOutput
const toolName = this.toolName;
const toolInput = this.toolInput;
const allTools = this.allTools;
const toolOutput = this.toolOutput;


return toolOutput;`,
};

interface CallbackContext {
	input?: any;
	systemMessage?: string;
	tools?: any[];
	memory?: any;
	options?: any;
	response?: any;
	originalInput?: any;
	toolName?: string;
	toolInput?: any;
	toolOutput?: any;
	allTools?: any[];
}

function getSandboxForCallback(
	ctx: IExecuteFunctions | ISupplyDataFunctions,
	code: string,
	itemIndex: number,
	callbackContext: CallbackContext = {},
) {
	const node = ctx.getNode();
	const workflowMode = ctx.getMode();

	const context = getSandboxContext.call(ctx, itemIndex);
	context.addInputData = ctx.addInputData.bind(ctx);
	context.addOutputData = ctx.addOutputData.bind(ctx);
	context.getInputConnectionData = ctx.getInputConnectionData.bind(ctx);
	context.getInputData = ctx.getInputData.bind(ctx);
	context.getNode = ctx.getNode.bind(ctx);
	context.getExecutionCancelSignal = ctx.getExecutionCancelSignal.bind(ctx);
	context.getNodeOutputs = ctx.getNodeOutputs.bind(ctx);
	context.executeWorkflow = ctx.executeWorkflow.bind(ctx);
	context.getWorkflowDataProxy = ctx.getWorkflowDataProxy.bind(ctx);
	context.logger = ctx.logger;
	context.executionContext = ctx;
	context.itemIndex = itemIndex;

	Object.assign(context, callbackContext);

	const sandbox = new JavaScriptSandbox(context, code, ctx.helpers, {
		resolver: vmResolver,
	});

	sandbox.on(
		'output',
		workflowMode === 'manual' || workflowMode === 'integrated'
			? (...args: any[]) => (ctx as any).sendMessageToUI(...args)
			: (...args: unknown[]) =>
					console.log(`[Workflow "${ctx.getWorkflow().id}"][Node "${node.name}"]`, ...args),
	);
	return sandbox;
}

export async function executeCallback(
	ctx: IExecuteFunctions | ISupplyDataFunctions,
	callbackType: 'beforeLLM' | 'afterLLM' | 'beforeTool' | 'afterTool',
	itemIndex: number,
	callbackContext: CallbackContext = {},
): Promise<any> {
	const callbacks = ctx.getNodeParameter('callbacks', itemIndex, {}) as {
		beforeLLM?: { code: string };
		afterLLM?: { code: string };
		beforeTool?: { code: string };
		afterTool?: { code: string };
	};

	const callback = callbacks[callbackType];
	if (!callback?.code?.trim()) {
		// If no callback code is provided, return original data based on callback type
		switch (callbackType) {
			case 'beforeLLM':
				return {
					input: callbackContext.input,
					systemMessage: callbackContext.systemMessage,
					tools: callbackContext.tools,
					memory: callbackContext.memory,
					options: callbackContext.options,
				};
			case 'afterLLM':
				return callbackContext.response;
			case 'beforeTool':
				return callbackContext.toolInput;
			case 'afterTool':
				return callbackContext.toolOutput;
		}
	}

	try {
		ctx.logger.info(`🔄 Executing ${callbackType} callback`, {
			hasCode: !!callback.code?.trim(),
			codeLength: callback.code?.length || 0,
			itemIndex,
		});
		const sandbox = getSandboxForCallback(ctx, callback.code, itemIndex, callbackContext);
		const result = await sandbox.runCode();
		ctx.logger.info(`✅ ${callbackType} callback completed`, {
			resultType: typeof result,
			hasResult: !!result,
		});
		return result;
	} catch (error) {
		const errorMessage = `Error in ${callbackType} callback: ${(error as Error).message}`;
		if (!ctx.continueOnFail()) {
			throw new NodeOperationError(ctx.getNode(), errorMessage, { itemIndex });
		}
		ctx.logger.error(errorMessage, error);

		// Return original data on error based on callback type
		switch (callbackType) {
			case 'beforeLLM':
				return {
					input: callbackContext.input,
					systemMessage: callbackContext.systemMessage,
					tools: callbackContext.tools,
					memory: callbackContext.memory,
					options: callbackContext.options,
				};
			case 'afterLLM':
				return callbackContext.response;
			case 'beforeTool':
				return callbackContext.toolInput;
			case 'afterTool':
				return callbackContext.toolOutput;
		}
	}
}

// Helper function to get callback properties for node description
export function getCallbackProperties() {
	return [
		{
			displayName: 'Callbacks',
			name: 'callbacks',
			placeholder: 'Add Callback',
			type: 'fixedCollection' as const,
			noDataExpression: true,
			default: {},
			options: [
				{
					name: 'beforeLLM',
					displayName: 'Before LLM Call',
					values: [
						{
							displayName: 'JavaScript - Before LLM',
							name: 'code',
							type: 'string' as const,
							typeOptions: {
								editor: 'jsEditor' as const,
							},
							default: defaultCallbacks.beforeLLM,
							description:
								'Code to execute before calling the language model. Can modify input parameters.',
							noDataExpression: true,
						},
					],
				},
				{
					name: 'afterLLM',
					displayName: 'After LLM Response',
					values: [
						{
							displayName: 'JavaScript - After LLM',
							name: 'code',
							type: 'string' as const,
							typeOptions: {
								editor: 'jsEditor' as const,
							},
							default: defaultCallbacks.afterLLM,
							description: 'Code to execute after receiving LLM response. Can modify the response.',
							noDataExpression: true,
						},
					],
				},
				{
					name: 'beforeTool',
					displayName: 'Before Tool Call',
					values: [
						{
							displayName: 'JavaScript - Before Tool',
							name: 'code',
							type: 'string' as const,
							typeOptions: {
								editor: 'jsEditor' as const,
							},
							default: defaultCallbacks.beforeTool,
							description:
								'Code to execute before calling any tool. Can modify tool input parameters.',
							noDataExpression: true,
						},
					],
				},
				{
					name: 'afterTool',
					displayName: 'After Tool Response',
					values: [
						{
							displayName: 'JavaScript - After Tool',
							name: 'code',
							type: 'string' as const,
							typeOptions: {
								editor: 'jsEditor' as const,
							},
							default: defaultCallbacks.afterTool,
							description: 'Code to execute after tool response. Can filter or modify tool output.',
							noDataExpression: true,
						},
					],
				},
			],
		},
		{
			displayName:
				'You can use callbacks to modify parameters and responses at different stages. Debug by using <code>console.log()</code> statements and viewing their output in the browser console.',
			name: 'callbacksNotice',
			type: 'notice' as const,
			default: '',
		},
	];
}
