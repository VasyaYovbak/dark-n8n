import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';
import { DynamicStructuredTool, DynamicTool } from '@langchain/core/tools';
import type {
	INodeTypeBaseDescription,
	ISupplyDataFunctions,
	SupplyData,
	INodeType,
	INodeTypeDescription,
	INodeExecutionData,
	IDataObject,
	IWorkflowBase,
	IExecuteWorkflowInfo,
	ExecuteWorkflowData,
	Workflow,
	ITaskMetadata,
} from 'n8n-workflow';
import {
	NodeOperationError,
	NodeConnectionTypes,
	jsonParse,
	jsonStringify,
	nodeNameToToolName,
} from 'n8n-workflow';
import { z } from 'zod';

import { versionDescription } from './versionDescription';

export class ToolWorkflowExecutorV1 implements INodeType {
	description: INodeTypeDescription;

	constructor(baseDescription: INodeTypeBaseDescription) {
		this.description = {
			...baseDescription,
			...versionDescription,
		};
	}

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const node = this.getNode();
		// Use nodeNameToToolName to create valid tool name (alphanumeric with underscores/dashes only)
		const name = nodeNameToToolName(node);
		const description = this.getNodeParameter('toolDescription', itemIndex) as string;
		const parametersType = this.getNodeParameter('parametersType', itemIndex, 'none') as string;

		// Store parent context for later use in tool execution
		// This preserves enhanced methods like sendChunk, sendResponse, etc.
		const parentContext = this;

