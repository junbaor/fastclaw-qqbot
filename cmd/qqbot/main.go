package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// ── Constants ──

const (
	APIBase        = "https://api.sgroup.qq.com"
	SandboxAPIBase = "https://sandbox.api.sgroup.qq.com"
	TokenURL       = "https://bots.qq.com/app/getAppAccessToken"
)

const (
	IntentDirectMessage      = 1 << 12
	IntentGroupAndC2C        = 1 << 25
	IntentInteraction        = 1 << 26
	IntentPublicGuildMessage = 1 << 30
)

var version = "dev"

var FullIntents = IntentPublicGuildMessage | IntentDirectMessage | IntentGroupAndC2C | IntentInteraction

var reconnectDelays = []time.Duration{
	1 * time.Second, 2 * time.Second, 5 * time.Second,
	10 * time.Second, 30 * time.Second, 60 * time.Second,
}

const maxReconnectAttempts = 50

// ── Types ──

type PluginConfig struct {
	AppID        string `json:"appId"`
	ClientSecret string `json:"clientSecret"`
	Sandbox      string `json:"sandbox"`
}

type TokenInfo struct {
	Token     string
	ExpiresAt time.Time
}

type msgEntry struct {
	MsgID     string
	Timestamp time.Time
}

// ── Global State ──

var (
	config            PluginConfig
	apiBase           = APIBase
	tokenCache        *TokenInfo
	tokenMu           sync.Mutex
	sessionID         string
	lastSeq           *int64
	connMu            sync.Mutex
	heartbeatStop     chan struct{}
	reconnectAttempts int
	isShuttingDown    bool
	shutdownMu        sync.Mutex
	lastMsgIDs        sync.Map
)

// ── Main ──

func main() {
	// Handle CLI commands (--setup, --version, etc.)
	if len(os.Args) > 1 {
		handleCLI(os.Args[1:])
		return
	}

	// Default: run as JSON-RPC subprocess plugin
	initLogger()
	log("Plugin process started, waiting for initialize...")

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fileLog("RPC-IN", "request", line)

		var req RPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			rpcSend(RPCResponse{
				JSONRPC: "2.0",
				Error:   &RPCError{Code: -32700, Message: fmt.Sprintf("Parse error: %v", err)},
			})
			continue
		}
		handleRequest(req)
	}

	shutdownMu.Lock()
	isShuttingDown = true
	shutdownMu.Unlock()
	cleanup()
}

func handleCLI(args []string) {
	switch args[0] {
	case "--setup":
		appID, secret := "", ""
		for i := 1; i < len(args); i++ {
			switch args[i] {
			case "--appid":
				if i+1 < len(args) {
					appID = args[i+1]
					i++
				}
			case "--secret":
				if i+1 < len(args) {
					secret = args[i+1]
					i++
				}
			}
		}
		runSetup(appID, secret)
	case "--version":
		fmt.Println("qqbot version", version)
	case "--help", "-h":
		fmt.Println("Usage:")
		fmt.Println("  qqbot                                          Run as FastClaw plugin (JSON-RPC mode)")
		fmt.Println("  qqbot --setup --appid ID --secret SECRET       Configure fastclaw.json")
		fmt.Println("  qqbot --version                                Show version")
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\nRun 'qqbot --help' for usage.\n", args[0])
		os.Exit(1)
	}
}

func isShutdown() bool {
	shutdownMu.Lock()
	defer shutdownMu.Unlock()
	return isShuttingDown
}

func setLastMsgID(chatKey, msgID string) {
	lastMsgIDs.Store(chatKey, msgEntry{MsgID: msgID, Timestamp: time.Now()})
}

func getLastMsgID(chatKey string) string {
	v, ok := lastMsgIDs.Load(chatKey)
	if !ok {
		return ""
	}
	entry := v.(msgEntry)
	if time.Since(entry.Timestamp) > 4*time.Minute+30*time.Second {
		lastMsgIDs.Delete(chatKey)
		return ""
	}
	return entry.MsgID
}
