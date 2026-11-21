import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INode,
	INodeExecutionData,
} from 'n8n-workflow';
import { createRequire } from 'node:module';

// The node code is CommonJS, so the tests must use the same (CommonJS) n8n-workflow build;
// an ESM import would load the ESM build and break instanceof checks on its error classes.
const workflow = createRequire(import.meta.url)('n8n-workflow') as typeof import('n8n-workflow');
export const { NodeApiError, NodeOperationError } = workflow;

export const BASE_URL = 'https://jira.example.com';

export interface RecordedRequest {
	credentialType: string;
	options: IHttpRequestOptions;
}

export type RequestHandler = (options: IHttpRequestOptions) => unknown;

export interface FakeExecuteContext {
	context: IExecuteFunctions;
	requests: RecordedRequest[];
}

const fakeNode: INode = {
	id: 'node-1',
	name: 'Jira Session',
	type: 'n8n-nodes-jira-session.jiraSession',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** Minimal IExecuteFunctions stand-in: parameters per item, a scripted HTTP layer and a request log. */
export function createExecuteContext(
	parametersPerItem: IDataObject[],
	handler: RequestHandler,
	continueOnFail = false,
): FakeExecuteContext {
	const requests: RecordedRequest[] = [];
	const items: INodeExecutionData[] = parametersPerItem.map(() => ({ json: {} }));

	const context = {
		getInputData: () => items,
		getNode: () => fakeNode,
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({ baseUrl: `${BASE_URL}/`, username: 'jdoe', password: 'x' }),
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			const parameters = parametersPerItem[itemIndex] ?? {};
			if (name in parameters) {
				return parameters[name];
			}
			if (fallback !== undefined) {
				return fallback;
			}
			throw new Error(`Missing parameter ${name}`);
		},
		helpers: {
			httpRequestWithAuthentication: async (
				credentialType: string,
				options: IHttpRequestOptions,
			) => {
				requests.push({ credentialType, options });
				return handler(options);
			},
		},
	};

	return { context: context as unknown as IExecuteFunctions, requests };
}

export function makeIssues(count: number, offset = 0): IDataObject[] {
	return Array.from({ length: count }, (_, index) => ({
		id: String(offset + index + 1),
		key: `PROJ-${offset + index + 1}`,
	}));
}
