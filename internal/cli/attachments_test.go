package cli

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sajjad-fatehi/jira-tools/internal/jira"
)

const attachmentInfoJSON = `{"id":"10001","filename":"PROJ-123-summary.pdf","size":4096,"created":"2026-11-17T10:30:00.000+0000","author":{"name":"jdoe","displayName":"Jane"}}`

// serveRoutes answers by "METHOD path"; unknown GETs are 404, any other unknown method fails the test.
func serveRoutes(t *testing.T, routes map[string]string) *fakeJira {
	t.Helper()
	fake := &fakeJira{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rest/auth/1/session" {
			return
		}
		fake.mutex.Lock()
		fake.requests = append(fake.requests, recordedRequest{Method: r.Method, Path: r.URL.Path})
		fake.mutex.Unlock()
		response, found := routes[r.Method+" "+r.URL.Path]
		if !found {
			if r.Method != http.MethodGet {
				t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			}
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Write([]byte(response))
	}))
	t.Cleanup(server.Close)
	t.Setenv("JIRA_BASE_URL", server.URL)
	t.Setenv("JIRA_USERNAME", "jdoe")
	t.Setenv("JIRA_PASSWORD", "pw")
	return fake
}

func TestAttachmentsListing(t *testing.T) {
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rest/auth/1/session" {
			return
		}
		queries = append(queries, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		w.Write([]byte(`{"key":"PROJ-123","fields":{"attachment":[` + attachmentInfoJSON + `]}}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("JIRA_BASE_URL", server.URL)
	t.Setenv("JIRA_USERNAME", "jdoe")
	t.Setenv("JIRA_PASSWORD", "pw")

	stdout, stderr, code := run(t, "attachments", "proj-123")
	if code != 0 {
		t.Fatalf("exit %d err %q", code, stderr)
	}
	if len(queries) != 1 || queries[0] != "GET /rest/api/2/issue/PROJ-123?fields=attachment" {
		t.Fatalf("unexpected requests %v", queries)
	}
	for _, want := range []string{"ID", "10001", "PROJ-123-summary.pdf", "4096 bytes", "2026-11-17 10:30", "Jane (jdoe)"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("output missing %q:\n%s", want, stdout)
		}
	}

	rawOutput, _, code := run(t, "attachments", "PROJ-123", "-json")
	if code != 0 || !strings.Contains(rawOutput, `"attachment"`) {
		t.Fatalf("exit %d json %q", code, rawOutput)
	}
}

func TestAttachmentDeleteSendsDelete(t *testing.T) {
	fake := serveRoutes(t, map[string]string{
		"GET /rest/api/2/attachment/10001":    attachmentInfoJSON,
		"DELETE /rest/api/2/attachment/10001": "",
	})
	stdout, stderr, code := run(t, "attachment-delete", "10001")
	if code != 0 {
		t.Fatalf("exit %d err %q", code, stderr)
	}
	last := fake.last(t)
	if last.Method != "DELETE" || last.Path != "/rest/api/2/attachment/10001" {
		t.Fatalf("last request %+v", last)
	}
	if !strings.Contains(stdout, "Deleted attachment 10001") || !strings.Contains(stdout, "PROJ-123-summary.pdf") {
		t.Fatalf("unexpected output %q", stdout)
	}
}

func TestAttachmentDeleteDryRunSendsNothing(t *testing.T) {
	fake := serveRoutes(t, map[string]string{})
	stdout, stderr, code := run(t, "attachment-delete", "10001", "-dry-run")
	if code != 0 {
		t.Fatalf("exit %d err %q", code, stderr)
	}
	if stdout != "DELETE /rest/api/2/attachment/10001\n" {
		t.Fatalf("unexpected output %q", stdout)
	}
	if fake.count() != 0 {
		t.Fatal("dry-run sent requests")
	}
}

func TestAttachmentDeleteMissingAttachmentDeletesNothing(t *testing.T) {
	fake := serveRoutes(t, map[string]string{})
	if _, _, code := run(t, "attachment-delete", "999"); code == 0 {
		t.Fatal("expected failure")
	}
	for _, request := range fake.requests {
		if request.Method == "DELETE" {
			t.Fatal("DELETE sent for an attachment that could not be looked up")
		}
	}
}

func TestCommentDeleteSendsDelete(t *testing.T) {
	fake := serveRoutes(t, map[string]string{
		"DELETE /rest/api/2/issue/PROJ-120/comment/10100": "",
	})
	stdout, stderr, code := run(t, "comment-delete", "PROJ-120", "-id", "10100")
	if code != 0 {
		t.Fatalf("exit %d err %q", code, stderr)
	}
	last := fake.last(t)
	if last.Method != "DELETE" || last.Path != "/rest/api/2/issue/PROJ-120/comment/10100" {
		t.Fatalf("last request %+v", last)
	}
	if !strings.Contains(stdout, "Deleted comment 10100 on PROJ-120") {
		t.Fatalf("unexpected output %q", stdout)
	}
}

func TestCommentUpdateSendsPut(t *testing.T) {
	fake := serveRoutes(t, map[string]string{
		"PUT /rest/api/2/issue/PROJ-120/comment/10100": `{"id":"10100"}`,
	})
	stdout, stderr, code := run(t, "comment-update", "PROJ-120", "-id", "10100", "-body", "new text")
	if code != 0 {
		t.Fatalf("exit %d err %q", code, stderr)
	}
	last := fake.last(t)
	if last.Method != "PUT" || last.Path != "/rest/api/2/issue/PROJ-120/comment/10100" {
		t.Fatalf("last request %+v", last)
	}
	if !strings.Contains(stdout, "Updated comment 10100 on PROJ-120") {
		t.Fatalf("unexpected output %q", stdout)
	}
}

func TestCommentUpdateDryRunSendsNothing(t *testing.T) {
	fake := serveRoutes(t, map[string]string{})
	stdout, stderr, code := run(t, "comment-update", "PROJ-120", "-id", "10100", "-body", "new text", "-dry-run")
	if code != 0 {
		t.Fatalf("exit %d err %q", code, stderr)
	}
	if !strings.HasPrefix(stdout, "PUT /rest/api/2/issue/PROJ-120/comment/10100") || !strings.Contains(stdout, `"body": "new text"`) {
		t.Fatalf("unexpected output %q", stdout)
	}
	if fake.count() != 0 {
		t.Fatal("dry-run sent requests")
	}
}

func TestCommentUpdateRejectsBadInput(t *testing.T) {
	fake := serveRoutes(t, map[string]string{})
	for _, args := range [][]string{
		{"comment-update", "PROJ-120", "-body", "x"},
		{"comment-update", "PROJ-120", "-id", "10100"},
		{"comment-update", "PROJ-120", "-id", "../x", "-body", "x"},
	} {
		if _, _, code := run(t, args...); code == 0 {
			t.Errorf("%v: expected non-zero exit", args)
		}
	}
	if fake.count() != 0 {
		t.Fatal("bad input reached the API")
	}
}

func TestCommentDeleteRejectsBadID(t *testing.T) {
	fake := serveRoutes(t, map[string]string{})
	for _, args := range [][]string{{"comment-delete", "PROJ-120"}, {"comment-delete", "PROJ-120", "-id", "../x"}, {"comment-delete", "PROJ-120", "-id", "12a", "-dry-run"}} {
		if _, _, code := run(t, args...); code == 0 {
			t.Errorf("%v: expected non-zero exit", args)
		}
	}
	if fake.count() != 0 {
		t.Fatal("bad input reached the API")
	}
}

func TestAttachmentDeleteRejectsBadID(t *testing.T) {
	fake := serveRoutes(t, map[string]string{})
	for _, args := range [][]string{{"attachment-delete"}, {"attachment-delete", "../x"}, {"attachment-delete", "12a", "-dry-run"}} {
		if _, _, code := run(t, args...); code == 0 {
			t.Errorf("%v: expected non-zero exit", args)
		}
	}
	if fake.count() != 0 {
		t.Fatal("bad input reached the API")
	}
}

func TestPrintIssueShowsParentAndSubtasks(t *testing.T) {
	var parentOnly, withSubtasks strings.Builder
	issue := issueFixture()
	issue.Fields.Parent = &jira.IssueRef{Key: "PROJ-123"}
	issue.Fields.Parent.Fields.Summary = "Epic-ish parent"
	printIssue(&parentOnly, issue)
	if !strings.Contains(parentOnly.String(), "Parent:    PROJ-123  Epic-ish parent") || strings.Contains(parentOnly.String(), "Subtasks") {
		t.Fatalf("parent rendering:\n%s", parentOnly.String())
	}

	issue = issueFixture()
	for _, key := range []string{"PROJ-124", "PROJ-125"} {
		subtask := jira.IssueRef{Key: key}
		subtask.Fields.Summary = "Step " + key
		subtask.Fields.Status = jira.Named{Name: "Open"}
		issue.Fields.Subtasks = append(issue.Fields.Subtasks, subtask)
	}
	printIssue(&withSubtasks, issue)
	for _, want := range []string{"Subtasks (2):", "PROJ-124  [Open]  Step PROJ-124", "PROJ-125"} {
		if !strings.Contains(withSubtasks.String(), want) {
			t.Errorf("missing %q:\n%s", want, withSubtasks.String())
		}
	}
	if strings.Contains(withSubtasks.String(), "Parent:") {
		t.Fatal("unexpected Parent line")
	}
}

func TestIssueRequestAsksForParentAndSubtasks(t *testing.T) {
	request := jira.IssueRequest("PROJ-1")
	if !strings.Contains(request.Path, "parent") || !strings.Contains(request.Path, "subtasks") {
		t.Fatalf("path %q", request.Path)
	}
}

func TestAttachmentDownloadWritesFileAndRefusesOverwrite(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rest/auth/1/session":
		case "/rest/api/2/attachment/10001":
			w.Write([]byte(`{"id":"10001","filename":"finding.pdf","size":7,"content":"` + server.URL + `/secure/attachment/10001/finding.pdf"}`))
		case "/secure/attachment/10001/finding.pdf":
			w.Write([]byte("PDFDATA"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("JIRA_BASE_URL", server.URL)
	t.Setenv("JIRA_USERNAME", "jdoe")
	t.Setenv("JIRA_PASSWORD", "pw")

	outputPath := filepath.Join(t.TempDir(), "finding.pdf")
	stdout, stderr, code := run(t, "attachment-download", "10001", "-out", outputPath)
	if code != 0 {
		t.Fatalf("exit %d err %q", code, stderr)
	}
	content, err := os.ReadFile(outputPath)
	if err != nil || string(content) != "PDFDATA" {
		t.Fatalf("file content %q err %v", content, err)
	}
	if !strings.Contains(stdout, "Saved attachment 10001") {
		t.Fatalf("unexpected output %q", stdout)
	}
	if _, _, code := run(t, "attachment-download", "10001", "-out", outputPath); code == 0 {
		t.Fatal("expected failure when output file exists")
	}
}
