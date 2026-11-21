package main

import (
	"os"

	"github.com/sajjad-fatehi/jira-tools/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}
