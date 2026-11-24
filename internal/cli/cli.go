package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/sajjad-fatehi/jira-tools/internal/jira"
)

const version = "jira-tools v1.0.0"

var errUsageReported = errors.New("usage error")

type options struct {
	jsonOutput bool
	envFile    string
	dryRun     bool
}

type app struct {
	stdout io.Writer
	stderr io.Writer
	global options
	client *jira.Client
}

type command struct {
	name     string
	summary  string
	synopsis string
	run      func(*app, []string) error
}

func commands() []command {
	return []command{
		{"me", "Show the current user", "me", (*app).runMe},
		{"projects", "List visible projects", "projects", (*app).runProjects},
		{"search", "Search issues with JQL", "search [-jql <JQL>] [-sprint <id|active>] [-max N]", (*app).runSearch},
		{"boards", "List boards", "boards [-type scrum|kanban]", (*app).runBoards},
		{"sprints", "List sprints (default: active, all scrum boards)", "sprints [-board <id or name>] [-state active|future|closed]", (*app).runSprints},
		{"issue", "Show one issue", "issue <KEY>", (*app).runIssue},
		{"issuetypes", "List issue types of a project (marks subtask types)", "issuetypes -project <KEY>", (*app).runIssueTypes},
		{"create", "Create an issue or, with -parent, a subtask", "create -project <KEY> -type <name> -summary <text> [-description <text>] [-assignee <username>] [-parent <KEY>]", (*app).runCreate},
		{"attach", "Upload files as attachments", "attach <KEY> -file <path> [-file <path>...]", (*app).runAttach},
		{"attachments", "List an issue's attachments", "attachments <KEY>", (*app).runAttachments},
		{"attachment-download", "Save one attachment to a new file", "attachment-download <ID> -out <path>", (*app).runAttachmentDownload},
		{"attachment-delete", "Delete one attachment by id", "attachment-delete <ID>", (*app).runAttachmentDelete},
		{"comment", "Add a comment", "comment <KEY> -body <text>", (*app).runComment},
		{"comment-update", "Replace the text of one comment by id", "comment-update <KEY> -id <comment id> -body <text>", (*app).runCommentUpdate},
		{"comment-delete", "Delete one comment by id", "comment-delete <KEY> -id <comment id>", (*app).runCommentDelete},
		{"transitions", "List available transitions", "transitions <KEY>", (*app).runTransitions},
		{"transition", "Move an issue through a transition", "transition <KEY> -to <name or id>", (*app).runTransition},
		{"assign", "Assign an issue", "assign <KEY> -user <username>", (*app).runAssign},
	}
}

// Run executes the CLI and returns the process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	instance := &app{stdout: stdout, stderr: stderr}
	err := instance.run(args)
	switch {
	case err == nil, errors.Is(err, flag.ErrHelp):
		return 0
	case errors.Is(err, errUsageReported):
		return 2
	default:
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
}

func (instance *app) run(args []string) error {
	globalFlags := flag.NewFlagSet("jira-tools", flag.ContinueOnError)
	globalFlags.SetOutput(instance.stderr)
	globalFlags.Usage = instance.printUsage
	bindCommonFlags(globalFlags, &instance.global)
	instance.global.envFile = jira.EnvFile()
	if err := parseFlags(globalFlags, args); err != nil {
		return err
	}

	remaining := globalFlags.Args()
	if len(remaining) == 0 {
		instance.printUsage()
		return errUsageReported
	}

	switch remaining[0] {
	case "version":
		fmt.Fprintln(instance.stdout, version)
		return nil
	case "help", "--help", "-h":
		instance.printUsage()
		return nil
	}
	for _, candidate := range commands() {
		if candidate.name == remaining[0] {
			return candidate.run(instance, remaining[1:])
		}
	}
	fmt.Fprintf(instance.stderr, "Unknown command: %s\n\n", remaining[0])
	instance.printUsage()
	return errUsageReported
}

func (instance *app) printUsage() {
	output := instance.stderr
	fmt.Fprintln(output, "jira-tools - CLI for Jira Server/Data Center (REST API v2, session-cookie auth)")
	fmt.Fprintln(output, "\nUsage:\n  jira-tools [-json] [-env-file <path>] <command> [options]")
	fmt.Fprintln(output, "\nCommands:")
	table := newTable(output)
	for _, candidate := range commands() {
		fmt.Fprintf(table, "  %s\t%s\n", candidate.name, candidate.summary)
	}
	fmt.Fprintln(table, "  version\tShow version")
	table.Flush()
	fmt.Fprintln(output, "\nRun 'jira-tools <command> --help' for command options.")
}

