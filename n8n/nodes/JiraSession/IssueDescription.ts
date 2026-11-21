import type { INodeProperties } from 'n8n-workflow';

export const DEFAULT_SEARCH_FIELDS = 'summary,status,assignee,issuetype,priority,created,updated';

const showForCreate = { show: { resource: ['issue'], operation: ['create'] } };
const showForSearch = { show: { resource: ['issue'], operation: ['getAll'] } };
const showForCreateV1 = { show: { ...showForCreate.show, '@version': [1] } };
const showForCreateV2 = { show: { ...showForCreate.show, '@version': [{ _cnd: { gte: 2 } }] } };

export const issueOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['issue'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Create an issue',
				action: 'Create an issue',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Search issues with filters or JQL',
				action: 'Get many issues',
			},
		],
		default: 'create',
	},
];

const createFields: INodeProperties[] = [
	{
		displayName: 'Project Name or ID',
		name: 'project',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getProjects' },
		required: true,
		default: '',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		displayOptions: showForCreate,
	},
	{
		displayName: 'Issue Type Name or ID',
		name: 'issueType',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getIssueTypes', loadOptionsDependsOn: ['project'] },
		required: true,
		default: '',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		displayOptions: showForCreate,
	},
	{
		displayName: 'Summary',
		name: 'summary',
		type: 'string',
		required: true,
		default: '',
		displayOptions: showForCreateV1,
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: showForCreateV1,
		options: [
			{
				displayName: 'Additional Fields (JSON)',
				name: 'fieldsJson',
				type: 'json',
				default: '{}',
				description:
					'Extra entries merged into the "fields" object of the create request; they override other values',
			},
			{
				displayName: 'Assignee',
				name: 'assignee',
				type: 'string',
				default: '',
				placeholder: 'jdoe',
				description: 'Username of the assignee',
			},
			{
				displayName: 'Components',
				name: 'components',
				type: 'string',
				default: '',
				placeholder: 'Backend, API',
				description: 'Comma-separated component names',
			},
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Issue description in Jira wiki markup',
			},
			{
				displayName: 'Due Date',
				name: 'dueDate',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Labels',
				name: 'labels',
				type: 'string',
				default: '',
				placeholder: 'n8n, automation',
				description: 'Comma-separated labels (no spaces inside a label)',
			},
			{
				displayName: 'Parent Issue Key',
				name: 'parentKey',
				type: 'string',
				default: '',
				placeholder: 'PROJ-123',
				description: 'Parent issue, required when the issue type is a sub-task',
			},
			{
				displayName: 'Priority Name or ID',
				name: 'priority',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getPriorities' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Reporter',
				name: 'reporter',
				type: 'string',
				default: '',
				placeholder: 'jdoe',
				description: 'Username of the reporter (needs the Modify Reporter permission)',
			},
		],
	},
	{
		displayName: 'Custom Fields',
		name: 'customFields',
		type: 'fixedCollection',
		placeholder: 'Add Custom Field',
		typeOptions: { multipleValues: true },
		default: {},
		displayOptions: showForCreateV1,
		options: [
			{
				displayName: 'Field',
				name: 'field',
				values: [
					{
						displayName: 'Field ID',
						name: 'fieldId',
						type: 'string',
						default: '',
						placeholder: 'customfield_10010',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description:
							'Sent as JSON when it parses as JSON (5, {"value": "High"}, ["a"]), otherwise as text. Wrap in quotes ("123") to force text.',
					},
				],
			},
		],
	},
	{
		displayName: 'Fields',
		name: 'createFields',
		type: 'resourceMapper',
		noDataExpression: true,
		required: true,
		default: { mappingMode: 'defineBelow', value: null },
		description:
			'Every field Jira shows on the create screen of the chosen project and issue type, with its required flag and allowed values',
		displayOptions: showForCreateV2,
		typeOptions: {
			loadOptionsDependsOn: ['project', 'issueType'],
			resourceMapper: {
				resourceMapperMethod: 'getCreateFields',
				mode: 'add',
				fieldWords: { singular: 'field', plural: 'fields' },
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: true,
				noFieldsError: 'Choose a project and an issue type to load the fields of its create screen',
			},
		},
	},
	{
		displayName: 'Assignee',
		name: 'assignee',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		description: 'User the issue is assigned to; leave empty to use the project default',
		displayOptions: showForCreateV2,
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select a user...',
				typeOptions: { searchListMethod: 'searchAssignableUsers', searchable: true },
			},
			{
				displayName: 'By Username',
				name: 'username',
				type: 'string',
				placeholder: 'jdoe',
			},
		],
	},
	{
		displayName: 'Reporter',
		name: 'reporter',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		description:
			'User reported as the creator (needs the Modify Reporter permission); leave empty for the logged-in user',
		displayOptions: showForCreateV2,
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				placeholder: 'Select a user...',
				typeOptions: { searchListMethod: 'searchUsers', searchable: true },
			},
			{
				displayName: 'By Username',
				name: 'username',
				type: 'string',
				placeholder: 'jdoe',
			},
		],
	},
	{
		displayName: 'Additional Fields (JSON)',
		name: 'additionalFieldsJson',
		type: 'json',
		default: '{}',
		description:
			'Extra entries merged into the "fields" object of the create request last, for anything the Fields mapper cannot express',
		displayOptions: showForCreateV2,
	},
];

