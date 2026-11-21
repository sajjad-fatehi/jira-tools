package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type recordedRequest struct {
	Method string
	Path   string
	Body   map[string]any
}

type fakeJira struct {
	mutex    sync.Mutex
	requests []recordedRequest
}

func (fake *fakeJira) last(t *testing.T) recordedRequest {
	t.Helper()
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	if len(fake.requests) == 0 {
		t.Fatal("no API request was sent")
	}
	return fake.requests[len(fake.requests)-1]
}

func (fake *fakeJira) count() int {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	return len(fake.requests)
}

func setup(t *testing.T) *fakeJira {
	t.Helper()
	fake := &fakeJira{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rest/auth/1/session" {
			http.SetCookie(w, &http.Cookie{Name: "JSESSIONID", Value: "x", Path: "/"})
			return
		}
		raw, _ := io.ReadAll(r.Body)
		recorded := recordedRequest{Method: r.Method, Path: r.URL.Path}
		if len(raw) > 0 {
			json.Unmarshal(raw, &recorded.Body)
		}
		fake.mutex.Lock()
		fake.requests = append(fake.requests, recorded)
		fake.mutex.Unlock()

		switch {
		case strings.HasSuffix(r.URL.Path, "/transitions") && r.Method == "GET":
			w.Write([]byte(`{"transitions":[{"id":"31","name":"Finish","to":{"name":"Done"}}]}`))
		case r.URL.Path == "/rest/api/2/issue" && r.Method == "POST":
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"id":"1","key":"PROJ-99"}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/comment"):
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"id":"5"}`))
		case r.Method == "POST" || r.Method == "PUT":
			w.WriteHeader(http.StatusNoContent)
		default:
			w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("JIRA_BASE_URL", server.URL)
	t.Setenv("JIRA_USERNAME", "jdoe")
	t.Setenv("JIRA_PASSWORD", "pw")
	return fake
}

func run(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(args, &stdout, &stderr)
	return stdout.String(), stderr.String(), code
}

func TestWriteCommandBodies(t *testing.T) {
	tests := []struct {
		name   string
		args   []string
		method string
		path   string
		body   string
	}{
		{"create", []string{"create", "-project", "PROJ", "-type", "Task", "-summary", "Hi", "-description", "D", "-assignee", "jdoe"},
			"POST", "/rest/api/2/issue",
			`{"fields":{"project":{"key":"PROJ"},"issuetype":{"name":"Task"},"summary":"Hi","description":"D","assignee":{"name":"jdoe"}}}`},
		{"create minimal", []string{"create", "-project", "PROJ", "-type", "Bug", "-summary", "Hi"},
			"POST", "/rest/api/2/issue",
			`{"fields":{"project":{"key":"PROJ"},"issuetype":{"name":"Bug"},"summary":"Hi"}}`},
		{"comment", []string{"comment", "proj-5", "-body", "hello"}, "POST", "/rest/api/2/issue/PROJ-5/comment", `{"body":"hello"}`},
		{"transition by name", []string{"transition", "PROJ-5", "-to", "done"}, "POST", "/rest/api/2/issue/PROJ-5/transitions", `{"transition":{"id":"31"}}`},
		{"transition by id", []string{"transition", "PROJ-5", "-to", "41"}, "POST", "/rest/api/2/issue/PROJ-5/transitions", `{"transition":{"id":"41"}}`},
		{"assign", []string{"assign", "PROJ-5", "-user", "jdoe"}, "PUT", "/rest/api/2/issue/PROJ-5/assignee", `{"name":"jdoe"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := setup(t)
			stdout, stderr, code := run(t, test.args...)
			if code != 0 {
				t.Fatalf("exit %d stderr %q", code, stderr)
			}
			last := fake.last(t)
			wantBody := map[string]any{}
			json.Unmarshal([]byte(test.body), &wantBody)
			gotBody, _ := json.Marshal(last.Body)
			expectedBody, _ := json.Marshal(wantBody)
			if last.Method != test.method || last.Path != test.path || string(gotBody) != string(expectedBody) {
				t.Fatalf("got %s %s %s; want %s %s %s", last.Method, last.Path, gotBody, test.method, test.path, expectedBody)
			}
			if test.name == "create" && !strings.Contains(stdout, "PROJ-99") {
				t.Fatalf("create output lacks key: %q", stdout)
			}
		})
	}
}

func TestDryRunSendsNothing(t *testing.T) {
	fake := setup(t)
	cases := [][]string{
		{"create", "-project", "PROJ", "-type", "Task", "-summary", "Hi", "-dry-run"},
		{"comment", "PROJ-5", "-body", "hello", "-dry-run"},
		{"transition", "PROJ-5", "-to", "31", "-dry-run"},
		{"assign", "PROJ-5", "-user", "jdoe", "-dry-run"},
	}
	for _, args := range cases {
		stdout, stderr, code := run(t, args...)
		if code != 0 {
			t.Fatalf("%v: exit %d stderr %q", args, code, stderr)
		}
		if !strings.Contains(stdout, "/rest/api/2/") {
			t.Fatalf("%v: dry-run output lacks path: %q", args, stdout)
		}
	}
	if fake.count() != 0 {
		t.Fatalf("dry-run sent %d API requests", fake.count())
	}
}

func TestDryRunOutputShape(t *testing.T) {
	setup(t)
	stdout, _, code := run(t, "comment", "PROJ-5", "-body", "hello", "-dry-run")
	if code != 0 || !strings.HasPrefix(stdout, "POST /rest/api/2/issue/PROJ-5/comment\n") || !strings.Contains(stdout, `"body": "hello"`) {
		t.Fatalf("unexpected dry-run output %q", stdout)
	}
}

