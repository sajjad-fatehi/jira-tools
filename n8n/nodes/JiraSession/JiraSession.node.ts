import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ResourceMapperFields,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	buildCreatePayload,
	fetchCreateMeta,
	type JiraFieldMeta,
	type MapperValue,
	toResourceMapperFields,
} from './createMeta';
import { DEFAULT_SEARCH_FIELDS, issueFields, issueOperations } from './IssueDescription';
import {
	buildCreateFields,
	type CreateAdditionalFields,
	type CustomFieldEntry,
	parseFieldsJson,
} from './issueFields';
import { buildJql, splitList, type OrderDirection, type SearchFilters } from './jql';
import { CREDENTIAL_NAME } from './session';
import { getBaseUrl, jiraApiRequest, searchIssues, toNodeError } from './transport';
import { readLocatorValue, searchAllUsers, searchAssignableUsers } from './users';

interface NamedEntity {
	id?: string;
	key?: string;
	name?: string;
	subtask?: boolean;
}

function toOptions(
	entities: NamedEntity[],
	valueOf: (entity: NamedEntity) => string | undefined,
	labelOf: (entity: NamedEntity) => string,
): INodePropertyOptions[] {
	const options: INodePropertyOptions[] = [];
	for (const entity of entities) {
		const value = valueOf(entity);
		if (!value) {
			continue;
		}
		options.push({ name: labelOf(entity), value });
	}
	return options.sort((left, right) => left.name.localeCompare(right.name));
}

async function createIssue(
	this: IExecuteFunctions,
	itemIndex: number,
	baseUrl: string,
): Promise<IDataObject> {
	const customFieldCollection = this.getNodeParameter('customFields', itemIndex, {}) as {
		field?: CustomFieldEntry[];
	};
	let fields: IDataObject;
	try {
		fields = buildCreateFields({
			project: this.getNodeParameter('project', itemIndex) as string,
			issueType: this.getNodeParameter('issueType', itemIndex) as string,
			summary: this.getNodeParameter('summary', itemIndex) as string,
			additionalFields: this.getNodeParameter(
				'additionalFields',
				itemIndex,
				{},
			) as CreateAdditionalFields,
			customFields: customFieldCollection.field ?? [],
		});
	} catch (error) {
		throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
	}

	const created = await jiraApiRequest.call(this, 'POST', '/issue', { fields });
	return toCreatedOutput(created, baseUrl);
}

function toCreatedOutput(created: IDataObject, baseUrl: string): IDataObject {
	const key = String(created.key ?? '');
	return {
		id: created.id,
		key,
		self: created.self,
		url: `${baseUrl}/browse/${key}`,
	};
}

type CreateMetaCache = Map<string, Promise<JiraFieldMeta[]>>;

function readMapperValues(
	mapper: ResourceMapperValue | undefined,
	item: INodeExecutionData,
): Record<string, MapperValue> {
	if (mapper?.mappingMode === 'autoMapInputData') {
		return item.json as Record<string, MapperValue>;
	}
	return mapper?.value ?? {};
}

async function createIssueV2(
	this: IExecuteFunctions,
	itemIndex: number,
	baseUrl: string,
	createMetaCache: CreateMetaCache,
): Promise<IDataObject> {
	const project = this.getNodeParameter('project', itemIndex) as string;
	const issueType = this.getNodeParameter('issueType', itemIndex) as string;
	const cacheKey = `${project}\u0000${issueType}`;
	const fieldMetas =
		createMetaCache.get(cacheKey) ?? fetchCreateMeta.call(this, project, issueType);
	createMetaCache.set(cacheKey, fieldMetas);

	let fields: IDataObject;
	try {
		const mapper = this.getNodeParameter('createFields', itemIndex, undefined) as
			| ResourceMapperValue
			| undefined;
		fields = buildCreatePayload({
			project,
			issueType,
			fieldMetas: await fieldMetas,
			values: readMapperValues(mapper, this.getInputData()[itemIndex]),
			assignee: readLocatorValue(
				this.getNodeParameter('assignee', itemIndex, '', { extractValue: true }),
			),
			reporter: readLocatorValue(
				this.getNodeParameter('reporter', itemIndex, '', { extractValue: true }),
			),
			fieldsJson: parseFieldsJson(
				this.getNodeParameter('additionalFieldsJson', itemIndex, '{}') as string | IDataObject,
			),
		});
	} catch (error) {
		throw toNodeError(this.getNode(), error, { itemIndex });
	}

	const created = await jiraApiRequest.call(this, 'POST', '/issue', { fields });
	return toCreatedOutput(created, baseUrl);
}

