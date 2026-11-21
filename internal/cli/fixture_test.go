package cli

import (
	"fmt"

	"github.com/sajjad-fatehi/jira-tools/internal/jira"
)

func issueFixture() jira.Issue {
	page := jira.CommentPage{Total: 7}
	for index := 1; index <= 7; index++ {
		page.Comments = append(page.Comments, jira.Comment{
			Author:  jira.User{Name: "jdoe", DisplayName: "Jane"},
			Body:    fmt.Sprintf("c%d", index),
			Created: "2026-11-14T09:51:00.000+0000",
		})
	}
	return jira.Issue{Key: "PROJ-1", Fields: jira.IssueFields{
		Summary:   "Title",
		IssueType: jira.Named{Name: "Task"},
		Status:    jira.Named{Name: "Open"},
		Comment:   page,
	}}
}
