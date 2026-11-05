//go:build !linux

package main

// Host administration is deployed on Linux. Other platforms can exercise the
// HTTP/queue contract without reporting unsupported host memory measurements.
func hostMemory() (uint64, uint64) { return 0, 0 }