async function searchIssuesForItem(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const filterMode = this.getNodeParameter('filterMode', itemIndex) as 'builder' | 'jql';
	let jql: string;
	try {
		jql =
			filterMode === 'jql'
				? (this.getNodeParameter('jql', itemIndex, '') as string).trim()
				: buildJql(
						this.getNodeParameter('filters', itemIndex, {}) as SearchFilters,
						this.getNodeParameter('orderBy', itemIndex, '') as string,
						this.getNodeParameter('orderDirection', itemIndex, 'DESC') as OrderDirection,
					);
	} catch (error) {
		throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
	}

	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	return await searchIssues.call(this, {
		jql,
		fields: splitList(
			this.getNodeParameter('fields', itemIndex, DEFAULT_SEARCH_FIELDS) as string,
		),
		returnAll,
		limit: returnAll ? 0 : (this.getNodeParameter('limit', itemIndex, 50) as number),
	});
}

export class JiraSession implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jira Session',
		name: 'jiraSession',
		icon: { light: 'file:jira.svg', dark: 'file:jira.dark.svg' },
		group: ['output'],
		version: [1, 2],
		defaultVersion: 2,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Create and search Jira Server / Data Center issues using a username/password session login',
		defaults: {
			name: 'Jira Session',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Issue',
						value: 'issue',
					},
				],
				default: 'issue',
			},
			...issueOperations,
			...issueFields,
		],
	};

	methods = {
		listSearch: {
			searchAssignableUsers,
			searchUsers: searchAllUsers,
		},

		resourceMapping: {
			async getCreateFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const project = this.getCurrentNodeParameter('project') as string | undefined;
				const issueType = this.getCurrentNodeParameter('issueType') as string | undefined;
				if (!project || !issueType) {
					return { fields: [] };
				}
				const fieldMetas = await fetchCreateMeta.call(this, project, issueType);
				return {
					fields: toResourceMapperFields(fieldMetas),
					emptyFieldsNotice: 'Jira lists no fields on the create screen of this issue type',
				};
			},
		},

		loadOptions: {
			async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const projects = (await jiraApiRequest.call(
					this,
					'GET',
					'/project',
				)) as unknown as NamedEntity[];
				return toOptions(
					projects,
					(project) => project.key,
					(project) => `${project.name ?? project.key} (${project.key})`,
				);
			},

			async getIssueTypes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const projectKey = this.getCurrentNodeParameter('project') as string | undefined;
				if (!projectKey) {
					return [];
				}
				const project = await jiraApiRequest.call(
					this,
					'GET',
					`/project/${encodeURIComponent(projectKey)}`,
				);
				const issueTypes = (project.issueTypes ?? []) as NamedEntity[];
				return toOptions(
					issueTypes,
					(issueType) => issueType.id,
					(issueType) => {
						const name = issueType.name ?? String(issueType.id);
						const needsSuffix = issueType.subtask === true && !/sub-?task/i.test(name);
						return needsSuffix ? `${name} (sub-task)` : name;
					},
				);
			},

			async getPriorities(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const priorities = (await jiraApiRequest.call(
					this,
					'GET',
					'/priority',
				)) as unknown as NamedEntity[];
				return toOptions(
					priorities,
					(priority) => priority.id,
					(priority) => priority.name ?? String(priority.id),
				);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0) as 'create' | 'getAll';
		const baseUrl = await getBaseUrl.call(this);
		const nodeVersion = this.getNode().typeVersion;
		const createMetaCache: CreateMetaCache = new Map();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				if (operation === 'create') {
					const created =
						nodeVersion >= 2
							? await createIssueV2.call(this, itemIndex, baseUrl, createMetaCache)
							: await createIssue.call(this, itemIndex, baseUrl);
					returnData.push({ json: created, pairedItem: { item: itemIndex } });
					continue;
				}
				const issues = await searchIssuesForItem.call(this, itemIndex);
				for (const issue of issues) {
					returnData.push({ json: issue, pairedItem: { item: itemIndex } });
				}
			} catch (error) {
				if (!this.continueOnFail()) {
					throw toNodeError(this.getNode(), error, { itemIndex });
				}
				returnData.push({
					json: { error: (error as Error).message },
					pairedItem: { item: itemIndex },
				});
			}
		}

		return [returnData];
	}
}