func TestGlobalJSONFlag(t *testing.T) {
	setup(t)
	stdout, _, code := run(t, "-json", "me")
	if code != 0 || strings.TrimSpace(stdout) != "{}" {
		t.Fatalf("exit %d out %q", code, stdout)
	}
}

func TestUsageErrors(t *testing.T) {
	setup(t)
	for _, args := range [][]string{{}, {"nope"}, {"search"}, {"comment", "PROJ-1"}, {"issue"}, {"issue", "bad key"}} {
		if _, _, code := run(t, args...); code == 0 {
			t.Errorf("%v: expected non-zero exit", args)
		}
	}
}

func TestVersionAndHelp(t *testing.T) {
	stdout, _, code := run(t, "version")
	if code != 0 || !strings.HasPrefix(stdout, "jira-tools v") {
		t.Fatalf("version: %d %q", code, stdout)
	}
	if _, _, code := run(t, "issue", "--help"); code != 0 {
		t.Fatalf("--help exit %d", code)
	}
}

func TestIssueRendering(t *testing.T) {
	var out bytes.Buffer
	printIssue(&out, issueFixture())
	text := out.String()
	for _, want := range []string{"PROJ-1  Title", "Status:    Open", "Assignee:  Unassigned", "Comments (last 5 of 7)", "c7"} {
		if !strings.Contains(text, want) {
			t.Errorf("rendering lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "c1\n") || strings.Contains(text, "c2\n") {
		t.Errorf("old comments should be trimmed:\n%s", text)
	}
}

func TestCreateSubtaskBody(t *testing.T) {
	fake := setup(t)
	_, stderr, code := run(t, "create", "-parent", "proj-123", "-type", "Sub-task", "-summary", "Hi")
	if code != 0 {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	last := fake.last(t)
	fields, _ := last.Body["fields"].(map[string]any)
	parent, _ := fields["parent"].(map[string]any)
	project, _ := fields["project"].(map[string]any)
	if parent["key"] != "PROJ-123" || project["key"] != "PROJ" {
		t.Fatalf("unexpected fields %v", fields)
	}
}

func TestCreateDryRunPrintsParent(t *testing.T) {
	fake := setup(t)
	stdout, _, code := run(t, "create", "-parent", "PROJ-123", "-type", "Sub-task", "-summary", "test", "-dry-run")
	if code != 0 || !strings.Contains(strings.Join(strings.Fields(stdout), ""), `"parent":{"key":"PROJ-123"}`) {
		t.Fatalf("exit %d out %q", code, stdout)
	}
	if fake.count() != 0 {
		t.Fatal("dry-run sent requests")
	}
}

func TestCreateWithoutProjectOrParentFails(t *testing.T) {
	setup(t)
	if _, _, code := run(t, "create", "-type", "Task", "-summary", "x", "-dry-run"); code == 0 {
		t.Fatal("expected usage error")
	}
}

func TestAttachDryRunSendsNothing(t *testing.T) {
	fake := setup(t)
	path := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := run(t, "attach", "proj-5", "-file", path, "-file", path, "-dry-run")
	if code != 0 {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	if !strings.HasPrefix(stdout, "POST /rest/api/2/issue/PROJ-5/attachments\n") || strings.Count(stdout, "file: "+path) != 2 {
		t.Fatalf("unexpected output %q", stdout)
	}
	if fake.count() != 0 {
		t.Fatal("dry-run sent requests")
	}
}

func TestAttachUsageErrors(t *testing.T) {
	setup(t)
	missing := filepath.Join(t.TempDir(), "nope")
	for _, args := range [][]string{{"attach", "PROJ-5"}, {"attach", "-file", "x"}, {"attach", "PROJ-5", "-file", missing, "-dry-run"}} {
		if _, _, code := run(t, args...); code == 0 {
			t.Errorf("%v: expected non-zero exit", args)
		}
	}
}

func TestAttachUploadPrintsResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rest/auth/1/session" {
			return
		}
		if r.Header.Get("X-Atlassian-Token") != "no-check" {
			t.Errorf("missing XSRF header")
		}
		w.Write([]byte(`[{"id":"900","filename":"a.txt","size":1}]`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("JIRA_BASE_URL", server.URL)
	t.Setenv("JIRA_USERNAME", "jdoe")
	t.Setenv("JIRA_PASSWORD", "pw")
	path := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := run(t, "attach", "PROJ-5", "-file", path)
	if code != 0 || !strings.Contains(stdout, "900") || !strings.Contains(stdout, "a.txt") || !strings.Contains(stdout, "1 bytes") {
		t.Fatalf("exit %d out %q err %q", code, stdout, stderr)
	}
}

func TestIssueTypesListing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rest/auth/1/session" {
			return
		}
		if r.Method != "GET" || r.URL.Path != "/rest/api/2/project/PROJ" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Write([]byte(`{"key":"PROJ","issueTypes":[{"id":"1","name":"Task","subtask":false},{"id":"5","name":"Sub-task","subtask":true}]}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("JIRA_BASE_URL", server.URL)
	t.Setenv("JIRA_USERNAME", "jdoe")
	t.Setenv("JIRA_PASSWORD", "pw")
	stdout, stderr, code := run(t, "issuetypes", "-project", "proj")
	if code != 0 {
		t.Fatalf("exit %d err %q", code, stderr)
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) != 3 || !strings.HasSuffix(lines[1], "no") || !strings.Contains(lines[2], "Sub-task") || !strings.HasSuffix(lines[2], "yes") {
		t.Fatalf("unexpected output %q", stdout)
	}
	if _, _, code := run(t, "issuetypes"); code == 0 {
		t.Fatal("missing -project should fail")
	}
}
