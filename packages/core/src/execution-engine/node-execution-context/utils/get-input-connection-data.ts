/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { DynamicStructuredTool, StructuredTool, Tool } from '@langchain/core/tools';
import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import z, { ZodType } from 'zod';
import type {
	AINodeConnectionType,
	ChatNodeMessageWithButtons,
	CloseFunction,
	GenericValue,
	IDataObject,
	IExecuteData,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeInputConfiguration,
	INodeType,
	IRunExecutionData,
	ISupplyDataFunctions,
	ITaskDataConnections,
	IWorkflowExecuteAdditionalData,
	NodeConnectionType,
	NodeOutput,
	SupplyData,
	Workflow,
	WorkflowExecuteMode,
} from 'n8n-workflow';
import {
	ApplicationError,
	ExecutionBaseError,
	NodeConnectionTypes,
	NodeOperationError,
	UserError,
	sleepWithAbort,
	isHitlToolType,
} from 'n8n-workflow';

import { StructuredToolkit, type SupplyDataToolResponse } from './ai-tool-types';
import { createNodeAsTool, getSchema } from './create-node-as-tool';
// eslint-disable-next-line import-x/no-cycle
import { ExecuteContext } from '../../node-execution-context/execute-context';
// eslint-disable-next-line import-x/no-cycle
import { SupplyDataContext } from '../../node-execution-context/supply-data-context';
import type { WebhookContext } from '../../node-execution-context/webhook-context';
import { isEngineRequest } from '../../requests-response';

// Node types that require enhanced ExecuteContext with full IExecuteFunctions capability
const NODE_TYPES_REQUIRING_ENHANCED_CONTEXT: readonly string[] = [
	'@n8n/n8n-nodes-langchain.darkAgentTool',
	'@n8n/n8n-nodes-langchain.toolDarkWorkflow',
	'@n8n/n8n-nodes-langchain.toolWorkflowExecutor',
];

/**
 * Checks if a node type requires enhanced context with full IExecuteFunctions methods
 */
function requiresEnhancedContext(nodeType: string): boolean {
	return NODE_TYPES_REQUIRING_ENHANCED_CONTEXT.includes(nodeType);
}

type EnhancedSupplyDataFunctions = ISupplyDataFunctions &
	Partial<
		Pick<
			IExecuteFunctions,
			| 'sendChunk'
			| 'sendResponse'
			| 'sendMessageToUI'
			| 'putExecutionToWait'
			| 'isStreaming'
			| 'getExecutionDataById'
			| 'addExecutionHints'
			| 'nodeHelpers'
			| 'helpers'
			| 'logger'
		>
	>;

/**
 * Normalize a value to an array.
 */
function ensureArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

export function createHitlToolkit(
	connectedToolsOrToolkits: SupplyDataToolResponse[] | SupplyDataToolResponse | undefined,
	hitlNode: INode,
) {
	const connectedTools = ensureArray(connectedToolsOrToolkits).flatMap((toolOrToolkit) => {
		if (toolOrToolkit instanceof StructuredToolkit) {
			return toolOrToolkit.tools;
		}
		return toolOrToolkit;
	});

	// toolParameters and tool are filled programmatically in createEngineRequests, don't need to be in the schema
	const hitlNodeSchema = getSchema(hitlNode).omit({ toolParameters: true, tool: true });
	// Wrap each tool: sourceNodeName routes to HITL node, gatedToolNodeName is the tool to execute after approval
	const gatedTools = connectedTools.map((tool) => {
		let schema = tool.schema;
		if (tool.schema instanceof ZodType) {
			schema = z.object({
				toolParameters: tool.schema.describe('Input parameters for the tool'),
				hitlParameters: hitlNodeSchema.describe('Parameters for the Human-in-the-Loop layer'),
			});
		}

		const gatedToolNodeName =
			typeof tool.metadata?.sourceNodeName === 'string' ? tool.metadata.sourceNodeName : undefined;

		return new DynamicStructuredTool({
			name: tool.name,
			description: tool.description,
			schema,
			func: async () => await Promise.resolve(''),
			metadata: {
				sourceNodeName: hitlNode.name,
				gatedToolNodeName,
				originalSchema: tool.schema,
			},
		});
	});

	const toolkit = new StructuredToolkit(gatedTools);
	return toolkit;
}