		if (parametersType === 'fields') {
			// Get parameters from fixedCollection
			const parametersData = this.getNodeParameter(
				'parameters.parameters',
				itemIndex,
				[],
			) as Array<{
				name: string;
				description: string;
				type: string;
				valueSource: string;
				value?: string;
				required: boolean;
			}>;

			if (parametersData.length === 0) {
				throw new NodeOperationError(
					node,
					'Parameters type is set to "Define Parameters" but no parameters are defined',
					{ itemIndex },
				);
			}

			// Separate AI parameters from predefined parameters
			const aiParameters = parametersData.filter((p) => p.valueSource === 'ai');
			const predefinedParametersConfig = parametersData.filter((p) => p.valueSource === 'define');

			// Build Zod schema only for AI parameters
			const zodSchema: Record<string, z.ZodTypeAny> = {};

			for (const param of aiParameters) {
				if (!param.name) {
					throw new NodeOperationError(node, 'Parameter name cannot be empty', { itemIndex });
				}

				let fieldSchema: z.ZodTypeAny;

				switch (param.type) {
					case 'string':
						fieldSchema = z.string();
						break;
					case 'number':
						fieldSchema = z.number();
						break;
					case 'boolean':
						fieldSchema = z.boolean();
						break;
					case 'array':
						fieldSchema = z.array(z.any());
						break;
					case 'object':
						fieldSchema = z.object({}).passthrough();
						break;
					default:
						fieldSchema = z.any();
				}

				if (param.description) {
					fieldSchema = fieldSchema.describe(param.description);
				}

				zodSchema[param.name] = param.required ? fieldSchema : fieldSchema.optional();
			}

			const schema = z.object(zodSchema);

			// Create structured tool with schema
			const tool = new DynamicStructuredTool({
				name,
				description,
				schema,
				func: async (input: IDataObject, _runManager?: CallbackManagerForToolRun) => {
					// Evaluate predefined parameters NOW, while we still have access to parent context
					const predefinedParameters: Record<string, any> = {};
					for (const param of predefinedParametersConfig) {
						if (!param.name) continue;

						const rawValue = param.value || '';

						// Try to evaluate expressions using parent context
						try {
							// Evaluate the expression
							// This gives access to $node, $json, $input from parent workflow
							const evaluatedValue = parentContext.evaluateExpression(rawValue, itemIndex);
							predefinedParameters[param.name] = evaluatedValue;
						} catch (error) {
							// If evaluation fails, use raw value
							// This might happen if the value is not an expression
							predefinedParameters[param.name] = rawValue;
						}
					}

					// Merge predefined parameters with AI input (AI params take precedence)
					const mergedInput = { ...predefinedParameters, ...input };

					// Call the execute method with the merged input data
					return await executeToolWorkflow(parentContext, mergedInput, itemIndex);
				},
			});

			return { response: tool };
		} else if (parametersType === 'jsonSchema') {
			const jsonSchemaString = this.getNodeParameter('jsonSchema', itemIndex, '') as string;
			if (!jsonSchemaString) {
				throw new NodeOperationError(node, 'JSON Schema is enabled but no schema provided', {
					itemIndex,
				});
			}

			let schema: z.ZodObject<any>;
			try {
				const jsonSchema = jsonParse<IDataObject>(jsonSchemaString);
				const zodSchema: Record<string, z.ZodTypeAny> = {};

				// Convert JSON schema to Zod schema
				if (jsonSchema.properties && typeof jsonSchema.properties === 'object') {
					for (const [key, prop] of Object.entries(jsonSchema.properties)) {
						const property = prop as IDataObject;
						let fieldSchema: z.ZodTypeAny;

						switch (property.type) {
							case 'string':
								fieldSchema = z.string();
								break;
							case 'number':
								fieldSchema = z.number();
								break;
							case 'boolean':
								fieldSchema = z.boolean();
								break;
							case 'array':
								fieldSchema = z.array(z.any());
								break;
							case 'object':
								fieldSchema = z.object({}).passthrough();
								break;
							default:
								fieldSchema = z.any();
						}

						if (property.description) {
							fieldSchema = fieldSchema.describe(property.description as string);
						}

						// Check if field is required
						const requiredFields = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
						const isRequired = requiredFields.some((req) => String(req) === key);

						zodSchema[key] = isRequired ? fieldSchema : fieldSchema.optional();
					}
				}

				schema = z.object(zodSchema);
			} catch (error) {
				throw new NodeOperationError(
					node,
					`Failed to parse JSON schema: ${(error as Error).message}`,
					{ itemIndex },
				);
			}

			// Create structured tool with schema
			const tool = new DynamicStructuredTool({
				name,
				description,
				schema,
				func: async (input: IDataObject, _runManager?: CallbackManagerForToolRun) => {
					// Call the execute method with the input data
					return await executeToolWorkflow(parentContext, input, itemIndex);
				},
			});

			return { response: tool };
		} else {
			// No parameters - create simple tool without schema
			const tool = new DynamicTool({
				name,
				description,
				func: async (query: string, _runManager?: CallbackManagerForToolRun) => {
					// Call the execute method with the query
					return await executeToolWorkflow(parentContext, { query }, itemIndex);
				},
			});

			return { response: tool };
		}
	}
}

/**
 * Executes the downstream workflow by creating a sub-workflow with Execute Workflow Trigger
 * This is called when the AI agent invokes the tool
 */
