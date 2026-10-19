package main

// 升级相关：Windows 不允许覆盖/删除正在运行的 exe，但允许把它改名。所以替换文件时先把旧文件
// 挤到旁边（<名>.old-<时间>），再放新文件，下次解压时清理旧文件（还在运行的删不掉就留着，下次再试）。
// 另外：升级后如果后台是升级前启动的旧版本，空闲时自动重启，有会话在跑时只提示。

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// renameFn 可在测试里替换，用来模拟 Windows 的「目标正在运行，不能覆盖」。
var renameFn = os.Rename

// replaceFile 把 tmp 放到 dst。直接改名失败且 dst 存在时，先把 dst 改名挤开再放新文件；放不进去就还原。
func replaceFile(tmp, dst string) error {
	err := renameFn(tmp, dst)
	if err == nil {
		return nil
	}
	if _, serr := os.Stat(dst); serr != nil {
		return err
	}
	old := fmt.Sprintf("%s.old-%d", dst, time.Now().UnixNano())
	if rerr := renameFn(dst, old); rerr != nil {
		return err
	}
	if err2 := renameFn(tmp, dst); err2 != nil {
		_ = renameFn(old, dst)
		return err2
	}
	return nil
}

// cleanOld 删掉先前被挤开的旧文件（*.old-*）；正在运行的删不掉，忽略错误，下次再试。
func cleanOld(dir string) {
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.Contains(d.Name(), ".old-") {
			_ = os.Remove(p)
		}
		return nil
	})
}

// staleDaemon：后台启动时间早于已安装的 sv 可执行文件的修改时间（留 2 秒余量）就是升级前的旧进程。
// 解压只在内容变了才重写，所以没升级时文件时间一定早于后台启动时间。
func staleDaemon(startedAtMs int64, binMtime time.Time) bool {
	if startedAtMs <= 0 {
		return false
	}
	return time.UnixMilli(startedAtMs).Add(2 * time.Second).Before(binMtime)
}

// readHookPid 读后台自己写的 hook.json（只含 pid / startedAt 等），并要求 startedAt 与 hello 一致，防止误杀复用的 pid。
func readHookPid(home string, startedAt int64) int {
	b, err := os.ReadFile(filepath.Join(home, "hook.json"))
	if err != nil {
		return 0
	}
	var h struct {
		Pid       int   `json:"pid"`
		StartedAt int64 `json:"startedAt"`
	}
	if json.Unmarshal(b, &h) != nil || h.Pid <= 0 || h.StartedAt != startedAt {
		return 0
	}
	return h.Pid
}
