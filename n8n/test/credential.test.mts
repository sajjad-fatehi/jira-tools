import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IHttpRequestHelper, IHttpRequestOptions, IN8nHttpFullResponse } from 'n8n-workflow';

import { JiraSessionApi } from '../credentials/JiraSessionApi.credentials.ts';
import { buildCookieHeader, describeLoginFailure, normalizeBaseUrl } from '../nodes/JiraSession/session.ts';
import { BASE_URL } from './helpers.mts';

function createHelper(response: IN8nHttpFullResponse): {
	helper: IHttpRequestHelper;
	calls: IHttpRequestOptions[];
} {
	const calls: IHttpRequestOptions[] = [];
	const helper = {
		helpers: {
			httpRequest: async (options: IHttpRequestOptions) => {
				calls.push(options);
				return response;
			},
		},
	};
	return { helper: helper as unknown as IHttpRequestHelper, calls };
}

const credentials = { baseUrl: `${BASE_URL}//`, username: 'jdoe', password: 'secret' };

describe('session cookie handling', () => {
	it('keeps every name=value pair of Set-Cookie and drops attributes', () => {
		const header = buildCookieHeader([
			'JSESSIONID=ABC123; Path=/; HttpOnly',
			'atlassian.xsrf.token=TOKEN|lin; Path=/; Secure',
		]);
		assert.equal(header, 'JSESSIONID=ABC123; atlassian.xsrf.token=TOKEN|lin');
	});

	it('falls back to the session object of the login body when Set-Cookie is stripped', () => {
		assert.equal(
			buildCookieHeader(undefined, { session: { name: 'JSESSIONID', value: 'FROMBODY' } }),
			'JSESSIONID=FROMBODY',
		);
	});

	it('prefers the Set-Cookie value over the body for the same cookie name', () => {
		assert.equal(
			buildCookieHeader('JSESSIONID=HEADER; Path=/', {
				session: { name: 'JSESSIONID', value: 'BODY' },
			}),
			'JSESSIONID=HEADER',
		);
	});

	it('normalizes the base URL and rejects non-http values', () => {
		assert.equal(normalizeBaseUrl(' https://jira.example.com/// '), BASE_URL);
		assert.throws(() => normalizeBaseUrl('jira.example.com'), /must start with http/);
	});
});

describe('JiraSessionApi credential', () => {
	const credential = new JiraSessionApi();

	it('logs in with POST /rest/auth/1/session and returns the cookie as the expirable field', async () => {
		const { helper, calls } = createHelper({
			statusCode: 200,
			headers: { 'set-cookie': ['JSESSIONID=ABC; Path=/; HttpOnly', 'other=1; Path=/'] },
			body: { session: { name: 'JSESSIONID', value: 'ABC' } },
		});

		const output = await credential.preAuthentication.call(helper, credentials);

		assert.deepEqual(output, { sessionCookie: 'JSESSIONID=ABC; other=1' });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, 'POST');
		assert.equal(calls[0].url, `${BASE_URL}/rest/auth/1/session`);
		assert.deepEqual(calls[0].body, { username: 'jdoe', password: 'secret' });
		assert.equal(calls[0].returnFullResponse, true);
		assert.equal(calls[0].ignoreHttpStatusErrors, true);
	});

	it('fails a rejected login with a clear message and sends exactly one login request', async () => {
		const { helper, calls } = createHelper({
			statusCode: 401,
			headers: { 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED' },
			body: { errorMessages: ['Login failed'] },
		});

		await assert.rejects(
			credential.preAuthentication.call(helper, credentials),
			(error: Error) =>
				error.message === describeLoginFailure(401, 'AUTHENTICATED_FAILED') &&
				/Not retrying/.test(error.message),
		);
		assert.equal(calls.length, 1);
	});

	it('fails on a CAPTCHA challenge (403) without retrying', async () => {
		const { helper, calls } = createHelper({
			statusCode: 403,
			headers: { 'x-seraph-loginreason': 'AUTHENTICATION_DENIED' },
			body: {},
		});
		await assert.rejects(
			credential.preAuthentication.call(helper, credentials),
			/HTTP 403 \(AUTHENTICATION_DENIED\)/,
		);
		assert.equal(calls.length, 1);
	});

	it('rejects a 200 login response that carries no session cookie', async () => {
		const { helper } = createHelper({ statusCode: 200, headers: {}, body: {} });
		await assert.rejects(credential.preAuthentication.call(helper, credentials), /no session cookie/);
	});

	it('sends the session as Cookie and tests against GET /rest/api/2/myself', () => {
		assert.deepEqual(credential.authenticate.properties.headers, {
			Cookie: '={{$credentials.sessionCookie}}',
		});
		assert.equal(credential.test.request.url, '/rest/api/2/myself');
		assert.equal(credential.test.request.method, 'GET');
		assert.match(String(credential.test.request.baseURL), /\$credentials\.baseUrl/);
	});

	it('marks the password as secret and the session cookie as hidden + expirable', () => {
		const password = credential.properties.find((property) => property.name === 'password');
		const session = credential.properties.find((property) => property.name === 'sessionCookie');
		assert.equal(password?.typeOptions?.password, true);
		assert.equal(session?.type, 'hidden');
		assert.equal(session?.typeOptions?.expirable, true);
	});
});
