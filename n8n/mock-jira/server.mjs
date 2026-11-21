#!/usr/bin/env node
// Minimal Jira Server REST v2 mock for end-to-end checks of the n8n node.
// Like the instances this node targets, it ignores the Authorization header and only accepts
// the JSESSIONID cookie from POST /rest/auth/1/session. Not a real Jira: in-memory, no persistence.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.argv[2] ?? process.env.MOCK_JIRA_PORT ?? 8089);
const validUser = { username: 'jdoe', password: 'secret' };
const sessions = new Set();
const log = [];

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
	log.push({ route, cookie: Boolean(request.headers.cookie), xsrf: request.headers['x-atlassian-token'] });

	if (route === 'GET /__log') {
		return send(response, 200, log);
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
	if (route === 'GET /rest/api/2/issue/createmeta') {
		return send(response, 200, { projects });
	}
	if (route === 'GET /rest/api/2/priority') {
		return send(response, 200, priorities);
	}
	if (route === 'POST /rest/api/2/issue') {
		if (request.headers['x-atlassian-token'] !== 'no-check') {
			return send(response, 403, { errorMessages: ['XSRF check failed'] });
		}
		const body = await readBody(request);
		const fields = body?.fields;
		if (!fields?.summary || fields.project?.key !== 'PROJ' || !fields.issuetype?.id) {
			return send(response, 400, { errorMessages: [], errors: { summary: 'You must specify a summary of the issue.' } });
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