/**
 * Create supplyData for an HITL tool node.
 *
 * Agent sees gated tools directly but with sourceNodeName pointing to the HITL node.
 *
 * Flow:
 * 1. Agent calls gated tool -> EngineRequest routes to HITL node
 * 2. HITL executes sendAndWait -> waiting state
 * 3. User approves/denies via webhook
 * 4. If approved: new EngineRequest executes gated tool -> result to Agent
 * 5. If denied: denial message -> Agent knows not to retry
 */
export async function createHitlToolSupplyData(
	hitlNode: INode,
	workflow: Workflow,
	runExecutionData: IRunExecutionData,
	parentRunIndex: number,
	connectionInputData: INodeExecutionData[],
	parentInputData: ITaskDataConnections,
	additionalData: IWorkflowExecuteAdditionalData,
	executeData: IExecuteData,
	mode: WorkflowExecuteMode,
	closeFunctions: CloseFunction[],
	itemIndex: number,
	abortSignal?: AbortSignal,
	parentNode?: INode,
): Promise<SupplyData> {
	const context = new SupplyDataContext(
		workflow,
		hitlNode,
		additionalData,
		mode,
		runExecutionData,
		parentRunIndex,
		connectionInputData,
		parentInputData,
		NodeConnectionTypes.AiTool,
		executeData,
		closeFunctions,
		abortSignal,
		parentNode,
	);

	const connectedToolsOrToolkits = (await context.getInputConnectionData(
		NodeConnectionTypes.AiTool,
		itemIndex,
	)) as SupplyDataToolResponse[] | SupplyDataToolResponse | undefined;

	const toolkit = createHitlToolkit(connectedToolsOrToolkits, hitlNode);
	return { response: toolkit };
}

function getNextRunIndex(runExecutionData: IRunExecutionData, nodeName: string) {
	return runExecutionData.resultData.runData[nodeName]?.length ?? 0;
}

function containsBinaryData(nodeExecutionResult?: NodeOutput): boolean {
	if (isEngineRequest(nodeExecutionResult)) {
		return false;
	}

	if (nodeExecutionResult === undefined || nodeExecutionResult === null) {
		return false;
	}

	return nodeExecutionResult.some((outputBranch) => outputBranch.some((item) => item.binary));
}

function containsDataThatIsUsefulToTheAgent(nodeExecutionResult?: NodeOutput): boolean {
	if (isEngineRequest(nodeExecutionResult)) {
		return false;
	}

	if (nodeExecutionResult === undefined || nodeExecutionResult === null) {
		return false;
	}

	return nodeExecutionResult.some((outputBranch) =>
		outputBranch.some((item) => Object.keys(item.json).length > 0),
	);
}

/**
 * Filters out non-json items and reports if the result contained mixed
 * responses (e.g. json and binary).
 */
function mapResult(result?: NodeOutput) {
	let response:
		| string
		| Array<IDataObject | GenericValue | GenericValue[] | IDataObject[]>
		| undefined;
	let nodeHasMixedJsonAndBinaryData = false;
	let sendMessage: ChatNodeMessageWithButtons | string | undefined = undefined;

	if (result === undefined) {
		response = undefined;
	} else if (isEngineRequest(result)) {
		response =
			'Error: The Tool attempted to return an engine request, which is not supported in Agents';
	} else if (containsBinaryData(result) && !containsDataThatIsUsefulToTheAgent(result)) {
		response = 'Error: The Tool attempted to return binary data, which is not supported in Agents';
	} else {
		if (containsBinaryData(result)) {
			nodeHasMixedJsonAndBinaryData = true;
		}
		response = result?.[0]?.flatMap((item) => item.json);

		// Chat node always returns single item with sendMessage property
		// alongside json, this is used to send a bot message to the chat
		if (result?.[0]?.[0]?.sendMessage) {
			sendMessage = result?.[0]?.[0]?.sendMessage;
		}
	}

	return { response, nodeHasMixedJsonAndBinaryData, sendMessage };
}

