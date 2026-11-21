export const SESSION_PATH = '/rest/auth/1/session';
export const API_PREFIX = '/rest/api/2';
export const XSRF_HEADER = 'X-Atlassian-Token';
export const CREDENTIAL_NAME = 'jiraSessionApi';

export interface LoginResponseBody {
	session?: {
		name?: string;
		value?: string;
	};
}

export function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, '');
	if (!/^https?:\/\/[^/]+/i.test(trimmed)) {
		throw new Error(`Jira base URL must start with http:// or https://, got "${baseUrl}"`);
	}
	return trimmed;
}

/**
 * Keeps only the name=value pair of every Set-Cookie line, because some Jira setups need more than
 * JSESSIONID (load-balancer affinity cookies, XSRF token). Falls back to the session object of the
 * login response body when a proxy strips Set-Cookie.
 */
export function buildCookieHeader(
	setCookie: string | string[] | undefined,
	body?: LoginResponseBody,
): string {
	const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
	const pairs = new Map<string, string>();
	for (const line of lines) {
		const pair = line.split(';', 1)[0].trim();
		const separator = pair.indexOf('=');
		if (separator <= 0) {
			continue;
		}
		pairs.set(pair.slice(0, separator), pair.slice(separator + 1));
	}

	const sessionName = body?.session?.name;
	const sessionValue = body?.session?.value;
	if (sessionName && sessionValue && !pairs.has(sessionName)) {
		pairs.set(sessionName, sessionValue);
	}

	return Array.from(pairs, ([name, value]) => `${name}=${value}`).join('; ');
}

export function describeLoginFailure(statusCode: number, loginReason?: string): string {
	const reason = loginReason ? ` (${loginReason})` : '';
	return (
		`Jira login failed: HTTP ${statusCode}${reason}. Check the username and password of the ` +
		'Jira Session credential. Not retrying, to avoid a CAPTCHA lockout.'
	);
}

export function readHeader(
	headers: Record<string, unknown> | undefined,
	name: string,
): string | string[] | undefined {
	if (!headers) {
		return undefined;
	}
	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== lowerName) {
			continue;
		}
		if (typeof value === 'string' || Array.isArray(value)) {
			return value as string | string[];
		}
	}
	return undefined;
}
