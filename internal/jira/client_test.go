package jira

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testPassword = "s3cret-password"

func newTestClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewClient(Config{BaseURL: server.URL, Username: "jdoe", Password: testPassword})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestLoginThenCookieReused(t *testing.T) {
	logins := 0
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("Authorization header must not be sent")
		}
		if r.URL.Path == sessionPath {
			logins++
			var credentials map[string]string
			if err := json.NewDecoder(r.Body).Decode(&credentials); err != nil {
				t.Fatal(err)
			}
			if credentials["username"] != "jdoe" || credentials["password"] != testPassword {
				t.Errorf("unexpected credentials payload: %v", credentials)
			}
			http.SetCookie(w, &http.Cookie{Name: "JSESSIONID", Value: "abc123", Path: "/"})
			w.Write([]byte(`{"session":{"name":"JSESSIONID"}}`))
			return
		}
		cookie, err := r.Cookie("JSESSIONID")
		if err != nil || cookie.Value != "abc123" {
			http.Error(w, "anonymous", http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"name":"jdoe","displayName":"Jane Doe"}`))
	}))

	for range 2 {
		raw, err := client.Do(context.Background(), MyselfRequest())
		if err != nil {
			t.Fatal(err)
		}
		var user User
		if err := json.Unmarshal(raw, &user); err != nil || user.Name != "jdoe" {
			t.Fatalf("unexpected user %+v err %v", user, err)
		}
	}
	if logins != 1 {
		t.Fatalf("expected one login, got %d", logins)
	}
}

func TestLoginFailureHidesPasswordAndDoesNotRetry(t *testing.T) {
	logins := 0
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		logins++
		w.Header().Set("X-Seraph-LoginReason", "AUTHENTICATION_DENIED")
		http.Error(w, `{"errorMessages":["bad "}`, http.StatusUnauthorized)
	}))

	_, err := client.Do(context.Background(), MyselfRequest())
	if err == nil {
		t.Fatal("expected login error")
	}
	if strings.Contains(err.Error(), testPassword) {
		t.Fatalf("error leaks password: %v", err)
	}
	if !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "AUTHENTICATION_DENIED") {
		t.Fatalf("error lacks status/reason: %v", err)
	}
	if logins != 1 {
		t.Fatalf("expected single login attempt, got %d", logins)
	}
}

func TestSearchParsing(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == sessionPath {
			http.SetCookie(w, &http.Cookie{Name: "JSESSIONID", Value: "x", Path: "/"})
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if r.Method != "POST" || r.URL.Path != "/rest/api/2/search" || body["jql"] != "project = PROJ" || body["maxResults"] != float64(2) {
			t.Errorf("unexpected search request %s %s %v", r.Method, r.URL.Path, body)
		}
		w.Write([]byte(`{"total":7,"issues":[
			{"key":"PROJ-1","fields":{"summary":"First","issuetype":{"name":"Bug"},"status":{"name":"Open"},"assignee":{"name":"jdoe","displayName":"Jane"}}},
			{"key":"PROJ-2","fields":{"summary":"Second","issuetype":{"name":"Task"},"status":{"name":"Done"},"assignee":null}}]}`))
	}))

	raw, err := client.Do(context.Background(), SearchRequest("project = PROJ", 2))
	if err != nil {
		t.Fatal(err)
	}
	var result SearchResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Total != 7 || len(result.Issues) != 2 {
		t.Fatalf("unexpected result %+v", result)
	}
	first, second := result.Issues[0], result.Issues[1]
	if first.Key != "PROJ-1" || first.Fields.IssueType.Name != "Bug" || first.Fields.Assignee.Name != "jdoe" || second.Fields.Assignee != nil {
		t.Fatalf("unexpected issues %+v %+v", first, second)
	}
}

func TestAPIErrorMessage(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == sessionPath {
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"errorMessages":["boom"],"errors":{"summary":"required"}}`))
	}))
	_, err := client.Do(context.Background(), CreateRequest(CreateParams{Project: "PROJ", Type: "Task"}))
	if err == nil || !strings.Contains(err.Error(), "boom") || !strings.Contains(err.Error(), "summary: required") {
		t.Fatalf("unexpected error %v", err)
	}
}

func TestLoadConfigEnvOverridesFile(t *testing.T) {
	envFile := filepath.Join(t.TempDir(), ".env")
	content := "# comment\nJIRA_BASE_URL=\"https://file.example/\"\nexport JIRA_USERNAME=fileuser\nJIRA_PASSWORD=filepass\n"
	if err := os.WriteFile(envFile, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JIRA_USERNAME", "envuser")
	t.Setenv("JIRA_BASE_URL", "")
	t.Setenv("JIRA_PASSWORD", "")

	config, err := LoadConfig(envFile, true)
	if err != nil {
		t.Fatal(err)
	}
	if config.BaseURL != "https://file.example" || config.Username != "envuser" || config.Password != "filepass" {
		t.Fatalf("unexpected config %v", config)
	}
	if strings.Contains(config.String(), "filepass") {
		t.Fatal("Config.String leaks password")
	}
}

func TestEnvFileLocation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("JIRA_TOOLS_ENV_FILE", "")
	if got, want := EnvFile(), filepath.Join(home, ".config", "jira-tools", ".env"); got != want {
		t.Fatalf("home fallback: got %q want %q", got, want)
	}

	configHome := filepath.Join(home, "xdg")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	if got, want := EnvFile(), filepath.Join(configHome, "jira-tools", ".env"); got != want {
		t.Fatalf("XDG_CONFIG_HOME: got %q want %q", got, want)
	}

	override := filepath.Join(home, "custom.env")
	t.Setenv("JIRA_TOOLS_ENV_FILE", override)
	if got := EnvFile(); got != override {
		t.Fatalf("JIRA_TOOLS_ENV_FILE: got %q want %q", got, override)
	}
	if DefaultEnvFile() == override {
		t.Fatal("override must not change DefaultEnvFile, so a missing override file is reported")
	}
}