export function makeHandleToolInvocation(
	contextFactory: (runIndex: number) => ISupplyDataFunctions,
	node: INode,
	nodeType: INodeType,
	runExecutionData: IRunExecutionData,
	executeContextFactory?: (runIndex: number) => IExecuteFunctions,
) {
	/**
	 * This keeps track of how many times this specific AI tool node has been invoked.
	 * It is incremented on every invocation of the tool to keep the output of each invocation separate from each other.
	 */
	// We get the runIndex from the context to handle multiple executions
	// of the same tool when the tool is used in a loop or in a parallel execution.
	let runIndex = getNextRunIndex(runExecutionData, node.name);

	return async (toolArgs: IDataObject) => {
		let maxTries = 1;
		if (node.retryOnFail === true) {
			maxTries = Math.min(5, Math.max(2, node.maxTries ?? 3));
		}

		let waitBetweenTries = 0;
		if (node.retryOnFail === true) {
			waitBetweenTries = Math.min(5000, Math.max(0, node.waitBetweenTries ?? 1000));
		}

		let lastError: NodeOperationError | undefined;

		for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
			// Increment the runIndex for the next invocation
			const localRunIndex = runIndex++;

			// Use ExecuteContext for nodes requiring full IExecuteFunctions
			const logger = Container.get(Logger);
			logger.info(`🚀 makeHandleToolInvocation for node: ${node.name} (type: ${node.type})`);

			let context: ISupplyDataFunctions | IExecuteFunctions;

			if (requiresEnhancedContext(node.type) && executeContextFactory) {
				logger.info(`✨ Creating hybrid context for ${node.name}`);

				// First create SupplyDataContext with all the necessary data and state
				const supplyContext = contextFactory(localRunIndex);
				logger.info(`📦 Created base SupplyDataContext with all data`);

				// Then create ExecuteContext with full IExecuteFunctions methods
				const executeContext = executeContextFactory(localRunIndex);
				logger.info(`⚡ Created ExecuteContext with full IExecuteFunctions capability`);

				context = supplyContext as unknown as IExecuteFunctions;
				enhanceContextWithExecuteFunctions(supplyContext, executeContext, node.name);

				logger.info(`🔄 Using hybrid context (SupplyData + ExecuteFunctions) for ${node.name}`);
			} else {
				logger.info(`📋 Using SupplyDataContext (ISupplyDataFunctions) for ${node.name}`);
				context = contextFactory(localRunIndex);
			}

			// Get abort signal from context for cancellation support
			const abortSignal = context.getExecutionCancelSignal?.();

			// Check if execution was cancelled before retry
			if (abortSignal?.aborted) {
				return 'Error during node execution: Execution was cancelled';
			}

			if (tryIndex !== 0) {
				// Reset error from previous attempt
				lastError = undefined;
				if (waitBetweenTries !== 0) {
					try {
						await sleepWithAbort(waitBetweenTries, abortSignal);
					} catch (abortError) {
						return 'Error during node execution: Execution was cancelled';
					}
				}
			}

			context.addInputData(NodeConnectionTypes.AiTool, [[{ json: toolArgs }]]);

			try {
				// Execute the sub-node with the proxied context
				logger.info(
					`🛠️ Executing Tool: ${node.name} with context type: ${context.constructor.name}`,
				);
				const result = await nodeType.execute?.call(context as unknown as IExecuteFunctions);
				logger.info(`✅ Tool execution completed: ${node.name}, hasResult: ${!!result}`);

				const { response, nodeHasMixedJsonAndBinaryData, sendMessage } = mapResult(result);
				logger.info(
					`📊 Tool result mapped: ${node.name}, responseType: ${typeof response}, hasBinaryData: ${nodeHasMixedJsonAndBinaryData}`,
				);

				// If the node returned some binary data, but also useful data we just log a warning instead of overriding the result
				if (nodeHasMixedJsonAndBinaryData) {
					context.logger.warn(
						`Response from Tool '${node.name}' included binary data, which is not supported in Agents. The binary data was omitted from the response.`,
					);
				}

				// Add output data to the context
				context.addOutputData(NodeConnectionTypes.AiTool, localRunIndex, [
					[{ json: { response }, sendMessage }],
				]);

				// Return the stringified results
				const jsonResponse = JSON.stringify(response);
				logger.info(
					`🎉 Tool execution success: ${node.name}, returning: ${jsonResponse?.substring(0, 100)}...`,
				);
				return jsonResponse;
			} catch (error) {
				logger.error(`❌ Tool execution error: ${node.name}`, {
					error: error.message,
					stack: error.stack,
				});
				// Check if error is due to cancellation
				if (abortSignal?.aborted) {
					throw new NodeOperationError(node, 'Execution was cancelled');
				}

				const nodeError = new NodeOperationError(node, error as Error);
				context.addOutputData(NodeConnectionTypes.AiTool, localRunIndex, nodeError);

				lastError = nodeError;

				// If this is the last attempt, throw the error to properly terminate execution
				if (tryIndex === maxTries - 1) {
					// Enhance the error with detailed information
					if (nodeError.description && !nodeError.message.includes(nodeError.description)) {
						nodeError.message = `${nodeError.message}\n\nDetails: ${nodeError.description}`;
					}
					throw nodeError;
				}
			}
		}

		// This should never be reached, but if it is, throw the error
		if (lastError) {
			if (lastError.description && !lastError.message.includes(lastError.description)) {
				lastError.message = `${lastError.message}\n\nDetails: ${lastError.description}`;
			}
			throw lastError;
		}

		throw new NodeOperationError(node, 'Unknown error during node execution');
	};
}

