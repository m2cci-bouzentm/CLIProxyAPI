// Package cursor runs the Cursor login through the Cursor bridge (a Node script that uses the official Cursor SDK).
package cursor

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const defaultBridgeDir = "/CLIProxyAPI/cursor-bridge"

// LoginResult is the API key that the Cursor login mints, with its account email and expiry.
type LoginResult struct {
	APIKey      string `json:"api_key"`
	Email       string `json:"email"`
	ExpiresAtMs int64  `json:"expires_at_ms"`
}

type loginLine struct {
	LoginURL string `json:"login_url"`
	LoginResult
}

// BridgeDir returns the directory that holds the Cursor bridge script and its node_modules.
func BridgeDir() string {
	dir := strings.TrimSpace(os.Getenv("CURSOR_BRIDGE_DIR"))
	if dir == "" {
		return defaultBridgeDir
	}
	return dir
}

// BridgeNode returns the Node.js binary that runs the Cursor bridge.
func BridgeNode() string {
	node := strings.TrimSpace(os.Getenv("CURSOR_BRIDGE_NODE"))
	if node == "" {
		return "node"
	}
	return node
}

// BridgeScript returns the path of the Cursor bridge entry script.
func BridgeScript() string {
	return filepath.Join(BridgeDir(), "index.mjs")
}

// Login runs the Cursor browser login. onLoginURL receives the login page URL before the login waits.
func Login(ctx context.Context, onLoginURL func(string)) (*LoginResult, error) {
	cmd := exec.CommandContext(ctx, BridgeNode(), BridgeScript(), "login")
	cmd.Stderr = os.Stderr
	stdout, errPipe := cmd.StdoutPipe()
	if errPipe != nil {
		return nil, fmt.Errorf("cursor login: stdout pipe: %w", errPipe)
	}
	if errStart := cmd.Start(); errStart != nil {
		return nil, fmt.Errorf("cursor login: start bridge: %w", errStart)
	}
	var result *LoginResult
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		var line loginLine
		if errDecode := json.Unmarshal(scanner.Bytes(), &line); errDecode != nil {
			continue
		}
		if line.LoginURL != "" {
			onLoginURL(line.LoginURL)
		}
		if line.APIKey != "" {
			result = &line.LoginResult
		}
	}
	if errWait := cmd.Wait(); errWait != nil {
		return nil, fmt.Errorf("cursor login: %w", errWait)
	}
	if result == nil {
		return nil, fmt.Errorf("cursor login: the bridge returned no API key")
	}
	return result, nil
}
