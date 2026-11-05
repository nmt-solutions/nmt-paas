package main

import "syscall"

func hostMemory() (uint64, uint64) {
	var info syscall.Sysinfo_t
	if syscall.Sysinfo(&info) == nil {
		return info.Totalram * uint64(info.Unit), info.Freeram * uint64(info.Unit)
	}
	return 0, 0
}