async function executeToolWorkflow(
	context: ISupplyDataFunctions,
	input: IDataObject | { query: string },
	_itemIndex: number = 0,
): Promise<string> {
	try {
		const node = context.getNode();
		const runIndex = context.getNextRunIndex();
		const workflowProxy = context.getWorkflowDataProxy(0);

		// Access the full Workflow object through internal API
		const workflow = (context as any).workflow as Workflow;
		if (!workflow) {
			throw new NodeOperationError(node, 'Could not access workflow object');
		}

		// Create input data for workflow execution
		// Don't add __toolMetadata as it might cause issues with downstream nodes
		const inputData: INodeExecutionData[] = [
			{
				json: input,
			},
		];

		// Get connections from this node's Main output
		const connections = workflow.connectionsBySourceNode[node.name];
		if (
			!connections ||
			!connections.main ||
			!connections.main[0] ||
			connections.main[0].length === 0
		) {
			// No downstream nodes - just return the input
			return jsonStringify({
				success: true,
				message: `Tool "${node.name}" executed (no downstream nodes connected)`,
				data: input,
			});
		}

		// Get all downstream node names starting from our Main output
		const firstDownstreamNodeName = connections.main[0][0].node;

		// Collect all reachable nodes from the first downstream node
		// This includes Main connections AND all AI/dependency connections
		const reachableNodes = new Set<string>();
		const nodesToProcess = [firstDownstreamNodeName];

		while (nodesToProcess.length > 0) {
			const currentNodeName = nodesToProcess.pop()!;
			if (reachableNodes.has(currentNodeName)) continue;

			reachableNodes.add(currentNodeName);

			// Use workflow.getChildNodes to get ALL connected nodes (including AI connections)
			// This will include Chat Models, Tools, Vector Stores, etc.
			const childNodes = workflow.getChildNodes(currentNodeName, 'ALL_NON_MAIN', -1);
			for (const childNode of childNodes) {
				if (!reachableNodes.has(childNode)) {
					nodesToProcess.push(childNode);
				}
			}

			// Also add Main output connections
			const nodeConnections = workflow.connectionsBySourceNode[currentNodeName];
			if (nodeConnections?.main) {
				for (const outputConnections of nodeConnections.main) {
					if (outputConnections) {
						for (const connection of outputConnections) {
							if (!reachableNodes.has(connection.node)) {
								nodesToProcess.push(connection.node);
							}
						}
					}
				}
			}
		}

		// Create Execute Workflow Trigger as entry point
		const triggerNodeName = '__trigger__';
		const triggerNode = {
			id: triggerNodeName,
			name: triggerNodeName,
			type: 'n8n-nodes-base.executeWorkflowTrigger',
			typeVersion: 1,
			position: [0, 0] as [number, number],
			parameters: {},
		};

		// Collect all nodes we need (no virtual node, just trigger + downstream)
		const workflowNodes = [
			triggerNode,
			...Array.from(reachableNodes).map((nodeName) => workflow.nodes[nodeName]),
		];

		// Create connections object
		const workflowConnections: IWorkflowBase['connections'] = {
			// Connect trigger directly to first downstream node
			[triggerNodeName]: {
				main: [[{ node: firstDownstreamNodeName, type: NodeConnectionTypes.Main, index: 0 }]],
			},
		};

		// Copy ALL connections for all reachable nodes
		// This includes Main, AI connections (languageModel, tool, memory, etc.)
		for (const nodeName of reachableNodes) {
			const nodeConnections = workflow.connectionsBySourceNode[nodeName];
			if (nodeConnections) {
				workflowConnections[nodeName] = nodeConnections;
			}
		}

		// Also check connectionsByDestinationNode to capture all incoming connections
		// This ensures AI sub-nodes (Chat Models, Tools, etc.) are properly connected
		for (const nodeName of reachableNodes) {
			const incomingConnections = workflow.connectionsByDestinationNode[nodeName];
			if (incomingConnections) {
				// These are already captured in connectionsBySourceNode, but we iterate
				// to ensure we don't miss any nodes that are only destinations
				for (const connections of Object.values(incomingConnections)) {
					for (const connectionList of Object.values(connections)) {
						if (!connectionList) continue;
						for (const connection of connectionList) {
							const sourceNodeName = connection.node;
							// Make sure source node is included
							if (!reachableNodes.has(sourceNodeName)) {
								reachableNodes.add(sourceNodeName);
								// Add its connections too
								const sourceNodeConnections = workflow.connectionsBySourceNode[sourceNodeName];
								if (sourceNodeConnections) {
									workflowConnections[sourceNodeName] = sourceNodeConnections;
								}
								// Add the node itself to the nodes list
								workflowNodes.push(workflow.nodes[sourceNodeName]);
							}
						}
					}
				}
			}
		}

		// Create minimal workflow
		const now = new Date();
		const minimalWorkflow: IWorkflowBase = {
			id: workflowProxy.$workflow.id,
			name: `${workflow.name} (Tool Execution)`,
			active: false,
			nodes: workflowNodes,
			connections: workflowConnections,
			settings: workflow.settings,
			isArchived: false,
			createdAt: now,
			updatedAt: now,
		};

		const workflowInfo: IExecuteWorkflowInfo = {
			code: minimalWorkflow,
		};

		// Execute the sub-workflow with parent context methods propagation
		let receivedData: ExecuteWorkflowData;
		try {
			// CRITICAL: Intercept additionalData.sendDataToUI to redirect UI events to parent execution
			const contextAny = context as any;
			const parentMethods = contextAny;

			// Check if parent context has enhanced methods to propagate
			const hasEnhancedMethods =
				typeof parentMethods.sendChunk === 'function' ||
				typeof parentMethods.sendResponse === 'function' ||
				typeof parentMethods.sendMessageToUI === 'function';

			// Store original methods to restore later
			const originalExecuteWorkflow = contextAny.additionalData?.executeWorkflow;

			// Get pushRef from parent execution for UI tracking
			const hooksAny = contextAny.additionalData?.hooks as any;
			const pushRef = hooksAny?.pushRef as string | undefined;

			// Also wrap executeWorkflow to inject parent methods and pushRef
			if (originalExecuteWorkflow && (hasEnhancedMethods || pushRef)) {
				contextAny.additionalData.executeWorkflow = async function (
					workflowInfo: any,
					additionalData: any,
					options: any,
				) {
					// Create a wrapped additionalData that will propagate our methods and pushRef
					const wrappedAdditionalData = {
						...additionalData,
						// Propagate pushRef to enable UI tracking in sub-workflow
						pushRef: pushRef || additionalData.pushRef,
						// Store parent methods reference so they can be accessed in the new execution
						_parentMethods: {
							sendChunk: parentMethods.sendChunk?.bind(parentMethods),
							sendResponse: parentMethods.sendResponse?.bind(parentMethods),
							sendMessageToUI: (...args: any[]) => {
								try {
									return parentMethods.sendMessageToUI.call(parentMethods, ...args);
								} catch (error) {
									// Fail silently
								}
							},
							putExecutionToWait: parentMethods.putExecutionToWait?.bind(parentMethods),
							isStreaming: parentMethods.isStreaming?.bind(parentMethods),
							getExecutionDataById: parentMethods.getExecutionDataById?.bind(parentMethods),
							addExecutionHints: parentMethods.addExecutionHints?.bind(parentMethods),
						},
					};

					// Call original executeWorkflow with wrapped additionalData
					const result = await originalExecuteWorkflow.call(
						this,
						workflowInfo,
						wrappedAdditionalData,
						options,
					);

					return result;
				};
			}

			receivedData = await context.executeWorkflow(workflowInfo, inputData, undefined, {
				parentExecution: {
					executionId: workflowProxy.$execution.id,
					workflowId: workflowProxy.$workflow.id,
				},
			});

			// Restore original methods
			if (originalExecuteWorkflow) {
				contextAny.additionalData.executeWorkflow = originalExecuteWorkflow;
			}
		} catch (error) {
			throw new NodeOperationError(node, error as Error);
		}

		// Add output data to track execution with sub-execution metadata
		// This links the sub-workflow execution to the parent and enables UI highlighting
		let metadata: ITaskMetadata | undefined;
		if (receivedData.executionId && workflowProxy.$workflow.id) {
			metadata = {
				subExecution: {
					executionId: receivedData.executionId,
					workflowId: workflowProxy.$workflow.id,
				},
			};
		}

		// Add output data for AiTool connection
		void context.addOutputData(
			NodeConnectionTypes.AiTool,
			runIndex,
			[receivedData?.data?.[0] ?? []],
			metadata,
		);

		// IMPORTANT: Also add output data for Main connection to make the node visible in execution
		// This allows downstream nodes to reference this node's data via $node["ToolWorkflowExecutor"]
		void context.addOutputData(
			NodeConnectionTypes.Main,
			runIndex,
			[inputData], // Wrap in array as addOutputData expects INodeExecutionData[][]
			metadata,
		);

		// Extract the response from the workflow execution
		const responseData = receivedData?.data?.[0]?.[0]?.json;
		if (responseData === undefined) {
			throw new NodeOperationError(
				node,
				'There was an error: "The workflow did not return a response"',
			);
		}

		// Format response for the agent
		if (typeof responseData === 'string') {
			return responseData;
		}

		return jsonStringify(responseData);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return jsonStringify({
			success: false,
			error: errorMessage,
		});
	}
}
