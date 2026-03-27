package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// runSetup handles: qqbot --setup --appid XXX --secret YYY
// Merges qqbot plugin config into ~/.fastclaw/fastclaw.json
func runSetup(appID, clientSecret string) {
	if appID == "" || clientSecret == "" {
		fmt.Fprintln(os.Stderr, "Error: --appid and --secret are required")
		fmt.Fprintln(os.Stderr, "Usage: qqbot --setup --appid YOUR_APPID --secret YOUR_SECRET")
		os.Exit(1)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot determine home directory: %v\n", err)
		os.Exit(1)
	}

	configPath := filepath.Join(home, ".fastclaw", "fastclaw.json")
	os.MkdirAll(filepath.Dir(configPath), 0755)

	cfg := loadOrCreateConfig(configPath)
	mergePluginConfig(cfg, appID, clientSecret)

	data, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot write config: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Config updated:", configPath)
}

func loadOrCreateConfig(path string) map[string]interface{} {
	data, err := os.ReadFile(path)
	if err != nil {
		return make(map[string]interface{})
	}
	var cfg map[string]interface{}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return make(map[string]interface{})
	}
	return cfg
}

func mergePluginConfig(cfg map[string]interface{}, appID, clientSecret string) {
	// plugins section
	plugins, _ := cfg["plugins"].(map[string]interface{})
	if plugins == nil {
		plugins = make(map[string]interface{})
		cfg["plugins"] = plugins
	}
	plugins["enabled"] = true

	// plugins.paths
	paths, _ := plugins["paths"].([]interface{})
	hasPath := false
	for _, p := range paths {
		if p == "~/.fastclaw/plugins" {
			hasPath = true
			break
		}
	}
	if !hasPath {
		paths = append(paths, "~/.fastclaw/plugins")
		plugins["paths"] = paths
	}

	// plugins.entries.qqbot
	entries, _ := plugins["entries"].(map[string]interface{})
	if entries == nil {
		entries = make(map[string]interface{})
		plugins["entries"] = entries
	}
	entries["qqbot"] = map[string]interface{}{
		"enabled": true,
		"config": map[string]interface{}{
			"appId":        appID,
			"clientSecret": clientSecret,
		},
	}

	// bindings — add qqbot binding if not present
	bindings, _ := cfg["bindings"].([]interface{})
	hasBinding := false
	for _, b := range bindings {
		bm, _ := b.(map[string]interface{})
		if bm == nil {
			continue
		}
		match, _ := bm["match"].(map[string]interface{})
		if match != nil && match["channel"] == "qqbot" {
			hasBinding = true
			break
		}
	}
	if !hasBinding {
		agentID := "default"
		// try to find first agent
		if agents, ok := cfg["agents"].(map[string]interface{}); ok {
			if list, ok := agents["list"].([]interface{}); ok && len(list) > 0 {
				if first, ok := list[0].(map[string]interface{}); ok {
					if id, ok := first["id"].(string); ok && id != "" {
						agentID = id
					}
				}
			}
		}
		bindings = append(bindings, map[string]interface{}{
			"agentId": agentID,
			"match":   map[string]interface{}{"channel": "qqbot"},
		})
		cfg["bindings"] = bindings
	}
}
