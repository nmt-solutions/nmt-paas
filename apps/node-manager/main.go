package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const queuePrefix = "bull:deployment-queue:"

var errDeploymentEnqueueConflict = errors.New("Deployment is already queued with a different payload.")

type config struct{ port, apiKey, redisHost, redisPort, redisPassword string }
type queuePayload struct {
	UserID       string  `json:"userId"`
	DeploymentID float64 `json:"deploymentId"`
	Operation    string  `json:"operation,omitempty"`
}
type apiResponse struct {
	Status     string `json:"status"`
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Data       any    `json:"data"`
	Errors     any    `json:"errors"`
}

func response(status, code int, message string, data, errs any) apiResponse {
	state := "success"
	if status >= 400 {
		state = "error"
	}
	return apiResponse{Status: state, StatusCode: code, Message: message, Data: data, Errors: errs}
}

func main() {
	loadDotEnv(".env")
	cfg, err := loadConfig()
	if err != nil {
		panic(err)
	}
	router := gin.Default()
	router.GET("/api/v1/health/", health)
	router.GET("/api/v1/health", health)
	authenticated := router.Group("/api/v1")
	authenticated.Use(requireAPIAuth(cfg.apiKey))
	authenticated.POST("/deployments/queue", queueDeployment(cfg))
	authenticated.POST("/deployments/publication", queuePublication(cfg))
	authenticated.GET("/admin/host", adminHost)
	authenticated.GET("/admin/docker/:resource", dockerResources)
	authenticated.DELETE("/admin/docker/:resource/:id", deleteDockerResource)
	authenticated.GET("/logs/stream/:deploymentId", streamRuntimeLogs)
	if err := router.Run("0.0.0.0:" + cfg.port); err != nil {
		panic(err)
	}
}

func loadConfig() (config, error) {
	get := func(name string) (string, error) {
		value := os.Getenv(name)
		if value == "" {
			return "", fmt.Errorf("%s is required.", name)
		}
		return value, nil
	}
	port, err := get("API_APP_PORT")
	if err != nil {
		return config{}, err
	}
	key, err := get("API_KEY")
	if err != nil {
		return config{}, err
	}
	host, err := get("REDIS_HOST")
	if err != nil {
		return config{}, err
	}
	redisPort, err := get("REDIS_PORT")
	if err != nil {
		return config{}, err
	}
	password, err := get("REDIS_PASSWORD")
	if err != nil {
		return config{}, err
	}
	return config{port, key, host, redisPort, password}, nil
}

func loadDotEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 || os.Getenv(strings.TrimSpace(parts[0])) != "" {
			continue
		}
		key, value := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		_ = os.Setenv(key, value)
	}
	_ = scanner.Err()
}

func health(c *gin.Context) { c.JSON(200, response(200, 200, "System is healthy.", "OK", nil)) }
func requireAPIAuth(key string) gin.HandlerFunc {
	return func(c *gin.Context) {
		authorization := c.GetHeader("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") || authorization[len("Bearer "):] != key {
			c.JSON(401, response(401, 401, "Unauthorized", nil, "Unauthorized"))
			c.Abort()
			return
		}
		c.Next()
	}
}

