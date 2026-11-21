import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

import { JiraSession } from '../nodes/JiraSession/JiraSession.node.ts';
import {
	BASE_URL,
	createExecuteContext,
	makeIssues,
	NodeApiError,
	NodeOperationError,
} from './helpers.mts';

const node = new JiraSession();

function searchHandler(total: number) {
	const all = makeIssues(total);
	return (options: IHttpRequestOptions) => {
		const body = options.body as IDataObject;
		const startAt = Number(body.startAt);
		const maxResults = Number(body.maxResults);
		return { startAt, maxResults, total, issues: all.slice(startAt, startAt + maxResults) };
	};
}

const searchParameters: IDataObject = {
	operation: 'getAll',
	filterMode: 'builder',
	filters: { project: 'PROJ' },
	orderBy: 'updated',
	orderDirection: 'DESC',
	fields: 'summary, status',
};

describe('Issue > Create', () => {
	it('posts the mapped fields with the XSRF header and returns id, key, self and browse URL', async () => {
		const { context, requests } = createExecuteContext(
			[
				{
					operation: 'create',
					project: 'PROJ',
					issueType: '10001',
					summary: 'From n8n',
					additionalFields: { labels: 'n8n' },
					customFields: { field: [{ fieldId: 'customfield_10010', value: '3' }] },
				},
			],
			() => ({ id: '20001', key: 'PROJ-1', self: `${BASE_URL}/rest/api/2/issue/20001` }),
		);

		const [output] = await node.execute.call(context);

		assert.equal(requests.length, 1);
		const { credentialType, options } = requests[0];
		assert.equal(credentialType, 'jiraSessionApi');
		assert.equal(options.method, 'POST');
		assert.equal(options.url, `${BASE_URL}/rest/api/2/issue`);
		assert.equal((options.headers as IDataObject)['X-Atlassian-Token'], 'no-check');
		assert.deepEqual(options.body, {
			fields: {
				project: { key: 'PROJ' },
				issuetype: { id: '10001' },
				summary: 'From n8n',
				labels: ['n8n'],
				customfield_10010: 3,
			},
		});
		assert.deepEqual(output, [
			{
				json: {
					id: '20001',
					key: 'PROJ-1',
					self: `${BASE_URL}/rest/api/2/issue/20001`,
					url: `${BASE_URL}/browse/PROJ-1`,
				},
				pairedItem: { item: 0 },
			},
		]);
	});

	it('reports invalid JSON as a NodeOperationError without calling Jira', async () => {
		const { context, requests } = createExecuteContext(
			[
				{
					operation: 'create',
					project: 'PROJ',
					issueType: '10001',
					summary: 'x',
					additionalFields: { fieldsJson: '{oops' },
				},
			],
			() => ({}),
		);
		await assert.rejects(node.execute.call(context), NodeOperationError);
		assert.equal(requests.length, 0);
	});

	it('continues per item on failure when continueOnFail is enabled', async () => {
		let call = 0;
		const { context } = createExecuteContext(
			[
				{ operation: 'create', project: 'PROJ', issueType: '10001', summary: 'ok' },
				{ operation: 'create', project: 'PROJ', issueType: '10001', summary: 'bad' },
			],
			() => {
				call++;
				if (call === 2) {
					throw Object.assign(new Error('Request failed with status code 400'), {
						httpCode: '400',
						response: { status: 400, data: { errors: { summary: 'too long' } } },
					});
				}
				return { id: '1', key: 'PROJ-1', self: 'x' };
			},
			true,
		);

		const [output] = await node.execute.call(context);

		assert.equal(output.length, 2);
		assert.equal(output[0].json.key, 'PROJ-1');
		assert.deepEqual(output[1].pairedItem, { item: 1 });
		assert.ok(typeof output[1].json.error === 'string');
	});

	it('wraps HTTP failures in NodeApiError with Jira error details', async () => {
		const { context } = createExecuteContext(
			[{ operation: 'create', project: 'PROJ', issueType: '10001', summary: 'bad' }],
			() => {
				throw Object.assign(new Error('Request failed with status code 400'), {
					httpCode: '400',
					response: { status: 400, data: { errorMessages: ['Field x is required'] } },
				});
			},
		);
		await assert.rejects(node.execute.call(context), (error: unknown) => {
			assert.ok(error instanceof NodeApiError);
			assert.equal(error.description, 'Field x is required');
			return true;
		});
	});

	it('surfaces a failed login as a NodeOperationError carrying the login message', async () => {
		const { context, requests } = createExecuteContext(
			[{ operation: 'create', project: 'PROJ', issueType: '10001', summary: 'x' }],
			() => {
				throw new Error('Jira login failed: HTTP 401. Not retrying, to avoid a CAPTCHA lockout.');
			},
		);
		await assert.rejects(node.execute.call(context), (error: unknown) => {
			assert.ok(error instanceof NodeOperationError);
			assert.match(error.message, /Jira login failed: HTTP 401/);
			return true;
		});
		assert.equal(requests.length, 1);
	});
});

