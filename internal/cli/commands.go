package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"

	"github.com/sajjad-fatehi/jira-tools/internal/jira"
)

const (
	defaultSearchLimit = 20
	maxSearchLimit     = 1000
)

var digitsPattern = regexp.MustCompile(`^[0-9]+$`)

// fetch performs a read call and either prints raw JSON or decodes into out for rendering.
func (instance *app) fetch(settings *options, request jira.Request, out any) (rendered bool, err error) {
	client, err := instance.newClient(settings)
	if err != nil {
		return false, err
	}
	raw, err := client.Do(context.Background(), request)
	if err != nil {
		return false, err
	}
	if settings.jsonOutput {
		return true, printRawJSON(instance.stdout, raw)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return false, fmt.Errorf("decode %s response: %w", request.Path, err)
	}
	return false, nil
}

func (instance *app) runMe(args []string) error {
	flagSet, settings := instance.commandFlags("me", false)
	if err := parseFlags(flagSet, args); err != nil {
		return err
	}
	var user jira.User
	done, err := instance.fetch(settings, jira.MyselfRequest(), &user)
	if err != nil || done {
		return err
	}
	printUser(instance.stdout, user)
	return nil
}

func (instance *app) runProjects(args []string) error {
	flagSet, settings := instance.commandFlags("projects", false)
	if err := parseFlags(flagSet, args); err != nil {
		return err
	}
	var projects []jira.Project
	done, err := instance.fetch(settings, jira.ProjectsRequest(), &projects)
	if err != nil || done {
		return err
	}
	printProjects(instance.stdout, projects)
	return nil
}

func (instance *app) runSearch(args []string) error {
	flagSet, settings := instance.commandFlags("search [-jql <JQL>] [-sprint <id|active>] [-max N]", false)
	jql := flagSet.String("jql", "", "JQL query (required unless -sprint is given)")
	sprint := flagSet.String("sprint", "", "limit to a sprint: active (open sprints) or a sprint id")
	limit := flagSet.Int("max", defaultSearchLimit, "maximum number of issues")
	if err := parseFlags(flagSet, args); err != nil {
		return err
	}
	if err := requireFlags(flagSet, map[string]string{"jql or -sprint": *jql + *sprint}); err != nil {
		return err
	}
	if *limit < 1 || *limit > maxSearchLimit {
		return fmt.Errorf("-max must be between 1 and %d", maxSearchLimit)
	}
	fullJQL, err := jira.SprintJQL(*jql, *sprint)
	if err != nil {
		return err
	}
	var result jira.SearchResult
	done, err := instance.fetch(settings, jira.SearchRequest(fullJQL, *limit), &result)
	if err != nil || done {
		return err
	}
	printSearch(instance.stdout, result)
	return nil
}

func (instance *app) runIssue(args []string) error {
	flagSet, settings := instance.commandFlags("issue <KEY>", false)
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	var issue jira.Issue
	done, err := instance.fetch(settings, jira.IssueRequest(key), &issue)
	if err != nil || done {
		return err
	}
	printIssue(instance.stdout, issue)
	return nil
}

func (instance *app) runTransitions(args []string) error {
	flagSet, settings := instance.commandFlags("transitions <KEY>", false)
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	var list jira.TransitionList
	done, err := instance.fetch(settings, jira.TransitionsRequest(key), &list)
	if err != nil || done {
		return err
	}
	printTransitions(instance.stdout, list.Transitions)
	return nil
}

func (instance *app) runCreate(args []string) error {
	flagSet, settings := instance.commandFlags("create -project <KEY> -type <name> -summary <text> [-description <text>] [-assignee <username>] [-parent <KEY>]", true)
	params := jira.CreateParams{}
	flagSet.StringVar(&params.Project, "project", "", "project key (required unless -parent is given)")
	flagSet.StringVar(&params.Type, "type", "", "issue type name, e.g. Task; a subtask type name with -parent (required)")
	flagSet.StringVar(&params.Summary, "summary", "", "issue summary (required)")
	flagSet.StringVar(&params.Description, "description", "", "issue description")
	flagSet.StringVar(&params.Assignee, "assignee", "", "assignee username")
	flagSet.StringVar(&params.Parent, "parent", "", "parent issue key; creates a subtask (project defaults to the parent's)")
	if err := parseFlags(flagSet, args); err != nil {
		return err
	}
	if params.Parent != "" {
		parent, err := jira.NormalizeIssueKey(params.Parent)
		if err != nil {
			return err
		}
		params.Parent = parent
		if params.Project == "" {
			params.Project = jira.ProjectKeyFromIssueKey(parent)
		}
	}
	if err := requireFlags(flagSet, map[string]string{"project": params.Project, "type": params.Type, "summary": params.Summary}); err != nil {
		return err
	}

	raw, sent, err := instance.execute(settings, jira.CreateRequest(params))
	if err != nil || !sent {
		return err
	}
	if settings.jsonOutput {
		return printRawJSON(instance.stdout, raw)
	}
	var created jira.CreatedIssue
	if err := json.Unmarshal(raw, &created); err != nil || created.Key == "" {
		return fmt.Errorf("issue created but response had no key")
	}
	client, err := instance.newClient(settings)
	if err != nil {
		return err
	}
	fmt.Fprintf(instance.stdout, "%s\n%s\n", created.Key, client.BrowseURL(created.Key))
	return nil
}

