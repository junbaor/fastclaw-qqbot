package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ── QQ Bot API ──

func getAccessToken() (string, error) {
	tokenMu.Lock()
	defer tokenMu.Unlock()

	if tokenCache != nil && time.Now().Before(tokenCache.ExpiresAt.Add(-60*time.Second)) {
		return tokenCache.Token, nil
	}

	log("Fetching new access token...")
	body, _ := json.Marshal(map[string]string{
		"appId":        config.AppID,
		"clientSecret": config.ClientSecret,
	})

	resp, err := http.Post(TokenURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	var data struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   json.Number `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", fmt.Errorf("token decode failed: %w", err)
	}
	if data.AccessToken == "" {
		return "", fmt.Errorf("empty access_token in response")
	}

	expiresIn, _ := data.ExpiresIn.Int64()
	if expiresIn == 0 {
		expiresIn = 7200
	}
	tokenCache = &TokenInfo{
		Token:     data.AccessToken,
		ExpiresAt: time.Now().Add(time.Duration(expiresIn) * time.Second),
	}
	logf("Access token obtained, expires in %ds", expiresIn)
	return tokenCache.Token, nil
}

func apiRequest(method, path string, body interface{}) (json.RawMessage, error) {
	token, err := getAccessToken()
	if err != nil {
		return nil, err
	}

	url := apiBase + path
	var reqBody io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		fileLog("API-REQ", fmt.Sprintf("%s %s", method, path), string(b))
		reqBody = bytes.NewReader(b)
	} else {
		fileLog("API-REQ", fmt.Sprintf("%s %s", method, path), "no body")
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "QQBot "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	fileLog("API-RSP", fmt.Sprintf("%s %s status=%d", method, path, resp.StatusCode), string(respBody))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("API Error [%s] %d: %s", path, resp.StatusCode, string(respBody))
	}
	if len(respBody) == 0 {
		return json.RawMessage("{}"), nil
	}
	return json.RawMessage(respBody), nil
}

func getGatewayURL() (string, error) {
	raw, err := apiRequest("GET", "/gateway", nil)
	if err != nil {
		return "", err
	}
	var data struct {
		URL string `json:"url"`
	}
	json.Unmarshal(raw, &data)
	return data.URL, nil
}

// ── Message Sending ──

func nextMsgSeq() int {
	t := time.Now().UnixMilli() % 100000000
	r := time.Now().UnixNano() % 65536
	return int((t ^ r) % 65536)
}

func sendC2CMessage(openid, content, msgID string) error {
	body := map[string]interface{}{
		"content": content, "msg_type": 0, "msg_seq": nextMsgSeq(),
	}
	if msgID != "" {
		body["msg_id"] = msgID
	}
	_, err := apiRequest("POST", fmt.Sprintf("/v2/users/%s/messages", openid), body)
	return err
}

func sendGroupMessage(groupOpenid, content, msgID string) error {
	body := map[string]interface{}{
		"content": content, "msg_type": 0, "msg_seq": nextMsgSeq(),
	}
	if msgID != "" {
		body["msg_id"] = msgID
	}
	_, err := apiRequest("POST", fmt.Sprintf("/v2/groups/%s/messages", groupOpenid), body)
	return err
}

func sendChannelMessage(channelID, content, msgID string) error {
	body := map[string]interface{}{"content": content}
	if msgID != "" {
		body["msg_id"] = msgID
	}
	_, err := apiRequest("POST", fmt.Sprintf("/channels/%s/messages", channelID), body)
	return err
}

func sendDmMessage(guildID, content, msgID string) error {
	body := map[string]interface{}{"content": content}
	if msgID != "" {
		body["msg_id"] = msgID
	}
	_, err := apiRequest("POST", fmt.Sprintf("/dms/%s/messages", guildID), body)
	return err
}

// ── Outbound: channel.send ──

func handleChannelSend(params SendParams) (map[string]string, error) {
	if params.ChatID == "" || params.Text == "" {
		return nil, fmt.Errorf("chatId and text required")
	}

	plainText := stripThinkTags(params.Text)
	replyMsgID := getLastMsgID(params.ChatID)

	switch {
	case strings.HasPrefix(params.ChatID, "c2c:"):
		openid := params.ChatID[4:]
		if err := sendC2CMessage(openid, plainText, replyMsgID); err != nil {
			return nil, err
		}
		logf("C2C → %s: %s", openid, truncate(plainText, 80))

	case strings.HasPrefix(params.ChatID, "group:"):
		groupOpenid := params.ChatID[6:]
		if err := sendGroupMessage(groupOpenid, plainText, replyMsgID); err != nil {
			return nil, err
		}
		logf("Group → %s: %s", groupOpenid, truncate(plainText, 80))

	case strings.HasPrefix(params.ChatID, "channel:"):
		channelID := params.ChatID[8:]
		if err := sendChannelMessage(channelID, plainText, replyMsgID); err != nil {
			return nil, err
		}
		logf("Channel → %s: %s", channelID, truncate(plainText, 80))

	case strings.HasPrefix(params.ChatID, "dm:"):
		guildID := params.ChatID[3:]
		if err := sendDmMessage(guildID, plainText, replyMsgID); err != nil {
			return nil, err
		}
		logf("DM → %s: %s", guildID, truncate(plainText, 80))

	default:
		return nil, fmt.Errorf("unknown chatId format: %s", params.ChatID)
	}

	return map[string]string{"status": "sent", "target": params.ChatID}, nil
}
