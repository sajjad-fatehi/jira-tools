import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

import {
	buildCreatePayload,
	fetchCreateMeta,
	type JiraFieldMeta,
	toResourceMapperFields,
} from '../nodes/JiraSession/createMeta.ts';
import { JiraSession } from '../nodes/JiraSession/JiraSession.node.ts';
import { readLocatorValue } from '../nodes/JiraSession/users.ts';
import {
	BASE_URL,
	createExecuteContext,
	createLoadOptionsContext,
	httpError,
	NodeApiError,
	NodeOperationError,
} from './helpers.mts';

const node = new JiraSession();
const NEW_ENDPOINT = `${BASE_URL}/rest/api/2/issue/createmeta/PROJ/issuetypes/10002`;
const LEGACY_ENDPOINT = `${BASE_URL}/rest/api/2/issue/createmeta`;

const fieldMetas: JiraFieldMeta[] = [
	{ fieldId: 'project', name: 'Project', required: true, schema: { type: 'project' } },
	{ fieldId: 'issuetype', name: 'Issue Type', required: true, schema: { type: 'issuetype' } },
	{ fieldId: 'assignee', name: 'Assignee', required: false, schema: { type: 'user' } },
	{
		fieldId: 'reporter',
		name: 'Reporter',
		required: true,
		hasDefaultValue: true,
		schema: { type: 'user' },
	},
	{ fieldId: 'attachment', name: 'Attachment', required: false, schema: { type: 'array' } },
	{ fieldId: 'description', name: 'Description', required: false, schema: { type: 'string' } },
	{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
	{ fieldId: 'customfield_10012', name: 'Story Points', schema: { type: 'number' } },
	{ fieldId: 'duedate', name: 'Due Date', schema: { type: 'date' } },
	{ fieldId: 'customfield_10013', name: 'Go-Live Date', schema: { type: 'datetime' } },
	{
		fieldId: 'priority',
		name: 'Priority',
		required: true,
		hasDefaultValue: true,
		schema: { type: 'priority' },
		allowedValues: [
			{ id: '1', name: 'Highest' },
			{ id: '3', name: 'Medium' },
		],
	},
	{
		fieldId: 'resolution',
		name: 'Resolution',
		schema: { type: 'resolution' },
		allowedValues: [{ id: '10000', name: 'Done' }],
	},
	{
		fieldId: 'fixVersions',
		name: 'Fix Version/s',
		schema: { type: 'array', items: 'version' },
		allowedValues: [
			{ id: '10200', name: '1.0' },
			{ id: '10201', name: '2.0' },
		],
	},
	{
		fieldId: 'components',
		name: 'Component/s',
		schema: { type: 'array', items: 'component' },
		allowedValues: [
			{ id: '10100', name: 'Backend' },
			{ id: '10101', name: 'Frontend' },
		],
	},
	{
		fieldId: 'customfield_10010',
		name: 'Severity',
		required: true,
		schema: { type: 'option', custom: 'select' },
		allowedValues: [
			{ id: '20001', value: 'Critical' },
			{ id: '20002', value: 'Major' },
		],
	},
	{
		fieldId: 'customfield_10011',
		name: 'Affected Platforms',
		schema: { type: 'array', items: 'option', custom: 'multiselect' },
		allowedValues: [
			{ id: '20101', value: 'Web' },
			{ id: '20102', value: 'Android' },
			{ id: '20103', value: 'iOS' },
		],
	},
	{ fieldId: 'labels', name: 'Labels', schema: { type: 'array', items: 'string' } },
	{ fieldId: 'customfield_10014', name: 'Reviewer', schema: { type: 'user' } },
	{ fieldId: 'customfield_10015', name: 'Watchers', schema: { type: 'array', items: 'user' } },
	{ fieldId: 'timetracking', name: 'Time tracking', schema: { type: 'timetracking' } },
	{
		fieldId: 'parent',
		name: 'Parent',
		required: true,
		schema: { type: 'issuelink', system: 'parent' },
	},
];

function urlOf(options: IHttpRequestOptions): string {
	return String(options.url);
}

describe('createmeta', () => {
	it('reads the paged endpoint until isLast and keeps every page', async () => {
		const { context, requests } = createLoadOptionsContext({}, (options) => {
			const startAt = Number((options.qs as IDataObject).startAt);
			const values = fieldMetas.slice(startAt, startAt + 10);
			return {
				startAt,
				maxResults: 10,
				total: fieldMetas.length,
				isLast: startAt + values.length >= fieldMetas.length,
				values,
			};
		});

		const metas = await fetchCreateMeta.call(context, 'PROJ', '10002');

		assert.equal(metas.length, fieldMetas.length);
		assert.deepEqual(
			requests.map((request) => urlOf(request.options)),
			[NEW_ENDPOINT, NEW_ENDPOINT, NEW_ENDPOINT],
		);
		assert.deepEqual(
			requests.map((request) => (request.options.qs as IDataObject).startAt),
			[0, 10, 20],
		);
		assert.equal((requests[0].options.qs as IDataObject).maxResults, 50);
	});

	it('stops on an empty page even when isLast is missing', async () => {
		const { context, requests } = createLoadOptionsContext({}, () => ({ values: [] }));
		assert.deepEqual(await fetchCreateMeta.call(context, 'PROJ', '10002'), []);
		assert.equal(requests.length, 1);
	});

	it('falls back to the legacy expand endpoint when the paged one returns 404', async () => {
		const { context, requests } = createLoadOptionsContext({}, (options) => {
			if (urlOf(options) === NEW_ENDPOINT) {
				throw httpError(404, { errorMessages: ['null for uri'] });
			}
			return {
				projects: [
					{
						key: 'PROJ',
						issuetypes: [
							{ id: '10001', fields: { environment: { name: 'Environment' } } },
							{
								id: '10002',
								fields: {
									summary: { name: 'Summary', required: true, schema: { type: 'string' } },
									labels: { name: 'Labels', schema: { type: 'array', items: 'string' } },
								},
							},
						],
					},
				],
			};
		});

		const metas = await fetchCreateMeta.call(context, 'PROJ', '10002');

		assert.deepEqual(
			metas.map((meta) => meta.fieldId),
			['summary', 'labels'],
		);
		assert.equal(metas[0].required, true);
		assert.equal(urlOf(requests[1].options), LEGACY_ENDPOINT);
		assert.deepEqual(requests[1].options.qs, {
			projectKeys: 'PROJ',
			issuetypeIds: '10002',
			expand: 'projects.issuetypes.fields',
		});
	});

	it('does not fall back on other errors such as 403', async () => {
		const { context, requests } = createLoadOptionsContext({}, () => {
			throw httpError(403, { errorMessages: ['Forbidden'] });
		});
		await assert.rejects(fetchCreateMeta.call(context, 'PROJ', '10002'), NodeApiError);
		assert.equal(requests.length, 1);
	});
});

describe('createmeta → resource mapper schema', () => {
	const fields = toResourceMapperFields(fieldMetas);
	const byId = new Map(fields.map((field) => [field.id, field]));

	it('leaves out project, issue type, assignee, reporter and attachment', () => {
		for (const excluded of ['project', 'issuetype', 'assignee', 'reporter', 'attachment']) {
			assert.equal(byId.has(excluded), false, excluded);
		}
	});

	it('maps every Jira schema type to the expected n8n type', () => {
		const expected: Record<string, string> = {
			summary: 'string',
			description: 'string',
			customfield_10012: 'number',
			duedate: 'dateTime',
			customfield_10013: 'dateTime',
			priority: 'options',
			resolution: 'options',
			fixVersions: 'options',
			components: 'options',
			customfield_10010: 'options',
			customfield_10011: 'options',
			labels: 'string',
			customfield_10014: 'string',
			customfield_10015: 'string',
			timetracking: 'string',
			parent: 'string',
		};
		for (const [fieldId, type] of Object.entries(expected)) {
			assert.equal(byId.get(fieldId)?.type, type, fieldId);
		}
	});

	it('builds options from allowedValues using name or value as label and id as value', () => {
		assert.deepEqual(byId.get('customfield_10011')?.options, [
			{ name: 'Web', value: '20101' },
			{ name: 'Android', value: '20102' },
			{ name: 'iOS', value: '20103' },
		]);
		assert.deepEqual(byId.get('priority')?.options, [
			{ name: 'Highest', value: '1' },
			{ name: 'Medium', value: '3' },
		]);
	});

	it('flags required fields unless Jira fills them by default, and shows every field', () => {
		assert.equal(byId.get('summary')?.required, true);
		assert.equal(byId.get('customfield_10010')?.required, true);
		assert.equal(byId.get('parent')?.required, true);
		assert.equal(byId.get('priority')?.required, false);
		assert.equal(byId.get('labels')?.required, false);
		assert.ok(fields.every((field) => field.display && !field.removed));
	});

	it('orders summary first, then required fields, then the rest by name', () => {
		assert.deepEqual(
			fields.slice(0, 3).map((field) => field.id),
			['summary', 'parent', 'customfield_10010'],
		);
		assert.equal(fields[3].displayName, 'Affected Platforms');
	});
});

describe('mapper values → create payload', () => {
	const base = { project: 'PROJ', issueType: '10002', fieldMetas };

	it('converts every field kind to the shape Jira expects', () => {
		const fields = buildCreatePayload({
			...base,
			values: {
				summary: 'From the mapper',
				description: 'Body',
				customfield_10012: 5,
				duedate: '2026-03-01T00:00:00',
				customfield_10013: '2026-03-01T10:30:00+03:30',
				priority: '1',
				resolution: '10000',
				fixVersions: '10201',
				components: 'Backend, Frontend',
				customfield_10010: '20002',
				customfield_10011: '["20101", "iOS"]',
				labels: 'n8n, automation',
				customfield_10014: 'jsmith',
				customfield_10015: 'jdoe, akim',
				timetracking: '{"originalEstimate": "1d"}',
				parent: 'proj-7',
			},
			assignee: 'jdoe',
			reporter: 'akim',
		});

		assert.deepEqual(fields, {
			project: { key: 'PROJ' },
			issuetype: { id: '10002' },
			summary: 'From the mapper',
			description: 'Body',
			customfield_10012: 5,
			duedate: '2026-03-01',
			customfield_10013: '2026-03-01T07:00:00.000+0000',
			priority: { id: '1' },
			resolution: { id: '10000' },
			fixVersions: [{ id: '10201' }],
			components: [{ id: '10100' }, { id: '10101' }],
			customfield_10010: { id: '20002' },
			customfield_10011: [{ id: '20101' }, { id: '20103' }],
			labels: ['n8n', 'automation'],
			customfield_10014: { name: 'jsmith' },
			customfield_10015: [{ name: 'jdoe' }, { name: 'akim' }],
			timetracking: { originalEstimate: '1d' },
			parent: { key: 'PROJ-7' },
			assignee: { name: 'jdoe' },
			reporter: { name: 'akim' },
		});
	});

	it('reads date-times without an offset as UTC and accepts numbers given as text', () => {
		const fields = buildCreatePayload({
			...base,
			values: { customfield_10013: '2026-03-01T10:30:00', customfield_10012: '2.5' },
		});
		assert.equal(fields.customfield_10013, '2026-03-01T10:30:00.000+0000');
		assert.equal(fields.customfield_10012, 2.5);
	});

	it('skips empty values and keys Jira does not list, and lets Additional Fields (JSON) win', () => {
		const fields = buildCreatePayload({
			...base,
			values: { summary: 'x', description: '', labels: null, unrelated: 'ignored', assignee: 'no' },
			fieldsJson: { summary: 'override', customfield_99999: 1 },
		});
		assert.deepEqual(fields, {
			project: { key: 'PROJ' },
			issuetype: { id: '10002' },
			summary: 'override',
			customfield_99999: 1,
		});
	});

	it('passes objects from expressions through untouched', () => {
		const fields = buildCreatePayload({
			...base,
			values: { customfield_10010: { value: 'Critical' } as unknown as string },
		});
		assert.deepEqual(fields.customfield_10010, { value: 'Critical' });
	});

	it('rejects a value that is not allowed and names the choices', () => {
		assert.throws(
			() => buildCreatePayload({ ...base, values: { customfield_10010: 'Blocker' } }),
			/"Blocker" is not an allowed value of Severity \(Critical, Major\)/,
		);
	});

	it('rejects invalid numbers and dates with the field name', () => {
		assert.throws(
			() => buildCreatePayload({ ...base, values: { customfield_10012: 'many' } }),
			/Story Points must be a number/,
		);
		assert.throws(
			() => buildCreatePayload({ ...base, values: { duedate: 'tomorrow' } }),
			/Due Date must be a date/,
		);
	});
});

describe('assignee / reporter search', () => {
	function userPage(startAt: number, count: number): IDataObject[] {
		return Array.from({ length: count }, (_, index) => ({
			name: `user${startAt + index}`,
			displayName: `User ${startAt + index}`,
		}));
	}

	it('searches assignable users of the chosen project with the typed query and pages by startAt', async () => {
		const { context, requests } = createLoadOptionsContext({ project: 'PROJ' }, (options) => {
			const startAt = Number((options.qs as IDataObject).startAt);
			return startAt === 0 ? userPage(0, 50) : userPage(50, 3);
		});
		const search = node.methods.listSearch.searchAssignableUsers;

		const first = await search.call(context, ' jan ');
		const second = await search.call(context, 'jan', first.paginationToken);

		assert.equal(urlOf(requests[0].options), `${BASE_URL}/rest/api/2/user/assignable/search`);
		assert.deepEqual(requests[0].options.qs, {
			project: 'PROJ',
			username: 'jan',
			startAt: 0,
			maxResults: 50,
		});
		assert.equal(first.results.length, 50);
		assert.deepEqual(first.results[0], { name: 'User 0 (user0)', value: 'user0' });
		assert.equal(first.paginationToken, '50');
		assert.equal((requests[1].options.qs as IDataObject).startAt, 50);
		assert.equal(second.results.length, 3);
		assert.equal(second.paginationToken, undefined);
	});

	it('searches all users for the reporter and sends "." when the query is empty', async () => {
		const { context, requests } = createLoadOptionsContext({ project: 'PROJ' }, () => [
			{ name: 'jdoe', displayName: 'Jane Doe' },
			{ displayName: 'No username' },
			{ name: 'svc' },
		]);

		const result = await node.methods.listSearch.searchUsers.call(context);

		assert.equal(urlOf(requests[0].options), `${BASE_URL}/rest/api/2/user/search`);
		assert.equal((requests[0].options.qs as IDataObject).username, '.');
		assert.deepEqual(result.results, [
			{ name: 'Jane Doe (jdoe)', value: 'jdoe' },
			{ name: 'svc', value: 'svc' },
		]);
	});

	it('falls back to the user search when no project is chosen yet', async () => {
		const { context, requests } = createLoadOptionsContext({}, () => []);
		await node.methods.listSearch.searchAssignableUsers.call(context, 'ja');
		assert.equal(urlOf(requests[0].options), `${BASE_URL}/rest/api/2/user/search`);
		assert.equal((requests[0].options.qs as IDataObject).username, 'ja');
	});

	it('reads locator values in both raw and extracted form', () => {
		assert.equal(readLocatorValue({ __rl: true, mode: 'list', value: ' jdoe ' }), 'jdoe');
		assert.equal(readLocatorValue('jsmith'), 'jsmith');
		assert.equal(readLocatorValue(undefined), '');
	});
});

describe('Issue > Create (v2)', () => {
	const createdResponse = {
		id: '20001',
		key: 'PROJ-1',
		self: `${BASE_URL}/rest/api/2/issue/20001`,
	};

	function jiraHandler(posted: IDataObject[]) {
		return (options: IHttpRequestOptions) => {
			if (options.method === 'POST') {
				posted.push(options.body as IDataObject);
				return createdResponse;
			}
			return { isLast: true, values: fieldMetas };
		};
	}

	it('loads the mapper schema for the chosen project and issue type', async () => {
		const { context, requests } = createLoadOptionsContext(
			{ project: 'PROJ', issueType: '10002' },
			() => ({ isLast: true, values: fieldMetas }),
		);
		const schema = await node.methods.resourceMapping.getCreateFields.call(context);
		assert.equal(urlOf(requests[0].options), NEW_ENDPOINT);
		assert.equal(schema.fields[0].id, 'summary');
	});

	it('returns no fields before a project and issue type are chosen', async () => {
		const { context, requests } = createLoadOptionsContext({ project: 'PROJ' }, () => ({}));
		const schema = await node.methods.resourceMapping.getCreateFields.call(context);
		assert.deepEqual(schema.fields, []);
		assert.equal(requests.length, 0);
	});

	it('posts the mapped payload and reads createmeta once for all items', async () => {
		const posted: IDataObject[] = [];
		const item = {
			operation: 'create',
			project: 'PROJ',
			issueType: '10002',
			createFields: {
				mappingMode: 'defineBelow',
				value: { summary: 'From v2', customfield_10010: '20001', labels: 'n8n' },
			},
			assignee: { __rl: true, mode: 'list', value: 'jdoe' },
			reporter: { __rl: true, mode: 'username', value: '' },
			additionalFieldsJson: '{"customfield_10012": 8}',
		};
		const { context, requests } = createExecuteContext([item, item], jiraHandler(posted), false, 2);

		const [output] = await node.execute.call(context);

		assert.equal(requests.filter((request) => request.options.method === 'GET').length, 1);
		assert.equal(posted.length, 2);
		assert.deepEqual(posted[0], {
			fields: {
				project: { key: 'PROJ' },
				issuetype: { id: '10002' },
				summary: 'From v2',
				customfield_10010: { id: '20001' },
				labels: ['n8n'],
				assignee: { name: 'jdoe' },
				customfield_10012: 8,
			},
		});
		assert.equal(output[0].json.url, `${BASE_URL}/browse/PROJ-1`);
	});

	it('maps input item fields automatically in auto-map mode', async () => {
		const posted: IDataObject[] = [];
		const { context } = createExecuteContext(
			[
				{
					operation: 'create',
					project: 'PROJ',
					issueType: '10002',
					createFields: { mappingMode: 'autoMapInputData', value: null },
				},
			],
			jiraHandler(posted),
			false,
			2,
		);
		context.getInputData = () => [
			{ json: { summary: 'Auto', customfield_10010: 'Major', notAField: true } },
		];

		await node.execute.call(context);

		assert.deepEqual(posted[0].fields, {
			project: { key: 'PROJ' },
			issuetype: { id: '10002' },
			summary: 'Auto',
			customfield_10010: { id: '20002' },
		});
	});

	it('reports a bad mapper value as a NodeOperationError without posting', async () => {
		const posted: IDataObject[] = [];
		const { context } = createExecuteContext(
			[
				{
					operation: 'create',
					project: 'PROJ',
					issueType: '10002',
					createFields: { mappingMode: 'defineBelow', value: { customfield_10010: 'Blocker' } },
				},
			],
			jiraHandler(posted),
			false,
			2,
		);
		await assert.rejects(node.execute.call(context), NodeOperationError);
		assert.equal(posted.length, 0);
	});
});
