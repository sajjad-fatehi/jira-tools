import type {
	FieldType,
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	ResourceMapperField,
} from 'n8n-workflow';

import { parseCustomFieldValue } from './issueFields';
import { splitList } from './jql';
import { jiraApiRequest, toNodeError } from './transport';

type JiraContext = IExecuteFunctions | ILoadOptionsFunctions;

export const CREATE_META_PAGE_SIZE = 50;

/**
 * Fields chosen by dedicated parameters (project, issue type, assignee, reporter) or that the create
 * request cannot set (attachments are uploaded separately) never appear in the Fields mapper.
 */
export const EXCLUDED_FIELD_IDS = new Set([
	'project',
	'issuetype',
	'assignee',
	'reporter',
	'attachment',
]);

const REFERENCE_KINDS = new Set([
	'option',
	'priority',
	'resolution',
	'version',
	'component',
	'securitylevel',
	'project',
	'issuetype',
]);
const USER_KINDS = new Set(['user', 'group']);
const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

export interface JiraFieldSchema {
	type?: string;
	items?: string;
	system?: string;
	custom?: string;
}

export interface JiraAllowedValue {
	id?: string;
	name?: string;
	value?: string;
	key?: string;
}

export interface JiraFieldMeta {
	fieldId: string;
	name?: string;
	required?: boolean;
	hasDefaultValue?: boolean;
	schema?: JiraFieldSchema;
	allowedValues?: JiraAllowedValue[];
}

interface CreateMetaPage {
	startAt?: number;
	total?: number;
	isLast?: boolean;
	values?: JiraFieldMeta[];
}

interface LegacyCreateMeta {
	projects?: Array<{
		issuetypes?: Array<{
			id?: string;
			fields?: Record<string, Omit<JiraFieldMeta, 'fieldId'>>;
		}>;
	}>;
}

export type MapperValue = string | number | boolean | null | undefined | IDataObject | unknown[];

function isNotFound(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const candidate = error as { httpCode?: unknown; response?: { status?: unknown } };
	return String(candidate.httpCode ?? candidate.response?.status ?? '') === '404';
}

async function fetchPagedCreateMeta(
	this: JiraContext,
	projectKey: string,
	issueTypeId: string,
): Promise<JiraFieldMeta[]> {
	const endpoint =
		`/issue/createmeta/${encodeURIComponent(projectKey)}` +
		`/issuetypes/${encodeURIComponent(issueTypeId)}`;
	const fields: JiraFieldMeta[] = [];
	let startAt = 0;

	for (;;) {
		const page = (await jiraApiRequest.call(this, 'GET', endpoint, undefined, {
			startAt,
			maxResults: CREATE_META_PAGE_SIZE,
		})) as CreateMetaPage;
		const values = page.values ?? [];
		fields.push(...values);
		startAt += values.length;

		const reachedTotal = page.total !== undefined && startAt >= page.total;
		if (values.length === 0 || page.isLast === true || reachedTotal) {
			return fields;
		}
	}
}

async function fetchLegacyCreateMeta(
	this: JiraContext,
	projectKey: string,
	issueTypeId: string,
): Promise<JiraFieldMeta[]> {
	const response = (await jiraApiRequest.call(this, 'GET', '/issue/createmeta', undefined, {
		projectKeys: projectKey,
		issuetypeIds: issueTypeId,
		expand: 'projects.issuetypes.fields',
	})) as LegacyCreateMeta;
	const issueTypes = response.projects?.[0]?.issuetypes ?? [];
	const issueType = issueTypes.find((candidate) => candidate.id === issueTypeId) ?? issueTypes[0];
	return Object.entries(issueType?.fields ?? {}).map(([fieldId, meta]) => ({ ...meta, fieldId }));
}

/**
 * Reads the create screen of a project + issue type from the paged endpoint (Jira 8.4+) and falls back
 * to the legacy expand-based endpoint when the server does not know the new one (404).
 */
export async function fetchCreateMeta(
	this: JiraContext,
	projectKey: string,
	issueTypeId: string,
): Promise<JiraFieldMeta[]> {
	try {
		return await fetchPagedCreateMeta.call(this, projectKey, issueTypeId);
	} catch (error) {
		if (!isNotFound(error)) {
			throw toNodeError(this.getNode(), error);
		}
		return await fetchLegacyCreateMeta.call(this, projectKey, issueTypeId);
	}
}

