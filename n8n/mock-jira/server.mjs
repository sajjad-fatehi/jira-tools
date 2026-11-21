#!/usr/bin/env node
// Minimal Jira Server REST v2 mock for end-to-end checks of the n8n node.
// Like the instances this node targets, it ignores the Authorization header and only accepts
// the JSESSIONID cookie from POST /rest/auth/1/session. Not a real Jira: in-memory, no persistence.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? process.env.MOCK_JIRA_PORT ?? 8089);
// MOCK_JIRA_LEGACY_CREATEMETA=1 makes the paged createmeta endpoint 404, like Jira < 8.4.
const legacyCreateMetaOnly = process.env.MOCK_JIRA_LEGACY_CREATEMETA === '1';
const validUser = { username: 'jdoe', password: 'secret' };
const sessions = new Set();
const log = [];
let lastCreateBody;

const projects = [
	{
		id: '10000',
		key: 'PROJ',
		name: 'Example Project',
		issueTypes: [
			{ id: '10001', name: 'Task', subtask: false },
			{ id: '10002', name: 'Bug', subtask: false },
			{ id: '10003', name: 'Sub-task', subtask: true },
		],
	},
];
const priorities = [
	{ id: '1', name: 'Highest' },
	{ id: '3', name: 'Medium' },
];
const issues = [];
let nextIssueNumber = 1;

const namedUsers = [
	['jdoe', 'Jane Doe'],
	['jsmith', 'John Smith'],
	['akim', 'Alex Kim'],
	['mgarcia', 'Maria Garcia'],
	['pnovak', 'Petra Novak'],
];
// 60 users so the user search needs a second page (pages of 50).
const users = [
	...namedUsers,
	...Array.from({ length: 55 }, (_, index) => {
		const number = String(index + 1).padStart(2, '0');
		return [`tester${number}`, `Test User ${number}`];
	}),
].map(([name, displayName]) => ({
	name,
	key: name,
	displayName,
	emailAddress: `${name}@example.com`,
	active: true,
}));
// Not assignable in PROJ, so assignable search and plain user search differ.
const unassignableUsers = new Set(['pnovak']);

