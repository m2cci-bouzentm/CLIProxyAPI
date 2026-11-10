package registry

// cursorModelNames maps each Cursor model ID (as listed by the Cursor SDK) to its display name.
// Clients call them as "cursor/<id>", so they never collide with the same model served by another provider.
var cursorModelNames = [][2]string{
	{"composer-2.5", "Composer 2.5"},
	{"composer-2", "Composer 2"},
	{"grok-4.7", "Grok 4.7"},
	{"grok-4.6", "Grok 4.6"},
	{"grok-4.5", "Grok 4.5"},
	{"claude-opus-5-5", "Claude Opus 5.5"},
	{"claude-opus-5", "Claude Opus 5"},
	{"claude-opus-4-8", "Claude Opus 4.8"},
	{"claude-opus-4-7", "Claude Opus 4.7"},
	{"claude-opus-4-6", "Claude Opus 4.6"},
	{"claude-opus-4-5", "Claude Opus 4.5"},
	{"claude-fable-5-2", "Claude Fable 5.2"},
	{"claude-fable-5-1", "Claude Fable 5.1"},
	{"claude-fable-5", "Claude Fable 5"},
	{"claude-sonnet-5-5", "Claude Sonnet 5.5"},
	{"claude-sonnet-5", "Claude Sonnet 5"},
	{"claude-sonnet-4-6", "Claude Sonnet 4.6"},
	{"claude-sonnet-4-5", "Claude Sonnet 4.5"},
	{"claude-sonnet-4", "Claude Sonnet 4"},
	{"claude-haiku-5-5", "Claude Haiku 5.5"},
	{"claude-haiku-4-5", "Claude Haiku 4.5"},
	{"gpt-5.6-sol", "GPT-5.6 Sol"},
	{"gpt-5.6-terra", "GPT-5.6 Terra"},
	{"gpt-5.6-luna", "GPT-5.6 Luna"},
	{"gpt-5.5", "GPT-5.5"},
	{"gpt-5.4", "GPT-5.4"},
	{"gpt-5.4-mini", "GPT-5.4 Mini"},
	{"gpt-5.4-nano", "GPT-5.4 Nano"},
	{"gpt-5.3-codex", "Codex 5.3"},
	{"gpt-5.2", "GPT-5.2"},
	{"gpt-5.1", "GPT-5.1"},
	{"gpt-5-mini", "GPT-5 Mini"},
	{"gemini-4-argon", "Gemini 4 Argon"},
	{"gemini-3.8-flash", "Gemini 3.8 Flash"},
	{"gemini-3.5-flash", "Gemini 3.5 Flash"},
	{"gemini-3.1-pro", "Gemini 3.1 Pro"},
	{"gemini-3-flash", "Gemini 3 Flash"},
	{"gemini-2.5-flash", "Gemini 2.5 Flash"},
	{"muse-wonder-1.0", "Muse Wonder"},
	{"muse-spark-1.3", "Muse Spark 1.3"},
	{"kimi-k3", "Kimi K3"},
	{"kimi-k2.7-code", "Kimi K2.7 Code"},
	{"glm-5.2", "GLM 5.2"},
	{"glm-5p3", "GLM 5.3"},
	{"glm-5p3-flash", "GLM 5.3 Flash"},
	{"deepseek-v41-flash-1017", "DeepSeek V4.1 Flash 1017"},
}

// GetCursorModels returns the models served through the Cursor provider.
func GetCursorModels() []*ModelInfo {
	models := make([]*ModelInfo, 0, len(cursorModelNames))
	for _, entry := range cursorModelNames {
		models = append(models, &ModelInfo{
			ID:                        "cursor/" + entry[0],
			Object:                    "model",
			Type:                      "cursor",
			OwnedBy:                   "cursor",
			DisplayName:               entry[1] + " (Cursor)",
			SupportedInputModalities:  []string{"text", "image"},
			SupportedOutputModalities: []string{"text"},
		})
	}
	return models
}
