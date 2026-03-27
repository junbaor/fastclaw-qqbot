package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	logFile *os.File
	logMu   sync.Mutex
	logDir  string
	logPath string
	logDate string // date when current qqbot.log was opened
)

func initLogger() {
	home, _ := os.UserHomeDir()
	logDir = filepath.Join(home, ".fastclaw", "logs")
	os.MkdirAll(logDir, 0755)
	logPath = filepath.Join(logDir, "qqbot.log")
	logDate = time.Now().Format("2006-01-02")
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		logFile = f
	}
}

// rotateIfNeeded renames qqbot.log → qqbot-YYYY-MM-DD.log when date changes
func rotateIfNeeded() {
	today := time.Now().Format("2006-01-02")
	if today == logDate {
		return
	}
	if logFile != nil {
		logFile.Close()
	}
	archive := filepath.Join(logDir, "qqbot-"+logDate+".log")
	os.Rename(logPath, archive)
	logDate = today
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		logFile = f
	}
}

func fileLog(direction, label string, data interface{}) {
	logMu.Lock()
	defer logMu.Unlock()
	if logFile == nil {
		return
	}
	rotateIfNeeded()
	ts := time.Now().Format(time.RFC3339Nano)
	var s string
	switch v := data.(type) {
	case string:
		s = v
	default:
		b, _ := json.Marshal(v)
		s = string(b)
	}
	fmt.Fprintf(logFile, "[%s] [%s] %s: %s\n", ts, direction, label, s)
}

func log(msg string) {
	fileLog("LOG", "info", msg)
}

func logf(format string, args ...interface{}) {
	log(fmt.Sprintf(format, args...))
}