const option = (id, value) => ({ id, value });
const commonFields = [
	{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
	{ fieldId: 'issuetype', name: 'Issue Type', required: true, schema: { type: 'issuetype', system: 'issuetype' } },
	{ fieldId: 'project', name: 'Project', required: true, schema: { type: 'project', system: 'project' } },
	{ fieldId: 'description', name: 'Description', required: false, schema: { type: 'string', system: 'description' } },
	{
		fieldId: 'priority',
		name: 'Priority',
		required: true,
		hasDefaultValue: true,
		schema: { type: 'priority', system: 'priority' },
		allowedValues: priorities,
	},
	{ fieldId: 'labels', name: 'Labels', required: false, schema: { type: 'array', items: 'string', system: 'labels' } },
	{
		fieldId: 'components',
		name: 'Component/s',
		required: false,
		schema: { type: 'array', items: 'component', system: 'components' },
		allowedValues: [
			{ id: '10100', name: 'Backend' },
			{ id: '10101', name: 'Frontend' },
		],
	},
	{
		fieldId: 'fixVersions',
		name: 'Fix Version/s',
		required: false,
		schema: { type: 'array', items: 'version', system: 'fixVersions' },
		allowedValues: [
			{ id: '10200', name: '1.0' },
			{ id: '10201', name: '2.0' },
		],
	},
	{ fieldId: 'duedate', name: 'Due Date', required: false, schema: { type: 'date', system: 'duedate' } },
	{ fieldId: 'assignee', name: 'Assignee', required: false, schema: { type: 'user', system: 'assignee' } },
	{ fieldId: 'reporter', name: 'Reporter', required: true, hasDefaultValue: true, schema: { type: 'user', system: 'reporter' } },
	{
		fieldId: 'customfield_10011',
		name: 'Affected Platforms',
		required: false,
		schema: { type: 'array', items: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselect', customId: 10011 },
		allowedValues: [option('20101', 'Web'), option('20102', 'Android'), option('20103', 'iOS')],
	},
	{
		fieldId: 'customfield_10012',
		name: 'Story Points',
		required: false,
		schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float', customId: 10012 },
	},
	{
		fieldId: 'customfield_10013',
		name: 'Go-Live Date',
		required: false,
		schema: { type: 'datetime', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datetime', customId: 10013 },
	},
	{
		fieldId: 'customfield_10014',
		name: 'Reviewer',
		required: false,
		schema: { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker', customId: 10014 },
	},
	{
		fieldId: 'timetracking',
		name: 'Time tracking',
		required: false,
		schema: { type: 'timetracking', system: 'timetracking' },
	},
];
const severityField = (required) => ({
	fieldId: 'customfield_10010',
	name: 'Severity',
	required,
	schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select', customId: 10010 },
	allowedValues: [option('20001', 'Critical'), option('20002', 'Major'), option('20003', 'Minor')],
});
// Task keeps only Summary mandatory (so the v1 example still works); Bug adds a required custom select.
const createMetaByIssueType = {
	10001: [...commonFields, severityField(false)],
	10002: [
		...commonFields,
		severityField(true),
		{ fieldId: 'environment', name: 'Environment', required: false, schema: { type: 'string', system: 'environment' } },
	],
	10003: [
		...commonFields,
		{ fieldId: 'parent', name: 'Parent', required: true, schema: { type: 'issuelink', system: 'parent' } },
	],
};

function requiredFieldErrors(fields) {
	const errors = {};
	for (const meta of createMetaByIssueType[fields.issuetype?.id] ?? []) {
		if (meta.required && !meta.hasDefaultValue && fields[meta.fieldId] === undefined) {
			errors[meta.fieldId] = `${meta.name} is required.`;
		}
	}
	return errors;
}

function searchUsers(url, candidates) {
	const query = (url.searchParams.get('username') ?? '').toLowerCase();
	const startAt = Number(url.searchParams.get('startAt') ?? 0);
	const maxResults = Math.min(Number(url.searchParams.get('maxResults') ?? 50), 1000);
	const matching =
		query === '' || query === '.'
			? candidates
			: candidates.filter(
					(user) =>
						user.name.toLowerCase().includes(query) || user.displayName.toLowerCase().includes(query),
				);
	return matching.slice(startAt, startAt + maxResults);
}

function seedIssues() {
	const statuses = ['To Do', 'In Progress', 'Done'];
	for (let index = 0; index < 120; index++) {
		addIssue({
			summary: `Seed issue ${index + 1}`,
			issuetype: { id: '10001' },
			status: statuses[index % statuses.length],
			labels: index % 2 === 0 ? ['seed', 'even'] : ['seed'],
		});
	}
}

function addIssue(fields) {
	const number = nextIssueNumber++;
	const key = `PROJ-${number}`;
	const issueType = projects[0].issueTypes.find((type) => type.id === fields.issuetype?.id);
	const issue = {
		id: String(20000 + number),
		key,
		self: `http://localhost:${port}/rest/api/2/issue/${20000 + number}`,
		fields: {
			...fields,
			summary: fields.summary,
			status: { name: fields.status ?? 'To Do' },
			issuetype: { id: issueType?.id, name: issueType?.name },
			created: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(),
			updated: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(),
		},
	};
	issues.push(issue);
	return issue;
}

function send(response, status, body, headers = {}) {
	response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
	response.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(request) {
	return new Promise((resolve) => {
		let raw = '';
		request.on('data', (chunk) => (raw += chunk));
		request.on('end', () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch {
				resolve(undefined);
			}
		});
	});
}

function sessionOf(request) {
	const cookie = request.headers.cookie ?? '';
	const match = /(?:^|;\s*)JSESSIONID=([^;]+)/.exec(cookie);
	return match && sessions.has(match[1]) ? match[1] : undefined;
}

// Only the subset of JQL the node builder emits: AND-joined "field = value" / "field in (...)",
// "updated >= ...", "text ~ ...", and an ORDER BY clause.
function filterByJql(jql) {
	const [where] = jql.split(/\s+ORDER BY\s+/i);
	const statusMatch = /status (?:= "([^"]+)"|in \(([^)]+)\))/.exec(where);
	const labelMatch = /labels (?:= "([^"]+)"|in \(([^)]+)\))/.exec(where);
	const textMatch = /text ~ "((?:[^"\\]|\\.)*)"/.exec(where);
	const listOf = (match) =>
		match[1] ? [match[1]] : match[2].split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
	return issues.filter((issue) => {
		if (statusMatch && !listOf(statusMatch).includes(issue.fields.status.name)) {
			return false;
		}
		if (labelMatch && !listOf(labelMatch).some((label) => issue.fields.labels?.includes(label))) {
			return false;
		}
		if (textMatch) {
			const needle = textMatch[1].replace(/\\(.)/g, '$1').toLowerCase();
			return issue.fields.summary.toLowerCase().includes(needle);
		}
		return true;
	});
}

