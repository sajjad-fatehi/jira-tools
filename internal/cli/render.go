package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/sajjad-fatehi/jira-tools/internal/jira"
)

const recentCommentCount = 5

func newTable(output io.Writer) *tabwriter.Writer {
	return tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
}

func printRawJSON(output io.Writer, raw []byte) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var indented bytes.Buffer
	if err := json.Indent(&indented, raw, "", "  "); err != nil {
		return fmt.Errorf("format response JSON: %w", err)
	}
	_, err := fmt.Fprintln(output, indented.String())
	return err
}

func displayUser(user *jira.User) string {
	if user == nil {
		return "Unassigned"
	}
	if user.DisplayName == "" {
		return user.Name
	}
	return fmt.Sprintf("%s (%s)", user.DisplayName, user.Name)
}

func formatTime(value string) string {
	if len(value) < 16 {
		return value
	}
	return value[:10] + " " + value[11:16]
}

func printUser(output io.Writer, user jira.User) {
	fmt.Fprintf(output, "Name:          %s\nDisplay name:  %s\n", user.Name, user.DisplayName)
}

func printProjects(output io.Writer, projects []jira.Project) {
	table := newTable(output)
	fmt.Fprintln(table, "KEY\tNAME")
	for _, project := range projects {
		fmt.Fprintf(table, "%s\t%s\n", project.Key, project.Name)
	}
	table.Flush()
}

func printSearch(output io.Writer, result jira.SearchResult) {
	table := newTable(output)
	fmt.Fprintln(table, "KEY\tTYPE\tSTATUS\tASSIGNEE\tSUMMARY")
	for _, issue := range result.Issues {
		fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\n",
			issue.Key, issue.Fields.IssueType.Name, issue.Fields.Status.Name,
			displayUser(issue.Fields.Assignee), issue.Fields.Summary)
	}
	table.Flush()
	if result.Total > len(result.Issues) {
		fmt.Fprintf(output, "\nShowing %d of %d (raise -max)\n", len(result.Issues), result.Total)
	}
}

func printIssue(output io.Writer, issue jira.Issue) {
	fields := issue.Fields
	priority := "-"
	if fields.Priority != nil {
		priority = fields.Priority.Name
	}
	fmt.Fprintf(output, "%s  %s\n\n", issue.Key, fields.Summary)
	fmt.Fprintf(output, "Type:      %s\n", fields.IssueType.Name)
	fmt.Fprintf(output, "Status:    %s\n", fields.Status.Name)
	fmt.Fprintf(output, "Priority:  %s\n", priority)
	fmt.Fprintf(output, "Assignee:  %s\n", displayUser(fields.Assignee))
	fmt.Fprintf(output, "Reporter:  %s\n", displayUser(fields.Reporter))
	fmt.Fprintf(output, "Created:   %s\n", formatTime(fields.Created))
	fmt.Fprintf(output, "Updated:   %s\n", formatTime(fields.Updated))
	printIssueRelations(output, fields)

	fmt.Fprintln(output, "\nDescription:")
	if strings.TrimSpace(fields.Description) == "" {
		fmt.Fprintln(output, "  (none)")
	} else {
		fmt.Fprintln(output, indent(fields.Description))
	}

	comments := fields.Comment.Comments
	if len(comments) > recentCommentCount {
		comments = comments[len(comments)-recentCommentCount:]
	}
	fmt.Fprintf(output, "\nComments (last %d of %d):\n", len(comments), fields.Comment.Total)
	for _, comment := range comments {
		fmt.Fprintf(output, "  [%s] %s\n%s\n", formatTime(comment.Created), displayUser(&comment.Author), indent(comment.Body))
	}
}

func printTransitions(output io.Writer, transitions []jira.Transition) {
	table := newTable(output)
	fmt.Fprintln(table, "ID\tNAME\tTO STATUS")
	for _, transition := range transitions {
		fmt.Fprintf(table, "%s\t%s\t%s\n", transition.ID, transition.Name, transition.To.Name)
	}
	table.Flush()
}

func indent(text string) string {
	lines := strings.Split(strings.TrimRight(text, "\r\n"), "\n")
	for index, line := range lines {
		lines[index] = "    " + strings.TrimRight(line, "\r")
	}
	return strings.Join(lines, "\n")
}

func printIssueTypes(output io.Writer, issueTypes []jira.IssueType) {
	table := newTable(output)
	fmt.Fprintln(table, "ID\tNAME\tSUBTASK")
	for _, issueType := range issueTypes {
		subtask := "no"
		if issueType.Subtask {
			subtask = "yes"
		}
		fmt.Fprintf(table, "%s\t%s\t%s\n", issueType.ID, issueType.Name, subtask)
	}
	table.Flush()
}

func printAttachments(output io.Writer, attachments []jira.Attachment) {
	table := newTable(output)
	fmt.Fprintln(table, "ID\tNAME\tSIZE\tCREATED\tAUTHOR")
	for _, attachment := range attachments {
		author := "-"
		if attachment.Author != nil {
			author = displayUser(attachment.Author)
		}
		fmt.Fprintf(table, "%s\t%s\t%d bytes\t%s\t%s\n",
			attachment.ID, attachment.Filename, attachment.Size, formatTime(attachment.Created), author)
	}
	table.Flush()
}

func printIssueRelations(output io.Writer, fields jira.IssueFields) {
	if fields.Parent != nil {
		fmt.Fprintf(output, "Parent:    %s  %s\n", fields.Parent.Key, fields.Parent.Fields.Summary)
	}
	if len(fields.Subtasks) == 0 {
		return
	}
	fmt.Fprintf(output, "\nSubtasks (%d):\n", len(fields.Subtasks))
	for _, subtask := range fields.Subtasks {
		fmt.Fprintf(output, "  %s  [%s]  %s\n", subtask.Key, subtask.Fields.Status.Name, subtask.Fields.Summary)
	}
}
