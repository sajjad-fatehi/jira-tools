package jira

type User struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
}

type Project struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type Named struct {
	Name string `json:"name"`
}

type Comment struct {
	Author  User   `json:"author"`
	Body    string `json:"body"`
	Created string `json:"created"`
}

type CommentPage struct {
	Total    int       `json:"total"`
	Comments []Comment `json:"comments"`
}

type IssueFields struct {
	Summary     string       `json:"summary"`
	IssueType   Named        `json:"issuetype"`
	Status      Named        `json:"status"`
	Priority    *Named       `json:"priority"`
	Assignee    *User        `json:"assignee"`
	Reporter    *User        `json:"reporter"`
	Created     string       `json:"created"`
	Updated     string       `json:"updated"`
	Description string       `json:"description"`
	Comment     CommentPage  `json:"comment"`
	Parent      *IssueRef    `json:"parent"`
	Subtasks    []IssueRef   `json:"subtasks"`
	Attachment  []Attachment `json:"attachment"`
}

// IssueRef is the short form Jira embeds for a parent or subtask.
type IssueRef struct {
	Key    string `json:"key"`
	Fields struct {
		Summary string `json:"summary"`
		Status  Named  `json:"status"`
	} `json:"fields"`
}

type Issue struct {
	Key    string      `json:"key"`
	Fields IssueFields `json:"fields"`
}

type SearchResult struct {
	Total  int     `json:"total"`
	Issues []Issue `json:"issues"`
}

type Transition struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	To   Named  `json:"to"`
}

type TransitionList struct {
	Transitions []Transition `json:"transitions"`
}

type CreatedIssue struct {
	Key string `json:"key"`
}

type IssueType struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Subtask     bool   `json:"subtask"`
	Description string `json:"description"`
}

type ProjectDetail struct {
	Key        string      `json:"key"`
	Name       string      `json:"name"`
	IssueTypes []IssueType `json:"issueTypes"`
}

type Attachment struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Content  string `json:"content"`
	Created  string `json:"created"`
	Author   *User  `json:"author"`
}