function pickFields(issue, fields) {
	if (!fields || fields.length === 0 || fields.includes('*all')) {
		return issue;
	}
	const picked = {};
	for (const field of fields) {
		if (field in issue.fields) {
			picked[field] = issue.fields[field];
		}
	}
	return { id: issue.id, key: issue.key, self: issue.self, fields: picked };
}

async function handle(request, response) {
	const url = new URL(request.url, `http://localhost:${port}`);
	const route = `${request.method} ${url.pathname}`;
	log.push({
		route,
		query: url.search,
		cookie: Boolean(request.headers.cookie),
		xsrf: request.headers['x-atlassian-token'],
	});

	if (route === 'GET /__log') {
		return send(response, 200, log);
	}
	if (route === 'GET /__last-create') {
		return send(response, 200, lastCreateBody ?? {});
	}
	if (route === 'POST /rest/auth/1/session') {
		const body = await readBody(request);
		if (body?.username !== validUser.username || body?.password !== validUser.password) {
			return send(response, 401, { errorMessages: ['Login failed'] }, {
				'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED',
			});
		}
		const sessionId = randomUUID();
		sessions.add(sessionId);
		return send(response, 200, { session: { name: 'JSESSIONID', value: sessionId } }, {
			'Set-Cookie': [`JSESSIONID=${sessionId}; Path=/; HttpOnly`, 'atlassian.xsrf.token=MOCK|lin; Path=/'],
		});
	}

	if (!sessionOf(request)) {
		return send(response, 401, { errorMessages: ['You are not authenticated.'] });
	}

	if (route === 'GET /rest/api/2/myself') {
		return send(response, 200, { name: validUser.username, displayName: 'Jane Doe', active: true });
	}
	if (route === 'GET /rest/api/2/project') {
		return send(response, 200, projects.map(({ issueTypes, ...project }) => project));
	}
	const projectMatch = /^GET \/rest\/api\/2\/project\/([^/]+)$/.exec(route);
	if (projectMatch) {
		const project = projects.find((candidate) => candidate.key === decodeURIComponent(projectMatch[1]));
		return project ? send(response, 200, project) : send(response, 404, { errorMessages: ['No project'] });
	}
	const createMetaMatch = /^GET \/rest\/api\/2\/issue\/createmeta\/([^/]+)\/issuetypes\/([^/]+)$/.exec(route);
	if (createMetaMatch) {
		if (legacyCreateMetaOnly) {
			return send(response, 404, { errorMessages: ['null for uri'] });
		}
		const project = projects.find((candidate) => candidate.key === decodeURIComponent(createMetaMatch[1]));
		const fields = project ? createMetaByIssueType[decodeURIComponent(createMetaMatch[2])] : undefined;
		if (!fields) {
			return send(response, 404, { errorMessages: ['Issue type not found'] });
		}
		const startAt = Number(url.searchParams.get('startAt') ?? 0);
		const maxResults = Math.min(Number(url.searchParams.get('maxResults') ?? 50), 50);
		const values = fields.slice(startAt, startAt + maxResults);
		return send(response, 200, {
			startAt,
			maxResults,
			total: fields.length,
			isLast: startAt + values.length >= fields.length,
			values,
		});
	}
	if (route === 'GET /rest/api/2/issue/createmeta') {
		const wantedKeys = (url.searchParams.get('projectKeys') ?? '').split(',').filter(Boolean);
		const wantedTypes = (url.searchParams.get('issuetypeIds') ?? '').split(',').filter(Boolean);
		const withFields = url.searchParams.get('expand')?.includes('projects.issuetypes.fields');
		const selected = projects.filter((project) => wantedKeys.length === 0 || wantedKeys.includes(project.key));
		return send(response, 200, {
			projects: selected.map(({ issueTypes, ...project }) => ({
				...project,
				issuetypes: issueTypes
					.filter((type) => wantedTypes.length === 0 || wantedTypes.includes(type.id))
					.map((type) => ({
						...type,
						...(withFields
							? {
									fields: Object.fromEntries(
										(createMetaByIssueType[type.id] ?? []).map(({ fieldId, ...meta }) => [fieldId, meta]),
									),
								}
							: {}),
					})),
			})),
		});
	}
	if (route === 'GET /rest/api/2/user/assignable/search') {
		if (!url.searchParams.get('project') && !url.searchParams.get('issueKey')) {
			return send(response, 400, { errorMessages: ['The project or issueKey parameter is required.'] });
		}
		return send(response, 200, searchUsers(url, users.filter((user) => !unassignableUsers.has(user.name))));
	}
	if (route === 'GET /rest/api/2/user/search') {
		if (!url.searchParams.get('username')) {
			return send(response, 400, { errorMessages: ['The username query parameter was not provided'] });
		}
		return send(response, 200, searchUsers(url, users));
	}
	if (route === 'GET /rest/api/2/priority') {
		return send(response, 200, priorities);
	}
	if (route === 'POST /rest/api/2/issue') {
		if (request.headers['x-atlassian-token'] !== 'no-check') {
			return send(response, 403, { errorMessages: ['XSRF check failed'] });
		}
		const body = await readBody(request);
		lastCreateBody = body;
		const fields = body?.fields;
		if (!fields?.summary || fields.project?.key !== 'PROJ' || !fields.issuetype?.id) {
			return send(response, 400, { errorMessages: [], errors: { summary: 'You must specify a summary of the issue.' } });
		}
		const missing = requiredFieldErrors(fields);
		if (Object.keys(missing).length > 0) {
			return send(response, 400, { errorMessages: [], errors: missing });
		}
		const issue = addIssue(fields);
		return send(response, 201, { id: issue.id, key: issue.key, self: issue.self });
	}
	if (route === 'POST /rest/api/2/search') {
		const body = (await readBody(request)) ?? {};
		const matching = filterByJql(String(body.jql ?? ''));
		const startAt = Number(body.startAt ?? 0);
		const maxResults = Math.min(Number(body.maxResults ?? 50), 100);
		return send(response, 200, {
			startAt,
			maxResults,
			total: matching.length,
			issues: matching.slice(startAt, startAt + maxResults).map((issue) => pickFields(issue, body.fields)),
		});
	}
	return send(response, 404, { errorMessages: [`Mock has no route ${route}`] });
}

seedIssues();
createServer((request, response) => {
	handle(request, response).catch((error) => send(response, 500, { errorMessages: [String(error)] }));
}).listen(port, '0.0.0.0', () => {
	console.log(`mock Jira on http://localhost:${port} (user ${validUser.username} / ${validUser.password})`);
});
