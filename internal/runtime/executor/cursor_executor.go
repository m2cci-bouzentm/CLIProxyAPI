package executor

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	cursorauth "github.com/router-for-me/CLIProxyAPI/v8/internal/auth/cursor"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	log "github.com/sirupsen/logrus"
)

const (
	cursorBridgeDefaultPort = "18318"
	cursorBridgeStartWait   = 20 * time.Second
	cursorBridgeRestartWait = 2 * time.Second
)

var cursorBridgeOnce sync.Once

// CursorExecutor sends OpenAI chat-completions requests to the local Cursor bridge,
// a Node child process that runs the official Cursor SDK with the credential's API key.
type CursorExecutor struct {
	*OpenAICompatExecutor
}

// NewCursorExecutor creates the Cursor executor and starts the Cursor bridge process once.
func NewCursorExecutor(cfg *config.Config) *CursorExecutor {
	cursorBridgeOnce.Do(func() { go superviseCursorBridge() })
	return &CursorExecutor{OpenAICompatExecutor: NewOpenAICompatExecutor("cursor", cfg)}
}

// Execute implements cliproxyauth.ProviderExecutor.
func (e *CursorExecutor) Execute(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	if errWait := waitCursorBridge(ctx); errWait != nil {
		return cliproxyexecutor.Response{}, errWait
	}
	return e.executeWithCredentials(ctx, auth, req, opts, cursorBridgeBaseURL(), cursorAPIKey(auth), nil)
}

// ExecuteStream implements cliproxyauth.ProviderExecutor.
func (e *CursorExecutor) ExecuteStream(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	if errWait := waitCursorBridge(ctx); errWait != nil {
		return nil, errWait
	}
	return e.executeStreamWithCredentials(ctx, auth, req, opts, cursorBridgeBaseURL(), cursorAPIKey(auth), nil)
}

// Refresh keeps the credential unchanged: the Cursor login mints an API key that is valid for 90 days.
func (e *CursorExecutor) Refresh(_ context.Context, auth *cliproxyauth.Auth) (*cliproxyauth.Auth, error) {
	return auth, nil
}

func cursorAPIKey(auth *cliproxyauth.Auth) string {
	apiKey, _ := auth.Metadata["api_key"].(string)
	return strings.TrimSpace(apiKey)
}

func cursorBridgePort() string {
	port := strings.TrimSpace(os.Getenv("CURSOR_BRIDGE_PORT"))
	if port == "" {
		return cursorBridgeDefaultPort
	}
	return port
}

func cursorBridgeBaseURL() string {
	return "http://127.0.0.1:" + cursorBridgePort() + "/v1"
}

func superviseCursorBridge() {
	for {
		cmd := exec.Command(cursorauth.BridgeNode(), cursorauth.BridgeScript())
		cmd.Env = append(os.Environ(), "CURSOR_BRIDGE_PORT="+cursorBridgePort())
		stdout := log.StandardLogger().WriterLevel(log.InfoLevel)
		stderr := log.StandardLogger().WriterLevel(log.WarnLevel)
		cmd.Stdout = stdout
		cmd.Stderr = stderr
		errRun := cmd.Run()
		log.Warnf("cursor bridge exited: %v; restarting in %s", errRun, cursorBridgeRestartWait)
		if errClose := stdout.Close(); errClose != nil {
			log.Errorf("cursor bridge: close stdout log writer: %v", errClose)
		}
		if errClose := stderr.Close(); errClose != nil {
			log.Errorf("cursor bridge: close stderr log writer: %v", errClose)
		}
		time.Sleep(cursorBridgeRestartWait)
	}
}

func waitCursorBridge(ctx context.Context) error {
	healthURL := "http://127.0.0.1:" + cursorBridgePort() + "/healthz"
	deadline := time.Now().Add(cursorBridgeStartWait)
	for {
		req, errRequest := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		if errRequest != nil {
			return errRequest
		}
		resp, errDo := http.DefaultClient.Do(req)
		if errDo == nil {
			if errClose := resp.Body.Close(); errClose != nil {
				log.Errorf("cursor bridge: close health response: %v", errClose)
			}
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return statusErr{code: http.StatusServiceUnavailable, msg: "cursor bridge is not running"}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