func (instance *app) runIssueTypes(args []string) error {
	flagSet, settings := instance.commandFlags("issuetypes -project <KEY>", false)
	project := flagSet.String("project", "", "project key (required)")
	if err := parseFlags(flagSet, args); err != nil {
		return err
	}
	if err := requireFlags(flagSet, map[string]string{"project": *project}); err != nil {
		return err
	}
	key, err := jira.NormalizeProjectKey(*project)
	if err != nil {
		return err
	}
	var detail jira.ProjectDetail
	done, err := instance.fetch(settings, jira.ProjectRequest(key), &detail)
	if err != nil || done {
		return err
	}
	printIssueTypes(instance.stdout, detail.IssueTypes)
	return nil
}

func (instance *app) runAttach(args []string) error {
	flagSet, settings := instance.commandFlags("attach <KEY> -file <path> [-file <path>...]", true)
	var files stringList
	flagSet.Var(&files, "file", "file to upload; repeat for several (required)")
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return requireFlags(flagSet, map[string]string{"file": ""})
	}
	if err := jira.ValidateAttachmentFiles(files); err != nil {
		return err
	}

	raw, sent, err := instance.execute(settings, jira.AttachRequest(key, files))
	if err != nil || !sent {
		return err
	}
	if settings.jsonOutput {
		return printRawJSON(instance.stdout, raw)
	}
	var attachments []jira.Attachment
	if err := json.Unmarshal(raw, &attachments); err != nil {
		return fmt.Errorf("decode attachments response: %w", err)
	}
	printAttachments(instance.stdout, attachments)
	return nil
}

func (instance *app) runAttachments(args []string) error {
	flagSet, settings := instance.commandFlags("attachments <KEY>", false)
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	var issue jira.Issue
	done, err := instance.fetch(settings, jira.IssueAttachmentsRequest(key), &issue)
	if err != nil || done {
		return err
	}
	printAttachments(instance.stdout, issue.Fields.Attachment)
	return nil
}