func queueDeployment(cfg config) gin.HandlerFunc  { return queueHandler(cfg, false) }
func queuePublication(cfg config) gin.HandlerFunc { return queueHandler(cfg, true) }
func queueHandler(cfg config, publication bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		var raw json.RawMessage
		decoder := json.NewDecoder(c.Request.Body)
		if err := decoder.Decode(&raw); err != nil {
			if err != io.EOF {
				validationError(c, []string{"Invalid input: expected object, received invalid"}, nil)
				return
			}
			raw = json.RawMessage(`{}`)
		}
		var trailing any
		if decoder.Decode(&trailing) != io.EOF {
			validationError(c, []string{"Invalid input: expected object, received invalid"}, nil)
			return
		}
		var body map[string]json.RawMessage
		if json.Unmarshal(raw, &body) != nil || body == nil {
			validationError(c, []string{"Invalid input: expected object, received " + jsonType(raw)}, nil)
			return
		}

		fields := map[string][]string{}
		var userID string
		userRaw, hasUserID := body["userId"]
		if !hasUserID {
			fields["userId"] = []string{"Invalid input: expected string, received undefined"}
		} else if jsonType(userRaw) != "string" || json.Unmarshal(userRaw, &userID) != nil {
			fields["userId"] = []string{"Invalid input: expected string, received " + jsonType(userRaw)}
		} else if userID == "" {
			fields["userId"] = []string{"User id is required."}
		}

		var deploymentID float64
		deploymentRaw, hasDeploymentID := body["deploymentId"]
		if !hasDeploymentID || jsonType(deploymentRaw) != "number" || json.Unmarshal(deploymentRaw, &deploymentID) != nil || math.IsNaN(deploymentID) || math.IsInf(deploymentID, 0) {
			fields["deploymentId"] = []string{"Deployment id must be a number."}
		} else if deploymentID < 0 {
			fields["deploymentId"] = []string{"Deployment id must be a +ve int."}
		}
		if len(fields) > 0 {
			validationError(c, []string{}, fields)
			return
		}
		payload := queuePayload{UserID: userID, DeploymentID: deploymentID}
		// Match Express's numeric identity without changing the accepted schema.
		if deploymentID == 0 {
			deploymentID = 0 // Normalize negative zero.
		}
		jobID := fmt.Sprintf("deployment-%016x", math.Float64bits(deploymentID))
		message := "Deployment Queued"
		if publication {
			payload.Operation = "publish"
			identity := make([]byte, 16)
			if _, err := rand.Read(identity); err != nil {
				c.JSON(503, response(503, 503, "Deployment queue is unavailable.", nil, nil))
				return
			}
			jobID = fmt.Sprintf("publication-%x", identity)
			message = "Publication Queued"
		}
		data, _ := json.Marshal(payload)
		if err := addBullMQJob(c.Request.Context(), cfg, jobID, string(data)); err != nil {
			if errors.Is(err, errDeploymentEnqueueConflict) {
				c.JSON(409, response(409, 409, err.Error(), nil, nil))
				return
			}
			c.JSON(503, response(503, 503, "Deployment queue is unavailable.", nil, nil))
			return
		}
		c.JSON(201, response(201, 201, message, true, nil))
	}
}
func jsonType(raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return "undefined"
	}
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case []any:
		return "array"
	default:
		return "object"
	}
}
func validationError(c *gin.Context, formErrors []string, fields map[string][]string) {
	if fields == nil {
		fields = map[string][]string{}
	}
	c.JSON(400, response(400, 400, "Validation Errors", nil, struct {
		FormErrors  []string            `json:"formErrors"`
		FieldErrors map[string][]string `json:"fieldErrors"`
	}{formErrors, fields}))
}

