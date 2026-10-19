//go:build embedbackend

package main

import "embed"

// 打包脚本（scripts/package.sh）先把目标平台的 sv / sv-hook / 插件 / 配置样例放进 embedded/ 再带 -tags embedbackend 编译。
//
//go:embed embedded/sv embedded/sv-hook embedded/agent-supervisor.ts embedded/config.example.yaml
var backendFS embed.FS

const hasBackend = true