describe('Issue > Get Many', () => {
	it('builds JQL, requests the chosen fields and emits one item per issue', async () => {
		const { context, requests } = createExecuteContext(
			[{ ...searchParameters, returnAll: false, limit: 5 }],
			searchHandler(3),
		);

		const [output] = await node.execute.call(context);

		assert.equal(output.length, 3);
		assert.deepEqual(output[0], { json: { id: '1', key: 'PROJ-1' }, pairedItem: { item: 0 } });
		const options = requests[0].options;
		assert.equal(options.url, `${BASE_URL}/rest/api/2/search`);
		assert.deepEqual(options.body, {
			jql: 'project = "PROJ" ORDER BY updated DESC',
			startAt: 0,
			maxResults: 5,
			fields: ['summary', 'status'],
		});
	});

	it('pages through every result with startAt when Return All is on', async () => {
		const { context, requests } = createExecuteContext(
			[{ ...searchParameters, returnAll: true }],
			searchHandler(250),
		);

		const [output] = await node.execute.call(context);

		assert.equal(output.length, 250);
		assert.deepEqual(
			requests.map((request) => (request.options.body as IDataObject).startAt),
			[0, 100, 200],
		);
		assert.equal(output[249].json.key, 'PROJ-250');
	});

	it('stops at the limit and shrinks the last page size', async () => {
		const { context, requests } = createExecuteContext(
			[{ ...searchParameters, returnAll: false, limit: 120 }],
			searchHandler(500),
		);

		const [output] = await node.execute.call(context);

		assert.equal(output.length, 120);
		assert.deepEqual(
			requests.map((request) => (request.options.body as IDataObject).maxResults),
			[100, 20],
		);
	});

	it('stops when Jira returns an empty page even if total says otherwise', async () => {
		const { context, requests } = createExecuteContext(
			[{ ...searchParameters, returnAll: true }],
			() => ({ startAt: 0, total: 999, issues: [] }),
		);
		const [output] = await node.execute.call(context);
		assert.equal(output.length, 0);
		assert.equal(requests.length, 1);
	});

	it('sends raw JQL unchanged', async () => {
		const { context, requests } = createExecuteContext(
			[
				{
					operation: 'getAll',
					filterMode: 'jql',
					jql: ' project = PROJ AND labels = n8n ',
					returnAll: false,
					limit: 10,
				},
			],
			searchHandler(0),
		);
		await node.execute.call(context);
		const body = requests[0].options.body as IDataObject;
		assert.equal(body.jql, 'project = PROJ AND labels = n8n');
		assert.deepEqual(body.fields, [
			'summary',
			'status',
			'assignee',
			'issuetype',
			'priority',
			'created',
			'updated',
		]);
	});
});
