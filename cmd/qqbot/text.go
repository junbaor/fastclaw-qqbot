package main

import (
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ── Text Processing ──

var mentionRe = regexp.MustCompile(`<@!?\w+>`)

func stripMentions(text string) string {
	return strings.TrimSpace(mentionRe.ReplaceAllString(text, ""))
}

var (
	thinkRe      = regexp.MustCompile(`(?s)<think>.*?</think>`)
	codeBlockRe  = regexp.MustCompile("(?s)```[^\\n]*\\n?(.*?)```")
	imageRe      = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	linkRe       = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	tableSepRe   = regexp.MustCompile(`(?m)^\|[\s:|\-]+\|$`)
	tableRowRe   = regexp.MustCompile(`(?m)^\|(.+)\|$`)
	boldStarRe   = regexp.MustCompile(`\*\*(.+?)\*\*`)
	boldUnderRe  = regexp.MustCompile(`__(.+?)__`)
	italicStarRe = regexp.MustCompile(`\*(.+?)\*`)
	italicUnderRe = regexp.MustCompile(`_(.+?)_`)
	strikeRe     = regexp.MustCompile(`~~(.*?)~~`)
	headerRe     = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	blockquoteRe = regexp.MustCompile(`(?m)^>\s?`)
	listMarkerRe = regexp.MustCompile(`(?m)^[-*+]\s`)
)

func stripThinkTags(text string) string {
	r := thinkRe.ReplaceAllString(text, "")
	r = codeBlockRe.ReplaceAllString(r, "$1")
	r = imageRe.ReplaceAllString(r, "")
	r = linkRe.ReplaceAllString(r, "$1")
	r = tableSepRe.ReplaceAllString(r, "")
	r = tableRowRe.ReplaceAllStringFunc(r, func(s string) string {
		inner := strings.Trim(s, "|")
		parts := strings.Split(inner, "|")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		return strings.Join(parts, "  ")
	})
	r = boldStarRe.ReplaceAllString(r, "$1")
	r = boldUnderRe.ReplaceAllString(r, "$1")
	r = italicStarRe.ReplaceAllString(r, "$1")
	r = italicUnderRe.ReplaceAllString(r, "$1")
	r = strikeRe.ReplaceAllString(r, "$1")
	r = headerRe.ReplaceAllString(r, "")
	r = blockquoteRe.ReplaceAllString(r, "")
	r = listMarkerRe.ReplaceAllString(r, "• ")
	return strings.TrimSpace(r)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ── Attachments ──

type Attachment struct {
	ContentType string `json:"content_type"`
	Filename    string `json:"filename"`
	URL         string `json:"url"`
	Size        int    `json:"size"`
}

var textFileExts = map[string]bool{
	".sql": true, ".txt": true, ".json": true, ".xml": true, ".csv": true,
	".md": true, ".yaml": true, ".yml": true, ".toml": true, ".ini": true,
	".cfg": true, ".conf": true, ".log": true, ".sh": true, ".bash": true,
	".zsh": true, ".py": true, ".js": true, ".ts": true, ".mjs": true,
	".cjs": true, ".jsx": true, ".tsx": true, ".go": true, ".rs": true,
	".java": true, ".c": true, ".cpp": true, ".h": true, ".hpp": true,
	".cs": true, ".rb": true, ".php": true, ".lua": true, ".r": true,
	".swift": true, ".kt": true, ".scala": true, ".html": true, ".css": true,
	".scss": true, ".less": true, ".vue": true, ".svelte": true, ".env": true,
	".gitignore": true, ".dockerfile": true, ".makefile": true,
}

func isTextFile(filename string) bool {
	return textFileExts[strings.ToLower(filepath.Ext(filename))]
}

func downloadTextFile(url string, maxBytes int) string {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil || resp.StatusCode != 200 {
		return ""
	}
	defer resp.Body.Close()
	buf := make([]byte, maxBytes)
	n, _ := io.ReadFull(resp.Body, buf)
	return string(buf[:n])
}

func formatAttachments(attachments []Attachment) string {
	if len(attachments) == 0 {
		return ""
	}
	var parts []string
	for _, att := range attachments {
		ct, fn, url := att.ContentType, att.Filename, att.URL
		switch {
		case strings.HasPrefix(ct, "image/"):
			parts = append(parts, fmt.Sprintf("\n[图片: %s]", url))
		case strings.HasPrefix(ct, "audio/") || strings.HasSuffix(fn, ".silk"):
			parts = append(parts, fmt.Sprintf("\n[语音: %s]", url))
		case strings.HasPrefix(ct, "video/"):
			parts = append(parts, fmt.Sprintf("\n[视频: %s]", url))
		case isTextFile(fn):
			logf("[attachment] Downloading text file: %s (%d bytes)", fn, att.Size)
			content := downloadTextFile(url, 50000)
			if content != "" {
				parts = append(parts, fmt.Sprintf("\n[文件: %s]\n```\n%s\n```", fn, content))
			} else {
				parts = append(parts, fmt.Sprintf("\n[文件: %s] (下载失败)", fn))
			}
		default:
			label := fn
			if label == "" {
				label = url
			}
			if url != "" && fn != "" {
				parts = append(parts, fmt.Sprintf("\n[文件: %s %s]", fn, url))
			} else {
				parts = append(parts, fmt.Sprintf("\n[文件: %s]", label))
			}
		}
	}
	return strings.Join(parts, "")
}
