package jira

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Request describes one API call; the CLI prints it for -dry-run instead of sending.
type Request struct {
	Method string
	Path   string
	Body   any
	// Files switches the call to multipart/form-data, one "file" part per path.
	Files []string
}

func (request Request) JSONBody() ([]byte, error) {
	if request.Body == nil {
		return nil, nil
	}
	body, err := json.Marshal(request.Body)
	if err != nil {
		return nil, fmt.Errorf("encode request body: %w", err)
	}
	return body, nil
}

var issueKeyPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*-[0-9]+$`)

// NormalizeIssueKey validates the key (it ends up in a URL path) and upper-cases it.
func NormalizeIssueKey(key string) (string, error) {
	if !issueKeyPattern.MatchString(key) {
		return "", fmt.Errorf("invalid issue key %q (expected like PROJ-123)", key)
	}
	return strings.ToUpper(key), nil
}

var projectKeyPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)

// NormalizeProjectKey validates the key (it ends up in a URL path) and upper-cases it.
func NormalizeProjectKey(key string) (string, error) {
	if !projectKeyPattern.MatchString(key) {
		return "", fmt.Errorf("invalid project key %q (expected like PROJ)", key)
	}
	return strings.ToUpper(key), nil
}

// ProjectKeyFromIssueKey returns the project part of an issue key such as PROJ-123.
func ProjectKeyFromIssueKey(issueKey string) string {
	project, _, _ := strings.Cut(issueKey, "-")
	return strings.ToUpper(project)
}

func issuePath(key string) string {
	return apiPrefix + "/issue/" + url.PathEscape(key)
}

func MyselfRequest() Request {
	return Request{Method: "GET", Path: apiPrefix + "/myself"}
}

func ProjectsRequest() Request {
	return Request{Method: "GET", Path: apiPrefix + "/project"}
}

func SearchRequest(jql string, maxResults int) Request {
	return Request{Method: "POST", Path: apiPrefix + "/search", Body: map[string]any{
		"jql":        jql,
		"maxResults": maxResults,
		"fields":     []string{"summary", "issuetype", "status", "assignee"},
	}}
}

func IssueRequest(key string) Request {
	return Request{Method: "GET", Path: issuePath(key) + "?fields=summary,issuetype,status,priority,assignee,reporter,created,updated,description,comment,parent,subtasks"}
}

func TransitionsRequest(key string) Request {
	return Request{Method: "GET", Path: issuePath(key) + "/transitions"}
}

type CreateParams struct {
	Project     string
	Type        string
	Summary     string
	Description string
	Assignee    string
	Parent      string
}

func CreateRequest(params CreateParams) Request {
	fields := map[string]any{
		"project":   map[string]string{"key": params.Project},
		"issuetype": map[string]string{"name": params.Type},
		"summary":   params.Summary,
	}
	if params.Description != "" {
		fields["description"] = params.Description
	}
	if params.Assignee != "" {
		fields["assignee"] = map[string]string{"name": params.Assignee}
	}
	if params.Parent != "" {
		fields["parent"] = map[string]string{"key": params.Parent}
	}
	return Request{Method: "POST", Path: apiPrefix + "/issue", Body: map[string]any{"fields": fields}}
}

func AttachRequest(key string, files []string) Request {
	return Request{Method: "POST", Path: issuePath(key) + "/attachments", Files: files}
}

func IssueAttachmentsRequest(key string) Request {
	return Request{Method: "GET", Path: issuePath(key) + "?fields=attachment"}
}

func attachmentPath(id string) string {
	return apiPrefix + "/attachment/" + url.PathEscape(id)
}

func AttachmentRequest(id string) Request {
	return Request{Method: "GET", Path: attachmentPath(id)}
}

func DeleteAttachmentRequest(id string) Request {
	return Request{Method: "DELETE", Path: attachmentPath(id)}
}

var attachmentIDPattern = regexp.MustCompile(`^[0-9]+$`)

// NormalizeAttachmentID validates the id (it ends up in a URL path).
func NormalizeAttachmentID(id string) (string, error) {
	if !attachmentIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid attachment id %q (expected digits, e.g. 10001)", id)
	}
	return id, nil
}

// ProjectRequest returns the project including its issueTypes, each flagged with "subtask".
func ProjectRequest(key string) Request {
	return Request{Method: "GET", Path: apiPrefix + "/project/" + url.PathEscape(key)}
}

func CommentRequest(key, body string) Request {
	return Request{Method: "POST", Path: issuePath(key) + "/comment", Body: map[string]string{"body": body}}
}

func UpdateCommentRequest(key, commentID, body string) Request {
	return Request{Method: "PUT", Path: issuePath(key) + "/comment/" + url.PathEscape(commentID), Body: map[string]string{"body": body}}
}

func DeleteCommentRequest(key, commentID string) Request {
	return Request{Method: "DELETE", Path: issuePath(key) + "/comment/" + url.PathEscape(commentID)}
}

var commentIDPattern = regexp.MustCompile(`^[0-9]+$`)

// NormalizeCommentID validates the id (it ends up in a URL path).
func NormalizeCommentID(id string) (string, error) {
	if !commentIDPattern.MatchString(id) {
		return "", fmt.Errorf("invalid comment id %q (expected digits, e.g. 10100)", id)
	}
	return id, nil
}

func TransitionRequest(key, transitionID string) Request {
	return Request{Method: "POST", Path: issuePath(key) + "/transitions", Body: map[string]any{
		"transition": map[string]string{"id": transitionID},
	}}
}

func AssignRequest(key, username string) Request {
	return Request{Method: "PUT", Path: issuePath(key) + "/assignee", Body: map[string]string{"name": username}}
}

// ResolveTransition matches by id, transition name or target status name (case-insensitive).
func ResolveTransition(transitions []Transition, target string) (Transition, error) {
	names := make([]string, 0, len(transitions))
	for _, transition := range transitions {
		names = append(names, fmt.Sprintf("%s (%s)", transition.Name, transition.ID))
		if transition.ID == target ||
			strings.EqualFold(transition.Name, target) ||
			strings.EqualFold(transition.To.Name, target) {
			return transition, nil
		}
	}
	return Transition{}, fmt.Errorf("no transition %q; available: %s", target, strings.Join(names, ", "))
}
