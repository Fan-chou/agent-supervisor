// sv-ui：agent-supervisor 的 MyGo 原生界面。只通过守护进程的本地鉴权 API 通信（UDS 优先，或 127.0.0.1 HTTP + token）。
//
//	sv-ui                       # 连 ~/.agent-supervisor/sock
//	sv-ui -url http://127.0.0.1:PORT -token-file PATH
//	sv-ui -demo                 # 内置合成数据的假守护进程，不连真实守护进程
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Fan-chou/agent-supervisor/ui/api"
	"github.com/Fan-chou/agent-supervisor/ui/app"
	"github.com/Fan-chou/agent-supervisor/ui/fake"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func main() {
	home, _ := os.UserHomeDir()
	sock := flag.String("sock", filepath.Join(home, ".agent-supervisor", "sock"), "守护进程 Unix socket 路径")
	url := flag.String("url", "", "改用 HTTP 基址（如 http://127.0.0.1:7777），需配 -token-file")
	tokenFile := flag.String("token-file", "", "HTTP Bearer token 文件（只读取，不打印）")
	demo := flag.Bool("demo", false, "使用内置合成数据的假守护进程（不连真实守护进程）")
	quitAfter := flag.Duration("quit-after", 0, "运行这么久后自动退出（冒烟用）")
	flag.Parse()

	var cl *api.Client
	switch {
	case *demo:
		srv := fake.New()
		defer srv.Close()
		cl = api.NewHTTP(srv.URL, "")
	case *url != "":
		tok := ""
		if *tokenFile != "" {
			if w := api.CheckPerm(*tokenFile); w != "" {
				fmt.Fprintln(os.Stderr, "警告:", w)
			}
			b, err := os.ReadFile(*tokenFile)
			if err != nil {
				fmt.Fprintln(os.Stderr, "读取 token 文件失败:", err)
				os.Exit(2)
			}
			tok = strings.TrimSpace(string(b))
		}
		cl = api.NewHTTP(*url, tok)
	default:
		if w := api.CheckPerm(*sock); w != "" {
			fmt.Fprintln(os.Stderr, "警告:", w)
		}
		cl = api.NewUnix(*sock)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mygo.App.WhenReady(func() {
		var win *mygo.Window
		a := app.New(ctx, cl, func(fn func()) {
			if win != nil {
				win.Update(fn)
			}
		})
		a.Demo = *demo
		win = mygo.NewWindow(mygo.WindowOptions{
			Title:    "agent-supervisor",
			Width:    1440,
			Height:   900,
			MinWidth: 960, MinHeight: 600,
			Content: ui.View(a.View),
		})
		a.Start()
		if *quitAfter > 0 {
			time.AfterFunc(*quitAfter, mygo.App.Quit)
		}
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
