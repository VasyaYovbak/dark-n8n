import { NodeConnectionTypes } from 'n8n-workflow';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

import { promptTypeOptions, textFromPreviousNode, textInput } from '@utils/descriptions';

import { getInputs } from './utils';
import { getToolsAgentProperties } from './utils/description';
import { toolsAgentExecute } from './utils/execute';
import { getCallbackProperties } from './utils/callbacks';

export class DarkAdvancedAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dark Advanced AI Agent',
		name: 'darkAgent',
		icon: 'fa:robot',
		iconColor: 'black',
		group: ['transform'],
		description: 'Generates an action plan and executes it. Can use external tools.',
		codex: {
			alias: ['LangChain', 'Chat', 'Conversational', 'Plan and Execute', 'ReAct', 'Tools'],
			categories: ['AI'],
			subcategories: {
				AI: ['Agents', 'Root Nodes'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/',
					},
				],
			},
		},
		defaultVersion: 2.2,
		version: [2, 2.1, 2.2],
		defaults: {
			name: 'Dark Advanced AI Agent',
			color: '#404040',
		},
		inputs: `={{
				((hasOutputParser, needsFallback) => {
					${getInputs.toString()};
					return getInputs(true, hasOutputParser, needsFallback);
				})($parameter.hasOutputParser === undefined || $parameter.hasOutputParser === true, $parameter.needsFallback !== undefined && $parameter.needsFallback === true)
			}}`,
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName:
					'Tip: Get a feel for agents with our quick <a href="https://docs.n8n.io/advanced-ai/intro-tutorial/" target="_blank">tutorial</a> or see an <a href="/workflows/templates/1954" target="_blank">example</a> of how this node works',
				name: 'aiAgentStarterCallout',
				type: 'callout',
				default: '',
			},
			{
				// eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
				displayName: 'Get started faster with our',
				name: 'preBuiltAgentsCallout',
				type: 'callout',
				typeOptions: {
					calloutAction: {
						label: 'pre-built agents',
						icon: 'bot',
						type: 'openPreBuiltAgentsCollection',
					},
				},
				default: '',
			},
			promptTypeOptions,
			{
				...textFromPreviousNode,
				displayOptions: {
					show: {
						promptType: ['auto'],
					},
				},
			},
			{
				...textInput,
				displayOptions: {
					show: {
						promptType: ['define'],
					},
				},
			},
			{
				displayName: 'Require Specific Output Format',
				name: 'hasOutputParser',
				type: 'boolean',
				default: false,
				noDataExpression: true,
			},
			{
				displayName: `Connect an <a data-action='openSelectiveNodeCreator' data-action-parameter-connectiontype='${NodeConnectionTypes.AiOutputParser}'>output parser</a> on the canvas to specify the output format you require`,
				name: 'notice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						hasOutputParser: [true],
					},
				},
			},
			{
				displayName: 'Enable Fallback Model',
				name: 'needsFallback',
				type: 'boolean',
				default: false,
				noDataExpression: true,
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 2.1 } }],
					},
				},
			},
			{
				displayName:
					'Connect an additional language model on the canvas to use it as a fallback if the main model fails',
				name: 'fallbackNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: {
						needsFallback: [true],
					},
				},
			},
			...getCallbackProperties(),
			...getToolsAgentProperties({ withStreaming: true }),
		],
		hints: [
			{
				message:
					'You are using streaming responses. Make sure to set the response mode to "Streaming Response" on the connected trigger node.',
				type: 'warning',
				location: 'outputPane',
				whenToDisplay: 'afterExecution',
				displayCondition: '={{ $parameter["enableStreaming"] === true }}',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await toolsAgentExecute.call(this);
	}
}
