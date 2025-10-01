import type { IVersionedNodeType, INodeTypeBaseDescription } from 'n8n-workflow';
import { VersionedNodeType } from 'n8n-workflow';

import { ToolWorkflowExecutorV1 } from './v1/ToolWorkflowExecutorV1.node';

export class ToolWorkflowExecutor extends VersionedNodeType {
	constructor() {
		const baseDescription: INodeTypeBaseDescription = {
			displayName: 'Tool Workflow Executor',
			name: 'toolWorkflowExecutor',
			icon: 'fa:cogs',
			iconColor: 'black',
			group: ['transform'],
			description: 'Acts as a tool for AI agents while allowing workflow execution continuation',
			codex: {
				categories: ['AI'],
				subcategories: {
					AI: ['Tools'],
					Tools: ['Workflow Tools'],
				},
				resources: {
					primaryDocumentation: [
						{
							url: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolworkflow/',
						},
					],
				},
			},
			defaultVersion: 1,
		};

		const nodeVersions: IVersionedNodeType['nodeVersions'] = {
			1: new ToolWorkflowExecutorV1(baseDescription),
		};
		super(nodeVersions, baseDescription);
	}
}
