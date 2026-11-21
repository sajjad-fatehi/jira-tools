import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodeParameterResourceLocator,
} from 'n8n-workflow';

import { jiraApiRequest } from './transport';

export const USER_SEARCH_PAGE_SIZE = 50;

/** Jira Server's /user/search requires a username; "." matches nearly every account. */
const MATCH_ANY_USERNAME = '.';

interface JiraUser {
	name?: string;
	key?: string;
	displayName?: string;
	active?: boolean;
}

export interface UserSearchRequest {
	endpoint: '/user/assignable/search' | '/user/search';
	query: IDataObject;
	paginationToken?: string;
}

function toListItems(users: JiraUser[]): INodeListSearchItems[] {
	const items: INodeListSearchItems[] = [];
	for (const user of users) {
		if (!user.name) {
			continue;
		}
		const label = user.displayName ? `${user.displayName} (${user.name})` : user.name;
		items.push({ name: label, value: user.name });
	}
	return items;
}

async function searchUsers(
	this: ILoadOptionsFunctions,
	request: UserSearchRequest,
): Promise<INodeListSearchResult> {
	const startAt = Number(request.paginationToken ?? 0) || 0;
	const users = (await jiraApiRequest.call(this, 'GET', request.endpoint, undefined, {
		...request.query,
		startAt,
		maxResults: USER_SEARCH_PAGE_SIZE,
	})) as unknown as JiraUser[];
	const page = Array.isArray(users) ? users : [];
	const result: INodeListSearchResult = { results: toListItems(page) };
	if (page.length >= USER_SEARCH_PAGE_SIZE) {
		result.paginationToken = String(startAt + page.length);
	}
	return result;
}

function currentProjectKey(context: ILoadOptionsFunctions): string {
	const project = context.getCurrentNodeParameter('project');
	return typeof project === 'string' ? project.trim() : '';
}

/** Users assignable in the chosen project; without a project, any user. */
export async function searchAssignableUsers(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const project = currentProjectKey(this);
	if (!project) {
		return await searchAllUsers.call(this, filter, paginationToken);
	}
	return await searchUsers.call(this, {
		endpoint: '/user/assignable/search',
		query: { project, username: filter?.trim() ?? '' },
		paginationToken,
	});
}

export async function searchAllUsers(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	return await searchUsers.call(this, {
		endpoint: '/user/search',
		query: { username: filter?.trim() || MATCH_ANY_USERNAME },
		paginationToken,
	});
}

/** Accepts the extracted locator value as well as the raw locator object. */
export function readLocatorValue(raw: unknown): string {
	if (typeof raw === 'string') {
		return raw.trim();
	}
	if (typeof raw === 'object' && raw !== null && 'value' in raw) {
		const value = (raw as INodeParameterResourceLocator).value;
		return value === undefined || value === null ? '' : String(value).trim();
	}
	return '';
}
