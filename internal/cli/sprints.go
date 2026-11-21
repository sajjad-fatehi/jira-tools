package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/sajjad-fatehi/jira-tools/internal/jira"
)

var validBoardTypes = map[string]bool{"": true, "scrum": true, "kanban": true}

func (instance *app) runBoards(args []string) error {
	flagSet, settings := instance.commandFlags("boards [-type scrum|kanban]", false)
	boardType := flagSet.String("type", "", "board type: scrum or kanban (default: all)")
	if err := parseFlags(flagSet, args); err != nil {
		return err
	}
	if !validBoardTypes[*boardType] {
		return fmt.Errorf("-type must be scrum or kanban")
	}
	client, err := instance.newClient(settings)
	if err != nil {
		return err
	}
	boards, err := jira.ListBoards(context.Background(), client, *boardType)
	if err != nil {
		return err
	}
	if settings.jsonOutput {
		return printJSONValue(instance.stdout, boards)
	}
	printBoards(instance.stdout, boards)
	return nil
}

func (instance *app) runSprints(args []string) error {
	flagSet, settings := instance.commandFlags("sprints [-board <id or name>] [-state active|future|closed]", false)
	boardTarget := flagSet.String("board", "", "scrum board id or name (default: every scrum board)")
	state := flagSet.String("state", "active", "sprint state: active, future or closed")
	if err := parseFlags(flagSet, args); err != nil {
		return err
	}
	switch *state {
	case "active", "future", "closed":
	default:
		return fmt.Errorf("-state must be active, future or closed")
	}

	client, err := instance.newClient(settings)
	if err != nil {
		return err
	}
	ctx := context.Background()
	boards, err := jira.ListBoards(ctx, client, jira.BoardTypeScrum)
	if err != nil {
		return err
	}
	if *boardTarget != "" {
		board, err := jira.ResolveBoard(boards, *boardTarget)
		if err != nil {
			return err
		}
		boards = []jira.Board{board}
	}
	sprints, err := jira.CollectSprints(ctx, client, boards, *state)
	if err != nil {
		return err
	}
	if settings.jsonOutput {
		return printJSONValue(instance.stdout, sprints)
	}
	printSprints(instance.stdout, sprints)
	return nil
}

func printJSONValue(output io.Writer, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode JSON: %w", err)
	}
	return printRawJSON(output, raw)
}

func printBoards(output io.Writer, boards []jira.Board) {
	table := newTable(output)
	fmt.Fprintln(table, "ID\tNAME\tTYPE")
	for _, board := range boards {
		fmt.Fprintf(table, "%d\t%s\t%s\n", board.ID, board.Name, board.Type)
	}
	table.Flush()
}

func printSprints(output io.Writer, sprints []jira.Sprint) {
	table := newTable(output)
	fmt.Fprintln(table, "ID\tNAME\tSTART→END\tBOARDS")
	for _, sprint := range sprints {
		fmt.Fprintf(table, "%d\t%s\t%s→%s\t%s\n",
			sprint.ID, sprint.Name, dateOrDash(sprint.StartDate), dateOrDash(sprint.EndDate), strings.Join(sprint.Boards, ", "))
	}
	table.Flush()
}

func dateOrDash(value string) string {
	if len(value) < 10 {
		return "-"
	}
	return value[:10]
}