func TestLoadConfigMissingExplicitFile(t *testing.T) {
	if _, err := LoadConfig(filepath.Join(t.TempDir(), "nope"), true); err == nil {
		t.Fatal("expected error for missing explicit env file")
	}
}

func TestNormalizeIssueKey(t *testing.T) {
	if key, err := NormalizeIssueKey("proj-12"); err != nil || key != "PROJ-12" {
		t.Fatalf("got %q %v", key, err)
	}
	for _, bad := range []string{"", "PROJ", "PROJ-1/../x", "1-2", "PROJ-1?x"} {
		if _, err := NormalizeIssueKey(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}

func TestResolveTransition(t *testing.T) {
	transitions := []Transition{{ID: "11", Name: "Start", To: Named{Name: "In Progress"}}, {ID: "21", Name: "Finish", To: Named{Name: "Done"}}}
	for _, target := range []string{"21", "finish", "done"} {
		if transition, err := ResolveTransition(transitions, target); err != nil || transition.ID != "21" {
			t.Errorf("target %q: %+v %v", target, transition, err)
		}
	}
	if _, err := ResolveTransition(transitions, "nope"); err == nil || !strings.Contains(err.Error(), "Start (11)") {
		t.Fatalf("expected listing error, got %v", err)
	}
}

func TestAttachRequestSendsMultipart(t *testing.T) {
	directory := t.TempDir()
	first := filepath.Join(directory, "shot one.png")
	second := filepath.Join(directory, "notes.txt")
	if err := os.WriteFile(first, []byte("PNGDATA"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	received := map[string]string{}
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == sessionPath {
			http.SetCookie(w, &http.Cookie{Name: "JSESSIONID", Value: "x", Path: "/"})
			return
		}
		if r.Method != "POST" || r.URL.Path != "/rest/api/2/issue/PROJ-5/attachments" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("X-Atlassian-Token"); got != "no-check" {
			t.Errorf("X-Atlassian-Token = %q", got)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("not multipart: %v", err)
		}
		for _, header := range r.MultipartForm.File["file"] {
			opened, _ := header.Open()
			content, _ := io.ReadAll(opened)
			received[header.Filename] = string(content)
		}
		w.Write([]byte(`[]`))
	}))

	if _, err := client.Do(context.Background(), AttachRequest("PROJ-5", []string{first, second})); err != nil {
		t.Fatal(err)
	}
	if len(received) != 2 || received["shot one.png"] != "PNGDATA" || received["notes.txt"] != "hello" {
		t.Fatalf("unexpected parts %v", received)
	}
}

func TestJSONRequestSendsNoXSRFHeader(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == sessionPath {
			return
		}
		if r.Header.Get("X-Atlassian-Token") != "" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected headers %v", r.Header)
		}
		w.Write([]byte(`{}`))
	}))
	if _, err := client.Do(context.Background(), CommentRequest("PROJ-1", "x")); err != nil {
		t.Fatal(err)
	}
}

func TestCreateRequestParent(t *testing.T) {
	request := CreateRequest(CreateParams{Project: "PROJ", Type: "Sub-task", Summary: "s", Parent: "PROJ-123"})
	body, err := request.JSONBody()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"parent":{"key":"PROJ-123"}`) {
		t.Fatalf("body lacks parent: %s", body)
	}
	plain, _ := CreateRequest(CreateParams{Project: "PROJ", Type: "Task", Summary: "s"}).JSONBody()
	if strings.Contains(string(plain), "parent") {
		t.Fatalf("parent must be omitted: %s", plain)
	}
}

func TestProjectKeyHelpers(t *testing.T) {
	if got := ProjectKeyFromIssueKey("proj-123"); got != "PROJ" {
		t.Fatalf("got %q", got)
	}
	if key, err := NormalizeProjectKey("proj"); err != nil || key != "PROJ" {
		t.Fatalf("got %q %v", key, err)
	}
	for _, bad := range []string{"", "P/ROJ", "PROJ?x", "1PROJ"} {
		if _, err := NormalizeProjectKey(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}

func TestValidateAttachmentFiles(t *testing.T) {
	directory := t.TempDir()
	if err := ValidateAttachmentFiles([]string{directory}); err == nil {
		t.Error("directory should be rejected")
	}
	if err := ValidateAttachmentFiles([]string{filepath.Join(directory, "missing")}); err == nil {
		t.Error("missing file should be rejected")
	}
}
