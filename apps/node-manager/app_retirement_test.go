package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestAppRetirementOwnsRuntimeAndRetriesPartialCleanup(t *testing.T) {
	fail := true
	changed := false
	runtimes := map[string]map[string]any{
		"owned":   {"Id": "owned", "Names": []string{"/deployment-41"}, "Name": "/deployment-41", "Labels": map[string]string{"nmt.app-id": "7", "nmt.deployment-id": "41", "nmt.artifact": "runtime"}},
		"sibling": {"Id": "sibling", "Names": []string{"/deployment-42"}, "Name": "/deployment-42", "Labels": map[string]string{"nmt.app-id": "8", "nmt.deployment-id": "42", "nmt.artifact": "runtime"}},
	}
	docker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/containers/json" {
			values := []map[string]any{}
			for _, c := range runtimes {
				values = append(values, c)
			}
			json.NewEncoder(w).Encode(values)
			return
		}
		if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/json") {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/containers/"), "/json")
			if c, ok := runtimes[id]; ok {
				labels := c["Labels"]
				if changed && id == "owned" {
					labels = map[string]string{"nmt.app-id": "8", "nmt.deployment-id": "41", "nmt.artifact": "runtime"}
				}
				json.NewEncoder(w).Encode(map[string]any{"Id": id, "Config": map[string]any{"Labels": labels}})
			} else {
				w.WriteHeader(404)
			}
			return
		}
		if r.Method == "DELETE" && r.URL.Path == "/containers/owned" {
			if r.URL.Query().Get("force") != "true" || r.URL.Query().Get("v") != "false" {
				t.Error("unexpected cleanup flags")
			}
			if fail {
				w.WriteHeader(500)
				return
			}
			delete(runtimes, "owned")
			w.WriteHeader(204)
			return
		}
		t.Errorf("unrelated Docker operation: %s %s", r.Method, r.URL)
		w.WriteHeader(500)
	}))
	defer docker.Close()
	client := docker.Client()
	client.Transport = &retirementTransport{base: docker.URL, inner: http.DefaultTransport}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(requireAPIAuth("owner-host-key"))
	router.POST("/api/v1/apps/:appId/retire", appRetirementHandler(client))
	send := func(key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/v1/apps/7/retire", bytes.NewBufferString(`{"deploymentIds":[41]}`))
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		result := httptest.NewRecorder()
		router.ServeHTTP(result, req)
		return result
	}
	if result := send("foreign"); result.Code != 401 {
		t.Fatal(result)
	}
	result := send("owner-host-key")
	if result.Code != 200 || !bytes.Contains(result.Body.Bytes(), []byte(`"complete":false`)) {
		t.Fatal(result)
	}
	fail = false
	changed = true
	result = send("owner-host-key")
	if result.Code != 200 || !bytes.Contains(result.Body.Bytes(), []byte(`"complete":false`)) {
		t.Fatal("changed ownership must remain pending", result)
	}
	changed = false
	for i := 0; i < 2; i++ {
		result = send("owner-host-key")
		if result.Code != 200 || !bytes.Contains(result.Body.Bytes(), []byte(`"complete":true`)) {
			t.Fatal(result)
		}
	}
	for id, expected := range map[string]int{"sibling": 200, "owned": 404} {
		result, err := docker.Client().Get(docker.URL + "/containers/" + id + "/json")
		if err != nil {
			t.Fatal(err)
		}
		result.Body.Close()
		if result.StatusCode != expected {
			t.Fatalf("%s: got %d", id, result.StatusCode)
		}
	}
}

type retirementTransport struct {
	base  string
	inner http.RoundTripper
}