function valueKind(meta: JiraFieldMeta): string {
	const schema = meta.schema ?? {};
	if (schema.type === 'array') {
		return schema.items ?? 'any';
	}
	return schema.type ?? 'any';
}

function isArrayField(meta: JiraFieldMeta): boolean {
	return meta.schema?.type === 'array';
}

function isParentField(meta: JiraFieldMeta): boolean {
	return meta.fieldId === 'parent' || meta.schema?.system === 'parent';
}

function hasAllowedValues(meta: JiraFieldMeta): boolean {
	return (meta.allowedValues ?? []).some((allowed) => allowed.id !== undefined);
}

function labelOf(allowed: JiraAllowedValue): string {
	return String(allowed.name ?? allowed.value ?? allowed.key ?? allowed.id);
}

function toAllowedOptions(meta: JiraFieldMeta): INodePropertyOptions[] {
	const options: INodePropertyOptions[] = [];
	for (const allowed of meta.allowedValues ?? []) {
		if (allowed.id === undefined) {
			continue;
		}
		options.push({ name: labelOf(allowed), value: String(allowed.id) });
	}
	return options;
}

export function mapFieldType(meta: JiraFieldMeta): FieldType {
	if (hasAllowedValues(meta)) {
		return 'options';
	}
	const kind = valueKind(meta);
	if (kind === 'number' && !isArrayField(meta)) {
		return 'number';
	}
	if ((kind === 'date' || kind === 'datetime') && !isArrayField(meta)) {
		return 'dateTime';
	}
	return 'string';
}

export function isFieldRequired(meta: JiraFieldMeta): boolean {
	return meta.required === true && meta.hasDefaultValue !== true;
}

function compareFields(left: ResourceMapperField, right: ResourceMapperField): number {
	if (left.id === 'summary' || right.id === 'summary') {
		return left.id === 'summary' ? -1 : 1;
	}
	if (left.required !== right.required) {
		return left.required ? -1 : 1;
	}
	return left.displayName.localeCompare(right.displayName);
}

/** Turns Jira create metadata into the n8n resource mapper schema: summary first, then required, then A-Z. */
export function toResourceMapperFields(metas: JiraFieldMeta[]): ResourceMapperField[] {
	const fields: ResourceMapperField[] = [];
	for (const meta of metas) {
		if (EXCLUDED_FIELD_IDS.has(meta.fieldId)) {
			continue;
		}
		const type = mapFieldType(meta);
		const field: ResourceMapperField = {
			id: meta.fieldId,
			displayName: meta.name ?? meta.fieldId,
			required: isFieldRequired(meta),
			defaultMatch: false,
			canBeUsedToMatch: false,
			display: true,
			type,
		};
		if (type === 'options') {
			field.options = toAllowedOptions(meta);
		}
		fields.push(field);
	}
	return fields.sort(compareFields);
}

function isEmptyValue(value: MapperValue): boolean {
	if (value === undefined || value === null) {
		return true;
	}
	return typeof value === 'string' && value.trim().length === 0;
}

function toValueList(value: MapperValue): unknown[] {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== 'string') {
		return [value];
	}
	const trimmed = value.trim();
	const parsed = trimmed.startsWith('[') ? parseCustomFieldValue(trimmed) : undefined;
	if (Array.isArray(parsed)) {
		return parsed;
	}
	return splitList(trimmed);
}

function toReference(meta: JiraFieldMeta, entry: unknown): IDataObject {
	if (typeof entry === 'object' && entry !== null) {
		return entry as IDataObject;
	}
	const text = String(entry).trim();
	const allowedValues = meta.allowedValues ?? [];
	const byId = allowedValues.find((allowed) => String(allowed.id) === text);
	if (byId) {
		return { id: String(byId.id) };
	}
	const lowerText = text.toLowerCase();
	const byLabel = allowedValues.find(
		(allowed) => allowed.id !== undefined && labelOf(allowed).toLowerCase() === lowerText,
	);
	if (byLabel) {
		return { id: String(byLabel.id) };
	}
	if (allowedValues.length > 0) {
		const choices = allowedValues.map(labelOf).join(', ');
		throw new Error(`"${text}" is not an allowed value of ${fieldLabel(meta)} (${choices})`);
	}
	return valueKind(meta) === 'option' ? { value: text } : { name: text };
}