// This writes BullMQ's Queue.add job representation so apps/worker can consume it unchanged.
func addBullMQJob(ctx context.Context, cfg config, jobID, data string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(cfg.redisHost, cfg.redisPort))
	if err != nil {
		return err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	reader := bufio.NewReader(conn)
	if err := writeRedisCommand(conn, "AUTH", cfg.redisPassword); err != nil {
		return err
	}
	if _, err := readRedisReply(reader); err != nil {
		return err
	}
	options := `{"attempts":3,"backoff":{"type":"exponential","delay":2000},"removeOnComplete":100,"removeOnFail":1000}`
	script := `
local id = ARGV[5]
local key = KEYS[2] .. id
if redis.call('EXISTS', key) == 1 then
  local existing = cjson.decode(redis.call('HGET', key, 'data'))
  local incoming = cjson.decode(ARGV[2])
  if redis.call('HGET', key, 'name') ~= ARGV[1]
    or existing.userId ~= incoming.userId
    or existing.deploymentId ~= incoming.deploymentId then
    return -1
  end
  return 0
end
redis.call('INCR', KEYS[1])
local max = redis.call('HGET', KEYS[3], 'opts.maxLenEvents')
if not max then
  max = 10000
  redis.call('HSET', KEYS[3], 'opts.maxLenEvents', max)
end
local target = KEYS[4]
local paused = redis.call('HGET', KEYS[3], 'paused')
if paused then target = KEYS[5] end
redis.call('HMSET', key, 'name', ARGV[1], 'data', ARGV[2], 'opts', ARGV[3], 'timestamp', ARGV[4], 'delay', 0, 'priority', 0)
redis.call('XADD', KEYS[6], '*', 'event', 'added', 'jobId', id, 'name', ARGV[1])
redis.call('LPUSH', target, id)
if not paused then redis.call('ZADD', KEYS[7], 0, '0') end
redis.call('XADD', KEYS[6], 'MAXLEN', '~', max, '*', 'event', 'waiting', 'jobId', id)
return 1`
	args := []string{"EVAL", script, "7", queuePrefix + "id", queuePrefix, queuePrefix + "meta", queuePrefix + "wait", queuePrefix + "paused", queuePrefix + "events", queuePrefix + "marker", "deployment-queue", data, options, strconv.FormatInt(time.Now().UnixMilli(), 10), jobID}
	if err := writeRedisCommand(conn, args...); err != nil {
		return err
	}
	result, err := readRedisReply(reader)
	if err == nil && result == "-1" {
		return errDeploymentEnqueueConflict
	}
	return err
}
func writeRedisCommand(w io.Writer, args ...string) error {
	if _, err := fmt.Fprintf(w, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, arg := range args {
		if _, err := fmt.Fprintf(w, "$%d\r\n%s\r\n", len(arg), arg); err != nil {
			return err
		}
	}
	return nil
}
func readRedisReply(r *bufio.Reader) (string, error) {
	prefix, err := r.ReadByte()
	if err != nil {
		return "", err
	}
	line, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	if prefix == '-' {
		return "", errors.New(line)
	}
	return line, nil
}

func dockerHTTPClient() *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/docker.sock")
	}}}
}
func dockerRequest(ctx context.Context, method, path string) (*http.Response, error) {
	return dockerRequestWithClient(dockerHTTPClient(), ctx, method, path)
}
func dockerRequestWithClient(client *http.Client, ctx context.Context, method, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, nil)
	if err != nil {
		return nil, err
	}
	result, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if result.StatusCode < 400 {
		return result, nil
	}
	defer result.Body.Close()
	body, _ := io.ReadAll(result.Body)
	var payload struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Message != "" {
		return nil, errors.New(payload.Message)
	}
	return nil, fmt.Errorf("Docker API returned %s", result.Status)
}
func dockerJSON(ctx context.Context, path string, target any) error {
	result, err := dockerRequest(ctx, "GET", path)
	if err != nil {
		return err
	}
	defer result.Body.Close()
	return json.NewDecoder(result.Body).Decode(target)
}

