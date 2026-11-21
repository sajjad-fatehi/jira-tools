package jira

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	envBaseURL  = "JIRA_BASE_URL"
	envUsername = "JIRA_USERNAME"
	envPassword = "JIRA_PASSWORD"

	envEnvFile       = "JIRA_TOOLS_ENV_FILE"
	envXDGConfigHome = "XDG_CONFIG_HOME"
	appDirName       = "jira-tools"
)

// Config holds connection settings. Password never appears in formatted output.
type Config struct {
	BaseURL  string
	Username string
	Password string
}

func (config Config) String() string {
	return fmt.Sprintf("Config{BaseURL: %s, Username: %s, Password: <redacted>}", config.BaseURL, config.Username)
}

// DefaultEnvFile is where credentials live so the binary works from any directory:
// $XDG_CONFIG_HOME/jira-tools/.env, falling back to ~/.config/jira-tools/.env.
func DefaultEnvFile() string {
	if configHome := os.Getenv(envXDGConfigHome); configHome != "" {
		return filepath.Join(configHome, appDirName, ".env")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".env"
	}
	return filepath.Join(home, ".config", appDirName, ".env")
}

// EnvFile returns the env file to read when -env-file is not given:
// $JIRA_TOOLS_ENV_FILE if set, otherwise DefaultEnvFile. A path that differs
// from DefaultEnvFile counts as chosen by the user, so a missing file is an error.
func EnvFile() string {
	if override := os.Getenv(envEnvFile); override != "" {
		return override
	}
	return DefaultEnvFile()
}

// LoadConfig reads env vars first and fills the missing ones from envFile.
// A missing file is an error only when the caller asked for it explicitly.
func LoadConfig(envFile string, explicit bool) (Config, error) {
	fileValues, err := readEnvFile(envFile)
	if err != nil && (explicit || !os.IsNotExist(err)) {
		return Config{}, fmt.Errorf("read env file %s: %w", envFile, err)
	}

	lookup := func(name string) string {
		if value := os.Getenv(name); value != "" {
			return value
		}
		return fileValues[name]
	}

	config := Config{
		BaseURL:  strings.TrimRight(lookup(envBaseURL), "/"),
		Username: lookup(envUsername),
		Password: lookup(envPassword),
	}
	for name, value := range map[string]string{
		envBaseURL:  config.BaseURL,
		envUsername: config.Username,
		envPassword: config.Password,
	} {
		if value == "" {
			return Config{}, fmt.Errorf("%s is not set (export it or put it in %s)", name, envFile)
		}
	}
	return config, nil
}

func readEnvFile(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	values := map[string]string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		name, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		values[strings.TrimSpace(name)] = unquote(strings.TrimSpace(value))
	}
	return values, scanner.Err()
}

func unquote(value string) string {
	if len(value) >= 2 {
		first, last := value[0], value[len(value)-1]
		if first == last && (first == '"' || first == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}
