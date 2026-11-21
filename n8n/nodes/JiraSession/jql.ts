export interface SearchFilters {
	project?: string;
	status?: string;
	issueType?: string;
	assignee?: string;
	labels?: string;
	updatedSince?: string;
	text?: string;
}

export type OrderDirection = 'ASC' | 'DESC';

const UNQUOTED_FUNCTIONS = new Set(['currentuser()']);
const ORDER_FIELD_PATTERN = /^[A-Za-z0-9_.]+$|^cf\[\d+\]$/;
const DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/;

/** Quotes a JQL string literal: backslash and double quote are escaped, control characters dropped. */
export function quoteJqlValue(value: string): string {
	const escaped = value
		.replace(/\p{Cc}+/gu, ' ')
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"');
	return `"${escaped}"`;
}

export function splitList(value: string | undefined): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function formatJqlOperand(value: string): string {
	if (UNQUOTED_FUNCTIONS.has(value.toLowerCase())) {
		return value;
	}
	return quoteJqlValue(value);
}

function buildListClause(field: string, rawValue: string | undefined): string | undefined {
	const values = splitList(rawValue);
	if (values.length === 0) {
		return undefined;
	}
	if (values.length === 1) {
		return `${field} = ${formatJqlOperand(values[0])}`;
	}
	return `${field} in (${values.map(formatJqlOperand).join(', ')})`;
}

/** Jira JQL accepts "yyyy-MM-dd HH:mm" in the user's time zone, so the given wall time is kept as is. */
export function formatJqlDate(value: string): string {
	const match = DATE_TIME_PATTERN.exec(value.trim());
	if (!match) {
		throw new Error(`Invalid date "${value}", expected yyyy-MM-dd or yyyy-MM-ddTHH:mm`);
	}
	const [, date, time] = match;
	return time ? `${date} ${time}` : date;
}

export function buildOrderBy(field: string | undefined, direction: OrderDirection): string {
	const trimmed = (field ?? '').trim();
	if (!trimmed) {
		return '';
	}
	if (!ORDER_FIELD_PATTERN.test(trimmed)) {
		throw new Error(`Invalid order-by field "${trimmed}"`);
	}
	return `ORDER BY ${trimmed} ${direction}`;
}

export function buildJql(
	filters: SearchFilters,
	orderField?: string,
	orderDirection: OrderDirection = 'DESC',
): string {
	const clauses: string[] = [];
	const listClauses: Array<[string, string | undefined]> = [
		['project', filters.project],
		['status', filters.status],
		['issuetype', filters.issueType],
		['assignee', filters.assignee],
		['labels', filters.labels],
	];
	for (const [field, value] of listClauses) {
		const clause = buildListClause(field, value);
		if (clause) {
			clauses.push(clause);
		}
	}
	if (filters.updatedSince) {
		clauses.push(`updated >= ${quoteJqlValue(formatJqlDate(filters.updatedSince))}`);
	}
	if (filters.text && filters.text.trim()) {
		clauses.push(`text ~ ${quoteJqlValue(filters.text.trim())}`);
	}

	const orderBy = buildOrderBy(orderField, orderDirection);
	return [clauses.join(' AND '), orderBy].filter((part) => part.length > 0).join(' ');
}
