import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCreateFields, parseCustomFieldValue } from '../nodes/JiraSession/issueFields.ts';
import { buildJql, buildOrderBy, formatJqlDate, quoteJqlValue } from '../nodes/JiraSession/jql.ts';

describe('JQL builder', () => {
	it('escapes backslashes and double quotes inside string literals', () => {
		assert.equal(quoteJqlValue('say "hi" C:\\temp'), '"say \\"hi\\" C:\\\\temp"');
	});

	it('replaces control characters so a value cannot break out of the literal', () => {
		assert.equal(quoteJqlValue('line1\nline2\t'), '"line1 line2 "');
	});

	it('neutralizes JQL injection attempts', () => {
		const jql = buildJql({ project: 'PROJ" OR project = "SECRET' });
		assert.equal(jql, 'project = "PROJ\\" OR project = \\"SECRET"');
	});

	it('composes all builder filters with AND and appends ORDER BY', () => {
		const jql = buildJql(
			{
				project: 'PROJ',
				status: 'To Do, In Progress',
				issueType: 'Bug',
				assignee: 'currentUser()',
				labels: 'n8n,automation',
				updatedSince: '2026-01-15T08:30:00',
				text: 'login "error"',
			},
			'updated',
			'DESC',
		);
		assert.equal(
			jql,
			'project = "PROJ" AND status in ("To Do", "In Progress") AND issuetype = "Bug" AND ' +
				'assignee = currentUser() AND labels in ("n8n", "automation") AND ' +
				'updated >= "2026-01-15 08:30" AND text ~ "login \\"error\\"" ORDER BY updated DESC',
		);
	});

	it('returns only ORDER BY when no filter is set, and nothing when order is empty', () => {
		assert.equal(buildJql({}, 'created', 'ASC'), 'ORDER BY created ASC');
		assert.equal(buildJql({}, '', 'ASC'), '');
	});

	it('rejects order-by values that are not a field name', () => {
		assert.throws(() => buildOrderBy('updated; DROP', 'DESC'), /Invalid order-by field/);
		assert.equal(buildOrderBy('cf[10010]', 'ASC'), 'ORDER BY cf[10010] ASC');
	});

	it('formats dates as Jira wall-clock values', () => {
		assert.equal(formatJqlDate('2026-03-01'), '2026-03-01');
		assert.equal(formatJqlDate('2026-03-01T23:59:59.000Z'), '2026-03-01 23:59');
		assert.throws(() => formatJqlDate('yesterday'), /Invalid date/);
	});
});

describe('create payload mapping', () => {
	const base = { project: 'PROJ', issueType: '10001', summary: 'Hello' };

	it('maps required fields only when nothing else is set', () => {
		assert.deepEqual(buildCreateFields({ ...base, additionalFields: {}, customFields: [] }), {
			project: { key: 'PROJ' },
			issuetype: { id: '10001' },
			summary: 'Hello',
		});
	});

	it('maps every optional field to the Jira REST v2 shape', () => {
		const fields = buildCreateFields({
			...base,
			additionalFields: {
				description: 'Body',
				assignee: ' jdoe ',
				reporter: 'asmith',
				priority: '3',
				labels: 'n8n, automation',
				components: 'Backend, API',
				parentKey: 'proj-7',
				dueDate: '2026-12-31T00:00:00',
			},
			customFields: [],
		});
		assert.deepEqual(fields, {
			project: { key: 'PROJ' },
			issuetype: { id: '10001' },
			summary: 'Hello',
			description: 'Body',
			assignee: { name: 'jdoe' },
			reporter: { name: 'asmith' },
			priority: { id: '3' },
			labels: ['n8n', 'automation'],
			components: [{ name: 'Backend' }, { name: 'API' }],
			parent: { key: 'PROJ-7' },
			duedate: '2026-12-31',
		});
	});

	it('parses custom field values as JSON when possible, else keeps text', () => {
		assert.equal(parseCustomFieldValue('5'), 5);
		assert.deepEqual(parseCustomFieldValue('{"value":"High"}'), { value: 'High' });
		assert.equal(parseCustomFieldValue('"123"'), '123');
		assert.equal(parseCustomFieldValue('plain text'), 'plain text');
	});

	it('adds custom fields, skips rows without id, and lets the JSON escape hatch win', () => {
		const fields = buildCreateFields({
			...base,
			additionalFields: {
				fieldsJson: '{"customfield_10020": {"id": "7"}, "summary": "From JSON"}',
			},
			customFields: [
				{ fieldId: 'customfield_10010', value: '8' },
				{ fieldId: 'customfield_10011', value: 'Team A' },
				{ fieldId: ' ', value: 'ignored' },
			],
		});
		assert.deepEqual(fields, {
			project: { key: 'PROJ' },
			issuetype: { id: '10001' },
			summary: 'From JSON',
			customfield_10010: 8,
			customfield_10011: 'Team A',
			customfield_10020: { id: '7' },
		});
	});

	it('accepts an already-parsed JSON object and rejects non-object JSON', () => {
		const fields = buildCreateFields({
			...base,
			additionalFields: { fieldsJson: { environment: 'prod' } },
			customFields: [],
		});
		assert.equal(fields.environment, 'prod');
		assert.throws(
			() =>
				buildCreateFields({ ...base, additionalFields: { fieldsJson: '[1,2]' }, customFields: [] }),
			/must be a JSON object/,
		);
		assert.throws(
			() =>
				buildCreateFields({ ...base, additionalFields: { fieldsJson: '{bad' }, customFields: [] }),
			SyntaxError,
		);
	});
});