func TestAppRetirementVerifiesLegacyOwnership(t *testing.T) {
	containers := map[string]retirementContainer{}
	seed := func(id, name string, labels map[string]string) {
		containers[id] = retirementContainer{ID: id, Names: []string{name}, Name: name, Labels: labels}
	}
	seed("legacy", "/deployment-41", map[string]string{"nmt.app-id": "7", "nmt.deployment-id": "41"})
	seed("builder", "/builder-42", map[string]string{"nmt.deployment-id": "42", "nmt.artifact": "builder"})
	seed("sibling", "/deployment-43", map[string]string{"nmt.app-id": "8", "nmt.deployment-id": "43"})
	changed := false
	docker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/containers/json" {
			items := []retirementContainer{}
			for _, item := range containers {
				items = append(items, item)
			}
			json.NewEncoder(w).Encode(items)
			return
		}
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/containers/"), "/json")
		item, ok := containers[id]
		if !ok {
			w.WriteHeader(404)
			return
		}
		if r.Method == "GET" {
			labels := item.Labels
			if changed && id == "legacy" {
				labels = map[string]string{"nmt.app-id": "8", "nmt.deployment-id": "41"}
			}
			json.NewEncoder(w).Encode(map[string]any{"Id": id, "Name": item.Name, "Config": map[string]any{"Labels": labels}})
			return
		}
		if r.Method == "DELETE" && id == "legacy" && r.URL.Query().Get("v") == "false" {
			delete(containers, id)
			w.WriteHeader(204)
			return
		}
		t.Errorf("unrelated Docker operation: %s %s", r.Method, r.URL)
		w.WriteHeader(500)
	}))
	defer docker.Close()
	client := docker.Client()
	client.Transport = &retirementTransport{base: docker.URL, inner: http.DefaultTransport}
	router := gin.New()
	router.Use(requireAPIAuth("legacy-key"))
	router.POST("/apps/:appId/retire", appRetirementHandler(client))
	send := func(ids string, complete bool) {
		t.Helper()
		req := httptest.NewRequest("POST", "/apps/7/retire", strings.NewReader(`{"deploymentIds":`+ids+`}`))
		req.Header.Set("Authorization", "Bearer legacy-key")
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != 200 || !strings.Contains(res.Body.String(), fmt.Sprintf(`"complete":%t`, complete)) {
			t.Fatal(res)
		}
	}
	changed = true
	send("[41,42]", false)
	changed = false
	send("[41,42]", true)
	send("[41,42]", true)
	if _, ok := containers["legacy"]; ok {
		t.Fatal("legacy runtime remains")
	}
	seed("foreign", "/deployment-44", map[string]string{"nmt.app-id": "8", "nmt.deployment-id": "44"})
	seed("unverified", "/deployment-45", map[string]string{"traefik.http.routers.deployment-45.rule": "Host(`fixture.invalid`)"})
	seed("conflict", "/deployment-46", map[string]string{"nmt.app-id": "7", "nmt.deployment-id": "46", "nmt.artifact": "builder"})
	seed("wrong-name", "/other-47", map[string]string{"nmt.app-id": "7", "nmt.deployment-id": "47"})
	send("[44,45,46,47]", false)
	for _, id := range []string{"builder", "sibling", "foreign", "unverified", "conflict", "wrong-name"} {
		if _, ok := containers[id]; !ok {
			t.Fatalf("unverified container %s removed", id)
		}
	}
}

func (r *retirementTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	copy := req.Clone(req.Context())
	u := *req.URL
	parsed, _ := http.NewRequest("GET", r.base, nil)
	u.Scheme = parsed.URL.Scheme
	u.Host = parsed.URL.Host
	copy.URL = &u
	return r.inner.RoundTrip(copy)
}

// Opt-in against a disposable, initially empty Docker daemon with an existing
// local image. Never pull images or collect pre-existing host resources.
func TestAppRetirementRealDocker(t *testing.T) {
	if os.Getenv("NMT_RETIREMENT_DOCKER_SMOKE") != "1" {
		t.Skip("set NMT_RETIREMENT_DOCKER_SMOKE=1 on a disposable Docker host")
	}
	client := dockerHTTPClient()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	call := func(method, path string, body []byte) *http.Response {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	list := call("GET", "/containers/json?all=true", nil)
	var existing []retirementContainer
	err := json.NewDecoder(list.Body).Decode(&existing)
	list.Body.Close()
	if err != nil || list.StatusCode != 200 || len(existing) != 0 {
		t.Fatal("smoke requires an initially empty disposable Docker daemon")
	}
	image := os.Getenv("RETIREMENT_DOCKER_IMAGE")
	if image == "" {
		image = "alpine:3.20"
	}
	ids := []string{}
	t.Cleanup(func() {
		for _, id := range ids {
			req, _ := http.NewRequest("DELETE", "http://docker/containers/"+id+"?force=true&v=false", nil)
			res, err := client.Do(req)
			if err == nil {
				res.Body.Close()
			}
		}
	})
	for i := 0; i < 2; i++ {
		appID := 2000000000 + i
		deploymentID := 41 + i
		body, _ := json.Marshal(map[string]any{"Image": image, "Cmd": []string{"sleep", "120"}, "Labels": map[string]string{"nmt.app-id": fmt.Sprint(appID), "nmt.deployment-id": fmt.Sprint(deploymentID), "nmt.artifact": "runtime"}})
		res := call("POST", fmt.Sprintf("/containers/create?name=retirement-smoke-%d-%d", time.Now().UnixNano(), i), body)
		var created struct {
			ID string `json:"Id"`
		}
		err := json.NewDecoder(res.Body).Decode(&created)
		res.Body.Close()
		if err != nil || res.StatusCode != 201 || created.ID == "" {
			t.Fatal("local smoke image/container creation unavailable")
		}
		ids = append(ids, created.ID)
		res = call("POST", "/containers/"+created.ID+"/start", nil)
		res.Body.Close()
		if res.StatusCode != 204 {
			t.Fatal("smoke container start failed")
		}
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(requireAPIAuth("smoke-key"))
	router.POST("/apps/:appId/retire", appRetirementHandler(client))
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("POST", "/apps/2000000000/retire", bytes.NewBufferString(`{"deploymentIds":[41]}`))
		req.Header.Set("Authorization", "Bearer smoke-key")
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != 200 || !bytes.Contains(res.Body.Bytes(), []byte(`"complete":true`)) {
			t.Fatal(res)
		}
	}
	removed := call("GET", "/containers/"+ids[0]+"/json", nil)
	removed.Body.Close()
	if removed.StatusCode != 404 {
		t.Fatal("retired runtime remains")
	}
	sibling := call("GET", "/containers/"+ids[1]+"/json", nil)
	defer sibling.Body.Close()
	var details struct{ State struct{ Running bool } }
	if json.NewDecoder(sibling.Body).Decode(&details) != nil || !details.State.Running {
		t.Fatal("sibling runtime was affected")
	}
}
