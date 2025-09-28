import type { AgentExecutor } from 'langchain/agents';
import type { IExecuteFunctions, ISupplyDataFunctions } from 'n8n-workflow';
import { executeCallback } from './callbacks';

export class CallbackEnabledAgentExecutor {
	private executor: AgentExecutor;
	private ctx: IExecuteFunctions | ISupplyDataFunctions;
	private itemIndex: number;

	constructor(
		executor: AgentExecutor,
		ctx: IExecuteFunctions | ISupplyDataFunctions,
		itemIndex: number,
	) {
		this.executor = executor;
		this.ctx = ctx;
		this.itemIndex = itemIndex;
	}

	/**
	 * Wraps all tools with beforeTool and afterTool callbacks
	 */
	public static wrapToolsWithCallbacks(
		tools: any[],
		ctx: IExecuteFunctions | ISupplyDataFunctions,
		itemIndex: number,
	): any[] {
		return tools.map((tool) => {
			const originalInvoke = tool.invoke?.bind(tool);
			const originalCall = tool._call?.bind(tool);
			const originalRun = tool.run?.bind(tool);

			const createWrappedMethod = (originalMethod: any) => {
				if (!originalMethod) return undefined;

				return async (input: any, config?: any) => {
					// Execute beforeTool callback
					const modifiedInput = await executeCallback(ctx, 'beforeTool', itemIndex, {
						toolName: tool.name,
						toolInput: input,
						allTools: tools,
					});

					// Call the original method with modified input
					const toolOutput = await originalMethod(modifiedInput, config);

					// Execute afterTool callback
					const modifiedOutput = await executeCallback(ctx, 'afterTool', itemIndex, {
						toolName: tool.name,
						toolInput: modifiedInput,
						toolOutput,
						allTools: tools,
					});

					return modifiedOutput;
				};
			};

			// Copy all properties from original tool
			const wrappedTool = Object.create(Object.getPrototypeOf(tool));
			Object.assign(wrappedTool, tool);

			// Wrap all possible methods that LangChain might use
			if (originalInvoke) wrappedTool.invoke = createWrappedMethod(originalInvoke);
			if (originalCall) wrappedTool._call = createWrappedMethod(originalCall);
			if (originalRun) wrappedTool.run = createWrappedMethod(originalRun);

			return wrappedTool;
		});
	}

	/**
	 * Wraps a tool with beforeTool and afterTool callbacks
	 */
	public wrapToolWithCallbacks(tool: any, originalTools: any[]): any {
		const originalInvoke = tool.invoke?.bind(tool);
		const originalCall = tool._call?.bind(tool);
		const originalRun = tool.run?.bind(tool);

		const createWrappedMethod = (originalMethod: any) => {
			if (!originalMethod) return undefined;

			return async (input: any, config?: any) => {
				// Execute beforeTool callback
				const modifiedInput = await executeCallback(this.ctx, 'beforeTool', this.itemIndex, {
					toolName: tool.name,
					toolInput: input,
					allTools: originalTools,
				});

				// Call the original method with modified input
				const toolOutput = await originalMethod(modifiedInput, config);

				// Execute afterTool callback
				const modifiedOutput = await executeCallback(this.ctx, 'afterTool', this.itemIndex, {
					toolName: tool.name,
					toolInput: modifiedInput,
					toolOutput,
					allTools: originalTools,
				});

				return modifiedOutput;
			};
		};

		// Copy all properties from original tool
		const wrappedTool = Object.create(Object.getPrototypeOf(tool));
		Object.assign(wrappedTool, tool);

		// Wrap all possible methods that LangChain might use
		if (originalInvoke) wrappedTool.invoke = createWrappedMethod(originalInvoke);
		if (originalCall) wrappedTool._call = createWrappedMethod(originalCall);
		if (originalRun) wrappedTool.run = createWrappedMethod(originalRun);

		return wrappedTool;
	}

	async invoke(params: any, options?: any): Promise<any> {
		this.ctx.logger.info('🔧 CallbackEnabledAgentExecutor.invoke started', {
			input: params.input,
			hasTools: this.executor.tools?.length > 0,
			toolsCount: this.executor.tools?.length || 0,
			executionMode: this.ctx.getMode(),
		});

		// Execute beforeLLM callback
		const modifiedParams = await executeCallback(this.ctx, 'beforeLLM', this.itemIndex, {
			input: params.input,
			systemMessage: params.system_message,
			tools: this.executor.tools,
			memory: this.executor.memory,
			options: params,
		});

		// Update params with callback result
		const updatedParams = {
			...params,
			input: modifiedParams.input || params.input,
			system_message: modifiedParams.systemMessage || params.system_message,
		};

		// Tools are already wrapped in execute.ts, so we don't need to wrap them again
		this.ctx.logger.info('🚀 CallbackEnabledAgentExecutor: Calling base executor.invoke');
		// Execute the agent with modified parameters
		const response = await this.executor.invoke(updatedParams, options);
		this.ctx.logger.info('✅ CallbackEnabledAgentExecutor: Base executor completed', {
			hasOutput: !!response?.output,
			responseType: typeof response,
		});

		// Execute afterLLM callback
		const modifiedResponse = await executeCallback(this.ctx, 'afterLLM', this.itemIndex, {
			response,
			originalInput: params.input,
			tools: this.executor.tools,
			memory: this.executor.memory,
		});

		return modifiedResponse;
	}

	async streamEvents(params: any, options?: any): Promise<any> {
		this.ctx.logger.info('🌊 CallbackEnabledAgentExecutor.streamEvents started', {
			input: params.input,
			hasTools: this.executor.tools?.length > 0,
			toolsCount: this.executor.tools?.length || 0,
			executionMode: this.ctx.getMode(),
		});

		// Execute beforeLLM callback
		const modifiedParams = await executeCallback(this.ctx, 'beforeLLM', this.itemIndex, {
			input: params.input,
			systemMessage: params.system_message,
			tools: this.executor.tools,
			memory: this.executor.memory,
			options: params,
		});

		// Update params with callback result
		const updatedParams = {
			...params,
			input: modifiedParams.input || params.input,
			system_message: modifiedParams.systemMessage || params.system_message,
		};

		// Tools are already wrapped in execute.ts, so we don't need to wrap them again
		this.ctx.logger.info('🌊 CallbackEnabledAgentExecutor: Calling base executor.streamEvents');
		// Execute the agent with modified parameters and return the stream
		// Note: afterLLM callback should be handled in the processEventStream function
		const eventStream = this.executor.streamEvents(updatedParams, options);
		this.ctx.logger.info('🌊 CallbackEnabledAgentExecutor: StreamEvents initiated');
		return eventStream;
	}
}
