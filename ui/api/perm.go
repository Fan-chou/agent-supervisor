package api

import (
	"fmt"
	"os"
	"runtime"
)

// CheckPerm 检查 socket / token 文件权限是否是 0600（§9：不是就在顶栏警告）。文件不存在时返回 ("", nil)。
// Windows 没有 POSIX 权限位（Go 对任何文件都报 0666），检查没有意义，直接跳过，不给假告警。
func CheckPerm(path string) (warn string) { return checkPerm(path, runtime.GOOS) }

func checkPerm(path, goos string) string {
	if goos == "windows" {
		return ""
	}
	st, err := os.Stat(path)
	if err != nil {
		return ""
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Sprintf("%s 的权限是 %04o，应为 0600", path, st.Mode().Perm())
	}
	return ""
}
