import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
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

function createFakeNode(typeVersion: number): INode {
	return {
		id: 'node-1',
		name: 'Jira Session',
		type: 'n8n-nodes-jira-session.jiraSession',
		typeVersion,
		position: [0, 0],
		parameters: {},
	};
}

function createHttpHelpers(requests: RecordedRequest[], handler: RequestHandler) {
	return {
		httpRequestWithAuthentication: async (credentialType: string, options: IHttpRequestOptions) => {
			requests.push({ credentialType, options });
			return handler(options);
		},
	};
}

const fakeCredentials = async () => ({ baseUrl: `${BASE_URL}/`, username: 'jdoe', password: 'x' });

/** Minimal IExecuteFunctions stand-in: parameters per item, a scripted HTTP layer and a request log. */
export function createExecuteContext(
	parametersPerItem: IDataObject[],
	handler: RequestHandler,
	continueOnFail = false,
	typeVersion = 1,
): FakeExecuteContext {
	const requests: RecordedRequest[] = [];
	const items: INodeExecutionData[] = parametersPerItem.map(() => ({ json: {} }));

	const context = {
		getInputData: () => items,
		getNode: () => createFakeNode(typeVersion),
		continueOnFail: () => continueOnFail,
		getCredentials: fakeCredentials,
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
		helpers: createHttpHelpers(requests, handler),
	};

	return { context: context as unknown as IExecuteFunctions, requests };
}

export interface FakeLoadOptionsContext {
	context: ILoadOptionsFunctions;
	requests: RecordedRequest[];
}

/** Minimal ILoadOptionsFunctions stand-in for load options, list search and resource mapping methods. */
export function createLoadOptionsContext(
	currentParameters: IDataObject,
	handler: RequestHandler,
): FakeLoadOptionsContext {
	const requests: RecordedRequest[] = [];
	const context = {
		getNode: () => createFakeNode(2),
		getCredentials: fakeCredentials,
		getCurrentNodeParameter: (name: string) => currentParameters[name],
		helpers: createHttpHelpers(requests, handler),
	};
	return { context: context as unknown as ILoadOptionsFunctions, requests };
}

export function httpError(status: number, data: IDataObject = {}): Error {
	return Object.assign(new Error(`Request failed with status code ${status}`), {
		httpCode: String(status),
		response: { status, data },
	});
}

export function makeIssues(count: number, offset = 0): IDataObject[] {
	return Array.from({ length: count }, (_, index) => ({
		id: String(offset + index + 1),
		key: `PROJ-${offset + index + 1}`,
	}));
}
