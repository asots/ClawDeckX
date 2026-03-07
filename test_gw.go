//go:build ignore

package main

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	host := "192.168.168.138"
	port := 18789
	addr := fmt.Sprintf("%s:%d", host, port)

	// Step 1: TCP
	fmt.Printf("[TCP] Connecting to %s ... ", addr)
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		fmt.Printf("FAILED: %v\n", err)
		return
	}
	conn.Close()
	fmt.Println("OK")

	// Step 2: HTTP /health
	healthURL := fmt.Sprintf("http://%s/health", addr)
	fmt.Printf("[HTTP] GET %s ... ", healthURL)
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Get(healthURL)
	if err != nil {
		fmt.Printf("FAILED: %v\n", err)
	} else {
		fmt.Printf("HTTP %d\n", resp.StatusCode)
		resp.Body.Close()
	}

	// Step 3: WebSocket
	wsURL := fmt.Sprintf("ws://%s/", addr)
	fmt.Printf("[WS]   Dialing %s ... ", wsURL)
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	wsConn, wsResp, wsErr := dialer.Dial(wsURL, nil)
	if wsErr != nil {
		fmt.Printf("FAILED: %v\n", wsErr)
		if wsResp != nil {
			fmt.Printf("       HTTP status: %d\n", wsResp.StatusCode)
		}
	} else {
		fmt.Println("OK")
		// Try to read one message
		wsConn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, msg, err := wsConn.ReadMessage()
		if err != nil {
			fmt.Printf("[WS]   Read: %v\n", err)
		} else {
			fmt.Printf("[WS]   First message: %s\n", string(msg))
		}
		wsConn.Close()
	}

	// Step 4: HTTP /health with different paths
	for _, path := range []string{"/api/v1/status", "/healthz", "/ready"} {
		testURL := fmt.Sprintf("http://%s%s", addr, path)
		fmt.Printf("[HTTP] GET %s ... ", testURL)
		resp, err := client.Get(testURL)
		if err != nil {
			fmt.Printf("FAILED: %v\n", err)
		} else {
			fmt.Printf("HTTP %d\n", resp.StatusCode)
			resp.Body.Close()
		}
	}

	// Step 5: HTTPS /health
	healthsURL := fmt.Sprintf("https://%s/health", addr)
	fmt.Printf("[HTTPS] GET %s ... ", healthsURL)
	tlsClient := &http.Client{Timeout: 6 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	resp2, err2 := tlsClient.Get(healthsURL)
	if err2 != nil {
		fmt.Printf("FAILED: %v\n", err2)
	} else {
		fmt.Printf("HTTP %d\n", resp2.StatusCode)
		resp2.Body.Close()
	}

	// Step 6: WSS
	wssURL := fmt.Sprintf("wss://%s/", addr)
	fmt.Printf("[WSS]  Dialing %s ... ", wssURL)
	tlsDialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second, TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	wsConn2, _, wsErr2 := tlsDialer.Dial(wssURL, nil)
	if wsErr2 != nil {
		fmt.Printf("FAILED: %v\n", wsErr2)
	} else {
		fmt.Println("OK")
		wsConn2.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, msg2, err := wsConn2.ReadMessage()
		if err != nil {
			fmt.Printf("[WSS]  Read: %v\n", err)
		} else {
			fmt.Printf("[WSS]  First message: %s\n", string(msg2))
		}
		wsConn2.Close()
	}

	// Step 7: Raw TLS handshake probe
	fmt.Printf("[TLS]  Probing %s ... ", addr)
	tlsConn, tlsErr := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", addr, &tls.Config{InsecureSkipVerify: true})
	if tlsErr != nil {
		fmt.Printf("Not TLS: %v\n", tlsErr)
	} else {
		state := tlsConn.ConnectionState()
		fmt.Printf("TLS OK, version=0x%04x, serverName=%s\n", state.Version, state.ServerName)
		tlsConn.Close()
	}

	// Step 8: Try port 443 (maybe nginx proxy)
	for _, testPort := range []int{443, 80} {
		testAddr := fmt.Sprintf("%s:%d", host, testPort)
		fmt.Printf("[HTTP] GET http://%s/health ... ", testAddr)
		resp3, err3 := client.Get(fmt.Sprintf("http://%s/health", testAddr))
		if err3 != nil {
			fmt.Printf("FAILED: %v\n", err3)
		} else {
			fmt.Printf("HTTP %d\n", resp3.StatusCode)
			resp3.Body.Close()
		}
	}

	_ = url.URL{}
}