func adminHost(c *gin.Context) {
	var info, containers, images, volumes, usage any
	paths := []struct {
		path   string
		target *any
	}{{"/info", &info}, {"/containers/json?all=true", &containers}, {"/images/json", &images}, {"/volumes", &volumes}, {"/system/df", &usage}}
	var group sync.WaitGroup
	errs := make(chan error, len(paths))
	for _, item := range paths {
		group.Add(1)
		go func(item struct {
			path   string
			target *any
		}) {
			defer group.Done()
			errs <- dockerJSON(c.Request.Context(), item.path, item.target)
		}(item)
	}
	group.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			c.JSON(503, response(503, 503, err.Error(), nil, nil))
			return
		}
	}
	containerList, _ := containers.([]any)
	running := 0
	for _, value := range containerList {
		if item, ok := value.(map[string]any); ok && item["State"] == "running" {
			running++
		}
	}
	imageList, _ := images.([]any)
	volumeCount := 0
	if value, ok := volumes.(map[string]any); ok {
		if list, ok := value["Volumes"].([]any); ok {
			volumeCount = len(list)
		}
	}
	total, free := hostMemory()
	c.JSON(200, response(200, 200, "Host status", gin.H{"health": "healthy", "cpuCount": runtime.NumCPU(), "memory": gin.H{"total": total, "used": total - free}, "docker": gin.H{"containers": len(containerList), "runningContainers": running, "images": len(imageList), "volumes": volumeCount, "disk": usage}, "info": info}, nil))
}
func dockerResources(c *gin.Context) {
	resource := c.Param("resource")
	path := map[string]string{"containers": "/containers/json?all=true", "images": "/images/json", "volumes": "/volumes"}[resource]
	if path == "" {
		c.JSON(404, response(404, 404, "Unknown Docker resource", nil, nil))
		return
	}
	var data any
	if err := dockerJSON(c.Request.Context(), path, &data); err != nil {
		c.JSON(500, response(500, 500, err.Error(), nil, nil))
		return
	}
	if resource == "volumes" {
		if result, ok := data.(map[string]any); ok {
			data = result["Volumes"]
			if data == nil {
				data = []any{}
			}
		}
	}
	c.JSON(200, response(200, 200, "Docker resources", data, nil))
}
func deleteDockerResource(c *gin.Context) {
	resource, id := c.Param("resource"), c.Param("id")
	base := map[string]string{"containers": "/containers/", "images": "/images/", "volumes": "/volumes/"}[resource]
	if base == "" {
		c.JSON(404, response(404, 404, "Unknown Docker resource", nil, nil))
		return
	}
	path := base + url.PathEscape(id)
	if resource != "volumes" {
		path += "?force=true"
	}
	result, err := dockerRequest(c.Request.Context(), "DELETE", path)
	if err != nil {
		c.JSON(400, response(400, 400, err.Error(), nil, nil))
		return
	}
	result.Body.Close()
	c.JSON(200, response(200, 200, "Docker resource deleted", true, nil))
}

func streamRuntimeLogs(c *gin.Context) {
	runtimeLogsHandler(dockerHTTPClient(), 15*time.Second)(c)
}
func runtimeLogsHandler(client *http.Client, heartbeatInterval time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer client.CloseIdleConnections()
		value, err := strconv.ParseFloat(c.Param("deploymentId"), 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value {
			c.JSON(400, response(400, 400, "Invalid deployment ID.", nil, nil))
			return
		}
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache, no-transform")
		c.Header("Connection", "keep-alive")
		c.Header("X-Accel-Buffering", "no")
		c.Status(200)
		c.Writer.Flush()
		var lock sync.Mutex
		write := func(message string) {
			lock.Lock()
			defer lock.Unlock()
			_, _ = c.Writer.WriteString(message)
			c.Writer.Flush()
		}
		write(": connected\n\n")
		logs, err := dockerRequestWithClient(client, c.Request.Context(), "GET", fmt.Sprintf("/containers/deployment-%d/logs?follow=true&stdout=true&stderr=true&timestamps=true&tail=100", int64(value)))
		if err != nil {
			write("event: error\ndata: {\"message\":\"Failed to read deployment logs.\"}\n\n")
			return
		}
		defer logs.Body.Close()
		heartbeat := time.NewTicker(heartbeatInterval)
		stopHeartbeat := make(chan struct{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				select {
				case <-heartbeat.C:
					write(": heartbeat\n\n")
				case <-stopHeartbeat:
					return
				case <-c.Request.Context().Done():
					return
				}
			}
		}()
		defer func() { heartbeat.Stop(); close(stopHeartbeat); <-done }()
		streamDockerLogs(logs.Body, func(line string) { encoded, _ := json.Marshal(line); write("data: " + string(encoded) + "\n\n") })
	}
}
func streamDockerLogs(reader io.Reader, onLine func(string)) {
	for {
		header := make([]byte, 8)
		if _, err := io.ReadFull(reader, header); err != nil {
			return
		}
		payload := make([]byte, binary.BigEndian.Uint32(header[4:]))
		if _, err := io.ReadFull(reader, payload); err != nil {
			return
		}
		for _, line := range strings.Split(string(payload), "\n") {
			if line != "" {
				onLine(line)
			}
		}
	}
}
