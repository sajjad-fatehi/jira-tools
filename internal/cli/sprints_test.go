package cli

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func setupAgile(t *testing.T) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rest/auth/1/session":
			http.SetCookie(w, &http.Cookie{Name: "JSESSIONID", Value: "x", Path: "/"})
		case "/rest/agile/1.0/board":
			w.Write([]byte(`{"isLast":true,"values":[{"id":10,"name":"Team board","type":"scrum"},{"id":1,"name":"Development","type":"scrum"}]}`))
		case "/rest/agile/1.0/board/10/sprint", "/rest/agile/1.0/board/1/sprint":
			w.Write([]byte(`{"isLast":true,"values":[{"id":7,"name":"Sprint 26","startDate":"2026-11-01T08:00:00.000Z","endDate":"2026-11-15T08:00:00.000Z"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("JIRA_BASE_URL", server.URL)
	t.Setenv("JIRA_USERNAME", "jdoe")
	t.Setenv("JIRA_PASSWORD", "pw")
}

func TestSprintsDedupAcrossBoards(t *testing.T) {
	setupAgile(t)
	stdout, stderr, code := run(t, "sprints")
	if code != 0 {
		t.Fatalf("exit %d %q", code, stderr)
	}
	if strings.Count(stdout, "Sprint 26") != 1 || !strings.Contains(stdout, "2026-11-01→2026-11-15") || !strings.Contains(stdout, "Team board, Development") {
		t.Fatalf("unexpected output:\n%s", stdout)
	}
}

func TestSprintsBoardFilterAndJSON(t *testing.T) {
	setupAgile(t)
	stdout, stderr, code := run(t, "sprints", "-board", "development", "-json")
	if code != 0 || !strings.Contains(stdout, `"boards": [`) || strings.Contains(stdout, "Team board") {
		t.Fatalf("exit %d out %q err %q", code, stdout, stderr)
	}
}

func TestBoardsCommand(t *testing.T) {
	setupAgile(t)
	stdout, _, code := run(t, "boards", "-type", "scrum")
	if code != 0 || !strings.Contains(stdout, "Team board") || !strings.Contains(stdout, "Development") {
		t.Fatalf("exit %d out %q", code, stdout)
	}
}

func TestSearchSprintBuildsJQL(t *testing.T) {
	fake := setup(t)
	if _, stderr, code := run(t, "search", "-json", "-sprint", "active", "-jql", "assignee = currentUser()"); code != 0 {
		t.Fatalf("exit %d %q", code, stderr)
	}
	if got := fake.last(t).Body["jql"]; got != "(assignee = currentUser()) AND sprint in openSprints()" {
		t.Fatalf("jql %v", got)
	}
	if _, _, code := run(t, "search", "-json", "-sprint", "12"); code != 0 {
		t.Fatal("sprint-only search failed")
	}
	if got := fake.last(t).Body["jql"]; got != "sprint = 12" {
		t.Fatalf("jql %v", got)
	}
	if _, _, code := run(t, "search", "-json", "-sprint", "bogus"); code == 0 {
		t.Fatal("bogus sprint accepted")
	}
}
