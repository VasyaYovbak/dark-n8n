import type { INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

export const versionDescription: INodeTypeDescription = {
	displayName: 'Tool Workflow Executor',
	name: 'toolWorkflowExecutor',
	icon: 'fa:cogs',
	iconColor: 'black',
	group: ['transform'],
	version: 1,
	description: 'Acts as a tool for AI agents while allowing workflow execution continuation',
	defaults: {
		name: 'Tool Workflow Executor',
	},
	codex: {
		categories: ['AI'],
		subcategories: {
			AI: ['Tools'],
		},
	},
	inputs: [],
	outputs: [NodeConnectionTypes.AiTool, NodeConnectionTypes.Main],
	properties: [
		{
			displayName: 'Tool Description',
			name: 'toolDescription',
			type: 'string',
			typeOptions: {
				rows: 3,
			},
			default: '',
			required: true,
			description:
				'Description of what this tool does. Be specific as the AI uses this to decide when to use the tool. The tool name will be automatically generated from the node name.',
			placeholder: 'e.g., Processes Google Docs documents and extracts information',
		},
		{
			displayName: 'Note',
			name: 'toolNameNote',
			type: 'notice',
			default: '',
			displayOptions: {
				show: {
					'@version': [1],
				},
			},
			description:
				'The tool name is automatically generated from the node name (e.g., "My Tool" becomes "my_tool"). Rename the node to change the tool name.',
		},
		{
			displayName: 'Parameters Type',
			name: 'parametersType',
			type: 'options',
			options: [
				{
					name: 'No Parameters',
					value: 'none',
					description: 'Tool does not accept any parameters',
				},
				{
					name: 'Define Parameters',
					value: 'fields',
					description: 'Define parameters using fields',
				},
				{
					name: 'JSON Schema',
					value: 'jsonSchema',
					description: 'Define parameters using JSON Schema',
				},
			],
			default: 'none',
			description: 'How to define the parameters for this tool',
		},
		{
			displayName: 'Parameters',
			name: 'parameters',
			type: 'fixedCollection',
			displayOptions: {
				show: {
					parametersType: ['fields'],
				},
			},
			typeOptions: {
				multipleValues: true,
			},
			placeholder: 'Add Parameter',
			default: {},
			options: [
				{
					name: 'parameters',
					displayName: 'Parameter',
					values: [
						{
							displayName: 'Parameter Name',
							name: 'name',
							type: 'string',
							default: '',
							placeholder: 'e.g., documentId',
							description: 'Name of the parameter',
						},
						{
							displayName: 'Description',
							name: 'description',
							type: 'string',
							default: '',
							placeholder: 'e.g., The ID of the document to process',
							description:
								'Description of what this parameter does (used by AI to understand the parameter)',
						},
						{
							displayName: 'Type',
							name: 'type',
							type: 'options',
							options: [
								{
									name: 'String',
									value: 'string',
								},
								{
									name: 'Number',
									value: 'number',
								},
								{
									name: 'Boolean',
									value: 'boolean',
								},
								{
									name: 'Array',
									value: 'array',
								},
								{
									name: 'Object',
									value: 'object',
								},
							],
							default: 'string',
							description: 'The type of the parameter',
						},
						{
							displayName: 'Value Source',
							name: 'valueSource',
							type: 'options',
							options: [
								{
									name: 'From AI',
									value: 'ai',
									description: 'AI will provide this parameter value',
								},
								{
									name: 'Define Below',
									value: 'define',
									description: 'You define the value (can use expressions)',
								},
							],
							default: 'ai',
							description: 'Whether the AI provides this value or you define it',
						},
						{
							displayName: 'Value',
							name: 'value',
							type: 'string',
							default: '',
							displayOptions: {
								show: {
									valueSource: ['define'],
								},
							},
							description:
								'The value for this parameter. Can use expressions to access data from parent execution.',
							placeholder: 'e.g., {{ $json.documentId }}',
						},
						{
							displayName: 'Required',
							name: 'required',
							type: 'boolean',
							default: false,
							displayOptions: {
								show: {
									valueSource: ['ai'],
								},
							},
							description: 'Whether this parameter is required from AI',
						},
					],
				},
			],
			description: 'Define parameters that the AI can pass to this tool',
		},
		{
			displayName: 'JSON Schema',
			name: 'jsonSchema',
			type: 'json',
			default:
				'{\n  "type": "object",\n  "properties": {\n    "documentId": {\n      "type": "string",\n      "description": "The ID of the document to process"\n    },\n    "action": {\n      "type": "string",\n      "description": "The action to perform (e.g., extract, summarize)"\n    }\n  },\n  "required": ["documentId", "action"]\n}',
			displayOptions: {
				show: {
					parametersType: ['jsonSchema'],
				},
			},
			description: 'JSON Schema defining the expected parameters for this tool',
		},
		{
			displayName: 'Info',
			name: 'notice',
			type: 'notice',
			default: '',
			displayOptions: {
				show: {
					'@version': [1],
				},
			},
			description:
				'This node acts as a bridge between AI agents and workflow execution. Connect it to an agent as a tool, then add your workflow logic to the Main output. The result of your workflow will be returned to the agent.',
		},
	],
};