/**
 * Enhances a context with additional IExecuteFunctions methods from ExecuteContext
 * Used for nodes that require full execution capabilities (e.g., DarkAdvancedAgentTool)
 */
function enhanceContextWithExecuteFunctions(
	context: ISupplyDataFunctions,
	executeContext: IExecuteFunctions,
	nodeName: string,
): void {
	const logger = Container.get(Logger);
	const contextWithExecuteFunctions: EnhancedSupplyDataFunctions = context;

	// Core IExecuteFunctions methods
	contextWithExecuteFunctions.sendChunk = executeContext.sendChunk?.bind(executeContext);
	contextWithExecuteFunctions.sendResponse = executeContext.sendResponse?.bind(executeContext);
	contextWithExecuteFunctions.sendMessageToUI = executeContext.sendMessageToUI?.bind(executeContext);
	contextWithExecuteFunctions.putExecutionToWait = executeContext.putExecutionToWait?.bind(executeContext);
	contextWithExecuteFunctions.isStreaming = executeContext.isStreaming?.bind(executeContext);

	// Execution control methods
	contextWithExecuteFunctions.getExecutionDataById = executeContext.getExecutionDataById?.bind(executeContext);
	contextWithExecuteFunctions.addExecutionHints = executeContext.addExecutionHints?.bind(executeContext);

	// Node helper methods (if different from supplyContext)
	if (
		executeContext.nodeHelpers &&
		executeContext.nodeHelpers !== contextWithExecuteFunctions.nodeHelpers
	) {
		contextWithExecuteFunctions.nodeHelpers = executeContext.nodeHelpers;
	}

	// Helper functions enhancement
	if (executeContext.helpers) {
		contextWithExecuteFunctions.helpers = {
			...contextWithExecuteFunctions.helpers,
			...executeContext.helpers,
		};
	}

	if (executeContext.logger) {
		contextWithExecuteFunctions.logger = executeContext.logger;
	}

	logger.info(`🔧 Enhanced context with additional IExecuteFunctions methods for ${nodeName}`);
}

