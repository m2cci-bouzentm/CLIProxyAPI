package auth

import (
	"context"
	"fmt"
	"strings"
	"time"

	cursorauth "github.com/router-for-me/CLIProxyAPI/v8/internal/auth/cursor"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/browser"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

// CursorAuthenticator runs the Cursor browser login, which mints a Cursor API key.
type CursorAuthenticator struct{}

// NewCursorAuthenticator constructs a new Cursor authenticator.
func NewCursorAuthenticator() Authenticator {
	return &CursorAuthenticator{}
}

// Provider returns the provider key for Cursor.
func (CursorAuthenticator) Provider() string {
	return "cursor"
}

// RefreshLead returns nil: the minted Cursor API key has no refresh token and is valid for 90 days.
func (CursorAuthenticator) RefreshLead() *time.Duration {
	return nil
}

// Login runs the Cursor browser login and returns the credential that holds the minted API key.
func (a CursorAuthenticator) Login(ctx context.Context, cfg *config.Config, opts *LoginOptions) (*coreauth.Auth, error) {
	if cfg == nil {
		return nil, fmt.Errorf("cliproxy auth: configuration is required")
	}
	if opts == nil {
		opts = &LoginOptions{}
	}

	fmt.Println("Starting Cursor authentication...")
	onLoginURL := func(url string) {
		fmt.Printf("\nTo authenticate, please visit:\n%s\n\n", url)
		if opts.NoBrowser || !browser.IsAvailable() {
			return
		}
		if errOpen := browser.OpenURL(url); errOpen != nil {
			log.Warnf("Failed to open browser automatically: %v", errOpen)
		}
	}
	result, errLogin := cursorauth.Login(ctx, onLoginURL)
	if errLogin != nil {
		return nil, errLogin
	}

	expired := time.UnixMilli(result.ExpiresAtMs).UTC().Format(time.RFC3339)
	label := strings.TrimSpace(result.Email)
	if label == "" {
		label = "Cursor"
	}
	fileName := "cursor-" + strings.ReplaceAll(label, "/", "_") + ".json"
	metadata := map[string]any{
		"type":    "cursor",
		"api_key": result.APIKey,
		"email":   result.Email,
		"expired": expired,
	}

	fmt.Println("Cursor authentication successful")
	return &coreauth.Auth{
		ID:       fileName,
		Provider: a.Provider(),
		FileName: fileName,
		Label:    label,
		Metadata: metadata,
	}, nil
}