// runAttachmentDownload reads the attachment metadata (read-only) and saves its content to -out.
// An existing file is never overwritten.
func (instance *app) runAttachmentDownload(args []string) error {
	flagSet, settings := instance.commandFlags("attachment-download <ID> -out <path>", false)
	outputPath := flagSet.String("out", "", "file to write (must not exist)")
	if err := parseFlags(flagSet, reorderLeadingArgument(args)); err != nil {
		return err
	}
	if flagSet.NArg() != 1 {
		flagSet.Usage()
		return errUsageReported
	}
	if err := requireFlags(flagSet, map[string]string{"out": *outputPath}); err != nil {
		return err
	}
	id, err := jira.NormalizeAttachmentID(flagSet.Arg(0))
	if err != nil {
		return err
	}

	client, err := instance.newClient(settings)
	if err != nil {
		return err
	}
	rawInfo, err := client.Do(context.Background(), jira.AttachmentRequest(id))
	if err != nil {
		return err
	}
	var attachment jira.Attachment
	if err := json.Unmarshal(rawInfo, &attachment); err != nil {
		return fmt.Errorf("decode attachment %s: %w", id, err)
	}
	content, err := client.Download(context.Background(), attachment.Content)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(*outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", *outputPath, err)
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		return fmt.Errorf("write %s: %w", *outputPath, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", *outputPath, err)
	}
	fmt.Fprintf(instance.stdout, "Saved attachment %s (%s, %d bytes) to %s\n", id, attachment.Filename, len(content), *outputPath)
	return nil
}

// runAttachmentDelete looks the attachment up first (read-only GET) so the output can say what was removed
// and a wrong id fails before anything is deleted; -dry-run sends nothing at all.
func (instance *app) runAttachmentDelete(args []string) error {
	flagSet, settings := instance.commandFlags("attachment-delete <ID>", true)
	if err := parseFlags(flagSet, reorderLeadingArgument(args)); err != nil {
		return err
	}
	if flagSet.NArg() != 1 {
		flagSet.Usage()
		return errUsageReported
	}
	id, err := jira.NormalizeAttachmentID(flagSet.Arg(0))
	if err != nil {
		return err
	}
	if settings.dryRun {
		_, _, err := instance.execute(settings, jira.DeleteAttachmentRequest(id))
		return err
	}

	client, err := instance.newClient(settings)
	if err != nil {
		return err
	}
	rawInfo, err := client.Do(context.Background(), jira.AttachmentRequest(id))
	if err != nil {
		return err
	}
	var attachment jira.Attachment
	if err := json.Unmarshal(rawInfo, &attachment); err != nil {
		return fmt.Errorf("decode attachment %s: %w", id, err)
	}
	if _, err := client.Do(context.Background(), jira.DeleteAttachmentRequest(id)); err != nil {
		return err
	}
	if settings.jsonOutput {
		return printRawJSON(instance.stdout, rawInfo)
	}
	fmt.Fprintf(instance.stdout, "Deleted attachment %s (%s, %d bytes)\n", id, attachment.Filename, attachment.Size)
	return nil
}

func (instance *app) runComment(args []string) error {
	flagSet, settings := instance.commandFlags("comment <KEY> -body <text>", true)
	body := flagSet.String("body", "", "comment text (required)")
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	if err := requireFlags(flagSet, map[string]string{"body": *body}); err != nil {
		return err
	}
	return instance.finishWrite(settings, jira.CommentRequest(key, *body), "Commented on "+key)
}

func (instance *app) runCommentUpdate(args []string) error {
	flagSet, settings := instance.commandFlags("comment-update <KEY> -id <comment id> -body <text>", true)
	rawID := flagSet.String("id", "", "comment id (required; see 'issue <KEY> -json')")
	body := flagSet.String("body", "", "new comment text, replaces the whole body (required)")
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	if err := requireFlags(flagSet, map[string]string{"id": *rawID, "body": *body}); err != nil {
		return err
	}
	commentID, err := jira.NormalizeCommentID(*rawID)
	if err != nil {
		return err
	}
	return instance.finishWrite(settings, jira.UpdateCommentRequest(key, commentID, *body), fmt.Sprintf("Updated comment %s on %s", commentID, key))
}

func (instance *app) runCommentDelete(args []string) error {
	flagSet, settings := instance.commandFlags("comment-delete <KEY> -id <comment id>", true)
	rawID := flagSet.String("id", "", "comment id (required; see 'issue <KEY> -json')")
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	if err := requireFlags(flagSet, map[string]string{"id": *rawID}); err != nil {
		return err
	}
	commentID, err := jira.NormalizeCommentID(*rawID)
	if err != nil {
		return err
	}
	return instance.finishWrite(settings, jira.DeleteCommentRequest(key, commentID), fmt.Sprintf("Deleted comment %s on %s", commentID, key))
}

func (instance *app) runAssign(args []string) error {
	flagSet, settings := instance.commandFlags("assign <KEY> -user <username>", true)
	user := flagSet.String("user", "", "assignee username (required)")
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	if err := requireFlags(flagSet, map[string]string{"user": *user}); err != nil {
		return err
	}
	return instance.finishWrite(settings, jira.AssignRequest(key, *user), fmt.Sprintf("Assigned %s to %s", key, *user))
}

// runTransition resolves a transition name via a read-only GET, even in -dry-run; numeric ids need no network.
func (instance *app) runTransition(args []string) error {
	flagSet, settings := instance.commandFlags("transition <KEY> -to <name or id>", true)
	target := flagSet.String("to", "", "transition name, target status name or numeric id (required)")
	key, err := parseWithKey(flagSet, args)
	if err != nil {
		return err
	}
	if err := requireFlags(flagSet, map[string]string{"to": *target}); err != nil {
		return err
	}

	transitionID := *target
	if !digitsPattern.MatchString(*target) {
		var list jira.TransitionList
		client, err := instance.newClient(settings)
		if err != nil {
			return err
		}
		raw, err := client.Do(context.Background(), jira.TransitionsRequest(key))
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &list); err != nil {
			return fmt.Errorf("decode transitions: %w", err)
		}
		transition, err := jira.ResolveTransition(list.Transitions, *target)
		if err != nil {
			return err
		}
		transitionID = transition.ID
	}
	return instance.finishWrite(settings, jira.TransitionRequest(key, transitionID), fmt.Sprintf("Transitioned %s (transition %s)", key, transitionID))
}

func (instance *app) finishWrite(settings *options, request jira.Request, successMessage string) error {
	raw, sent, err := instance.execute(settings, request)
	if err != nil || !sent {
		return err
	}
	if settings.jsonOutput {
		return printRawJSON(instance.stdout, raw)
	}
	fmt.Fprintln(instance.stdout, successMessage)
	return nil
}
