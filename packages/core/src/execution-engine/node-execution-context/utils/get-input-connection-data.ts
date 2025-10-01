/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type {
	CloseFunction,
	IExecuteData,
	IExecuteFunctions,
	INodeExecutionData,
	IRunExecutionData,
	ITaskDataConnections,
	IWorkflowExecuteAdditionalData,
	Workflow,
	WorkflowExecuteMode,
	SupplyData,
	AINodeConnectionType,
	IDataObject,
	ISupplyDataFunctions,
	INodeType,
	INode,
	INodeInputConfiguration,
	NodeConnectionType,
	NodeOutput,
	GenericValue,
} from 'n8n-workflow';
import {
	NodeConnectionTypes,
	NodeOperationError,
	ExecutionBaseError,
	ApplicationError,
	UserError,
	sleepWithAbort,
} from 'n8n-workflow';
import { Container } from '@n8n/di';
import { Logger } from '@n8n/backend-common';

import { createNodeAsTool } from './create-node-as-tool';
import type { WebhookContext } from '../../node-execution-context';
// eslint-disable-next-line import-x/no-cycle
import { SupplyDataContext } from '../../node-execution-context/supply-data-context';
// eslint-disable-next-line import-x/no-cycle
import { ExecuteContext } from '../../node-execution-context/execute-context';
import { isEngineRequest } from '../../requests-response';

// Node types that require enhanced ExecuteContext with full IExecuteFunctions capability
const NODE_TYPES_REQUIRING_ENHANCED_CONTEXT = [
	'@n8n/n8n-nodes-langchain.darkAgentTool',
	'@n8n/n8n-nodes-langchain.toolDarkWorkflow',
] as const;

/**
 * Checks if a node type requires enhanced context with full IExecuteFunctions methods
 */
function requiresEnhancedContext(nodeType: string): boolean {
	return NODE_TYPES_REQUIRING_ENHANCED_CONTEXT.includes(nodeType as any);
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
	}

	return { response, nodeHasMixedJsonAndBinaryData };
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

				const { response, nodeHasMixedJsonAndBinaryData } = mapResult(result);
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
					[{ json: { response } }],
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
					return 'Error during node execution: Execution was cancelled';
				}

				const nodeError = new NodeOperationError(node, error as Error);
				context.addOutputData(NodeConnectionTypes.AiTool, localRunIndex, nodeError);

				lastError = nodeError;

				// If this is the last attempt, throw the error
				if (tryIndex === maxTries - 1) {
					return 'Error during node execution: ' + (nodeError.description ?? nodeError.message);
				}
			}
		}

		return 'Error during node execution : ' + (lastError?.description ?? lastError?.message);
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
	const contextAny = context as any;

	// Core IExecuteFunctions methods
	contextAny.sendChunk = executeContext.sendChunk?.bind(executeContext);
	contextAny.sendResponse = executeContext.sendResponse?.bind(executeContext);
	contextAny.sendMessageToUI = executeContext.sendMessageToUI?.bind(executeContext);
	contextAny.putExecutionToWait = executeContext.putExecutionToWait?.bind(executeContext);
	contextAny.isStreaming = executeContext.isStreaming?.bind(executeContext);

	// Execution control methods
	contextAny.getExecutionDataById = executeContext.getExecutionDataById?.bind(executeContext);
	contextAny.addExecutionHints = executeContext.addExecutionHints?.bind(executeContext);

	// Node helper methods (if different from supplyContext)
	if (executeContext.nodeHelpers && executeContext.nodeHelpers !== contextAny.nodeHelpers) {
		contextAny.nodeHelpers = executeContext.nodeHelpers;
	}

	// Helper functions enhancement
	if (executeContext.helpers) {
		contextAny.helpers = {
			...contextAny.helpers,
			...executeContext.helpers,
		};
	}

	if (executeContext.logger) {
		contextAny.logger = executeContext.logger;
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
				if (supplyData.closeFunction) {
					closeFunctions.push(supplyData.closeFunction);
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
