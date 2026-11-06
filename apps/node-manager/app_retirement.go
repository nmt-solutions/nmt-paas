package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

type retirementContainer struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Name   string            `json:"Name"`
	Labels map[string]string `json:"Labels"`
}

// The server-held bearer authenticates the control plane; the application has
// already authorized the owner and persisted retirement. Never accept arbitrary
// Docker IDs or fall back to host-wide deletion here.
func appRetirementHandler(client *http.Client) gin.HandlerFunc {
	return func(c *gin.Context) {
		appID, err := strconv.ParseInt(c.Param("appId"), 10, 32)
		var body struct {
			DeploymentIDs []int64 `json:"deploymentIds"`
		}
		if err != nil || appID <= 0 || c.ShouldBindJSON(&body) != nil || body.DeploymentIDs == nil {
			c.JSON(400, response(400, 400, "Invalid app retirement", nil, nil))
			return
		}
		allowed := map[string]bool{}
		for _, id := range body.DeploymentIDs {
			if id <= 0 || id > 9007199254740991 {
				c.JSON(400, response(400, 400, "Invalid app retirement", nil, nil))
				return
			}
			allowed[strconv.FormatInt(id, 10)] = true
		}
		request := func(method, path string) (*http.Response, error) {
			req, err := http.NewRequestWithContext(c.Request.Context(), method, "http://docker"+path, nil)
			if err != nil {
				return nil, err
			}
			return client.Do(req)
		}
		list, err := request("GET", "/containers/json?all=true")
		if err != nil {
			c.JSON(503, response(503, 503, "Runtime cleanup unavailable", nil, nil))
			return
		}
		defer list.Body.Close()
		var containers []retirementContainer
		if list.StatusCode != 200 || json.NewDecoder(list.Body).Decode(&containers) != nil {
			c.JSON(503, response(503, 503, "Runtime cleanup unavailable", nil, nil))
			return
		}
		owns := func(item retirementContainer) bool {
			id := item.Labels["nmt.deployment-id"]
			role, explicitRole := item.Labels["nmt.artifact"]
			legacyName := item.Name == "/deployment-"+id
			for _, name := range item.Names {
				legacyName = legacyName || name == "/deployment-"+id
			}
			// bb3f873 runtimes carried both ownership labels and this exact
			// name, but no role label. An explicit conflicting role is never legacy.
			return item.Labels["nmt.app-id"] == strconv.FormatInt(appID, 10) && allowed[id] && (role == "runtime" || !explicitRole && legacyName)
		}
		complete := true
		for _, item := range containers {
			role, explicitRole := item.Labels["nmt.artifact"]
			candidate := item.Labels["nmt.app-id"] == strconv.FormatInt(appID, 10) && (role == "runtime" || !explicitRole && allowed[item.Labels["nmt.deployment-id"]])
			for _, name := range item.Names {
				candidate = candidate || allowed[strings.TrimPrefix(name, "/deployment-")] && strings.HasPrefix(name, "/deployment-")
			}
			if !candidate {
				continue
			}
			if item.ID == "" || !owns(item) {
				complete = false
				continue
			}
			// Inspect by immutable ID again, preserving changed/unverified ownership.
			inspection, err := request("GET", "/containers/"+url.PathEscape(item.ID)+"/json")
			if err != nil {
				complete = false
				continue
			}
			if inspection.StatusCode == 404 {
				inspection.Body.Close()
				continue
			}
			var current retirementContainer
			// Inspect labels are under Config, unlike the list response.
			var details struct {
				retirementContainer
				Config struct {
					Labels map[string]string `json:"Labels"`
				} `json:"Config"`
			}
			err = json.NewDecoder(inspection.Body).Decode(&details)
			inspection.Body.Close()
			current = details.retirementContainer
			current.Labels = details.Config.Labels
			if err != nil || inspection.StatusCode != 200 || current.ID != item.ID || !owns(current) || current.Labels["nmt.deployment-id"] != item.Labels["nmt.deployment-id"] {
				complete = false
				continue
			}
			removed, err := request("DELETE", fmt.Sprintf("/containers/%s?force=true&v=false", url.PathEscape(item.ID)))
			if err != nil {
				complete = false
				continue
			}
			if removed.StatusCode != 204 && removed.StatusCode != 404 {
				complete = false
			}
			removed.Body.Close()
		}
		c.JSON(200, response(200, 200, "App retired; runtime cleanup outcome", gin.H{"complete": complete}, nil))
	}
}