function validateInputConfiguration(
	context: ExecuteContext | WebhookContext | SupplyDataContext,
	connectionType: NodeConnectionType,
	nodeInputs: INodeInputConfiguration[],
	connectedNodes: INode[],
) {
	const parentNode = context.getNode();

	const connections = context.getConnections(parentNode, connectionType);

	// Validate missing required connections
	for (let index = 0; index < nodeInputs.length; index++) {
		const inputConfiguration = nodeInputs[index];

		if (inputConfiguration.required) {
			// For required inputs, we need at least one enabled connected node
			if (
				connections.length === 0 ||
				connections.length <= index ||
				connections.at(index)?.length === 0 ||
				!connectedNodes.find((node) =>
					connections
						.at(index)
						?.map((value) => value.node)
						.includes(node.name),
				)
			) {
				throw new NodeOperationError(
					parentNode,
					`A ${inputConfiguration?.displayName ?? connectionType} sub-node must be connected and enabled`,
				);
			}
		}
	}
}

// Extends metadata for tools and toolkits to include the source node name that is used for HITL routing
export function extendResponseMetadata(response: unknown, connectedNode: INode) {
	// Ensure sourceNodeName is set for proper routing
	if (response instanceof StructuredTool || response instanceof Tool) {
		response.metadata ??= {};
		response.metadata.sourceNodeName = connectedNode.name;
	}

	if (response instanceof StructuredToolkit) {
		for (const tool of response.tools) {
			tool.metadata ??= {};
			tool.metadata.sourceNodeName = connectedNode.name;
		}
	}
}

