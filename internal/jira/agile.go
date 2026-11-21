package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	agilePrefix      = "/rest/agile/1.0"
	agilePageSize    = 50
	BoardTypeScrum   = "scrum"
	SprintStateRun   = "active"
	activeSprintMark = "active"
)

type Board struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// Sprint.Boards is filled by CollectSprints: one sprint can be listed by several boards.
type Sprint struct {
	ID        int      `json:"id"`
	Name      string   `json:"name"`
	State     string   `json:"state"`
	StartDate string   `json:"startDate,omitempty"`
	EndDate   string   `json:"endDate,omitempty"`
	Boards    []string `json:"boards"`
}

type agilePage struct {
	IsLast bool              `json:"isLast"`
	Values []json.RawMessage `json:"values"`
}

// FetchAllPages follows startAt/isLast of an Agile list endpoint and decodes every value.
func FetchAllPages[T any](ctx context.Context, client *Client, path string, query url.Values) ([]T, error) {
	var all []T
	for startAt := 0; ; {
		pageQuery := url.Values{}
		for key, values := range query {
			pageQuery[key] = values
		}
		pageQuery.Set("startAt", strconv.Itoa(startAt))
		pageQuery.Set("maxResults", strconv.Itoa(agilePageSize))

		raw, err := client.Do(ctx, Request{Method: "GET", Path: path + "?" + pageQuery.Encode()})
		if err != nil {
			return nil, err
		}
		var page agilePage
		if err := json.Unmarshal(raw, &page); err != nil {
			return nil, fmt.Errorf("decode %s response: %w", path, err)
		}
		for _, value := range page.Values {
			var item T
			if err := json.Unmarshal(value, &item); err != nil {
				return nil, fmt.Errorf("decode %s item: %w", path, err)
			}
			all = append(all, item)
		}
		if page.IsLast || len(page.Values) == 0 {
			return all, nil
		}
		startAt += len(page.Values)
	}
}

// ListBoards returns every board, optionally filtered by type (scrum, kanban).
func ListBoards(ctx context.Context, client *Client, boardType string) ([]Board, error) {
	query := url.Values{}
	if boardType != "" {
		query.Set("type", boardType)
	}
	return FetchAllPages[Board](ctx, client, agilePrefix+"/board", query)
}

// ResolveBoard matches a numeric id or a case-insensitive exact name.
func ResolveBoard(boards []Board, target string) (Board, error) {
	names := make([]string, 0, len(boards))
	for _, board := range boards {
		names = append(names, fmt.Sprintf("%s (%d)", board.Name, board.ID))
		if strconv.Itoa(board.ID) == target || strings.EqualFold(board.Name, target) {
			return board, nil
		}
	}
	return Board{}, fmt.Errorf("no board %q; available: %s", target, strings.Join(names, ", "))
}

// CollectSprints lists sprints of each board, merges duplicates by sprint id and sorts newest start first.
func CollectSprints(ctx context.Context, client *Client, boards []Board, state string) ([]Sprint, error) {
	byID := map[int]*Sprint{}
	var order []int
	for _, board := range boards {
		query := url.Values{}
		if state != "" {
			query.Set("state", state)
		}
		sprints, err := FetchAllPages[Sprint](ctx, client, fmt.Sprintf("%s/board/%d/sprint", agilePrefix, board.ID), query)
		if err != nil {
			return nil, fmt.Errorf("board %q (%d): %w", board.Name, board.ID, err)
		}
		for _, sprint := range sprints {
			existing, seen := byID[sprint.ID]
			if !seen {
				sprint.Boards = nil
				existing = &sprint
				byID[sprint.ID] = existing
				order = append(order, sprint.ID)
			}
			existing.Boards = append(existing.Boards, board.Name)
		}
	}

	result := make([]Sprint, 0, len(order))
	for _, id := range order {
		result = append(result, *byID[id])
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].StartDate != result[right].StartDate {
			return startsLater(result[left].StartDate, result[right].StartDate)
		}
		return result[left].ID > result[right].ID
	})
	return result, nil
}

// startsLater orders ISO timestamps newest first; sprints without a start date go last.
func startsLater(left, right string) bool {
	if left == "" || right == "" {
		return right == ""
	}
	return left > right
}

var (
	sprintIDPattern = regexp.MustCompile(`^[0-9]+$`)
	orderByPattern  = regexp.MustCompile(`(?i)\border\s+by\b`)
)

// SprintJQL ANDs a sprint clause ("active" or a numeric id) onto jql, keeping any ORDER BY at the end.
func SprintJQL(jql, sprint string) (string, error) {
	var clause string
	switch {
	case sprint == "":
		return jql, nil
	case strings.EqualFold(sprint, activeSprintMark):
		clause = "sprint in openSprints()"
	case sprintIDPattern.MatchString(sprint):
		clause = "sprint = " + sprint
	default:
		return "", fmt.Errorf("invalid -sprint %q (expected active or a numeric sprint id)", sprint)
	}

	condition, order := jql, ""
	if location := orderByPattern.FindStringIndex(jql); location != nil {
		condition, order = jql[:location[0]], " "+jql[location[0]:]
	}
	if strings.TrimSpace(condition) == "" {
		return clause + order, nil
	}
	return "(" + strings.TrimSpace(condition) + ") AND " + clause + order, nil
}
