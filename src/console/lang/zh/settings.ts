// 设置：系统权限（web/js/settings.js）。数从运维的只读检查来；页面只读，按钮只是在主人的浏览器里打开系统设置
export const settings = {
  loading: "正在查…",
  notSet: "这个角色没配系统权限的检查（实例配置 console.permissionsCheck），这里没有可列的。",
  failed: "查不出来：{error}",
  checked: "{time} 查的。检查以 {user} 跑，系统把{me}跑的命令都算在 {program} 头上。",
  recheck: "重新查一遍",
  status: { granted: "已给", missing: "没给", unknown: "查不了" },
  names: { screen: "录屏与系统录音", ax: "辅助功能", fda: "完全磁盘访问", automation: "自动化", files: "文件与文件夹" },
  open: "打开系统设置",
  look: "在系统设置里看",
  add: "要加的程序：",
  copy: "复制路径",
  copied: "复制好了",
  grants: "开权限",
  how: "在打开的那一页点「+」，选上面这个文件，再打开它旁边的开关。文件在隐藏的目录里时，在选文件的窗口按 ⌘⇧G，把路径粘进去。",
} as const;
