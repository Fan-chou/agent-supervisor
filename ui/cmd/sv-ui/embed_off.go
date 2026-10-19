//go:build !embedbackend

package main

import "embed"

var backendFS embed.FS

const hasBackend = false