const searchFields: INodeProperties[] = [
	{
		displayName: 'Filter Mode',
		name: 'filterMode',
		type: 'options',
		options: [
			{
				name: 'Builder',
				value: 'builder',
				description: 'Compose the JQL from the filters below',
			},
			{
				name: 'Raw JQL',
				value: 'jql',
				description: 'Write the JQL query yourself',
			},
		],
		default: 'builder',
		displayOptions: showForSearch,
	},
	{
		displayName: 'JQL',
		name: 'jql',
		type: 'string',
		default: '',
		placeholder: 'project = PROJ AND status = "In Progress" ORDER BY updated DESC',
		displayOptions: { show: { ...showForSearch.show, filterMode: ['jql'] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { ...showForSearch.show, filterMode: ['builder'] } },
		options: [
			{
				displayName: 'Assignee',
				name: 'assignee',
				type: 'string',
				default: '',
				placeholder: 'jdoe, currentUser()',
				description: 'Comma-separated usernames; currentUser() means the logged-in user',
			},
			{
				displayName: 'Issue Type',
				name: 'issueType',
				type: 'string',
				default: '',
				placeholder: 'Bug, Task',
				description: 'Comma-separated issue type names',
			},
			{
				displayName: 'Labels',
				name: 'labels',
				type: 'string',
				default: '',
				placeholder: 'n8n, automation',
				description: 'Comma-separated labels; an issue matches if it has any of them',
			},
			{
				displayName: 'Project',
				name: 'project',
				type: 'string',
				default: '',
				placeholder: 'PROJ',
				description: 'Comma-separated project keys',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'string',
				default: '',
				placeholder: 'To Do, In Progress',
				description: 'Comma-separated status names',
			},
			{
				displayName: 'Text Contains',
				name: 'text',
				type: 'string',
				default: '',
				description: 'Full-text search over summary, description and comments',
			},
			{
				displayName: 'Updated Since',
				name: 'updatedSince',
				type: 'dateTime',
				default: '',
				description: 'Wall-clock time, interpreted by Jira in the time zone of the Jira user',
			},
		],
	},
	{
		displayName: 'Order By',
		name: 'orderBy',
		type: 'string',
		default: 'updated',
		placeholder: 'updated',
		description: 'Field to sort by, e.g. updated, created, priority, key. Leave empty for none.',
		displayOptions: { show: { ...showForSearch.show, filterMode: ['builder'] } },
	},
	{
		displayName: 'Order Direction',
		name: 'orderDirection',
		type: 'options',
		options: [
			{ name: 'Descending', value: 'DESC' },
			{ name: 'Ascending', value: 'ASC' },
		],
		default: 'DESC',
		displayOptions: { show: { ...showForSearch.show, filterMode: ['builder'] } },
	},
	{
		displayName: 'Fields to Return',
		name: 'fields',
		type: 'string',
		default: DEFAULT_SEARCH_FIELDS,
		description: 'Comma-separated field IDs; use *all for every field or *navigable for the default set',
		displayOptions: showForSearch,
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: showForSearch,
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { ...showForSearch.show, returnAll: [false] } },
	},
];

export const issueFields: INodeProperties[] = [...createFields, ...searchFields];
