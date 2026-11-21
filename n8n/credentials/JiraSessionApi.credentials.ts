import type {
	IAuthenticateGeneric,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IDataObject,
	IHttpRequestHelper,
	IN8nHttpFullResponse,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

import {
	buildCookieHeader,
	describeLoginFailure,
	normalizeBaseUrl,
	readHeader,
	SESSION_PATH,
	type LoginResponseBody,
} from '../nodes/JiraSession/session';

export class JiraSessionApi implements ICredentialType {
	name = 'jiraSessionApi';

	displayName = 'Jira Session API';

	icon: Icon = {
		light: 'file:../nodes/JiraSession/jira.svg',
		dark: 'file:../nodes/JiraSession/jira.dark.svg',
	};

	documentationUrl = 'https://github.com/sajjad-fatehi/jira-tools/tree/main/n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://jira.example.com',
			description: 'Root URL of the Jira Server / Data Center instance, without /rest',
			required: true,
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Session Cookie',
			name: 'sessionCookie',
			type: 'hidden',
			typeOptions: { expirable: true },
			default: '',
		},
	];

	/**
	 * Called by n8n when the stored session cookie is empty, or once after a request answered 401.
	 * A failed login throws and is never retried, because repeated failures trigger Jira's CAPTCHA.
	 */
	async preAuthentication(
		this: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
	): Promise<IDataObject> {
		const baseUrl = normalizeBaseUrl(String(credentials.baseUrl ?? ''));
		const response = (await this.helpers.httpRequest({
			method: 'POST',
			url: `${baseUrl}${SESSION_PATH}`,
			body: {
				username: String(credentials.username ?? ''),
				password: String(credentials.password ?? ''),
			},
			json: true,
			headers: { Accept: 'application/json' },
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		})) as IN8nHttpFullResponse;

		if (response.statusCode !== 200) {
			const reason = readHeader(response.headers, 'X-Seraph-LoginReason');
			throw new Error(
				describeLoginFailure(response.statusCode, Array.isArray(reason) ? reason[0] : reason),
			);
		}

		const sessionCookie = buildCookieHeader(
			readHeader(response.headers, 'set-cookie'),
			response.body as LoginResponseBody,
		);
		if (!sessionCookie) {
			throw new Error('Jira login returned HTTP 200 but no session cookie');
		}
		return { sessionCookie };
	}

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Cookie: '={{$credentials.sessionCookie}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/rest/api/2/myself',
			method: 'GET',
		},
	};
}