func bindCommonFlags(flagSet *flag.FlagSet, target *options) {
	flagSet.BoolVar(&target.jsonOutput, "json", target.jsonOutput, "print raw API JSON instead of the text view")
	flagSet.StringVar(&target.envFile, "env-file", target.envFile, "env file with JIRA_BASE_URL, JIRA_USERNAME, JIRA_PASSWORD")
}

func parseFlags(flagSet *flag.FlagSet, args []string) error {
	err := flagSet.Parse(args)
	switch {
	case err == nil, errors.Is(err, flag.ErrHelp):
		return err
	default:
		return errUsageReported
	}
}

// commandFlags builds a flag set whose common flags default to the global ones.
func (instance *app) commandFlags(synopsis string, writes bool) (*flag.FlagSet, *options) {
	name := strings.Fields(synopsis)[0]
	flagSet := flag.NewFlagSet(name, flag.ContinueOnError)
	flagSet.SetOutput(instance.stderr)
	flagSet.Usage = func() {
		fmt.Fprintf(instance.stderr, "Usage:\n  jira-tools %s [-json] [-env-file <path>]", synopsis)
		if writes {
			fmt.Fprint(instance.stderr, " [-dry-run]")
		}
		fmt.Fprintln(instance.stderr, "\n\nOptions:")
		flagSet.PrintDefaults()
	}
	local := instance.global
	bindCommonFlags(flagSet, &local)
	if writes {
		flagSet.BoolVar(&local.dryRun, "dry-run", false, "print method and path (and JSON body if any) without sending")
	}
	return flagSet, &local
}

// parseWithKey accepts the issue key before or after the flags.
func parseWithKey(flagSet *flag.FlagSet, args []string) (string, error) {
	var key string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		key, args = args[0], args[1:]
	}
	if err := parseFlags(flagSet, args); err != nil {
		return "", err
	}
	if key == "" && flagSet.NArg() > 0 {
		key = flagSet.Arg(0)
	}
	if key == "" {
		flagSet.Usage()
		return "", errUsageReported
	}
	return jira.NormalizeIssueKey(key)
}

// reorderLeadingArgument moves a leading positional argument behind the flags, since Go's flag package stops at it.
func reorderLeadingArgument(args []string) []string {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return args
	}
	return append(append([]string{}, args[1:]...), args[0])
}

func requireFlags(flagSet *flag.FlagSet, values map[string]string) error {
	for name, value := range values {
		if strings.TrimSpace(value) == "" {
			fmt.Fprintf(flagSet.Output(), "missing required flag -%s\n\n", name)
			flagSet.Usage()
			return errUsageReported
		}
	}
	return nil
}

// newClient is memoized so one invocation logs in once.
func (instance *app) newClient(settings *options) (*jira.Client, error) {
	if instance.client != nil {
		return instance.client, nil
	}
	explicit := settings.envFile != jira.DefaultEnvFile()
	config, err := jira.LoadConfig(settings.envFile, explicit)
	if err != nil {
		return nil, err
	}
	instance.client, err = jira.NewClient(config)
	return instance.client, err
}

// execute sends the request, or prints it when -dry-run is set (then sent is false).
func (instance *app) execute(settings *options, request jira.Request) (raw []byte, sent bool, err error) {
	if settings.dryRun {
		return nil, false, instance.printDryRun(request)
	}
	client, err := instance.newClient(settings)
	if err != nil {
		return nil, false, err
	}
	raw, err = client.Do(context.Background(), request)
	return raw, err == nil, err
}

func (instance *app) printDryRun(request jira.Request) error {
	fmt.Fprintf(instance.stdout, "%s %s\n", request.Method, request.Path)
	for _, path := range request.Files {
		fmt.Fprintf(instance.stdout, "file: %s\n", path)
	}
	body, err := request.JSONBody()
	if err != nil {
		return err
	}
	if body == nil {
		return nil
	}
	return printRawJSON(instance.stdout, body)
}

// stringList is a repeatable string flag.
type stringList []string

func (list *stringList) String() string {
	return strings.Join(*list, ",")
}

func (list *stringList) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("value must not be empty")
	}
	*list = append(*list, value)
	return nil
}
