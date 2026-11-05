package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func logFrame(line string) []byte {
	payload := []byte(line)
	header := make([]byte, 8)
	header[0] = 1
	binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
	return append(header, payload...)
}

func logsHost(t *testing.T, dockerHandler http.HandlerFunc, configure ...func(*httptest.Server)) *httptest.Server {
	t.Helper()
	docker := httptest.NewUnstartedServer(dockerHandler)
	for _, configureServer := range configure {
		configureServer(docker)
	}
	docker.Start()
	t.Cleanup(docker.Close)
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", docker.Listener.Addr().String())
	}}
	t.Cleanup(transport.CloseIdleConnections)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(requireAPIAuth("fixture-log-key"))
	router.GET("/api/v1/logs/stream/:deploymentId", runtimeLogsHandler(&http.Client{Transport: transport}, 10*time.Millisecond))
	host := httptest.NewServer(router)
	t.Cleanup(host.Close)
	return host
}

func openLogs(t *testing.T, host *httptest.Server, ctx context.Context) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, "GET", host.URL+"/api/v1/logs/stream/7", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer fixture-log-key")
	response, err := host.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { response.Body.Close() })
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("unexpected stream response: %s, %v", response.Status, response.Header)
	}
	return response
}

func TestRuntimeLogsEndAfterDockerEOF(t *testing.T) {
	host := logsHost(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.String(), "/containers/deployment-7/logs?") {
			t.Errorf("unexpected Docker request: %s", r.URL)
		}
		w.Write(logFrame("hello from runtime\n"))
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response := openLogs(t, host, ctx)
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("subscription did not reach EOF within 1s: %v", err)
	}
	if !strings.Contains(string(body), ": connected\n\n") || !strings.Contains(string(body), "data: \"hello from runtime\"\n\n") {
		t.Fatalf("missing established SSE output: %s", body)
	}
}

func TestRuntimeLogsReleaseDockerConnectionAfterEOF(t *testing.T) {
	closed := make(chan struct{}, 1)
	host := logsHost(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write(logFrame("finished\n"))
	}, func(docker *httptest.Server) {
		docker.Config.ConnState = func(_ net.Conn, state http.ConnState) {
			if state == http.StateClosed {
				closed <- struct{}{}
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response := openLogs(t, host, ctx)
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("completed subscription retained an owned Docker HTTP connection")
	}
}

func TestRuntimeLogsCancelRepeatedActiveSubscriptions(t *testing.T) {
	closed := make(chan struct{}, 5)
	host := logsHost(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write(logFrame("still running\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		closed <- struct{}{}
	})
	for cycle := 0; cycle < 5; cycle++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		response := openLogs(t, host, ctx)
		reader := bufio.NewReader(response.Body)
		var output strings.Builder
		for !strings.Contains(output.String(), ": heartbeat\n\n") || !strings.Contains(output.String(), "data: \"still running\"\n\n") {
			line, err := reader.ReadString('\n')
			if err != nil {
				cancel()
				t.Fatalf("active subscription lost output/heartbeat: %v", err)
			}
			output.WriteString(line)
		}
		if !strings.Contains(output.String(), "data: \"still running\"\n\n") {
			cancel()
			t.Fatalf("missing runtime output: %s", output.String())
		}
		cancel()
		response.Body.Close()
		select {
		case <-closed:
		case <-time.After(time.Second):
			t.Fatal("Docker reader remained subscribed after cancellation")
		}
	}
}

func TestRuntimeLogsCancelWhileDockerOpens(t *testing.T) {
	opened, closed := make(chan struct{}), make(chan struct{})
	host := logsHost(t, func(w http.ResponseWriter, r *http.Request) {
		close(opened)
		<-r.Context().Done()
		close(closed)
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response := openLogs(t, host, ctx)
	select {
	case <-opened:
	case <-ctx.Done():
		t.Fatal("Docker request did not open")
	}
	cancel()
	response.Body.Close()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("pending Docker request survived cancellation")
	}
}

func TestRuntimeLogsEndAfterInterruptedDockerConnection(t *testing.T) {
	host := logsHost(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write(logFrame("before interruption\n"))
		w.(http.Flusher).Flush()
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		connection.Close()
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response := openLogs(t, host, ctx)
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatalf("interrupted upstream did not end subscription within 1s: %v", err)
	}
}
