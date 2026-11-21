import type { IDataObject } from 'n8n-workflow';

import { formatJqlDate, splitList } from './jql';

export interface CustomFieldEntry {
	fieldId?: string;
	value?: string;
}

export interface CreateAdditionalFields {
	description?: string;
	assignee?: string;
	reporter?: string;
	priority?: string;
	labels?: string;
	components?: string;
	parentKey?: string;
	dueDate?: string;
	fieldsJson?: string | IDataObject;
}

export interface CreateIssueInput {
	project: string;
	issueType: string;
	summary: string;
	additionalFields: CreateAdditionalFields;
	customFields: CustomFieldEntry[];
}

/**
 * Custom field values are sent as JSON when they parse as JSON (numbers, objects such as
 * {"value": "High"}, arrays), otherwise as plain strings. Quote a value ("123") to force text.
 */
export function parseCustomFieldValue(raw: string): IDataObject[string] {
	try {
		return JSON.parse(raw) as IDataObject[string];
	} catch {
		return raw;
	}
}

export function parseFieldsJson(raw: string | IDataObject | undefined): IDataObject {
	if (raw === undefined || raw === '') {
		return {};
	}
	const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Additional Fields (JSON) must be a JSON object, e.g. {"customfield_10010": 5}');
	}
	return parsed as IDataObject;
}

function isFilled(value: string | undefined): value is string {
	return value !== undefined && value.trim().length > 0;
}

export function buildCreateFields(input: CreateIssueInput): IDataObject {
	const extra = input.additionalFields;
	const fields: IDataObject = {
		project: { key: input.project },
		issuetype: { id: input.issueType },
		summary: input.summary,
	};

	if (isFilled(extra.description)) {
		fields.description = extra.description;
	}
	if (isFilled(extra.assignee)) {
		fields.assignee = { name: extra.assignee.trim() };
	}
	if (isFilled(extra.reporter)) {
		fields.reporter = { name: extra.reporter.trim() };
	}
	if (isFilled(extra.priority)) {
		fields.priority = { id: extra.priority };
	}
	const labels = splitList(extra.labels);
	if (labels.length > 0) {
		fields.labels = labels;
	}
	const components = splitList(extra.components);
	if (components.length > 0) {
		fields.components = components.map((name) => ({ name }));
	}
	if (isFilled(extra.parentKey)) {
		fields.parent = { key: extra.parentKey.trim().toUpperCase() };
	}
	if (isFilled(extra.dueDate)) {
		fields.duedate = formatJqlDate(extra.dueDate).slice(0, 10);
	}

	for (const entry of input.customFields) {
		if (!isFilled(entry.fieldId)) {
			continue;
		}
		fields[entry.fieldId.trim()] = parseCustomFieldValue(entry.value ?? '');
	}

	return { ...fields, ...parseFieldsJson(extra.fieldsJson) };
}
