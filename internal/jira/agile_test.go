package jira

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestListBoardsPaginates(t *testing.T) {
	var startAts []string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == sessionPath {
			return
		}
		if r.URL.Path != "/rest/agile/1.0/board" || r.URL.Query().Get("type") != "scrum" {
			t.Errorf("unexpected request %s", r.URL)
		}
		startAt := r.URL.Query().Get("startAt")
		startAts = append(startAts, startAt)
		if startAt == "0" {
			fmt.Fprint(w, `{"isLast":false,"values":[{"id":1,"name":"A","type":"scrum"},{"id":2,"name":"B","type":"scrum"}]}`)
			return
		}
		fmt.Fprint(w, `{"isLast":true,"values":[{"id":3,"name":"C","type":"scrum"}]}`)
	}))
	boards, err := ListBoards(context.Background(), client, BoardTypeScrum)
	if err != nil {
		t.Fatal(err)
	}
	if len(boards) != 3 || boards[2].Name != "C" || strings.Join(startAts, ",") != "0,2" {
		t.Fatalf("boards %v startAts %v", boards, startAts)
	}
}

func TestCollectSprintsDedupAndSort(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == sessionPath {
			return
		}
		if r.URL.Query().Get("state") != "active" {
			t.Errorf("state not forwarded: %s", r.URL)
		}
		switch r.URL.Path {
		case "/rest/agile/1.0/board/10/sprint":
			fmt.Fprint(w, `{"isLast":true,"values":[{"id":7,"name":"Sprint 26","startDate":"2026-11-01T08:00:00.000Z","endDate":"2026-11-15T08:00:00.000Z"},{"id":5,"name":"Older","startDate":"2026-10-01T08:00:00.000Z"}]}`)
		case "/rest/agile/1.0/board/1/sprint":
			fmt.Fprint(w, `{"isLast":true,"values":[{"id":7,"name":"Sprint 26","startDate":"2026-11-01T08:00:00.000Z"},{"id":9,"name":"Undated"}]}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	boards := []Board{{ID: 10, Name: "Team board"}, {ID: 1, Name: "Development"}}
	sprints, err := CollectSprints(context.Background(), client, boards, "active")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, sprint := range sprints {
		ids = append(ids, strconv.Itoa(sprint.ID))
	}
	if strings.Join(ids, ",") != "7,5,9" {
		t.Fatalf("want deduped newest-first 7,5,9 got %v", ids)
	}
	if strings.Join(sprints[0].Boards, ",") != "Team board,Development" {
		t.Fatalf("boards not joined: %v", sprints[0].Boards)
	}
}

func TestResolveBoard(t *testing.T) {
	boards := []Board{{ID: 10, Name: "Team board"}, {ID: 1, Name: "Development"}}
	for _, target := range []string{"10", "team board"} {
		if board, err := ResolveBoard(boards, target); err != nil || board.ID != 10 {
			t.Errorf("%s: %v %v", target, board, err)
		}
	}
	if _, err := ResolveBoard(boards, "nope"); err == nil || !strings.Contains(err.Error(), "Development (1)") {
		t.Errorf("want listing error, got %v", err)
	}
}

func TestSprintJQL(t *testing.T) {
	tests := []struct{ jql, sprint, want string }{
		{"assignee = currentUser()", "active", "(assignee = currentUser()) AND sprint in openSprints()"},
		{"project = PROJ", "42", "(project = PROJ) AND sprint = 42"},
		{"", "active", "sprint in openSprints()"},
		{"project = PROJ ORDER BY updated DESC", "42", "(project = PROJ) AND sprint = 42 ORDER BY updated DESC"},
		{"order by rank", "active", "sprint in openSprints() order by rank"},
		{"project = PROJ", "", "project = PROJ"},
	}
	for _, test := range tests {
		got, err := SprintJQL(test.jql, test.sprint)
		if err != nil || got != test.want {
			t.Errorf("SprintJQL(%q,%q) = %q, %v; want %q", test.jql, test.sprint, got, err, test.want)
		}
	}
	if _, err := SprintJQL("x", "1; drop"); err == nil {
		t.Error("invalid sprint accepted")
	}
}
