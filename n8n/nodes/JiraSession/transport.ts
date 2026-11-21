import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { API_PREFIX, CREDENTIAL_NAME, normalizeBaseUrl, XSRF_HEADER } from './session';

type JiraContext = IExecuteFunctions | ILoadOptionsFunctions;

export const SEARCH_PAGE_SIZE = 100;

interface JiraErrorBody {
	errorMessages?: string[];
	errors?: Record<string, string>;
}

export interface SearchRequest {
	jql: string;
	fields: string[];
	returnAll: boolean;
	limit: number;
}

interface SearchPage {
	issues?: IDataObject[];
	total?: number;
	startAt?: number;
}

function extractJiraDetails(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}
	const candidate = error as { response?: { body?: unknown; data?: unknown }; cause?: unknown };
	const body = (candidate.response?.body ?? candidate.response?.data) as JiraErrorBody | undefined;
	if (!body || typeof body !== 'object') {
		return undefined;
	}
	const details = [...(body.errorMessages ?? [])];
	for (const [field, message] of Object.entries(body.errors ?? {})) {
		details.push(`${field}: ${message}`);
	}
	return details.length > 0 ? details.join('; ') : undefined;
}

function hasHttpResponse(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const candidate = error as { response?: unknown; httpCode?: unknown; statusCode?: unknown };
	return Boolean(candidate.response ?? candidate.httpCode ?? candidate.statusCode);
}

export async function getBaseUrl(this: JiraContext): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	return normalizeBaseUrl(String(credentials.baseUrl ?? ''));
}

export async function jiraApiRequest(
	this: JiraContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const baseUrl = await getBaseUrl.call(this);
	const headers: IDataObject = { Accept: 'application/json' };
	if (method !== 'GET') {
		headers[XSRF_HEADER] = 'no-check';
	}
	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${API_PREFIX}${endpoint}`,
		headers,
		json: true,
	};
	if (body) {
		options.body = body;
	}
	if (qs) {
		options.qs = qs;
	}

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as IDataObject;
	} catch (error) {
		throw toNodeError(this.getNode(), error, {
			message: `${method} ${API_PREFIX}${endpoint} failed`,
			description: extractJiraDetails(error),
		});
	}
}

/**
 * Keeps errors that already carry n8n context, wraps HTTP failures as NodeApiError (status and
 * Jira's errorMessages stay visible) and everything else, such as a failed login, as NodeOperationError.
 */
export function toNodeError(
	node: INode,
	error: unknown,
	context: { message?: string; description?: string; itemIndex?: number } = {},
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		if (context.itemIndex !== undefined && error.context.itemIndex === undefined) {
			error.context.itemIndex = context.itemIndex;
		}
		return error;
	}
	if (!hasHttpResponse(error)) {
		return new NodeOperationError(node, error as Error, { itemIndex: context.itemIndex });
	}
	return new NodeApiError(node, error as JsonObject, {
		message: context.message,
		description: context.description,
		itemIndex: context.itemIndex,
	});
}

export async function searchIssues(
	this: IExecuteFunctions,
	request: SearchRequest,
): Promise<IDataObject[]> {
	const issues: IDataObject[] = [];
	let startAt = 0;

	for (;;) {
		const remaining = request.returnAll ? SEARCH_PAGE_SIZE : request.limit - issues.length;
		if (remaining <= 0) {
			break;
		}
		const page = (await jiraApiRequest.call(this, 'POST', '/search', {
			jql: request.jql,
			startAt,
			maxResults: Math.min(SEARCH_PAGE_SIZE, remaining),
			fields: request.fields,
		})) as SearchPage;

		const pageIssues = page.issues ?? [];
		issues.push(...pageIssues.slice(0, remaining));
		startAt += pageIssues.length;

		const total = page.total ?? 0;
		if (pageIssues.length === 0 || startAt >= total) {
			break;
		}
	}

	return issues;
}