export async function getInputConnectionData(
	this: ExecuteContext | WebhookContext | SupplyDataContext,
	workflow: Workflow,
	runExecutionData: IRunExecutionData,
	parentRunIndex: number,
	connectionInputData: INodeExecutionData[],
	parentInputData: ITaskDataConnections,
	additionalData: IWorkflowExecuteAdditionalData,
	executeData: IExecuteData,
	mode: WorkflowExecuteMode,
	closeFunctions: CloseFunction[],
	connectionType: AINodeConnectionType,
	itemIndex: number,
	abortSignal?: AbortSignal,
): Promise<unknown> {
	const parentNode = this.getNode();
	const inputConfigurations = this.nodeInputs.filter((input) => input.type === connectionType);

	if (inputConfigurations === undefined || inputConfigurations.length === 0) {
		throw new UserError('Node does not have input of type', {
			extra: { nodeName: parentNode.name, connectionType },
		});
	}

	const maxConnections = inputConfigurations.reduce(
		(acc, currentItem) =>
			currentItem.maxConnections !== undefined ? acc + currentItem.maxConnections : acc,
		0,
	);

	const connectedNodes = this.getConnectedNodes(connectionType);
	validateInputConfiguration(this, connectionType, inputConfigurations, connectedNodes);

	// Nothing is connected or required
	if (connectedNodes.length === 0) {
		return maxConnections === 1 ? undefined : [];
	}

	// Too many connections
	if (
		maxConnections !== undefined &&
		maxConnections !== 0 &&
		connectedNodes.length > maxConnections
	) {
		throw new NodeOperationError(
			parentNode,
			`Only ${maxConnections} ${connectionType} sub-nodes are/is allowed to be connected`,
		);
	}

	const nodes: SupplyData[] = [];
	for (const connectedNode of connectedNodes) {
		// Check if this is an HITL (Human-in-the-Loop) tool node
		// HITL tools need special handling to create the middleware tool
		if (isHitlToolType(connectedNode?.type)) {
			const supplyData = await createHitlToolSupplyData(
				connectedNode,
				workflow,
				runExecutionData,
				parentRunIndex,
				connectionInputData,
				parentInputData,
				additionalData,
				executeData,
				mode,
				closeFunctions,
				itemIndex,
				abortSignal,
				parentNode,
			);
			nodes.push(supplyData);
			continue;
		}

		const connectedNodeType = workflow.nodeTypes.getByNameAndVersion(
			connectedNode.type,
			connectedNode.typeVersion,
		);
		const contextFactory = (runIndex: number, inputData: ITaskDataConnections) =>
			new SupplyDataContext(
				workflow,
				connectedNode,
				additionalData,
				mode,
				runExecutionData,
				runIndex,
				connectionInputData,
				inputData,
				connectionType,
				executeData,
				closeFunctions,
				abortSignal,
				parentNode,
			);

		// Create ExecuteContext factory for nodes requiring enhanced context
		const logger = Container.get(Logger);
		logger.info(`🔍 Node type: ${connectedNode.type}, name: ${connectedNode.name}`);
		const executeContextFactory = requiresEnhancedContext(connectedNode.type)
			? (runIndex: number) => {
					logger.info(`✅ Creating ExecuteContext for ${connectedNode.name}`);
					const execContext = new ExecuteContext(
						workflow,
						connectedNode,
						additionalData,
						mode,
						runExecutionData,
						runIndex,
						connectionInputData,
						{}, // inputData
						executeData,
						closeFunctions,
						abortSignal,
					);
					logger.info(`✅ ExecuteContext CREATED for ${connectedNode.name}`);
					return execContext;
				}
			: undefined;
		if (executeContextFactory) {
			logger.info(`🎯 ExecuteContextFactory created for ${connectedNode.name}`);
		} else {
			logger.info(`📦 Using standard SupplyDataContext for ${connectedNode.name}`);
		}

		if (!connectedNodeType.supplyData) {
			if (connectedNodeType.description.outputs.includes(NodeConnectionTypes.AiTool)) {
				const supplyData = createNodeAsTool({
					node: connectedNode,
					nodeType: connectedNodeType,
					handleToolInvocation: makeHandleToolInvocation(
						(i) => contextFactory(i, {}),
						connectedNode,
						connectedNodeType,
						runExecutionData,
						executeContextFactory,
					),
				});
				nodes.push(supplyData);
			} else {
				throw new ApplicationError('Node does not have a `supplyData` method defined', {
					extra: { nodeName: connectedNode.name },
				});
			}
		} else {
			let context = contextFactory(parentRunIndex, parentInputData);

			// Enhanced context for nodes requiring full IExecuteFunctions with supplyData
			if (requiresEnhancedContext(connectedNode.type) && executeContextFactory) {
				logger.info(
					`✨ Creating hybrid context for ${connectedNode.type} with supplyData: ${connectedNode.name}`,
				);

				// Create ExecuteContext with full IExecuteFunctions methods
				const executeContext = executeContextFactory(parentRunIndex);
				logger.info(
					`⚡ Created ExecuteContext with full IExecuteFunctions capability for supplyData`,
				);

				enhanceContextWithExecuteFunctions(context, executeContext, connectedNode.name);
			}

			try {
				const supplyData = await connectedNodeType.supplyData.call(context, itemIndex);
				const response = supplyData.response;

				extendResponseMetadata(response, connectedNode);

				if (supplyData.closeFunction) {
					closeFunctions.push(supplyData.closeFunction);
				}
				// Add hints from context to supply data
				if (context.hints.length > 0) {
					supplyData.hints = context.hints;
				}
				nodes.push(supplyData);
			} catch (error) {
				// Propagate errors from sub-nodes
				if (error instanceof ExecutionBaseError) {
					if (error.functionality === 'configuration-node') throw error;
				} else {
					error = new NodeOperationError(connectedNode, error, {
						itemIndex,
					});
				}

				let currentNodeRunIndex = 0;
				if (runExecutionData.resultData.runData.hasOwnProperty(parentNode.name)) {
					currentNodeRunIndex = runExecutionData.resultData.runData[parentNode.name].length;
				}

				// Display the error on the node which is causing it
				await context.addExecutionDataFunctions(
					'input',
					error,
					connectionType,
					parentNode.name,
					currentNodeRunIndex,
				);

				await context.addExecutionDataFunctions(
					'output',
					error,
					connectionType,
					parentNode.name,
					currentNodeRunIndex,
				);

				// Display on the calling node which node has the error
				throw new NodeOperationError(connectedNode, `Error in sub-node ${connectedNode.name}`, {
					itemIndex,
					functionality: 'configuration-node',
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
					description: error.message,
				});
			}
		}
	}

	return maxConnections === 1 ? (nodes || [])[0]?.response : nodes.map((node) => node.response);
}
