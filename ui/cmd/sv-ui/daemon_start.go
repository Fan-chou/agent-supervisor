package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
)

func reachable(sock string, d time.Duration) bool {
	c, err := net.DialTimeout("unix", sock, d)
	if err == nil {
		c.Close()
	}
	return err == nil
}

// ensureDaemon：内嵌构建下，每次启动都先把后端解压/更新到固定目录（内容相同不重写），再保证后台在跑。
// 后台没在跑 → 后台启动 `sv start`（日志写 bin 目录旁的 daemon.log）。
// 后台是升级前启动的旧版本 → 没有会话在跑时自动重启（不丢数据：记录都已落库，hook 在重启的一瞬间失败也是 fail-open）；
// 有会话在跑就不动它，返回一条提示给窗口显示。
func ensureDaemon(sock string) (notice string) {
	if !hasBackend {
		return ""
	}
	dir, err := extractBackend()
	if err != nil {
		fmt.Fprintln(os.Stderr, "解压后端失败:", err)
		return "解压后端失败：" + err.Error() + "。旧版本仍可使用；请关闭后台 sv 进程后重新打开本程序。"
	}
	if reachable(sock, 300*time.Millisecond) {
		st, err := os.Stat(filepath.Join(dir, exeName("sv")))
		if err != nil {
			return ""
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		cl := api.NewUnix(sock)
		hello, herr := cl.Hello(ctx)
		if herr != nil || !staleDaemon(hello.StartedAt, st.ModTime()) {
			return ""
		}
		status, serr := cl.Status(ctx)
		if serr != nil || status.Sessions > 0 {
			return "后台仍是升级前启动的旧版本，新版本在后台下次重启后生效（当前有会话在跑，没有打断它）。需要时结束后台 sv 进程后重新打开本程序。"
		}
		pid := readHookPid(filepath.Dir(sock), hello.StartedAt)
		if pid == 0 || stopProcess(pid) != nil {
			return "后台是升级前启动的旧版本，但没能自动重启它；请结束后台 sv 进程后重新打开本程序。"
		}
		for i := 0; i < 30 && reachable(sock, 100*time.Millisecond); i++ { // 最多等 3 秒退出
			time.Sleep(100 * time.Millisecond)
		}
		if reachable(sock, 100*time.Millisecond) {
			return "后台是升级前启动的旧版本，自动重启超时；请结束后台 sv 进程后重新打开本程序。"
		}
	}
	logf, _ := os.OpenFile(filepath.Join(filepath.Dir(dir), "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	cmd := exec.Command(filepath.Join(dir, exeName("sv")), "start")
	cmd.Env = backendEnv(dir)
	cmd.Stdin = bytes.NewReader(nil)
	if logf != nil {
		cmd.Stdout, cmd.Stderr = logf, logf
	}
	detach(cmd)
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "启动守护进程失败:", err)
		return "启动守护进程失败：" + err.Error()
	}
	_ = cmd.Process.Release()
	for i := 0; i < 30; i++ { // 最多等 3 秒
		if reachable(sock, 100*time.Millisecond) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	return ""
}
