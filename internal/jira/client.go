package jira

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"time"
)

const (
	sessionPath = "/rest/auth/1/session"
	apiPrefix   = "/rest/api/2"
	// Jira rejects attachment uploads without this header (XSRF check).
	xsrfHeader = "X-Atlassian-Token"
)

// Client logs in once with a session cookie. Some Jira Server instances sit
// behind proxies that drop the Authorization header (Basic and Bearer), so
// cookie auth works where header auth does not.
type Client struct {
	config     Config
	httpClient *http.Client
	loggedIn   bool
}

func NewClient(config Config) (*Client, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, fmt.Errorf("create cookie jar: %w", err)
	}
	return &Client{
		config:     config,
		httpClient: &http.Client{Jar: jar, Timeout: 30 * time.Second},
	}, nil
}

// Login is called lazily by Do and never retried: repeated failures trigger Jira's CAPTCHA lockout.
func (client *Client) Login(ctx context.Context) error {
	payload, err := json.Marshal(map[string]string{
		"username": client.config.Username,
		"password": client.config.Password,
	})
	if err != nil {
		return fmt.Errorf("encode login payload: %w", err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.config.BaseURL+sessionPath, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build login request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("login request failed: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)

	if response.StatusCode != http.StatusOK {
		message := fmt.Sprintf("login failed: HTTP %d", response.StatusCode)
		if reason := response.Header.Get("X-Seraph-LoginReason"); reason != "" {
			message += " (" + reason + ")"
		}
		return fmt.Errorf("%s; check JIRA_USERNAME/JIRA_PASSWORD, not retrying to avoid CAPTCHA lockout", message)
	}
	client.loggedIn = true
	return nil
}

// Do sends a request with the session cookie and returns the raw response body.
func (client *Client) Do(ctx context.Context, request Request) ([]byte, error) {
	if !client.loggedIn {
		if err := client.Login(ctx); err != nil {
			return nil, err
		}
	}

	body, contentType, err := request.encodeBody()
	if err != nil {
		return nil, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, request.Method, client.config.BaseURL+request.Path, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	httpRequest.Header.Set("Accept", "application/json")
	if contentType != "" {
		httpRequest.Header.Set("Content-Type", contentType)
	}
	if len(request.Files) > 0 {
		httpRequest.Header.Set(xsrfHeader, "no-check")
	}

	response, err := client.httpClient.Do(httpRequest)
	if err != nil {
		return nil, fmt.Errorf("%s %s failed: %w", request.Method, request.Path, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if response.StatusCode >= http.StatusMultipleChoices {
		return nil, newAPIError(request, response.StatusCode, payload)
	}
	return payload, nil
}

// BrowseURL is the human-facing link of an issue.
func (client *Client) BrowseURL(key string) string {
	return client.config.BaseURL + "/browse/" + key
}

func newAPIError(request Request, status int, payload []byte) error {
	var parsed struct {
		ErrorMessages []string          `json:"errorMessages"`
		Errors        map[string]string `json:"errors"`
	}
	details := []string{}
	if json.Unmarshal(payload, &parsed) == nil {
		details = append(details, parsed.ErrorMessages...)
		for field, message := range parsed.Errors {
			details = append(details, field+": "+message)
		}
	}
	message := fmt.Sprintf("%s %s: HTTP %d", request.Method, request.Path, status)
	if len(details) > 0 {
		message += ": " + strings.Join(details, "; ")
	}
	return fmt.Errorf("%s", message)
}

// Download fetches an attachment body. The URL comes from Jira's own attachment
// metadata; it must stay under the configured base URL so the session cookie is
// never sent to another host.
func (client *Client) Download(ctx context.Context, contentURL string) ([]byte, error) {
	if !strings.HasPrefix(contentURL, client.config.BaseURL+"/") {
		return nil, fmt.Errorf("refusing to download from %q: outside Jira base URL", contentURL)
	}
	if !client.loggedIn {
		if err := client.Login(ctx); err != nil {
			return nil, err
		}
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, contentURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build download request: %w", err)
	}
	response, err := client.httpClient.Do(httpRequest)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read download: %w", err)
	}
	if response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("GET %s: HTTP %d", contentURL, response.StatusCode)
	}
	return payload, nil
}