function fieldLabel(meta: JiraFieldMeta): string {
	return meta.name ?? meta.fieldId;
}

function formatJiraDate(meta: JiraFieldMeta, value: string): string {
	const match = DATE_PATTERN.exec(value.trim());
	if (!match) {
		throw new Error(`${fieldLabel(meta)} must be a date (yyyy-MM-dd), got "${value}"`);
	}
	return match[1];
}

/** Jira expects yyyy-MM-ddTHH:mm:ss.SSS+hhmm; values without an offset are read as UTC. */
function formatJiraDateTime(meta: JiraFieldMeta, value: string): string {
	const text = value.trim();
	const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
	const parsed = new Date(hasZone ? text : `${text}Z`);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`${fieldLabel(meta)} must be an ISO 8601 date-time, got "${value}"`);
	}
	return parsed.toISOString().replace('Z', '+0000');
}

function toNumber(meta: JiraFieldMeta, value: MapperValue): number {
	const parsed = typeof value === 'number' ? value : Number(String(value).trim());
	if (Number.isNaN(parsed)) {
		throw new Error(`${fieldLabel(meta)} must be a number, got "${String(value)}"`);
	}
	return parsed;
}

/** Converts one mapper value into the JSON shape Jira expects for the field's schema. */
export function toJiraFieldValue(meta: JiraFieldMeta, value: MapperValue): IDataObject[string] {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value;
	}
	const kind = valueKind(meta);
	const isArray = isArrayField(meta);

	if (isParentField(meta)) {
		return { key: String(value).trim().toUpperCase() };
	}
	if (hasAllowedValues(meta) || REFERENCE_KINDS.has(kind)) {
		const references = toValueList(value).map((entry) => toReference(meta, entry));
		return isArray ? references : references[0];
	}
	if (USER_KINDS.has(kind)) {
		const names = toValueList(value).map((entry) => ({ name: String(entry).trim() }));
		return isArray ? names : names[0];
	}
	if (isArray && (kind === 'string' || kind === 'any')) {
		return toValueList(value).map((entry) => String(entry));
	}
	if (kind === 'string') {
		return String(value);
	}
	if (kind === 'number') {
		return toNumber(meta, value);
	}
	if (kind === 'date') {
		return formatJiraDate(meta, String(value));
	}
	if (kind === 'datetime') {
		return formatJiraDateTime(meta, String(value));
	}
	if (Array.isArray(value)) {
		return value as IDataObject[];
	}
	return typeof value === 'string' ? parseCustomFieldValue(value) : value;
}

export interface CreatePayloadInput {
	project: string;
	issueType: string;
	fieldMetas: JiraFieldMeta[];
	values: Record<string, MapperValue>;
	assignee?: string;
	reporter?: string;
	fieldsJson?: IDataObject;
}

/**
 * Builds the "fields" object of a v2 create request. Values for fields Jira does not list on the create
 * screen are dropped (auto-mapped input often carries unrelated keys); Additional Fields (JSON) wins last.
 */
export function buildCreatePayload(input: CreatePayloadInput): IDataObject {
	const fields: IDataObject = {
		project: { key: input.project },
		issuetype: { id: input.issueType },
	};
	const metaById = new Map(input.fieldMetas.map((meta) => [meta.fieldId, meta]));

	for (const [fieldId, value] of Object.entries(input.values)) {
		const meta = metaById.get(fieldId);
		if (!meta || EXCLUDED_FIELD_IDS.has(fieldId) || isEmptyValue(value)) {
			continue;
		}
		fields[fieldId] = toJiraFieldValue(meta, value);
	}

	if (input.assignee?.trim()) {
		fields.assignee = { name: input.assignee.trim() };
	}
	if (input.reporter?.trim()) {
		fields.reporter = { name: input.reporter.trim() };
	}

	return { ...fields, ...(input.fieldsJson ?? {}) };
}
